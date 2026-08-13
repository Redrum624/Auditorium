import { bumpIdCounter, createDocument, docLength, nextId, type AudioDocument } from '../audio/AudioDocument';
import { decodeWav, encodeWav } from '../audio/wavCodec';
import { useAppStore, type Marker } from '../stores/appStore';
import type { Clip, Session, Track } from './session';
import { clampFadePair } from './session';
import { sanitizeAutomationLanes } from './automation';
import { FADE_CURVES, type FadeCurve } from '../dsp/fades';
import { useSessionStore } from './sessionStore';
import { clearSessionHistory } from './sessionUndo';
import { defaultSessionZoom } from './sessionZoom';

/** .audm format version. v1: no markers. v2: adds an optional `markers` map,
 * audio embedded as base64 WAV inside the JSON text. v3 (current, write
 * default — see `serializeSessionV3`): audio moves out of the JSON entirely
 * into a raw binary payload, so no monolithic JS string is ever built for the
 * audio content (the V8 string-length cap made v2 throw a RangeError once
 * embedded audio crossed ~402MB — see F3). The loader accepts all three; only
 * v3 is ever written by `saveSessionViaDialog`.
 *
 * v1.9 (X2): clips may additionally carry OPTIONAL fade keys (`fadeInSample`,
 * `fadeOutSample`, `fadeInCurve`, `fadeOutCurve` — see `session.ts`). These
 * ride inside the existing JSON clip records with `formatVersion` STAYING 3:
 * absent keys mean "no fade", so every pre-fade `.audm` still loads, a
 * session saved without fades is byte-identical to what v1.8.0 wrote, and a
 * fade-carrying file still opens in a v1.8.0 build (its parser spreads clip
 * records through untouched, so unknown keys are simply carried). Bumping the
 * version instead would be a data-loss-class change: `parseSessionFileV3`
 * hard-rejects any `formatVersion !== 3` (an equality, not a floor), so a v4
 * file would be unreadable by every shipped build. Fade keys from disk are
 * UNTRUSTED and normalized in `finalizeParsedSession` (see
 * `sanitizeClipFades`). */
const FORMAT_VERSION = 2;
const SUPPORTED_VERSIONS = new Set([1, 2]);

const BASE64_CHUNK_SIZE = 32 * 1024; // avoid call-stack overflow from spreading huge typed arrays

interface SessionFileDocument {
  id: string;
  name: string;
  sampleRate: number;
  channels: number;
  wavBase64: string;
}

interface SessionFileShape {
  formatVersion: number;
  session: Session;
  documents: SessionFileDocument[];
  /** docId (matching `documents[].id`, pre-remap) -> markers. v2+; only docs
   * referenced by the session that actually have markers get an entry. */
  markers?: Record<string, Marker[]>;
}

/** v3 on-disk byte layout:
 *   bytes [0, 6)   ASCII magic 'AUDM3\n'
 *   bytes [6, 10)  u32 LE jsonByteLength
 *   bytes [10, 10+jsonByteLength)          UTF-8 JSON (SessionFileShapeV3)
 *   bytes [10+jsonByteLength, EOF)         raw audio payload: each channel's
 *     Float32 samples, LE, back-to-back, at the offsets recorded in
 *     `audio[].channels[].offset` (relative to the start of this payload).
 * All supported build targets (x86/x64/ARM desktop) are little-endian, so a
 * typed array's native byte order already matches the on-disk LE contract —
 * no manual per-sample byte-swapping is needed to write or read it. */
const V3_MAGIC = new Uint8Array([0x41, 0x55, 0x44, 0x4d, 0x33, 0x0a]); // 'AUDM3\n'
const V3_HEADER_BYTES = 10; // magic(6) + u32 jsonByteLength(4)

interface AudioChannelMeta {
  offset: number; // relative to the start of the audio payload
  byteLength: number;
}

interface AudioDocMeta {
  docId: string;
  /** Kept beyond the minimal v3 shape so a round-tripped document keeps its
   * Files-panel display name instead of falling back to a generic label.
   * Always written by `serializeSessionV3`; typed as required so well-formed
   * files don't need an `?? 'Untitled'` fallback at every use, but the parser
   * still defends against a hand-built/foreign file omitting it (see
   * `parseSessionFileV3`) since nothing here is runtime-validated against
   * this type. */
  name: string;
  sampleRate: number;
  length: number; // samples per channel
  channels: AudioChannelMeta[];
}

