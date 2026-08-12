/**
 * Remix join cost function (v1.5, T10): scores how good a splice from bar
 * boundary `from` to bar boundary `to` would sound, as a PER-TERM breakdown
 * (`JoinCostTerms`), never a bare scalar -- the remix panel's tooltip breaks
 * the cost into its terms, and a scalar return would force the panel to
 * recompute the weighting a second place where it can drift from this one.
 * Pure, synchronous, no DSP of its own: every term reads directly off an
 * already-computed `RemixAnalysis` (T9's `remixFeatures.ts` output).
 *
 * ## `numBands` is read from the analysis, never assumed to be 24
 *
 * `T` rows are `numBands` wide and `numBands` can legitimately be 23, not
 * always 24 (T9: the narrowest onset band is exactly 1 bin wide at several
 * sample rates, including 11025 Hz). Every place this module indexes into
 * `T` uses `analysis.numBands` as the stride -- there is no literal `24`
 * anywhere in this file. The test suite deliberately builds its hand-written
 * fixtures with `numBands = 23` specifically to catch a hardcoded-24
 * regression (a fixture that happened to use 24 would pass either way).
 *
 * ## Why `T`/`C`/`R` distances read as plain cosine/Euclidean, no re-normalising
 *
 * `remixFeatures.ts` already L2-normalises `T`, `C`, and `R` rows before
 * storing them, so `cosineDistance`/`euclideanDistance` below do not need to
 * re-normalise for the common case. They still divide by each vector's own
 * norm defensively (rather than assuming norm === 1 exactly) so a
 * pathological all-zero row (silence) or a hand-built test fixture that
 * skips normalisation still produces a defined, sensible distance instead of
 * `0/0 = NaN`. Two DIFFERENT zero-handling rules apply, deliberately: a row
 * compared against itself (both zero, i.e. two silent boundaries) returns
 * distance `0` -- they are literally identical, and silence-to-silence is
 * the least audible splice possible, not the most, so treating it as
 * maximally DISSIMILAR would be actively wrong (fix round 1, Minor 3). A row
 * compared against a genuinely non-zero row returns distance `1` (maximally
 * dissimilar) -- cosine similarity has no defined direction against a zero
 * vector, and "silence spliced against real content" is correctly one of
 * the worst joins available, so the undefined case resolves to the
 * conservative extreme rather than `0` or `NaN`.
 *
 * ## Fixed doc-comment arithmetic (fix round 1, Minor 4)
 *
 * The brief's own prose states the five signal terms (`dT..dStruct`) sum to
 * "a theoretical 4.1" and that `dT`/`dC` range over `[0,2]`. Both are
 * measured wrong against this module's actual weights/inputs: the weighted
 * max is `1.0+1.2+0.8+0.6+0.7 = 4.3` (not 4.1), and because `T`/`C` are
 * always non-negative (L2-normalised recovered-energy / log-magnitude
 * vectors -- `remixFeatures.ts` never produces a negative component), their
 * cosine similarity is confined to `[0,1]` in practice, so `dT`/`dC` are
 * `[0,1]`, not the fully general `[0,2]` a signed vector would allow. Fixed
 * here because this doc comment is the durable justification record for the
 * weights, and future tuning decisions should be made against the real
 * numbers.
 *
 * ## `dStruct`'s three tiers, read as an exhaustive ladder (a documented
 * interpretation of an under-specified brief clause -- reported, not silently
 * guessed)
 *
 * The brief enumerates three cases (transition seen -> 0; unseen but both
 * clusters multi-member -> 0.5; destination a never-followed singleton ->
 * 1.0) but its wording for the 1.0 case ("`cluster[b]` is a singleton that
 * never followed `cluster[a]`") does not literally cover every pair that
 * fails the 0.5 test -- e.g. a SOURCE-singleton, multi-member-destination
 * pair with no recorded transition is not literally "destination is a
 * singleton". Implemented as an EXHAUSTIVE 3-tier ladder with no gap: (1)
 * transition seen -> 0; else (2) both clusters have >= 2 members -> 0.5; else
 * (3) -> 1.0. This is a strict generalisation of the brief's literal wording
 * (every case the brief pins numerically -- all three acceptance-item-3
 * scenarios -- gets the same number under this ladder as under a literal
 * reading), it just also defines the one combination the brief's prose left
 * unstated, which a total cost function cannot leave undefined. See the task
 * report for this being flagged rather than silently assumed.
 *
 * ## Hard-constraint options intentionally have NO default for `strict` /
 * `allowRepeats`
 *
 * The brief states explicit numeric defaults for `edgeGuardBars` (1),
 * `minKeepBars` (`2*phraseBars`), and `maxRepeatBars` (32), but states none
 * for `strict` or `allowRepeats` -- these are caller-facing MODE switches
 * (the remix dialog's "Strict phrase mode" toggle, a possible future "allow
 * repeats" control), not DSP-internal tuning constants, so defaulting either
 * one silently here would be inventing product behaviour this module has no
 * business deciding. Both are REQUIRED fields on `CandidateListOptions`.
 * `minRunBars` is likewise required and undefaulted: T11 computes it itself
 * (`phraseBars` in strict mode, 4 in loose mode per the T11 brief) and must
 * pass the value it actually used, not have this module silently re-derive
 * a possibly-different one.
 *
 * ## Out-of-domain indices THROW (fix round 1, Important 1)
 *
 * `joinCost` is a public export `buildCandidateLists` never calls with an
 * invalid index (it only ever enumerates `[0, numBars]`, verified over
 * 77,324 emitted pairs across 216 option combinations in review), but T13/
 * T14's panel will call `joinCost` directly with UI-derived indices, and an
 * out-of-range `from`/`to` (e.g. `numBars === 0`) previously produced a
 * silent `NaN` throughout `JoinCostTerms` -- `cosineDistance` read past the
 * `Float32Array` end, got `undefined`, and `undefined < 1e-24` is `false`,
 * so the zero-vector guard never caught it. That is exactly the
 * "`undefined` poisoning a Float32Array rather than a throw" hazard the
 * brief names elsewhere. `joinCost` now validates both indices against
 * `[0, analysis.numBars]` up front and THROWS a `RangeError` (not a
 * sentinel value, which would just relocate the same silent-poisoning
 * problem one level up) -- matching this codebase's own convention
 * (`AudioDocument.ts` throws `RangeError` for invalid region args). The
 * check lives ONLY in `joinCost` -- not inside `computeJoinCostTerms`/
 * `cosineDistance`, so the hot per-candidate loop stays branch-free, and not
 * in `buildCandidateLists` either, which calls `computeJoinCostTerms` directly
 * and so bypasses the guard entirely. That is safe for the reason above (its
 * own loops enumerate `[0, numBars]` and cannot emit anything else) and it is
 * why the guard is worth having on the public export: the unvalidated path is
 * the one the module controls, the validated one is the one it does not.
 *
 * ## `phraseBars <= 0` is clamped, not left to propagate NaN (fix round 1,
 * Minor 6)
 *
 * `delta % phraseBars` is `NaN` for `phraseBars <= 0`, and `NaN !== 0` is
 * `true`, so `phrasePenalty` would silently fall through every tier to the
 * mod-4/mod-2 checks instead of signalling a caller error. `phraseBars` is
 * normalised to `Math.max(1, Math.floor(phraseBars))` at both entry points
 * that use it for the phrase-alignment arithmetic (`computeJoinCostTerms`,
 * and `buildCandidateLists`' own `resolved.phraseBars`, which also feeds
 * `isLegalPair`'s delta/strict-congruence checks and the `minKeepBars`
 * default) rather than only inside `phrasePenalty` itself, so the legality
 * pruning and the cost term stay consistent with each other even for a
 * malformed input.
 */

