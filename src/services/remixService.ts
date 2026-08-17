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
 * `planRemix` (main thread or the session's plan worker, see below) ->
 * `renderRemix` -> `createDocument` -> `addDocument` -> `setView('waveform')`
 * -> seed join markers. The creation half follows `mixdownToNewFile`
 * (`menuActions.ts:615-637`) VERBATIM, including
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
 * NO undo at all; saving a `.audm` drops clips whose source document is
 * closed; and although v1.9 made same-track overlap first-class — a drag can
 * deliberately overlap, and a canonical pair of facing clip fades renders as
 * a crossfade (X2/X3/X5) — that pair law is a fixed rho=0 blend of exactly
 * TWO clips' facing fades, not the centred, correlation-compensated,
 * lag-searched per-join crossfade Remix needs across many joins).
 *
 * Each `'Remix'` undo entry still retains the REMIX document's own pre-edit
 * snapshot (~105 MB for a 5-minute stereo remix), so roughly eight
 * adjustments reach `MAX_UNDO_BYTES` and the oldest entries are evicted,
 * always keeping at least one. That is correct, bounded behaviour rather than
 * a leak, and is recorded in `docs/KNOWN_LIMITATIONS.md` as intended.
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
 * unjustified change to the single write path.
 *
 * **The two-entry count is CONDITIONAL, not a contract** (fix round 1): the
 * marker entry is pushed only when there is a marker change to record — a
 * zero-join arrangement, or `markEditPoints: false`, produces exactly ONE
 * entry (`'Remix'`). A consumer that wants to undo "one adjustment" must read
 * the actual history length, never assume 2.
 *
 * ## Staleness is a HARD gate, never a silent re-render
 *
 * The session retains `sourceChannelRefs` (the same identity-based test
 * `peaksCache.ts:16-22` and `tempoAnalysis.ts` use — a mutator always
 * allocates fresh channel arrays). When they no longer match the live source
 * document, or the source was closed, `stale` flips and EVERY adjustment
 * becomes a no-op returning `null`. The check runs BOTH at the top of every
 * adjustment and again at commit time, after the plan await — a resident
 * worker analysis must never become a way to plan against audio the live
 * document no longer matches.
 *
 * Going stale is also where the session gives its resources back: the
 * transition terminates the plan worker (respawned from the retained
 * `analysis` if an undo un-stales the session), and `sourceChannelRefs` are
 * held WEAKLY so a stale session never pins the pre-edit source. See
 * `refreshStale` and `Entry.sourceChannelRefs`.
 *
 * ## A pin is a guarantee, and its cost is a bigger table (R4b)
 *
 * `toggleLockJoin`'s pins go to the planner as `requiredJoins`, which
 * `remixPlan.ts` enforces exactly with a `2^K` subset axis on its DP. Two
 * consequences live HERE, not there:
 *
 * 1. **Routing must account for `2^K`.** `dpCells` multiplies by it and the
 *    decision is re-taken per plan rather than once per session, because a
 *    session is created with no pins and every pin the user adds afterwards
 *    doubles the table. See `dpCells` and `runPlan`.
 * 2. **The degradation above `MAX_REQUIRED_JOINS` (4) must be VISIBLE.** The
 *    panel's own cap is 8, so a user can pin more than the planner can
 *    guarantee; the planner then falls back to the old preference behaviour
 *    and says `mode: 'preference'`, which this module carries on the session
 *    as `pinReport` and `RemixPanel` states in words. A silently downgraded
 *    guarantee would be worse than no guarantee.
 *
 * ## Planning: main thread below `MAX_DP_CELLS`, a SESSION-SCOPED worker above
 *
 * The DP is ~O(M^2) (measured: doubling `M` multiplies wall clock by
 * 4.2-4.5x). At the worst case actually reachable under
 * `MAX_ANALYSIS_SECONDS = 600` (200 BPM, 600 s -> `M = 499`, `Nmax = 1497`,
 * **749 000 cells, 3.0x `MAX_DP_CELLS`**) a single `planRemix` measured
 * **302-311 ms** and `rollIndex = 3` **996-1024 ms** — a renderer freeze with
 * no progress and no cancel. It bites well below the threshold too: measured
 * at 120 BPM 4/4, a 4-minute song (120 bars) is **19 ms** and a 10-minute set
 * (300 bars, already 1.08x the limit) is **120 ms**.
 *
 * So planning is routed to a worker when
 * `(numBars+1)*(Nmax+1)*2^min(pins, MAX_REQUIRED_JOINS) > MAX_DP_CELLS`, and
 * the worker is **session-scoped**: the whole
 * `RemixAnalysis` is posted ONCE at session creation and stays RESIDENT
 * (`remixPlan.worker.ts`), so every subsequent plan request is a small
 * message in and a small `PlanRemixResult` out. Shipping the analysis
 * per-call instead would have paid a ~1.7 MB structured clone on EVERY
 * adjustment (measured payload: 1 766 000 bytes; the typed-array copy alone
 * is ~0.4-0.5 ms) — exactly the interaction latency the routing exists to
 * protect. Paid once at creation it sits behind the ~630 ms analysis that
 * already dominates there. The analysis is deliberately NOT transferred:
 * those typed arrays ARE `tempoAnalysis`'s cache rows, and transferring would
 * detach them.
 *
 * Below the threshold the DP stays on the main thread — 19 ms for a 4-minute
 * song is not worth a worker handshake, and that is the common case. (An
 * earlier version of this comment said "1 ms", which was this repo's 64-second
 * abab fixture, not a song — a ~20x understatement of the real thing.)
 *
 * **Worker lifecycle is SESSION-scoped, a deliberate departure from T4's
 * one-shot `terminate()`-on-every-terminal-branch contract** (which is for
 * fire-and-forget analysis runs). It is terminated on session invalidation,
 * on `clearAllRemix`, and on `closeDocumentFlow` for BOTH the remix document
 * and its source. Everything else from T4 still applies verbatim: monotonic
 * id, stale replies dropped, `onerror` wired, the request promise ALWAYS
 * resolves (a hang here would be worse than the freeze this replaces), and
 * failures surfaced via `showMessageBox`. There is deliberately no
 * fall-back-to-main-thread on worker failure: that would reintroduce the
 * multi-second freeze immediately after telling the user something went
 * wrong, and it is the same choice `effectRunner.ts` already makes.
 *
 * ## Re-roll cost compounds, and is memoised per session
 *
 * `planRemix(rollIndex=k)` re-derives rolls `0..k-1` internally (that is what
 * makes re-roll deterministic and stateless), so each press is dearer than
 * the last. Reducing the cost of ONE cold roll would mean restructuring
 * `remixPlan.ts` to accept a precomputed penalty map — out of scope, and
 * ruled out. What IS done here: a per-session memo keyed by `rollIndex`
 * within one option/rejection/pin signature, so a roll a previous press already
 * computed is never recomputed by the next. That removes the repeated work,
 * not the intrinsic cost of a cold roll — a documented residual.
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
import {
  DEFAULT_MAX_REPEAT_FACTOR,
  MAX_DP_CELLS,
  MAX_REQUIRED_JOINS,
  planRemix,
  type PlanRemixOptions,
  type PlanRemixResult,
  type RemixJoin,
  type RequiredJoinsReport,
} from '../dsp/remixPlan';
import { renderRemix, type CrossfadeShape, type RemixPlan } from '../dsp/remixRender';
import { createRemixPlanWorker } from '../workers/createRemixPlanWorker';

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