interface SessionFileShapeV3 {
  formatVersion: 3;
  session: Session;
  markers?: Record<string, Marker[]>;
  audio: AudioDocMeta[];
}

function api() {
  const a = window.electronAPI;
  if (!a) throw new Error('electronAPI is not available');
  return a;
}

/** Base64-encodes an ArrayBuffer in fixed-size chunks so `String.fromCharCode`
 * is never called with more arguments than the JS engine's call-stack limit
 * allows. Retained only for the legacy v2 writer (`serializeSession`, kept
 * around for v1/v2 fixture generation and back-compat reads) — the v3 writer
 * never encodes audio as base64 or builds a JS string from it at all. */
function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Shared by both writers: filters each track's clips down to those whose
 * source document is currently open (`docs`), collects the resulting set of
 * referenced document ids, and narrows `markersByDoc` to only those ids (and
 * only when non-empty). See `serializeSession`'s original doc comment for why
 * clips referencing a closed document are dropped rather than written with no
 * embedded audio.
 */
function computeReferenced(
  session: Session,
  docs: AudioDocument[],
  markersByDoc: Record<string, Marker[]>
): {
  tracks: Session['tracks'];
  referencedIds: Set<string>;
  droppedClipCount: number;
  markers: Record<string, Marker[]>;
} {
  const openIds = new Set(docs.map((d) => d.id));
  let droppedClipCount = 0;

  const tracks = session.tracks.map((track) => {
    const clips = track.clips.filter((clip) => {
      const keep = openIds.has(clip.documentId);
      if (!keep) droppedClipCount++;
      return keep;
    });
    return { ...track, clips };
  });

  const referencedIds = new Set<string>();
  for (const track of tracks) {
    for (const clip of track.clips) referencedIds.add(clip.documentId);
  }

  const markers: Record<string, Marker[]> = {};
  for (const id of referencedIds) {
    const list = markersByDoc[id];
    if (list && list.length > 0) markers[id] = list;
  }

  return { tracks, referencedIds, droppedClipCount, markers };
}

/**
 * Serializes a session to the legacy .audm v2 JSON format (base64-embedded
 * 32-bit-float WAV per document). No longer used by `saveSessionViaDialog`
 * (which writes v3 — see `serializeSessionV3`); retained as the writer for
 * v1/v2 fixtures so the loader's back-compat path (`parseSessionFile`) stays
 * covered by real round-trip tests instead of hand-maintained JSON literals.
 *
 * Only documents actually referenced by at least one clip are embedded, and
 * clips whose source document isn't currently open are dropped (see
 * `computeReferenced`); `droppedClipCount` lets the caller warn the user.
 */
export function serializeSession(
  session: Session,
  docs: AudioDocument[],
  markersByDoc: Record<string, Marker[]> = {}
): { json: string; droppedClipCount: number } {
  const { tracks, referencedIds, droppedClipCount, markers } = computeReferenced(session, docs, markersByDoc);

  const documents: SessionFileDocument[] = docs
    .filter((d) => referencedIds.has(d.id))
    .map((d) => ({
      id: d.id,
      name: d.name,
      sampleRate: d.sampleRate,
      channels: d.channels.length,
      wavBase64: bufferToBase64(encodeWav(d.channels, d.sampleRate, 32)),
    }));

  const file: SessionFileShape = {
    formatVersion: FORMAT_VERSION,
    session: { ...session, tracks },
    documents,
    ...(Object.keys(markers).length > 0 ? { markers } : {}),
  };
  return { json: JSON.stringify(file), droppedClipCount };
}

