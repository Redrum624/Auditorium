import { channelMixerEffect } from './ChannelMixerEffect';
import { panEffect } from './PanEffect';
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

describe('channelMixerEffect', () => {
  it('registers as channel-mixer in category Stereo', () => {
    expect(channelMixerEffect.id).toBe('channel-mixer');
    expect(channelMixerEffect.category).toBe('Stereo');
  });

  it('the swap preset (ll 0, lr 100, rl 100, rr 0) swaps channels exactly', () => {
    const l = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
    const r = Float32Array.from([-0.5, -0.6, -0.7, -0.8]);
    const out = run(channelMixerEffect, [l, r], {
      llGain: 0,
      lrGain: 100,
      rlGain: 100,
      rrGain: 0,
    });
    expect(Array.from(out[0])).toEqual(Array.from(r));
    expect(Array.from(out[1])).toEqual(Array.from(l));
  });

  it('identity preset (100/0/0/100) passes both channels through unchanged', () => {
    const l = Float32Array.from([0.1, 0.2, 0.3]);
    const r = Float32Array.from([0.4, 0.5, 0.6]);
    const out = run(channelMixerEffect, [l, r]); // defaults
    expect(Array.from(out[0])).toEqual(Array.from(l));
    expect(Array.from(out[1])).toEqual(Array.from(r));
  });

  it('mono input is returned as an unchanged copy (not the same reference)', () => {
    const m = Float32Array.from([0.1, -0.2, 0.3]);
    const result = channelMixerEffect.process([m], SR, {
      llGain: 0,
      lrGain: 100,
      rlGain: 100,
      rrGain: 0,
    });
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0]).not.toBe(m);
    expect(Array.from(result.channels[0])).toEqual(Array.from(m));
  });

  it('mixes with percentage weights: newL = (ll*L + lr*R)/100', () => {
    const l = Float32Array.from([0.4]);
    const r = Float32Array.from([0.2]);
    const out = run(channelMixerEffect, [l, r], {
      llGain: 50,
      lrGain: 50,
      rlGain: 100,
      rrGain: -100,
    });
    expect(out[0][0]).toBeCloseTo((50 * 0.4 + 50 * 0.2) / 100, 6); // 0.3
    expect(out[1][0]).toBeCloseTo((100 * 0.4 + -100 * 0.2) / 100, 6); // 0.2
  });
});

describe('panEffect', () => {
  it('registers as pan in category Stereo', () => {
    expect(panEffect.id).toBe('pan');
    expect(panEffect.category).toBe('Stereo');
  });

  it('full left (pan -100): L gain 1, R silenced', () => {
    const l = sine(440, 0.05, 0.8);
    const r = sine(440, 0.05, 0.8);
    const out = run(panEffect, [l, r], { pan: -100 });
    expect(rms(out[0])).toBeCloseTo(rms(l), 5); // cos(0) = 1
    expect(rms(out[1])).toBeCloseTo(0, 6); // sin(0) = 0
  });

  it('full right (pan +100): R gain 1, L silenced', () => {
    const l = sine(440, 0.05, 0.8);
    const r = sine(440, 0.05, 0.8);
    const out = run(panEffect, [l, r], { pan: 100 });
    expect(rms(out[1])).toBeCloseTo(rms(r), 5); // sin(pi/2) = 1
    expect(rms(out[0])).toBeCloseTo(0, 6); // cos(pi/2) = 0
  });

  it('center (pan 0): constant-power law attenuates both channels by cos(pi/4)', () => {
    const l = Float32Array.from([1, 1, 1, 1]);
    const r = Float32Array.from([0.5, 0.5, 0.5, 0.5]);
    const out = run(panEffect, [l, r], { pan: 0 });
    const g = Math.cos(Math.PI / 4); // = sin(pi/4) ~= 0.7071
    expect(out[0][0]).toBeCloseTo(1 * g, 6);
    expect(out[1][0]).toBeCloseTo(0.5 * g, 6);
  });

  it('mono input is returned as an unchanged copy (not the same reference)', () => {
    const m = Float32Array.from([0.1, -0.2, 0.3]);
    const result = panEffect.process([m], SR, { pan: -100 });
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0]).not.toBe(m);
    expect(Array.from(result.channels[0])).toEqual(Array.from(m));
  });
});

describe('stereo effects registration', () => {
  it('registerAllEffects exposes channel-mixer and pan in category Stereo', () => {
    registerAllEffects();
    const stereoIds = getAllEffects()
      .filter((e) => e.category === 'Stereo')
      .map((e) => e.id);
    expect(stereoIds).toEqual(expect.arrayContaining(['channel-mixer', 'pan']));
  });

  it('the registry holds at least 19 effects after all four new ones register', () => {
    registerAllEffects();
    expect(getAllEffects().length).toBeGreaterThanOrEqual(19);
  });
});
