/**
 * Renderer-side stem separation service (Auditorium v1.7, task S3) — the join
 * between S1's utility-process inference host and S2's exact-sum partition.
 * It owns the whole renderer half of the feature: the IPC round trip, the
 * resample discipline of ruling 4, staleness, lifetime and busy accounting.
 * S6's dialog and S5's multitrack landing both consume THIS module; neither
 * touches `window.electronAPI.stems*` directly.
 *
 * ## The pipeline (plan ruling 4, end to end)
 *
 *   document channels (native rate, e.g. 48 kHz)
 *     -> resampleChannel(..., 44100)                [the app's windowed-sinc]
 *     -> IPC 'stems:separate' -> utilityProcess -> HT-Demucs
 *     -> 'stems:chunk' estimates (44.1 kHz, 4 stems x 2 channels)
 *     -> resampleChannel(..., document rate)        [same windowed-sinc, back up]
 *     -> partitionStems(ORIGINAL document channels, estimates)
 *     -> { stems x4 (masked iSTFT), residual (time-domain complement) }
 *
 * The model runs at ITS rate; the PARTITION runs at the DOCUMENT's rate over
 * the ORIGINAL, untouched mix. That ordering is what keeps the "no sound
 * removed" guarantee real: the exact-sum identity is asserted against the
 * user's actual audio, not against a resampled copy of it. The resampler is
 * `src/dsp/resample.ts`'s `resampleChannel` on BOTH legs — linear
 * interpolation and hand-rolled resamplers are forbidden (ruling 4), and BOTH
 * legs are pinned BIT-EXACTLY by the unit tests: leg 1 against
 * `resampleChannel`'s output for the outgoing payload, leg 2 by recomputing
 * the whole partition from the delivered chunk and comparing every stem
 * sample.
 *
 * Leg 2 needed its own pin because the reconstruction metric CANNOT catch a
 * wrong resampler there — and in the most misleading direction. A linear
 * resampler leaves above-Nyquist junk in the estimates; those bins' masks
 * then route the corresponding mix energy into the Residual, which makes
 * every exact-sum number look BETTER (0 error, 100% bit-exact). Correctness
 * on the return leg is therefore a property of the SAMPLES, never of the sum.
 *
 * Length across the round trip: `modelLength = round(docLength * 44100/rate)`
 * and the return leg lands at `round(modelLength * rate/44100)`, which can
 * differ from `docLength` by a sample for some rate/length pairs. Every
 * estimate is therefore fitted (truncated or zero-padded at the tail) to the
 * document length before it reaches `partitionStems`, whose shape contract
 * demands the same channel count and length as the mix.
 *
 * Mono: the host always returns the model's 2 channels (a mono job is
 * repeated into both, `stemHost.cjs` buildSegmentInput). A mono document's
 * estimates are folded back by AVERAGING the two — the estimates are only the
 * MASK SOURCE, so the fold affects mask shape alone and cannot touch the
 * exact-sum guarantee.
 *
 * ## NON-FINITE POLICY (S2's input contract THROWS — this module decides)
 *
 * Split by PROVENANCE, because the two sides are not the same kind of value:
 *
 *   - MODEL ESTIMATES are SANITISED (non-finite -> 0), counted, and reported
 *     as `output.sanitisedEstimateSamples`. A fp16 export can plausibly emit
 *     a NaN/Inf on a hot transient, and an estimate is nothing but the mask
 *     source (ruling 4): a zeroed estimate sample means that source claims no
 *     energy in the affected bins, so the energy lands in the Residual and
 *     the partition is still a partition of the user's audio. Nothing is
 *     removed. Throwing away a multi-minute inference run over a handful of
 *     samples would cost the user everything and buy no safety. Sanitisation
 *     happens at CHUNK-ACCUMULATION time, at the model rate — before the
 *     return-leg resample, where one bad sample would otherwise smear across
 *     up to 63 output samples (`resample.ts` spans +/-32 input taps and its
 *     Hann window is exactly 0 at both ends).
 *   - The MIX is NEVER sanitised. It is the user's own audio; a non-finite
 *     sample there is an app/decode bug, and quietly rewriting it would alter
 *     what the user recorded. `partitionStems` catches it (naming
 *     channel+sample) and this module surfaces that message verbatim as a
 *     terminal `failed` result plus a `showMessageBox`. Anything still
 *     non-finite in the estimates after our own resampler is likewise a bug
 *     in US and fails the same loud way.
 *
 * Either way a NaN never reaches the user's audio silently, which is the
 * property the whole feature rests on.
 *
 * Sanitising is not licence to report success on nothing, though: a run whose
 * masks are ALL zero (`stats.maxMaskSum === 0`) over a mix that HAS energy is
 * refused as a terminal `failed`, with the discarded-sample count in the
 * message. Four silent stems and `residual === mix` is a copy with extra
 * steps, and presenting it as a separation would be the worst silent failure
 * this feature could produce. The count is also carried on every successful
 * result (`sanitisedEstimateSamples`) so a partially-degraded run can be
 * reported honestly rather than passed off as clean.
 *
 * ## Staleness — T13 discipline, checked at DELIVERY
 *
 * The source's channel-array identities are snapshotted at request time (the
 * `peaksCache.ts:16-22` convention every cache in this repo uses: a mutator
 * always allocates fresh arrays, so reference identity IS "has this audio
 * changed") and re-checked when the result lands. A run whose source was
 * edited or closed in flight NEVER delivers stems — it settles `stale` or
 * `source-closed`. On top of that delivery gate, a store subscription live
 * for the run's duration aborts EARLY on the same conditions, so an edit does
 * not leave minutes of now-worthless inference (and ~5 GB of ORT arena)
 * running. Both routes funnel through `abortRun`.
 *
 * ## Lifetime — every path settles, no orphan process
 *
 * One run at a time (the manager enforces the same, `stemManager.cjs`); a
 * second request resolves `busy` rather than queueing. The utility process is
 * killed on cancel (ruling 7), on a source edit, on source close
 * (`invalidateStemRun`, called from `closeDocumentFlow`), on any terminal
 * failure (the manager kills its child on every terminal branch), and on app
 * quit (main's `will-quit` -> `manager.dispose()`; the in-flight invoke then
 * resolves cancelled and this module settles `cancelled`). The returned
 * promise ALWAYS resolves — never rejects, never hangs — including when the
 * IPC invoke itself rejects on a dead channel. A hung promise here would be
 * worse than any error, because the busy gate below would then never reopen.
 *
 * ## RESULT SHAPE (what S5 consumes — do not guess)
 *
 *   {ok:true, output: StemSeparationOutput} | {ok:false, status, message}
 *
 *   output.stems     — EXACTLY 4 entries, in ruling-6 order:
 *                      [Drums, Bass, Vocals, Other] (the model's own order is
 *                      drums, bass, OTHER, vocals — the swap happens HERE, so
 *                      S5 lays tracks out in the delivered order).
 *                      Each `{label, channels: Float32Array[]}`.
 *   output.residual  — Float32Array[], the 5th "Residual" track, laid out
 *                      LAST (stemPartition.ts's accumulation contract).
 *   Every channel array: `output.channelCount` channels of exactly
 *   `output.lengthSamples` samples at `output.sampleRate` — identical to the
 *   source document, so a stem document is `createDocument({name:
 *   `${output.sourceName} — ${label}`, sampleRate: output.sampleRate,
 *   channels: stem.channels})`.
 *   output.sanitisedEstimateSamples — non-finite model samples zeroed (0 in
 *   the normal case). A non-zero value means the run is DEGRADED but valid:
 *   S6 should say so rather than let it pass silently. An all-zero-mask run
 *   never reaches here — it is a `failed`.
 *   output.stats — S2's mask stats (min/max mask, worst-case sum).
 *
 *   S3 deliberately creates NO documents and NO session: that is S5.
 */

