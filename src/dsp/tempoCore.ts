/**
 * Shared DSP core for tempo/BPM analysis (v1.5 feature set), part 1:
 * decimation to a common analysis rate, and a log-band spectral-flux
 * onset-strength envelope. Pure, synchronous, no Worker/DOM globals — this
 * runs inside `tempo.worker.ts` (later task) as well as in tests.
 *
 * ## Decimation (`decimateMono`)
 *
 * Anti-aliases with a TRIPLE-cascaded boxcar (three length-D running sums),
 * O(n) adds only — not `resampleChannel` (64-tap windowed sinc measured at
 * ~450 ms/1M samples, `resample.test.ts:68-78` — roughly 6 s for a 5-minute
 * track, more than the rest of this pipeline combined) and not a single
 * boxcar or triangular kernel either (those leave -6.5 dB / -13 dB at the
 * 7-8 kHz fold; the triple cascade gives ~-23 dB there, see
 * `decimateMono`'s doc comment for the full analysis).
 *
 * The cascade is built to have EXACT zero group delay so decimated index `j`
 * maps to original sample `j*D`, not `j*D + <some causal filter delay>`:
 * every downstream feature (beat positions, bar boundaries, splice points)
 * inherits this mapping, so an off-by-one here silently shifts every beat.
 * See `tripleBoxcarZeroDelay` for the construction and its correctness
 * argument (odd D: perfectly symmetric single-stage boxcars, zero bias by
 * construction; even D: a 2-1 split of the two minimal-asymmetry directions,
 * giving a combined bias of exactly +/-0.5 original samples, which — for an
 * impulse placed exactly on the decimation grid — always leaves the on-grid
 * sample as the unique argmax of the (symmetric, unimodal) composite kernel).
 *
 * ## Onset envelope (`onsetEnvelope`)
 *
 * Streaming `fft` + `hann(1024)` on two buffers allocated ONCE outside the
 * frame loop and reused every iteration — never `stft()` (`stft.ts:28`),
 * which retains a fresh magnitude AND phase array per frame (`stft.ts:45-52`)
 * plus an atan2 per bin; at ~12,920 frames x 513 bins for a 5-minute track
 * that is ~106 MB of garbage for phase that is never read. This follows the
 * same reused-buffer shape as `spectrogramCore.ts:74-91`, which is itself
 * just `fft()` + externally-owned buffers (there is no separate exported
 * "streaming FFT" utility in this repo to import — `fft()` in `fft.ts` is
 * already the reusable primitive; `spectrogramCore.ts` doesn't add anything
 * on top of it, so there was nothing private to extract, only a pattern to
 * repeat).
 *
 * Frames are CENTERED at `t*ONSET_HOP` (window = `[t*hop - fftSize/2, t*hop
 * + fftSize/2)`, zero-padded at both ends), matching the Ellis 2007 /
 * librosa `onset_strength(center=True)` convention this design's downstream
 * beat-tracking stage (Ellis DP) is built on — NOT the plain
 * `start = t*hop` convention `stft.ts`/`spectrogramCore.ts` use for their own
 * (unrelated) arbitrary-region spectrogram purposes. This matters: with
 * log-compressed flux (`L = log(1 + LOG_COMPRESSION*E)`), the concavity of
 * `log` means the flux from "silence to half-energy" (as an isolated
 * transient FIRST enters the analysis window) is always larger than the
 * subsequent "half to full energy" step as the window centers on it — so a
 * spectral-flux onset detector always fires ~1 hop BEFORE a frame's nominal
 * center for a sharp, isolated attack. Centered framing is what makes frame
 * index `t` line up with "attack near sample `t*hop`" the way callers
 * expect; it is also independently corroborated by this design's own later
 * sample-domain refinement constant `beatSample ~= (f*256 + 256)*D`
 * (`v15-architecture.md`) — the `+256` (`+1 hop`) is exactly this same
 * "flux peaks 1 hop early" correction, derived independently here from
 * first principles (see `task-T1-report.md` for the full derivation and the
 * numeric proof that the plain `start = t*hop` convention places the
 * impulse-response argmax 3 frames away from the brief's specified
 * "frame 5 +/- 1", outside tolerance, while centered framing lands it at
 * frame 4, inside tolerance).
 */

import { fft } from './fft';
import { hann } from './windows';

