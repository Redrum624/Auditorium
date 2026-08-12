/**
 * Pitch Correct effect tests. Every numeric bound is a MEASURED value (recorded
 * 2026-08-08 on this implementation, noted per assertion) plus headroom, and
 * output pitch is asserted by MEASURING the output's f0 with the detector that
 * pitchDetect.test.ts validates against known-f0 fixtures — not by "samples
 * changed".
 */
import {
  pitchCorrectEffect,
  buildCorrectionMap,
  correctionCurve,
  hzToMidi,
  snapMidiToScale,
  SCALE_INTERVALS,
  summarizeCorrection,
} from './PitchCorrectEffect';
import { MAX_RATIO, MIN_RATIO } from '../../dsp/wsola';
import { getAllEffects } from '../EffectRegistry';
import { registerAllEffects } from '../registerAll';
import { detectPitch, type PitchTrack } from '../../dsp/pitchDetect';
import type { EffectParamValue } from '../types';

const SR = 44100;

function sine(freq: number, seconds: number, amplitude = 1): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function noise(seconds: number, amplitude: number, seed: number): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  let state = seed >>> 0;
  for (let i = 0; i < n; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = amplitude * (state / 2147483648 - 1);
  }
  return out;
}

function cents(a: number, b: number): number {
  return 1200 * Math.log2(a / b);
}

/** Runs the effect and asserts the inputs were not mutated (registry contract). */
function run(channels: Float32Array[], params: Record<string, EffectParamValue>): Float32Array[] {
  const before = channels.map((c) => Array.from(c));
  const result = pitchCorrectEffect.process(channels, SR, params);
  channels.forEach((c, i) => expect(Array.from(c)).toEqual(before[i]));
  return result.channels;
}

/** Median MEASURED f0 over voiced frames whose centre lies in [fromSec, toSec]. */
function medianF0(x: Float32Array, fromSec: number, toSec: number): number {
  const track = detectPitch(x, SR);
  const center = track.frameSamples / 2;
  const f0s: number[] = [];
  track.frames.forEach((fr, k) => {
    const t = (k * track.hopSamples + center) / SR;
    if (fr.f0Hz !== null && t >= fromSec && t <= toSec) f0s.push(fr.f0Hz);
  });
  expect(f0s.length).toBeGreaterThan(0);
  f0s.sort((a, b) => a - b);
  return f0s[Math.floor(f0s.length / 2)];
}

describe('pitchCorrectEffect — registration and parameter surface', () => {
  it('registers as pitch-correct in Time & Pitch via registerAllEffects', () => {
    registerAllEffects();
    const byId = new Map(getAllEffects().map((e) => [e.id, e]));
    expect(byId.get('pitch-correct')?.category).toBe('Time & Pitch');
    expect(byId.get('pitch-correct')?.name).toBe('Pitch Correct');
  });

  it('ships the derived defaults: key C, chromatic, strength 100 %, retune 50 ms', () => {
    const p = new Map(pitchCorrectEffect.params.map((d) => [d.id, d]));
    expect(p.get('key')?.default).toBe('C');
    expect(p.get('scale')?.default).toBe('chromatic');
    expect(p.get('strength')?.default).toBe(100);
    expect(p.get('retuneMs')?.default).toBe(50);
  });

  it('retune readout mirrors the one-pole corner 1/(2πτ) and names 0 ms an instant snap', () => {
    const readout = pitchCorrectEffect.params.find((d) => d.id === 'retuneMs')?.readout;
    expect(readout).toBeDefined();
    const ctx = { regionSamples: SR, sampleRate: SR };
    expect(readout?.(0, ctx)).toBe('instant snap');
    // 1/(2π·0.05 s) = 3.183 Hz
    expect(readout?.(50, ctx)).toBe('corner ≈ 3.2 Hz');
  });
});