import { useSyncExternalStore } from 'react';
import type { AudioDocument } from '../audio/AudioDocument';
import { useAppStore } from '../stores/appStore';
import { resampleChannel } from '../dsp/resample';
import { partitionStems, type StemPartitionStats } from '../dsp/stemPartition';

// ---------------------------------------------------------------------------
// Constants — mirrored from the main-process modules named in each comment.
// They are duplicated rather than imported because the renderer must never
// load anything from `electron/` (those are CommonJS main-process modules that
// pull in onnxruntime-node transitively).
// ---------------------------------------------------------------------------

/** The model's own rate (`electron/stemSegmentation.cjs` MODEL_SAMPLE_RATE). */
export const MODEL_SAMPLE_RATE = 44100;
/** The model always emits 2 channels (`stemSegmentation.cjs` MODEL_CHANNELS). */
const MODEL_CHANNELS = 2;
/** drums, bass, other, vocals (`stemSegmentation.cjs` STEM_NAMES). */
const HOST_STEM_COUNT = 4;
/**
 * RENDERER-side length cap: 15 minutes at the model rate. Deliberately NOT
 * `stemHost.cjs`'s MAX_TOTAL_SAMPLES (30 min) — that number is the HOST's
 * memory arithmetic, and mirroring it here would have let the renderer accept
 * a job it cannot hold.
 *
 * MEASURED on this machine (stereo 48 kHz, the real pipeline: both resample
 * legs + `partitionStems`, peak RSS sampled at every phase boundary):
 * 15 s -> 516 MB, 30 s -> 584 MB, 60 s -> 716 MB — a slope of
 * **4.4 MB of renderer RSS per second of audio (~264 MB/min)**, linear across
 * both intervals. The analytic figure agrees: at the partition peak the
 * renderer holds the document (2ch), the document-rate estimates (4 stems x
 * 2ch), the partition's stems (4 x 2ch) and the residual (2ch) = 20 channels
 * x 4 B x 48000 = 3.84 MB/s, plus scratch and GC lag.
 *
 * Two phases, two budgets:
 *   - DURING inference the renderer holds document + model-rate mix +
 *     model-rate estimates ~= 2.1 MB/s (126 MB/min) WHILE the main side holds
 *     its own ~1.94 MB/s (116 MB/min) plus ORT's measured ~5 GB arena
 *     (S1) -> 5 GB + 242 MB/min.
 *   - AFTER inference (the manager kills the child on `done`, so the 5 GB is
 *     already back) the renderer peaks alone at 264 MB/min.
 * On a 16 GB machine, leaving ~4-5 GB for the OS, Chromium and the app, the
 * inference phase is the binding one: 5 GB + 0.242 GB/min x D <= ~10 GB gives
 * D <= ~20 min. 15 minutes takes that with headroom (combined ~8.6 GB;
 * renderer-alone partition peak ~3.9 GB).
 *
 * At the host's 30-minute cap the renderer alone would peak near 7.9 GB and
 * the combined figure near 12.3 GB — which is why that cap is unreachable
 * from here and is not mirrored. The host still enforces its own 30 min as
 * the outer bound; this is the tighter, renderer-feasible one, and whole real
 * tracks sit far below it (the plan's own framing of the length rule).
 */
