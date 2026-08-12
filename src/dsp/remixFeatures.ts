/**
 * Remix analysis (v1.5 feature set, T9): chroma features, downbeat-phase
 * detection, drift-following bar boundaries, per-boundary descriptors and
 * section clusters. Pure, synchronous, no Worker/DOM globals -- runs inside
 * `tempo.worker.ts` at `level:'remix'` as well as in tests. Builds on
 * `tempoCore.ts`'s `analyzeTempo` output (sample-accurate `beatSamples`,
 * the onset stage's `odf`/`odfLow`/`bands`/`numBands`).
 *
 * ## GAP CLOSED IN `tempoCore.ts` AS PART OF THIS TASK
 *
 * `TempoAnalysis` did not retain `bands`/`numBands`/`odfLow` before this task
 * -- `onsetEnvelope` computed all three, but `analyzeTempo`'s own destructure
 * (`const { odf, numFrames, odfRate } = onsetEnvelope(...)`) silently dropped
 * them, even though `v15-architecture.md`'s "Where the result is cached"
 * section already described `bands` as retained ("`bands` 1.24 MB ... at
 * level tempo") and T4's own `runRemixAnalysis` level-policy doc comment
 * describes a rejected alternative ("shipping cached `bands` back down to the
 * worker") that presupposes `bands` already exists on the cached analysis.
 * Both this task's own function signature (`deriveRemixFeatures(tempo:
 * TempoAnalysis, ...)` needing timbre/level data and a low-band envelope for
 * downbeat detection) and the architecture doc's stated intent require these
 * three fields to survive on `TempoAnalysis`, so `tempoCore.ts` was widened
 * (interface + every `analyzeTempo`/`emptyTempoAnalysis` return path) rather
 * than having this module re-run the onset FFT independently (which would
 * have silently duplicated ~1.5 s of work every remix analysis and defeated
 * the entire "re-derive without re-FFT" design point). `deriveGrid` (the
 * 'regrid' fast path) has no onset data to source these from and reports them
 * as empty/0 -- documented at its own call sites, matching the precedent
 * `confidence`/`peakRatio` already set. See the T9 task report for the full
 * evidence trail.
 *
 * ## Chroma pass (`chromaEnvelope`)
 *
 * Runs on the DECIMATED signal (~11025 Hz canonical rate) with streaming
 * `fft` + `hann(2048)` on reused buffers -- never `stft()`, for the same
 * memory reason `onsetEnvelope` avoids it. 2048 @ 11025 Hz gives 5.38 Hz
 * bins; semitone spacing at the 130 Hz band floor is 7.7 Hz, so (VERIFIED
 * empirically by this task's acceptance test 5, not merely assumed from the
 * bin-width arithmetic) two adjacent semitones at the floor land in
 * different pitch classes. A 2048-pt FFT at the NATIVE 44.1 kHz rate would
 * give 21.5 Hz bins and could not resolve this.
 *
 * For each FFT bin whose NOMINAL centre frequency `f = k*rate/CHROMA_FFT`
 * falls in `[CHROMA_LOW_HZ, CHROMA_HIGH_HZ]`: pitch class
 * `pc = ((round(12*log2(f/440)) % 12) + 12) % 12`; accumulate `mag^2` into
 * that pitch class's bucket. Then log-compress `log(1 + 100*c)` per class and
 * L2-normalise the resulting 12-vector (an all-zero accumulation -- e.g. a
 * silent frame -- stays all-zero: `log(1+0) === 0` for every class, so the
 * pre-normalisation vector is already zero and the norm guard leaves it that
 * way rather than dividing by zero).
 *
 * ## Level-blind timbre (`T`) vs. level-carrying (`L`)
 *
 * `onsetEnvelope`'s retained `bands` stores the LOG-COMPRESSED value
 * `L_b = log(1 + LOG_COMPRESSION*e_b)`, not the raw linear band energy `e_b`.
 * Averaging and L2-normalising the log-compressed values directly would only
 * be APPROXIMATELY level-invariant (a constant-amplitude scale factor `k`
 * shifts every `L_b` by very close to `log(k)` when `LOG_COMPRESSION*e_b >>
 * 1`, but that is an additive, not multiplicative, perturbation on the raw
 * vector, so L2-normalising afterwards does not cancel it exactly) --
 * measurably too weak to guarantee this task's acceptance bound (cosine
 * similarity `> 0.999` under a 4x amplitude cut). This module instead
 * INVERTS the log compression per cell (`recoverEnergy`) before averaging,
 * giving a raw linear-in-amplitude energy vector: scaling input amplitude by
 * `k` scales every recovered `e_b` by EXACTLY `k` (since `onsetEnvelope`
 * accumulates `mag`, not `mag^2`, per band -- linear in amplitude), so
 * L2-normalising afterwards cancels `k` EXACTLY (bit-for-bit up to floating
 * point), not merely approximately. `L[m]` (the one deliberately
 * level-CARRYING term) is computed from that same recovered linear energy,
 * `20*log10(mean(e))` -- so scaling amplitude by `k` shifts `L[m]` by exactly
 * `20*log10(k)` (`-12.04 dB` for `k=0.25`), matching this task's acceptance
 * bound exactly rather than approximately.
 *
 * ## Downbeat-phase detection frame mapping (fix round 1 — this was wrong)
 *
 * `deriveRemixFeatures` only receives `tempo` (sample-accurate `beatSamples`,
 * not per-beat onset-frame indices), so scoring `peak(odf, beat(b), +/-2
 * frames)` requires converting a beat's SAMPLE position into an approximate
 * onset-frame index for reading `odf`/`odfLow`. **`odf` is FLUX, not
 * centred-frame energy**, so the ODF FRAME ATTRIBUTION CONTRACT
 * (`tempoCore.ts`) applies DIRECTLY, not "the opposite direction" as a
 * previous version of this comment claimed: the contract's own inverse
 * (`attackSample = (f+1)*ONSET_HOP` in decimated samples) means the frame
 * whose flux peaks for an attack at decimated sample `s` is
 * `f = s/ONSET_HOP - 1`, i.e. `frame = beatSample/decimationFactor/ONSET_HOP
 * - 1` — the SAME `-1` hop correction, not its opposite, applied at the
 * point of READING flux rather than of locating an attack from a frame. The
 * omission (a plain `beatSample/D/ONSET_HOP`, off by exactly one hop late)
 * measured a real attack at 516.80 hops producing its true flux argmax at
 * frame 515, while the uncorrected search centred on frame 517 — the true
 * peak sat at the exact edge of the +/-2 window, one hop from falling
 * outside it entirely. `bands`/`chroma` reads (`T`/`L`/`C`, via
 * `frameRangeForSamples`) are UNAFFECTED and stay on the plain inverse: they
 * read centred-frame ENERGY, not a differenced quantity, so there is no
 * "attack arrives one hop late" effect to correct for.
 *
 * ## Bar-boundary head/tail and the very first boundary's "preceding beat"
 *
 * `barBoundary[m] = beatSamples[effectiveB0 + m*beatsPerBar]` for as many `m`
 * as stay in range and below `analyzedEndSample` -- REAL tracked, drift-
 * following beat samples, never an extrapolated isochronous grid, so bars
 * vary in length by a few ms and nothing downstream assumes otherwise. Every
 * per-boundary descriptor (`T`/`C`/`L`) is defined over "the one beat of
 * audio immediately preceding boundary `m`", i.e. `[beatSamples[idx-1],
 * beatSamples[idx])` where `idx = effectiveB0 + m*beatsPerBar` is boundary
 * `m`'s own beat index. Boundary 0 has an earlier tracked beat whenever the
 * downbeat phase is non-zero (`idx-1 = effectiveB0-1 >= 0`), and the REAL beat
 * is used there; only at phase 0 is there no earlier beat, and that is the one
 * case `T`/`C`/`L` fall back to `[0, barBoundary[0])`. `R` is different: its
 * "preceding BAR" falls back to `[0, barBoundary[0])` whenever `m === 0`,
 * phase or no phase, since `barBoundary[-1]` never exists. Both fallbacks are
 * documented interpretations where the brief is silent on this edge, not
 * silently-invented defaults (see the task report for why this choice, rather
 * than e.g. an all-zero descriptor, was made: an all-zero contribution would
 * only dilute, not qualitatively change, boundary 0's clustering direction,
 * since it is one of the terms in `S[0]`'s own average -- at most
 * `SMOOTH_BARS+1` of them at boundary 0, where the `+-SMOOTH_BARS` window is
 * clamped on the left, not the `2*SMOOTH_BARS+1` an interior boundary gets).
 *
 * ## `downbeatShiftBeats` wraps, it does not shift the array window
 *
 * The brief describes `downbeatShiftBeats` as "adds to b0*" without pinning
 * exact out-of-range behaviour. This module wraps
 * `((b0Star + shift) % beatsPerBar + beatsPerBar) % beatsPerBar` rather than
 * using the raw (possibly negative or >= beatsPerBar) sum as a `beatSamples`
 * index directly -- the dialog's escape hatch is described as cycling WHICH
 * of the `beatsPerBar` candidate phases is treated as the downbeat
 * (syncopation correction), not as arbitrarily discarding leading bars from
 * the analysis, and a raw unwrapped sum risks a negative or out-of-bounds
 * starting index for any `|shift| >= 1`.
 *
 * ## R's resampling aggregator: peak, not mean
 *
 * Unlike `T`/`C`/`L` (all explicitly "mean ... over the window" in the
 * brief), `R`'s own text has no "mean" and its stated purpose is literally
 * "does this bar end with a fill" -- a transient-detection question that a
 * mean would smooth away. Each of the `4*beatsPerBar` output points takes the
 * PEAK (not mean) `odf` value within its proportional sub-segment of the
 * whole preceding bar, preserving exactly the kind of localised onset burst
 * "ends with a fill" needs to detect.
 */

