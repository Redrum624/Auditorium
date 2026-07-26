import {
  decimateMono,
  onsetEnvelope,
  computeBandTable,
  TARGET_ANALYSIS_RATE,
  ONSET_FFT,
  ONSET_HOP,
  BANDS,
  BAND_LOW_HZ,
  BAND_HIGH_HZ,
  LOG_COMPRESSION,
  LOCAL_MEAN_SEC,
  LOW_BAND_MAX_HZ,
  MIN_ANALYSIS_SECONDS,
  MAX_ANALYSIS_SECONDS,
} from './tempoCore';

// Local generators only — this repo re-declares sine()/clickTrain() per test
// file rather than sharing a helper module (see fft.test.ts, resample.test.ts,
// wsola.test.ts, sessionFile.test.ts).

function sine(freq: number, seconds: number, sr = 44100, amp = 1): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

/** A unit-impulse click train at `bpm` beats/minute over `seconds`. */
function clickTrain(bpm: number, seconds: number, sr = 44100): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const interval = Math.round((60 / bpm) * sr);
  for (let i = 0; i < n; i += interval) out[i] = 1;
  return out;
}

function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

/** Snapshot/expectUnmutated wrappers, adapted from basicEffects.test.ts:11-31
 * to a single Float32Array (decimateMono/onsetEnvelope take one array, not a
 * channel list). */
function snapshot(x: Float32Array): number[] {
  return Array.from(x);
}
function expectUnmutated(x: Float32Array, before: number[]): void {
  expect(Array.from(x)).toEqual(before);
}

describe('tempoCore constants', () => {
  it('exports the exact spec values', () => {
    expect(TARGET_ANALYSIS_RATE).toBe(11025);
    expect(ONSET_FFT).toBe(1024);
    expect(ONSET_HOP).toBe(256);
    expect(BANDS).toBe(24);
    expect(BAND_LOW_HZ).toBe(80);
    expect(BAND_HIGH_HZ).toBe(3500);
    expect(LOG_COMPRESSION).toBe(1000);
    expect(LOCAL_MEAN_SEC).toBe(1.0);
    expect(LOW_BAND_MAX_HZ).toBe(200);
    expect(MIN_ANALYSIS_SECONDS).toBe(5);
    expect(MAX_ANALYSIS_SECONDS).toBe(600);
  });
});

describe('decimateMono', () => {
  it('1. DECIMATION ANTI-ALIAS: triple cascade attenuates a 7500 Hz tone by >= 22.5 dB relative to 500 Hz', () => {
    const sr = 44100;
    const hiIn = sine(7500, 1, sr);
    const loIn = sine(500, 1, sr);
    const ratio = rms(decimateMono(hiIn, sr).signal) / rms(decimateMono(loIn, sr).signal);
    expect(ratio).toBeLessThanOrEqual(0.075);

    // DISCRIMINATION: a plain single boxcar decimator (reference implemented
    // inline here, never via decimateMono/production code) must FAIL this
    // bound, proving the triple cascade -- not merely decimating -- does
    // the anti-aliasing work.
    const D = 4;
    const singleBoxcarDecimate = (x: Float32Array): Float32Array => {
      const n = x.length;
      const filtered = new Float32Array(n);
      let sum = 0;
      for (let k = 0; k < D && k < n; k++) sum += x[k];
      filtered[0] = sum;
      for (let i = 1; i < n; i++) {
        if (i + D - 1 < n) sum += x[i + D - 1];
        sum -= x[i - 1];
        filtered[i] = sum;
      }
      const outLen = Math.floor((n - 1) / D) + 1;
      const out = new Float32Array(outLen);
      for (let j = 0; j < outLen; j++) out[j] = filtered[j * D] / D;
      return out;
    };
    const refRatio = rms(singleBoxcarDecimate(hiIn)) / rms(singleBoxcarDecimate(loIn));
    expect(refRatio).toBeGreaterThan(0.4);
  });

  it('2. ZERO GROUP DELAY: an impulse at original sample 4000 (D=4) decimates to index 1000 +/- 1', () => {
    const input = new Float32Array(8000);
    input[4000] = 1;
    const { signal, factor } = decimateMono(input, 44100);
    expect(factor).toBe(4);
    let maxI = 0;
    let maxV = -Infinity;
    for (let i = 0; i < signal.length; i++) {
      if (signal[i] > maxV) {
        maxV = signal[i];
        maxI = i;
      }
    }
    expect(Math.abs(maxI - 1000)).toBeLessThanOrEqual(1);
  });

  it('2b. ZERO GROUP DELAY (exact pin, not +/-1): D=4 and D=2 impulses decimate to EXACTLY index 1000', () => {
    const inputD4 = new Float32Array(8000);
    inputD4[4000] = 1;
    const r4 = decimateMono(inputD4, 44100);
    expect(r4.factor).toBe(4);
    let maxI4 = 0;
    let maxV4 = -Infinity;
    for (let i = 0; i < r4.signal.length; i++) {
      if (r4.signal[i] > maxV4) {
        maxV4 = r4.signal[i];
        maxI4 = i;
      }
    }
    expect(maxI4).toBe(1000);

    const inputD2 = new Float32Array(4000);
    inputD2[2000] = 1;
    const r2 = decimateMono(inputD2, 22050);
    expect(r2.factor).toBe(2);
    let maxI2 = 0;
    let maxV2 = -Infinity;
    for (let i = 0; i < r2.signal.length; i++) {
      if (r2.signal[i] > maxV2) {
        maxV2 = r2.signal[i];
        maxI2 = i;
      }
    }
    expect(maxI2).toBe(1000);
  });

  it('3. RATE MAPPING: factor/rate for 44100, 48000, 22050, and D=1 passthrough for 16000', () => {
    expect(decimateMono(new Float32Array(100), 44100)).toMatchObject({ factor: 4, rate: 11025 });
    expect(decimateMono(new Float32Array(100), 48000)).toMatchObject({ factor: 4, rate: 12000 });
    expect(decimateMono(new Float32Array(100), 22050)).toMatchObject({ factor: 2 });

    const input = new Float32Array(50);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin(i * 0.3);
    const result = decimateMono(input, 16000);
    expect(result.factor).toBe(1);
    expect(result.rate).toBe(16000);
    expect(result.signal).not.toBe(input); // fresh copy, never the caller's array
    expect(Array.from(result.signal)).toEqual(Array.from(input)); // byte-identical
  });

  it('8. PURITY: decimateMono does not mutate its input', () => {
    const input = sine(300, 0.2);
    const before = snapshot(input);
    decimateMono(input, 44100);
    expectUnmutated(input, before);
  });
});

