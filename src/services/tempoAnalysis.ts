/**
 * THE shared tempo/remix analysis layer (Task T4, v15-architecture.md "Shared
 * analysis layer"). Every consumer (feature 1's BPM readout, feature 2's
 * Change-BPM prefill, feature 3's Auto-Remix) reads through this module —
 * never the worker or `analyzeTempo` directly — so the cache, invalidation
 * and worker choreography live in exactly one place.
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
 * `monoSnapshot` allocates ONE Float32Array and averages channels[0]/[1] into
 * it in a single pass — deliberately NOT `mixDown(cloneRegion(doc, 0,
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
 * staleness against the LIVE document at read time, never at write time.
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
 * ## T2 carry-forward (octave correction)
 *
 * The brief's binding carry-forward — an x2//2 octave-correction control must
 * re-run `trackBeats` at the corrected period, never just relabel the
 * displayed BPM — concerns a UI control this task does not build (it lands
 * with whichever later task adds the correction control, consuming the
 * retained `bands` off a level:'remix' `RemixAnalysis` to re-run
 * `deriveGrid`). Nothing in this module forecloses that: the cache retains
 * the WHOLE worker-computed `analysis` object per document (not just a
 * flattened bpm/beats view), so a later task has everything it needs. See
 * task-T4-report.md for the explicit note.
 *
 * ## Reactivity
 *
 * A version counter + subscribe/getSnapshot/`useTempoVersion` trio, copied in
 * shape from `noiseProfile.ts:31-49,87-95` — module state behind
 * `useSyncExternalStore`, NOT zustand (matches `spectralScale.ts`,
 * `noiseProfile.ts`, `undoHistory.useHistoryVersion`). Bumped on run start, on
 * each (already 50ms worker-side-throttled) progress message, on completion
 * (success OR failure), and on invalidation.
 */

import { useSyncExternalStore } from 'react';
import type { AudioDocument } from '../audio/AudioDocument';
import { useAppStore } from '../stores/appStore';
import { createTempoWorker } from '../workers/createTempoWorker';
import { MIN_BPM, MAX_BPM } from '../dsp/tempoCore';
import type { TempoAnalysis } from '../dsp/tempoCore';

/**
 * Placeholder until T9 (`src/dsp/remixFeatures.ts`) lands and widens this
 * with chroma / bar boundaries / per-boundary descriptors / clusters.
 * `tempo.worker.ts`'s `deriveRemixFeatures` still throws 'not implemented'
 * for `level:'remix'` requests (T3), so no genuine `RemixAnalysis` value
 * flows through this module beyond the type declaration today. A type ALIAS
 * (not an empty interface) so T9 can turn it into its own interface freely,
 * without this module needing a change.
 */
export type RemixAnalysis = TempoAnalysis;

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
  channelRefs: Float32Array[];
  sampleRate: number;
  level: 'tempo' | 'remix';
  analysis: TempoAnalysis | RemixAnalysis;
  /** Long-lived `TempoEntry` view over `analysis`, created once when the row
   * is cached. `getTempo` mutates `.stale` on THIS SAME object and returns it
   * by reference every call — never reallocates — so a caller holding a
   * reference across a metadata-only document replacement (rename, dirty
   * flip, marker add) sees reference equality (acceptance b). */
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

/** Averages `doc.channels[0]`/`[1]` into ONE freshly-allocated Float32Array in
 * a single pass. See the module doc comment for why this is not
 * `mixDown(cloneRegion(...))`. Never mutates `doc.channels`. */