describe('snapMidiToScale — nearest-note selection (boundary trios per scale gap)', () => {
  const chromatic = SCALE_INTERVALS.chromatic as readonly number[];
  const major = SCALE_INTERVALS.major as readonly number[];
  const minor = SCALE_INTERVALS.minor as readonly number[];

  it('chromatic: below / on / above the half-semitone midpoint', () => {
    expect(snapMidiToScale(60.499, 0, chromatic)).toBe(60);
    expect(snapMidiToScale(60.5, 0, chromatic)).toBe(61); // exact tie snaps UP (half-up)
    expect(snapMidiToScale(60.501, 0, chromatic)).toBe(61);
    expect(snapMidiToScale(61.0, 0, chromatic)).toBe(61); // exact note is a fixpoint
  });

  it('C major: C#4 (61) is the midpoint of the C–D whole step — below / on / above', () => {
    expect(snapMidiToScale(60.99, 0, major)).toBe(60);
    expect(snapMidiToScale(61.0, 0, major)).toBe(62); // tie snaps UP
    expect(snapMidiToScale(61.01, 0, major)).toBe(62);
  });

  it('crosses octave boundaries in both directions (C major)', () => {
    expect(snapMidiToScale(71.6, 0, major)).toBe(72); // B4 → C5, the next octave's root
    expect(snapMidiToScale(59.7, 0, major)).toBe(60); // below C4 pulls up to it
  });

  it('distinguishes the minor third from the major third (root A)', () => {
    expect(snapMidiToScale(72.4, 9, minor)).toBe(72); // C5 is IN A natural minor
    expect(snapMidiToScale(72.4, 9, major)).toBe(73); // A major has C#5 instead
  });

  it('the octave-below scan is live for rootless interval sets (dead for all shipped scales)', () => {
    // With intervals [11] (no root), midi 60.2's nearest candidates are 59
    // (11 of the octave BELOW, distance 1.2) and 71 (distance 10.8) — only the
    // baseOct − 1 scan can find 59. Every shipped scale contains 0, which
    // provably beats any octave-below candidate, so this pin documents why the
    // branch exists rather than a reachable effect behaviour.
    expect(snapMidiToScale(60.2, 0, [11])).toBe(59);
  });

  it('hzToMidi: A4 = 440 Hz is exactly MIDI 69, octaves are ±12', () => {
    expect(hzToMidi(440)).toBe(69);
    expect(hzToMidi(880)).toBe(81);
    expect(hzToMidi(220)).toBe(57);
  });
});

describe('correctionCurve — smoothing semantics', () => {
  const chromatic = SCALE_INTERVALS.chromatic as readonly number[];

  /** All-voiced synthetic track at a constant f0 (hop/frame mirror 44.1 kHz geometry). */
  function steadyTrack(f0: number, frames: number): PitchTrack {
    return {
      frames: Array.from({ length: frames }, () => ({ f0Hz: f0, confidence: 1 })),
      hopSamples: 441,
      frameSamples: 2206,
    };
  }

  it('retune 0 jumps to the full snapped correction on the first frame', () => {
    // midi(452) = 69.4664…; chromatic snap → 69 ⇒ correction = −0.46637 st.
    const corr = correctionCurve(steadyTrack(452, 3), SR, 0, chromatic, 1, 0);
    const expected = 69 - hzToMidi(452);
    expect(corr[0]).toBeCloseTo(expected, 10);
    expect(corr[2]).toBeCloseTo(expected, 10);
  });

  it('strength scales the correction linearly (50 % ⇒ half the semitone offset)', () => {
    const corr = correctionCurve(steadyTrack(452, 2), SR, 0, chromatic, 0.5, 0);
    expect(corr[0]).toBeCloseTo((69 - hzToMidi(452)) / 2, 10);
  });

  it('retuneMs is the time constant: 1 − e⁻¹ of the step after τ, ~95 % after 3τ', () => {
    // τ = 100 ms = 10 hops of 10 ms. state(m) = target·(1 − (1−α)^m) with
    // α = 1 − e^(−hop/τ), so state(10)/target = 1 − e^(−10·hop/τ) = 1 − e⁻¹.
    const target = 69 - hzToMidi(452);
    const corr = correctionCurve(steadyTrack(452, 31), SR, 0, chromatic, 1, 100);
    expect(corr[9] / target).toBeCloseTo(1 - Math.exp(-1), 6); // frame 9 = 10th update
    expect(corr[29] / target).toBeCloseTo(1 - Math.exp(-3), 6);
  });

  it('unvoiced frames pull the correction back toward zero with the same constant', () => {
    const track = steadyTrack(452, 20);
    for (let k = 10; k < 20; k++) track.frames[k] = { f0Hz: null, confidence: 0 };
    const corr = correctionCurve(track, SR, 0, chromatic, 1, 0);
    expect(corr[9]).not.toBe(0);
    expect(corr[10]).toBe(0); // retune 0: the decay is also instant
  });
});

