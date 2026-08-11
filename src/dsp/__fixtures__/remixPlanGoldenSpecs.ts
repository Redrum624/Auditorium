/**
 * Shared `RemixAnalysis` builders and the GOLDEN CASE MATRIX for the auto-remix
 * planner. Committed to the repo and imported by BOTH consumers, so the two can
 * never drift:
 *
 *   - `src/dsp/remixPlan.test.ts` — replays the matrix against the shipped
 *     planner and asserts it reproduces `remixPlanGolden.ts` field for field.
 *   - `scripts/gen-remix-plan-golden.cjs` — regenerates `remixPlanGolden.ts`,
 *     optionally from a PAST revision of the planner (`--from=<git-rev>`).
 *
 * WHY THIS FILE EXISTS (R4b fix round 1, I7). The golden pins the single most
 * load-bearing property of R4b — that an empty `requiredJoins` leaves the
 * planner byte-identical — and its numbers came from the planner at commit
 * `5dfa19d`, before the option existed. Originally the generator AND these
 * specs lived in a gitignored scratch directory, which made that provenance
 * unverifiable and the fixture unregenerable by anyone outside the session that
 * produced it. That is precisely the weakness R4b's own headline finding
 * diagnosed in the uncommitted 156-case pin rig, so repeating it inside the
 * same change was not acceptable. Everything needed to re-derive the golden now
 * lives in the repo and survives `git clean -fdx`.
 *
 * This file is NOT a test: jest's renderer project collects only `*.test.ts`
 * and `*.test.tsx`, so it adds nothing to the suite count.
 */
import { DEFAULT_REMIX_WEIGHTS } from '../remixCost';
import type { RemixAnalysis } from '../remixFeatures';
import type { PlanRemixOptions } from '../remixPlan';


// ---------------------------------------------------------------------------
// Hand-built RemixAnalysis fixtures -- driven from a SYNTHETIC sections array
// plus a STUBBED (hand-controlled) join cost matrix, per the brief, so the
// search is tested independently of the DSP (T10's `remixCost.test.ts` uses
// the same approach for `joinCost`/`buildCandidateLists` themselves).
// ---------------------------------------------------------------------------

const NUM_BANDS = 23; // T9/T10 precedent: never 24, to catch a hardcoded stride
const BEATS_PER_BAR = 4;
const R_DIMS = 4 * BEATS_PER_BAR;

export interface UniformOverrides {
  numBars: number;
  barLen?: number;
  head?: number;
  tail?: number;
  confidence?: number;
  L?: (i: number) => number;
  cluster?: Int32Array;
  transitionSeen?: Set<string>;
}

/** Uniform bar length (every bar exactly `barLen` samples) -- deliberately
 * simple so expected `outputSample` values for structural tests (feasibility
 * window, out-of-bounds, min-run, determinism, purity, exact mode) can be
 * hand-computed as `head + n*barLen + tail`. The HEADLINE duration-accuracy
 * test below uses a separate, genuinely VARYING-bar-length fixture instead --
 * this one must never be used to assert a duration property that would only
 * hold if the planner assumed uniform spacing. */
export function makeUniformAnalysis(o: UniformOverrides): RemixAnalysis {
  const { numBars } = o;
  const barLen = o.barLen ?? 10000;
  const head = o.head ?? 500;
  const tail = o.tail ?? 800;
  const numBoundaries = numBars + 1;
  const barBoundary = Int32Array.from({ length: numBoundaries }, (_, i) => head + i * barLen);
  const analyzedEndSample = barBoundary[numBars] + tail;
  const L = new Float32Array(numBoundaries);
  if (o.L) for (let i = 0; i < numBoundaries; i++) L[i] = o.L(i);

  return {
    bpm: 120,
    confidence: o.confidence ?? 1,
    beatSamples: Int32Array.from({ length: numBoundaries * BEATS_PER_BAR }, (_, i) => i * (barLen / BEATS_PER_BAR)),
    salience: 1,
    peakRatio: 1,
    ibiCv: 0,
    truncated: false,
    analyzedEndSample,
    odf: new Float32Array(0),
    periodFrames: 20,
    decimationFactor: 4,
    bands: new Float32Array(0),
    numBands: NUM_BANDS,
    odfLow: new Float32Array(0),
    chroma: new Float32Array(0),
    numChromaFrames: 0,
    chromaRate: 10,
    beatsPerBar: BEATS_PER_BAR,
    downbeatPhase: 0,
    downbeatConfidence: 0,
    barBoundary,
    numBars,
    T: new Float32Array(numBoundaries * NUM_BANDS),
    C: new Float32Array(numBoundaries * 12),
    L,
    R: new Float32Array(numBoundaries * R_DIMS),
    S: new Float32Array(numBoundaries * (NUM_BANDS + 12)),
    cluster: o.cluster ?? Int32Array.from({ length: numBoundaries }, (_, i) => i),
    transitionSeen: o.transitionSeen ?? new Set<string>(),
  };
}

