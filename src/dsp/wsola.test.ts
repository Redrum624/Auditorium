import { timeStretch } from './wsola';

const SR = 44100;

function sine(freq: number, seconds: number, amplitude = 1, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

/** Count sign changes (zero crossings) in an interior window, ignoring exact zeros. */
function countZeroCrossings(x: Float32Array, start: number, end: number): number {
  let count = 0;
  let prevSign = 0;
  for (let i = start; i < end; i++) {
    const s = x[i] > 0 ? 1 : x[i] < 0 ? -1 : 0;
    if (s !== 0) {
      if (prevSign !== 0 && s !== prevSign) count++;
      prevSign = s;
    }
  }
  return count;
}

/** Zero-crossing RATE (crossings per second) over the interior [20%, 80%] of a signal. */
function zeroCrossingRate(x: Float32Array, sr = SR): number {
  const start = Math.floor(x.length * 0.2);
  const end = Math.floor(x.length * 0.8);
  const crossings = countZeroCrossings(x, start, end);
  const seconds = (end - start) / sr;
  return seconds > 0 ? crossings / seconds : 0;
}

/** Normalized (Pearson) correlation between the leading min-length of two signals. */
function correlation(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sumA = 0;
  let sumB = 0;
  let sumAB = 0;
  let sumA2 = 0;
  let sumB2 = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i];
    sumB += b[i];
    sumAB += a[i] * b[i];
    sumA2 += a[i] * a[i];
    sumB2 += b[i] * b[i];
  }
  const num = n * sumAB - sumA * sumB;
  const den = Math.sqrt((n * sumA2 - sumA * sumA) * (n * sumB2 - sumB * sumB));
  return den === 0 ? 1 : num / den;
}

function expectFinite(signal: Float32Array): void {
  for (let i = 0; i < signal.length; i++) expect(Number.isFinite(signal[i])).toBe(true);
}

describe('timeStretch (WSOLA)', () => {
  it('ratio 1.0 → ~same length and correlates > 0.9 with the input', () => {
    const input = sine(220, 0.5);
    const out = timeStretch(input, SR, 1.0);
    expect(Math.abs(out.length - input.length) / input.length).toBeLessThan(0.05);
    expect(correlation(input, out)).toBeGreaterThan(0.9);
  });

  it('ratio 2.0 → ~2x length with the same frequency (zero-crossing rate within ±8%)', () => {
    const input = sine(440, 0.5);
    const out = timeStretch(input, SR, 2.0);
    const expectedLen = 2 * input.length;
    expect(Math.abs(out.length - expectedLen) / expectedLen).toBeLessThan(0.1);
    // 440 Hz has 880 zero crossings/second; stretching must NOT change the pitch.
    const rate = zeroCrossingRate(out);
    expect(Math.abs(rate - 880) / 880).toBeLessThan(0.08);
    expectFinite(out);
  }, 15000);

  it('ratio 0.5 → half length with the same frequency (zero-crossing rate within ±8%)', () => {
    const input = sine(440, 0.5);
    const out = timeStretch(input, SR, 0.5);
    const expectedLen = 0.5 * input.length;
    expect(Math.abs(out.length - expectedLen) / expectedLen).toBeLessThan(0.1);
    const rate = zeroCrossingRate(out);
    expect(Math.abs(rate - 880) / 880).toBeLessThan(0.08);
    expectFinite(out);
  }, 15000);

  it('produces no NaN/Inf on a musical-ish mixed signal', () => {
    const n = Math.round(0.4 * SR);
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      input[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.3 * Math.sin((2 * Math.PI * 330 * i) / SR);
    }
    const out = timeStretch(input, SR, 1.5);
    expectFinite(out);
  }, 15000);

  it('reports non-decreasing progress ending at ≥ 0.99', () => {
    const input = sine(440, 0.5);
    const fractions: number[] = [];
    timeStretch(input, SR, 2.0, (f) => fractions.push(f));
    expect(fractions.length).toBeGreaterThan(0);
    for (const f of fractions) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
    }
    expect(fractions[fractions.length - 1]).toBeGreaterThanOrEqual(0.99);
  }, 15000);

  it('clamps out-of-range ratios into [0.25, 4]', () => {
    const input = sine(300, 0.2);
    const tooSmall = timeStretch(input, SR, 0.01);
    const tooLarge = timeStretch(input, SR, 100);
    expect(Math.abs(tooSmall.length - Math.round(input.length * 0.25))).toBeLessThanOrEqual(1);
    expect(Math.abs(tooLarge.length - Math.round(input.length * 4))).toBeLessThanOrEqual(1);
  }, 15000);

  it('handles empty input', () => {
    const out = timeStretch(new Float32Array(0), SR, 2.0);
    expect(out.length).toBe(0);
  });
});
