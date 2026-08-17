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
 * itself candidate-free, so nothing ever departs from it). The terminal `n*`
 * is chosen from the feasibility window `{n : abs(n-targetBars) <= tolBars}`
 * (`tolBars = ceil(phraseBars/2)` strict, `2` loose -- the grid step IS
 * `phraseBars` bars in strict mode, so half a step is the tightest
 * meaningful tolerance) -- but NOT by `argmin f(M,n)`. Cost first narrows the
 * field to the candidates within `costMargin` of the window's cheapest, and
 * among those the one closest to `targetSample` IN SAMPLES wins (ties: cheaper
 * first, then smaller `n`). So a costlier `n` can and does win, deliberately:
 * bars vary in length, and a pure cost pick inside the window measured up to
 * +7.2 % duration error on an accelerando. A candidate more than `costMargin`
 * cheaper than every other is the sole member of the competitive set and still
 * wins outright. See `selectTerminalN`. This deliberately drops a `wDuration` weight
 * entirely: calibrating bars-of-error against cost-units is exactly the kind
 * of magic number that can only be judged by ear, whereas "filter to
 * feasible, then minimise cost" needs no such calibration. If the window is
 * EMPTY, fall back to the reachable `n` closest to `targetBars` and report
 * the achieved length via `reason`/`message` (`ok: false`, never a
 * best-effort `ok: true`) -- see "Refusals" below.
 *
 * `targetBars` itself is only ever an ESTIMATE (`(targetSample-headLen-
 * tailLen)/avgBarLen`, `avgBarLen` the analysis's own mean bar length) used
 * to place the WINDOW -- it is NEVER used to size `Nmax` (fix round 1, Plan
 * Ruling 6 -- see "Lattice sizing is target-independent" below) and it is
 * NEVER used to compute a reported duration. Every duration this module
 * reports (`outputSample`, `minOutputSample`, `maxOutputSample`) is summed
 * from the ACTUAL `barBoundary` samples of the actually-reconstructed path,
 * so drift-varying bar lengths never leak an error into the reported
 * numbers, only (at most) into which `n` gets selected -- and the tolerance
 * window exists precisely to absorb that.
 *
 * ## Lattice sizing is target-independent (Plan Ruling 6, fix round 1)
 *
 * `Nmax = round(numBars*maxRepeatFactor)` -- a function of the SOURCE and
 * `maxRepeatFactor` alone, never of `targetBars`. The brief originally
 * specified `Nmax = min(round(M*maxRepeatFactor), targetBars+phraseBars)`,
 * which the T11 review measured as WRONG: it made reachability itself a
 * function of the requested target. A far-too-short target shrank `Nmax`
 * below `M`, so even the trivial straight-through state became unreachable
 * within the truncated table -- producing a spurious `'no-path'` whose
 * fallback then reported the FULL source length as "the only achievable
 * length", exactly backwards for a length slider dragged to its minimum.
 * Sizing unconditionally makes `minOutputSample`/`maxOutputSample`
 * genuinely target-independent reachable extremes (see "Reachability" next)
 * and turns that `no-path` cliff into a correct `'too-short'` carrying the
 * TRUE minimum.
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
 * `targetSample` non-finite or `<= 0` -> `'too-short'` (fix round 1, Minor
 * 1); `tempoConfidence < CONFIDENCE_LOW` -> `'no-tempo'`; `numBars <
 * 2*phraseBars + 2` -> `'too-short'`. None of these touch
 * `buildCandidateLists`/`joinCost` at all (verified by dedicated spy-based
 * tests) -- there is no meaningful reachability to report for them, so
 * `minOutputSample`/`maxOutputSample` both fall back to the one length
 * ALWAYS known without running anything: the trivial straight-through play,
 * `analysis.analyzedEndSample` (every continue edge is unconditional, so
 * "play everything, no joins" is always conceptually valid regardless of
 * confidence/length -- we just never reach it structurally when refusing up
 * front). There is deliberately NO up-front `targetSample too large` refusal
 * (fix round 1, Minor 3 -- see `planRemix`'s own inline comment for why: once
 * `Nmax` no longer depends on the target, running the DP costs the same
 * regardless of how large the target is, so the too-long case always flows
 * through the real DP instead and gets the EXACT reachable maximum). The
 * POST-DP empty-window fallback (`'too-short'`/`'too-long'`, from the real,
 * exact table) and a completely unreachable terminal state (`'no-path'`,
 * only possible now when a caller supplies `maxRepeatFactor < 1`, making
 * `Nmax < M` by construction) use the exact reachable min/max instead once
 * the table exists; `'no-path'` has no reachable state to measure from at
 * all, so it uses the same trivial straight-through fallback as the
 * up-front refusals (a documented choice, not a silent guess -- see the
 * task report).
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
 * overshoot in bar-equivalent units is bounded STRICTLY LESS THAN
 * `phraseBars` (fix round 1: the original claim here said "as large as
 * `phraseBars-1` bars", which is wrong for the same reason `n` isn't a
 * sample count -- real bar-length variation means the overshoot can land at
 * a genuinely fractional bar count approaching, but never reaching,
 * `phraseBars`; measured 7.50 bars at `phraseBars=8` in one evidence run,
 * comfortably under 8 but well above the "7" an integer `phraseBars-1` bound
 * would have implied). The actual sample-exact trim (with a 5 ms fade) is
 * T12's job at render time,
 * never a WSOLA micro-stretch here or there (T12's own doc comment has the
 * full argument -- `computeOffsets` runs its full similarity search
 * regardless of ratio, so a "harmless" 2% correction would re-smear every
 * splice this planner just optimised).
 *
 * ## `requiredJoins`: a pin as a HARD constraint, via a subset axis (R4b)
 *
 * `lockedJoins` (below) is a cost PREFERENCE. `requiredJoins` is the
 * guarantee: every key in it appears in the returned plan, or the result says
 * -- by name and by category -- why it could not.
 *
 * WHY A BITMASK AND NOT A COUNTER OR A PREFIX INDEX. Both cheaper designs
 * were considered and both are WRONG here, measured on this module's own
 * lattice (32 bars, `phraseBars = 8`, strict, `allowRepeats`):
 * - A COUNTER ("how many required edges has this path taken") over-counts,
 *   because a single plan can traverse the SAME join key more than once: a
 *   loop re-enters the same `(from,to)` edge at a later `n`. Measured **28 of
 *   126** real plans across three scales, three roll indices and both modes
 *   contain a repeated join key (e.g. `26>10,26>10`). A path using pin A
 *   twice and pin B never would reach `count = 2 = K` and be wrongly
 *   declared complete.
 * - A PREFIX INDEX ("required joins are met in a fixed order") needs that
 *   order to be forced by the lattice. It is not. `n` increases strictly on
 *   every edge, which is why an ascending-`n` sweep is a valid topological
 *   order -- but `p` does NOT move monotonically, so a jump can land anywhere
 *   `buildCandidateLists` allows and the ORDER two pinned joins appear in is
 *   free. Measured by 3-state-automaton reachability over all 69 candidate
 *   keys of that fixture: of 2 173 ordered-realizable key pairs, **1 326 are
 *   realizable in BOTH orders** (847 in one order only).
 *
 * So "which pins have been used so far" is genuinely SET-valued, and the
 * exact formulation is a subset DP: the state becomes `(p, n, S)` with `S`
 * the bitmask of satisfied pins, a jump edge whose key is pin `i` sets bit
 * `i`, and the table grows by `2^K`.
 *
 * THE SUBSET AXIS IS ALSO THE FALLBACK -- there is deliberately no second
 * mechanism (no relaxation pass, no retry loop, no heuristic). At the
 * terminal the table holds a best cost for `(M, n, S)` for EVERY reachable
 * `S`, so the maximum-satisfiable pin set and the cheapest plan achieving it
 * fall out of the same table: take the largest popcount reachable anywhere at
 * `p = M`, then per `n` the cheapest mask of that popcount (ties by lower
 * mask value), then run the ordinary terminal selection over that reduced
 * cost vector. All pins satisfiable -> all honoured. Not all -> the largest
 * set that is, with the specific dropped keys named as mutually
 * `'incompatible'`.
 *
 * TWO INFEASIBILITIES ARE DECIDED BEFORE THE DP, because they are decidable
 * without planning and produce far better messages: a key that is also in
 * `forbiddenJoins` (`'forbidden'` -- `buildCandidateLists` applies that as a
 * hard constraint and it wins), and a key that appears in NO candidate list
 * at all (`'no-candidate'` -- filtered out by strict congruence, the edge
 * guard, `minKeepBars`/`maxRepeatBars` or `allowRepeats`). Neither consumes a
 * bit, so triaging them first can bring a set back under the cap.
 *
 * `K` IS CAPPED at `MAX_REQUIRED_JOINS`; above it the keys degrade to
 * `lockedJoins` semantics and the result says so (`mode: 'preference'`). See
 * that constant for the memory arithmetic the cap comes from.
 *
 * INERTNESS. With no required joins `K = 0`, `numMasks = 1`, and every index
 * expression below collapses to exactly the arithmetic this module used
 * before the axis existed (`(p*width + n)*1 + 0`). The table does not grow,
 * no per-edge required-key lookup runs (one hoisted boolean guards it), and
 * the plan is byte-identical -- pinned by a stored golden, not by argument.
 *
 * ## `MAX_DP_CELLS` is exported, not enforced, here
 *
 * The brief specifies routing to a worker above `(M+1)*(Nmax+1) >
 * MAX_DP_CELLS`. That is an ORCHESTRATION decision (main thread vs worker),
 * not something a pure planning function can make about itself -- this
 * module always runs the DP it is asked to run. `MAX_DP_CELLS` is exported
 * purely so the service layer that owns that choice (T13) has one canonical
 * constant to compare against, matching this module's own
 * `(numBars+1)*(Nmax+1)` table shape exactly. R4b does NOT change that
 * division of labour: the subset axis multiplies the table by `2^K`, and it
 * is the SERVICE that must multiply its comparison to match (a `2^K` the
 * existing comparison would not notice is a 16x table on the main thread).
 * `MAX_REQUIRED_JOINS` is exported for the same reason `MAX_DP_CELLS` is.
 */

import type { RemixAnalysis } from './remixFeatures';
import { joinCost, buildCandidateLists, clusterMemberCounts } from './remixCost';
import type { RemixWeights, JoinCostTerms, CandidateListOptions } from './remixCost';
import { CONFIDENCE_LOW } from './tempoCore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** `Nmax = round(numBars*maxRepeatFactor)` default (Plan Ruling 6, fix round
 * 1 -- sized independently of the target; see the module doc comment). */
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
/**
 * Largest number of `requiredJoins` this module will enforce EXACTLY. Above
 * it the keys degrade to `lockedJoins` semantics and the result reports
 * `mode: 'preference'` so the caller can say so plainly -- a silently
 * downgraded guarantee would be worse than no guarantee.
 *
 * THE ARITHMETIC THIS COMES FROM (not a taste call). The subset axis
 * multiplies BOTH typed arrays of the table by `2^K`:
 * `cost` is a `Float64Array` (8 B/cell) and `parent` an `Int32Array`
 * (4 B/cell), over `(M+1)*(Nmax+1)*2^K` cells -- **12 bytes per cell**.
 * At the worst case actually reachable in this app (`MAX_ANALYSIS_SECONDS =
 * 600` at 200 BPM -> `M = 499`, `Nmax = round(499*3) = 1497`, so
 * `500*1498 = 749 000` cells, **8.99 MB** at `K = 0`):
 *
 *     K = 0 ->   8.99 MB      K = 4 -> 143.8 MB
 *     K = 1 ->  17.98 MB      K = 5 -> 287.6 MB
 *     K = 2 ->  35.95 MB      K = 6 -> 575.2 MB
 *     K = 3 ->  71.90 MB      K = 8 ->   2.30 GB
 *
 * `K = 4` (143.8 MB) is the largest that stays inside the same order of
 * magnitude as the allocations this feature ALREADY makes on the same
 * machine at the same moment -- `renderRemix` allocates up to ~690 MB for its
 * output (`remixRender.ts:571`) and the source snapshot is ~105 MB for a
 * 5-minute stereo track. `K = 5` (287.6 MB) would roughly triple the
 * planner's own footprint while those are live; `K = 8` (the panel's
 * `MAX_LOCKED_JOINS`) is 2.3 GB and would simply fail to allocate.
 *
 * TIME AGREES, and it was MEASURED rather than assumed. The hope that most
 * `(p,n,S)` cells would stay `Infinity` (a mask being unreachable until its
 * own pinned edges are taken) is WRONG in practice: a continue edge carries
 * every reachable mask forward one bar, so a mask taken early is live for the
 * rest of the sweep. Measured at `M = 496` under ts-jest (the ratios are what
 * transfer; the absolute figures carry that harness's overhead, which is
 * ~5.7x the 302 ms this module records for a production `M = 499` run):
 *
 *     K = 0 -> 1729 ms    K = 2 ->  5990 ms (3.46x)
 *     K = 1 -> 3199 ms    K = 3 -> 11381 ms (6.58x)
 *     (1.85x)             K = 4 -> 22877 ms (13.2x)
 *
 * i.e. essentially the full `2^K`. `K = 5` would be ~26x and `K = 8` ~200x on
 * top of a run that is already the reason planning moves to a worker at all.
 * So 4 is where BOTH budgets run out, which is the useful kind of agreement.
 * The residual is real and recorded: a 4-pin re-roll on a 10-minute source is
 * seconds of worker time, not milliseconds -- see `docs/KNOWN_LIMITATIONS.md`.
 *
 * The cap is deliberately BELOW the panel's `MAX_LOCKED_JOINS = 8`, so the
 * degradation path is reachable in normal use rather than theoretical -- and
 * therefore testable, and therefore something the UI must actually say.
 */
