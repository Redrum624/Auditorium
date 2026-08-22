import { bumpIdCounter, createDocument, docLength, nextId, type AudioDocument } from '../audio/AudioDocument';
import { decodeWav, encodeWav } from '../audio/wavCodec';
import { useAppStore, type Marker } from '../stores/appStore';
import type { Clip, Session, Track } from './session';
import { clampFadePair } from './session';
import { sanitizeAutomationLanes } from './automation';
import { FADE_CURVES, type FadeCurve } from '../dsp/fades';
import { useSessionStore } from './sessionStore';
import {
  clearSessionHistory,
  invalidateSessionSavePoint,
  markSessionSavePoint,
  sessionTimelineEpoch,
} from './sessionUndo';
import { defaultSessionZoom } from './sessionZoom';
import { invalidateSavePoint, markSavePoint } from '../services/undoHistory';

/** .audm format version. v1: no markers. v2: adds an optional `markers` map,
 * audio embedded as base64 WAV inside the JSON text. v3: audio moves out of
 * the JSON entirely into a raw binary payload, so no monolithic JS string is
 * ever built for the audio content (the V8 string-length cap made v2 throw a
 * RangeError once embedded audio crossed ~402MB — see F3). v4 (current, write
 * default — see `serializeSessionV4`; lot A, ruling M4): v3's byte layout
 * under an `AUDM4\n` magic, plus an `unreferenced` section so EVERY open
 * document is in the file (v3 embedded only clip-referenced ones), `markers`
 * for every embedded document, and an optional per-document `origin` — the
 * path the document was opened from. The loader accepts all four; only v4 is
 * written by a project save (`writeProject`).
 *
 * v1.9 (X2): clips may additionally carry OPTIONAL fade keys (`fadeInSample`,
 * `fadeOutSample`, `fadeInCurve`, `fadeOutCurve` — see `session.ts`). These
 * ride inside the existing JSON clip records: absent keys mean "no fade", so
 * every pre-fade `.audm` still loads, and the parsers spread clip records
 * through untouched, so unknown keys are simply carried. Fade keys from disk
 * are UNTRUSTED and normalized in `finalizeParsedSession` (see
 * `sanitizeClipFades`).
 *
 * Compatibility (lot A): X2 argued that bumping the version would be a
 * data-loss-class change, because `parseSessionFileV3` hard-rejects any
 * `formatVersion !== 3`. That consequence is now ACCEPTED by ruling M4 — a
 * project save must drop nothing, which v3's shape cannot express — so v4
 * files are unreadable by builds ≤ v1.35. v3, v2 and v1 files still load
 * (`parseSessionFileBytes` sniffs the magic). */
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

/** v4 (lot A, M4) on-disk layout = v3's with a different magic and two JSON
 * additions: header = magic(6) `'AUDM4\n'` + u32 LE jsonByteLength, then the
 * UTF-8 JSON (`SessionFileShapeV4`), then the raw audio payload — the
 * channels of every `audio` entry, then of every `unreferenced` entry,
 * back-to-back, offsets relative to the payload start exactly as v3. */
const V4_MAGIC = new Uint8Array([0x41, 0x55, 0x44, 0x4d, 0x34, 0x0a]); // 'AUDM4\n'
/** Shared by v3 and v4: magic(6) + u32 jsonByteLength(4). */
const BINARY_HEADER_BYTES = V3_HEADER_BYTES;

interface AudioDocMetaV4 extends AudioDocMeta {
  /** The document's `filePath` at save time, when it had one — restored as
   * the recreated document's `filePath` so the project remembers where each
   * file came from. Absent for computed / never-written documents. */
  origin?: string;
}

interface SessionFileShapeV4 {
  formatVersion: 4;
  session: Session; // tracks filtered exactly as v3 (clips of closed docs dropped)
  /** EVERY embedded document with >= 1 marker — referenced or not. */
  markers?: Record<string, Marker[]>;
  /** Clip-referenced documents (the v3 meaning, the v3 order). */
  audio: AudioDocMetaV4[];
  /** M4's section: every OTHER open document, same meta shape, audio in the
   * same payload. The parser treats a missing array as `[]`. */
  unreferenced: AudioDocMetaV4[];
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
 * 32-bit-float WAV per document). No production save calls this (the write
 * default is v4 — see `serializeSessionV4`); retained as the writer for
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
 * the v4 writer keeps the same guarantee and `writeProject` relies on it to
 * hand `bytes.buffer` straight to `writeFile` with no defensive copy (see its
 * comment for why that copy would matter). Lot A: no production save calls
 * this any more (v4 is the write default); it stays as the legacy fixture
 * writer behind the v3 compat tests.
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

