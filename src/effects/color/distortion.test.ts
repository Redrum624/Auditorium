import { distortionEffect } from './DistortionEffect';
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

function sine(freq: number, seconds: number, amplitude = 1): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function rms(signal: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < signal.length; i++) sum += signal[i] * signal[i];
  return Math.sqrt(sum / signal.length);
}

function maxAbs(signal: Float32Array): number {
  let m = 0;
  for (let i = 0; i < signal.length; i++) m = Math.max(m, Math.abs(signal[i]));
  return m;
}

describe('distortionEffect', () => {
  it('registers as distortion in category Distortion', () => {
    expect(distortionEffect.id).toBe('distortion');
    expect(distortionEffect.category).toBe('Distortion');
  });

  it('tanh mode keeps |out| <= 10^(outputDb/20) + epsilon', () => {
    const input = sine(440, 0.2, 0.9);
    const outputDb = -3;
    const ceil = Math.pow(10, outputDb / 20);
    const out = run(distortionEffect, [input], { drive: 25, mode: 'tanh', outputDb });
    expect(maxAbs(out[0])).toBeLessThanOrEqual(ceil + 1e-4);
  });

  it('heavy tanh drive squares off a sine (RMS/peak ratio > 0.9)', () => {
    const input = sine(440, 0.2, 0.9);
    const out = run(distortionEffect, [input], { drive: 50, mode: 'tanh', outputDb: -3 });
    const ratio = rms(out[0]) / maxAbs(out[0]);
    expect(ratio).toBeGreaterThan(0.9);
  });

  it('hardclip clamps exactly to +/-1 before the output gain (outputDb 0)', () => {
    // drive 10, values well past 0.1 saturate to the +/-1 rail.
    const input = Float32Array.from([1, -1, 0.5, -0.5, 0.05, -0.05]);
    const out = run(distortionEffect, [input], { drive: 10, mode: 'hardclip', outputDb: 0 });
    expect(out[0][0]).toBeCloseTo(1, 6); // 1*10 clamped -> 1
    expect(out[0][1]).toBeCloseTo(-1, 6);
    expect(out[0][2]).toBeCloseTo(1, 6); // 0.5*10 clamped -> 1
    expect(out[0][3]).toBeCloseTo(-1, 6);
    expect(out[0][4]).toBeCloseTo(0.5, 6); // 0.05*10 = 0.5, in-range
    expect(out[0][5]).toBeCloseTo(-0.5, 6);
  });

  it('foldback reflects overshoot back into [-1, 1]', () => {
    const input = Float32Array.from([0.3]); // 0.3*10 = 3 -> fold -> 2-3 = -1
    const out = run(distortionEffect, [input], { drive: 10, mode: 'foldback', outputDb: 0 });
    expect(out[0][0]).toBeCloseTo(-1, 6);
    expect(Math.abs(out[0][0])).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('foldback outputs 0 for non-finite samples (NaN) instead of propagating them (Task F8)', () => {
    const input = Float32Array.from([Number.NaN, 0.05]);
    const out = run(distortionEffect, [input], { drive: 10, mode: 'foldback', outputDb: 0 });
    expect(out[0][0]).toBe(0);
    expect(out[0][1]).toBeCloseTo(0.5, 6); // neighbors unaffected
  });

  it('foldback outputs 0 for Infinity input without hanging (Task F8)', () => {
    const input = Float32Array.from([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
    const out = run(distortionEffect, [input], { drive: 10, mode: 'foldback', outputDb: 0 });
    expect(out[0][0]).toBe(0);
    expect(out[0][1]).toBe(0);
  });

  it('foldback terminates within the 64-iteration cap on huge finite values and clamps to [-1, 1] (Task F8)', () => {
    // 1e20 * drive: float rounding makes `2 - v === -v`, so the unbounded fold
    // loop never converged before the cap existed.
    const input = Float32Array.from([1e19, -1e19]);
    const out = run(distortionEffect, [input], { drive: 10, mode: 'foldback', outputDb: 0 });
    for (const v of out[0]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
  });

  it('output gain scales the result by 10^(outputDb/20)', () => {
    const input = Float32Array.from([1]);
    const at0 = run(distortionEffect, [input], { drive: 10, mode: 'hardclip', outputDb: 0 })[0][0];
    const atMinus6 = run(distortionEffect, [input], {
      drive: 10,
      mode: 'hardclip',
      outputDb: -6,
    })[0][0];
    expect(atMinus6 / at0).toBeCloseTo(Math.pow(10, -6 / 20), 4);
  });

  it('processes stereo independently without mutating inputs: each channel equals its own mono render', () => {
    // Distinct L/R content — the shaper is memoryless, so a stereo render must
    // be bit-identical to two separate mono renders. Anything that folds L into
    // R (or reuses one channel for both) breaks this exactly.
    const l = sine(440, 0.05, 0.8);
    const r = sine(660, 0.05, 0.3);
    const params = { drive: 15, mode: 'tanh', outputDb: -3 };
    const out = run(distortionEffect, [l, r], params);
    expect(out).toHaveLength(2);
    expect(out[0].length).toBe(l.length);
    out[0].forEach((v) => expect(Number.isFinite(v)).toBe(true));

    const monoL = run(distortionEffect, [l], params)[0];
    const monoR = run(distortionEffect, [r], params)[0];
    expect(Array.from(out[0])).toEqual(Array.from(monoL));
    expect(Array.from(out[1])).toEqual(Array.from(monoR));
    // Sanity: the two channels really are different material, so the equality
    // above is a genuine constraint and not two names for the same buffer.
    expect(Array.from(out[1])).not.toEqual(Array.from(out[0]));
  });

  it('is discoverable via registerAllEffects in category Distortion', () => {
    registerAllEffects();
    const ids = getAllEffects()
      .filter((e) => e.category === 'Distortion')
      .map((e) => e.id);
    expect(ids).toContain('distortion');
  });
});