describe('buildCorrectionMap — exact per-sample ratios (edge holds, interpolation, clamp)', () => {
  // The tail hold affects only the last ~25 ms of audio and is unobservable at
  // f0-measurement scale (a surviving mutant proved it: with the accumulated
  // map shift, even a zero-correction tail deviates from the input by O(1)
  // phase offset), so the hold/interp/clamp branches are pinned here with
  // EXACT arithmetic on the per-sample increments S[i+1] − S[i] = ρ(i).
  const rho = (c: number) => Math.pow(2, c / 12);
  const inc = (S: Float64Array, i: number) => S[i + 1] - S[i];
  // S[i+1] − S[i] recovers ρ(i) up to one accumulation ulp (~2e-16); precision
  // 12 (5e-13) absorbs that while the pinned branch differences are ≥ percents.
  const expectRho = (got: number, c: number) => expect(got).toBeCloseTo(rho(c), 12);

  it('holds corr[0] up to the first frame centre and corr[K−1] from the last (below/on/above each)', () => {
    // center = 2, hop = 4, K = 3 ⇒ centres at samples 2, 6, 10 over N = 16.
    const corr = [0.5, 0.2, -0.3];
    const { S } = buildCorrectionMap(corr, 16, 2, 4);
    expectRho(inc(S, 0), 0.5); // below the first centre: head hold
    expectRho(inc(S, 1), 0.5);
    expectRho(inc(S, 2), 0.5); // ON the first centre (t = 0 takes the hold branch)
    expectRho(inc(S, 3), 0.5 + 0.25 * (0.2 - 0.5)); // above: interpolation begins
    expectRho(inc(S, 9), 0.2 + 0.75 * (-0.3 - 0.2)); // below the last centre: interp
    expectRho(inc(S, 10), -0.3); // ON the last centre (t = K−1 takes the hold branch)
    expectRho(inc(S, 11), -0.3); // above: tail hold
    expectRho(inc(S, 15), -0.3);
  });

  it('interpolates linearly in semitones between frame centres', () => {
    const corr = [0, 1.2];
    const { S, maxRho } = buildCorrectionMap(corr, 8, 0, 4); // centres at 0 and 4
    expectRho(inc(S, 1), 0.3);
    expectRho(inc(S, 2), 0.6);
    expectRho(inc(S, 3), 0.9);
    expect(maxRho).toBe(rho(1.2)); // maxRho is a direct copy, not a difference — exact
  });

  it('clamps out-of-range ratios to [MIN_RATIO, MAX_RATIO] (unreachable from the effect, pinned here)', () => {
    // ±100 st ⇒ ρ = 2^±8.33, far outside WSOLA's supported range — pins the
    // clamp TARGET; the trio below pins the clamp THRESHOLD.
    const up = buildCorrectionMap([100], 4, 2, 4);
    expect(inc(up.S, 0)).toBe(MAX_RATIO);
    expect(up.maxRho).toBe(MAX_RATIO);
    const down = buildCorrectionMap([-100], 4, 2, 4);
    expect(inc(down.S, 0)).toBe(MIN_RATIO);
    // …and an in-range curve is NOT clamped (boundary from the inside).
    const inside = buildCorrectionMap([1], 4, 2, 4);
    expect(inc(inside.S, 0)).toBe(rho(1));
  });

  it('clamp THRESHOLD trios: just below / exactly on / just above each ratio boundary', () => {
    // A ±100 st fixture sits 80× beyond the boundary and cannot see a moved
    // threshold (rho > MAX_RATIO·4 clamps it just the same) — the round-2
    // review proved that mutant survives. These fixtures straddle the boundary
    // itself: ρ = MAX_RATIO exactly at c = 24 st (2^(24/12) = 4, dyadic ⇒ every
    // value below is float-exact), MIN_RATIO at c = −24 st (2^−2 = 0.25).
    const maxBelow = buildCorrectionMap([23.9], 4, 2, 4); // ρ ≈ 3.977 — inside, must NOT clamp
    expectRho(inc(maxBelow.S, 0), 23.9);
    const maxOn = buildCorrectionMap([24], 4, 2, 4); // ρ = 4 exactly — clamping is a no-op AT the
    expect(inc(maxOn.S, 0)).toBe(MAX_RATIO); //         boundary value, so `>` vs `>=` is invisible
    const maxAbove = buildCorrectionMap([24.1], 4, 2, 4); // ρ ≈ 4.023 — MUST clamp to exactly 4;
    expect(inc(maxAbove.S, 0)).toBe(MAX_RATIO); //          kills any moved-threshold mutant

    const minAbove = buildCorrectionMap([-23.9], 4, 2, 4); // ρ ≈ 0.2515 — inside, must NOT clamp
    expectRho(inc(minAbove.S, 0), -23.9);
    const minOn = buildCorrectionMap([-24], 4, 2, 4); // ρ = 0.25 exactly
    expect(inc(minOn.S, 0)).toBe(MIN_RATIO);
    const minBelow = buildCorrectionMap([-24.1], 4, 2, 4); // ρ ≈ 0.2486 — MUST clamp to exactly 0.25
    expect(inc(minBelow.S, 0)).toBe(MIN_RATIO);
  });

  it('S starts at 0 and accumulates to the stretched total', () => {
    const { S } = buildCorrectionMap([0], 5, 2, 4); // ρ ≡ 1
    expect(S[0]).toBe(0);
    expect(S[5]).toBe(5);
  });
});

