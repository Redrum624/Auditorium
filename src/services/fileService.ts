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
import {
  applyEditorZoom,
  useAppStore,
  type AppState,
  type Marker,
  type SelectionRange,
} from '../stores/appStore';
import { clearNoiseProfile, getNoiseProfile } from './noiseProfile';
import { beginOpen, endOpen } from './openProgress';
import { invalidatePeaks } from './peaksCache';
import { clearHistory, markSavePoint, invalidateSavePoint } from './undoHistory';
import { invalidateTempo, invalidateRemix } from './tempoAnalysis';
import { releaseBeatGrid } from './beatGrid';
// Two layers, two calls: `tempoAnalysis.invalidateRemix` drops the cached
// remix-level ANALYSIS row; `remixService.invalidateRemixSession` drops the
// remix SESSION (plan, locks, rejections, its retained `sourceChannelRefs`
// and its plan worker). Closing a document must clear both (Task T13).
import { invalidateRemixSession } from './remixService';
import { invalidateStemRun } from './stemService';
import { invalidateTranscript } from './transcribeService';
import { invalidateLyricsAlignment } from './alignLyricsService';
// Lot A (M4): Save is a PROJECT save. No cycle — sessionFile imports the
// stores, sessionUndo, undoHistory, wavCodec and AudioDocument; none of those
// import this module.
import { useSessionStore } from '../multitrack/sessionStore';
import { isSessionDirty } from '../multitrack/sessionUndo';
import { saveProject } from '../multitrack/sessionFile';
// Lot A (M5): Export in the multitrack view renders the session — the offline
// mixdown is playback ground truth and is never diverged from here.
import { mixdownSession } from '../multitrack/mixdown';

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

/** File extensions offered in the Open dialog's Audio filter — and (F11-4) the
 * same list a lane drop checks a dropped file against, since the OS applies no
 * filter to a drag. Exported so that check cannot drift from this one. */
export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm'];

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

/** Lot A (M5): the synchronous encode switch over explicit arguments — what
 * `encodeExport` (a document) and `exportSessionMixdown` / the `exportSession`
 * hook (a render) share, so the two export doors cannot drift in how they
 * encode. `markers` may be `undefined` (a session render carries none). */
export function encodeAudio(
  channels: Float32Array[],
  sampleRate: number,
  markers: Marker[] | undefined,
  opts: ExportOptions
): ArrayBuffer {
  switch (opts.format) {
    case 'wav':
      return encodeWav(channels, sampleRate, opts.wavBitDepth, markers);
    case 'mp3':
      return encodeMp3(channels, sampleRate, opts.mp3Kbps, markers);
    case 'flac':
      return encodeFlac(channels, sampleRate, 16, markers);
    case 'ogg':
      // Opus encoding is async (WebCodecs); exportAudio routes 'ogg' through
      // encodeOggOpus directly, so this synchronous path is never reached.
      throw new Error('OGG export must go through exportAudio (async encodeOggOpus)');
  }
}

/** Encode a document to bytes for the given export options. Exported so the
 * (test-only) test hooks can reuse the exact same encoding path. */