/**
 * Serializes a session to the .audm v3 binary format (write default — see F3).
 * Audio is never turned into a JS string: each channel's underlying bytes are
 * copied straight into one pre-sized `Uint8Array` alongside a small JSON
 * metadata blob (session/tracks/markers/audio index), eliminating both the v2
 * base64 33% size overhead and the V8 string-length cap that made saving a
 * large embedded take throw a RangeError.
 *
 * Same "only referenced docs, drop clips from closed documents" behavior as
 * `serializeSession` (see `computeReferenced`).
 *
 * The returned `bytes` is always a *fresh* zero-offset `Uint8Array` sized to
 * exactly its own content (`bytes.byteLength === bytes.buffer.byteLength`) —
 * `saveSessionViaDialog` relies on this to hand `bytes.buffer` straight to
 * `writeFile` with no defensive copy (see its comment for why that copy would
 * matter). Don't change this function to return a subarray/view over some
 * larger buffer without updating that call site too.
 */
export function serializeSessionV3(
  session: Session,
  docs: AudioDocument[],
  markersByDoc: Record<string, Marker[]> = {}
): { bytes: Uint8Array<ArrayBuffer>; droppedClipCount: number } {
  const { tracks, referencedIds, droppedClipCount, markers } = computeReferenced(session, docs, markersByDoc);

  const audio: AudioDocMeta[] = [];
  const channelChunks: Uint8Array[] = [];
  let payloadLength = 0;
  for (const d of docs.filter((doc) => referencedIds.has(doc.id))) {
    const length = docLength(d); // channels[0].length — see the invariant check below
    const channels: AudioChannelMeta[] = [];
    for (const channel of d.channels) {
      // The reader validates every channel's byteLength against this single
      // `length` value (documents are invariantly all-channels-same-length —
      // see AudioDocument.ts), so a writer that ever saw that invariant
      // broken must fail loudly here rather than silently emit a file its
      // own reader would then reject with nothing noticing at save time.
      if (channel.length !== length) {
        throw new Error(
          `Cannot save session: document "${d.name}" (${d.id}) has channels of differing length (${length} vs ${channel.length}), which should never happen`
        );
      }
      const bytes = new Uint8Array(channel.buffer, channel.byteOffset, channel.byteLength);
      channels.push({ offset: payloadLength, byteLength: bytes.byteLength });
      channelChunks.push(bytes);
      payloadLength += bytes.byteLength;
    }
    audio.push({ docId: d.id, name: d.name, sampleRate: d.sampleRate, length, channels });
  }

  const fileShape: SessionFileShapeV3 = {
    formatVersion: 3,
    session: { ...session, tracks },
    ...(Object.keys(markers).length > 0 ? { markers } : {}),
    audio,
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(fileShape));

  const out = new Uint8Array(V3_HEADER_BYTES + jsonBytes.byteLength + payloadLength);
  out.set(V3_MAGIC, 0);
  new DataView(out.buffer).setUint32(6, jsonBytes.byteLength, true);
  out.set(jsonBytes, V3_HEADER_BYTES);

  let pos = V3_HEADER_BYTES + jsonBytes.byteLength;
  for (const chunk of channelChunks) {
    out.set(chunk, pos);
    pos += chunk.byteLength;
  }

  return { bytes: out, droppedClipCount };
}

/** Largest numeric suffix among ids of the form `${prefix}-<digits>`; 0 if none match. */
function maxIdSuffix(ids: string[], prefix: string): number {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const id of ids) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** Seeds the 'doc' id counter past the largest suffix among the raw (pre-
 * remap) clip.documentIds in a just-parsed file. Shared by both the legacy
 * and v3 parsers — see `parseSessionFile`'s doc comment for why this needs to
 * run even when every embedded document loads cleanly. */
function seedDocCounterFromRawClips(rawSession: { tracks: { clips: { documentId: string }[] }[] }): void {
  const rawDocumentIds = rawSession.tracks.flatMap((t) => t.clips.map((c) => c.documentId));
  bumpIdCounter('doc', maxIdSuffix(rawDocumentIds, 'doc') + 1);
}

/**
 * Shared by both parsers: remaps every clip.documentId through `idMap`
 * (dropping clips whose document wasn't recreated), seeds the 'track'/'clip'
 * id counters past the file's ids, and remaps `rawMarkers` (old docId ->
 * Marker[]) onto the fresh doc ids with fresh marker ids of their own. See
 * `parseSessionFile`'s original doc comment for the full rationale.
 *
 * Seeded marker positions are clamped to `[0, docLength]` (final-review fix:
 * a stale or hand-edited .audm can carry a marker past the recreated
 * document's actual length) -- matching the clamp already applied to markers
 * parsed from a WAV/MP3/FLAC/OGG file's own embedded cue points/tags (see
 * fileService's seeding chain).
 */