describe('onsetEnvelope', () => {
  it('4. ODF IMPULSE LOCALISATION: impulse at decimated sample 5*ONSET_HOP puts argmax(odf) at frame 5 +/- 1', () => {
    const signal = new Float32Array(8000);
    signal[5 * ONSET_HOP] = 1;
    const { odf } = onsetEnvelope(signal, TARGET_ANALYSIS_RATE);
    let maxT = 0;
    let maxV = -Infinity;
    for (let t = 0; t < odf.length; t++) {
      if (odf[t] > maxV) {
        maxV = odf[t];
        maxT = t;
      }
    }
    expect(Math.abs(maxT - 5)).toBeLessThanOrEqual(1);
  }, 15000);

  it('4b. ODF FRAME ATTRIBUTION (exact pin, not +/-1): a burst at decimated sample k*ONSET_HOP puts argmax(odf) at EXACTLY frame k-1', () => {
    // A multi-sample burst (not just a single-sample impulse), away from
    // both array edges, at two different k -- pins the frame-attribution
    // contract stated in the module doc comment: attackSample = (f+1)*hop,
    // not f*hop.
    for (const k of [20, 40]) {
      const signal = new Float32Array((k + 15) * ONSET_HOP + ONSET_FFT);
      for (let i = 0; i < 4; i++) signal[k * ONSET_HOP + i] = 1;
      const { odf } = onsetEnvelope(signal, TARGET_ANALYSIS_RATE);
      let maxT = 0;
      let maxV = -Infinity;
      for (let t = 0; t < odf.length; t++) {
        if (odf[t] > maxV) {
          maxV = odf[t];
          maxT = t;
        }
      }
      expect(maxT).toBe(k - 1);
    }
  }, 15000);

  it('5. ODF PEAKINESS: clickTrain(120, 8) decimated has max(odf) > 5*mean(odf)', () => {
    const clicks = clickTrain(120, 8);
    const { signal, rate } = decimateMono(clicks, 44100);
    const { odf } = onsetEnvelope(signal, rate);
    let max = -Infinity;
    let sum = 0;
    for (let t = 0; t < odf.length; t++) {
      if (odf[t] > max) max = odf[t];
      sum += odf[t];
    }
    const mean = sum / odf.length;
    expect(max).toBeGreaterThan(5 * mean);
  }, 15000);

  it('6. BAND TABLE: every one of the 24 bands has >= 1 bin after dedup at rate 11025, centres monotonically increasing', () => {
    const table = computeBandTable(TARGET_ANALYSIS_RATE);
    expect(table.lo.length).toBe(BANDS);
    for (let b = 0; b < table.lo.length; b++) {
      expect(table.hi[b] - table.lo[b]).toBeGreaterThanOrEqual(1);
    }
    for (let b = 1; b < table.centerHz.length; b++) {
      expect(table.centerHz[b]).toBeGreaterThan(table.centerHz[b - 1]);
    }

    // The bands matrix returned by onsetEnvelope is sized off this same table.
    const signal = new Float32Array(ONSET_FFT + ONSET_HOP);
    const { bands, numFrames, numBands } = onsetEnvelope(signal, TARGET_ANALYSIS_RATE);
    expect(numBands).toBe(BANDS);
    expect(bands.length).toBe(numFrames * numBands);
  });

  it('6b. numBands is NOT always 24: rate 24000 (192 kHz source clamped to D=8) drops one band, and the caller can see it', () => {
    const signal = new Float32Array(ONSET_FFT + ONSET_HOP);
    const { bands, numFrames, numBands } = onsetEnvelope(signal, 24000);
    expect(numBands).toBe(23);
    expect(numBands).not.toBe(BANDS);
    expect(bands.length).toBe(numFrames * numBands);
  });

  it('6c. odfLow shares odf\'s normalisation scale: the odfLow/odf ratio discriminates bass-present from bass-free material', () => {
    // Hann-shaped tone bursts (smooth on/off, unlike a raw click) so each
    // burst's spectrum stays concentrated near its own frequency instead of
    // splattering broadband energy into the low bands regardless of pitch.
    function tonePulseTrain(freq: number, bpm: number, seconds: number, sr: number): Float32Array {
      const n = Math.round(seconds * sr);
      const out = new Float32Array(n);
      const interval = Math.round((60 / bpm) * sr);
      const burstLen = Math.round(0.08 * sr);
      const env = new Float32Array(burstLen);
      for (let i = 0; i < burstLen; i++) env[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (burstLen - 1)));
      for (let start = 0; start < n; start += interval) {
        for (let i = 0; i < burstLen && start + i < n; i++) {
          out[start + i] = env[i] * Math.sin((2 * Math.PI * freq * i) / sr);
        }
      }
      return out;
    }
    const maxOf = (x: Float32Array): number => {
      let m = -Infinity;
      for (let i = 0; i < x.length; i++) if (x[i] > m) m = x[i];
      return m;
    };

    const bassPresent = tonePulseTrain(100, 120, 4, TARGET_ANALYSIS_RATE); // kick-like low bursts
    const bassFree = tonePulseTrain(4000, 120, 4, TARGET_ANALYSIS_RATE); // high bursts, no sub-200Hz energy

    const a = onsetEnvelope(bassPresent, TARGET_ANALYSIS_RATE);
    const b = onsetEnvelope(bassFree, TARGET_ANALYSIS_RATE);
    const ratioBassPresent = maxOf(a.odfLow) / maxOf(a.odf);
    const ratioBassFree = maxOf(b.odfLow) / maxOf(b.odf);

    // The bass-free ratio must stay small in absolute terms (not just
    // "smaller than bass-present") -- this is what a shared normalisation
    // scale buys: an independently-normalised odfLow would read LARGER than
    // odf here (reproduced separately -- see task-T1-report.md).
    expect(ratioBassFree).toBeLessThan(0.05);
    expect(ratioBassPresent).toBeGreaterThan(10 * ratioBassFree);
  }, 15000);

  it('7. DEGENERATE: all-zeros 20s -> odf is all zeros, no NaN', () => {
    const signal = new Float32Array(20 * TARGET_ANALYSIS_RATE);
    const { odf, odfLow } = onsetEnvelope(signal, TARGET_ANALYSIS_RATE);
    for (let t = 0; t < odf.length; t++) {
      expect(odf[t]).toBe(0);
      expect(odfLow[t]).toBe(0);
    }
  }, 15000);

  it('7b. DEGENERATE: Float32Array(0) -> numFrames 1, no throw', () => {
    expect(() => {
      const { numFrames, odf } = onsetEnvelope(new Float32Array(0), TARGET_ANALYSIS_RATE);
      expect(numFrames).toBe(1);
      expect(odf.length).toBe(1);
      expect(Number.isNaN(odf[0])).toBe(false);
    }).not.toThrow();
  });

  it('8. PURITY: onsetEnvelope does not mutate its input', () => {
    const signal = sine(200, 0.5, TARGET_ANALYSIS_RATE);
    const before = snapshot(signal);
    onsetEnvelope(signal, TARGET_ANALYSIS_RATE);
    expectUnmutated(signal, before);
  }, 15000);

  it('9. PROGRESS: fractions are monotonic non-decreasing and within [0, 0.9]', () => {
    const signal = sine(220, 1, TARGET_ANALYSIS_RATE);
    const fractions: number[] = [];
    onsetEnvelope(signal, TARGET_ANALYSIS_RATE, (f) => fractions.push(f));
    expect(fractions.length).toBeGreaterThan(0);
    for (const f of fractions) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(0.9);
    }
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
    }
  }, 15000);
});
