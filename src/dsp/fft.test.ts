import { fft, ifft, nextPow2 } from './fft';

function magnitude(re: Float32Array, im: Float32Array, k: number): number {
  return Math.hypot(re[k], im[k]);
}

describe('nextPow2', () => {
  it('returns 1 for 0 and 1', () => {
    expect(nextPow2(0)).toBe(1);
    expect(nextPow2(1)).toBe(1);
  });

  it('rounds up to the next power of two', () => {
    expect(nextPow2(2)).toBe(2);
    expect(nextPow2(3)).toBe(4);
    expect(nextPow2(5)).toBe(8);
    expect(nextPow2(1000)).toBe(1024);
    expect(nextPow2(1024)).toBe(1024);
    expect(nextPow2(1025)).toBe(2048);
  });
});

describe('fft', () => {
  it('throws on a non-power-of-two length', () => {
    expect(() => fft(new Float32Array(3), new Float32Array(3))).toThrow();
    expect(() => fft(new Float32Array(6), new Float32Array(6))).toThrow();
  });

  it('throws on length 0', () => {
    expect(() => fft(new Float32Array(0), new Float32Array(0))).toThrow();
  });

  it('leaves a length-1 signal unchanged (no-op)', () => {
    const re = Float32Array.from([0.42]);
    const im = Float32Array.from([0]);
    fft(re, im);
    expect(re[0]).toBeCloseTo(0.42, 6);
    expect(im[0]).toBeCloseTo(0, 6);
  });

  it('transforms a DC signal [1,1,1,1] to re[0]=4, others ~0', () => {
    const re = Float32Array.from([1, 1, 1, 1]);
    const im = new Float32Array(4);
    fft(re, im);
    expect(re[0]).toBeCloseTo(4, 5);
    expect(im[0]).toBeCloseTo(0, 5);
    for (let k = 1; k < 4; k++) {
      expect(magnitude(re, im, k)).toBeCloseTo(0, 5);
    }
  });

  it('produces peaks at bins 3 and 61 of magnitude N/2 for a single-bin sine (k=3, N=64)', () => {
    const N = 64;
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    for (let n = 0; n < N; n++) re[n] = Math.sin((2 * Math.PI * 3 * n) / N);
    fft(re, im);
    for (let k = 0; k < N; k++) {
      const mag = magnitude(re, im, k);
      if (k === 3 || k === 61) {
        expect(mag).toBeCloseTo(N / 2, 3);
      } else {
        expect(mag).toBeCloseTo(0, 3);
      }
    }
  });
});

describe('ifft', () => {
  it('inverts fft to recover the original signal (round trip within 1e-5)', () => {
    const N = 256;
    const orig = new Float32Array(N);
    for (let n = 0; n < N; n++) orig[n] = Math.sin(n * 0.3) + 0.5 * Math.cos(n * 0.07);
    const re = Float32Array.from(orig);
    const im = new Float32Array(N);
    fft(re, im);
    ifft(re, im);
    for (let n = 0; n < N; n++) {
      expect(re[n]).toBeCloseTo(orig[n], 5);
      expect(im[n]).toBeCloseTo(0, 5);
    }
  });

  it('applies 1/N scaling so ifft of a DC-only spectrum yields a constant', () => {
    const N = 8;
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    re[0] = 8; // spectrum with only DC bin
    ifft(re, im);
    for (let n = 0; n < N; n++) {
      expect(re[n]).toBeCloseTo(1, 6);
      expect(im[n]).toBeCloseTo(0, 6);
    }
  });
});

describe('Parseval theorem', () => {
  it('holds within 1e-3 relative: sum|x|^2 == (1/N) sum|X|^2', () => {
    const N = 512;
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff - 0.5;
    };
    let energyTime = 0;
    for (let n = 0; n < N; n++) {
      re[n] = rand();
      energyTime += re[n] * re[n];
    }
    fft(re, im);
    let energyFreq = 0;
    for (let k = 0; k < N; k++) energyFreq += re[k] * re[k] + im[k] * im[k];
    energyFreq /= N;
    expect(Math.abs(energyFreq - energyTime) / energyTime).toBeLessThan(1e-3);
  });
});