import { fft } from './fft';
import { hann } from './windows';
import { analyzeTempo, decimateMono, ONSET_HOP, LOG_COMPRESSION } from './tempoCore';
import type { TempoAnalysis, AnalyzeTempoOptions } from './tempoCore';

// ---------------------------------------------------------------------------
// Constants (exported -- named in the task brief and architecture doc).
// ---------------------------------------------------------------------------

/** Chroma-pass FFT size (samples), on the decimated (~11025 Hz) signal. */
export const CHROMA_FFT = 2048;
/** Chroma-pass hop size (samples). */
export const CHROMA_HOP = 1024;
/** Lowest bin centre frequency (Hz) folded into the 12-class chroma vector. */
export const CHROMA_LOW_HZ = 130;
/** Highest bin centre frequency (Hz) folded into the 12-class chroma vector. */
export const CHROMA_HIGH_HZ = 2000;
/** Log-compression constant for chroma accumulation: `log(1 + 100*c)`. */
export const CHROMA_LOG_COMPRESSION = 100;
/** Default beats-per-bar when the caller doesn't specify a time signature. */
export const DEFAULT_BEATS_PER_BAR = 4;
/** Weight of the low-band envelope (`odfLow`) in the downbeat score. */
export const DOWNBEAT_LOW_WEIGHT = 1.0;
/** Half-width (in bar/boundary units) of the smoothing window feeding `S`. */
export const SMOOTH_BARS = 4;
/** Average-linkage agglomerative merge threshold on `S` (Euclidean, unit vectors). */
export const CLUSTER_RADIUS = 0.18;
/** +/- frame search radius around a beat's approximate onset-frame index. */
const DOWNBEAT_PEAK_RADIUS = 2;

