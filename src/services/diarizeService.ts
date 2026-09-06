/**
 * Renderer-side speaker-diarization service (Separate Speakers, D1-D6) — the
 * join between the utility-process host (`electron/diarizeHost.cjs`, driven by
 * `electron/diarizeManager.cjs`) and `SeparateDialog`'s voice mode. It owns
 * the renderer half of stages 2 and 3: the IPC round trip, the resample
 * discipline, cancellation, busy accounting, and the assembly that turns the
 * host's evidence into speakers.
 *
 * This is `transcribeService.ts`'s shape over a different host, deliberately —
 * one run at a time, progress with an ETA, a Cancel that kills the utility
 * process, an always-resolving promise. Where the two differ, the difference
 * is stated below with its reason.
 *
 * ## The pipeline (D1)
 *
 *   Vocals stem channels (stem rate, stem channel count)
 *     -> average to MONO at the stem rate                [one pass, one alloc]
 *     -> resampleChannel(..., 16000)                     [the app's windowed-sinc]
 *     -> IPC 'diarize:run' -> utilityProcess
 *          -> pyannote-segmentation-3.0 over 10 s windows shifted by 1 s
 *          -> WeSpeaker ResNet34-LM on every (window, local speaker) fragment
 *     -> 'diarize:window'    events (589 powerset classes per window)
 *     -> 'diarize:embedding' events (256-d L2-normalised vectors)
 *     -> assembleDiarization(...)                        [src/dsp/diarization.ts]
 *
 * MONO and 16 kHz because that is the host's contract (`diarizeHost.cjs`
 * SAMPLE_RATE, refused at the trust boundary otherwise). The averaging happens
 * BEFORE the resample so the windowed-sinc runs once instead of once per
 * channel, and `monoMix` is imported from `transcribeService.ts` rather than
 * re-written: there is one mono-mix in the renderer, and it is the one whose
 * contract says the caller's channel arrays are read and never transferred.
 *
 * ## Why this service takes CHANNELS, not a document id
 *
 * Its input is the in-memory Vocals stem from stage 1, which is not a document
 * and never becomes one unless the user lands it (D4). There is therefore no
 * staleness watch and no store subscription here — the caller (the dialog)
 * owns the buffer's lifetime, and its `cancelledRef` reaches this module as
 * the `shouldCancel` predicate.
 *
 * ## Cancellation has two doors (D5)
 *
 *   - `shouldCancel` is polled at three points — before the model probe, after
 *     the resample, and immediately before the invoke — so a Cancel raised
 *     while stage 1 was finishing spawns NOTHING.
 *   - `cancelDiarization()` handles a Cancel raised while the host is running:
 *     the manager kills the child, the in-flight invoke resolves
 *     `{ok:false,cancelled:true}` and the run settles through its normal path.
 *
 * ## Lifetime
 *
 * One run at a time (the manager enforces the same); a second request resolves
 * `busy` rather than queueing. The returned promise ALWAYS resolves — never
 * rejects, never hangs — including when the IPC invoke itself rejects on a
 * dead channel, because a hung promise would leave the busy gate shut for the
 * rest of the session.
 */

import { resampleChannel } from '../dsp/resample';
import {
  assembleDiarization,
  LOCAL_SPEAKERS,
  MODEL_SAMPLE_RATE,
  POWERSET,
  SEG_FRAMES,
  type Diarization,
  type DiarizationEmbedding,
  type DiarizationEvidence,
} from '../dsp/diarization';
import { monoMix } from './transcribeService';
import { MEASURED_REALTIME_FACTOR as STEM_REALTIME_FACTOR } from './stemService';

// ---------------------------------------------------------------------------
// Constants — mirrored from the main-process modules named in each comment.
// They are duplicated rather than imported because the renderer must never
// load anything from `electron/` (CommonJS modules that pull in
// onnxruntime-node transitively).
// ---------------------------------------------------------------------------

/** The host's fixed input rate (`diarizeHost.cjs` SAMPLE_RATE). Re-exported
 * from the DSP module's own model metadata so the two cannot drift. */
