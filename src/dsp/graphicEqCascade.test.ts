import {
  GRAPHIC_EQ_CASCADE_Q,
  GRAPHIC_EQ_MAX_ABS_DB,
  GRAPHIC_EQ_SKIP_DB,
  SOLVE_TOLERANCE_DB,
  realisedBandEnergyDb,
  realisedCascadeDb,
  solveCascadeGains,
} from './graphicEqCascade';
import { GRAPHIC_EQ_BANDS, graphicEqEffect } from '../effects/eq/GraphicEqEffect';
import { designBiquad, magnitudeAt, type BiquadCoeffs } from './biquad';
import {
  LTAS_FFT_SIZE,
  MATCH_BAND_CENTRES_HZ,
  bandLevelDb,
  longTermAverageSpectrum,
  type Ltas,
} from './coverMatch';

const SR = 48000;
const CENTRES = GRAPHIC_EQ_BANDS.map((b) => b.freq);

function tone(n: number, freqHz: number, sampleRate: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
}

function rms(x: Float32Array, from: number): number {
  let sum = 0;
  for (let i = from; i < x.length; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / (x.length - from));
}

/** The response the EFFECT actually delivers at `freqHz`, measured by running a
 * steady tone through it. The first half is discarded so only the settled
 * response is measured. */
function measuredEffectDb(gainsDb: number[], freqHz: number, sampleRate = SR): number {
  const n = sampleRate; // 1 s — hundreds of cycles even at the lowest centre
  const input = tone(n, freqHz, sampleRate);
  const params: Record<string, number> = {};
  GRAPHIC_EQ_BANDS.forEach((b, i) => {
    params[b.id] = gainsDb[i] ?? 0;
  });
  const out = graphicEqEffect.process([Float32Array.from(input)], sampleRate, params)
    .channels[0];
  return 20 * Math.log10(rms(out, n >> 1) / rms(input, n >> 1));
}

function gainsAt(map: Record<number, number>): number[] {
  return CENTRES.map((f) => map[f] ?? 0);
}

function paramsFrom(gainsDb: readonly number[]): Record<string, number> {
  const params: Record<string, number> = {};
  GRAPHIC_EQ_BANDS.forEach((b, i) => {
    params[b.id] = gainsDb[i] ?? 0;
  });
  return params;
}

/**
 * Deterministic white noise. Its spectrum is flat, which makes it the WEAKEST
 * fixture available for anything about band energy: the signal-weighted mean of
 * |H|^2 and the plain mean of |H|^2 coincide on a flat spectrum, so a
 * white-noise test cannot tell the two apart. Every end-to-end band-energy test
 * in this file used to drive white noise for exactly that reason, and the suite
 * was green through a 0.94 dB misreport because of it. White noise is kept only
 * where flatness is the point; `formantNoise` is the fixture that observes the
 * weighting.
 */
function whiteNoise(n: number, seed = 0x9e3779b9): Float32Array {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 0xffffffff) * 2 - 1) * 0.25;
  }
  return out;
}

function filterWith(coeffs: BiquadCoeffs, x: Float32Array): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = coeffs.b0 * x[i] + coeffs.b1 * x1 + coeffs.b2 * x2 - coeffs.a1 * y1 - coeffs.a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/**
 * A deliberately NON-FLAT stationary fixture: two strong Q = 8 resonances at
 * 700 Hz and 2.6 kHz over a falling tail, which is the coarse shape of a sung
 * vowel and the shape white noise does not have.
 *
 * It exists because the quantity this module reports is the change in the
 * SIGNAL's octave energy, and how much energy a filter removes from an octave
 * depends on where inside that octave the signal's energy sits. On this fixture
 * the plain unweighted mean of |H|^2 misses what the effect delivers by up to
 * 1.37 dB while the weighted mean tracks it to 0.09 dB — so a test driven by it
 * can observe the approximation that a white-noise test structurally cannot.
 *
 * Stationary on purpose: the LTAS gate must select the same frames before and
 * after the cascade runs, or the comparison carries the gate's frame
 * reselection as well as the filter's effect.
 */