function sanitizeFadeLength(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.round(v));
}

function sanitizeFadeCurve(v: unknown): FadeCurve | undefined {
  return typeof v === 'string' && (FADE_CURVES as readonly string[]).includes(v) ? (v as FadeCurve) : undefined;
}

/** v1.9 X2 (trap T15): fade keys arrive from disk UNVALIDATED — the JSON is
 * cast, never checked, so a hand-edited or corrupt `.audm` can carry
 * anything. This re-establishes the Clip fade invariant (`session.ts`) at the
 * parse boundary so no consumer downstream has to defend itself:
 *  - a fade length that isn't a finite number (string, null, `1e999`) is
 *    dropped; a fractional one is rounded; a negative one becomes "no fade";
 *  - the pair is clamped to `fadeIn + fadeOut <= lengthSample` with the
 *    fade-IN preserved when they'd cross (there is no "edited edge" here, so
 *    the rule is fixed: in first, out gets the remainder) — against a
 *    non-numeric `lengthSample` (nothing validates clip geometry either) both
 *    fades drop to 0 rather than clamping against garbage;
 *  - an unknown curve string is dropped (absent = `DEFAULT_FADE_CURVE`);
 *  - zero-length results lose their key entirely, so "no fade" round-trips
 *    back to "no key on disk".
 * Unknown OTHER keys are deliberately preserved by the spread — the same
 * tolerance that lets a v1.8.0 build open a fade-carrying file is extended to
 * whatever a future version adds. */
function sanitizeClipFades(clip: Clip): Clip {
  // Clamp against the FLOOR of the length (X5, carried X2 finding): clip
  // geometry itself is unvalidated, so a hand-edited file can carry a
  // fractional `lengthSample`, and clamping rounded fades against it stored a
  // fractional fade (lengthSample: 100.5 + fadeInSample: 5000 -> 100.5),
  // breaking the positive-integer invariant. Math.floor — not Math.round,
  // which could exceed the real length (round(100.5) = 101 > 100.5) — keeps
  // both halves of the invariant true and is a no-op for every well-formed
  // integer file. Geometry itself deliberately stays unvalidated: ruling 10
  // requires pre-v1.9 files (including damaged ones v1.8.0 loaded verbatim)
  // to load with identical clip geometry, so rounding or rejecting it here
  // would move clips the shipped reader accepted.
  const len =
    typeof clip.lengthSample === 'number' && Number.isFinite(clip.lengthSample)
      ? Math.floor(clip.lengthSample)
      : 0;
  const pair = clampFadePair(sanitizeFadeLength(clip.fadeInSample), sanitizeFadeLength(clip.fadeOutSample), len, 'in');
  const inCurve = sanitizeFadeCurve(clip.fadeInCurve);
  const outCurve = sanitizeFadeCurve(clip.fadeOutCurve);

  const out: Clip = { ...clip };
  delete out.fadeInSample;
  delete out.fadeOutSample;
  delete out.fadeInCurve;
  delete out.fadeOutCurve;
  if (pair.fadeIn > 0) out.fadeInSample = pair.fadeIn;
  if (pair.fadeOut > 0) out.fadeOutSample = pair.fadeOut;
  if (inCurve !== undefined) out.fadeInCurve = inCurve;
  if (outCurve !== undefined) out.fadeOutCurve = outCurve;
  return out;
}

/** F0 (traps T12/T13): the automation counterpart of `sanitizeClipFades`,
 * applied at the SAME shared finalize so the v3 AND the legacy v1/v2 parse
 * paths are both covered — the first (and so far only) track-LEVEL sanitiser.
 * The arithmetic lives in `automation.ts` (`sanitizeAutomationLanes`): keys
 * from disk are UNTRUSTED (nothing else between the parse boundary and the
 * two audio engines validates track fields), so a hand-edited `value: null` /
 * `1e999` / string would otherwise flow straight into both engines' gain
 * path. An invalid or emptied field is DELETED — garbage round-trips back to
 * "no key on disk", never to a default-valued key — while a track that never
 * had the field never gains one. Unknown OTHER track keys stay untouched
 * (spread tolerance — the forward-compat mechanism). */
