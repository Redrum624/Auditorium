import type { EffectDefinition } from '../types';
import { stft, istft } from '../../dsp/stft';

/**
 * Spectral-subtraction noise reduction (Task 19). Requires a previously captured
 * noise print, delivered to the worker via the `__effectExtra` side channel as
 * `{ spectra: number[][] | Float32Array[] }` — one average magnitude spectrum per
 * profiled channel (`fftSize/2+1` bins). Throws `No noise print captured` when it
 * is missing, which effectRunner surfaces as an error dialog.
 *
 * Per channel it runs an STFT (2048/512) and, per frame & bin, computes an
 * over-subtraction gain `max(floor, (mag − sensitivity·noise)/mag)` with
 * `floor = 10^(−reductionDb/20)`, temporally smooths the gain per bin
 * (`g' = smoothing·gPrev + (1−smoothing)·g`), applies it to the magnitude, and
 * resynthesizes with the original phases. A mono profile is reused for every
 * channel when channel counts differ.
 */

const FFT_SIZE = 2048;
const HOP = 512;

interface NoiseExtra {
  spectra?: Array<number[] | Float32Array>;
}

export const noiseReductionEffect: EffectDefinition = {
  id: 'noise-reduction',
  name: 'Noise Reduction',
  category: 'Restoration',
  params: [
    { id: 'reductionDb', label: 'Reduction', type: 'number', min: 0, max: 40, step: 1, unit: 'dB', default: 12 },
    { id: 'sensitivity', label: 'Sensitivity', type: 'number', min: 0.5, max: 4, step: 0.1, default: 1.5 },
    { id: 'smoothing', label: 'Smoothing', type: 'number', min: 0, max: 1, step: 0.05, default: 0.5 },
  ],
  process(channels, _sampleRate, params, onProgress) {
    const extra = (globalThis as { __effectExtra?: NoiseExtra }).__effectExtra;
    const spectra = extra?.spectra;
    if (!spectra || spectra.length === 0) {
      throw new Error('No noise print captured');
    }

    const reductionDb = Number(params.reductionDb ?? 12);
    const sensitivity = Number(params.sensitivity ?? 1.5);
    const smoothing = Number(params.smoothing ?? 0.5);
    const floor = Math.pow(10, -reductionDb / 20);
    const bins = FFT_SIZE / 2 + 1;

    const out = channels.map((channel, c) => {
      const noise = spectra[Math.min(c, spectra.length - 1)];
      const { frames, phases, fftSize, hop } = stft(channel, FFT_SIZE, HOP);

      const gPrev = new Float32Array(bins);
      const newFrames = frames.map((mag, fi) => {
        const outMag = new Float32Array(bins);
        for (let k = 0; k < bins; k++) {
          const m = mag[k];
          const nz = Number(noise[k] ?? 0);
          let g = m < 1e-12 ? floor : Math.max(floor, (m - sensitivity * nz) / m);
          // Temporal smoothing per bin (first frame seeds the state directly).
          g = fi === 0 ? g : smoothing * gPrev[k] + (1 - smoothing) * g;
          gPrev[k] = g;
          outMag[k] = m * g;
        }
        return outMag;
      });

      onProgress?.((c + 1) / channels.length);
      return istft({ frames: newFrames, phases, fftSize, hop }, channel.length);
    });

    return { channels: out };
  },
};
