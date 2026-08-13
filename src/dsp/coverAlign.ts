/**
 * Task CP1 — global alignment of a cover take to the original vocal.
 *
 * ── What this is, said plainly ──────────────────────────────────────────────
 * ONE number: where the take's first sample belongs on the original's timeline.
 * It is a PLACEMENT, not a warp — nothing here stretches, nudges a syllable or
 * touches a sample. A take that drifts against the original stays drifting; the
 * app's warp tools (Align Vocal Timing, Align Lyrics) are deliberately manual
 * because they need a confirmed grid and a chosen word, and this stage does not
 * pretend to replace them.
 *
 * ── It composes; it does not re-implement ───────────────────────────────────
 * The feature this correlates is the app's OWN onset-strength envelope —
 * `tempoCore.onsetEnvelope`, the log-band spectral flux the tempo tracker and
 * the beat grid already run on, over `tempoCore.decimateMono` — reduced to mono
 * by `chainAnalysis.monoMix` and transformed by `fft`/`ifft`. Nothing about
 * attack detection is invented here.
 *
 * Correlating the ONSET envelope rather than a level envelope is the decision
 * that makes the refusal arm work at all. Two unrelated recordings of singing
 * have similar amounts of silence and similar loud sections, so their LEVEL
 * envelopes correlate on the shape of "someone is singing"; their attacks do
 * not line up, and a flux envelope is zero everywhere except at an attack.
 *
 * ── Two passes, because one cannot do both jobs ─────────────────────────────
 * This was built as a single full-rate pass first, and MEASURED. Framing the
 * audio at 44.1 kHz gives 5.8 ms frames — lovely time resolution — but
 * `onsetEnvelope`'s FFT size and band table are fixed, so at 44.1 kHz its 24
 * log bands from 80 Hz to 3.5 kHz fall on 43 Hz-wide bins and the narrow low
 * ones collapse into each other. The flux gets noisy, and the populations the
 * confidence has to separate OVERLAPPED: across 24 constructed pairs the worst
 * cover scored 0.152 prominence and the best unrelated pair scored 0.155. There
 * is no threshold in a negative gap.
 *
 * The second attempt ran the coarse pass over `tempoCore.decimateMono`, whose
 * ~11 kHz target gives the sharpest bands of all — and it was measured too, and
 * it was WORSE (worst cover 0.2035 against best unrelated 0.2045). Sharper bands
 * on their own are not the answer either.
 *
 * What ships is the rate the sweep actually separated on,
 * {@link ALIGN_ANALYSIS_RATE_HZ}: bins 21.5 Hz wide, every band resolved, and
 * still enough bandwidth that a vocal's 80 Hz–3.5 kHz is entirely inside it. The
 * two questions are then asked separately, of the pass that can answer each:
 *
 *   - WHERE, ROUGHLY, and CAN IT BE BELIEVED — on the ODF of both signals
 *     brought to that ONE fixed analysis rate, so the flux each carries is
 *     computed over identical bands whatever the files' own rates were. This is
 *     the pass the confidence comes from, and it searches every lag.
 *   - EXACTLY WHERE — on the ODF of each signal at its OWN rate (5.8 ms frames
 *     at 44.1 kHz against the coarse pass's 11.6 ms), correlated ONLY inside
 *     ±{@link ALIGN_REFINE_SECONDS} of the coarse answer, where the band noise
 *     no longer has a wrong lag to prefer, and interpolated parabolically on
 *     top of that.
 *
 * Both passes put their envelopes on the SAME frame grid,
 * {@link ALIGN_FRAME_RATE_HZ}, so a lag means the same thing whatever the two
 * files' rates are — and so the coarse answer can be handed to the fine pass as
 * a window without a units conversion in between.
 *
 * `onsetEnvelope`'s frame-attribution bias (module note in `tempoCore`: an
 * attack lands up to one hop LATE) applies identically to both signals and so
 * cancels in a cross-correlation. It would matter to an absolute beat position;
 * it does not matter to a difference of two.
 *
 * ── Confidence: two numbers, both measured, and an honest refusal ───────────
 * `peakCorrelation` is the Pearson correlation of the two coarse envelopes at
 * the winning lag. `prominence` is that peak minus the best rival lag at least
 * {@link ALIGN_GUARD_SECONDS} away — "is there ONE lag that stands out", which
 * is the question, because a flat correlation surface with a high peak is a
 * coincidence and a sharp peak at a modest correlation is an alignment.
 *
 * Both thresholds come from the sweep in `coverAlign.test.ts` and the test
 * asserts the shipped constants still sit strictly inside the measured gap. See
 * the constants for the figures.
 */

