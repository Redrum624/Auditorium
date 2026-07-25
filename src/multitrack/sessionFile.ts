import { bumpIdCounter, createDocument, docLength, nextId, type AudioDocument } from '../audio/AudioDocument';
import { decodeWav, encodeWav } from '../audio/wavCodec';
import { useAppStore, type Marker } from '../stores/appStore';
import type { Session } from './session';
import { useSessionStore } from './sessionStore';
import { clearClipWaveformCache } from '../components/Multitrack/clipWaveformCache';

/** .audm format version. v1: no markers. v2: adds an optional `markers` map,
 * audio embedded as base64 WAV inside the JSON text. v3 (current, write
 * default — see `serializeSessionV3`): audio moves out of the JSON entirely
 * into a raw binary payload, so no monolithic JS string is ever built for the
 * audio content (the V8 string-length cap made v2 throw a RangeError once
 * embedded audio crossed ~402MB — see F3). The loader accepts all three; only
 * v3 is ever written by `saveSessionViaDialog`. */
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
   * Files-panel display name instead of falling back to a generic label. */
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

/** Copies a Uint8Array into a standalone ArrayBuffer for the IPC writeFile call
 * (which detaches/transfers the buffer). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
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
    const channels: AudioChannelMeta[] = [];
    for (const channel of d.channels) {
      const bytes = new Uint8Array(channel.buffer, channel.byteOffset, channel.byteLength);
      channels.push({ offset: payloadLength, byteLength: bytes.byteLength });
      channelChunks.push(bytes);
      payloadLength += bytes.byteLength;
    }
    audio.push({ docId: d.id, name: d.name, sampleRate: d.sampleRate, length: docLength(d), channels });
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
 */
function finalizeParsedSession(
  parsedSession: Session,
  idMap: Map<string, string>,
  recreatedIds: Set<string>,
  rawMarkers: Record<string, Marker[]> | undefined
): { session: Session; droppedClipCount: number; markers: Record<string, Marker[]> } {
  let droppedClipCount = 0;
  const session: Session = {
    ...parsedSession,
    tracks: parsedSession.tracks.map((t) => ({
      ...t,
      clips: t.clips
        .map((c) => ({ ...c, documentId: idMap.get(c.documentId) ?? c.documentId }))
        .filter((c) => {
          const keep = recreatedIds.has(c.documentId);
          if (!keep) droppedClipCount++;
          return keep;
        }),
    })),
  };

  // Seeded from the raw file, not the (possibly clip-dropping) `session`
  // above: a dropped clip's id must still be retired so nothing minted later
  // in the process can reuse it.
  const trackIds = parsedSession.tracks.map((t) => t.id);
  const clipIds = parsedSession.tracks.flatMap((t) => t.clips.map((c) => c.id));
  bumpIdCounter('track', maxIdSuffix(trackIds, 'track') + 1);
  bumpIdCounter('clip', maxIdSuffix(clipIds, 'clip') + 1);

  const markers: Record<string, Marker[]> = {};
  if (rawMarkers) {
    for (const [oldDocId, list] of Object.entries(rawMarkers)) {
      const newDocId = idMap.get(oldDocId);
      if (!newDocId) continue; // stale reference to a doc that wasn't recreated
      markers[newDocId] = list
        .map((m) => ({ id: nextId('marker'), name: m.name, positionSample: m.positionSample }))
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
    const doc = createDocument({ name: fd.name, sampleRate: decoded.sampleRate, channels: decoded.channels });
    idMap.set(fd.id, doc.id);
    return doc;
  });

  const recreatedIds = new Set(documents.map((d) => d.id));
  const { session, droppedClipCount, markers } = finalizeParsedSession(
    parsed.session,
    idMap,
    recreatedIds,
    parsed.markers
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
 * `audio` index, a channel whose declared byteLength disagrees with its
 * declared sample count, or a channel offset/length that runs past the end of
 * the payload — i.e. any corrupt-or-truncated v3 file yields a clean error
 * instead of a crash.
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
    const channels: Float32Array[] = meta.channels.map((chMeta) => {
      if (chMeta.byteLength !== meta.length * 4) {
        throw new Error('Corrupt .audm file: channel byte length does not match declared sample count');
      }
      const start = chMeta.offset;
      const end = start + chMeta.byteLength;
      if (start < 0 || end > payloadLength) {
        throw new Error('Corrupt .audm file: audio payload offset/length out of range');
      }
      // Copy into a fresh, zero-offset buffer — see doc comment above.
      return new Float32Array(buf.slice(payloadStart + start, payloadStart + end));
    });
    const doc = createDocument({ name: meta.name, sampleRate: meta.sampleRate, channels });
    idMap.set(meta.docId, doc.id);
    return doc;
  });

  const recreatedIds = new Set(documents.map((d) => d.id));
  const { session, droppedClipCount, markers } = finalizeParsedSession(
    parsed.session,
    idMap,
    recreatedIds,
    parsed.markers
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
 * success is never silent either. */
export async function saveSessionViaDialog(): Promise<void> {
  const session = useSessionStore.getState().session;
  const docs = useAppStore.getState().documents;

  const defaultName = /\.audm$/i.test(session.name) ? session.name : `${session.name}.audm`;
  const targetPath = await api().showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: 'Auditorium Session', extensions: ['audm'] }],
  });
  if (!targetPath) return; // cancelled

  let bytes: Uint8Array;
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
    result = await api().writeFile(targetPath, toArrayBuffer(bytes));
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
    mtZoom: { samplesPerPixel: 512, scrollSample: 0 },
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
  });
  // Every clip in the just-replaced session is either new or a stale id from a
  // previous session — either way no bitmap in the cache belongs to it (F9).
  clearClipWaveformCache();
  useAppStore.getState().setView('multitrack');

  if (result.droppedClipCount > 0) {
    await api().showMessageBox({
      type: 'info',
      title: 'Open Session',
      message: `${result.droppedClipCount} clip(s) referenced missing audio and were removed.`,
    });
  }
}