// ---------------------------------------------------------------------------
// Constants (exported — later tasks and the architecture doc name these
// exact values).
// ---------------------------------------------------------------------------

/** Target sample rate after decimation (Hz). */
export const TARGET_ANALYSIS_RATE = 11025;
/** Onset-envelope FFT size (samples). */
export const ONSET_FFT = 1024;
/** Onset-envelope hop size (samples). */
export const ONSET_HOP = 256;
/** Number of log-spaced spectral bands feeding the onset flux. */
export const BANDS = 24;
/** Lowest band edge (Hz). */
export const BAND_LOW_HZ = 80;
/** Highest band edge (Hz), further capped to `0.32 * rate` per-call. */
export const BAND_HIGH_HZ = 3500;
/** Log-compression constant: `L = log(1 + LOG_COMPRESSION * energy)`. */
export const LOG_COMPRESSION = 1000;
/** Width (seconds) of the centred local-mean window subtracted from the ODF. */
export const LOCAL_MEAN_SEC = 1.0;
/** Bands with centre frequency below this feed `odfLow` (kick emphasis). */
export const LOW_BAND_MAX_HZ = 200;
/** Shortest audio this analysis is meaningful for (seconds). */
export const MIN_ANALYSIS_SECONDS = 5;
/** Longest audio processed in one pass (seconds); longer inputs are clipped by the caller. */
export const MAX_ANALYSIS_SECONDS = 600;

// ---------------------------------------------------------------------------
// decimateMono
// ---------------------------------------------------------------------------