function sanitizeTrackAutomation(track: Track): Track {
  const lanes = sanitizeAutomationLanes((track as { automation?: unknown }).automation);
  const out: Track = { ...track };
  delete out.automation;
  if (lanes !== undefined) out.automation = lanes;
  return out;
}

function finalizeParsedSession(
  parsedSession: Session,
  idMap: Map<string, string>,
  recreatedIds: Set<string>,
  rawMarkers: Record<string, Marker[]> | undefined,
  documents: AudioDocument[]
): { session: Session; droppedClipCount: number; markers: Record<string, Marker[]> } {
  let droppedClipCount = 0;
  const session: Session = {
    ...parsedSession,
    tracks: parsedSession.tracks.map((t) =>
      sanitizeTrackAutomation({
        ...t,
        clips: t.clips
          .map((c) => sanitizeClipFades({ ...c, documentId: idMap.get(c.documentId) ?? c.documentId }))
          .filter((c) => {
            const keep = recreatedIds.has(c.documentId);
            if (!keep) droppedClipCount++;
            return keep;
          }),
      })
    ),
  };

  // Seeded from the raw file, not the (possibly clip-dropping) `session`
  // above: a dropped clip's id must still be retired so nothing minted later
  // in the process can reuse it.
  const trackIds = parsedSession.tracks.map((t) => t.id);
  const clipIds = parsedSession.tracks.flatMap((t) => t.clips.map((c) => c.id));
  bumpIdCounter('track', maxIdSuffix(trackIds, 'track') + 1);
  bumpIdCounter('clip', maxIdSuffix(clipIds, 'clip') + 1);

  const docLengths = new Map(documents.map((d) => [d.id, docLength(d)]));

  const markers: Record<string, Marker[]> = {};
  if (rawMarkers) {
    for (const [oldDocId, list] of Object.entries(rawMarkers)) {
      const newDocId = idMap.get(oldDocId);
      if (!newDocId) continue; // stale reference to a doc that wasn't recreated
      const length = docLengths.get(newDocId) ?? 0;
      markers[newDocId] = list
        .map((m) => ({
          id: nextId('marker'),
          name: m.name,
          positionSample: Math.max(0, Math.min(length, m.positionSample)),
        }))
        .sort((a, b) => a.positionSample - b.positionSample);
    }
  }

  return { session, droppedClipCount, markers };
}

/**
 * Parses a legacy .audm v1/v2 JSON string, decoding each embedded document
 * (base64 WAV) with fresh ('doc-N') ids and remapping every clip.documentId
 * through the old->new id map. Throws if formatVersion isn't v1 or v2.
 * Unchanged by the v3 work — this is the "otherwise legacy v1/v2 JSON path"
 * `parseSessionFileBytes` falls back to for any file that doesn't start with
 * the v3 magic.
 */
export function parseSessionFile(text: string): {
  session: Session;
  documents: AudioDocument[];
  droppedClipCount: number;
  markers: Record<string, Marker[]>;
} {
  const parsed = JSON.parse(text) as SessionFileShape;
  if (!SUPPORTED_VERSIONS.has(parsed.formatVersion)) {
    throw new Error(
      `Unsupported session file version: ${parsed.formatVersion} (expected one of ${[...SUPPORTED_VERSIONS].join(', ')})`
    );
  }

  seedDocCounterFromRawClips(parsed.session);

  const idMap = new Map<string, string>();
  const documents: AudioDocument[] = parsed.documents.map((fd) => {
    const decoded = decodeWav(base64ToBuffer(fd.wavBase64));
    // `neverSaved: false` (Task S4): this audio came off disk — it lives in
    // the .audm being opened. The document has no filePath of its own, but
    // closing it discards nothing that reopening the session wouldn't restore.
    const doc = createDocument({
      name: fd.name,
      sampleRate: decoded.sampleRate,
      channels: decoded.channels,
      neverSaved: false,
    });
    idMap.set(fd.id, doc.id);
    return doc;
  });

  const recreatedIds = new Set(documents.map((d) => d.id));
  const { session, droppedClipCount, markers } = finalizeParsedSession(
    parsed.session,
    idMap,
    recreatedIds,
    parsed.markers,
    documents
  );

  return { session, documents, droppedClipCount, markers };
}