function monoSnapshot(doc: AudioDocument): Float32Array {
  const channels = doc.channels;
  const length = channels[0]?.length ?? 0;
  const out = new Float32Array(length);
  if (channels.length <= 1) {
    const src = channels[0];
    if (src) out.set(src);
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
  entry.tempoEntry.stale = !sameChannelRefs(entry.channelRefs, doc.channels);
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
  if (!sameChannelRefs(entry.channelRefs, doc.channels)) return null;
  return entry.analysis as RemixAnalysis;
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
 * `invalidateTempo` in `closeDocumentFlow` per the task's flagged risk #1. */
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

/** True while ANY analysis (tempo or remix level) is in flight for `docId`. */
export function isTempoRunning(docId: string): boolean {
  return inFlightTempo.has(docId) || inFlightRemix.has(docId);
}

/** The most recent progress fraction reported for `docId`'s in-flight run, or
 * `null` when nothing is running. */
export function getTempoProgress(docId: string): number | null {
  return progress.has(docId) ? (progress.get(docId) as number) : null;
}

let nextRunId = 1;

type WorkerReply =
  | { type: 'progress'; id: number; fraction: number }
  | { type: 'done'; id: number; level: 'tempo' | 'remix'; analysis: TempoAnalysis | RemixAnalysis }
  | { type: 'error'; id: number; message: string };

function showFailure(message: string): void {
  void window.electronAPI?.showMessageBox({
    type: 'error',
    title: 'Tempo analysis failed',
    message,
  });
}

/**
 * Shared worker choreography for both `runTempoAnalysis` and
 * `runRemixAnalysis`. Returns the PUBLIC, doc-shaped result for `level`
 * (`TempoEntry | null` for 'tempo', `RemixAnalysis | null` for 'remix') —
 * read fresh off the cache via `getTempo`/`getRemixAnalysis` against the LIVE
 * document, never the raw worker payload — so a superseded or doc-closed-
 * mid-run outcome resolves to whatever is currently true rather than to a
 * value that may already be wrong by the time the caller sees it.
 */
function startRun(
  doc: AudioDocument,
  level: 'tempo' | 'remix',
  params: RemixAnalysisParams | undefined,
  onProgress: ((fraction: number) => void) | undefined
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

  const worker = createTempoWorker();

  return new Promise((resolve) => {
    function readLive(): TempoEntry | RemixAnalysis | null {
      const liveDoc = useAppStore.getState().documents.find((d) => d.id === docId);
      if (!liveDoc) return null;
      return level === 'tempo' ? getTempo(liveDoc) : getRemixAnalysis(liveDoc);
    }

    function settle(): void {
      progress.delete(docId);
      bumpVersion();
      resolve(readLive());
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
          const liveDoc = useAppStore.getState().documents.find((d) => d.id === docId);
          if (liveDoc) writeCache(docId, channelRefs, sampleRate, level, msg.analysis);
        }
      } else if (isCurrent) {
        // error
        showFailure(msg.message);
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
      },
      transfer
    );
  });
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
  if (existing && existing.level === 'remix' && sameChannelRefs(existing.channelRefs, doc.channels)) {
    return Promise.resolve(getTempo(doc));
  }

  const running = inFlightTempo.get(docId);
  if (running) return running;

  const promise = (startRun(doc, 'tempo', undefined, undefined) as Promise<TempoEntry | null>).finally(() => {
    inFlightTempo.delete(docId);
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
    inFlightRemix.delete(docId);
  });
  inFlightRemix.set(docId, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Test-only hooks
// ---------------------------------------------------------------------------

/**
 * Test-only: promotes the CURRENT cache row for `docId` (if any) to
 * `level:'remix'` in place, without running the worker. `tempo.worker.ts`'s
 * `deriveRemixFeatures` still throws 'not implemented' (T9 not landed), so a
 * genuine level:'remix' row cannot be produced end-to-end via
 * `runRemixAnalysis` yet — this lets `getRemixAnalysis`'s hard rule
 * (`level !== 'remix' || stale` -> null) be exercised on BOTH arms ahead of
 * T9, rather than only the `level !== 'remix'` arm a tempo-only flow can
 * reach today. Does not fabricate analysis content — it relabels a real,
 * already-cached `TempoAnalysis` (structurally a valid `RemixAnalysis` today,
 * since the latter is still a type alias of the former).
 */
export function _promoteToRemixLevelForTest(docId: string): void {
  const entry = cache.get(docId);
  if (entry) entry.level = 'remix';
}
