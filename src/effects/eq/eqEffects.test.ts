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

  it('does not mutate stereo input channels, and filters each channel with its OWN content', () => {
    const l = sine(300, 0.1);
    const r = sine(500, 0.1);
    const beforeL = Array.from(l);
    const beforeR = Array.from(r);
    const params = {
      ...disableAllBands,
      band1Enabled: true,
      band1Gain: 6,
    };
    const out = parametricEqEffect.process([l, r], SR, params).channels;
    expect(Array.from(l)).toEqual(beforeL);
    expect(Array.from(r)).toEqual(beforeR);

    // Each biquad chain starts from zero state per channel, so a stereo render
    // must be bit-identical to two mono renders. This is what catches a channel
    // loop that reads channels[0] for every output channel.
    const monoL = parametricEqEffect.process([sine(300, 0.1)], SR, params).channels[0];
    const monoR = parametricEqEffect.process([sine(500, 0.1)], SR, params).channels[0];
    expect(Array.from(out[0])).toEqual(Array.from(monoL));
    expect(Array.from(out[1])).toEqual(Array.from(monoR));
    expect(Array.from(out[1])).not.toEqual(Array.from(out[0]));
  });

  it('skips a band whose frequency is at/above Nyquist instead of throwing', () => {
    const lowSr = 8000; // Nyquist = 4000; band5 default freq is 10000
    const input = sine(1000, 0.1, lowSr);
    expect(() =>
      parametricEqEffect.process([input], lowSr, { band5Enabled: true })
    ).not.toThrow();
  });

  it('pins the complete param id order: hp, band1(+type)..band4, band5(+type), lp', () => {
    expect(parametricEqEffect.params.map((p) => p.id)).toEqual([
      'hpEnabled',
      'hpFreq',
      'band1Enabled',
      'band1Freq',
      'band1Gain',
      'band1Q',
      'band1Type',
      'band2Enabled',
      'band2Freq',
      'band2Gain',
      'band2Q',
      'band3Enabled',
      'band3Freq',
      'band3Gain',
      'band3Q',
      'band4Enabled',
      'band4Freq',
      'band4Gain',
      'band4Q',
      'band5Enabled',
      'band5Freq',
      'band5Gain',
      'band5Q',
      'band5Type',
      'lpEnabled',
      'lpFreq',
    ]);
  });

  it('band1Type=lowshelf +12dB @100Hz boosts a 30Hz probe ~x4, diverging >2x from peaking', () => {
    const base = {
      ...disableAllBands,
      band1Enabled: true,
      band1Freq: 100,
      band1Gain: 12,
      band1Q: 1,
    };
    const shelfGain = probeGain(parametricEqEffect, 30, { ...base, band1Type: 'lowshelf' });
    const peakGain = probeGain(parametricEqEffect, 30, { ...base, band1Type: 'peaking' });
    // Low-shelf boosts everything below its corner (~x4 at 30Hz); a Q=1 peaking
    // bell centered at 100Hz has already fallen back near unity by 30Hz.
    expect(Math.abs(shelfGain - 4) / 4).toBeLessThan(0.1);
    expect(shelfGain / peakGain).toBeGreaterThan(2);
  });

  it('band5Type=highshelf +12dB @10kHz boosts a 16kHz probe ~x4, diverging >2x from peaking', () => {
    const base = {
      ...disableAllBands,
      band5Enabled: true,
      band5Freq: 10000,
      band5Gain: 12,
      band5Q: 1,
    };
    const shelfGain = probeGain(parametricEqEffect, 16000, { ...base, band5Type: 'highshelf' });
    const peakGain = probeGain(parametricEqEffect, 16000, { ...base, band5Type: 'peaking' });
    // High-shelf boosts everything above its corner (~x4 at 16kHz); a Q=1
    // peaking bell centered at 10kHz has largely fallen back by 16kHz.
    expect(Math.abs(shelfGain - 4) / 4).toBeLessThan(0.1);
    expect(shelfGain / peakGain).toBeGreaterThan(2);
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

  it('does not mutate input channels, and filters each channel with its OWN content', () => {
    const l = sine(300, 0.1);
    const r = sine(500, 0.1);
    const beforeL = Array.from(l);
    const beforeR = Array.from(r);
    const out = graphicEqEffect.process([l, r], SR, { g250: 8 }).channels;
    expect(Array.from(l)).toEqual(beforeL);
    expect(Array.from(r)).toEqual(beforeR);

    const monoL = graphicEqEffect.process([sine(300, 0.1)], SR, { g250: 8 }).channels[0];
    const monoR = graphicEqEffect.process([sine(500, 0.1)], SR, { g250: 8 }).channels[0];
    expect(Array.from(out[0])).toEqual(Array.from(monoL));
    expect(Array.from(out[1])).toEqual(Array.from(monoR));
    expect(Array.from(out[1])).not.toEqual(Array.from(out[0]));
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
