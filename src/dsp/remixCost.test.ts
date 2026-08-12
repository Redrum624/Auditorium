import { joinCost, buildCandidateLists, clusterMemberCounts, DEFAULT_REMIX_WEIGHTS, CANDIDATE_LIST_K } from './remixCost';
import type { RemixWeights } from './remixCost';
import { analyzeRemix } from './remixFeatures';
import type { RemixAnalysis } from './remixFeatures';

// ---------------------------------------------------------------------------
// Hand-built RemixAnalysis fixture factory (acceptance items 1,2,3,5,6,7,8
// are all driven from a hand-built literal, per the brief, so the cost
// function is tested independently of the DSP). `numBands = 23` is a
// DELIBERATE choice, not an arbitrary one: T9 measured `numBands` can be 23,
// not always 24, at several real sample rates, so a fixture that happened to
// use 24 everywhere would silently pass a hardcoded-24 bug. Every hand-built
// test below uses 23 specifically to guard against that.
// ---------------------------------------------------------------------------

const NUM_BANDS = 23;
const BEATS_PER_BAR = 4;
const R_DIMS = 4 * BEATS_PER_BAR; // 16

interface AnalysisOverrides {
  numBoundaries: number;
  T?: Float32Array;
  C?: Float32Array;
  L?: Float32Array;
  R?: Float32Array;
  cluster?: Int32Array;
  transitionSeen?: Set<string>;
  beatsPerBar?: number;
  numBands?: number;
}

/** Builds a minimal-but-complete `RemixAnalysis`. Fields irrelevant to the
 * cost function (bpm, odf, chroma pass metadata, ...) are filled with inert
 * placeholders; only `T`/`C`/`L`/`R`/`cluster`/`transitionSeen`/`numBands`/
 * `beatsPerBar`/`numBars` matter to `joinCost`/`buildCandidateLists`. */
function makeAnalysis(o: AnalysisOverrides): RemixAnalysis {
  const numBoundaries = o.numBoundaries;
  const numBands = o.numBands ?? NUM_BANDS;
  const beatsPerBar = o.beatsPerBar ?? BEATS_PER_BAR;
  const rDims = 4 * beatsPerBar;

  return {
    // TempoAnalysis base -- inert placeholders, not read by the cost function.
    bpm: 120,
    confidence: 1,
    beatSamples: Int32Array.from({ length: numBoundaries }, (_, i) => i * 1000),
    salience: 1,
    peakRatio: 1,
    ibiCv: 0,
    truncated: false,
    analyzedEndSample: numBoundaries * 1000,
    odf: new Float32Array(0),
    periodFrames: 20,
    decimationFactor: 4,
    bands: new Float32Array(0),
    numBands,
    odfLow: new Float32Array(0),
    // RemixAnalysis extras.
    chroma: new Float32Array(0),
    numChromaFrames: 0,
    chromaRate: 10,
    beatsPerBar,
    downbeatPhase: 0,
    downbeatConfidence: 0,
    barBoundary: Int32Array.from({ length: numBoundaries }, (_, i) => i * 1000),
    numBars: numBoundaries - 1,
    T: o.T ?? new Float32Array(numBoundaries * numBands),
    C: o.C ?? new Float32Array(numBoundaries * 12),
    L: o.L ?? new Float32Array(numBoundaries),
    R: o.R ?? new Float32Array(numBoundaries * rDims),
    S: new Float32Array(numBoundaries * (numBands + 12)),
    cluster: o.cluster ?? Int32Array.from({ length: numBoundaries }, (_, i) => i), // default: every boundary its own singleton cluster
    transitionSeen: o.transitionSeen ?? new Set<string>(),
  };
}

function setRow(arr: Float32Array, index: number, dim: number, values: number[]): void {
  for (let i = 0; i < dim; i++) arr[index * dim + i] = values[i];
}

function oneHot(dim: number, hotIndex: number): number[] {
  const v = new Array(dim).fill(0);
  v[hotIndex] = 1;
  return v;
}

function arbitraryVec(dim: number, salt: number): number[] {
  return Array.from({ length: dim }, (_, i) => Math.sin((salt * 7 + i * 3) * 0.53) + 2);
}

// ---------------------------------------------------------------------------
// 1. CLOSED FORMS
// ---------------------------------------------------------------------------

