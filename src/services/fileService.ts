import { createDocument, docLength, nextId, type AudioDocument } from '../audio/AudioDocument';
import { decodeArrayBuffer } from '../audio/decodeAudio';
import { readFlacStreamInfo } from '../audio/sniffSampleRate';
import { encodeFlac } from '../audio/flacEncoder';
import { readFlacVorbisComment } from '../audio/flacMeta';
import { parseChapterComments } from '../audio/chapterTags';
import { encodeMp3, type Mp3Kbps } from '../audio/mp3Encoder';
import { parseId3Chapters } from '../audio/id3Chapters';
import { encodeOggOpus, OggEncoderUnavailableError } from '../audio/oggOpusEncoder';
import { readOpusTags } from '../audio/oggPage';
import { encodeWav, type WavBitDepth } from '../audio/wavCodec';
import { playbackEngine } from '../audio/PlaybackEngine';
import { useAppStore, type Marker } from '../stores/appStore';
import { clearNoiseProfile, getNoiseProfile } from './noiseProfile';
import { invalidatePeaks } from './peaksCache';
import { clearHistory, markSavePoint, invalidateSavePoint } from './undoHistory';
import { clearClipWaveformCache } from '../components/Multitrack/clipWaveformCache';

export interface ExportOptions {
  format: 'wav' | 'mp3' | 'flac' | 'ogg';
  wavBitDepth: WavBitDepth;
  /** Imported from mp3Encoder.ts (single source of truth) — the CBR bitrates
   * this app's UI offers for MP3 encode. `encodeMp3` measures its marker
   * rescale from the real encoded output rather than predicting it from
   * `kbps`, so this type is just the app's current UI options, not a
   * correctness constraint (Task M6 fix round 2 / IMPORTANT A). */
  mp3Kbps: Mp3Kbps;
  /** Opus bitrate in bits/second; only used when format is 'ogg'. */
  oggBitrate?: 96_000 | 128_000 | 192_000;
}

/** In-place Save bitrate for re-encoded MP3 sources (matches Export's default). */
const MP3_SAVE_KBPS = 192;

/** Copy a Uint8Array into a standalone ArrayBuffer for the IPC writeFile call
 * (which detaches/transfers the buffer). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

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

/** Extract a display message from a thrown/rejected value that may or may not
 * be an Error (encoders can reject with a DOMException or a plain value). */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** docIds with a Save currently in flight (spans the encode + write awaits).
 * `encodeInPlace`'s OGG branch is async (WebCodecs), so a second saveDocument()
 * call for the same doc could otherwise start a second encode/write and race
 * the first. Guarded at the top of the exported saveDocument. */
const inFlightSaves = new Set<string>();

/** Number of documents currently mid-save (encode + write awaits). The close
 * guard's renderer-side reply (App.tsx) includes this alongside the dirty
 * count so a Save that's actually in flight still warns on close even when
 * the doc it's saving happens to read as clean at that instant (Task M4/F7). */
export function getInFlightSaveCount(): number {
  return inFlightSaves.size;
}

/** Encode a document to bytes for the given export options. Exported so the
 * (test-only) test hooks can reuse the exact same encoding path. */
export function encodeExport(doc: AudioDocument, opts: ExportOptions): ArrayBuffer {
  switch (opts.format) {
    case 'wav':
      return encodeWav(doc.channels, doc.sampleRate, opts.wavBitDepth, store().markers[doc.id]);
    case 'mp3':
      return encodeMp3(doc.channels, doc.sampleRate, opts.mp3Kbps, store().markers[doc.id]);
    case 'flac':
      return encodeFlac(doc.channels, doc.sampleRate, 16, store().markers[doc.id]);
    case 'ogg':
      // Opus encoding is async (WebCodecs); exportDocument routes 'ogg' through
      // encodeOggOpus directly, so this synchronous path is never reached.
      throw new Error('OGG export must go through exportDocument (async encodeOggOpus)');
  }
}

