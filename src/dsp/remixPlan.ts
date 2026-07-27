/**
 * Remix planner (v1.5, T11): the 2-D lattice DP that turns a `RemixAnalysis`
 * plus a target duration into a concrete sequence of bar segments and joins,
 * a hard feasibility window (not a weighted duration term), reachability
 * bounds, deterministic re-roll and the over-repetition guard. Pure,
 * synchronous -- no DSP of its own, consumes `remixCost.ts`'s `joinCost`/
 * `buildCandidateLists` directly.
 *
 * ## The lattice, in one picture
 *
 * `M = numBars`, `p in [0..M]` = "next bar to play", `n in [0..Nmax]` =
 * "bars emitted so far". `f(0,0) = 0`. Two edge kinds, BOTH strictly
 * increasing `n` (this is what makes a single ascending-`n` sweep a valid
 * topological order even though a "repeat" jump can *decrease* `p`):
 * - continue: `f(p,n) -> f(p+1,n+1)`, cost 0, for `p < M`.
 * - jump: `f(p,n) -> f(b+R,n+R)`, cost `joinCost(p,b).total + weights.jump`,
 *   for every `b` in `cand[p]` (`buildCandidateLists` already guarantees
 *   `b+R <= M`, checked again defensively here -- see "OUT-OF-BOUNDS" below).
 *
 * `R = minRunBars` (`phraseBars` in strict mode, `4` in loose mode) is
 * FORCE-EMITTED on landing -- the jump edge alone enforces "no two joins
 * closer than `R` bars" without a third "bars since last join" state axis.
 *
 * ## Why the DP sweeps `n`, not `p`
 *
 * A naive implementation might process states in ascending `p` (continue
 * edges only ever increase `p` by 1, so that looks like the natural
 * "forward" direction). That is WRONG the moment `allowRepeats` admits a
 * backward jump (`to < from`): the jump's destination `b+R` can be LESS than
 * the source `p`, so a `p`-ascending sweep would already have finalised (and
 * moved past) states the backward jump needs to relax. Every edge -- continue
 * or jump -- strictly increases `n` (continue by 1, jump by `R >= 1`), so
 * sweeping `n` ascending is a genuine topological order regardless of which
 * direction `p` moves. This is the one property that makes "repeat" joins
 * (essential for the over-repetition scenario T11 must guard against) safe
 * to relax in a single forward pass instead of a full shortest-path
 * algorithm.
 *
 * ## Termination is a HARD FEASIBILITY WINDOW, not a weighted duration term
 *
 * Every valid plan runs off the end of the lattice at `p = M` (there is no
 * other absorbing state -- `buildCandidateLists`'s edge guard makes `p = M`
 * itself candidate-free, so nothing ever departs from it). `n* =
 * argmin f(M,n)` over `{n : abs(n-targetBars) <= tolBars}`
 * (`tolBars = ceil(phraseBars/2)` strict, `2` loose -- the grid step IS
 * `phraseBars` bars in strict mode, so half a step is the tightest
 * meaningful tolerance). This deliberately drops a `wDuration` weight
 * entirely: calibrating bars-of-error against cost-units is exactly the kind
 * of magic number that can only be judged by ear, whereas "filter to
 * feasible, then minimise cost" needs no such calibration. If the window is
 * EMPTY, fall back to the reachable `n` closest to `targetBars` and report
 * the achieved length via `reason`/`message` (`ok: false`, never a
 * best-effort `ok: true`) -- see "Refusals" below.
 *
 * `targetBars` itself is only ever an ESTIMATE (`(targetSample-headLen-
 * tailLen)/avgBarLen`, `avgBarLen` the analysis's own mean bar length) used
 * to size `Nmax` and the window -- it is NEVER used to compute a reported
 * duration. Every duration this module reports (`outputSample`,
 * `minOutputSample`, `maxOutputSample`) is summed from the ACTUAL
 * `barBoundary` samples of the actually-reconstructed path, so drift-varying
 * bar lengths never leak an error into the reported numbers, only (at most)
 * into which `n` gets selected -- and the tolerance window exists precisely
 * to absorb that.
 *
 * ## Reachability falls out of the same finished table for free
 *
 * `minOutputSample`/`maxOutputSample` are the smallest/largest `n` with
 * finite `f(M,n)`, converted through the ACTUAL reconstructed segments for
 * those two specific `n` (never `n*avgBarLen`) -- no separate computation,
 * just two more reconstructions of a table that was going to be built
 * anyway. They are ALWAYS populated, even on failure (`ok: false`), so a
 * calling dialog can clamp its input and mostly PREVENT the failure rather
 * than merely report it.
 *
 * ## Refusals computed BEFORE the DP, where possible
 *
 * `tempoConfidence < CONFIDENCE_LOW` -> `'no-tempo'`; `numBars < 2*phraseBars
 * + 2` -> `'too-short'`; `targetSample > maxRepeatFactor*lengthSample` ->
 * `'too-long'`. None of these three touch `buildCandidateLists`/`joinCost`
 * at all (verified by a dedicated spy-based test) -- there is no meaningful
 * reachability to report for them, so `minOutputSample`/`maxOutputSample`
 * both fall back to the one length ALWAYS known without running anything:
 * the trivial straight-through play, `analysis.analyzedEndSample` (every
 * continue edge is unconditional, so "play everything, no joins" is always
 * conceptually valid regardless of confidence/length -- we just never
 * reach it structurally when refusing up front). The POST-DP empty-window
 * fallback (`'too-short'`/`'too-long'` again, but this time from a real,
 * exact table) and a completely unreachable terminal state (`'no-path'`,
 * candidates too constrained to ever reach `p=M` within `Nmax`) use the
 * exact reachable min/max instead once the table exists; `'no-path'` has no
 * reachable state to measure from at all, so it uses the same trivial
 * straight-through fallback as the up-front refusals (a documented choice,
 * not a silent guess -- see the task report).
 *
 * ## OUT-OF-BOUNDS defence in depth
 *
 * `buildCandidateLists` already guarantees `b + minRunBars <= numBars` for
 * every candidate it emits (T10, verified over 77k pairs) -- but T10's own
 * review also measured a config (`edgeGuardBars: 0`) where the trailing
 * extrapolated boundary becomes cheap and reachable. This module never
 * overrides `edgeGuardBars` itself (leaves it `undefined` unless the caller
 * sets it, so `buildCandidateLists`'s own default of `1` is the one that
 * actually applies) and additionally re-checks `landing <= M` and `newN <=
 * Nmax` inline before every jump relaxation, purely as defence in depth --
 * so a future regression in `buildCandidateLists` (or a caller supplying its
 * own hand-built candidate lists, as T11's own acceptance tests do) can
 * never write outside the `(M+1)*(Nmax+1)` table.
 *
 * ## Reconstruction is deterministic, no RNG anywhere
 *
 * Ties are broken toward the LOWER predecessor `p`, then the lower
 * predecessor `n` (an explicit comparison against the currently-recorded
 * predecessor, not an incidental artefact of loop order -- see `relax`).
 * `agglomerativeCluster`/`buildCandidateLists` already avoid `Math.random()`
 * (T9/T10); this module adds none either.
 *
 * ## Re-roll: deterministic next-best, not jitter
 *
 * `rollIndex` (default 0) re-derives rolls `0..rollIndex-1` FROM SCRATCH
 * (same analysis/options, increasing penalty), unions each roll's own joins
 * into a `+JOIN_PENALTY` cost bump keyed `${from}>${to}`, then plans
 * `rollIndex` under the accumulated penalty. This is a pure, stateless
 * design specifically so `planRemix` alone -- with no caller-held history --
 * is deterministic: two calls with the same `rollIndex` produce
 * byte-identical plans, and NOT randomised jitter, which (per the brief)
 * would scale perturbation WITH cost and so perturb bad joins hardest,
 * risking promoting a bad join above a good one, and would make any
 * determinism assertion flaky.
 *
 * ## Over-repetition guard
 *
 * The lattice has no memory of how many times a given SOURCE bar index was
 * played, so an aggressive lengthening can legitimately find that looping
 * one favoured phrase is the cheapest way to hit the target. Post-check: if
 * any bar index appears more than `MAX_USE_COUNT` times in the reconstructed
 * path, re-run with THAT path's own joins penalised `+JOIN_PENALTY` (on a
 * COPY of the roll-level penalty map -- these extra bumps are scoped to
 * fixing over-repetition within this one roll's attempt and never leak into
 * the next `rollIndex`'s base penalty), up to `MAX_REPETITION_ITERATIONS`
 * further iterations, then accept the best attempt seen (fewest bar-index
 * over-uses, ties broken by lowest recomputed cost) -- a heuristic, but
 * bounded and fully deterministic.
 *
 * ## Exact length: overshoot-and-trim selection only
 *
 * `exactLength: true` replaces the tolBars-window selection with "smallest
 * reachable `n` whose ACTUAL sample sum is `>= targetSample`" -- the
 * OVERSHOOT this module reports is deliberately left untrimmed. How large
 * that overshoot can be depends on how densely `n` is reachable near the
 * target: in LOOSE mode (or any config where legal repeat/deletion
 * distances aren't restricted to multiples of `phraseBars`) the reachable
 * set is dense and overshoot is typically under one bar; in STRICT mode
 * every legal distance is a multiple of `phraseBars` (congruence), so every
 * reachable `n` at `p=M` is congruent to `M` modulo `phraseBars` too, and
 * overshoot can be as large as `phraseBars-1` bars in the worst case
 * (measured: ~1.5 bars at `phraseBars=8` in one evidence run -- see the task
 * report). The actual sample-exact trim (with a 5 ms fade) is T12's job at
 * render time,
 * never a WSOLA micro-stretch here or there (T12's own doc comment has the
 * full argument -- `computeOffsets` runs its full similarity search
 * regardless of ratio, so a "harmless" 2% correction would re-smear every
 * splice this planner just optimised).
 *
 * ## `MAX_DP_CELLS` is exported, not enforced, here
 *
 * The brief specifies routing to a worker above `(M+1)*(Nmax+1) >
 * MAX_DP_CELLS`. That is an ORCHESTRATION decision (main thread vs worker),
 * not something a pure planning function can make about itself -- this
 * module always runs the DP it is asked to run. `MAX_DP_CELLS` is exported
 * purely so the service layer that owns that choice (T13) has one canonical
 * constant to compare against, matching this module's own
 * `(numBars+1)*(Nmax+1)` table shape exactly.
 */

