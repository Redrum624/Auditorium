import type { EffectDefinition } from '../types';

/** Constant gain in decibels: out = in * 10^(gainDb/20). */
export const amplifyEffect: EffectDefinition = {
  id: 'amplify',
  name: 'Amplify',
  category: 'Amplitude',
  params: [
    { id: 'gainDb', label: 'Gain', type: 'number', min: -60, max: 60, step: 0.1, unit: 'dB', default: 0 },
  ],
  process(channels, _sampleRate, params, onProgress) {
    const gainDb = Number(params.gainDb ?? 0);
    const factor = Math.pow(10, gainDb / 20);
    const out = channels.map((c) => {
      const dst = new Float32Array(c.length);
      for (let i = 0; i < c.length; i++) dst[i] = c[i] * factor;
      return dst;
    });
    channels.forEach((_, i) => onProgress?.((i + 1) / channels.length));
    return { channels: out };
  },
};
