import { amplifyEffect } from './AmplifyEffect';
import { normalizeEffect } from './NormalizeEffect';
import { fadeEffect } from './FadeEffect';
import { reverseEffect } from './ReverseEffect';
import { invertEffect } from './InvertEffect';
import { dcRemoveEffect } from './DcRemoveEffect';
import type { EffectDefinition } from '../types';

const SR = 44100;

/** Snapshot every input channel so we can assert the effect never mutated them. */
function snapshot(channels: Float32Array[]): number[][] {
  return channels.map((c) => Array.from(c));
}

function expectUnmutated(channels: Float32Array[], before: number[][]): void {
  channels.forEach((c, i) => {
    expect(Array.from(c)).toEqual(before[i]);
  });
}

function run(
  def: EffectDefinition,
  channels: Float32Array[],
  params: Record<string, number | string | boolean> = {}
): Float32Array[] {
  const before = snapshot(channels);
  const result = def.process(channels, SR, params);
  expectUnmutated(channels, before);
  return result.channels;
}

function maxAbs(channels: Float32Array[]): number {
  let m = 0;
  for (const c of channels) for (const v of c) m = Math.max(m, Math.abs(v));
  return m;
}

function mean(c: Float32Array): number {
  let s = 0;
  for (const v of c) s += v;
  return s / c.length;
}

describe('AmplifyEffect', () => {
  it('scales by 10^(gainDb/20) (+6 dB)', () => {
    const factor = Math.pow(10, 6 / 20);
    const input = [Float32Array.from([0.1, 0.2, 0.3, -0.4])];
    const out = run(amplifyEffect, input, { gainDb: 6 });
    out[0].forEach((v, i) => expect(v).toBeCloseTo(input[0][i] * factor, 4));
  });

  it('is identity at 0 dB', () => {
    const input = [Float32Array.from([0.5, -0.25])];
    const out = run(amplifyEffect, input, { gainDb: 0 });
    expect(Array.from(out[0])).toEqual([0.5, -0.25]);
  });
});

describe('NormalizeEffect', () => {
  it('peak mode brings the global max to the target dB', () => {
    const target = Math.pow(10, -0.3 / 20);
    const input = [Float32Array.from([0.25, -0.5, 0.1]), Float32Array.from([0.2, 0.3, -0.4])];
    const out = run(normalizeEffect, input, { targetDb: -0.3, mode: 'peak' });
    expect(maxAbs(out)).toBeCloseTo(target, 4);
  });

  it('leaves an all-zero (silent) input unchanged', () => {
    const input = [new Float32Array(8)];
    const out = run(normalizeEffect, input, { targetDb: -0.3, mode: 'peak' });
    expect(maxAbs(out)).toBe(0);
  });

  it('rms mode hard-clamps to +/-1', () => {
    const input = [Float32Array.from([0.02, -0.02, 0.02, -0.02])];
    const out = run(normalizeEffect, input, { targetDb: -0.3, mode: 'rms' });
    expect(maxAbs(out)).toBeLessThanOrEqual(1 + 1e-6);
  });
});

describe('FadeEffect', () => {
  it('linear fade-in: 0 at start, ~half at midpoint, ~original at end', () => {
    const input = [Float32Array.from([1, 1, 1, 1, 1])];
    const out = run(fadeEffect, input, { direction: 'in', curve: 'linear' });
    expect(out[0][0]).toBeCloseTo(0, 6);
    expect(out[0][2]).toBeCloseTo(0.5, 6);
    expect(out[0][4]).toBeCloseTo(1, 6);
  });

  it('linear fade-out: original at start, ~half at midpoint, 0 at end', () => {
    const input = [Float32Array.from([1, 1, 1, 1, 1])];
    const out = run(fadeEffect, input, { direction: 'out', curve: 'linear' });
    expect(out[0][0]).toBeCloseTo(1, 6);
    expect(out[0][2]).toBeCloseTo(0.5, 6);
    expect(out[0][4]).toBeCloseTo(0, 6);
  });

  it('cosine fade-in is 0.5 at the midpoint', () => {
    const input = [Float32Array.from([1, 1, 1, 1, 1])];
    const out = run(fadeEffect, input, { direction: 'in', curve: 'cosine' });
    expect(out[0][2]).toBeCloseTo(0.5, 6);
  });
});

describe('ReverseEffect', () => {
  it('reversing twice is the exact identity', () => {
    const input = [Float32Array.from([0.1, 0.2, 0.3, 0.4])];
    const original = Array.from(input[0]);
    const once = run(reverseEffect, input, {});
    expect(Array.from(once[0])).toEqual([...original].reverse());
    const twice = reverseEffect.process(once, SR, {}).channels;
    expect(Array.from(twice[0])).toEqual(original);
  });
});

describe('InvertEffect', () => {
  it('inverting twice is the exact identity', () => {
    const input = [Float32Array.from([0.1, -0.2, 0.3])];
    const original = Array.from(input[0]);
    const once = run(invertEffect, input, {});
    expect(Array.from(once[0])).toEqual(original.map((v) => -v));
    const twice = invertEffect.process(once, SR, {}).channels;
    expect(Array.from(twice[0])).toEqual(original);
  });
});

describe('DcRemoveEffect', () => {
  it('removes the per-channel DC offset (mean ~ 0)', () => {
    const withDc = new Float32Array(64);
    for (let i = 0; i < withDc.length; i++) {
      withDc[i] = 0.5 + 0.2 * Math.sin((2 * Math.PI * i) / 16);
    }
    const out = run(dcRemoveEffect, [withDc], {});
    expect(Math.abs(mean(out[0]))).toBeLessThan(1e-7);
  });
});