// ---------------------------------------------------------------------------
// Chroma pass
// ---------------------------------------------------------------------------

export interface ChromaResult {
  /** `numFrames * 12`, row-major, each row L2-normalised (all-zero stays
   * zero). INDEX ORIGIN: `pc = 0` is A (440 Hz), NOT C -- `pc =
   * ((round(12*log2(f/440)) % 12) + 12) % 12` is A-referenced by
   * construction (verified: `pc(220 Hz) === pc(440 Hz) === 0`, `pc(261.63 Hz,
   * middle C) === 3`). Never render an index from this array as an absolute
   * pitch NAME (e.g. index 0 as "C") without first re-basing it -- doing so
   * silently mislabels every pitch class by 3 semitones. */
  chroma: Float32Array;
  numFrames: number;
  chromaRate: number;
}

/**
 * Streaming, centred-frame (matches `onsetEnvelope`'s convention) 12-class
 * chroma envelope. Frames are CENTRED at `t*CHROMA_HOP` (window =
 * `[t*hop - fftSize/2, t*hop + fftSize/2)`, zero-padded at both ends). Never
 * mutates `signal`.
 */
export function chromaEnvelope(
  signal: Float32Array,
  rate: number,
  onProgress?: (fraction: number) => void
): ChromaResult {
  const len = signal.length;
  const numFrames = Math.max(1, Math.floor(len / CHROMA_HOP) + 1);
  const chromaRate = rate / CHROMA_HOP;

  const bins = CHROMA_FFT / 2 + 1;
  const win = hann(CHROMA_FFT);
  const re = new Float32Array(CHROMA_FFT);
  const im = new Float32Array(CHROMA_FFT);

  // Precompute each bin's pitch class once (or -1 when its nominal centre
  // frequency falls outside [CHROMA_LOW_HZ, CHROMA_HIGH_HZ]), plus the
  // CONTIGUOUS bin range that can possibly feed one (bin->frequency is
  // monotonic, so this is a single [kLo, kHi) span) -- minor perf fix:
  // only ~34% of bins ever feed a pitch class, so the per-frame accumulation
  // loop below visits just that span instead of all `bins` every frame.
  const binPc = new Int32Array(bins).fill(-1);
  let kLo = bins;
  let kHi = 0;
  for (let k = 0; k < bins; k++) {
    const f = (k * rate) / CHROMA_FFT;
    if (f >= CHROMA_LOW_HZ && f <= CHROMA_HIGH_HZ) {
      binPc[k] = (((Math.round(12 * Math.log2(f / 440)) % 12) + 12) % 12);
      if (k < kLo) kLo = k;
      if (k >= kHi) kHi = k + 1;
    }
  }

  const chroma = new Float32Array(numFrames * 12);
  const half = CHROMA_FFT / 2;
  const c = new Float64Array(12);

  for (let t = 0; t < numFrames; t++) {
    const start = t * CHROMA_HOP - half;
    im.fill(0);
    for (let i = 0; i < CHROMA_FFT; i++) {
      const idx = start + i;
      re[i] = idx >= 0 && idx < len ? signal[idx] * win[i] : 0;
    }
    fft(re, im);

    // minor perf fix: accumulate POWER (`re^2+im^2`) directly instead of
    // `Math.hypot(re,im)` then squaring it right back -- `mag` was only ever
    // read squared, so the sqrt in `hypot` was pure waste (~2.2M unneeded
    // sqrt calls per 5-min track at the old `bins`-wide loop), and skipping
    // it is also marginally MORE precise (no sqrt/multiply round-trip).
    c.fill(0);
    for (let k = kLo; k < kHi; k++) {
      const pc = binPc[k];
      if (pc < 0) continue;
      c[pc] += re[k] * re[k] + im[k] * im[k];
    }

    let normSq = 0;
    for (let pc = 0; pc < 12; pc++) {
      const v = Math.log(1 + CHROMA_LOG_COMPRESSION * c[pc]);
      chroma[t * 12 + pc] = v;
      normSq += v * v;
    }
    if (normSq > 1e-24) {
      const inv = 1 / Math.sqrt(normSq);
      for (let pc = 0; pc < 12; pc++) chroma[t * 12 + pc] *= inv;
    }

    if (onProgress && (t % 32 === 0 || t === numFrames - 1)) {
      onProgress(Math.min(1, (t + 1) / numFrames));
    }
  }

  return { chroma, numFrames, chromaRate };
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function recoverEnergy(L: number): number {
  return (Math.exp(L) - 1) / LOG_COMPRESSION;
}

/** L2-normalises `vec` IN PLACE; leaves an all-(near-)zero vector untouched. */
function l2NormalizeInPlace(vec: Float64Array): Float64Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  if (sumSq > 1e-24) {
    const inv = 1 / Math.sqrt(sumSq);
    for (let i = 0; i < vec.length; i++) vec[i] *= inv;
  }
  return vec;
}

