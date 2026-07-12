import { parametricEqEffect } from './ParametricEqEffect';
import { graphicEqEffect } from './GraphicEqEffect';
import { getAllEffects } from '../EffectRegistry';
import { registerAllEffects } from '../registerAll';
import type { EffectDefinition, EffectParamValue } from '../types';

const SR = 44100;
const SKIP = 1000; // samples of transient to discard before measuring RMS

function sine(freq: number, seconds: number, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

function rms(signal: Float32Array, skip = 0): number {
  let sum = 0;
  let count = 0;
  for (let i = skip; i < signal.length; i++) {
    sum += signal[i] * signal[i];
    count++;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

/** Steady-state RMS gain: process a probe sine and compare output/input RMS,
 * both measured after skipping the filter's transient. */
function probeGain(
  def: EffectDefinition,
  freq: number,
  params: Record<string, EffectParamValue>
): number {
  const input = sine(freq, 0.5);
  const before = Array.from(input);
  const out = def.process([input], SR, params).channels;
  // No input mutation.
  expect(Array.from(input)).toEqual(before);
  const inRms = rms(input, SKIP);
  const outRms = rms(out[0], SKIP);
  return outRms / inRms;
}

describe('parametricEqEffect', () => {
  const disableAllBands = {
    hpEnabled: false,
    band1Enabled: false,
    band2Enabled: false,
    band3Enabled: false,
    band4Enabled: false,
    band5Enabled: false,
    lpEnabled: false,
  };

  it('registers as parametric-eq in category EQ & Filters', () => {
    expect(parametricEqEffect.id).toBe('parametric-eq');
    expect(parametricEqEffect.category).toBe('EQ & Filters');
  });

  it('+12dB band3 @1kHz boosts a 1kHz sine by ~x3.98 (+/-5%)', () => {
    const params = {
      ...disableAllBands,
      band3Enabled: true,
      band3Freq: 1000,
      band3Gain: 12,
      band3Q: 1,
    };
    const gain = probeGain(parametricEqEffect, 1000, params);
    const expected = Math.pow(10, 12 / 20); // ~3.981
    expect(Math.abs(gain - expected) / expected).toBeLessThan(0.05);
  });

  it('+12dB band3 @1kHz leaves a 100Hz sine ~unity (+/-10%)', () => {
    const params = {
      ...disableAllBands,
      band3Enabled: true,
      band3Freq: 1000,
      band3Gain: 12,
      band3Q: 1,
    };
    const gain = probeGain(parametricEqEffect, 100, params);
    expect(Math.abs(gain - 1)).toBeLessThan(0.1);
  });

  it('HP enabled @200Hz kills a 40Hz sine (RMS < 0.05x)', () => {
    const params = {
      ...disableAllBands,
      hpEnabled: true,
      hpFreq: 200,
    };
    const gain = probeGain(parametricEqEffect, 40, params);
    expect(gain).toBeLessThan(0.05);
  });

  it('LP enabled @1kHz passes a 100Hz sine near-unity and attenuates a 10kHz sine', () => {
    const params = {
      ...disableAllBands,
      lpEnabled: true,
      lpFreq: 1000,
    };
    const passGain = probeGain(parametricEqEffect, 100, params);
    expect(Math.abs(passGain - 1)).toBeLessThan(0.1);
    const stopGain = probeGain(parametricEqEffect, 10000, params);
    expect(stopGain).toBeLessThan(0.1);
  });

  it('all-defaults cascade is identity within 1e-3 RMS (band1-3 enabled at 0dB + HP/LP off)', () => {
    const input = sine(1000, 0.3);
    const before = Array.from(input);
    const out = parametricEqEffect.process([input], SR, {}).channels;
    expect(Array.from(input)).toEqual(before);
    const diff = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) diff[i] = out[0][i] - input[i];
    expect(rms(diff, SKIP)).toBeLessThan(1e-3);
  });

  it('does not mutate stereo input channels', () => {
    const l = sine(300, 0.1);
    const r = sine(500, 0.1);
    const beforeL = Array.from(l);
    const beforeR = Array.from(r);
    parametricEqEffect.process([l, r], SR, {
      ...disableAllBands,
      band1Enabled: true,
      band1Gain: 6,
    });
    expect(Array.from(l)).toEqual(beforeL);
    expect(Array.from(r)).toEqual(beforeR);
  });

  it('skips a band whose frequency is at/above Nyquist instead of throwing', () => {
    const lowSr = 8000; // Nyquist = 4000; band5 default freq is 10000
    const input = sine(1000, 0.1, lowSr);
    expect(() =>
      parametricEqEffect.process([input], lowSr, { band5Enabled: true })
    ).not.toThrow();
  });

  it('exposes the exact param ids from the brief, in hp -> band1..5 -> lp order', () => {
    const ids = parametricEqEffect.params.map((p) => p.id);
    expect(ids[0]).toBe('hpEnabled');
    expect(ids[1]).toBe('hpFreq');
    expect(ids[ids.length - 2]).toBe('lpEnabled');
    expect(ids[ids.length - 1]).toBe('lpFreq');
    for (let n = 1; n <= 5; n++) {
      expect(ids).toContain(`band${n}Enabled`);
      expect(ids).toContain(`band${n}Freq`);
      expect(ids).toContain(`band${n}Gain`);
      expect(ids).toContain(`band${n}Q`);
    }
    expect(ids).toContain('band1Type');
    expect(ids).toContain('band5Type');
    expect(ids).not.toContain('band2Type');
    expect(ids).not.toContain('band3Type');
    expect(ids).not.toContain('band4Type');
    // band index order: band1's params must all precede band2's.
    expect(ids.indexOf('band1Q')).toBeLessThan(ids.indexOf('band2Enabled'));
  });

  it('defaults match the brief: band1-3 enabled, band4-5 disabled, HP/LP off', () => {
    const byId = Object.fromEntries(parametricEqEffect.params.map((p) => [p.id, p.default]));
    expect(byId.hpEnabled).toBe(false);
    expect(byId.hpFreq).toBe(80);
    expect(byId.band1Enabled).toBe(true);
    expect(byId.band2Enabled).toBe(true);
    expect(byId.band3Enabled).toBe(true);
    expect(byId.band4Enabled).toBe(false);
    expect(byId.band5Enabled).toBe(false);
    expect(byId.band1Freq).toBe(100);
    expect(byId.band2Freq).toBe(400);
    expect(byId.band3Freq).toBe(1000);
    expect(byId.band4Freq).toBe(4000);
    expect(byId.band5Freq).toBe(10000);
    expect(byId.band1Type).toBe('peaking');
    expect(byId.band5Type).toBe('peaking');
    expect(byId.lpEnabled).toBe(false);
    expect(byId.lpFreq).toBe(12000);
  });
});

describe('graphicEqEffect', () => {
  const GAIN_IDS = ['g31', 'g63', 'g125', 'g250', 'g500', 'g1k', 'g2k', 'g4k', 'g8k', 'g16k'];

  it('registers as graphic-eq in category EQ & Filters with the exact 10 band ids', () => {
    expect(graphicEqEffect.id).toBe('graphic-eq');
    expect(graphicEqEffect.category).toBe('EQ & Filters');
    expect(graphicEqEffect.params.map((p) => p.id)).toEqual(GAIN_IDS);
    expect(graphicEqEffect.params.map((p) => p.label)).toEqual([
      '31 Hz',
      '63 Hz',
      '125 Hz',
      '250 Hz',
      '500 Hz',
      '1 kHz',
      '2 kHz',
      '4 kHz',
      '8 kHz',
      '16 kHz',
    ]);
    graphicEqEffect.params.forEach((p) => {
      expect(p.min).toBe(-12);
      expect(p.max).toBe(12);
      expect(p.default).toBe(0);
    });
  });

  it('g1k=+12 boosts a 1kHz sine ~x4 (+/-10%)', () => {
    const gain = probeGain(graphicEqEffect, 1000, { g1k: 12 });
    expect(Math.abs(gain - 4) / 4).toBeLessThan(0.1);
  });

  it('g1k=+12 leaves a 100Hz sine ~unity (+/-10%)', () => {
    const gain = probeGain(graphicEqEffect, 100, { g1k: 12 });
    expect(Math.abs(gain - 1)).toBeLessThan(0.1);
  });

  it('all-defaults cascade is identity within 1e-3 RMS', () => {
    const input = sine(1000, 0.3);
    const before = Array.from(input);
    const out = graphicEqEffect.process([input], SR, {}).channels;
    expect(Array.from(input)).toEqual(before);
    const diff = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) diff[i] = out[0][i] - input[i];
    expect(rms(diff, SKIP)).toBeLessThan(1e-3);
  });

  it('does not mutate input channels', () => {
    const l = sine(300, 0.1);
    const before = Array.from(l);
    graphicEqEffect.process([l], SR, { g250: 8 });
    expect(Array.from(l)).toEqual(before);
  });

  it('skips a band at/above Nyquist instead of throwing', () => {
    const lowSr = 8000; // Nyquist = 4000; g16k (16000) and g8k (8000) are >= Nyquist
    const input = sine(1000, 0.1, lowSr);
    expect(() =>
      graphicEqEffect.process([input], lowSr, { g16k: 6, g8k: 6 })
    ).not.toThrow();
  });
});

describe('EQ effects registration', () => {
  it('parametric-eq and graphic-eq both appear via getAllEffects', () => {
    registerAllEffects();
    const ids = getAllEffects().map((e) => e.id);
    expect(ids).toContain('parametric-eq');
    expect(ids).toContain('graphic-eq');
  });
});