/** `no-document` / `analysis-failed` / `plan-failed` are this module's own;
 * the remaining four are `PlanRemixResult`'s `reason` passed straight
 * through, so a dialog can render one message table for both layers. */
export type RemixCreateStatus =
  | 'no-document'
  | 'analysis-failed'
  | 'plan-failed'
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
  /** The subset of `lockedJoins` the CURRENT plan does not contain. Since R4b
   * a pin is a GUARANTEE, so this is normally empty and a non-empty value is
   * a specific, explained failure rather than "the planner preferred
   * something else": see `pinReport` for which category. Kept as its own field
   * because the panel's pin badges are keyed by join and need the plain set. */
  lockedJoinsDropped: string[];
  /** Why each dropped pin was dropped, and whether the guarantee was in force
   * at all (R4b). `null` only while no plan with pins has been made — a fresh
   * session has no pins, so there is nothing to report yet. The panel must
   * distinguish `mode: 'preference'` (more than `MAX_REQUIRED_JOINS` pins, so
   * NOTHING was guaranteed) from an enforced plan that dropped a specific,
   * named, impossible pin. */
  pinReport: RequiredJoinsReport | null;
  /** The roll index the CURRENT plan was produced at. Always the index the
   * caller asked for: the lock-recovery sweep that used to try `rollIndex+1..
   * +3` and keep whichever attempt preserved more pins is gone (fix round 2 —
   * see the note on `MAX_LOCKED_JOINS`), so `planWithLocks` returns the
   * requested index unchanged. The next press advances from here, so it can
   * never re-serve the arrangement already on screen. */
  rollIndex: number;
  /** True once `nudgeJoin` has hand-edited the arrangement, so the current
   * `plan` is NOT what `planRemix` would return for these options. Any
   * re-plan (reject / re-roll / reset / option change) clears it. */
  manual: boolean;
  /** True when planning for this session runs in its own worker (the
   * `MAX_DP_CELLS` route). Surfaced so a panel can explain why an adjustment
   * is not instantaneous. */
  plansInWorker: boolean;
  /** Recomputed against the LIVE source document on every `getRemixSession`
   * call, at the top of every adjustment, and again at commit time — never
   * trusted from write time. */
  stale: boolean;
}

/** Why `toggleLockJoin` refused. Distinct reasons, so a panel can say "you
 * already have 8 pins" rather than failing silently (fix round 1). */
export type ToggleLockRefusal = 'no-session' | 'stale' | 'unknown-join' | 'limit-reached';

export type ToggleLockResult =
  | { ok: true; locked: boolean; lockedJoins: string[] }
  | { ok: false; reason: ToggleLockRefusal };

/** The panel's own cap (T15: "pins the join across re-plans and re-rolls, max
 * 8"), enforced HERE as well as in the UI so the invariant does not depend on
 * a component.
 *
 * DELIBERATELY HIGHER than `MAX_REQUIRED_JOINS` (4), which is where the
 * planner's exact subset DP runs out of memory (see that constant). Lowering
 * this to 4 would make the guarantee unconditional at the price of taking four
 * pins away from the user; keeping it at 8 means that once the set the planner
 * can enforce exceeds 4, EVERY pin degrades to a preference — not just the
 * fifth onward. `remixPlan.ts` sets `preferredKeys = feasible`, the whole set,
 * because there is no principled way to choose which four keep a guarantee the
 * user never ranked. The panel says exactly that ("pins are currently strong
 * preferences rather than guarantees"), which is the honest label; an earlier
 * version of this comment claimed pins 1-4 kept the guarantee above the cap,
 * which the planner has never done. That is a real trade-off, made explicitly:
 * a user who pins 8 edits is arranging by hand and is better served by 8
 * preferences plus an honest label than by being told "no".
 *
 * This cap is enforced at TOGGLE time, on the raw length of
 * `session.lockedJoins` (`toggleLockJoin` refuses with `'limit-reached'`) —
 * before any planning, so no triage has happened and none can bring an
 * over-cap set back under it. The triage-first rule belongs to the OTHER cap:
 * `remixPlan.ts`'s `MAX_REQUIRED_JOINS = 4`, where pins the caller also forbade
 * and pins no candidate list contains are dropped before the count is taken. */
export const MAX_LOCKED_JOINS = 8;

