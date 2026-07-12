import { designBiquad, processBiquad, magnitudeAt, BiquadCoeffs } from './biquad';

const FS = 44100;

describe('designBiquad + magnitudeAt', () => {
  it('peaking @1kHz +6dB: magnitude at 1kHz ~= 10^(6/20) within 2%', () => {
    const coeffs = designBiquad('peaking', FS, 1000, 1, 6);
    const expected = Math.pow(10, 6 / 20); // ~1.995
    const mag = magnitudeAt(coeffs, 1000, FS);
    expect(Math.abs(mag - expected) / expected).toBeLessThan(0.02);
  });

  it('peaking @1kHz +6dB: magnitude far below f0 (100Hz) ~= 1 within 5%', () => {
    const coeffs = designBiquad('peaking', FS, 1000, 1, 6);
    const mag = magnitudeAt(coeffs, 100, FS);
    expect(Math.abs(mag - 1)).toBeLessThan(0.05);
  });

  it('lowpass fc=1kHz: passband (100Hz) ~= 1 and stopband (10kHz) < 0.02', () => {
    const coeffs = designBiquad('lowpass', FS, 1000, Math.SQRT1_2);
    expect(magnitudeAt(coeffs, 100, FS)).toBeCloseTo(1, 1);
    expect(magnitudeAt(coeffs, 10000, FS)).toBeLessThan(0.02);
  });

  it('highpass fc=1kHz: stopband (100Hz) small and passband (10kHz) ~= 1', () => {
    const coeffs = designBiquad('highpass', FS, 1000, Math.SQRT1_2);
    expect(magnitudeAt(coeffs, 100, FS)).toBeLessThan(0.02);
    expect(magnitudeAt(coeffs, 10000, FS)).toBeCloseTo(1, 1);
  });

  it('bandpass @1kHz: unity at center, attenuated away', () => {
    const coeffs = designBiquad('bandpass', FS, 1000, 1);
    expect(magnitudeAt(coeffs, 1000, FS)).toBeCloseTo(1, 2);
    expect(magnitudeAt(coeffs, 100, FS)).toBeLessThan(0.5);
    expect(magnitudeAt(coeffs, 10000, FS)).toBeLessThan(0.5);
  });

  it('notch @1kHz: ~0 at center, ~1 away', () => {
    const coeffs = designBiquad('notch', FS, 1000, 1);
    expect(magnitudeAt(coeffs, 1000, FS)).toBeLessThan(0.01);
    expect(magnitudeAt(coeffs, 100, FS)).toBeCloseTo(1, 1);
    expect(magnitudeAt(coeffs, 10000, FS)).toBeCloseTo(1, 1);
  });

  it('lowshelf +6dB: boosts DC-ish low end, unity high end', () => {
    const coeffs = designBiquad('lowshelf', FS, 1000, Math.SQRT1_2, 6);
    const boost = Math.pow(10, 6 / 20);
    expect(magnitudeAt(coeffs, 50, FS)).toBeCloseTo(boost, 1);
    expect(magnitudeAt(coeffs, 20000, FS)).toBeCloseTo(1, 1);
  });

  it('highshelf +6dB: unity low end, boosts high end', () => {
    const coeffs = designBiquad('highshelf', FS, 1000, Math.SQRT1_2, 6);
    const boost = Math.pow(10, 6 / 20);
    expect(magnitudeAt(coeffs, 50, FS)).toBeCloseTo(1, 1);
    expect(magnitudeAt(coeffs, 20000, FS)).toBeCloseTo(boost, 1);
  });
});

describe('processBiquad', () => {
  it('impulse response starts with h[0] = b0', () => {
    const coeffs = designBiquad('lowpass', FS, 1000, Math.SQRT1_2);
    const impulse = new Float32Array(16);
    impulse[0] = 1;
    const h = processBiquad(impulse, coeffs);
    // h[0] is stored in a Float32Array, so compare at single-precision resolution.
    expect(h[0]).toBeCloseTo(coeffs.b0, 6);
  });

  it('returns a new array and does not mutate the input', () => {
    const coeffs = designBiquad('lowpass', FS, 1000, Math.SQRT1_2);
    const input = Float32Array.from([1, 0, 0, 0, 0, 0]);
    const out = processBiquad(input, coeffs);
    expect(out).not.toBe(input);
    expect(Array.from(input)).toEqual([1, 0, 0, 0, 0, 0]);
  });

  it('DC blocker (highpass fc=20Hz) drives a constant signal to ~0 at steady state', () => {
    const coeffs = designBiquad('highpass', FS, 20, Math.SQRT1_2);
    const signal = new Float32Array(8000);
    signal.fill(1);
    const out = processBiquad(signal, coeffs);
    let tailMean = 0;
    for (let i = out.length - 100; i < out.length; i++) tailMean += out[i];
    tailMean /= 100;
    expect(Math.abs(tailMean)).toBeLessThan(1e-3);
  });

  it('carries state across chunked calls to match a single-pass run', () => {
    const coeffs = designBiquad('lowpass', FS, 3000, Math.SQRT1_2);
    const signal = new Float32Array(200);
    for (let i = 0; i < signal.length; i++) signal[i] = Math.sin(i * 0.2);
    const single = processBiquad(signal, coeffs);

    const state = { x1: 0, x2: 0, y1: 0, y2: 0 };
    const first = processBiquad(signal.subarray(0, 100), coeffs, state);
    const second = processBiquad(signal.subarray(100), coeffs, state);
    const chunked = new Float32Array(200);
    chunked.set(first, 0);
    chunked.set(second, 100);

    for (let i = 0; i < 200; i++) expect(chunked[i]).toBeCloseTo(single[i], 6);
  });
});

describe('BiquadCoeffs shape', () => {
  it('exposes b0,b1,b2,a1,a2 (a0-normalized)', () => {
    const coeffs: BiquadCoeffs = designBiquad('peaking', FS, 1000, 1, 3);
    for (const key of ['b0', 'b1', 'b2', 'a1', 'a2'] as const) {
      expect(typeof coeffs[key]).toBe('number');
      expect(Number.isFinite(coeffs[key])).toBe(true);
    }
  });
});
