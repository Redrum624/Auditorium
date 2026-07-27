/**
 * Feature 3 service (Task T13): the Auto-Remix session — worker choreography,
 * new-document creation, and the five adjustment operations (reject / lock /
 * nudge / re-roll / reset). REUSE, NOT REBUILD: every piece of the pipeline
 * below already exists and is already reviewed —
 * `tempoAnalysis.ts`'s shared cache + worker (T4), `remixFeatures.ts`'s
 * analysis (T9), `remixCost.ts`'s `joinCost` (T10), `remixPlan.ts`'s 2-D
 * lattice DP (T11), `remixRender.ts`'s crossfade/assembly (T12) and
 * `editOps.ts`'s single write path. This module owns ONLY the orchestration
 * and the session state.
 *
 * ## The flow
 *
 * `getRemixAnalysis(source)` (from the shared cache) or `runRemixAnalysis` ->
 * `planRemix` -> `renderRemix` -> `createDocument` -> `addDocument` ->
 * `setView('waveform')` -> seed join markers. The creation half follows
 * `mixdownToNewFile` (`menuActions.ts:615-637`) VERBATIM, including
 * `nextId('remix').split('-')[1]` for the display number and the deliberate
 * absence of any undo entry — a brand-new document has no history, exactly as
 * Mix Down.
 *
 * ## Why the output is a NEW DOCUMENT, not an in-place edit
 *
 * An in-place `applyEdit` charges `docBytes(preDoc)` (`editOps.ts:189`) — the
 * ENTIRE source, ~105 MB for a 5-minute stereo track — against
 * `MAX_UNDO_BYTES = 800 MB` (`undoHistory.ts:67`), so eight re-rolls would
 * exhaust the budget on their own; it destroys the A/B reference the user
 * needs; and a new document matches Audition's own Remix behaviour.
 * Multitrack clips were considered and rejected (clip/session mutations get
 * NO undo at all, saving a `.audm` drops clips whose source document is
 * closed, clips within a track must not overlap — which centred crossfades
 * violate by construction — and `Clip` has no fade fields).
 *
 * ## Adjustments rewrite the SAME remix document, in TWO undo entries
 *
 * Every re-render (reject / nudge / re-roll / reset / target or crossfade
 * change) goes through ONE `applyEdit('Remix', ...)` with a `{type:'replace',
 * start:0, end:oldLen, length:newLen}` remap. `'replace'` is semantically
 * correct here, NOT `'stretch'`: the content genuinely IS swapped for a
 * different arrangement, and every old join marker refers to a splice that no
 * longer exists — so dropping all interior markers is exactly right
 * (`editOps.ts:50-57,76-79`). Fresh join markers are then seeded with a
 * SECOND, separately-labelled `pushMarkerUndo('Remix Markers', ...)` entry —
 * unavoidable, because `applyEdit`'s remap can only drop or shift EXISTING
 * markers, never invent one (`editOps.ts:151-155`). Widening `applyEdit` to
 * carry an explicit marker list was considered and rejected as an
 * unjustified change to the single write path. Two Ctrl+Z presses therefore
 * step back one arrangement; the panel (T15) states this rather than hiding
 * it.
 *
 * ## Staleness is a HARD gate, never a silent re-render
 *
 * The session retains `sourceChannelRefs` (the same identity-based test
 * `peaksCache.ts:16-22` and `tempoAnalysis.ts` use — a mutator always
 * allocates fresh channel arrays). When they no longer match the live source
 * document, or the source was closed, `stale` flips and EVERY adjustment
 * becomes a no-op returning `null`. The remix audio is untouched; we never
 * re-render an arrangement from different audio than it was planned against.
 *
 * ## Planning runs on the MAIN THREAD (deviation from the brief — reported)
 *
 * The brief specifies routing `planRemix` to the worker above
 * `(numBars+1)*(Nmax+1) > MAX_DP_CELLS` (`remixPlan.ts`). This module does
 * NOT: `tempo.worker.ts` has an `analyze`-only protocol (levels tempo /
 * remix / regrid) and T13's file list does not include it, and — more
 * importantly — a plan request would have to ship the WHOLE cached
 * `RemixAnalysis` (~1.5 MB of typed arrays) to the worker on EVERY
 * adjustment, which cannot be transferred (transferring would detach the
 * shared cache's own arrays) and so must be copied. Measured on this repo's
 * abab fixture (32 bars): the DP runs in **1 ms**, against ~630 ms for the
 * analysis it already sits behind. The brief's own crossover (`M = 288`,
 * ~10 minutes of material) puts the worst case in the low hundreds of ms,
 * once, behind an existing progress bar — while the per-adjustment copy cost
 * would be paid on every reject/nudge/re-roll, i.e. exactly the latency the
 * routing was meant to protect. Flagged for adjudication in the task report,
 * not silently dropped.
 *
 * ## `dirty` stays false on creation
 *
 * `createDocument` sets it (`AudioDocument.ts:50`) and this module
 * deliberately does not override it, matching Mix Down: `undoHistory`
 * re-derives `dirty` from `position` vs `savePoint` after any undo/redo, so
 * an explicitly-set flag would silently clear on the first undo of a
 * subsequent edit. Recorded in `docs/KNOWN_LIMITATIONS.md` (T16).
 *
 * ## Reactivity
 *
 * A version counter + `subscribe`/`getSnapshot`/`useRemixVersion` trio,
 * copied in shape from `tempoAnalysis.ts` / `noiseProfile.ts:31-49,87-95` —
 * module state behind `useSyncExternalStore`, NOT zustand. Bumped on
 * creation, on every adjustment (including a lock toggle, which changes no
 * audio) and on invalidation.
 */