import { monoMix } from './chainAnalysis';
import { fft, ifft, nextPow2 } from './fft';
import { resampleChannel } from './resample';
import { onsetEnvelope } from './tempoCore';

/**
 * The common frame grid the FINE envelopes are resampled onto, in frames per
 * second. 200 Hz is 5 ms per lag, comfortably inside the ±10 ms the alignment
 * is required to hit before the parabolic interpolation is counted at all —
 * chosen so the requirement does not RELY on the interpolation.
 */
export const ALIGN_FRAME_RATE_HZ = 200;

/**
 * The one rate BOTH signals are brought to before the coarse pass frames them.
 * See the module header for the two rates this was measured against and why
 * each lost. A file already at this rate is copied rather than resampled; a file
 * BELOW it is resampled up, which invents no detail but does keep the two ODFs
 * on one grid, and a pair of files at very different rates simply has less
 * shared spectrum to correlate — that shows up as a lower peak, which is
 * exactly what the confidence floor is for.
 */
export const ALIGN_ANALYSIS_RATE_HZ = 22050;

/**
 * The coarse pass's grid — the SAME grid, deliberately. Leaving the coarse ODF
 * on its own 86.1 frames/s was measured as well and lost (worst cover 0.1476
 * against best unrelated 0.1829): a rival search that samples the correlation
 * surface coarsely finds a lower runner-up than the surface really has, which
 * inflates the prominence of coincidences more than it inflates the prominence
 * of alignments. One grid for both passes is also what lets the coarse offset be
 * handed to the fine pass as a window with no conversion.
 */
export const ALIGN_COARSE_FRAME_RATE_HZ = ALIGN_FRAME_RATE_HZ;

/**
 * How far the fine pass is allowed to move the coarse answer. One coarse frame
 * is 11.6 ms and the coarse peak is interpolated, so the residual is a small
 * multiple of that; 0.2 s is an order of magnitude of headroom and still narrow
 * enough that the fine pass cannot wander to a different verse.
 */
export const ALIGN_REFINE_SECONDS = 0.2;

/**
 * How far from the winning lag a rival has to be before it counts as a rival.
 * A correlation peak has shoulders — the frames either side of the true lag are
 * high because a syllable is not an impulse — and counting one of those as the
 * runner-up would report prominence ~0 for a perfect alignment. 0.35 s is just
 * over the longest syllable the ground-truth schedule draws (0.37 s of attack
 * plus decay, whose correlation shoulder is roughly half that).
 */
export const ALIGN_GUARD_SECONDS = 0.35;

/**
 * The shortest overlap a lag may be evaluated at. Below this the Pearson
 * denominator is computed over a handful of frames and returns ±1 for any two
 * signals at all — the classic normalised-cross-correlation edge artefact. Two
 * seconds, or 20 % of the shorter recording when that is more, so a short take
 * against a long song is still allowed most of its lag range.
 */
export const ALIGN_MIN_OVERLAP_SECONDS = 2;

/** …and the fraction of the shorter signal that overrides it when larger. */
export const ALIGN_MIN_OVERLAP_FRACTION = 0.2;

/**
 * The prominence a result must reach to be BELIEVED.
 *
 * MEASURED, in `coverAlign.test.ts` → "the measured separation", which prints
 * both populations every run and asserts this constant still sits between them.
 * Sixteen constructed cover pairs — one syllable schedule sung at pitches scaled
 * 1.26×, with ±50 % dynamics jitter and noise on top, 44.1 kHz against 48 kHz —
 * against sixteen pairs with no relation at all:
 *
 *     cover prominence      0.2092 … 0.5093
 *     unrelated prominence  0.0002 … 0.1635
 *
 * 0.186 is the middle of that gap. It is not rounded to something prettier on
 * purpose: it is a point inside a measured interval, not a preference.
 */
export const ALIGN_MIN_PROMINENCE = 0.186;

/**
 * …and the floor on the peak correlation itself, which catches the other
 * failure: a low, flat correlation surface can produce a prominent peak out of
 * noise. Same sweep, same test, and a much wider gap:
 *
 *     cover correlation     0.7674 … 0.8325
 *     unrelated correlation 0.2937 … 0.4476
 *
 * 0.607 is the middle of THAT gap. Both floors must be cleared: a run is
 * believed only when the surface has a peak worth having AND one lag that stands
 * out from the field.
 */
