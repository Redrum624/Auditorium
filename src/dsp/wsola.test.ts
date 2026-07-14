import { timeStretch, timeStretchLinked, planStretch, computeOffsets, olaWithOffsets } from './wsola';

const SR = 44100;

function sine(freq: number, seconds: number, amplitude = 1, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

/** Sine with an explicit starting phase (radians). */
function sinePhase(freq: number, seconds: number, phase: number, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sr + phase);
  return out;
}

/**
 * Integer lag d in [-maxLag, maxLag] maximizing the (unnormalized) cross-correlation
 * Σ a[start+i+d]·b[start+i] over a mid-signal window — i.e. how far channel a must be
 * shifted to line up with channel b. The caller guarantees the window + lag stay in bounds.
 */
function bestLag(a: Float32Array, b: Float32Array, start: number, winLen: number, maxLag: number): number {
  let bestScore = -Infinity;
  let bestD = 0;
  for (let d = -maxLag; d <= maxLag; d++) {
    let sum = 0;
    for (let i = 0; i < winLen; i++) sum += a[start + i + d] * b[start + i];
    if (sum > bestScore) {
      bestScore = sum;
      bestD = d;
    }
  }
  return bestD;
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

describe('timeStretchLinked (stereo-linked WSOLA)', () => {
  it('mono delegation is sample-identical to timeStretch', () => {
    const input = sine(330, 0.4);
    const linked = timeStretchLinked([input], SR, 1.5);
    const direct = timeStretch(input, SR, 1.5);
    expect(linked.length).toBe(1);
    expect(linked[0].length).toBe(direct.length);
    for (let i = 0; i < direct.length; i++) expect(linked[0][i]).toBe(direct[i]);
  }, 15000);

  it('yields identical output lengths per channel = round(N*ratio)', () => {
    const l = sine(300, 0.3);
    const r = sine(500, 0.3);
    const ratio = 1.5;
    const out = timeStretchLinked([l, r], SR, ratio);
    const expected = Math.round(l.length * ratio);
    expect(out.length).toBe(2);
    expect(out[0].length).toBe(expected);
    expect(out[1].length).toBe(expected);
  }, 15000);

  it('preserves the inter-channel phase lag through a 1.5× stretch', () => {
    // L = sin, R = sin shifted +90°; R leads L by a quarter period (~50 samples @220Hz).
    const l = sinePhase(220, 0.5, 0);
    const r = sinePhase(220, 0.5, Math.PI / 2);

    const winLen = 8192;
    const maxLag = 100;
    const startBefore = Math.floor((l.length - winLen) / 2);
    const lagBefore = bestLag(l, r, startBefore, winLen, maxLag);

    const out = timeStretchLinked([l, r], SR, 1.5);
    const startAfter = Math.floor((out[0].length - winLen) / 2);
    const lagAfter = bestLag(out[0], out[1], startAfter, winLen, maxLag);

    // Sanity: the 90° offset is ~50 samples at 220 Hz / 44100 Hz.
    expect(Math.abs(lagBefore - 50)).toBeLessThanOrEqual(2);
    // The linked path applies ONE set of copy offsets to both channels, so the
    // relative lag is preserved exactly — it must NOT drift across the stretch.
    expect(lagAfter).toBe(lagBefore);
  }, 15000);

  it('preserves frequency on the linked stereo path (zero-crossing rate ±8%) at ratio 2.0', () => {
    const l = sinePhase(440, 0.5, 0);
    const r = sinePhase(440, 0.5, Math.PI / 2);
    const out = timeStretchLinked([l, r], SR, 2.0);
    for (const ch of out) {
      expect(Math.abs(zeroCrossingRate(ch) - 880) / 880).toBeLessThan(0.08);
      expectFinite(ch);
    }
  }, 15000);

  it('preserves frequency on the linked stereo path (zero-crossing rate ±8%) at ratio 0.5', () => {
    const l = sinePhase(440, 0.5, 0);
    const r = sinePhase(440, 0.5, Math.PI / 2);
    const out = timeStretchLinked([l, r], SR, 0.5);
    for (const ch of out) {
      expect(Math.abs(zeroCrossingRate(ch) - 880) / 880).toBeLessThan(0.08);
      expectFinite(ch);
    }
  }, 15000);

  it('renders every channel with the MID-signal offsets on divergent stereo content', () => {
    // DISCRIMINATING fixture: L and R at different frequencies (220 vs 277 Hz), so
    // each channel's OWN similarity search picks different offsets than the mid's.
    // A same-frequency phase-offset pair does NOT discriminate (the normalized
    // xcorr cancels a constant phase offset and both searches agree) — this one does.
    const l = sine(220, 0.5);
    const r = sine(277, 0.5);
    const ratio = 1.5;

    const plan = planStretch(l.length, SR, ratio);
    if (plan.kind !== 'ola') throw new Error('expected the OLA regime for this fixture');

    const mid = new Float32Array(l.length);
    for (let i = 0; i < l.length; i++) mid[i] = (l[i] + r[i]) / 2;

    const midOffsets = computeOffsets(mid, plan);
    const ownOffsets = computeOffsets(r, plan);

    // Fixture sanity: R's own search must diverge from the mid search on ≥30% of
    // frames, otherwise this test could pass even without linking.
    let differing = 0;
    for (let k = 0; k < midOffsets.length; k++) {
      if (midOffsets[k] !== ownOffsets[k]) differing++;
    }
    expect(differing / midOffsets.length).toBeGreaterThanOrEqual(0.3);

    const linked = timeStretchLinked([l, r], SR, ratio);

    // Core F3 invariant: the linked R output IS the OLA of R under the MID's offsets.
    const expected = olaWithOffsets(r, midOffsets, plan);
    expect(linked[1].length).toBe(expected.length);
    let maxDevFromMid = 0;
    for (let i = 0; i < expected.length; i++) {
      maxDevFromMid = Math.max(maxDevFromMid, Math.abs(linked[1][i] - expected[i]));
    }
    expect(maxDevFromMid).toBeLessThanOrEqual(1e-6);

    // ...and NOT what R would produce with its own per-channel search: if the
    // linking were removed, linked[1] would equal timeStretch(r) exactly.
    const unlinked = timeStretch(r, SR, ratio);
    let maxDevFromOwn = 0;
    for (let i = 0; i < Math.min(unlinked.length, linked[1].length); i++) {
      maxDevFromOwn = Math.max(maxDevFromOwn, Math.abs(linked[1][i] - unlinked[i]));
    }
    expect(maxDevFromOwn).toBeGreaterThan(1e-3);
  }, 15000);
});
