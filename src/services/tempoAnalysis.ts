/**
 * THE shared tempo/remix analysis layer (Task T4, v15-architecture.md "Shared
 * analysis layer"). The rule is about the WHOLE-DOCUMENT analysis: every
 * consumer of it (feature 1's BPM readout, feature 2's Change-BPM prefill,
 * feature 3's Auto-Remix) reads through this module — never the worker
 * directly — so the cache, invalidation and worker choreography live in
 * exactly one place.
 *
 * The one deliberate exception is REGION-scoped, uncached analysis:
 * `tempoService.ts`'s `detectRegionTempo` ('Re-detect from selection') calls
 * the pure `analyzeTempo` core synchronously on a centred excerpt of the
 * selection. It bypasses this module BECAUSE it must not write here — caching
 * an arbitrary region's result under the document's id would poison the
 * whole-document analysis features 1 and 3 read (see that function's own
 * comment). So: nothing but this module runs the WORKER, and nothing but a
 * region-scoped, deliberately uncached read calls `analyzeTempo` itself.
 *
 * ## Cache
 *
 * ONE entry per document id, `Map<docId, CacheEntry>`, hit-tested with
 * `sameChannelRefs` copied VERBATIM from `peaksCache.ts:16-22` (this repo's
 * established precedent for identity-based cache validation — a mutator
 * always allocates fresh channel arrays, so reference identity IS the
 * "has this document's audio changed" test) and written with
 * `doc.channels.slice()` (`peaksCache.ts:40`). Bounded to `MAX_ENTRIES = 4` by
 * delete+set re-insertion with oldest-first eviction (`clipWaveformCache.ts:
 * 83-87`) — the bound exists because each entry retains channel REFERENCES
 * (keeping a closed-but-not-invalidated document's audio alive), not because
 * the payload itself (~1.3-1.6 MB) is large.
 *
 * `entry.level` records whether the cached `analysis` was computed at the
 * cheaper 'tempo' pass (onset envelope + beat DP only) or the fuller 'remix'
 * pass (adds the chroma/bar-boundary work — `deriveRemixFeatures`, T9). A
 * document analysed for remix serves the BPM readout for free (no re-run);
 * the reverse costs one extra ~1.5s onset pass, accepted once per document
 * (see `runRemixAnalysis`).
 *
 * ## Mono snapshot
 *
 * `monoSnapshot` allocates ONE Float32Array — clamped to
 * `analysisSampleBudget(doc)`, i.e. the `MAX_ANALYSIS_SECONDS` window the
 * worker itself truncates to plus one sample of `truncated`-detection headroom
 * — and averages channels[0]/[1] into it in a single pass — deliberately NOT
 * `mixDown(cloneRegion(doc, 0,
 * docLength(doc)))`: `cloneRegion` slices every channel first (a redundant
 * ~106 MB allocation on a 5-min stereo doc) before `mixDown` allocates ITS OWN
 * fresh output on top of that. `mixDown(cloneRegion(...))` does typecheck
 * (`cloneRegion` returns `Float32Array[]`) — it is not a type error, merely
 * wasteful — so this hand-rolled single-pass version is a deliberate
 * efficiency choice, not a workaround for a compile problem. Only the fresh
 * buffer this function allocates is ever transferred to the worker;
 * `doc.channels` itself is read but never mutated and never transferred, so
 * the repo-wide "never transfer `doc.channels`" invariant holds. The
 * allocation is wrapped in try/catch at the call site (not inside this pure
 * function) because an OOM throw on a memory-pressured machine is a NORMAL
 * failure path here (resolve null + error box, exactly like a worker
 * failure), not an escape.
 *
 * ## Worker choreography
 *
 * `createTempoWorker()` per run, monotonic id, `worker.terminate()` on EVERY
 * terminal branch, and `worker.onerror` wired — the v1.4 lesson at
 * `effectRunner.ts:106-119`: a worker that fails to even LOAD never reaches
 * `onmessage`, and without `onerror` the promise would hang forever. Every
 * run promise ALWAYS settles (resolving null on failure) and surfaces
 * failures via `window.electronAPI?.showMessageBox({type:'error',
 * title:'Tempo analysis failed', message})`, exactly like
 * `effectRunner.ts:96-103`.
 *
 * Beyond the per-worker id check, `currentRunId` tracks — PER DOCUMENT id,
 * across BOTH levels — which run is the most recently REQUESTED one. A
 * worker's 'done'/'error' reply only writes the cache (or shows an error
 * dialog) when its own id still matches `currentRunId.get(docId)` at arrival
 * time; a reply for a since-superseded run is dropped from the CACHE side
 * (it must not clobber a newer run's result) but its own promise still
 * settles, reading whatever is currently true for the document. This is the
 * scenario `msg.id !== current` in the brief refers to: two DIFFERENT levels
 * requested for the same document overlap in flight (same-level, same-doc
 * calls are already deduped below one worker), and the earlier one's belated
 * reply must not win.
 *
 * `channelRefs` are snapshotted at RUN START (before the worker is even
 * created), so a result landing after a concurrent edit is stored already
 * stale the moment it's cached — `getTempo`/`getRemixAnalysis` compute
 * staleness against the LIVE document at read time, never at write time. That
 * observation happens in exactly one place, `isEntryFresh`, which also
 * RELEASES the row's `channelRefs` the first time it sees a mismatch (and so
 * makes staleness sticky for that row) — see its comment.
 *
 * A document CLOSED mid-run is the other race this guards: the 'done'/'error'
 * handler re-reads the store for `docId` and skips the cache write entirely
 * when the document is no longer open, so a belated result cannot resurrect a
 * cache row that would otherwise pin the closed document's channel arrays for
 * the rest of the session (exactly the leak class `invalidateTempo`/
 * `invalidateRemix` guard against on an explicit close).
 *
 * ## Level policy (the one accepted inefficiency — v15-architecture.md)
 *
 * `runTempoAnalysis` is a no-op (returns the cached entry) when a FRESH
 * level:'remix' entry already exists — a remix-level analysis is a strict
 * superset. `runRemixAnalysis` always re-requests level:'remix', including a
 * fresh re-run of the onset pass when the cached entry is only level:'tempo'
 * — rejected alternative: ship the cached `bands` back down to the worker to
 * skip the onset FFT (saves ~1.5s once, costs a 1.24 MB copy/detach and a
 * second protocol path through the worker) — not worth it for a once-per-
 * document cost behind an existing progress bar.
 *
 * ## T2 carry-forward (octave correction) — Plan Ruling 4 (2026-07-26, post-T4-review)
 *
 * The brief's binding carry-forward — an x2//2 octave-correction control must
 * re-run `trackBeats` at the corrected period, never just relabel the
 * displayed BPM — was originally closed here with an assertion the T4 review
 * proved FALSE: `TempoAnalysis` did not retain `odf`/`periodFrames`, and no
 * `deriveGrid` function existed anywhere in the repo, so the correction
 * control would have been forced into exactly the relabel the carry-forward
 * forbids. Fixed by Plan Ruling 4 as a cross-task amendment: `analyzeTempo`
 * (`tempoCore.ts`) now additionally returns `odf`/`periodFrames`/
 * `decimationFactor`; the worker transfers them in its `done` payload and
 * this module's cache retains them (they are ordinary fields on the SAME
 * retained `analysis` object, so no cache-shape change was needed once
 * `TempoAnalysis` itself carried them); `tempo.worker.ts` gained a
 * `level:'regrid'` message that runs ONLY `tempoCore.ts`'s `deriveGrid`
 * (`trackBeats` + the two-stage sample-domain refinement — no decimation, no
 * FFT, no ACF, no octave search); and this module exposes `regridTempo`
 * below, which consumers (the eventual octave-correction control) MUST call
 * for x2//2 — relabelling remains forbidden.
 *
 * ## Reactivity
 *
 * A version counter + subscribe/getSnapshot/`useTempoVersion` trio, copied in
 * shape from `noiseProfile.ts:31-49,87-95` — module state behind
 * `useSyncExternalStore`, NOT zustand (matches `spectralScale.ts`,
 * `noiseProfile.ts`, `undoHistory.useHistoryVersion`). Bumped on run start, on
 * each (already 50ms worker-side-throttled) progress message, on completion
 * (success OR failure), and on invalidation.
 *
 * **`useTempoVersion()` does NOT bump on an audio edit** (I2, T4 review fix
 * round 1) — measured: version stays unchanged across an `applyEdit`, and
 * `getTempo(doc)` returns the SAME object reference with only `.stale`
 * flipped in place. This is a deliberate choice, not an oversight: this
 * module has no subscription to `useAppStore` (adding one would mean
 * watching every open document's channel identity on every store change, a
 * cost this cache-only module shouldn't own), and every real consumer this
 * release ships (T5's PropertiesPanel/StatusBar) already reads `doc` from a
 * LIVE `useAppStore` subscription for the document's other fields (name,
 * dirty, ...), which itself re-renders on every edit — so the component
 * re-runs `getTempo(doc)` with the fresh `doc` object on its OWN store-driven
 * re-render, and `.stale` recomputes correctly at that point.
 * `useTempoVersion()`'s job is narrower: catching the events that DON'T
 * naturally correlate with a `useAppStore` change (run start/progress/
 * completion, invalidation). A FUTURE consumer that captures a `doc`
 * reference once and relies SOLELY on `useTempoVersion()` (never re-reading
 * `doc` from a live store subscription) would miss a staleness flip until
 * some other event bumps the version — this is the sharp edge to know about
 * if a future task adds such a consumer.
 */