/** Max of `x` over `[centerFrame-radius, centerFrame+radius]`, clamped to
 * `x`'s bounds; `centerFrame` is a fractional frame estimate, rounded before
 * the window is applied. Returns 0 if the window is entirely out of range. */
function peakAround(x: Float32Array, centerFrame: number, radius: number): number {
  const c = Math.round(centerFrame);
  let best = -Infinity;
  for (let f = c - radius; f <= c + radius; f++) {
    if (f >= 0 && f < x.length && x[f] > best) best = x[f];
  }
  return best === -Infinity ? 0 : best;
}

/** Maps a half-open ORIGINAL-domain sample range to a half-open frame-index
 * range for an envelope decimated by `D` and hopped by `hop`, clamped to
 * `[0, numFrames]` and widened to at least one frame when the mapped range
 * would otherwise be empty (e.g. a very short leading window). */
function frameRangeForSamples(
  startSample: number,
  endSample: number,
  D: number,
  hop: number,
  numFrames: number
): [number, number] {
  const startDec = startSample / D;
  const endDec = endSample / D;
  const lo = Math.max(0, Math.ceil(startDec / hop));
  let hi = Math.min(numFrames, Math.ceil(endDec / hop));
  if (hi <= lo) hi = Math.min(numFrames, lo + 1);
  return [lo, hi];
}

/**
 * Resamples `odf` over `[barStartSample, barEndSample)` (original domain,
 * decimation factor `D`) into exactly `points` values, each the PEAK `odf`
 * value within its proportional sub-segment (see the module doc comment for
 * why peak, not mean).
 *
 * FRAME MAPPING (fix round 1 — this was wrong): `odf` is FLUX, not centred-
 * frame energy, so the ODF FRAME ATTRIBUTION CONTRACT (`tempoCore.ts`)
 * applies: an attack at decimated sample `k*ONSET_HOP` peaks at frame `k-1`,
 * not frame `k`. Reading flux at a known sample position therefore needs the
 * SAME `-1` hop correction the contract's own worked example uses (`attackSample
 * = (f+1)*ONSET_HOP` inverted is `f = sample/ONSET_HOP - 1`), which the
 * original implementation omitted (a plain `ceil(sample/ONSET_HOP)`, correct
 * for `bands`/`chroma`'s centred-frame energy reads but exactly one hop late
 * for `odf`). Measured impact of the omission on a 20-bar fixture with real
 * onsets at segments 0/4/8/12 of 16: peaks observed at 3/7/11/15 instead —
 * every bar's own downbeat fell into the segment BEFORE it (reading ~0), and
 * the segment meant to carry "does this bar end with a fill" instead always
 * caught the START of the NEXT bar's downbeat (a fixed, non-discriminating
 * value at every boundary). See the task report's "Fix round 1" for the
 * corrected re-measurement.
 */
function resampleOdfBarPeak(
  odf: Float32Array,
  barStartSample: number,
  barEndSample: number,
  D: number,
  points: number
): Float64Array {
  const out = new Float64Array(points);
  const startDec = barStartSample / D;
  const totalDec = Math.max(0, barEndSample / D - startDec);
  for (let p = 0; p < points; p++) {
    const segStart = startDec + (p / points) * totalDec;
    const segEnd = startDec + ((p + 1) / points) * totalDec;
    const lo = Math.max(0, Math.ceil(segStart / ONSET_HOP) - 1);
    let hi = Math.min(odf.length, Math.ceil(segEnd / ONSET_HOP) - 1);
    if (hi <= lo) hi = Math.min(odf.length, lo + 1);
    let peak = 0;
    for (let f = lo; f < hi; f++) if (odf[f] > peak) peak = odf[f];
    out[p] = peak;
  }
  return out;
}