function formantNoise(n: number, seed = 0x9e3779b9): Float32Array {
  let x = whiteNoise(n, seed);
  x = filterWith(designBiquad('peaking', SR, 700, 8, 18), x);
  x = filterWith(designBiquad('peaking', SR, 2600, 8, 18), x);
  x = filterWith(designBiquad('lowpass', SR, 1200, 0.707, 0), x);
  return x;
}

let flatSpectrumCache: Ltas | null = null;
const flatSpectrum = (): Ltas =>
  (flatSpectrumCache ??= longTermAverageSpectrum([whiteNoise(SR * 2)], SR));
let formantSpectrumCache: Ltas | null = null;
const formantSpectrum = (): Ltas =>
  (formantSpectrumCache ??= longTermAverageSpectrum([formantNoise(SR * 2)], SR));

/** The band average this module used to take: the plain mean of |H|^2 over the
 * octave's bins, with no reference to the signal at all. Reproduced here so the
 * tests can show what it costs rather than describe it. */
function unweightedBandEnergyDb(gainsDb: readonly number[], sampleRate: number): number[] {
  const coeffs = CENTRES.map((freq, i) => ({ freq, gainDb: gainsDb[i] ?? 0 }))
    .filter((b) => Math.abs(b.gainDb) > GRAPHIC_EQ_SKIP_DB && b.freq < sampleRate / 2)
    .map((b) => designBiquad('peaking', sampleRate, b.freq, GRAPHIC_EQ_CASCADE_Q, b.gainDb));
  return CENTRES.map((centre) => {
    let sum = 0;
    let count = 0;
    for (let k = 1; k < LTAS_FFT_SIZE / 2 + 1; k++) {
      const f = (k * sampleRate) / LTAS_FFT_SIZE;
      if (f < centre / Math.SQRT2 || f >= centre * Math.SQRT2) continue;
      let magnitude = 1;
      for (const c of coeffs) magnitude *= magnitudeAt(c, f, sampleRate);
      sum += magnitude * magnitude;
      count++;
    }
    return count === 0 ? 0 : 10 * Math.log10(Math.max(sum / count, 1e-30));
  });
}

/** What the effect ACTUALLY does to each octave's energy in `input`, measured
 * with the same two functions the match curve is built from. */
function deliveredBandEnergyDb(
  input: Float32Array,
  gainsDb: readonly number[],
  sampleRate = SR
): { before: Ltas; delivered: (centreHz: number) => number } {
  const before = longTermAverageSpectrum([input], sampleRate);
  const output = graphicEqEffect.process(
    [Float32Array.from(input)],
    sampleRate,
    paramsFrom(gainsDb)
  ).channels;
  const after = longTermAverageSpectrum(output, sampleRate);
  // The gate must have kept the same frames, or the difference below is partly
  // the gate's and not the cascade's.
  expect(after.frames).toBe(before.frames);
  return {
    before,
    delivered: (centreHz: number): number => {
      const lo = centreHz / Math.SQRT2;
      const hi = centreHz * Math.SQRT2;
      return bandLevelDb(after, lo, hi)! - bandLevelDb(before, lo, hi)!;
    },
  };
}

