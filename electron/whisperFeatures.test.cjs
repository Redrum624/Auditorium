'use strict';

/**
 * Tests for whisperFeatures.cjs (F4) — the pure-math feature pipelines.
 *
 * External validation that anchors these pins (recorded in the F4 report):
 *   - the WHISPER pipeline transcribed whisper.cpp's jfk.wav through the
 *     real tiny/base models to the exact known sentence, which a wrong mel
 *     front end cannot do;
 *   - the KALDI pipeline was diffed bit-for-bit against
 *     torchaudio.compliance.kaldi.fbank with WeSpeaker's parameters
 *     (max |diff| 1.9e-4 over 778 frames of real speech).
 * The golden numbers below were captured from that validated build; the
 * analytic assertions are independent of it.
 */

const {
  WHISPER_CHUNK_SAMPLES,
  WHISPER_FRAMES_PER_CHUNK,
  FBANK_LOG_FLOOR,
  fftRadix2,
  createBluestein,
  bluesteinDft,
  hannPeriodic,
  hzToMelSlaney,
  melToHzSlaney,
  whisperMelFilterbank,
  whisperLogMel,
  createWhisperMelState,
  hzToMelHtk,
  poveyWindow,
  kaldiMelBanks,
  kaldiFbank,
  createFbankState,
} = require('./whisperFeatures.cjs');

/** Deterministic LCG noise (the repo's fixture convention). */
function lcgNoise(n, seed = 1234) {
  const out = new Float64Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s / 0xffffffff - 0.5;
  }
  return out;
}

/** Naive O(n^2) DFT — the independent oracle for the FFT tests. */
function naiveDft(x) {
  const n = x.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * k * t) / n;
      re[k] += x[t] * Math.cos(ang);
      im[k] += x[t] * Math.sin(ang);
    }
  }
  return { re, im };
}

describe('fftRadix2', () => {
  test('impulse transforms to a flat spectrum', () => {
    const re = new Float64Array(8);
    const im = new Float64Array(8);
    re[0] = 1;
    fftRadix2(re, im);
    for (let k = 0; k < 8; k++) {
      expect(re[k]).toBeCloseTo(1, 12);
      expect(im[k]).toBeCloseTo(0, 12);
    }
  });

  test('matches the naive DFT on noise (n = 64)', () => {
    const x = lcgNoise(64);
    const re = Float64Array.from(x);
    const im = new Float64Array(64);
    fftRadix2(re, im);
    const ref = naiveDft(x);
    for (let k = 0; k < 64; k++) {
      expect(re[k]).toBeCloseTo(ref.re[k], 8);
      expect(im[k]).toBeCloseTo(ref.im[k], 8);
    }
  });

  test('rejects non-power-of-two lengths (one below / at / above)', () => {
    expect(() => fftRadix2(new Float64Array(63), new Float64Array(63))).toThrow(/power of two/);
    expect(() => fftRadix2(new Float64Array(64), new Float64Array(64))).not.toThrow();
    expect(() => fftRadix2(new Float64Array(65), new Float64Array(65))).toThrow(/power of two/);
  });
});

describe('bluesteinDft', () => {
  test('matches the naive DFT at the non-power-of-two Whisper size (n = 400)', () => {
    const x = lcgNoise(400);
    const plan = createBluestein(400);
    const { re, im } = bluesteinDft(plan, x);
    const ref = naiveDft(Array.from(x));
    for (let k = 0; k < 400; k++) {
      expect(re[k]).toBeCloseTo(ref.re[k], 6);
      expect(im[k]).toBeCloseTo(ref.im[k], 6);
    }
  });

  test('matches fftRadix2 at a power-of-two size (n = 16)', () => {
    const x = lcgNoise(16);
    const plan = createBluestein(16);
    const { re, im } = bluesteinDft(plan, x);
    const re2 = Float64Array.from(x);
    const im2 = new Float64Array(16);
    fftRadix2(re2, im2);
    for (let k = 0; k < 16; k++) {
      expect(re[k]).toBeCloseTo(re2[k], 8);
      expect(im[k]).toBeCloseTo(im2[k], 8);
    }
  });
});