/**
 * Test-only export of `resampleOdfBarPeak`, so its ODF FRAME ATTRIBUTION
 * CONTRACT fix (see the function's own doc comment) can be regression-tested
 * with arithmetic-precise, synthetic `odf` input directly, independent of
 * the full `analyzeTempo`/`chromaEnvelope`/`deriveRemixFeatures` pipeline.
 * NOT a supported public API -- following this repo's `_xxxForTest`
 * convention (`tempoAnalysis.ts`'s `_promoteToRemixLevelForTest`) so the
 * widened surface reads as a deliberate test hook, not a new production
 * entry point.
 */
export const _resampleOdfBarPeakForTest = resampleOdfBarPeak;

// ---------------------------------------------------------------------------
// Average-linkage agglomerative clustering
// ---------------------------------------------------------------------------

/**
 * AVERAGE-LINKAGE agglomerative clustering of the `n` `dim`-dimensional row
 * vectors packed in `S` (row-major), merging the pair of clusters with the
 * smallest mean pairwise EUCLIDEAN distance while that minimum stays below
 * `radius`. Chosen over k-means specifically because it is FULLY
 * deterministic (no seeding, no `Math.random()` -- verified absent from
 * `src/`, `scripts/`, `electron/`). `n` is bounded by `numBars+1` (<= ~150
 * per the brief), so the O(n^3) worst case here is negligible. Ties in the
 * "smallest average distance" search resolve to the first pair found in a
 * fixed `i < j` scan order, so two calls on identical input always merge in
 * the same sequence and produce IDENTICAL labels (acceptance: determinism).
 */
function agglomerativeCluster(S: Float32Array, n: number, dim: number, radius: number): Int32Array {
  if (n === 0) return new Int32Array(0);

  const dist: Float64Array[] = [];
  for (let i = 0; i < n; i++) dist.push(new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let sumSq = 0;
      for (let d = 0; d < dim; d++) {
        const diff = S[i * dim + d] - S[j * dim + d];
        sumSq += diff * diff;
      }
      const d = Math.sqrt(sumSq);
      dist[i][j] = d;
      dist[j][i] = d;
    }
  }

  let clusters: number[][] = [];
  for (let i = 0; i < n; i++) clusters.push([i]);

  function avgLinkDist(a: number[], b: number[]): number {
    let sum = 0;
    for (const i of a) for (const j of b) sum += dist[i][j];
    return sum / (a.length * b.length);
  }

  while (clusters.length > 1) {
    let bestI = -1;
    let bestJ = -1;
    let bestD = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = avgLinkDist(clusters[i], clusters[j]);
        if (d < bestD) {
          bestD = d;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestD >= radius) break;
    clusters[bestI] = clusters[bestI].concat(clusters[bestJ]);
    clusters.splice(bestJ, 1);
  }

  const labels = new Int32Array(n);
  clusters.forEach((members, label) => {
    for (const idx of members) labels[idx] = label;
  });
  return labels;
}

// ---------------------------------------------------------------------------
// deriveRemixFeatures / RemixAnalysis
// ---------------------------------------------------------------------------

export interface RemixFeatureParams {
  beatsPerBar?: number;
  downbeatShiftBeats?: number;
}

export interface RemixAnalysis extends TempoAnalysis {
  /** `numChromaFrames * 12`, row-major, from `chromaEnvelope`. */
  chroma: Float32Array;
  numChromaFrames: number;
  chromaRate: number;

  beatsPerBar: number;
  /** The EFFECTIVE beat-index phase (post `downbeatShiftBeats`) that starts
   * bar 0 -- i.e. `barBoundary[0] === beatSamples[downbeatPhase]`. */
  downbeatPhase: number;
  /** `(D(b0*) - D(runnerUp)) / max(1e-9, D(b0*))`, computed BEFORE
   * `downbeatShiftBeats` is applied (a user override is a deliberate
   * disagreement with the detector, not evidence the detector was
   * confident). NOT A GATE (PLAN OWNER RULING 5): the log-compression this
   * is built from flattens a genuine 2x accent to roughly `log 2` regardless
   * of level, so this saturates near a low value on realistic, loud
   * material -- no feature may refuse or branch on any threshold against
   * this value. It may be surfaced as a soft hint only; the downbeat's
   * user-facing correction is the `<` `>` shift control (T13/T14), not a
   * confidence check. */
  downbeatConfidence: number;
  /** NOT a measurement, and NEVER derived from `confidence`: a human's
   * explicit assertion that this grid's tempo is right — set when the user
   * types a BPM, presses x2 / /2, or ticks the confirmation in the Auto-Remix
   * dialog (T14). Nothing in this module ever sets it; it is stamped on by
   * the UI and carried through re-derives.
   *
   * It exists because "the detector is confident" and "a human asserted this
   * tempo" are DIFFERENT facts and the second is strictly stronger. The
   * planner's tempo gate accepts either (`remixPlan.ts`), so an assertion can
   * open a gate a weak detection closed — WITHOUT overwriting `confidence`,
   * which stays exactly as measured so the status bar's uncertainty marker
   * and the Properties readout keep telling the truth about the detection on
   * a document the user may go on to use for something else. */
  tempoConfirmed?: boolean;