describe('graphicEqCascade — the realised response is the effect\'s own (Ruling B)', () => {
  it('re-declares the effect\'s Q rather than a different one, pinned two-sided', () => {
    // `src/dsp` may not import from `src/effects`, so the constant is duplicated.
    // This is the pin that stops the copy drifting, and it has to probe OFF the
    // centres: a peaking biquad's response AT its centre is exactly its gain
    // whatever Q is, so a centre-only comparison cannot observe Q at all.
    //
    // 707.1 Hz is a half-octave above 500 Hz — the steepest part of the skirt,
    // where Q moves the response most.
    const PROBE_HZ = 500 * Math.SQRT2;
    const measured = measuredEffectDb(gainsAt({ 500: 6 }), PROBE_HZ);
    // Evaluated through the module's own predictor: a second entry at the probe
    // frequency carrying no gain of its own is skipped as a filter (0.01 rule)
    // but is still a point the response is reported at.
    const predicted = realisedCascadeDb([6, 0], [500, PROBE_HZ], SR)[1];
    expect(predicted).toBeCloseTo(measured, 1);

    // And a neighbouring Q does NOT reproduce it, so the pin is two-sided
    // rather than "some Q happens to agree".
    const atQ = (q: number): number =>
      20 * Math.log10(magnitudeAt(designBiquad('peaking', SR, 500, q, 6), PROBE_HZ, SR));
    expect(Math.abs(atQ(GRAPHIC_EQ_CASCADE_Q * 0.8) - measured)).toBeGreaterThan(0.3);
    expect(Math.abs(atQ(GRAPHIC_EQ_CASCADE_Q * 1.25) - measured)).toBeGreaterThan(0.3);
  });

  it('predicts what the effect delivers at every centre, on a curve every band carries', () => {
    // Every band non-zero, alternating, so the prediction is exercised with the
    // full cascade in place rather than with one filter.
    const gains = CENTRES.map((_, i) => (i % 2 === 0 ? 3 : -3));
    const predicted = realisedCascadeDb(gains, CENTRES, SR);
    let checked = 0;
    for (let i = 0; i < CENTRES.length; i++) {
      if (CENTRES[i] >= SR / 2) continue;
      expect(predicted[i]).toBeCloseTo(measuredEffectDb(gains, CENTRES[i]), 1);
      checked++;
    }
    // The loop's EXTENT, not just its existence: all ten centres are under
    // Nyquist at 48 kHz, so all ten must have been compared.
    expect(checked).toBe(10);
  });

  it('predicts the effect on a curve of the size the cover match actually asks for', () => {
    // The reference material's curve: +0.54 / -1.15 / -1.90 / -1.04 / +3.54 dB
    // across 500 Hz - 8 kHz, and zero below 500 Hz.
    const gains = gainsAt({ 500: 0.54, 1000: -1.15, 2000: -1.9, 4000: -1.04, 8000: 3.54 });
    const predicted = realisedCascadeDb(gains, CENTRES, SR);
    for (const f of [500, 1000, 2000, 4000, 8000]) {
      const i = CENTRES.indexOf(f);
      expect(predicted[i]).toBeCloseTo(measuredEffectDb(gains, f), 1);
    }
  });

  it('honours the effect\'s skip threshold on both sides of it', () => {
    // Below / on / above, sized so the boundary can move the output: a lone
    // 8 kHz band, whose only neighbour contribution is its own.
    const i8k = CENTRES.indexOf(8000);
    const below = realisedCascadeDb(gainsAt({ 8000: GRAPHIC_EQ_SKIP_DB / 2 }), CENTRES, SR)[i8k];
    const on = realisedCascadeDb(gainsAt({ 8000: GRAPHIC_EQ_SKIP_DB }), CENTRES, SR)[i8k];
    const above = realisedCascadeDb(gainsAt({ 8000: GRAPHIC_EQ_SKIP_DB * 4 }), CENTRES, SR)[i8k];
    expect(below).toBe(0);
    expect(on).toBe(0); // `> 0.01`, so 0.01 itself is skipped — as in the effect
    expect(above).toBeGreaterThan(0.03);
    // And the effect agrees on the same three points.
    expect(measuredEffectDb(gainsAt({ 8000: GRAPHIC_EQ_SKIP_DB }), 8000)).toBeCloseTo(0, 3);
    expect(measuredEffectDb(gainsAt({ 8000: GRAPHIC_EQ_SKIP_DB * 4 }), 8000)).toBeCloseTo(above, 1);
  });

  it('reports nothing for a centre at or above Nyquist, as the effect applies nothing there', () => {
    // 16 kHz sits above Nyquist at 24 kHz sample rate. Probed per operand role:
    // the band below it (8 kHz, under Nyquist) still responds.
    const gains = gainsAt({ 8000: 4, 16000: 6 });
    const realised = realisedCascadeDb(gains, CENTRES, 24000);
    expect(realised[CENTRES.indexOf(16000)]).toBe(0);
    expect(realised[CENTRES.indexOf(8000)]).toBeGreaterThan(3);
    // The effect drops it for the same reason (`freq < nyquist`), so a 16 kHz
    // gain changes nothing it delivers at 8 kHz.
    expect(measuredEffectDb(gains, 8000, 24000)).toBeCloseTo(
      measuredEffectDb(gainsAt({ 8000: 4 }), 8000, 24000),
      3
    );
  });
});

