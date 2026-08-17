/**
 * Renderer-side transcription service (Auditorium F4b) — the join between the
 * main-process inference host (`electron/transcribeHost.cjs`, driven by
 * `electron/transcribeManager.cjs`) and the UI. It owns the whole renderer
 * half: the IPC round trip, the resample discipline, staleness, lifetime, busy
 * accounting, the diarization pass and the transcript store the panel reads.
 *
 * This is `stemService.ts`'s shape, deliberately. v1.7 shipped exactly this
 * pattern — renderer service, one run at a time, progress, a Cancel that kills
 * the utility process, an always-resolving promise — and F4b extends it rather
 * than inventing a second one. Where the two differ, the difference is stated
 * below with its reason.
 *
 * ## The pipeline
 *
 *   document channels (native rate, any channel count)
 *     -> average to MONO at the document rate            [one pass, one alloc]
 *     -> resampleChannel(..., 16000)                     [the app's windowed-sinc]
 *     -> IPC 'transcribe:run' -> utilityProcess -> Whisper base (ONNX, CPU EP)
 *     -> 'transcribe:segment' events   (positions in 16 kHz samples)
 *     -> 'transcribe:embedding' events (CAM++ 512-d, only for segments >= 0.5 s)
 *     -> clusterSpeakers(...)                            [src/dsp/speakerClustering.ts]
 *     -> positions converted BACK to document samples
 *     -> Transcript stored per document
 *
 * MONO because the host's contract is mono (`transcribeHost.cjs`: "audio is
 * MONO"), and 16 kHz because that is Whisper's fixed input rate
 * (`whisperFeatures.cjs` WHISPER_SAMPLE_RATE). The averaging happens BEFORE the
 * resample so the windowed-sinc runs once instead of once per channel.
 *
 * Positions make the round trip in SAMPLES, never seconds: the host reports
 * 16 kHz sample offsets, and this module converts them to DOCUMENT samples
 * (`round(modelSample * rate / 16000)`, clamped to the document length) before
 * anything else sees them. Everything downstream — the panel, the timeline
 * ribbon, the SRT/WebVTT exporter — works in document samples, so a transcript
 * lines up with the waveform it was made from at any sample rate.
 *
 * ## Diarization is re-runnable WITHOUT re-running Whisper
 *
 * The embeddings are kept alongside the segments (512 floats x segment count —
 * a 2 KB row per segment, i.e. ~1 MB for a 500-segment hour). That is what
 * makes {@link setTranscriptSpeakerCount} instant: changing the speaker count
 * re-clusters stored vectors, it does not re-transcribe. The measured
 * diarization accuracy makes that control MANDATORY rather than a nicety — see
 * the honesty note on {@link DIARIZATION_LIMITS}.
 *
 * ## Staleness — the transcript is MARKED, not dropped
 *
 * An in-flight run aborts on a source edit or close, exactly like a stem run
 * (`abortRun`, delivery-time re-check, the `peaksCache.ts:16-22` channel-array
 * identity convention this repo uses everywhere for "has this audio changed").
 *
 * A FINISHED transcript is treated differently: an edit marks it stale
 * ({@link isTranscriptStale}) instead of deleting it. Timestamps taken from
 * before an edit no longer line up, and the UI must say so — but silently
 * throwing away minutes of inference because the user trimmed a millisecond of
 * silence would be worse than showing a warned-about transcript. Closing the
 * document DOES drop it ({@link invalidateTranscript}, called from
 * `closeDocumentFlow`), because the row otherwise retains the closed
 * document's channel arrays for the rest of the session — the leak class
 * `invalidateTempo`/`invalidateStemRun` already manage.
 *
 * ## Lifetime
 *
 * One run at a time (the manager enforces the same); a second request resolves
 * `busy` rather than queueing. The utility process is killed on cancel, on a
 * source edit, on source close, on any terminal failure and on app quit
 * (main's `will-quit` -> `manager.dispose()`). The returned promise ALWAYS
 * resolves — never rejects, never hangs — including when the IPC invoke itself
 * rejects on a dead channel. A hung promise would leave the busy gate shut for
 * the rest of the session.
 */

import { useSyncExternalStore } from 'react';
import type { AudioDocument } from '../audio/AudioDocument';
import { useAppStore } from '../stores/appStore';
import { resampleChannel } from '../dsp/resample';
import { clusterSpeakers, MAX_SPEAKERS } from '../dsp/speakerClustering';
import type { TranscriptSegment } from './subtitleFormat';
import { formatSrt, formatWebVtt } from './subtitleFormat';

// ---------------------------------------------------------------------------
// Constants — mirrored from the main-process modules named in each comment.
// They are duplicated rather than imported because the renderer must never
// load anything from `electron/` (CommonJS main-process modules that pull in
// onnxruntime-node transitively).
// ---------------------------------------------------------------------------

/** Whisper's fixed input rate (`electron/whisperFeatures.cjs` WHISPER_SAMPLE_RATE). */
export const WHISPER_SAMPLE_RATE = 16000;

/**
 * Job-length cap, in 16 kHz samples: 2 hours.
 *
 * MIRRORED from `transcribeHost.cjs` MAX_TOTAL_SAMPLES via the manager's
 * `parseTranscribeRequest`, which rejects any request above it — so the two
 * MUST agree or a job the renderer accepts is refused at the trust boundary
 * with an opaque "invalid transcribe request".
 *
 * Unlike stem separation (whose renderer cap is TIGHTER than the host's,
 * because the partition holds ~20 channel-arrays of the user's audio at once),
 * the renderer holds strictly LESS than the host here: one mono 16 kHz
 * Float32Array, 4 B x 16000 x 7200 = 460.8 MB at the cap, plus the transient
 * structured-clone copy IPC makes of it, plus the segment text and the
 * embeddings (512 floats per embedded segment = 2 KB each). There is no
 * per-channel expansion and no second full-rate copy, so the host's own
 * arithmetic is the binding one and mirroring it is correct.
 */
