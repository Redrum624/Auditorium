import { planRemix, MAX_USE_COUNT, MAX_REQUIRED_JOINS, DEFAULT_MAX_REPEAT_FACTOR, _runRemixDPForTest } from './remixPlan';
import type { PlanRemixOptions, PlanRemixResult, RemixSegment } from './remixPlan';
import { REMIX_PLAN_GOLDEN } from './__fixtures__/remixPlanGolden';
// The fixture builders and the golden case matrix are COMMITTED and SHARED
// with `scripts/gen-remix-plan-golden.cjs` (R4b fix round 1, I7) — a golden
// whose generator only exists in someone's scratch directory is a number
// nobody can re-derive, which is the exact weakness this task diagnosed in the
// old 156-case pin rig.
import {
  REMIX_FIXTURE_NUM_BANDS as NUM_BANDS,
  REMIX_FIXTURE_BEATS_PER_BAR as BEATS_PER_BAR,
  REMIX_FIXTURE_R_DIMS as R_DIMS,
  makeUniformAnalysis,
  makeVaryingAnalysis,
  makeRichAnalysis,
  baseOptions,
  REMIX_PLAN_GOLDEN_SPECS,
} from './__fixtures__/remixPlanGoldenSpecs';
import { buildCandidateLists, joinCost, DEFAULT_REMIX_WEIGHTS } from './remixCost';
import * as remixCostModule from './remixCost';
import type { RemixAnalysis } from './remixFeatures';
import { CONFIDENCE_LOW } from './tempoCore';

function expectOk(r: PlanRemixResult): asserts r is PlanRemixResult & { ok: true } {
  if (!r.ok) throw new Error(`expected ok:true, got ok:false reason=${r.reason} message=${r.message}`);
}
function expectFail(r: PlanRemixResult): asserts r is PlanRemixResult & { ok: false } {
  if (r.ok) throw new Error('expected ok:false, got ok:true');
}

function sumSegments(segs: RemixSegment[]): number {
  let total = 0;
  for (const s of segs) total += s.end - s.start;
  return total;
}

// ---------------------------------------------------------------------------
// 1. OUT-OF-BOUNDS
// ---------------------------------------------------------------------------