describe('graphicEqCascade — the leak Ruling B is about', () => {
  it('measures dispatch 1\'s figure: a lone +6 dB band leaks about 1.15 dB an octave away', () => {
    const realised = realisedCascadeDb(gainsAt({ 1000: 6 }), CENTRES, SR);
    const leakBelow = realised[CENTRES.indexOf(500)];
    const leakAbove = realised[CENTRES.indexOf(2000)];
    expect(leakBelow).toBeGreaterThan(1.0);
    expect(leakBelow).toBeLessThan(1.3);
    expect(leakAbove).toBeGreaterThan(1.0);
    expect(leakAbove).toBeLessThan(1.3);
    // And the effect really does that to audio, which is the claim that matters.
    expect(measuredEffectDb(gainsAt({ 1000: 6 }), 500)).toBeCloseTo(leakBelow, 1);
  });

  it('measures the +-3 dB error Ruling B quotes: up to about 1 dB at the centres', () => {
    const gains = CENTRES.map((_, i) => (i % 2 === 0 ? 3 : -3));
    const realised = realisedCascadeDb(gains, CENTRES, SR);
    let worst = 0;
    for (let i = 0; i < CENTRES.length; i++) {
      worst = Math.max(worst, Math.abs(realised[i] - gains[i]));
    }
    expect(worst).toBeGreaterThan(0.7);
    expect(worst).toBeLessThan(1.4);
  });
});

describe('graphicEqCascade — band energy is a different quantity from the centre', () => {
  const GAINS = gainsAt({ 500: 4, 1000: -4, 2000: 3, 4000: -3, 8000: 5 });
  const PROBED = [250, 500, 1000, 2000, 4000, 8000, 16000];

  it('predicts what the effect does to an octave\'s ENERGY, measured through real audio', () => {
    // The strongest available pin: real audio through the real effect, and the
    // band levels measured with the SAME function the match curve is built
    // from. If the predictor and the audio disagree, the chain's report is a
    // claim about audio that did not happen.
    const input = whiteNoise(SR * 2);
    const { before, delivered } = deliveredBandEnergyDb(input, GAINS);
    const predicted = realisedBandEnergyDb(GAINS, CENTRES, SR, before);
    let checked = 0;
    for (const centre of PROBED) {
      expect(delivered(centre)).toBeCloseTo(predicted[CENTRES.indexOf(centre)], 1);
      checked++;
    }
    expect(checked).toBe(7);
  });

  it('predicts it on a NON-FLAT spectrum, where an unweighted average cannot', () => {
    // The test that would have caught the misreport. On white noise the
    // unweighted mean of |H|^2 and the signal-weighted mean coincide, so the
    // test above passes either way; on a spectrum shaped like a vowel they do
    // not, and only one of them is what the audio receives.
    const input = formantNoise(SR * 2);
    const { before, delivered } = deliveredBandEnergyDb(input, GAINS);
    const predicted = realisedBandEnergyDb(GAINS, CENTRES, SR, before);
    const unweighted = unweightedBandEnergyDb(GAINS, SR);

    let worstWeighted = 0;
    let worstUnweighted = 0;
    let checked = 0;
    for (const centre of PROBED) {
      const i = CENTRES.indexOf(centre);
      const got = delivered(centre);
      worstWeighted = Math.max(worstWeighted, Math.abs(predicted[i] - got));
      worstUnweighted = Math.max(worstUnweighted, Math.abs(unweighted[i] - got));
      checked++;
    }
    expect(checked).toBe(7);
    // What the module reports IS what the audio received, on material that is
    // not flat.
    expect(worstWeighted).toBeLessThan(0.15);
    // And the fixture is non-flat ENOUGH to observe the difference: dropping
    // the weighting would misreport by more than half a dB. Without this half
    // the test could be satisfied by a fixture that is flat after all.
    expect(worstUnweighted).toBeGreaterThan(0.5);
  });

  it('refuses a weighting spectrum measured at a different sample rate', () => {
    // The two share a bin grid, so a mismatch is a silently wrong answer rather
    // than a slightly wrong one.
    const at44k = longTermAverageSpectrum([whiteNoise(44100)], 44100);
    expect(() => realisedBandEnergyDb(GAINS, CENTRES, SR, at44k)).toThrow(/sample rate/);
  });

  it('is NOT the centre response — a peaking filter moves less energy than its peak', () => {
    // The distinction the module exists to make. A lone +6 dB band delivers
    // 6 dB at its centre and measurably less across its octave.
    const gains = gainsAt({ 1000: 6 });
    const i1k = CENTRES.indexOf(1000);
    const centre = realisedCascadeDb(gains, CENTRES, SR)[i1k];
    const energy = realisedBandEnergyDb(gains, CENTRES, SR, flatSpectrum())[i1k];
    expect(centre).toBeCloseTo(6, 1);
    expect(energy).toBeLessThan(centre - 0.5);
    expect(energy).toBeGreaterThan(3);
  });

  it('reports nothing for a band with no bin under Nyquist, and the partial band above it', () => {
    // 16 kHz's octave runs 11.3–22.6 kHz. At 24 kHz sample rate Nyquist is
    // 12 kHz, so only its bottom slice has bins; at 16 kHz there are none.
    const gains = gainsAt({ 8000: 6, 16000: 6 });
    const at16k = longTermAverageSpectrum([whiteNoise(16000 * 2)], 16000);
    const at24k = longTermAverageSpectrum([whiteNoise(24000 * 2)], 24000);
    expect(realisedBandEnergyDb(gains, CENTRES, 16000, at16k)[CENTRES.indexOf(16000)]).toBe(0);
    expect(realisedBandEnergyDb(gains, CENTRES, 24000, at24k)[CENTRES.indexOf(16000)]).not.toBe(0);
  });

  it('reports nothing for a band the signal has no energy in', () => {
    // A weighted average of nothing is not zero dB by arithmetic — it is
    // undefined — so the band has to be reported as untouched rather than as a
    // number derived from a division by zero.
    const silent: Ltas = {
      power: new Float64Array(LTAS_FFT_SIZE / 2 + 1),
      frames: 0,
      sampleRate: SR,
    };
    expect(realisedBandEnergyDb(GAINS, CENTRES, SR, silent)).toEqual(CENTRES.map(() => 0));
  });
});

