/**
 * Short-time Fourier transform / inverse for spectral processing (Task 19).
 *
 * `stft` slides a periodic Hann analysis window over the input in `hop`-sample
 * steps, zero-padding the tail so the final frame still covers the last sample,
 * and returns per-frame magnitude + phase for the non-negative-frequency bins
 * (`fftSize/2 + 1` of them).
 *
 * `istft` rebuilds each frame's full Hermitian spectrum from magnitude/phase,
 * inverts it, applies a Hann synthesis window and overlap-adds, then normalizes
 * by a per-sample accumulator of the squared synthesis window so that — with an
 * unmodified spectrum — the round trip reproduces the original signal in the
 * overlap interior. Output is exactly `outputLength` samples.
 */

import { fft, ifft } from './fft';
import { hann } from './windows';

export interface StftFrames {
  /** Magnitude per frame, length fftSize/2+1. */
  frames: Float32Array[];
  /** Phase (radians) per frame, same length. */
  phases: Float32Array[];
  fftSize: number;
  hop: number;
}

export function stft(input: Float32Array, fftSize: number, hop: number): StftFrames {
  const win = hann(fftSize);
  const bins = fftSize / 2 + 1;
  const numFrames = Math.max(1, Math.ceil(input.length / hop));
  const frames: Float32Array[] = [];
  const phases: Float32Array[] = [];
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);

  for (let f = 0; f < numFrames; f++) {
    const start = f * hop;
    im.fill(0);
    for (let i = 0; i < fftSize; i++) {
      const idx = start + i;
      re[i] = idx < input.length ? input[idx] * win[i] : 0;
    }
    fft(re, im);
    const mag = new Float32Array(bins);
    const ph = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      ph[k] = Math.atan2(im[k], re[k]);
    }
    frames.push(mag);
    phases.push(ph);
  }

  return { frames, phases, fftSize, hop };
}

export function istft(f: StftFrames, outputLength: number): Float32Array {
  const { frames, phases, fftSize, hop } = f;
  const win = hann(fftSize);
  const bins = fftSize / 2 + 1;
  const out = new Float32Array(outputLength);
  const winSq = new Float32Array(outputLength);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);

  for (let fi = 0; fi < frames.length; fi++) {
    const mag = frames[fi];
    const ph = phases[fi];

    // Non-negative-frequency bins from magnitude/phase.
    for (let k = 0; k < bins; k++) {
      re[k] = mag[k] * Math.cos(ph[k]);
      im[k] = mag[k] * Math.sin(ph[k]);
    }
    // Hermitian mirror for the negative frequencies: X[N-k] = conj(X[k]).
    for (let k = 1; k < fftSize / 2; k++) {
      re[fftSize - k] = re[k];
      im[fftSize - k] = -im[k];
    }

    ifft(re, im); // includes 1/N scaling -> time-domain frame in `re`

    const start = fi * hop;
    for (let i = 0; i < fftSize; i++) {
      const idx = start + i;
      if (idx < 0 || idx >= outputLength) continue;
      const w = win[i];
      out[idx] += re[i] * w;
      winSq[idx] += w * w;
    }
  }

  for (let i = 0; i < outputLength; i++) {
    if (winSq[i] > 1e-8) out[i] /= winSq[i];
  }
  return out;
}