export const ALIGN_MIN_CORRELATION = 0.607;

export interface AlignmentMeasurement {
  /**
   * Where the take's sample 0 belongs on the reference's timeline, in seconds.
   * POSITIVE means the take starts later than the reference does; negative
   * means it starts before the reference's own zero.
   */
  offsetSeconds: number;
  /** Pearson correlation of the two coarse onset envelopes at the winning lag,
   * in [−1, 1]. */
  peakCorrelation: number;
  /** The best rival at least {@link ALIGN_GUARD_SECONDS} away. */
  rivalCorrelation: number;
  /** `peakCorrelation − rivalCorrelation`. The confidence. */
  prominence: number;
  /** True when BOTH measured thresholds are met. */
  confident: boolean;
  /** What the coarse pass alone said, before the fine pass refined it. Reported
   * because the difference between the two is the only evidence that the
   * refinement stayed inside its window rather than finding a new answer. */
  coarseOffsetSeconds: number;
  /** How many coarse lags carried enough overlap to be evaluated. */
  lagsEvaluated: number;
  /** The overlap, in seconds, at the winning coarse lag. */
  overlapSeconds: number;
}

/**
 * Linear resampling of an envelope onto a new frame rate. Linear rather than
 * band-limited on purpose: an onset envelope is already a heavily smoothed,
 * locally-mean-rectified curve, and a sinc kernel would ring negative lobes into
 * a quantity whose zeros mean "no attack here".
 */
function resampleEnvelope(env: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return env;
  const outLen = Math.max(1, Math.floor((env.length * toRate) / fromRate));
  const out = new Float32Array(outLen);
  const step = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const x = i * step;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, env.length - 1);
    const f = x - i0;
    out[i] = env[i0] * (1 - f) + env[i1] * f;
  }
  return out;
}

/** The ODF of `mono` at `rate`, or `null` when there is no attack in it —
 * `onsetEnvelope` short-circuits to all-zero below its own 1e-9
 * standard-deviation floor, and a constant envelope has no lag to prefer.
 * `gridRate` of `null` keeps the ODF on its own frame rate. */
function odfOrNull(mono: Float32Array, rate: number, gridRate: number | null): Float32Array | null {
  const { odf, odfRate, numFrames } = onsetEnvelope(mono, rate);
  if (numFrames < 2) return null;
  let nonZero = 0;
  for (let i = 0; i < odf.length; i++) if (odf[i] !== 0) nonZero++;
  if (nonZero === 0) return null;
  const grid = gridRate === null ? odf : resampleEnvelope(odf, odfRate, gridRate);
  return grid.length >= 2 ? grid : null;
}

export interface AlignmentEnvelopes {
  /** On {@link ALIGN_COARSE_FRAME_RATE_HZ}, from the signal brought to
   * {@link ALIGN_ANALYSIS_RATE_HZ}. */
  coarse: Float32Array;
  /** On {@link ALIGN_FRAME_RATE_HZ}, from the signal at its own rate. */
  fine: Float32Array;
}

/**
 * The two onset envelopes this module aligns on — or `null` when there is
 * nothing to align: no samples, a signal shorter than one analysis frame, or
 * audio with no attack anywhere in it.
 *
 * Exported because it is where a refusal is DECIDED, and a refusal the tests
 * cannot reach independently of the correlation is a refusal nobody has checked.
 */
export function alignmentOdf(
  channels: Float32Array[],
  sampleRate: number
): AlignmentEnvelopes | null {
  if (channels.length === 0 || channels[0].length === 0) return null;
  if (!(sampleRate > 0)) return null;
  const mono = monoMix(channels);
  // One hop is the smallest thing `onsetEnvelope` can report a difference
  // across; below one FFT window there is no flux, only the first frame's zero.
  if (mono.length < 1024) return null;

  const analysis =
    sampleRate === ALIGN_ANALYSIS_RATE_HZ
      ? mono
      : resampleChannel(mono, sampleRate, ALIGN_ANALYSIS_RATE_HZ);
  if (analysis.length < 1024) return null;

  // No grid conversion on the coarse ODF: `analysis` is at the same rate for
  // every caller, so the two ODFs being compared are already on one grid.
  const coarse = odfOrNull(analysis, ALIGN_ANALYSIS_RATE_HZ, ALIGN_COARSE_FRAME_RATE_HZ);
  if (!coarse) return null;
  const fine = odfOrNull(mono, sampleRate, ALIGN_FRAME_RATE_HZ);
  if (!fine) return null;
  return { coarse, fine };
}