export const DIARIZE_SAMPLE_RATE = MODEL_SAMPLE_RATE;

/**
 * Job-length cap, in 16 kHz samples: 2 hours.
 *
 * MIRRORED from `diarizeHost.cjs` MAX_TOTAL_SAMPLES via the manager's
 * `parseDiarizeRequest`, which rejects anything above it — so the two MUST
 * agree or a job this module accepts is refused at the trust boundary with an
 * opaque "invalid diarize request".
 */
export const MAX_DIARIZE_SAMPLES = DIARIZE_SAMPLE_RATE * 7200;

/**
 * Total download size of the pinned two-file model set, used ONLY as the
 * fallback for the "no preload" model state so the dialog can still state a
 * size. The live number comes from `diarize:model-state`.
 *
 * Derived, not invented: the sum of the two `bytes` pins in
 * `electron/diarizeManager.cjs` DIARIZE_FILES — 5,992,913 + 26,530,550.
 */
export const DIARIZE_MODEL_BYTES = 32523463;

/**
 * Time-estimate seed for the SEGMENTATION stage: milliseconds of wall clock
 * per audio second.
 *
 * MEASURED, not chosen (D5): the spike's four recordings segmented at 5.50 /
 * 8.12 / 8.01 / 8.58 ms per audio second on this machine
 * (`spike-results.json`, `segmentation_ms / duration_s`). 8 is the top of that
 * range only for the SHORTEST file and sits just under the three longer ones,
 * so this seed reads a little short rather than long — it is not the
 * finishes-early direction, and it is not pretended to be. Two things make
 * that acceptable: the seed is used only until the host's first progress
 * event lands, after which the estimate comes from THIS run's own measured
 * rate, and segmentation owns about 1 % of the overall bar (`stageWeights`),
 * so the worst shortfall in the set — 0.58 ms per audio second, on the
 * 56.9 s file — is invisible next to Demucs. Task 8 re-measures it on the
 * bench; re-tuning it here without that run is not allowed.
 */
export const MEASURED_SEGMENT_MS_PER_S = 8;

/**
 * Time-estimate seed for the EMBEDDING stage: milliseconds of wall clock per
 * audio SECOND (not per fragment).
 *
 * MEASURED (D5): the spike's four recordings embedded at 29.13 / 45.71 /
 * 65.29 / 72.51 ms per audio second (`spike-results.json`,
 * `embedding_ms / duration_s`), and 55 is the MEDIAN of that spread — the
 * middle two straddle it — not the midpoint of the 29-73 range (~51) and not
 * its top. The spread is wide (the slowest file costs 2.5x the fastest), so a
 * seed at the top would over-state the wait on half the set; the median is the
 * honest first guess, and it too is replaced by this run's own measured rate
 * at the first embed event.
 *
 * Per audio second rather than per fragment because the fragment
 * count is not known until segmentation finishes, while the relationship D5
 * records — every audio second lies in ~10 windows and carries 1-3 fragments —
 * is what makes an audio-second seed usable before the first embed event.
 */
export const MEASURED_EMBED_MS_PER_S = 55;

/**
 * What the shipped speaker separation was MEASURED to do, in the numbers the
 * review panel and the docs quote. Named for the FEATURE, not for the
 * technique: `DIARIZATION_LIMITS` already exists in `transcribeService.ts` and
 * describes the entirely different CAM++ path the Transcribe panel uses.
 *
 * Every field comes from the D6 bench set (`docs/bench/diarize-bench-baseline.json`,
 * written by `scripts/diarize-bench.cjs`; the recordings and their durations
 * are the plan's design-notes). The honest part is what is NOT here: the
 * material ships a speaker COUNT per file and nothing finer, so there is no
 * DER, no per-segment accuracy, and no claim about crosstalk.
 */