import { useSyncExternalStore } from 'react';
import type { AudioDocument } from '../audio/AudioDocument';
import { useAppStore } from '../stores/appStore';
import { createTempoWorker } from '../workers/createTempoWorker';
import { MIN_BPM, MAX_BPM, MAX_ANALYSIS_SECONDS } from '../dsp/tempoCore';
import type { TempoAnalysis } from '../dsp/tempoCore';
import type { RemixAnalysis as RemixFeaturesAnalysis } from '../dsp/remixFeatures';

/**
 * T9 (`src/dsp/remixFeatures.ts`) landed and widened this with chroma / bar
 * boundaries / per-boundary descriptors / clusters (fix round 1: `tempo.
 * worker.ts`'s `deriveRemixFeatures` now genuinely implements `level:'remix'`
 * requests instead of throwing 'not implemented', so a real `RemixAnalysis`
 * value now flows through this module, not just the type declaration). Was a
 * type ALIAS to `TempoAnalysis` (not an empty interface) specifically so this
 * swap could happen without any OTHER change to this module — this is that
 * swap; every other line in this file that reads/writes a `RemixAnalysis`
 * value already only relied on it being a `TempoAnalysis`-compatible shape.
 */
export type RemixAnalysis = RemixFeaturesAnalysis;

/** `TempoAnalysis` plus the REQUIRED staleness flag — required, not
 * optional, so a consumer cannot read `beatSamples` while accidentally
 * skipping the one check that keeps it meaningful. */