// THE LOCK-RECOVERY SWEEP IS GONE (fix round 2). It used to re-run planning
// at `rollIndex+1..+3` and keep whichever attempt preserved the most pins.
// Measured over 92 cases across three scales (M = 32 / 128 / 496, both the
// re-roll and reject entry points): it ran 89 times and helped **0** times.
// The reason was structural, and in the wrong module: `remixPlan.ts`
// accumulated its re-roll penalty monotonically, so a join was penalised
// `+JOIN_PENALTY` (2.0, ~5.7x `weights.jump`) at roll `k+1` precisely BECAUSE
// it was in roll `k`'s plan — the sweep searched in exactly the direction
// that pushes pins out. It is now fixed at the source
// (`PlanRemixOptions.lockedJoins` exempts pinned keys from that penalty), so
// pins survive in the BASE plan and the sweep has nothing left to compensate
// for. Deleting it also removes up to 3 extra full DP runs — measured 2.7-5.6 s
// of worker time at M = 499 — from 100% of pinned Re-rolls.

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
  'maxRepeatFactor',
];

const WEIGHT_KEYS: (keyof RemixWeights)[] = ['timbre', 'chroma', 'loudness', 'rhythm', 'struct', 'phrase', 'jump'];

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

/** One session-scoped plan worker. `pending` guarantees the "promise always
 * resolves" contract from every terminal branch: a reply, an `onerror`, a
 * failed `postMessage`, or termination. */
interface PlanWorkerHandle {
  worker: Worker;
  pending: Map<number, (result: PlanRemixResult | null) => void>;
  nextRequestId: number;
  /** Id of the most recently ISSUED request — a reply for anything older is
   * STALE (its state has been superseded) and resolves `null` rather than
   * letting an out-of-date arrangement reach `commitPlan`. */
  latestRequestId: number;
  dead: boolean;
}

interface Entry {
  session: RemixSession;
  /** Snapshot of the source's channel arrays at plan time — the staleness
   * test (`peaksCache.ts:16-22`'s identity convention), held WEAKLY.
   *
   * Weakly, because a stale session is deliberately never dropped (it stays
   * read-only so the panel can still say where the remix came from), and a
   * strong snapshot therefore pinned the ENTIRE PRE-EDIT source — ~105 MB for
   * a 5-minute stereo track — for the rest of the session. Those are the same
   * arrays `undoHistory`'s `MAX_UNDO_BYTES` eviction assumes it frees when it
   * shifts an entry out, so the pin also made the undo budget under-report.
   * Weak references cost the identity test nothing: while the session is
   * FRESH the live document holds the same arrays strongly, so `deref()`
   * always succeeds; while it is STALE, `deref()` succeeding is exactly the
   * condition under which an undo could still bring them back. */
  sourceChannelRefs: WeakRef<Float32Array>[];
  /** Cumulative nudge in bars per join, parallel to `session.plan.joins`, so
   * the `+/- floor(phraseBars/2)` bound is on the TOTAL displacement rather
   * than on one keystroke. Reset by every re-plan. */
  nudgeBars: number[];
  /** `null` when this session plans on the main thread. */
  planWorker: PlanWorkerHandle | null;
  /** `rollIndex -> result` within ONE option/rejection signature; cleared
   * whenever that signature changes, so it stays bounded by the number of
   * rolls actually tried. */
  planMemo: Map<number, PlanRemixResult>;
  planMemoSignature: string;
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

/**
 * The same identity test against a session's WEAKLY-held snapshot (see
 * `Entry.sourceChannelRefs`). `deref()` returning `undefined` is not a special
 * case: it can only happen once nothing else in the process references that
 * array — i.e. once the source edit can no longer be undone back to it — and
 * `undefined !== b[i]` correctly reports "not the audio this session was
 * planned against".
 */
function sameWeakChannelRefs(a: readonly WeakRef<Float32Array>[], b: Float32Array[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].deref() !== b[i]) return false;
  }
  return true;
}