export const MAX_REQUIRED_JOINS = 4;
/**
 * Cost advantage a PINNED join gets, on top of being exempt from every
 * synthetic penalty (fix round 2). NOT an invented constant: 0.35 is
 * `DEFAULT_REMIX_WEIGHTS.jump` (`remixCost.ts`), this module's own per-join
 * toll at the shipped weights and the same unit `selectTerminalN` uses as
 * `costMargin` to mean "no real quality difference" -- so at the defaults a pin
 * is worth precisely one join's worth of preference, enough to win ties and
 * near-ties and no more. It is a LITERAL, not a read of `options.weights.jump`:
 * a caller who moves the jump weight moves the toll but not this bonus, so the
 * "one join's worth" equivalence is a statement about the defaults.
 *
 * MEASURED (fix round 2). Pin preservation over 156 pin/press cases across
 * three scales and both entry points: exemption alone 140/156 (89.7%),
 * exemption + this bonus 156/156 (100%). Degeneracy check against the same
 * matrix, pinned vs unpinned re-roll: mean change in clean `totalCost`
 * -0.015 (abab, M=32) and -0.025 (song-like, M=128) -- pinned arrangements
 * are on average CHEAPER, not more expensive -- and the number of plans
 * exceeding `MAX_USE_COUNT` is IDENTICAL with and without pins (0 vs 0, and
 * 8 vs 8). So it buys the last 10% at no measurable quality cost.
 */
