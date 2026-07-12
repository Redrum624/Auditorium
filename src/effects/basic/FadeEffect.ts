import type { EffectDefinition } from '../types';

/**
 * Amplitude envelope applied across the full region. Fade-in ramps the gain
 * 0 -> 1; fade-out is its mirror (gain at t equals the fade-in gain at 1 - t),
 * ramping 1 -> 0. Curves: linear g=t, exponential g=t^2, cosine g=(1-cos(pi*t))/2.
 */
export const fadeEffect: EffectDefinition = {
  id: 'fade',
  name: 'Fade',
  category: 'Amplitude',
  params: [
    {
      id: 'direction',
      label: 'Direction',
      type: 'select',
      options: [
        { value: 'in', label: 'Fade In' },
        { value: 'out', label: 'Fade Out' },
      ],
      default: 'in',
    },
    {
      id: 'curve',
      label: 'Curve',
      type: 'select',
      options: [
        { value: 'linear', label: 'Linear' },
        { value: 'exponential', label: 'Exponential' },
        { value: 'cosine', label: 'Cosine' },
      ],
      default: 'linear',
    },
  ],
  process(channels, _sampleRate, params, onProgress) {
    const direction = String(params.direction ?? 'in');
    const curve = String(params.curve ?? 'linear');
    const length = channels[0]?.length ?? 0;

    const curveGain = (t: number): number => {
      switch (curve) {
        case 'exponential':
          return t * t;
        case 'cosine':
          return (1 - Math.cos(Math.PI * t)) / 2;
        default:
          return t;
      }
    };

    // Fade-out mirrors fade-in: gain(t) = fadeInGain(1 - t).
    const gainAt = (i: number): number => {
      const t = length > 1 ? i / (length - 1) : 0;
      return direction === 'out' ? curveGain(1 - t) : curveGain(t);
    };

    const out = channels.map((c) => {
      const dst = new Float32Array(c.length);
      for (let i = 0; i < c.length; i++) dst[i] = c[i] * gainAt(i);
      return dst;
    });
    channels.forEach((_, i) => onProgress?.((i + 1) / channels.length));
    return { channels: out };
  },
};