describe('hannPeriodic', () => {
  test('is the periodic (not symmetric) Hann: w[0]=0, w[n/2]=1, w[k]=w[n-k]', () => {
    const w = hannPeriodic(400);
    expect(w[0]).toBe(0);
    expect(w[200]).toBeCloseTo(1, 12);
    for (const k of [1, 57, 199]) expect(w[k]).toBeCloseTo(w[400 - k], 12);
    // symmetric Hann would give w[399] = 0; periodic gives w[399] = w[1] > 0
    expect(w[399]).toBeGreaterThan(0);
  });
});

describe('slaney mel scale', () => {
  test('is linear below the 1000 Hz break and logarithmic above (probes below/on/above)', () => {
    expect(hzToMelSlaney(1000)).toBeCloseTo(15, 12); // 1000 / (200/3)
    expect(hzToMelSlaney(500)).toBeCloseTo(7.5, 12); // linear half
    // just below the break stays linear …
    expect(hzToMelSlaney(999)).toBeCloseTo(999 / (200 / 3), 12);
    // … above it the curve compresses: equal Hz steps shrink in mel
    const dLow = hzToMelSlaney(1100) - hzToMelSlaney(1000);
    const dHigh = hzToMelSlaney(4100) - hzToMelSlaney(4000);
    expect(dHigh).toBeLessThan(dLow);
    // exact log form at one point: mel(6400) = 15 + ln(6.4)/(ln(6.4)/27) = 42
    expect(hzToMelSlaney(6400)).toBeCloseTo(42, 10);
  });

  test('melToHz inverts hzToMel across both regimes', () => {
    for (const hz of [0, 250, 999.5, 1000, 1000.5, 3000, 8000]) {
      expect(melToHzSlaney(hzToMelSlaney(hz))).toBeCloseTo(hz, 8);
    }
  });
});