const LOCK_BONUS = 0.35;

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

/**
 * Why a `requiredJoins` key is not in the returned plan. The four are
 * genuinely different facts and a caller should say different things about
 * them:
 * - `'forbidden'` — the same key is also in `forbiddenJoins`, a direct
 *   contradiction. `buildCandidateLists` applies that as a hard constraint
 *   and it wins; decided BEFORE the DP.
 * - `'no-candidate'` — the key appears in no candidate list at all, so no
 *   path can contain it: filtered out by strict congruence, the edge guard,
 *   `minKeepBars`/`maxRepeatBars`, or `allowRepeats`. Decided BEFORE the DP.
 * - `'incompatible'` — individually reachable, but not jointly with the other
 *   required keys that WERE honoured. This is the only category the DP itself
 *   decides, and it is always relative to the maximum-satisfiable set.
 * - `'not-enforced'` — more than `MAX_REQUIRED_JOINS` keys were required, so
 *   the constraint degraded to a preference (`mode: 'preference'`) and this
 *   key lost on cost. NOT a guarantee that was broken; a guarantee that was
 *   never in force, which the caller must say out loud.
 */
export type RequiredJoinDropReason = 'forbidden' | 'no-candidate' | 'incompatible' | 'not-enforced';

export interface RequiredJoinDrop {
  key: string;
  reason: RequiredJoinDropReason;
}

/** Present on a result ONLY when `requiredJoins` was non-empty — an absent
 * field and an empty report are different facts, and keeping the field absent
 * is also what makes an empty `requiredJoins` byte-identical to a call that
 * never passed the option (see the module doc comment, "INERTNESS"). */