import type { RemixAnalysis } from './remixFeatures';

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

export interface RemixWeights {
  timbre: number;
  chroma: number;
  loudness: number;
  rhythm: number;
  struct: number;
  phrase: number;
  /** Fixed per-join toll applied by the PLANNER's jump-edge cost (T11), not
   * part of `JoinCostTerms.total` -- kept here only so callers have one
   * canonical weights object to tune and persist. */
  jump: number;
}

/**
 * wC (1.2) > wT (1.0): a harmonic mismatch (a IV-chord bar where a V-chord
 * bar was expected) is the most audible failure of a bar splice, while a
 * timbre mismatch merely reads as "different section", often acceptable.
 * wL (0.8) with a 6 dB saturation: `T` is L2-normalised and therefore
 * deliberately blind to level, and 6 dB is where a level change reads as a
 * step rather than a swell. wR (0.6) catches cutting away a fill's
 * resolution or landing on a fill with no setup. wStruct (0.7), the
 * long-range guard both design judges independently named the best musical
 * idea available, sits below chroma because a never-before-seen transition
 * is unusual, not wrong. wPhrase (3.0) makes "musical plausibility over raw
 * signal similarity" numeric: the five signal terms sum to a theoretical 4.3
 * (measured exactly -- see "Fixed doc-comment arithmetic" above; the brief's
 * own prose states 4.1, which is arithmetically wrong against these weights)
 * but occupy roughly 0.2-1.5 on real material, so 3.0 means a spectrally
 * perfect but phrase-misaligned join essentially never beats a
 * phrase-aligned join of ordinary similarity, yet can still beat a
 * pathologically bad one. wJump (0.35) is the planner's fixed per-join toll,
 * not consumed here.
 */