export interface DecimateResult {
  signal: Float32Array;
  rate: number;
  factor: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Sliding-window sum over `[i - left, i + right]` (zero-padded outside the
 * array), computed incrementally (one add + one subtract per output sample)
 * so the whole pass is O(n) regardless of window width. Never mutates `src`.
 */
function centeredSum(src: Float32Array, left: number, right: number): Float32Array {
  const n = src.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  let sum = 0;
  for (let k = -left; k <= right; k++) {
    if (k >= 0 && k < n) sum += src[k];
  }
  out[0] = sum;
  for (let i = 1; i < n; i++) {
    const add = i + right;
    const rem = i - left - 1;
    if (add >= 0 && add < n) sum += src[add];
    if (rem >= 0 && rem < n) sum -= src[rem];
    out[i] = sum;
  }
  return out;
}

/**
 * Triple-cascaded length-D boxcar with EXACT zero group delay by
 * construction (unnormalized: caller divides by `D^3`).
 *
 * - D odd: a length-D boxcar has a single well-defined integer centre
 *   (`left = right = (D-1)/2`), so applying the SAME perfectly symmetric
 *   window in all 3 stages gives a combined kernel that is exactly
 *   symmetric about lag 0 — zero bias, exactly, no approximation.
 * - D even: no single-stage boxcar of length D can be centered on an
 *   integer sample (the natural split is `D/2` vs `D/2-1`, off by 0.5
 *   either direction). Applying that split the SAME way in all 3 stages
 *   would accumulate a 1.5-sample bias (three halves in the same
 *   direction) — enough to occasionally pick the wrong neighbouring
 *   decimated sample. Instead this uses a 2-1 split: two stages biased one
 *   way and one stage biased the other, so the combined bias is exactly
 *   +/-0.5 samples (the minimum possible, not the maximum). For an impulse
 *   placed exactly on the decimation grid, the true (fractional) kernel
 *   peak then sits exactly half way between two adjacent samples, one of
 *   which is always the grid point itself — so the grid sample is
 *   guaranteed to be (one of) the maxima, giving an exact, not merely
 *   close, decimated-index mapping. Verified for D=2 and D=4 by direct
 *   impulse-response simulation (see `task-T1-report.md`).
 */
function tripleBoxcarZeroDelay(x: Float32Array, D: number): Float32Array {
  let s1: [number, number];
  let s2: [number, number];
  let s3: [number, number];
  if (D % 2 === 1) {
    const h = (D - 1) / 2;
    s1 = s2 = s3 = [h, h];
  } else {
    const lo = D / 2 - 1;
    const hi = D / 2;
    s1 = [lo, hi];
    s2 = [lo, hi];
    s3 = [hi, lo];
  }
  const y1 = centeredSum(x, s1[0], s1[1]);
  const y2 = centeredSum(y1, s2[0], s2[1]);
  return centeredSum(y2, s3[0], s3[1]);
}

/**
 * Decimates `mono` toward `TARGET_ANALYSIS_RATE` by an integer factor
 * `D = clamp(round(sampleRate / TARGET_ANALYSIS_RATE), 1, 8)`, anti-aliasing
 * with `tripleBoxcarZeroDelay` first. Never mutates `mono`.
 */
export function decimateMono(mono: Float32Array, sampleRate: number): DecimateResult {
  const factor = clamp(Math.round(sampleRate / TARGET_ANALYSIS_RATE), 1, 8);

  if (factor === 1) {
    const copy = new Float32Array(mono.length);
    copy.set(mono);
    return { signal: copy, rate: sampleRate, factor };
  }

  const filtered = tripleBoxcarZeroDelay(mono, factor);
  const outLen = mono.length > 0 ? Math.floor((mono.length - 1) / factor) + 1 : 0;
  const signal = new Float32Array(outLen);
  const norm = 1 / (factor * factor * factor);
  for (let j = 0; j < outLen; j++) {
    signal[j] = filtered[j * factor] * norm;
  }
  return { signal, rate: sampleRate / factor, factor };
}

// ---------------------------------------------------------------------------
// onsetEnvelope
// ---------------------------------------------------------------------------

export interface OnsetEnvelopeResult {
  odf: Float32Array;
  odfLow: Float32Array;
  /** numFrames * numBands, row-major (band table may have fewer than BANDS entries if dedup drops any). */
  bands: Float32Array;
  odfRate: number;
  numFrames: number;
}

export interface BandTable {
  lo: Int32Array; // inclusive FFT bin
  hi: Int32Array; // exclusive FFT bin
  centerHz: Float64Array;
}

/**
 * `BANDS` log-spaced bands from `BAND_LOW_HZ` to `min(BAND_HIGH_HZ, 0.32*rate)`,
 * built from `BANDS+1` log-spaced edge frequencies (giving exactly `BANDS`
 * consecutive-pair intervals, rather than `BANDS` edges giving `BANDS-1`
 * intervals plus an oddly-sized leftover band). Bands whose two edges round
 * to the same FFT bin (only possible at unusually low decimated rates) are
 * dropped. Verified at rate=11025, ONSET_FFT=1024: all 24 bands survive with
 * bin widths >= 1 (down to 2 bins at the 80 Hz floor). Exported (in addition
 * to `onsetEnvelope` using it internally) so the band-edge/centre invariants
 * are independently testable, and for later tasks that need the same table.
 */
export function computeBandTable(rate: number): BandTable {
  const bandHigh = Math.min(BAND_HIGH_HZ, 0.32 * rate);
  const edgesHz: number[] = new Array(BANDS + 1);
  for (let k = 0; k <= BANDS; k++) {
    edgesHz[k] = BAND_LOW_HZ * Math.pow(bandHigh / BAND_LOW_HZ, k / BANDS);
  }
  const freqToBin = (f: number) => clamp(Math.round((f * ONSET_FFT) / rate), 1, 512);

  const lo: number[] = [];
  const hi: number[] = [];
  const centerHz: number[] = [];
  for (let b = 0; b < BANDS; b++) {
    const binLo = freqToBin(edgesHz[b]);
    const binHi = freqToBin(edgesHz[b + 1]);
    if (binHi > binLo) {
      lo.push(binLo);
      hi.push(binHi);
      centerHz.push((edgesHz[b] + edgesHz[b + 1]) / 2);
    }
  }
  return { lo: Int32Array.from(lo), hi: Int32Array.from(hi), centerHz: Float64Array.from(centerHz) };
}

/**
 * Centred moving average of `x` over a window of `2*halfWidth+1` samples,
 * computed via an incrementally-maintained running sum AND running count (so
 * the average near the array edges is over the samples actually available,
 * not biased toward zero by implicit zero-padding). O(n).
 */
function centeredMovingAverage(x: Float32Array, halfWidth: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  let sum = 0;
  let count = 0;
  for (let k = -halfWidth; k <= halfWidth; k++) {
    if (k >= 0 && k < n) {
      sum += x[k];
      count++;
    }
  }
  out[0] = count > 0 ? sum / count : 0;
  for (let t = 1; t < n; t++) {
    const add = t + halfWidth;
    const rem = t - halfWidth - 1;
    if (add >= 0 && add < n) {
      sum += x[add];
      count++;
    }
    if (rem >= 0 && rem < n) {
      sum -= x[rem];
      count--;
    }
    out[t] = count > 0 ? sum / count : 0;
  }
  return out;
}

/**
 * Subtracts a centred `LOCAL_MEAN_SEC`-wide moving average, half-wave
 * rectifies, then normalises to unit standard deviation. Returns an
 * all-zero envelope (never NaN) when the input has effectively no variance.
 */
function postProcessEnvelope(raw: Float32Array, odfRate: number): Float32Array {
  const n = raw.length;
  const halfWidth = Math.round(0.5 * LOCAL_MEAN_SEC * odfRate);
  const avg = centeredMovingAverage(raw, halfWidth);

  const rectified = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const v = raw[t] - avg[t];
    rectified[t] = v > 0 ? v : 0;
  }