export const MAX_MODEL_SAMPLES = WHISPER_SAMPLE_RATE * 7200;

/**
 * Total download size of the pinned six-file model set, used ONLY as the
 * fallback for the "no preload" model state so the dialog can still state a
 * size. The live number comes from `transcribe:model-state`.
 *
 * Derived, not invented: the sum of the six `bytes` pins in
 * `electron/transcribeManager.cjs` TRANSCRIBE_FILES —
 * 82,468,078 + 208,521,528 + 2,480,466 + 3,832 + 2,243 + 29,292,684.
 */
export const TRANSCRIBE_MODEL_BYTES = 322768831;

/**
 * Time-estimate seed: audio-seconds transcribed per wall-second.
 *
 * MEASURED, not chosen — `.superpowers/sdd/task-F4-report.md` section 4, the
 * spoken control (`jfk.wav`, 11 s, whisper-base, CPU EP, this machine): RTF
 * x9.02. Used only until the host's first progress event lands, after which
 * the estimate is derived from THIS run's own measured rate.
 *
 * Exported so the dialog states the figure it will actually be held to rather
 * than re-typing it where the two could drift apart.
 */
export const MEASURED_REALTIME_FACTOR = 9.02;

/** The clustering module's candidate bound, re-exported so the UI's speaker
 * picker cannot offer a count the clusterer would silently clamp. */
export { MAX_SPEAKERS };

/**
 * What the shipped diarization was MEASURED to do, in the UI's own words.
 *
 * Every number here comes from `.superpowers/sdd/task-F4-report.md` section 3
 * (ground truth known by construction: every chunk cut from a single-speaker
 * recording). It lives in code so the panel, the dialog and the docs cannot
 * drift into promising more than was measured.
 *
 * The material was CONCATENATED single-speaker recordings — clean cuts, no
 * crosstalk, no overlapping speech, and differing channel conditions between
 * speakers, all of which make the task EASIER than real conversation. 100% on
 * two speakers is therefore an upper bound, not a field expectation.
 */
export const DIARIZATION_LIMITS = Object.freeze({
  /** 4/4 two-speaker sets, 100% segment accuracy; 5/5 single-speaker sets returned 1. */
  reliableUpTo: 2,
  /** 1/1 three-speaker set returned 2 speakers at 45% accuracy. */
  threeSpeakerAccuracy: 0.45,
  /** The same set, TOLD there were three, still only reached 73%. */
  threeSpeakerAccuracyWhenTold: 0.73,
});

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TranscribeModelState {
  downloaded: boolean;
  bytes: number | null;
  expectedBytes: number;
}

export type TranscribeRunPhase = 'resampling' | 'transcribing' | 'embedding' | 'clustering';

export interface TranscribeProgress {
  phase: TranscribeRunPhase;
  /** Units are the phase's own: 16 kHz samples while transcribing, segments
   * while embedding, 0 otherwise. */
  done: number;
  total: number;
  /** `done / total`, 0 when the total is not known yet. */
  fraction: number;
  elapsedMs: number;
  /** Seeded from {@link MEASURED_REALTIME_FACTOR}, then refined from this
   * run's own measured rate. Null while the EMBEDDING phase has nothing to
   * extrapolate from (`done === 0 || total === 0`): that phase runs at its own
   * rate, so reusing the decode seed there would be wrong by an order of
   * magnitude, and a null that renders as "estimating…" is the honest answer.
   * The resampling/transcribing phases always carry a number (the seed until
   * their own rate is measurable), and clustering reports 0. */
  estimatedRemainingMs: number | null;
}

/**
 * One transcript row. Positions are DOCUMENT samples (see the module header),
 * so `startSample / doc.sampleRate` is wall-clock in the document's own
 * timeline.
 *
 * Extends the exporter's {@link TranscriptSegment} rather than redeclaring it,
 * so a transcript can be handed to `formatSrt`/`formatWebVtt` unchanged.
 */
export interface TranscriptEntry extends TranscriptSegment {
  /** The host's own segment index — dense, ascending, stable across a
   * re-cluster, and therefore the React key. */
  index: number;
  avgLogprob: number;
  noSpeechProb: number;
  compressionRatio: number;
}

export interface Transcript {
  docId: string;
  docName: string;
  /** The DOCUMENT's rate; segment positions are in this rate's samples. */
  sampleRate: number;
  lengthSamples: number;
  language: string | null;
  languageProbability: number | null;
  segments: TranscriptEntry[];
  speakerCount: number;
  /** `null` when the count was auto-detected, otherwise the count the user
   * asserted through {@link setTranscriptSpeakerCount}. */
  requestedSpeakerCount: number | null;
  /** Silhouette of the returned partition, or null (a fixed count, or too few
   * embeddings for the coefficient to mean anything). */
  silhouette: number | null;
  /** Segments too short to embed (< 0.5 s, the host's MIN_EMBED_SAMPLES) and
   * therefore not clustered on their own evidence. */
  unembeddedSegments: number;
  /**
   * The largest speaker count this transcript's EVIDENCE can support: one
   * cluster per embedded segment, capped at {@link MAX_SPEAKERS}. Asking for
   * more than there are embeddings to split is not a stricter request, it is
   * an impossible one — `clusterSpeakers` clamps it and the UI would then
   * display a number the result contradicts.
   */
  maxUsableSpeakers: number;
  /** Segments left with `speaker === null` after neighbour inheritance. */
  unlabelledSegments: number;
  /** Parallel to `segments`; `null` where the host sent no embedding. Kept so
   * the speaker count can be changed without re-running Whisper. */
  embeddings: (Float32Array | null)[];
  /** Channel-array identity snapshot for {@link isTranscriptStale}. */
  channelRefs: Float32Array[];
  createdAt: number;
}