describe('joinCost -- closed forms (acceptance 1)', () => {
  it('identical descriptors -> dT === 0, dC === 0, dR === 0', () => {
    const a = makeAnalysis({ numBoundaries: 2 });
    const tVec = arbitraryVec(NUM_BANDS, 1);
    const cVec = arbitraryVec(12, 2);
    const rVec = arbitraryVec(R_DIMS, 3);
    setRow(a.T, 0, NUM_BANDS, tVec);
    setRow(a.T, 1, NUM_BANDS, tVec);
    setRow(a.C, 0, 12, cVec);
    setRow(a.C, 1, 12, cVec);
    setRow(a.R, 0, R_DIMS, rVec);
    setRow(a.R, 1, R_DIMS, rVec);

    const terms = joinCost(a, DEFAULT_REMIX_WEIGHTS, 4, 0, 1);
    expect(terms.timbre).toBeCloseTo(0, 6);
    expect(terms.chroma).toBeCloseTo(0, 6);
    expect(terms.rhythm).toBeCloseTo(0, 6);
  });

  it('two identical all-zero (silent) rows -> dT === 0, dC === 0 (fix round 1, Minor 3)', () => {
    // T/C/R default to all-zero when not overridden (see makeAnalysis). Two
    // silent boundaries are IDENTICAL, and silence-to-silence is the least
    // audible splice available, not the most -- so this must NOT read as
    // maximally dissimilar (the pre-fix behaviour, which returned dT=dC=1
    // for a zero-vs-zero comparison because the zero-vector guard didn't
    // distinguish "both zero" from "one zero").
    const a = makeAnalysis({ numBoundaries: 2 });
    const terms = joinCost(a, DEFAULT_REMIX_WEIGHTS, 4, 0, 1);
    expect(terms.timbre).toBeCloseTo(0, 6);
    expect(terms.chroma).toBeCloseTo(0, 6);
    expect(terms.rhythm).toBeCloseTo(0, 6);
  });

  it('a silent row against a genuinely non-zero row -> dT === 1 (undefined direction, worst case)', () => {
    const a = makeAnalysis({ numBoundaries: 2 });
    setRow(a.T, 1, NUM_BANDS, arbitraryVec(NUM_BANDS, 9)); // boundary 0 stays all-zero
    const terms = joinCost(a, DEFAULT_REMIX_WEIGHTS, 4, 0, 1);
    expect(terms.timbre).toBeCloseTo(1, 6);
  });

  it('a 3 dB level gap -> dL === 0.5 exactly', () => {
    const a = makeAnalysis({ numBoundaries: 2 });
    a.L[0] = -20;
    a.L[1] = -17; // |diff| = 3
    const terms = joinCost(a, DEFAULT_REMIX_WEIGHTS, 4, 0, 1);
    expect(terms.loudness).toBeCloseTo(0.5, 6);
  });

  it('a 12 dB level gap -> dL === 1.0 (saturated)', () => {
    const a = makeAnalysis({ numBoundaries: 2 });
    a.L[0] = -20;
    a.L[1] = -8; // |diff| = 12
    const terms = joinCost(a, DEFAULT_REMIX_WEIGHTS, 4, 0, 1);
    expect(terms.loudness).toBeCloseTo(1.0, 6);
  });

  it('orthogonal chroma vectors -> dC === 1.0', () => {
    const a = makeAnalysis({ numBoundaries: 2 });
    setRow(a.C, 0, 12, oneHot(12, 0));
    setRow(a.C, 1, 12, oneHot(12, 1));
    const terms = joinCost(a, DEFAULT_REMIX_WEIGHTS, 4, 0, 1);
    expect(terms.chroma).toBeCloseTo(1.0, 6);
  });
});

// ---------------------------------------------------------------------------
// joinCost -- out-of-domain indices THROW (fix round 1, Important 1)
// ---------------------------------------------------------------------------

