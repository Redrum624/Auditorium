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
 * `decimateMono`'s doc comment for the full analysis). The two intermediate
 * filter stages ping-pong between two scratch buffers and the third stage
 * writes directly into the (much shorter) decimated output, so this never
 * holds more than two full-length temporaries live at once — not three.
 *
 * The cascade's group delay is zero in the following precise sense: for an
 * impulse that lands exactly ON the decimation grid (original sample `j*D`
 * for some integer `j` — which is what matters, since every consumer indexes
 * the decimated signal at `j*D`), decimated sample `j` is GUARANTEED to be
 * the argmax, exactly, not approximately. For an impulse elsewhere, the
 * residual bias is at most +/-0.5 original samples, provably the minimum
 * possible for an even-length composite kernel (odd `D` has zero bias with
 * no caveat at all). Every downstream feature (beat positions, bar
 * boundaries, splice points) inherits the on-grid mapping, so an off-by-one
 * here would silently shift every beat. See `tripleBoxcarZeroDelay` for the
 * construction and its correctness argument.
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
 * Frames are CENTRED at `t*ONSET_HOP` (window = `[t*hop - fftSize/2, t*hop
 * + fftSize/2)`, zero-padded at both ends), matching the Ellis 2007 / librosa
 * `onset_strength(center=True)` convention this design's downstream
 * beat-tracking stage (Ellis DP) is built on — NOT the plain `start = t*hop`
 * convention `stft.ts`/`spectrogramCore.ts` use for their own (unrelated)
 * arbitrary-region spectrogram purposes.
 *
 * ODF FRAME ATTRIBUTION CONTRACT (load-bearing for T2/T3): frame `f`'s
 * *window* is centred at decimated sample `f*ONSET_HOP`, but its *flux peak*
 * is NOT — because `L = log(1 + LOG_COMPRESSION*E)` is concave, the flux
 * from "silence -> half-window-weight energy" as a sharp attack FIRST enters
 * a frame's Hann window is always bigger than the subsequent "half -> full
 * weight" step as the window centres on it. So for an isolated attack at
 * decimated sample `k*ONSET_HOP`, `argmax(odf) === k-1` EXACTLY (verified for
 * k=3,5,8,13,20,40, both single-sample impulses and multi-sample bursts —
 * never off by even one frame away from an array edge). The correct
 * frame-index -> sample mapping a consumer MUST use is therefore:
 *
 *     attackSample = (f + 1) * ONSET_HOP             (decimated-domain samples)
 *     attackSample = (f * ONSET_HOP + ONSET_HOP) * D  (original-domain samples)
 *
 * NOT `f * ONSET_HOP` — that reads every attack 1 hop (23.2 ms at the
 * canonical 11025 Hz / 256-hop rate) too early, which the design's own
 * render-time +/-10 ms NCC micro-alignment cannot repair. This is exactly
 * `v15-architecture.md`'s Stage-7 refinement constant
 * `beatSample ~= (f*256 + 256)*D` — the `+256` (`+1 hop`) is this same
 * correction, independently corroborating centred framing (see
 * `task-T1-report.md`, "## Fix round 1" for the full derivation).
 *
 * `odf` and `odfLow` share ONE normalisation scale — `odf`'s own standard
 * deviation, not `odfLow`'s. Normalising each envelope to ITS OWN unit std
 * independently destroys the very ratio `odfLow` exists to carry: on
 * bass-free material `odfLow`'s raw values are small but non-zero (band-edge
 * leakage), and independently rescaling that near-silent signal up to unit
 * std can make it read LARGER than `odf`, which downstream downbeat
 * detection would misread as strong kick evidence. Sharing `odf`'s scale
 * keeps `odfLow` small when there is genuinely little sub-200-Hz energy.
 */

import { fft, ifft, nextPow2 } from './fft';
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

/** onProgress fires once every this many frames — same convention as wsola.ts:35. */
const PROGRESS_FRAME_BATCH = 32;

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
 * Sliding-window sum of `src` over `[i - left, i + right]` (zero-padded
 * outside the array), written into the caller-provided `dst` (same length,
 * must not alias `src`). Computed incrementally (one add + one subtract per
 * output sample) so the pass is O(n) regardless of window width.
 */
function centeredSumInto(src: Float32Array, dst: Float32Array, left: number, right: number): void {
  const n = src.length;
  if (n === 0) return;
  let sum = 0;
  for (let k = -left; k <= right; k++) {
    if (k >= 0 && k < n) sum += src[k];
  }
  dst[0] = sum;
  for (let i = 1; i < n; i++) {
    const add = i + right;
    const rem = i - left - 1;
    if (add >= 0 && add < n) sum += src[add];
    if (rem >= 0 && rem < n) sum -= src[rem];
    dst[i] = sum;
  }
}

/**
 * Same sliding-window sum as `centeredSumInto`, but only WRITES every
 * `factor`-th sample (scaled by `norm`) into `dst`, which is sized for the
 * decimated output rather than the full input length. The running sum still
 * has to be advanced one sample at a time (the recurrence is sequential),
 * but this avoids allocating a third full-length temporary for the final
 * cascade stage — `dst` is `~1/factor` the size instead.
 */
function centeredSumStrided(
  src: Float32Array,
  dst: Float32Array,
  left: number,
  right: number,
  factor: number,
  norm: number
): void {
  const n = src.length;
  if (n === 0) return;
  let sum = 0;
  for (let k = -left; k <= right; k++) {
    if (k >= 0 && k < n) sum += src[k];
  }
  let j = 0;
  if (0 % factor === 0) dst[j++] = sum * norm;
  for (let i = 1; i < n; i++) {
    const add = i + right;
    const rem = i - left - 1;
    if (add >= 0 && add < n) sum += src[add];
    if (rem >= 0 && rem < n) sum -= src[rem];
    if (i % factor === 0) dst[j++] = sum * norm;
  }
}

/**
 * Per-stage `[left, right]` window half-widths for the triple-cascaded
 * length-D boxcar with zero group delay by construction (see the module doc
 * comment for the precise "exact for on-grid events" guarantee).
 *
 * - D odd: a length-D boxcar has a single well-defined integer centre
 *   (`left = right = (D-1)/2`), so applying the SAME perfectly symmetric
 *   window in all 3 stages gives a combined kernel that is exactly symmetric
 *   about lag 0 — zero bias, exactly, no approximation.
 * - D even: no single-stage boxcar of length D can be centred on an integer
 *   sample (the natural split is `D/2` vs `D/2-1`, off by 0.5 either
 *   direction). Applying that split the SAME way in all 3 stages would
 *   accumulate a 1.5-sample bias (three halves in the same direction) —
 *   enough to occasionally pick the wrong neighbouring decimated sample
 *   (verified: this fails for D=2). Instead this uses a 2-1 split: two
 *   stages biased one way and one stage biased the other, so the combined
 *   bias is exactly +/-0.5 samples (the minimum possible, not the maximum).
 *   For an impulse placed exactly on the decimation grid, the true
 *   (fractional) kernel peak then sits exactly half way between two
 *   adjacent samples, one of which is always the grid point itself — so the
 *   grid sample is guaranteed to be (one of) the maxima. Verified for D=2
 *   and D=4 by direct impulse-response simulation (see `task-T1-report.md`).
 */
function boxcarStageWindows(D: number): [number, number][] {
  if (D % 2 === 1) {
    const h = (D - 1) / 2;
    return [
      [h, h],
      [h, h],
      [h, h],
    ];
  }
  const lo = D / 2 - 1;
  const hi = D / 2;
  return [
    [lo, hi],
    [lo, hi],
    [hi, lo],
  ];
}

/**
 * `D = clamp(round(sampleRate / TARGET_ANALYSIS_RATE), 1, 8)` — a pure
 * function of `sampleRate` alone (no audio content involved), so `deriveGrid`
 * (Task T4 Plan Ruling 4) can recompute the SAME factor `decimateMono` would
 * have used without needing it passed across the worker boundary.
 */