import type { RemixAnalysis } from './remixFeatures';
import { joinCost, buildCandidateLists, clusterMemberCounts } from './remixCost';
import type { RemixWeights, JoinCostTerms, CandidateListOptions } from './remixCost';
import { CONFIDENCE_LOW } from './tempoCore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** `Nmax = min(round(numBars*maxRepeatFactor), targetBars+phraseBars)` default. */
export const DEFAULT_MAX_REPEAT_FACTOR = 3;
/** Over-repetition guard threshold: a bar index used more than this many
 * times in the reconstructed path triggers a penalised re-run. */
export const MAX_USE_COUNT = 3;
/** Fixed cost bump applied per offending/previous-roll join, both by the
 * over-repetition guard and by re-roll. */
export const JOIN_PENALTY = 2.0;
/** Bound on the guard's penalised re-run loop (in ADDITION to the initial,
 * unpenalised attempt). */
export const MAX_REPETITION_ITERATIONS = 3;
/** `(numBars+1)*(Nmax+1)` states above which the caller should route
 * planning to a worker instead of the main thread. Exported for the
 * orchestration layer (T13); not enforced inside this pure module. */
export const MAX_DP_CELLS = 250_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RemixSegment {
  /** Sample, inclusive -- `analysis.barBoundary[startBar]`. */
  start: number;
  /** Sample, exclusive -- `analysis.barBoundary[endBar]`. */
  end: number;
}