/** Lot A (v4): packs one document's channels into `chunks` at the running
 * payload offset and returns its index entry plus the advanced offset. The
 * per-document equal-channel-length throw is the same invariant check
 * `serializeSessionV3` performs inline (the reader validates every channel
 * against one declared `length`). */
function packDocumentV4(
  d: AudioDocument,
  chunks: Uint8Array[],
  payloadLength: number
): { meta: AudioDocMetaV4; payloadLength: number } {
  const length = docLength(d);
  const channels: AudioChannelMeta[] = [];
  for (const channel of d.channels) {
    if (channel.length !== length) {
      throw new Error(
        `Cannot save project: document "${d.name}" (${d.id}) has channels of differing length (${length} vs ${channel.length}), which should never happen`
      );
    }
    const bytes = new Uint8Array(channel.buffer, channel.byteOffset, channel.byteLength);
    channels.push({ offset: payloadLength, byteLength: bytes.byteLength });
    chunks.push(bytes);
    payloadLength += bytes.byteLength;
  }
  const meta: AudioDocMetaV4 = { docId: d.id, name: d.name, sampleRate: d.sampleRate, length, channels };
  if (d.filePath) meta.origin = d.filePath;
  return { meta, payloadLength };
}

/**
 * Serializes the PROJECT to the .audm v4 binary format (write default — lot
 * A, ruling M4): the session plus EVERY open document. Clip-referenced
 * documents go in `audio` (v3's meaning and order); every other open document
 * goes in `unreferenced`; both sections' channels share one raw payload, so
 * nothing is dropped and no JS string is ever built from audio (v3's F3
 * guarantee). Clips whose source document is closed are still filtered out
 * (`computeReferenced`) and counted in `droppedClipCount` — there is no audio
 * to embed for them. Markers are written for every embedded document that
 * has any, referenced or not.
 *
 * Same fresh zero-offset `Uint8Array` guarantee as `serializeSessionV3`
 * (`bytes.byteLength === bytes.buffer.byteLength`) — `writeProject` hands
 * `bytes.buffer` straight to `writeFile` with no defensive copy; see the v3
 * comment for why that copy would matter.
 */