/** True when `bytes` starts with the v3 magic `AUDM3\n`. */
function hasV3Magic(bytes: Uint8Array): boolean {
  if (bytes.length < V3_MAGIC.length) return false;
  for (let i = 0; i < V3_MAGIC.length; i++) {
    if (bytes[i] !== V3_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Parses a .audm v3 binary buffer (see the byte-layout comment above
 * `V3_MAGIC`). Every document's channels are copied (not merely wrapped) out
 * of the payload slice into their own `Float32Array` — the payload's start
 * offset (10 + jsonByteLength) isn't guaranteed to be 4-byte aligned, so a
 * `Float32Array` can't be constructed as a view directly over the original
 * buffer at an arbitrary byte offset; `ArrayBuffer.slice` copies into a fresh,
 * zero-offset buffer that's always safely aligned.
 *
 * Throws a descriptive error (never lets a `RangeError`/`TypeError` from a
 * malformed/truncated buffer propagate as something opaque) for: a header
 * that's cut short, a JSON slice that runs past the end of the file, JSON
 * that doesn't parse, a formatVersion other than 3, a missing/malformed
 * `audio` index, a non-integer/negative declared sample `length`, a missing
 * per-doc channel list, a channel whose declared byteLength disagrees with
 * its declared sample count, or a channel offset/length that runs past the
 * end of the payload — i.e. any corrupt-or-truncated v3 file (or a hostile
 * hand-built one) yields a clean error instead of a crash. A missing `name`
 * on an otherwise-valid entry falls back to 'Untitled' rather than crashing
 * or leaving the Files panel showing `undefined`.
 */
export function parseSessionFileV3(buf: ArrayBuffer): {
  session: Session;
  documents: AudioDocument[];
  droppedClipCount: number;
  markers: Record<string, Marker[]>;
} {
  const bytes = new Uint8Array(buf);
  if (bytes.length < V3_HEADER_BYTES || !hasV3Magic(bytes)) {
    throw new Error('Corrupt .audm file: not a valid v3 session (missing AUDM3 header)');
  }

  const jsonByteLength = new DataView(buf).getUint32(6, true);
  const jsonStart = V3_HEADER_BYTES;
  const jsonEnd = jsonStart + jsonByteLength;
  if (jsonEnd > bytes.length) {
    throw new Error('Corrupt .audm file: truncated (JSON metadata runs past end of file)');
  }

  let parsed: SessionFileShapeV3;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(jsonStart, jsonEnd))) as SessionFileShapeV3;
  } catch {
    throw new Error('Corrupt .audm file: invalid JSON metadata');
  }
  if (parsed.formatVersion !== 3) {
    throw new Error(`Unsupported session file version: ${parsed.formatVersion} (expected 3)`);
  }
  if (!Array.isArray(parsed.audio)) {
    throw new Error('Corrupt .audm file: missing audio index');
  }

  const payloadStart = jsonEnd;
  const payloadLength = bytes.length - payloadStart;

  seedDocCounterFromRawClips(parsed.session);

  const idMap = new Map<string, string>();
  const documents: AudioDocument[] = parsed.audio.map((meta) => {
    if (!Number.isInteger(meta.length) || meta.length < 0) {
      throw new Error('Corrupt .audm file: audio index has an invalid sample length');
    }
    if (!Array.isArray(meta.channels)) {
      throw new Error('Corrupt .audm file: audio index entry is missing its channel list');
    }
    const channels: Float32Array[] = meta.channels.map((chMeta) => {
      if (chMeta.byteLength !== meta.length * 4) {
        throw new Error('Corrupt .audm file: channel byte length does not match declared sample count');
      }
      // Final-review fix: require an integer, non-negative offset before
      // using it in arithmetic below -- `null < 0` is `false` and
      // `null + byteLength` silently coerces to `byteLength`, so a
      // hand-corrupted `offset: null` (or a fractional/string one) would
      // otherwise misread payload bytes from the wrong slice instead of
      // being reported as corrupt (matching the guards already applied to
      // `length`/`channels` above).
      if (!Number.isInteger(chMeta.offset) || chMeta.offset < 0) {
        throw new Error('Corrupt .audm file: audio payload offset/length out of range');
      }
      const start = chMeta.offset;
      const end = start + chMeta.byteLength;
      if (end > payloadLength) {
        throw new Error('Corrupt .audm file: audio payload offset/length out of range');
      }
      // Copy into a fresh, zero-offset buffer — see doc comment above.
      return new Float32Array(buf.slice(payloadStart + start, payloadStart + end));
    });
    // Fall back to a generic label rather than `undefined` for a v3 file
    // whose audio index entry lacks a `name` (e.g. hand-built/foreign writer).
    // `neverSaved: false` — see the legacy parser's note above (Task S4).
    const doc = createDocument({
      name: meta.name ?? 'Untitled',
      sampleRate: meta.sampleRate,
      channels,
      neverSaved: false,
    });
    idMap.set(meta.docId, doc.id);
    return doc;
  });

  const recreatedIds = new Set(documents.map((d) => d.id));
  const { session, droppedClipCount, markers } = finalizeParsedSession(
    parsed.session,
    idMap,
    recreatedIds,
    parsed.markers,
    documents
  );

  return { session, documents, droppedClipCount, markers };
}