/** Re-encode a document into its ORIGINAL container for an in-place Save.
 * MP3 → 192 kbps CBR, carrying the doc's markers as an ID3v2.3 chapter tag
 * (CTOC/CHAP + AUDITORIUM_MARKERS TXXX); FLAC → verbatim FLAC at the source
 * bit depth (16 or 24), carrying the doc's markers as a VORBIS_COMMENT block
 * (CHAPTERxxx + AUDITORIUM_MARKERS); OGG → Opus-in-Ogg at 128 kbps (async via
 * WebCodecs), carrying the doc's markers as an OpusTags block (same
 * CHAPTERxxx + AUDITORIUM_MARKERS comments, converted to the 48 kHz file rate
 * — Task K5); wav/undefined → 32-bit-float WAV (the app's canonical lossless
 * container), carrying the doc's markers as cue/adtl chunks. Rejects with
 * OggEncoderUnavailableError when the Opus encoder is missing (jsdom/no WebCodecs). */
async function encodeInPlace(doc: AudioDocument): Promise<ArrayBuffer> {
  switch (doc.sourceFormat) {
    case 'mp3':
      return encodeMp3(doc.channels, doc.sampleRate, MP3_SAVE_KBPS, store().markers[doc.id]);
    case 'flac':
      // Round UP rather than truncating: a 20-bit source must not silently
      // lose precision down to 16 (Task M6 / F20).
      return encodeFlac(doc.channels, doc.sampleRate, (doc.sourceBitDepth ?? 0) > 16 ? 24 : 16, store().markers[doc.id]);
    case 'ogg':
      return toArrayBuffer(await encodeOggOpus(doc.channels, doc.sampleRate, undefined, store().markers[doc.id]));
    default:
      return encodeWav(doc.channels, doc.sampleRate, 32, store().markers[doc.id]);
  }
}

/**
 * Read, decode, and add a single file as a new document.
 *
 * `.wav`, `.mp3`, `.flac`, and `.ogg` sources keep their `filePath` so Save
 * re-encodes back into that container in place (see `saveDocument`): `.ogg`
 * round-trips as Opus-in-Ogg via WebCodecs. Everything else (m4a, aac, webm,
 * unrecognized) gets `filePath = null`, so its first Save falls back to a
 * save-as `.wav` dialog. The source format and (for WAV/FLAC) the original bit
 * depth are recorded on the document for the Properties panel and Save.
 * Throws on read/decode failure; callers that batch-open catch per file.
 */