export const DEFAULT_REMIX_WEIGHTS: RemixWeights = {
  timbre: 1.0,
  chroma: 1.2,
  loudness: 0.8,
  rhythm: 0.6,
  struct: 0.7,
  phrase: 3.0,
  jump: 0.35,
};

// ---------------------------------------------------------------------------
// joinCost
// ---------------------------------------------------------------------------

export interface JoinCostTerms {
  /** `dT = 1 - cos(T[from], T[to])`. */
  timbre: number;
  /** `dC = 1 - cos(C[from], C[to])`. */
  chroma: number;
  /** `dL = min(1, abs(L[from]-L[to])/6)`. */
  loudness: number;
  /** `dR = ||R[from]-R[to]||_2 / sqrt(2)`. */
  rhythm: number;
  /** `dStruct` in {0, 0.5, 1.0} -- see the module doc comment. */
  struct: number;
  /** `phrasePen` in {0, 0.5, 0.75, 1}. */
  phrase: number;
  /** The weighted sum of the six terms above (NOT including `weights.jump`,
   * which is the planner's separate per-join toll, not a term of this join's
   * own cost). */
  total: number;
}

/** `1 - cosine similarity` between two `dim`-wide rows starting at `offA`/
 * `offB` in (possibly different) arrays. Two zero-handling rules (see the
 * module doc comment, fix round 1 Minor 3): BOTH rows near-zero -> distance
 * `0` (identical silence, not maximally dissimilar); exactly ONE row
 * near-zero -> distance `1` (undefined direction, treated as the worst
 * case). Cosine is clamped to `[-1,1]` before subtracting, guarding against
 * float round-off nudging an identical pair's cosine to e.g.
 * `1.0000000002`. */
function cosineDistance(a: Float32Array, offA: number, b: Float32Array, offB: number, dim: number): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < dim; i++) {
    const va = a[offA + i];
    const vb = b[offB + i];
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const zeroA = normA < 1e-24;
  const zeroB = normB < 1e-24;
  if (zeroA && zeroB) return 0;
  if (zeroA || zeroB) return 1;
  const cos = dot / Math.sqrt(normA * normB);
  const clamped = Math.max(-1, Math.min(1, cos));
  return 1 - clamped;
}

/** Euclidean distance between two `dim`-wide rows. */
function euclideanDistance(a: Float32Array, offA: number, b: Float32Array, offB: number, dim: number): number {
  let sumSq = 0;
  for (let i = 0; i < dim; i++) {
    const d = a[offA + i] - b[offB + i];
    sumSq += d * d;
  }
  return Math.sqrt(sumSq);
}

/** `boundary -> cluster label -> how many boundaries share it`, computed once
 * per `buildCandidateLists` call (not once per candidate pair -- see that
 * function's own comment) and once per standalone `joinCost` call unless the
 * caller supplies a precomputed one (fix round 1, Minor 5) -- exported so a
 * caller making many `joinCost` calls against the same analysis (e.g. T11's
 * DP relaxation) can compute this once and pass it in every time, instead of
 * paying an `O(numBars)` rebuild per call. */
export function clusterMemberCounts(cluster: Int32Array): Map<number, number> {
  const counts = new Map<number, number>();
  for (let i = 0; i < cluster.length; i++) {
    counts.set(cluster[i], (counts.get(cluster[i]) ?? 0) + 1);
  }
  return counts;
}

/** See the module doc comment ("dStruct's three tiers") for why this is an
 * exhaustive ladder rather than a literal transcription of the brief's
 * prose. */
function structCost(analysis: RemixAnalysis, from: number, to: number, memberCounts: Map<number, number>): number {
  const clusterFrom = analysis.cluster[from];
  const clusterTo = analysis.cluster[to];
  if (analysis.transitionSeen.has(`${clusterFrom}>${clusterTo}`)) return 0;
  const bothMultiMember = (memberCounts.get(clusterFrom) ?? 0) >= 2 && (memberCounts.get(clusterTo) ?? 0) >= 2;
  return bothMultiMember ? 0.5 : 1.0;
}

