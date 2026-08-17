/**
 * Renderer-side Align Lyrics service (Auditorium F6) — the join between the
 * main-process acoustic host (`electron/alignHost.cjs`, driven by
 * `electron/alignManager.cjs`), the pure Viterbi in `src/dsp/ctcAlign.ts`, the
 * splice in `src/dsp/wordSplice.ts`, and the UI.
 *
 * This is `transcribeService.ts`'s shape, deliberately: renderer service, one
 * run at a time, progress, a Cancel that kills the utility process, a promise
 * that ALWAYS resolves, and a per-document result that an edit marks STALE
 * rather than deletes. Where the two differ, the difference is stated with its
 * reason.
 *
 * ## What this feature is, and the name it is not allowed to have
 *
 * It aligns KNOWN text to a recording and makes each word reachable. It does
 * NOT assess pronunciation. F6's spike evaluated Goodness-of-Pronunciation over
 * this same emission grid and measured **AUC 0.642 against a 0.500 chance
 * baseline, flagging 46 of 51 words** — so nothing in this feature ranks,
 * scores, flags or suggests that any word is wrong. The user's ear decides
 * which word to fix; this module's job is to make that word instantly reachable
 * ({@link previewWord}) and cleanly replaceable ({@link replaceWord}).
 *
 * `AlignedWord.score` exists and is deliberately NOT surfaced per word. It is a
 * placement fit, not a pronunciation verdict, and its only use here is the
 * MEDIAN over all words, which is the lyrics-match warning's statistic
 * ({@link LYRICS_MATCH_THRESHOLD}).
 *
 * ## The pipeline
 *
 *   document channels (native rate, any channel count), selection or whole file
 *     -> average to MONO at the document rate            [one pass, one alloc]
 *     -> resampleChannel(..., 16000)                     [the app's windowed-sinc]
 *     -> IPC 'align:run' -> utilityProcess -> wav2vec2-base-960h (ONNX, CPU EP)
 *     -> {frames, classes, frameSamples, vocab, logProbs}
 *     -> tokenizeLyrics(text, vocab)                     [the MODEL's own vocab]
 *     -> alignLyrics(...)                                [blank-extended Viterbi]
 *     -> frame spans converted to DOCUMENT samples
 *     -> stored per document
 *
 * Positions make the round trip in FRAMES and SAMPLES, never seconds. A frame
 * index maps to a 16 kHz sample offset by the host's own `frameSamples` (320,
 * the feature encoder's total conv stride), and that offset is scaled into the
 * document's rate here — so the spans line up with the waveform at any sample
 * rate, and with the selection they were measured inside.
 *
 * ## Why a replacement leaves the alignment USABLE
 *
 * `spliceWord` returns a region of exactly the length it replaced, so no sample
 * outside `[regionStart, regionEnd)` moves and every OTHER word's span is still
 * exactly right. The generic staleness test in this repo is channel-array
 * IDENTITY (`peaksCache.ts:16-22`), which a splice necessarily breaks — so
 * {@link replaceWord} re-snapshots the identity itself after committing. That
 * is not a loophole in the staleness rule: it is the one edit whose effect on
 * the stored positions is known to be nil, and it is what makes "fix this word,
 * then that one" work without re-running a 378 MB model in between.
 *
 * Any OTHER edit still marks the alignment stale, and a stale alignment is
 * shown with its warning rather than deleted — minutes of inference are not
 * thrown away because the user trimmed a millisecond of silence.
 *
 * ## Replacements come from the microphone, and only from the microphone
 *
 * There is no "import a replacement from a file" affordance. It is a scope
 * decision, not a technical one: a replacement sung here IS your voice, with no
 * provenance to defend.
 *
 * It USED to be a technical one as well, and that reason is gone.
 * `measureNoiseWindow` — which `wordSplice`'s trim derives its threshold from —
 * rejects every window at or below `SILENCE_RMS` (2^-15), so a recording whose
 * pauses are LITERAL ZEROS (a DAW export, a gated bounce) had no floor window
 * to offer, the trim threshold became the word's own envelope peak, and a
 * perfectly good replacement was refused as `silent-replacement`. That was
 * recorded as unreachable from the live-mic path — wrongly: Chromium's fake
 * capture device records exactly that shape, and the packaged smoke hit it.
 * `wordSplice.ts`'s trim now falls back to the absolute digital-silence floor
 * when the recording's own floor yields nothing, and the refusal is judged
 * against that absolute floor too.
 *
 * ## Lifetime
 *
 * One run at a time; a second request resolves `busy` rather than queueing. The
 * utility process is killed on cancel, on a source edit, on source close and on
 * app quit. The returned promise never rejects and never hangs, including when
 * the IPC invoke itself rejects on a dead channel — a hung promise would leave
 * the busy gate shut for the rest of the session.
 */