describe('pitchCorrectEffect — pass-through rulings (byte-identical)', () => {
  it('strength 0 returns byte-identical copies in NEW arrays (ruling 4)', () => {
    const input = sine(452, 0.3);
    const out = run([input], { key: 'C', scale: 'chromatic', strength: 0, retuneMs: 0 });
    expect(out[0]).not.toBe(input);
    expect(Array.from(out[0])).toEqual(Array.from(input));
  });

  it('a NEGATIVE persisted strength clamps to 0 and passes through (never inverts corrections)', () => {
    // Only reachable via hand-edited params (the slider floors at 0), but an
    // unclamped negative strength would INVERT every correction — pushing
    // pitch away from the scale. Probes Math.max(0, …) from below.
    const input = sine(452, 0.3);
    const out = run([input], { key: 'C', scale: 'chromatic', strength: -50, retuneMs: 0 });
    expect(Array.from(out[0])).toEqual(Array.from(input));
  });

  it('strength 1 (just above the boundary) does NOT pass through', () => {
    const input = sine(452, 0.3);
    const out = run([input], { key: 'C', scale: 'chromatic', strength: 1, retuneMs: 0 });
    // Measured: every sample differs at strength 1 on an off-pitch tone.
    let differing = 0;
    for (let i = 0; i < input.length; i++) if (out[0][i] !== input[i]) differing++;
    expect(differing).toBeGreaterThan(0);
  });

  it('digital silence passes through byte-identically at full strength (ruling 3)', () => {
    const input = new Float32Array(Math.round(0.4 * SR));
    const out = run([input], { key: 'C', scale: 'chromatic', strength: 100, retuneMs: 50 });
    expect(Array.from(out[0])).toEqual(Array.from(input));
  });

  it('unvoiced audio (white noise) passes through byte-identically (ruling 3)', () => {
    // The detector reports this fixture entirely unvoiced (pinned in
    // pitchDetect.test.ts), so the correction curve is exactly zero.
    const input = noise(0.5, 0.5, 12345);
    const out = run([input], { key: 'C', scale: 'chromatic', strength: 100, retuneMs: 0 });
    expect(Array.from(out[0])).toEqual(Array.from(input));
  });

  it('input shorter than one analysis frame (no detector frames) passes through', () => {
    const input = sine(452, 2205 / SR); // one sample short of a frame
    const out = run([input], { key: 'C', scale: 'chromatic', strength: 100, retuneMs: 0 });
    expect(Array.from(out[0])).toEqual(Array.from(input));
  });
});

