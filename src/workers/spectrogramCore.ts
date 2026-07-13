/**
 * Pure spectrogram column computation shared by the spectrogram Web Worker, its
 * Jest mock, and unit tests (Task 19). Kept free of any Worker/DOM globals so it
 * can run synchronously anywhere.
 *
 * For each of `width` columns it windows `fftSize` samples starting at
 * `startSample + col*hop` (Hann), takes the FFT, and maps the `height` output
 * rows to FFT bins with a simple LINEAR mapping (`bin = row*(fftSize/2)/height`)
 * — row 0 is DC, the last row is Nyquist. The value stored is magnitude in dB.
 * The grid is column-major: `mags[col*height + row]`. `hop` is chosen so columns
 * are ~1 sample-window per pixel for the visible span, clamped to [128, 8192].
 */

import { fft } from '../dsp/fft';
import { hann } from '../dsp/windows';

export interface SpectrogramParams {
  channel: Float32Array;
  startSample: number;
  endSample: number;
  width: number;
  height: number;
  fftSize: number;
}

export function spectrogramHop(startSample: number, endSample: number, width: number): number {
  const span = Math.max(1, endSample - startSample);
  const raw = Math.floor(span / Math.max(1, width));
  return Math.min(8192, Math.max(128, raw));
}

export function computeSpectrogramColumns(p: SpectrogramParams): Float32Array {
  const { channel, startSample, endSample, width, height, fftSize } = p;
  const win = hann(fftSize);
  const halfBins = fftSize / 2; // highest bin index (Nyquist)
  const hop = spectrogramHop(startSample, endSample, width);
  const out = new Float32Array(Math.max(0, width * height));
  if (width <= 0 || height <= 0) return out;

  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);

  for (let col = 0; col < width; col++) {
    const start = startSample + col * hop;
    im.fill(0);
    for (let i = 0; i < fftSize; i++) {
      const idx = start + i;
      re[i] = idx >= 0 && idx < channel.length ? channel[idx] * win[i] : 0;
    }
    fft(re, im);
    for (let row = 0; row < height; row++) {
      const bin = Math.min(halfBins, Math.floor((row * halfBins) / height));
      const mag = Math.hypot(re[bin], im[bin]);
      out[col * height + row] = 20 * Math.log10(mag + 1e-9);
    }
  }
  return out;
}