export interface RemixJoin {
  fromBar: number;
  toBar: number;
  /** Fresh, UNPENALISED per-term breakdown for this exact pair -- re-roll's
   * and the repetition guard's synthetic cost bumps never appear here; this
   * is purely `joinCost(analysis, weights, phraseBars, fromBar, toBar)`, for
   * the panel's own tooltip (T13/T14). */
  cost: JoinCostTerms;
}

export interface PlanRemixOptions {
  /** Desired output length, in samples. */
  targetSample: number;
  weights: RemixWeights;
  /** Phi -- bars per phrase. Normalised to `max(1, floor(phraseBars))`
   * internally, matching `remixCost.ts`'s own normalisation. */
  phraseBars: number;
  /** Hard `from === to (mod phraseBars)` congruence; also selects
   * `minRunBars = phraseBars` (vs `4` loose). Required -- a caller-facing
   * mode switch, not a DSP-internal tuning constant (matches
   * `CandidateListOptions`'s own undefaulted `strict`). */
  strict: boolean;
  /** Required -- see `strict`'s doc comment; matches
   * `CandidateListOptions.allowRepeats`. */
  allowRepeats: boolean;
  /** Default `DEFAULT_MAX_REPEAT_FACTOR` (3). */
  maxRepeatFactor?: number;
  /** Passed straight through to `buildCandidateLists`; left `undefined`
   * unless the caller explicitly overrides it, so THAT module's own default
   * of `1` is the one that actually applies (see the module doc comment,
   * "OUT-OF-BOUNDS defence in depth"). */
  edgeGuardBars?: number;
  minKeepBars?: number;
  maxRepeatBars?: number;
  /** `${from}>${to}` keys illegal regardless of cost (e.g. a rejected join). */
  forbiddenJoins?: Iterable<string>;
  /** Deterministic next-best re-roll. `0` (default) = the plain best plan.
   * `>= 1` re-derives rolls `0..rollIndex-1` first and penalises the union of
   * their joins before planning `rollIndex`. See the module doc comment. */
  rollIndex?: number;
  /** Overshoot-to-next-reachable-then-trim selection. Opt-in, default
   * `false`. See the module doc comment, "Exact length". */
  exactLength?: boolean;
}