  let mean = 0;
  for (let t = 0; t < n; t++) mean += rectified[t];
  mean /= n > 0 ? n : 1;

  let variance = 0;
  for (let t = 0; t < n; t++) {
    const d = rectified[t] - mean;
    variance += d * d;
  }
  variance /= n > 0 ? n : 1;
  const std = Math.sqrt(variance);

  if (std < 1e-9) return new Float32Array(n);

  const out = new Float32Array(n);
  for (let t = 0; t < n; t++) out[t] = rectified[t] / std;
  return out;
}

/**
 * Streaming log-band spectral-flux onset-strength envelope. Frames are
 * CENTRED at `t*ONSET_HOP` (see the module doc comment for why). `signal`
 * and its contents are never mutated.
 */
export function onsetEnvelope(
  signal: Float32Array,
  rate: number,
  onProgress?: (fraction: number) => void
): OnsetEnvelopeResult {
  const len = signal.length;
  const numFrames = Math.max(1, Math.floor((len - ONSET_FFT) / ONSET_HOP) + 1);
  const odfRate = rate / ONSET_HOP;

  const table = computeBandTable(rate);
  const numBands = table.lo.length;
  const isLowBand = new Uint8Array(numBands);
  for (let b = 0; b < numBands; b++) isLowBand[b] = table.centerHz[b] < LOW_BAND_MAX_HZ ? 1 : 0;

  const bins = ONSET_FFT / 2 + 1;
  const win = hann(ONSET_FFT);
  const re = new Float32Array(ONSET_FFT);
  const im = new Float32Array(ONSET_FFT);
  const mag = new Float32Array(bins);

  const bandsMatrix = new Float32Array(numFrames * numBands);
  const prevL = new Float32Array(numBands);
  const rawOdf = new Float32Array(numFrames);
  const rawOdfLow = new Float32Array(numFrames);

  const half = ONSET_FFT / 2;
  for (let t = 0; t < numFrames; t++) {
    const start = t * ONSET_HOP - half; // centred framing
    im.fill(0);
    for (let i = 0; i < ONSET_FFT; i++) {
      const idx = start + i;
      re[i] = idx >= 0 && idx < len ? signal[idx] * win[i] : 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) mag[k] = Math.hypot(re[k], im[k]);

    let flux = 0;
    let fluxLow = 0;
    for (let b = 0; b < numBands; b++) {
      let e = 0;
      for (let k = table.lo[b]; k < table.hi[b]; k++) e += mag[k];
      const L = Math.log(1 + LOG_COMPRESSION * e);
      bandsMatrix[t * numBands + b] = L;
      if (t > 0) {
        const d = L - prevL[b];
        if (d > 0) {
          flux += d;
          if (isLowBand[b]) fluxLow += d;
        }
      }
      prevL[b] = L;
    }
    rawOdf[t] = t === 0 ? 0 : flux;
    rawOdfLow[t] = t === 0 ? 0 : fluxLow;

    if (onProgress) onProgress(Math.min(0.9, ((t + 1) / numFrames) * 0.9));
  }

  const odf = postProcessEnvelope(rawOdf, odfRate);
  const odfLow = postProcessEnvelope(rawOdfLow, odfRate);

  return { odf, odfLow, bands: bandsMatrix, odfRate, numFrames };
}