/** Prefix sums of `v` and of `v²`, as float64 — the Pearson denominators are
 * differences of large partial sums and float32 loses them. */
function prefixSums(v: Float32Array): { sum: Float64Array; sumSq: Float64Array } {
  const n = v.length;
  const sum = new Float64Array(n + 1);
  const sumSq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    sum[i + 1] = sum[i] + v[i];
    sumSq[i + 1] = sumSq[i] + v[i] * v[i];
  }
  return { sum, sumSq };
}

/**
 * Raw cross-correlation `c[k] = Σ a[i]·b[i−k]` for every lag, via one forward
 * FFT per signal and one inverse. `k` is read modulo `N`, so `c[N−m]` is lag
 * `−m`; `N ≥ La + Lb` keeps the wrap from folding one lag's sum onto another's.
 */
function rawCorrelation(a: Float32Array, b: Float32Array): { c: Float32Array; n: number } {
  const N = nextPow2(a.length + b.length);
  const aRe = new Float32Array(N);
  const aIm = new Float32Array(N);
  const bRe = new Float32Array(N);
  const bIm = new Float32Array(N);
  aRe.set(a);
  bRe.set(b);
  fft(aRe, aIm);
  fft(bRe, bIm);
  // A · conj(B), in place in the a buffers.
  for (let i = 0; i < N; i++) {
    const re = aRe[i] * bRe[i] + aIm[i] * bIm[i];
    const im = aIm[i] * bRe[i] - aRe[i] * bIm[i];
    aRe[i] = re;
    aIm[i] = im;
  }
  ifft(aRe, aIm);
  return { c: aRe, n: N };
}

interface LagSurface {
  /** Pearson correlation per lag, indexed from `kLo`. */
  rho: Float64Array;
  /** Overlap in frames per lag; 0 means "not evaluated". */
  overlap: Int32Array;
  kLo: number;
  bestIdx: number;
  evaluated: number;
}

/**
 * The normalised cross-correlation surface of two envelopes, with the lags that
 * do not overlap by `minOverlap` left unevaluated. `window`, when given,
 * restricts the search to lags within `halfWidth` frames of `centre` — the fine
 * pass's whole safeguard against finding a different verse.
 */
function lagSurface(
  a: Float32Array,
  b: Float32Array,
  minOverlap: number,
  window?: { centre: number; halfWidth: number }
): LagSurface | null {
  const La = a.length;
  const Lb = b.length;
  const { c, n: N } = rawCorrelation(a, b);
  const pa = prefixSums(a);
  const pb = prefixSums(b);

  const kLo = -(Lb - 1);
  const kHi = La - 1;
  const rho = new Float64Array(kHi - kLo + 1);
  const overlap = new Int32Array(kHi - kLo + 1);
  let evaluated = 0;
  let bestIdx = -1;

  for (let k = kLo; k <= kHi; k++) {
    if (window && Math.abs(k - window.centre) > window.halfWidth) continue;
    const idx = k - kLo;
    const iLo = Math.max(0, k);
    const iHi = Math.min(La - 1, Lb - 1 + k);
    const count = iHi - iLo + 1;
    if (count < minOverlap) continue;

    const jLo = iLo - k;
    const jHi = iHi - k;
    const sa = pa.sum[iHi + 1] - pa.sum[iLo];
    const saa = pa.sumSq[iHi + 1] - pa.sumSq[iLo];
    const sb = pb.sum[jHi + 1] - pb.sum[jLo];
    const sbb = pb.sumSq[jHi + 1] - pb.sumSq[jLo];
    const sab = c[k >= 0 ? k : N + k];

    const varA = count * saa - sa * sa;
    const varB = count * sbb - sb * sb;
    if (varA <= 0 || varB <= 0) continue;

    rho[idx] = (count * sab - sa * sb) / Math.sqrt(varA * varB);
    overlap[idx] = count;
    evaluated++;
    if (bestIdx < 0 || rho[idx] > rho[bestIdx]) bestIdx = idx;
  }

  return bestIdx < 0 ? null : { rho, overlap, kLo, bestIdx, evaluated };
}