describe('pitchCorrectEffect — measured pitch correction (452 Hz = A4 + 46.6 cents)', () => {
  it('chromatic, strength 100, retune 0: output measures 440 Hz within 3 cents, length preserved', () => {
    // Measured: 440.01 Hz (+0.04 c) — ≥ 99 % of the 46.6 c offset removed.
    const input = sine(452, 1.0);
    const out = run([input], { key: 'C', scale: 'chromatic', strength: 100, retuneMs: 0 });
    expect(out[0].length).toBe(input.length);
    expect(Math.abs(cents(medianF0(out[0], 0.15, 0.85), 440))).toBeLessThan(3);
  });

  it('strength 50 leaves half the offset: output ≈ +23 cents from A4 (linear-in-cents blend)', () => {
    // Measured +23.36 c; the exact half is +23.32 c. Pin ±5 c.
    const out = run([sine(452, 1.0)], { key: 'C', scale: 'chromatic', strength: 50, retuneMs: 0 });
    const c = cents(medianF0(out[0], 0.15, 0.85), 440);
    expect(c).toBeGreaterThan(18);
    expect(c).toBeLessThan(28);
  });

  it('strength above 100 clamps to full correction (no overshoot past the note)', () => {
    // A broken upper clamp would overshoot to ≈ −23 c; measured behaviour is ≈ 440 Hz.
    const out = run([sine(452, 1.0)], { key: 'C', scale: 'chromatic', strength: 150, retuneMs: 0 });
    expect(Math.abs(cents(medianF0(out[0], 0.15, 0.85), 440))).toBeLessThan(3);
  });
});

describe('pitchCorrectEffect — key and scale route to different target notes (460 Hz input)', () => {
  // 460 Hz = midi 69.77: nearest chromatic note is A#4 (466.16 Hz, 0.23 st away);
  // nearest C-MAJOR note is A4 (440 Hz — A# is not in the scale); nearest
  // C-MINOR note is A#4 again (it IS in the scale). Same input, three targets.
  // The F-major row is what makes the KEY load-bearing: Bb (= A#4, 466.16 Hz)
  // is in F major but not in C major, so a root pitch class stuck at 0 retunes
  // this row to A4 (440 Hz) instead — every C-keyed row above stays green.
  it.each([
    ['chromatic', 'C', 466.16],
    ['major', 'C', 440],
    ['minor', 'C', 466.16],
    ['major', 'F', 466.16],
  ] as const)('scale %s (key %s) retunes 460 Hz to %f Hz within 3 cents', (scale, key, target) => {
    // Measured: 466.15 / 440.00 / 466.15 Hz.
    const out = run([sine(460, 1.0)], { key, scale, strength: 100, retuneMs: 0 });
    expect(Math.abs(cents(medianF0(out[0], 0.15, 0.85), target))).toBeLessThan(3);
  });
});

