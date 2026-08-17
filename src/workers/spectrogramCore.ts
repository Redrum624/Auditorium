/**
 * Pure spectrogram column computation shared by the spectrogram Web Worker, its
 * Jest mock, and unit tests (Task 19). Kept free of any Worker/DOM globals so it
 * can run synchronously anywhere.
 *
 * For each of `width` columns it windows `fftSize` samples starting at
 * `startSample + col*hop` (Hann), takes the FFT, and maps the `height` output
 * rows to FFT bins per `scale` (Task F4):
 *   - 'linear': `bin = row*(fftSize/2)/height` — row 0 is DC, the last row is
 *     Nyquist.
 *   - 'log' (default): row r maps to frequency `fmin*(fnyq/fmin)^(r/(height-1))`
 *     with `fmin = 20 Hz`, then `bin = round(freq/binWidth)` clamped to
 *     `[0, halfBins-1]` — row 0 is 20 Hz, the last row is ~Nyquist. This matches
 *     Adobe Audition's default logarithmic axis, spreading low-frequency detail
 *     (where most musical content lives) across most of the display.
 * In BOTH scales row 0 is the LOWEST frequency and the last row is the HIGHEST
 * — `SpectrogramView`'s paint step already flips rows vertically so row 0 lands
 * at the BOTTOM of the canvas (low frequencies at the bottom, like Audition);
 * no draw-order change was needed for the log scale.
 * The value stored is magnitude in dB. The grid is column-major:
 * `mags[col*height + row]`. Column `col` windows samples starting at
 * `startSample + floor(col*span/width)` (fractional stride), so the `width`
 * columns always spread across exactly [startSample, endSample] — the paint
 * step maps x->column linearly and relies on this. (An earlier integer `hop`
 * clamped to >=128 strode past `endSample` whenever span/width < 128, painting
 * the right side of the raster black and misaligning it with the ruler.)
 */

import { fft } from '../dsp/fft';
import { hann } from '../dsp/windows';

/** Lowest frequency (Hz) mapped to row 0 under the 'log' scale. */
const LOG_FMIN = 20;

export interface SpectrogramParams {
  channel: Float32Array;
  startSample: number;
  endSample: number;
  width: number;
  height: number;
  fftSize: number;
  /** Sample rate of `channel`, needed to convert the 'log' scale's frequency
   * mapping into an FFT bin index. Unused by the 'linear' scale but always
   * required for a stable signature. */
  sampleRate: number;
  /** Row→frequency mapping; defaults to 'log' (Task F4). */
  scale?: 'log' | 'linear';
}

export function computeSpectrogramColumns(p: SpectrogramParams): Float32Array {
  const { channel, startSample, endSample, width, height, fftSize, sampleRate } = p;
  const scale = p.scale ?? 'log';
  const win = hann(fftSize);
  const halfBins = fftSize / 2; // highest bin index (Nyquist)
  const binWidth = sampleRate / fftSize;
  const fnyq = sampleRate / 2;
  const span = Math.max(1, endSample - startSample);
  const out = new Float32Array(Math.max(0, width * height));
  if (width <= 0 || height <= 0) return out;

  // Row->bin lookup computed once per call (independent of column data).
  const rowBins = new Int32Array(height);
  for (let row = 0; row < height; row++) {
    if (scale === 'log') {
      const t = height > 1 ? row / (height - 1) : 0;
      const freq = LOG_FMIN * Math.pow(fnyq / LOG_FMIN, t);
      const bin = Math.round(freq / binWidth);
      rowBins[row] = bin < 0 ? 0 : bin > halfBins - 1 ? halfBins - 1 : bin;
    } else {
      rowBins[row] = Math.min(halfBins, Math.floor((row * halfBins) / height));
    }
  }

  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);

  for (let col = 0; col < width; col++) {
    // Fractional stride: columns spread across exactly [startSample, endSample].
    const start = startSample + Math.floor((col * span) / width);
    im.fill(0);
    for (let i = 0; i < fftSize; i++) {
      const idx = start + i;
      re[i] = idx >= 0 && idx < channel.length ? channel[idx] * win[i] : 0;
    }
    fft(re, im);
    for (let row = 0; row < height; row++) {
      const bin = rowBins[row];
      const mag = Math.hypot(re[bin], im[bin]);
      out[col * height + row] = 20 * Math.log10(mag + 1e-9);
    }
  }
  return out;
}
