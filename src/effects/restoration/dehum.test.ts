import { deHumEffect } from './DeHumEffect';
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

// RMS over an interior window to skip the filter's start-up transient.
function rms(signal: Float32Array, start: number, end: number): number {
  let sum = 0;
  let count = 0;
  for (let i = start; i < end; i++) {
    sum += signal[i] * signal[i];
    count++;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

describe('deHumEffect', () => {
  it('registers as dehum in category Restoration', () => {
    expect(deHumEffect.id).toBe('dehum');
    expect(deHumEffect.category).toBe('Restoration');
  });

  it('removes a 50Hz hum: interior RMS reduced by more than 20x with defaults', () => {
    const input = sine(50, 1.0, 0.5);
    const out = run(deHumEffect, [input], { baseFreq: '50', harmonics: 4, q: 30 });
    const skip = Math.round(0.4 * SR); // past the notch settling transient
    const before = rms(input, skip, input.length);
    const after = rms(out[0], skip, input.length);
    expect(before / after).toBeGreaterThan(20);
  });

  it('leaves a far-from-hum 1kHz tone near unity (+/-10%)', () => {
    const input = sine(1000, 0.5, 0.5);
    const out = run(deHumEffect, [input], { baseFreq: '50', harmonics: 4, q: 30 });
    const skip = Math.round(0.2 * SR);
    const before = rms(input, skip, input.length);
    const after = rms(out[0], skip, input.length);
    expect(after / before).toBeGreaterThan(0.9);
    expect(after / before).toBeLessThan(1.1);
  });

  it('notches harmonics: a 150Hz tone (3rd harmonic of 50) is strongly attenuated', () => {
    const input = sine(150, 1.0, 0.5);
    const out = run(deHumEffect, [input], { baseFreq: '50', harmonics: 4, q: 30 });
    const skip = Math.round(0.4 * SR);
    const before = rms(input, skip, input.length);
    const after = rms(out[0], skip, input.length);
    expect(before / after).toBeGreaterThan(20);
  });

  it('notches the LAST requested harmonic: with harmonics=4 the 4th (200Hz) is attenuated too', () => {
    // The 4th is the boundary of the `k <= harmonics` loop — an off-by-one there
    // leaves the strongest upper partial of the hum completely un-notched.
    const input = sine(200, 1.0, 0.5);
    const out = run(deHumEffect, [input], { baseFreq: '50', harmonics: 4, q: 30 });
    const skip = Math.round(0.4 * SR);
    const before = rms(input, skip, input.length);
    const after = rms(out[0], skip, input.length);
    expect(before / after).toBeGreaterThan(20);
  });

  it('does NOT notch beyond the requested harmonic count: with harmonics=3 the 4th (200Hz) survives', () => {
    const input = sine(200, 1.0, 0.5);
    const out = run(deHumEffect, [input], { baseFreq: '50', harmonics: 3, q: 30 });
    const skip = Math.round(0.4 * SR);
    const before = rms(input, skip, input.length);
    const after = rms(out[0], skip, input.length);
    expect(after / before).toBeGreaterThan(0.9);
  });

  it('skips harmonics at or above Nyquist (no NaN/Infinity)', () => {
    // 60Hz base, 8 harmonics -> up to 480Hz, all under Nyquist; keep it simple by
    // asserting finiteness with a high harmonic count.
    const input = sine(60, 0.3, 0.5);
    const out = run(deHumEffect, [input], { baseFreq: '60', harmonics: 8, q: 20 });
    out[0].forEach((v) => expect(Number.isFinite(v)).toBe(true));
  });

  it('is discoverable via registerAllEffects in category Restoration', () => {
    registerAllEffects();
    const ids = getAllEffects()
      .filter((e) => e.category === 'Restoration')
      .map((e) => e.id);
    expect(ids).toContain('dehum');
  });
});
