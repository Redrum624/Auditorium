import type { EffectDefinition } from '../types';

/** Flips polarity (negates every sample). Applying it twice is the exact identity. */
export const invertEffect: EffectDefinition = {
  id: 'invert',
  name: 'Invert',
  category: 'Utility',
  params: [],
  process(channels) {
    const out = channels.map((c) => {
      const dst = new Float32Array(c.length);
      for (let i = 0; i < c.length; i++) dst[i] = -c[i];
      return dst;
    });
    return { channels: out };
  },
};