export function encodeExport(doc: AudioDocument, opts: ExportOptions): ArrayBuffer {
  return encodeAudio(doc.channels, doc.sampleRate, store().markers[doc.id], opts);
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

/** Everything `addDocument` overwrites, captured before the open touches it so
 * a rollback can put it back. `addDocument` sets the new document active and
 * resets selection/cursor/zoom (appStore.ts), and `closeDocument` then picks a
 * SURVIVOR by index rather than restoring what was active — so without this a
 * failed open silently moved the user to a different document. */
interface ViewStateSnapshot {
  activeDocumentId: string | null;
  selection: SelectionRange | null;
  cursorSample: number;
  zoom: AppState['zoom'];
}

function captureViewState(): ViewStateSnapshot {
  const s = store();
  return {
    activeDocumentId: s.activeDocumentId,
    selection: s.selection,
    cursorSample: s.cursorSample,
    zoom: s.zoom,
  };
}

/**
 * Undo a half-completed open.
 *
 * The document was added to the store moments ago and nothing else has had a
 * chance to reference it — no analysis, no remix session, no stem run, no noise
 * profile can exist for an id the app has not returned to the event loop with —
 * so unlike `closeDocumentFlow` this needs only the three teardowns that
 * `addDocument` itself makes necessary: `closeDocument` drops the document and
 * its markers, and the other two release the caches keyed on the id.
 *
 * Then it restores the view. `closeDocument` re-activates `documents[min(index,
 * len-1)]` — the LAST survivor, which is only coincidentally the document that
 * was active before. With A, B open and A active, a failed open of C left B
 * active with A's selection, cursor and zoom gone. A failed open must be
 * invisible, so the document that was active is made active again and its
 * selection/cursor/zoom are put back. Playback is deliberately NOT restored:
 * `addDocument` stopped it, the engine really is stopped, and re-asserting a
 * 'playing' flag over a stopped engine would be a lie about the transport.
 */
function rollbackOpen(docId: string, before: ViewStateSnapshot): void {
  store().closeDocument(docId);
  clearHistory(docId);
  invalidatePeaks(docId);

  const { activeDocumentId } = before;
  if (activeDocumentId === null) return;
  // A no-op if that document is gone (closed while this open was in flight);
  // `setActiveDocument` ignores an unknown id, and then the selection/cursor/
  // zoom below would belong to nothing, so bail on the same condition.
  if (!findDoc(activeDocumentId)) return;
  store().setActiveDocument(activeDocumentId);
  // setActiveDocument applies its own activation reset, so these three go
  // after it, not before.
  store().setSelection(before.selection);
  store().setCursor(before.cursorSample);
  // M3: through the ONE clamping writer, not `setZoom` — this was the sixth
  // surface writing the store's zoom raw. A snapshot is only known-good for the
  // lane it was taken against, and an open is exactly the window in which that
  // can change: a decode runs for hundreds of milliseconds, and a panel card
  // opening or the window being dragged wider both re-measure the lane. A WIDER
  // lane shows more of the document, so `maxScroll` shrinks, and restoring the
  // snapshot's scroll verbatim puts the viewport past an end the waveform
  // cannot follow — the F11-9 symptom, through one more door. `resolveZoom`
  // carries an unchanged request through untouched, so the ordinary rollback
  // (nothing resized) restores the snapshot exactly.
  applyEditorZoom(before.zoom);
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
 *
 * Two orderings here are load-bearing, both about memory:
 *
 *  1. **Every scrap of container metadata is read before the decode.** The
 *     decode CONSUMES the bytes (transferred into the decode worker, or
 *     detached by `decodeAudioData`), so a FLAC's stream info, an MP3's ID3
 *     chapters, a FLAC's Vorbis comment and an Ogg's Opus tags are all lifted
 *     out while the buffer is still readable. This used to happen after, which
 *     forced the whole file to stay resident alongside its own decoded samples.
 *  2. **Nothing else holds the bytes across the decode.** The only reference
 *     is the argument handed to `decodeArrayBuffer`, so from the moment it is
 *     posted the file exists in one place, not two.
 *
 * On failure at ANY point the document is rolled back if it had been added, so
 * a decode that dies mid-open cannot leave a blank row selected and the app
 * with a document it can neither draw nor close. The error propagates for the
 * caller to name the file in one dialog.
 *
 * Returns the id of the document it added. F11-4: a lane drop opens a file and
 * must then place THAT document as a clip; making the open say what it made is
 * the alternative to a caller diffing the store around it, which would guess
 * wrong the moment two opens are in flight.
 */
export async function openFilePath(path: string): Promise<string> {
  const name = api().pathBasename(path);
  const sourceFormat = formatForPath(path);
  const keepsPath =
    sourceFormat === 'wav' ||
    sourceFormat === 'mp3' ||
    sourceFormat === 'flac' ||
    sourceFormat === 'ogg';

  // The Files panel shows this while the read and decode run. Cleared in the
  // `finally` on every path — success, failure, or an exception from the store.
  const openToken = beginOpen(path, name);
  // Captured before anything can change it — a failed open has to be able to
  // put the view back exactly as it found it.
  const viewBefore = captureViewState();
  let addedDocId: string | null = null;

  try {
    const buf = await api().readFile(path);

    // --- container metadata, while the bytes are still ours (see 1. above) ---
    const flacBitDepth = sourceFormat === 'flac' ? readFlacStreamInfo(buf)?.bitDepth : undefined;
    const id3Chapters = sourceFormat === 'mp3' ? parseId3Chapters(buf) : null;
    const vorbisComment = sourceFormat === 'flac' ? readFlacVorbisComment(buf) : null;
    const opusTags = sourceFormat === 'ogg' ? readOpusTags(buf) : null;

    // --- the decode consumes `buf`; it is detached from here on ---
    const decoded = await decodeArrayBuffer(buf, path);

    const sourceBitDepth =
      sourceFormat === 'wav' ? decoded.sourceBitDepth : sourceFormat === 'flac' ? flacBitDepth : undefined;

    const doc = createDocument({
      name,
      sampleRate: decoded.sampleRate,
      channels: decoded.channels,
      filePath: keepsPath ? path : null,
      sourceFormat,
      sourceBitDepth,
      channelMask: decoded.channelMask,
      // Task S4: this audio came OFF disk, so closing it loses nothing — even
      // for an exotic source, which keeps no filePath (its first Save prompts a
      // save-as WAV) but whose original file is still sitting there.
      neverSaved: false,
    });
    store().addDocument(doc);
    addedDocId = doc.id;

    if (decoded.markers && decoded.markers.length > 0) {
      const length = docLength(doc);
      const markers: Marker[] = decoded.markers.map((m) => ({
        id: nextId('marker'),
        name: m.name,
        positionSample: Math.max(0, Math.min(length, m.positionSample)),
      }));
      store().setMarkersForDoc(doc.id, markers);
    } else if (id3Chapters && id3Chapters.length > 0) {
      const length = docLength(doc);
      const markers: Marker[] = id3Chapters.map((c) => {
        const rawSample = c.exactSample ?? Math.round((c.positionMs / 1000) * doc.sampleRate);
        return {
          id: nextId('marker'),
          name: c.name,
          positionSample: Math.max(0, Math.min(length, rawSample)),
        };
      });
      store().setMarkersForDoc(doc.id, markers);
    } else if (vorbisComment) {
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
    } else if (opusTags) {
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

    return doc.id;
  } catch (err) {
    // A half-added document is worse than no document: it is selected, it
    // cannot be drawn, and every panel that reads the active document reads
    // one whose audio never arrived. Take it back out and let the caller
    // report the failure once, naming the file.
    if (addedDocId !== null) rollbackOpen(addedDocId, viewBefore);
    throw err;
  } finally {
    endOpen(openToken);
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
 * A failed WRITE additionally offers "Save As…" alongside Cancel, and taking it
 * runs the save-as flow — the only action that resolves a refused location.
 *
 * A plain Save (`as` false) on a document that has a `filePath` and no unsaved
 * work is a NO-OP: no encode, no write, no dialog. Save As (`as` true) always
 * runs — it is an explicit "write this to a file I name" gesture, meaningful
 * whether or not there are edits behind it.
 *
 * A second call for the same `docId` while one is already mid-encode/write
 * (the OGG branch is async) does not start a second write; it surfaces
 * "Save in progress" and returns (Task H1). If any store-observable edit lands
 * on the doc during an in-flight save's encode/write, the save's post-write
 * bookkeeping never clobbers it: the live doc keeps its newer channels and
 * stays dirty, and the save point is NOT marked (Task H1, Task M2).
 *
 * Lot A (M4): NO UI command reaches this any more. File → Save / Save As
 * write the `.audm` project (`sessionFile.saveProject`), and Export is the
 * only way audio leaves the app. `saveDocument`, `saveDocumentLocked`,
 * `saveAsWav`, `encodeInPlace` and `getInFlightSaveCount` are kept, unchanged,
 * as the engine behind the headless `saveActiveInPlace` test hook and the
 * format-faithful round-trip suites (`fileService.test.ts`); deleting them is
 * a follow-up, not this lot.
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

  // Nothing to save. An in-place Save is not a cheap no-op when there is no
  // work behind it: it re-encodes the whole document and overwrites the source
  // file, and for a 16- or 24-bit WAV it also RETAGS the document as 32-bit
  // float (see the write below), so a Save nobody asked for silently rewrites
  // a file and changes what the app reports about it. The command is gated on
  // the same predicate (menuActions `file.save`); this is the second gate, for
  // any programmatic caller that reaches past the command registry.
  //
  // `as` is excluded deliberately: Save As is an explicit export-like gesture —
  // "write this document to a file I am about to name" — and is meaningful on a
  // document with no unsaved work at all. `hasUnsavedWork` covers `neverSaved`
  // too, so a computed document (Mix Down, Remix N, a recording, a stem) that
  // has never been written still saves on its first Save.
  if (!as && doc.filePath && !hasUnsavedWork(doc)) return;

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
      // A denied write used to end here, in a dialog with one button and no
      // way forward: the document's own path is refused by the write policy
      // (a protected directory, a read-only file, a full disk) and nothing in
      // the app offered the one action that resolves every one of those --
      // writing somewhere else. Offer it.
      if (await offerSaveAs(result.error)) {
        await saveAsWav(docId);
      }
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
      // `neverSaved: false` — this document's audio is now on disk at its own
      // path (Task S4). Only reached on a SUCCESSFUL write that also passed
      // the staleness check; every early return above (encode failure, write
      // failure) leaves the flag alone, and so does the stale branch below,
      // whose bytes on disk no longer correspond to the live document.
      const updated: AudioDocument = { ...current, dirty: false, neverSaved: false };
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
 * Report a write failure and ask whether to save somewhere else. Returns true
 * when the user chose "Save As…".
 *
 * `message` is the write layer's own error text, unchanged — it names the real
 * reason (a protected directory, EACCES, a full disk), and that is the half of
 * the dialog the user needs in order to judge whether a different location
 * will help. What changed is that the dialog now has a second half: an action.
 * A single-button error box on a save the user did not ask for is how the
 * incident ended — a modal naming a policy, with nothing to do about it.
 */
async function offerSaveAs(message: string): Promise<boolean> {
  const buttons = ['Save As…', 'Cancel'];
  const choice = await api().showMessageBox({
    type: 'error',
    title: 'Save failed',
    message,
    buttons,
    // Enter lands on Cancel, not on the button that opens a file dialog. This
    // box appears unbidden, on a failure the user did not cause, and a stray
    // Return on it should do nothing rather than start a save-as flow — the
    // same reasoning that put a divider between Open and Save.
    defaultId: buttons.indexOf('Cancel'),
  });
  return choice === 0;
}

/**
 * Prompt a save-as dialog and write a 32-bit-float WAV (the lossless default),
 * carrying the doc's markers and retagging its provenance to WAV so a later
 * Save writes WAV in place. Shared by the first Save of a path-less/exotic
 * source, the Opus-unavailable in-place `.ogg` fallback, and the "Save As…"
 * answer to a denied in-place write. Cancelled dialog is a no-op; a failed
 * write surfaces the error and offers another location.
 *
 * The retry is a LOOP, not a recursive call: the answer to a refused location
 * is a different location, so the offer has to be repeatable, and iterating
 * cannot grow the stack however long the user keeps trying. It ends when they
 * cancel either dialog. Nothing can spin it on its own — `dialog:save` and
 * `dialog:message` are native modals with no auto-answer in any mode,
 * including AUDITORIUM_TEST (electron/ipc.cjs), so every turn of this loop
 * costs two deliberate human clicks.
 */
async function saveAsWav(docId: string): Promise<void> {
  for (;;) {
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
      if (await offerSaveAs(result.error)) continue; // another location
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
        // Task S4: this is the save that gives a computed document (Mix Down,
        // Remix N, a recording, a stem) its first file. Cleared here and nowhere
        // else on this path — a cancelled dialog and a failed write both return
        // before this point, and the stale branch below deliberately skips it.
        neverSaved: false,
      });
      markSavePoint(docId);
    } else {
      // Same reasoning as the in-place branch: the write already landed, but a
      // concurrent edit invalidates the save point it would otherwise mark.
      invalidateSavePoint(docId);
    }
    return;
  }
}

/**
 * Export a document to WAV / FLAC / MP3 / OGG via a save dialog. Unlike Save,
 * export never changes the document's filePath/dirty state. Returns the
 * written path, or null if the dialog was cancelled or the write failed.
 * Lot A: the body is `exportAudio`, shared with the session export (M5).
 */
export async function exportDocument(docId: string, opts: ExportOptions): Promise<string | null> {
  const doc = findDoc(docId);
  if (!doc) return null;
  return exportAudio(
    { name: doc.name, sampleRate: doc.sampleRate, channels: doc.channels, markers: store().markers[doc.id] },
    opts
  );
}

/**
 * Lot A (M5): Export in the multitrack view — the session rendered by
 * `mixdownSession` (mute/solo, automation, fades honoured, hard-clamped;
 * length = the last AUDIBLE clip end), byte-identical to Mix Down to New
 * File, written to the chosen format through `exportAudio`. No document is
 * added, no markers are written, and no document's `filePath` / `dirty` /
 * `neverSaved` changes. Nothing audible (an empty or all-muted session) shows
 * an info box and returns null without opening a dialog. Default file name =
 * the project name with a `.audm` suffix stripped.
 */
export async function exportSessionMixdown(opts: ExportOptions): Promise<string | null> {
  const session = useSessionStore.getState().session;
  const docs = new Map(store().documents.map((d) => [d.id, d]));
  const { channels, sampleRate } = mixdownSession(session, docs);
  if (channels[0].length === 0) {
    await api().showMessageBox({ type: 'info', title: 'Export', message: 'Nothing audible to export.' });
    return null;
  }
  return exportAudio(
    { name: session.name.replace(/\.audm$/i, ''), sampleRate, channels: [channels[0], channels[1]] },
    opts
  );
}

/**
 * The export flow proper (lot A — extracted from `exportDocument` so the
 * session export shares it byte for byte): the save dialog with the format's
 * filter and the display name's extension replaced, the format extension
 * enforced on the picked path, the ogg-vs-synchronous encode fed from `src`,
 * the write, and the 'Export complete' box. `src.markers` is what the encoder
 * embeds (a document's markers; nothing for a session render).
 */
export async function exportAudio(
  src: { name: string; sampleRate: number; channels: Float32Array[]; markers?: Marker[] },
  opts: ExportOptions
): Promise<string | null> {
  const ext = opts.format; // 'wav' | 'mp3' | 'flac' | 'ogg'
  const baseName = src.name.replace(/\.[^.]+$/, '');
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
        ? toArrayBuffer(await encodeOggOpus(src.channels, src.sampleRate, opts.oggBitrate, src.markers))
        : encodeAudio(src.channels, src.sampleRate, src.markers, opts);
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

/** True when closing this document would discard work that exists nowhere on
 * disk — either unsaved EDITS (`dirty`) or, for a document the app computed
 * and never wrote, the whole thing (`neverSaved`, Task S4). The two are
 * independent: a Mix Down / `Remix N` / recording / stem is created with no
 * undo entry, so it is CLEAN from the moment it exists, and `dirty` cannot be
 * pressed into service to represent it (undoHistory re-derives `dirty` from
 * the save point, which would silently erase a stamped value on the first
 * undo — see AudioDocument.ts and docs/KNOWN_LIMITATIONS.md). */
export function hasUnsavedWork(doc: AudioDocument): boolean {
  return doc.dirty || doc.neverSaved;
}

// ---- lot A (M4) — the project predicates -----------------------------------

/** True when there is anything to put in a project file: an open document,
 * or a clip on any track. */
export function projectHasContent(): boolean {
  return (
    store().documents.length > 0 ||
    useSessionStore.getState().session.tracks.some((t) => t.clips.length > 0)
  );
}

/**
 * M4's definition, VERBATIM: any document dirty || session dirty || (never
 * written && has content). The third clause is N12's "an empty untitled
 * project is clean" and nothing more — a SAVED project whose session is
 * dirty with no clip and no document (a track added or removed) is dirty,
 * so the content test is not folded around the whole expression. This is
 * what `file.save`, the Save pill, the StatusBar chip and the close guard
 * all read.
 */
export function projectHasUnsavedWork(): boolean {
  const docsDirty = store().documents.some(hasUnsavedWork);
  const neverWritten = useSessionStore.getState().projectPath === null;
  return docsDirty || isSessionDirty() || (neverWritten && projectHasContent());
}

/** The "N item(s)" the close guard reports: each document with unsaved work
 * plus one for a dirty session, and never 0 for a project that has unsaved
 * work (a never-written project with only clean documents counts as 1). */
export function projectDirtyCount(): number {
  if (!projectHasUnsavedWork()) return 0;
  const docs = store().documents.filter(hasUnsavedWork).length;
  return Math.max(1, docs + (isSessionDirty() ? 1 : 0));
}

// ---- end lot A ---------------------------------------------------------------

/**
 * Close a document, prompting to save first when closing would lose work —
 * unsaved edits (`dirty`) OR a document that has never been written to a file
 * at all (`neverSaved`, Task S4), which is how every computed document starts
 * out. Shared by the File > Close command and the Files panel's ✕ button.
 * Guarantees the per-document undo history and peak cache are freed, playback
 * is stopped, and a noise profile captured FROM this document is cleared (Task
 * F8 — the print belongs to audio that no longer exists), so closing never
 * leaks memory or leaves the engine pointed at a gone document.
 */
export async function closeDocumentFlow(docId: string): Promise<void> {
  const doc = findDoc(docId);
  if (!doc) return;

  if (hasUnsavedWork(doc)) {
    // Lot A (M4): the offer is a PROJECT save — the document has no file of
    // its own through Save any more (Export is how audio leaves the app). A
    // never-saved document isn't "changed", it exists only in this project;
    // word each case for what it is.
    const neverSaved = doc.neverSaved;
    const choice = await api().showMessageBox({
      type: 'question',
      title: neverSaved ? 'Unsaved document' : 'Unsaved changes',
      message: neverSaved
        ? `${doc.name} exists only in this project and the project has not been saved. Save the project before closing it?`
        : `${doc.name} has unsaved changes. Save the project before closing it?`,
      buttons: ['Save Project', "Don't Save", 'Cancel'],
    });
    if (choice === 2) return; // Cancel
    if (choice === 0) {
      // Save the project, then close — but abort the close if the save didn't
      // actually land (a cancelled Save As dialog, a failed write): a
      // successful project save clears this document's flags; anything else
      // leaves them set.
      await saveProject({ as: false });
      const afterSave = findDoc(docId);
      if (afterSave && hasUnsavedWork(afterSave)) return;
    }
    // choice === 1 ("Don't Save"): discard and close.
  }

  // `loadedDocumentId` itself isn't touched by closeDocument() (only load()/
  // unload()/dispose() ever change it), so reading it before vs. after the
  // close wouldn't change `wasLoaded` either way. What's deliberate is the
  // OTHER half of the condition below — `documents.length === 0` — which is
  // checked AFTER closeDocument() runs, so it reflects the POST-close
  // document count rather than the pre-close one (Task M9 fix round 1 /
  // MINOR 4 — corrects a misleading "read BEFORE" comment here).
  const wasLoaded = playbackEngine.loadedDocumentId === docId;

  // Task B1: BEFORE the close, not after — `releaseBeatGrid` drops this
  // document's own provenance link AND hands its (small) beat grid to every
  // derived document that inherits it, which it can only read while the
  // document is still in the store and its tempo cache row is still armed.
  // Both of those are gone by the next two lines.
  releaseBeatGrid(docId);

  store().closeDocument(docId);
  clearHistory(docId);
  invalidatePeaks(docId);
  // Task T4: without these, the closed document's channel arrays stay
  // retained by tempoAnalysis's cache (`channelRefs`) for the whole session —
  // the exact leak class peaksCache/clipWaveformCache already manage above.
  // invalidateTempo drops the row unconditionally (any level); invalidateRemix
  // is the narrower remix-only sibling a future remix session also needs on
  // its own close (v15-architecture.md's Invalidation section) — both are
  // called here so a level:'remix' row for this doc is cleared either way.
  invalidateTempo(docId);
  invalidateRemix(docId);
  // Task T13: the remix SESSION must go too — and it must go whether `docId`
  // is the remix document ITSELF or the SOURCE it was planned from (the
  // session retains the source's channel arrays, its whole RemixAnalysis, and
  // — on long tracks — a live plan Worker holding its own resident copy, so a
  // source close would otherwise pin all three for the rest of the session).
  // `invalidateRemixSession` matches on both ids, mirroring the
  // `getNoiseProfile()?.docId === docId` provenance guard right below.
  invalidateRemixSession(docId);
  // Task S3: an in-flight stem separation for this document can no longer
  // deliver anything (the delivery-time staleness gate would discard it), so
  // its ~5 GB utility process must not go on running — and its busy count must
  // not keep the close guard armed. Terminates the run; a no-op otherwise.
  invalidateStemRun(docId);
  // Task F4b: the same accounting for transcription — an in-flight run for a
  // closed document can no longer deliver anything (the delivery-time
  // staleness gate would discard it), and a FINISHED transcript retains the
  // closed document's channel arrays through its staleness snapshot, which is
  // the leak class the three calls above already manage.
  invalidateTranscript(docId);
  // Task F6: and again for the lyrics alignment — same two reasons, the same
  // retained-channels leak class, and a live 378 MB acoustic host that would
  // otherwise go on placing words in audio nobody can see.
  invalidateLyricsAlignment(docId);
  if (getNoiseProfile()?.docId === docId) clearNoiseProfile();
  // A closing doc can invalidate many clips' cached mini-waveforms at once
  // (every clip sourced from it); clearing the whole cache is cheap and
  // avoids leaking the doc's channels arrays via a retained cache entry (F9).
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