export const SPEAKER_SEPARATION_LIMITS = Object.freeze({
  /** Recordings in the bench set. */
  recordings: 4,
  /** Three of them carry two speakers... */
  twoSpeakerRecordings: 3,
  /** ...and one carries four. */
  fourSpeakerRecordings: 1,
  /** Total duration: 16.0 + 34.0 + 54.8 + 56.9 s (design-notes). */
  seconds: 161.7,
  /** The four-speaker file is Mandarin, read by an English-trained embedder. */
  fourSpeakerLanguage: 'Mandarin',
  /** The only ground truth that ships with the material is the file name's count. */
  countOnlyTruth: true,
  /** No reference RTTMs, so no diarization error rate was computed — null, not 0. */
  diarizationErrorRate: null,
  /** Overlapping speech is near-absent in the material, so overlap is untested. */
  overlapInMaterial: 'near-zero',
  /** Where the numbers are re-derived from. */
  benchFile: 'docs/bench/diarize-bench-baseline.json',
});

/**
 * The measured-limits line the review step shows, verbatim (D5). It lives in
 * code so the dialog, the docs and the bench cannot drift into promising more
 * than the four recordings showed; Task 8 rewrites it if the full-chain bench
 * table differs.
 */
export function limitsSentence(): string {
  return (
    'On the four test recordings (three with two speakers, one with four) the count was right every time, ' +
    'with clean speech fed straight to the speaker step; recordings with many short turns or heavy crosstalk ' +
    'were not in that set. If the count looks wrong, set it here.'
  );
}

/**
 * The three stages' shares of one Separate Voice run, for the dialog's single
 * overall bar (D5).
 *
 * DERIVED at call time from the three measured seeds rather than written down
 * as 0.91 / 0.01 / 0.08: a literal would drift the moment any seed is
 * re-measured, and these three numbers are the only thing that makes the bar
 * mean anything. Demucs' cost per audio second is `1000 / MEASURED_REALTIME_FACTOR`
 * (`stemService.ts`, 1.52 -> 658 ms), imported from the module that measured
 * it. On this machine the weights come out at 0.913 / 0.011 / 0.076.
 */
export function stageWeights(): { separate: number; segment: number; embed: number } {
  const separateMsPerSecond = 1000 / STEM_REALTIME_FACTOR;
  const total = separateMsPerSecond + MEASURED_SEGMENT_MS_PER_S + MEASURED_EMBED_MS_PER_S;
  return {
    separate: separateMsPerSecond / total,
    segment: MEASURED_SEGMENT_MS_PER_S / total,
    embed: MEASURED_EMBED_MS_PER_S / total,
  };
}

/**
 * The 16 kHz length a source of `lengthSamples` at `sampleRate` resamples to —
 * `resampleChannel`'s own `round(length * toRate / fromRate)`, so the cap can
 * be enforced BEFORE a multi-hundred-megabyte mono buffer is allocated and the
 * two answers cannot disagree by a sample.
 */
export function modelLength16k(lengthSamples: number, sampleRate: number): number {
  return Math.round(lengthSamples * (DIARIZE_SAMPLE_RATE / sampleRate));
}

/** Share of the diarization bar the SEGMENTATION stage owns, from the two
 * seeds — the embedding stage owns the rest. */
const SEGMENT_BAR_SHARE = MEASURED_SEGMENT_MS_PER_S / (MEASURED_SEGMENT_MS_PER_S + MEASURED_EMBED_MS_PER_S);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DiarizeModelState {
  downloaded: boolean;
  bytes: number | null;
  expectedBytes: number;
}

export type DiarizeRunPhase = 'resampling' | 'segmenting' | 'embedding' | 'clustering';

export interface DiarizeProgress {
  phase: DiarizeRunPhase;
  /** Units are the phase's own: windows while segmenting, fragments while
   * embedding, 0 otherwise. */
  done: number;
  total: number;
  /**
   * Progress of the WHOLE call in `[0, 1]`, not of the current phase: the two
   * model stages split it by {@link SEGMENT_BAR_SHARE}, so it is
   * non-decreasing across the segment -> embed boundary where a per-phase
   * ratio would drop back to zero. It is also clamped never to fall, so a
   * straggling event from a finished stage cannot walk the dialog's bar
   * backwards. (`transcribeService.ts` reports a per-phase fraction; its
   * dialog does not draw one continuous bar across stages, and this one does.)
   */
  fraction: number;
  elapsedMs: number;
  /**
   * Seeded from {@link MEASURED_SEGMENT_MS_PER_S} and
   * {@link MEASURED_EMBED_MS_PER_S}, then refined from this run's own measured
   * rate. Never null — unlike `transcribeService`'s, whose embedding pass has
   * no seed to extrapolate from until the host says how many segments it will
   * embed; here both stages have an audio-second seed from the start.
   */
  estimatedRemainingMs: number;
}