export type TranscribeStatus =
  | 'no-document'
  | 'empty-document'
  | 'bad-speaker-count'
  | 'too-long'
  | 'busy'
  | 'model-missing'
  | 'cancelled'
  | 'stale'
  | 'source-closed'
  | 'failed';

export type TranscribeResult =
  | { ok: true; transcript: Transcript }
  | { ok: false; status: TranscribeStatus; message: string };

export interface TranscribeRequest {
  docId: string;
  /**
   * Speaker count to force, or `undefined` to auto-detect. Auto-detection is
   * measurably reliable only up to {@link DIARIZATION_LIMITS.reliableUpTo}
   * speakers, which is why the UI must expose this.
   */
  speakerCount?: number;
  onProgress?: (progress: TranscribeProgress) => void;
}

// ---------------------------------------------------------------------------
// The preload surface (electron/preload.cjs), read defensively — jsdom and an
// older preload both legitimately lack it.
// ---------------------------------------------------------------------------

interface TranscribeApi {
  transcribeModelState?(): Promise<TranscribeModelState>;
  transcribeEnsureModels?(): Promise<{ ok: true } | { ok: false; error: string }>;
  onTranscribeModelProgress?(
    cb: (p: { file: string; fileIndex: number; fileCount: number; received: number; total: number }) => void
  ): () => void;
  transcribeRun?(req: {
    sampleRate: number;
    samples: ArrayBuffer;
    language: string;
  }): Promise<{ ok: true; segmentCount: number } | { ok: false; cancelled?: true; error?: string }>;
  transcribeCancel?(): Promise<{ cancelled: boolean }>;
  onTranscribeProgress?(cb: (p: { stage: 'transcribe' | 'embed'; done: number; total: number }) => void): () => void;
  onTranscribeLanguage?(cb: (p: { language: string; probability: number }) => void): () => void;
  onTranscribeSegment?(
    cb: (s: {
      index: number;
      startSample: number;
      endSample: number;
      text: string;
      avgLogprob: number;
      noSpeechProb: number;
      compressionRatio: number;
    }) => void
  ): () => void;
  onTranscribeEmbedding?(cb: (e: { segmentIndex: number; vector: ArrayBuffer }) => void): () => void;
  showMessageBox?(opts: {
    type?: 'info' | 'warning' | 'error' | 'question';
    title?: string;
    message: string;
  }): Promise<number>;
  showSaveDialog?(opts: {
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<string | null>;
  writeFile?(path: string, data: ArrayBuffer): Promise<{ ok: true } | { ok: false; error: string }>;
}

function api(): TranscribeApi | undefined {
  return (window as unknown as { electronAPI?: TranscribeApi }).electronAPI;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Terminal failures only — a cancel, a staleness abort or a busy refusal is
 * not an error and must not raise a native dialog (the `stemService.ts` /
 * `remixService.ts` one-liner). */
function showFailure(message: string): void {
  void api()?.showMessageBox?.({ type: 'error', title: 'Transcription failed', message });
}

// ---------------------------------------------------------------------------
// Reactivity — version counter + subscribe/getSnapshot, copied in shape from
// stemService.ts / tempoAnalysis.ts. NOT zustand.
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

/** Monotonic counter bumped on run start, on every progress event, on
 * settlement and on every transcript mutation; non-reactive read. */
export function getTranscribeVersion(): number {
  return version;
}

/** Re-renders the caller whenever transcription state changes. */
export function useTranscribeVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function findDoc(docId: string): AudioDocument | undefined {
  return useAppStore.getState().documents.find((d) => d.id === docId);
}

/** Copied VERBATIM from `peaksCache.ts:16-22` / `stemService.ts` — this repo's
 * identity-based "has the audio changed" test. */
function sameChannelRefs(a: readonly Float32Array[], b: readonly Float32Array[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Averages every channel into ONE fresh Float32Array at the document's own
 * rate — the same single-pass shape as `tempoAnalysis.ts`'s `monoSnapshot`,
 * and deliberately not `mixDown(cloneRegion(...))`, which allocates the whole
 * document twice before producing the mono buffer.
 *
 * Only this fresh buffer is ever resampled or handed to IPC; `doc.channels` is
 * read and never transferred, so the repo-wide "never transfer doc.channels"
 * invariant holds.
 */
export function monoMix(channels: readonly Float32Array[], length: number): Float32Array {
  const out = new Float32Array(length);
  const count = channels.length;
  if (count === 0) return out;
  for (const ch of channels) {
    const n = Math.min(length, ch.length);
    for (let i = 0; i < n; i++) out[i] += ch[i];
  }
  if (count > 1) {
    for (let i = 0; i < length; i++) out[i] /= count;
  }
  return out;
}

/**
 * 16 kHz sample position -> DOCUMENT sample position, clamped into
 * `[0, docLength]`.
 *
 * The clamp is load-bearing at BOTH ends: the host's own positions are already
 * clamped to its `totalSamples`, but that total is
 * `round(docLength * 16000 / rate)`, and scaling it back can round one sample
 * PAST `docLength` for some rate/length pairs. A cue that ends after the file
 * does is a malformed cue, and a negative start is not representable in either
 * subtitle format.
 */
export function modelSampleToDoc(modelSample: number, sampleRate: number, docLength: number): number {
  const scaled = Math.round(modelSample * (sampleRate / WHISPER_SAMPLE_RATE));
  if (scaled < 0) return 0;
  if (scaled > docLength) return docLength;
  return scaled;
}

/**
 * Assigns a speaker to every segment from the embeddings that exist.
 *
 * Two rules, and the second one is the honest part:
 *
 *  1. Segments WITH an embedding are clustered by
 *     {@link clusterSpeakers} — Ward linkage, silhouette-selected k, then the
 *     measured same-speaker merge pass (or exactly `speakerCount` clusters
 *     when the caller asserts one).
 *  2. Segments WITHOUT one (shorter than the host's 0.5 s MIN_EMBED_SAMPLES,
 *     below which an embedding is more noise than voice) inherit a label ONLY
 *     when their immediate labelled neighbours are UNANIMOUS — one neighbour
 *     that exists, or two that agree. A short segment sitting between two
 *     DIFFERENT speakers is exactly the case where it is most likely to be the
 *     turn boundary itself, so it stays `null`. The brief's rule: a confident
 *     wrong speaker label is worse than an unknown one.
 *
 * Returns speakers parallel to `embeddings`.
 */
/**
 * The ONE speaker-count contract, shared by the request path and the
 * re-cluster path so the two cannot disagree.
 *
 * `null` means auto-detect and is always valid. A number is valid only if it
 * is an integer in `[1, min(MAX_SPEAKERS, maxUsable)]`. Out of range is
 * REFUSED, never silently downgraded to auto and never clamped: a caller who
 * asked for 8 speakers and got 6 without being told has been lied to, and one
 * who asked for 8 and got auto-detection has been lied to differently.
 */
export function validateSpeakerCount(
  count: number | null | undefined,
  maxUsable: number
): { ok: true; value: number | null } | { ok: false; message: string } {
  if (count === null || count === undefined) return { ok: true, value: null };
  const ceiling = Math.min(MAX_SPEAKERS, Math.max(1, maxUsable));
  if (!Number.isInteger(count) || count < 1 || count > ceiling) {
    return {
      ok: false,
      message: `Speaker count must be a whole number between 1 and ${ceiling}, or left on automatic (got ${count}).`,
    };
  }
  return { ok: true, value: count };
}

/** How many distinct speakers this many embeddings could possibly separate. */
export function maxUsableSpeakerCount(embeddedSegments: number): number {
  return Math.max(1, Math.min(MAX_SPEAKERS, embeddedSegments));
}

export function assignSpeakerLabels(
  embeddings: readonly (Float32Array | null)[],
  options: { speakerCount?: number } = {}
): { speakers: (number | null)[]; speakerCount: number; silhouette: number | null } {
  const present: Float32Array[] = [];
  const presentIndex: number[] = [];
  for (let i = 0; i < embeddings.length; i++) {
    const v = embeddings[i];
    if (v) {
      present.push(v);
      presentIndex.push(i);
    }
  }

  const speakers: (number | null)[] = embeddings.map(() => null);
  if (present.length === 0) {
    return { speakers, speakerCount: 0, silhouette: null };
  }

  const clustered = clusterSpeakers(present, options);
  for (let i = 0; i < presentIndex.length; i++) {
    speakers[presentIndex[i]] = clustered.labels[i];
  }

  // Rule 2 — unanimous-neighbour inheritance, resolved against the ORIGINAL
  // clustered labels.
  //
  // The snapshot is DEFENSIVE, not load-bearing, and the comment says so
  // rather than overstating it: mutating it away (resolving against the live
  // array, so an inherited label can seed the next inheritance) survives the
  // suite, because it cannot change any answer. An inherited label is by
  // construction the nearest ORIGINAL label in the direction it came from, so
  // a later scan that stops at it finds the same value it would have found by
  // scanning past it. What the snapshot does buy is INDEPENDENCE FROM SWEEP
  // ORDER — the rule reads as a statement about each segment's own
  // neighbours rather than about the order this loop happens to run in.
  const clusteredOnly = speakers.slice();
  for (let i = 0; i < speakers.length; i++) {
    if (speakers[i] !== null) continue;
    let before: number | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (clusteredOnly[j] !== null) {
        before = clusteredOnly[j];
        break;
      }
    }
    let after: number | null = null;
    for (let j = i + 1; j < speakers.length; j++) {
      if (clusteredOnly[j] !== null) {
        after = clusteredOnly[j];
        break;
      }
    }
    if (before === null) speakers[i] = after;
    else if (after === null) speakers[i] = before;
    else if (before === after) speakers[i] = before;
    // else: the two sides disagree — this segment straddles a turn, leave null.
  }

  return { speakers, speakerCount: clustered.speakerCount, silhouette: clustered.silhouette };
}

// ---------------------------------------------------------------------------
// The transcript store — one per document
// ---------------------------------------------------------------------------

const transcripts = new Map<string, Transcript>();

/** The stored transcript for `docId`, or null. Non-reactive; pair it with
 * {@link useTranscribeVersion} in a component. */
export function getTranscript(docId: string): Transcript | null {
  return transcripts.get(docId) ?? null;
}

/**
 * True when the document's audio has changed since the transcript was made, so
 * its timestamps no longer line up. The transcript is KEPT (see the module
 * header) — the UI's job is to say so.
 */
export function isTranscriptStale(docId: string): boolean {
  const t = transcripts.get(docId);
  if (!t) return false;
  const doc = findDoc(docId);
  if (!doc) return true;
  return !sameChannelRefs(t.channelRefs, doc.channels);
}

/**
 * Drops the transcript and aborts any in-flight run for `docId`. MANDATORY in
 * `closeDocumentFlow` alongside `invalidateTempo`/`invalidateStemRun`: the
 * stored `channelRefs` otherwise retain the closed document's channel arrays
 * for the rest of the session, and a run for a closed document would keep a
 * ~1 GB utility process alive producing a transcript that can never land.
 */
export function invalidateTranscript(docId: string): void {
  const run = active;
  if (run && run.docId === docId) abortRun(run, 'closed');
  if (transcripts.delete(docId)) bumpVersion();
}

/**
 * Re-clusters an existing transcript at a different speaker count, WITHOUT
 * re-running Whisper (the embeddings were kept for exactly this). Pass `null`
 * to go back to auto-detection.
 *
 * Returns the new transcript, or null when there is nothing to re-cluster.
 * Counts outside `[1, MAX_SPEAKERS]` are refused rather than clamped: the
 * clusterer would silently clamp them, and a picker that shows 8 while the
 * result says 6 is a lie.
 */
export function setTranscriptSpeakerCount(docId: string, count: number | null): Transcript | null {
  const current = transcripts.get(docId);
  if (!current) return null;
  const validated = validateSpeakerCount(count, current.maxUsableSpeakers);
  if (!validated.ok) return null;
  if (current.requestedSpeakerCount === count) return current;

  const assigned = assignSpeakerLabels(
    current.embeddings,
    count === null ? {} : { speakerCount: count }
  );
  const segments = current.segments.map((seg, i) => ({ ...seg, speaker: assigned.speakers[i] }));
  const next: Transcript = {
    ...current,
    segments,
    speakerCount: assigned.speakerCount,
    requestedSpeakerCount: count,
    silhouette: assigned.silhouette,
    unlabelledSegments: assigned.speakers.filter((s) => s === null).length,
  };
  transcripts.set(docId, next);
  bumpVersion();
  return next;
}

/** Test-only (this repo's `_xxxForTest` convention): empties the transcript
 * store so suites do not leak state into each other. */
export function _resetTranscriptsForTest(): void {
  transcripts.clear();
  active = null;
  progressState = null;
  bumpVersion();
}

// ---------------------------------------------------------------------------
// Run state — one at a time, exactly like the manager
// ---------------------------------------------------------------------------

type AbortReason = 'user' | 'edited' | 'closed';

interface HostSegment {
  index: number;
  startSample: number;
  endSample: number;
  text: string;
  avgLogprob: number;
  noSpeechProb: number;
  compressionRatio: number;
}

interface ActiveRun {
  id: number;
  docId: string;
  /** Identity snapshot taken at REQUEST time. */
  channelRefs: Float32Array[];
  docLength: number;
  sampleRate: number;
  modelLength: number;
  segments: HostSegment[];
  /** Keyed by the host's segment index — embeddings arrive in a separate pass
   * AFTER the segments, and not every segment gets one. */
  embeddings: Map<number, Float32Array>;
  language: string | null;
  languageProbability: number | null;
  abortReason: AbortReason | null;
  cancelInvoked: boolean;
  settled: boolean;
  startedAt: number;
  /** Wall clock at the first 'transcribe' progress event with done > 0. */
  transcribeStartedAt: number;
}

let active: ActiveRun | null = null;
let nextRunId = 1;
let progressState: TranscribeProgress | null = null;
let staleWatchEnabled = true;

/**
 * Test-only (`stemService._setStaleWatchForTest`'s twin). Disables the
 * EARLY-abort store subscription so the DELIVERY-TIME staleness gate can be
 * exercised on its own — in production the subscription always fires first, so
 * that branch would otherwise be untestable, and an untestable guarantee is
 * not a guarantee.
 */
export function _setStaleWatchForTest(enabled: boolean): void {
  staleWatchEnabled = enabled;
}

/** True while a transcription is in flight. */
export function isTranscribing(): boolean {
  return active !== null;
}

/**
 * Busy-work count for the close guard (App.tsx adds it to
 * `getInFlightSaveCount()`): quitting mid-run must WARN rather than silently
 * discard minutes of inference.
 */
export function getTranscribeBusyCount(): number {
  return active ? 1 : 0;
}

/** The in-flight run's latest progress, or null when nothing is running. */
export function getTranscribeProgress(): TranscribeProgress | null {
  return progressState;
}

function publishProgress(
  run: ActiveRun,
  next: Omit<TranscribeProgress, 'elapsedMs'>,
  onProgress?: (p: TranscribeProgress) => void
): void {
  if (active !== run) return;
  const progress: TranscribeProgress = { ...next, elapsedMs: Date.now() - run.startedAt };
  progressState = progress;
  bumpVersion();
  onProgress?.(progress);
}

/**
 * The single abort point: records WHY (so the settled status is honest —
 * 'cancelled' vs 'stale' vs 'source-closed') and kills the utility process
 * exactly once. The in-flight `transcribe:run` invoke then resolves
 * `{ok:false, cancelled:true}` and the awaiting run settles through its normal
 * path — abort never settles the promise itself, so there is exactly one
 * settlement site.
 */
function abortRun(run: ActiveRun, reason: AbortReason): void {
  if (run.settled || run.abortReason) return;
  run.abortReason = reason;
  if (!run.cancelInvoked) {
    run.cancelInvoked = true;
    const bridge = api();
    if (bridge?.transcribeCancel) {
      void bridge.transcribeCancel().catch(() => {
        /* the run settles from the invoke's own resolution regardless */
      });
    }
  }
}

/** Cancels the in-flight transcription — the manager kills the utility
 * process. Resolves `true` when a run was actually cancelled. */
export async function cancelTranscription(): Promise<boolean> {
  const run = active;
  if (!run) return false;
  abortRun(run, 'user');
  return true;
}

// ---------------------------------------------------------------------------
// Model state
// ---------------------------------------------------------------------------

/** Cheap existence+size probe over the whole six-file set. Never throws; an
 * unavailable preload reads as "not downloaded" so the dialog shows its
 * download state rather than an error. */
export async function getTranscribeModelState(): Promise<TranscribeModelState> {
  const bridge = api();
  if (!bridge?.transcribeModelState) {
    return { downloaded: false, bytes: null, expectedBytes: TRANSCRIBE_MODEL_BYTES };
  }
  try {
    return await bridge.transcribeModelState();
  } catch {
    return { downloaded: false, bytes: null, expectedBytes: TRANSCRIBE_MODEL_BYTES };
  }
}

/**
 * Verifies-or-downloads the whole pinned file set, streaming OVERALL byte
 * progress to `onProgress`. Always resolves — a download failure is
 * `{ok:false,error}`, never a rejection.
 */
export async function ensureTranscribeModels(
  onProgress?: (p: { file: string; fileIndex: number; fileCount: number; received: number; total: number }) => void
): Promise<{ ok: true } | { ok: false; error: string }> {
  const bridge = api();
  if (!bridge?.transcribeEnsureModels) {
    return { ok: false, error: 'Transcription is unavailable in this build.' };
  }
  const unsubscribe =
    onProgress && bridge.onTranscribeModelProgress ? bridge.onTranscribeModelProgress(onProgress) : null;
  try {
    return await bridge.transcribeEnsureModels();
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    unsubscribe?.();
  }
}

// ---------------------------------------------------------------------------
// transcribeDocument
// ---------------------------------------------------------------------------

function fail(status: TranscribeStatus, message: string): TranscribeResult {
  return { ok: false, status, message };
}

function statusForAbort(reason: AbortReason | null): TranscribeStatus {
  if (reason === 'edited') return 'stale';
  if (reason === 'closed') return 'source-closed';
  return 'cancelled';
}

function messageForAbort(reason: AbortReason | null): string {
  if (reason === 'edited') return 'The audio changed during transcription — the transcript was discarded.';
  if (reason === 'closed') return 'The document was closed during transcription.';
  return 'Transcription was cancelled.';
}

/**
 * Transcribes `docId` and diarizes the result. ALWAYS resolves (see the module
 * header's lifetime section); never throws for a user-facing condition. On
 * success the transcript is stored and readable through {@link getTranscript}.
 */
export async function transcribeDocument(req: TranscribeRequest): Promise<TranscribeResult> {
  const bridge = api();
  if (
    !bridge?.transcribeRun ||
    !bridge.onTranscribeProgress ||
    !bridge.onTranscribeSegment ||
    !bridge.onTranscribeEmbedding ||
    !bridge.onTranscribeLanguage
  ) {
    return fail('failed', 'Transcription is unavailable in this build.');
  }
  // Everything from here to the `active = run` assignment is synchronous, so
  // two calls in the same tick cannot both pass the busy gate (the same
  // reservation discipline `transcribeManager.startTranscription` uses).
  if (active) return fail('busy', 'A transcription is already running.');

  const doc = findDoc(req.docId);
  if (!doc) return fail('no-document', `Document ${req.docId} is not open.`);

  const docLength = doc.channels[0]?.length ?? 0;
  if (docLength === 0) return fail('empty-document', `${doc.name} has no audio to transcribe.`);

  const modelLength = Math.round(docLength * (WHISPER_SAMPLE_RATE / doc.sampleRate));
  if (modelLength > MAX_MODEL_SAMPLES) {
    return fail('too-long', 'Transcription is limited to 2 hours of audio in one job.');
  }
  if (modelLength === 0) {
    // A document shorter than one 16 kHz sample period resamples to nothing,
    // and the manager rejects a zero-length buffer at the trust boundary.
    return fail('empty-document', `${doc.name} is too short to transcribe.`);
  }

  const run: ActiveRun = {
    id: nextRunId++,
    docId: doc.id,
    channelRefs: doc.channels.slice(),
    docLength,
    sampleRate: doc.sampleRate,
    modelLength,
    segments: [],
    embeddings: new Map(),
    language: null,
    languageProbability: null,
    abortReason: null,
    cancelInvoked: false,
    settled: false,
    startedAt: Date.now(),
    transcribeStartedAt: 0,
  };
  active = run;
  const docName = doc.name;
  const audioMs = (docLength / doc.sampleRate) * 1000;
  const seedEstimateMs = audioMs / MEASURED_REALTIME_FACTOR;

  // EARLY abort: an edit or a close must not leave inference burning on audio
  // that no longer exists. The delivery-time re-check below is the guarantee;
  // this is the courtesy that saves the CPU.
  const unsubscribeStore = useAppStore.subscribe(() => {
    if (!staleWatchEnabled || active !== run || run.settled) return;
    const live = findDoc(run.docId);
    if (!live) abortRun(run, 'closed');
    else if (!sameChannelRefs(run.channelRefs, live.channels)) abortRun(run, 'edited');
  });

  const unsubscribers: (() => void)[] = [];

  try {
    const modelState = await getTranscribeModelState();
    if (run.abortReason) return fail(statusForAbort(run.abortReason), messageForAbort(run.abortReason));
    if (!modelState.downloaded) {
      return fail(
        'model-missing',
        'The transcription models have not been downloaded yet (about 323 MB, one time).'
      );
    }

    publishProgress(
      run,
      { phase: 'resampling', done: 0, total: 0, fraction: 0, estimatedRemainingMs: seedEstimateMs },
      req.onProgress
    );

    // Mono at the document rate, then ONE windowed-sinc pass down to 16 kHz.
    let outgoing: Float32Array;
    try {
      const mono = monoMix(doc.channels, docLength);
      outgoing = resampleChannel(mono, doc.sampleRate, WHISPER_SAMPLE_RATE);
    } catch (err) {
      // An OOM on a memory-pressured machine is a NORMAL failure here, not an
      // escape (`tempoAnalysis.ts`'s monoSnapshot makes the same call).
      showFailure(errorMessage(err));
      return fail('failed', errorMessage(err));
    }
    if (run.abortReason) return fail(statusForAbort(run.abortReason), messageForAbort(run.abortReason));

    // `resampleChannel` rounds independently of the arithmetic above, so the
    // buffer's real length is what the host will be told and what its segment
    // positions are relative to.
    run.modelLength = outgoing.length;

    unsubscribers.push(
      bridge.onTranscribeLanguage((p) => {
        if (active !== run || run.settled) return;
        if (typeof p.language !== 'string') return;
        run.language = p.language;
        run.languageProbability = Number.isFinite(p.probability) ? p.probability : null;
        bumpVersion();
      })
    );

    unsubscribers.push(
      bridge.onTranscribeProgress((p) => {
        if (active !== run || run.settled) return; // settled-run chatter is dropped
        const total = Number.isFinite(p.total) && p.total > 0 ? p.total : 0;
        const done = Number.isFinite(p.done) && p.done > 0 ? p.done : 0;
        if (p.stage === 'transcribe') {
          if (run.transcribeStartedAt === 0) run.transcribeStartedAt = run.startedAt;
          const elapsed = Date.now() - run.transcribeStartedAt;
          const remaining = done > 0 && total > 0 ? (elapsed / done) * Math.max(0, total - done) : seedEstimateMs;
          publishProgress(
            run,
            {
              phase: 'transcribing',
              done,
              total,
              fraction: total > 0 ? Math.min(1, done / total) : 0,
              estimatedRemainingMs: remaining,
            },
            req.onProgress
          );
        } else {
          publishProgress(
            run,
            {
              phase: 'embedding',
              done,
              total,
              fraction: total > 0 ? Math.min(1, done / total) : 0,
              // The embedding pass has its own rate; extrapolate from ITS
              // measured progress rather than reusing the decode seed, which
              // would be wrong by an order of magnitude.
              estimatedRemainingMs:
                done > 0 && total > 0
                  ? ((Date.now() - run.startedAt) / done) * Math.max(0, total - done)
                  : null,
            },
            req.onProgress
          );
        }
      })
    );

    unsubscribers.push(
      bridge.onTranscribeSegment((s) => {
        if (active !== run || run.settled) return;
        acceptSegment(run, s);
      })
    );

    unsubscribers.push(
      bridge.onTranscribeEmbedding((e) => {
        if (active !== run || run.settled) return;
        acceptEmbedding(run, e);
      })
    );

    publishProgress(
      run,
      { phase: 'transcribing', done: 0, total: run.modelLength, fraction: 0, estimatedRemainingMs: seedEstimateMs },
      req.onProgress
    );

    let result: Awaited<ReturnType<NonNullable<TranscribeApi['transcribeRun']>>>;
    try {
      result = await bridge.transcribeRun({
        sampleRate: WHISPER_SAMPLE_RATE,
        samples: outgoing.buffer as ArrayBuffer,
        // 'auto' is the host's own language-detection path, measured in the F4
        // bench. No language picker: offering one would mean inventing the
        // list of codes this tokenizer accepts.
        language: 'auto',
      });
    } catch (err) {
      // A rejected invoke means the IPC channel itself died. Without this
      // catch the promise would reject instead of resolving — the one thing
      // this module must never do.
      //
      // A rejection says nothing about the CHILD, though: the manager may
      // still own a live utility process for this run. Kill it explicitly, or
      // it outlives the run it belonged to. Deliberately NOT `abortRun` — this
      // is a failure, not an abort, and must keep the `failed` status rather
      // than becoming `cancelled`.
      if (!run.cancelInvoked) {
        run.cancelInvoked = true;
        void bridge.transcribeCancel?.().catch(() => {
          /* best-effort: the channel that just died may not answer */
        });
      }
      const message = errorMessage(err);
      showFailure(message);
      return fail('failed', message);
    } finally {
      // The 16 kHz mono buffer is IPC-copied by now; up to 460 MB that must
      // not stay alive while the transcript is assembled.
      outgoing = new Float32Array(0);
    }

    // An abort recorded while the invoke was in flight decides the status,
    // even if the manager happened to answer {ok:true} first.
    if (run.abortReason) return fail(statusForAbort(run.abortReason), messageForAbort(run.abortReason));

    if (!result.ok) {
      if (result.cancelled) {
        return fail(statusForAbort(run.abortReason), messageForAbort(run.abortReason));
      }
      const message = result.error ?? 'The transcription host failed.';
      showFailure(message);
      return fail('failed', message);
    }

    // The host counts what it emitted; a mismatch means segment events were
    // dropped or malformed and the transcript would be silently incomplete.
    if (run.segments.length !== result.segmentCount) {
      const message = `The transcription host reported ${result.segmentCount} segment(s) but delivered ${run.segments.length}.`;
      showFailure(message);
      return fail('failed', message);
    }

    // DELIVERY-TIME staleness re-check: never store a transcript whose
    // timestamps describe audio that no longer exists.
    const live = findDoc(run.docId);
    if (!live) return fail('source-closed', messageForAbort('closed'));
    if (!sameChannelRefs(run.channelRefs, live.channels)) return fail('stale', messageForAbort('edited'));

    publishProgress(
      run,
      { phase: 'clustering', done: 0, total: 0, fraction: 1, estimatedRemainingMs: 0 },
      req.onProgress
    );

    const ordered = run.segments.slice().sort((a, b) => a.index - b.index);
    const embeddings = ordered.map((s) => run.embeddings.get(s.index) ?? null);
    const maxUsableSpeakers = maxUsableSpeakerCount(embeddings.filter((e) => e !== null).length);
    // Validated HERE rather than at entry, because the ceiling is not known
    // until the embeddings are in. Same contract as the re-cluster path.
    const validated = validateSpeakerCount(req.speakerCount, maxUsableSpeakers);
    if (!validated.ok) return fail('bad-speaker-count', validated.message);
    const requested = validated.value;
    const assigned = assignSpeakerLabels(embeddings, requested === null ? {} : { speakerCount: requested });

    const transcript: Transcript = {
      docId: run.docId,
      docName,
      sampleRate: run.sampleRate,
      lengthSamples: docLength,
      language: run.language,
      languageProbability: run.languageProbability,
      segments: ordered.map((s, i) => ({
        index: s.index,
        startSample: modelSampleToDoc(s.startSample, run.sampleRate, docLength),
        endSample: modelSampleToDoc(s.endSample, run.sampleRate, docLength),
        text: s.text,
        speaker: assigned.speakers[i],
        avgLogprob: s.avgLogprob,
        noSpeechProb: s.noSpeechProb,
        compressionRatio: s.compressionRatio,
      })),
      speakerCount: assigned.speakerCount,
      requestedSpeakerCount: requested,
      silhouette: assigned.silhouette,
      unembeddedSegments: embeddings.filter((e) => e === null).length,
      maxUsableSpeakers,
      unlabelledSegments: assigned.speakers.filter((s) => s === null).length,
      embeddings,
      channelRefs: live.channels.slice(),
      createdAt: Date.now(),
    };
    transcripts.set(run.docId, transcript);
    return { ok: true, transcript };
  } catch (err) {
    // The always-resolves contract, closed for good: the mono mix and the
    // resample are both multi-hundred-megabyte allocations on a long
    // document, so a `RangeError: Array buffer allocation failed` is a NORMAL
    // failure mode here, not an escape.
    const message = errorMessage(err);
    showFailure(message);
    return fail('failed', message);
  } finally {
    run.settled = true;
    for (const off of unsubscribers) off();
    unsubscribeStore();
    run.segments = [];
    run.embeddings = new Map();
    if (active === run) {
      active = null;
      progressState = null;
    }
    bumpVersion();
  }
}

/**
 * Accumulates one 'transcribe:segment' payload. Validated at this boundary
 * like any other cross-process payload: a malformed segment is DROPPED (the
 * segment-count gate then reports the shortfall) rather than corrupting the
 * transcript or throwing inside an event callback.
 */
function acceptSegment(run: ActiveRun, s: HostSegment): void {
  if (!Number.isInteger(s.index) || s.index < 0) return;
  if (!Number.isInteger(s.startSample) || !Number.isInteger(s.endSample)) return;
  if (s.startSample < 0 || s.endSample > run.modelLength || s.endSample <= s.startSample) return;
  if (typeof s.text !== 'string' || s.text.length === 0) return;
  if (run.segments.some((existing) => existing.index === s.index)) return;
  run.segments.push({
    index: s.index,
    startSample: s.startSample,
    endSample: s.endSample,
    text: s.text,
    avgLogprob: Number.isFinite(s.avgLogprob) ? s.avgLogprob : 0,
    noSpeechProb: Number.isFinite(s.noSpeechProb) ? s.noSpeechProb : 0,
    compressionRatio: Number.isFinite(s.compressionRatio) ? s.compressionRatio : 0,
  });
}

/**
 * Accumulates one 'transcribe:embedding' payload. A non-finite component would
 * poison every distance in the clusterer (NaN propagates through Ward linkage
 * and silhouette alike, and a NaN comparison is silently false), so a vector
 * carrying one is dropped whole — that segment then falls to the
 * unanimous-neighbour rule instead of corrupting everybody else's labels.
 */
function acceptEmbedding(run: ActiveRun, e: { segmentIndex: number; vector: ArrayBuffer }): void {
  if (!Number.isInteger(e.segmentIndex) || e.segmentIndex < 0) return;
  let vector: Float32Array;
  try {
    vector = new Float32Array(e.vector);
  } catch {
    return;
  }
  if (vector.length === 0) return;
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) return;
  }
  run.embeddings.set(e.segmentIndex, vector);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type SubtitleFormatId = 'srt' | 'vtt';

const SUBTITLE_FILTERS: Record<SubtitleFormatId, { name: string; extension: string }> = {
  srt: { name: 'SubRip subtitles', extension: 'srt' },
  vtt: { name: 'WebVTT subtitles', extension: 'vtt' },
};

/**
 * Writes the stored transcript out as SRT or WebVTT through the native save
 * dialog, using `fileService.exportDocument`'s idiom (replace the extension,
 * never append; a cancelled dialog returns null; a write failure raises a
 * native error box rather than throwing).
 *
 * Serialisation is `subtitleFormat.ts`'s — this function adds no formatting of
 * its own, so the exported file and the exporter's tests can never disagree.
 *
 * Returns the written path, or null when cancelled or failed.
 */
export async function exportTranscript(docId: string, format: SubtitleFormatId): Promise<string | null> {
  const bridge = api();
  if (!bridge?.showSaveDialog || !bridge.writeFile) return null;
  const transcript = transcripts.get(docId);
  if (!transcript || transcript.segments.length === 0) return null;

  const { name, extension } = SUBTITLE_FILTERS[format];
  const text =
    format === 'srt'
      ? formatSrt(transcript.segments, transcript.sampleRate)
      : formatWebVtt(transcript.segments, transcript.sampleRate);

  const baseName = transcript.docName.replace(/\.[^.]+$/, '');
  const targetPath = await bridge.showSaveDialog({
    defaultPath: `${baseName}.${extension}`,
    filters: [{ name, extensions: [extension] }],
  });
  if (!targetPath) return null;

  // A fresh buffer: `writeFile` transfers what it is given, and the encoder's
  // output may be a view onto a larger pool.
  const bytes = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);

  const result = await bridge.writeFile(targetPath, buffer);
  if (!result.ok) {
    await bridge.showMessageBox?.({
      type: 'error',
      title: 'Transcript export failed',
      message: result.error,
    });
    return null;
  }
  return targetPath;
}