describe('whisperMelFilterbank', () => {
  const fb = whisperMelFilterbank();

  test('shape: 80 filters over 201 rfft bins, all non-negative', () => {
    expect(fb.length).toBe(80);
    for (const row of fb) {
      expect(row.length).toBe(201);
      for (const v of row) expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  test('slaney normalisation: each row sums to ~2/(upper-lower) x triangle mass', () => {
    // Independent recomputation of the expected sum for row 40: the row is a
    // triangle of unit height sampled every sr/n_fft Hz then scaled by
    // 2/(upper-lower); its sum ≈ enorm x (area / bin spacing).
    const lower = melToHzSlaney((hzToMelSlaney(8000) * 41) / 81);
    const upper = melToHzSlaney((hzToMelSlaney(8000) * 43) / 81);
    const area = (upper - lower) / 2;
    const expected = ((2 / (upper - lower)) * area) / (16000 / 400);
    const sum = fb[40].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(expected, 2);
  });

  test('filter peaks move monotonically up in frequency', () => {
    let lastPeak = -1;
    for (const row of fb) {
      let peak = 0;
      for (let k = 1; k < row.length; k++) if (row[k] > row[peak]) peak = k;
      expect(peak).toBeGreaterThanOrEqual(lastPeak);
      lastPeak = peak;
    }
  });
});

describe('whisperLogMel', () => {
  test('rejects any length but exactly one 30 s window (below/on/above)', () => {
    expect(() => whisperLogMel(new Float32Array(WHISPER_CHUNK_SAMPLES - 1))).toThrow(/480000/);
    expect(() => whisperLogMel(new Float32Array(WHISPER_CHUNK_SAMPLES + 1))).toThrow(/480000/);
    expect(() => whisperLogMel(new Float32Array(WHISPER_CHUNK_SAMPLES))).not.toThrow();
  });

  test('digital silence maps to exactly -1.5 everywhere (the 1e-10 floor through (x+4)/4)', () => {
    const mel = whisperLogMel(new Float32Array(WHISPER_CHUNK_SAMPLES));
    expect(mel.length).toBe(80 * WHISPER_FRAMES_PER_CHUNK);
    // log10(1e-10) = -10 -> max-8 clamp inert -> (-10+4)/4 = -1.5
    for (const i of [0, 1, 12345, mel.length - 1]) expect(mel[i]).toBe(-1.5);
  });

  test('a 440 Hz tone concentrates energy in mel bin 11 (golden from the validated build)', () => {
    const s = new Float32Array(WHISPER_CHUNK_SAMPLES);
    for (let i = 0; i < 16000; i++) s[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 16000);
    const mel = whisperLogMel(s, createWhisperMelState());
    const F = WHISPER_FRAMES_PER_CHUNK;
    let best = 0;
    for (let m = 1; m < 80; m++) if (mel[m * F + 50] > mel[best * F + 50]) best = m;
    expect(best).toBe(11);
    // golden regression values (JFK-transcript-validated build)
    expect(mel[0]).toBeCloseTo(0.9832787, 5);
    expect(mel[best * F + 50]).toBeCloseTo(1.4382038, 5);
    expect(mel[40 * F + 2000]).toBeCloseTo(-0.5617962, 5);
  });
});

describe('kaldi fbank', () => {
  test('HTK mel scale: 1127*ln(1 + f/700)', () => {
    expect(hzToMelHtk(0)).toBe(0);
    expect(hzToMelHtk(700)).toBeCloseTo(1127 * Math.LN2, 8);
  });

  test('povey window: hann^0.85, symmetric, unit peak', () => {
    const w = poveyWindow(400);
    expect(w[0]).toBe(0);
    // symmetric: midpoint of n-1
    for (const k of [1, 100, 199]) expect(w[k]).toBeCloseTo(w[399 - k], 12);
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * 100) / 399);
    expect(w[100]).toBeCloseTo(Math.pow(hann, 0.85), 12);
  });

  test('mel banks: 80 rows over 257 bins of the 512-padded FFT, no area norm (peak ~1)', () => {
    const banks = kaldiMelBanks();
    expect(banks.length).toBe(80);
    expect(banks[0].length).toBe(257);
    let globalMax = 0;
    for (const row of banks) for (const v of row) globalMax = Math.max(globalMax, v);
    // unnormalised triangles peak near unit height (exact 1 only if a bin
    // falls exactly on a centre)
    expect(globalMax).toBeGreaterThan(0.9);
    expect(globalMax).toBeLessThanOrEqual(1);
  });

  test('snip_edges frame count: probes below/on/above both boundaries', () => {
    const st = createFbankState();
    expect(kaldiFbank(new Float32Array(399), st).frames).toBe(0);
    expect(kaldiFbank(new Float32Array(400), st).frames).toBe(1);
    expect(kaldiFbank(new Float32Array(559), st).frames).toBe(1);
    expect(kaldiFbank(new Float32Array(560), st).frames).toBe(2);
  });

  test('DC-only input hits the log floor in every bin (DC removal + preemphasis leave nothing)', () => {
    const s = new Float32Array(800).fill(0.25);
    const { frames, data } = kaldiFbank(s, createFbankState());
    expect(frames).toBe(3);
    const floor = Math.fround(Math.log(FBANK_LOG_FLOOR)); // stored as float32
    for (const v of data) expect(v).toBe(floor);
  });

  test('440 Hz tone: golden values from the torchaudio-verified build', () => {
    const s = new Float32Array(800);
    for (let i = 0; i < 800; i++) s[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 16000);
    const { frames, data } = kaldiFbank(s, createFbankState());
    expect(frames).toBe(3);
    let best = 0;
    for (let k = 1; k < 80; k++) if (data[k] > data[best]) best = k;
    expect(best).toBe(14);
    expect(data[0]).toBeCloseTo(9.2231655, 4);
    expect(data[10]).toBeCloseTo(16.2206364, 4);
    expect(data[80]).toBeCloseTo(9.9267988, 4);
  });
});