/** Deterministic LCG, verbatim recipe from `remixFeatures.test.ts`/
 * `fft.test.ts:104` -- this repo's own precedent for reproducible synthetic
 * jitter, not a fresh invention. */
export function makeLcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
}

/** GENUINELY VARYING bar lengths (a few ms of jitter around a base length,
 * deterministic via an LCG, never uniform) -- for the headline duration-
 * accuracy test, which must never pass merely because the fixture happens to
 * be uniform. */
export function makeVaryingAnalysis(numBars: number): RemixAnalysis {
  const baseBarLen = 22050; // ~0.5 s at 44.1 kHz
  const head = 4000;
  const tail = 3000;
  const numBoundaries = numBars + 1;
  const rand = makeLcg(7);
  const barBoundary = new Int32Array(numBoundaries);
  barBoundary[0] = head;
  for (let i = 1; i <= numBars; i++) {
    const jitter = Math.round(rand() * 400); // +/-200 samples of drift, never 0 for every bar
    barBoundary[i] = barBoundary[i - 1] + baseBarLen + jitter;
  }
  const analyzedEndSample = barBoundary[numBars] + tail;

  return {
    bpm: 120,
    confidence: 1,
    beatSamples: Int32Array.from({ length: numBoundaries * BEATS_PER_BAR }, (_, i) => i * Math.round(baseBarLen / BEATS_PER_BAR)),
    salience: 1,
    peakRatio: 1,
    ibiCv: 0,
    truncated: false,
    analyzedEndSample,
    odf: new Float32Array(0),
    periodFrames: 20,
    decimationFactor: 4,
    bands: new Float32Array(0),
    numBands: NUM_BANDS,
    odfLow: new Float32Array(0),
    chroma: new Float32Array(0),
    numChromaFrames: 0,
    chromaRate: 10,
    beatsPerBar: BEATS_PER_BAR,
    downbeatPhase: 0,
    downbeatConfidence: 0,
    barBoundary,
    numBars,
    T: new Float32Array(numBoundaries * NUM_BANDS),
    C: new Float32Array(numBoundaries * 12),
    L: new Float32Array(numBoundaries),
    R: new Float32Array(numBoundaries * R_DIMS),
    S: new Float32Array(numBoundaries * (NUM_BANDS + 12)),
    cluster: Int32Array.from({ length: numBoundaries }, () => 0), // one shared cluster
    // EVERY pair "seen", in one key. `structCost` looks transitions up by
    // CLUSTER id (`${cluster[from]}>${cluster[to]}`), and the line above puts
    // every bar in cluster 0, so `'0>0'` IS every pair -- a uniform-cost
    // candidate graph (dStruct === 0 everywhere legal) that leaves selection
    // to the feasibility window alone, isolating the duration bookkeeping
    // under test from cost-based tie-breaking.
    //
    // This used to be a nested loop over bar indices adding the same constant
    // key `numBoundaries^2` times: dead code that described a set it did not
    // build, in the file that is the golden's generator input (fix round 3).
    // The set it actually built is this one, so no golden moves.
    transitionSeen: new Set<string>(['0>0']),
  };
}

/**
 * Varying bar lengths AND a genuinely non-degenerate cost landscape (R4b).
 *
 * `makeUniformAnalysis`/`makeVaryingAnalysis` leave every feature array at
 * zero, so `joinCost` returns the SAME total for every legal candidate and
 * the planner is choosing between equals. That is deliberate for the
 * structural tests (it isolates the feasibility window from cost tie-breaks)
 * and useless for anything that has to observe the planner PREFERRING one
 * arrangement over another. This fills all five feature arrays from the same
 * deterministic LCG so the cost surface has structure, and clusters bars into
 * four sections so `dStruct` varies too.
 */