export function serializeSessionV4(
  session: Session,
  docs: AudioDocument[],
  markersByDoc: Record<string, Marker[]> = {}
): { bytes: Uint8Array<ArrayBuffer>; droppedClipCount: number } {
  const { tracks, referencedIds, droppedClipCount } = computeReferenced(session, docs, markersByDoc);

  const audio: AudioDocMetaV4[] = [];
  const unreferenced: AudioDocMetaV4[] = [];
  const channelChunks: Uint8Array[] = [];
  let payloadLength = 0;
  // Payload order: every referenced document's channels first, then every
  // unreferenced one's — each section in `docs` (Files panel) order.
  for (const d of docs.filter((doc) => referencedIds.has(doc.id))) {
    const packed = packDocumentV4(d, channelChunks, payloadLength);
    payloadLength = packed.payloadLength;
    audio.push(packed.meta);
  }
  for (const d of docs.filter((doc) => !referencedIds.has(doc.id))) {
    const packed = packDocumentV4(d, channelChunks, payloadLength);
    payloadLength = packed.payloadLength;
    unreferenced.push(packed.meta);
  }

  const markers: Record<string, Marker[]> = {};
  for (const d of docs) {
    const list = markersByDoc[d.id];
    if (list && list.length > 0) markers[d.id] = list;
  }

  const fileShape: SessionFileShapeV4 = {
    formatVersion: 4,
    session: { ...session, tracks },
    ...(Object.keys(markers).length > 0 ? { markers } : {}),
    audio,
    unreferenced,
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(fileShape));

  const out = new Uint8Array(BINARY_HEADER_BYTES + jsonBytes.byteLength + payloadLength);
  out.set(V4_MAGIC, 0);
  new DataView(out.buffer).setUint32(6, jsonBytes.byteLength, true);
  out.set(jsonBytes, BINARY_HEADER_BYTES);

  let pos = BINARY_HEADER_BYTES + jsonBytes.byteLength;
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

/** True when `bytes` starts with `magic` (`AUDM3\n` or `AUDM4\n`). */
function hasMagic(bytes: Uint8Array, magic: Uint8Array): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

interface ParsedSessionFile {
  session: Session;
  documents: AudioDocument[];
  droppedClipCount: number;
  markers: Record<string, Marker[]>;
}

/**
 * The body shared by `parseSessionFileV3` and `parseSessionFileV4` (lot A):
 * the two formats differ only in their magic, the `formatVersion` they accept
 * and v4's extra `unreferenced` section, which is read with the same guards
 * as `audio`. Every document's channels are copied (not merely wrapped) out
 * of the payload slice into their own `Float32Array` — the payload's start
 * offset (10 + jsonByteLength) isn't guaranteed to be 4-byte aligned, so a
 * `Float32Array` can't be constructed as a view directly over the original
 * buffer at an arbitrary byte offset; `ArrayBuffer.slice` copies into a fresh,
 * zero-offset buffer that's always safely aligned.
 *
 * Throws a descriptive error (never lets a `RangeError`/`TypeError` from a
 * malformed/truncated buffer propagate as something opaque) for: a header
 * that's cut short, a JSON slice that runs past the end of the file, JSON
 * that doesn't parse, a formatVersion other than the one expected, a
 * missing/malformed `audio` (or, v4, a non-array `unreferenced`) index, a
 * non-integer/negative declared sample `length`, a missing per-doc channel
 * list, a channel whose declared byteLength disagrees with its declared
 * sample count, or a channel offset/length that runs past the end of the
 * payload — i.e. any corrupt-or-truncated file (or a hostile hand-built one)
 * yields a clean error instead of a crash. A missing `name` on an
 * otherwise-valid entry falls back to 'Untitled' rather than crashing or
 * leaving the Files panel showing `undefined`; a missing v4 `unreferenced`
 * array is `[]`, not corrupt.
 */
function parseBinarySessionFile(buf: ArrayBuffer, version: 3 | 4): ParsedSessionFile {
  const magic = version === 4 ? V4_MAGIC : V3_MAGIC;
  const bytes = new Uint8Array(buf);
  if (bytes.length < BINARY_HEADER_BYTES || !hasMagic(bytes, magic)) {
    throw new Error(`Corrupt .audm file: not a valid v${version} session (missing AUDM${version} header)`);
  }

  const jsonByteLength = new DataView(buf).getUint32(6, true);
  const jsonStart = BINARY_HEADER_BYTES;
  const jsonEnd = jsonStart + jsonByteLength;
  if (jsonEnd > bytes.length) {
    throw new Error('Corrupt .audm file: truncated (JSON metadata runs past end of file)');
  }

  let parsed: SessionFileShapeV3 | SessionFileShapeV4;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(jsonStart, jsonEnd))) as
      | SessionFileShapeV3
      | SessionFileShapeV4;
  } catch {
    throw new Error('Corrupt .audm file: invalid JSON metadata');
  }
  if (parsed.formatVersion !== version) {
    throw new Error(`Unsupported session file version: ${parsed.formatVersion} (expected ${version})`);
  }
  if (!Array.isArray(parsed.audio)) {
    throw new Error('Corrupt .audm file: missing audio index');
  }
  const unreferenced: AudioDocMetaV4[] =
    version === 4 ? ((parsed as SessionFileShapeV4).unreferenced ?? []) : [];
  if (!Array.isArray(unreferenced)) {
    throw new Error('Corrupt .audm file: malformed unreferenced index');
  }

  const payloadStart = jsonEnd;
  const payloadLength = bytes.length - payloadStart;

  seedDocCounterFromRawClips(parsed.session);

  const idMap = new Map<string, string>();
  const recreate = (meta: AudioDocMetaV4): AudioDocument => {
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
    // Fall back to a generic label rather than `undefined` for a file whose
    // audio index entry lacks a `name` (e.g. hand-built/foreign writer).
    // `neverSaved: false` — see the legacy parser's note above (Task S4).
    // `filePath` from v4's `origin` (lot A) — a v3 entry never carries one.
    const doc = createDocument({
      name: meta.name ?? 'Untitled',
      sampleRate: meta.sampleRate,
      channels,
      neverSaved: false,
      filePath: typeof meta.origin === 'string' && meta.origin.length > 0 ? meta.origin : null,
    });
    idMap.set(meta.docId, doc.id);
    return doc;
  };
  const documents: AudioDocument[] = [...parsed.audio.map(recreate), ...unreferenced.map(recreate)];

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