export type DiarizeStatus = 'too-long' | 'busy' | 'model-missing' | 'cancelled' | 'failed' | 'unavailable';

export type DiarizeResult =
  | { ok: true; evidence: DiarizationEvidence; diarization: Diarization }
  | { ok: false; status: DiarizeStatus; message: string };

export interface DiarizeRequest {
  /** The Vocals stem's channels, at `sampleRate`. Read, never transferred. */
  channels: readonly Float32Array[];
  sampleRate: number;
  onProgress?: (progress: DiarizeProgress) => void;
  /** Polled before the model probe, after the resample and before the invoke;
   * `true` at any of them ends the run as `cancelled` having spawned nothing. */
  shouldCancel?: () => boolean;
}

// ---------------------------------------------------------------------------
// The preload surface (electron/preload.cjs), read defensively — jsdom and an
// older preload both legitimately lack it.
// ---------------------------------------------------------------------------

interface DiarizeApi {
  diarizeModelState?(): Promise<DiarizeModelState>;
  diarizeEnsureModels?(): Promise<{ ok: true } | { ok: false; error: string }>;
  onDiarizeModelProgress?(cb: (p: { received: number; total: number }) => void): () => void;
  diarizeRun?(req: {
    sampleRate: number;
    samples: ArrayBuffer;
  }): Promise<{ ok: true; windowCount: number } | { ok: false; cancelled?: true; error?: string }>;
  diarizeCancel?(): Promise<{ cancelled: boolean }>;
  onDiarizeProgress?(cb: (p: { stage: 'segment' | 'embed'; done: number; total: number }) => void): () => void;
  onDiarizeWindow?(cb: (w: { index: number; labels: ArrayBuffer }) => void): () => void;
  onDiarizeEmbedding?(
    cb: (e: { windowIndex: number; localSpeaker: number; activeFrames: number; vector: ArrayBuffer }) => void
  ): () => void;
  showMessageBox?(opts: {
    type?: 'info' | 'warning' | 'error' | 'question';
    title?: string;
    message: string;
  }): Promise<number>;
}