describe('pitchCorrectEffect — retune speed is an exponential glide with time constant retuneMs', () => {
  it('retune 200 ms: the residual offset decays exponentially along the note', () => {
    // Measured residuals from 440 Hz (input +46.6 c): [0.1,0.15] s → 28.5 c,
    // [0.2,0.25] → 17.3 c, [0.4,0.45] → 6.4 c, [1.2,1.4] → 0.12 c — matching
    // 46.6·e^(−(t−t₀)/0.2) with t₀ ≈ the first frame centre (25 ms).
    const out = run([sine(452, 1.5)], { key: 'C', scale: 'chromatic', strength: 100, retuneMs: 200 });
    const residuals = (
      [
        [0.1, 0.15],
        [0.2, 0.25],
        [0.4, 0.45],
        [1.2, 1.4],
      ] as const
    ).map(([a, b]) => cents(medianF0(out[0], a, b), 440));
    expect(residuals[0]).toBeGreaterThan(20);
    expect(residuals[0]).toBeLessThan(35);
    for (let i = 1; i < residuals.length; i++) expect(residuals[i]).toBeLessThan(residuals[i - 1]);
    expect(residuals[3]).toBeLessThan(3);
  });

  it('retune 0 corrects fully from the start of the note (measured +0.03 c at 0.1 s)', () => {
    const input = sine(452, 1.5);
    const out = run([input], { key: 'C', scale: 'chromatic', strength: 100, retuneMs: 0 });
    expect(Math.abs(cents(medianF0(out[0], 0.1, 0.15), 440))).toBeLessThan(3);

    // The correction curve HOLDS its first/last frame values across the edge
    // regions (the first/last ~25 ms lie before/after any frame centre), so
    // with retune 0 even the head and tail of the note are pitch-shifted. The
    // 46.6 c shift drifts the phase ~1.7 rad across 1000 samples, so the
    // corrected edges deviate from the input by O(1) — measured max 1.497
    // (head) / 1.437 (tail) — while an edge whose correction decayed to zero
    // is a unit-ratio pass-through deviating by ~1e-17 (sinc leakage only).
    // A magnitude pin, not an any-sample-differs pin: near-zero samples pick
    // up float-level leakage either way. Probes the t ≤ 0 and t ≥ K−1 hold
    // branches of the ratio curve.
    let headDev = 0;
    for (let i = 0; i < 1000; i++) headDev = Math.max(headDev, Math.abs(out[0][i] - input[i]));
    expect(headDev).toBeGreaterThan(0.1);
    let tailDev = 0;
    for (let i = input.length - 1000; i < input.length; i++) {
      tailDev = Math.max(tailDev, Math.abs(out[0][i] - input[i]));
    }
    expect(tailDev).toBeGreaterThan(0.1);
  });
});

describe('pitchCorrectEffect — frame-centre attribution (correction-vs-audio alignment)', () => {
  it('a glide through the A4 snap zone flattens to 440 with the residual the detector lag predicts', () => {
    // buildCorrectionMap is exactly pinned GIVEN centerSamples, but nothing else
    // pins what the effect passes it — a centre mis-wire shifts the correction
    // curve against the audio with every steady-tone pin still green (round-2
    // review: `frameSamples / 4` survived all 32 tests). On a glide the shift
    // is observable: residual ≈ slope × (detector lag + wiring error).
    // Measured on this fixture (333 c/s through the zone): correct wiring
    // +3.79 c median (spread 3.64–3.86 — the detector's ≈11 ms glide lag);
    // `frameSamples / 4` −0.38 c; a hypothetical un-halved centre ≈ +8 c.
    // The (2.0, 5.5) band accepts the correct wiring and rejects a ±12.5 ms
    // mis-attribution in either direction.
    const n = Math.round(0.6 * SR);
    const input = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      input[i] = Math.sin(phase);
      const f = 415.3047 * Math.pow(466.1638 / 415.3047, i / n); // G#4 → A#4, −100 c → +100 c of A4
      phase += (2 * Math.PI * f) / SR;
    }
    const out = run([input], { key: 'C', scale: 'chromatic', strength: 100, retuneMs: 0 });
    const track = detectPitch(out[0], SR);
    const center = track.frameSamples / 2;
    const residuals: number[] = [];
    track.frames.forEach((fr, k) => {
      const t = (k * track.hopSamples + center) / SR;
      if (fr.f0Hz !== null && t >= 0.24 && t <= 0.36) residuals.push(cents(fr.f0Hz, 440));
    });
    expect(residuals.length).toBeGreaterThan(0);
    residuals.sort((a, b) => a - b);
    const median = residuals[Math.floor(residuals.length / 2)];
    expect(median).toBeGreaterThan(2.0);
    expect(median).toBeLessThan(5.5);
  });
});