export type PlanRemixResult =
  | {
      ok: true;
      segments: RemixSegment[];
      joins: RemixJoin[];
      outputSample: number;
      targetSample: number;
      totalCost: number;
      minOutputSample: number;
      maxOutputSample: number;
    }
  | {
      ok: false;
      reason: 'no-tempo' | 'too-short' | 'too-long' | 'no-path';
      minOutputSample: number;
      maxOutputSample: number;
      message: string;
    };

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function normalizePhraseBars(phraseBars: number): number {
  return Math.max(1, Math.floor(phraseBars));
}

function joinKey(from: number, to: number): string {
  return `${from}>${to}`;
}

// ---------------------------------------------------------------------------
// The DP table
// ---------------------------------------------------------------------------

interface DPTable {
  M: number;
  Nmax: number;
  width: number; // Nmax + 1
  cost: Float64Array; // (M+1)*width, Infinity = unreached
  /** `predecessorState*2 + isJump`, `-1` = no predecessor (only state (0,0)). */
  parent: Int32Array;
}

/**
 * Runs the forward DP once, sweeping `n` ascending (see the module doc
 * comment for why `n`, not `p`, is the valid topological order). `baseCosts`
 * is `joinCost(...).total` precomputed ONCE per `planRemix` call, parallel to
 * `candidates` -- it never changes across rolls/guard iterations, only
 * `penalty` does, so this avoids recomputing `joinCost` up to `O(Nmax)`
 * redundant times per candidate pair.
 *
 * Exported as `_runRemixDPForTest` (not a supported public API) so
 * acceptance tests can inspect `cost`/`parent` directly -- e.g. asserting no
 * entry ever decodes to a state `>= (M+1)*(Nmax+1)`.
 */
function runRemixDP(
  candidates: Int32Array[],
  baseCosts: Float64Array[],
  jumpToll: number,
  penalty: ReadonlyMap<string, number>,
  M: number,
  Nmax: number,
  minRunBars: number
): DPTable {
  const width = Nmax + 1;
  const size = (M + 1) * width;
  const cost = new Float64Array(size).fill(Infinity);
  const parent = new Int32Array(size).fill(-1);
  const at = (p: number, n: number): number => p * width + n;
  cost[at(0, 0)] = 0;

  function relax(destIdx: number, newCost: number, predIdx: number, isJump: boolean): void {
    const cur = cost[destIdx];
    if (newCost < cur) {
      cost[destIdx] = newCost;
      parent[destIdx] = predIdx * 2 + (isJump ? 1 : 0);
      return;
    }
    if (newCost === cur && parent[destIdx] >= 0) {
      // Tie-break: lower predecessor p, then lower predecessor n (module doc
      // comment, "Reconstruction is deterministic") -- an explicit
      // comparison against the RECORDED predecessor, not an artefact of
      // sweep order.
      const curPred = Math.floor(parent[destIdx] / 2);
      const curP = Math.floor(curPred / width);
      const curN = curPred % width;
      const newP = Math.floor(predIdx / width);
      const newN = predIdx % width;
      if (newP < curP || (newP === curP && newN < curN)) {
        parent[destIdx] = predIdx * 2 + (isJump ? 1 : 0);
      }
    }
  }

  for (let n = 0; n < Nmax; n++) {
    for (let p = 0; p <= M; p++) {
      const srcIdx = at(p, n);
      const cur = cost[srcIdx];
      if (!Number.isFinite(cur)) continue;

      if (p < M) {
        relax(at(p + 1, n + 1), cur, srcIdx, false);
      }

      const cand = candidates[p];
      if (cand && cand.length > 0) {
        const costs = baseCosts[p];
        for (let i = 0; i < cand.length; i++) {
          const b = cand[i];
          const landing = b + minRunBars;
          const newN = n + minRunBars;
          // Defence in depth -- see the module doc comment,
          // "OUT-OF-BOUNDS defence in depth". `buildCandidateLists` already
          // guarantees this, but a relaxation must never write outside the
          // table regardless.
          if (landing > M || newN > Nmax) continue;
          const extra = penalty.get(joinKey(p, b)) ?? 0;
          const edgeCost = costs[i] + jumpToll + extra;
          relax(at(landing, newN), cur + edgeCost, srcIdx, true);
        }
      }
    }
  }

  return { M, Nmax, width, cost, parent };
}