/** Parses a .audm v3 binary buffer (see the byte-layout comment above
 * `V3_MAGIC`) — `parseBinarySessionFile` with the v3 magic and `(expected 3)`
 * rejection. Kept by name and signature: the legacy fixture round trips and
 * the compat tests pin it. */
export function parseSessionFileV3(buf: ArrayBuffer): ParsedSessionFile {
  return parseBinarySessionFile(buf, 3);
}

/** Parses a .audm v4 binary buffer (lot A): the v3 body plus the
 * `unreferenced` section, every document recreated with `neverSaved: false`
 * and its `origin` (when present) as `filePath`; `documents` = the `audio`
 * entries then the `unreferenced` ones; markers remapped for all of them. */
export function parseSessionFileV4(buf: ArrayBuffer): ParsedSessionFile {
  return parseBinarySessionFile(buf, 4);
}

/** Dispatches a raw .audm file buffer to the v4 or v3 binary parser or the
 * legacy v1/v2 JSON parser, based on sniffing the first 6 bytes for a magic.
 * This is what `loadProjectFrom` calls — callers never need to know which
 * on-disk version they're loading (M4: v3 load compatibility). */
export function parseSessionFileBytes(buf: ArrayBuffer): ParsedSessionFile {
  const bytes = new Uint8Array(buf);
  if (hasMagic(bytes, V4_MAGIC)) {
    return parseSessionFileV4(buf);
  }
  if (hasMagic(bytes, V3_MAGIC)) {
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

// ---------------------------------------------------------------------------
// Lot A (M4) — the project flows: Save / Save As / Open Project.
// ---------------------------------------------------------------------------

/** True while a project save is between its dialog and its write landing.
 * The close guard (App.tsx) counts it as in-flight work, and `saveProject`
 * refuses to start a second one — two writes to the same `.audm` racing
 * each other would be worse than a "Save in progress" box. */
let projectSaveInFlight = false;

export function isProjectSaveInFlight(): boolean {
  return projectSaveInFlight;
}

/** `session.name` with a trailing `.audm` stripped — the default file name a
 * Save As dialog offers, and the name a Save As assigns from the file. */
function projectBaseName(name: string): string {
  return name.replace(/\.audm$/i, '');
}

/**
 * The dialog-free core of a project save (lot A, M4) — also what the
 * headless `saveSessionAs` hook calls, so the smoke proves the real writer.
 *
 * Captures the session, EVERY open document and the markers, serializes them
 * as .audm v4 and writes the file. On success, the bookkeeping follows the
 * same staleness discipline as a document save (`fileService.saveDocument`):
 * the session is renamed (when `opts.rename`) and its save point marked only
 * if nothing replaced `session` during the write await — otherwise the mark
 * is invalidated, because the bytes on disk no longer match the live
 * session; every captured document is marked clean (`dirty: false`,
 * `neverSaved: false` — it IS in the file now, which inverts the S4 reasoning
 * that kept the flag when a session save embedded only clip-referenced
 * documents) if its store object is still the captured one, otherwise its
 * save point is invalidated. Then `projectPath` is remembered.
 *
 * Message policy (N13): plain Save is silent; a dropped-clip count is always
 * reported (it is information the user does not otherwise have); a Save As
 * confirms with 'Project saved.' — `confirmSuccess` is how `saveProject`
 * asks for that on its dialog path. Every failure (serialize throw, write
 * rejection, `{ ok: false }`) surfaces as a 'Save Project failed' error box
 * and returns `false` with nothing marked.
 */
async function writeProjectCore(
  targetPath: string,
  opts: { rename: boolean; confirmSuccess: boolean }
): Promise<boolean> {
  const sessionState = useSessionStore.getState();
  const session = sessionState.session;
  // Which editing timeline these bytes belong to (see `sessionTimelineEpoch`).
  const timelineAtStart = sessionTimelineEpoch();
  const appState = useAppStore.getState();
  const docs = appState.documents;
  const markers = appState.markers;
  const name = opts.rename ? projectBaseName(api().pathBasename(targetPath)) : session.name;

  let bytes: Uint8Array<ArrayBuffer>;
  let droppedClipCount: number;
  try {
    ({ bytes, droppedClipCount } = serializeSessionV4({ ...session, name }, docs, markers));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await api().showMessageBox({ type: 'error', title: 'Save Project failed', message });
    return false;
  }

  let result: { ok: true } | { ok: false; error: string };
  try {
    // `bytes` is `serializeSessionV4`'s freshly-allocated Uint8Array — byteOffset
    // 0, byteLength === bytes.buffer.byteLength, and dead after this call — so
    // `bytes.buffer` IS the whole file with nothing to trim. Passing it directly
    // (no `toArrayBuffer` copy) matters here specifically: `writeFile` is a plain
    // `ipcRenderer.invoke` (preload.cjs), which structured-clones its argument
    // rather than transferring/detaching it, so an extra defensive copy would
    // hold 3 live copies of the project's audio at once instead of 2 — halving
    // the largest project save() can handle before OOM.
    result = await api().writeFile(targetPath, bytes.buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await api().showMessageBox({ type: 'error', title: 'Save Project failed', message });
    return false;
  }
  if (!result.ok) {
    await api().showMessageBox({ type: 'error', title: 'Save Project failed', message: result.error });
    return false;
  }

  // Session bookkeeping — only against the session the bytes were made from.
  const after = useSessionStore.getState();
  if (after.session === session) {
    if (name !== session.name) after.renameSession(name);
    markSessionSavePoint();
  } else {
    invalidateSessionSavePoint();
  }

  // Document bookkeeping — per captured document, same reference test.
  for (const doc of docs) {
    const live = useAppStore.getState().documents.find((d) => d.id === doc.id);
    if (live === doc) {
      useAppStore.getState().updateDocument({ ...doc, dirty: false, neverSaved: false });
      markSavePoint(doc.id);
    } else {
      invalidateSavePoint(doc.id);
    }
  }

  // Remember where the project lives — but only if it is still the SAME
  // project. A load-shaped replacement (Open Project, a stem landing, a cover
  // session) can land inside the await above: separation runs for minutes, and
  // each of those flows sets `projectPath` itself (null for a landing, its own
  // file for an open) on a brand-new timeline. Stamping this save's target over
  // that would bind someone else's content to the file just written, while the
  // stale-branch `invalidateSessionSavePoint()` above reads as clean on the
  // freshly cleared stack: the next plain Ctrl+S would overwrite the project on
  // disk with no dialog. The write itself still happened, and the file it
  // produced is intact.
  if (sessionTimelineEpoch() === timelineAtStart) {
    useSessionStore.getState().setProjectPath(targetPath);
  }

  if (droppedClipCount > 0) {
    await api().showMessageBox({
      type: 'info',
      title: 'Save Project',
      message: `Project saved. ${droppedClipCount} clip(s) referenced closed files and were not saved.`,
    });
  } else if (opts.confirmSuccess) {
    await api().showMessageBox({ type: 'info', title: 'Save Project', message: 'Project saved.' });
  }
  return true;
}

/** The dialog-free project write (see `writeProjectCore`): v4 bytes to
 * `targetPath`, save points, `projectPath`, and the rename when asked — with
 * no success box. Production's Save / Save As go through `saveProject`; the
 * headless `saveSessionAs` hook calls this directly. */
export async function writeProject(targetPath: string, opts: { rename: boolean }): Promise<boolean> {
  return writeProjectCore(targetPath, { rename: opts.rename, confirmSuccess: false });
}

/**
 * File → Save (`as: false`) and Save As (`as: true`) — the project, in every
 * view (M4). Plain Save with a remembered `projectPath` writes there with no
 * dialog and no box on success (N13); with none it IS a Save As. Save As
 * always prompts (default name = the project name, `.audm` enforced on the
 * picked path — `electron/ipc.cjs` approves the appended variant), renames
 * the project to the file's basename when the target differs from the
 * remembered path (a Save As onto the same file keeps the name), and
 * confirms with 'Project saved.'. A cancelled dialog returns `false` with
 * nothing changed. A second call while one is in flight shows 'Save in
 * progress' and returns `false`.
 */
export async function saveProject(opts: { as: boolean }): Promise<boolean> {
  if (projectSaveInFlight) {
    await api().showMessageBox({
      type: 'warning',
      title: 'Save in progress',
      message: 'A project save is already in progress.',
    });
    return false;
  }
  projectSaveInFlight = true;
  try {
    const { session, projectPath } = useSessionStore.getState();
    const viaDialog = opts.as || projectPath === null;
    let target: string;
    if (!viaDialog) {
      target = projectPath as string;
    } else {
      const picked = await api().showSaveDialog({
        defaultPath: `${projectBaseName(session.name)}.audm`,
        filters: [{ name: 'Auditorium Project', extensions: ['audm'] }],
      });
      if (!picked) return false; // cancelled
      target = /\.audm$/i.test(picked) ? picked : `${picked}.audm`;
    }
    return await writeProjectCore(target, { rename: target !== projectPath, confirmSuccess: viaDialog });
  } finally {
    projectSaveInFlight = false;
  }
}

/**
 * Reads and parses a `.audm` (any version) and makes it THE project: every
 * embedded document is added to the Files panel (referenced or not — M4),
 * markers are set, the session replaces the current one with its transients
 * reset and its zoom fitted, the history is cleared (R3: a load starts a new
 * editing timeline), `projectPath` is remembered, and the view switches to
 * multitrack. Throws on a read or parse failure and applies NOTHING in that
 * case — `openSessionViaDialog` turns the throw into an error box; the
 * headless `openSessionFrom` hook lets it propagate.
 */
export async function loadProjectFrom(
  path: string
): Promise<{ droppedClipCount: number; docCount: number; trackCount: number }> {
  const buf = await api().readFile(path);
  const result = parseSessionFileBytes(buf);

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
    projectPath: path, // lot A (M4): this file is where plain Save writes from now on
  });
  // R3: opening a project starts a new editing timeline — the previous
  // session's undo history is dropped, exactly as opening a document starts
  // that document's history fresh. (An unrecorded, un-cleared replacement
  // would be silently reverted by the next undo of an older entry — the
  // recording invariant in sessionUndo.ts.) The cleared stack also reads as
  // "at the save point": a freshly opened project is clean.
  clearSessionHistory();
  useAppStore.getState().setView('multitrack');

  return {
    droppedClipCount: result.droppedClipCount,
    docCount: result.documents.length,
    trackCount: result.session.tracks.length,
  };
}

/** File → Open Project…: prompts for a .audm file and hands it to
 * `loadProjectFrom`. A cancelled dialog is a no-op; an unsupported/corrupt/
 * truncated file (v1–v4 alike) or a read failure surfaces an error message
 * box and leaves the current project untouched. If any clips referenced
 * audio that couldn't be recreated (a stale/missing document id), they're
 * dropped and an info message box reports how many. */
export async function openSessionViaDialog(): Promise<void> {
  // The filter name follows M4's rename, as the save dialog's does (:975):
  // under M4 a .audm IS the project, and every other surface says so (the
  // 'Open Project…' row, both error box titles, the StatusBar chip), so this
  // label would otherwise be the last place calling one a session. A4 briefs
  // only the SAVE filter, so the open one is recorded here as a deliberate
  // un-briefed detail rather than left to be re-derived. It is inert beyond
  // the dialog's own chrome: `cleanFilters` (`electron/ipc.cjs:134-146`)
  // validates shape only, and .audm write approval is by extension (:43).
  const paths = await api().showOpenDialog({
    filters: [{ name: 'Auditorium Project', extensions: ['audm'] }],
  });
  if (!paths || paths.length === 0) return; // cancelled

  // readFile and parsing are both inside the try so an IO failure (unapproved
  // path, fs error), a corrupt/truncated binary file, or a legacy file too
  // large to decode as one JS string all surface the same error box instead
  // of rejecting unhandled — and nothing is applied in any of those cases.
  let droppedClipCount: number;
  try {
    ({ droppedClipCount } = await loadProjectFrom(paths[0]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await api().showMessageBox({ type: 'error', title: 'Open Project failed', message });
    return;
  }

  if (droppedClipCount > 0) {
    await api().showMessageBox({
      type: 'info',
      title: 'Open Project',
      message: `${droppedClipCount} clip(s) referenced missing audio and were removed.`,
    });
  }
}