/** Dispatches a raw .audm file buffer to the v3 binary parser or the legacy
 * v1/v2 JSON parser, based on sniffing the first 6 bytes for the v3 magic.
 * This is what `openSessionViaDialog` calls — callers never need to know
 * which on-disk version they're loading. */
export function parseSessionFileBytes(buf: ArrayBuffer): {
  session: Session;
  documents: AudioDocument[];
  droppedClipCount: number;
  markers: Record<string, Marker[]>;
} {
  const bytes = new Uint8Array(buf);
  if (hasV3Magic(bytes)) {
    return parseSessionFileV3(buf);
  }
  // Legacy path: decoding the whole buffer as one JS string is exactly the
  // V8 string-length-cap hazard v3 exists to avoid, but there is no way to
  // stream-decode an already-written legacy JSON file — this can still throw
  // for a pathologically large v1/v2 file. Left to propagate to the caller's
  // try/catch (openSessionViaDialog) so it surfaces as a clean error message
  // box instead of an uncaught crash, rather than being silently swallowed.
  const text = new TextDecoder().decode(buf);
  return parseSessionFile(text);
}

/** Prompts for a save location and writes the current session (with only its
 * referenced documents) as .audm v3. A cancelled dialog is a no-op. Both
 * serialization and the write are wrapped so any failure — including one
 * `serializeSessionV3` itself throws — surfaces as an error message box
 * instead of an unhandled rejection (F3: previously the base64 serializer
 * could throw past ~402MB of embedded audio with no try/catch anywhere on
 * the call path, so Save Session failed with zero visible feedback). On
 * success, an info box always confirms the save (extended with the
 * dropped-clip count when any clips referenced closed source documents) —
 * success is never silent either.
 *
 * Deliberately does NOT clear any document's `neverSaved` flag (Task S4). A
 * session save is not a document save: it embeds only CLIP-REFERENCED
 * documents (`computeReferenced`), so most open documents aren't in the file
 * at all; what it embeds is a point-in-time COPY under a foreign id, which
 * later edits don't reach and which reopening restores as a NEW document; and
 * the document itself still has no path, so File > Save still prompts a
 * save-as. Clearing the flag here would silently un-guard documents this file
 * never contained. */