export async function openFilePath(path: string): Promise<void> {
  const buf = await api().readFile(path);
  const decoded = await decodeArrayBuffer(buf, path);
  const name = api().pathBasename(path);
  const sourceFormat = formatForPath(path);
  const keepsPath =
    sourceFormat === 'wav' ||
    sourceFormat === 'mp3' ||
    sourceFormat === 'flac' ||
    sourceFormat === 'ogg';
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
  if (decoded.markers && decoded.markers.length > 0) {
    const length = docLength(doc);
    const markers: Marker[] = decoded.markers.map((m) => ({
      id: nextId('marker'),
      name: m.name,
      positionSample: Math.max(0, Math.min(length, m.positionSample)),
    }));
    store().setMarkersForDoc(doc.id, markers);
  } else if (sourceFormat === 'mp3') {
    const chapters = parseId3Chapters(buf);
    if (chapters && chapters.length > 0) {
      const length = docLength(doc);
      const markers: Marker[] = chapters.map((c) => {
        const rawSample = c.exactSample ?? Math.round((c.positionMs / 1000) * doc.sampleRate);
        return {
          id: nextId('marker'),
          name: c.name,
          positionSample: Math.max(0, Math.min(length, rawSample)),
        };
      });
      store().setMarkersForDoc(doc.id, markers);
    }
  } else if (sourceFormat === 'flac') {
    const vorbisComment = readFlacVorbisComment(buf);
    if (vorbisComment) {
      // FLAC's file rate equals the doc's decoded rate (no resample), so
      // AUDITORIUM_MARKERS positions pass through unscaled.
      const chapters = parseChapterComments(vorbisComment.comments, doc.sampleRate);
      if (chapters.length > 0) {
        const length = docLength(doc);
        const markers: Marker[] = chapters.map((c) => ({
          id: nextId('marker'),
          name: c.name,
          positionSample: Math.max(0, Math.min(length, Math.round(c.positionSample))),
        }));
        store().setMarkersForDoc(doc.id, markers);
      }
    }
  } else if (sourceFormat === 'ogg') {
    const opusTags = readOpusTags(buf);
    if (opusTags) {
      // Ogg Opus always decodes at 48 kHz, and AUDITORIUM_MARKERS positions
      // are written at the file's own (48 kHz) rate, so doc.sampleRate maps
      // 1:1 — same reasoning as the FLAC branch above (Task K5).
      const chapters = parseChapterComments(opusTags.comments, doc.sampleRate);
      if (chapters.length > 0) {
        const length = docLength(doc);
        const markers: Marker[] = chapters.map((c) => ({
          id: nextId('marker'),
          name: c.name,
          positionSample: Math.max(0, Math.min(length, Math.round(c.positionSample))),
        }));
        store().setMarkersForDoc(doc.id, markers);
      }
    }
  }
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
 * MP3 → 192 kbps, FLAC → verbatim FLAC at the source bit depth, OGG → Opus-in-
 * Ogg at 128 kbps (`encodeInPlace`). If the Opus encoder is unavailable (no
 * WebCodecs) an in-place `.ogg` Save falls back to the save-as WAV dialog.
 * Otherwise (no path, or Save As) prompt a save-as dialog which always writes
 * WAV. On success name/filePath update and dirty clears — without an undo entry
 * — and `markSavePoint(docId)` records this history position as the doc's save
 * point, so a later undo past it derives `dirty` correctly instead of trusting
 * a stale snapshot flag (Task M2 / F9). A cancelled dialog is a no-op; a failed
 * write, or a non-`OggEncoderUnavailableError` encode failure, surfaces an
 * error message box and leaves the doc dirty (and the save point untouched).
 *
 * A second call for the same `docId` while one is already mid-encode/write
 * (the OGG branch is async) does not start a second write; it surfaces
 * "Save in progress" and returns (Task H1). If any store-observable edit lands
 * on the doc during an in-flight save's encode/write, the save's post-write
 * bookkeeping never clobbers it: the live doc keeps its newer channels and
 * stays dirty, and the save point is NOT marked (Task H1, Task M2).
 */
export async function saveDocument(docId: string, as = false): Promise<void> {
  if (inFlightSaves.has(docId)) {
    // A save for this doc is already mid-encode/write (encodeInPlace's OGG
    // branch is async). Don't start a second write that could race the first.
    await api().showMessageBox({
      type: 'warning',
      title: 'Save in progress',
      message: 'A save is already in progress for this document.',
    });
    return;
  }
  inFlightSaves.add(docId);
  try {
    await saveDocumentLocked(docId, as);
  } finally {
    inFlightSaves.delete(docId);
  }
}

async function saveDocumentLocked(docId: string, as: boolean): Promise<void> {
  const doc = findDoc(docId);
  if (!doc) return;

  // In-place: re-encode into the source container. Only wav/mp3/flac/ogg sources
  // ever carry a filePath (other/exotic sources are opened with filePath = null).
  if (doc.filePath && !as) {
    const targetPath = doc.filePath; // narrowed to string
    const current = findDoc(docId);
    if (!current) return;
    let data: ArrayBuffer;
    try {
      data = await encodeInPlace(current);
    } catch (err) {
      // No Opus encoder here (e.g. no WebCodecs): fall back to the save-as WAV
      // dialog, the same lossless default an exotic source's first Save uses.
      if (err instanceof OggEncoderUnavailableError) {
        await saveAsWav(docId);
        return;
      }
      // Any other encode failure: surface it the same way a write failure is
      // surfaced below, rather than letting it throw upward unhandled.
      await api().showMessageBox({ type: 'error', title: 'Save failed', message: errorMessage(err) });
      return;
    }
    const result = await api().writeFile(targetPath, data);
    if (!result.ok) {
      await api().showMessageBox({ type: 'error', title: 'Save failed', message: result.error });
      return;
    }
    // Only clear dirty (and only write to the store at all) when nothing
    // edited the doc during the encode/write awaits. Every edit replaces the
    // store's doc object (AudioDocument.ts), so reference equality against
    // the pre-await snapshot is a valid "unchanged" test. If it changed, the
    // live doc already has newer channels — leave it untouched and still
    // dirty; the file on disk now holds the older snapshot, same semantics as
    // "save, then edit". Never write the pre-await snapshot's channels back.
    if (findDoc(docId) === current) {
      // encodeInPlace's default branch (sourceFormat 'wav' or undefined) always
      // writes a fresh 32-bit-float WAV, regardless of what sourceBitDepth used
      // to say — retag it here the same way saveAsWav already does, so
      // Properties (and a later re-open of this same path) reports the truth
      // about what's actually on disk instead of a stale source depth (F14).
      const updated: AudioDocument = { ...current, dirty: false };
      if (current.sourceFormat !== 'mp3' && current.sourceFormat !== 'flac' && current.sourceFormat !== 'ogg') {
        updated.sourceFormat = 'wav';
        updated.sourceBitDepth = 32;
      }
      store().updateDocument(updated);
      markSavePoint(docId);
    } else {
      // The write already happened (using the pre-await snapshot), but a
      // concurrent edit landed during the encode/write, so the save point
      // we'd otherwise keep no longer corresponds to what's on disk — make
      // it permanently unreachable (Task M2 finding 2).
      invalidateSavePoint(docId);
    }
    return;
  }

  await saveAsWav(docId);
}

/**
 * Prompt a save-as dialog and write a 32-bit-float WAV (the lossless default),
 * carrying the doc's markers and retagging its provenance to WAV so a later
 * Save writes WAV in place. Shared by the first Save of a path-less/exotic
 * source and the Opus-unavailable in-place `.ogg` fallback. Cancelled dialog is
 * a no-op; a failed write surfaces an error message box.
 */
async function saveAsWav(docId: string): Promise<void> {
  const doc = findDoc(docId);
  if (!doc) return;
  // Replace the source extension rather than appending (F21 — mirrors
  // exportDocument's defaultName), so `song.mp3` defaults to `song.wav`
  // instead of `song.mp3.wav`.
  const baseName = doc.name.replace(/\.[^.]+$/, '');
  let targetPath = await api().showSaveDialog({
    defaultPath: `${baseName}.wav`,
    filters: [{ name: 'Waveform Audio', extensions: ['wav'] }],
  });
  if (!targetPath) return; // cancelled
  // The dialog can return a path with a different (or no) extension if the
  // user retypes the filename (e.g. `take.flac`); enforce `.wav` on the
  // actual write target the same way exportDocument enforces its format
  // extension, so RIFF bytes never land under a non-wav name and mislead a
  // later in-place Save into overwriting it with more WAV bytes (F21).
  if (!isWavPath(targetPath)) {
    targetPath += '.wav';
  }

  // Re-read the latest doc in case it changed while the dialog was open.
  const current = findDoc(docId);
  if (!current) return;
  const data = encodeWav(current.channels, current.sampleRate, 32, store().markers[current.id]);
  const result = await api().writeFile(targetPath, data);
  if (!result.ok) {
    await api().showMessageBox({ type: 'error', title: 'Save failed', message: result.error });
    return;
  }
  // Same staleness discipline as the in-place path: only retag filePath/name/
  // provenance and clear dirty if nothing edited the doc during the write
  // await. If it changed, leave the live (newer) doc untouched and dirty —
  // the just-written file holds the pre-edit snapshot; a later Save will
  // re-prompt (or re-encode in place, once a filePath exists) consistently.
  if (findDoc(docId) === current) {
    store().updateDocument({
      ...current,
      filePath: targetPath,
      name: api().pathBasename(targetPath),
      sourceFormat: 'wav',
      sourceBitDepth: 32,
      dirty: false,
    });
    markSavePoint(docId);
  } else {
    // Same reasoning as the in-place branch: the write already landed, but a
    // concurrent edit invalidates the save point it would otherwise mark.
    invalidateSavePoint(docId);
  }
}

/**
 * Export a document to WAV or MP3 via a save dialog. Unlike Save, export never
 * changes the document's filePath/dirty state. Returns the written path, or null
 * if the dialog was cancelled or the write failed.
 */
export async function exportDocument(docId: string, opts: ExportOptions): Promise<string | null> {
  const doc = findDoc(docId);
  if (!doc) return null;

  const ext = opts.format; // 'wav' | 'mp3' | 'flac' | 'ogg'
  const baseName = doc.name.replace(/\.[^.]+$/, '');
  const filterName =
    opts.format === 'wav'
      ? 'Waveform Audio'
      : opts.format === 'flac'
        ? 'FLAC Audio'
        : opts.format === 'ogg'
          ? 'Ogg Opus Audio'
          : 'MP3 Audio';
  let targetPath = await api().showSaveDialog({
    defaultPath: `${baseName}.${ext}`,
    filters: [{ name: filterName, extensions: [ext] }],
  });
  if (!targetPath) return null; // cancelled
  if (!new RegExp(`\\.${ext}$`, 'i').test(targetPath)) {
    targetPath += `.${ext}`;
  }

  // Opus encoding is async (WebCodecs); the other formats are synchronous.
  let data: ArrayBuffer;
  try {
    data =
      opts.format === 'ogg'
        ? toArrayBuffer(
            await encodeOggOpus(doc.channels, doc.sampleRate, opts.oggBitrate, store().markers[doc.id])
          )
        : encodeExport(doc, opts);
  } catch (err) {
    if (err instanceof OggEncoderUnavailableError) {
      await api().showMessageBox({ type: 'error', title: 'Export failed', message: err.message });
      return null;
    }
    // Any other encode failure (generic Error, DOMException, ...): surface it
    // the same way instead of letting it throw upward unhandled.
    await api().showMessageBox({ type: 'error', title: 'Export failed', message: errorMessage(err) });
    return null;
  }
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

  // Read BEFORE closeDocument() mutates the store, so "no documents remain"
  // below reflects the post-close state (checked after) rather than this one.
  const wasLoaded = playbackEngine.loadedDocumentId === docId;

  store().closeDocument(docId);
  clearHistory(docId);
  invalidatePeaks(docId);
  if (getNoiseProfile()?.docId === docId) clearNoiseProfile();
  // A closing doc can invalidate many clips' cached mini-waveforms at once
  // (every clip sourced from it); clearing the whole cache is cheap and
  // avoids leaking the doc's channels arrays via a retained cache entry (F9).
  clearClipWaveformCache();
  // unload() (not just stop()) when the closed doc is the one actually loaded
  // into the engine, or when no documents remain open at all — otherwise the
  // engine's full AudioBuffer for the closed doc stays resident for the rest
  // of the session (Task M9 / F16). A plain stop() still covers every other
  // case (closing a background doc while a different one stays loaded).
  if (wasLoaded || store().documents.length === 0) {
    playbackEngine.unload();
  } else {
    playbackEngine.stop();
  }
}