export function computeDecimationFactor(sampleRate: number): number {
  return clamp(Math.round(sampleRate / TARGET_ANALYSIS_RATE), 1, 8);
}

/**
 * Decimates `mono` toward `TARGET_ANALYSIS_RATE` by an integer factor
 * `D = clamp(round(sampleRate / TARGET_ANALYSIS_RATE), 1, 8)`, anti-aliasing
 * with a triple-cascaded boxcar first (`boxcarStageWindows`). Never mutates
 * `mono`. Allocates only two full-length scratch buffers (not three): the
 * final cascade stage writes its strided (every-`D`-th) result straight into
 * the decimated-size output via `centeredSumStrided`.
 */
export function decimateMono(mono: Float32Array, sampleRate: number): DecimateResult {
  const factor = computeDecimationFactor(sampleRate);

  if (factor === 1) {
    const copy = new Float32Array(mono.length);
    copy.set(mono);
    return { signal: copy, rate: sampleRate, factor };
  }

  const [s1, s2, s3] = boxcarStageWindows(factor);
  const n = mono.length;
  const bufA = new Float32Array(n);
  const bufB = new Float32Array(n);
  centeredSumInto(mono, bufA, s1[0], s1[1]);
  centeredSumInto(bufA, bufB, s2[0], s2[1]);

  const outLen = n > 0 ? Math.floor((n - 1) / factor) + 1 : 0;
  const signal = new Float32Array(outLen);
  const norm = 1 / (factor * factor * factor);
  centeredSumStrided(bufB, signal, s3[0], s3[1], factor, norm);

  return { signal, rate: sampleRate / factor, factor };
}

// ---------------------------------------------------------------------------
// onsetEnvelope
// ---------------------------------------------------------------------------

export interface OnsetEnvelopeResult {
  odf: Float32Array;
  odfLow: Float32Array;
  /** numFrames * numBands, row-major. */
  bands: Float32Array;
  /** Number of columns in `bands` this call actually produced — usually
   * `BANDS`, but can be less at unusually low decimated rates where dedup
   * drops a band (e.g. 23 at rate=24000, reached via a 192 kHz source
   * clamped to D=8). Callers must use THIS, not the `BANDS` constant, when
   * re-deriving rows from a cached `bands` matrix. */
  numBands: number;
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
 * to the same FFT bin are dropped — at rate=11025 (the canonical decimated
 * rate) all 24 survive, narrowest band 1 bin wide (not the ">=1.2 bins"
 * the architecture doc estimated before checking integer rounding); at
 * unusually low decimated rates (e.g. 24000, reached from a 192 kHz source
 * clamped to D=8) one band is dropped, giving 23 — see `OnsetEnvelopeResult.
 * numBands`. Exported (in addition to `onsetEnvelope` using it internally)
 * so the band-edge/centre invariants are independently testable, and for
 * later tasks that need the same table.
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

/** Subtracts a centred `LOCAL_MEAN_SEC`-wide moving average and half-wave
 * rectifies. Does NOT normalise — see `onsetEnvelope`, which normalises
 * `odf` and `odfLow` together against a SHARED scale. */
function localMeanRectify(raw: Float32Array, halfWidth: number): Float32Array {
  const n = raw.length;
  const avg = centeredMovingAverage(raw, halfWidth);
  const out = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const v = raw[t] - avg[t];
    out[t] = v > 0 ? v : 0;
  }
  return out;
}

function stdOf(x: Float32Array): number {
  const n = x.length;
  let mean = 0;
  for (let t = 0; t < n; t++) mean += x[t];
  mean /= n > 0 ? n : 1;
  let variance = 0;
  for (let t = 0; t < n; t++) {
    const d = x[t] - mean;
    variance += d * d;
  }
  variance /= n > 0 ? n : 1;
  return Math.sqrt(variance);
}

/**
 * Streaming log-band spectral-flux onset-strength envelope. Frames are
 * CENTRED at `t*ONSET_HOP` (see the module doc comment for the ODF frame
 * attribution contract this implies). `signal` and its contents are never
 * mutated.
 */
export function onsetEnvelope(
  signal: Float32Array,
  rate: number,
  onProgress?: (fraction: number) => void
): OnsetEnvelopeResult {
  const len = signal.length;
  // floor(len/hop)+1 frames fully cover the signal under centred framing
  // (matches v15-architecture.md's own "~12,920 frames for a 5-minute
  // track" worked example at rate=11025; the start-aligned
  // floor((len-fft)/hop)+1 formula leaves the final ~50-70ms of every
  // track outside every frame's window once framing is centred).
  const numFrames = Math.max(1, Math.floor(len / ONSET_HOP) + 1);
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

    if (onProgress && (t % PROGRESS_FRAME_BATCH === 0 || t === numFrames - 1)) {
      onProgress(Math.min(0.9, ((t + 1) / numFrames) * 0.9));
    }
  }

  const halfWidth = Math.round(0.5 * LOCAL_MEAN_SEC * odfRate);
  const odfRect = localMeanRectify(rawOdf, halfWidth);
  const odfLowRect = localMeanRectify(rawOdfLow, halfWidth);

  // odf and odfLow are normalised against ONE shared scale -- odf's own std
  // -- not their own individual stds; see the module doc comment for why
  // (an independent-std normalisation would erase the very odfLow/odf ratio
  // downbeat detection reads as kick evidence). std < 1e-9 short-circuits
  // BOTH to all-zero, matching the brief's "caller short-circuits to
  // bpm: null" contract.
  const scale = stdOf(odfRect);
  const odf = new Float32Array(numFrames);
  const odfLow = new Float32Array(numFrames);
  if (scale >= 1e-9) {
    for (let t = 0; t < numFrames; t++) {
      odf[t] = odfRect[t] / scale;
      odfLow[t] = odfLowRect[t] / scale;
    }
  }

  return { odf, odfLow, bands: bandsMatrix, numBands, odfRate, numFrames };
}

// ---------------------------------------------------------------------------
// Tempo estimation, Ellis beat-tracking DP, sample-accurate refinement
// (v1.5 feature set, part 2).
//
// ## Sample-domain refinement window: asymmetric and forward-biased, on purpose
//
// T1's ODF FRAME ATTRIBUTION CONTRACT (see module doc comment above) measured
// the frame->sample mapping `(f+1)*ONSET_HOP*D` as a FLOOR, not a point
// estimate: sub-hop sweeps showed attacks at original samples
// 7680/7744/7808/7872 (all within one decimated hop of each other) map to the
// SAME frame. So the true attack lies anywhere in
// `[(f+1)*ONSET_HOP*D, (f+2)*ONSET_HOP*D)` -- mean bias -11.6 ms, worst
// -23.2 ms, ALWAYS late of the coarse estimate, never early. A symmetric
// +/-512-sample search window would therefore only cover the first half of
// the true uncertainty and leave every beat systematically early. The search
// window below is deliberately `[-D*ONSET_HOP/4, +D*ONSET_HOP]` (= [-256,
// +1024] original samples at the canonical 44.1 kHz / D=4 rate), not a
// symmetric +/-512 -- see `refineSampleDomain`.
// ---------------------------------------------------------------------------

export const MIN_BPM = 60;
export const MAX_BPM = 200;
export const CANDIDATE_STEP = 1.005;
export const HARMONIC_WEIGHTS = [1, 0.5, 0.25];
export const PRIOR_CENTER_BPM = 120;
export const PRIOR_SIGMA_OCT = 0.9;
export const OCTAVE_FAMILY = [1 / 3, 1 / 2, 2 / 3, 1, 3 / 2, 2, 3];
export const TIGHTNESS = 6;
export const ONSET_ATTRIBUTION_FRAC = 0.25;
export const REFINE_ENERGY_WIN = 256;
export const CONFIDENCE_LOW = 0.35;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function meanOf(x: ArrayLike<number>): number {
  const n = x.length;
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += x[i];
  return s / n;
}