export async function saveSessionViaDialog(): Promise<void> {
  const session = useSessionStore.getState().session;
  const docs = useAppStore.getState().documents;

  const defaultName = /\.audm$/i.test(session.name) ? session.name : `${session.name}.audm`;
  const targetPath = await api().showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: 'Auditorium Session', extensions: ['audm'] }],
  });
  if (!targetPath) return; // cancelled

  let bytes: Uint8Array<ArrayBuffer>;
  let droppedClipCount: number;
  try {
    ({ bytes, droppedClipCount } = serializeSessionV3(session, docs, useAppStore.getState().markers));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await api().showMessageBox({ type: 'error', title: 'Save Session failed', message });
    return;
  }

  let result: { ok: true } | { ok: false; error: string };
  try {
    // `bytes` is `serializeSessionV3`'s freshly-allocated Uint8Array — byteOffset
    // 0, byteLength === bytes.buffer.byteLength, and dead after this call — so
    // `bytes.buffer` IS the whole file with nothing to trim. Passing it directly
    // (no `toArrayBuffer` copy) matters here specifically: `writeFile` is a plain
    // `ipcRenderer.invoke` (preload.cjs), which structured-clones its argument
    // rather than transferring/detaching it, so an extra defensive copy would
    // hold 3 live copies of the session's audio at once instead of 2 — halving
    // the largest session save() can handle before OOM, i.e. re-introducing the
    // very ceiling this task exists to raise.
    result = await api().writeFile(targetPath, bytes.buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await api().showMessageBox({ type: 'error', title: 'Save Session failed', message });
    return;
  }
  if (!result.ok) {
    await api().showMessageBox({ type: 'error', title: 'Save Session failed', message: result.error });
    return;
  }

  await api().showMessageBox({
    type: 'info',
    title: 'Save Session',
    message:
      droppedClipCount > 0
        ? `Session saved. ${droppedClipCount} clip(s) referenced closed files and were not saved.`
        : 'Session saved.',
  });
}

/** Prompts for a .audm file, recreates its embedded documents (fresh ids,
 * added to the Files panel via addDocument), replaces the session store's
 * session, and switches the view to 'multitrack'. A cancelled dialog is a
 * no-op; an unsupported/corrupt/truncated file (v1/v2/v3 alike) surfaces an
 * error message box and leaves the current session untouched. If any clips
 * referenced audio that couldn't be recreated (a stale/missing document id),
 * they're dropped and an info message box reports how many. */
export async function openSessionViaDialog(): Promise<void> {
  const paths = await api().showOpenDialog({
    filters: [{ name: 'Auditorium Session', extensions: ['audm'] }],
  });
  if (!paths || paths.length === 0) return; // cancelled

  // readFile and parsing are both inside the try so an IO failure (unapproved
  // path, fs error), a corrupt/truncated v3 file, or a legacy file too large
  // to decode as one JS string all surface the same error box instead of
  // rejecting unhandled.
  let result: {
    session: Session;
    documents: AudioDocument[];
    droppedClipCount: number;
    markers: Record<string, Marker[]>;
  };
  try {
    const buf = await api().readFile(paths[0]);
    result = parseSessionFileBytes(buf);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await api().showMessageBox({ type: 'error', title: 'Open Session failed', message });
    return;
  }

  for (const doc of result.documents) {
    useAppStore.getState().addDocument(doc);
  }
  for (const [docId, markerList] of Object.entries(result.markers)) {
    useAppStore.getState().setMarkersForDoc(docId, markerList);
  }
  useSessionStore.setState({
    session: result.session,
    selectedClipId: null,
    mtCursorSample: 0,
    // MT1 (C1): the session and its zoom are written together, because the zoom
    // IS a function of the session — the longest track across the measured lane.
    // This wrote `{ samplesPerPixel: 512 }` by hand, which is 16 s of timeline
    // whatever the file holds: opening the reported 2:58 session showed 15.97 s
    // of it at ~1114%, which is the filed bug arriving through File → Open
    // Session. Nothing downstream rescued it — `publishSessionLaneWidth` only
    // re-fits a session ALREADY at its fit, and 512 is far zoomed IN of the fit
    // for anything longer than about sixteen seconds.
    mtZoom: defaultSessionZoom(result.session),
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null, // F0: a stale open-envelope target must not outlive its session
  });
  // Every clip in the just-replaced session is either new or a stale id from a
  // previous session — either way no bitmap in the cache belongs to it (F9).
  // R3: opening a session starts a new editing timeline — the previous
  // session's undo history is dropped, exactly as opening a document starts
  // that document's history fresh. (An unrecorded, un-cleared replacement
  // would be silently reverted by the next undo of an older entry — the
  // recording invariant in sessionUndo.ts.)
  clearSessionHistory();
  useAppStore.getState().setView('multitrack');

  if (result.droppedClipCount > 0) {
    await api().showMessageBox({
      type: 'info',
      title: 'Open Session',
      message: `${result.droppedClipCount} clip(s) referenced missing audio and were removed.`,
    });
  }
}
