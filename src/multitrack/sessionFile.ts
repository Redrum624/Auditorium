import { bumpIdCounter, createDocument, type AudioDocument } from '../audio/AudioDocument';
import { decodeWav, encodeWav } from '../audio/wavCodec';
import { useAppStore } from '../stores/appStore';
import type { Session } from './session';
import { useSessionStore } from './sessionStore';

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
 */
export function serializeSession(session: Session, docs: AudioDocument[]): string {
  const referencedIds = new Set<string>();
  for (const track of session.tracks) {
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

  const file: SessionFileShape = { formatVersion: FORMAT_VERSION, session, documents };
  return JSON.stringify(file);
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
 */
export function parseSessionFile(text: string): { session: Session; documents: AudioDocument[] } {
  const parsed = JSON.parse(text) as SessionFileShape;
  if (parsed.formatVersion !== FORMAT_VERSION) {
    throw new Error(`Unsupported session file version: ${parsed.formatVersion} (expected ${FORMAT_VERSION})`);
  }

  const idMap = new Map<string, string>();
  const documents: AudioDocument[] = parsed.documents.map((fd) => {
    const decoded = decodeWav(base64ToBuffer(fd.wavBase64));
    const doc = createDocument({ name: fd.name, sampleRate: decoded.sampleRate, channels: decoded.channels });
    idMap.set(fd.id, doc.id);
    return doc;
  });

  const session: Session = {
    ...parsed.session,
    tracks: parsed.session.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => ({ ...c, documentId: idMap.get(c.documentId) ?? c.documentId })),
    })),
  };

  const trackIds = session.tracks.map((t) => t.id);
  const clipIds = session.tracks.flatMap((t) => t.clips.map((c) => c.id));
  bumpIdCounter('track', maxIdSuffix(trackIds, 'track') + 1);
  bumpIdCounter('clip', maxIdSuffix(clipIds, 'clip') + 1);

  return { session, documents };
}

/** Prompts for a save location and writes the current session (with only its
 * referenced documents) as .audm. A cancelled dialog is a no-op; a failed
 * write surfaces an error message box. */
export async function saveSessionViaDialog(): Promise<void> {
  const session = useSessionStore.getState().session;
  const docs = useAppStore.getState().documents;

  const defaultName = /\.audm$/i.test(session.name) ? session.name : `${session.name}.audm`;
  const targetPath = await api().showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: 'Auditorium Session', extensions: ['audm'] }],
  });
  if (!targetPath) return; // cancelled

  const json = serializeSession(session, docs);
  const data = new TextEncoder().encode(json).buffer;
  const result = await api().writeFile(targetPath, data);
  if (!result.ok) {
    await api().showMessageBox({ type: 'error', title: 'Save Session failed', message: result.error });
  }
}

/** Prompts for a .audm file, recreates its embedded documents (fresh ids,
 * added to the Files panel via addDocument), replaces the session store's
 * session, and switches the view to 'multitrack'. A cancelled dialog is a
 * no-op; an unsupported/corrupt file surfaces an error message box and
 * leaves the current session untouched. */
export async function openSessionViaDialog(): Promise<void> {
  const paths = await api().showOpenDialog({
    filters: [{ name: 'Auditorium Session', extensions: ['audm'] }],
  });
  if (!paths || paths.length === 0) return; // cancelled

  // readFile is inside the try so an IO failure (unapproved path, fs error)
  // surfaces the same error box as a corrupt/unsupported file, instead of
  // rejecting unhandled.
  let result: { session: Session; documents: AudioDocument[] };
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
  useAppStore.getState().setView('multitrack');
}
