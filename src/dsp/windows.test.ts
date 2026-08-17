import { hann, hamming } from './windows';

describe('hann (periodic)', () => {
  it('has length equal to size', () => {
    expect(hann(8)).toHaveLength(8);
    expect(hann(1024)).toHaveLength(1024);
  });

  it('starts at 0 (periodic definition)', () => {
    expect(hann(8)[0]).toBe(0);
    expect(hann(1024)[0]).toBe(0);
  });

  it('matches the periodic formula 0.5*(1-cos(2*pi*i/N))', () => {
    const N = 16;
    const w = hann(N);
    for (let i = 0; i < N; i++) {
      expect(w[i]).toBeCloseTo(0.5 * (1 - Math.cos((2 * Math.PI * i) / N)), 6);
    }
  });

  it('is symmetric around the center: w[i] == w[N-i] for 1 <= i < N', () => {
    const N = 32;
    const w = hann(N);
    for (let i = 1; i < N; i++) {
      expect(w[i]).toBeCloseTo(w[N - i], 6);
    }
  });

  it('keeps all values within [0,1]', () => {
    const w = hann(64);
    for (let i = 0; i < w.length; i++) {
      expect(w[i]).toBeGreaterThanOrEqual(0);
      expect(w[i]).toBeLessThanOrEqual(1);
    }
  });

  it('peaks at 1 in the middle for an even size', () => {
    const N = 8;
    const w = hann(N);
    expect(w[N / 2]).toBeCloseTo(1, 6);
  });
});

describe('hamming (periodic)', () => {
  it('has length equal to size', () => {
    expect(hamming(8)).toHaveLength(8);
  });

  it('matches the periodic formula 0.54-0.46*cos(2*pi*i/N)', () => {
    const N = 16;
    const w = hamming(N);
    for (let i = 0; i < N; i++) {
      expect(w[i]).toBeCloseTo(0.54 - 0.46 * Math.cos((2 * Math.PI * i) / N), 6);
    }
  });

  it('starts at 0.08 (periodic definition)', () => {
    expect(hamming(8)[0]).toBeCloseTo(0.08, 6);
  });

  it('is symmetric: w[i] == w[N-i] for 1 <= i < N', () => {
    const N = 32;
    const w = hamming(N);
    for (let i = 1; i < N; i++) {
      expect(w[i]).toBeCloseTo(w[N - i], 6);
    }
  });

  it('keeps all values within [0,1]', () => {
    const w = hamming(64);
    for (let i = 0; i < w.length; i++) {
      expect(w[i]).toBeGreaterThanOrEqual(0);
      expect(w[i]).toBeLessThanOrEqual(1);
    }
  });
});