function api(): DiarizeApi | undefined {
  return (window as unknown as { electronAPI?: DiarizeApi }).electronAPI;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Terminal failures only — a cancel, a busy refusal or a missing model is not
 * an error and must not raise a native dialog (the `stemService.ts` /
 * `transcribeService.ts` one-liner). */
function showFailure(message: string): void {
  void api()?.showMessageBox?.({ type: 'error', title: 'Speaker separation failed', message });
}

// ---------------------------------------------------------------------------
// Run state — one at a time, exactly like the manager
// ---------------------------------------------------------------------------

interface ActiveRun {
  id: number;
  /** Keyed by the host's window index; the assembly needs them dense and in
   * order, and events are not ordered by contract. */
  windows: Map<number, Uint8Array>;
  embeddings: DiarizationEmbedding[];
  /** Vector length of the first accepted embedding — the assembly refuses a
   * ragged set, so a differently-sized row is dropped rather than thrown. */
  vectorDims: number;
  totalSamples16k: number;
  audioSeconds: number;
  cancelled: boolean;
  cancelInvoked: boolean;
  settled: boolean;
  startedAt: number;
  /** Wall clock at the first 'segment' event, and at the last one — the second
   * is where the embedding stage's own clock starts. */
  segmentStartedAt: number;
  segmentEndedAt: number;
  embedStartedAt: number;
  /** The highest fraction published so far (the bar never falls). */
  fraction: number;
}

let active: ActiveRun | null = null;
let nextRunId = 1;

/** True while a diarization is in flight. */
export function isDiarizing(): boolean {
  return active !== null;
}

/**
 * Busy-work count for the close guard (App.tsx adds it to
 * `getInFlightSaveCount()`): quitting mid-run must WARN rather than silently
 * discard minutes of inference.
 */
export function getDiarizeBusyCount(): number {
  return active ? 1 : 0;
}

function publishProgress(
  run: ActiveRun,
  next: { phase: DiarizeRunPhase; done: number; total: number; fraction: number; estimatedRemainingMs: number },
  onProgress?: (p: DiarizeProgress) => void
): void {
  if (active !== run) return;
  // The clamp, not the caller's discipline, is what makes the bar monotone.
  run.fraction = Math.max(run.fraction, Math.min(1, next.fraction));
  onProgress?.({
    phase: next.phase,
    done: next.done,
    total: next.total,
    fraction: run.fraction,
    elapsedMs: Date.now() - run.startedAt,
    estimatedRemainingMs: next.estimatedRemainingMs,
  });
}

/**
 * The single abort point: records the cancel and kills the utility process
 * exactly once. The in-flight `diarize:run` invoke then resolves
 * `{ok:false, cancelled:true}` and the awaiting run settles through its normal
 * path — abort never settles the promise itself, so there is exactly one
 * settlement site.
 */
function abortRun(run: ActiveRun): void {
  if (run.settled || run.cancelled) return;
  run.cancelled = true;
  if (!run.cancelInvoked) {
    run.cancelInvoked = true;
    void api()
      ?.diarizeCancel?.()
      .catch(() => {
        /* the run settles from the invoke's own resolution regardless */
      });
  }
}

/** Cancels the in-flight diarization — the manager kills the utility process.
 * Resolves `true` when a run was actually cancelled, `false` when idle. */
export async function cancelDiarization(): Promise<boolean> {
  const run = active;
  if (!run) return false;
  abortRun(run);
  return true;
}

// ---------------------------------------------------------------------------
// Model state
// ---------------------------------------------------------------------------

/** Cheap existence+size probe over the two-file set. Never throws; an
 * unavailable preload reads as "not downloaded" so the dialog shows its
 * download state rather than an error. */
export async function getDiarizeModelState(): Promise<DiarizeModelState> {
  const bridge = api();
  if (!bridge?.diarizeModelState) {
    return { downloaded: false, bytes: null, expectedBytes: DIARIZE_MODEL_BYTES };
  }
  try {
    return await bridge.diarizeModelState();
  } catch {
    return { downloaded: false, bytes: null, expectedBytes: DIARIZE_MODEL_BYTES };
  }
}

/**
 * Verifies-or-downloads both pinned files, streaming OVERALL byte progress to
 * `onProgress`. Always resolves — a download failure is `{ok:false,error}`,
 * never a rejection.
 */
export async function ensureDiarizeModels(
  onProgress?: (p: { received: number; total: number }) => void
): Promise<{ ok: true } | { ok: false; error: string }> {
  const bridge = api();
  if (!bridge?.diarizeEnsureModels) {
    return { ok: false, error: 'Speaker separation is unavailable in this build.' };
  }
  const unsubscribe = onProgress && bridge.onDiarizeModelProgress ? bridge.onDiarizeModelProgress(onProgress) : null;
  try {
    return await bridge.diarizeEnsureModels();
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    unsubscribe?.();
  }
}

// ---------------------------------------------------------------------------
// diarizeChannels
// ---------------------------------------------------------------------------

function fail(status: DiarizeStatus, message: string): DiarizeResult {
  return { ok: false, status, message };
}

const CANCELLED_MESSAGE = 'Speaker separation was cancelled.';

/**
 * Accumulates one 'diarize:window' payload. Validated at this boundary like
 * any other cross-process payload: a window of the wrong length or carrying a
 * class outside the powerset would make `assembleDiarization` throw, so it is
 * DROPPED here and the window-count gate below reports the shortfall.
 */
function acceptWindow(run: ActiveRun, w: { index: number; labels: ArrayBuffer }): void {
  if (!Number.isInteger(w.index) || w.index < 0) return;
  if (run.windows.has(w.index)) return;
  let labels: Uint8Array;
  try {
    labels = new Uint8Array(w.labels);
  } catch {
    return;
  }
  if (labels.length !== SEG_FRAMES) return;
  for (let f = 0; f < labels.length; f++) {
    if (labels[f] >= POWERSET.length) return;
  }
  run.windows.set(w.index, labels);
}

/**
 * Accumulates one 'diarize:embedding' payload, in arrival order — the order
 * decides the cluster numbering (`relabelByFirstAppearance`) and therefore the
 * speaker numbering, so it is the host's order that is preserved, not a sort.
 *
 * A non-finite component would poison every distance in the clusterer (NaN
 * propagates through the linkage and a NaN comparison is silently false), so a
 * vector carrying one is dropped whole — that fragment then falls out of the
 * evidence instead of corrupting everybody else's labels.
 */
function acceptEmbedding(
  run: ActiveRun,
  e: { windowIndex: number; localSpeaker: number; activeFrames: number; vector: ArrayBuffer }
): void {
  if (!Number.isInteger(e.windowIndex) || e.windowIndex < 0) return;
  if (!Number.isInteger(e.localSpeaker) || e.localSpeaker < 0 || e.localSpeaker >= LOCAL_SPEAKERS) return;
  if (!Number.isInteger(e.activeFrames) || e.activeFrames < 0) return;
  let vector: Float32Array;
  try {
    vector = new Float32Array(e.vector);
  } catch {
    return;
  }
  if (vector.length === 0) return;
  if (run.vectorDims === 0) run.vectorDims = vector.length;
  else if (vector.length !== run.vectorDims) return;
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) return;
  }
  run.embeddings.push({
    windowIndex: e.windowIndex,
    localSpeaker: e.localSpeaker,
    activeFrames: e.activeFrames,
    vector,
  });
}

