import type { EffectDefinition } from '../types';

/** Reverses each channel in time. Applying it twice is the exact identity. */
export const reverseEffect: EffectDefinition = {
  id: 'reverse',
  name: 'Reverse',
  category: 'Utility',
  params: [],
  process(channels) {
    const out = channels.map((c) => {
      const dst = new Float32Array(c.length);
      const n = c.length;
      for (let i = 0; i < n; i++) dst[i] = c[n - 1 - i];
      return dst;
    });
    return { channels: out };
  },
};
