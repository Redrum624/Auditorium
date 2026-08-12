import {
  crossfadeGains,
  normalizedCorrelation,
  bestAlignLag,
  effectiveCrossfadeMs,
  renderRemix,
} from './remixRender';
import type { RemixPlan } from './remixRender';
import type { RemixAnalysis } from './remixFeatures';
import type { RemixSegment, RemixJoin } from './remixPlan';
import { ONSET_HOP } from './tempoCore';

const SR = 44100;

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

/** Deterministic LCG, verbatim recipe from `fft.test.ts:104` / `remixPlan.test.ts` --
 * this repo's own precedent for reproducible synthetic noise, never `Math.random()`. */
function makeLcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
}

function noise(n: number, seed: number): Float32Array {
  const rand = makeLcg(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rand();
  return out;
}

function sine(freq: number, n: number, sr = SR, amp = 1): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

/** `r*a + sqrt(1-r^2)*b`, giving a signal whose correlation to `a` is
 * approximately `r` when `a`/`b` are independent, comparable-energy noise. */
function makeCorrelated(a: Float32Array, b: Float32Array, r: number): Float32Array {
  const k = Math.sqrt(Math.max(0, 1 - r * r));
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = r * a[i] + k * b[i];
  return out;
}

function rms(x: Float32Array, start = 0, end = x.length): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / (end - start));
}

const NUM_BANDS = 23;
const BEATS_PER_BAR = 4;
const R_DIMS = 4 * BEATS_PER_BAR;

interface AnalysisOverrides {
  numBars: number;
  barBoundary: Int32Array;
  analyzedEndSample: number;
  beatSamples?: Int32Array;
  decimationFactor?: number;
  odf?: Float32Array;
}

/** Minimal, hand-built `RemixAnalysis` fixture -- only the fields
 * `remixRender.ts` actually reads (`barBoundary`, `numBars`,
 * `analyzedEndSample`, `beatSamples`, `decimationFactor`, `odf`) are given
 * meaningful values; everything else is a validly-shaped placeholder,
 * following the `remixPlan.test.ts` precedent for hand-built fixtures. */
function makeAnalysis(o: AnalysisOverrides): RemixAnalysis {
  const { numBars, barBoundary, analyzedEndSample } = o;
  const numBoundaries = numBars + 1;
  const decimationFactor = o.decimationFactor ?? 1;
  const beatSamples = o.beatSamples ?? Int32Array.from({ length: numBoundaries * BEATS_PER_BAR }, (_, i) => i * 30000);
  const odf = o.odf ?? new Float32Array(0);

  return {
    bpm: 120,
    confidence: 1,
    beatSamples,
    salience: 1,
    peakRatio: 1,
    ibiCv: 0,
    truncated: false,
    analyzedEndSample,
    odf,
    periodFrames: 20,
    decimationFactor,
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
    cluster: Int32Array.from({ length: numBoundaries }, (_, i) => i),
    transitionSeen: new Set<string>(),
  };
}

interface PlanOverrides {
  segments: RemixSegment[];
  joins: RemixJoin[];
  outputSample: number;
  targetSample?: number;
}

function makePlan(o: PlanOverrides): RemixPlan {
  return {
    ok: true,
    segments: o.segments,
    joins: o.joins,
    outputSample: o.outputSample,
    targetSample: o.targetSample ?? o.outputSample,
    totalCost: 0,
    minOutputSample: o.outputSample,
    maxOutputSample: o.outputSample,
    maxBarUse: 1,
    canReroll: o.joins.length > 0,
  };
}

function join(fromBar: number, toBar: number): RemixJoin {
  return {
    fromBar,
    toBar,
    cost: { timbre: 0, chroma: 0, loudness: 0, rhythm: 0, struct: 0, phrase: 0, total: 0 },
  };
}

/** Sample position for onset FRAME `frame` at `decimationFactor` D=1 --
 * inverse of `sample/D/ONSET_HOP - 1`. */
function sampleForFrame(frame: number): number {
  return (frame + 1) * ONSET_HOP;
}

// ---------------------------------------------------------------------------
// 1. Gain law -- closed-form power preservation across a rho sweep
// ---------------------------------------------------------------------------