export interface RequiredJoinsReport {
  /** `'enforced'` = every listed key below is a hard constraint the DP
   * satisfied or proved unsatisfiable. `'preference'` = the set exceeded
   * `MAX_REQUIRED_JOINS`, so it was planned with `lockedJoins` semantics
   * instead (penalty exemption + `LOCK_BONUS`) and NOTHING is guaranteed. */
  mode: 'enforced' | 'preference';
  /** Keys the returned plan actually contains, in the order given. */
  satisfied: string[];
  /** Keys it does not, each with why. Ordered by the caller's own ordering of
   * `requiredJoins`, so the report is stable across runs. */
  dropped: RequiredJoinDrop[];
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
  /**
   * `${from}>${to}` keys the caller has PINNED. Two effects, both scoped to
   * these keys alone: they are EXEMPT from every synthetic `+JOIN_PENALTY`
   * this module applies — the re-roll penalty AND the over-repetition
   * guard's — so a pinned join is never penalised for the one thing that made
   * the caller pin it (being in the plan currently on screen); and they get a
   * `LOCK_BONUS` cost advantage so they win ties and near-ties. Default
   * empty, and provably inert when empty (the only reads are
   * `lockedKeys.has(key)` and a loop over the set).
   *
   * WHY THIS EXISTS (fix round 2, measured): without it a "pin" was
   * unimplementable above this layer. Re-roll penalises the union of every
   * previous roll's joins, monotonically (`+2.0` per roll, ~5.7x
   * `weights.jump = 0.35`), so the very act of being in roll `k`'s plan
   * pushed a join out of contention at roll `k+1` — the search moved in
   * exactly the direction that drops pins. A service-layer "retry later rolls
   * and keep the one preserving the most pins" heuristic was measured over 92
   * cases across three scales and preserved a pin **0 times**. Exempting the
   * key from the penalty is the fix, and it belongs here because the penalty
   * lives here.
   *
   * This is a STRONG PREFERENCE, not a guarantee: a key listed here can still
   * lose to a cheaper arrangement, and it cannot survive at all if the caller
   * also forbids it (`forbiddenJoins` wins — it is a hard constraint applied
   * in `buildCandidateLists`, this is only a cost exemption). For the
   * guarantee use `requiredJoins` (R4b); this option is retained as the
   * distinct, cheaper thing it always was, and is what `requiredJoins` itself
   * degrades to above `MAX_REQUIRED_JOINS`.
   */
  lockedJoins?: Iterable<string>;
  /**
   * `${from}>${to}` keys the plan MUST contain — the guarantee (R4b),
   * implemented as a subset axis on the DP (see the module doc comment,
   * "`requiredJoins`: a pin as a HARD constraint"). Duplicates are collapsed;
   * the caller's iteration order fixes the bit indices and the report order,
   * so it is deterministic.
   *
   * WHAT IT DOES BEYOND `lockedJoins`: it is a hard constraint, so every
   * enforced key is in the returned plan or is named in
   * `PlanRemixResult.requiredJoins.dropped` with a category saying why. It
   * ALSO carries `lockedJoins`'s penalty exemption — penalising an edge the
   * constraint already forces would only distort the cost of the REST of the
   * path — for both the re-roll penalty and the over-repetition guard's.
   *
   * WHAT IT DELIBERATELY DOES NOT DO: an enforced key gets NO `LOCK_BONUS`.
   * The bonus exists to win ties for something that might not otherwise be
   * chosen; once the key is forced it can no longer change WHETHER the join
   * appears, only how cheap the paths containing it look — and because a path
   * can traverse the same join twice (measured: 28 of 126 plans), the bonus is
   * collected TWICE there, which is a thumb on the scale for repeating the
   * pinned join. `LOCK_BONUS` is NOT deleted: it is a measured constant, it
   * still governs `lockedJoins`, and it is still what the above-cap
   * `'preference'` mode falls back to. It is scoped out of the one case where
   * it is no longer meaningful, and the scoping is measured too — over a
   * 102-case pin/press matrix (5 scales, 5 presses per pin), keeping the bonus
   * under enforcement changed the chosen arrangement in **4 of 102** cases,
   * and every one of those changes was for the worse: mean clean `totalCost`
   * **+0.144**, and one case where `maxBarUse` went UP. That is the predicted
   * double-count, observed. See the R4b report.
   *
   * Default empty, and provably inert when empty — see the module doc
   * comment, "INERTNESS", and the stored golden that pins it.
   */
  requiredJoins?: Iterable<string>;
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
      /** The most times any single bar index is played in `segments` (fix
       * round 1, Important 1 -- T11 review). The over-repetition guard is a
       * bounded heuristic (see the module doc comment) that can settle for
       * a plan still above `MAX_USE_COUNT` when the source material offers
       * no cheaper alternative -- surfaced directly so a caller (T13/T14)
       * can tell the user "this arrangement repeats a phrase N times"
       * instead of re-deriving it from `segments` itself. */
      maxBarUse: number;
      /** `joins.length > 0` -- whether THIS plan has at least one join a
       * future `rollIndex+1` re-roll could penalise (fix round 1, Minor 4).
       * `false` means re-roll would be a silent no-op (nothing to penalise),
       * a signal T13/T14 can use to disable a "Re-roll" control rather than
       * offer a button that visibly does nothing. */
      canReroll: boolean;
      /** Present ONLY when `requiredJoins` was non-empty (R4b) — see
       * `RequiredJoinsReport`. Its absence is what keeps an empty
       * `requiredJoins` byte-identical to a call that never passed it. */
      requiredJoins?: RequiredJoinsReport;
    }
  | {
      ok: false;
      reason: 'no-tempo' | 'too-short' | 'too-long' | 'no-path';
      minOutputSample: number;
      maxOutputSample: number;
      message: string;
      /** Present ONLY when `requiredJoins` was non-empty AND planning got far
       * enough to triage it (i.e. past the pre-DP refusals). `satisfied` is
       * empty here — no plan was chosen — so this carries only the facts that
       * were decided without a plan: the `'forbidden'` and `'no-candidate'`
       * categories. Enforced pins are ALSO why a length can become
       * unreachable, which is why the refusal `message` names their count. */
      requiredJoins?: RequiredJoinsReport;
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
  /** `2^K` — the subset axis (R4b). `1` when nothing is required, in which
   * case every index below collapses to the pre-R4b `p*width + n`. */
  numMasks: number;
  cost: Float64Array; // (M+1)*width*numMasks, Infinity = unreached
  /** `predecessorState*2 + isJump`, `-1` = no predecessor (only state
   * (0,0,0)). `predecessorState` indexes the SAME `(p,n,S)` space, so
   * reconstruction needs no separate mask trail. */
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
  minRunBars: number,
  /** `${from}>${to}` -> bit index, for `requiredJoins` (R4b). `null` (the
   * default) is the pre-R4b behaviour exactly: no lookup runs at all. */
  requiredBit: ReadonlyMap<string, number> | null = null,
  /** `2^K`. MUST be `1` when `requiredBit` is `null`. */
  numMasks = 1
): DPTable {
  const width = Nmax + 1;
  const size = (M + 1) * width * numMasks;
  const cost = new Float64Array(size).fill(Infinity);
  const parent = new Int32Array(size).fill(-1);
  // With `numMasks === 1` this is `p*width + n`, bit for bit -- the multiply
  // by 1 and the `+ 0` are the whole of R4b's cost on the unpinned path.
  const at = (p: number, n: number, s: number): number => (p * width + n) * numMasks + s;
  // Hoisted out of the edge loop: one null test per jump, rather than a Map
  // lookup per jump on a path that has no required joins. A genuine `const`
  // local (not the parameter) so the narrowing inside the loop is structural
  // and cannot silently degrade.
  const requiredMap: ReadonlyMap<string, number> | null = numMasks > 1 ? requiredBit : null;
  cost[at(0, 0, 0)] = 0;

  function relax(destIdx: number, newCost: number, predIdx: number, isJump: boolean): void {
    const cur = cost[destIdx];
    if (newCost < cur) {
      cost[destIdx] = newCost;
      parent[destIdx] = predIdx * 2 + (isJump ? 1 : 0);
      return;
    }
    if (newCost === cur && parent[destIdx] >= 0) {
      // Tie-break: lower predecessor p, then lower predecessor n, then lower
      // predecessor mask (module doc comment, "Reconstruction is
      // deterministic") -- an explicit comparison against the RECORDED
      // predecessor, not an artefact of sweep order.
      //
      // ONE comparison expresses all three, because the state index IS a
      // mixed-radix number with digits `(p, n, S)`: `idx = p*width*numMasks +
      // n*numMasks + S` with `n < width` and `S < numMasks`, so numeric order
      // on the index is exactly lexicographic order on `(p, n, S)`. With
      // `numMasks === 1` it reduces to `p*width + n`, i.e. bit for bit the
      // `newP < curP || (newP === curP && newN < curN)` this module used
      // before the subset axis existed -- pinned by the plan golden.
      //
      // Written instead as the decomposed three-way comparison, the MASK term
      // would be DEAD CODE: the `s` loop ascends, so at a given `(p,n)` the
      // lower mask is always relaxed first and never replaced. It was written
      // that way first, and the mutation set caught it -- inverting the mask
      // term turned zero tests red, which is the same signature as a missing
      // test and had to be resolved as one or the other. It was the branch.
      const curPred = Math.floor(parent[destIdx] / 2);
      if (predIdx < curPred) {
        parent[destIdx] = predIdx * 2 + (isJump ? 1 : 0);
      }
    }
  }

  for (let n = 0; n < Nmax; n++) {
    for (let p = 0; p <= M; p++) {
      for (let s = 0; s < numMasks; s++) {
        const srcIdx = at(p, n, s);
        const cur = cost[srcIdx];
        // Unreachable `(p,n,S)` cost one test and nothing else -- but do NOT
        // read that as "the subset axis is cheap". Measured, it is not: a
        // continue edge carries every reachable mask forward, so masks fill in
        // and the sweep really does cost about `2^K` (see
        // `MAX_REQUIRED_JOINS`, which is why the cap exists).
        if (!Number.isFinite(cur)) continue;

        if (p < M) {
          relax(at(p + 1, n + 1, s), cur, srcIdx, false);
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
            const key = joinKey(p, b);
            const extra = penalty.get(key) ?? 0;
            const edgeCost = costs[i] + jumpToll + extra;
            let destS = s;
            if (requiredMap !== null) {
              const bit = requiredMap.get(key);
              if (bit !== undefined) destS = s | (1 << bit);
            }
            relax(at(landing, newN, destS), cur + edgeCost, srcIdx, true);
          }
        }
      }
    }
  }

  return { M, Nmax, width, numMasks, cost, parent };
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
function reconstructPath(table: DPTable, n: number, minRunBars: number, mask = 0): ReconstructedPath {
  const { M, width, numMasks, parent } = table;
  const planeStride = width * numMasks;
  const edges: { isJump: boolean; predP: number; curP: number }[] = [];
  // `(M*width + n)*1 + 0` when nothing is required — the pre-R4b start state.
  let curIdx = (M * width + n) * numMasks + mask;
  let curP = M;
  for (;;) {
    const enc = parent[curIdx];
    if (enc < 0) break;
    const isJump = enc % 2 === 1;
    const predState = Math.floor(enc / 2);
    const predP = Math.floor(predState / planeStride);
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
  mask: number,
  minRunBars: number,
  barBoundary: Int32Array,
  headLen: number,
  tailLen: number
): number {
  const { segmentsBar } = reconstructPath(table, n, minRunBars, mask);
  return headLen + sumSegmentSamples(segmentsBarToSamples(segmentsBar, barBoundary)) + tailLen;
}

// ---------------------------------------------------------------------------
// Terminal reduction over the subset axis (R4b)
// ---------------------------------------------------------------------------

interface TerminalReduction {
  /** Best cost per terminal `n` UNDER the constraint, `Infinity` where no
   * mask of the honoured popcount reaches `(M, n)`. */
  cost: Float64Array;
  /** The mask chosen at each `n`, `0` where unreachable (never read then).
   *
   * There is deliberately NO `satisfiedCount` field beside these two. The
   * honoured-set SIZE is load-bearing inside `reduceTerminal` (it is the
   * popcount filter), but outside it the MASK carries the same information in
   * a more useful form — `buildRequiredReport` needs to know WHICH pins were
   * honoured, not how many. It was briefly returned here, read only by a guard
   * comparison that fix round 1 removed as dead; returning it afterwards left
   * a write-only field, which is the same defect one level up. Removed in fix
   * round 2 (re-review): removing dead code can create dead code, which is
   * precisely why this project re-runs its mutation set after a refactor. */
  mask: Int32Array;
}

function popcount(x: number): number {
  let n = 0;
  for (let v = x; v !== 0; v >>>= 1) n += v & 1;
  return n;
}

/**
 * Collapses the `(M, n, S)` terminal face to one cost per `n`, honouring the
 * LARGEST satisfiable pin set (Ruling 1: the subset axis is also the
 * fallback — no second mechanism).
 *
 * Two stages, in this order, and the order is the semantics:
 * 1. `satisfiedCount` (a LOCAL, never returned — see `TerminalReduction`) =
 *    the maximum popcount over EVERY reachable terminal state. This is global,
 *    not per-`n`, so "which pins were dropped" is one answer for the whole
 *    call rather than a different answer per length.
 * 2. Per `n`, the cheapest mask of exactly that popcount; ties broken toward
 *    the LOWER mask value, which is the caller's own `requiredJoins` ordering
 *    read as a binary number — so two equally-large, equally-cheap satisfiable
 *    sets always resolve the same way, and the caller controls which way by
 *    the order it lists its pins in.
 *
 *    HOW that rule is implemented, stated honestly (fix round 1, I4): by the
 *    ASCENDING `s` loop plus a STRICT `<`, not by an explicit comparison. The
 *    lower mask is visited first and a later equal cost never displaces it.
 *    Unlike `relax`'s predecessor tie — where candidates arrive from
 *    arbitrary `(p,n)` and sweep order genuinely cannot be relied on — the
 *    masks at one `n` are enumerated by this loop and by nothing else, so the
 *    ordering is a property of the code you are reading rather than of
 *    something far away. An explicit `s < mask[n]` term would be unreachable
 *    for the same reason, and this module does not ship unreachable branches.
 *
 *    This is NOT a corner case: `makeUniformAnalysis` gives every legal
 *    candidate the same join cost, so two distinct masks of equal popcount
 *    reaching the same `n` at exactly equal cost is the COMMON case there.
 *    Relaxing the `<` to `<=` flips the winner to the highest mask and turns
 *    the dedicated tie test red.
 *
 * A length only reachable by dropping a pin therefore becomes unreachable —
 * that is what "hard constraint" means, and it is why `minOutputSample`/
 * `maxOutputSample` (and any `'too-short'`/`'too-long'` refusal) are reported
 * UNDER the pins rather than under a plan the caller cannot have.
 *
 * With `numMasks === 1` this is `cost[M*width + n]` copied out and `mask` all
 * zero (the popcount filter is skipped entirely) — no behaviour and no
 * selection changes.
 */
function reduceTerminal(table: DPTable): TerminalReduction {
  const { M, Nmax, width, numMasks, cost } = table;
  const out = new Float64Array(Nmax + 1).fill(Infinity);
  const mask = new Int32Array(Nmax + 1);
  const base = M * width * numMasks;

  let satisfiedCount = 0;
  if (numMasks > 1) {
    for (let n = 0; n <= Nmax; n++) {
      for (let s = 0; s < numMasks; s++) {
        if (!Number.isFinite(cost[base + n * numMasks + s])) continue;
        const bits = popcount(s);
        if (bits > satisfiedCount) satisfiedCount = bits;
      }
    }
  }

  for (let n = 0; n <= Nmax; n++) {
    for (let s = 0; s < numMasks; s++) {
      if (numMasks > 1 && popcount(s) !== satisfiedCount) continue;
      const c = cost[base + n * numMasks + s];
      if (!Number.isFinite(c)) continue;
      // STRICT `<` is the tie rule: `s` ascends, so an equal cost leaves the
      // lower mask in place. See the doc comment above -- this is load-bearing
      // and pinned by test, not an accident of loop order that happens to be
      // acceptable.
      if (c < out[n]) {
        out[n] = c;
        mask[n] = s;
      }
    }
  }

  return { cost: out, mask };
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
  terminal: TerminalReduction,
  minRunBars: number,
  barBoundary: Int32Array,
  headLen: number,
  tailLen: number,
  targetBars: number,
  targetSample: number,
  tolBars: number,
  exactLength: boolean,
  noPathFallbackSample: number,
  costMargin: number
): SelectionResult {
  const { Nmax } = table;
  const cost = terminal.cost;
  const reachable: ReachableEntry[] = [];
  for (let n = 0; n <= Nmax; n++) {
    if (Number.isFinite(cost[n])) {
      reachable.push({ n, sample: pathSampleSum(table, n, terminal.mask[n], minRunBars, barBoundary, headLen, tailLen) });
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
    // Fix round 1, Important 2 (T11 review): a pure "minimise cost" pick
    // among several windowed `n` can land far from `targetSample` in SAMPLES
    // even though every candidate is within `tolBars` in BARS -- measured up
    // to +7.2% duration error on an accelerando where bar count alone was a
    // poor proxy for sample duration (bars vary in length). Fix: among the
    // candidates whose cost is within `costMargin` of the window's cheapest
    // (i.e. genuinely cost-competitive, not merely "the window"), prefer
    // whichever is closest to `targetSample` in actual samples; a candidate
    // that is MORE than `costMargin` cheaper than everything else still wins
    // outright, since it is then the only member of that competitive set.
    // `costMargin` is `weights.jump` -- the planner's own smallest atomic
    // cost unit (the fixed per-join toll), not an arbitrary invented
    // epsilon: two arrangements within one join's worth of cost are exactly
    // the kind of "no real quality difference" the brief's own cost design
    // already treats as interchangeable (wJump exists precisely to make the
    // planner indifferent between equally-similar options save the toll).
    let minCost = Infinity;
    for (const r of windowed) {
      const c = cost[r.n];
      if (c < minCost) minCost = c;
    }
    const competitive = windowed.filter((r) => cost[r.n] <= minCost + costMargin);

    let best = competitive[0];
    let bestDist = Math.abs(best.sample - targetSample);
    let bestCost = cost[best.n];
    for (let i = 1; i < competitive.length; i++) {
      const r = competitive[i];
      const dist = Math.abs(r.sample - targetSample);
      const c = cost[r.n];
      const better =
        dist < bestDist ||
        (dist === bestDist && (c < bestCost || (c === bestCost && r.n < best.n)));
      if (better) {
        best = r;
        bestDist = dist;
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
  /** The most times any single bar index appears in `segmentsBar` --
   * computed once here and reused by the repetition guard and the final
   * result, rather than recomputed at every call site. */
  maxBarUse: number;
  /** Bitmask of the `requiredJoins` this path satisfies (R4b). Always `0`
   * when nothing is required. The only consumer is `buildRequiredReport`,
   * which reads bit `i` as "pin `i` is in this plan" -- a path sets that bit
   * exactly when it traverses pin `i`'s edge, so the bit IS the answer and no
   * set-difference against `joins` is needed. */
  mask: number;
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
  /** `${from}>${to}` -> bit index for the enforced `requiredJoins`, or `null`
   * when there are none (R4b). */
  requiredBit: ReadonlyMap<string, number> | null;
  /** `2^K`; `1` when nothing is enforced. */
  numMasks: number;
}

function planOnce(ctx: AttemptContext, penalty: ReadonlyMap<string, number>): Attempt {
  const table = runRemixDP(
    ctx.candidates,
    ctx.baseCosts,
    ctx.jumpToll,
    penalty,
    ctx.M,
    ctx.Nmax,
    ctx.minRunBars,
    ctx.requiredBit,
    ctx.numMasks
  );
  const terminal = reduceTerminal(table);
  const sel = selectTerminalN(
    table,
    terminal,
    ctx.minRunBars,
    ctx.barBoundary,
    ctx.headLen,
    ctx.tailLen,
    ctx.targetBars,
    ctx.targetSample,
    ctx.tolBars,
    ctx.exactLength,
    ctx.noPathFallbackSample,
    ctx.jumpToll
  );
  if (!sel.ok) {
    return { ok: false, reason: sel.reason, minOutputSample: sel.minOutputSample, maxOutputSample: sel.maxOutputSample };
  }
  const mask = terminal.mask[sel.n];
  const { segmentsBar, barJoins } = reconstructPath(table, sel.n, ctx.minRunBars, mask);
  return {
    ok: true,
    n: sel.n,
    segmentsBar,
    barJoins,
    minOutputSample: sel.minOutputSample,
    maxOutputSample: sel.maxOutputSample,
    maxBarUse: maxBarUsage(countBarUsage(segmentsBar, ctx.M)),
    mask,
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
  cleanCostOf: (barJoins: { fromBar: number; toBar: number }[]) => number,
  /** Keys no synthetic penalty may ever touch: `lockedJoins` (a pin must not
   * be penalised for being in the plan that made the user pin it) AND
   * `requiredJoins` (penalising an edge the constraint already forces cannot
   * remove it — it only distorts the cost of the rest of the path). */
  exemptKeys: ReadonlySet<string>
): Attempt {
  const penalty = new Map(basePenalty);
  let attempt = planOnce(ctx, penalty);
  if (!attempt.ok) return attempt;

  let usage = attempt.maxBarUse;
  if (usage <= MAX_USE_COUNT) return attempt;

  let best = attempt;
  let bestUsage = usage;
  let bestCost = cleanCostOf(attempt.barJoins);

  for (let iter = 0; iter < MAX_REPETITION_ITERATIONS; iter++) {
    for (const j of attempt.barJoins) {
      const key = joinKey(j.fromBar, j.toBar);
      // A PINNED join is exempt here for the same reason it is exempt from
      // the roll penalty (see `PlanRemixOptions.lockedJoins`): penalising it
      // for being in the current attempt is precisely what makes a pin
      // impossible to honour. The guard still has every OTHER join of the
      // path to penalise, and still accepts the best attempt it managed when
      // it cannot get under `MAX_USE_COUNT` — including the case (R4b) where
      // the over-repetition is caused BY a required join, which the guard
      // cannot penalise away and must not pretend it can: `maxBarUse` is then
      // reported honestly above `MAX_USE_COUNT`, exactly as it already is
      // when the source offers no cheaper alternative.
      if (exemptKeys.has(key)) continue;
      penalty.set(key, (penalty.get(key) ?? 0) + JOIN_PENALTY);
    }
    const next = planOnce(ctx, penalty);
    if (!next.ok) break; // Reachability/window are penalty-independent; not
    // expected, but bail out safely and keep the best attempt seen so far.
    attempt = next;
    usage = attempt.maxBarUse;
    if (usage <= MAX_USE_COUNT) return attempt;
    const cost = cleanCostOf(attempt.barJoins);
    // The guard CANNOT trade a guaranteed pin for a repetition win, and it
    // needs no term of its own to be prevented from it (fix round 1, I3).
    // Every attempt in this loop differs only in `penalty`, and penalties are
    // finite additions to edge costs: they change which paths are cheapest,
    // never which states are REACHABLE. So the maximum satisfiable pin set is
    // identical in every attempt, `reduceTerminal` restricts every attempt to
    // masks of that same popcount, and a plan dropping a pin the previous
    // attempt kept is not a candidate the guard can even see.
    //
    // An earlier version compared `satisfiedCount` first as defence in depth.
    // It was DEAD by exactly the argument above, and this module removed an
    // identically dead mask term from `relax` in the same task -- shipping the
    // standard and its violation in one file is worse than shipping neither.
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
  // Empty unless the caller pins something, and read ONLY through
  // `lockedKeys.has(...)` guards, so an absent/empty `lockedJoins` leaves
  // every plan byte-identical to what this module produced before the option
  // existed (asserted directly in `remixPlan.test.ts`).
  const lockedKeys = new Set(options.lockedJoins ?? []);
  // Deduped, ORDER PRESERVED: the caller's ordering fixes both the bit
  // indices and the report ordering, so two identical calls are identical.
  const requiredKeys = [...new Set(options.requiredJoins ?? [])];
  const phraseBars = normalizePhraseBars(options.phraseBars);
  const maxRepeatFactor = options.maxRepeatFactor ?? DEFAULT_MAX_REPEAT_FACTOR;
  const M = analysis.numBars;
  const trivialSample = analysis.analyzedEndSample;

  // --- Refusals computed BEFORE the DP (module doc comment, "Refusals") ---
  // (Fix round 1: `targetSample` is validated here too -- a non-finite or
  // non-positive value would otherwise silently produce a zero-length
  // Float64Array inside the DP, turning every write into a silent no-op and
  // degrading to a confusing 'no-path'. There is no dedicated reason for
  // "invalid input" in the brief's four-reason union, and no arrangement can
  // ever be shorter than a positive sample count, so this reuses 'too-short'
  // -- the closest honest fit -- with a message that names the real problem.)
  if (!Number.isFinite(options.targetSample) || options.targetSample <= 0) {
    return {
      ok: false,
      reason: 'too-short',
      minOutputSample: trivialSample,
      maxOutputSample: trivialSample,
      message: `targetSample must be a finite, positive sample count (got ${options.targetSample})`,
    };
  }
  // The tempo gate takes EITHER a confident detection OR an explicit user
  // assertion (`tempoConfirmed`, T14 fix round 1). The two are different
  // facts, and the second is strictly stronger: a human who typed the BPM or
  // corrected the octave knows something the ACF does not. Carrying the
  // assertion as its own flag — rather than writing a threshold constant into
  // `confidence` — is what keeps `confidence` a MEASUREMENT for every other
  // consumer (the status bar's uncertainty marker, the Properties readout) on
  // a track whose detection really is weak.
  if (analysis.confidence < CONFIDENCE_LOW && !analysis.tempoConfirmed) {
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
  // NOTE (fix round 1, Minor 3 / Plan Ruling 6): there is deliberately NO
  // up-front `targetSample > maxRepeatFactor*lengthSample` short-circuit
  // here anymore. Two reasons: (a) since `Nmax` (below) no longer depends on
  // `targetBars` at all, running the DP costs the same regardless of how
  // large the target is -- the ORIGINAL reason for a cheap up-front escape
  // (avoiding an oversized table for an absurd target) no longer applies;
  // (b) the up-front estimate (`round(maxRepeatFactor*lengthSample)`) was
  // measured WRONG in both directions against the true reachable maximum
  // (T11 review, fix round 1) -- requesting exactly the advertised estimate
  // could even succeed with a silent shortfall. A too-long target now always
  // flows through the real DP and gets the EXACT reachable maximum from
  // `selectTerminalN`'s empty-window fallback instead.

  // --- Lattice sizing ---
  const minRunBars = options.strict ? phraseBars : 4;
  const headLen = analysis.barBoundary[0];
  const tailLen = analysis.analyzedEndSample - analysis.barBoundary[M];
  const avgBarLen = (analysis.barBoundary[M] - analysis.barBoundary[0]) / M;
  const targetBarsRaw = (options.targetSample - headLen - tailLen) / Math.max(1, avgBarLen);
  const targetBars = Math.max(0, Math.round(targetBarsRaw));
  // Plan Ruling 6 (T11 review, fix round 1): `Nmax` is sized from `M` and
  // `maxRepeatFactor` ALONE, independently of the target. The brief's
  // original `min(round(M*maxRepeatFactor), targetBars+phraseBars)` made
  // reachability itself a function of the requested target -- measured
  // producing `no-path` for a far-too-short target (whose fallback then
  // reports the FULL source length as the only achievable one, the worst
  // possible answer to drag a length slider to its minimum) and a
  // `maxOutputSample` capped at `targetBars+phraseBars` bars regardless of
  // what's actually reachable (a 16-bar request advertising a 12 s ceiling
  // on a 73 s-capable source). Sizing unconditionally makes
  // `minOutputSample`/`maxOutputSample` genuinely target-independent reachable
  // extremes, exactly as the brief's own reachability contract intends.
  const Nmax = Math.max(0, Math.round(M * maxRepeatFactor));
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

  // --- requiredJoins triage, BEFORE the DP (Ruling 2) -------------------
  // Two infeasibilities are decidable without planning, cost nothing here,
  // and produce a message the DP could never produce: a key the caller ALSO
  // forbade, and a key no candidate list contains. Neither consumes a bit, so
  // triaging first can bring an over-cap set back under `MAX_REQUIRED_JOINS`.
  const drops: RequiredJoinDrop[] = [];
  let enforcedKeys: string[] = [];
  let preferredKeys: string[] = [];
  if (requiredKeys.length > 0) {
    const forbidden = new Set(options.forbiddenJoins ?? []);
    const available = new Set<string>();
    for (let from = 0; from < candidates.length; from++) {
      const cand = candidates[from];
      if (!cand) continue;
      for (let i = 0; i < cand.length; i++) available.add(joinKey(from, cand[i]));
    }
    const feasible: string[] = [];
    for (const key of requiredKeys) {
      if (forbidden.has(key)) drops.push({ key, reason: 'forbidden' });
      else if (!available.has(key)) drops.push({ key, reason: 'no-candidate' });
      else feasible.push(key);
    }
    // Above the cap the table would not fit (see `MAX_REQUIRED_JOINS`), so
    // the keys degrade to `lockedJoins` semantics — exemption plus
    // `LOCK_BONUS` — and the result says `mode: 'preference'` so the caller
    // can tell the user the guarantee is not in force. A silent downgrade
    // would be worse than never promising.
    if (feasible.length > MAX_REQUIRED_JOINS) preferredKeys = feasible;
    else enforcedKeys = feasible;
  }
  // `LOCK_BONUS` is scoped OUT of enforced keys and only out of those — see
  // `PlanRemixOptions.requiredJoins` for why (it can no longer change whether
  // the join appears, and a path traversing it twice would collect it twice).
  const bonusKeys = new Set([...lockedKeys, ...preferredKeys]);
  // An ENFORCED key never carries the bonus, even when the caller ALSO listed
  // it in `lockedJoins` — otherwise the documented rule would be true only for
  // callers who happened not to pass both, which is not a rule.
  for (const key of enforcedKeys) bonusKeys.delete(key);
  const exemptKeys = new Set([...lockedKeys, ...preferredKeys, ...enforcedKeys]);
  const requiredBit: ReadonlyMap<string, number> | null =
    enforcedKeys.length > 0 ? new Map(enforcedKeys.map((key, i) => [key, i])) : null;
  const numMasks = 1 << enforcedKeys.length;

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
    requiredBit,
    numMasks,
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
  // The pin's cost advantage, seeded as a NEGATIVE penalty so it rides the
  // one channel every attempt already reads (including the repetition
  // guard's copy) rather than needing a second parallel map. Empty unless
  // the caller pinned something.
  for (const key of bonusKeys) rollPenalty.set(key, -LOCK_BONUS);
  let attempt: Attempt = planWithRepetitionGuard(ctx, rollPenalty, cleanCostOf, exemptKeys);
  for (let roll = 1; roll <= rollIndex; roll++) {
    if (attempt.ok) {
      for (const j of attempt.barJoins) {
        const key = joinKey(j.fromBar, j.toBar);
        // PINNED joins never accumulate the roll penalty (see
        // `PlanRemixOptions.lockedJoins`). This one `continue` is the whole
        // fix: without it, being in roll `k`'s plan is exactly what costs a
        // join its place in roll `k+1`, so a pin could never survive a
        // re-roll — measured 0/92 before, across three scales. R4b widens the
        // exemption to `requiredJoins` for a different reason: those edges
        // are forced, so the penalty cannot remove them and would only make
        // the rest of the path look relatively cheaper.
        if (exemptKeys.has(key)) continue;
        rollPenalty.set(key, (rollPenalty.get(key) ?? 0) + JOIN_PENALTY);
      }
    }
    attempt = planWithRepetitionGuard(ctx, rollPenalty, cleanCostOf, exemptKeys);
  }

  if (!attempt.ok) {
    // Enforced pins are a reason a length can become unreachable — the
    // reachable extremes above ARE the extremes UNDER the pins — so the
    // message says how many were in force rather than leaving the user to
    // wonder why the same target worked a moment ago.
    const pinNote = enforcedKeys.length > 0 ? ` with ${enforcedKeys.length} pinned edit(s) enforced` : '';
    const reasonMessage: Record<'too-short' | 'too-long' | 'no-path', string> = {
      'too-short': `target ${options.targetSample} samples is below the shortest reachable arrangement${pinNote} (${attempt.minOutputSample} samples)`,
      'too-long': `target ${options.targetSample} samples is above the longest reachable arrangement${pinNote} (${attempt.maxOutputSample} samples)`,
      'no-path': `no candidate join reaches the end of the track within the allowed state space${pinNote}`,
    };
    return {
      ok: false,
      reason: attempt.reason,
      minOutputSample: attempt.minOutputSample,
      maxOutputSample: attempt.maxOutputSample,
      message: reasonMessage[attempt.reason],
      // Only the pre-DP facts are known here — no plan was chosen, so no key
      // can honestly be called 'incompatible' and `satisfied` is empty.
      ...(requiredKeys.length > 0
        ? {
            requiredJoins: {
              mode: preferredKeys.length > 0 ? ('preference' as const) : ('enforced' as const),
              satisfied: [],
              dropped: orderDrops(drops, requiredKeys),
            },
          }
        : {}),
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
    maxBarUse: attempt.maxBarUse,
    canReroll: joins.length > 0,
    // SPREAD, not a plain field: with no `requiredJoins` the key is ABSENT,
    // so the result object is byte-identical to the pre-R4b one (Ruling 4).
    ...(requiredKeys.length > 0
      ? {
          requiredJoins: buildRequiredReport(
            requiredKeys,
            enforcedKeys,
            preferredKeys,
            drops,
            attempt.mask,
            attempt.barJoins
          ),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// requiredJoins reporting
// ---------------------------------------------------------------------------

/** Drops in the caller's own `requiredJoins` order, so the report is stable
 * across runs and reads in the order the user pinned things — the triage
 * drops are discovered before the DP ones, which would otherwise leak the
 * implementation's phase order into a user-facing list. */
function orderDrops(drops: RequiredJoinDrop[], requiredKeys: readonly string[]): RequiredJoinDrop[] {
  const rank = new Map(requiredKeys.map((key, i) => [key, i]));
  return [...drops].sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
}

function buildRequiredReport(
  requiredKeys: readonly string[],
  enforcedKeys: readonly string[],
  preferredKeys: readonly string[],
  triageDrops: RequiredJoinDrop[],
  mask: number,
  barJoins: readonly { fromBar: number; toBar: number }[]
): RequiredJoinsReport {
  const drops = [...triageDrops];
  const satisfied: string[] = [];

  // ENFORCED: the bit IS the answer. A path sets bit `i` exactly when it
  // traverses pin `i`'s edge, so "bit set" and "key present in `joins`" are
  // the same fact — no set-difference against the plan is needed, and none is
  // done (that inference is what `lockedJoinsDropped` used to have to do).
  for (let i = 0; i < enforcedKeys.length; i++) {
    if (mask & (1 << i)) satisfied.push(enforcedKeys[i]);
    // Every enforced key passed the pre-DP triage, so it IS individually
    // reachable; the only way it can be missing is that the maximum
    // satisfiable set excludes it — i.e. it is incompatible with the pins
    // that were honoured.
    else drops.push({ key: enforcedKeys[i], reason: 'incompatible' });
  }

  // PREFERENCE mode (above the cap): nothing was forced, so the plan itself
  // is the only evidence.
  if (preferredKeys.length > 0) {
    const present = new Set(barJoins.map((j) => joinKey(j.fromBar, j.toBar)));
    for (const key of preferredKeys) {
      if (present.has(key)) satisfied.push(key);
      else drops.push({ key, reason: 'not-enforced' });
    }
  }

  const rank = new Map(requiredKeys.map((key, i) => [key, i]));
  return {
    mode: preferredKeys.length > 0 ? 'preference' : 'enforced',
    satisfied: satisfied.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)),
    dropped: orderDrops(drops, requiredKeys),
  };
}
