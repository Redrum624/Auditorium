import { envelopeFollower } from './envelope';
import { compressorEffect } from './CompressorEffect';
import { limiterEffect } from './LimiterEffect';
import { noiseGateEffect } from './NoiseGateEffect';
import { getAllEffects } from '../EffectRegistry';
import { registerAllEffects } from '../registerAll';
import type { EffectDefinition, EffectParamValue } from '../types';

const SR = 44100;

function snapshot(channels: Float32Array[]): number[][] {
  return channels.map((c) => Array.from(c));
}

function expectUnmutated(channels: Float32Array[], before: number[][]): void {
  channels.forEach((c, i) => expect(Array.from(c)).toEqual(before[i]));
}

function run(
  def: EffectDefinition,
  channels: Float32Array[],
  params: Record<string, EffectParamValue> = {}
): Float32Array[] {
  const before = snapshot(channels);
  const result = def.process(channels, SR, params);
  expectUnmutated(channels, before);
  return result.channels;
}

function sine(freq: number, seconds: number, amplitude = 1, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

function rms(signal: Float32Array, start = 0, end = signal.length): number {
  let sum = 0;
  let count = 0;
  for (let i = start; i < end; i++) {
    sum += signal[i] * signal[i];
    count++;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

function maxAbs(signal: Float32Array, start = 0, end = signal.length): number {
  let m = 0;
  for (let i = start; i < end; i++) m = Math.max(m, Math.abs(signal[i]));
  return m;
}

function dbToLin(db: number): number {
  return Math.pow(10, db / 20);
}

function dbGain(inSignal: Float32Array, outSignal: Float32Array, start: number, end: number): number {
  const inR = rms(inSignal, start, end);
  const outR = rms(outSignal, start, end);
  return 20 * Math.log10(outR / inR);
}

describe('envelopeFollower', () => {
  it('rises to ~63% of a step level within ~attackMs (+/-30%)', () => {
    const attackMs = 10;
    const releaseMs = 100;
    const attackSamples = Math.round((attackMs / 1000) * SR);
    // Long constant-1 signal so we can sample the rise in isolation.
    const input = new Float32Array(attackSamples * 20).fill(1);
    const env = envelopeFollower(input, SR, attackMs, releaseMs);
    const at = env[attackSamples - 1];
    expect(at).toBeGreaterThan(0.632 * 0.7);
    expect(at).toBeLessThan(0.632 * 1.3);
  });

  it('decays to ~36.8% of the held level within ~releaseMs after the step ends (+/-30%)', () => {
    const attackMs = 10;
    const releaseMs = 100;
    const attackSamples = Math.round((attackMs / 1000) * SR);
    const releaseSamples = Math.round((releaseMs / 1000) * SR);
    const rampUp = new Float32Array(attackSamples * 20).fill(1); // settle near 1
    const rampDown = new Float32Array(releaseSamples * 5); // zeros
    const input = new Float32Array(rampUp.length + rampDown.length);
    input.set(rampUp, 0);
    input.set(rampDown, rampUp.length);
    const env = envelopeFollower(input, SR, attackMs, releaseMs);
    const dropIndex = rampUp.length;
    const levelAtDrop = env[dropIndex - 1];
    const at = env[dropIndex + releaseSamples - 1];
    expect(at).toBeGreaterThan(levelAtDrop * 0.368 * 0.7);
    expect(at).toBeLessThan(levelAtDrop * 0.368 * 1.3);
  });

  it('env[-1] starts at 0: first sample of a constant signal moves only partway', () => {
    const input = new Float32Array(4).fill(1);
    const env = envelopeFollower(input, SR, 10, 100);
    expect(env[0]).toBeGreaterThan(0);
    expect(env[0]).toBeLessThan(1);
  });
});

describe('compressorEffect', () => {
  it('registers as compressor in category Dynamics', () => {
    expect(compressorEffect.id).toBe('compressor');
    expect(compressorEffect.category).toBe('Dynamics');
  });

  it('14dB over threshold at ratio 4 (knee 0) reduces RMS by ~10.5dB (+/-1.5dB)', () => {
    // -6dBFS sine, threshold -20dB -> 14dB over. reduction = 14*(1-1/4) = 10.5dB.
    const amp = dbToLin(-6);
    const input = sine(1000, 0.5, amp);
    const params = {
      thresholdDb: -20,
      ratio: 4,
      attackMs: 5,
      releaseMs: 20,
      kneeDb: 0,
      makeupDb: 0,
    };
    const out = run(compressorEffect, [input], params);
    const skip = 5000; // let the envelope settle past attack/release
    const gain = dbGain(input, out[0], skip, input.length);
    expect(gain).toBeGreaterThan(-12);
    expect(gain).toBeLessThan(-9);
  });

  it('a signal well under threshold is left ~untouched (+/-0.5dB)', () => {
    const amp = dbToLin(-40);
    const input = sine(1000, 0.5, amp);
    const params = {
      thresholdDb: -20,
      ratio: 4,
      attackMs: 5,
      releaseMs: 20,
      kneeDb: 0,
      makeupDb: 0,
    };
    const out = run(compressorEffect, [input], params);
    const gain = dbGain(input, out[0], 5000, input.length);
    expect(Math.abs(gain)).toBeLessThan(0.5);
  });

  it('makeup +6dB raises an untouched (quiet) signal by ~6dB', () => {
    const amp = dbToLin(-40);
    const input = sine(1000, 0.5, amp);
    const params = {
      thresholdDb: -20,
      ratio: 4,
      attackMs: 5,
      releaseMs: 20,
      kneeDb: 0,
      makeupDb: 6,
    };
    const out = run(compressorEffect, [input], params);
    const gain = dbGain(input, out[0], 5000, input.length);
    expect(gain).toBeCloseTo(6, 1);
  });

  it('sidechain uses max(|L|,|R|): a loud L channel drags down a quiet R channel by the same gain', () => {
    const loud = sine(1000, 0.5, dbToLin(-6)); // 14dB over threshold
    const quiet = sine(1000, 0.5, dbToLin(-40)); // alone would be untouched
    const params = {
      thresholdDb: -20,
      ratio: 4,
      attackMs: 5,
      releaseMs: 20,
      kneeDb: 0,
      makeupDb: 0,
    };
    const out = run(compressorEffect, [loud, quiet], params);
    const skip = 5000;
    const gainR = dbGain(quiet, out[1], skip, quiet.length);
    // R alone is 34dB under threshold and would normally be untouched, but the
    // shared (max) sidechain detector should apply L's ~10.5dB reduction to it too.
    expect(gainR).toBeGreaterThan(-12);
    expect(gainR).toBeLessThan(-9);
  });
});

describe('limiterEffect', () => {
  it('registers as limiter in category Dynamics', () => {
    expect(limiterEffect.id).toBe('limiter');
    expect(limiterEffect.category).toBe('Dynamics');
  });

  it('0dBFS sine with ceiling -6dB sits near the ceiling without exceeding it', () => {
    const input = sine(1000, 0.3, 1);
    const params = { ceilingDb: -6, releaseMs: 50 };
    const out = run(limiterEffect, [input], params);
    const ceilLin = dbToLin(-6);
    const peak = maxAbs(out[0]);
    expect(peak).toBeLessThanOrEqual(ceilLin + 1e-4);
    expect(peak).toBeGreaterThanOrEqual(ceilLin * 0.9);
  });

  it('never exceeds the ceiling even immediately at a sharp onset', () => {
    const input = new Float32Array(2000).fill(1); // instant full-scale step
    const params = { ceilingDb: -3, releaseMs: 50 };
    const out = run(limiterEffect, [input], params);
    const ceilLin = dbToLin(-3);
    expect(maxAbs(out[0])).toBeLessThanOrEqual(ceilLin + 1e-4);
  });

  it('a quiet signal well under the ceiling passes through ~unchanged', () => {
    const input = sine(1000, 0.3, dbToLin(-20));
    const params = { ceilingDb: -6, releaseMs: 50 };
    const out = run(limiterEffect, [input], params);
    const gain = dbGain(input, out[0], 1000, input.length);
    expect(Math.abs(gain)).toBeLessThan(1);
  });

  it('silence in produces silence out (no NaN/Infinity)', () => {
    const input = new Float32Array(1000);
    const out = run(limiterEffect, [input], { ceilingDb: -6, releaseMs: 50 });
    out[0].forEach((v) => {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeCloseTo(0, 6);
    });
  });

  it('forward-looking alignment: no zero pre-roll head, no dropped tail, length preserved', () => {
    const input = sine(1000, 0.3, 1); // full-scale; ~2.2 cycles per 100 samples @44.1k
    const out = run(limiterEffect, [input], { ceilingDb: -6, releaseMs: 50 });
    const ceilLin = dbToLin(-6);
    expect(out[0].length).toBe(input.length);
    // FIRST 100 samples must already sit near the ceiling — the delayed-output
    // design emitted a 5ms (221-sample) zero pre-roll from the delay-line fill.
    const headPeak = maxAbs(out[0], 0, 100);
    expect(headPeak).toBeGreaterThanOrEqual(ceilLin * 0.9);
    expect(headPeak).toBeLessThanOrEqual(ceilLin + 1e-4);
    // LAST 100 samples near the ceiling too (no dropped tail; release-edge tolerance).
    const tailPeak = maxAbs(out[0], out[0].length - 100, out[0].length);
    expect(tailPeak).toBeGreaterThanOrEqual(ceilLin * 0.85);
    expect(tailPeak).toBeLessThanOrEqual(ceilLin + 1e-4);
  });

  it('preserves content in the final lookahead window (burst in the last 50 samples)', () => {
    const n = 2000;
    const input = new Float32Array(n);
    for (let i = n - 50; i < n; i++) input[i] = 1; // full-scale burst at the very end
    const out = run(limiterEffect, [input], { ceilingDb: -6, releaseMs: 50 });
    const ceilLin = dbToLin(-6);
    // The delayed-output design never emitted the last L input samples — this
    // burst vanished entirely. It must appear in place, limited to the ceiling.
    const burstPeak = maxAbs(out[0], n - 50, n);
    expect(burstPeak).toBeGreaterThanOrEqual(ceilLin * 0.9);
    expect(maxAbs(out[0])).toBeLessThanOrEqual(ceilLin + 1e-4);
  });

  it('keeps a quiet signal sample-aligned (no lookahead time shift)', () => {
    const input = sine(1000, 0.1, dbToLin(-20)); // far below ceiling -> gain stays 1
    const out = run(limiterEffect, [input], { ceilingDb: -6, releaseMs: 50 });
    for (let i = 0; i < input.length; i += 7) {
      expect(out[0][i]).toBeCloseTo(input[i], 5);
    }
  });
});

describe('noiseGateEffect', () => {
  it('registers as noise-gate in category Dynamics', () => {
    expect(noiseGateEffect.id).toBe('noise-gate');
    expect(noiseGateEffect.category).toBe('Dynamics');
  });

  it('loud block passes ~unchanged RMS; silent block is fully closed after hold+release (<1e-3)', () => {
    const loud = sine(1000, 0.3, dbToLin(-10)); // above -50dB default threshold
    const silent = new Float32Array(Math.round(0.5 * SR)); // zeros
    const input = new Float32Array(loud.length + silent.length);
    input.set(loud, 0);
    input.set(silent, loud.length);

    const params = { thresholdDb: -50, attackMs: 1, releaseMs: 150, holdMs: 50 };
    const out = run(noiseGateEffect, [input], params);

    // Loud block: skip a short attack transient, RMS should match input closely.
    const loudGain = dbGain(input, out[0], 500, loud.length);
    expect(Math.abs(loudGain)).toBeLessThan(1); // within ~10% in linear terms is < 1dB

    // Silent block tail: well past hold (50ms) + release (150ms) = 200ms.
    const tailStart = loud.length + Math.round(0.3 * SR);
    const tailPeak = maxAbs(out[0], tailStart, input.length);
    expect(tailPeak).toBeLessThan(1e-3);
  });

  it('holds the gate open through a gap shorter than holdMs', () => {
    const loud = sine(1000, 0.2, dbToLin(-10));
    const gapMs = 20; // shorter than holdMs (50 default)
    const gap = sine(1000, gapMs / 1000, dbToLin(-60)); // below threshold, but brief
    const input = new Float32Array(loud.length + gap.length);
    input.set(loud, 0);
    input.set(gap, loud.length);

    const params = { thresholdDb: -50, attackMs: 1, releaseMs: 150, holdMs: 50 };
    const out = run(noiseGateEffect, [input], params);

    // During the held-open gap, gain should still be ~1: gap output RMS should
    // match the gap input RMS (not attenuated toward the release floor yet).
    const gapGain = dbGain(gap, out[0].subarray(loud.length), 0, gap.length);
    expect(Math.abs(gapGain)).toBeLessThan(1);
  });

  it('does not mutate input and produces only finite samples', () => {
    const input = sine(1000, 0.1, dbToLin(-10));
    const out = run(noiseGateEffect, [input], {});
    out[0].forEach((v) => expect(Number.isFinite(v)).toBe(true));
  });
});

describe('dynamics effects registration', () => {
  it('registerAllEffects makes compressor, limiter, noise-gate and de-esser discoverable in category Dynamics', () => {
    registerAllEffects();
    const all = getAllEffects();
    const dynamicsIds = all.filter((e) => e.category === 'Dynamics').map((e) => e.id);
    expect(dynamicsIds).toEqual(expect.arrayContaining(['compressor', 'limiter', 'noise-gate', 'de-esser']));
  });
});