/** Test-only export -- see `runRemixDP`'s own doc comment. Not a supported
 * public API, following this repo's `_xxxForTest` convention
 * (`remixFeatures.ts`'s `_resampleOdfBarPeakForTest`). */
export const _runRemixDPForTest = runRemixDP;

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

interface ReconstructedPath {
  segmentsBar: { startBar: number; endBar: number }[];
  barJoins: { fromBar: number; toBar: number }[];
}

/**
 * Walks `parent` backward from `(M, n)` to `(0,0)`, then rebuilds the
 * FORWARD sequence of continuous bar-segments and the joins between them.
 * `toBar` for a jump edge is recovered as `landingP - minRunBars` -- the
 * landing state's `p` uniquely determines it since `minRunBars` is fixed for
 * the whole table, so it never needs to be stored in `parent` itself.
 */
function reconstructPath(table: DPTable, n: number, minRunBars: number): ReconstructedPath {
  const { M, width, parent } = table;
  const edges: { isJump: boolean; predP: number; curP: number }[] = [];
  let curIdx = M * width + n;
  let curP = M;
  for (;;) {
    const enc = parent[curIdx];
    if (enc < 0) break;
    const isJump = enc % 2 === 1;
    const predState = Math.floor(enc / 2);
    const predP = Math.floor(predState / width);
    edges.push({ isJump, predP, curP });
    curIdx = predState;
    curP = predP;
  }
  edges.reverse();

  const segmentsBar: { startBar: number; endBar: number }[] = [];
  const barJoins: { fromBar: number; toBar: number }[] = [];
  let segStart = 0;
  for (const e of edges) {
    if (e.isJump) {
      segmentsBar.push({ startBar: segStart, endBar: e.predP });
      const toBar = e.curP - minRunBars;
      barJoins.push({ fromBar: e.predP, toBar });
      segStart = toBar;
    }
  }
  segmentsBar.push({ startBar: segStart, endBar: M });
  return { segmentsBar, barJoins };
}

function segmentsBarToSamples(segs: { startBar: number; endBar: number }[], barBoundary: Int32Array): RemixSegment[] {
  return segs.map((s) => ({ start: barBoundary[s.startBar], end: barBoundary[s.endBar] }));
}

function sumSegmentSamples(segs: RemixSegment[]): number {
  let total = 0;
  for (const s of segs) total += s.end - s.start;
  return total;
}

function pathSampleSum(
  table: DPTable,
  n: number,
  minRunBars: number,
  barBoundary: Int32Array,
  headLen: number,
  tailLen: number
): number {
  const { segmentsBar } = reconstructPath(table, n, minRunBars);
  return headLen + sumSegmentSamples(segmentsBarToSamples(segmentsBar, barBoundary)) + tailLen;
}

// ---------------------------------------------------------------------------
// Over-repetition guard
// ---------------------------------------------------------------------------

function countBarUsage(segmentsBar: { startBar: number; endBar: number }[], M: number): Int32Array {
  const counts = new Int32Array(M);
  for (const seg of segmentsBar) {
    for (let b = seg.startBar; b < seg.endBar; b++) counts[b]++;
  }
  return counts;
}

function maxBarUsage(counts: Int32Array): number {
  let m = 0;
  for (let i = 0; i < counts.length; i++) if (counts[i] > m) m = counts[i];
  return m;
}

// ---------------------------------------------------------------------------
// Terminal-state selection
// ---------------------------------------------------------------------------

interface ReachableEntry {
  n: number;
  sample: number;
}