export interface TempoEntry extends TempoAnalysis {
  stale: boolean;
}

export interface RemixAnalysisParams {
  minBpm?: number;
  maxBpm?: number;
  beatsPerBar?: number;
  downbeatShiftBeats?: number;
}

interface CacheEntry {
  /** The channel arrays this row was analysed against, or `null` once the row
   * has been OBSERVED stale — see `isEntryFresh`. Nulling them is the whole
   * point of that observation: a row kept only for its (still-displayable, now
   * out-of-date) BPM must not go on pinning ~105 MB of PRE-EDIT audio for the
   * rest of the session. */
  channelRefs: Float32Array[] | null;
  /** Sticky: set the first time `isEntryFresh` sees an identity mismatch, and
   * never cleared (the row is replaced wholesale by the next `writeCache`).
   * It has to be sticky because `channelRefs` is dropped at the same moment —
   * with nothing left to compare against, "fresh" is no longer decidable, and
   * the only safe answer is the one that never serves a grid for audio it may
   * not match. */
  stale: boolean;
  sampleRate: number;
  level: 'tempo' | 'remix';
  analysis: TempoAnalysis | RemixAnalysis;
  /** Long-lived `TempoEntry` view over `analysis`, created once when the row
   * is cached. `getTempo` mutates `.stale` on THIS SAME object and returns it
   * by reference every call — never reallocates — so a caller holding a
   * reference across a metadata-only document replacement (rename, dirty
   * flip, marker add) sees reference equality (acceptance b). NOTE (T4
   * review, minor): `tempoEntry` is a SHALLOW spread of `analysis` (`{
   * ...analysis, stale: false }`), so `tempoEntry.beatSamples`/`.odf` and
   * `entry.analysis.beatSamples`/`.odf` are the SAME underlying typed
   * arrays, not independent copies — `getTempo` and `getRemixAnalysis`
   * therefore hand out two different wrapper objects that share the same
   * typed-array data. Harmless today (neither this module nor any known
   * consumer mutates a returned `beatSamples`/`odf` in place — every
   * mutator in `AudioDocument.ts` and `tempoCore.ts` allocates fresh
   * arrays), but a future consumer must not assume the two are
   * independently safe to mutate. */
  tempoEntry: TempoEntry;
}

const MAX_ENTRIES = 4;
const DEFAULT_BEATS_PER_BAR = 4;
const DEFAULT_DOWNBEAT_SHIFT_BEATS = 0;

const cache = new Map<string, CacheEntry>();

/** Copied VERBATIM from `peaksCache.ts:16-22` — the established precedent for
 * identity-based cache validation in this codebase. */