/** `0` when `from === to (mod phraseBars)`; `0.5` when `(mod 4)`; `0.75` when
 * `(mod 2)`; `1` otherwise. Tiers are checked independently of each other (a
 * small `phraseBars`, e.g. 2 or 4, just makes an earlier tier subsume a
 * later one) -- direction-independent (`abs(to-from)`), since phrase
 * congruence is a property of the pair, not of which one is "from".
 * `phraseBars` is assumed already normalised to >= 1 by the caller (both
 * callers in this module do so -- see the module doc comment, fix round 1
 * Minor 6). */
function phrasePenalty(from: number, to: number, phraseBars: number): number {
  const delta = Math.abs(to - from);
  if (delta % phraseBars === 0) return 0;
  if (delta % 4 === 0) return 0.5;
  if (delta % 2 === 0) return 0.75;
  return 1;
}

/** `phraseBars <= 0` (or non-integer) would otherwise poison `delta %
 * phraseBars` into `NaN` -- see the module doc comment, fix round 1 Minor
 * 6. */
function normalizePhraseBars(phraseBars: number): number {
  return Math.max(1, Math.floor(phraseBars));
}

function computeJoinCostTerms(
  analysis: RemixAnalysis,
  weights: RemixWeights,
  phraseBarsRaw: number,
  from: number,
  to: number,
  memberCounts: Map<number, number>
): JoinCostTerms {
  const numBands = analysis.numBands;
  const rDims = 4 * analysis.beatsPerBar;
  const phraseBars = normalizePhraseBars(phraseBarsRaw);

  const dT = cosineDistance(analysis.T, from * numBands, analysis.T, to * numBands, numBands);
  const dC = cosineDistance(analysis.C, from * 12, analysis.C, to * 12, 12);
  const dL = Math.min(1, Math.abs(analysis.L[from] - analysis.L[to]) / 6);
  const dR = euclideanDistance(analysis.R, from * rDims, analysis.R, to * rDims, rDims) / Math.SQRT2;
  const dStruct = structCost(analysis, from, to, memberCounts);
  const phrasePen = phrasePenalty(from, to, phraseBars);

  const total =
    weights.timbre * dT +
    weights.chroma * dC +
    weights.loudness * dL +
    weights.rhythm * dR +
    weights.struct * dStruct +
    weights.phrase * phrasePen;

  return { timbre: dT, chroma: dC, loudness: dL, rhythm: dR, struct: dStruct, phrase: phrasePen, total };
}

/** Throws `RangeError` unless `index` is an integer in `[0, analysis.numBars]`
 * -- see the module doc comment, fix round 1 Important 1. */
function assertValidBoundaryIndex(analysis: RemixAnalysis, index: number, label: string): void {
  if (!Number.isInteger(index) || index < 0 || index > analysis.numBars) {
    throw new RangeError(
      `joinCost: ${label}=${index} is out of range for numBars=${analysis.numBars} (expected an integer in [0, ${analysis.numBars}])`
    );
  }
}

/**
 * Per-term join cost breakdown for an ordered boundary pair `(from, to)`.
 * Pure math over an already-computed `RemixAnalysis` -- does not enforce any
 * of the hard constraints (that is `buildCandidateLists`' job); this
 * function will happily score a pair `buildCandidateLists` would have
 * pruned. Throws `RangeError` if `from`/`to` is not an integer in
 * `[0, analysis.numBars]` (fix round 1 Important 1) -- `buildCandidateLists`
 * never triggers this (it only ever enumerates that same range), but a
 * UI-derived index reaching this public export directly must not be allowed
 * to silently poison `JoinCostTerms` with `NaN`.
 *
 * `precomputedClusterMemberCounts` is optional (fix round 1, Minor 5): a
 * caller making many `joinCost` calls against the same `analysis` (e.g. a
 * planner's DP relaxation loop) can compute it once via
 * `clusterMemberCounts(analysis.cluster)` and pass it in, instead of paying
 * an `O(numBars)` rebuild on every call. Omitting it (the common case for a
 * one-off UI tooltip lookup) computes it fresh, exactly as before.
 */
export function joinCost(
  analysis: RemixAnalysis,
  weights: RemixWeights,
  phraseBars: number,
  from: number,
  to: number,
  precomputedClusterMemberCounts?: Map<number, number>
): JoinCostTerms {
  assertValidBoundaryIndex(analysis, from, 'from');
  assertValidBoundaryIndex(analysis, to, 'to');
  const memberCounts = precomputedClusterMemberCounts ?? clusterMemberCounts(analysis.cluster);
  return computeJoinCostTerms(analysis, weights, phraseBars, from, to, memberCounts);
}

