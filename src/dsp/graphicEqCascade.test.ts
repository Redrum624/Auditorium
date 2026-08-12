import {
  GRAPHIC_EQ_CASCADE_Q,
  GRAPHIC_EQ_MAX_ABS_DB,
  GRAPHIC_EQ_SKIP_DB,
  realisedBandEnergyDb,
  realisedCascadeDb,
  solveCascadeGains,
} from './graphicEqCascade';
import { GRAPHIC_EQ_BANDS, graphicEqEffect } from '../effects/eq/GraphicEqEffect';
import { designBiquad, magnitudeAt } from './biquad';
import { MATCH_BAND_CENTRES_HZ, bandLevelDb, longTermAverageSpectrum } from './coverMatch';

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

/** Deterministic white noise — flat enough across an octave that the band level
 * measured after a filter is that filter's band-energy response. */
function whiteNoise(n: number, seed = 0x9e3779b9): Float32Array {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 0xffffffff) * 2 - 1) * 0.25;
  }
  return out;
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
  it('predicts what the effect does to an octave\'s ENERGY, measured through real audio', () => {
    // The strongest available pin: white noise through the real effect, and the
    // band levels measured with the SAME function the match curve is built
    // from. If the predictor and the audio disagree, the chain's report is a
    // claim about audio that did not happen.
    const gains = gainsAt({ 500: 4, 1000: -4, 2000: 3, 4000: -3, 8000: 5 });
    const predicted = realisedBandEnergyDb(gains, CENTRES, SR);
    const input = [whiteNoise(SR * 2)];
    const output = graphicEqEffect.process([Float32Array.from(input[0])], SR, paramsFrom(gains))
      .channels;
    const beforeLtas = longTermAverageSpectrum(input, SR);
    const afterLtas = longTermAverageSpectrum(output, SR);

    let checked = 0;
    for (const centre of [500, 1000, 2000, 4000, 8000]) {
      const lo = centre / Math.SQRT2;
      const hi = centre * Math.SQRT2;
      const measured =
        bandLevelDb(afterLtas, lo, hi)! - bandLevelDb(beforeLtas, lo, hi)!;
      expect(measured).toBeCloseTo(predicted[CENTRES.indexOf(centre)], 1);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it('is NOT the centre response — a peaking filter moves less energy than its peak', () => {
    // The distinction the module exists to make. A lone +6 dB band delivers
    // 6 dB at its centre and measurably less across its octave.
    const gains = gainsAt({ 1000: 6 });
    const i1k = CENTRES.indexOf(1000);
    const centre = realisedCascadeDb(gains, CENTRES, SR)[i1k];
    const energy = realisedBandEnergyDb(gains, CENTRES, SR)[i1k];
    expect(centre).toBeCloseTo(6, 1);
    expect(energy).toBeLessThan(centre - 0.5);
    expect(energy).toBeGreaterThan(3);
  });

  it('reports nothing for a band with no bin under Nyquist, and the partial band above it', () => {
    // 16 kHz's octave runs 11.3–22.6 kHz. At 24 kHz sample rate Nyquist is
    // 12 kHz, so only its bottom slice has bins; at 16 kHz there are none.
    const gains = gainsAt({ 8000: 6, 16000: 6 });
    expect(realisedBandEnergyDb(gains, CENTRES, 16000)[CENTRES.indexOf(16000)]).toBe(0);
    expect(realisedBandEnergyDb(gains, CENTRES, 24000)[CENTRES.indexOf(16000)]).not.toBe(0);
  });
});

describe('graphicEqCascade — the pre-compensating solve', () => {
  const solvableFrom = (freqs: number[]): boolean[] => CENTRES.map((f) => freqs.includes(f));

  it('lands the realised band energy on the target, where an unsolved curve would not', () => {
    const target = gainsAt({ 500: 0.54, 1000: -1.15, 2000: -1.9, 4000: -1.04, 8000: 3.54 });
    const solvable = solvableFrom([500, 1000, 2000, 4000, 8000]);
    const raw = realisedBandEnergyDb(target, CENTRES, SR);
    let rawWorst = 0;
    for (let i = 0; i < CENTRES.length; i++) {
      if (!solvable[i]) continue;
      rawWorst = Math.max(rawWorst, Math.abs(raw[i] - target[i]));
    }
    // The error the solve exists to remove is real on this very curve — the
    // one measured on the reference material.
    expect(rawWorst).toBeGreaterThan(0.5);

    const solution = solveCascadeGains(target, CENTRES, SR, solvable);
    expect(solution.worstErrorDb).toBeLessThanOrEqual(0.01);
    expect(solution.iterations).toBeLessThan(12); // it converged rather than ran out
    expect(solution.clamped).toBe(false);
    // A band solved ALONE needs a LARGER gain than its target, because it is
    // compensating its own roll-off across the octave. (In the full curve the
    // neighbours' leakage can push either way, so this is stated where it is
    // actually a property of the cascade rather than of one fixture.)
    const lone = solveCascadeGains(gainsAt({ 1000: 3 }), CENTRES, SR, solvableFrom([1000]));
    expect(lone.gainsDb[CENTRES.indexOf(1000)]).toBeGreaterThan(3.3);
    expect(lone.realisedDb[CENTRES.indexOf(1000)]).toBeCloseTo(3, 2);

    // Pinned against the EFFECT and real audio, not against the predictor it
    // was solved with.
    const input = [whiteNoise(SR * 2)];
    const output = graphicEqEffect.process(
      [Float32Array.from(input[0])],
      SR,
      paramsFrom(solution.gainsDb)
    ).channels;
    const beforeLtas = longTermAverageSpectrum(input, SR);
    const afterLtas = longTermAverageSpectrum(output, SR);
    for (const f of [500, 1000, 2000, 4000, 8000]) {
      const measured =
        bandLevelDb(afterLtas, f / Math.SQRT2, f * Math.SQRT2)! -
        bandLevelDb(beforeLtas, f / Math.SQRT2, f * Math.SQRT2)!;
      expect(measured).toBeCloseTo(target[CENTRES.indexOf(f)], 1);
    }
  });

  it('holds every band it may not touch at exactly zero, and reports what leaks in', () => {
    const target = gainsAt({ 500: 3, 1000: -3, 2000: 3, 4000: -3, 8000: 3 });
    const solvable = solvableFrom([500, 1000, 2000, 4000, 8000]);
    const solution = solveCascadeGains(target, CENTRES, SR, solvable);
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
    const target = gainsAt({ 500: 11.5, 1000: -11.5, 2000: 11.5 });
    const solution = solveCascadeGains(target, CENTRES, SR, solvableFrom([500, 1000, 2000]));
    expect(solution.clamped).toBe(true);
    for (const g of solution.gainsDb) {
      expect(Math.abs(g)).toBeLessThanOrEqual(GRAPHIC_EQ_MAX_ABS_DB);
    }
    // It did NOT reach the target, and the report says so rather than echoing
    // the target back — the failure mode Ruling B is about.
    expect(solution.worstErrorDb).toBeGreaterThan(0.01);
    const i500 = CENTRES.indexOf(500);
    expect(Math.abs(solution.realisedDb[i500])).toBeLessThan(Math.abs(target[i500]));

    // A curve that does not need the clamp does not report one — the flag
    // observes the target, not the code path.
    const easy = solveCascadeGains(gainsAt({ 1000: 2 }), CENTRES, SR, solvableFrom([1000]));
    expect(easy.clamped).toBe(false);
    expect(easy.worstErrorDb).toBeLessThanOrEqual(0.01);
  });

  it('returns the requested gains unchanged when there is nothing to solve', () => {
    const solution = solveCascadeGains(
      CENTRES.map(() => 0),
      CENTRES,
      SR,
      CENTRES.map(() => false)
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