function sameWeights(a: RemixWeights, b: RemixWeights): boolean {
  for (const key of WEIGHT_KEYS) {
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

function joinKey(from: number, to: number): string {
  return `${from}>${to}`;
}

function keysOf(joins: readonly RemixJoin[]): string[] {
  return joins.map((j) => joinKey(j.fromBar, j.toBar));
}

function showFailure(message: string): void {
  void window.electronAPI?.showMessageBox({
    type: 'error',
    title: 'Remix planning failed',
    message,
  });
}

/**
 * Recomputes `stale` against the LIVE source and, on the transition INTO
 * stale, terminates the session's plan worker.
 *
 * The worker had to go: a stale session answers `null` to every adjustment,
 * so nothing will ever ask it to plan again, yet it stayed resident for the
 * rest of the process — a live thread holding its own resident copy of the
 * ~1.7 MB analysis — because a stale session is (deliberately) never dropped.
 * Terminating is safe precisely because it is respawnable: `session.analysis`
 * is retained, so `liveEntry` re-spawns from it the moment the session
 * un-stales (undoing the source edit restores the same channel arrays), which
 * costs one `postMessage` of the analysis on the first adjustment after the
 * undo and nothing at all otherwise.
 */
function refreshStale(entry: Entry): boolean {
  const source = findDoc(entry.session.sourceDocId);
  const stale = !source || !sameWeakChannelRefs(entry.sourceChannelRefs, source.channels);
  if (stale && entry.planWorker) {
    killPlanWorker(entry.planWorker, null); // orderly, not a failure — no dialog
    entry.planWorker = null;
  }
  entry.session.stale = stale;
  return stale;
}

/** The one guard every adjustment opens with: a live, non-stale session whose
 * remix document is still open. Returns `null` (a silent no-op for the
 * caller) otherwise. */
function liveEntry(remixDocId: string): Entry | null {
  const entry = sessions.get(remixDocId);
  if (!entry) return null;
  if (!findDoc(remixDocId)) {
    // The remix document was closed without `closeDocumentFlow` (or by a
    // direct store call): drop the session — and its worker — rather than
    // leave it pinning the source's channel arrays.
    dropEntry(remixDocId, entry);
    bumpVersion();
    return null;
  }
  if (refreshStale(entry)) return null;
  // Un-stale again (the source edit was undone) after `refreshStale` had
  // already terminated the worker: respawn it from the retained analysis. No
  // main-thread fallback if that fails, for the same reason session creation
  // has none — it would trade a visible error for a multi-second freeze.
  if (entry.session.plansInWorker && !entry.planWorker) {
    entry.planWorker = spawnPlanWorker(entry.session.analysis);
    if (!entry.planWorker) return null;
  }
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
// The session-scoped plan worker
// ---------------------------------------------------------------------------

/**
 * `(numBars+1)*(Nmax+1)*2^K` — the exact table shape `remixPlan.ts` allocates,
 * INCLUDING R4b's subset axis.
 *
 * The `2^K` is the whole point of this function existing at this layer. A pin
 * is a hard constraint now, implemented as a bitmask axis on the DP, so the
 * table a given adjustment allocates depends on how many joins the user has
 * pinned — and the pre-R4b comparison, which only knew `(M+1)*(Nmax+1)`, would
 * not have noticed. Four pins is 16x: at the worst case reachable that is a
 * 12-million-cell, 144 MB table and (measured) 13x the DP time, on the main
 * thread, with no progress and no cancel. `remixPlan.ts` stays a pure module
 * that runs the DP it is asked to run; deciding WHERE it runs is this layer's
 * job, and R4b does not move that line, it only corrects the arithmetic on
 * this side of it.
 *
 * `K` is clamped to `MAX_REQUIRED_JOINS` because that is the largest subset
 * axis the planner can ever allocate — `1 << MAX_REQUIRED_JOINS` is a true
 * UPPER BOUND on the table, which is what a routing decision needs.
 *
 * It is deliberately NOT clamped to `2^0` above the cap, even though the
 * planner does degrade to `lockedJoins` semantics there and allocate the
 * K = 0 table (fix round 1, I6 — the comment here used to give that as the
 * reason for the clamp, which argues for the opposite clamp). The count
 * passed in is the RAW pin count, taken before the planner's own triage:
 * six pins of which two are rejected or congruence-illegal consume four bits,
 * not zero, so a `2^0` estimate above the cap would under-route exactly the
 * case that still allocates the biggest table. Over-routing costs a worker
 * handshake; under-routing freezes the window. The estimate is therefore an
 * upper bound in both directions, and `plansInWorker` promotion is one-way
 * anyway, so a shrinking estimate could not demote a session even if it were
 * right to.
 */
function dpCells(analysis: RemixAnalysis, maxRepeatFactor: number, requiredCount = 0): number {
  const M = analysis.numBars;
  const Nmax = Math.max(0, Math.round(M * maxRepeatFactor));
  const K = Math.min(Math.max(0, requiredCount), MAX_REQUIRED_JOINS);
  return (M + 1) * (Nmax + 1) * 2 ** K;
}

let planWorkerThreshold = MAX_DP_CELLS;

/** Test-only (this repo's `_xxxForTest` convention — `tempoAnalysis.ts`'s
 * `_promoteToRemixLevelForTest`, `remixPlan.ts`'s `_runRemixDPForTest`).
 * Lowers the `MAX_DP_CELLS` routing threshold so the worker route can be
 * exercised without a 10-minute fixture. `null` restores the real constant. */
export function _setPlanWorkerThresholdForTest(cells: number | null): void {
  planWorkerThreshold = cells ?? MAX_DP_CELLS;
}

/** Resolves every outstanding request with `null`, marks the handle dead and
 * terminates the worker. The single place the "promise always resolves"
 * contract is honoured for abnormal termination. */
function killPlanWorker(handle: PlanWorkerHandle, message: string | null): void {
  if (handle.dead) return;
  handle.dead = true;
  try {
    handle.worker.terminate();
  } catch {
    /* best-effort — nothing further to clean up */
  }
  const pending = [...handle.pending.values()];
  handle.pending.clear();
  for (const resolve of pending) resolve(null);
  if (message !== null) showFailure(message);
}

/** Spawns a plan worker and posts the analysis ONCE. Returns `null` (having
 * already surfaced the failure) when the worker cannot be created or the
 * `init` post throws — the caller then refuses rather than falling back to a
 * multi-second main-thread freeze. */
function spawnPlanWorker(analysis: RemixAnalysis): PlanWorkerHandle | null {
  let worker: Worker;
  try {
    worker = createRemixPlanWorker();
  } catch (err) {
    showFailure(err instanceof Error ? err.message : String(err));
    return null;
  }

  const handle: PlanWorkerHandle = {
    worker,
    pending: new Map(),
    nextRequestId: 1,
    latestRequestId: 0,
    dead: false,
  };

  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data as { type?: string; id?: number; result?: PlanRemixResult; message?: string };
    const id = msg?.id;
    if (typeof id !== 'number') return;
    const resolve = handle.pending.get(id);
    if (!resolve) return; // unknown or already-settled id — dropped
    handle.pending.delete(id);

    if (msg.type === 'planned') {
      // A reply for a superseded request must never be committed: the
      // session's rejections/locks/options have moved on since it was issued.
      resolve(id === handle.latestRequestId ? (msg.result as PlanRemixResult) : null);
      return;
    }
    if (msg.type === 'error') {
      showFailure(msg.message ?? 'Remix planner failed');
      resolve(null);
      return;
    }
    // Defensive, mirroring tempoAnalysis's own unexpected-reply branch.
    showFailure(`Unexpected remix planner reply: ${String(msg.type)}`);
    resolve(null);
  };

  worker.onerror = (ev: ErrorEvent) => {
    // A worker that fails to LOAD never reaches `onmessage` — without this
    // every pending promise would hang forever (the v1.4 lesson at
    // `effectRunner.ts:106-119`).
    killPlanWorker(handle, ev.message || 'Remix planner failed to load');
  };

  try {
    // NOT transferred — see `remixPlan.worker.ts`.
    worker.postMessage({ type: 'init', analysis });
  } catch (err) {
    killPlanWorker(handle, err instanceof Error ? err.message : String(err));
    return null;
  }

  return handle;
}

function requestWorkerPlan(handle: PlanWorkerHandle, options: PlanRemixOptions): Promise<PlanRemixResult | null> {
  if (handle.dead) return Promise.resolve(null);
  const id = handle.nextRequestId++;
  handle.latestRequestId = id;
  return new Promise<PlanRemixResult | null>((resolve) => {
    handle.pending.set(id, resolve);
    try {
      handle.worker.postMessage({ type: 'plan', id, options });
    } catch (err) {
      handle.pending.delete(id);
      killPlanWorker(handle, err instanceof Error ? err.message : String(err));
      resolve(null);
    }
  });
}

/** Drops a session: terminates its worker (silently — this is an orderly
 * shutdown, not a failure) and removes it from the map. */
function dropEntry(remixDocId: string, entry: Entry): void {
  if (entry.planWorker) killPlanWorker(entry.planWorker, null);
  sessions.delete(remixDocId);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function planOptionsFor(
  options: RemixOptions,
  rejected: readonly string[],
  locked: readonly string[],
  rollIndex: number
): PlanRemixOptions {
  return {
    targetSample: options.targetSample,
    weights: options.weights,
    phraseBars: options.phraseBars,
    strict: options.strict,
    allowRepeats: options.allowRepeats,
    maxRepeatFactor: options.maxRepeatFactor,
    exactLength: options.exactLength,
    // Plain arrays, not Sets: these values are structure-cloned to the worker.
    forbiddenJoins: [...rejected],
    // R4b: pins go in as `requiredJoins`, the HARD constraint — not
    // `lockedJoins`, which is the cost preference they used to be. The planner
    // itself falls back to `lockedJoins` semantics above `MAX_REQUIRED_JOINS`
    // and reports `mode: 'preference'` when it does, so this layer does not
    // need (and must not have) a second fallback of its own: two mechanisms
    // choosing when to guarantee is exactly how a guarantee stops being one.
    requiredJoins: [...locked],
    rollIndex,
  };
}

/** Everything the memo must key on besides `rollIndex`. `locked` is part of
 * the signature (fix round 2): pins change the PLAN — since R4b they
 * CONSTRAIN it — so a memo that ignored them would serve a plan computed
 * under a different pin set, which is now not merely suboptimal but a broken
 * promise. */
function memoSignature(options: RemixOptions, rejected: readonly string[], locked: readonly string[]): string {
  return JSON.stringify([
    options.targetSample,
    options.phraseBars,
    options.strict,
    options.allowRepeats,
    options.exactLength,
    options.maxRepeatFactor,
    WEIGHT_KEYS.map((k) => options.weights[k]),
    [...rejected].sort(),
    [...locked].sort(),
  ]);
}

/**
 * ONE plan: memo first, then this session's worker if it has one, else the
 * main thread. Resolves `null` ONLY when the worker failed (the dialog has
 * already been shown) — a planner REFUSAL is an `ok:false` result, not a
 * null.
 */
async function runPlan(
  entry: Entry,
  options: RemixOptions,
  rejected: readonly string[],
  locked: readonly string[],
  rollIndex: number
): Promise<PlanRemixResult | null> {
  const signature = memoSignature(options, rejected, locked);
  if (signature !== entry.planMemoSignature) {
    entry.planMemo.clear();
    entry.planMemoSignature = signature;
  }
  const hit = entry.planMemo.get(rollIndex);
  if (hit) return hit;

  // R4b: the routing decision is re-taken PER PLAN, not once per session. A
  // session is created with no pins, so its creation-time table is the K = 0
  // one; every pin the user adds afterwards doubles it. A session that
  // legitimately planned on the main thread at 60 000 cells is at 960 000 —
  // nearly 4x `MAX_DP_CELLS` — with four pins, and the old once-per-session
  // decision would have run that on the main thread.
  //
  // Promotion is ONE-WAY. Unpinning could in principle demote the session back
  // to the main thread, but terminating and respawning a worker (and re-posting
  // the ~1.7 MB analysis) on every pin toggle would cost far more than the
  // worker handshake it saves. Once a session has needed a worker it keeps it,
  // which is also what `plansInWorker` has always meant to the panel.
  if (!entry.planWorker && dpCells(entry.session.analysis, options.maxRepeatFactor, locked.length) > planWorkerThreshold) {
    const spawned = spawnPlanWorker(entry.session.analysis);
    // The dialog is already up (`spawnPlanWorker` surfaces its own failure).
    // Refuse rather than fall back to the main thread — that is the same
    // choice session creation makes, for the same reason: a multi-second
    // freeze immediately after telling the user something went wrong.
    if (!spawned) return null;
    entry.planWorker = spawned;
    entry.session.plansInWorker = true;
  }

  const planOptions = planOptionsFor(options, rejected, locked, rollIndex);
  const result = entry.planWorker
    ? await requestWorkerPlan(entry.planWorker, planOptions)
    : planRemix(entry.session.analysis, planOptions);
  if (result) entry.planMemo.set(rollIndex, result);
  return result;
}

/** `${from}>${to}` keys in `locked` that `plan` does NOT contain — the pins
 * this arrangement dropped. Surfaced on the session so T15 can say so rather
 * than leaving a pin badge lit on a join that is no longer there.
 *
 * Still derived from the PLAN rather than from `plan.requiredJoins.dropped`,
 * deliberately: the plan is the thing the user hears, and a pin badge must
 * follow it even in the paths that produce no report at all (`nudgeJoin`'s
 * hand-rebuilt plan, a `crossfadeMs` re-render of an existing arrangement).
 * The report says WHY; this says WHICH, and the two must agree — asserted by
 * test. */
function droppedLocks(plan: RemixPlan, locked: readonly string[]): string[] {
  const present = new Set(keysOf(plan.joins));
  return locked.filter((key) => !present.has(key));
}

/**
 * ONE plan, with pinned joins passed to the planner as `requiredJoins` — a
 * HARD CONSTRAINT since R4b, not the cost preference they were.
 *
 * A pin is now a guarantee: up to `MAX_REQUIRED_JOINS` of them, the returned
 * plan contains every pinned join or names the ones it could not and why
 * (forbidden / no-candidate / mutually incompatible). Above that cap the
 * PLANNER — not this layer — degrades to the old preference behaviour and
 * reports `mode: 'preference'`, which the panel states plainly. There is
 * deliberately no second fallback here; the one that used to live here (the
 * lock-recovery sweep, see the constant block above) was deleted for helping
 * 0 times in 89 runs, and re-adding one would put two different pieces of code
 * in charge of when a promise applies.
 *
 * `locksKept`/`rollIndexUsed` are reported so the panel can tell the user a
 * pin was dropped instead of silently lying about it.
 *
 * `rollIndexUsed` is now always the REQUESTED index — the sweep that could
 * make it differ is gone (see the constant block above) — but it is kept as
 * the plan's own provenance so the field the session records stays honest if
 * that ever changes again.
 */
async function planWithLocks(
  entry: Entry,
  options: RemixOptions,
  rejected: readonly string[],
  locked: readonly string[],
  rollIndex: number
): Promise<{ result: PlanRemixResult; rollIndexUsed: number; locksKept: number } | null> {
  const result = await runPlan(entry, options, rejected, locked, rollIndex);
  if (!result) return null;
  const locksKept = result.ok ? locked.length - droppedLocks(result, locked).length : 0;
  return { result, rollIndexUsed: rollIndex, locksKept };
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
 * `applyEdit('Remix', ...)` plus (when there is a marker change to record)
 * ONE `pushMarkerUndo('Remix Markers', ...)` — see the module doc comment for
 * why that is normally two entries, and when it is one.
 *
 * RE-CHECKS STALENESS (fix round 1): a plan can now be awaited from a worker,
 * and the source document may have been edited or closed in the meantime. A
 * resident worker analysis must never become a way to render an arrangement
 * against audio the live `sourceChannelRefs` no longer match.
 *
 * `renderRemix` is called WITHOUT a try/catch on purpose: it throws only when
 * `plan.outputSample` disagrees with its own segments, and `joinCost` throws
 * `RangeError` only for an out-of-domain bar index. Both are programming
 * errors in THIS module, not user-facing conditions, and swallowing them
 * would hide exactly the class of bug the checks exist to catch (T12/T10
 * carry-forward).
 */
function commitPlan(entry: Entry, plan: RemixPlan, lockedForReport?: readonly string[]): RemixPlan | null {
  const { remixDocId, sourceDocId, analysis, options } = entry.session;
  const source = findDoc(sourceDocId);
  const remixDoc = findDoc(remixDocId);
  if (!source || !remixDoc) {
    refreshStale(entry);
    return null;
  }
  // Routed through `refreshStale` (rather than an inline identity test) so the
  // commit-time refusal ALSO terminates the plan worker — this is a transition
  // into stale exactly like the one `liveEntry` sees.
  if (refreshStale(entry)) return null;

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
  // This is also why the entry count per adjustment is 2 OR 1 — see the
  // module doc comment.
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
  entry.session.lockedJoinsDropped = droppedLocks(plan, lockedForReport ?? entry.session.lockedJoins);
  // `plan.requiredJoins` is present exactly when this plan was made WITH pins
  // (R4b makes the field absent otherwise, which is what keeps an unpinned
  // plan byte-identical to the pre-R4b one). `nudgeJoin`'s hand-built plan and
  // a pure re-render both carry no report, and must not silently clear a real
  // one — but they also cannot invent one, so the previous report stands only
  // when there are still pins to report on.
  //
  // `lockedForReport`, NOT `entry.session.lockedJoins` (fix round 1, C1):
  // `replanAndCommit` assigns the session's `lockedJoins` only AFTER this
  // function returns, so reading the session here reads the PRE-update set.
  // "Revert to auto" on a 5-pin preference plan would then keep the stale
  // report and the panel would say "More than 4 pins… unpin down to 4" on an
  // arrangement with no pins at all — a loudly downgraded guarantee that is
  // not actually downgraded, which is the same dishonesty as a silent one
  // pointing the other way. The line above already reads `lockedForReport`
  // for exactly this reason.
  const lockedNow = lockedForReport ?? entry.session.lockedJoins;
  entry.session.pinReport = plan.requiredJoins ?? (lockedNow.length > 0 ? entry.session.pinReport : null);
  bumpVersion();
  return plan;
}

/** Shared tail of every re-PLANNING adjustment: plan, commit, and only then
 * mutate the session's own bookkeeping. A failed plan leaves the session (and
 * the document) exactly as it was and is handed back so the caller can
 * surface `minOutputSample`/`maxOutputSample`.
 *
 * ORDER MATTERS (fix round 2): the bookkeeping writes land AFTER a successful
 * `commitPlan`, never before. `commitPlan` can still refuse — its staleness
 * re-check runs after the plan await — and writing `rejectedJoins`/
 * `lockedJoins`/`rollIndex` first would leave the session claiming a
 * rejection its own `plan` does not reflect. */
async function replanAndCommit(
  entry: Entry,
  next: { rejected: string[]; locked: string[]; rollIndex: number }
): Promise<PlanRemixResult | null> {
  const outcome = await planWithLocks(entry, entry.session.options, next.rejected, next.locked, next.rollIndex);
  if (!outcome) return null; // worker failure — the dialog is already up
  if (!outcome.result.ok) return outcome.result;

  const committed = commitPlan(entry, outcome.result, next.locked);
  if (!committed) return null;

  entry.session.rejectedJoins = next.rejected;
  entry.session.lockedJoins = next.locked;
  entry.session.rollIndex = outcome.rollIndexUsed;
  entry.session.manual = false;
  entry.nudgeBars = outcome.result.joins.map(() => 0);
  return committed;
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
 * choreography) and reported here as `status: 'analysis-failed'`; a plan
 * worker failure is `status: 'plan-failed'`; planning refusals pass
 * `PlanRemixResult`'s own `reason`/`message` straight through so a dialog can
 * clamp its input from `minOutputSample`/`maxOutputSample` next time.
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

  // The CREATION-time routing decision, taken at zero pins because a session
  // is always created without any. It is not the last word: `runPlan` re-takes
  // it on every subsequent plan, since each pin doubles the table and can
  // promote the session to a worker mid-life (see the module doc comment,
  // "A pin is a guarantee, and its cost is a bigger table").
  const plansInWorker = dpCells(analysis, options.maxRepeatFactor) > planWorkerThreshold;
  let planWorker: PlanWorkerHandle | null = null;
  if (plansInWorker) {
    planWorker = spawnPlanWorker(analysis);
    if (!planWorker) {
      return { ok: false, status: 'plan-failed', message: 'The remix planner worker could not be started.' };
    }
  }

  const planOptions = planOptionsFor(options, [], [], 0);
  const plan = planWorker
    ? await requestWorkerPlan(planWorker, planOptions)
    : planRemix(analysis, planOptions);
  if (!plan) {
    if (planWorker) killPlanWorker(planWorker, null);
    return { ok: false, status: 'plan-failed', message: 'The remix planner did not return a plan.' };
  }
  if (!plan.ok) {
    if (planWorker) killPlanWorker(planWorker, null);
    return { ok: false, status: plan.reason, message: plan.message };
  }

  // The source can have changed while the plan was in flight (worker route).
  const liveSource = findDoc(req.sourceDocId);
  if (!liveSource || !sameChannelRefs(source.channels, liveSource.channels)) {
    if (planWorker) killPlanWorker(planWorker, null);
    return { ok: false, status: 'analysis-failed', message: 'The source audio changed during planning.' };
  }

  // EVERYTHING from here to `sessions.set` runs AFTER the last `killPlanWorker`
  // guard and BEFORE the session that owns `planWorker` exists — so a throw in
  // this window leaves a live worker thread that nothing can reach to
  // terminate. It is a reachable window, not a theoretical one: `renderRemix`
  // throws on its own entry-side identity check (`remixRender.ts:566`, `:776`)
  // and allocates the output (up to ~690 MB, `:571`) right after, and the
  // caller (`RemixDialog.tsx:370-394`) has a try/finally with NO catch — so
  // the user sees nothing and every retry adds another thread. Terminate, then
  // rethrow: the throw itself is a programming error in this module and must
  // stay visible (see `commitPlan`'s comment on why `renderRemix` is otherwise
  // uncaught).
  try {
    const render = renderRemix(liveSource.channels, analysis, plan, {
      sampleRate: liveSource.sampleRate,
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
      sampleRate: liveSource.sampleRate,
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
        sourceDocId: liveSource.id,
        sourceName: liveSource.name,
        options,
        analysis,
        plan,
        joinSamples: render.joinSamples,
        nudgeSamples: render.nudgeSamples,
        rhos: render.rhos,
        shapes: render.shapes,
        rejectedJoins: [],
        lockedJoins: [],
        lockedJoinsDropped: [],
        // A brand-new session has no pins, so there is nothing to report yet
        // — and `null` is a different fact from "reported, nothing dropped".
        pinReport: null,
        rollIndex: 0,
        manual: false,
        plansInWorker,
        stale: false,
      },
      sourceChannelRefs: liveSource.channels.map((c) => new WeakRef(c)),
      nudgeBars: plan.joins.map(() => 0),
      planWorker,
      planMemo: new Map([[0, plan as PlanRemixResult]]),
      planMemoSignature: memoSignature(options, [], []),
    });
    bumpVersion();

    return { ok: true, remixDocId: doc.id, plan };
  } catch (err) {
    if (planWorker) killPlanWorker(planWorker, null);
    throw err;
  }
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
 * merely re-renders) the remix document. Resolves with the resulting
 * `PlanRemixResult` — including the `ok: false` arm, so a dialog can clamp
 * its target from `minOutputSample`/`maxOutputSample` — or `null` when there
 * is no live, non-stale session, or the plan worker failed.
 *
 * `weights` is compared FIELD BY FIELD, not by reference (fix round 1):
 * building the options object in a React render is the natural idiom, and an
 * `Object.is` comparison would make every value-identical `{...weights}` force
 * a full re-plan — silently discarding the user's nudges and charging two
 * extra undo entries on something as innocent as a crossfade slider tick.
 *
 * A failed re-plan is fully atomic: the options are restored and neither the
 * document nor the session is touched.
 */
export async function updateRemixSession(
  remixDocId: string,
  patch: Partial<RemixOptions>
): Promise<PlanRemixResult | null> {
  const entry = liveEntry(remixDocId);
  if (!entry) return null;

  const previous = entry.session.options;
  const needsReplan =
    REPLAN_KEYS.some((key) => key in patch && !Object.is(patch[key], previous[key])) ||
    (patch.weights !== undefined && !sameWeights(patch.weights, previous.weights));
  const options: RemixOptions = { ...previous, ...patch };
  entry.session.options = options;

  // Restore `previous` ONLY if nothing else has moved the options on since —
  // two rapid `updateRemixSession` calls (a slider dragged fast) otherwise
  // let the FIRST one's rollback clobber the SECOND one's accepted value.
  const rollback = (): void => {
    if (entry.session.options === options) entry.session.options = previous;
  };

  if (!needsReplan) {
    // Same arrangement, new render parameters. A manual (nudged) plan
    // survives, which is the whole reason `crossfadeMs` is not a replan key.
    const committed = commitPlan(entry, entry.session.plan);
    if (!committed) {
      rollback();
      return null;
    }
    return committed;
  }

  const outcome = await planWithLocks(
    entry,
    options,
    entry.session.rejectedJoins,
    entry.session.lockedJoins,
    entry.session.rollIndex
  );
  if (!outcome || !outcome.result.ok) {
    rollback();
    return outcome ? outcome.result : null;
  }
  // Bookkeeping AFTER a successful commit — see `replanAndCommit`.
  const committed = commitPlan(entry, outcome.result);
  if (!committed) {
    rollback();
    return null;
  }
  entry.session.rollIndex = outcome.rollIndexUsed;
  entry.session.manual = false;
  entry.nudgeBars = outcome.result.joins.map(() => 0);
  return committed;
}

/**
 * Forbids `${from}>${to}` for good and re-plans around it ("that one edit
 * sounds wrong, find another way to hit the same length"). Any LOCK on the
 * same join is dropped in the same step — a key that is simultaneously
 * forbidden and required is a direct contradiction, and the planner would
 * (correctly) report it as `dropped: 'forbidden'` on every subsequent plan.
 * Dropping the pin here means the user is never shown a permanent complaint
 * about a contradiction they resolved by rejecting the join.
 */
export async function rejectJoin(remixDocId: string, key: string): Promise<PlanRemixResult | null> {
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
 * Pins / unpins a join. Synchronous and never re-renders (the brief lists
 * 'lock' among the re-render triggers — reported as a spec problem): locking
 * a join that is already IN the current arrangement cannot change that
 * arrangement, so a re-render would rewrite the document to identical audio
 * and charge the user two undo entries for it. Locks only take effect on the
 * NEXT re-plan; see `planWithLocks` for exactly how strong that effect is.
 *
 * Returns a DISCRIMINATED result (fix round 1) so a panel can distinguish
 * "no session" / "stale" / "not a join of this plan" / "you already have 8
 * pins" instead of getting one undifferentiated `null`.
 */
export function toggleLockJoin(remixDocId: string, key: string): ToggleLockResult {
  const entry = sessions.get(remixDocId);
  if (!entry || !findDoc(remixDocId)) return { ok: false, reason: 'no-session' };
  if (refreshStale(entry)) return { ok: false, reason: 'stale' };

  const index = entry.session.lockedJoins.indexOf(key);
  if (index >= 0) {
    entry.session.lockedJoins.splice(index, 1);
    bumpVersion();
    return { ok: true, locked: false, lockedJoins: entry.session.lockedJoins.slice() };
  }
  if (!keysOf(entry.session.plan.joins).includes(key)) return { ok: false, reason: 'unknown-join' };
  if (entry.session.lockedJoins.length >= MAX_LOCKED_JOINS) return { ok: false, reason: 'limit-reached' };
  entry.session.lockedJoins.push(key);
  bumpVersion();
  return { ok: true, locked: true, lockedJoins: entry.session.lockedJoins.slice() };
}

/**
 * Moves a join `deltaBars` bars through the song by shifting `fromBar` AND
 * `toBar` together, so the arrangement keeps emitting exactly the same NUMBER
 * of bars. Bounded to a cumulative `+/- floor(phraseBars/2)` bars per join
 * (T15's own `+/-Phi/2`), and refused outright when the shift would produce
 * an illegal arrangement (a zero-length segment, or a bar outside
 * `[0, numBars]`).
 *
 * Never runs the DP (the plan is rebuilt directly from the moved join list),
 * so it is instant regardless of track length — but it is `async` like the
 * other four adjustments so a caller cannot get the sync/async-ness of an
 * adjustment wrong.
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
 * COUNT; the duration moves only by that inter-bar drift.
 */
export async function nudgeJoin(
  remixDocId: string,
  key: string,
  deltaBars: number
): Promise<PlanRemixResult | null> {
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
 * Deterministic next-best arrangement: advances past the roll index the
 * CURRENT plan was produced at and re-plans (see `remixPlan.ts`'s "Re-roll" —
 * penalise the previous rolls' joins, never randomised jitter, so two
 * identically-seeded sessions re-roll identically). A no-op resolving `null`
 * when the current plan has no joins to vary.
 *
 * "Nothing to vary" now includes EVERY join being pinned (fix round 2): a
 * pinned key is exempt from the roll penalty, so with all of them pinned the
 * penalty map for the next roll is empty and `planRemix(rollIndex+1)` is
 * provably identical to the plan already on screen. Refusing is honest; a
 * visibly dead press is not.
 */
export async function reRollRemix(remixDocId: string): Promise<PlanRemixResult | null> {
  const entry = liveEntry(remixDocId);
  if (!entry) return null;
  const keys = keysOf(entry.session.plan.joins);
  if (keys.length === 0) return null;
  if (keys.every((key) => entry.session.lockedJoins.includes(key))) return null;

  return replanAndCommit(entry, {
    rejected: entry.session.rejectedJoins.slice(),
    locked: entry.session.lockedJoins.slice(),
    rollIndex: entry.session.rollIndex + 1,
  });
}

/** 'Revert to auto': drops every rejection, lock, nudge and roll and returns
 * the plain automatic plan for the session's current options. */
export async function resetRemix(remixDocId: string): Promise<PlanRemixResult | null> {
  const entry = liveEntry(remixDocId);
  if (!entry) return null;
  return replanAndCommit(entry, { rejected: [], locked: [], rollIndex: 0 });
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

/**
 * Drops every session that involves `docId` — as the REMIX document or as its
 * SOURCE — terminating each one's plan worker. MANDATORY in
 * `closeDocumentFlow` for both: without it the whole `RemixAnalysis` (and, for
 * a session that has not yet been observed stale, a live Worker holding its
 * own resident copy of it) stays retained for the rest of the session — the
 * same leak class `peaksCache`/`clipWaveformCache`/`tempoAnalysis` already
 * manage. (`sourceChannelRefs` are weak, so they are no longer part of that
 * list; every other reason to drop the session still stands.)
 *
 * Named `invalidateRemixSession`, not `invalidateRemix`, so it cannot be
 * confused with `tempoAnalysis.invalidateRemix`, which drops the cached
 * remix-level ANALYSIS row (a different layer). Both must run on close.
 */
export function invalidateRemixSession(docId: string): void {
  let removed = false;
  for (const [remixDocId, entry] of sessions) {
    if (remixDocId === docId || entry.session.sourceDocId === docId) {
      dropEntry(remixDocId, entry);
      removed = true;
    }
  }
  if (removed) bumpVersion();
}

/** Drops every session and terminates every plan worker — test isolation
 * only, paired with `invalidateRemixSession`. */
export function clearAllRemix(): void {
  for (const [remixDocId, entry] of sessions) dropEntry(remixDocId, entry);
  sessions.clear();
  bumpVersion();
}
