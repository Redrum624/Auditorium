import { echoEffect } from './EchoEffect';
import { reverbEffect } from './ReverbEffect';
import { chorusEffect } from './ChorusEffect';
import { flangerEffect } from './FlangerEffect';
import {
  matchTempoVariableEffect,
  MATCH_TEMPO_VARIABLE_EFFECT_ID,
  type MatchTempoVariableExtra,
} from './MatchTempoVariableEffect';
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

function impulse(n = 1): Float32Array {
  const out = new Float32Array(n);
  out[0] = 1;
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

function energy(signal: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let i = Math.max(0, start); i < Math.min(end, signal.length); i++) sum += signal[i] * signal[i];
  return sum;
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

function expectFinite(signal: Float32Array): void {
  signal.forEach((v) => expect(Number.isFinite(v)).toBe(true));
}

describe('echoEffect', () => {
  it('registers as echo in category Delay & Reverb', () => {
    expect(echoEffect.id).toBe('echo');
    expect(echoEffect.category).toBe('Delay & Reverb');
  });

  it('impulse produces pulses at 0 (dry, 1-mix), D (~mix), 2D (~mix*feedback), within +/-20%', () => {
    const delayMs = 100;
    const feedback = 0.5;
    const mix = 0.4;
    const D = Math.round((delayMs / 1000) * SR);
    const input = impulse(1);
    const out = run(echoEffect, [input], { delayMs, feedback, mix, pingPong: false });

    expect(out[0][0]).toBeCloseTo(1 - mix, 5);

    const echo1 = out[0][D];
    expect(echo1).toBeGreaterThan(mix * 0.8);
    expect(echo1).toBeLessThan(mix * 1.2);

    const echo2 = out[0][2 * D];
    const expected2 = mix * feedback;
    expect(echo2).toBeGreaterThan(expected2 * 0.8);
    expect(echo2).toBeLessThan(expected2 * 1.2);
  });

  it('output is longer than the input (tail extension)', () => {
    const input = impulse(100);
    const out = run(echoEffect, [input], { delayMs: 350, feedback: 0.35, mix: 0.35 });
    expect(out[0].length).toBeGreaterThan(input.length);
  });

  it('ping-pong: impulse in L only puts the first echo mostly in R (>3x the L sample at the same index)', () => {
    const delayMs = 80;
    const feedback = 0.4;
    const mix = 0.5;
    const D = Math.round((delayMs / 1000) * SR);
    const inL = impulse(1);
    const inR = new Float32Array(1);
    const out = run(echoEffect, [inL, inR], { delayMs, feedback, mix, pingPong: true });

    const echoL = Math.abs(out[0][D]);
    const echoR = Math.abs(out[1][D]);
    expect(echoR).toBeGreaterThan(3 * echoL);
    expect(echoR).toBeGreaterThan(mix * 0.5);
  });

  it('mono ignores pingPong (behaves like the non-pingpong impulse case)', () => {
    const delayMs = 100;
    const feedback = 0.5;
    const mix = 0.4;
    const D = Math.round((delayMs / 1000) * SR);
    const input = impulse(1);
    const out = run(echoEffect, [input], { delayMs, feedback, mix, pingPong: true });
    expect(out[0][D]).toBeGreaterThan(mix * 0.8);
    expect(out[0][D]).toBeLessThan(mix * 1.2);
  });
});

describe('reverbEffect', () => {
  it('registers as reverb in category Delay & Reverb', () => {
    expect(reverbEffect.id).toBe('reverb');
    expect(reverbEffect.category).toBe('Delay & Reverb');
  });

  it('impulse: energy in a window around 0.5s is nonzero', () => {
    const input = impulse(1);
    const out = run(reverbEffect, [input], { roomSize: 0.5, damping: 0.5, mix: 1, preDelayMs: 0 });
    const start = Math.round(0.5 * SR);
    const end = Math.round(0.6 * SR);
    expect(energy(out[0], start, end)).toBeGreaterThan(0);
  });

  it('decays over time: energy in [1.5s,2s] < energy in [0.2s,0.7s]', () => {
    const input = impulse(1);
    const out = run(reverbEffect, [input], { roomSize: 0.5, damping: 0.5, mix: 1, preDelayMs: 0 });
    const early = energy(out[0], Math.round(0.2 * SR), Math.round(0.7 * SR));
    const late = energy(out[0], Math.round(1.5 * SR), Math.round(2.0 * SR));
    expect(late).toBeLessThan(early);
  });

  it('mix=0 is an exact dry passthrough for [0,N) and still extends the tail', () => {
    const input = sine(440, 0.05, 0.5);
    const out = run(reverbEffect, [input], { roomSize: 0.5, damping: 0.5, mix: 0, preDelayMs: 10 });
    expect(out[0].length).toBeGreaterThan(input.length);
    for (let i = 0; i < input.length; i++) {
      expect(out[0][i]).toBeCloseTo(input[i], 6);
    }
  });

  it('larger roomSize sustains more tail energy at 1.5s than a smaller roomSize', () => {
    const input = impulse(1);
    const outBig = run(reverbEffect, [input], { roomSize: 0.9, damping: 0.5, mix: 1, preDelayMs: 0 });
    const outSmall = run(reverbEffect, [input], { roomSize: 0.1, damping: 0.5, mix: 1, preDelayMs: 0 });
    const start = Math.round(1.5 * SR);
    const end = Math.round(1.6 * SR);
    const bigEnergy = energy(outBig[0], start, end);
    const smallEnergy = energy(outSmall[0], start, end);
    expect(bigEnergy).toBeGreaterThan(smallEnergy);
  });

  it('produces only finite samples', () => {
    const input = impulse(1);
    const out = run(reverbEffect, [input], { roomSize: 0.9, damping: 0.1, mix: 0.5, preDelayMs: 20 });
    expectFinite(out[0]);
  });
});

describe('chorusEffect', () => {
  it('registers as chorus in category Modulation', () => {
    expect(chorusEffect.id).toBe('chorus');
    expect(chorusEffect.category).toBe('Modulation');
  });

  it('output length equals input length', () => {
    const input = sine(440, 0.5);
    const out = run(chorusEffect, [input], {});
    expect(out[0].length).toBe(input.length);
  });

  it('RMS stays within +/-6dB of the input for a sine', () => {
    const input = sine(440, 0.5, 0.5);
    const out = run(chorusEffect, [input], { rateHz: 0.8, depthMs: 7, mix: 0.5, voices: '2' });
    const gainDb = 20 * Math.log10(rms(out[0]) / rms(input));
    expect(Math.abs(gainDb)).toBeLessThan(6);
  });

  it('output differs meaningfully from the input (correlation < 0.999)', () => {
    const input = sine(440, 0.5, 0.5);
    const out = run(chorusEffect, [input], { rateHz: 0.8, depthMs: 7, mix: 0.5, voices: '3' });
    expect(correlation(input, out[0])).toBeLessThan(0.999);
  });

  it('produces only finite samples and does not mutate input', () => {
    const input = sine(440, 0.3, 0.5);
    const out = run(chorusEffect, [input], {});
    expectFinite(out[0]);
  });

  it('mix=0 is a BIT-IDENTICAL dry passthrough (not merely close)', () => {
    const input = sine(440, 0.1, 0.5);
    const out = run(chorusEffect, [input], { rateHz: 0.8, depthMs: 7, mix: 0, voices: '2' });
    expect(Array.from(out[0])).toEqual(Array.from(input));
  });

  it('mix=1 carries NO dry component: the pre-delay head is exactly silent', () => {
    // Every voice reads at BASE_DELAY_MS (20ms) +/- depthMs (7ms), so the
    // earliest possible tap is 13ms = 573 samples back; before that the wet
    // signal is exactly 0. Any dry leakage would show up immediately here.
    const input = sine(440, 0.1, 0.5);
    const out = run(chorusEffect, [input], { rateHz: 0.8, depthMs: 7, mix: 1, voices: '2' });
    for (let i = 0; i < 500; i++) expect(out[0][i]).toBe(0);
    expect(rms(input, 0, 500)).toBeGreaterThan(0.1); // the dry signal is loud there
    expect(rms(out[0], 2000, out[0].length)).toBeGreaterThan(0.1); // and wet arrives later
  });

  it('every declared parameter is actually read: moving each off its default changes the output', () => {
    const input = sine(440, 0.2, 0.5);
    const base = { rateHz: 0.8, depthMs: 7, mix: 0.5, voices: '2' };
    const ref = run(chorusEffect, [input], base);
    const differs = (params: Record<string, EffectParamValue>): boolean => {
      const out = run(chorusEffect, [input], { ...base, ...params });
      return out[0].some((v, i) => v !== ref[0][i]);
    };
    expect(differs({ rateHz: 4 })).toBe(true);
    expect(differs({ depthMs: 1 })).toBe(true);
    expect(differs({ mix: 0.9 })).toBe(true);
    expect(differs({ voices: '3' })).toBe(true);
  });
});

describe('flangerEffect', () => {
  it('registers as flanger in category Modulation', () => {
    expect(flangerEffect.id).toBe('flanger');
    expect(flangerEffect.category).toBe('Modulation');
  });

  it('output length equals input length', () => {
    const input = sine(440, 0.5);
    const out = run(flangerEffect, [input], {});
    expect(out[0].length).toBe(input.length);
  });

  it('RMS stays within +/-6dB of the input for a sine', () => {
    const input = sine(440, 0.5, 0.5);
    const out = run(flangerEffect, [input], { rateHz: 0.25, depthMs: 2, feedback: 0.5, mix: 0.5 });
    const gainDb = 20 * Math.log10(rms(out[0]) / rms(input));
    expect(Math.abs(gainDb)).toBeLessThan(6);
  });

  it('output differs meaningfully from the input (correlation < 0.999)', () => {
    const input = sine(440, 0.5, 0.5);
    const out = run(flangerEffect, [input], { rateHz: 0.25, depthMs: 2, feedback: 0.5, mix: 0.5 });
    expect(correlation(input, out[0])).toBeLessThan(0.999);
  });

  it('produces only finite samples and does not mutate input', () => {
    const input = sine(440, 0.3, 0.5);
    const out = run(flangerEffect, [input], { feedback: 0.85 });
    expectFinite(out[0]);
  });

  it('mix=0 is a BIT-IDENTICAL dry passthrough (not merely close)', () => {
    const input = sine(440, 0.1, 0.5);
    const out = run(flangerEffect, [input], { rateHz: 0.25, depthMs: 2, feedback: 0.5, mix: 0 });
    expect(Array.from(out[0])).toEqual(Array.from(input));
  });

  it('mix=1 carries NO dry component: the pre-delay head is exactly silent', () => {
    // The unipolar sweep runs from BASE_DELAY_MS (1ms = 44.1 samples) upward,
    // so the tap is exactly 0 for the first 44 output samples; a dry leak would
    // be visible there at once.
    const input = sine(440, 0.1, 0.5);
    const out = run(flangerEffect, [input], { rateHz: 0.25, depthMs: 2, feedback: 0.5, mix: 1 });
    for (let i = 0; i < 40; i++) expect(out[0][i]).toBe(0);
    expect(rms(input, 0, 40)).toBeGreaterThan(0.1); // the dry signal is loud there
    expect(rms(out[0], 2000, out[0].length)).toBeGreaterThan(0.1); // and wet arrives later
  });

  it('every declared parameter is actually read: moving each off its default changes the output', () => {
    const input = sine(440, 0.2, 0.5);
    const base = { rateHz: 0.25, depthMs: 2, feedback: 0.5, mix: 0.5 };
    const ref = run(flangerEffect, [input], base);
    const differs = (params: Record<string, EffectParamValue>): boolean => {
      const out = run(flangerEffect, [input], { ...base, ...params });
      return out[0].some((v, i) => v !== ref[0][i]);
    };
    expect(differs({ rateHz: 2 })).toBe(true);
    expect(differs({ depthMs: 5 })).toBe(true);
    expect(differs({ feedback: 0 })).toBe(true);
    expect(differs({ mix: 0.9 })).toBe(true);
  });
});

describe('time effects registration', () => {
  it('registerAllEffects makes echo/reverb (Delay & Reverb) and chorus/flanger (Modulation) discoverable', () => {
    registerAllEffects();
    const all = getAllEffects();
    const byId = new Map(all.map((e) => [e.id, e]));
    expect(byId.get('echo')?.category).toBe('Delay & Reverb');
    expect(byId.get('reverb')?.category).toBe('Delay & Reverb');
    expect(byId.get('chorus')?.category).toBe('Modulation');
    expect(byId.get('flanger')?.category).toBe('Modulation');
  });

  it('at least 15 effects are registered in total (6 basic + 2 eq + 3 dynamics + 4 time)', () => {
    registerAllEffects();
    expect(getAllEffects().length).toBeGreaterThanOrEqual(15);
  });
});

// ---------------------------------------------------------------------------
// R7 — matchTempoVariableEffect: the side channel and the registration
// ---------------------------------------------------------------------------

describe('matchTempoVariableEffect registration', () => {
  afterEach(() => {
    delete (globalThis as { __effectExtra?: unknown }).__effectExtra;
  });

  it('is registered, hidden, and out of the effects browser', () => {
    registerAllEffects();
    const found = getAllEffects().find((e) => e.id === MATCH_TEMPO_VARIABLE_EFFECT_ID);
    expect(found).toBeDefined();
    expect(matchTempoVariableEffect.hidden).toBe(true);
    expect(matchTempoVariableEffect.category).toBe('Time & Pitch');
    // No params: everything it needs is the confirmed grid on the side channel,
    // so a params-only dialog could never drive it.
    expect(matchTempoVariableEffect.params).toEqual([]);
  });

  it.each([
    ['no extra at all', undefined],
    ['no beats', { beatSamples: undefined, targetSpacing: 1000 }],
    ['one beat', { beatSamples: [0], targetSpacing: 1000 }],
    ['a non-array grid', { beatSamples: 'nope', targetSpacing: 1000 }],
    ['no spacing', { beatSamples: [0, 1000], targetSpacing: undefined }],
    ['a zero spacing', { beatSamples: [0, 1000], targetSpacing: 0 }],
    ['a non-finite spacing', { beatSamples: [0, 1000], targetSpacing: Number.NaN }],
  ])('THROWS rather than silently passing the audio through: %s', (_label, extra) => {
    // Thrown, not swallowed: effectRunner shows an error dialog and applies no
    // edit. Returning the input unchanged would push an undo entry that did
    // nothing and look like the feature silently failing.
    (globalThis as { __effectExtra?: unknown }).__effectExtra = extra;
    const x = new Float32Array(SR).fill(0.25);
    expect(() => matchTempoVariableEffect.process([x], SR, {})).toThrow(/confirmed beat grid/i);
  });

  it('reads the grid off the side channel and actually stretches by it', () => {
    // The wiring test: a map that is computed, threaded through and then not
    // used is the defect F7 shipped 3999/3999 green with. An even 1000-sample
    // grid asked for 2000 must double the LENGTH, and no other value proves
    // the payload arrived.
    const n = 8 * SR;
    const beats: number[] = [];
    for (let i = 0; i * 1000 < n; i++) beats.push(i * 1000);
    (globalThis as { __effectExtra?: MatchTempoVariableExtra }).__effectExtra = {
      beatSamples: beats,
      targetSpacing: 2000,
    };
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 220 * i) / SR);
    const out = matchTempoVariableEffect.process([x], SR, {});
    expect(out.channels[0].length).toBe(2 * n);
  });

  it('honours the spacing it is given, not one it re-derives', () => {
    const n = 4 * SR;
    const beats: number[] = [];
    for (let i = 0; i * 1000 < n; i++) beats.push(i * 1000);
    const x = new Float32Array(n).fill(0.1);

    (globalThis as { __effectExtra?: MatchTempoVariableExtra }).__effectExtra = {
      beatSamples: beats,
      targetSpacing: 500,
    };
    const half = matchTempoVariableEffect.process([x], SR, {});
    expect(half.channels[0].length).toBe(n / 2);

    (globalThis as { __effectExtra?: MatchTempoVariableExtra }).__effectExtra = {
      beatSamples: beats,
      targetSpacing: 1500,
    };
    const longer = matchTempoVariableEffect.process([x], SR, {});
    expect(longer.channels[0].length).toBe(n * 1.5);
  });

  it('reports no removedSpans — it deletes nothing', () => {
    const n = 2 * SR;
    const beats: number[] = [];
    for (let i = 0; i * 1000 < n; i++) beats.push(i * 1000);
    (globalThis as { __effectExtra?: MatchTempoVariableExtra }).__effectExtra = {
      beatSamples: beats,
      targetSpacing: 1200,
    };
    const out = matchTempoVariableEffect.process([new Float32Array(n).fill(0.2)], SR, {});
    expect(out.removedSpans).toBeUndefined();
  });
});
