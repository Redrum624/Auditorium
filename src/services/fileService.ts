import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { decodeArrayBuffer } from '../audio/decodeAudio';
import { readFlacStreamInfo } from '../audio/sniffSampleRate';
import { encodeFlac } from '../audio/flacEncoder';
import { encodeMp3 } from '../audio/mp3Encoder';
import { encodeWav, type WavBitDepth } from '../audio/wavCodec';
import { playbackEngine } from '../audio/PlaybackEngine';
import { useAppStore } from '../stores/appStore';
import { clearNoiseProfile, getNoiseProfile } from './noiseProfile';
import { invalidatePeaks } from './peaksCache';
import { clearHistory } from './undoHistory';

export interface ExportOptions {
  format: 'wav' | 'mp3' | 'flac';
  wavBitDepth: WavBitDepth;
  mp3Kbps: 128 | 192 | 256 | 320;
}

/** In-place Save bitrate for re-encoded MP3 sources (matches Export's default). */
const MP3_SAVE_KBPS = 192;

type SourceFormat = NonNullable<AudioDocument['sourceFormat']>;

/** Classify an opened file by extension into the provenance formats Save routes
 * on. m4a/aac/webm and anything unrecognized are 'other' (Save-as WAV). */
function formatForPath(path: string): SourceFormat {
  if (/\.wav$/i.test(path)) return 'wav';
  if (/\.mp3$/i.test(path)) return 'mp3';
  if (/\.flac$/i.test(path)) return 'flac';
  if (/\.ogg$/i.test(path)) return 'ogg';
  return 'other';
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
  switch (opts.format) {
    case 'wav':
      return encodeWav(doc.channels, doc.sampleRate, opts.wavBitDepth);
    case 'mp3':
      return encodeMp3(doc.channels, doc.sampleRate, opts.mp3Kbps);
    case 'flac':
      return encodeFlac(doc.channels, doc.sampleRate, 16);
  }
}

/** Re-encode a document into its ORIGINAL container for an in-place Save.
 * MP3 → 192 kbps CBR; FLAC → verbatim FLAC at the source bit depth (16 or 24);
 * wav/undefined → 32-bit-float WAV (the app's canonical lossless container). */
function encodeInPlace(doc: AudioDocument): ArrayBuffer {
  switch (doc.sourceFormat) {
    case 'mp3':
      return encodeMp3(doc.channels, doc.sampleRate, MP3_SAVE_KBPS);
    case 'flac':
      return encodeFlac(doc.channels, doc.sampleRate, doc.sourceBitDepth === 24 ? 24 : 16);
    default:
      return encodeWav(doc.channels, doc.sampleRate, 32);
  }
}

/**
 * Read, decode, and add a single file as a new document.
 *
 * `.wav`, `.mp3`, and `.flac` sources keep their `filePath` so Save re-encodes
 * back into that container in place (see `saveDocument`). `.ogg` and everything
 * else get `filePath = null`, so their first Save falls back to a save-as `.wav`
 * dialog (re-encoding Ogg Vorbis losslessly-enough is out of scope — see
 * docs/KNOWN_LIMITATIONS.md). The source format and (for WAV/FLAC) the original
 * bit depth are recorded on the document for the Properties panel and Save.
 * Throws on read/decode failure; callers that batch-open catch per file.
 */
export async function openFilePath(path: string): Promise<void> {
  const buf = await api().readFile(path);
  const decoded = await decodeArrayBuffer(buf, path);
  const name = api().pathBasename(path);
  const sourceFormat = formatForPath(path);
  const keepsPath =
    sourceFormat === 'wav' || sourceFormat === 'mp3' || sourceFormat === 'flac';
  let sourceBitDepth: number | undefined;
  if (sourceFormat === 'wav') {
    sourceBitDepth = decoded.sourceBitDepth;
  } else if (sourceFormat === 'flac') {
    sourceBitDepth = readFlacStreamInfo(buf)?.bitDepth;
  }
  const doc = createDocument({
    name,
    sampleRate: decoded.sampleRate,
    channels: decoded.channels,
    filePath: keepsPath ? path : null,
    sourceFormat,
    sourceBitDepth,
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
 * Save a document, format-faithfully. When it has a `filePath` and `as` is
 * false, re-encode into the ORIGINAL container in place: WAV → 32-bit float,
 * MP3 → 192 kbps, FLAC → verbatim FLAC at the source bit depth (`encodeInPlace`).
 * Otherwise (no path, or Save As) prompt a save-as dialog which always writes
 * WAV. On success name/filePath update and dirty clears — without an undo entry.
 * A cancelled dialog is a no-op; a failed write surfaces an error message box.
 */
export async function saveDocument(docId: string, as = false): Promise<void> {
  const doc = findDoc(docId);
  if (!doc) return;

  let targetPath: string | null;
  let saveAs: boolean;
  if (doc.filePath && !as) {
    // In-place: re-encode into the source container. Only wav/mp3/flac sources
    // ever carry a filePath (ogg/other are opened with filePath = null).
    targetPath = doc.filePath;
    saveAs = false;
  } else {
    const defaultName = isWavPath(doc.name) ? doc.name : `${doc.name}.wav`;
    targetPath = await api().showSaveDialog({
      defaultPath: defaultName,
      filters: [{ name: 'Waveform Audio', extensions: ['wav'] }],
    });
    if (!targetPath) return; // cancelled
    saveAs = true;
  }

  // Re-read the latest doc in case it changed while the dialog was open.
  const current = findDoc(docId);
  if (!current) return;
  // Save-as always produces WAV; in-place re-encodes into the source container.
  const data = saveAs
    ? encodeWav(current.channels, current.sampleRate, 32)
    : encodeInPlace(current);
  const result = await api().writeFile(targetPath, data);
  if (!result.ok) {
    await api().showMessageBox({ type: 'error', title: 'Save failed', message: result.error });
    return;
  }
  store().updateDocument({
    ...current,
    filePath: targetPath,
    name: api().pathBasename(targetPath),
    // A Save-As to WAV changes the on-disk container; retag provenance so a
    // subsequent Save writes WAV in place rather than the old source format.
    sourceFormat: saveAs ? 'wav' : current.sourceFormat,
    sourceBitDepth: saveAs ? 32 : current.sourceBitDepth,
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

  const ext = opts.format; // 'wav' | 'mp3' | 'flac'
  const baseName = doc.name.replace(/\.[^.]+$/, '');
  const filterName =
    opts.format === 'wav' ? 'Waveform Audio' : opts.format === 'flac' ? 'FLAC Audio' : 'MP3 Audio';
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
 * per-document undo history and peak cache are freed, playback is stopped, and
 * a noise profile captured FROM this document is cleared (Task F8 — the print
 * belongs to audio that no longer exists), so closing never leaks memory or
 * leaves the engine pointed at a gone document.
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
  if (getNoiseProfile()?.docId === docId) clearNoiseProfile();
  playbackEngine.stop();
}
