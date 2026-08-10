import { designBiquad, designOnePoleLowpass, processBiquad, magnitudeAt, BiquadCoeffs } from './biquad';

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

describe('designOnePoleLowpass', () => {
  const FC = 1000;

  /** Sine long enough to settle; measured over the last 0.1 s, which holds an
   * integer number of periods for every probe frequency below (all multiples
   * of 10 Hz), so the RMS of the input is exactly A/sqrt(2). */
  function probe(freq: number, coeffs: BiquadCoeffs): { inR: number; lowR: number; highR: number } {
    const n = Math.round(0.3 * FS);
    const sine = new Float32Array(n);
    for (let i = 0; i < n; i++) sine[i] = Math.sin((2 * Math.PI * freq * i) / FS);
    const low = processBiquad(sine, coeffs);
    const from = Math.round(0.2 * FS);
    let si = 0;
    let sl = 0;
    let sh = 0;
    for (let i = from; i < n; i++) {
      const high = sine[i] - low[i];
      si += sine[i] * sine[i];
      sl += low[i] * low[i];
      sh += high * high;
    }
    const count = n - from;
    return { inR: Math.sqrt(si / count), lowR: Math.sqrt(sl / count), highR: Math.sqrt(sh / count) };
  }

  it('is unity at DC, exactly 1/sqrt(2) at the corner, and exactly 0 at Nyquist', () => {
    const coeffs = designOnePoleLowpass(FS, FC);
    expect(magnitudeAt(coeffs, 0, FS)).toBeCloseTo(1, 12);
    expect(magnitudeAt(coeffs, FC, FS)).toBeCloseTo(Math.SQRT1_2, 12);
    // The design has an exact zero at Nyquist (b0 + b1*z^-1 with b1 = b0);
    // what is left is magnitudeAt's own sin(pi) residue, ~4e-18.
    expect(magnitudeAt(coeffs, FS / 2, FS)).toBeLessThan(1e-15);
  });

  it('rolls off at 6 dB/oct (one pole), not 12', () => {
    const coeffs = designOnePoleLowpass(FS, FC);
    // With r = tan(pi*f/fs)/tan(pi*fc/fs) (r = 2.0099 one octave up, 8.9720
    // three octaves up), one pole gives 1/sqrt(1+r^2) = 0.4454 / 0.1107.
    // A two-pole Butterworth would give 1/sqrt(1+r^4) = 0.2403 / 0.0124.
    expect(magnitudeAt(coeffs, 2 * FC, FS)).toBeCloseTo(0.4454, 3);
    expect(magnitudeAt(coeffs, 8 * FC, FS)).toBeCloseTo(0.1107, 3);
  });

  it('the residual x - lowpass(x) is power-complementary with it at every frequency', () => {
    const coeffs = designOnePoleLowpass(FS, FC);
    // Below, on and above the corner - the whole extent, not just one probe.
    for (const freq of [250, 500, 1000, 2000, 8000]) {
      const { inR, lowR, highR } = probe(freq, coeffs);
      const sumPower = lowR * lowR + highR * highR;
      expect(Math.abs(sumPower - inR * inR) / (inR * inR)).toBeLessThan(1e-3);
    }
  });

  it('splits the power evenly at the corner and hands the band over across it', () => {
    const coeffs = designOnePoleLowpass(FS, FC);
    const at = probe(FC, coeffs);
    expect(at.lowR / at.inR).toBeCloseTo(Math.SQRT1_2, 3);
    expect(at.highR / at.inR).toBeCloseTo(Math.SQRT1_2, 3);

    const below = probe(FC / 4, coeffs);
    expect(below.lowR / below.inR).toBeGreaterThan(0.96);
    expect(below.highR / below.inR).toBeLessThan(0.26);

    const above = probe(FC * 8, coeffs);
    expect(above.lowR / above.inR).toBeLessThan(0.12);
    expect(above.highR / above.inR).toBeGreaterThan(0.99);
  });

  it('neither band ever overshoots the input (|H| <= 1 for both halves)', () => {
    const coeffs = designOnePoleLowpass(FS, FC);
    for (const freq of [125, 250, 500, 1000, 2000, 4000, 8000, 16000]) {
      const { inR, lowR, highR } = probe(freq, coeffs);
      expect(lowR / inR).toBeLessThanOrEqual(1.0005);
      expect(highR / inR).toBeLessThanOrEqual(1.0005);
    }
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