/** Log-Gaussian tempo prior centred on `PRIOR_CENTER_BPM`, width `PRIOR_SIGMA_OCT` octaves. */
function priorWeight(bpm: number): number {
  const z = Math.log2(bpm / PRIOR_CENTER_BPM) / PRIOR_SIGMA_OCT;
  return Math.exp(-0.5 * z * z);
}

// ---------------------------------------------------------------------------
// autocorrelate / acfAt
// ---------------------------------------------------------------------------

/**
 * Wiener-Khinchin autocorrelation of `odf`: pad to `nextPow2(2*N)`, forward
 * FFT, replace with the power spectrum, inverse FFT, take the first `N` real
 * values. UNBIASED normalisation (`acf[l] /= (N-l)`, then `/= acf[0]`) is
 * load-bearing -- the raw (biased) ACF's triangular taper suppresses long
 * lags and manufactures fast-tempo octave errors before the disambiguator
 * (`chooseOctave`) ever runs. Never mutates `odf`.
 */
export function autocorrelate(odf: Float32Array): Float32Array {
  const N = odf.length;
  if (N === 0) return new Float32Array(0);

  const M = nextPow2(2 * N);
  const re = new Float32Array(M);
  const im = new Float32Array(M);
  re.set(odf);
  fft(re, im);
  for (let k = 0; k < M; k++) {
    re[k] = re[k] * re[k] + im[k] * im[k];
    im[k] = 0;
  }
  ifft(re, im);

  const acf = new Float32Array(N);
  for (let l = 0; l < N; l++) acf[l] = re[l] / (N - l);

  const a0 = acf[0];
  if (!(a0 > 1e-20)) {
    // Degenerate (all-zero / silent) ODF: acf[0] would be ~0, and dividing by
    // it would manufacture NaN out of a legitimately-zero signal. The caller
    // guards on this upstream (odf all-zero -> bpm: null), but autocorrelate
    // itself must still return finite values per its own contract.
    return new Float32Array(N);
  }
  for (let l = 0; l < N; l++) acf[l] /= a0;
  return acf;
}

/** Linear interpolation of `acf` at a fractional lag; clamps outside `[0, N-1]`. */
export function acfAt(acf: Float32Array, lag: number): number {
  const N = acf.length;
  if (N === 0) return 0;
  if (N === 1) return acf[0];
  if (lag <= 0) return acf[0];
  if (lag >= N - 1) return acf[N - 1];
  const i0 = Math.floor(lag);
  const frac = lag - i0;
  return acf[i0] * (1 - frac) + acf[i0 + 1] * frac;
}

// ---------------------------------------------------------------------------
// scoreTempoCandidates / period refinement
// ---------------------------------------------------------------------------

export interface TempoCandidate {
  bpm: number;
  score: number;
  /** Unweighted harmonic-comb strength (no prior applied) -- exposed so the
   * confidence measure can compute peak PROMINENCE on the raw comb (see
   * `combProminence`), separately from the prior-weighted `score`. */
  comb: number;
}

/**
 * Scores a log-spaced grid of tempo candidates (`b = minBpm * 1.005^i`, ~241
 * candidates over the default 60-200 BPM range, with `maxBpm` itself always
 * appended as the final candidate even when the multiplicative step
 * overshoots it -- otherwise the grid's last point lands at ~199.6, never
 * reaching `MAX_BPM` exactly) by harmonic comb strength on the
 * autocorrelation times a log-Gaussian prior centred on `PRIOR_CENTER_BPM`.
 * Sorted descending by score -- `[0]` is the winning OCTAVE (not yet
 * period-refined; see `refinePeriodFrames`).
 */
