import type { EffectDefinition } from '../types';

/**
 * Normalize to a target level. Peak mode scales so the loudest sample across all
 * channels hits the target; RMS mode scales so the global RMS hits the target,
 * then hard-clamps to +/-1. A silent (all-zero) input is returned unchanged.
 */
export const normalizeEffect: EffectDefinition = {
  id: 'normalize',
  name: 'Normalize',
  category: 'Amplitude',
  params: [
    { id: 'targetDb', label: 'Target', type: 'number', min: -60, max: 0, step: 0.1, unit: 'dB', default: -0.3 },
    {
      id: 'mode',
      label: 'Mode',
      type: 'select',
      options: [
        { value: 'peak', label: 'Peak' },
        { value: 'rms', label: 'RMS' },
      ],
      default: 'peak',
    },
  ],
  process(channels, _sampleRate, params, onProgress) {
    const targetDb = Number(params.targetDb ?? -0.3);
    const mode = String(params.mode ?? 'peak');
    const targetLinear = Math.pow(10, targetDb / 20);

    let measure = 0;
    if (mode === 'rms') {
      let sumSq = 0;
      let count = 0;
      for (const c of channels) {
        for (let i = 0; i < c.length; i++) sumSq += c[i] * c[i];
        count += c.length;
      }
      measure = count > 0 ? Math.sqrt(sumSq / count) : 0;
    } else {
      for (const c of channels) {
        for (let i = 0; i < c.length; i++) {
          const a = Math.abs(c[i]);
          if (a > measure) measure = a;
        }
      }
    }

    // Silent input (or no samples): nothing to normalize — return copies.
    const scale = measure > 0 ? targetLinear / measure : 1;
    const clamp = mode === 'rms';

    const out = channels.map((c) => {
      const dst = new Float32Array(c.length);
      for (let i = 0; i < c.length; i++) {
        let v = c[i] * scale;
        if (clamp) {
          if (v > 1) v = 1;
          else if (v < -1) v = -1;
        }
        dst[i] = v;
      }
      return dst;
    });
    channels.forEach((_, i) => onProgress?.((i + 1) / channels.length));
    return { channels: out };
  },
};