/**
 * The peak's lag in frames, interpolated parabolically across its two evaluated
 * neighbours. A peak at the very edge of the evaluated range keeps its integer
 * lag rather than extrapolating off the end.
 */
function interpolatedLag(s: LagSurface): number {
  const { rho, overlap, bestIdx, kLo } = s;
  const left = bestIdx - 1;
  const right = bestIdx + 1;
  let delta = 0;
  if (left >= 0 && right < rho.length && overlap[left] > 0 && overlap[right] > 0) {
    const denom = rho[left] - 2 * rho[bestIdx] + rho[right];
    if (denom !== 0) {
      delta = (0.5 * (rho[left] - rho[right])) / denom;
      if (!Number.isFinite(delta) || Math.abs(delta) > 0.5) delta = 0;
    }
  }
  return bestIdx + kLo + delta;
}

/** The best correlation at least `guardFrames` away from the winner, or 0 when
 * no lag outside the guard was evaluable at all — the two recordings are then
 * short enough that the guard swallows the whole surface, nothing stands out
 * relative to nothing, and the correlation floor is what carries the decision. */
function rivalOf(s: LagSurface, guardFrames: number): number {
  let rival = -1;
  for (let idx = 0; idx < s.rho.length; idx++) {
    if (s.overlap[idx] === 0) continue;
    if (Math.abs(idx - s.bestIdx) < guardFrames) continue;
    if (s.rho[idx] > rival) rival = s.rho[idx];
  }
  return rival === -1 ? 0 : rival;
}

function minOverlapFrames(La: number, Lb: number, frameRate: number): number {
  return Math.max(
    Math.round(ALIGN_MIN_OVERLAP_SECONDS * frameRate),
    Math.round(Math.min(La, Lb) * ALIGN_MIN_OVERLAP_FRACTION)
  );
}

/**
 * Aligns `take` to `reference` globally, or refuses.
 *
 * Returns `null` when the question cannot be asked — either side with no onset
 * at all, or two recordings that cannot overlap by
 * {@link ALIGN_MIN_OVERLAP_SECONDS}. A refusal on CONFIDENCE is not a `null`:
 * it comes back as a measurement with `confident: false` and the numbers that
 * decided it, because the caller has to be able to say why.
 */
export function alignTakeToReference(
  reference: Float32Array[],
  referenceRate: number,
  take: Float32Array[],
  takeRate: number
): AlignmentMeasurement | null {
  const a = alignmentOdf(reference, referenceRate);
  const b = alignmentOdf(take, takeRate);
  if (!a || !b) return null;

  const coarseMin = minOverlapFrames(
    a.coarse.length,
    b.coarse.length,
    ALIGN_COARSE_FRAME_RATE_HZ
  );
  if (Math.min(a.coarse.length, b.coarse.length) < coarseMin) return null;

  const coarse = lagSurface(a.coarse, b.coarse, coarseMin);
  if (!coarse) return null;

  const peak = coarse.rho[coarse.bestIdx];
  const rival = rivalOf(coarse, Math.round(ALIGN_GUARD_SECONDS * ALIGN_COARSE_FRAME_RATE_HZ));
  const prominence = peak - rival;
  const coarseOffsetSeconds = interpolatedLag(coarse) / ALIGN_COARSE_FRAME_RATE_HZ;

  // The fine pass never gets to disagree about WHICH alignment this is — only
  // about where inside ±ALIGN_REFINE_SECONDS of it the peak really sits.
  const fineMin = minOverlapFrames(a.fine.length, b.fine.length, ALIGN_FRAME_RATE_HZ);
  const fine = lagSurface(a.fine, b.fine, fineMin, {
    centre: coarseOffsetSeconds * ALIGN_FRAME_RATE_HZ,
    halfWidth: ALIGN_REFINE_SECONDS * ALIGN_FRAME_RATE_HZ,
  });

  const offsetSeconds = fine
    ? interpolatedLag(fine) / ALIGN_FRAME_RATE_HZ
    : coarseOffsetSeconds;

  return {
    offsetSeconds,
    peakCorrelation: peak,
    rivalCorrelation: rival,
    prominence,
    confident: prominence >= ALIGN_MIN_PROMINENCE && peak >= ALIGN_MIN_CORRELATION,
    coarseOffsetSeconds,
    lagsEvaluated: coarse.evaluated,
    overlapSeconds: coarse.overlap[coarse.bestIdx] / ALIGN_COARSE_FRAME_RATE_HZ,
  };
}