export function scoreTempoCandidates(
  acf: Float32Array,
  odfRate: number,
  minBpm: number = MIN_BPM,
  maxBpm: number = MAX_BPM
): TempoCandidate[] {
  const candidates: TempoCandidate[] = [];
  let lastBpm = minBpm;
  for (let bpm = minBpm; bpm <= maxBpm; bpm *= CANDIDATE_STEP) {
    const periodFrames = (60 * odfRate) / bpm;
    let comb = 0;
    for (let m = 1; m <= HARMONIC_WEIGHTS.length; m++) {
      comb += HARMONIC_WEIGHTS[m - 1] * acfAt(acf, m * periodFrames);
    }
    candidates.push({ bpm, score: comb * priorWeight(bpm), comb });
    lastBpm = bpm;
  }
  if (lastBpm < maxBpm) {
    const periodFrames = (60 * odfRate) / maxBpm;
    let comb = 0;
    for (let m = 1; m <= HARMONIC_WEIGHTS.length; m++) {
      comb += HARMONIC_WEIGHTS[m - 1] * acfAt(acf, m * periodFrames);
    }
    candidates.push({ bpm: maxBpm, score: comb * priorWeight(maxBpm), comb });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

/**
 * Peak PROMINENCE of the RAW (unweighted, no prior, no octave-family
 * exclusion) harmonic comb over the whole candidate grid: `max(comb) /
 * mean(comb)`. Answers "is there real periodic structure at all" rather than
 * "did the DP produce an evenly-spaced track on ODF peaks" (which is true by
 * construction for almost any content -- see `analyzeTempo`'s confidence
 * calculation for why this replaced a salience-based term).
 */
function combProminence(candidates: TempoCandidate[]): number {
  if (candidates.length === 0) return 0;
  let maxComb = -Infinity;
  let sum = 0;
  for (const c of candidates) {
    if (c.comb > maxComb) maxComb = c.comb;
    sum += c.comb;
  }
  const mean = sum / candidates.length;
  return mean > 1e-12 ? maxComb / mean : 0;
}

/**
 * Confidence sub-score calibration (post-T2-review C2 fix). Unlike
 * MIN_BPM/TIGHTNESS/etc., the brief's confidence formula only pins
 * `CONFIDENCE_LOW` as an ACCEPTANCE ANCHOR -- the internal divisors inside
 * `sSal`/`sPeak` are prose, not named constants, and the original `sSal`
 * formula turned out to saturate on noise (see the review). These three
 * were calibrated against an 8-content-type sweep -- clickTrain, drumLoop,
 * backbeat, ramp (real rhythm, prominence >= 5.8) vs. LCG noise, pad,
 * speech-like, pure sine (no real tempo, prominence <= 2.95) -- see
 * task-T2-report.md "Fix round 1"/"Fix round 2" for the full measurement
 * tables this was derived from.
 *
 * CALIBRATED-TO-FIXTURE, NOT PROVEN ROBUST (N5, T2 review round 2):
 * `PROMINENCE_FLOOR=3` sits close enough to this repo's own LCG noise
 * generator's measured prominence (2.95-2.99 depending on exact fixture
 * length/seed) that it is fitted to, rather than comfortably clear of, that
 * boundary -- an independently-synthesised pink-noise-like fixture measured
 * prominence 3.09 (ABOVE the floor) during this review round, though its
 * full confidence still landed under CONFIDENCE_LOW (0.267) once sPeak/sReg
 * were factored in. Content types NOT in the calibration sweep -- pink
 * noise, applause, and other broadband-but-not-white non-rhythmic material
 * -- are NOT verified to stay reliably below this floor; this constant
 * should be treated as tuned against the specific fixture bank cited above,
 * not as a universally-safe boundary, until it is re-validated against a
 * wider non-rhythm content bank (out of scope for T2 -- flagging for
 * whoever owns the confidence gate next).
 */
const PROMINENCE_FLOOR = 3;
const PROMINENCE_SCALE = 3;
const PEAK_RATIO_SCALE = 2;

/** 3-point parabolic vertex offset for samples `(yMinus, y0, yPlus)` centred on `y0`. */
function parabolicOffset(yMinus: number, y0: number, yPlus: number): number {
  const denom = yMinus - 2 * y0 + yPlus;
  if (denom === 0) return 0;
  return (0.5 * (yMinus - yPlus)) / denom;
}

/**
 * Refines a period ESTIMATE (in ODF frames) by 3-point parabolic
 * interpolation on the RAW `acf` around `round(periodFrames)` -- never on the
 * prior-weighted score (audio-judge F7): the log-Gaussian prior has nonzero
 * slope at its peak and would otherwise bias the refined period by ~0.06%,
 * feeding directly into every splice position downstream. The octave itself
 * must already be decided before calling this -- this function only sharpens
 * the period within +/-0.5 frames of the integer guess.
 *
 * The fit is done in the LOG domain (log(acf[p-1]), log(acf[p]),
 * log(acf[p+1])) when all three are positive, falling back to the plain
 * linear-domain fit otherwise (e.g. a lag where the unbiased acf has gone
 * slightly negative). This is still "3-point parabolic interpolation on the
 * raw acf" -- no score/prior value enters it anywhere -- just applied after
 * a monotonic (log) transform of those same raw samples. It matters because
 * the acf's peak shape around a real click-train period is measurably
 * SKEWED, not symmetric (inherited from T1's own documented asymmetric
 * per-attack flux profile: "argmax(odf) === k-1 EXACTLY", never centred).
 * Measured on clickTrain(150,20)'s true 17.2266-frame period: linear-domain
 * fit recovers offset 0.1145 (true 0.2266, bias ~115 samples); log-domain
 * recovers 0.2310 (bias ~4.5 samples) -- roughly 25x tighter, though still
 * not quite inside the brief's <4-sample bound (see task report).
 */
export function refinePeriodFrames(acf: Float32Array, periodFrames: number): number {
  const p = Math.round(periodFrames);
  if (p <= 0 || p >= acf.length - 1) return periodFrames;
  const yMinus = acf[p - 1];
  const y0 = acf[p];
  const yPlus = acf[p + 1];
  const canLog = yMinus > 0 && y0 > 0 && yPlus > 0;
  const offset = canLog
    ? parabolicOffset(Math.log(yMinus), Math.log(y0), Math.log(yPlus))
    : parabolicOffset(yMinus, y0, yPlus);
  const clamped = Math.max(-0.5, Math.min(0.5, offset));
  return p + clamped;
}

// ---------------------------------------------------------------------------
// trackBeats -- Ellis (2007) beat-tracking dynamic program
// ---------------------------------------------------------------------------

/**
 * Ellis (2007) beat tracking DP with fractional period `P` (in ODF frames).
 * `C[t] = odf[t] + max(0, max_{tau in [t-2P, t-P/2]} (C[tau] -
 * TIGHTNESS*(ln((t-tau)/P))^2))`; `TIGHTNESS=6` is Ellis's published value
 * for a unit-std onset envelope (T1's `onsetEnvelope` already normalises to
 * unit std) and is not a free parameter. The `max(0, ...)` floor (present in
 * Ellis's original recursion, implicit rather than spelled out in the task
 * brief's simplified formula) lets a frame start a fresh beat sequence with
 * no predecessor rather than forcing every frame to inherit an arbitrarily
 * bad predecessor cost -- without it there is no way to represent "no valid
 * tau exists yet" for frames before the first `~P/2` frames of the track,
 * and the whole recursion is undefined there. Backtrace starts from
 * `argmax C[t]` over the last `~2P` frames and follows `back` pointers to
 * `-1`. This DP FOLLOWS tempo drift -- unlike a rigid isochronous grid, it
 * finds the actual maximum-consistency path through the observed onset
 * strength. Cost O(N*1.5P), matching the `tau` window width.
 */
export function trackBeats(odf: Float32Array, periodFrames: number): Int32Array {
  const N = odf.length;
  if (N === 0 || !(periodFrames > 0)) return new Int32Array(0);

  const P = periodFrames;
  const C = new Float64Array(N);
  const back = new Int32Array(N).fill(-1);

  for (let t = 0; t < N; t++) {
    const lowTau = Math.max(0, Math.ceil(t - 2 * P));
    const highTau = Math.min(t - 1, Math.floor(t - P / 2));
    let best = -Infinity;
    let bestTau = -1;
    for (let tau = lowTau; tau <= highTau; tau++) {
      const ratio = (t - tau) / P;
      const logRatio = Math.log(ratio);
      const val = C[tau] - TIGHTNESS * logRatio * logRatio;
      if (val > best) {
        best = val;
        bestTau = tau;
      }
    }
    if (best > 0) {
      C[t] = odf[t] + best;
      back[t] = bestTau;
    } else {
      C[t] = odf[t];
      back[t] = -1;
    }
  }

  const searchStart = Math.max(0, N - Math.ceil(2 * P));
  let tStar = searchStart;
  let bestC = -Infinity;
  for (let t = searchStart; t < N; t++) {
    if (C[t] > bestC) {
      bestC = C[t];
      tStar = t;
    }
  }

  const beats: number[] = [];
  let cur = tStar;
  while (cur !== -1) {
    beats.push(cur);
    cur = back[cur];
  }
  beats.reverse();
  return Int32Array.from(beats);
}

/** `mean(odf at beat frames) / mean(odf overall)` -- the octave-disambiguation salience metric. */
function salienceOf(odf: Float32Array, beatFrames: Int32Array): number {
  if (beatFrames.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < beatFrames.length; i++) s += odf[beatFrames[i]];
  const beatMean = s / beatFrames.length;
  const overallMean = meanOf(odf);
  return overallMean > 1e-12 ? beatMean / overallMean : 0;
}

interface OctaveChoice {
  periodFrames: number;
  beatFrames: Int32Array;
  salience: number;
}

/**
 * R4 (P2-4, the T2 reviewer's named follow-up): how much of the JITTER
 * (variance) component of the tightness penalty is kept. The decomposition
 * in `meanTightnessPenalty` splits the mean-square log-gap error into
 * `mean^2` (systematic OFFSET from the requested period -- the collapse
 * signature `periodMatch` exists to detect) plus `variance` (zero-mean
 * scatter -- benign human/DP tracking jitter). The offset term keeps FULL
 * weight; only the variance term is down-weighted, because mean-centring
 * (dropping `mean^2`, weight 0 on offset) destroys exactly the collapse
 * signal -- measured on the R4 bank: 70/83, WORSE than not changing
 * anything.
 *
 * A/B-measured on the R4 83-fixture bank (docs/bench/, scripts/
 * tempo-bench.cjs; task-R4-report.md). correct/octave/other by weight:
 *   1.0 (previous form, full jitter penalty)  71/12/0
 *   0.5   72/11/0      0.4   73/10/0
 *   0.35  74/ 9/0  <-- kept (best; all misses are the two evidenced
 *   0.3   73/10/0      chooseOctave limitations, see its doc comment)
 *   0.25  73/10/0      0.15  73/ 9/1
 *   0.0 (offset-only)  72/ 9/2
 *   variance-only (mean-centred trap)         70/13/0
 *   median-gap form                           69/ 9/5
 * The 0.15-0.5 plateau all beats 1.0; 0.35 sits +1 above its +-0.05
 * neighbours on a single limitation-band fixture (jclick-180-j0.02), so
 * the choice is measured-best-on-plateau, not a knife edge. The bank is
 * SYNTHETIC -- this is not a real-world-material claim; the harness makes
 * any future re-measure a one-command diff.
 */
const JITTER_VARIANCE_WEIGHT = 0.35;

/**
 * Mean (deliberately NOT summed -- beat-count sensitivity is exactly the
 * defect being avoided, see `chooseOctave`'s doc comment) per-hop Ellis-DP
 * tightness penalty of the ACTUAL track `beatFrames` against the period `P`
 * it was requested at. Answers "does this candidate's own delivered beats
 * actually match the period IT ITSELF asked for" -- near 0 for a genuine,
 * non-"collapsed" track (every hop's gap sits close to `P`, so
 * `ln(gap/P) approx 0`); large when the DP's wide tau-window let it
 * "collapse" onto some OTHER octave-family member's real periodicity while
 * nominally requesting a period that periodicity doesn't match at all.
 *
 * R4 JITTER-TOLERANT FORM: the raw second moment `mean(ln^2(gap/P))` is
 * decomposed as `meanLog^2 + varLog` and the variance term is down-weighted
 * by `JITTER_VARIANCE_WEIGHT` (see its A/B table). Rationale: a COLLAPSED
 * candidate's gaps are systematically OFFSET from its own requested `P`
 * (nonzero `meanLog` -- that is definitionally what collapse means), while
 * a jittery-but-GENUINE track scatters symmetrically around `P` (zero-mean
 * `varLog`); the old form charged both at full price, structurally
 * favouring a machine-regular octave error over honest human timing (P2-4).
 * Offset keeps full weight, so the collapse detection this function exists
 * for is intact -- re-verified on the R4 bank: the previous form's
 * collapse-suppression wins (drumLoop 120/150, backbeat<=150, all
 * ramp/rise/click<=165) are all retained, and the flagship measured
 * numbers in `chooseOctave`'s comment still hold.
 */
function meanTightnessPenalty(beatFrames: Int32Array, P: number): number {
  if (beatFrames.length < 2) return Infinity;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let i = 1; i < beatFrames.length; i++) {
    const gap = beatFrames[i] - beatFrames[i - 1];
    const logRatio = Math.log(gap / P);
    sum += logRatio;
    sumSq += logRatio * logRatio;
    n++;
  }
  const meanLog = sum / n;
  const varLog = sumSq / n - meanLog * meanLog;
  return TIGHTNESS * (meanLog * meanLog + JITTER_VARIANCE_WEIGHT * varLog);
}

/**
 * Calibrated post-T2-review-round-2: how sharply `periodMatch =
 * exp(-meanTightnessPenalty)` is weighted in `chooseOctave`'s selection
 * metric. A/B-measured against `PERIOD_MATCH_POWER` in {1..4} on a 60-200
 * bpm, 41-fixture bank (task-T2-report.md "Fix round 2"): 1 under-corrects
 * (26/41 correct, barely above not using periodMatch at all), 2 is the
 * measured optimum (28/41), 3 and 4 over-correct (27/41 each) and start
 * losing fixtures the lower power still got right.
 */
const PERIOD_MATCH_POWER = 2;

/**
 * OCTAVE DISAMBIGUATION: `bStar` (the prior-weighted score's argmax) only
 * fixes an OCTAVE FAMILY, not necessarily the perceptually "correct" member
 * of it. For each `r` in `OCTAVE_FAMILY` with `bStar*r` in range, runs the
 * full beat DP at that period and scores `salience(b) * periodMatch(b)^2 *
 * prior(bpmR)`.
 *
 * FIX-ROUND-2 REWRITE of the round-1 C1 fix (which weighted `prior` on the
 * ACHIEVED beat rate instead of the nominal `bpmR` label): that fix closed
 * the original C1 regression (a 90 bpm backbeat/drumLoop misreported at
 * 180 bpm) but, per an independent reviewer A/B over 60-200 bpm (25
 * fixtures: 17/25 correct pre-fix, 11/25 post -- a NET REGRESSION), broke 7
 * previously-correct fixtures in the 165-200 bpm band. ROOT CAUSE (reviewer-
 * verified): `salienceOf` is `mean(odf at beats)` with NO normalisation for
 * how many beats were actually visited, so a family member that "collapses"
 * -- the Ellis DP's wide `[t-2P,t-P/2]` tau-window lets it silently follow a
 * NEIGHBOURING family member's real track while still nominally requesting
 * a period that track doesn't match -- and thereby cherry-picks a sparser,
 * higher-average-onset-strength subset ALWAYS outscores the fuller, honest
 * track it borrowed from. Pre-round-1, weighting the prior on the NOMINAL
 * label accidentally opposed this bias in some cases (a collapsed candidate
 * often has a nominal label further from `PRIOR_CENTER_BPM`, so the prior
 * penalised it even though salience didn't); weighting on the achieved rate
 * (round 1) removed that accidental opposition, letting the sparse-subset
 * bias decide alone -- and on the 165-200 bpm band specifically, the
 * collapsed candidate's accidental "borrow" often happened to land on the
 * CORRECT tempo, so removing that accident cost real correctness.
 *
 * The fix-round-2 fix targets the mechanism directly instead of arguing
 * about which bpm label to weight the prior on: `periodMatch` (via
 * `meanTightnessPenalty`) directly measures whether a candidate's own
 * delivered track matches the period IT REQUESTED. A collapsed candidate's
 * hops systematically deviate from its own requested `P` (that is
 * definitionally what "collapsed onto a different family member's track"
 * means), so `periodMatch` is close to 1 for a genuine track and
 * substantially below 1 for a collapsed one -- catching the borrowing
 * directly, rather than trying to patch it via which bpm the prior sees.
 * Measured on the flagship backbeat/drumLoop(90, ghostAmp<=0.3) case: r=1.5
 * (collapsed onto r=2's real beats) scores periodMatch~0.60 vs r=1's
 * (genuine) ~0.84 -- squared, a penalty the prior alone could not reliably
 * provide. The bpm label the prior weights on (nominal vs. achieved) turned
 * out NOT to matter once periodMatch suppresses collapse -- measured
 * IDENTICAL results either way on the fix-round-2 A/B bank -- so this
 * reverts to the simpler NOMINAL label per the reviewer's own fallback
 * guidance. (A dynamic-programming-objective-based alternative to salience,
 * and a duplicate-track-detection-based alternative to periodMatch, were
 * both evaluated and measured no better or worse overall -- see
 * task-T2-report.md "Fix round 2" for the comparison.)
 *
 * REMAINING, EVIDENCED LIMITATIONS (both reported, not silently patched):
 * (1) `periodMatch` cannot help when MULTIPLE octave-family members each
 * GENUINELY (non-collapsed) match their own requested period -- e.g. a
 * uniform click train, or a backbeat/drumLoop pattern whose hi-hats create
 * real energy at the half-period too, in the 165-200 bpm range, where
 * `bStar` often lands on the tempo's exact HALF and both the true tempo
 * (r=2) and a mid-family "collapsed-but-lucky" member (r=1.5, nominal close
 * to `PRIOR_CENTER_BPM`) are candidates. Suppressing r=1.5's collapse
 * (correctly) removes ITS accidental, label-driven correctness, exposing a
 * direct r=1-vs-r=2 tie that the prior breaks toward the slower (wrong)
 * side -- the SAME architectural limitation as the pre-existing bpm=200
 * boundary case (task-T2-report.md, Finding 1), now also observed at
 * bpm=180 on click trains and at 165/180 on backbeat. (2) At a
 * SUFFICIENTLY LOUD ghost note (measured: drumLoop ghostAmp>=0.45), the
 * off-beat becomes comparably strong to the main beat, so the DOUBLED
 * candidate's own track is no longer really "collapsed" at all -- it is
 * genuinely, honestly tracking a real doubled periodicity the content now
 * actually contains -- and `periodMatch` (correctly) does not penalise it.
 * This is a content-level ambiguity, not a labelling defect: even a
 * omniscient "did this candidate collapse" oracle could not resolve it,
 * because the doubled candidate did NOT collapse. See task-T2-report.md
 * "Fix round 2" for the measured backbeat/drumLoop(90, ghostAmp in
 * {0.45,0.6}) case this affects.
 *
 * R4 MEASURED UPDATE (jitter-tolerant penalty, `JITTER_VARIANCE_WEIGHT`):
 * the UNJITTERED drumLoop(90, ghostAmp 0.45/0.6) now RESOLVES to ~90 --
 * not because the doubled candidate got penalised (it still honestly
 * matches its own period, ~0.99) but because the TRUE track's benign
 * DP-tracking jitter (the ~0.84 above) is no longer taxed, lifting its
 * periodMatch enough for salience x prior to win the tie. Limitation (2)'s
 * mechanism claim stands: nothing detects a collapse that did not happen,
 * and the HARDER variant -- a jittered loud-ghost loop (R4 bank
 * `jdrum-90-g0.6-j0.03`) -- still reports 180. Limitation (1) is untouched:
 * on the R4 bank, click-180/200, backbeat-165/180 and jclick-180-j0.04/
 * j0.1 still alias to the half tempo, and drumLoop(75, ghost 0.3/0.6)
 * doubles to 150 -- the same genuine-multi-member tie, broken by the prior
 * toward `PRIOR_CENTER_BPM` in the x2 direction this time. Full per-form
 * numbers: `JITTER_VARIANCE_WEIGHT`'s table and task-R4-report.md.
 *
 * `r=1` (bStar unchanged) is always a member of the family and always in
 * range (bStar itself came from the same [minBpm,maxBpm] search), so this
 * always returns a result.
 */
function chooseOctave(
  odf: Float32Array,
  bStar: number,
  periodFramesRefined: number,
  minBpm: number,
  maxBpm: number
): OctaveChoice {
  let best: OctaveChoice | null = null;
  let bestMetric = -Infinity;
  for (const r of OCTAVE_FAMILY) {
    const bpmR = bStar * r;
    if (bpmR < minBpm || bpmR > maxBpm) continue;
    const periodR = periodFramesRefined / r;
    const beatFrames = trackBeats(odf, periodR);
    const salience = salienceOf(odf, beatFrames);
    const periodMatch = Math.exp(-meanTightnessPenalty(beatFrames, periodR));
    const metric = salience * Math.pow(periodMatch, PERIOD_MATCH_POWER) * priorWeight(bpmR);
    if (metric > bestMetric) {
      bestMetric = metric;
      best = { periodFrames: periodR, beatFrames, salience };
    }
  }
  // r=1 is always a valid member (see doc comment), so `best` is never null.
  return best as OctaveChoice;
}

// ---------------------------------------------------------------------------
// Two-stage beat refinement
// ---------------------------------------------------------------------------

/**
 * Stage (a): parabolic sub-frame fit on `(odf[t-1], odf[t], odf[t+1])`, only
 * applied when `odf[t]` is a local max AND the vertex offset falls in
 * `(-0.5, 0.5)`. This is a SANITY CHECK on the ODF peak shape, not the
 * mechanism that removes the T1 frame-attribution bias (that is stage (b),
 * `refineSampleDomain`) -- per the T1 carry-forward, conflating the two would
 * be wrong.
 */
function parabolicSubFrame(odf: Float32Array, t: number): number {
  const n = odf.length;
  if (t <= 0 || t >= n - 1) return t;
  const yMinus = odf[t - 1];
  const y0 = odf[t];
  const yPlus = odf[t + 1];
  if (!(y0 >= yMinus && y0 >= yPlus)) return t;
  const offset = parabolicOffset(yMinus, y0, yPlus);
  return offset > -0.5 && offset < 0.5 ? t + offset : t;
}

/** Short-time energy `sum(mono[start..start+win)^2)`, zero-padded outside `mono`. */
function shortTimeEnergy(mono: Float32Array, start: number, win: number): number {
  const n = mono.length;
  const lo = Math.max(0, start);
  const hi = Math.min(n, start + win);
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += mono[i] * mono[i];
  return sum;
}

/**
 * Stage (b), sample-domain refinement (T1 carry-forward): the coarse
 * frame-derived sample is a FLOOR of the true attack (see the module-level
 * doc comment above this section), so this searches the asymmetric,
 * forward-biased window `[-D*ONSET_HOP/4, +D*ONSET_HOP]` original samples
 * (= [-256, +1024] at 44.1 kHz / D=4) around `coarseSample` for the maximum
 * of the `REFINE_ENERGY_WIN`-sample short-time energy DERIVATIVE
 * `E[i]-E[i-REFINE_ENERGY_WIN]` on the FULL-RATE mono, computed via an O(1)
 * sliding-window update per candidate position (never re-summing the whole
 * window). Boundary-clamped into `[0, mono.length-1]`.
 */
function refineSampleDomain(mono: Float32Array, coarseSample: number, D: number): number {
  const win = REFINE_ENERGY_WIN;
  const searchLo = -Math.floor((D * ONSET_HOP) / 4);
  const searchHi = D * ONSET_HOP;
  const n = mono.length;

  const pStart = coarseSample + searchLo - win;
  const pEnd = coarseSample + searchHi;
  const eValues = new Float64Array(pEnd - pStart + 1);
  let sum = shortTimeEnergy(mono, pStart, win);
  eValues[0] = sum;
  for (let p = pStart + 1, idx = 1; p <= pEnd; p++, idx++) {
    const outIdx = p - 1;
    const inIdx = p - 1 + win;
    if (outIdx >= 0 && outIdx < n) sum -= mono[outIdx] * mono[outIdx];
    if (inIdx >= 0 && inIdx < n) sum += mono[inIdx] * mono[inIdx];
    eValues[idx] = sum;
  }

  let bestP = coarseSample;
  let bestVal = -Infinity;
  for (let p = coarseSample + searchLo; p <= coarseSample + searchHi; p++) {
    const idx = p - pStart;
    const idxPrev = idx - win;
    if (idxPrev < 0) continue;
    const deriv = eValues[idx] - eValues[idxPrev];
    // `>=`, not `>` (post-T2-review I2 fix): for a sharp attack the
    // derivative is a flat PLATEAU across `win` consecutive positions ending
    // exactly AT the true attack sample (see the worked proof in
    // task-T2-report.md), so ties must resolve to the LATEST (rightmost)
    // position, matching the T1 carry-forward's own "always late, never
    // early" finding -- a strict `>` instead keeps the FIRST (leftmost)
    // position on the plateau, landing `win-1` samples too early.
    if (deriv >= bestVal) {
      bestVal = deriv;
      bestP = p;
    }
  }
  return Math.max(0, Math.min(n > 0 ? n - 1 : 0, bestP));
}

function enforceStrictlyIncreasing(samples: number[]): void {
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] <= samples[i - 1]) samples[i] = samples[i - 1] + 1;
  }
}