type SelectionResult =
  | { ok: true; n: number; minOutputSample: number; maxOutputSample: number }
  | { ok: false; reason: 'too-short' | 'too-long' | 'no-path'; minOutputSample: number; maxOutputSample: number };

function selectTerminalN(
  table: DPTable,
  minRunBars: number,
  barBoundary: Int32Array,
  headLen: number,
  tailLen: number,
  targetBars: number,
  targetSample: number,
  tolBars: number,
  exactLength: boolean,
  noPathFallbackSample: number
): SelectionResult {
  const { M, Nmax, width, cost } = table;
  const reachable: ReachableEntry[] = [];
  for (let n = 0; n <= Nmax; n++) {
    if (Number.isFinite(cost[M * width + n])) {
      reachable.push({ n, sample: pathSampleSum(table, n, minRunBars, barBoundary, headLen, tailLen) });
    }
  }

  if (reachable.length === 0) {
    return {
      ok: false,
      reason: 'no-path',
      minOutputSample: noPathFallbackSample,
      maxOutputSample: noPathFallbackSample,
    };
  }

  const minOutputSample = reachable[0].sample;
  const maxOutputSample = reachable[reachable.length - 1].sample;

  if (exactLength) {
    let best: ReachableEntry | null = null;
    for (const r of reachable) {
      if (r.sample >= targetSample && (best === null || r.sample < best.sample)) best = r;
    }
    if (!best) return { ok: false, reason: 'too-long', minOutputSample, maxOutputSample };
    return { ok: true, n: best.n, minOutputSample, maxOutputSample };
  }

  const lo = targetBars - tolBars;
  const hi = targetBars + tolBars;
  const windowed = reachable.filter((r) => r.n >= lo && r.n <= hi);

  if (windowed.length > 0) {
    let best = windowed[0];
    let bestCost = cost[M * width + best.n];
    for (let i = 1; i < windowed.length; i++) {
      const r = windowed[i];
      const c = cost[M * width + r.n];
      const better =
        c < bestCost ||
        (c === bestCost &&
          (Math.abs(r.n - targetBars) < Math.abs(best.n - targetBars) ||
            (Math.abs(r.n - targetBars) === Math.abs(best.n - targetBars) && r.n < best.n)));
      if (better) {
        best = r;
        bestCost = c;
      }
    }
    return { ok: true, n: best.n, minOutputSample, maxOutputSample };
  }

  let closest = reachable[0];
  for (const r of reachable) {
    if (Math.abs(r.n - targetBars) < Math.abs(closest.n - targetBars)) closest = r;
  }
  // `closest.n < targetBars` means even the largest reachable arrangement
  // falls short of the target -- the target itself is too LONG. Conversely
  // `closest.n > targetBars` means even the shortest reachable arrangement
  // overshoots the target -- the target is too SHORT.
  const reason: 'too-short' | 'too-long' = closest.n < targetBars ? 'too-long' : 'too-short';
  return { ok: false, reason, minOutputSample, maxOutputSample };
}

// ---------------------------------------------------------------------------
// Single-attempt planning (one DP run + selection + reconstruction)
// ---------------------------------------------------------------------------

interface AttemptOk {
  ok: true;
  n: number;
  segmentsBar: { startBar: number; endBar: number }[];
  barJoins: { fromBar: number; toBar: number }[];
  minOutputSample: number;
  maxOutputSample: number;
}
interface AttemptFail {
  ok: false;
  reason: 'too-short' | 'too-long' | 'no-path';
  minOutputSample: number;
  maxOutputSample: number;
}
type Attempt = AttemptOk | AttemptFail;

interface AttemptContext {
  candidates: Int32Array[];
  baseCosts: Float64Array[];
  jumpToll: number;
  M: number;
  Nmax: number;
  minRunBars: number;
  barBoundary: Int32Array;
  headLen: number;
  tailLen: number;
  targetBars: number;
  targetSample: number;
  tolBars: number;
  exactLength: boolean;
  noPathFallbackSample: number;
}

