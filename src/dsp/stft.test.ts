import { stft, istft } from './stft';

const FFT = 2048;
const HOP = 512;

/** Argmax bin of a magnitude frame. */
function argmax(mag: Float32Array): number {
  let best = 0;
  let bestV = -Infinity;
  for (let k = 0; k < mag.length; k++) {
    if (mag[k] > bestV) {
      bestV = mag[k];
      best = k;
    }
  }
  return best;
}

describe('stft', () => {
  it('reports magnitude/phase frames of length fftSize/2+1', () => {
    const x = new Float32Array(4096);
    for (let n = 0; n < x.length; n++) x[n] = Math.sin((2 * Math.PI * 40 * n) / FFT);
    const f = stft(x, FFT, HOP);
    expect(f.fftSize).toBe(FFT);
    expect(f.hop).toBe(HOP);
    expect(f.frames.length).toBe(f.phases.length);
    expect(f.frames.length).toBeGreaterThan(0);
    for (const fr of f.frames) expect(fr.length).toBe(FFT / 2 + 1);
    for (const ph of f.phases) expect(ph.length).toBe(FFT / 2 + 1);
  });

  it('places the dominant bin at the sine frequency for every interior frame', () => {
    // Bin-aligned sine: period fftSize/BIN samples -> energy concentrated at BIN.
    const BIN = 50;
    const length = FFT * 6;
    const x = new Float32Array(length);
    for (let n = 0; n < length; n++) x[n] = Math.sin((2 * Math.PI * BIN * n) / FFT);
    const f = stft(x, FFT, HOP);
    let interior = 0;
    for (let i = 0; i < f.frames.length; i++) {
      const start = i * HOP;
      if (start + FFT > length) continue; // skip zero-padded tail frames
      expect(argmax(f.frames[i])).toBe(BIN);
      interior++;
    }
    expect(interior).toBeGreaterThan(3);
  });

  it('reconstructs a random signal via istft(stft(x)) within 1e-3 in the interior', () => {
    const length = 5000;
    const x = new Float32Array(length);
    let seed = 24681357;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff - 0.5;
    };
    for (let n = 0; n < length; n++) x[n] = rand();
    const y = istft(stft(x, FFT, HOP), length);
    let maxErr = 0;
    for (let n = FFT; n < length - FFT; n++) {
      maxErr = Math.max(maxErr, Math.abs(y[n] - x[n]));
    }
    expect(maxErr).toBeLessThan(1e-3);
  });

  it('preserves the requested output length', () => {
    const x = new Float32Array(3333);
    for (let n = 0; n < x.length; n++) x[n] = Math.sin(n * 0.11);
    const f = stft(x, FFT, HOP);
    expect(istft(f, x.length).length).toBe(x.length);
    expect(istft(f, 1000).length).toBe(1000);
  });
});