/**
 * Diarizes `channels`. ALWAYS resolves (see the module header's lifetime
 * section); never throws for a user-facing condition. On success it returns
 * BOTH the assembled diarization and the evidence it came from, so the review
 * step can re-cluster at a different speaker count without a model run (D3).
 */
export async function diarizeChannels(req: DiarizeRequest): Promise<DiarizeResult> {
  const bridge = api();
  if (!bridge?.diarizeRun || !bridge.onDiarizeProgress || !bridge.onDiarizeWindow || !bridge.onDiarizeEmbedding) {
    return fail('unavailable', 'Speaker separation is unavailable in this build.');
  }
  // Everything from here to the `active = run` assignment is synchronous, so
  // two calls in the same tick cannot both pass the busy gate (the same
  // reservation discipline `diarizeManager.startDiarization` uses).
  if (active) return fail('busy', 'A speaker separation is already running.');

  const { channels, sampleRate } = req;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return fail('failed', `Speaker separation needs a positive sample rate (got ${sampleRate}).`);
  }
  const length = channels[0]?.length ?? 0;
  if (length === 0) return fail('failed', 'There is no audio to separate into speakers.');
  if (modelLength16k(length, sampleRate) > MAX_DIARIZE_SAMPLES) {
    return fail('too-long', 'Speaker separation is limited to 2 hours of audio in one job.');
  }

  const run: ActiveRun = {
    id: nextRunId++,
    windows: new Map(),
    embeddings: [],
    vectorDims: 0,
    totalSamples16k: 0,
    audioSeconds: length / sampleRate,
    cancelled: false,
    cancelInvoked: false,
    settled: false,
    startedAt: Date.now(),
    segmentStartedAt: 0,
    segmentEndedAt: 0,
    embedStartedAt: 0,
    fraction: 0,
  };
  active = run;

  const seedSegmentMs = run.audioSeconds * MEASURED_SEGMENT_MS_PER_S;
  const seedEmbedMs = run.audioSeconds * MEASURED_EMBED_MS_PER_S;
  const unsubscribers: (() => void)[] = [];

  try {
    // Door 1 (D5): a Cancel raised while stage 1 was finishing must not even
    // probe the model set, let alone spawn a child.
    if (req.shouldCancel?.()) return fail('cancelled', CANCELLED_MESSAGE);

    const modelState = await getDiarizeModelState();
    if (run.cancelled) return fail('cancelled', CANCELLED_MESSAGE);
    if (!modelState.downloaded) {
      return fail(
        'model-missing',
        'The speaker models have not been downloaded yet (about 32.5 MB, one time).'
      );
    }

    publishProgress(
      run,
      { phase: 'resampling', done: 0, total: 0, fraction: 0, estimatedRemainingMs: seedSegmentMs + seedEmbedMs },
      req.onProgress
    );

    // Mono at the stem's rate, then ONE windowed-sinc pass down to 16 kHz.
    let outgoing: Float32Array;
    try {
      outgoing = resampleChannel(monoMix(channels, length), sampleRate, DIARIZE_SAMPLE_RATE);
    } catch (err) {
      // An OOM on a memory-pressured machine is a NORMAL failure here, not an
      // escape: the mono mix and the resample are both multi-hundred-megabyte
      // allocations on a long stem.
      showFailure(errorMessage(err));
      return fail('failed', errorMessage(err));
    }

    // Door 2 (D5): after the resample, before anything is spawned.
    if (req.shouldCancel?.() || run.cancelled) return fail('cancelled', CANCELLED_MESSAGE);

    // `resampleChannel` rounds independently of the prediction above, so the
    // buffer's real length is what the host is told and what the window
    // arithmetic is relative to — and what the manager's cap is applied to.
    run.totalSamples16k = outgoing.length;
    if (outgoing.length === 0) return fail('failed', 'The audio is too short to separate into speakers.');
    if (outgoing.length > MAX_DIARIZE_SAMPLES) {
      return fail('too-long', 'Speaker separation is limited to 2 hours of audio in one job.');
    }

    unsubscribers.push(
      bridge.onDiarizeProgress((p) => {
        if (active !== run || run.settled) return; // settled-run chatter is dropped
        const total = Number.isFinite(p.total) && p.total > 0 ? p.total : 0;
        const done = Number.isFinite(p.done) && p.done > 0 ? p.done : 0;
        const now = Date.now();
        if (p.stage === 'segment') {
          if (run.segmentStartedAt === 0) run.segmentStartedAt = run.startedAt;
          run.segmentEndedAt = now;
          const elapsed = now - run.segmentStartedAt;
          publishProgress(
            run,
            {
              phase: 'segmenting',
              done,
              total,
              fraction: total > 0 ? SEGMENT_BAR_SHARE * Math.min(1, done / total) : 0,
              // This stage's own measured rate, plus the embedding stage's
              // audio-second seed — that stage has not started, so its own
              // rate cannot be measured yet.
              estimatedRemainingMs:
                done > 0 && total > 0
                  ? (elapsed / done) * Math.max(0, total - done) + seedEmbedMs
                  : seedSegmentMs + seedEmbedMs,
            },
            req.onProgress
          );
        } else {
          // The embedding stage's clock starts where segmentation ENDED, not
          // at the run's start: charging it with the model load and the whole
          // segmentation pass would over-estimate its first events by the
          // length of stage 2.
          if (run.embedStartedAt === 0) run.embedStartedAt = run.segmentEndedAt || now;
          const elapsed = now - run.embedStartedAt;
          publishProgress(
            run,
            {
              phase: 'embedding',
              done,
              total,
              fraction:
                total > 0
                  ? SEGMENT_BAR_SHARE + (1 - SEGMENT_BAR_SHARE) * Math.min(1, done / total)
                  : SEGMENT_BAR_SHARE,
              estimatedRemainingMs:
                done > 0 && total > 0 ? (elapsed / done) * Math.max(0, total - done) : seedEmbedMs,
            },
            req.onProgress
          );
        }
      })
    );

    unsubscribers.push(
      bridge.onDiarizeWindow((w) => {
        if (active !== run || run.settled) return;
        acceptWindow(run, w);
      })
    );

    unsubscribers.push(
      bridge.onDiarizeEmbedding((e) => {
        if (active !== run || run.settled) return;
        acceptEmbedding(run, e);
      })
    );

    // Door 3 (D5): the last look before the child is spawned.
    if (req.shouldCancel?.() || run.cancelled) return fail('cancelled', CANCELLED_MESSAGE);

    publishProgress(
      run,
      {
        phase: 'segmenting',
        done: 0,
        total: 0,
        fraction: 0,
        estimatedRemainingMs: seedSegmentMs + seedEmbedMs,
      },
      req.onProgress
    );

    let result: Awaited<ReturnType<NonNullable<DiarizeApi['diarizeRun']>>>;
    try {
      result = await bridge.diarizeRun({
        sampleRate: DIARIZE_SAMPLE_RATE,
        samples: outgoing.buffer as ArrayBuffer,
      });
    } catch (err) {
      // A rejected invoke means the IPC channel itself died. Without this
      // catch the promise would reject instead of resolving — the one thing
      // this module must never do.
      //
      // A rejection says nothing about the CHILD, though: the manager may
      // still own a live utility process for this run. Kill it explicitly, or
      // it outlives the run it belonged to. Deliberately NOT `abortRun` — this
      // is a failure, not a cancel, and must keep the `failed` status.
      if (!run.cancelInvoked) {
        run.cancelInvoked = true;
        void bridge.diarizeCancel?.().catch(() => {
          /* best-effort: the channel that just died may not answer */
        });
      }
      const message = errorMessage(err);
      showFailure(message);
      return fail('failed', message);
    } finally {
      // The 16 kHz mono buffer is IPC-copied by now; up to 460 MB that must
      // not stay alive while the diarization is assembled.
      outgoing = new Float32Array(0);
    }

    // A cancel recorded while the invoke was in flight decides the status,
    // even if the manager happened to answer {ok:true} first.
    if (run.cancelled) return fail('cancelled', CANCELLED_MESSAGE);

    if (!result.ok) {
      if (result.cancelled) return fail('cancelled', CANCELLED_MESSAGE);
      const message = result.error ?? 'The speaker host failed.';
      showFailure(message);
      return fail('failed', message);
    }

    // The host counts what it emitted; a mismatch means window events were
    // dropped or malformed, and the assembly would silently describe a
    // shorter recording than the one that was analysed.
    const windowCount = result.windowCount;
    const windows: Uint8Array[] = [];
    for (let i = 0; i < windowCount; i++) {
      const w = run.windows.get(i);
      if (!w) break;
      windows.push(w);
    }
    if (windows.length !== windowCount || run.windows.size < windowCount) {
      const message = `The speaker host reported ${windowCount} window(s) but delivered ${windows.length}.`;
      showFailure(message);
      return fail('failed', message);
    }

    publishProgress(
      run,
      { phase: 'clustering', done: 0, total: 0, fraction: 1, estimatedRemainingMs: 0 },
      req.onProgress
    );

    const evidence: DiarizationEvidence = {
      totalSamples16k: run.totalSamples16k,
      windows,
      // A fragment whose window never arrived has nothing to be voted into,
      // and the assembly refuses it outright — dropped here for the same
      // reason a malformed window is.
      embeddings: run.embeddings.filter((e) => e.windowIndex < windows.length),
    };

    let diarization: Diarization;
    try {
      diarization = assembleDiarization(evidence);
    } catch (err) {
      // The assembly's guards are RangeErrors about evidence shape; every one
      // of them means the host sent something this module failed to reject,
      // which is a failure of the run, not of the app.
      const message = errorMessage(err);
      showFailure(message);
      return fail('failed', message);
    }

    return { ok: true, evidence, diarization };
  } catch (err) {
    // The always-resolves contract, closed for good.
    const message = errorMessage(err);
    showFailure(message);
    return fail('failed', message);
  } finally {
    run.settled = true;
    for (const off of unsubscribers) off();
    run.windows = new Map();
    run.embeddings = [];
    if (active === run) active = null;
  }
}