import { useSyncExternalStore } from 'react';
import { createDocument, docLength, nextId, replaceRegion, type AudioDocument } from '../audio/AudioDocument';
import { useAppStore, type Marker } from '../stores/appStore';
import { applyEdit, pushMarkerUndo } from './editOps';
import { getRemixAnalysis, runRemixAnalysis, type RemixAnalysis, type RemixAnalysisParams } from './tempoAnalysis';
import { DEFAULT_REMIX_WEIGHTS, clusterMemberCounts, joinCost, type RemixWeights } from '../dsp/remixCost';
import { DEFAULT_MAX_REPEAT_FACTOR, planRemix, type PlanRemixResult, type RemixJoin } from '../dsp/remixPlan';
import { renderRemix, type CrossfadeShape, type RemixPlan } from '../dsp/remixRender';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Everything a session needs to re-plan and re-render itself. Split from
 * `CreateRemixRequest` so `updateRemixSession` can patch any subset of it. */
export interface RemixOptions {
  /** Desired output length, in samples. */
  targetSample: number;
  /** Phi — bars per phrase. */
  phraseBars: number;
  /** Hard phrase congruence + `minRunBars = phraseBars` (vs 4 loose). */
  strict: boolean;
  allowRepeats: boolean;
  /** Crossfade width in ms (T12's own 5-120 ms user range; render-only). */
  crossfadeMs: number;
  /** Sample-exact trim to `targetSample` (affects BOTH planning and render). */
  exactLength: boolean;
  /** Seed one 'Edit k' marker per join. */
  markEditPoints: boolean;
  weights: RemixWeights;
  maxRepeatFactor: number;
}

export interface CreateRemixRequest extends Partial<RemixOptions> {
  sourceDocId: string;
  targetSample: number;
  /** Forwarded to `runRemixAnalysis` — beats/bar, downbeat shift, BPM range. */
  analysisParams?: RemixAnalysisParams;
  onProgress?: (fraction: number) => void;
}

/** `no-document` / `analysis-failed` are this module's own; the remaining
 * four are `PlanRemixResult`'s `reason` passed straight through, so a dialog
 * can render one message table for both layers. */
export type RemixCreateStatus =
  | 'no-document'
  | 'analysis-failed'
  | 'no-tempo'
  | 'too-short'
  | 'too-long'
  | 'no-path';

export type CreateRemixResult =
  | { ok: true; remixDocId: string; plan: RemixPlan }
  | { ok: false; status: RemixCreateStatus; message: string };

export interface RemixSession {
  remixDocId: string;
  sourceDocId: string;
  /** The source document's name AT CREATION TIME — the panel's 'from
   * Song.wav' line must keep reading correctly after the source is closed,
   * which is exactly when the session is stale and most needs to say where
   * it came from. */
  sourceName: string;
  options: RemixOptions;
  analysis: RemixAnalysis;
  plan: RemixPlan;
  /** Output-sample position of each join's crossfade centre, parallel to
   * `plan.joins` — `renderRemix`'s own `joinSamples`. */
  joinSamples: number[];
  /** Micro-alignment delta actually applied per join (source samples). */
  nudgeSamples: number[];
  /** Correlation fed to the gain law per join. */
  rhos: number[];
  shapes: CrossfadeShape[];
  /** `${from}>${to}` keys the user rejected; passed to the planner as
   * `forbiddenJoins`. */
  rejectedJoins: string[];
  /** `${from}>${to}` keys the user pinned — see `toggleLockJoin`. */
  lockedJoins: string[];
  rollIndex: number;
  /** True once `nudgeJoin` has hand-edited the arrangement, so the current
   * `plan` is NOT what `planRemix` would return for these options. Any
   * re-plan (reject / re-roll / reset / option change) clears it. */
  manual: boolean;
  /** Recomputed against the LIVE source document on every `getRemixSession`
   * call and at the top of every adjustment — never trusted from write time. */
  stale: boolean;
}