function leastSquaresSlope(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = meanOf(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    num += dx * (ys[i] - meanY);
    den += dx * dx;
  }
  return den > 0 ? num / den : 0;
}

function isWithinOctaveFamily(ratio: number): boolean {
  for (const r of OCTAVE_FAMILY) {
    if (Math.abs(ratio - r) <= 0.05 * r) return true;
  }
  return false;
}

/**
 * The first candidate (by descending score) whose bpm ratio to `bStar` is
 * NOT within 5% of any `OCTAVE_FAMILY` member -- i.e. the strongest
 * genuinely-competing (non-harmonically-related) tempo hypothesis. Falls
 * back to a tiny positive epsilon (never 0) in the practically-unreachable
 * case where the whole ~241-candidate grid is octave-related to `bStar`, so
 * `peakRatio` stays finite rather than becoming `Infinity`.
 */
function secondBestOutsideFamily(candidates: TempoCandidate[], bStar: number): number {
  for (let i = 1; i < candidates.length; i++) {
    const ratio = candidates[i].bpm / bStar;
    if (!isWithinOctaveFamily(ratio)) return candidates[i].score;
  }
  return 1e-9;
}

// ---------------------------------------------------------------------------
// analyzeTempo -- full pipeline
// ---------------------------------------------------------------------------

