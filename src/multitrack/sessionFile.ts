import { bumpIdCounter, createDocument, type AudioDocument } from '../audio/AudioDocument';
import { decodeWav, encodeWav } from '../audio/wavCodec';
import { useAppStore } from '../stores/appStore';
import type { Session } from './session';
import { useSessionStore } from './sessionStore';
import { clearClipWaveformCache } from '../components/Multitrack/clipWaveformCache';

/** .audm format version. Bump when the on-disk shape changes incompatibly. */
const FORMAT_VERSION = 1;

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
}

function api() {
  const a = window.electronAPI;
  if (!a) throw new Error('electronAPI is not available');
  return a;
}

/** Base64-encodes an ArrayBuffer in fixed-size chunks so `String.fromCharCode`
 * is never called with more arguments than the JS engine's call-stack limit
 * allows (a plain `String.fromCharCode(...bytes)` over a large buffer throws
 * "Maximum call stack size exceeded"). */
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
 * Serializes a session to the .audm JSON format. Only documents actually
 * referenced by at least one clip are embedded (as base64 32-bit-float WAV),
 * so unreferenced open documents don't bloat the file.
 *
 * Clips whose documentId has no matching entry in `docs` (i.e. the clip's
 * source document was closed since the clip was added to the session) are
 * dropped from the saved session — otherwise the clip would be written out
 * with no embedded audio, and on load could silently bind to an unrelated
 * document that happens to reuse its stale id (see parseSessionFile).
 * `droppedClipCount` lets the caller warn the user.
 */
export function serializeSession(
  session: Session,
  docs: AudioDocument[]
): { json: string; droppedClipCount: number } {
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

  const documents: SessionFileDocument[] = docs
    .filter((d) => referencedIds.has(d.id))
    .map((d) => ({
      id: d.id,
      name: d.name,
      sampleRate: d.sampleRate,
      channels: d.channels.length,
      wavBase64: bufferToBase64(encodeWav(d.channels, d.sampleRate, 32)),
    }));

  const file: SessionFileShape = { formatVersion: FORMAT_VERSION, session: { ...session, tracks }, documents };
  return { json: JSON.stringify(file), droppedClipCount };
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

/**
 * Parses a .audm JSON string, decoding each embedded document with fresh
 * ('doc-N') ids and remapping every clip.documentId through the old->new id
 * map. Throws if formatVersion isn't the version this build understands.
 *
 * Track/clip ids are kept verbatim from the file, but the per-prefix nextId
 * counters reset every process start — so this also seeds the 'track' and
 * 'clip' counters past the largest suffix in the loaded session, ensuring a
 * later addTrack()/createClip() can never mint a duplicate of a loaded id.
 *
 * The 'doc' counter is seeded too, computed over the raw clip.documentIds as
 * they appear in the file *before* remapping. A well-formed post-fix file
 * never needs this (serializeSession no longer writes clips with no matching
 * open document), but a pre-fix or hand-edited file can retain a stale
 * `doc-N` id on a clip whose source was never embedded; without seeding, a
 * freshly created document later in the process could mint that same id and
 * the orphaned clip would silently bind to unrelated audio. As belt-and-
 * braces, any clip whose (remapped) documentId doesn't match a recreated
 * document is dropped; `droppedClipCount` lets the caller notify the user.
 */
export function parseSessionFile(
  text: string
): { session: Session; documents: AudioDocument[]; droppedClipCount: number } {
  const parsed = JSON.parse(text) as SessionFileShape;
  if (parsed.formatVersion !== FORMAT_VERSION) {
    throw new Error(`Unsupported session file version: ${parsed.formatVersion} (expected ${FORMAT_VERSION})`);
  }

  const rawDocumentIds = parsed.session.tracks.flatMap((t) => t.clips.map((c) => c.documentId));
  bumpIdCounter('doc', maxIdSuffix(rawDocumentIds, 'doc') + 1);

  const idMap = new Map<string, string>();
  const documents: AudioDocument[] = parsed.documents.map((fd) => {
    const decoded = decodeWav(base64ToBuffer(fd.wavBase64));
    const doc = createDocument({ name: fd.name, sampleRate: decoded.sampleRate, channels: decoded.channels });
    idMap.set(fd.id, doc.id);
    return doc;
  });

  const recreatedIds = new Set(documents.map((d) => d.id));
  let droppedClipCount = 0;

  const session: Session = {
    ...parsed.session,
    tracks: parsed.session.tracks.map((t) => ({
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
  const trackIds = parsed.session.tracks.map((t) => t.id);
  const clipIds = parsed.session.tracks.flatMap((t) => t.clips.map((c) => c.id));
  bumpIdCounter('track', maxIdSuffix(trackIds, 'track') + 1);
  bumpIdCounter('clip', maxIdSuffix(clipIds, 'clip') + 1);

  return { session, documents, droppedClipCount };
}

/** Prompts for a save location and writes the current session (with only its
 * referenced documents) as .audm. A cancelled dialog is a no-op; a failed
 * write surfaces an error message box. If any clips referenced a closed
 * source document, they're dropped from the save and, after a successful
 * write, an info message box reports how many. */
export async function saveSessionViaDialog(): Promise<void> {
  const session = useSessionStore.getState().session;
  const docs = useAppStore.getState().documents;

  const defaultName = /\.audm$/i.test(session.name) ? session.name : `${session.name}.audm`;
  const targetPath = await api().showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: 'Auditorium Session', extensions: ['audm'] }],
  });
  if (!targetPath) return; // cancelled

  const { json, droppedClipCount } = serializeSession(session, docs);
  const data = new TextEncoder().encode(json).buffer;
  const result = await api().writeFile(targetPath, data);
  if (!result.ok) {
    await api().showMessageBox({ type: 'error', title: 'Save Session failed', message: result.error });
    return;
  }
  if (droppedClipCount > 0) {
    await api().showMessageBox({
      type: 'info',
      title: 'Save Session',
      message: `${droppedClipCount} clip(s) referenced closed files and were not saved.`,
    });
  }
}

/** Prompts for a .audm file, recreates its embedded documents (fresh ids,
 * added to the Files panel via addDocument), replaces the session store's
 * session, and switches the view to 'multitrack'. A cancelled dialog is a
 * no-op; an unsupported/corrupt file surfaces an error message box and
 * leaves the current session untouched. If any clips referenced audio that
 * couldn't be recreated (a stale/missing document id), they're dropped and
 * an info message box reports how many. */
export async function openSessionViaDialog(): Promise<void> {
  const paths = await api().showOpenDialog({
    filters: [{ name: 'Auditorium Session', extensions: ['audm'] }],
  });
  if (!paths || paths.length === 0) return; // cancelled

  // readFile is inside the try so an IO failure (unapproved path, fs error)
  // surfaces the same error box as a corrupt/unsupported file, instead of
  // rejecting unhandled.
  let result: { session: Session; documents: AudioDocument[]; droppedClipCount: number };
  try {
    const buf = await api().readFile(paths[0]);
    const text = new TextDecoder().decode(buf);
    result = parseSessionFile(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await api().showMessageBox({ type: 'error', title: 'Open Session failed', message });
    return;
  }

  for (const doc of result.documents) {
    useAppStore.getState().addDocument(doc);
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