describe('joinCost -- out-of-domain indices (fix round 1, Important 1)', () => {
  it('throws RangeError instead of silently returning NaN when to is out of range', () => {
    // numBars === 0 (a single-boundary, degenerate analysis) -- the exact
    // review repro: joinCost(a, w, 8, 0, 5) previously gave
    // {timbre: NaN, ..., total: NaN} because cosineDistance read past the
    // Float32Array end (undefined < 1e-24 is false, so the zero-vector guard
    // never caught it).
    const a = makeAnalysis({ numBoundaries: 1 });
    expect(a.numBars).toBe(0);
    expect(() => joinCost(a, DEFAULT_REMIX_WEIGHTS, 8, 0, 5)).toThrow(RangeError);
  });

  it('throws RangeError for a negative index', () => {
    const a = makeAnalysis({ numBoundaries: 5 });
    expect(() => joinCost(a, DEFAULT_REMIX_WEIGHTS, 4, -1, 2)).toThrow(RangeError);
  });

  it('throws RangeError for a non-integer index', () => {
    const a = makeAnalysis({ numBoundaries: 5 });
    expect(() => joinCost(a, DEFAULT_REMIX_WEIGHTS, 4, 1.5, 2)).toThrow(RangeError);
  });

  it('does NOT throw for the boundary values of the valid domain (0 and numBars)', () => {
    const a = makeAnalysis({ numBoundaries: 5 }); // numBars === 4
    expect(() => joinCost(a, DEFAULT_REMIX_WEIGHTS, 4, 0, 4)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// phraseBars <= 0 is clamped, not left to propagate NaN (fix round 1, Minor 6)
// ---------------------------------------------------------------------------

describe('phraseBars <= 0 guard (fix round 1, Minor 6)', () => {
  it('joinCost with phraseBars === 0 does not produce NaN and matches the phraseBars === 1 result', () => {
    const a = makeAnalysis({ numBoundaries: 6 });
    const zero = joinCost(a, DEFAULT_REMIX_WEIGHTS, 0, 0, 3);
    const one = joinCost(a, DEFAULT_REMIX_WEIGHTS, 1, 0, 3);
    expect(Number.isNaN(zero.phrase)).toBe(false);
    expect(Number.isNaN(zero.total)).toBe(false);
    expect(zero.phrase).toBeCloseTo(one.phrase, 6);
  });

  it('joinCost with a negative phraseBars behaves the same as phraseBars === 1', () => {
    const a = makeAnalysis({ numBoundaries: 6 });
    const negative = joinCost(a, DEFAULT_REMIX_WEIGHTS, -5, 0, 3);
    const one = joinCost(a, DEFAULT_REMIX_WEIGHTS, 1, 0, 3);
    expect(negative.phrase).toBeCloseTo(one.phrase, 6);
  });

  it('buildCandidateLists with phraseBars === 0 does not throw or produce NaN-poisoned lists', () => {
    const a = makeConstraintAnalysis();
    expect(() =>
      buildCandidateLists(a, {
        weights: DEFAULT_REMIX_WEIGHTS,
        phraseBars: 0,
        minRunBars: 4,
        strict: false,
        allowRepeats: true,
      })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. PHRASE PENALTY
// ---------------------------------------------------------------------------

describe('joinCost -- phrase penalty (acceptance 2)', () => {
  const PHI = 8;
  const a = makeAnalysis({ numBoundaries: PHI + 1 });

  it.each([
    [0, 8, 0],
    [0, 4, 0.5],
    [0, 2, 0.75],
    [0, 3, 1.0],
  ])('(%i,%i) -> phrasePen === %f for Phi = 8', (from, to, expected) => {
    const terms = joinCost(a, DEFAULT_REMIX_WEIGHTS, PHI, from, to);
    expect(terms.phrase).toBeCloseTo(expected, 6);
  });
});

// ---------------------------------------------------------------------------
// 3. dStruct discrete
// ---------------------------------------------------------------------------

describe('joinCost -- dStruct discrete (acceptance 3)', () => {
  it('a transition present in transitionSeen -> dStruct === 0', () => {
    const a = makeAnalysis({
      numBoundaries: 2,
      cluster: Int32Array.from([0, 1]),
      transitionSeen: new Set(['0>1']),
    });
    const terms = joinCost(a, DEFAULT_REMIX_WEIGHTS, 4, 0, 1);
    expect(terms.struct).toBeCloseTo(0, 6);
  });

  it('absent but both clusters multi-member -> dStruct === 0.5', () => {
    // Cluster A = {0,1}, cluster B = {2,3}; the A->B transition is never
    // recorded. Both A and B have >= 2 members.
    const a = makeAnalysis({
      numBoundaries: 4,
      cluster: Int32Array.from([0, 0, 1, 1]),
      transitionSeen: new Set<string>(),
    });
    const terms = joinCost(a, DEFAULT_REMIX_WEIGHTS, 4, 0, 2);
    expect(terms.struct).toBeCloseTo(0.5, 6);
  });

  it('destination a singleton that never followed -> dStruct === 1.0', () => {
    // Cluster A = {0,1} (multi-member), cluster C = {2} (singleton
    // destination). No recorded transition.
    const a = makeAnalysis({
      numBoundaries: 3,
      cluster: Int32Array.from([0, 0, 2]),
      transitionSeen: new Set<string>(),
    });
    const terms = joinCost(a, DEFAULT_REMIX_WEIGHTS, 4, 0, 2);
    expect(terms.struct).toBeCloseTo(1.0, 6);
  });
});

// ---------------------------------------------------------------------------
// 4. ORDERING -- real analysis (abab fixture, T9-style)
// ---------------------------------------------------------------------------

// Local generator, matching remixFeatures.test.ts's `abab` recipe -- this
// repo re-declares such helpers per test file rather than sharing one.
const SR = 44100;
const BPM = 120;
const BEAT = Math.round((60 / BPM) * SR);
const BAR = BEAT * 4;
const BARS_PER_SECTION = 8;
const SECTION_LEN = BAR * BARS_PER_SECTION;
const PRE_ROLL_BARS = 1;

function makeLcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
}

function abab(structure: ('A' | 'B')[] = ['A', 'B', 'A', 'B']): Float32Array {
  const preRollLen = PRE_ROLL_BARS * BAR;
  const structLen = structure.length * SECTION_LEN;
  const totalLen = preRollLen + structLen;
  const out = new Float32Array(totalLen);
  const freqA = [220, 330];
  const freqB = [440, 554.365];
  const toneAmp = 0.25;
  const clickAmp = 1.0;

  const firstFreqs = structure[0] === 'A' ? freqA : freqB;
  for (let i = 0; i < preRollLen; i++) {
    const t = i / SR;
    let v = 0;
    for (const f of firstFreqs) v += Math.sin(2 * Math.PI * f * t);
    out[i] += toneAmp * v;
  }

  structure.forEach((label, si) => {
    const start = preRollLen + si * SECTION_LEN;
    const freqs = label === 'A' ? freqA : freqB;
    for (let i = 0; i < SECTION_LEN; i++) {
      const t = i / SR;
      let v = 0;
      for (const f of freqs) v += Math.sin(2 * Math.PI * f * t);
      out[start + i] += toneAmp * v;
    }
  });

  const rand = makeLcg(12345);
  const clickLen = Math.round(0.005 * SR);
  const clickWin = new Float32Array(clickLen);
  for (let i = 0; i < clickLen; i++) {
    clickWin[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, clickLen - 1)));
  }

  let beatIdx = -PRE_ROLL_BARS * 4;
  for (let s = 0; s < totalLen; s += BEAT, beatIdx++) {
    const phase = ((beatIdx % 4) + 4) % 4;
    const accented = phase === 0;
    const gain = (accented ? 2 : 1) * clickAmp;
    for (let i = 0; i < clickLen && s + i < totalLen; i++) {
      out[s + i] += gain * clickWin[i] * rand();
    }
  }

  return out;
}

function boundaryAt(sec: number): number {
  return Math.round((sec * SR) / BAR) + PRE_ROLL_BARS;
}

// See remixFeatures.test.ts's `interiorBoundary` doc comment: `SMOOTH_BARS =
// 4` over an 8-bar section makes the literal transition boundary a ~50/50
// blend, not a clean "just started section X" vector, so this test (like
// T9's own) compares points OFFSET_BARS = 4 into each section instead of the
// literal section-start boundary.
const OFFSET_BARS = 4;
function interiorBoundary(sectionStartIdx: number): number {
  return sectionStartIdx + OFFSET_BARS;
}

describe('joinCost -- ORDERING on the abab fixture real analysis (acceptance 4)', () => {
  it('a like-to-like join (A1->A2) is measurably cheaper than a cross-section join (A1->B1), ratio < 0.5', () => {
    const sig = abab();
    const analysis = analyzeRemix(sig, SR);
    expect(analysis.bpm).not.toBeNull();

    const a1 = interiorBoundary(boundaryAt(0));
    const b1 = interiorBoundary(boundaryAt(16));
    const a2 = interiorBoundary(boundaryAt(32));

    // phraseBars = 8 matches this fixture's own section length exactly, so
    // both pairs tested (A1->A2 delta=16, A1->B1 delta=8) are equally
    // phrase-aligned (phrasePen === 0 for both) -- isolating the comparison
    // to the SIGNAL terms (timbre/chroma/rhythm/struct), which is the
    // property under test, rather than letting phrase alignment itself
    // manufacture the gap.
    const phraseBars = BARS_PER_SECTION;
    const sameSection = joinCost(analysis, DEFAULT_REMIX_WEIGHTS, phraseBars, a1, a2);
    const crossSection = joinCost(analysis, DEFAULT_REMIX_WEIGHTS, phraseBars, a1, b1);

    expect(sameSection.phrase).toBeCloseTo(0, 6);
    expect(crossSection.phrase).toBeCloseTo(0, 6);

    const ratio = sameSection.total / crossSection.total;
    expect(sameSection.total).toBeLessThan(crossSection.total);
    expect(ratio).toBeLessThan(0.5);
  }, 20000);
});

// ---------------------------------------------------------------------------
// 5. TOTAL is exactly the weighted sum of the returned terms
// ---------------------------------------------------------------------------

describe('joinCost -- total pinning (acceptance 5)', () => {
  it('total === hand-recomputed weighted sum of the returned terms', () => {
    const a = makeAnalysis({
      numBoundaries: 4,
      cluster: Int32Array.from([0, 0, 1, 1]),
      transitionSeen: new Set<string>(), // forces dStruct === 0.5 for the pair tested below
    });
    setRow(a.T, 0, NUM_BANDS, arbitraryVec(NUM_BANDS, 5));
    setRow(a.T, 2, NUM_BANDS, arbitraryVec(NUM_BANDS, 11));
    setRow(a.C, 0, 12, arbitraryVec(12, 6));
    setRow(a.C, 2, 12, arbitraryVec(12, 13));
    setRow(a.R, 0, R_DIMS, arbitraryVec(R_DIMS, 7));
    setRow(a.R, 2, R_DIMS, arbitraryVec(R_DIMS, 17));
    a.L[0] = -18;
    a.L[2] = -9;

    const weights: RemixWeights = DEFAULT_REMIX_WEIGHTS;
    const phraseBars = 3;
    const terms = joinCost(a, weights, phraseBars, 0, 2);

    const handSum =
      weights.timbre * terms.timbre +
      weights.chroma * terms.chroma +
      weights.loudness * terms.loudness +
      weights.rhythm * terms.rhythm +
      weights.struct * terms.struct +
      weights.phrase * terms.phrase;

    expect(terms.total).toBeCloseTo(handSum, 6);
    // Sanity: every term is genuinely non-trivial in this fixture, so this
    // pin cannot pass via every term happening to be zero.
    expect(terms.timbre).toBeGreaterThan(0);
    expect(terms.chroma).toBeGreaterThan(0);
    expect(terms.loudness).toBeGreaterThan(0);
    expect(terms.rhythm).toBeGreaterThan(0);
    expect(terms.struct).toBeCloseTo(0.5, 6);
  });
});

// ---------------------------------------------------------------------------
// 6/7/8. buildCandidateLists -- hard constraints, K/sort, determinism
// ---------------------------------------------------------------------------

const NUM_BARS = 20; // M = 20, matching the scale T11's own brief example uses

function makeConstraintAnalysis(): RemixAnalysis {
  const numBoundaries = NUM_BARS + 1;
  const a = makeAnalysis({
    numBoundaries,
    cluster: Int32Array.from({ length: numBoundaries }, (_, i) => i % 3),
    transitionSeen: new Set<string>(),
  });
  // Deterministic, non-degenerate per-boundary vectors so costs differ
  // enough to exercise sorting/K-truncation meaningfully (not all tied).
  for (let m = 0; m < numBoundaries; m++) {
    setRow(a.T, m, NUM_BANDS, arbitraryVec(NUM_BANDS, m));
    setRow(a.C, m, 12, arbitraryVec(12, m * 3 + 1));
    setRow(a.R, m, R_DIMS, arbitraryVec(R_DIMS, m * 5 + 2));
    a.L[m] = ((m % 7) - 3) * 2;
  }
  return a;
}

describe('buildCandidateLists -- hard constraints (acceptance 6)', () => {
  const PHI = 8;

  it('never emits a pair with abs(to-from) < Phi', () => {
    const a = makeConstraintAnalysis();
    const lists = buildCandidateLists(a, {
      weights: DEFAULT_REMIX_WEIGHTS,
      phraseBars: PHI,
      minRunBars: 4,
      strict: false,
      allowRepeats: true,
    });
    lists.forEach((list, from) => {
      list.forEach((to) => {
        expect(Math.abs(to - from)).toBeGreaterThanOrEqual(PHI);
      });
    });
  });

  it('never emits a to outside [edgeGuardBars, numBars - edgeGuardBars]', () => {
    const a = makeConstraintAnalysis();
    const edgeGuardBars = 1;
    const lists = buildCandidateLists(a, {
      weights: DEFAULT_REMIX_WEIGHTS,
      phraseBars: PHI,
      minRunBars: 4,
      strict: false,
      allowRepeats: true,
      edgeGuardBars,
    });
    lists.forEach((list) => {
      list.forEach((to) => {
        expect(to).toBeGreaterThanOrEqual(edgeGuardBars);
        expect(to).toBeLessThanOrEqual(NUM_BARS - edgeGuardBars);
      });
    });
  });

  it('never emits a to with to + minRunBars > numBars -- asserted explicitly for from = numBars-1', () => {
    const a = makeConstraintAnalysis();
    const minRunBars = 8;
    const lists = buildCandidateLists(a, {
      weights: DEFAULT_REMIX_WEIGHTS,
      phraseBars: PHI,
      minRunBars,
      strict: false,
      allowRepeats: true,
    });
    // General property, over every `from`.
    lists.forEach((list) => {
      list.forEach((to) => {
        expect(to + minRunBars).toBeLessThanOrEqual(NUM_BARS);
      });
    });
    // The specific case the brief calls out: `from = numBars - 1` is the
    // case that would index past the lattice if this constraint were a
    // clamp instead of a candidate-list prune.
    const from = NUM_BARS - 1;
    expect(lists[from].length).toBeGreaterThan(0); // repeats (allowRepeats:true) still reach small `to`
    lists[from].forEach((to) => {
      expect(to + minRunBars).toBeLessThanOrEqual(NUM_BARS);
    });
  });

  it('minRunBars is the BINDING constraint (tighter than the phrase-delta bound), not merely a redundant check', () => {
    // With from = numBars-1 = 19, phraseBars = 8: the phrase-delta bound
    // alone (abs(to-from) >= 8) would permit to <= 11. A large minRunBars =
    // 15 is the STRICTER bound (to + 15 <= 20 -> to <= 5), so this proves
    // the constraint actually prunes candidates the delta bound alone would
    // have let through (to in [6..11]) -- not just cases the delta bound
    // already excluded.
    const a = makeConstraintAnalysis();
    const minRunBars = 15;
    const from = NUM_BARS - 1;
    const lists = buildCandidateLists(a, {
      weights: DEFAULT_REMIX_WEIGHTS,
      phraseBars: PHI,
      minRunBars,
      strict: false,
      allowRepeats: true,
    });
    const emitted = Array.from(lists[from]);
    expect(emitted.length).toBeGreaterThan(0);
    // Every emitted `to` respects the tighter minRunBars bound...
    emitted.forEach((to) => expect(to).toBeLessThanOrEqual(NUM_BARS - minRunBars));
    // ...and specifically excludes to in [6..11], which satisfy the phrase
    // delta bound (19-6=13>=8, 19-11=8>=8) but violate minRunBars (to+15>20).
    for (let to = 6; to <= 11; to++) expect(emitted).not.toContain(to);
  });

  it('never emits a forbidden key — the key is one the unforbidden call provably DOES emit, and only that one direction is removed', () => {
    const a = makeConstraintAnalysis();
    // `minKeepBars: 4` is what makes this test mean anything (fix, L3-6). On
    // the DEFAULT `minKeepBars = 2*PHI = 16` at `numBars = 20`, a deletion
    // needs `to - from <= 20 - 16 = 4` while the phrase bound needs
    // `abs(to-from) >= 8` — no deletion is legal at all, so `5>13` could never
    // have been emitted and this test passed with the `forbidden.has` guard
    // DELETED. At `minKeepBars: 4` the deletion bound becomes `to - from <=
    // 16`, so `5>13` is legal on every other clause; and `13>5` is legal as a
    // repeat, which is what lets the reverse direction be asserted too.
    const opts = {
      weights: DEFAULT_REMIX_WEIGHTS,
      phraseBars: PHI,
      minRunBars: 4,
      strict: false,
      allowRepeats: true,
      minKeepBars: 4,
    };

    // CONTROL: both directions really are in the unforbidden lists. `from = 5`
    // has only `to in {13..16}` legal and `from = 13` only `to in {1..5}`,
    // both far under `CANDIDATE_LIST_K = 24`, so legal here means emitted —
    // the control cannot be passing for the trivial reason that the list was
    // truncated.
    const control = buildCandidateLists(a, opts);
    expect(Array.from(control[5])).toContain(13);
    expect(Array.from(control[13])).toContain(5);

    const lists = buildCandidateLists(a, { ...opts, forbiddenJoins: ['5>13'] });
    expect(Array.from(lists[5])).not.toContain(13);
    // Exactly one key removed, not a wholesale prune of `from = 5`...
    expect(Array.from(lists[5])).toEqual(Array.from(control[5]).filter((to) => to !== 13));
    // ...and the key is DIRECTIONAL: forbidding '5>13' leaves '13>5' alone.
    expect(Array.from(lists[13])).toContain(5);
    // Every other `from` is untouched.
    for (let from = 0; from <= NUM_BARS; from++) {
      if (from === 5) continue;
      expect(Array.from(lists[from])).toEqual(Array.from(control[from]));
    }
  });

  it('strict mode: every emitted pair satisfies from === to (mod Phi)', () => {
    const a = makeConstraintAnalysis();
    const lists = buildCandidateLists(a, {
      weights: DEFAULT_REMIX_WEIGHTS,
      phraseBars: PHI,
      minRunBars: PHI,
      strict: true,
      allowRepeats: true,
    });
    lists.forEach((list, from) => {
      list.forEach((to) => {
        expect(Math.abs(to - from) % PHI).toBe(0);
      });
    });
    // Sanity: strict mode is not vacuously satisfied by an all-empty result.
    const totalCandidates = lists.reduce((sum, l) => sum + l.length, 0);
    expect(totalCandidates).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// DELETION coverage (fix round 1, Important 2). The original acceptance-6
// tests all used allowRepeats:true with the default maxRepeatBars (32) and
// minKeepBars (2*phraseBars = 16 at phraseBars=8) against numBars=20 -- under
// those exact parameters `to - from <= numBars - minKeepBars = 4` while
// `abs(to-from) >= phraseBars = 8` is ALSO required, so no deletion (to >
// from) was ever legal and every previously-asserted candidate was a
// repeat. These tests use parameters that make deletion legal, so
// minKeepBars, allowRepeats:false, and maxRepeatBars each get positive
// coverage, not just "the reviewer trusts it".
// ---------------------------------------------------------------------------

describe('buildCandidateLists -- DELETION coverage (fix round 1, Important 2)', () => {
  it('allowRepeats:false -- never emits a backward edge, and deletions are actually present (non-vacuous)', () => {
    const a = makeConstraintAnalysis();
    const lists = buildCandidateLists(a, {
      weights: DEFAULT_REMIX_WEIGHTS,
      phraseBars: 4,
      minRunBars: 4,
      minKeepBars: 4, // small enough that deletions of up to 16 bars are legal
      strict: false,
      allowRepeats: false,
    });
    let deletionCount = 0;
    lists.forEach((list, from) => {
      list.forEach((to) => {
        expect(to).toBeGreaterThan(from); // no backward edge anywhere
        deletionCount++;
      });
    });
    expect(deletionCount).toBeGreaterThan(0); // not vacuously true on an all-empty result
  });

  it('maxRepeatBars caps how far back a repeat may reach, and is the BINDING constraint (not redundant with the delta bound)', () => {
    const a = makeConstraintAnalysis();
    const maxRepeatBars = 5;
    const from = 15;
    const lists = buildCandidateLists(a, {
      weights: DEFAULT_REMIX_WEIGHTS,
      phraseBars: 4,
      minRunBars: 4,
      maxRepeatBars,
      strict: false,
      allowRepeats: true,
    });
    // General property: no repeat anywhere exceeds the cap.
    lists.forEach((list, f) => {
      list.forEach((to) => {
        if (to < f) expect(f - to).toBeLessThanOrEqual(maxRepeatBars);
      });
    });
    // Specific, fully-worked case: for from=15, phraseBars=4 alone would
    // permit repeats back to to=1 (delta=14>=4); maxRepeatBars=5 is the
    // TIGHTER bound (from-to<=5 -> to>=10), leaving repeats {10, 11}. The
    // only deletion the delta bound alone would admit (to=19, delta=4) is
    // separately excluded by the `to + minRunBars <= numBars` lattice bound
    // (19+4=23>20) -- confirming that bound is independently enforced here
    // too, not just in the dedicated minRunBars tests above. Net legal set:
    // exactly {10, 11}.
    const emitted = Array.from(lists[from]).sort((x, y) => x - y);
    expect(emitted).toEqual([10, 11]);
  });

  it('minKeepBars caps how much may be deleted in one join, and is the BINDING constraint (not redundant with the delta bound)', () => {
    const a = makeConstraintAnalysis();
    const minKeepBars = 16; // numBars(20) - minKeepBars(16) = 4: deletion span capped at 4
    const from = 2;
    const lists = buildCandidateLists(a, {
      weights: DEFAULT_REMIX_WEIGHTS,
      phraseBars: 4,
      minRunBars: 4,
      minKeepBars,
      strict: false,
      allowRepeats: true,
    });
    // General property: no deletion anywhere exceeds the cap.
    lists.forEach((list, f) => {
      list.forEach((to) => {
        if (to > f) expect(to - f).toBeLessThanOrEqual(NUM_BARS - minKeepBars);
      });
    });
    // Specific case: for from=2, phraseBars=4 alone would permit deletions
    // up to to=19 (or any to-from>=4); minKeepBars forces to-from<=4, so
    // the ONLY legal deletion is to=6 (delta exactly 4). to=10 (delta=8)
    // satisfies the phrase-delta bound but must be absent.
    const emitted = Array.from(lists[from]);
    expect(emitted).toContain(6);
    expect(emitted).not.toContain(10);
  });
});

// ---------------------------------------------------------------------------
// joinCost -- optional precomputed cluster member counts (fix round 1, Minor 5)
// ---------------------------------------------------------------------------

describe('joinCost -- optional precomputed cluster member counts (fix round 1, Minor 5)', () => {
  it('passing a precomputed clusterMemberCounts gives the identical result to computing it fresh', () => {
    const a = makeConstraintAnalysis();
    const fresh = joinCost(a, DEFAULT_REMIX_WEIGHTS, 4, 2, 10);
    const precomputed = clusterMemberCounts(a.cluster);
    const withPrecomputed = joinCost(a, DEFAULT_REMIX_WEIGHTS, 4, 2, 10, precomputed);
    expect(withPrecomputed).toEqual(fresh);
  });
});

describe('buildCandidateLists -- K cap and sort order (acceptance 7)', () => {
  it('every list has length <= K = 24 and is sorted ascending by total cost', () => {
    const a = makeConstraintAnalysis();
    const options = {
      weights: DEFAULT_REMIX_WEIGHTS,
      phraseBars: 2, // small Phi -> many legal candidates, exercising the K cap
      minRunBars: 2,
      strict: false,
      allowRepeats: true,
    };
    const lists = buildCandidateLists(a, options);
    expect(CANDIDATE_LIST_K).toBe(24);
    lists.forEach((list, from) => {
      expect(list.length).toBeLessThanOrEqual(CANDIDATE_LIST_K);
      let prevCost = -Infinity;
      list.forEach((to) => {
        const cost = joinCost(a, options.weights, options.phraseBars, from, to).total;
        expect(cost).toBeGreaterThanOrEqual(prevCost);
        prevCost = cost;
      });
    });
  });
});

describe('buildCandidateLists -- determinism (acceptance 8)', () => {
  it('two calls on identical input produce deep-equal lists', () => {
    const a = makeConstraintAnalysis();
    const options = {
      weights: DEFAULT_REMIX_WEIGHTS,
      phraseBars: 4,
      minRunBars: 4,
      strict: false,
      allowRepeats: true,
    };
    const lists1 = buildCandidateLists(a, options);
    const lists2 = buildCandidateLists(a, options);
    expect(lists1.map((l) => Array.from(l))).toEqual(lists2.map((l) => Array.from(l)));
  });
});

// ---------------------------------------------------------------------------
// Purity (defensive, matching this codebase's convention elsewhere in the
// DSP layer even though it is not its own numbered acceptance item here).
// ---------------------------------------------------------------------------

describe('purity', () => {
  it('joinCost and buildCandidateLists never mutate the RemixAnalysis they read', () => {
    const a = makeConstraintAnalysis();
    const snapshotT = Array.from(a.T);
    const snapshotC = Array.from(a.C);
    const snapshotL = Array.from(a.L);
    const snapshotR = Array.from(a.R);
    const snapshotCluster = Array.from(a.cluster);

    joinCost(a, DEFAULT_REMIX_WEIGHTS, 8, 0, 8);
    buildCandidateLists(a, {
      weights: DEFAULT_REMIX_WEIGHTS,
      phraseBars: 8,
      minRunBars: 8,
      strict: true,
      allowRepeats: true,
    });

    expect(Array.from(a.T)).toEqual(snapshotT);
    expect(Array.from(a.C)).toEqual(snapshotC);
    expect(Array.from(a.L)).toEqual(snapshotL);
    expect(Array.from(a.R)).toEqual(snapshotR);
    expect(Array.from(a.cluster)).toEqual(snapshotCluster);
  });
});