function planOnce(ctx: AttemptContext, penalty: ReadonlyMap<string, number>): Attempt {
  const table = runRemixDP(ctx.candidates, ctx.baseCosts, ctx.jumpToll, penalty, ctx.M, ctx.Nmax, ctx.minRunBars);
  const sel = selectTerminalN(
    table,
    ctx.minRunBars,
    ctx.barBoundary,
    ctx.headLen,
    ctx.tailLen,
    ctx.targetBars,
    ctx.targetSample,
    ctx.tolBars,
    ctx.exactLength,
    ctx.noPathFallbackSample
  );
  if (!sel.ok) {
    return { ok: false, reason: sel.reason, minOutputSample: sel.minOutputSample, maxOutputSample: sel.maxOutputSample };
  }
  const { segmentsBar, barJoins } = reconstructPath(table, sel.n, ctx.minRunBars);
  return {
    ok: true,
    n: sel.n,
    segmentsBar,
    barJoins,
    minOutputSample: sel.minOutputSample,
    maxOutputSample: sel.maxOutputSample,
  };
}

/**
 * One roll's full result: the initial attempt, then (only if it violates the
 * over-repetition guard) up to `MAX_REPETITION_ITERATIONS` penalised re-runs,
 * keeping the best (fewest bar-index over-uses, ties by lowest recomputed
 * cost -- computed by the caller, since `planOnce` doesn't have `analysis`/
 * `weights` to recompute a clean cost itself).
 */