const MAX_MODEL_SAMPLES = MODEL_SAMPLE_RATE * 900;
/** `stemManager.cjs` MODEL_BYTES — used only for the "no preload" fallback
 * model state, so the dialog can still show the 166 MB warning. */
const MODEL_BYTES = 165612636;

/**
 * Ruling-7 time estimate seed: audio-seconds processed per wall-second on the
 * reference machine (P0: 1.52x; S1's integration bench measured 1.57x). Used
 * only until the first segment lands, after which the estimate is derived
 * from THIS run's own measured segment rate.
 *
 * Exported so S6's dialog can state the same figure it will actually be held
 * to, rather than re-typing 1.52 into the UI where the two could drift apart.
 */
export const MEASURED_REALTIME_FACTOR = 1.52;

/** Ruling 6's track order. The result's `stems` array is in this order. */
export const STEM_LABELS = ['Drums', 'Bass', 'Vocals', 'Other'] as const;
export type StemLabel = (typeof STEM_LABELS)[number];

/** Index into the HOST's stem order (drums, bass, other, vocals) for each
 * entry of `STEM_LABELS`. Vocals/Other are swapped — this is the only place
 * that swap exists. */
const HOST_INDEX_FOR_LABEL: readonly number[] = [0, 1, 3, 2];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StemModelState {
  downloaded: boolean;
  bytes: number | null;
  expectedBytes: number;
}

export type StemRunPhase = 'resampling' | 'inference' | 'partitioning';

export interface StemSeparationProgress {
  phase: StemRunPhase;
  /** Segments finished (0 before the first one lands). */
  segment: number;
  /** 0 until the host reports the segment count. */
  totalSegments: number;
  /** `segment / totalSegments`, 0 outside the inference phase. */
  fraction: number;
  elapsedMs: number;
  /** Seeded from `MEASURED_REALTIME_FACTOR`, then refined from this run's own
   * measured per-segment time. Never null once a run is under way. */
  estimatedRemainingMs: number | null;
}

export interface StemSeparationOutput {
  sourceDocId: string;
  sourceName: string;
  sampleRate: number;
  channelCount: number;
  lengthSamples: number;
  /** Exactly 4, in `STEM_LABELS` (ruling-6) order. */
  stems: { label: StemLabel; channels: Float32Array[] }[];
  /** The 5th track — laid out LAST (stemPartition.ts's contract). */
  residual: Float32Array[];
  /** Non-finite model samples replaced with 0 (see the non-finite policy). */
  sanitisedEstimateSamples: number;
  stats?: StemPartitionStats;
}

export type StemSeparationStatus =
  | 'no-document'
  | 'empty-document'
  | 'too-long'
  | 'busy'
  | 'model-missing'
  | 'cancelled'
  | 'stale'
  | 'source-closed'
  | 'failed';

export type StemSeparationResult =
  | { ok: true; output: StemSeparationOutput }
  | { ok: false; status: StemSeparationStatus; message: string };

export interface SeparateStemsRequest {
  sourceDocId: string;
  onProgress?: (progress: StemSeparationProgress) => void;
}

// ---------------------------------------------------------------------------
// The preload surface (electron/preload.cjs), read defensively — jsdom and an
// older preload both legitimately lack it.
// ---------------------------------------------------------------------------