describe('pitchCorrectEffect — stereo linkage and silence gaps', () => {
  it('proportional channels stay exactly proportional (shared offsets + shared read positions)', () => {
    // R = 0.5·L throughout; measured max |out.R − 0.5·out.L| = 0 exactly
    // (scaling by a power of two commutes with every float operation used).
    const l = sine(452, 0.8, 0.8);
    const r = sine(452, 0.8, 0.4);
    const out = run([l, r], { key: 'C', scale: 'chromatic', strength: 100, retuneMs: 0 });
    expect(out[0].length).toBe(l.length);
    expect(out[1].length).toBe(l.length);
    let maxDev = 0;
    for (let i = 0; i < out[0].length; i++) {
      maxDev = Math.max(maxDev, Math.abs(out[1][i] - 0.5 * out[0][i]));
    }
    expect(maxDev).toBeLessThan(1e-7);
  });

  it('a digital-silence gap between corrected notes stays exactly zero in its interior', () => {
    // 0.3 s tone | 0.3 s silence | 0.3 s tone. WSOLA frames reach at most
    // frame/2 + search ≈ 35 ms across the boundary and the sinc kernel 0.73 ms,
    // so a 60 ms margin bounds all bleed; measured interior max |sample| = 0.
    const seg = Math.round(0.3 * SR);
    const input = new Float32Array(3 * seg);
    input.set(sine(452, 0.3), 0);
    input.set(sine(452, 0.3), 2 * seg);
    const out = run([input], { key: 'C', scale: 'chromatic', strength: 100, retuneMs: 0 });
    expect(out[0].length).toBe(input.length);
    const margin = Math.round(0.06 * SR);
    for (let i = seg + margin; i < 2 * seg - margin; i++) {
      if (out[0][i] !== 0) throw new Error(`non-zero sample ${out[0][i]} at ${i}`);
    }
    // …and the gap did not disable correction: the first tone measures 440.
    expect(Math.abs(cents(medianF0(out[0].subarray(0, seg), 0.1, 0.25), 440))).toBeLessThan(3);
  });
});

describe('pitchCorrectEffect — progress reporting', () => {
  it('reports a terminal 1 and never regresses across the three stages', () => {
    const seen: number[] = [];
    pitchCorrectEffect.process([sine(452, 0.5)], SR, { key: 'C', scale: 'chromatic', strength: 100, retuneMs: 0 }, (f) =>
      seen.push(f)
    );
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });
});


