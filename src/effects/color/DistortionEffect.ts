import type { EffectDefinition } from '../types';

/**
 * Waveshaping distortion with three transfer curves, a pre-shape `drive` and a
 * post-shape output trim:
 * - tanh: `tanh(x*drive) / tanh(drive)` — smooth saturation, normalized so the
 *   curve reaches +/-1 at full-scale input (unity at drive independence).
 * - hardclip: `clamp(x*drive, -1, 1)` — brick-wall clipping.
 * - foldback: reflect `x*drive` back into [-1, 1] repeatedly (triangle folding).
 * The shaped signal is then scaled by 10^(outputDb/20).
 */
export const distortionEffect: EffectDefinition = {
  id: 'distortion',
  name: 'Distortion',
  category: 'Distortion',
  params: [
    { id: 'drive', label: 'Drive', type: 'number', min: 1, max: 50, step: 0.1, default: 10 },
    {
      id: 'mode',
      label: 'Mode',
      type: 'select',
      options: [
        { value: 'tanh', label: 'Tanh (soft)' },
        { value: 'hardclip', label: 'Hard Clip' },
        { value: 'foldback', label: 'Foldback' },
      ],
      default: 'tanh',
    },
    { id: 'outputDb', label: 'Output', type: 'number', min: -24, max: 0, step: 0.1, unit: 'dB', default: -3 },
  ],
  process(channels, _sampleRate, params, onProgress) {
    const drive = Number(params.drive ?? 10);
    const mode = String(params.mode ?? 'tanh');
    const outputDb = Number(params.outputDb ?? -3);
    const outGain = Math.pow(10, outputDb / 20);
    const tanhDenom = Math.tanh(drive) || 1; // drive >= 1 so this is never 0

    const shape = (x: number): number => {
      if (mode === 'hardclip') {
        const v = x * drive;
        return v > 1 ? 1 : v < -1 ? -1 : v;
      }
      if (mode === 'foldback') {
        let v = x * drive;
        // Non-finite input (NaN/±Infinity) can't fold — emit silence rather
        // than propagate it (Task F8). The fold loop is also capped: for huge
        // finite v, float rounding makes `2 - v === -v`, so the loop would
        // never converge; after 64 reflections we clamp whatever remains.
        if (!Number.isFinite(v)) return 0;
        for (let iter = 0; (v > 1 || v < -1) && iter < 64; iter++) {
          v = v > 1 ? 2 - v : -2 - v;
        }
        return v > 1 ? 1 : v < -1 ? -1 : v;
      }
      // tanh (default)
      return Math.tanh(x * drive) / tanhDenom;
    };

    const out = channels.map((c) => {
      const dst = new Float32Array(c.length);
      for (let i = 0; i < c.length; i++) dst[i] = shape(c[i]) * outGain;
      return dst;
    });
    channels.forEach((_, i) => onProgress?.((i + 1) / channels.length));
    return { channels: out };
  },
};