export interface AnalyzeTempoOptions {
  minBpm?: number;
  maxBpm?: number;
}

export interface TempoAnalysis {
  bpm: number | null;
  confidence: number;
  beatSamples: Int32Array;
  salience: number;
  peakRatio: number;
  ibiCv: number;
  truncated: boolean;
  analyzedEndSample: number;
  /** Post-processed onset envelope (unit-std-normalised, half-wave rectified
   * -- the exact array `trackBeats` consumes), retained so a LATER octave
   * correction can re-run `trackBeats` at a corrected period without
   * re-decimating/re-FFT-ing/re-ACF-ing (Task T4 Plan Ruling 4 -- see
   * `deriveGrid`). ~52 KB for a 5-minute track at 43 fps. */
  odf: Float32Array;
  /** The refined period (in ODF frames) that actually produced `beatSamples`
   * -- `octave.periodFrames` from `chooseOctave`, or the period `deriveGrid`
   * was called with for a regridded entry. This is what a x2/(division)2
   * correction control doubles/halves and feeds back into `deriveGrid`. */
  periodFrames: number;
  /** The decimation factor `D` used to produce `odf` -- `computeDecimationFactor
   * (sampleRate)`, a pure function of `sampleRate` alone, but retained
   * directly so `deriveGrid` doesn't need to re-derive it from context. */
  decimationFactor: number;
  /** The onset stage's full log-band matrix (`onsetEnvelope`'s `bands`,
   * `numFrames * numBands` row-major), retained -- per
   * `v15-architecture.md`'s "Where the result is cached" section -- so a
   * remix-level per-boundary descriptor pass (T9's `deriveRemixFeatures`)
   * reads timbre/level directly off it instead of re-running the onset FFT.
   * GAP CLOSED BY T9 (was previously computed by `onsetEnvelope` and then
   * silently discarded by `analyzeTempo`'s destructure, even though the
   * architecture doc already described it as retained -- see the T9 task
   * report for the full evidence trail): every `analyzeTempo` return path now
   * threads it through. `deriveGrid` (the 'regrid' fast path) has no onset
   * data to source this from and returns an EMPTY array here -- documented at
   * its own call site, matching how it already leaves `confidence`/
   * `peakRatio` at 0 for the same reason. */
  bands: Float32Array;
  /** Number of columns in `bands` (see `OnsetEnvelopeResult.numBands` --
   * usually 24, can be less at unusually low decimated rates). 0 when `bands`
   * is empty (the `deriveGrid` path, or a too-short-audio guard). */
  numBands: number;
  /** The onset stage's low-band-restricted flux envelope (`onsetEnvelope`'s
   * `odfLow`, same length and shared normalisation scale as `odf`), retained
   * for the same reason as `bands` -- T9's downbeat-phase detector needs it
   * and must not re-run the onset pass to get it. Empty from `deriveGrid`. */
  odfLow: Float32Array;
}