/** The panel's own cap (T15: "pins the join across re-plans and re-rolls, max
 * 8"), enforced HERE as well as in the UI so the invariant does not depend on
 * a component. */
export const MAX_LOCKED_JOINS = 8;

/** How many extra deterministic re-rolls `planWithLocks` may try to bring a
 * broken lock back. See its own doc comment. */
const MAX_LOCK_RECOVERY_ROLLS = 3;

const DEFAULTS: Omit<RemixOptions, 'targetSample' | 'weights'> = {
  phraseBars: 8,
  strict: true,
  allowRepeats: true,
  crossfadeMs: 25,
  exactLength: false,
  markEditPoints: true,
  maxRepeatFactor: DEFAULT_MAX_REPEAT_FACTOR,
};

/** Option keys whose change invalidates the PLAN, not merely the render.
 * `crossfadeMs`/`markEditPoints` are deliberately absent: a crossfade is
 * length-neutral by construction (T12), so changing it re-renders the SAME
 * arrangement — and re-planning would silently discard the user's nudges. */
const REPLAN_KEYS: (keyof RemixOptions)[] = [
  'targetSample',
  'phraseBars',
  'strict',
  'allowRepeats',
  'exactLength',
  'weights',
  'maxRepeatFactor',
];

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

interface Entry {
  session: RemixSession;
  /** Snapshot of the source's channel arrays at plan time — the staleness
   * test (`peaksCache.ts:16-22`'s identity convention). */
  sourceChannelRefs: Float32Array[];
  /** Cumulative nudge in bars per join, parallel to `session.plan.joins`, so
   * the `+/- floor(phraseBars/2)` bound is on the TOTAL displacement rather
   * than on one keystroke. Reset by every re-plan. */
  nudgeBars: number[];
}

const sessions = new Map<string, Entry>();

// ---------------------------------------------------------------------------
// Reactivity — copied in shape from tempoAnalysis.ts / noiseProfile.ts
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

/** Monotonic counter bumped on creation, on every adjustment and on
 * invalidation; non-reactive read. */
export function getRemixVersion(): number {
  return version;
}

/** Re-renders the caller whenever remix session state changes. */
export function useRemixVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function store() {
  return useAppStore.getState();
}

function findDoc(docId: string): AudioDocument | undefined {
  return store().documents.find((d) => d.id === docId);
}