import { useSyncExternalStore } from 'react';
import { docLength, replaceRegion, type AudioDocument } from '../audio/AudioDocument';
import { playbackEngine } from '../audio/PlaybackEngine';
import { resampleChannel } from '../dsp/resample';
import {
  ALIGN_ACCURACY,
  ALIGN_ACCURACY_SENTENCE,
  LYRICS_MATCH_THRESHOLD,
  alignLyrics,
  lyricsMatchVerdict,
  tokenizeLyrics,
  type AlignedWord,
  type LyricsMatchVerdict,
} from '../dsp/ctcAlign';
import { deriveSeamSamples, spliceWord, type WordSpliceReport } from '../dsp/wordSplice';
import { useAppStore } from '../stores/appStore';
import { applyEdit } from './editOps';

export { ALIGN_ACCURACY, ALIGN_ACCURACY_SENTENCE, LYRICS_MATCH_THRESHOLD };

// ---------------------------------------------------------------------------
// Constants — mirrored from the main-process modules named in each comment.
// Duplicated rather than imported because the renderer must never load anything
// from `electron/` (CommonJS modules that pull in onnxruntime-node).
// ---------------------------------------------------------------------------

/** The model's fixed input rate (`electron/alignHost.cjs` ALIGN_SAMPLE_RATE). */
export const ALIGN_SAMPLE_RATE = 16000;

/**
 * Job-length cap, in 16 kHz samples: 20 minutes.
 *
 * MIRRORED from `alignHost.cjs` MAX_TOTAL_SAMPLES via the manager's
 * `parseAlignRequest`, which rejects anything above it — so the two MUST agree
 * or a job this module accepts is refused at the trust boundary with an opaque
 * "invalid align request".
 */
export const MAX_ALIGN_SAMPLES = ALIGN_SAMPLE_RATE * 1200;

/**
 * Total download size of the pinned two-file model set, used ONLY as the
 * fallback for the "no preload" model state so the dialog can still state a
 * size. The live number comes from `align:model-state`.
 *
 * Derived, not invented: the sum of the two `bytes` pins in
 * `electron/alignManager.cjs` ALIGN_FILES — 377,911,891 + 291.
 */
export const ALIGN_MODEL_BYTES = 377912182;

/**
 * Time-estimate seed: audio-seconds aligned per wall-second.
 *
 * MEASURED, not chosen — the F6 spike's 30.000 s sung excerpt on this machine,
 * CPU EP, session creation excluded, which is also the operating point the host
 * chunks at (`alignHost.cjs` CHUNK_SAMPLES = 30 s). Exported so the dialog
 * states the figure it will actually be held to.
 */
export const MEASURED_ALIGN_REALTIME_FACTOR = 16.4;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AlignModelState {
  downloaded: boolean;
  bytes: number | null;
  expectedBytes: number;
}

export type AlignRunPhase = 'resampling' | 'aligning' | 'placing';

export interface AlignProgress {
  phase: AlignRunPhase;
  /** 16 kHz samples analysed while aligning, 0 otherwise. */
  done: number;
  total: number;
  /** `done / total`, 0 when the total is not known yet. */
  fraction: number;
  elapsedMs: number;
  /** Seeded from {@link MEASURED_ALIGN_REALTIME_FACTOR}, then refined from this
   * run's own measured rate. Never null once a run is under way. */
  estimatedRemainingMs: number | null;
}

/** One placed word. Positions are DOCUMENT samples. */
export interface PlacedWord extends AlignedWord {
  startSample: number;
  endSample: number;
}

export interface LyricsAlignment {
  docId: string;
  docName: string;
  /** The document's rate; every sample position below is in it. */
  sampleRate: number;
  /** The region the alignment was run over — the selection at the time, or the
   * whole document. Word positions are absolute document samples already. */
  regionStart: number;
  regionEnd: number;
  words: PlacedWord[];
  /** The lyrics exactly as the user typed them, so the dialog can restore the
   * text a stored alignment came from. */
  text: string;
  /** Words made only of characters the 32-symbol vocabulary does not have. */
  droppedWords: string[];
  /** Distinct SOUNDED characters dropped from words that survived. */
  droppedCharacters: string[];
  pathScore: number;
  medianWordScore: number;
  verdict: LyricsMatchVerdict;
  /** True when the alignment needed more than one inference chunk, so about one
   * onset in six may sit up to 40 ms from a single-pass placement. */
  chunked: boolean;
  /** Channel-array identity snapshot for {@link isLyricsAlignmentStale}. */
  channelRefs: Float32Array[];
  createdAt: number;
}