function emptyTempoAnalysis(
  analyzedEndSample: number,
  truncated: boolean,
  odf: Float32Array = new Float32Array(0),
  periodFrames = 0,
  decimationFactor = 1,
  bands: Float32Array = new Float32Array(0),
  numBands = 0,
  odfLow: Float32Array = new Float32Array(0)
): TempoAnalysis {
  return {
    bpm: null,
    confidence: 0,
    beatSamples: new Int32Array(0),
    salience: 0,
    peakRatio: 0,
    ibiCv: 0,
    truncated,
    analyzedEndSample,
    odf,
    periodFrames,
    decimationFactor,
    bands,
    numBands,
    odfLow,
  };
}

interface RefinedBeats {
  beatSamples: Int32Array;
  bpm: number;
  ibiCv: number;
}

/**
 * Two-stage sample-accurate refinement (parabolic sub-frame + sample-domain
 * energy-derivative search) applied to a set of ODF-frame beat positions,
 * followed by least-squares BPM regression and inter-beat-interval CV.
 * Shared between `analyzeTempo`'s own tail and `deriveGrid` (Task T4 Plan
 * Ruling 4) so a period correction reuses EXACTLY the refinement math a full
 * analysis uses, rather than a re-derived copy that could silently drift
 * from it. Returns `null` for a degenerate beat set (fewer than 2 beats, or
 * a non-positive regression slope -- mathematically unreachable given >=2
 * STRICTLY increasing refined samples, kept as a defensive guard matching
 * the one `analyzeTempo` already had before this was extracted).
 */
function refineAndMeasure(
  odf: Float32Array,
  beatFrames: Int32Array,
  analyzed: Float32Array,
  sampleRate: number,
  D: number
): RefinedBeats | null {
  if (beatFrames.length < 2) return null;

  const refinedSamples: number[] = new Array(beatFrames.length);
  for (let i = 0; i < beatFrames.length; i++) {
    const f = parabolicSubFrame(odf, beatFrames[i]);
    const coarseSample = Math.round((f * ONSET_HOP + ONSET_FFT * ONSET_ATTRIBUTION_FRAC) * D);
    refinedSamples[i] = refineSampleDomain(analyzed, coarseSample, D);
  }
  enforceStrictlyIncreasing(refinedSamples);

  const slope = leastSquaresSlope(refinedSamples);
  if (!(slope > 0)) return null;
  const bpm = (60 * sampleRate) / slope;

  const diffs: number[] = new Array(refinedSamples.length - 1);
  for (let i = 1; i < refinedSamples.length; i++) diffs[i - 1] = refinedSamples[i] - refinedSamples[i - 1];
  const diffMean = meanOf(diffs);
  let variance = 0;
  for (let i = 0; i < diffs.length; i++) variance += (diffs[i] - diffMean) * (diffs[i] - diffMean);
  variance /= diffs.length > 0 ? diffs.length : 1;
  const ibiCv = diffMean > 0 ? Math.sqrt(variance) / diffMean : 0;

  return { beatSamples: Int32Array.from(refinedSamples), bpm, ibiCv };
}

/**
 * Full tempo pipeline: decimate -> onset envelope -> autocorrelation ->
 * tempo-candidate scoring + octave-disambiguated period -> Ellis beat DP ->
 * two-stage sample-accurate refinement -> least-squares BPM regression ->
 * confidence. Progress is composed 0->0.05 (decimate), 0.05->0.75 (onset
 * envelope), 0.75->0.85 (tempo candidate scoring + period refinement),
 * 0.85->1.0 (octave DP + beat refinement). Never throws on any audio CONTENT;
 * every guard path returns finite fields. Invalid OPTIONS are the one
 * exception (v1.5.2): a non-positive or inverted BPM range throws a
 * RangeError up front -- scoreTempoCandidates' grid is multiplicative
 * (`bpm *= CANDIDATE_STEP`), so `minBpm <= 0` never advances and would loop
 * forever. Does not mutate `mono`.
 */