describe('graphicEqCascade — the pre-compensating solve', () => {
  const solvableFrom = (freqs: number[]): boolean[] => CENTRES.map((f) => freqs.includes(f));

  it('lands the realised band energy on the target, where an unsolved curve would not', () => {
    const target = gainsAt({ 500: 0.54, 1000: -1.15, 2000: -1.9, 4000: -1.04, 8000: 3.54 });
    const solvable = solvableFrom([500, 1000, 2000, 4000, 8000]);
    const signal = flatSpectrum();
    const raw = realisedBandEnergyDb(target, CENTRES, SR, signal);
    let rawWorst = 0;
    for (let i = 0; i < CENTRES.length; i++) {
      if (!solvable[i]) continue;
      rawWorst = Math.max(rawWorst, Math.abs(raw[i] - target[i]));
    }
    // The error the solve exists to remove is real on this very curve — the
    // one measured on the reference material.
    expect(rawWorst).toBeGreaterThan(0.5);

    const solution = solveCascadeGains(target, CENTRES, SR, solvable, signal);
    expect(solution.worstErrorDb).toBeLessThanOrEqual(SOLVE_TOLERANCE_DB);
    expect(solution.clamped).toBe(false);
    // A band solved ALONE needs a LARGER gain than its target, because it is
    // compensating its own roll-off across the octave. (In the full curve the
    // neighbours' leakage can push either way, so this is stated where it is
    // actually a property of the cascade rather than of one fixture.)
    const lone = solveCascadeGains(gainsAt({ 1000: 3 }), CENTRES, SR, solvableFrom([1000]), signal);
    expect(lone.gainsDb[CENTRES.indexOf(1000)]).toBeGreaterThan(3.3);
    expect(lone.realisedDb[CENTRES.indexOf(1000)]).toBeCloseTo(3, 2);

    // Pinned against the EFFECT and real audio, not against the predictor it
    // was solved with.
    const { delivered } = deliveredBandEnergyDb(whiteNoise(SR * 2), solution.gainsDb);
    for (const f of [500, 1000, 2000, 4000, 8000]) {
      expect(delivered(f)).toBeCloseTo(target[CENTRES.indexOf(f)], 1);
    }
  });

  it('lands it on the target for a NON-FLAT take, which is the only kind there is', () => {
    // Same claim as above, on a signal whose energy is not evenly spread across
    // its octaves. The solve has to compensate the SHAPE of the take as well as
    // the roll-off of the filter, and the proof is the audio: what comes out is
    // the curve that was asked for, band by band.
    const target = gainsAt({ 500: 0.54, 1000: -1.15, 2000: -1.9, 4000: -1.04, 8000: 3.54 });
    const solvable = solvableFrom([500, 1000, 2000, 4000, 8000]);
    const input = formantNoise(SR * 2);
    const signal = longTermAverageSpectrum([input], SR);
    const solution = solveCascadeGains(target, CENTRES, SR, solvable, signal);
    expect(solution.worstErrorDb).toBeLessThanOrEqual(SOLVE_TOLERANCE_DB);

    const { delivered } = deliveredBandEnergyDb(input, solution.gainsDb);
    let worst = 0;
    for (const f of [500, 1000, 2000, 4000, 8000]) {
      worst = Math.max(worst, Math.abs(delivered(f) - target[CENTRES.indexOf(f)]));
    }
    expect(worst).toBeLessThan(0.15);

    // And the same target solved as though the take were flat does NOT land on
    // this take — which is what the chain used to hand the effect.
    const asIfFlat = solveCascadeGains(target, CENTRES, SR, solvable, flatSpectrum());
    const flatSolved = deliveredBandEnergyDb(input, asIfFlat.gainsDb).delivered;
    let worstAsIfFlat = 0;
    for (const f of [500, 1000, 2000, 4000, 8000]) {
      worstAsIfFlat = Math.max(worstAsIfFlat, Math.abs(flatSolved(f) - target[CENTRES.indexOf(f)]));
    }
    expect(worstAsIfFlat).toBeGreaterThan(0.5);
  });

  it('holds every band it may not touch at exactly zero, and reports what leaks in', () => {
    const target = gainsAt({ 500: 3, 1000: -3, 2000: 3, 4000: -3, 8000: 3 });
    const solvable = solvableFrom([500, 1000, 2000, 4000, 8000]);
    const solution = solveCascadeGains(target, CENTRES, SR, solvable, flatSpectrum());
    let heldAtZero = 0;
    for (let i = 0; i < CENTRES.length; i++) {
      if (solvable[i]) continue;
      expect(solution.gainsDb[i]).toBe(0);
      heldAtZero++;
    }
    // The extent of the loop, counted: five centres are outside the solve.
    expect(heldAtZero).toBe(5);
    // 250 Hz receives no gain of its own, yet the 500 Hz band leaks into it —
    // and that leak is REPORTED rather than assumed to be zero.
    expect(Math.abs(solution.realisedDb[CENTRES.indexOf(250)])).toBeGreaterThan(0.1);
  });

  it('clamps to the effect\'s own range, says it did, and reports the SHORTFALL', () => {
    const signal = flatSpectrum();
    const target = gainsAt({ 500: 11.5, 1000: -11.5, 2000: 11.5 });
    const solution = solveCascadeGains(target, CENTRES, SR, solvableFrom([500, 1000, 2000]), signal);
    expect(solution.clamped).toBe(true);
    for (const g of solution.gainsDb) {
      expect(Math.abs(g)).toBeLessThanOrEqual(GRAPHIC_EQ_MAX_ABS_DB);
    }
    // It did NOT reach the target, and the report says so rather than echoing
    // the target back — the failure mode Ruling B is about.
    expect(solution.worstErrorDb).toBeGreaterThan(SOLVE_TOLERANCE_DB);
    const i500 = CENTRES.indexOf(500);
    expect(Math.abs(solution.realisedDb[i500])).toBeLessThan(Math.abs(target[i500]));

    // A curve that does not need the clamp does not report one — the flag
    // observes the target, not the code path.
    const easy = solveCascadeGains(gainsAt({ 1000: 2 }), CENTRES, SR, solvableFrom([1000]), signal);
    expect(easy.clamped).toBe(false);
    expect(easy.worstErrorDb).toBeLessThanOrEqual(SOLVE_TOLERANCE_DB);
  });

  it('never returns a solve that is WORSE than the gains it started from', () => {
    // Past the clamp the iteration stops being a contraction and can settle
    // further from the target than the un-compensated curve. Measured over 600
    // mean-centred targets bounded to +-10.9 dB — the shape `matchCurve`
    // produces — against a non-flat take.
    const signal = formantSpectrum();
    const solvable = solvableFrom([500, 1000, 2000, 4000, 8000]);
    const naiveWorst = (target: number[]): number => {
      const gains = target.map((v, i) =>
        solvable[i] ? Math.max(-GRAPHIC_EQ_MAX_ABS_DB, Math.min(GRAPHIC_EQ_MAX_ABS_DB, v)) : 0
      );
      const realised = realisedBandEnergyDb(gains, CENTRES, SR, signal);
      let w = 0;
      for (let i = 0; i < CENTRES.length; i++) {
        if (solvable[i]) w = Math.max(w, Math.abs(realised[i] - target[i]));
      }
      return w;
    };

    let seed = 0x1234567;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    let checked = 0;
    let sawClamped = 0;
    for (let t = 0; t < 200; t++) {
      const vals = [500, 1000, 2000, 4000, 8000].map(() => (next() * 2 - 1) * 10.9);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const target = CENTRES.map((c) => {
        const i = [500, 1000, 2000, 4000, 8000].indexOf(c);
        return i === -1 ? 0 : Math.max(-10.9, Math.min(10.9, vals[i] - mean));
      });
      const solution = solveCascadeGains(target, CENTRES, SR, solvable, signal);
      // Within SOLVE_TOLERANCE_DB, because the iterate comparison treats a
      // difference smaller than the effect's own skip threshold as no
      // difference and then prefers the smaller TOTAL error — which is what
      // stops one clamped band freezing every other band where it stands.
      expect(solution.worstErrorDb).toBeLessThanOrEqual(naiveWorst(target) + SOLVE_TOLERANCE_DB);
      if (solution.clamped) sawClamped++;
      checked++;
    }
    expect(checked).toBe(200);
    // The property is only interesting because the clamp is reached: a sweep
    // that never clamped would be asserting nothing.
    expect(sawClamped).toBeGreaterThan(40);
  });

  it('gives every solvable curve the effect CAN deliver enough passes to converge', () => {
    // The pass budget, observed rather than asserted: across both weighting
    // spectra and a range of curve sizes, every run that did not hit the
    // effect's +-12 dB range finished inside tolerance. A budget one pass too
    // small shows up here as a warning the user is shown for no reason.
    const solvable = solvableFrom([500, 1000, 2000, 4000, 8000]);
    let seed = 0x2ee2ee2;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    let unclamped = 0;
    for (const signal of [flatSpectrum(), formantSpectrum()]) {
      for (const span of [4, 10.9]) {
        for (let t = 0; t < 50; t++) {
          const vals = [500, 1000, 2000, 4000, 8000].map(() => (next() * 2 - 1) * span);
          const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
          const target = CENTRES.map((c) => {
            const i = [500, 1000, 2000, 4000, 8000].indexOf(c);
            return i === -1 ? 0 : Math.max(-10.9, Math.min(10.9, vals[i] - mean));
          });
          const solution = solveCascadeGains(target, CENTRES, SR, solvable, signal);
          if (solution.clamped) continue;
          unclamped++;
          expect(solution.worstErrorDb).toBeLessThanOrEqual(SOLVE_TOLERANCE_DB);
        }
      }
    }
    expect(unclamped).toBeGreaterThan(100);
  });

  it('returns the requested gains unchanged when there is nothing to solve', () => {
    const solution = solveCascadeGains(
      CENTRES.map(() => 0),
      CENTRES,
      SR,
      CENTRES.map(() => false),
      flatSpectrum()
    );
    expect(solution.gainsDb).toEqual(CENTRES.map(() => 0));
    expect(solution.realisedDb).toEqual(CENTRES.map(() => 0));
    expect(solution.iterations).toBe(0);
    expect(solution.worstErrorDb).toBe(0);
  });

  it('solves on the centres the match module declares, not a private copy', () => {
    expect(CENTRES).toEqual(Array.from(MATCH_BAND_CENTRES_HZ));
  });
});