export type AlignStatus =
  | 'no-document'
  | 'empty-document'
  | 'empty-text'
  | 'too-long'
  | 'busy'
  | 'model-missing'
  | 'cancelled'
  | 'stale'
  | 'source-closed'
  | 'failed';

export type AlignLyricsResult =
  | { ok: true; alignment: LyricsAlignment }
  | { ok: false; status: AlignStatus; message: string };

export interface AlignLyricsRequest {
  docId: string;
  /** The known lyrics, verbatim. Line breaks are kept so the UI can lay the
   * words out as they were written. */
  text: string;
  onProgress?: (progress: AlignProgress) => void;
}

export type ReplaceWordStatus =
  | 'no-document'
  | 'no-alignment'
  | 'stale'
  | 'bad-word'
  | 'empty-replacement'
  | 'refused'
  | 'failed';

export type ReplaceWordResult =
  | { ok: true; report: WordSpliceReport; word: PlacedWord }
  | { ok: false; status: ReplaceWordStatus; message: string };

export interface ReplaceWordRequest {
  docId: string;
  /** Index into {@link LyricsAlignment.words}. */
  wordIndex: number;
  /** The fresh take. Mono or the document's channel count. */
  replacement: readonly Float32Array[];
  /** The rate the take was captured at — resampled here when it differs from
   * the document's, because `spliceWord` takes ONE rate for both sides. */
  replacementSampleRate: number;
  matchPitch?: boolean;
}

/** The undo entry a replacement lands as. */
export const REPLACE_WORD_UNDO_LABEL = 'Replace Word';

// ---------------------------------------------------------------------------
// The preload surface (electron/preload.cjs), read defensively — jsdom and an
// older preload both legitimately lack it.
// ---------------------------------------------------------------------------