  /** `numBars+1` REFINED, drift-following beat samples -- never an
   * extrapolated isochronous grid. KNOWN LIMITATION, flagged not fixed
   * (review minor, cheap-enough to document, not to design a guard for
   * here): every entry is a REAL `beatSamples` position, but the Ellis DP
   * keeps tracking as long as the transformed `odf` has ANY local structure
   * to follow, including a tone-only tail with no genuine rhythmic attacks
   * left -- measured drifting a tracked "beat" 1877 ms past the last
   * musically real downbeat on a ramp fixture's trailing silence-adjacent
   * tone. This is not extrapolation (every sample here really is a tracked
   * beat, per the field's own contract), but a downstream splice consumer
   * (T10-T12) must not assume the LAST few boundaries are equally trustworthy
   * splice points just because they're structurally well-formed -- consider
   * a flux-strength sanity check (e.g. against `peakAround`-style local `odf`
   * magnitude) on the trailing boundaries before offering them as candidates. */
  barBoundary: Int32Array;
  numBars: number;

  /** `(numBars+1) * numBands`, row-major: mean recovered-linear band energy
   * over the one beat preceding each boundary, L2-normalised. */
  T: Float32Array;
  /** `(numBars+1) * 12`, row-major: mean chroma over the same window,
   * re-normalised after averaging. */
  C: Float32Array;
  /** `numBars+1`: `20*log10(mean recovered band energy)` over the same
   * window, in dB. */
  L: Float32Array;
  /** `(numBars+1) * (4*beatsPerBar)`, row-major: `odf` over the WHOLE
   * preceding bar, resampled to 4 points/beat by PEAK, L2-normalised. */
  R: Float32Array;
  /** `(numBars+1) * (numBands+12)`, row-major: mean of `(T concat C)` over
   * boundaries `m-SMOOTH_BARS..m+SMOOTH_BARS`, L2-normalised. */
  S: Float32Array;

  /** `numBars+1` cluster labels over `S` (see `agglomerativeCluster`). */
  cluster: Int32Array;
  /** `${clusterA}>${clusterB}` for every CONSECUTIVE boundary pair in
   * original order. */
  transitionSeen: Set<string>;
}

/**
 * The empty/degenerate `RemixAnalysis` shape -- `numBars: 0`, every
 * descriptor array empty. Fix round 2 (Important 4, arms 2/3): `bpm` is
 * FORCED to `null` HERE, uniformly, for every caller -- not at one call
 * site -- because `numBars === 0` is, on its own, "the worst possible shape
 * for the planner" regardless of which guard produced it: a caller could
 * branch on `bpm !== null` alone and never notice `numBars` is empty. Round
 * 1 only forced this for the `numBands <= 0` (regrid) arm; measurement
 * showed two more arms reaching this function with a perfectly real `tempo.
 * bpm` intact -- an oversized `beatsPerBar` (caller-supplied from the
 * time-signature control) leaving `numBeats <= beatsPerBar`, and a short
 * clip (`MIN_ANALYSIS_SECONDS = 5` at `MIN_BPM` is only ~1.25 bars) leaving
 * `numBoundaries < 2` -- both reachable in production, both left `bpm`
 * non-null before this fix. Forcing it here closes all three arms at once
 * and makes it structurally impossible for a fourth arm to reopen the gap.
 */
function emptyRemixAnalysis(
  tempo: TempoAnalysis,
  chroma: ChromaResult,
  beatsPerBar: number,
  downbeatPhase = 0,
  downbeatConfidence = 0
): RemixAnalysis {
  return {
    ...tempo,
    bpm: null,
    chroma: chroma.chroma,
    numChromaFrames: chroma.numFrames,
    chromaRate: chroma.chromaRate,
    beatsPerBar,
    downbeatPhase,
    downbeatConfidence,
    barBoundary: new Int32Array(0),
    numBars: 0,
    T: new Float32Array(0),
    C: new Float32Array(0),
    L: new Float32Array(0),
    R: new Float32Array(0),
    S: new Float32Array(0),
    cluster: new Int32Array(0),
    transitionSeen: new Set<string>(),
  };
}

/**
 * Downbeat + bar boundaries + per-boundary descriptors + clusters ONLY --
 * no FFT, no decimation -- runs in milliseconds given an already-computed
 * `tempo`/`chroma` pair, so a BPM / time-signature / downbeat override
 * re-derives without re-analysing audio. Never throws.
 */
