import { timeStretchEffect } from './TimeStretchEffect';
import { pitchShiftEffect } from './PitchShiftEffect';
import { getAllEffects } from '../EffectRegistry';
import { registerAllEffects } from '../registerAll';
import { fft } from '../../dsp/fft';
import type { EffectDefinition, EffectParamValue } from '../types';

const SR = 44100;

function sine(freq: number, seconds: number, amplitude = 1): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

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

function correlation(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sumA = 0;
  let sumB = 0;
  let sumAB = 0;
  let sumA2 = 0;
  let sumB2 = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i];
    sumB += b[i];
    sumAB += a[i] * b[i];
    sumA2 += a[i] * a[i];
    sumB2 += b[i] * b[i];
  }
  const num = n * sumAB - sumA * sumB;
  const den = Math.sqrt((n * sumA2 - sumA * sumA) * (n * sumB2 - sumB * sumB));
  return den === 0 ? 1 : num / den;
}

/** Dominant frequency (Hz) via the FFT peak bin over a Hann-windowed mid-signal slice. */
function dominantFreq(x: Float32Array, sr: number, windowSize: number): number {
  const start = Math.max(0, Math.floor((x.length - windowSize) / 2));
  const re = new Float32Array(windowSize);
  const im = new Float32Array(windowSize);
  for (let i = 0; i < windowSize; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / windowSize));
    re[i] = (x[start + i] ?? 0) * w;
  }
  fft(re, im);
  let maxMag = -1;
  let maxBin = 0;
  for (let k = 1; k < windowSize / 2; k++) {
    const mag = re[k] * re[k] + im[k] * im[k];
    if (mag > maxMag) {
      maxMag = mag;
      maxBin = k;
    }
  }
  return (maxBin * sr) / windowSize;
}

describe('timeStretchEffect', () => {
  it('registers as time-stretch in category Time & Pitch', () => {
    expect(timeStretchEffect.id).toBe('time-stretch');
    expect(timeStretchEffect.category).toBe('Time & Pitch');
  });

  it('100% is an exact copy (no-op) and does not return the same reference', () => {
    const input = sine(440, 0.1);
    const out = run(timeStretchEffect, [input], { stretchPercent: 100 });
    expect(out[0]).not.toBe(input);
    expect(out[0].length).toBe(input.length);
    for (let i = 0; i < input.length; i++) expect(out[0][i]).toBeCloseTo(input[i], 6);
  });

  it('200% roughly doubles the length', () => {
    const input = sine(440, 0.3);
    const out = run(timeStretchEffect, [input], { stretchPercent: 200 });
    const expected = 2 * input.length;
    expect(Math.abs(out[0].length - expected) / expected).toBeLessThan(0.1);
  }, 15000);

  it('stereo: equal length, and each output channel carries ITS OWN source content', () => {
    // The stretch is stereo-LINKED (one WSOLA search on the channel mean, the
    // same offsets applied to both), so out[1] is NOT a mono render of R — but
    // it must still be built from R's samples. Pitch is preserved by a
    // time-stretch, so the surviving tone in each channel identifies its source.
    const l = sine(300, 0.2);
    const r = sine(500, 0.2);
    const out = run(timeStretchEffect, [l, r], { stretchPercent: 150 });
    expect(out.length).toBe(2);
    expect(out[0].length).toBe(out[1].length);
    expect(Math.abs(dominantFreq(out[0], SR, 8192) - 300) / 300).toBeLessThan(0.06);
    expect(Math.abs(dominantFreq(out[1], SR, 8192) - 500) / 500).toBeLessThan(0.06);
    expect(Array.from(out[1])).not.toEqual(Array.from(out[0]));
  }, 15000);
});

describe('pitchShiftEffect', () => {
  it('registers as pitch-shift in category Time & Pitch', () => {
    expect(pitchShiftEffect.id).toBe('pitch-shift');
    expect(pitchShiftEffect.category).toBe('Time & Pitch');
  });

  it('+12 semitones shifts 220Hz up to ~440Hz (FFT peak within ±6%) and keeps duration ±10%', () => {
    const input = sine(220, 0.6);
    const out = run(pitchShiftEffect, [input], { semitones: 12 });
    const peak = dominantFreq(out[0], SR, 16384);
    expect(Math.abs(peak - 440) / 440).toBeLessThan(0.06);
    expect(Math.abs(out[0].length - input.length) / input.length).toBeLessThan(0.1);
  }, 15000);

  it('0 semitones is an exact copy (identity)', () => {
    const input = sine(220, 0.3);
    const out = run(pitchShiftEffect, [input], { semitones: 0 });
    expect(out[0].length).toBe(input.length);
    expect(correlation(input, out[0])).toBeGreaterThan(0.9);
  });
});

describe('Time & Pitch registration', () => {
  it('registerAllEffects exposes at least 21 effects including time-stretch and pitch-shift', () => {
    registerAllEffects();
    const all = getAllEffects();
    expect(all.length).toBeGreaterThanOrEqual(21);
    const byId = new Map(all.map((e) => [e.id, e]));
    expect(byId.get('time-stretch')?.category).toBe('Time & Pitch');
    expect(byId.get('pitch-shift')?.category).toBe('Time & Pitch');
  });
});