interface AlignApi {
  alignModelState?(): Promise<AlignModelState>;
  alignEnsureModels?(): Promise<{ ok: true } | { ok: false; error: string }>;
  onAlignModelProgress?(
    cb: (p: { file: string; fileIndex: number; fileCount: number; received: number; total: number }) => void
  ): () => void;
  alignRun?(req: {
    sampleRate: number;
    samples: ArrayBuffer;
  }): Promise<
    | {
        ok: true;
        frames: number;
        classes: number;
        frameSamples: number;
        vocab: Record<string, number>;
        logProbs: ArrayBuffer;
      }
    | { ok: false; cancelled?: true; error?: string }
  >;
  alignCancel?(): Promise<{ cancelled: boolean }>;
  onAlignProgress?(cb: (p: { done: number; total: number }) => void): () => void;
  showMessageBox?(opts: {
    type?: 'info' | 'warning' | 'error' | 'question';
    title?: string;
    message: string;
  }): Promise<number>;
  showOpenDialog?(opts: {
    multi?: boolean;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<string[] | null>;
  readFile?(path: string): Promise<ArrayBuffer>;
}

function api(): AlignApi | undefined {
  return (window as unknown as { electronAPI?: AlignApi }).electronAPI;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Terminal failures only — a cancel, a staleness abort or a busy refusal is
 * not an error and must not raise a native dialog (the `stemService.ts` /
 * `transcribeService.ts` one-liner). */
function showFailure(message: string): void {
  void api()?.showMessageBox?.({ type: 'error', title: 'Align Lyrics failed', message });
}

// ---------------------------------------------------------------------------
// Reactivity — version counter + subscribe/getSnapshot, copied in shape from
// transcribeService.ts / stemService.ts. NOT zustand.
// ---------------------------------------------------------------------------

let version = 0;
const listeners = new Set<() => void>();

function bumpVersion(): void {
  version++;
  for (const listener of listeners) listener();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): number {
  return version;
}

/** Re-renders the caller whenever alignment state changes. */
export function useAlignVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function findDoc(docId: string): AudioDocument | undefined {
  return useAppStore.getState().documents.find((d) => d.id === docId);
}

/** Copied VERBATIM from `peaksCache.ts:16-22` — this repo's identity-based
 * "has the audio changed" test. */
function sameChannelRefs(a: readonly Float32Array[], b: readonly Float32Array[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Averages every channel into ONE fresh Float32Array — `transcribeService`'s
 * `monoMix`, restated over a REGION because the alignment may run on a
 * selection. `doc.channels` is read and never transferred. */
export function monoRegion(
  channels: readonly Float32Array[],
  start: number,
  end: number
): Float32Array {
  const length = Math.max(0, end - start);
  const out = new Float32Array(length);
  const count = channels.length;
  if (count === 0) return out;
  for (const ch of channels) {
    const hi = Math.min(end, ch.length);
    for (let i = start; i < hi; i++) out[i - start] += ch[i];
  }
  if (count > 1) {
    for (let i = 0; i < length; i++) out[i] /= count;
  }
  return out;
}

/**
 * Frame index -> DOCUMENT sample, clamped into `[regionStart, regionEnd]`.
 *
 * The clamp is load-bearing at BOTH ends. The host's grid tiles the job
 * exactly, but the LAST frame's span reaches `frames * frameSamples`, which the
 * conv stack's receptive field can put one frame's worth past the region — and
 * a word that ends after the audio does is not a span anything can play or
 * splice.
 */
export function frameToDocSample(
  frame: number,
  frameSamples: number,
  docRate: number,
  regionStart: number,
  regionEnd: number
): number {
  const scaled = regionStart + Math.round(frame * frameSamples * (docRate / ALIGN_SAMPLE_RATE));
  if (scaled < regionStart) return regionStart;
  if (scaled > regionEnd) return regionEnd;
  return scaled;
}

// ---------------------------------------------------------------------------
// The alignment store — one per document
// ---------------------------------------------------------------------------

const alignments = new Map<string, LyricsAlignment>();

/** The stored alignment for `docId`, or null. Non-reactive; pair it with
 * {@link useAlignVersion} in a component. */
export function getLyricsAlignment(docId: string): LyricsAlignment | null {
  return alignments.get(docId) ?? null;
}

/**
 * True when the document's audio has changed since the alignment was made, so
 * its spans no longer describe it. The alignment is KEPT (see the module
 * header) — the UI's job is to say so.
 */
export function isLyricsAlignmentStale(docId: string): boolean {
  const a = alignments.get(docId);
  if (!a) return false;
  const doc = findDoc(docId);
  if (!doc) return true;
  return !sameChannelRefs(a.channelRefs, doc.channels);
}

/**
 * Drops the alignment and aborts any in-flight run for `docId`. MANDATORY in
 * `closeDocumentFlow` alongside `invalidateTranscript`: the stored
 * `channelRefs` otherwise retain the closed document's channel arrays for the
 * rest of the session, and a run for a closed document would keep a ~1 GB
 * utility process alive producing spans that can never land.
 */
export function invalidateLyricsAlignment(docId: string): void {
  const run = active;
  if (run && run.docId === docId) abortRun(run, 'closed');
  if (alignments.delete(docId)) bumpVersion();
}

/** Test-only (this repo's `_xxxForTest` convention). */
export function _resetAlignmentsForTest(): void {
  alignments.clear();
  active = null;
  progressState = null;
  bumpVersion();
}

// ---------------------------------------------------------------------------
// Run state — one at a time, exactly like the manager
// ---------------------------------------------------------------------------

type AbortReason = 'user' | 'edited' | 'closed';

interface ActiveRun {
  id: number;
  docId: string;
  channelRefs: Float32Array[];
  abortReason: AbortReason | null;
  cancelInvoked: boolean;
  settled: boolean;
  startedAt: number;
}

let active: ActiveRun | null = null;
let nextRunId = 1;
let progressState: AlignProgress | null = null;
let staleWatchEnabled = true;

/**
 * Test-only (`transcribeService._setStaleWatchForTest`'s twin). Disables the
 * EARLY-abort store subscription so the DELIVERY-TIME staleness gate can be
 * exercised on its own — in production the subscription always fires first, so
 * that branch would otherwise be untestable, and an untestable guarantee is not
 * a guarantee.
 */
export function _setAlignStaleWatchForTest(enabled: boolean): void {
  staleWatchEnabled = enabled;
}

/** True while an alignment is in flight. */
export function isAligning(): boolean {
  return active !== null;
}

/** Busy-work count for the close guard (App.tsx adds it to
 * `getInFlightSaveCount()`). */
export function getAlignBusyCount(): number {
  return active ? 1 : 0;
}

function publishProgress(
  run: ActiveRun,
  next: Omit<AlignProgress, 'elapsedMs'>,
  onProgress?: (p: AlignProgress) => void
): void {
  if (active !== run) return;
  const progress: AlignProgress = { ...next, elapsedMs: Date.now() - run.startedAt };
  progressState = progress;
  bumpVersion();
  onProgress?.(progress);
}

/** The single abort point — records WHY and kills the utility process exactly
 * once. Abort never settles the promise itself. */
function abortRun(run: ActiveRun, reason: AbortReason): void {
  if (run.settled || run.abortReason) return;
  run.abortReason = reason;
  if (!run.cancelInvoked) {
    run.cancelInvoked = true;
    const bridge = api();
    if (bridge?.alignCancel) {
      void bridge.alignCancel().catch(() => {
        /* the run settles from the invoke's own resolution regardless */
      });
    }
  }
}

/** Cancels the in-flight alignment — the manager kills the utility process. */
export async function cancelAlignment(): Promise<boolean> {
  const run = active;
  if (!run) return false;
  abortRun(run, 'user');
  return true;
}

// ---------------------------------------------------------------------------
// Model state
// ---------------------------------------------------------------------------

/** Cheap existence+size probe over the two-file set. Never throws; an
 * unavailable preload reads as "not downloaded" so the dialog shows its
 * download state rather than an error. */
export async function getAlignModelState(): Promise<AlignModelState> {
  const bridge = api();
  if (!bridge?.alignModelState) {
    return { downloaded: false, bytes: null, expectedBytes: ALIGN_MODEL_BYTES };
  }
  try {
    return await bridge.alignModelState();
  } catch {
    return { downloaded: false, bytes: null, expectedBytes: ALIGN_MODEL_BYTES };
  }
}

/** Verifies-or-downloads the pinned file set, streaming OVERALL byte progress.
 * Always resolves — a download failure is `{ok:false,error}`. */
export async function ensureAlignModels(
  onProgress?: (p: { file: string; fileIndex: number; fileCount: number; received: number; total: number }) => void
): Promise<{ ok: true } | { ok: false; error: string }> {
  const bridge = api();
  if (!bridge?.alignEnsureModels) {
    return { ok: false, error: 'Lyrics alignment is unavailable in this build.' };
  }
  const unsubscribe = onProgress && bridge.onAlignModelProgress ? bridge.onAlignModelProgress(onProgress) : null;
  try {
    return await bridge.alignEnsureModels();
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    unsubscribe?.();
  }
}

// ---------------------------------------------------------------------------
// alignDocumentLyrics
// ---------------------------------------------------------------------------

function fail(status: AlignStatus, message: string): AlignLyricsResult {
  return { ok: false, status, message };
}

function statusForAbort(reason: AbortReason | null): AlignStatus {
  if (reason === 'edited') return 'stale';
  if (reason === 'closed') return 'source-closed';
  return 'cancelled';
}

function messageForAbort(reason: AbortReason | null): string {
  if (reason === 'edited') return 'The audio changed while aligning — the word positions were discarded.';
  if (reason === 'closed') return 'The document was closed while aligning.';
  return 'Alignment was cancelled.';
}

/** The region an alignment runs over: the current selection, clamped into the
 * document, or the whole document when there is none. */
export function alignRegion(doc: AudioDocument, selection: { start: number; end: number } | null): {
  start: number;
  end: number;
} {
  const length = docLength(doc);
  if (!selection) return { start: 0, end: length };
  const start = Math.max(0, Math.min(length, Math.round(selection.start)));
  const end = Math.max(start, Math.min(length, Math.round(selection.end)));
  return end > start ? { start, end } : { start: 0, end: length };
}

/**
 * Aligns `text` to `docId`'s audio and stores the per-word spans. ALWAYS
 * resolves; never throws for a user-facing condition.
 */
export async function alignDocumentLyrics(req: AlignLyricsRequest): Promise<AlignLyricsResult> {
  const bridge = api();
  if (!bridge?.alignRun || !bridge.onAlignProgress) {
    return fail('failed', 'Lyrics alignment is unavailable in this build.');
  }
  // Everything from here to the `active = run` assignment is synchronous, so
  // two calls in the same tick cannot both pass the busy gate.
  if (active) return fail('busy', 'An alignment is already running.');

  if (req.text.trim().length === 0) {
    return fail('empty-text', 'Paste the lyrics you want placed in this recording first.');
  }

  const doc = findDoc(req.docId);
  if (!doc) return fail('no-document', `Document ${req.docId} is not open.`);

  const length = docLength(doc);
  if (length === 0) return fail('empty-document', `${doc.name} has no audio to align against.`);

  const region = alignRegion(doc, useAppStore.getState().selection);
  const regionSamples = region.end - region.start;
  const modelLength = Math.round(regionSamples * (ALIGN_SAMPLE_RATE / doc.sampleRate));
  if (modelLength > MAX_ALIGN_SAMPLES) {
    return fail('too-long', 'Alignment is limited to 20 minutes of audio in one run — select a shorter passage.');
  }
  if (modelLength === 0) {
    return fail('empty-document', `${doc.name} is too short to align against.`);
  }

  const run: ActiveRun = {
    id: nextRunId++,
    docId: doc.id,
    channelRefs: doc.channels.slice(),
    abortReason: null,
    cancelInvoked: false,
    settled: false,
    startedAt: Date.now(),
  };
  active = run;
  const docName = doc.name;
  const sampleRate = doc.sampleRate;
  const seedEstimateMs = ((regionSamples / sampleRate) * 1000) / MEASURED_ALIGN_REALTIME_FACTOR;

  // EARLY abort: an edit or a close must not leave inference burning on audio
  // that no longer exists. The delivery-time re-check below is the guarantee.
  const unsubscribeStore = useAppStore.subscribe(() => {
    if (!staleWatchEnabled || active !== run || run.settled) return;
    const live = findDoc(run.docId);
    if (!live) abortRun(run, 'closed');
    else if (!sameChannelRefs(run.channelRefs, live.channels)) abortRun(run, 'edited');
  });

  const unsubscribers: (() => void)[] = [];

  try {
    const modelState = await getAlignModelState();
    if (run.abortReason) return fail(statusForAbort(run.abortReason), messageForAbort(run.abortReason));
    if (!modelState.downloaded) {
      return fail('model-missing', 'The alignment model has not been downloaded yet (about 378 MB, one time).');
    }

    publishProgress(
      run,
      { phase: 'resampling', done: 0, total: 0, fraction: 0, estimatedRemainingMs: seedEstimateMs },
      req.onProgress
    );

    let outgoing: Float32Array;
    try {
      const mono = monoRegion(doc.channels, region.start, region.end);
      outgoing = resampleChannel(mono, sampleRate, ALIGN_SAMPLE_RATE);
    } catch (err) {
      // An OOM on a memory-pressured machine is a NORMAL failure here.
      showFailure(errorMessage(err));
      return fail('failed', errorMessage(err));
    }
    if (run.abortReason) return fail(statusForAbort(run.abortReason), messageForAbort(run.abortReason));

    const modelSamples = outgoing.length;

    unsubscribers.push(
      bridge.onAlignProgress((p) => {
        if (active !== run || run.settled) return; // settled-run chatter is dropped
        const total = Number.isFinite(p.total) && p.total > 0 ? p.total : modelSamples;
        const done = Number.isFinite(p.done) && p.done > 0 ? p.done : 0;
        const elapsed = Date.now() - run.startedAt;
        publishProgress(
          run,
          {
            phase: 'aligning',
            done,
            total,
            fraction: total > 0 ? Math.min(1, done / total) : 0,
            estimatedRemainingMs:
              done > 0 && total > 0 ? (elapsed / done) * Math.max(0, total - done) : seedEstimateMs,
          },
          req.onProgress
        );
      })
    );

    publishProgress(
      run,
      { phase: 'aligning', done: 0, total: modelSamples, fraction: 0, estimatedRemainingMs: seedEstimateMs },
      req.onProgress
    );

    let result: Awaited<ReturnType<NonNullable<AlignApi['alignRun']>>>;
    try {
      result = await bridge.alignRun({
        sampleRate: ALIGN_SAMPLE_RATE,
        samples: outgoing.buffer as ArrayBuffer,
      });
    } catch (err) {
      // A rejected invoke means the IPC channel itself died. It says nothing
      // about the CHILD, though: the manager may still own a live utility
      // process. Kill it explicitly, or it outlives the run. Deliberately NOT
      // `abortRun` — this is a failure, not an abort.
      if (!run.cancelInvoked) {
        run.cancelInvoked = true;
        void bridge.alignCancel?.().catch(() => {
          /* best-effort: the channel that just died may not answer */
        });
      }
      const message = errorMessage(err);
      showFailure(message);
      return fail('failed', message);
    } finally {
      // The 16 kHz mono buffer is IPC-copied by now.
      outgoing = new Float32Array(0);
    }

    if (run.abortReason) return fail(statusForAbort(run.abortReason), messageForAbort(run.abortReason));

    if (!result.ok) {
      if (result.cancelled) return fail(statusForAbort(run.abortReason), messageForAbort(run.abortReason));
      const message = result.error ?? 'The alignment host failed.';
      showFailure(message);
      return fail('failed', message);
    }

    // DELIVERY-TIME staleness re-check: never store spans that describe audio
    // which no longer exists.
    const live = findDoc(run.docId);
    if (!live) return fail('source-closed', messageForAbort('closed'));
    if (!sameChannelRefs(run.channelRefs, live.channels)) return fail('stale', messageForAbort('edited'));

    publishProgress(
      run,
      { phase: 'placing', done: modelSamples, total: modelSamples, fraction: 1, estimatedRemainingMs: 0 },
      req.onProgress
    );

    const { frames, classes, frameSamples, vocab } = result;
    const logProbs = new Float32Array(result.logProbs);
    if (logProbs.length !== frames * classes) {
      const message = `The alignment host delivered ${logProbs.length} scores for ${frames} frames × ${classes} classes.`;
      showFailure(message);
      return fail('failed', message);
    }

    const tokenized = tokenizeLyrics(req.text, vocab);
    const blankId = vocab['<pad>'];
    if (blankId === undefined) {
      const message = "The model's vocabulary has no CTC blank, so no alignment path can be scored.";
      showFailure(message);
      return fail('failed', message);
    }

    const placed = alignLyrics(logProbs, frames, classes, tokenized, blankId);
    if (!placed.ok) {
      // Not a crash and not a host failure: the lyrics do not fit this audio.
      // Reported inline, without a native error box.
      return fail(placed.reason === 'empty-text' ? 'empty-text' : 'failed', placed.message);
    }

    const words: PlacedWord[] = placed.words.map((w) => ({
      ...w,
      startSample: frameToDocSample(w.startFrame, frameSamples, sampleRate, region.start, region.end),
      endSample: frameToDocSample(w.endFrame, frameSamples, sampleRate, region.start, region.end),
    }));

    const alignment: LyricsAlignment = {
      docId: run.docId,
      docName,
      sampleRate,
      regionStart: region.start,
      regionEnd: region.end,
      words,
      text: req.text,
      droppedWords: tokenized.droppedWords,
      droppedCharacters: tokenized.droppedCharacters,
      pathScore: placed.pathScore,
      medianWordScore: placed.medianWordScore,
      verdict: lyricsMatchVerdict(placed.medianWordScore),
      chunked: modelSamples > ALIGN_ACCURACY.chunkSeconds * ALIGN_SAMPLE_RATE,
      channelRefs: live.channels.slice(),
      createdAt: Date.now(),
    };
    alignments.set(run.docId, alignment);
    return { ok: true, alignment };
  } catch (err) {
    // The always-resolves contract, closed for good: the mono mix and the
    // resample are both large allocations on a long document, so a
    // `RangeError: Array buffer allocation failed` is a NORMAL failure mode.
    const message = errorMessage(err);
    showFailure(message);
    return fail('failed', message);
  } finally {
    run.settled = true;
    for (const off of unsubscribers) off();
    unsubscribeStore();
    if (active === run) {
      active = null;
      progressState = null;
    }
    bumpVersion();
  }
}

// ---------------------------------------------------------------------------
// Reach a word
// ---------------------------------------------------------------------------

/**
 * Plays exactly one word and stops.
 *
 * `playRegion` is the engine's own bounded-playback option, so the sound the
 * user hears is precisely the span the splice would replace — the same two
 * numbers, not an approximation of them. Returns false when there is nothing to
 * play.
 */
export function previewWord(docId: string, wordIndex: number): boolean {
  const alignment = alignments.get(docId);
  if (!alignment) return false;
  const word = alignment.words[wordIndex];
  if (!word || word.endSample <= word.startSample) return false;
  const doc = findDoc(docId);
  if (!doc) return false;
  if (playbackEngine.loadedDocumentId !== docId) playbackEngine.load(doc);
  playbackEngine.play(word.startSample, {
    playRegion: { start: word.startSample, end: word.endSample },
  });
  return true;
}

/**
 * Room the splice may use on each side of a word: to the previous word's end
 * (or the region start) and to the next word's start (or the region end).
 *
 * Both are clamped at 0 because aligned spans can touch — CTC places a word on
 * the frame after its predecessor with no gap at all in legato singing — and a
 * negative "gap" would otherwise shorten the seam below its floor.
 */
export function wordGaps(alignment: LyricsAlignment, wordIndex: number): { before: number; after: number } {
  const words = alignment.words;
  const word = words[wordIndex];
  const prevEnd = wordIndex > 0 ? words[wordIndex - 1].endSample : alignment.regionStart;
  const nextStart = wordIndex + 1 < words.length ? words[wordIndex + 1].startSample : alignment.regionEnd;
  return {
    before: Math.max(0, word.startSample - prevEnd),
    after: Math.max(0, nextStart - word.endSample),
  };
}

// ---------------------------------------------------------------------------
// Replace a word
// ---------------------------------------------------------------------------

function replaceFail(status: ReplaceWordStatus, message: string): ReplaceWordResult {
  return { ok: false, status, message };
}

/**
 * Splices `replacement` over the aligned span of `wordIndex` and commits it as
 * ONE undo entry.
 *
 * The commit is length-preserving by construction (`spliceWord` returns a
 * region of exactly the length it replaced), so no marker moves and no
 * `MarkerRemap` is needed — passing one would describe an edit that did not
 * happen. The stored alignment's channel identity is re-snapshotted afterwards;
 * see the module header for why that is sound.
 */
export async function replaceWord(req: ReplaceWordRequest): Promise<ReplaceWordResult> {
  const alignment = alignments.get(req.docId);
  if (!alignment) return replaceFail('no-alignment', 'Align the lyrics to this recording first.');

  const doc = findDoc(req.docId);
  if (!doc) return replaceFail('no-document', 'The document was closed.');
  if (!sameChannelRefs(alignment.channelRefs, doc.channels)) {
    return replaceFail(
      'stale',
      'The audio changed since these words were placed, so the spans no longer line up. Align the lyrics again before replacing a word.'
    );
  }

  const word = alignment.words[req.wordIndex];
  if (!word) return replaceFail('bad-word', `There is no word ${req.wordIndex} in this alignment.`);
  if ((req.replacement[0]?.length ?? 0) === 0) {
    return replaceFail('empty-replacement', 'The replacement recording is empty.');
  }

  // ONE rate for both sides: `spliceWord` measures level, pitch and the trim
  // threshold across the two documents and cannot do that at two rates.
  let replacement: Float32Array[];
  try {
    replacement =
      req.replacementSampleRate === alignment.sampleRate
        ? req.replacement.map((c) => Float32Array.from(c))
        : req.replacement.map((c) => resampleChannel(c, req.replacementSampleRate, alignment.sampleRate));
  } catch (err) {
    return replaceFail('failed', errorMessage(err));
  }

  const gaps = wordGaps(alignment, req.wordIndex);
  const seamSamples = deriveSeamSamples(alignment.sampleRate, gaps.before, gaps.after);

  const spliced = spliceWord({
    target: doc.channels,
    startSample: word.startSample,
    endSample: word.endSample,
    replacement,
    sampleRate: alignment.sampleRate,
    seamSamples,
    matchPitch: req.matchPitch,
  });
  if (!spliced.ok) return replaceFail('refused', spliced.message);

  const { regionStart, regionEnd } = spliced.report;
  try {
    applyEdit(
      REPLACE_WORD_UNDO_LABEL,
      req.docId,
      (d) => replaceRegion(d, regionStart, regionEnd, spliced.channels),
      { selection: { start: word.startSample, end: word.endSample }, cursorSample: word.startSample }
    );
  } catch (err) {
    // The document may have been closed between the guard above and here.
    const message = errorMessage(err);
    showFailure(message);
    return replaceFail('failed', message);
  }

  // The splice changed no sample POSITION, so every span is still exact. Re-arm
  // the identity snapshot so the alignment survives its own edit and the next
  // word can be replaced without re-running the model.
  const after = findDoc(req.docId);
  if (after) {
    alignments.set(req.docId, { ...alignment, channelRefs: after.channels.slice() });
  }
  // Playback holds an AudioBuffer copy of the pre-splice audio; a preview taken
  // now would play the word that was just replaced.
  if (playbackEngine.loadedDocumentId === req.docId && after) playbackEngine.load(after);
  bumpVersion();

  return { ok: true, report: spliced.report, word };
}

// ---------------------------------------------------------------------------
// Loading lyrics from a text file
// ---------------------------------------------------------------------------

/** Extensions the "Load from file…" affordance offers. Plain text only: this
 * reads WORDS, never audio, so nothing here can reach the splice. */
export const LYRICS_FILE_EXTENSIONS = ['txt', 'lrc', 'md'];

/**
 * Opens a text file through the native dialog and returns its contents, or null
 * when cancelled or unavailable. Decoded as UTF-8 with the BOM stripped — a
 * Notepad-saved lyric sheet on Windows carries one, and a leading `﻿`
 * would otherwise become part of the first word and be dropped from the target
 * as an unknown character.
 */
export async function loadLyricsFile(): Promise<{ ok: true; text: string } | { ok: false; error: string } | null> {
  const bridge = api();
  if (!bridge?.showOpenDialog || !bridge.readFile) {
    return { ok: false, error: 'Opening files is unavailable in this build.' };
  }
  let paths: string[] | null;
  try {
    paths = await bridge.showOpenDialog({
      filters: [{ name: 'Lyrics or text', extensions: LYRICS_FILE_EXTENSIONS }],
    });
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  const path = paths?.[0];
  if (!path) return null;

  // `readFile` REJECTS on a missing or unapproved path (electron/ipc.cjs) — it
  // does not return a failure object — so the catch is the only failure path.
  let data: ArrayBuffer;
  try {
    data = await bridge.readFile(path);
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }

  const text = new TextDecoder('utf-8').decode(new Uint8Array(data)).replace(/^﻿/, '');
  return { ok: true, text };
}
