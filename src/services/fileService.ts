import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { decodeArrayBuffer } from '../audio/decodeAudio';
import { encodeMp3 } from '../audio/mp3Encoder';
import { encodeWav, type WavBitDepth } from '../audio/wavCodec';
import { playbackEngine } from '../audio/PlaybackEngine';
import { useAppStore } from '../stores/appStore';
import { invalidatePeaks } from './peaksCache';
import { clearHistory } from './undoHistory';

export interface ExportOptions {
  format: 'wav' | 'mp3';
  wavBitDepth: WavBitDepth;
  mp3Kbps: 128 | 192 | 256 | 320;
}

/** File extensions offered in the Open dialog's Audio filter. */
const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm'];

function api() {
  const a = window.electronAPI;
  if (!a) throw new Error('electronAPI is not available');
  return a;
}

function store() {
  return useAppStore.getState();
}

function isWavPath(p: string): boolean {
  return /\.wav$/i.test(p);
}

function findDoc(docId: string): AudioDocument | undefined {
  return store().documents.find((d) => d.id === docId);
}

/** Encode a document to bytes for the given export options. Exported so the
 * (test-only) test hooks can reuse the exact same encoding path. */
export function encodeExport(doc: AudioDocument, opts: ExportOptions): ArrayBuffer {
  return opts.format === 'wav'
    ? encodeWav(doc.channels, doc.sampleRate, opts.wavBitDepth)
    : encodeMp3(doc.channels, doc.sampleRate, opts.mp3Kbps);
}

/**
 * Read, decode, and add a single file as a new document.
 *
 * Only `.wav` sources keep their `filePath`, so Save writes back in place. The
 * app only ever writes WAV, so non-WAV sources get `filePath = null` and Save
 * falls back to a save-as dialog offering `.wav` (see docs/KNOWN_LIMITATIONS.md).
 * Throws on read/decode failure; callers that batch-open catch per file.
 */
export async function openFilePath(path: string): Promise<void> {
  const buf = await api().readFile(path);
  const decoded = await decodeArrayBuffer(buf, path);
  const name = api().pathBasename(path);
  const filePath = isWavPath(path) ? path : null;
  const doc = createDocument({
    name,
    sampleRate: decoded.sampleRate,
    channels: decoded.channels,
    filePath,
  });
  store().addDocument(doc);
}

/** Prompt for one or more audio files and open each; the last opened becomes
 * active (via addDocument). A failure decoding one file reports an error and
 * continues with the rest. */
export async function openFilesViaDialog(): Promise<void> {
  const paths = await api().showOpenDialog({
    multi: true,
    filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }],
  });
  if (!paths) return; // cancelled
  for (const path of paths) {
    try {
      await openFilePath(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await api().showMessageBox({
        type: 'error',
        title: 'Open failed',
        message: `Could not open ${path}:\n${message}`,
      });
    }
  }
}

/**
 * Save a document as WAV (32-bit float). If it already has a `.wav` filePath and
 * `as` is false, write straight back to that path. Otherwise prompt with a
 * save-as dialog. On success the document's name/filePath update and its dirty
 * flag clears — without creating an undo entry. A cancelled dialog is a no-op; a
 * failed write surfaces an error message box.
 */
export async function saveDocument(docId: string, as = false): Promise<void> {
  const doc = findDoc(docId);
  if (!doc) return;

  let targetPath: string | null;
  if (doc.filePath && isWavPath(doc.filePath) && !as) {
    targetPath = doc.filePath;
  } else {
    const defaultName = isWavPath(doc.name) ? doc.name : `${doc.name}.wav`;
    targetPath = await api().showSaveDialog({
      defaultPath: defaultName,
      filters: [{ name: 'Waveform Audio', extensions: ['wav'] }],
    });
    if (!targetPath) return; // cancelled
  }

  // Re-read the latest doc in case it changed while the dialog was open.
  const current = findDoc(docId);
  if (!current) return;
  const data = encodeWav(current.channels, current.sampleRate, 32);
  const result = await api().writeFile(targetPath, data);
  if (!result.ok) {
    await api().showMessageBox({ type: 'error', title: 'Save failed', message: result.error });
    return;
  }
  store().updateDocument({
    ...current,
    filePath: targetPath,
    name: api().pathBasename(targetPath),
    dirty: false,
  });
}

/**
 * Export a document to WAV or MP3 via a save dialog. Unlike Save, export never
 * changes the document's filePath/dirty state. Returns the written path, or null
 * if the dialog was cancelled or the write failed.
 */
export async function exportDocument(docId: string, opts: ExportOptions): Promise<string | null> {
  const doc = findDoc(docId);
  if (!doc) return null;

  const ext = opts.format; // 'wav' | 'mp3'
  const baseName = doc.name.replace(/\.[^.]+$/, '');
  const filterName = opts.format === 'wav' ? 'Waveform Audio' : 'MP3 Audio';
  let targetPath = await api().showSaveDialog({
    defaultPath: `${baseName}.${ext}`,
    filters: [{ name: filterName, extensions: [ext] }],
  });
  if (!targetPath) return null; // cancelled
  if (!new RegExp(`\\.${ext}$`, 'i').test(targetPath)) {
    targetPath += `.${ext}`;
  }

  const data = encodeExport(doc, opts);
  const result = await api().writeFile(targetPath, data);
  if (!result.ok) {
    await api().showMessageBox({ type: 'error', title: 'Export failed', message: result.error });
    return null;
  }
  await api().showMessageBox({
    type: 'info',
    title: 'Export complete',
    message: `Exported to ${targetPath}`,
  });
  return targetPath;
}

/** Create a silent document of `round(sampleRate * durationSeconds)` samples per
 * channel and make it active. */
export function newDocument(opts: {
  name: string;
  sampleRate: number;
  channels: 1 | 2;
  durationSeconds: number;
}): void {
  const length = Math.round(opts.sampleRate * opts.durationSeconds);
  const channels: Float32Array[] = [];
  for (let c = 0; c < opts.channels; c++) channels.push(new Float32Array(length));
  const doc = createDocument({
    name: opts.name,
    sampleRate: opts.sampleRate,
    channels,
    filePath: null,
  });
  store().addDocument(doc);
}

/**
 * Close a document, prompting to save first when it has unsaved changes. Shared
 * by the File > Close command and the Files panel's ✕ button. Guarantees the
 * per-document undo history and peak cache are freed and playback is stopped, so
 * closing never leaks memory or leaves the engine pointed at a gone document.
 */
export async function closeDocumentFlow(docId: string): Promise<void> {
  const doc = findDoc(docId);
  if (!doc) return;

  if (doc.dirty) {
    const choice = await api().showMessageBox({
      type: 'question',
      title: 'Unsaved changes',
      message: `Save changes to ${doc.name} before closing?`,
      buttons: ['Save', "Don't Save", 'Cancel'],
    });
    if (choice === 2) return; // Cancel
    if (choice === 0) {
      // Save, then close — but abort the close if the save was cancelled (the
      // doc would still be dirty).
      await saveDocument(docId);
      const afterSave = findDoc(docId);
      if (afterSave && afterSave.dirty) return;
    }
    // choice === 1 ("Don't Save"): discard and close.
  }

  store().closeDocument(docId);
  clearHistory(docId);
  invalidatePeaks(docId);
  playbackEngine.stop();
}