describe('planRemix -- OUT-OF-BOUNDS (acceptance 1)', () => {
  it('no relaxation ever indexes f(p,n) with p>M; parent array never decodes to a state >= (M+1)*(Nmax+1)', () => {
    const M = 20;
    const phraseBars = 8;
    const a = makeUniformAnalysis({ numBars: M });
    const candOptions = {
      weights: DEFAULT_REMIX_WEIGHTS,
      phraseBars,
      minRunBars: phraseBars,
      strict: true,
      allowRepeats: true,
      edgeGuardBars: 1,
      maxRepeatBars: 32,
    };
    const candidates = buildCandidateLists(a, candOptions);
    const Nmax = 40;
    const baseCosts = candidates.map((cand, from) => Float64Array.from(cand, (b) => joinCost(a, DEFAULT_REMIX_WEIGHTS, phraseBars, from, b).total));
    const table = _runRemixDPForTest(candidates, baseCosts, DEFAULT_REMIX_WEIGHTS.jump, new Map(), M, Nmax, phraseBars);

    const width = Nmax + 1;
    const size = (M + 1) * width;
    expect(table.parent.length).toBe(size);
    expect(table.cost.length).toBe(size);
    // No parent entry anywhere in the table decodes to a predecessor state
    // >= (M+1)*(Nmax+1), and every decoded predecessor's own `p` stays <= M.
    for (let i = 0; i < size; i++) {
      const enc = table.parent[i];
      if (enc < 0) continue;
      const predState = Math.floor(enc / 2);
      expect(predState).toBeGreaterThanOrEqual(0);
      expect(predState).toBeLessThan(size);
      const predP = Math.floor(predState / width);
      expect(predP).toBeLessThanOrEqual(M);
    }

    // Reconstruct every reachable terminal state at p=M back to (0,0) and
    // confirm every `p` visited along the walk (i.e. every reconstructed
    // segment's end bar, since a segment boundary is exactly a visited `p`)
    // stays within [0, M] -- the direct acceptance-1 instrumentation.
    let anyReachable = false;
    for (let n = 0; n <= Nmax; n++) {
      const idx = M * width + n;
      if (!Number.isFinite(table.cost[idx])) continue;
      anyReachable = true;
      let cur = idx;
      let steps = 0;
      for (;;) {
        const p = Math.floor(cur / width);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(M);
        const enc = table.parent[cur];
        if (enc < 0) break;
        cur = Math.floor(enc / 2);
        steps++;
        expect(steps).toBeLessThanOrEqual(size); // guards against an accidental cycle
      }
    }
    expect(anyReachable).toBe(true);
  });

  it('a candidate list deliberately containing b=M-1 with R=8 is pruned by buildCandidateLists, and planRemix still returns ok with a finite, non-NaN cost', () => {
    const M = 20;
    const phraseBars = 8;
    const a = makeUniformAnalysis({ numBars: M });
    const candidates = buildCandidateLists(a, {
      weights: DEFAULT_REMIX_WEIGHTS,
      phraseBars,
      minRunBars: 8,
      strict: false,
      allowRepeats: true,
      edgeGuardBars: 1,
      maxRepeatBars: 32,
    });
    // b = M-1 = 19 with R=8 would need to+R=27 <= numBars=20 -- impossible,
    // so it must never appear as a candidate `to` anywhere.
    for (const list of candidates) {
      expect(Array.from(list)).not.toContain(M - 1);
    }

    // The trivial straight-through length -- always reachable regardless of
    // deletion/repeat constraints -- is enough to prove planRemix returns a
    // finite, well-formed plan once buildCandidateLists has correctly pruned
    // the invalid candidate.
    const result = planRemix(
      a,
      baseOptions({
        targetSample: a.analyzedEndSample,
        strict: false,
        allowRepeats: true,
      })
    );
    expectOk(result);
    expect(Number.isFinite(result.totalCost)).toBe(true);
    expect(Number.isNaN(result.totalCost)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. FEASIBILITY WINDOW
// ---------------------------------------------------------------------------

describe('planRemix -- FEASIBILITY WINDOW (acceptance 2)', () => {
  // M=48, phraseBars=8 (Phi=8, tolBars=ceil(8/2)=4 strict). A single
  // departure point (bar 8) offers three mutually-exclusive one-join
  // deletions (to=16/24/32, each congruent mod 8) that reduce the natural
  // 48-bar straight-through length by 8/16/24 bars respectively -- giving a
  // reachable set of exactly {24, 32, 40, 48} at p=M, each via 0 or 1 join
  // (never both), so their costs can be tuned completely independently.
  const M = 48;
  const PHI = 8;
  const BAR_LEN = 10000;
  const HEAD = 500;
  const TAIL = 800;

  // `minKeepBars: 17` caps a single deletion at `numBars - minKeepBars = 31`
  // bars, which excludes the delta=32 deletion (8->40) while keeping
  // delta=8/16/24 (8->16/24/32) legal -- deliberately restricting
  // candidates[8] to exactly {16,24,32} (reductions 8/16/24 off the natural
  // 48-bar length), giving a reachable set of exactly {24,32,40,48}.
  function makeWindowAnalysis(cheapJoinTo: 24 | 32 | null): RemixAnalysis {
    const a = makeUniformAnalysis({ numBars: M, barLen: BAR_LEN, head: HEAD, tail: TAIL });
    const seen = new Set<string>();
    if (cheapJoinTo === 24) seen.add('8>24');
    if (cheapJoinTo === 32) seen.add('8>32');
    a.transitionSeen = seen;
    return a;
  }

  function targetSampleForBars(n: number): number {
    return HEAD + n * BAR_LEN + TAIL;
  }

  const opts = (targetSample: number): PlanRemixOptions =>
    baseOptions({ targetSample, phraseBars: PHI, strict: true, allowRepeats: false, minKeepBars: 17 });

  it('reachable set sanity: candidates[8] === {16,24,32} for this fixture', () => {
    const a = makeWindowAnalysis(null);
    const candidates = buildCandidateLists(a, {
      weights: DEFAULT_REMIX_WEIGHTS,
      phraseBars: PHI,
      minRunBars: PHI,
      strict: true,
      allowRepeats: false,
      minKeepBars: 17,
    });
    expect(Array.from(candidates[8]).sort((x, y) => x - y)).toEqual([16, 24, 32]);
  });

  it('target 38 bars -> only 40 is within the window [34,42] -> n* selects 40 bars exactly', () => {
    const a = makeWindowAnalysis(null);
    const result = planRemix(a, opts(targetSampleForBars(38)));
    expectOk(result);
    expect(result.outputSample).toBe(targetSampleForBars(40));
  });

  it('target 28 bars -> window [24,32] contains both; rig the join to 24 (reduction 16, -> output 32 bars) cheaper -> 32 wins', () => {
    const a = makeWindowAnalysis(24);
    const result = planRemix(a, opts(targetSampleForBars(28)));
    expectOk(result);
    expect(result.outputSample).toBe(targetSampleForBars(32));
  });

  it('target 28 bars -> window [24,32] contains both; flip so the join to 32 (reduction 24, -> output 24 bars) is cheaper -> 24 wins', () => {
    const a = makeWindowAnalysis(32);
    const result = planRemix(a, opts(targetSampleForBars(28)));
    expectOk(result);
    expect(result.outputSample).toBe(targetSampleForBars(24));
  });
});

// ---------------------------------------------------------------------------
// FIX ROUND 1, Important 2: sample-space duration re-check within the window
// ---------------------------------------------------------------------------

describe('planRemix -- duration-margin selection within the window (fix round 1, Important 2)', () => {
  // A pure "minimise bars-distance-to-target, tie-break lowest n" selection
  // (the pre-fix behaviour) can pick a candidate that is far from the
  // target in SAMPLES even when two candidates are EXACTLY tied in bars,
  // because bar count is a poor proxy for sample duration once bars vary in
  // length -- measured up to +7.2% duration error by the review. This
  // fixture makes that concrete: two one-join deletions from bar 1, BOTH
  // exactly 4 bars from a targetBars of 20 (a genuine bar-distance tie), and
  // BOTH equally cheap (tied cost) -- but bars 17-24 are anomalously LONG
  // (40000 samples vs 10000 elsewhere), so the two candidates' ACTUAL sample
  // sums are very different: deleting only bars 1-16 (n=24, keeps the long
  // bars) lands at 481,300 samples; deleting bars 1-24 (n=16, also removes
  // the long bars) lands at only 161,300. Requesting 329,000 samples
  // (rounds to targetBars=20, tying both in BARS) is measurably closer to
  // the n=24 candidate (distance 152,300) than the n=16 one (distance
  // 167,700) -- so the fix must pick n=24, where the OLD bars-only tie-break
  // (tied distance, then lowest n) would have picked n=16 instead.
  function makeInversionAnalysis(): RemixAnalysis {
    const M = 40;
    const head = 500;
    const tail = 800;
    const numBoundaries = M + 1;
    const barBoundary = new Int32Array(numBoundaries);
    barBoundary[0] = head;
    for (let i = 1; i <= M; i++) {
      const len = i >= 18 && i <= 25 ? 40000 : 10000; // bars 17..24 (0-indexed) are long
      barBoundary[i] = barBoundary[i - 1] + len;
    }
    const analyzedEndSample = barBoundary[M] + tail;
    return {
      bpm: 120,
      confidence: 1,
      beatSamples: Int32Array.from({ length: numBoundaries * BEATS_PER_BAR }, (_, i) => i * 2500),
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
      numBars: M,
      T: new Float32Array(numBoundaries * NUM_BANDS),
      C: new Float32Array(numBoundaries * 12),
      L: new Float32Array(numBoundaries),
      R: new Float32Array(numBoundaries * R_DIMS),
      S: new Float32Array(numBoundaries * (NUM_BANDS + 12)),
      cluster: Int32Array.from({ length: numBoundaries }, (_, i) => i),
      transitionSeen: new Set(['1>17', '1>25']), // both deletions equally cheap (dStruct=0)
    };
  }

  it('picks the sample-closer candidate (n=24) over the bar-tied, sample-farther one (n=16)', () => {
    const a = makeInversionAnalysis();
    const targetSample = 329000; // rounds to targetBars=20 -> window [16,24], both candidates tied at bar-distance 4
    const result = planRemix(
      a,
      baseOptions({ targetSample, phraseBars: 8, strict: true, allowRepeats: false, minKeepBars: 16 })
    );
    expectOk(result);
    expect(result.outputSample).toBe(481300); // n=24 (delete bars 1-16, KEEP the long bars)
    expect(result.joins).toEqual([{ fromBar: 1, toBar: 17, cost: result.joins[0].cost }]);
  });
});

// ---------------------------------------------------------------------------
// 3. EMPTY WINDOW -- too-long
// ---------------------------------------------------------------------------

describe('planRemix -- EMPTY WINDOW, too-long (acceptance 3)', () => {
  it('target 100 bars against a reachable max of 40 bars (no repeats allowed) -> too-long, maxOutputSample === the 40-bar sample sum', () => {
    const M = 40;
    const barLen = 10000;
    const head = 500;
    const tail = 800;
    const a = makeUniformAnalysis({ numBars: M, barLen, head, tail });
    const natural = head + M * barLen + tail;
    const target = head + 100 * barLen + tail;

    const result = planRemix(
      a,
      baseOptions({
        targetSample: target,
        phraseBars: 8,
        strict: true,
        allowRepeats: false, // no repeats -> max reachable is the natural straight-through length
      })
    );
    expectFail(result);
    expect(result.reason).toBe('too-long');
    expect(result.maxOutputSample).toBe(natural);
  });
});

// ---------------------------------------------------------------------------
// 4. Refusals: too-short (window), too-short (numBars), no-tempo, no-path
// ---------------------------------------------------------------------------

describe('planRemix -- refusals (acceptance 4)', () => {
  it('target below the reachable minimum -> too-short, minOutputSample populated from the real reachable minimum', () => {
    // Deletions allowed (strict, phraseBars=8) shrink the natural 40-bar
    // track down to a minimum of 40 - 3*8 = 16 bars (three max-size,
    // non-overlapping 8-bar deletions at 0->8, 16->24, 32->40 phrase slots);
    // asking for far less than that must refuse as too-short, not silently
    // clamp.
    const M = 40;
    const barLen = 10000;
    const head = 500;
    const tail = 800;
    const a = makeUniformAnalysis({ numBars: M, barLen, head, tail });
    a.cluster = Int32Array.from({ length: M + 1 }, () => 0);
    a.transitionSeen = new Set(['0>0']); // every legal deletion cheap/uniform

    // targetBars=8 -> the tolBars=4 window [4,12] sits entirely below the
    // true reachable minimum (16 bars) -- an empty window on the low side.
    // (Fix round 1: Nmax no longer depends on the target at all -- see the
    // dedicated far-too-short test below, which pins targetBars 2/4/6
    // specifically because those are OUTSIDE the narrow band the old,
    // target-dependent Nmax formula happened to still cover.)
    const target = head + 8 * barLen + tail;
    const result = planRemix(
      a,
      baseOptions({
        targetSample: target,
        phraseBars: 8,
        strict: true,
        allowRepeats: false,
        minKeepBars: 8,
      })
    );
    expectFail(result);
    expect(result.reason).toBe('too-short');
    expect(result.minOutputSample).toBeGreaterThan(target);
    expect(result.minOutputSample).toBeLessThan(head + M * barLen + tail);
  });

  it('numBars < 2*phraseBars+2 -> too-short, computed up front', () => {
    const phraseBars = 8;
    const M = 2 * phraseBars + 1; // one short of the minimum
    const a = makeUniformAnalysis({ numBars: M });
    const result = planRemix(a, baseOptions({ targetSample: 100000, phraseBars }));
    expectFail(result);
    expect(result.reason).toBe('too-short');
  });

  // Fix round 1, Minor 1 (T11 review): a non-finite or non-positive
  // `targetSample` must be refused explicitly, not silently produce a
  // zero-length `Float64Array` (a `NaN` size) whose every DP write is then a
  // no-op, degrading confusingly to `no-path`.
  describe('invalid targetSample (fix round 1, Minor 1)', () => {
    const a = makeUniformAnalysis({ numBars: 40 });

    it.each([NaN, Infinity, -Infinity, 0, -1000])('targetSample=%p -> too-short with an explanatory message, never no-path', (bad) => {
      const result = planRemix(a, baseOptions({ targetSample: bad }));
      expectFail(result);
      expect(result.reason).toBe('too-short');
      expect(result.message).toMatch(/targetSample/);
      expect(result.minOutputSample).toBe(a.analyzedEndSample);
      expect(result.maxOutputSample).toBe(a.analyzedEndSample);
    });

    it('never throws and never reaches the DP for an invalid targetSample', () => {
      const spy = jest.spyOn(remixCostModule, 'buildCandidateLists');
      try {
        expect(() => planRemix(a, baseOptions({ targetSample: NaN }))).not.toThrow();
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('tempoConfidence 0.2 -> no-tempo, WITHOUT running the DP (buildCandidateLists never queried)', () => {
    const spy = jest.spyOn(remixCostModule, 'buildCandidateLists');
    try {
      // Sanity first: confirm the spy actually observes a call that DOES
      // reach the DP, so a "never called" assertion below isn't vacuously
      // true because the spy is wired to the wrong module object.
      const sane = makeUniformAnalysis({ numBars: 40, confidence: 1 });
      sane.cluster = Int32Array.from({ length: 41 }, () => 0);
      sane.transitionSeen = new Set(['0>0']);
      planRemix(sane, baseOptions({ targetSample: sane.analyzedEndSample }));
      expect(spy).toHaveBeenCalled();
      spy.mockClear();

      const a = makeUniformAnalysis({ numBars: 40, confidence: 0.2 });
      expect(a.confidence).toBeLessThan(CONFIDENCE_LOW);
      const result = planRemix(a, baseOptions({ targetSample: 100000 }));
      expectFail(result);
      expect(result.reason).toBe('no-tempo');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('tempoConfirmed opens the gate a low confidence closed, WITHOUT altering the measurement', () => {
    const a = makeUniformAnalysis({ numBars: 40, confidence: 0.2 });
    a.cluster = Int32Array.from({ length: 41 }, () => 0);
    a.transitionSeen = new Set(['0>0']);

    const refused = planRemix(a, baseOptions({ targetSample: a.analyzedEndSample }));
    expectFail(refused);
    expect(refused.reason).toBe('no-tempo');

    // The user asserted the tempo. That is a DIFFERENT fact from "the detector
    // is confident", it is strictly stronger, and it rides its own flag --
    // `confidence` stays exactly as measured, so every other consumer (the
    // status bar's uncertainty marker, the Properties readout) keeps telling
    // the truth about the detection.
    const confirmed: RemixAnalysis = { ...a, tempoConfirmed: true };
    const result = planRemix(confirmed, baseOptions({ targetSample: confirmed.analyzedEndSample }));

    expect(result.ok).toBe(true);
    expect(confirmed.confidence).toBe(0.2);
    expect(confirmed.confidence).toBeLessThan(CONFIDENCE_LOW);
  });

  it('every candidate rejected AND Nmax < M (maxRepeatFactor < 1) -> no-path', () => {
    // Fix round 1 (Plan Ruling 6): Nmax is now sized from M and
    // maxRepeatFactor ALONE, independently of the target -- so, unlike
    // before, a small/short TARGET can no longer shrink Nmax below M. The
    // trivial straight-through state (M,M) is reachable via unconditional
    // continue edges whenever Nmax>=M, regardless of candidates -- so
    // 'no-path' can now only occur when the caller supplies a
    // maxRepeatFactor<1 (Nmax<M by construction), a genuine misconfiguration
    // rather than an ordinary short target. strict phraseBars=8 requires
    // delta>=8 for ANY legal pair; the default minKeepBars=2*phraseBars=16
    // caps a deletion at numBars-minKeepBars=4 -- mutually exclusive, so
    // buildCandidateLists ALSO genuinely returns every candidate list empty
    // (the literal "every candidate rejected" the brief names), though with
    // Nmax<M that alone would already be enough regardless of candidates.
    const phraseBars = 8;
    const M = 2 * phraseBars + 4; // comfortably above the too-short floor
    const a = makeUniformAnalysis({ numBars: M });

    const candidates = buildCandidateLists(a, {
      weights: DEFAULT_REMIX_WEIGHTS,
      phraseBars,
      minRunBars: phraseBars,
      strict: true,
      allowRepeats: false,
    });
    for (const list of candidates) expect(list.length).toBe(0);

    const result = planRemix(
      a,
      baseOptions({
        targetSample: a.analyzedEndSample,
        phraseBars,
        strict: true,
        allowRepeats: false,
        maxRepeatFactor: 0.5, // Nmax = round(M*0.5) < M -- (M,M) itself sits outside the table.
      })
    );
    expectFail(result);
    expect(result.reason).toBe('no-path');
    expect(result.minOutputSample).toBe(a.analyzedEndSample);
    expect(result.maxOutputSample).toBe(a.analyzedEndSample);
  });

  it('a target below the true reachable minimum is CORRECTLY too-short (not no-path) regardless of how far below it is -- the far-too-short case Plan Ruling 6 requires pinned outside the old narrow band', () => {
    // Same M/constraints as the "target below the reachable minimum" test
    // above, but the target is now WAY below the true minimum (2 bars, not
    // tuned to sit just inside the old, target-dependent Nmax). Before the
    // Nmax fix this fell into 'no-path' with min=max=analyzedEndSample (the
    // FULL source length reported as the only achievable one -- the worst
    // possible answer to a length slider dragged to its minimum). After the
    // fix, Nmax no longer depends on the target at all, so the true
    // reachable minimum is found regardless of how extreme the request is.
    const M = 40;
    const barLen = 10000;
    const head = 500;
    const tail = 800;
    const a = makeUniformAnalysis({ numBars: M, barLen, head, tail });
    a.cluster = Int32Array.from({ length: M + 1 }, () => 0);
    a.transitionSeen = new Set(['0>0']);
    const naturalLength = head + M * barLen + tail;

    for (const targetBars of [2, 4, 6]) {
      const target = head + targetBars * barLen + tail;
      const result = planRemix(
        a,
        baseOptions({ targetSample: target, phraseBars: 8, strict: true, allowRepeats: false, minKeepBars: 8 })
      );
      expectFail(result);
      expect(result.reason).toBe('too-short');
      // The true minimum (three max-size 8-bar deletions off 40 bars = 16
      // bars) must be reported EXACTLY, not the full source length.
      expect(result.minOutputSample).toBe(head + 16 * barLen + tail);
      expect(result.minOutputSample).toBeLessThan(naturalLength);
    }
  });

  it('minOutputSample and maxOutputSample are TARGET-INDEPENDENT -- planning the same analysis at two wildly different targets must agree exactly (fix round 2, Plan Ruling 6 testing requirement)', () => {
    // Ruling 6's own point was that reachability must not be a function of
    // the target. The far-too-short test above pins the MIN half of that
    // (a far-too-short request must report the true minimum, not the full
    // source length); this pins the MAX half, which nothing else in this
    // suite directly asserts -- under the pre-fix `Nmax = min(round(M*
    // maxRepeatFactor), targetBars+phraseBars)`, a SHORT target starves
    // `Nmax` and caps `maxOutputSample` at roughly `targetBars+phraseBars`
    // bars, silently advertising a much lower ceiling than a long target
    // would report for the exact same source.
    const M = 40;
    const barLen = 10000;
    const head = 500;
    const tail = 800;
    const a = makeUniformAnalysis({ numBars: M, barLen, head, tail });
    a.cluster = Int32Array.from({ length: M + 1 }, () => 0);
    a.transitionSeen = new Set(['0>0']);

    const commonOptions = {
      phraseBars: 8,
      strict: true,
      allowRepeats: true,
      minKeepBars: 8,
      maxRepeatBars: 40,
    } as const;
    const farTooShort = planRemix(a, baseOptions({ targetSample: head + 2 * barLen + tail, ...commonOptions }));
    const farTooLong = planRemix(a, baseOptions({ targetSample: head + 300 * barLen + tail, ...commonOptions }));

    expect(farTooShort.minOutputSample).toBe(farTooLong.minOutputSample);
    expect(farTooShort.maxOutputSample).toBe(farTooLong.maxOutputSample);
    // Sanity: both fixed points are real (min < max), not a degenerate
    // both-equal-to-the-trivial-fallback case that would pass vacuously.
    expect(farTooShort.minOutputSample).toBeLessThan(farTooShort.maxOutputSample);
  });
});

// ---------------------------------------------------------------------------
// 5. PHRASE CONGRUENCE (strict mode)
// ---------------------------------------------------------------------------

describe('planRemix -- PHRASE CONGRUENCE, strict mode (acceptance 5)', () => {
  it('every emitted join satisfies fromBar === toBar (mod phraseBars); every deltaBars is a multiple of phraseBars', () => {
    const phraseBars = 8;
    const M = 64;
    const a = makeUniformAnalysis({ numBars: M });
    a.cluster = Int32Array.from({ length: M + 1 }, () => 0);
    a.transitionSeen = new Set(['0>0']);
    const target = a.barBoundary[0] + 40 * 10000 + (a.analyzedEndSample - a.barBoundary[M]);
    const result = planRemix(
      a,
      baseOptions({ targetSample: target, phraseBars, strict: true, allowRepeats: true, maxRepeatBars: 40 })
    );
    expectOk(result);
    expect(result.joins.length).toBeGreaterThan(0);
    for (const j of result.joins) {
      expect(((j.fromBar - j.toBar) % phraseBars + phraseBars) % phraseBars).toBe(0);
      expect(Math.abs(j.fromBar - j.toBar) % phraseBars).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. MIN RUN
// ---------------------------------------------------------------------------

describe('planRemix -- MIN RUN (acceptance 6)', () => {
  it('no two joins in the output are closer than minRunBars', () => {
    const phraseBars = 4; // loose mode -> minRunBars = 4
    const M = 60;
    const a = makeUniformAnalysis({ numBars: M });
    a.cluster = Int32Array.from({ length: M + 1 }, () => 0);
    a.transitionSeen = new Set(['0>0']);
    // Cap a single deletion at `numBars - minKeepBars = 8` bars so reaching
    // the needed 16-bar reduction (60 -> 44) FORCES at least two joins --
    // with an uncapped deletion budget the optimiser would always prefer
    // one big (cheaper, single-toll) deletion over several small ones,
    // which would not exercise the min-run gap at all.
    const target = a.barBoundary[0] + 44 * 10000 + (a.analyzedEndSample - a.barBoundary[M]);
    const result = planRemix(
      a,
      baseOptions({ targetSample: target, phraseBars, strict: false, allowRepeats: true, maxRepeatBars: 40, minKeepBars: 52 })
    );
    expectOk(result);
    expect(result.joins.length).toBeGreaterThan(1);
    for (let i = 1; i < result.joins.length; i++) {
      const gap = result.joins[i].fromBar - result.joins[i - 1].toBar;
      expect(gap).toBeGreaterThanOrEqual(4);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. REPETITION GUARD
// ---------------------------------------------------------------------------

describe('planRemix -- OVER-REPETITION GUARD (acceptance 7)', () => {
  // STRICT mode + maxRepeatBars===phraseBars forces every legal repeat to be
  // an EXACT self-loop (distance === phraseBars === minRunBars); a single
  // large backward jump is illegal, so the cheapest way to lengthen is to
  // loop one phrase repeatedly. 16->12 (a true self-loop: 12+4=16) is
  // recorded as "seen" so dStruct=0 there; every other same-distance
  // self-loop is unseen (dStruct=1.0, strictly costlier), and a linear
  // loudness trend (L[i]=i) makes any WIDER repeat (once maxRepeatBars is
  // relaxed for the guarded re-run) cost more the further apart its
  // endpoints are -- these two properties together are what let the guard's
  // penalised re-run find a genuinely cheaper, non-repetitive alternative
  // once minRunBars-only self-loops are ruled out. Verified empirically
  // (scratch exploration) before being locked in here, per the standing
  // rule: the unconstrained optimum for THIS fixture measured usage=5 at
  // bars 12-15 (cost 1.4); relaxing maxRepeatBars for the guarded re-run and
  // asserting against the actual `planRemix` output (not a hand-derived
  // number) is what this test checks.
  const M = 28;
  const BAR_LEN = 10000;
  const HEAD = 500;
  const TAIL = 800;

  function makeGuardAnalysis(): RemixAnalysis {
    const a = makeUniformAnalysis({ numBars: M, barLen: BAR_LEN, head: HEAD, tail: TAIL });
    for (let i = 0; i < a.L.length; i++) a.L[i] = i;
    a.L[12] = 12;
    a.L[16] = 12;
    a.transitionSeen = new Set(['16>12']);
    return a;
  }

  function usageCounts(segments: RemixSegment[], barLen: number, head: number, numBars: number): number[] {
    const counts = new Array(numBars).fill(0);
    for (const s of segments) {
      const startBar = Math.round((s.start - head) / barLen);
      const endBar = Math.round((s.end - head) / barLen);
      for (let b = startBar; b < endBar; b++) counts[b]++;
    }
    return counts;
  }

  it('the UNCONSTRAINED optimum (maxRepeatBars restricted to exact self-loops only) uses bar 12 five times', () => {
    const a = makeGuardAnalysis();
    const targetBars = 44; // 28 natural + 4 self-loop iterations * 4 bars
    const target = HEAD + targetBars * BAR_LEN + TAIL;
    const result = planRemix(
      a,
      baseOptions({
        targetSample: target,
        phraseBars: 4,
        strict: true,
        allowRepeats: true,
        maxRepeatBars: 4, // forces every legal repeat to be an exact self-loop
      })
    );
    expectOk(result);
    const counts = usageCounts(result.segments, BAR_LEN, HEAD, M);
    expect(Math.max(...counts)).toBe(5);
    expect(counts[12]).toBe(5);
    // maxBarUse (fix round 1, Important 1) must match the independently
    // counted usage exactly, including in a fixture where the guard's
    // heuristic itself does not fully succeed (see the module doc comment --
    // "bounded, not guaranteed").
    expect(result.maxBarUse).toBe(5);
  });

  it('with a wider repeat budget available, the guard reduces every bar index to <= MAX_USE_COUNT uses, at a totalCost >= the unconstrained optimum', () => {
    const a = makeGuardAnalysis();
    const targetBars = 44;
    const target = HEAD + targetBars * BAR_LEN + TAIL;

    // The unconstrained optimum under THESE (wider) constraints, computed
    // directly off the raw DP table (bypassing the guard), for comparison --
    // per the standing rule, measured from the real function, not hand-derived.
    const phraseBars = 4;
    const minRunBars = 4;
    const candOptions = {
      weights: DEFAULT_REMIX_WEIGHTS,
      phraseBars,
      minRunBars,
      strict: true,
      allowRepeats: true,
      maxRepeatBars: 24,
    };
    const candidates = buildCandidateLists(a, candOptions);
    const baseCosts = candidates.map((cand, from) =>
      Float64Array.from(cand, (b) => joinCost(a, DEFAULT_REMIX_WEIGHTS, phraseBars, from, b).total)
    );
    // Fix round 1 (Plan Ruling 6): Nmax is sized from M and maxRepeatFactor
    // ALONE now, matching planRemix's own (fixed) formula exactly, so this
    // probe's table is directly comparable to planRemix's internal one.
    const Nmax = Math.round(M * DEFAULT_MAX_REPEAT_FACTOR);
    const table = _runRemixDPForTest(candidates, baseCosts, DEFAULT_REMIX_WEIGHTS.jump, new Map(), M, Nmax, minRunBars);
    const width = Nmax + 1;
    const unconstrainedOptimum = table.cost[M * width + targetBars];
    expect(Number.isFinite(unconstrainedOptimum)).toBe(true);

    const result = planRemix(
      a,
      baseOptions({
        targetSample: target,
        phraseBars,
        strict: true,
        allowRepeats: true,
        maxRepeatBars: 24,
      })
    );
    expectOk(result);
    const counts = usageCounts(result.segments, BAR_LEN, HEAD, M);
    expect(Math.max(...counts)).toBeLessThanOrEqual(MAX_USE_COUNT);
    expect(result.totalCost).toBeGreaterThanOrEqual(unconstrainedOptimum);
    // maxBarUse (fix round 1, Important 1) surfaces the same count directly.
    expect(result.maxBarUse).toBe(Math.max(...counts));
    expect(result.maxBarUse).toBeLessThanOrEqual(MAX_USE_COUNT);
  });
});

// ---------------------------------------------------------------------------
// 8. DETERMINISM + RE-ROLL
// ---------------------------------------------------------------------------

describe('planRemix -- DETERMINISM and RE-ROLL (acceptance 8)', () => {
  const M = 48;
  const PHI = 8;
  const BAR_LEN = 10000;
  const HEAD = 500;
  const TAIL = 800;

  function makeRerollAnalysis(): RemixAnalysis {
    const a = makeUniformAnalysis({ numBars: M, barLen: BAR_LEN, head: HEAD, tail: TAIL });
    // Two independent, equally cheap one-join deletions from bar 8 (to=24
    // and to=32, both phrase-congruent) -- reroll's penalty should make the
    // planner prefer the OTHER one the second time around.
    a.transitionSeen = new Set(['8>24', '8>32']);
    return a;
  }

  it('two identical calls (rollIndex 0) produce deep-equal plans with byte-identical segments', () => {
    const a = makeRerollAnalysis();
    const target = HEAD + 32 * BAR_LEN + TAIL;
    const options = baseOptions({ targetSample: target, phraseBars: PHI, strict: true, allowRepeats: false, minKeepBars: 8 });
    const r1 = planRemix(a, options);
    const r2 = planRemix(a, { ...options });
    expect(r1).toEqual(r2);
  });

  it('re-roll (rollIndex 1) produces a DIFFERENT joins array, with outputSample still inside the tolerance window', () => {
    const a = makeRerollAnalysis();
    const target = HEAD + 32 * BAR_LEN + TAIL; // window [28,36] strict tolBars=4
    const options = baseOptions({ targetSample: target, phraseBars: PHI, strict: true, allowRepeats: false, minKeepBars: 8 });

    const r0 = planRemix(a, options);
    const r1 = planRemix(a, { ...options, rollIndex: 1 });
    expectOk(r0);
    expectOk(r1);
    expect(r1.joins).not.toEqual(r0.joins);

    const tolBars = Math.ceil(PHI / 2);
    const targetBars = 32;
    const outputBars0 = (r0.outputSample - HEAD - TAIL) / BAR_LEN;
    const outputBars1 = (r1.outputSample - HEAD - TAIL) / BAR_LEN;
    expect(Math.abs(outputBars0 - targetBars)).toBeLessThanOrEqual(tolBars);
    expect(Math.abs(outputBars1 - targetBars)).toBeLessThanOrEqual(tolBars);
  });

  it('re-roll itself is deterministic: two calls with the same rollIndex 1 deep-equal', () => {
    const a = makeRerollAnalysis();
    const target = HEAD + 32 * BAR_LEN + TAIL;
    const options = baseOptions({
      targetSample: target,
      phraseBars: PHI,
      strict: true,
      allowRepeats: false,
      minKeepBars: 8,
      rollIndex: 1,
    });
    const r1 = planRemix(a, options);
    const r2 = planRemix(a, { ...options });
    expect(r1).toEqual(r2);
  });

  it('canReroll (fix round 1, Minor 4) is true whenever the plan has at least one join, false for a plan with none', () => {
    const a = makeRerollAnalysis();

    const withJoin = planRemix(
      a,
      baseOptions({ targetSample: HEAD + 32 * BAR_LEN + TAIL, phraseBars: PHI, strict: true, allowRepeats: false, minKeepBars: 8 })
    );
    expectOk(withJoin);
    expect(withJoin.joins.length).toBeGreaterThan(0);
    expect(withJoin.canReroll).toBe(true);

    // The natural straight-through length needs zero joins -- re-roll would
    // have nothing to penalise, so canReroll must say so.
    const natural = planRemix(
      a,
      baseOptions({ targetSample: a.analyzedEndSample, phraseBars: PHI, strict: true, allowRepeats: false })
    );
    expectOk(natural);
    expect(natural.joins.length).toBe(0);
    expect(natural.canReroll).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. EXACT MODE
// ---------------------------------------------------------------------------

describe('planRemix -- EXACT MODE (acceptance 9)', () => {
  it('outputSample >= targetSample and outputSample - targetSample < one bar', () => {
    const phraseBars = 4;
    const M = 40;
    const barLen = 10000;
    const head = 500;
    const tail = 800;
    const a = makeUniformAnalysis({ numBars: M, barLen, head, tail });
    a.cluster = Int32Array.from({ length: M + 1 }, () => 0);
    a.transitionSeen = new Set(['0>0']);
    // A target that does NOT land on an exact multiple of barLen relative to
    // head/tail, forcing genuine overshoot.
    const target = head + 30 * barLen + Math.floor(barLen / 2) + tail;

    const result = planRemix(
      a,
      baseOptions({
        targetSample: target,
        phraseBars,
        strict: false,
        allowRepeats: true,
        maxRepeatBars: 40,
        exactLength: true,
      })
    );
    expectOk(result);
    expect(result.outputSample).toBeGreaterThanOrEqual(target);
    expect(result.outputSample - target).toBeLessThan(barLen);
  });
});

// ---------------------------------------------------------------------------
// 10. LENGTH IDENTITY
// ---------------------------------------------------------------------------

describe('planRemix -- LENGTH IDENTITY (acceptance 10)', () => {
  it('outputSample === headLen + sum(seg.end - seg.start) + tailLen, exact integer equality', () => {
    const phraseBars = 8;
    const M = 40;
    const barLen = 10000;
    const head = 500;
    const tail = 800;
    const a = makeUniformAnalysis({ numBars: M, barLen, head, tail });
    a.cluster = Int32Array.from({ length: M + 1 }, () => 0);
    a.transitionSeen = new Set(['0>0']);
    const target = head + 32 * barLen + tail;
    const result = planRemix(
      a,
      baseOptions({ targetSample: target, phraseBars, strict: true, allowRepeats: true, maxRepeatBars: 32 })
    );
    expectOk(result);
    const headLen = a.barBoundary[0];
    const tailLen = a.analyzedEndSample - a.barBoundary[M];
    expect(result.outputSample).toBe(headLen + sumSegments(result.segments) + tailLen);
  });
});

// ---------------------------------------------------------------------------
// 11. PURITY
// ---------------------------------------------------------------------------

describe('planRemix -- PURITY (acceptance 11)', () => {
  function snapshotAll(a: RemixAnalysis): Record<string, number[]> {
    return {
      barBoundary: Array.from(a.barBoundary),
      beatSamples: Array.from(a.beatSamples),
      T: Array.from(a.T),
      C: Array.from(a.C),
      L: Array.from(a.L),
      R: Array.from(a.R),
      S: Array.from(a.S),
      cluster: Array.from(a.cluster),
      odf: Array.from(a.odf),
      odfLow: Array.from(a.odfLow),
      bands: Array.from(a.bands),
      chroma: Array.from(a.chroma),
    };
  }

  it('never mutates the analysis passed to it', () => {
    const M = 40;
    const a = makeUniformAnalysis({ numBars: M });
    a.cluster = Int32Array.from({ length: M + 1 }, () => 0);
    a.transitionSeen = new Set(['0>0']);
    const before = snapshotAll(a);
    const beforeTransitions = new Set(a.transitionSeen);

    const target = a.barBoundary[0] + 30 * 10000 + (a.analyzedEndSample - a.barBoundary[M]);
    planRemix(a, baseOptions({ targetSample: target, phraseBars: 8, strict: true, allowRepeats: true, maxRepeatBars: 32 }));

    const after = snapshotAll(a);
    for (const key of Object.keys(before)) {
      expect(after[key]).toEqual(before[key]);
    }
    expect(a.transitionSeen).toEqual(beforeTransitions);
  });
});

// ---------------------------------------------------------------------------
// HEADLINE: duration accuracy against REAL, VARYING bar lengths, across a
// range of targets (both shortening and lengthening), including targets near
// the reachable limits.
// ---------------------------------------------------------------------------

describe('planRemix -- duration accuracy across a range of targets (varying bar lengths)', () => {
  const PHI = 8;
  const M = 48;

  function planFor(a: RemixAnalysis, targetSample: number, maxRepeatFactor: number): PlanRemixResult {
    return planRemix(
      a,
      baseOptions({
        targetSample,
        phraseBars: PHI,
        strict: true,
        allowRepeats: true,
        maxRepeatBars: M,
        maxRepeatFactor,
      })
    );
  }

  it('measures achieved vs. target duration, in SAMPLES, for a sweep of shortening and lengthening targets', () => {
    const a = makeVaryingAnalysis(M);
    const headLen = a.barBoundary[0];
    const tailLen = a.analyzedEndSample - a.barBoundary[M];
    const avgBarLen = (a.barBoundary[M] - a.barBoundary[0]) / M;
    // Confirm the fixture really is non-uniform (guards against accidentally
    // reverting to a uniform fixture and passing for the wrong reason).
    const barLens = new Set<number>();
    for (let i = 1; i <= M; i++) barLens.add(a.barBoundary[i] - a.barBoundary[i - 1]);
    expect(barLens.size).toBeGreaterThan(1);

    const maxRepeatFactor = 3;
    const targetBarsSweep = [16, 24, 32, 40, 48, 56, 64, 72, Math.floor(M * maxRepeatFactor * 0.9)];
    const rows: { targetBars: number; achievedSamples: number; deltaBars: number }[] = [];

    for (const targetBars of targetBarsSweep) {
      const targetSample = Math.round(headLen + targetBars * avgBarLen + tailLen);
      const result = planFor(a, targetSample, maxRepeatFactor);
      expectOk(result);
      // The headline property: outputSample is EXACT integer equality
      // against the real reconstructed segments, never `n*avgBarLen`.
      expect(result.outputSample).toBe(headLen + sumSegments(result.segments) + tailLen);

      const achievedBars = (result.outputSample - headLen - tailLen) / avgBarLen;
      rows.push({ targetBars, achievedSamples: result.outputSample, deltaBars: achievedBars - targetBars });
    }

    // Every measured target lands within the strict-mode tolerance window
    // (tolBars = ceil(PHI/2) = 4), in BAR units estimated from the analysis's
    // own average bar length -- the window's job, not a hand-picked slop.
    const tolBars = Math.ceil(PHI / 2);
    for (const row of rows) {
      expect(Math.abs(row.deltaBars)).toBeLessThanOrEqual(tolBars + 1); // +1 for avgBarLen rounding, not planner slack
    }
    // At least one shortening and one lengthening target were exercised.
    expect(targetBarsSweep.some((b) => b < M)).toBe(true);
    expect(targetBarsSweep.some((b) => b > M)).toBe(true);
  });

  it('a target beyond maxRepeatFactor*lengthSample refuses too-long via the real DP (fix round 1 -- there is no up-front shortcut anymore), reporting the EXACT reachable maximum', () => {
    const a = makeVaryingAnalysis(M);
    const farTooLong = a.analyzedEndSample * 5; // default maxRepeatFactor = 3
    const result = planFor(a, farTooLong, DEFAULT_MAX_REPEAT_FACTOR);
    expectFail(result);
    expect(result.reason).toBe('too-long');
    // The reported maximum must be a genuine, reachable, EXACT value -- well
    // below the absurd request, and above the natural length (since
    // lengthening via repeats is allowed in this fixture) -- not the old
    // `round(maxRepeatFactor*lengthSample)` ESTIMATE (fix round 1, Minor 3),
    // which the review measured wrong in both directions.
    expect(result.maxOutputSample).toBeLessThan(farTooLong);
    expect(result.maxOutputSample).toBeGreaterThan(a.analyzedEndSample);
  });
});

// ---------------------------------------------------------------------------
// lockedJoins (fix round 2) -- pinned joins are EXEMPT from the synthetic
// +JOIN_PENALTY this module applies, both on the re-roll path and inside the
// over-repetition guard. See `PlanRemixOptions.lockedJoins`.
// ---------------------------------------------------------------------------

const joinKeyOf = (j: { fromBar: number; toBar: number }) => `${j.fromBar}>${j.toBar}`;

describe('lockedJoins', () => {
  // THE REQUIRED ASSERTION: the option is additive and provably inert. Every
  // plan produced with no `lockedJoins`, with an EMPTY one, and with one
  // naming keys that can never appear must be byte-identical -- so nothing
  // this module produced before the option existed can have changed.
  it('is INERT when empty: plans are deep-equal with no lock set, an empty lock set, and an unreachable lock set', () => {
    const fixtures: RemixAnalysis[] = [
      makeUniformAnalysis({ numBars: 40 }),
      makeUniformAnalysis({ numBars: 24, cluster: Int32Array.from({ length: 25 }, (_, i) => i % 3) }),
      makeVaryingAnalysis(48),
    ];
    let compared = 0;
    for (const a of fixtures) {
      for (const frac of [0.5, 0.75, 1.0, 1.4]) {
        for (const rollIndex of [0, 1, 2, 3]) {
          for (const strict of [true, false]) {
            const base: PlanRemixOptions = baseOptions({
              targetSample: Math.round(a.analyzedEndSample * frac),
              strict,
              allowRepeats: true,
              rollIndex,
            });
            const plain = planRemix(a, base);
            expect(planRemix(a, { ...base, lockedJoins: [] })).toEqual(plain);
            expect(planRemix(a, { ...base, lockedJoins: ['9999>9998'] })).toEqual(plain);
            compared++;
          }
        }
      }
    }
    expect(compared).toBe(96); // the matrix really ran, it did not short-circuit
  });

  it('a PINNED join survives a re-roll that drops it unpinned -- the exemption, measured on the same call pair', () => {
    // Search the fixture/target matrix for the situation the fix targets: a
    // join in roll 0 that roll 1 discards. That situation is the norm (the
    // roll penalty is +2.0, ~5.7x weights.jump), so this loop finds one
    // immediately; it is a search only so the test cannot silently pass on a
    // fixture where roll 1 happened to keep everything anyway.
    const a = makeVaryingAnalysis(64);
    let found = 0;
    let rescued = 0;
    for (const frac of [0.5, 0.65, 0.8, 1.0, 1.25, 1.5]) {
      const base = baseOptions({
        targetSample: Math.round(a.analyzedEndSample * frac),
        strict: true,
        allowRepeats: true,
      });
      const roll0 = planRemix(a, base);
      if (!roll0.ok || roll0.joins.length === 0) continue;
      for (const pinned of roll0.joins) {
        const key = joinKeyOf(pinned);
        const unpinned = planRemix(a, { ...base, rollIndex: 1 });
        if (!unpinned.ok || unpinned.joins.some((j) => joinKeyOf(j) === key)) continue;
        found++;
        const withPin = planRemix(a, { ...base, rollIndex: 1, lockedJoins: [key] });
        expect(withPin.ok).toBe(true);
        if (withPin.ok && withPin.joins.some((j) => joinKeyOf(j) === key)) rescued++;
      }
    }
    expect(found).toBeGreaterThan(0); // the defect scenario really occurs
    expect(rescued).toBe(found); // and the pin survives every one of them
  });

  it('a pin cannot beat a HARD constraint: forbidding and pinning the same key leaves it out', () => {
    const a = makeVaryingAnalysis(48);
    const base = baseOptions({
      targetSample: Math.round(a.analyzedEndSample * 0.75),
      strict: true,
      allowRepeats: true,
    });
    const roll0 = planRemix(a, base);
    expectOk(roll0);
    expect(roll0.joins.length).toBeGreaterThan(0);
    const key = joinKeyOf(roll0.joins[0]);

    const both = planRemix(a, { ...base, forbiddenJoins: [key], lockedJoins: [key] });

    expectOk(both);
    expect(both.joins.map(joinKeyOf)).not.toContain(key);
  });

  it('stays deterministic with pins: two identical calls are deep-equal', () => {
    const a = makeVaryingAnalysis(48);
    const base = baseOptions({
      targetSample: Math.round(a.analyzedEndSample * 0.75),
      strict: true,
      allowRepeats: true,
    });
    const roll0 = planRemix(a, base);
    expectOk(roll0);
    const locked = roll0.joins.map(joinKeyOf);

    const first = planRemix(a, { ...base, rollIndex: 2, lockedJoins: locked });
    const second = planRemix(a, { ...base, rollIndex: 2, lockedJoins: locked });

    expect(second).toEqual(first);
  });
});

describe('lockedJoins — non-degeneracy (fix round 2, measured)', () => {
  it('pinning never makes the arrangement worse: no extra over-repetition and no systematic cost increase', () => {
    const fixtures = [makeVaryingAnalysis(64), makeUniformAnalysis({ numBars: 48, cluster: Int32Array.from({ length: 49 }, (_, i) => i % 4) })];
    let cases = 0;
    let overUseUnpinned = 0;
    let overUsePinned = 0;
    let totalDelta = 0;
    for (const a of fixtures) {
      for (const frac of [0.5, 0.7, 0.9, 1.2, 1.5]) {
        for (const strict of [true, false]) {
          const base = baseOptions({ targetSample: Math.round(a.analyzedEndSample * frac), strict, allowRepeats: true });
          const roll0 = planRemix(a, base);
          if (!roll0.ok || roll0.joins.length === 0) continue;
          const unpinned = planRemix(a, { ...base, rollIndex: 1 });
          if (!unpinned.ok) continue;
          for (const j of roll0.joins) {
            const pinned = planRemix(a, { ...base, rollIndex: 1, lockedJoins: [joinKeyOf(j)] });
            if (!pinned.ok) continue;
            cases++;
            if (unpinned.maxBarUse > MAX_USE_COUNT) overUseUnpinned++;
            if (pinned.maxBarUse > MAX_USE_COUNT) overUsePinned++;
            totalDelta += pinned.totalCost - unpinned.totalCost;
          }
        }
      }
    }
    expect(cases).toBeGreaterThanOrEqual(20);
    // The pin must not push the DP into repeating a bar more often than it
    // already would — the exact failure mode a cost advantage risks.
    expect(overUsePinned).toBeLessThanOrEqual(overUseUnpinned);
    // And it must not systematically buy pin survival with worse joins:
    // measured MEAN change in clean cost is <= 0 on both fixtures.
    expect(totalDelta / cases).toBeLessThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// requiredJoins (R4b) -- a pin as a HARD constraint. See `PlanRemixOptions.
// requiredJoins` and the module doc comment's "subset axis" section.
// ---------------------------------------------------------------------------

describe('requiredJoins — INERTNESS when empty (R4b, Ruling 4)', () => {
  // THE SINGLE MOST IMPORTANT TEST IN R4b. Every other remix golden is
  // downstream of it: the subset axis is shared by the K = 0 path, so "an
  // empty requiredJoins changes nothing" must be a comparison against stored
  // numbers from code that never knew the option existed — not an argument
  // about `* 1` and `+ 0`.
  it('reproduces the pre-R4b plan golden field-for-field', () => {
    expect(REMIX_PLAN_GOLDEN.length).toBe(REMIX_PLAN_GOLDEN_SPECS.length);
    let checked = 0;
    for (const spec of REMIX_PLAN_GOLDEN_SPECS) {
      const golden = REMIX_PLAN_GOLDEN.find((g) => g.name === spec.name);
      if (!golden) throw new Error(`no golden row for ${spec.name}`);
      const a = spec.analysis();
      const plan = planRemix(a, spec.opts(a));
      expectOk(plan);
      expect(plan.segments.map((s) => [s.start, s.end])).toEqual(golden.segments.map((s) => [s[0], s[1]]));
      expect(plan.joins.map(joinKeyOf)).toEqual([...golden.joins]);
      expect(plan.joins.map((j) => j.cost.total)).toEqual([...golden.joinCosts]);
      expect(plan.outputSample).toBe(golden.outputSample);
      expect(plan.totalCost).toBe(golden.totalCost);
      expect(plan.minOutputSample).toBe(golden.minOutputSample);
      expect(plan.maxOutputSample).toBe(golden.maxOutputSample);
      expect(plan.maxBarUse).toBe(golden.maxBarUse);
      expect(plan.canReroll).toBe(golden.canReroll);
      checked++;
    }
    expect(checked).toBe(8); // the matrix really ran, it did not short-circuit
  });

  it('an ABSENT and an EMPTY requiredJoins produce byte-identical results, including the absence of the report field', () => {
    let compared = 0;
    for (const spec of REMIX_PLAN_GOLDEN_SPECS) {
      const a = spec.analysis();
      const plain = planRemix(a, spec.opts(a));
      const empty = planRemix(spec.analysis(), { ...spec.opts(spec.analysis()), requiredJoins: [] });
      expect(empty).toEqual(plain);
      // `toEqual` ignores undefined-valued keys, so assert the KEY ITSELF is
      // absent — an always-present `requiredJoins: {...}` would slip past a
      // deep-equality check between two post-R4b results.
      expect('requiredJoins' in plain).toBe(false);
      expect('requiredJoins' in empty).toBe(false);
      compared++;
    }
    expect(compared).toBe(8);
  });

  it('a REFUSAL is inert too — no requiredJoins field on either arm of the result', () => {
    // The report field is spread onto BOTH arms, so the ok:false arm needs its
    // own assertion: a mutation that made it unconditional there would leave
    // every ok:true test green.
    const a = makeUniformAnalysis({ numBars: 40 });
    let refusals = 0;
    for (const opts of [
      // Pre-DP refusals (no candidate lists exist yet)...
      baseOptions({ targetSample: -1, strict: true, allowRepeats: true }),
      baseOptions({ targetSample: 100, strict: true, allowRepeats: true, phraseBars: 40 }),
      // ...and the POST-DP empty-window one, which does reach the triage.
      baseOptions({ targetSample: a.analyzedEndSample * 50, strict: true, allowRepeats: false }),
    ]) {
      const r = planRemix(a, opts);
      expectFail(r);
      expect('requiredJoins' in r).toBe(false);
      expect(planRemix(a, { ...opts, requiredJoins: [] })).toEqual(r);
      refusals++;
    }
    expect(refusals).toBe(3);

    // And WITH a required key the failure arm does carry the report, so the
    // absence above is the option being inert rather than the field being
    // unreachable.
    const pinnedRefusal = planRemix(a, {
      ...baseOptions({ targetSample: a.analyzedEndSample * 50, strict: true, allowRepeats: false }),
      requiredJoins: ['8>16'],
    });
    expectFail(pinnedRefusal);
    expect(pinnedRefusal.requiredJoins).toEqual({ mode: 'enforced', satisfied: [], dropped: [] });
  });

  it('the DP table does not grow when nothing is required, and grows by exactly 2^K when something is', () => {
    const M = 20;
    const phraseBars = 8;
    const a = makeUniformAnalysis({ numBars: M });
    const candidates = buildCandidateLists(a, {
      weights: DEFAULT_REMIX_WEIGHTS,
      phraseBars,
      minRunBars: phraseBars,
      strict: true,
      allowRepeats: true,
    });
    const baseCosts = candidates.map((cand, from) =>
      Float64Array.from(cand, (b) => joinCost(a, DEFAULT_REMIX_WEIGHTS, phraseBars, from, b).total)
    );
    const Nmax = 40;
    const cells = (M + 1) * (Nmax + 1);

    // BELOW / ON / ABOVE the multiplier: K = 0 must not grow the table at
    // all, and each further bit must exactly double it.
    for (const K of [0, 1, 2, 3, 4]) {
      const bits = new Map<string, number>();
      for (let i = 0; i < K; i++) bits.set(`${1 + i}>${9 + i}`, i);
      const table = _runRemixDPForTest(
        candidates,
        baseCosts,
        DEFAULT_REMIX_WEIGHTS.jump,
        new Map(),
        M,
        Nmax,
        phraseBars,
        K === 0 ? null : bits,
        1 << K
      );
      expect(table.cost.length).toBe(cells * (1 << K));
      expect(table.parent.length).toBe(cells * (1 << K));
      expect(table.numMasks).toBe(1 << K);
    }
  });
});

describe('requiredJoins — the guarantee (R4b)', () => {
  /** A loudness ramp, so `dLoudness` varies smoothly and legal joins have
   * genuinely different costs. Without it every candidate costs the same and
   * "the pin made the plan dearer" cannot be observed at all — the mistake
   * F7's 6 dB compression fixture and F9's pass-through both shipped. */
  const rampAnalysis = (): RemixAnalysis => makeUniformAnalysis({ numBars: 40, L: (i) => i * 0.05 });

  it('honours a pin the cheapest plan does NOT contain, at a strictly higher cost and the SAME length', () => {
    const a = rampAnalysis();
    const base = baseOptions({
      targetSample: Math.round(a.analyzedEndSample * 0.6),
      strict: true,
      allowRepeats: false,
    });
    const plain = planRemix(a, base);
    expectOk(plain);
    // The fixture is sized so the pin is genuinely OFF the optimal path: the
    // unconstrained plan splices at 15>31 and nowhere near bar 1.
    expect(plain.joins.map(joinKeyOf)).toEqual(['15>31']);

    const pinned = planRemix(a, { ...base, requiredJoins: ['1>9'] });
    expectOk(pinned);

    expect(pinned.joins.map(joinKeyOf)).toContain('1>9');
    // The constraint MOVED the output: a different, two-join arrangement...
    expect(pinned.joins.map(joinKeyOf)).toEqual(['1>9', '24>32']);
    // ...at nearly DOUBLE the cost (2.207 vs 1.157) — the price of the
    // guarantee, paid and visible...
    expect(pinned.totalCost).toBeGreaterThan(plain.totalCost);
    expect(pinned.totalCost).toBeCloseTo(2.2067, 3);
    expect(plain.totalCost).toBeCloseTo(1.1567, 3);
    // ...while still hitting the same duration, so the cost comparison is
    // like-for-like rather than "a different length happened to cost more".
    expect(pinned.outputSample).toBe(plain.outputSample);
    expect(pinned.requiredJoins).toEqual({ mode: 'enforced', satisfied: ['1>9'], dropped: [] });
  });

  it('a PREFERENCE would have dropped that same pin — the measurement that makes R4b more than a rename', () => {
    const a = rampAnalysis();
    const base = baseOptions({
      targetSample: Math.round(a.analyzedEndSample * 0.6),
      strict: true,
      allowRepeats: false,
    });
    const preference = planRemix(a, { ...base, lockedJoins: ['1>9'] });
    expectOk(preference);
    expect(preference.joins.map(joinKeyOf)).not.toContain('1>9');
    const required = planRemix(a, { ...base, requiredJoins: ['1>9'] });
    expectOk(required);
    expect(required.joins.map(joinKeyOf)).toContain('1>9');
  });

  it('forces a splice into a plan whose unconstrained optimum has NO joins at all', () => {
    const a = rampAnalysis();
    const base = baseOptions({
      targetSample: Math.round(a.analyzedEndSample * 0.9),
      strict: true,
      allowRepeats: false,
    });
    const plain = planRemix(a, base);
    expectOk(plain);
    expect(plain.joins).toEqual([]); // straight-through play is optimal here
    expect(plain.totalCost).toBe(0);

    const pinned = planRemix(a, { ...base, requiredJoins: ['1>9'] });
    expectOk(pinned);
    expect(pinned.joins.map(joinKeyOf)).toEqual(['1>9']);
    expect(pinned.totalCost).toBeGreaterThan(0);
    // The forced splice also shortens the arrangement — the pin is not free
    // in duration either, and the reported length is the real one.
    expect(pinned.outputSample).toBeLessThan(plain.outputSample);
  });
});

describe('requiredJoins — mutually incompatible pins (R4b, Ruling 1)', () => {
  const norepeat = (a: RemixAnalysis, frac: number): PlanRemixOptions =>
    baseOptions({ targetSample: Math.round(a.analyzedEndSample * frac), strict: true, allowRepeats: false });

  /** The `i * 0.05` level ramp with one extra step at bar `at`, which makes
   * every join landing on or leaving that bar dearer than its neighbours.
   * The plain ramp cannot separate `1>9` from `2>10` — both span 8 bars, so
   * both cost the same level jump — and this is the smallest change that
   * gives one of them a real cost advantage without touching anything else. */
  const rampWithLevelStepAt = (at: number): RemixAnalysis =>
    makeUniformAnalysis({ numBars: 40, L: (i) => i * 0.05 + (i === at ? 0.5 : 0) });

  it('keeps the larger satisfiable set and NAMES the incompatible pin', () => {
    // With `allowRepeats: false` every jump moves forward, so `8>16` (landing
    // at 24) and `16>24` (landing at 32) can never both occur: after either,
    // the other's source bar is behind the play head.
    const a = makeUniformAnalysis({ numBars: 40 });
    const r = planRemix(a, { ...norepeat(a, 0.75), requiredJoins: ['8>16', '16>24'] });
    expectOk(r);
    expect(r.joins.map(joinKeyOf)).toEqual(['8>16']);
    expect(r.requiredJoins).toEqual({
      mode: 'enforced',
      satisfied: ['8>16'],
      dropped: [{ key: '16>24', reason: 'incompatible' }],
    });
  });

  it('breaks an EXACTLY equal-cost tie toward the lower mask, so the caller controls it by listing order', () => {
    // `makeUniformAnalysis` gives every legal candidate the same join cost, so
    // "two distinct masks of equal popcount reaching the same n at exactly
    // equal cost" is the COMMON case here, not a corner. `8>16` and `16>24`
    // are mutually exclusive (forward-only jumps), both delete 8 bars, and
    // both cost 1.05 — so the honoured set is decided purely by
    // `reduceTerminal`'s tie rule, and by nothing else.
    const a = makeUniformAnalysis({ numBars: 40 });
    const first = planRemix(a, { ...norepeat(a, 0.75), requiredJoins: ['8>16', '16>24'] });
    const second = planRemix(a, { ...norepeat(a, 0.75), requiredJoins: ['16>24', '8>16'] });
    expectOk(first);
    expectOk(second);

    // Same cost, same length: nothing but the tie rule separates them.
    expect(first.totalCost).toBe(second.totalCost);
    expect(first.outputSample).toBe(second.outputSample);

    // Bit 0 wins in both — i.e. whichever key the caller listed FIRST.
    expect(first.requiredJoins?.satisfied).toEqual(['8>16']);
    expect(second.requiredJoins?.satisfied).toEqual(['16>24']);
    expect(first.joins.map(joinKeyOf)).toEqual(['8>16']);
    expect(second.joins.map(joinKeyOf)).toEqual(['16>24']);
    // Relaxing `reduceTerminal`'s `c < out[n]` to `<=` picks the HIGHEST mask
    // instead and inverts both answers above.
  });

  it('collapses duplicate keys instead of spending two bits on one join', () => {
    // A caller listing the same key twice must not get a second bit: the bit
    // map is keyed by string, so the first index would be unreachable and the
    // DP would decide the pin set was only half satisfiable.
    const a = makeUniformAnalysis({ numBars: 40 });
    const once = planRemix(a, { ...norepeat(a, 0.75), requiredJoins: ['8>16'] });
    const twice = planRemix(a, { ...norepeat(a, 0.75), requiredJoins: ['8>16', '8>16'] });
    expectOk(twice);
    expect(twice.requiredJoins).toEqual({ mode: 'enforced', satisfied: ['8>16'], dropped: [] });
    expect(twice).toEqual(once);
  });

  it('is deterministic across repeated identical calls', () => {
    const a = makeUniformAnalysis({ numBars: 40 });
    const opts: PlanRemixOptions = { ...norepeat(a, 0.75), requiredJoins: ['8>16', '16>24'] };
    const first = planRemix(a, opts);
    for (let i = 0; i < 5; i++) expect(planRemix(makeUniformAnalysis({ numBars: 40 }), opts)).toEqual(first);
  });

  it('indexes bits by POSITION, not "always bit 0", and it is the COST that picks the honoured pair', () => {
    // `1>9` and `2>10` are mutually incompatible for the same forward-only
    // reason; `24>32` is compatible with either. So the maximum satisfiable
    // size is 2 and something has to choose between {1>9, 24>32} and
    // {2>10, 24>32}.
    //
    // TWO fixtures, differing ONLY in which of the pair is dearer, because on
    // one fixture this test cannot tell cost from order (fix round 3). On the
    // plain `L(i) = i*0.05` ramp both joins span exactly 8 bars, so their
    // level costs are equal to within float noise (measured: 1.5e-9) and the
    // honoured pair could as easily have been decided by the listing order —
    // which is the thing the old comment claimed to have ruled out. One extra
    // step of level at bar 10 makes `2>10` genuinely dearer, the same step at
    // bar 9 makes `1>9` dearer, and the honoured pair follows the cost while
    // the listing order is held FIXED.
    const dearer210 = rampWithLevelStepAt(10);
    const dearer19 = rampWithLevelStepAt(9);
    // The premise, measured here rather than asserted in prose above.
    const cost = (a: RemixAnalysis, from: number, to: number): number =>
      joinCost(a, DEFAULT_REMIX_WEIGHTS, 8, from, to).total;
    expect(cost(dearer210, 1, 9)).toBeLessThan(cost(dearer210, 2, 10));
    expect(cost(dearer19, 2, 10)).toBeLessThan(cost(dearer19, 1, 9));

    // Same three pins, same order, both times: `2>10` is bit 0, so a
    // "satisfied = bit 0" implementation reports the wrong answer on the first
    // fixture, and an "always honour the earliest listed" one on the second.
    const listed = ['2>10', '1>9', '24>32'];
    const first = planRemix(dearer210, { ...norepeat(dearer210, 0.6), requiredJoins: listed });
    expectOk(first);
    expect(first.requiredJoins?.satisfied).toEqual(['1>9', '24>32']);
    expect(first.requiredJoins?.dropped).toEqual([{ key: '2>10', reason: 'incompatible' }]);
    expect(first.joins.map(joinKeyOf)).toEqual(['1>9', '24>32']);

    const second = planRemix(dearer19, { ...norepeat(dearer19, 0.6), requiredJoins: listed });
    expectOk(second);
    expect(second.requiredJoins?.satisfied).toEqual(['2>10', '24>32']);
    expect(second.requiredJoins?.dropped).toEqual([{ key: '1>9', reason: 'incompatible' }]);
    expect(second.joins.map(joinKeyOf)).toEqual(['2>10', '24>32']);

    // ...and the bit indices really are bookkeeping: naming the same three
    // pins in a different order changes nothing, on either fixture.
    const swapped = ['1>9', '2>10', '24>32'];
    expect(planRemix(dearer210, { ...norepeat(dearer210, 0.6), requiredJoins: swapped })).toEqual(first);
    expect(planRemix(dearer19, { ...norepeat(dearer19, 0.6), requiredJoins: swapped })).toEqual(second);
  });

  it('reports a length that only the pins made unreachable, and says how many were in force', () => {
    const a = makeUniformAnalysis({ numBars: 40 });
    const base = norepeat(a, 0.75);
    expectOk(planRemix(a, base)); // the same target succeeds unpinned
    const r = planRemix(a, { ...base, requiredJoins: ['8>24'] });
    expectFail(r);
    expect(r.message).toContain('1 pinned edit(s) enforced');
    expect(r.requiredJoins).toEqual({ mode: 'enforced', satisfied: [], dropped: [] });
  });
});

describe('requiredJoins — the pre-DP categories (R4b, Ruling 2)', () => {
  it('distinguishes forbidden, no-candidate and incompatible from each other in ONE call', () => {
    const a = makeUniformAnalysis({ numBars: 40 });
    const base = baseOptions({
      targetSample: Math.round(a.analyzedEndSample * 0.75),
      strict: true,
      allowRepeats: false,
    });
    const r = planRemix(a, {
      ...base,
      forbiddenJoins: ['24>32'],
      // 24>32 is forbidden AND required (a direct contradiction);
      // 3>4 is congruence-illegal so it is in no candidate list;
      // 8>16 and 16>24 are individually fine but mutually exclusive.
      requiredJoins: ['24>32', '3>4', '8>16', '16>24'],
    });
    expectOk(r);
    expect(r.requiredJoins?.mode).toBe('enforced');
    expect(r.requiredJoins?.satisfied).toEqual(['8>16']);
    expect(r.requiredJoins?.dropped).toEqual([
      { key: '24>32', reason: 'forbidden' },
      { key: '3>4', reason: 'no-candidate' },
      { key: '16>24', reason: 'incompatible' },
    ]);
    expect(r.joins.map(joinKeyOf)).not.toContain('24>32');
  });

  it('forbidden wins over required even when nothing else is pinned', () => {
    const a = makeUniformAnalysis({ numBars: 40 });
    const base = baseOptions({
      targetSample: Math.round(a.analyzedEndSample * 0.75),
      strict: true,
      allowRepeats: false,
    });
    const r = planRemix(a, { ...base, forbiddenJoins: ['8>16'], requiredJoins: ['8>16'] });
    expectOk(r);
    expect(r.joins.map(joinKeyOf)).not.toContain('8>16');
    expect(r.requiredJoins?.dropped).toEqual([{ key: '8>16', reason: 'forbidden' }]);
  });

  it('a key filtered out by strict congruence is no-candidate, and the SAME key is satisfiable in loose mode', () => {
    const a = makeVaryingAnalysis(64);
    const target = Math.round(a.analyzedEndSample * 1.2);
    const strict = planRemix(a, baseOptions({ targetSample: target, strict: true, allowRepeats: true, requiredJoins: ['1>13'] }));
    expectOk(strict);
    // 1 !== 13 (mod 8), so strict congruence removes it before the DP runs —
    // and the category says WHY rather than just that the pin is missing.
    expect(strict.requiredJoins?.dropped).toEqual([{ key: '1>13', reason: 'no-candidate' }]);

    const loose = planRemix(a, baseOptions({ targetSample: target, strict: false, allowRepeats: true, requiredJoins: ['1>13'] }));
    expectOk(loose);
    expect(loose.requiredJoins?.dropped).toEqual([]);
    expect(loose.joins.map(joinKeyOf)).toContain('1>13');
  });

  it('triage does not consume a bit: 6 pins of which 2 are impossible stay ENFORCED', () => {
    const a = makeVaryingAnalysis(64);
    const base = baseOptions({ targetSample: Math.round(a.analyzedEndSample * 1.5), strict: true, allowRepeats: true });
    const r = planRemix(a, {
      ...base,
      rollIndex: 2,
      forbiddenJoins: ['9>1'],
      requiredJoins: ['16>8', '32>24', '48>40', '24>16', '9>1', '5>6'],
    });
    expectOk(r);
    // 6 > MAX_REQUIRED_JOINS, but two are decided before the DP, so the
    // enforceable set is 4 and the guarantee stays in force.
    expect(r.requiredJoins?.mode).toBe('enforced');
    expect(r.requiredJoins?.satisfied).toEqual(['16>8', '32>24', '48>40', '24>16']);
    expect(r.requiredJoins?.dropped).toEqual([
      { key: '9>1', reason: 'forbidden' },
      { key: '5>6', reason: 'no-candidate' },
    ]);
  });
});

describe('requiredJoins — the MAX_REQUIRED_JOINS cap (R4b, Ruling 3)', () => {
  const PINS = ['16>8', '32>24', '48>40', '24>16', '40>32'];

  it('is 4 — the largest subset axis the memory arithmetic allows', () => {
    // Named for what it asserts (fix round 3). The relationship the old name
    // was about — this cap being BELOW the panel's `MAX_LOCKED_JOINS`, which
    // is what makes the degradation reachable at all — is asserted in
    // `remixService.test.ts`, where both constants are in scope; importing the
    // service here would drag the store and the workers into a pure DSP suite.
    expect(MAX_REQUIRED_JOINS).toBe(4);
  });

  // BELOW / ON / ABOVE the cap, sized so the boundary genuinely moves the
  // output: at 5 pins the mode flips and the honoured set collapses.
  it.each([
    [MAX_REQUIRED_JOINS - 1, 'enforced'],
    [MAX_REQUIRED_JOINS, 'enforced'],
    [MAX_REQUIRED_JOINS + 1, 'preference'],
  ] as [number, 'enforced' | 'preference'][])('with %i pins the mode is %s', (count, mode) => {
    const a = makeVaryingAnalysis(64);
    const base = baseOptions({ targetSample: Math.round(a.analyzedEndSample * 1.5), strict: true, allowRepeats: true });
    const r = planRemix(a, { ...base, rollIndex: 2, requiredJoins: PINS.slice(0, count) });
    expectOk(r);
    expect(r.requiredJoins?.mode).toBe(mode);
    if (mode === 'enforced') {
      expect(r.requiredJoins?.satisfied).toEqual(PINS.slice(0, count));
      expect(r.requiredJoins?.dropped).toEqual([]);
    } else {
      // Degraded to `lockedJoins` semantics: nothing is guaranteed, and the
      // report says so by category rather than by silence.
      expect(r.requiredJoins?.dropped.length).toBeGreaterThan(0);
      for (const d of r.requiredJoins?.dropped ?? []) expect(d.reason).toBe('not-enforced');
    }
  });

  it('above the cap it behaves EXACTLY like lockedJoins — the fallback is the existing mechanism, not a new one', () => {
    const a = makeVaryingAnalysis(64);
    const base = baseOptions({ targetSample: Math.round(a.analyzedEndSample * 1.5), strict: true, allowRepeats: true, rollIndex: 2 });
    const over = planRemix(a, { ...base, requiredJoins: PINS });
    const locked = planRemix(a, { ...base, lockedJoins: PINS });
    expectOk(over);
    expectOk(locked);
    expect(over.segments).toEqual(locked.segments);
    expect(over.joins.map(joinKeyOf)).toEqual(locked.joins.map(joinKeyOf));
    expect(over.totalCost).toBe(locked.totalCost);
  });
});

describe('requiredJoins — interaction with lockedJoins and the guard (R4b, Ruling 5)', () => {
  it('the removed LOCK_BONUS was making the planner REPEAT the pinned join', () => {
    // The reason an enforced key must not carry the bonus, pinned as an
    // arrangement rather than as an argument. A path can traverse the pinned
    // join twice and would collect `-LOCK_BONUS` twice, so the bonus is a
    // standing discount on repeating it. Measured against a bonus-enabled
    // build of this module over the same 102-case matrix: 4 arrangements
    // changed, and in every one the bonus build played the pinned join one
    // more time. This is that case at `M = 128`:
    //
    //   without the bonus  44>12, 73>57, 77>45   totalCost 8.6688
    //   with the bonus     44>12, 44>12, 73>57   totalCost 8.7962
    //
    // The assertion is the WITHOUT plan: the pinned join appears exactly
    // once, and the arrangement is the cheaper of the two. Re-adding the
    // bonus turns this red.
    const a = makeRichAnalysis(128);
    const r = planRemix(
      a,
      baseOptions({
        targetSample: Math.round(a.analyzedEndSample * 1.6),
        strict: true,
        allowRepeats: true,
        rollIndex: 1,
        requiredJoins: ['44>12'],
      })
    );
    expectOk(r);
    expect(r.joins.map(joinKeyOf)).toEqual(['44>12', '73>57', '77>45']);
    expect(r.joins.filter((j) => joinKeyOf(j) === '44>12')).toHaveLength(1);
    expect(r.totalCost).toBeCloseTo(8.6688, 3);
  });

  it('an ENFORCED key gets no LOCK_BONUS, even when the caller also passes it as lockedJoins', () => {
    // The bonus is a preference for something already forced; a path can
    // traverse the same join twice and would collect it twice. Measured over
    // 102 pin/press cases it changed the plan in 4, and every change was for
    // the worse — so passing both must be indistinguishable from passing only
    // `requiredJoins`.
    const a = makeVaryingAnalysis(64);
    const base = baseOptions({ targetSample: Math.round(a.analyzedEndSample * 1.5), strict: true, allowRepeats: true, rollIndex: 2 });
    let compared = 0;
    for (const pin of ['16>8', '32>24', '48>40']) {
      const only = planRemix(a, { ...base, requiredJoins: [pin] });
      const both = planRemix(a, { ...base, requiredJoins: [pin], lockedJoins: [pin] });
      expect(both).toEqual(only);
      compared++;
    }
    expect(compared).toBe(3);
  });

  it('a required join survives every roll index, including the rolls that would otherwise have moved it', () => {
    // NAMED for what it observes (fix round 3). The old name said "is exempt
    // from the re-roll penalty", which this body cannot see: the hard
    // constraint puts the pin in the plan at every roll whether or not its
    // edge is exempt from the penalty. The EXEMPTION is observed by the next
    // test down, which watches it move the rest of the arrangement.
    //
    // What this body does observe — and now asserts, so it is not vacuous —
    // is that the constraint overrides a genuinely different choice at every
    // one of these rolls: the unpinned plan at the same roll index does not
    // contain the key at all.
    const a = makeVaryingAnalysis(64);
    const pin = '16>8';
    const opts = (rollIndex: number, requiredJoins?: string[]): PlanRemixOptions =>
      baseOptions({
        targetSample: Math.round(a.analyzedEndSample * 1.5),
        strict: true,
        allowRepeats: true,
        rollIndex,
        ...(requiredJoins ? { requiredJoins } : {}),
      });
    let rolls = 0;
    for (const rollIndex of [0, 1, 2, 3]) {
      const free = planRemix(a, opts(rollIndex));
      expectOk(free);
      // The roll's own choice, which the pin has to override.
      expect(free.joins.map(joinKeyOf)).not.toContain(pin);

      const r = planRemix(a, opts(rollIndex, [pin]));
      expectOk(r);
      expect(r.joins.map(joinKeyOf)).toContain(pin);
      expect(r.requiredJoins?.dropped).toEqual([]);
      rolls++;
    }
    expect(rolls).toBe(4);
  });

  it('the exemption changes the REST of the arrangement, not just whether the pin survives', () => {
    // Exempting a required key from the re-roll/guard penalty cannot change
    // whether the pinned join appears — the constraint already forces that —
    // so the only way to test the exemption is to pin the arrangement AROUND
    // it. Without the exemption the pinned edge carries `+JOIN_PENALTY` on
    // every roll, which makes every OTHER edge look relatively cheaper and
    // moves the plan. Measured over 4 368 pin/roll/target combinations, the
    // exemption changes the chosen arrangement in 591 of them (13.5%); this
    // is one, chosen because both variants keep the pin, so nothing but the
    // exemption can explain the difference.
    const a = makeVaryingAnalysis(48);
    const r = planRemix(
      a,
      baseOptions({
        targetSample: Math.round(a.analyzedEndSample * 1.8),
        strict: true,
        allowRepeats: true,
        rollIndex: 2,
        requiredJoins: ['30>38'],
      })
    );
    expectOk(r);
    expect(r.joins.map(joinKeyOf)).toEqual(['34>2', '18>2', '30>38']);
  });

  it('the over-repetition guard never trades a guaranteed pin for a repetition win', () => {
    // A target far above the source forces heavy repetition, which is exactly
    // when the guard runs its penalised re-runs. The pin must still be there
    // afterwards, and `maxBarUse` must be reported honestly rather than the
    // guard pretending it fixed something.
    const a = makeVaryingAnalysis(48);
    const r = planRemix(
      a,
      baseOptions({
        targetSample: Math.round(a.analyzedEndSample * 2.6),
        strict: true,
        allowRepeats: true,
        requiredJoins: ['16>8'],
      })
    );
    expectOk(r);
    expect(r.joins.map(joinKeyOf)).toContain('16>8');
    // "Honestly" means: recounted from the CHOSEN path, not from what the
    // guard hoped to achieve. `toBeGreaterThan(1)` could not tell a plan the
    // guard fixed from one it did not (fix round 3), which is the whole point
    // of the comment above — so recount bar usage straight out of `segments`
    // and require exact agreement, then state the number.
    const barOf = (sample: number): number => {
      const bar = a.barBoundary.indexOf(sample);
      if (bar < 0) throw new Error(`${sample} is not a bar boundary`);
      return bar;
    };
    const use = new Array<number>(a.numBars).fill(0);
    for (const seg of r.segments) for (let b = barOf(seg.start); b < barOf(seg.end); b++) use[b]++;
    expect(r.maxBarUse).toBe(Math.max(...use));
    // And the guard genuinely did NOT fix this one: 5 uses against a
    // MAX_USE_COUNT of 3. The report says so rather than reporting the bound.
    expect(r.maxBarUse).toBe(5);
    expect(r.maxBarUse).toBeGreaterThan(MAX_USE_COUNT);
    expect(r.requiredJoins).toEqual({ mode: 'enforced', satisfied: ['16>8'], dropped: [] });
  });
});

describe('requiredJoins — why a bitmask (R4b, the design evidence)', () => {
  it('a single plan CAN traverse the same join key twice, so a counter would over-count', () => {
    // The measured counter-example: if `requiredJoins` were "how many
    // required edges have I taken", a path using pin A twice and pin B never
    // would reach `count = 2 = K` and be declared complete.
    const a = makeVaryingAnalysis(64);
    const r = planRemix(
      a,
      baseOptions({ targetSample: Math.round(a.analyzedEndSample * 2.0), strict: false, allowRepeats: true, rollIndex: 1 })
    );
    expectOk(r);
    const keys = r.joins.map(joinKeyOf);
    expect(keys.length).toBeGreaterThan(new Set(keys).size);
  });

  it('two pinned joins are realizable in EITHER order, so a prefix index would be wrong', () => {
    // Reachability of "A then B" and of "B then A" through the real candidate
    // graph. Both hold, so the order pins appear in is not fixed and "which
    // pins are done" is genuinely set-valued.
    const M = 32;
    const phraseBars = 8;
    const a = makeVaryingAnalysis(M);
    const candidates = buildCandidateLists(a, {
      weights: DEFAULT_REMIX_WEIGHTS,
      phraseBars,
      minRunBars: phraseBars,
      strict: true,
      allowRepeats: true,
    });
    const Nmax = M * DEFAULT_MAX_REPEAT_FACTOR;
    const orderReachable = (first: string, second: string): boolean => {
      const width = Nmax + 1;
      const seen = new Uint8Array((M + 1) * width * 3);
      const at = (p: number, n: number, s: number): number => (p * width + n) * 3 + s;
      seen[at(0, 0, 0)] = 1;
      for (let n = 0; n < Nmax; n++) {
        for (let p = 0; p <= M; p++) {
          for (let s = 0; s < 3; s++) {
            if (!seen[at(p, n, s)]) continue;
            if (p < M) seen[at(p + 1, n + 1, s)] = 1;
            const cand = candidates[p];
            if (!cand) continue;
            for (let i = 0; i < cand.length; i++) {
              const landing = cand[i] + phraseBars;
              const newN = n + phraseBars;
              if (landing > M || newN > Nmax) continue;
              const key = `${p}>${cand[i]}`;
              const ns = s === 0 && key === first ? 1 : s === 1 && key === second ? 2 : s;
              seen[at(landing, newN, ns)] = 1;
            }
          }
        }
      }
      for (let n = 0; n <= Nmax; n++) if (seen[at(M, n, 2)]) return true;
      return false;
    };
    expect(orderReachable('9>17', '10>2')).toBe(true);
    expect(orderReachable('10>2', '9>17')).toBe(true);
  });
});