describe('crossfadeGains', () => {
  const rhos = [0, 0.25, 0.5, 0.75, 1];
  const steps = 21;

  it('is power-preserving to 6 places for every rho in the sweep and every t', () => {
    let worst = 0;
    for (const rho of rhos) {
      for (let s = 0; s < steps; s++) {
        const t = s / (steps - 1);
        const { gOut, gIn } = crossfadeGains(t, rho);
        const power = gOut * gOut + gIn * gIn + 2 * rho * gOut * gIn;
        worst = Math.max(worst, Math.abs(power - 1));
        expect(power).toBeCloseTo(1, 6);
      }
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('has the expected endpoints for every rho', () => {
    for (const rho of rhos) {
      const at0 = crossfadeGains(0, rho);
      const at1 = crossfadeGains(1, rho);
      expect(at0.gOut).toBeCloseTo(1, 9);
      expect(at0.gIn).toBeCloseTo(0, 9);
      expect(at1.gOut).toBeCloseTo(0, 9);
      expect(at1.gIn).toBeCloseTo(1, 9);
    }
  });

  it('gOut is strictly decreasing and gIn strictly increasing in t, for every rho', () => {
    for (const rho of rhos) {
      let prevOut = Infinity;
      let prevIn = -Infinity;
      for (let s = 0; s < steps; s++) {
        const t = s / (steps - 1);
        const { gOut, gIn } = crossfadeGains(t, rho);
        expect(gOut).toBeLessThan(prevOut);
        expect(gIn).toBeGreaterThan(prevIn);
        prevOut = gOut;
        prevIn = gIn;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Level preservation -- rho=1 (identity) and rho~0 (uncorrelated noise)
// ---------------------------------------------------------------------------

describe('level preservation (music-free justification of the gain law)', () => {
  it('rho=1: crossfading a signal with itself reproduces it exactly (maxErr < 1e-6)', () => {
    const n = 2000;
    const x = sine(440, n).map((v, i) => v + 0.3 * Math.sin((2 * Math.PI * 977 * i) / SR));
    let maxErr = 0;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const { gOut, gIn } = crossfadeGains(t, 1);
      const mixed = x[i] * gOut + x[i] * gIn;
      maxErr = Math.max(maxErr, Math.abs(mixed - x[i]));
    }
    expect(maxErr).toBeLessThan(1e-6);
  });

  it('rho~0: crossfading two uncorrelated equal-RMS noise signals keeps RMS within +/-0.5 dB', () => {
    const n = 8000;
    const a = noise(n, 11);
    const b = noise(n, 97);
    const rho = Math.max(0, Math.min(1, normalizedCorrelation(a, b)));
    expect(rho).toBeLessThan(0.1); // fixture sanity -- genuinely near-uncorrelated

    const mixed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const { gOut, gIn } = crossfadeGains(t, rho);
      mixed[i] = a[i] * gOut + b[i] * gIn;
    }
    const inputRms = (rms(a) + rms(b)) / 2;
    const outputRms = rms(mixed);
    const dbDiff = 20 * Math.log10(outputRms / inputRms);
    expect(Math.abs(dbDiff)).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// 3. Length invariance, parameterised over crossfadeMs x shape
// ---------------------------------------------------------------------------

describe('renderRemix -- length invariance', () => {
  // Frames spaced far enough apart that a +/-2 radius peak search never
  // overlaps between boundaries.
  const frames = [10, 30, 50, 70, 90];
  const boundarySamples = frames.map(sampleForFrame);
  const barBoundary = Int32Array.from(boundarySamples);
  const tailLen = 2000;
  const analyzedEndSample = boundarySamples[4] + tailLen;
  const sourceLen = analyzedEndSample + 3000; // extra margin so analyzedEndSample < source.length (truncated-tail path)

  const odf = new Float32Array(100);
  odf[frames[0]] = 0.1;
  odf[frames[1]] = 0.1;
  odf[frames[2]] = 5.0; // boundary 2 = toBar of the one join -- forced HIGH onset
  odf[frames[3]] = 0.1;
  odf[frames[4]] = 0.1;

  const analysis = makeAnalysis({ numBars: 4, barBoundary, analyzedEndSample, odf });

  const seg0: RemixSegment = { start: boundarySamples[0], end: boundarySamples[1] };
  const seg1: RemixSegment = { start: boundarySamples[2], end: boundarySamples[3] };
  // The length identity's tail is measured from THIS plan's own last segment
  // end, not from `analysis`'s own final boundary (bar 4 here is simply
  // unused by this plan -- a plan need not walk every analysis boundary).
  const actualTailLen = analyzedEndSample - seg1.end;
  const outputSample = seg0.end - seg0.start + (seg1.end - seg1.start) + boundarySamples[0] + actualTailLen;
  const plan = makePlan({ segments: [seg0, seg1], joins: [join(1, 2)], outputSample });

  function expectedLength(): number {
    return boundarySamples[0] + (seg0.end - seg0.start) + (seg1.end - seg1.start) + actualTailLen;
  }

  // Fixture A: identical tone everywhere -> rho high everywhere -> 'centred' forced via rho.
  const sourceCentred: Float32Array[] = [sine(220, sourceLen)];
  // Fixture B: independent noise on each side of the join -> rho low; onset forces the rest -> 'pre-roll'.
  const sourcePreRoll: Float32Array[] = [(() => {
    const s = noise(sourceLen, 3);
    const s2 = noise(sourceLen, 4);
    for (let i = boundarySamples[2] - 3000; i < sourceLen; i++) s[i] = s2[i];
    return s;
  })()];

  const crossfadeMsValues = [0, 5, 25, 120];

  for (const crossfadeMs of crossfadeMsValues) {
    it(`'centred' fixture: crossfadeMs=${crossfadeMs} -> exact output length + shape is centred`, () => {
      const result = renderRemix(sourceCentred, analysis, plan, { sampleRate: SR, crossfadeMs });
      expect(result.channels[0].length).toBe(expectedLength());
      expect(result.channels[0].length).toBe(plan.outputSample);
      expect(result.shapes[0]).toBe('centred');
    }, 15000);

    it(`'pre-roll' fixture: crossfadeMs=${crossfadeMs} -> exact output length + shape is pre-roll`, () => {
      const result = renderRemix(sourcePreRoll, analysis, plan, { sampleRate: SR, crossfadeMs });
      expect(result.channels[0].length).toBe(expectedLength());
      expect(result.channels[0].length).toBe(plan.outputSample);
      expect(result.shapes[0]).toBe('pre-roll');
    }, 15000);
  }
});

// ---------------------------------------------------------------------------
// 3b. effectiveCrossfadeMs -- the quarter-beat cap, stated rather than silent
// ---------------------------------------------------------------------------

/** A tracked beat grid at `bpm` -- the median inter-beat interval IS the beat
 * period, which is exactly what the cap is derived from. */
function beatGrid(bpm: number, count = 64): Int32Array {
  const period = Math.round((60 / bpm) * SR);
  return Int32Array.from({ length: count }, (_, i) => i * period);
}

describe('effectiveCrossfadeMs -- what the requested width really becomes', () => {
  it('returns the request untouched while the quarter-beat bound is wider (120 BPM: the whole 5-120 ms UI range fits)', () => {
    const beats = beatGrid(120); // period 22050 -> bound 5512 samples = 125.0 ms
    // Precision 1 (0.05 ms), not 9: the only residual is the request's own
    // rounding to a whole sample (5 ms -> 221 samples -> 5.011 ms), which is a
    // real width, not a cap.
    for (const requested of [0, 5, 25, 60, 120]) {
      expect(effectiveCrossfadeMs(requested, beats, SR)).toBeCloseTo(requested, 1);
    }
    // Exact where the request lands on a whole sample.
    expect(effectiveCrossfadeMs(120, beats, SR)).toBe(120);
  });

  it('reports the quarter-beat cap rather than the request above ~125 BPM (defect 4a)', () => {
    const beats = beatGrid(150); // period 17640 -> bound 4410 samples = 100.0 ms exactly
    expect(effectiveCrossfadeMs(120, beats, SR)).toBeCloseTo(100, 9);
    expect(effectiveCrossfadeMs(100, beats, SR)).toBeCloseTo(100, 9);
    // Below the cap nothing is taken away -- the readout must not cry wolf.
    expect(effectiveCrossfadeMs(60, beats, SR)).toBeCloseTo(60, 9);
  });

  it('applies no beat cap at all when fewer than two beats were tracked (no period to bound against)', () => {
    expect(effectiveCrossfadeMs(120, new Int32Array(0), SR)).toBeCloseTo(120, 9);
    expect(effectiveCrossfadeMs(120, Int32Array.from([1000]), SR)).toBeCloseTo(120, 9);
  });

  it('is the width renderRemix actually applies: a request above the cap renders IDENTICALLY to one at the cap, and differently below it', () => {
    // Same construction as the length-invariance fixture (section 3), with a
    // 150 BPM beat grid so the cap (100 ms) bites inside the UI range.
    const frames = [10, 30, 50, 70, 90];
    const boundarySamples = frames.map(sampleForFrame);
    const barBoundary = Int32Array.from(boundarySamples);
    const analyzedEndSample = boundarySamples[4] + 2000;
    const sourceLen = analyzedEndSample + 3000;
    const analysis = makeAnalysis({
      numBars: 4,
      barBoundary,
      analyzedEndSample,
      beatSamples: beatGrid(150),
    });

    const seg0: RemixSegment = { start: boundarySamples[0], end: boundarySamples[1] };
    const seg1: RemixSegment = { start: boundarySamples[2], end: boundarySamples[3] };
    const outputSample =
      boundarySamples[0] +
      (seg0.end - seg0.start) +
      (seg1.end - seg1.start) +
      (analyzedEndSample - seg1.end);
    const plan = makePlan({ segments: [seg0, seg1], joins: [join(1, 2)], outputSample });
    const source: Float32Array[] = [sine(220, sourceLen)];

    const capMs = effectiveCrossfadeMs(120, analysis.beatSamples, SR);
    expect(capMs).toBeCloseTo(100, 9); // fixture sanity -- the cap really bites
    expect(capMs).toBeLessThan(120);

    const atRequest = renderRemix(source, analysis, plan, { sampleRate: SR, crossfadeMs: 120 });
    const atCap = renderRemix(source, analysis, plan, { sampleRate: SR, crossfadeMs: capMs });
    const belowCap = renderRemix(source, analysis, plan, { sampleRate: SR, crossfadeMs: 60 });

    expect(Array.from(atRequest.channels[0])).toEqual(Array.from(atCap.channels[0]));
    // DISCRIMINATION: the equality above must come from the cap, not from
    // `crossfadeMs` being ignored altogether.
    expect(Array.from(belowCap.channels[0])).not.toEqual(Array.from(atCap.channels[0]));
  }, 15000);
});

// ---------------------------------------------------------------------------
// 4. bestAlignLag -- micro-alignment discrimination
// ---------------------------------------------------------------------------

describe('bestAlignLag', () => {
  const maxLag = 441; // +/-10ms @ 44.1kHz
  const W = 300;
  const ref = noise(W, 5);

  it('at 0ms offset, the lag is 0 +/- 2', () => {
    const inHead = new Float32Array(W + 2 * maxLag);
    inHead.set(ref, maxLag);
    const { lag } = bestAlignLag(ref, inHead, maxLag);
    expect(Math.abs(lag)).toBeLessThanOrEqual(2);
  });

  it('an incoming side offset by +7ms (309 samples) -> returned lag is -309 +/- 22', () => {
    const trueOffsetSamples = 309;
    const inHead = new Float32Array(W + 2 * maxLag);
    inHead.set(ref, maxLag - trueOffsetSamples);
    const { lag } = bestAlignLag(ref, inHead, maxLag);
    expect(Math.abs(lag - -trueOffsetSamples)).toBeLessThanOrEqual(22);
  });

  // Fix round 1, Important 1 regressions -- both previously produced a
  // manufactured +/-maxLag shift instead of "no reliable alignment".
  it('a silent reference (all-zero outTail) never manufactures a shift -- lag 0, rho 0', () => {
    const silentRef = new Float32Array(W); // all zero
    const inHead = new Float32Array(W + 2 * maxLag); // also all zero: nothing to align
    const { lag, rho } = bestAlignLag(silentRef, inHead, maxLag);
    expect(lag).toBe(0);
    expect(rho).toBe(0);
  });

  it('two genuinely independent (real-energy, low-confidence) windows return lag 0, not whichever noise-driven candidate scored highest', () => {
    // The brief's own "normal case for two different bars": independent
    // content, no real phase relationship. An 883-candidate search (+/-441)
    // over pure noise still finds SOME positive best-of-search correlation
    // by chance (empirically measured min/median/p99/max = 0.117/0.149/
    // 0.199/0.212 across 200 independent-seed trials at this exact
    // W=441/maxLag=441) -- these two fixed seeds reproduce that (best
    // measured 0.137), well under `MIN_ALIGN_RHO`, so the guard must still
    // suppress it rather than committing to the highest-scoring noise peak.
    const wideRef = noise(441, 8);
    const wideHead = noise(441 + 2 * maxLag, 50007);
    const { lag, rho } = bestAlignLag(wideRef, wideHead, maxLag);
    expect(lag).toBe(0);
    expect(rho).toBeLessThan(0.3); // matches production's MIN_ALIGN_RHO
  });

  it('fix round 2, Important 1: when the guard fires, rho is the correlation AT lag 0, not the rejected best candidate', () => {
    // Same fixture as above: the rejected best candidate scores ~0.137 (at
    // some lag != 0), but the TRUE correlation at lag=0 -- where the
    // crossfade actually runs once the guard fires -- is a completely
    // different value (~0.020). Before the fix, `rho` reported the
    // rejected 0.137; the gain law would then run at lag=0 as if the
    // correlation there were 0.137, when it is actually ~0.020.
    const wideRef = noise(441, 8);
    const wideHead = noise(441 + 2 * maxLag, 50007);
    const { lag, rho } = bestAlignLag(wideRef, wideHead, maxLag);
    expect(lag).toBe(0);
    const rhoAtReturnedLag = normalizedCorrelation(wideRef, wideHead.subarray(maxLag + lag, maxLag + lag + 441));
    expect(rho).toBeCloseTo(rhoAtReturnedLag, 9);
    // Fixture sanity: this is genuinely NOT the rejected best (~0.137) --
    // otherwise the assertion above would pass even with the old bug.
    expect(Math.abs(rho - 0.137)).toBeGreaterThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// 5. No clicks -- crossfade vs hard butt-splice discrimination
// ---------------------------------------------------------------------------

describe('renderRemix -- no clicks', () => {
  it('max slew after a crossfaded join stays within 1.2x the source max slew; a hard butt-splice of the same material exceeds it', () => {
    const freq = 5; // Hz -- slow enough to be smooth over a continuous read
    const sourceLen = 260000; // comfortably past every position used below
    const src: Float32Array[] = [sine(freq, sourceLen)];

    const period = SR / freq;
    // Peak (phase pi/2) and trough (phase 3pi/2) -- a genuinely large jump if
    // concatenated raw, forcing the crossfade to do real work.
    const aEnd = Math.round(period * 10 + period / 4);
    const bStart = Math.round(period * 20 + (3 * period) / 4);

    const barBoundary = Int32Array.from([0, aEnd, bStart, bStart + Math.round(period * 5)]);
    const analyzedEndSample = barBoundary[3] + 2000;
    const analysis = makeAnalysis({ numBars: 3, barBoundary, analyzedEndSample });

    const seg0: RemixSegment = { start: 0, end: aEnd };
    const seg1: RemixSegment = { start: bStart, end: barBoundary[3] };
    const outputSample = (seg0.end - seg0.start) + (seg1.end - seg1.start) + (analyzedEndSample - barBoundary[3]);
    const plan = makePlan({ segments: [seg0, seg1], joins: [join(1, 2)], outputSample });

    // A wide crossfade (120ms, the top of the user range) gives the gain law
    // room to spread the peak-to-trough swing over enough samples to stay
    // under the tight 1.2x-source-slew bound -- the fixture picks the most
    // extreme possible discontinuity on purpose, so the crossfade width must
    // be generous enough to smooth it, not merely present.
    const result = renderRemix(src, analysis, plan, { sampleRate: SR, crossfadeMs: 120 });

    function maxSlew(x: Float32Array): number {
      let m = 0;
      for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
      return m;
    }

    const sourceMaxSlew = maxSlew(src[0]);
    const outputMaxSlew = maxSlew(result.channels[0]);
    expect(outputMaxSlew).toBeLessThanOrEqual(1.2 * sourceMaxSlew);

    // DISCRIMINATION: a hard butt-splice of the same material must exceed the bound.
    const buttSpliced = new Float32Array(seg0.end - seg0.start + (seg1.end - seg1.start));
    buttSpliced.set(src[0].subarray(seg0.start, seg0.end), 0);
    buttSpliced.set(src[0].subarray(seg1.start, seg1.end), seg0.end - seg0.start);
    const buttMaxSlew = maxSlew(buttSpliced);
    expect(buttMaxSlew).toBeGreaterThan(1.2 * sourceMaxSlew);

    // Plus: no NaN/Inf, no clipping beyond [-1,1].
    for (const ch of result.channels) {
      for (let i = 0; i < ch.length; i++) {
        expect(Number.isFinite(ch[i])).toBe(true);
        expect(Math.abs(ch[i])).toBeLessThanOrEqual(1.0 + 1e-6);
      }
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// 6. Pre-roll never reads past the line
// ---------------------------------------------------------------------------

describe('renderRemix -- pre-roll never reads past the line', () => {
  it('every outgoing contribution to a pre-roll join reconstructs to a valid (< bar line) source index', () => {
    // Strong onset at boundary 2 (the destination) forces 'pre-roll' together
    // with the sign-opposed (low-rho) source content constructed below.
    const frames = [5, 200, 400, 600];
    const odf = new Float32Array(700);
    odf[frames[0]] = 0.1;
    odf[frames[1]] = 0.1;
    odf[frames[2]] = 5.0;
    odf[frames[3]] = 0.1;
    // barBoundary is derived from the SAME frame positions used for odf so
    // the onset lookup is meaningful (decimationFactor=1 by default).
    const barBoundary2 = Int32Array.from(frames.map(sampleForFrame));
    const segEnd2 = barBoundary2[1];
    const bStart2 = barBoundary2[2];
    // Positive, self-indexing (index+1) before the bar line; NEGATIVE,
    // self-indexing (-(index+1)) from the bar line onward -- a bug reading
    // past the line would surface as a sign flip / wrong magnitude in the
    // reconstruction below.
    const src2 = new Float32Array(barBoundary2[3] + 50000);
    for (let i = 0; i < src2.length; i++) src2[i] = i < segEnd2 ? i + 1 : -(i + 1);
    const analyzedEndSample2 = barBoundary2[3] + 20000;

    const analysis = makeAnalysis({ numBars: 3, barBoundary: barBoundary2, analyzedEndSample: analyzedEndSample2, odf });
    const seg0: RemixSegment = { start: 0, end: segEnd2 };
    const seg1: RemixSegment = { start: bStart2, end: barBoundary2[3] };
    const outputSample = (seg0.end - seg0.start) + (seg1.end - seg1.start) + (analyzedEndSample2 - barBoundary2[3]);
    const plan = makePlan({ segments: [seg0, seg1], joins: [join(1, 2)], outputSample });

    const crossfadeMs = 25;
    const result = renderRemix([src2], analysis, plan, { sampleRate: SR, crossfadeMs });
    expect(result.shapes[0]).toBe('pre-roll'); // fixture sanity

    const lag = result.nudgeSamples[0];
    const rho = result.rhos[0];
    const bStartAligned = seg1.start + lag;

    // Reconstruct the crossfade region: pre-roll overwrites the LAST X
    // samples of segment 0's own (fully-written) output.
    const xBase = Math.round((crossfadeMs / 1000) * SR);
    const laActual = seg0.end - seg0.start;
    const X = Math.max(0, Math.min(xBase, laActual, bStartAligned));
    expect(X).toBeGreaterThan(0); // fixture sanity -- exercise the real crossfade, not a butt-splice

    const fadeStartCursor = seg0.end - X; // output position === source position here (no head, no prior shift)
    for (let k = 0; k < X; k++) {
      const t = X > 1 ? k / (X - 1) : 0.5;
      const { gOut, gIn } = crossfadeGains(t, rho);
      const inIdx = bStartAligned - X + k;
      const inSample = inIdx >= 0 && inIdx < src2.length ? src2[inIdx] : 0;
      const actual = result.channels[0][fadeStartCursor + k];
      // Skip the numerically unstable tail of the fade where `gOut` is tiny
      // -- dividing by a near-zero gain amplifies ordinary floating-point
      // noise into a large apparent error despite the underlying value being
      // correct (verified separately by the "plain prefix" exact-copy check
      // below, which covers the region this reconstruction can't safely
      // probe).
      const impliedOut = gOut > 0.1 ? (actual - inSample * gIn) / gOut : null;
      const expectedOutIdx = segEnd2 - X + k; // must be < segEnd2, i.e. the bar line
      expect(expectedOutIdx).toBeLessThan(segEnd2);
      if (impliedOut !== null) {
        expect(impliedOut).toBeCloseTo(expectedOutIdx + 1, 1); // positive, matches a valid (<line) index
        expect(impliedOut).toBeGreaterThan(0);
      }
    }

    // Plus the plain (non-blended) prefix of segment 0's write is an exact,
    // untouched copy -- directly checkable.
    for (let k = 0; k < laActual - X; k++) {
      expect(result.channels[0][k]).toBe(k + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Stereo linkage
// ---------------------------------------------------------------------------

describe('renderRemix -- stereo linkage', () => {
  it('uses ONE lag and ONE gain curve for both channels, even when L and R would independently disagree', () => {
    const aEnd = 20000;
    const bStart = 40000;
    const barBoundary = Int32Array.from([0, aEnd, bStart, bStart + 10000]);
    const analyzedEndSample = barBoundary[3] + 1000;
    // Analysis reaches the true end of the source EXACTLY -- no tail fade --
    // so this test's reconstruction can focus purely on the join itself,
    // not an orthogonal tail-fade interaction.
    const sourceLen = analyzedEndSample;
    const l = sine(220, sourceLen);
    const r = sine(277, sourceLen);
    const analysis = makeAnalysis({ numBars: 3, barBoundary, analyzedEndSample });

    const seg0: RemixSegment = { start: 0, end: aEnd };
    const seg1: RemixSegment = { start: bStart, end: barBoundary[3] };
    const outputSample = (seg0.end - seg0.start) + (seg1.end - seg1.start) + (analyzedEndSample - barBoundary[3]);
    const plan = makePlan({ segments: [seg0, seg1], joins: [join(1, 2)], outputSample });

    const maxLag = 441;
    const compareLen = Math.round((10 / 1000) * SR);

    // Fixture sanity: L's own best lag differs from R's own best lag on the raw material.
    function ownLag(ch: Float32Array): number {
      const outTail = ch.subarray(aEnd - compareLen, aEnd);
      const inHead = ch.subarray(bStart - maxLag, bStart + maxLag + compareLen);
      return bestAlignLag(outTail, inHead, maxLag).lag;
    }
    const lLag = ownLag(l);
    const rLag = ownLag(r);
    expect(Math.abs(lLag - rLag)).toBeGreaterThanOrEqual(5);

    const result = renderRemix([l, r], analysis, plan, { sampleRate: SR, crossfadeMs: 25 });
    const lag = result.nudgeSamples[0];
    const rho = result.rhos[0];
    const shape = result.shapes[0];
    const bStartAligned = seg1.start + lag;

    const xBase = Math.round((25 / 1000) * SR);
    const laActual = seg0.end - seg0.start;
    const lb = seg1.end - seg1.start;

    function reconstructChannel(ch: Float32Array): Float32Array {
      if (shape === 'centred') {
        const half = 2 * Math.floor(Math.min(xBase / 2, laActual, lb, aEnd, sourceLen - aEnd, bStartAligned, sourceLen - bStartAligned)) / 2;
        const X = half * 2;
        const expected = new Float32Array(laActual + lb);
        expected.set(ch.subarray(0, aEnd - half), 0);
        let cursor = aEnd - half;
        for (let k = 0; k < X; k++) {
          const t = X > 1 ? k / (X - 1) : 0.5;
          const { gOut, gIn } = crossfadeGains(t, rho);
          expected[cursor + k] = ch[aEnd - half + k] * gOut + ch[bStartAligned - half + k] * gIn;
        }
        cursor += X;
        // The continuation resumes at the ALIGNED position, not the raw
        // nominal start -- see the module doc comment, "Micro-alignment:
        // the incoming shift persists through the segment".
        expected.set(ch.subarray(bStartAligned + half, bStartAligned + lb), cursor);
        return expected;
      }
      const X = Math.max(0, Math.min(xBase, laActual, bStartAligned));
      const expected = new Float32Array(laActual + lb);
      expected.set(ch.subarray(0, aEnd), 0);
      let cursor = aEnd - X;
      for (let k = 0; k < X; k++) {
        const t = X > 1 ? k / (X - 1) : 0.5;
        const { gOut, gIn } = crossfadeGains(t, rho);
        expected[cursor + k] = ch[aEnd - X + k] * gOut + ch[bStartAligned - X + k] * gIn;
      }
      cursor = aEnd;
      expected.set(ch.subarray(bStartAligned, bStartAligned + lb), cursor);
      return expected;
    }

    const expectedL = reconstructChannel(l);
    const expectedR = reconstructChannel(r);

    const headLen = 0;
    for (let i = 0; i < expectedL.length; i++) {
      expect(result.channels[0][headLen + i]).toBeCloseTo(expectedL[i], 4);
      expect(result.channels[1][headLen + i]).toBeCloseTo(expectedR[i], 4);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Shape selector
// ---------------------------------------------------------------------------

describe('renderRemix -- shape selector', () => {
  /**
   * Builds a source whose micro-alignment comparison windows have a
   * CONTROLLED correlation `rhoTarget` to the outgoing side: independent
   * background noise everywhere, except the outgoing window
   * `[b1-W, b1)` is a reference noise burst `refA`, and the (lag=0) incoming
   * window `[b2, b2+W)` is `r*refA + sqrt(1-r^2)*refB` -- so
   * `normalizedCorrelation` between those two SPECIFIC windows is `r` by
   * construction, and the correlation search (over independent background
   * noise elsewhere) has nothing else nearby to prefer instead.
   */
  function buildFixture(rhoTarget: number, strongOnsetAtDestination: boolean) {
    const frames = [5, 300, 600, 900];
    const odf = new Float32Array(1000);
    odf[frames[0]] = 0.1;
    odf[frames[1]] = 0.1;
    odf[frames[2]] = strongOnsetAtDestination ? 8.0 : 0.05;
    odf[frames[3]] = 0.1;
    const barBoundary = Int32Array.from(frames.map(sampleForFrame));
    const b1 = barBoundary[1];
    const b2 = barBoundary[2];
    const analyzedEndSample = barBoundary[3] + 2000;
    const sourceLen = analyzedEndSample + 2000;

    const W = Math.round((10 / 1000) * SR); // matches ALIGN_COMPARE_MS
    const refA = noise(W, 21);
    const refB = noise(W, 55);
    const correlated = makeCorrelated(refA, refB, rhoTarget);

    const src = noise(sourceLen, 3); // independent background everywhere
    src.set(refA, b1 - W);
    src.set(correlated, b2);

    const analysis = makeAnalysis({ numBars: 3, barBoundary, analyzedEndSample, odf });
    const seg0: RemixSegment = { start: 0, end: b1 };
    const seg1: RemixSegment = { start: b2, end: barBoundary[3] };
    const outputSample = (seg0.end - seg0.start) + (seg1.end - seg1.start) + (analyzedEndSample - barBoundary[3]);
    const plan = makePlan({ segments: [seg0, seg1], joins: [join(1, 2)], outputSample });

    return { src: [src], analysis, plan };
  }

  it('percussive destination (strong onset, rho ~0.1) -> pre-roll', () => {
    const { src, analysis, plan } = buildFixture(0.1, true);
    const result = renderRemix(src, analysis, plan, { sampleRate: SR, crossfadeMs: 25 });
    expect(result.rhos[0]).toBeLessThan(0.35);
    expect(result.shapes[0]).toBe('pre-roll');
  });

  it('sustained pad destination (weak onset, rho ~0.6) -> centred', () => {
    const { src, analysis, plan } = buildFixture(0.6, false);
    const result = renderRemix(src, analysis, plan, { sampleRate: SR, crossfadeMs: 25 });
    expect(result.rhos[0]).toBeGreaterThanOrEqual(0.35);
    expect(result.shapes[0]).toBe('centred');
  });

  // The selector is `rho >= 0.35 || onsetTo < onsetMedian`, and the two cells
  // above are the two where BOTH clauses agree — so `rho` alone decided them
  // and deleting the onset clause outright left the whole suite green (L3-6...
  // L3-3). These two are the disagreeing corners: one per clause, each with
  // the other clause voting 'pre-roll'.

  it("sustained pad destination at LOW rho -> centred on the ONSET clause alone (rho ~0.1 says 'pre-roll')", () => {
    const { src, analysis, plan } = buildFixture(0.1, false);
    const result = renderRemix(src, analysis, plan, { sampleRate: SR, crossfadeMs: 25 });
    // The rho clause is FALSE here, so 'centred' can only have come from
    // `onsetTo < onsetMedian`: the destination boundary's onset peak is 0.05
    // against the other three boundaries' 0.1, i.e. a median of 0.1.
    expect(result.rhos[0]).toBeLessThan(0.35);
    expect(result.shapes[0]).toBe('centred');
  });

  it("percussive destination at HIGH rho -> centred on the RHO clause alone (the strong onset says 'pre-roll')", () => {
    const { src, analysis, plan } = buildFixture(0.6, true);
    const result = renderRemix(src, analysis, plan, { sampleRate: SR, crossfadeMs: 25 });
    // Mirror image: `onsetTo` is 8.0 against a median of 0.1, so the onset
    // clause is FALSE and only `rho >= 0.35` can be carrying this.
    expect(result.rhos[0]).toBeGreaterThanOrEqual(0.35);
    expect(result.shapes[0]).toBe('centred');
  });
});

// ---------------------------------------------------------------------------
// 9. Tail
// ---------------------------------------------------------------------------

describe('renderRemix -- tail', () => {
  function trivialFixture(sourceLen: number, analyzedEndSample: number) {
    const barBoundary = Int32Array.from([1000, 21000]);
    const src = [sine(110, sourceLen, SR, 0.8)];
    const analysis = makeAnalysis({ numBars: 1, barBoundary, analyzedEndSample });
    const seg0: RemixSegment = { start: barBoundary[0], end: barBoundary[1] };
    const outputSample = barBoundary[0] + (seg0.end - seg0.start) + (analyzedEndSample - barBoundary[1]);
    const plan = makePlan({ segments: [seg0], joins: [], outputSample });
    return { src, analysis, plan };
  }

  it('final bar != source final bar (more real audio exists beyond analyzedEndSample) -> 1500ms fade to near-silence', () => {
    const sourceLen = 40000;
    const analyzedEndSample = 25000; // < sourceLen: truncated, NOT the real ending
    const { src, analysis, plan } = trivialFixture(sourceLen, analyzedEndSample);
    const result = renderRemix(src, analysis, plan, { sampleRate: SR });
    const ch = result.channels[0];
    const fadeLen = Math.min(Math.round(1.5 * SR), ch.length);
    const start = ch.length - fadeLen;
    // Check the MULTIPLICATIVE envelope directly -- ch[i]/src[i] -- rather
    // than a windowed peak of ch alone, which would be confounded by the
    // sine's own oscillation (a later window can look "louder" than an
    // earlier one purely from phase, even under a genuinely monotonic
    // envelope). Skip source samples too close to a zero crossing, where the
    // ratio is numerically unstable.
    let prevRatio = Infinity;
    let checked = 0;
    for (let i = start; i < ch.length; i++) {
      const s = src[0][i];
      if (Math.abs(s) < 0.05) continue;
      const ratio = ch[i] / s;
      expect(ratio).toBeLessThanOrEqual(prevRatio + 1e-6);
      prevRatio = ratio;
      checked++;
    }
    expect(checked).toBeGreaterThan(100); // fixture sanity -- actually exercised the check
    expect(Math.abs(ch[ch.length - 1])).toBeLessThan(1e-3);
  });

  it('final bar === source final bar (analysis reaches the true end) -> no fade, last sample matches source', () => {
    const sourceLen = 22000; // exactly analyzedEndSample below
    const analyzedEndSample = 22000;
    const { src, analysis, plan } = trivialFixture(sourceLen, analyzedEndSample);
    const result = renderRemix(src, analysis, plan, { sampleRate: SR });
    const ch = result.channels[0];
    expect(ch[ch.length - 1]).toBeCloseTo(src[0][sourceLen - 1], 6);
  });
});

// ---------------------------------------------------------------------------
// 10. Mono passthrough + purity
// ---------------------------------------------------------------------------

describe('renderRemix -- mono + purity', () => {
  it('mono source -> mono output (one channel), source channels never mutated', () => {
    const sourceLen = 60000;
    const src = [sine(330, sourceLen)];
    const snapshot = src[0].slice();

    const aEnd = 20000;
    const bStart = 40000;
    const barBoundary = Int32Array.from([0, aEnd, bStart, bStart + 10000]);
    const analyzedEndSample = barBoundary[3] + 1000;
    const analysis = makeAnalysis({ numBars: 3, barBoundary, analyzedEndSample });
    const seg0: RemixSegment = { start: 0, end: aEnd };
    const seg1: RemixSegment = { start: bStart, end: barBoundary[3] };
    const outputSample = (seg0.end - seg0.start) + (seg1.end - seg1.start) + (analyzedEndSample - barBoundary[3]);
    const plan = makePlan({ segments: [seg0, seg1], joins: [join(1, 2)], outputSample });

    const result = renderRemix(src, analysis, plan, { sampleRate: SR, crossfadeMs: 25 });

    expect(result.channels.length).toBe(1);
    expect(result.channels[0].length).toBe(plan.outputSample);
    expect(src[0]).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Exact-length trim (spec-driven, not one of the 10 numbered acceptance
// items, but explicitly described in the brief's TAIL section)
// ---------------------------------------------------------------------------

describe('renderRemix -- exact-length trim (opts.exactLength)', () => {
  it('trims the untrimmed overshoot to plan.targetSample exactly, with a 5ms linear fade', () => {
    const sourceLen = 40000;
    const analyzedEndSample = 22000;
    const barBoundary = Int32Array.from([1000, 21000]);
    const src = [sine(110, sourceLen, SR, 0.8)];
    const analysis = makeAnalysis({ numBars: 1, barBoundary, analyzedEndSample });
    const seg0: RemixSegment = { start: barBoundary[0], end: barBoundary[1] };
    const outputSample = barBoundary[0] + (seg0.end - seg0.start) + (analyzedEndSample - barBoundary[1]);
    const targetSample = outputSample - 500; // the planner's own overshoot
    const plan = makePlan({ segments: [seg0], joins: [], outputSample, targetSample });

    const result = renderRemix(src, analysis, plan, { sampleRate: SR, exactLength: true });
    expect(result.channels[0].length).toBe(targetSample);
    const fadeLen = Math.min(Math.round(0.005 * SR), result.channels[0].length);
    expect(Math.abs(result.channels[0][result.channels[0].length - 1])).toBeLessThan(1e-3);
    expect(fadeLen).toBeGreaterThan(0);
  });

  it('the 5ms linear fade REPLACES the 1500ms quarter-cosine tail fade, not stacks on top of it (fix round 1, Important 3)', () => {
    // Fixture LONGER than 1.5s with TRUNCATED analysis (analyzedEndSample <
    // source.length) -- both conditions the buggy version needed to double-
    // fade: without them (the original test's buffer was shorter than
    // 1.5s), the whole output falls inside the quarter-cosine window either
    // way and the bug is unobservable.
    const sourceLen = 200000; // ~4.5s @ 44.1kHz, comfortably > 1.5s
    const analyzedEndSample = 150000; // < sourceLen: truncated, NOT the real ending
    const barBoundary = Int32Array.from([1000, 140000]);
    const src = [sine(110, sourceLen, SR, 0.8)];
    const analysis = makeAnalysis({ numBars: 1, barBoundary, analyzedEndSample });
    const seg0: RemixSegment = { start: barBoundary[0], end: barBoundary[1] };
    const outputSample = barBoundary[0] + (seg0.end - seg0.start) + (analyzedEndSample - barBoundary[1]);
    const targetSample = outputSample - 500; // the planner's own overshoot
    const plan = makePlan({ segments: [seg0], joins: [], outputSample, targetSample });

    const result = renderRemix(src, analysis, plan, { sampleRate: SR, exactLength: true });
    expect(result.channels[0].length).toBe(targetSample);

    // No join/shift in this fixture, so output[i] === source[i] except
    // inside the 5ms fade window -- measure the amplitude RATIO (dB) at 1s,
    // 0.5s and 0.1s from the end. If only the 5ms fade applies, all three
    // are ~0 dB (far outside a 220-sample window); the pre-fix behaviour
    // measured -0.88 / -4.91 / -9.47 dB at these same points (a ~1.5s fade
    // where 5ms was specified).
    function dbAt(distanceFromEndSamples: number): number {
      const idx = result.channels[0].length - distanceFromEndSamples;
      const actual = Math.abs(result.channels[0][idx]);
      const raw = Math.abs(src[0][idx]);
      return 20 * Math.log10(actual / raw);
    }
    const db1s = dbAt(Math.round(1 * SR));
    const db500ms = dbAt(Math.round(0.5 * SR));
    const db100ms = dbAt(Math.round(0.1 * SR));
    expect(Math.abs(db1s)).toBeLessThan(0.01);
    expect(Math.abs(db500ms)).toBeLessThan(0.01);
    expect(Math.abs(db100ms)).toBeLessThan(0.01);

    // And the trim's own 5ms fade is still genuinely present at the very end.
    expect(Math.abs(result.channels[0][result.channels[0].length - 1])).toBeLessThan(1e-3);
  });
});

// ---------------------------------------------------------------------------
// Fix round 1, Important 2 -- the last join's lag clamp must also protect
// the tail read that follows it, not just the segment itself.
// ---------------------------------------------------------------------------

describe('renderRemix -- tail after the last join never reads past the true end of source', () => {
  it('a positive last-join lag never overflows the tail into unattenuated silence, forward alignment is NOT disabled to achieve that, and the segment/tail read position is NEVER shifted (fix round 3)', () => {
    const compareLen = 441; // matches ALIGN_COMPARE_MS
    const aEnd = 50000;
    const bStartNominal = 60000;
    const lb = 8000;
    const naturalLag = 400; // the raw (unclamped) alignment search's own preference

    // sourceLen === analyzedEndSample (reachesFileEnd -- no masking quarter-
    // cosine fade) AND leaves EXACTLY zero slack for a positive last-join
    // lag: nextSeg.end + tailLenNominal === sourceLen -- so a lag of +400
    // means reading `tailLen` samples from `finalEffEnd` runs exactly 400
    // samples past `sourceLen`. Fix round 1 clamped the LAG itself to fit
    // the tail (silently disabling forward alignment on every non-truncated
    // track, fix round 2); fix round 2 clamped the TAIL'S READ POSITION
    // instead (which turned out to jump the read backward by `lag` samples
    // at the segment/tail seam -- a genuine phase discontinuity, fix round
    // 3). Round 3 never shifts the read position at all: it reads from
    // `finalEffEnd` (bounded, always <= sourceLen by the join's own lag
    // clamp), and fades OUT only the portion that runs past `sourceLen`.
    const tailLenNominal = 2100;
    const sourceLen = bStartNominal + lb + tailLenNominal;
    const analyzedEndSample = sourceLen;

    const src = noise(sourceLen, 200);
    const ref = noise(compareLen, 900);
    src.set(ref, aEnd - compareLen); // outgoing reference window
    src.set(ref, bStartNominal + naturalLag); // incoming's TRUE best match, +400 from nominal

    const barBoundary = Int32Array.from([0, aEnd, bStartNominal, bStartNominal + lb]);
    const analysis = makeAnalysis({ numBars: 3, barBoundary, analyzedEndSample });
    const seg0: RemixSegment = { start: 0, end: aEnd };
    const seg1: RemixSegment = { start: bStartNominal, end: bStartNominal + lb };
    const outputSample = (seg0.end - seg0.start) + (seg1.end - seg1.start) + (analyzedEndSample - seg1.end);
    const plan = makePlan({ segments: [seg0, seg1], joins: [join(1, 2)], outputSample });

    const result = renderRemix([src], analysis, plan, { sampleRate: SR, crossfadeMs: 25, maxNudgeMs: 10 });

    // Forward alignment is genuinely honoured -- the join's OWN lag is not
    // clamped away just because the tail follows it.
    expect(Math.abs(result.nudgeSamples[0] - naturalLag)).toBeLessThanOrEqual(2);
    const lag = result.nudgeSamples[0];
    const finalEffEnd = bStartNominal + lag + lb;
    const tailOverflow = Math.max(0, finalEffEnd + tailLenNominal - sourceLen);
    expect(tailOverflow).toBeGreaterThan(0); // fixture sanity -- genuinely exercises the overflow path

    const ch = result.channels[0];
    const seamPos = (seg0.end - seg0.start) + (seg1.end - seg1.start); // no head

    // The seam itself reads CONTINUOUSLY from `finalEffEnd` -- no backward
    // jump. The first real (non-faded) tail sample must equal source read
    // at exactly that position, not at some shifted-back position.
    expect(ch[seamPos]).toBeCloseTo(src[finalEffEnd], 6);
    expect(ch[seamPos - 1]).toBeCloseTo(src[finalEffEnd - 1], 6);

    // No unattenuated silence: the tail overflow (the portion that would
    // have read past `sourceLen`) is faded OUT smoothly, not hard-zeroed --
    // the very last sample is (near) silent, but the samples leading into
    // it form a taper, not a step.
    expect(Math.abs(ch[ch.length - 1])).toBeLessThan(1e-6);

    // No NaN/Inf anywhere in the tail region.
    for (let i = ch.length - tailLenNominal; i < ch.length; i++) {
      expect(Number.isFinite(ch[i])).toBe(true);
    }

    // The underlying tail content is NOISE (independent samples), so a
    // slew bound can't distinguish "smooth taper" from "normal noise
    // variation" -- instead reconstruct the EXPECTED linear-taper values
    // directly from the known fade formula and compare byte-for-byte. This
    // is the precise proof that the overflow is faded, not hard-zeroed.
    const validLen = tailLenNominal - tailOverflow;
    // The taper is at least MIN_TAIL_FADE_MS long and is NOT bounded by
    // `validLen` (fix round 4) -- it may reach back past `seamPos` into the
    // previous segment's own written audio. That region is contiguous
    // source audio with the tail (both read from `finalEffEnd` outward), so
    // the same `src`-relative formula reconstructs it for negative offsets
    // exactly as it does for positive ones.
    const fadeLen = Math.max(tailOverflow, Math.round((2 / 1000) * SR));
    const fadeStartOutput = seamPos + validLen - fadeLen;
    for (let k = 0; k < fadeLen; k++) {
      const g = fadeLen > 1 ? 1 - k / (fadeLen - 1) : 0;
      const unfaded = src[finalEffEnd + (validLen - fadeLen + k)];
      expect(ch[fadeStartOutput + k]).toBeCloseTo(unfaded * g, 6);
    }
  });

  // Round 3 tapered over exactly `tailOverflow` samples and bounded that by
  // `validLen`. Both bounds had a corner the round-3 fixtures did not reach:
  // a tiny lag made the fade a 1-2 sample cliff, and `tailLen <= lag` left
  // `validLen === 0` so no fade was applied at all and the original
  // unattenuated step into silence came back. Both are the SAME defect the
  // whole tail-fade exists to prevent, so both are asserted here.
  it('tapers smoothly even at a 1-sample overflow and when the tail is shorter than the lag', () => {
    const freq = 197;
    const lb = 20000;

    function maxSlew(x: Float32Array, start = 0, end = x.length): { value: number } {
      let m = 0;
      for (let i = Math.max(1, start); i < end; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
      return { value: m };
    }

    function run(targetLag: number, tailLenNominal: number) {
      const compareLen = Math.round((10 / 1000) * SR);
      const aEnd = 60000;
      const bStartNominal = 90000;
      // `sourceLen` set so the tail overflows by exactly `targetLag`.
      const sourceLen = bStartNominal + targetLag + lb + tailLenNominal - targetLag;
      const src = sine(freq, sourceLen, SR, 1);
      src.set(src.slice(aEnd - compareLen, aEnd), bStartNominal + targetLag);

      const analyzedEndSample = bStartNominal + lb + tailLenNominal;
      const barBoundary = Int32Array.from([0, aEnd, bStartNominal, bStartNominal + lb]);
      const analysis = makeAnalysis({ numBars: 3, barBoundary, analyzedEndSample });
      const seg0: RemixSegment = { start: 0, end: aEnd };
      const seg1: RemixSegment = { start: bStartNominal, end: bStartNominal + lb };
      const outputSample = (seg0.end - seg0.start) + (seg1.end - seg1.start) + (analyzedEndSample - seg1.end);
      const plan = makePlan({ segments: [seg0, seg1], joins: [join(1, 2)], outputSample });
      const result = renderRemix([src], analysis, plan, { sampleRate: SR, crossfadeMs: 25, maxNudgeMs: 10 });
      expect(result.nudgeSamples[0]).toBe(targetLag); // fixture sanity
      return { ch: result.channels[0], naturalSlew: maxSlew(sine(freq, 20000, SR, 1)).value };
    }

    // Corner 1: a 1-sample overflow. Round 3 gave a 1-sample fade (a cliff);
    // the 2 ms floor makes it a real taper.
    {
      const { ch, naturalSlew } = run(1, 8000);
      const region = maxSlew(ch, ch.length - 2000, ch.length);
      expect(region.value).toBeLessThanOrEqual(1.2 * naturalSlew);
      expect(Math.abs(ch[ch.length - 1])).toBeLessThan(1e-6);
    }

    // Corner 2: tail SHORTER than the lag -- `validLen === 0`, so round 3
    // applied no fade whatsoever and the step into silence was unattenuated.
    // The taper must now reach back into the segment's own audio.
    {
      const { ch, naturalSlew } = run(200, 200);
      const region = maxSlew(ch, ch.length - 2000, ch.length);
      expect(region.value).toBeLessThanOrEqual(1.2 * naturalSlew);
      const lastNonZero = ch.length - 1 - [...ch].reverse().findIndex((v) => Math.abs(v) > 1e-9);
      expect(Math.abs(ch[lastNonZero])).toBeLessThanOrEqual(0.2 * naturalSlew);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix round 1, Important 3 -- the exact-length invariant is now CHECKED.
// ---------------------------------------------------------------------------

describe('renderRemix -- the length identity is asserted, not merely assumed', () => {
  function trivialMismatchFixture() {
    const barBoundary = Int32Array.from([1000, 21000]);
    const analyzedEndSample = 22000;
    const src = [sine(110, 40000, SR, 0.8)];
    const analysis = makeAnalysis({ numBars: 1, barBoundary, analyzedEndSample });
    const seg0: RemixSegment = { start: barBoundary[0], end: barBoundary[1] };
    const trueOutputSample = barBoundary[0] + (seg0.end - seg0.start) + (analyzedEndSample - barBoundary[1]);
    return { src, analysis, seg0, trueOutputSample };
  }

  it('throws a clear error (not a bare RangeError) when plan.outputSample is a SURPLUS over the true identity (fix round 1, Important 3 -- entry-side check added round 2)', () => {
    const { src, analysis, seg0, trueOutputSample } = trivialMismatchFixture();
    const plan = makePlan({ segments: [seg0], joins: [], outputSample: trueOutputSample + 1000 });
    expect(() => renderRemix(src, analysis, plan, { sampleRate: SR })).toThrow(/outputSample/);
  });

  it('throws a clear error (not a bare RangeError) when plan.outputSample is a SHORTFALL under the true identity (fix round 2, Minor)', () => {
    // Before the entry-side check, a shortfall allocated a too-small
    // `channels` buffer and the first overflowing write failed with a bare
    // native `RangeError: offset is out of bounds` instead of identifying
    // the actual mismatch -- the surplus direction already had an
    // informative message (the post-hoc cursor check), the shortfall
    // direction didn't.
    const { src, analysis, seg0, trueOutputSample } = trivialMismatchFixture();
    const plan = makePlan({ segments: [seg0], joins: [], outputSample: trueOutputSample - 1000 });
    expect(() => renderRemix(src, analysis, plan, { sampleRate: SR })).toThrow(/outputSample/);
  });
});

// ---------------------------------------------------------------------------
// Fix round 3 -- the round-2 tail-read clamp shifted the read position
// backward by the last join's own lag on any NON-truncated source, a phase
// discontinuity at the segment->tail seam. Acceptance-5's own fixture uses a
// truncated `analyzedEndSample`, so it never exercised this path at all.
// ---------------------------------------------------------------------------

describe('renderRemix -- no clicks -- segment/tail seam on a non-truncated tonal source (fix round 3)', () => {
  const freq = 197; // avoids period dividing evenly into +/-441 (200Hz does: 441 = 2*220.5)
  const compareLen = 441;
  const aEnd = 60000;
  const bStartNominal = 90000;
  const lb = 20000;
  const tailLenNominal = 6000;

  function maxSlew(x: Float32Array, start = 0, end = x.length): { value: number; at: number } {
    let m = 0;
    let at = -1;
    for (let i = Math.max(1, start); i < end; i++) {
      const d = Math.abs(x[i] - x[i - 1]);
      if (d > m) { m = d; at = i; }
    }
    return { value: m, at };
  }

  for (const targetLag of [0, 150, 300, 440]) {
    it(`lag=${targetLag}: the segment/tail seam and the whole tail stay within 1.2x the source's own natural slew`, () => {
      const sourceLen = bStartNominal + lb + tailLenNominal;
      const analyzedEndSample = sourceLen; // NON-truncated -- reachesFileEnd, no masking quarter-cosine fade
      const src = sine(freq, sourceLen, SR, 1);
      // Plant the target lag deterministically: paste the exact outgoing
      // reference window at the position the search must land on to
      // report `targetLag` -- a pure periodic tone otherwise has several
      // equally-good matches nearby (every +/-period), so a plain
      // correlation search cannot be relied on to land on a SPECIFIC lag.
      const ref = src.slice(aEnd - compareLen, aEnd);
      src.set(ref, bStartNominal + targetLag);

      const barBoundary = Int32Array.from([0, aEnd, bStartNominal, bStartNominal + lb]);
      const analysis = makeAnalysis({ numBars: 3, barBoundary, analyzedEndSample });
      const seg0: RemixSegment = { start: 0, end: aEnd };
      const seg1: RemixSegment = { start: bStartNominal, end: bStartNominal + lb };
      const outputSample = (seg0.end - seg0.start) + (seg1.end - seg1.start) + (analyzedEndSample - seg1.end);
      const plan = makePlan({ segments: [seg0, seg1], joins: [join(1, 2)], outputSample });
      const result = renderRemix([src], analysis, plan, { sampleRate: SR, crossfadeMs: 25, maxNudgeMs: 10 });

      // Fixture sanity: the search actually landed on the planted lag.
      expect(result.nudgeSamples[0]).toBe(targetLag);

      // Fixture sanity: the paste artifact (an unavoidable side-effect of
      // planting an exact lag on periodic material -- see the comment
      // above) sits within segment 1's OWN early read range, i.e. well
      // BEFORE the segment/tail seam this test targets. Assert that
      // directly rather than merely assuming it -- the paste starts at
      // SOURCE position `bStartNominal+targetLag`, which segment 1 starts
      // reading from (fix round 1's "the incoming shift persists through
      // the segment" design), i.e. within roughly the first `compareLen`
      // OUTPUT samples after the join's own crossfade -- nowhere near
      // `seamPos` (only reached after the whole of segment 1, `lb` =
      // 20000 samples, has played).
      const pasteAffectedOutputUpperBound = (seg0.end - seg0.start) + compareLen + 200; // generous margin
      const seamPos = (seg0.end - seg0.start) + (seg1.end - seg1.start); // no head -- cursor at the tail's own start
      expect(pasteAffectedOutputUpperBound).toBeLessThan(seamPos - 500);

      const naturalSlew = maxSlew(sine(freq, 20000, SR, 1)).value; // clean reference, no pasted region
      const seamStep = Math.abs(result.channels[0][seamPos] - result.channels[0][seamPos - 1]);
      expect(seamStep).toBeLessThanOrEqual(1.2 * naturalSlew);

      // The relevant region (segment/tail seam through the end of the
      // output) must ALSO stay within bound -- not just the single seam
      // sample, in case the overflow fade itself introduced a step.
      // Restricted to [seamPos-500, end), which the assertion above just
      // proved is disjoint from the paste-affected range, so nothing here
      // can be the fixture's own paste artifact rather than a real
      // renderRemix regression.
      const region = maxSlew(result.channels[0], seamPos - 500, result.channels[0].length);
      expect(region.value).toBeLessThanOrEqual(1.2 * naturalSlew);
      // Cross-check that this measurement is genuinely reading the tail
      // region (confirmed empirically: the peak always lands a few hundred
      // samples INTO the tail, i.e. inside [seamPos, end), never in the
      // [seamPos-500, seamPos) margin) -- not an artefact of the window
      // happening to land somewhere irrelevant.
      expect(region.at).toBeGreaterThanOrEqual(seamPos);
    }, 15000);
  }
});
