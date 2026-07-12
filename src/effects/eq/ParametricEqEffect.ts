import type { EffectDefinition, EffectParamDef } from '../types';
import { designBiquad, processBiquad, type BiquadType } from '../../dsp/biquad';

const HP_LP_Q = Math.SQRT1_2; // Butterworth q for the HP/LP stages

/** Per-band defaults: center frequency and whether it's on by default. */
const BAND_DEFAULTS: { freq: number; enabled: boolean }[] = [
  { freq: 100, enabled: true },
  { freq: 400, enabled: true },
  { freq: 1000, enabled: true },
  { freq: 4000, enabled: false },
  { freq: 10000, enabled: false },
];

/** Builds the flat param list in brief order: HP, band1..5, LP. */
function buildParams(): EffectParamDef[] {
  const params: EffectParamDef[] = [
    { id: 'hpEnabled', label: 'High-Pass', type: 'boolean', default: false },
    { id: 'hpFreq', label: 'HP Freq', type: 'number', min: 20, max: 1000, step: 1, unit: 'Hz', default: 80 },
  ];

  for (let i = 0; i < BAND_DEFAULTS.length; i++) {
    const n = i + 1;
    const { freq, enabled } = BAND_DEFAULTS[i];
    params.push({ id: `band${n}Enabled`, label: `Band ${n}`, type: 'boolean', default: enabled });
    params.push({
      id: `band${n}Freq`,
      label: `Band ${n} Freq`,
      type: 'number',
      min: 20,
      max: 20000,
      step: 1,
      unit: 'Hz',
      default: freq,
    });
    params.push({
      id: `band${n}Gain`,
      label: `Band ${n} Gain`,
      type: 'number',
      min: -18,
      max: 18,
      step: 0.1,
      unit: 'dB',
      default: 0,
    });
    params.push({
      id: `band${n}Q`,
      label: `Band ${n} Q`,
      type: 'number',
      min: 0.3,
      max: 10,
      step: 0.1,
      default: 1.0,
    });
    if (n === 1) {
      params.push({
        id: 'band1Type',
        label: 'Band 1 Type',
        type: 'select',
        options: [
          { value: 'peaking', label: 'Peaking' },
          { value: 'lowshelf', label: 'Low Shelf' },
        ],
        default: 'peaking',
      });
    }
    if (n === 5) {
      params.push({
        id: 'band5Type',
        label: 'Band 5 Type',
        type: 'select',
        options: [
          { value: 'peaking', label: 'Peaking' },
          { value: 'highshelf', label: 'High Shelf' },
        ],
        default: 'peaking',
      });
    }
  }

  params.push({ id: 'lpEnabled', label: 'Low-Pass', type: 'boolean', default: false });
  params.push({
    id: 'lpFreq',
    label: 'LP Freq',
    type: 'number',
    min: 1000,
    max: 20000,
    step: 1,
    unit: 'Hz',
    default: 12000,
  });

  return params;
}

/**
 * 5-band parametric EQ with optional high-pass and low-pass. Bands 2-4 are
 * always peaking; band 1 may be peaking or low-shelf, band 5 peaking or
 * high-shelf. Enabled stages are cascaded (in HP -> band1..5 -> LP order)
 * once per `process()` call, sharing coefficients across channels but
 * running independent filter state per channel.
 */
export const parametricEqEffect: EffectDefinition = {
  id: 'parametric-eq',
  name: 'Parametric EQ',
  category: 'EQ & Filters',
  params: buildParams(),
  process(channels, sampleRate, params, onProgress) {
    const nyquist = sampleRate / 2;
    const stages: { type: BiquadType; freq: number; q: number; gainDb?: number }[] = [];

    if (Boolean(params.hpEnabled ?? false)) {
      const freq = Number(params.hpFreq ?? 80);
      if (freq < nyquist) stages.push({ type: 'highpass', freq, q: HP_LP_Q });
    }

    for (let n = 1; n <= 5; n++) {
      const defaults = BAND_DEFAULTS[n - 1];
      const enabled = Boolean(params[`band${n}Enabled`] ?? defaults.enabled);
      if (!enabled) continue;
      const freq = Number(params[`band${n}Freq`] ?? defaults.freq);
      if (freq >= nyquist) continue;
      const gainDb = Number(params[`band${n}Gain`] ?? 0);
      const q = Number(params[`band${n}Q`] ?? 1.0);
      let type: BiquadType = 'peaking';
      if (n === 1) type = String(params.band1Type ?? 'peaking') as BiquadType;
      else if (n === 5) type = String(params.band5Type ?? 'peaking') as BiquadType;
      stages.push({ type, freq, q, gainDb });
    }

    if (Boolean(params.lpEnabled ?? false)) {
      const freq = Number(params.lpFreq ?? 12000);
      if (freq < nyquist) stages.push({ type: 'lowpass', freq, q: HP_LP_Q });
    }

    const coeffsList = stages.map((s) => designBiquad(s.type, sampleRate, s.freq, s.q, s.gainDb));

    const out = channels.map((c, chIdx) => {
      let signal: Float32Array = coeffsList.length > 0 ? c : Float32Array.from(c);
      for (const coeffs of coeffsList) signal = processBiquad(signal, coeffs);
      onProgress?.((chIdx + 1) / channels.length);
      return signal;
    });

    return { channels: out };
  },
};
