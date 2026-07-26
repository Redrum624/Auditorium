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
 * Decimates `mono` toward `TARGET_ANALYSIS_RATE` by an integer factor
 * `D = clamp(round(sampleRate / TARGET_ANALYSIS_RATE), 1, 8)`, anti-aliasing
 * with a triple-cascaded boxcar first (`boxcarStageWindows`). Never mutates
 * `mono`. Allocates only two full-length scratch buffers (not three): the
 * final cascade stage writes its strided (every-`D`-th) result straight into
 * the decimated-size output via `centeredSumStrided`.
 */
export function decimateMono(mono: Float32Array, sampleRate: number): DecimateResult {
  const factor = clamp(Math.round(sampleRate / TARGET_ANALYSIS_RATE), 1, 8);

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