/** Copied VERBATIM from `peaksCache.ts:16-22` / `tempoAnalysis.ts`. */
function sameChannelRefs(a: Float32Array[], b: Float32Array[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function joinKey(from: number, to: number): string {
  return `${from}>${to}`;
}

function keysOf(joins: readonly RemixJoin[]): string[] {
  return joins.map((j) => joinKey(j.fromBar, j.toBar));
}

function refreshStale(entry: Entry): boolean {
  const source = findDoc(entry.session.sourceDocId);
  entry.session.stale = !source || !sameChannelRefs(entry.sourceChannelRefs, source.channels);
  return entry.session.stale;
}

/** The one guard every adjustment opens with: a live, non-stale session whose
 * remix document is still open. Returns `null` (a silent no-op for the
 * caller) otherwise. */
function liveEntry(remixDocId: string): Entry | null {
  const entry = sessions.get(remixDocId);
  if (!entry) return null;
  if (!findDoc(remixDocId)) {
    // The remix document was closed without `closeDocumentFlow` (or by a
    // direct store call): drop the session rather than leave it pinning the
    // source's channel arrays.
    sessions.delete(remixDocId);
    bumpVersion();
    return null;
  }
  if (refreshStale(entry)) return null;
  return entry;
}

/** One 'Edit k' marker per join, clamped into the document exactly like
 * `openFilePath`'s marker seeding (`fileService.ts:174-181`). */
function makeJoinMarkers(docId: string, joinSamples: readonly number[]): Marker[] {
  const doc = findDoc(docId);
  if (!doc) return [];
  const length = docLength(doc);
  return joinSamples.map((pos, i) => ({
    id: nextId('marker'),
    name: `Edit ${i + 1}`,
    positionSample: Math.max(0, Math.min(length, Math.round(pos))),
  }));
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function planOptionsFor(
  options: RemixOptions,
  rejected: readonly string[],
  rollIndex: number
): Parameters<typeof planRemix>[1] {
  return {
    targetSample: options.targetSample,
    weights: options.weights,
    phraseBars: options.phraseBars,
    strict: options.strict,
    allowRepeats: options.allowRepeats,
    maxRepeatFactor: options.maxRepeatFactor,
    exactLength: options.exactLength,
    forbiddenJoins: rejected,
    rollIndex,
  };
}

/**
 * `planRemix` plus a bounded, deterministic attempt to keep LOCKED joins.
 *
 * `remixPlan.ts` exposes `forbiddenJoins` but has NO "required joins" input,
 * and its re-roll penalty is applied to every join of the previous roll —
 * including a locked one. There is therefore no way to make a lock a HARD
 * constraint from this layer without changing the planner, which is out of
 * scope for T13. What IS available, and is what this does: run the plan, and
 * if a lock was broken, try the next few deterministic re-rolls and keep
 * whichever attempt preserves the MOST locks (ties -> the earliest attempt,
 * i.e. the cheapest). Same retry-and-keep-the-best shape as `remixPlan.ts`'s
 * own over-repetition guard, and equally deterministic — but a PREFERENCE,
 * not a guarantee, which the panel must present as such.
 */
function planWithLocks(
  analysis: RemixAnalysis,
  options: RemixOptions,
  rejected: readonly string[],
  locked: readonly string[],
  rollIndex: number
): PlanRemixResult {
  const base = planRemix(analysis, planOptionsFor(options, rejected, rollIndex));
  if (!base.ok || locked.length === 0) return base;

  const countKept = (plan: RemixPlan): number => {
    const keys = new Set(keysOf(plan.joins));
    let n = 0;
    for (const key of locked) if (keys.has(key)) n++;
    return n;
  };

  let best = base;
  let bestKept = countKept(base);
  for (let extra = 1; bestKept < locked.length && extra <= MAX_LOCK_RECOVERY_ROLLS; extra++) {
    const next = planRemix(analysis, planOptionsFor(options, rejected, rollIndex + extra));
    if (!next.ok) break;
    const kept = countKept(next);
    if (kept > bestKept) {
      best = next;
      bestKept = kept;
    }
  }
  return best;
}

/** Whether a hand-edited join list still describes a legal arrangement:
 * integer bars in `[0, numBars]`, every segment at least one bar long, and a
 * non-empty final segment. */
function joinsAreValid(joins: readonly { fromBar: number; toBar: number }[], numBars: number): boolean {
  let segStart = 0;
  for (const j of joins) {
    if (!Number.isInteger(j.fromBar) || !Number.isInteger(j.toBar)) return false;
    if (j.fromBar < 0 || j.fromBar > numBars || j.toBar < 0 || j.toBar > numBars) return false;
    if (j.fromBar <= segStart) return false;
    segStart = j.toBar;
  }
  return segStart < numBars;
}

/**
 * Rebuilds a full `RemixPlan` from a hand-edited join list — the ONLY way to
 * express `nudgeJoin`, since the DP plans from a target duration and cannot
 * be asked to honour a specific join. Every derived field is recomputed from
 * `analysis.barBoundary` exactly the way `remixPlan.ts` computes it, so
 * `renderRemix`'s entry-side identity check (`outputSample === headLen +
 * Sum(spans) + tailLen`) holds by construction.
 *
 * `minOutputSample`/`maxOutputSample` are CARRIED OVER from `base`: they
 * describe the reachable extremes of the DP's lattice, which a manual nudge
 * does not change (it moves a join within the same lattice, it does not add
 * or remove reachable terminal states).
 */
function buildPlanFromJoins(
  analysis: RemixAnalysis,
  options: RemixOptions,
  joins: readonly { fromBar: number; toBar: number }[],
  base: RemixPlan
): RemixPlan {
  const numBars = analysis.numBars;
  const boundary = analysis.barBoundary;
  const phraseBars = Math.max(1, Math.floor(options.phraseBars));

  const segmentsBar: { startBar: number; endBar: number }[] = [];
  let segStart = 0;
  for (const j of joins) {
    segmentsBar.push({ startBar: segStart, endBar: j.fromBar });
    segStart = j.toBar;
  }
  segmentsBar.push({ startBar: segStart, endBar: numBars });

  const segments = segmentsBar.map((s) => ({ start: boundary[s.startBar], end: boundary[s.endBar] }));
  let spanSum = 0;
  for (const s of segments) spanSum += s.end - s.start;
  const headLen = segments[0].start;
  const tailLen = analysis.analyzedEndSample - segments[segments.length - 1].end;

  const memberCounts = clusterMemberCounts(analysis.cluster);
  const fullJoins: RemixJoin[] = joins.map((j) => ({
    fromBar: j.fromBar,
    toBar: j.toBar,
    cost: joinCost(analysis, options.weights, phraseBars, j.fromBar, j.toBar, memberCounts),
  }));
  let totalCost = 0;
  for (const j of fullJoins) totalCost += j.cost.total + options.weights.jump;

  const counts = new Int32Array(numBars);
  for (const s of segmentsBar) for (let b = s.startBar; b < s.endBar; b++) counts[b]++;
  let maxBarUse = 0;
  for (let i = 0; i < counts.length; i++) if (counts[i] > maxBarUse) maxBarUse = counts[i];

  return {
    ok: true,
    segments,
    joins: fullJoins,
    outputSample: headLen + spanSum + tailLen,
    targetSample: options.targetSample,
    totalCost,
    minOutputSample: base.minOutputSample,
    maxOutputSample: base.maxOutputSample,
    maxBarUse,
    canReroll: fullJoins.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Render + commit
// ---------------------------------------------------------------------------

/**
 * Renders `plan` and rewrites the remix document through ONE
 * `applyEdit('Remix', ...)` plus ONE `pushMarkerUndo('Remix Markers', ...)`
 * — see the module doc comment for why that is two entries and not one.
 *
 * `renderRemix` is called WITHOUT a try/catch on purpose: it throws only when
 * `plan.outputSample` disagrees with its own segments, and `joinCost` throws
 * `RangeError` only for an out-of-domain bar index. Both are programming
 * errors in THIS module, not user-facing conditions, and swallowing them
 * would hide exactly the class of bug the checks exist to catch (T12/T10
 * carry-forward).
 */
function commitPlan(entry: Entry, plan: RemixPlan): RemixPlan | null {
  const { remixDocId, sourceDocId, analysis, options } = entry.session;
  const source = findDoc(sourceDocId);
  const remixDoc = findDoc(remixDocId);
  if (!source || !remixDoc) return null;

  const render = renderRemix(source.channels, analysis, plan, {
    sampleRate: source.sampleRate,
    crossfadeMs: options.crossfadeMs,
    exactLength: options.exactLength,
  });

  const oldLen = docLength(remixDoc);
  const newLen = render.channels[0].length;
  applyEdit(
    'Remix',
    remixDocId,
    (d) => replaceRegion(d, 0, docLength(d), render.channels),
    { selection: null, cursorSample: 0 },
    { type: 'replace', start: 0, end: oldLen, length: newLen }
  );

  // The 'replace' remap above dropped every interior marker (each described a
  // splice that no longer exists), so `before` is whatever survived it —
  // normally the empty list. Guarded exactly like `applyEdit`'s own remap
  // (`editOps.ts:156`): with nothing on either side there is no marker change
  // to record, and an empty undo entry would only cost the user a Ctrl+Z.
  const before = store().markers[remixDocId] ?? [];
  const after = options.markEditPoints ? makeJoinMarkers(remixDocId, render.joinSamples) : [];
  if (before.length > 0 || after.length > 0) {
    store().setMarkersForDoc(remixDocId, after);
    pushMarkerUndo('Remix Markers', remixDocId, before, store().markers[remixDocId] ?? after);
  }

  entry.session.plan = plan;
  entry.session.joinSamples = render.joinSamples;
  entry.session.nudgeSamples = render.nudgeSamples;
  entry.session.rhos = render.rhos;
  entry.session.shapes = render.shapes;
  bumpVersion();
  return plan;
}

/** Shared tail of every re-PLANNING adjustment: plan, and only if that
 * succeeded, mutate the session's own bookkeeping and commit. A failed plan
 * leaves the session (and the document) exactly as it was and is handed back
 * so the caller can surface `minOutputSample`/`maxOutputSample`. */
function replanAndCommit(
  entry: Entry,
  next: { rejected: string[]; locked: string[]; rollIndex: number }
): PlanRemixResult | null {
  const plan = planWithLocks(entry.session.analysis, entry.session.options, next.rejected, next.locked, next.rollIndex);
  if (!plan.ok) return plan;

  entry.session.rejectedJoins = next.rejected;
  entry.session.lockedJoins = next.locked;
  entry.session.rollIndex = next.rollIndex;
  entry.session.manual = false;
  entry.nudgeBars = plan.joins.map(() => 0);
  return commitPlan(entry, plan);
}

// ---------------------------------------------------------------------------
// createRemixDocument
// ---------------------------------------------------------------------------

/**
 * Analyses (or reuses the cached analysis for) the source document, plans and
 * renders the remix, and adds it as a NEW document — active, in the waveform
 * view, with one 'Edit k' marker per join and NO undo entry.
 *
 * Always resolves; never throws for a user-facing condition. Worker failures
 * are surfaced by `runRemixAnalysis` itself (its own `showMessageBox`, T4's
 * choreography: monotonic id, stale replies dropped, `terminate()` on every
 * terminal branch, `onerror` wired) and reported here as
 * `status: 'analysis-failed'`; planning refusals pass `PlanRemixResult`'s own
 * `reason`/`message` straight through so a dialog can clamp its input from
 * `minOutputSample`/`maxOutputSample` next time.
 */
export async function createRemixDocument(req: CreateRemixRequest): Promise<CreateRemixResult> {
  const initial = findDoc(req.sourceDocId);
  if (!initial) {
    return { ok: false, status: 'no-document', message: `Document ${req.sourceDocId} is not open.` };
  }

  let analysis = getRemixAnalysis(initial);
  if (!analysis) {
    analysis = await runRemixAnalysis(initial, req.analysisParams, req.onProgress);
  }
  if (!analysis) {
    return {
      ok: false,
      status: 'analysis-failed',
      message: 'Beat analysis did not produce a usable grid for this document.',
    };
  }

  // Re-read the source from LIVE state: the await above gives a user time to
  // close or edit it, and planning/rendering against a grid that no longer
  // matches the audio is the one failure mode in this feature that produces
  // silently wrong output rather than a visible error.
  const source = findDoc(req.sourceDocId);
  if (!source) {
    return { ok: false, status: 'no-document', message: 'The source document was closed during analysis.' };
  }
  if (!getRemixAnalysis(source)) {
    return { ok: false, status: 'analysis-failed', message: 'The source audio changed during analysis.' };
  }

  const options: RemixOptions = {
    ...DEFAULTS,
    targetSample: req.targetSample,
    weights: { ...DEFAULT_REMIX_WEIGHTS, ...req.weights },
    phraseBars: req.phraseBars ?? DEFAULTS.phraseBars,
    strict: req.strict ?? DEFAULTS.strict,
    allowRepeats: req.allowRepeats ?? DEFAULTS.allowRepeats,
    crossfadeMs: req.crossfadeMs ?? DEFAULTS.crossfadeMs,
    exactLength: req.exactLength ?? DEFAULTS.exactLength,
    markEditPoints: req.markEditPoints ?? DEFAULTS.markEditPoints,
    maxRepeatFactor: req.maxRepeatFactor ?? DEFAULTS.maxRepeatFactor,
  };

  const plan = planRemix(analysis, planOptionsFor(options, [], 0));
  if (!plan.ok) return { ok: false, status: plan.reason, message: plan.message };

  const render = renderRemix(source.channels, analysis, plan, {
    sampleRate: source.sampleRate,
    crossfadeMs: options.crossfadeMs,
    exactLength: options.exactLength,
  });

  // `mixdownToNewFile` (menuActions.ts:629-636), verbatim: the display number
  // comes from the id counter, `addDocument` activates the new document and
  // resets selection/cursor/zoom, then the view switches. No `pushUndo` — a
  // brand-new document has no history.
  const n = nextId('remix').split('-')[1];
  const doc = createDocument({
    name: `Remix ${n}`,
    sampleRate: source.sampleRate,
    channels: render.channels,
  });
  store().addDocument(doc);
  store().setView('waveform');

  if (options.markEditPoints) {
    const markers = makeJoinMarkers(doc.id, render.joinSamples);
    if (markers.length > 0) store().setMarkersForDoc(doc.id, markers);
  }

  sessions.set(doc.id, {
    session: {
      remixDocId: doc.id,
      sourceDocId: source.id,
      sourceName: source.name,
      options,
      analysis,
      plan,
      joinSamples: render.joinSamples,
      nudgeSamples: render.nudgeSamples,
      rhos: render.rhos,
      shapes: render.shapes,
      rejectedJoins: [],
      lockedJoins: [],
      rollIndex: 0,
      manual: false,
      stale: false,
    },
    sourceChannelRefs: source.channels.slice(),
    nudgeBars: plan.joins.map(() => 0),
  });
  bumpVersion();

  return { ok: true, remixDocId: doc.id, plan };
}

// ---------------------------------------------------------------------------
// Session reads
// ---------------------------------------------------------------------------

/** The session for a remix document, with `stale` freshly recomputed against
 * the LIVE source (never trusted from write time — the same discipline
 * `getTempo` uses). Returns the SAME object across calls for a live session,
 * so a component holding a reference sees `stale` flip in place. */
export function getRemixSession(remixDocId: string): RemixSession | null {
  const entry = sessions.get(remixDocId);
  if (!entry) return null;
  refreshStale(entry);
  return entry.session;
}

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

/**
 * Patches the session's options and re-plans (or, for render-only keys,
 * merely re-renders) the remix document. Returns the resulting
 * `PlanRemixResult` — including the `ok: false` arm, so a dialog can clamp
 * its target from `minOutputSample`/`maxOutputSample` — or `null` when there
 * is no live, non-stale session.
 *
 * A failed re-plan is fully atomic: the options are restored and neither the
 * document nor the session is touched.
 */
export function updateRemixSession(remixDocId: string, patch: Partial<RemixOptions>): PlanRemixResult | null {
  const entry = liveEntry(remixDocId);
  if (!entry) return null;

  const previous = entry.session.options;
  const needsReplan = REPLAN_KEYS.some((key) => key in patch && !Object.is(patch[key], previous[key]));
  const options: RemixOptions = { ...previous, ...patch };
  entry.session.options = options;

  if (!needsReplan) {
    // Same arrangement, new render parameters. A manual (nudged) plan
    // survives, which is the whole reason `crossfadeMs` is not a replan key.
    const committed = commitPlan(entry, entry.session.plan);
    if (!committed) {
      entry.session.options = previous;
      return null;
    }
    return committed;
  }

  const plan = planWithLocks(
    entry.session.analysis,
    options,
    entry.session.rejectedJoins,
    entry.session.lockedJoins,
    entry.session.rollIndex
  );
  if (!plan.ok) {
    entry.session.options = previous;
    return plan;
  }
  entry.session.manual = false;
  entry.nudgeBars = plan.joins.map(() => 0);
  return commitPlan(entry, plan);
}

/**
 * Forbids `${from}>${to}` for good and re-plans around it ("that one edit
 * sounds wrong, find another way to hit the same length"). Any LOCK on the
 * same join is dropped in the same step — a key that is simultaneously
 * forbidden and pinned can never be satisfied, so keeping both would make
 * `planWithLocks` retry forever for nothing.
 */
export function rejectJoin(remixDocId: string, key: string): PlanRemixResult | null {
  const entry = liveEntry(remixDocId);
  if (!entry) return null;
  if (!keysOf(entry.session.plan.joins).includes(key)) return null;

  const rejected = entry.session.rejectedJoins.includes(key)
    ? entry.session.rejectedJoins.slice()
    : [...entry.session.rejectedJoins, key];
  const locked = entry.session.lockedJoins.filter((k) => k !== key);
  return replanAndCommit(entry, { rejected, locked, rollIndex: entry.session.rollIndex });
}

/**
 * Pins / unpins a join. Returns the NEW locked state, or `null` when the
 * session is missing/stale, the key is not a join of the current plan, or the
 * `MAX_LOCKED_JOINS` cap is already reached.
 *
 * Deliberately does NOT re-render (the brief lists 'lock' among the
 * re-render triggers — reported as a spec problem): locking a join that is
 * already IN the current arrangement cannot change that arrangement, so a
 * re-render would rewrite the document to identical audio and charge the user
 * two undo entries for it. Locks only take effect on the NEXT re-plan; see
 * `planWithLocks` for exactly how strong that effect is.
 */
export function toggleLockJoin(remixDocId: string, key: string): boolean | null {
  const entry = liveEntry(remixDocId);
  if (!entry) return null;

  const index = entry.session.lockedJoins.indexOf(key);
  if (index >= 0) {
    entry.session.lockedJoins.splice(index, 1);
    bumpVersion();
    return false;
  }
  if (!keysOf(entry.session.plan.joins).includes(key)) return null;
  if (entry.session.lockedJoins.length >= MAX_LOCKED_JOINS) return null;
  entry.session.lockedJoins.push(key);
  bumpVersion();
  return true;
}

/**
 * Moves a join `deltaBars` bars through the song by shifting `fromBar` AND
 * `toBar` together, so the arrangement keeps emitting exactly the same NUMBER
 * of bars. Bounded to a cumulative `+/- floor(phraseBars/2)` bars per join
 * (T15's own `+/-Phi/2`), and refused outright when the shift would produce
 * an illegal arrangement (a zero-length segment, or a bar outside
 * `[0, numBars]`).
 *
 * NOTE — the brief's acceptance asks for `outputSample` to be UNCHANGED with
 * EXACT equality. That is unachievable by construction and is NOT what this
 * implements: `barBoundary` holds REAL tracked, drift-following beat samples
 * (`remixPlan.ts`: "bar lengths vary by a few ms because the grid is
 * drift-following"), so shifting `fromBar` by +1 adds `barLen(fromBar)`
 * samples while shifting `toBar` by +1 removes `barLen(toBar)`, and those two
 * bars are different lengths. Measured on this repo's abab fixture: a
 * one-sample difference on the first join, against a whole-fixture bar-length
 * spread of 87864-88304 samples. The exactly-preserved invariant is the BAR
 * COUNT; the duration moves only by that inter-bar drift. Reported, not
 * silently reinterpreted.
 */
export function nudgeJoin(remixDocId: string, key: string, deltaBars: number): PlanRemixResult | null {
  const entry = liveEntry(remixDocId);
  if (!entry) return null;
  if (!Number.isInteger(deltaBars) || deltaBars === 0) return null;

  const joins = entry.session.plan.joins;
  const index = keysOf(joins).indexOf(key);
  if (index < 0) return null;

  const limit = Math.max(1, Math.floor(Math.max(1, Math.floor(entry.session.options.phraseBars)) / 2));
  const nextTotal = (entry.nudgeBars[index] ?? 0) + deltaBars;
  if (Math.abs(nextTotal) > limit) return null;

  const moved = joins.map((j, i) =>
    i === index
      ? { fromBar: j.fromBar + deltaBars, toBar: j.toBar + deltaBars }
      : { fromBar: j.fromBar, toBar: j.toBar }
  );
  if (!joinsAreValid(moved, entry.session.analysis.numBars)) return null;

  const plan = buildPlanFromJoins(entry.session.analysis, entry.session.options, moved, entry.session.plan);
  const movedKey = joinKey(moved[index].fromBar, moved[index].toBar);
  const lockIndex = entry.session.lockedJoins.indexOf(key);
  if (lockIndex >= 0) entry.session.lockedJoins[lockIndex] = movedKey;
  entry.nudgeBars = entry.nudgeBars.slice();
  entry.nudgeBars[index] = nextTotal;
  entry.session.manual = true;
  return commitPlan(entry, plan);
}

/**
 * Deterministic next-best arrangement: advances `rollIndex` and re-plans (see
 * `remixPlan.ts`'s "Re-roll" — penalise the previous rolls' joins, never
 * randomised jitter, so two identically-seeded sessions re-roll identically).
 * A no-op returning `null` when the current plan has no joins to vary.
 */
export function reRollRemix(remixDocId: string): PlanRemixResult | null {
  const entry = liveEntry(remixDocId);
  if (!entry) return null;
  if (entry.session.plan.joins.length === 0) return null;

  return replanAndCommit(entry, {
    rejected: entry.session.rejectedJoins.slice(),
    locked: entry.session.lockedJoins.slice(),
    rollIndex: entry.session.rollIndex + 1,
  });
}

/** 'Revert to auto': drops every rejection, lock, nudge and roll and returns
 * the plain automatic plan for the session's current options. */
export function resetRemix(remixDocId: string): PlanRemixResult | null {
  const entry = liveEntry(remixDocId);
  if (!entry) return null;
  return replanAndCommit(entry, { rejected: [], locked: [], rollIndex: 0 });
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

/**
 * Drops every session that involves `docId` — as the REMIX document or as its
 * SOURCE. MANDATORY in `closeDocumentFlow` for both: without it a closed
 * document's channel arrays stay retained by `sourceChannelRefs` (and the
 * whole `RemixAnalysis`) for the rest of the session, the same leak class
 * `peaksCache`/`clipWaveformCache`/`tempoAnalysis` already manage.
 */
export function invalidateRemix(docId: string): void {
  let removed = false;
  for (const [remixDocId, entry] of sessions) {
    if (remixDocId === docId || entry.session.sourceDocId === docId) {
      sessions.delete(remixDocId);
      removed = true;
    }
  }
  if (removed) bumpVersion();
}

/** Drops every session — test isolation only, paired with `invalidateRemix`. */
export function clearAllRemix(): void {
  sessions.clear();
  bumpVersion();
}