function planWithRepetitionGuard(
  ctx: AttemptContext,
  basePenalty: ReadonlyMap<string, number>,
  cleanCostOf: (barJoins: { fromBar: number; toBar: number }[]) => number
): Attempt {
  const penalty = new Map(basePenalty);
  let attempt = planOnce(ctx, penalty);
  if (!attempt.ok) return attempt;

  let usage = maxBarUsage(countBarUsage(attempt.segmentsBar, ctx.M));
  if (usage <= MAX_USE_COUNT) return attempt;

  let best = attempt;
  let bestUsage = usage;
  let bestCost = cleanCostOf(attempt.barJoins);

  for (let iter = 0; iter < MAX_REPETITION_ITERATIONS; iter++) {
    for (const j of attempt.barJoins) {
      const key = joinKey(j.fromBar, j.toBar);
      penalty.set(key, (penalty.get(key) ?? 0) + JOIN_PENALTY);
    }
    const next = planOnce(ctx, penalty);
    if (!next.ok) break; // Reachability/window are penalty-independent; not
    // expected, but bail out safely and keep the best attempt seen so far.
    attempt = next;
    usage = maxBarUsage(countBarUsage(attempt.segmentsBar, ctx.M));
    if (usage <= MAX_USE_COUNT) return attempt;
    const cost = cleanCostOf(attempt.barJoins);
    if (usage < bestUsage || (usage === bestUsage && cost < bestCost)) {
      best = attempt;
      bestUsage = usage;
      bestCost = cost;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// planRemix
// ---------------------------------------------------------------------------

/**
 * Plans a remix for `analysis` hitting `options.targetSample`, subject to
 * the hard feasibility window (see the module doc comment). Never throws --
 * every refusal is `{ok:false, reason, ...}`, `minOutputSample`/
 * `maxOutputSample` always populated.
 */
export function planRemix(analysis: RemixAnalysis, options: PlanRemixOptions): PlanRemixResult {
  const phraseBars = normalizePhraseBars(options.phraseBars);
  const maxRepeatFactor = options.maxRepeatFactor ?? DEFAULT_MAX_REPEAT_FACTOR;
  const M = analysis.numBars;
  const trivialSample = analysis.analyzedEndSample;

  // --- Refusals computed BEFORE the DP (module doc comment, "Refusals") ---
  if (analysis.confidence < CONFIDENCE_LOW) {
    return {
      ok: false,
      reason: 'no-tempo',
      minOutputSample: trivialSample,
      maxOutputSample: trivialSample,
      message: `tempo confidence ${analysis.confidence.toFixed(2)} is below the required minimum ${CONFIDENCE_LOW}`,
    };
  }
  if (M < 2 * phraseBars + 2) {
    return {
      ok: false,
      reason: 'too-short',
      minOutputSample: trivialSample,
      maxOutputSample: trivialSample,
      message: `only ${M} bars available; at least ${2 * phraseBars + 2} are required for phrase-aware remixing`,
    };
  }
  const lengthSample = analysis.analyzedEndSample;
  if (options.targetSample > maxRepeatFactor * lengthSample) {
    return {
      ok: false,
      reason: 'too-long',
      minOutputSample: trivialSample,
      maxOutputSample: Math.round(maxRepeatFactor * lengthSample),
      message: `target ${options.targetSample} samples exceeds ${maxRepeatFactor}x the source length (${lengthSample} samples)`,
    };
  }

  // --- Lattice sizing ---
  const minRunBars = options.strict ? phraseBars : 4;
  const headLen = analysis.barBoundary[0];
  const tailLen = analysis.analyzedEndSample - analysis.barBoundary[M];
  const avgBarLen = (analysis.barBoundary[M] - analysis.barBoundary[0]) / M;
  const targetBarsRaw = (options.targetSample - headLen - tailLen) / Math.max(1, avgBarLen);
  const targetBars = Math.max(0, Math.round(targetBarsRaw));
  const Nmax = Math.max(0, Math.min(Math.round(M * maxRepeatFactor), targetBars + phraseBars));
  const tolBars = options.strict ? Math.ceil(phraseBars / 2) : 2;

  const candOptions: CandidateListOptions = {
    weights: options.weights,
    phraseBars,
    minRunBars,
    strict: options.strict,
    allowRepeats: options.allowRepeats,
    edgeGuardBars: options.edgeGuardBars,
    minKeepBars: options.minKeepBars,
    maxRepeatBars: options.maxRepeatBars,
    forbiddenJoins: options.forbiddenJoins,
  };
  const candidates = buildCandidateLists(analysis, candOptions);

  const memberCounts = clusterMemberCounts(analysis.cluster);
  const baseCosts: Float64Array[] = candidates.map((cand, from) => {
    const arr = new Float64Array(cand.length);
    for (let i = 0; i < cand.length; i++) {
      arr[i] = joinCost(analysis, options.weights, phraseBars, from, cand[i], memberCounts).total;
    }
    return arr;
  });

  const ctx: AttemptContext = {
    candidates,
    baseCosts,
    jumpToll: options.weights.jump,
    M,
    Nmax,
    minRunBars,
    barBoundary: analysis.barBoundary,
    headLen,
    tailLen,
    targetBars,
    targetSample: options.targetSample,
    tolBars,
    exactLength: options.exactLength ?? false,
    noPathFallbackSample: trivialSample,
  };

  const cleanCostOf = (barJoins: { fromBar: number; toBar: number }[]): number => {
    let total = 0;
    for (const j of barJoins) {
      total += joinCost(analysis, options.weights, phraseBars, j.fromBar, j.toBar, memberCounts).total + options.weights.jump;
    }
    return total;
  };

  // --- Re-roll: re-derive rolls 0..rollIndex-1, union their joins into a
  // penalty, then plan rollIndex under it (module doc comment, "Re-roll"). ---
  const rollIndex = Math.max(0, Math.floor(options.rollIndex ?? 0));
  const rollPenalty = new Map<string, number>();
  let attempt: Attempt = planWithRepetitionGuard(ctx, rollPenalty, cleanCostOf);
  for (let roll = 1; roll <= rollIndex; roll++) {
    if (attempt.ok) {
      for (const j of attempt.barJoins) {
        const key = joinKey(j.fromBar, j.toBar);
        rollPenalty.set(key, (rollPenalty.get(key) ?? 0) + JOIN_PENALTY);
      }
    }
    attempt = planWithRepetitionGuard(ctx, rollPenalty, cleanCostOf);
  }

  if (!attempt.ok) {
    const reasonMessage: Record<'too-short' | 'too-long' | 'no-path', string> = {
      'too-short': `target ${options.targetSample} samples is below the shortest reachable arrangement (${attempt.minOutputSample} samples)`,
      'too-long': `target ${options.targetSample} samples is above the longest reachable arrangement (${attempt.maxOutputSample} samples)`,
      'no-path': 'no candidate join reaches the end of the track within the allowed state space',
    };
    return {
      ok: false,
      reason: attempt.reason,
      minOutputSample: attempt.minOutputSample,
      maxOutputSample: attempt.maxOutputSample,
      message: reasonMessage[attempt.reason],
    };
  }

  const segments = segmentsBarToSamples(attempt.segmentsBar, analysis.barBoundary);
  const joins: RemixJoin[] = attempt.barJoins.map((j) => ({
    fromBar: j.fromBar,
    toBar: j.toBar,
    cost: joinCost(analysis, options.weights, phraseBars, j.fromBar, j.toBar, memberCounts),
  }));
  const outputSample = headLen + sumSegmentSamples(segments) + tailLen;
  const totalCost = cleanCostOf(attempt.barJoins);

  return {
    ok: true,
    segments,
    joins,
    outputSample,
    targetSample: options.targetSample,
    totalCost,
    minOutputSample: attempt.minOutputSample,
    maxOutputSample: attempt.maxOutputSample,
  };
}