// ---------------------------------------------------------------------------
// buildCandidateLists
// ---------------------------------------------------------------------------

/** The fixed cap on candidates kept per `from`, capping DP out-degree
 * independently of song length. A brief-pinned constant, not a tunable
 * option. */
export const CANDIDATE_LIST_K = 24;

export interface CandidateListOptions {
  weights: RemixWeights;
  phraseBars: number;
  /** The bound the planner needs: no emitted `to` may leave fewer than
   * `minRunBars` bars before the end of the lattice (`to + minRunBars <=
   * numBars`). Required -- see the module doc comment. */
  minRunBars: number;
  /** Hard `from === to (mod phraseBars)` when true. Required -- see the
   * module doc comment. */
  strict: boolean;
  /** Backward jumps (`to < from`, a repeat) are illegal unless this is true.
   * Required -- see the module doc comment. */
  allowRepeats: boolean;
  /** `edgeGuardBars <= from, to <= numBars - edgeGuardBars`. Default 1. */
  edgeGuardBars?: number;
  /** Deletions (`to > from`) satisfy `to - from <= numBars - minKeepBars`.
   * Default `2 * phraseBars`. */
  minKeepBars?: number;
  /** Repeats (`to < from`) satisfy `from - to <= maxRepeatBars`. Default 32. */
  maxRepeatBars?: number;
  /** `${from}>${to}` keys that are illegal regardless of everything else.
   * Default empty. */
  forbiddenJoins?: Iterable<string>;
}

function isLegalPair(
  from: number,
  to: number,
  numBars: number,
  o: Required<Omit<CandidateListOptions, 'weights' | 'forbiddenJoins'>>,
  forbidden: ReadonlySet<string>
): boolean {
  if (from === to) return false;
  if (from < o.edgeGuardBars || from > numBars - o.edgeGuardBars) return false;
  if (to < o.edgeGuardBars || to > numBars - o.edgeGuardBars) return false;

  const delta = Math.abs(to - from);
  if (delta < o.phraseBars) return false;

  if (to > from) {
    if (to - from > numBars - o.minKeepBars) return false;
  } else {
    if (!o.allowRepeats) return false;
    if (from - to > o.maxRepeatBars) return false;
  }

  if (o.strict && delta % o.phraseBars !== 0) return false;
  if (forbidden.has(`${from}>${to}`)) return false;
  if (to + o.minRunBars > numBars) return false;

  return true;
}

/**
 * The `CANDIDATE_LIST_K` cheapest LEGAL `to` for every possible `from` in
 * `[0, numBars]`, sorted ascending by `joinCost(...).total`. Returns one
 * `Int32Array` per `from` (length `numBars + 1`, so the planner can index it
 * directly by bar position); an `from` with no legal candidates (or one that
 * itself violates the edge guard) gets an empty array, never a missing
 * index. Ties in cost break toward the lower `to`, so two calls on identical
 * input always produce byte-identical lists regardless of sort-stability
 * assumptions.
 */
export function buildCandidateLists(analysis: RemixAnalysis, o: CandidateListOptions): Int32Array[] {
  const numBars = analysis.numBars;
  // `phraseBars` is normalised ONCE here so `isLegalPair`'s delta/strict-
  // congruence checks, its `minKeepBars` default, AND the cost computation
  // below all agree on the same value -- see the module doc comment, fix
  // round 1 Minor 6.
  const phraseBars = normalizePhraseBars(o.phraseBars);
  const resolved = {
    phraseBars,
    minRunBars: o.minRunBars,
    strict: o.strict,
    allowRepeats: o.allowRepeats,
    edgeGuardBars: o.edgeGuardBars ?? 1,
    minKeepBars: o.minKeepBars ?? 2 * phraseBars,
    maxRepeatBars: o.maxRepeatBars ?? 32,
  };
  const forbidden = new Set(o.forbiddenJoins ?? []);
  const memberCounts = clusterMemberCounts(analysis.cluster);

  const lists: Int32Array[] = [];
  for (let from = 0; from <= numBars; from++) {
    const candidates: { to: number; cost: number }[] = [];
    for (let to = 0; to <= numBars; to++) {
      if (!isLegalPair(from, to, numBars, resolved, forbidden)) continue;
      const terms = computeJoinCostTerms(analysis, o.weights, phraseBars, from, to, memberCounts);
      candidates.push({ to, cost: terms.total });
    }
    candidates.sort((x, y) => x.cost - y.cost || x.to - y.to);
    lists.push(Int32Array.from(candidates.slice(0, CANDIDATE_LIST_K).map((c) => c.to)));
  }
  return lists;
}