interface StemApi {
  stemsModelState?(): Promise<StemModelState>;
  stemsEnsureModel?(): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  onStemsModelProgress?(cb: (p: { received: number; total: number }) => void): () => void;
  stemsSeparate?(req: {
    sampleRate: number;
    channels: ArrayBuffer[];
  }): Promise<{ ok: true; totalSegments: number } | { ok: false; cancelled?: true; error?: string }>;
  stemsCancel?(): Promise<{ cancelled: boolean }>;
  onStemsProgress?(cb: (p: { segment: number; totalSegments: number }) => void): () => void;
  onStemsChunk?(cb: (c: { offset: number; samples: number; data: ArrayBuffer }) => void): () => void;
  showMessageBox?(opts: {
    type?: 'info' | 'warning' | 'error' | 'question';
    title?: string;
    message: string;
  }): Promise<number>;
}

function stemApi(): StemApi | undefined {
  return (window as unknown as { electronAPI?: StemApi }).electronAPI;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Terminal failures only — a cancel, a staleness abort or a busy refusal is
 * not an error and must not raise a native dialog (`tempoAnalysis.ts` /
 * `remixService.ts` use the same one-line helper shape). */
function showFailure(message: string): void {
  void stemApi()?.showMessageBox?.({ type: 'error', title: 'Stem separation failed', message });
}

// ---------------------------------------------------------------------------
// Reactivity — version counter + subscribe/getSnapshot/useStemVersion, copied
// in shape from tempoAnalysis.ts / remixService.ts. NOT zustand.
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

/** Monotonic counter bumped on run start, on every progress event and on
 * settlement; non-reactive read. */
export function getStemVersion(): number {
  return version;
}

/** Re-renders the caller whenever stem separation state changes. */
export function useStemVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function findDoc(docId: string): AudioDocument | undefined {
  return useAppStore.getState().documents.find((d) => d.id === docId);
}

/** Copied VERBATIM from `peaksCache.ts:16-22` / `tempoAnalysis.ts` /
 * `remixService.ts` — this repo's identity-based "has the audio changed" test. */
function sameChannelRefs(a: Float32Array[], b: Float32Array[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Sorted, disjoint [start, end) coverage — the same accounting
 * `stemHost.cjs` adopted in its fix round 1: a duplicated region must never
 * stand in for an undelivered one. */
function addCoverage(covered: [number, number][], start: number, end: number): void {
  covered.push([start, end]);
  covered.sort((x, y) => x[0] - y[0]);
  for (let i = covered.length - 1; i > 0; i--) {
    if (covered[i][0] <= covered[i - 1][1]) {
      covered[i - 1][1] = Math.max(covered[i - 1][1], covered[i][1]);
      covered.splice(i, 1);
    }
  }
}

function coversExactly(covered: [number, number][], total: number): boolean {
  return covered.length === 1 && covered[0][0] === 0 && covered[0][1] === total;
}

/** Whether the mix carries ANY non-zero sample. Only consulted when the
 * partition reports `maxMaskSum === 0` (see the all-silent refusal below), so
 * this O(n) scan runs on a path that is already terminal — never on a healthy
 * run. Digital silence in, all-zero masks out is CORRECT, and must not be
 * mistaken for the model having failed. */
function hasAnyEnergy(channels: Float32Array[]): boolean {
  for (const ch of channels) {
    for (let n = 0; n < ch.length; n++) {
      if (ch[n] !== 0) return true;
    }
  }
  return false;
}

/** Truncates or zero-pads `input` to `length` — the round-trip rounding fix-up
 * that satisfies `partitionStems`' shape contract (see the module header). */
function fitLength(input: Float32Array, length: number): Float32Array {
  if (input.length === length) return input;
  const out = new Float32Array(length);
  out.set(input.subarray(0, Math.min(length, input.length)));
  return out;
}

// ---------------------------------------------------------------------------
// Run state — one at a time, exactly like the manager
// ---------------------------------------------------------------------------

type AbortReason = 'user' | 'edited' | 'closed';

interface ActiveRun {
  id: number;
  sourceDocId: string;
  /** Identity snapshot taken at REQUEST time (T13). */
  channelRefs: Float32Array[];
  channelCount: number;
  docLength: number;
  sampleRate: number;
  modelLength: number;
  /** `[hostStemIndex][channel]` at the MODEL rate; entries are released
   * (nulled) as the return-leg resample consumes them, so the model-rate and
   * document-rate copies of ~400 MB of estimates never coexist. */
  estimates: (Float32Array | null)[][];
  covered: [number, number][];
  sanitised: number;
  abortReason: AbortReason | null;
  cancelInvoked: boolean;
  settled: boolean;
  startedAt: number;
  inferenceStartedAt: number;
}

let active: ActiveRun | null = null;
let nextRunId = 1;
let progressState: StemSeparationProgress | null = null;

/**
 * Test-only (this repo's `_xxxForTest` convention). Disables the EARLY-abort
 * store subscription so the DELIVERY-TIME staleness gate can be exercised on
 * its own.
 *
 * It exists because the two guards overlap by design: in production a store
 * change fires the subscription first, which means the delivery-time check --
 * the one ruling 7 actually rests on ("never deliver stems for audio that
 * changed") -- is never the branch that catches a normal edit. Without this
 * switch that branch is untestable, and an untestable guarantee is not a
 * guarantee.
 */
export function _setStaleWatchForTest(enabled: boolean): void {
  staleWatchEnabled = enabled;
}

let staleWatchEnabled = true;

/** True while a separation is in flight. */
export function isStemSeparationRunning(): boolean {
  return active !== null;
}

/**
 * Busy-work count for the close guard (App.tsx adds it to
 * `getInFlightSaveCount()`): quitting mid-run must WARN rather than silently
 * discard minutes of inference (ruling 7).
 */
export function getStemBusyCount(): number {
  return active ? 1 : 0;
}

/** The in-flight run's latest progress, or `null` when nothing is running. */
export function getStemProgress(): StemSeparationProgress | null {
  return progressState;
}

function publishProgress(run: ActiveRun, next: Omit<StemSeparationProgress, 'elapsedMs'>, onProgress?: (p: StemSeparationProgress) => void): void {
  if (active !== run) return;
  const progress: StemSeparationProgress = { ...next, elapsedMs: Date.now() - run.startedAt };
  progressState = progress;
  bumpVersion();
  onProgress?.(progress);
}

/**
 * The single abort point: records WHY (so the settled status is honest —
 * 'cancelled' vs 'stale' vs 'source-closed') and kills the utility process
 * exactly once (ruling 7). The in-flight `stems:separate` invoke then resolves
 * `{ok:false, cancelled:true}` and the awaiting run settles through its normal
 * path — abort never settles the promise itself, so there is exactly one
 * settlement site.
 */
function abortRun(run: ActiveRun, reason: AbortReason): void {
  if (run.settled || run.abortReason) return;
  run.abortReason = reason;
  if (!run.cancelInvoked) {
    run.cancelInvoked = true;
    const api = stemApi();
    if (api?.stemsCancel) {
      void api.stemsCancel().catch(() => {
        /* the run settles from the invoke's own resolution regardless */
      });
    }
  }
}

/**
 * Cancels the in-flight separation (ruling 7: Cancel kills the utility
 * process). Resolves `true` when a run was actually cancelled.
 */
export async function cancelStemSeparation(): Promise<boolean> {
  const run = active;
  if (!run) return false;
  abortRun(run, 'user');
  return true;
}

/**
 * Drops any in-flight run whose SOURCE is `docId`. MANDATORY in
 * `closeDocumentFlow`, alongside `invalidateTempo`/`invalidateRemixSession`:
 * without it a closed document's separation would keep a ~5 GB utility
 * process alive computing stems that can never be delivered, and the run
 * would keep the close guard's busy count raised.
 *
 * (The run's store subscription catches a plain `closeDocument()` too — this
 * is the explicit, order-independent wiring the repo's other caches get.)
 */
export function invalidateStemRun(docId: string): void {
  const run = active;
  if (run && run.sourceDocId === docId) abortRun(run, 'closed');
}

// ---------------------------------------------------------------------------
// Model state (S6's dialog talks to this module, never to IPC directly)
// ---------------------------------------------------------------------------

/** Cheap existence+size probe. Never throws; an unavailable preload reads as
 * "not downloaded" so the dialog shows its download state rather than an
 * error. */
export async function getStemModelState(): Promise<StemModelState> {
  const api = stemApi();
  if (!api?.stemsModelState) return { downloaded: false, bytes: null, expectedBytes: MODEL_BYTES };
  try {
    return await api.stemsModelState();
  } catch {
    return { downloaded: false, bytes: null, expectedBytes: MODEL_BYTES };
  }
}

/**
 * Verifies-or-downloads the 166 MB model (ruling 3), streaming byte progress
 * to `onProgress`. Always resolves — a download failure is `{ok:false,error}`,
 * never a rejection.
 */
export async function ensureStemModel(
  onProgress?: (p: { received: number; total: number }) => void
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const api = stemApi();
  if (!api?.stemsEnsureModel) {
    return { ok: false, error: 'Stem separation is unavailable in this build.' };
  }
  const unsubscribe = onProgress && api.onStemsModelProgress ? api.onStemsModelProgress(onProgress) : null;
  try {
    return await api.stemsEnsureModel();
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    unsubscribe?.();
  }
}

// ---------------------------------------------------------------------------
// separateStems
// ---------------------------------------------------------------------------

function fail(status: StemSeparationStatus, message: string): StemSeparationResult {
  return { ok: false, status, message };
}

/** Maps an abort reason onto the status the caller sees. */
function statusForAbort(reason: AbortReason | null): StemSeparationStatus {
  if (reason === 'edited') return 'stale';
  if (reason === 'closed') return 'source-closed';
  return 'cancelled';
}

function messageForAbort(reason: AbortReason | null): string {
  if (reason === 'edited') return 'The source audio changed during separation — the stems were discarded.';
  if (reason === 'closed') return 'The source document was closed during separation.';
  return 'Stem separation was cancelled.';
}

/**
 * Separates `sourceDocId` into four masked stems plus the residual complement.
 * ALWAYS resolves (see the module header's lifetime section); never throws for
 * a user-facing condition. Creates nothing — the caller (S5) owns the landing.
 */
export async function separateStems(req: SeparateStemsRequest): Promise<StemSeparationResult> {
  const api = stemApi();
  if (!api?.stemsSeparate || !api.onStemsProgress || !api.onStemsChunk) {
    return fail('failed', 'Stem separation is unavailable in this build.');
  }
  // Everything from here to the `active = run` assignment is synchronous, so
  // two calls in the same tick cannot both pass the busy gate (the same
  // reservation discipline `stemManager.startSeparation` uses).
  if (active) return fail('busy', 'A stem separation is already running.');

  const doc = findDoc(req.sourceDocId);
  if (!doc) return fail('no-document', `Document ${req.sourceDocId} is not open.`);

  const docLength = doc.channels[0]?.length ?? 0;
  if (docLength === 0) return fail('empty-document', `${doc.name} has no audio to separate.`);

  const channelCount = doc.channels.length;
  const modelLength = Math.round(docLength * (MODEL_SAMPLE_RATE / doc.sampleRate));
  if (modelLength > MAX_MODEL_SAMPLES) {
    return fail(
      'too-long',
      'Stem separation is limited to 15 minutes of audio (the renderer holds roughly 264 MB per minute while building the stems).'
    );
  }

  const run: ActiveRun = {
    id: nextRunId++,
    sourceDocId: doc.id,
    channelRefs: doc.channels.slice(),
    channelCount,
    docLength,
    sampleRate: doc.sampleRate,
    modelLength,
    estimates: [],
    covered: [],
    sanitised: 0,
    abortReason: null,
    cancelInvoked: false,
    settled: false,
    startedAt: Date.now(),
    inferenceStartedAt: 0,
  };
  active = run;
  const sourceName = doc.name;
  const audioMs = (docLength / doc.sampleRate) * 1000;
  const seedEstimateMs = audioMs / MEASURED_REALTIME_FACTOR;

  // EARLY abort: an edit or a close must not leave inference burning for
  // minutes on audio that no longer exists. The delivery-time re-check below
  // is the guarantee; this is the courtesy that saves the CPU.
  const unsubscribeStore = useAppStore.subscribe(() => {
    if (!staleWatchEnabled || active !== run || run.settled) return;
    const live = findDoc(run.sourceDocId);
    if (!live) {
      abortRun(run, 'closed');
    } else if (!sameChannelRefs(run.channelRefs, live.channels)) {
      abortRun(run, 'edited');
    }
  });

  let unsubscribeProgress: (() => void) | null = null;
  let unsubscribeChunk: (() => void) | null = null;

  try {
    const modelState = await getStemModelState();
    if (run.abortReason) return fail(statusForAbort(run.abortReason), messageForAbort(run.abortReason));
    if (!modelState.downloaded) {
      return fail(
        'model-missing',
        'The separation model has not been downloaded yet (166 MB, one time).'
      );
    }

    publishProgress(
      run,
      { phase: 'resampling', segment: 0, totalSegments: 0, fraction: 0, estimatedRemainingMs: seedEstimateMs },
      req.onProgress
    );

    // Ruling 4, leg 1: DOWN to the model's rate with the app's windowed-sinc.
    // `resampleChannel` returns a fresh copy even at an equal rate, so the
    // buffers handed to IPC are never the document's own arrays.
    let outgoing: Float32Array[];
    try {
      outgoing = doc.channels.map((ch) => resampleChannel(ch, doc.sampleRate, MODEL_SAMPLE_RATE));
    } catch (err) {
      // An OOM on a memory-pressured machine is a NORMAL failure here, not an
      // escape (tempoAnalysis.ts's monoSnapshot makes the same call).
      showFailure(errorMessage(err));
      return fail('failed', errorMessage(err));
    }
    if (run.abortReason) return fail(statusForAbort(run.abortReason), messageForAbort(run.abortReason));

    // Estimate accumulators, allocated once at the model rate.
    for (let s = 0; s < HOST_STEM_COUNT; s++) {
      const perChannel: (Float32Array | null)[] = [];
      for (let c = 0; c < channelCount; c++) perChannel.push(new Float32Array(modelLength));
      run.estimates.push(perChannel);
    }

    unsubscribeProgress = api.onStemsProgress((p) => {
      if (active !== run || run.settled) return; // T13: settled-run chatter is dropped
      const total = Number.isFinite(p.totalSegments) && p.totalSegments > 0 ? p.totalSegments : 0;
      const segment = Number.isFinite(p.segment) && p.segment > 0 ? p.segment : 0;
      const elapsedInference = Date.now() - run.inferenceStartedAt;
      const remaining =
        segment > 0 && total > 0
          ? (elapsedInference / segment) * Math.max(0, total - segment)
          : seedEstimateMs;
      publishProgress(
        run,
        {
          phase: 'inference',
          segment,
          totalSegments: total,
          fraction: total > 0 ? segment / total : 0,
          estimatedRemainingMs: remaining,
        },
        req.onProgress
      );
    });

    unsubscribeChunk = api.onStemsChunk((chunk) => {
      if (active !== run || run.settled) return;
      acceptChunk(run, chunk);
    });

    run.inferenceStartedAt = Date.now();
    publishProgress(
      run,
      { phase: 'inference', segment: 0, totalSegments: 0, fraction: 0, estimatedRemainingMs: seedEstimateMs },
      req.onProgress
    );

    let result: Awaited<ReturnType<NonNullable<StemApi['stemsSeparate']>>>;
    try {
      result = await api.stemsSeparate({
        sampleRate: MODEL_SAMPLE_RATE,
        channels: outgoing.map((ch) => ch.buffer as ArrayBuffer),
      });
    } catch (err) {
      // A rejected invoke means the IPC channel itself died. Without this
      // catch the promise would reject instead of resolving — the one thing
      // this module must never do (the v1.4 `effectRunner.ts:106-119` lesson,
      // one layer up).
      //
      // A rejection says nothing about the CHILD, though: the manager may
      // still own a live utility process for this run. Kill it explicitly, or
      // it outlives the run it belonged to (~5 GB, for the rest of the
      // session). Deliberately NOT `abortRun` — this is a failure, not an
      // abort, and must keep the `failed` status rather than becoming
      // `cancelled`.
      if (!run.cancelInvoked) {
        run.cancelInvoked = true;
        void api.stemsCancel?.().catch(() => {
          /* best-effort: the channel that just died may not answer */
        });
      }
      const message = errorMessage(err);
      showFailure(message);
      return fail('failed', message);
    } finally {
      // The model-rate mix is IPC-copied by now; ~100 MB that must not stay
      // alive alongside the estimates.
      outgoing = [];
    }

    // An abort recorded while the invoke was in flight decides the status,
    // even if the manager happened to answer `{ok:true}` first.
    if (run.abortReason) return fail(statusForAbort(run.abortReason), messageForAbort(run.abortReason));

    if (!result.ok) {
      if (result.cancelled) {
        return fail(statusForAbort(run.abortReason), messageForAbort(run.abortReason));
      }
      const message = result.error ?? 'The separation host failed.';
      showFailure(message);
      return fail('failed', message);
    }

    if (!coversExactly(run.covered, modelLength)) {
      const message = `The separation host reported success but delivered incomplete stem audio (${run.covered.length} region(s), expected one covering all ${modelLength} samples).`;
      showFailure(message);
      return fail('failed', message);
    }

    // DELIVERY-TIME staleness re-check (T13): never deliver stems computed
    // from audio that no longer exists.
    const live = findDoc(run.sourceDocId);
    if (!live) return fail('source-closed', messageForAbort('closed'));
    if (!sameChannelRefs(run.channelRefs, live.channels)) return fail('stale', messageForAbort('edited'));

    publishProgress(
      run,
      { phase: 'partitioning', segment: 0, totalSegments: 0, fraction: 1, estimatedRemainingMs: 0 },
      req.onProgress
    );

    // Ruling 4, leg 2: back UP to the document rate, same windowed-sinc, and
    // reordered into the ruling-6 label order as we go.
    const estimates: Float32Array[][] = [];
    for (let li = 0; li < STEM_LABELS.length; li++) {
      const hostIndex = HOST_INDEX_FOR_LABEL[li];
      const perChannel: Float32Array[] = [];
      for (let c = 0; c < channelCount; c++) {
        const modelRate = run.estimates[hostIndex][c];
        if (!modelRate) {
          const message = 'Internal error: a stem estimate was released before use.';
          showFailure(message);
          return fail('failed', message);
        }
        perChannel.push(fitLength(resampleChannel(modelRate, MODEL_SAMPLE_RATE, run.sampleRate), docLength));
        run.estimates[hostIndex][c] = null; // release the model-rate copy
      }
      estimates.push(perChannel);
    }

    let partition;
    try {
      // The mix is the LIVE document's own channels, at its native rate — the
      // exact-sum guarantee is against the real audio (ruling 4). Non-finite
      // input throws here, by S2's input contract; see the non-finite policy.
      partition = partitionStems(live.channels, estimates, { collectStats: true });
    } catch (err) {
      const message = errorMessage(err);
      showFailure(message);
      return fail('failed', message);
    }

    // MED-5: `maxMaskSum` is the MAXIMUM over every bin, frame and channel, so
    // 0 means every ratio mask was 0 everywhere — the model's estimates
    // carried no energy anywhere and the "partition" is four silent stems with
    // `residual === mix`. That is a copy with extra steps, and reporting it as
    // success would be the worst kind of silent failure: the user would be
    // told their track was separated. There is no partial-credit reading of
    // this number — a single bin with any estimate energy pushes it to ~1 —
    // so the threshold is exact rather than a tuned epsilon. Guarded by the
    // mix actually having energy: for a genuinely silent document, all-zero
    // masks are the correct answer.
    if (partition.stats && partition.stats.maxMaskSum <= 0 && hasAnyEnergy(live.channels)) {
      let message =
        'The separation model returned no usable output — every stem came back silent, so nothing was separated.';
      if (run.sanitised > 0) {
        message += ` ${run.sanitised} non-finite model sample(s) had to be discarded.`;
      }
      showFailure(message);
      return fail('failed', message);
    }

    return {
      ok: true,
      output: {
        sourceDocId: run.sourceDocId,
        sourceName,
        sampleRate: run.sampleRate,
        channelCount,
        lengthSamples: docLength,
        stems: STEM_LABELS.map((label, i) => ({ label, channels: partition.stems[i] })),
        residual: partition.residual,
        sanitisedEstimateSamples: run.sanitised,
        stats: partition.stats,
      },
    };
  } catch (err) {
    // MED-3: the always-resolves contract, closed for good. Every allocation
    // on this path is a multi-hundred-megabyte one (the estimate
    // accumulators, both resample legs, the partition's own output), so a
    // `RangeError: Array buffer allocation failed` is a NORMAL failure mode on
    // a memory-pressured machine — not an escape. Leg 1 was already guarded
    // for exactly this reason; this makes the guarantee unconditional, so S5
    // and S6 can be written against "always resolves" without a defensive
    // catch of their own.
    const message = errorMessage(err);
    showFailure(message);
    return fail('failed', message);
  } finally {
    run.settled = true;
    unsubscribeProgress?.();
    unsubscribeChunk?.();
    unsubscribeStore();
    run.estimates = [];
    if (active === run) {
      active = null;
      progressState = null;
    }
    bumpVersion();
  }
}

/**
 * Accumulates one 'stems:chunk' payload — planar, stem-major/channel-minor,
 * block `s*MODEL_CHANNELS+c` of length `samples` (stemHost.cjs). Validated at
 * this boundary like any other cross-process payload: a malformed chunk is
 * DROPPED (the coverage gate then reports the gap) rather than corrupting the
 * accumulators or throwing inside an event callback.
 *
 * Sanitisation happens HERE, at the model rate, before the return-leg
 * resample can smear a single bad sample across up to 63 output samples — see
 * the module header's non-finite policy.
 */
function acceptChunk(run: ActiveRun, chunk: { offset: number; samples: number; data: ArrayBuffer }): void {
  const { offset, samples } = chunk;
  if (!Number.isInteger(offset) || !Number.isInteger(samples)) return;
  if (offset < 0 || samples <= 0 || offset + samples > run.modelLength) return;
  let data: Float32Array;
  try {
    data = new Float32Array(chunk.data);
  } catch {
    return;
  }
  if (data.length !== HOST_STEM_COUNT * MODEL_CHANNELS * samples) return;

  const mono = run.channelCount === 1;
  for (let s = 0; s < HOST_STEM_COUNT; s++) {
    for (let c = 0; c < run.channelCount; c++) {
      const dst = run.estimates[s][c];
      if (!dst) return;
      if (mono) {
        // The host repeated a mono job into both model channels; average them
        // back down. Estimates are the MASK SOURCE only, so this cannot touch
        // the exact-sum guarantee.
        const left = s * MODEL_CHANNELS * samples;
        const right = (s * MODEL_CHANNELS + 1) * samples;
        for (let n = 0; n < samples; n++) {
          const l = data[left + n];
          const r = data[right + n];
          const lf = Number.isFinite(l) ? l : (run.sanitised++, 0);
          const rf = Number.isFinite(r) ? r : (run.sanitised++, 0);
          dst[offset + n] = (lf + rf) / 2;
        }
      } else {
        const base = (s * MODEL_CHANNELS + c) * samples;
        for (let n = 0; n < samples; n++) {
          const v = data[base + n];
          dst[offset + n] = Number.isFinite(v) ? v : (run.sanitised++, 0);
        }
      }
    }
  }
  addCoverage(run.covered, offset, offset + samples);
}