describe('summarizeCorrection (F7) — the facts only this effect can know', () => {
  /** A track whose voiced frames carry the given fundamentals; `null` is
   * unvoiced. Hop/frame sizes are irrelevant to the summary. */
  function track(f0s: (number | null)[]): PitchTrack {
    return {
      frames: f0s.map((f0Hz) => ({ f0Hz, confidence: f0Hz === null ? 0 : 0.95 })),
      hopSamples: 100,
      frameSamples: 400,
    };
  }

  it('counts only the frames the corrector actually MOVED', () => {
    // Six frames, three of them left alone. A summary that counted every frame
    // would report 6 and would also drag the median down to 0.
    const report = summarizeCorrection(track([100, 100, 100, 100, 100, 100]), [0, 0.1, 0, 0.2, 0, 0.3]);
    expect(report.correctedFrames).toBe(3);
    expect(report.totalFrames).toBe(6);
  });

  it('reports the median and the maximum of |correction| in cents', () => {
    const report = summarizeCorrection(track([100, 100, 100]), [0.1, -0.3, 0.2]);
    // |0.1|, |0.2|, |0.3| semitones -> 10, 20, 30 cents.
    expect(report.medianCorrectionCents).toBeCloseTo(20, 6);
    expect(report.maxCorrectionCents).toBeCloseTo(30, 6);
  });

  it('takes the ABSOLUTE correction, so a flat note and a sharp one both count', () => {
    const sharp = summarizeCorrection(track([100, 100]), [0.4, 0.4]);
    const flat = summarizeCorrection(track([100, 100]), [-0.4, -0.4]);
    expect(flat.maxCorrectionCents).toBeCloseTo(Number(sharp.maxCorrectionCents), 9);
    expect(flat.maxCorrectionCents).toBeCloseTo(40, 6);
  });

  it('reports zeros — not NaN — when nothing was moved', () => {
    const report = summarizeCorrection(track([100, 100]), [0, 0]);
    expect(report.correctedFrames).toBe(0);
    expect(report.medianCorrectionCents).toBe(0);
    expect(report.maxCorrectionCents).toBe(0);
  });

  it('reports the 1st PERCENTILE of the voiced fundamental, not its minimum', () => {
    // 100 voiced frames: one octave-error outlier at 40 Hz, the rest 200-299 Hz.
    // The minimum is 40; the 1st percentile is the second-lowest, 200.
    const f0s: number[] = [40];
    for (let k = 0; k < 99; k++) f0s.push(200 + k);
    const report = summarizeCorrection(track(f0s), new Array(100).fill(0.1));
    expect(report.f0P1Hz).toBe(200);
    expect(report.f0P1Hz).not.toBe(40);
    expect(report.f0MedianHz).toBeGreaterThan(240);
  });

  it('sorts before taking the percentile — input order must not matter', () => {
    const ascending = [100, 200, 300, 400, 500];
    const descending = [500, 400, 300, 200, 100];
    const a = summarizeCorrection(track(ascending), new Array(5).fill(0.1));
    const b = summarizeCorrection(track(descending), new Array(5).fill(0.1));
    expect(a.f0P1Hz).toBe(b.f0P1Hz);
    expect(a.f0MedianHz).toBe(b.f0MedianHz);
  });

  it('ignores unvoiced frames when measuring the sung range, but still counts them as frames', () => {
    const report = summarizeCorrection(track([null, 300, null, 400, null]), [0, 0.1, 0, 0.1, 0]);
    expect(report.voicedFrames).toBe(2);
    expect(report.totalFrames).toBe(5);
    expect(report.f0P1Hz).toBe(300);
  });

  it('OMITS the fundamental rather than reporting 0 Hz when nothing is voiced', () => {
    // 0 Hz downstream would be read as a measured fundamental of zero; absent
    // is the honest answer, and it is what makes the EQ stage decline.
    const report = summarizeCorrection(track([null, null]), [0, 0]);
    expect(report.f0P1Hz).toBeUndefined();
    expect(report.f0MedianHz).toBeUndefined();
    expect(report.voicedFrames).toBe(0);
  });

  it('rides back from a real run of the effect, not just from the helper', () => {
    const sr = 8000;
    const n = sr * 2;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = 0.4 * Math.sin((2 * Math.PI * 226 * i) / sr) + 0.15 * Math.sin((2 * Math.PI * 452 * i) / sr);
    }
    const result = pitchCorrectEffect.process([x], sr, {
      key: 'C',
      scale: 'chromatic',
      strength: 100,
      retuneMs: 50,
    });
    expect(result.report).toBeDefined();
    expect(Number(result.report!.f0P1Hz)).toBeCloseTo(226, 0);
    expect(Number(result.report!.correctedFrames)).toBeGreaterThan(0);
  });
});