export function makeRichAnalysis(numBars: number, seed = 7): RemixAnalysis {
  const baseBarLen = 22050;
  const head = 4000;
  const tail = 3000;
  const nb = numBars + 1;
  const rand = makeLcg(seed);
  const barBoundary = new Int32Array(nb);
  barBoundary[0] = head;
  for (let i = 1; i <= numBars; i++) barBoundary[i] = barBoundary[i - 1] + baseBarLen + Math.round(rand() * 400);
  const feature = makeLcg(seed * 13 + 1);
  const fill = (n: number): Float32Array => {
    const arr = new Float32Array(n);
    for (let i = 0; i < n; i++) arr[i] = feature();
    return arr;
  };

  return {
    bpm: 120,
    confidence: 1,
    beatSamples: Int32Array.from({ length: nb * BEATS_PER_BAR }, (_, i) => i * Math.round(baseBarLen / BEATS_PER_BAR)),
    salience: 1,
    peakRatio: 1,
    ibiCv: 0,
    truncated: false,
    analyzedEndSample: barBoundary[numBars] + tail,
    odf: new Float32Array(0),
    periodFrames: 20,
    decimationFactor: 4,
    bands: new Float32Array(0),
    numBands: NUM_BANDS,
    odfLow: new Float32Array(0),
    chroma: new Float32Array(0),
    numChromaFrames: 0,
    chromaRate: 10,
    beatsPerBar: BEATS_PER_BAR,
    downbeatPhase: 0,
    downbeatConfidence: 0,
    barBoundary,
    numBars,
    T: fill(nb * NUM_BANDS),
    C: fill(nb * 12),
    L: fill(nb),
    R: fill(nb * R_DIMS),
    S: fill(nb * (NUM_BANDS + 12)),
    cluster: Int32Array.from({ length: nb }, (_, i) => i % 4),
    transitionSeen: new Set<string>(),
  };
}

export function baseOptions(overrides: Partial<PlanRemixOptions>): PlanRemixOptions {
  return {
    targetSample: 0,
    weights: DEFAULT_REMIX_WEIGHTS,
    phraseBars: 8,
    strict: true,
    allowRepeats: false,
    ...overrides,
  };
}

/** The golden case matrix. One definition, replayed field-for-field against
 * `REMIX_PLAN_GOLDEN`, which was generated from the planner as it stood
 * BEFORE `requiredJoins` existed (see that file's header). */
export interface RemixPlanGoldenSpec {
  name: string;
  analysis: () => RemixAnalysis;
  opts: (a: RemixAnalysis) => PlanRemixOptions;
}

export const REMIX_PLAN_GOLDEN_SPECS: RemixPlanGoldenSpec[] = [
  {
    name: 'uniform-40-strict-roll0-0.75',
    analysis: () => makeUniformAnalysis({ numBars: 40 }),
    opts: (a) => baseOptions({ targetSample: Math.round(a.analyzedEndSample * 0.75), strict: true, allowRepeats: true }),
  },
  {
    name: 'uniform-40-loose-roll2-1.40',
    analysis: () => makeUniformAnalysis({ numBars: 40 }),
    opts: (a) => baseOptions({ targetSample: Math.round(a.analyzedEndSample * 1.4), strict: false, allowRepeats: true, rollIndex: 2 }),
  },
  {
    name: 'uniform-24-clustered-strict-roll1-1.00',
    analysis: () => makeUniformAnalysis({ numBars: 24, cluster: Int32Array.from({ length: 25 }, (_, i) => i % 3) }),
    opts: (a) => baseOptions({ targetSample: a.analyzedEndSample, strict: true, allowRepeats: true, rollIndex: 1 }),
  },
  {
    name: 'varying-48-strict-roll0-0.50',
    analysis: () => makeVaryingAnalysis(48),
    opts: (a) => baseOptions({ targetSample: Math.round(a.analyzedEndSample * 0.5), strict: true, allowRepeats: true }),
  },
  {
    name: 'varying-48-strict-roll3-1.25',
    analysis: () => makeVaryingAnalysis(48),
    opts: (a) => baseOptions({ targetSample: Math.round(a.analyzedEndSample * 1.25), strict: true, allowRepeats: true, rollIndex: 3 }),
  },
  {
    name: 'varying-64-loose-roll1-2.00',
    analysis: () => makeVaryingAnalysis(64),
    opts: (a) => baseOptions({ targetSample: Math.round(a.analyzedEndSample * 2.0), strict: false, allowRepeats: true, rollIndex: 1 }),
  },
  {
    name: 'varying-64-strict-exact-1.10',
    analysis: () => makeVaryingAnalysis(64),
    opts: (a) => baseOptions({ targetSample: Math.round(a.analyzedEndSample * 1.1), strict: true, allowRepeats: true, exactLength: true }),
  },
  {
    name: 'uniform-40-strict-norepeat-0.60',
    analysis: () => makeUniformAnalysis({ numBars: 40 }),
    opts: (a) => baseOptions({ targetSample: Math.round(a.analyzedEndSample * 0.6), strict: true, allowRepeats: false }),
  },
];

/** Shape constants shared with `remixPlan.test.ts`'s own one-off fixtures.
 * `NUM_BANDS` is 23 — deliberately never 24 (T9/T10 precedent), so a hardcoded
 * stride anywhere downstream shows up as a wrong answer rather than passing. */
export const REMIX_FIXTURE_NUM_BANDS = NUM_BANDS;
export const REMIX_FIXTURE_BEATS_PER_BAR = BEATS_PER_BAR;
export const REMIX_FIXTURE_R_DIMS = R_DIMS;
