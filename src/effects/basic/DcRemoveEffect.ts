import type { EffectDefinition } from '../types';

/** Removes any DC bias by subtracting each channel's mean. */
export const dcRemoveEffect: EffectDefinition = {
  id: 'dc-remove',
  name: 'Remove DC Offset',
  category: 'Restoration',
  params: [],
  process(channels, _sampleRate, _params, onProgress) {
    const out = channels.map((c) => {
      let sum = 0;
      for (let i = 0; i < c.length; i++) sum += c[i];
      const mean = c.length > 0 ? sum / c.length : 0;
      const dst = new Float32Array(c.length);
      for (let i = 0; i < c.length; i++) dst[i] = c[i] - mean;
      return dst;
    });
    channels.forEach((_, i) => onProgress?.((i + 1) / channels.length));
    return { channels: out };
  },
};
