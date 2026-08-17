import type { EffectDefinition } from '../types';
import { designBiquad, processBiquad, type BiquadCoeffs } from '../../dsp/biquad';

/**
 * Mains-hum remover: a cascade of narrow notch biquads placed at the fundamental
 * `baseFreq` (50 or 60 Hz) and its integer harmonics (2x, 3x, ... up to
 * `harmonics`). Harmonics at or above Nyquist are skipped. Coefficients are
 * shared across channels; each channel runs its own filter state so stereo files
 * are processed independently. `q` sets how narrow each notch is (higher = tighter).
 */
export const deHumEffect: EffectDefinition = {
  id: 'dehum',
  name: 'DeHum',
  category: 'Restoration',
  params: [
    {
      id: 'baseFreq',
      label: 'Base Frequency',
      type: 'select',
      options: [
        { value: '50', label: '50 Hz' },
        { value: '60', label: '60 Hz' },
      ],
      default: '50',
    },
    { id: 'harmonics', label: 'Harmonics', type: 'number', min: 1, max: 8, step: 1, default: 4 },
    { id: 'q', label: 'Q', type: 'number', min: 5, max: 100, step: 1, default: 30 },
  ],
  process(channels, sampleRate, params, onProgress) {
    const base = Number(params.baseFreq ?? 50);
    const harmonics = Math.round(Number(params.harmonics ?? 4));
    const q = Number(params.q ?? 30);
    const nyquist = sampleRate / 2;

    const coeffsList: BiquadCoeffs[] = [];
    for (let k = 1; k <= harmonics; k++) {
      const freq = k * base;
      if (freq >= nyquist) continue;
      coeffsList.push(designBiquad('notch', sampleRate, freq, q));
    }

    const out = channels.map((c, chIdx) => {
      // Copy up front so an empty cascade still returns a fresh (non-mutated) array.
      let signal: Float32Array = coeffsList.length > 0 ? c : Float32Array.from(c);
      for (const coeffs of coeffsList) signal = processBiquad(signal, coeffs);
      onProgress?.((chIdx + 1) / channels.length);
      return signal;
    });

    return { channels: out };
  },
};