function sameChannelRefs(a: Float32Array[], b: Float32Array[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * THE single staleness-observation point for a cache row — every reader
 * (`getTempo`, `getRemixAnalysis`, `runTempoAnalysis`'s superset short-circuit)
 * goes through it, and it is the only place `entry.stale`/`entry.channelRefs`
 * are written outside `writeCache`.
 *
 * The first time the live document's channel identities no longer match, the
 * row's `channelRefs` are RELEASED. Before this, a document that was analysed
 * and then edited left the row holding the PRE-EDIT `Float32Array`s forever —
 * ~105 MB per analysed-then-edited 5-minute stereo document, up to
 * `MAX_ENTRIES` of them — because staleness was flagged in place and the row
 * was never dropped. Worse, those are exactly the arrays `undoHistory`'s
 * `MAX_UNDO_BYTES` eviction assumes it frees when it shifts an entry out, so
 * the undo budget silently under-reported the process's real footprint for as
 * long as a stale row was armed.
 *
 * The row itself deliberately SURVIVES (rather than being deleted): `getTempo`
 * must keep returning the same `TempoEntry` reference with only `.stale`
 * flipped, so an edit marks the BPM readout out of date instead of blanking
 * it. The trade is that staleness is now one-way for a given row — an edit
 * followed by an undo no longer silently un-stales the readout, it needs a
 * re-analysis (which `writeCache` then serves from a fresh row). That is the
 * conservative direction: this module's hard rule is that a grid is never
 * served for audio it might not match.
 */
function isEntryFresh(entry: CacheEntry, doc: AudioDocument): boolean {
  if (entry.stale) return false;
  if (entry.channelRefs && sameChannelRefs(entry.channelRefs, doc.channels)) return true;
  entry.stale = true;
  entry.channelRefs = null;
  return false;
}

/**
 * The number of samples `monoSnapshot` actually needs to hand the worker.
 *
 * `analyzeTempo` (`tempoCore.ts:1251`) and `deriveGrid` (`:1385`) BOTH open by
 * truncating their input to `maxSamples = round(MAX_ANALYSIS_SECONDS *
 * sampleRate)` and reading only `mono.subarray(0, analyzedEndSample)` from
 * there on — `mono` is otherwise touched only for its `.length`. So every
 * sample past that bound was being allocated, averaged, structured-transferred
 * and then dropped unread: a 2-hour stereo document paid ~1.27 GB of transient
 * allocation for the ~105 MB the worker can actually use, and every x2//2
 * regrid (a ~50 ms operation) re-paid it.
 *
 * The bound is `maxSamples + 1`, NOT `maxSamples`, and the extra sample is
 * load-bearing: `truncated` is computed as `mono.length > maxSamples`, so
 * clamping to exactly `maxSamples` would silently flip `truncated` from true
 * to false on every over-long document and lose the "analysis limited to the
 * first 10 minutes" signal. With one sample of headroom the worker sees the
 * same `truncated`, the same `analyzedEndSample` and the same `analyzed`
 * subarray it saw before, so its output is byte-identical (asserted in
 * `tempoAnalysis.test.ts`).
 */
function analysisSampleBudget(doc: AudioDocument): number {
  const full = doc.channels[0]?.length ?? 0;
  const maxSamples = Math.round(MAX_ANALYSIS_SECONDS * doc.sampleRate);
  return full > maxSamples ? maxSamples + 1 : full;
}

/** Averages `doc.channels[0]`/`[1]` into ONE freshly-allocated Float32Array in
 * a single pass, over at most `analysisSampleBudget(doc)` samples. See the
 * module doc comment for why this is not `mixDown(cloneRegion(...))`, and
 * `analysisSampleBudget` for why the length is clamped. Never mutates
 * `doc.channels`. */
function monoSnapshot(doc: AudioDocument): Float32Array {
  const channels = doc.channels;
  const length = analysisSampleBudget(doc);
  const out = new Float32Array(length);
  if (channels.length <= 1) {
    const src = channels[0];
    if (src) out.set(src.subarray(0, length));
    return out;
  }
  const left = channels[0];
  const right = channels[1];
  for (let i = 0; i < length; i++) out[i] = (left[i] + right[i]) / 2;
  return out;
}

function makeTempoEntry(analysis: TempoAnalysis | RemixAnalysis): TempoEntry {
  return { ...analysis, stale: false };
}

/** Writes/overwrites the cache row for `docId`, moving it to the
 * most-recently-used position (delete+set re-insertion — `clipWaveformCache.
 * ts:83-87`) and evicting the oldest row past `MAX_ENTRIES`. Does NOT bump the
 * version counter itself — callers bump once per logical event (run
 * completion), not once per cache mutation. */
function writeCache(
  docId: string,
  channelRefs: Float32Array[],
  sampleRate: number,
  level: 'tempo' | 'remix',
  analysis: TempoAnalysis | RemixAnalysis
): void {
  cache.delete(docId);
  cache.set(docId, {
    channelRefs,
    stale: false,
    sampleRate,
    level,
    analysis,
    tempoEntry: makeTempoEntry(analysis),
  });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Cached read ONLY — never starts work. Returns the entry with a REQUIRED,
 * freshly-recomputed `stale` flag (an edit marks the BPM out of date; it does
 * not blank the readout) rather than dropping it. Returns the SAME object
 * reference across calls for the same live cache row (acceptance b). */
export function getTempo(doc: AudioDocument): TempoEntry | null {
  const entry = cache.get(doc.id);
  if (!entry) return null;
  entry.tempoEntry.stale = !isEntryFresh(entry, doc);
  return entry.tempoEntry;
}

/** Null unless the cached entry is level:'remix' AND fresh — HARD rule, not
 * advisory. Planning a remix against a grid that no longer matches the audio
 * is the one failure mode in this release that produces silently wrong
 * output rather than a visible error, so this never returns a stale or
 * tempo-only entry under any circumstance. */
export function getRemixAnalysis(doc: AudioDocument): RemixAnalysis | null {
  const entry = cache.get(doc.id);
  if (!entry || entry.level !== 'remix') return null;
  if (!isEntryFresh(entry, doc)) return null;
  return entry.analysis as RemixAnalysis;
}

/**
 * Publishes an already-derived level:'remix' analysis for `doc` — the
 * write-back half of the remix-level regrid this module's Plan-Ruling-4
 * section and `remixFeatures.ts`'s `numBands <= 0` comment both anticipate,
 * and the ONLY sanctioned way for a consumer to hand a user-corrected grid
 * back to the shared cache (T14's Auto-Remix dialog).
 *
 * Why it has to exist: `regridTempo` writes `deriveGrid`'s output through the
 * SAME cache row while PRESERVING `level:'remix'`, but `deriveGrid` has no
 * band/chroma data, so after an octave correction the row satisfies
 * `getRemixAnalysis`'s level+freshness test while carrying NO `barBoundary`/
 * `cluster`/`numBars` — a shape every remix consumer would read as a valid
 * analysis. The corrector re-runs `deriveRemixFeatures` against the retained
 * `bands`/`odfLow`/`chroma` (milliseconds) and calls this to REPAIR the row.
 * The same path carries a time-signature or downbeat override, which changes
 * nothing about the audio and so must never cost a re-analysis.
 *
 * `channelRefs` are snapshotted from the LIVE `doc` here, exactly like a
 * worker run's write, so `getRemixAnalysis`'s identity-based staleness test
 * keeps working unchanged — a corrected analysis published against audio that
 * has since been edited is rejected at read time like any other stale row.
 * Bumps the version (this is a cache-content change consumers must see).
 */
export function setRemixAnalysis(doc: AudioDocument, analysis: RemixAnalysis): void {
  writeCache(doc.id, doc.channels.slice(), doc.sampleRate, 'remix', analysis);
  bumpVersion();
}

// ---------------------------------------------------------------------------
// Reactivity — version counter + subscribe/getSnapshot/useTempoVersion, copied
// in shape from noiseProfile.ts:31-49,87-95. NOT zustand.
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

/** Monotonic counter bumped on run start, progress, completion and
 * invalidation; non-reactive read. */
export function getTempoVersion(): number {
  return version;
}

/** Re-renders the caller whenever tempo/remix analysis state changes. */
export function useTempoVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

const progress = new Map<string, number>();
const currentRunId = new Map<string, number>();
const inFlightTempo = new Map<string, Promise<TempoEntry | null>>();
const inFlightRemix = new Map<string, Promise<RemixAnalysis | null>>();
const inFlightRegrid = new Map<string, Promise<TempoEntry | null>>();

/** Drops the cached entry for `docId` (any level) and its progress/run-id
 * bookkeeping, then bumps the version. MANDATORY in `closeDocumentFlow` —
 * without it a closed document's channel arrays stay retained by
 * `channelRefs` for the rest of the session (the exact hazard `peaksCache`/
 * `clipWaveformCache` already manage). */
export function invalidateTempo(docId: string): void {
  progress.delete(docId);
  currentRunId.delete(docId);
  const had = cache.delete(docId);
  if (had) bumpVersion();
}

/** Drops the cached entry for `docId` only when it is currently level:
 * 'remix', leaving a level:'tempo' entry (if any) untouched. `invalidateTempo`
 * already unconditionally clears the whole row (any level) — this narrower
 * sibling exists for the remix-only invalidation a future remix SESSION
 * (`remixService.ts`, not yet built) needs on ITS OWN close, independent of
 * whether the tempo readout should also reset (v15-architecture.md's
 * Invalidation section: "`invalidateRemix(docId)` alongside it for BOTH the
 * remix document and its source"). Called unconditionally alongside
 * `invalidateTempo` in `closeDocumentFlow` per the task's flagged risk #1.
 *
 * DELIBERATELY does NOT touch `progress`/`currentRunId` (T4 review, minor —
 * asymmetric with `invalidateTempo` on purpose, not an oversight): those two
 * maps track an IN-FLIGHT RUN for `docId`, not cache content, and this
 * function's whole contract is "narrower than invalidateTempo" — a
 * level:'tempo' row (and any run legitimately still updating it) must
 * survive a call that only means "drop the remix-specific data". Clearing
 * run bookkeeping here could wipe state for an unrelated, still-valid
 * in-flight tempo/remix run for the same document. */
export function invalidateRemix(docId: string): void {
  const entry = cache.get(docId);
  if (entry && entry.level === 'remix') {
    cache.delete(docId);
    bumpVersion();
  }
}

/** Empties the whole cache and all run bookkeeping — test isolation only. */
export function clearAllTempo(): void {
  cache.clear();
  progress.clear();
  currentRunId.clear();
  inFlightTempo.clear();
  inFlightRemix.clear();
  inFlightRegrid.clear();
  bumpVersion();
}

/** Empties only level:'remix' rows — test isolation only, paired with
 * `invalidateRemix` per v15-architecture.md's Invalidation section. */
export function clearAllRemix(): void {
  for (const [docId, entry] of cache) {
    if (entry.level === 'remix') cache.delete(docId);
  }
  bumpVersion();
}

// ---------------------------------------------------------------------------
// Run bookkeeping
// ---------------------------------------------------------------------------

/** True while ANY analysis (tempo, remix, or regrid) is in flight for `docId`. */
export function isTempoRunning(docId: string): boolean {
  return inFlightTempo.has(docId) || inFlightRemix.has(docId) || inFlightRegrid.has(docId);
}

/** The most recent progress fraction reported for `docId`'s in-flight run, or
 * `null` when nothing is running. */
export function getTempoProgress(docId: string): number | null {
  return progress.has(docId) ? (progress.get(docId) as number) : null;
}

let nextRunId = 1;

type RunLevel = 'tempo' | 'remix' | 'regrid';

type WorkerReply =
  | { type: 'progress'; id: number; fraction: number }
  | { type: 'done'; id: number; level: RunLevel; analysis: TempoAnalysis | RemixAnalysis }
  | { type: 'error'; id: number; message: string };

function showFailure(message: string): void {
  void window.electronAPI?.showMessageBox({
    type: 'error',
    title: 'Tempo analysis failed',
    message,
  });
}

/** Only present when `level === 'regrid'`: the retained onset envelope from
 * a prior analysis, and the caller-corrected period to re-track it at. */
interface RegridInput {
  odf: Float32Array;
  periodFrames: number;
}

/** Only present when `level === 'regrid'`: the four fields `deriveGrid`
 * cannot compute (it never touches the ACF/candidates) and `truncated`/
 * `analyzedEndSample`, carried over from the entry being corrected and
 * merged into the worker's raw result before it is cached. See
 * `regridTempo`'s doc comment for why this carry-over is correct. */
interface RegridCarry {
  confidence: number;
  peakRatio: number;
  truncated: boolean;
  analyzedEndSample: number;
}

/**
 * Shared worker choreography for `runTempoAnalysis`, `runRemixAnalysis` and
 * `regridTempo`. Returns the PUBLIC, doc-shaped result for `level`
 * (`TempoEntry | null` for 'tempo'/'regrid', `RemixAnalysis | null` for
 * 'remix') — read fresh off the cache via `getTempo`/`getRemixAnalysis`
 * against the LIVE document, never the raw worker payload — so a superseded
 * or doc-closed-mid-run outcome resolves to whatever is currently true
 * rather than to a value that may already be wrong by the time the caller
 * sees it.
 *
 * I1 (T4 review fix round 1): `createTempoWorker()` and `worker.postMessage`
 * are BOTH wrapped in their own try/catch. A throw from `createTempoWorker()`
 * would otherwise propagate synchronously out of this function (never
 * returning a promise at all — breaking "the promise always resolves" for
 * every caller), and a throw from `postMessage` inside the executor would
 * otherwise silently REJECT the returned promise instead of resolving null
 * (a `new Promise` executor's throw is caught by the Promise machinery, not
 * by a `try` wrapped around the `new Promise(...)` call itself — that
 * pattern would never fire). Both paths now route through the same
 * `abortSetup` cleanup as every other failure: clear `progress`/
 * `currentRunId` for this run, bump the version, show the same error dialog,
 * and resolve null.
 */
function startRun(
  doc: AudioDocument,
  level: RunLevel,
  params: RemixAnalysisParams | undefined,
  onProgress: ((fraction: number) => void) | undefined,
  regridInput?: RegridInput,
  regridCarry?: RegridCarry
): Promise<TempoEntry | RemixAnalysis | null> {
  const docId = doc.id;

  let mono: Float32Array;
  try {
    mono = monoSnapshot(doc);
  } catch (err) {
    showFailure(err instanceof Error ? err.message : String(err));
    return Promise.resolve(null);
  }

  const channelRefs = doc.channels.slice();
  const sampleRate = doc.sampleRate;
  const runId = nextRunId++;
  currentRunId.set(docId, runId);
  progress.set(docId, 0);
  bumpVersion();

  function abortSetup(err: unknown): null {
    progress.delete(docId);
    if (currentRunId.get(docId) === runId) currentRunId.delete(docId);
    bumpVersion();
    showFailure(err instanceof Error ? err.message : String(err));
    return null;
  }

  let worker: Worker;
  try {
    worker = createTempoWorker();
  } catch (err) {
    return Promise.resolve(abortSetup(err));
  }

  function readLive(): TempoEntry | RemixAnalysis | null {
    const liveDoc = useAppStore.getState().documents.find((d) => d.id === docId);
    if (!liveDoc) return null;
    return level === 'remix' ? getRemixAnalysis(liveDoc) : getTempo(liveDoc);
  }

  let resolveRun!: (result: TempoEntry | RemixAnalysis | null) => void;
  const runPromise = new Promise<TempoEntry | RemixAnalysis | null>((resolve) => {
    resolveRun = resolve;
  });

  // N1 (T4 review fix round 2): set when a 'regrid' request yields a
  // degenerate result (bpm:null or <2 beats — e.g. an out-of-range/zero/
  // negative/NaN `periodFrames`). `settle()` then resolves null explicitly
  // rather than falling through to `readLive()`, which would otherwise
  // silently return the OLD (untouched, still-good) cache entry — easy to
  // misread as "the correction succeeded and this is the result."
  let degenerateRegrid = false;

  function settle(): void {
    progress.delete(docId);
    bumpVersion();
    resolveRun(degenerateRegrid ? null : readLive());
  }

  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data as WorkerReply;
    const isCurrent = msg.id === currentRunId.get(docId);

    if (msg.type === 'progress') {
      if (!isCurrent) return;
      progress.set(docId, msg.fraction);
      bumpVersion();
      onProgress?.(msg.fraction);
      return;
    }

    worker.terminate();
    if (msg.type === 'done') {
      if (isCurrent) {
        // N1: a degenerate regrid must not overwrite a good cache row, and
        // must never carry confidence/peakRatio onto an empty result (that
        // reads as "full confidence in a null BPM with zero beats" — the
        // exact silent-wrong-output class the staleness gate exists to
        // prevent). Skip the cache write entirely; settle() resolves null.
        const isDegenerateRegrid =
          level === 'regrid' && (msg.analysis.bpm === null || msg.analysis.beatSamples.length < 2);
        if (isDegenerateRegrid) {
          degenerateRegrid = true;
        } else {
          const liveDoc = useAppStore.getState().documents.find((d) => d.id === docId);
          if (liveDoc) {
            // A 'regrid' write must not force the cache row's level back to
            // 'tempo' — it only replaces the numeric grid, so a level:'remix'
            // row being corrected stays level:'remix' (Plan Ruling 4).
            const cacheLevel = level === 'regrid' ? (cache.get(docId)?.level ?? 'tempo') : level;
            // `deriveGrid` (the 'regrid' worker path) has no ACF/candidate
            // data, so confidence/peakRatio/truncated/analyzedEndSample are
            // merged in from the entry being corrected BEFORE writing —
            // `regridTempo`'s doc comment explains why this carry-over is
            // correct rather than a fabricated/zeroed value reaching the cache.
            const analysis = regridCarry ? { ...msg.analysis, ...regridCarry } : msg.analysis;
            writeCache(docId, channelRefs, sampleRate, cacheLevel, analysis);
          }
        }
      }
    } else if (msg.type === 'error') {
      if (isCurrent) showFailure(msg.message);
    } else {
      // Defensive (Minor 3, T4 review): an unexpected/corrupted reply shape
      // must not surface a dialog with `message: undefined` by falling
      // through to the 'error' branch above with no `message` field.
      if (isCurrent) showFailure(`Unexpected worker reply: ${String((msg as { type?: unknown }).type)}`);
    }
    settle();
  };

  worker.onerror = (ev: ErrorEvent) => {
    worker.terminate();
    if (runId === currentRunId.get(docId)) {
      showFailure(ev.message || 'Tempo worker failed to load');
    }
    settle();
  };

  try {
    const transfer = [mono.buffer as ArrayBuffer];
    worker.postMessage(
      {
        type: 'analyze',
        id: runId,
        level,
        mono,
        sampleRate,
        minBpm: params?.minBpm ?? MIN_BPM,
        maxBpm: params?.maxBpm ?? MAX_BPM,
        beatsPerBar: params?.beatsPerBar ?? DEFAULT_BEATS_PER_BAR,
        downbeatShiftBeats: params?.downbeatShiftBeats ?? DEFAULT_DOWNBEAT_SHIFT_BEATS,
        odf: regridInput?.odf,
        periodFrames: regridInput?.periodFrames,
      },
      transfer
    );
  } catch (err) {
    try {
      worker.terminate();
    } catch {
      /* best-effort — the worker never successfully posted, nothing more to clean up */
    }
    resolveRun(abortSetup(err));
  }

  return runPromise;
}

/**
 * Requests level:'tempo' analysis unless a FRESH level:'remix' entry already
 * exists (a remix-level analysis is a strict superset, so this is a no-op
 * returning the cached entry). A second concurrent call for the same
 * document shares the SAME in-flight promise (one worker, not two).
 */
export function runTempoAnalysis(doc: AudioDocument): Promise<TempoEntry | null> {
  const docId = doc.id;

  const existing = cache.get(docId);
  if (existing && existing.level === 'remix' && isEntryFresh(existing, doc)) {
    return Promise.resolve(getTempo(doc));
  }

  const running = inFlightTempo.get(docId);
  if (running) return running;

  const promise = (startRun(doc, 'tempo', undefined, undefined) as Promise<TempoEntry | null>).finally(() => {
    // C1 (T4 review fix round 1): the LAST version bump for this run must
    // land AFTER the dedupe entry is cleared, or `isTempoRunning(docId)`
    // reports `true` forever to any `useTempoVersion()`-gated consumer (the
    // bump inside `startRun`'s `settle()` fires while this entry is still in
    // the map, and nothing bumped again afterward). Minor 2: only delete
    // when the map still points at THIS promise — otherwise a delayed
    // `.finally` from a run already superseded by `clearAllTempo()` (or, in
    // principle, a fresh run for the same doc) could delete a NEWER run's
    // dedupe entry out from under it.
    if (inFlightTempo.get(docId) === promise) inFlightTempo.delete(docId);
    bumpVersion();
  });
  inFlightTempo.set(docId, promise);
  return promise;
}

/**
 * Requests level:'remix' analysis — a no-op returning the cached entry when a
 * FRESH level:'remix' entry already exists, otherwise re-running the onset
 * pass even if a level:'tempo' entry is cached (see the module doc comment's
 * "Level policy"). A second concurrent call for the same document shares the
 * SAME in-flight promise.
 */
export function runRemixAnalysis(
  doc: AudioDocument,
  params?: RemixAnalysisParams,
  onProgress?: (fraction: number) => void
): Promise<RemixAnalysis | null> {
  const docId = doc.id;

  const fresh = getRemixAnalysis(doc);
  if (fresh) return Promise.resolve(fresh);

  const running = inFlightRemix.get(docId);
  if (running) return running;

  const promise = (startRun(doc, 'remix', params, onProgress) as Promise<RemixAnalysis | null>).finally(() => {
    // See runTempoAnalysis's matching comment (C1 + Minor 2).
    if (inFlightRemix.get(docId) === promise) inFlightRemix.delete(docId);
    bumpVersion();
  });
  inFlightRemix.set(docId, promise);
  return promise;
}

/**
 * Re-tracks the beat grid at `newPeriodFrames` (ODF frames) without a full
 * re-analysis — Plan Ruling 4 (2026-07-26): the x2/(divide)2 octave-
 * correction control MUST call this, never just relabel the displayed BPM,
 * because `beatSamples` at a half-tempo detection physically contains only
 * every other beat and the remix planner splices on those positions.
 *
 * Requires a FRESH cached entry (any level) to already exist for `docId` —
 * there is nothing to correct otherwise, so this refuses (resolves null) on a
 * missing or stale entry, matching the hard-rule spirit of
 * `getRemixAnalysis`. Re-snapshots the mono mixdown from the LIVE document
 * and dispatches a `level:'regrid'` worker request carrying the RETAINED
 * `odf` and `newPeriodFrames` — no decimation, no FFT, no ACF, no octave
 * search (~50 ms against a ~3 s full analysis). `confidence`/`peakRatio`/
 * `truncated`/`analyzedEndSample` are carried over from the entry being
 * corrected (see `tempoCore.ts`'s `deriveGrid` doc comment for why: a period
 * correction doesn't change whether the content has real periodic structure
 * or how the winning octave competed against alternatives, only which family
 * member is displayed/spliced on) — done in `startRun`'s `'done'` handler by
 * merging those four fields from the row's PRE-write state before
 * `writeCache` runs.
 *
 * **Valid domain of `newPeriodFrames`** (N1, T4 review fix round 2): a
 * finite, positive number of ODF frames — typically the entry's own
 * `periodFrames` halved/doubled for a x2/(divide)2 correction, or computed
 * from a user-provided BPM or time-signature override.
 *
 * NOT downbeat overrides. A downbeat shift changes the PHASE of the bar
 * grid, not the beat PERIOD, and neither this function nor `deriveGrid`
 * takes a phase parameter (`regridTempo` deliberately passes
 * `params: undefined`, so `downbeatShiftBeats` is never forwarded here).
 * Re-tracking at an unchanged period would return the identical grid.
 * Downbeat selection belongs to bar derivation in the remix feature, which
 * chooses which tracked beat starts bar 1 — it is a consumer of
 * `beatSamples`, not a reason to recompute it. See Plan Ruling 4.
 *
 * This function
 * does NOT validate that the value is a SENSIBLE period for the content
 * (e.g. wildly out of the 60-200 BPM range `odf`'s length implies) —
 * `0`/negative/`NaN`/`Infinity` are rejected up front (resolve null, no
 * worker round-trip), but an otherwise well-formed, merely out-of-range
 * value is only caught AFTER `deriveGrid` runs: when the result is
 * degenerate (`bpm === null` or fewer than 2 beats), the existing cache row
 * is left COMPLETELY untouched and this resolves null — it never overwrites
 * a good row with an empty one, and never carries `confidence`/`peakRatio`
 * onto a result that doesn't deserve them.
 */
export function regridTempo(docId: string, newPeriodFrames: number): Promise<TempoEntry | null> {
  if (!(newPeriodFrames > 0) || !Number.isFinite(newPeriodFrames)) return Promise.resolve(null);

  const liveDoc = useAppStore.getState().documents.find((d) => d.id === docId);
  if (!liveDoc) return Promise.resolve(null);

  // Reuses getTempo's own identity-based staleness check rather than
  // re-implementing it against the raw cache row — also gives us
  // confidence/peakRatio/truncated/analyzedEndSample/odf directly off the
  // returned TempoEntry, since it is a superset view of the same analysis.
  const currentEntry = getTempo(liveDoc);
  if (!currentEntry || currentEntry.stale) return Promise.resolve(null);

  const running = inFlightRegrid.get(docId);
  if (running) return running;

  const carry: RegridCarry = {
    confidence: currentEntry.confidence,
    peakRatio: currentEntry.peakRatio,
    truncated: currentEntry.truncated,
    analyzedEndSample: currentEntry.analyzedEndSample,
  };

  const promise = (
    startRun(
      liveDoc,
      'regrid',
      undefined,
      undefined,
      { odf: currentEntry.odf, periodFrames: newPeriodFrames },
      carry
    ) as Promise<TempoEntry | null>
  ).finally(() => {
    if (inFlightRegrid.get(docId) === promise) inFlightRegrid.delete(docId);
    bumpVersion();
  });
  inFlightRegrid.set(docId, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Test-only hooks
// ---------------------------------------------------------------------------

/**
 * Test-only: promotes the CURRENT cache row for `docId` (if any) to
 * `level:'remix'` in place, without running the worker. T9 has landed —
 * `tempo.worker.ts` imports and calls the real `deriveRemixFeatures`, so a
 * genuine level:'remix' row IS producible end-to-end through
 * `runRemixAnalysis` — but producing one costs the full chroma/bar pass in a
 * worker. This hook exists so `getRemixAnalysis`'s hard rule
 * (`level !== 'remix' || stale` -> null) can be exercised on BOTH arms from a
 * plain tempo-level fixture, at no analysis cost. It does not fabricate
 * analysis content: it relabels a real, already-cached row, so what it
 * produces is a `TempoAnalysis` wearing a remix label — enough for the
 * level/staleness rule under test, and not a substitute for a real
 * `RemixAnalysis` in tests that read chroma or bar boundaries.
 */
export function _promoteToRemixLevelForTest(docId: string): void {
  const entry = cache.get(docId);
  if (entry) entry.level = 'remix';
}

/**
 * Test-only: the cache row's retained `channelRefs` for `docId` — `null` once
 * `isEntryFresh` has observed the row stale and released them, `undefined`
 * when there is no row at all. The retention itself is the thing under test
 * (a stale row must not go on pinning the pre-edit audio), and it is
 * deliberately invisible through the public surface, so there is nothing else
 * to assert against.
 */
export function _getCachedChannelRefsForTest(docId: string): Float32Array[] | null | undefined {
  return cache.get(docId)?.channelRefs;
}