export function deriveRemixFeatures(
  tempo: TempoAnalysis,
  chroma: ChromaResult,
  params?: RemixFeatureParams
): RemixAnalysis {
  const beatsPerBar = Math.max(1, Math.round(params?.beatsPerBar ?? DEFAULT_BEATS_PER_BAR));
  const downbeatShiftBeats = Math.round(params?.downbeatShiftBeats ?? 0);
  const D = tempo.decimationFactor > 0 ? tempo.decimationFactor : 1;
  const numOnsetFrames = tempo.odf.length;
  const numBands = tempo.numBands;
  const beatSamples = tempo.beatSamples;
  const numBeats = beatSamples.length;

  // `numBands <= 0` is NOT a normal "not enough audio" degeneracy -- it is
  // the signature of a `tempo` produced by `deriveGrid` (the 'regrid' fast
  // path), which never has band/chroma data to source these from and always
  // reports them empty (see tempoCore.ts's `deriveGrid` doc comment). A
  // genuine `analyzeTempo` result NEVER has `bpm !== null` with `numBands <=
  // 0` -- bands are computed in the same pass that finds bpm. This was
  // chosen over threading `bands`/`odfLow` through the regrid protocol so a
  // regridded entry could re-derive real descriptors, because that would
  // still be only a PARTIAL fix: `deriveGrid` never runs the chroma pass
  // either, so `C`/`S`/clustering would remain unrecoverable regardless. A
  // full fix belongs to whichever task wires a genuine remix-level regrid
  // (re-running `deriveRemixFeatures` against the ORIGINAL cached `bands`/
  // `odfLow`/`chroma`, not `deriveGrid`'s output) -- out of this task's
  // scope. (`emptyRemixAnalysis` forces `bpm: null` uniformly for every arm
  // below, fix round 2 -- see its own doc comment.)
  if (numBands <= 0) {
    return emptyRemixAnalysis(tempo, chroma, beatsPerBar);
  }
  if (tempo.bpm === null || numBeats <= beatsPerBar) {
    return emptyRemixAnalysis(tempo, chroma, beatsPerBar);
  }

  // --- Downbeat-phase detection ---
  // Fix round 1: (a) frame mapping corrected -- `odf`/`odfLow` are FLUX, so
  // the ODF FRAME ATTRIBUTION CONTRACT's `-1` hop applies here too (see
  // `resampleOdfBarPeak`'s doc comment for the full derivation; this read is
  // a single point rather than a range, so the correction is a plain `-1`
  // rather than `ceil(...) - 1`). (b) scores are now the MEAN, not the sum,
  // over each phase's terms -- unnormalised sums measured a ~50% score
  // advantage from term-count alone on short inputs (counts as uneven as
  // `12,12,12,11` on a zero-accent fixture), an artefact with nothing to do
  // with which phase is the true downbeat.
  const scores = new Float64Array(beatsPerBar);
  for (let b0 = 0; b0 < beatsPerBar; b0++) {
    let sum = 0;
    let count = 0;
    for (let idx = b0; idx < numBeats; idx += beatsPerBar) {
      const frame = beatSamples[idx] / D / ONSET_HOP - 1;
      sum += peakAround(tempo.odf, frame, DOWNBEAT_PEAK_RADIUS);
      sum += DOWNBEAT_LOW_WEIGHT * peakAround(tempo.odfLow, frame, DOWNBEAT_PEAK_RADIUS);
      count++;
    }
    scores[b0] = count > 0 ? sum / count : 0;
  }
  let b0Star = 0;
  let bestScore = -Infinity;
  for (let b0 = 0; b0 < beatsPerBar; b0++) {
    if (scores[b0] > bestScore) {
      bestScore = scores[b0];
      b0Star = b0;
    }
  }
  let runnerUp = 0;
  for (let b0 = 0; b0 < beatsPerBar; b0++) {
    if (b0 !== b0Star && scores[b0] > runnerUp) runnerUp = scores[b0];
  }
  const downbeatConfidence = (bestScore - runnerUp) / Math.max(1e-9, bestScore);

  const effectiveB0 = (((b0Star + downbeatShiftBeats) % beatsPerBar) + beatsPerBar) % beatsPerBar;

  // --- Bar boundaries (REAL tracked beat samples, never extrapolated) ---
  const lengthSample = tempo.analyzedEndSample;
  const boundaryList: number[] = [];
  for (let idx = effectiveB0; idx < numBeats; idx += beatsPerBar) {
    const s = beatSamples[idx];
    if (s >= lengthSample) break;
    boundaryList.push(s);
  }
  const barBoundary = Int32Array.from(boundaryList);
  const numBoundaries = barBoundary.length;
  const numBars = Math.max(0, numBoundaries - 1);

  // Fix round 2 (Important 4, arm 3): `numBoundaries < 2`, not `=== 0` -- a
  // SINGLE boundary bounds zero complete bars (`numBars = max(0, 1-1) = 0`)
  // but previously fell THROUGH this guard entirely (only `=== 0` was
  // checked) into the normal per-boundary computation below, returning a
  // real (non-`emptyRemixAnalysis`) result with a genuine `bpm` sitting next
  // to `numBars: 0` -- measured on a short clip at `MIN_ANALYSIS_SECONDS`/
  // `MIN_BPM` (~1.25 bars) and on an oversized `beatsPerBar`/60-beat input.
  if (numBoundaries < 2) {
    return emptyRemixAnalysis(tempo, chroma, beatsPerBar, effectiveB0, downbeatConfidence);
  }

  // --- Per-boundary descriptors T/C/L/R ---
  const rDims = 4 * beatsPerBar;
  const T = new Float32Array(numBoundaries * numBands);
  const C = new Float32Array(numBoundaries * 12);
  const L = new Float32Array(numBoundaries);
  const R = new Float32Array(numBoundaries * rDims);

  for (let m = 0; m < numBoundaries; m++) {
    const idx = effectiveB0 + m * beatsPerBar;
    const boundarySample = barBoundary[m];
    const prevBeatSample = idx - 1 >= 0 ? beatSamples[idx - 1] : 0;

    // T, L: onset-frame window over the one beat preceding this boundary.
    const [oLo, oHi] = frameRangeForSamples(prevBeatSample, boundarySample, D, ONSET_HOP, numOnsetFrames);
    const energyVec = new Float64Array(numBands);
    let energySum = 0;
    let energyCount = 0;
    for (let f = oLo; f < oHi; f++) {
      for (let b = 0; b < numBands; b++) {
        const e = recoverEnergy(tempo.bands[f * numBands + b]);
        energyVec[b] += e;
        energySum += e;
        energyCount++;
      }
    }
    const oFrameCount = Math.max(1, oHi - oLo);
    for (let b = 0; b < numBands; b++) energyVec[b] /= oFrameCount;
    const meanEnergy = energyCount > 0 ? energySum / energyCount : 0;
    L[m] = 20 * Math.log10(Math.max(meanEnergy, 1e-12));

    l2NormalizeInPlace(energyVec);
    for (let b = 0; b < numBands; b++) T[m * numBands + b] = energyVec[b];

    // C: chroma-frame window over the same sample range.
    const [cLo, cHi] = frameRangeForSamples(prevBeatSample, boundarySample, D, CHROMA_HOP, chroma.numFrames);
    const chromaVec = new Float64Array(12);
    const cFrameCount = Math.max(1, cHi - cLo);
    for (let f = cLo; f < cHi; f++) {
      for (let p = 0; p < 12; p++) chromaVec[p] += chroma.chroma[f * 12 + p];
    }
    for (let p = 0; p < 12; p++) chromaVec[p] /= cFrameCount;
    l2NormalizeInPlace(chromaVec);
    for (let p = 0; p < 12; p++) C[m * 12 + p] = chromaVec[p];

    // R: odf resampled (peak) over the WHOLE preceding bar.
    const prevBarBoundary = m >= 1 ? barBoundary[m - 1] : 0;
    const rVec = resampleOdfBarPeak(tempo.odf, prevBarBoundary, boundarySample, D, rDims);
    l2NormalizeInPlace(rVec);
    for (let p = 0; p < rDims; p++) R[m * rDims + p] = rVec[p];
  }

  // --- S: smoothed section-identity vector, input to clustering ---
  const sDims = numBands + 12;
  const S = new Float32Array(numBoundaries * sDims);
  for (let m = 0; m < numBoundaries; m++) {
    const lo = Math.max(0, m - SMOOTH_BARS);
    const hi = Math.min(numBoundaries - 1, m + SMOOTH_BARS);
    const acc = new Float64Array(sDims);
    let count = 0;
    for (let k = lo; k <= hi; k++) {
      for (let b = 0; b < numBands; b++) acc[b] += T[k * numBands + b];
      for (let p = 0; p < 12; p++) acc[numBands + p] += C[k * 12 + p];
      count++;
    }
    for (let d = 0; d < sDims; d++) acc[d] /= count;
    l2NormalizeInPlace(acc);
    for (let d = 0; d < sDims; d++) S[m * sDims + d] = acc[d];
  }

  // --- Clusters + transition table ---
  const cluster = agglomerativeCluster(S, numBoundaries, sDims, CLUSTER_RADIUS);
  const transitionSeen = new Set<string>();
  for (let m = 0; m < numBoundaries - 1; m++) {
    transitionSeen.add(`${cluster[m]}>${cluster[m + 1]}`);
  }

  return {
    ...tempo,
    chroma: chroma.chroma,
    numChromaFrames: chroma.numFrames,
    chromaRate: chroma.chromaRate,
    beatsPerBar,
    downbeatPhase: effectiveB0,
    downbeatConfidence,
    barBoundary,
    numBars,
    T,
    C,
    L,
    R,
    S,
    cluster,
    transitionSeen,
  };
}

/**
 * `analyzeRemix` = the chroma pass + `deriveRemixFeatures`: the full
 * level:'remix' pipeline from a raw mono mixdown. Re-decimates `mono` for
 * the chroma pass (a second, cheap linear-cost pass -- see the module doc
 * comment) using the SAME `analyzedEndSample` truncation `analyzeTempo`
 * applied, so the onset-frame and chroma-frame timelines share one
 * consistent decimated-signal basis. Never throws.
 */
export function analyzeRemix(
  mono: Float32Array,
  sampleRate: number,
  opts?: AnalyzeTempoOptions,
  params?: RemixFeatureParams,
  onProgress?: (fraction: number) => void
): RemixAnalysis {
  const tempo = analyzeTempo(mono, sampleRate, opts, (f) => onProgress?.(f * 0.7));
  const analyzed = mono.subarray(0, tempo.analyzedEndSample);
  const { signal, rate } = decimateMono(analyzed, sampleRate);
  const chroma = chromaEnvelope(signal, rate, (f) => onProgress?.(0.7 + f * 0.3));
  onProgress?.(1);
  return deriveRemixFeatures(tempo, chroma, params);
}