export function analyzeTempo(
  mono: Float32Array,
  sampleRate: number,
  opts?: AnalyzeTempoOptions,
  onProgress?: (fraction: number) => void
): TempoAnalysis {
  const minBpm = opts?.minBpm ?? MIN_BPM;
  const maxBpm = opts?.maxBpm ?? MAX_BPM;

  // Fail fast on an unusable BPM range (v1.5.2) -- BEFORE any content-based
  // early return, so a hostile range throws consistently instead of hanging
  // only on inputs long enough to reach the candidate grid. Latent today
  // (every in-app caller passes the 60/200 defaults), but AnalyzeTempoOptions
  // is exported.
  if (minBpm <= 0 || maxBpm < minBpm) {
    throw new RangeError(
      `analyzeTempo: invalid BPM range (minBpm ${minBpm}, maxBpm ${maxBpm}; need 0 < minBpm <= maxBpm)`
    );
  }

  const maxSamples = Math.round(MAX_ANALYSIS_SECONDS * sampleRate);
  const truncated = mono.length > maxSamples;
  const analyzedEndSample = truncated ? maxSamples : mono.length;
  const analyzed = mono.subarray(0, analyzedEndSample);

  if (analyzedEndSample / sampleRate < MIN_ANALYSIS_SECONDS) {
    return emptyTempoAnalysis(analyzedEndSample, truncated);
  }

  onProgress?.(0);
  const { signal, rate, factor: D } = decimateMono(analyzed, sampleRate);
  onProgress?.(0.05);

  const { odf, bands, numBands, odfLow, numFrames, odfRate } = onsetEnvelope(signal, rate, (f) => {
    onProgress?.(0.05 + (f / 0.9) * 0.7);
  });
  onProgress?.(0.75);

  let odfMax = 0;
  for (let t = 0; t < numFrames; t++) if (odf[t] > odfMax) odfMax = odf[t];
  if (!(odfMax > 0)) {
    // All-zero / silent / pure-DC ODF (T1's onsetEnvelope already collapses
    // these to all-zero via its own std<1e-9 short-circuit).
    return emptyTempoAnalysis(analyzedEndSample, truncated, odf, 0, D, bands, numBands, odfLow);
  }

  const acf = autocorrelate(odf);
  const candidates = scoreTempoCandidates(acf, odfRate, minBpm, maxBpm);
  const bStar = candidates[0].bpm;
  const bestScore = candidates[0].score;
  const rawPeriodFrames = (60 * odfRate) / bStar;
  const periodFramesRefined = refinePeriodFrames(acf, rawPeriodFrames);
  onProgress?.(0.85);

  const octave = chooseOctave(odf, bStar, periodFramesRefined, minBpm, maxBpm);
  const beatFrames = octave.beatFrames;
  if (beatFrames.length < 2) {
    return emptyTempoAnalysis(analyzedEndSample, truncated, odf, octave.periodFrames, D, bands, numBands, odfLow);
  }

  // Mathematically the `null` (slope <= 0) branch below is unreachable given
  // >=2 STRICTLY increasing refined samples paired with evenly-spaced
  // indices (the least-squares slope of a strictly monotonic sequence is
  // always positive) -- kept as a defensive guard, but post-T2-review it
  // must return the SAME null-bpm/empty-beats invariant as every other guard
  // rather than a bpm:null result carrying non-empty beatSamples.
  const refined = refineAndMeasure(odf, beatFrames, analyzed, sampleRate, D);
  if (!refined) {
    return emptyTempoAnalysis(analyzedEndSample, truncated, odf, octave.periodFrames, D, bands, numBands, odfLow);
  }
  const { beatSamples, bpm, ibiCv } = refined;

  const secondBest = secondBestOutsideFamily(candidates, bStar);
  const rawPeakRatio = secondBest > 0 ? bestScore / secondBest : 0;
  const peakRatio = Number.isFinite(rawPeakRatio) ? rawPeakRatio : 0;

  // CRITICAL FIX (post-T2-review C2): the original sSal = clamp01((salience-1)/2)
  // answers "did the DP produce an evenly-spaced track on ODF peaks", which
  // is true almost by construction for ANY non-degenerate content (the DP's
  // tightness penalty structurally forces a low-IBI-CV track regardless of
  // whether the underlying peaks are musically meaningful) -- measured
  // salience=4.76 on pure LCG noise, comfortably past this term's own
  // saturation point (salience=3). Replaced with peak PROMINENCE of the
  // unweighted comb over the whole candidate grid (`max(comb)/mean(comb)`,
  // no prior, no octave-family exclusion), which answers "is there real
  // periodic structure at all" instead. sPeak's divisor was widened
  // (0.5 -> PEAK_RATIO_SCALE) for the same reason: it also saturated on
  // noise's peakRatio (a ratio of two prior-weighted scores on a near-flat
  // acf, which turns out not to require much daylight to exceed 1.5).
  const prominence = combProminence(candidates);
  const sProm = clamp01((prominence - PROMINENCE_FLOOR) / PROMINENCE_SCALE);
  const sPeak = clamp01((peakRatio - 1) / PEAK_RATIO_SCALE);
  const sReg = clamp01(1 - ibiCv / 0.1);
  const confidence = 0.5 * sProm + 0.3 * sPeak + 0.2 * sReg;

  onProgress?.(1);

  return {
    bpm,
    confidence,
    beatSamples,
    salience: octave.salience,
    peakRatio,
    ibiCv,
    truncated,
    analyzedEndSample,
    odf,
    periodFrames: octave.periodFrames,
    decimationFactor: D,
    bands,
    numBands,
    odfLow,
  };
}

// ---------------------------------------------------------------------------
// deriveGrid -- regrid path (Task T4 Plan Ruling 4)
// ---------------------------------------------------------------------------

/**
 * Re-tracks the beat grid at a caller-specified `periodFrames` WITHOUT a
 * full re-analysis: no decimation, no FFT, no ACF, no tempo-candidate/octave
 * search -- just `trackBeats` (Ellis DP) at the given period, followed by
 * the SAME two-stage sample-accurate refinement `analyzeTempo` uses
 * (`refineAndMeasure`). This is the function the plan's octave-correction
 * carry-forward requires: the x2/(divide)2 control MUST call this to
 * physically re-track the grid at half/double the period, not merely
 * relabel the displayed BPM -- relabelling alone would leave `beatSamples`
 * at the WRONG density (half or double the true beat count) while
 * displaying the corrected number, which is exactly the failure mode the
 * carry-forward forbids.
 *
 * `D` (the decimation factor) is recomputed via `computeDecimationFactor
 * (sampleRate)` -- a pure function of `sampleRate` alone -- rather than
 * threaded across the worker boundary as a separate field, keeping the
 * `level:'regrid'` worker message to exactly `{mono, sampleRate, odf,
 * periodFrames}` per the plan. `analyzedEndSample`/`truncated` are
 * similarly re-derived the same way `analyzeTempo` computes them, from
 * `mono.length` and `sampleRate` alone.
 *
 * `confidence` and `peakRatio` are set to 0 here -- this function genuinely
 * has no ACF/candidate data to compute them from (that is the whole point:
 * it never touches the ACF). The caller (`tempoAnalysis.ts`'s
 * `regridTempo`) carries those two fields over from the entry being
 * corrected instead, since a period correction changes which octave-family
 * member is displayed, not whether the content has real periodic structure
 * or how the winning family competed against alternatives.
 *
 * Never mutates `mono` or `odf`. Does not throw; a degenerate `periodFrames`
 * (too few beats, or fewer than 2 in `odf`'s length) returns the same
 * null-bpm/empty-beats shape `analyzeTempo`'s own guards return.
 */
export function deriveGrid(mono: Float32Array, sampleRate: number, odf: Float32Array, periodFrames: number): TempoAnalysis {
  const D = computeDecimationFactor(sampleRate);
  const maxSamples = Math.round(MAX_ANALYSIS_SECONDS * sampleRate);
  const truncated = mono.length > maxSamples;
  const analyzedEndSample = truncated ? maxSamples : mono.length;
  const analyzed = mono.subarray(0, analyzedEndSample);

  const beatFrames = trackBeats(odf, periodFrames);
  if (beatFrames.length < 2) {
    return emptyTempoAnalysis(analyzedEndSample, truncated, odf, periodFrames, D);
  }

  const refined = refineAndMeasure(odf, beatFrames, analyzed, sampleRate, D);
  if (!refined) {
    return emptyTempoAnalysis(analyzedEndSample, truncated, odf, periodFrames, D);
  }

  return {
    bpm: refined.bpm,
    confidence: 0,
    beatSamples: refined.beatSamples,
    salience: salienceOf(odf, beatFrames),
    peakRatio: 0,
    ibiCv: refined.ibiCv,
    truncated,
    analyzedEndSample,
    odf,
    periodFrames,
    decimationFactor: D,
    // deriveGrid never re-runs the onset pass -- see the doc comment above:
    // it has no `bands`/`odfLow` to source these from, so a regrid always
    // reports them empty (same "genuinely doesn't have the data" precedent
    // as confidence/peakRatio above).
    bands: new Float32Array(0),
    numBands: 0,
    odfLow: new Float32Array(0),
  };
}
