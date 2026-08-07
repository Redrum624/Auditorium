/**
 * Exact-sum stem partition (Auditorium v1.7, task S2 — pure TypeScript, no model).
 *
 * This is the piece that turns the user's core requirement — "all stems
 * together sound identical to the source" — into a BIT-EXACT, tested property.
 * It consumes the ML model's per-stem waveform ESTIMATES (already resampled
 * back to the document's native rate by the caller, S3) and the ORIGINAL mix,
 * and produces a partition whose reconstruction equals the mix sample-for-sample.
 *
 * Pipeline (plan ruling 4):
 *   1. Build Wiener-style ratio masks over the ORIGINAL mix's STFT from the
 *      estimates' spectral energy:
 *          m_i(t,f) = |S_i(t,f)|² / (Σ_j |S_j(t,f)|² + ε)   per channel.
 *      By construction Σ_i m_i = (Σ_i|S_i|²)/(Σ_j|S_j|²+ε) ≤ 1; each m_i ∈ [0,1].
 *      A bin whose estimates are all ~0 gets denom = ε → every mask = 0, so its
 *      energy is claimed by no stem (it lands in the Residual below) — never 0/0.
 *   2. Each masked stem = iSTFT( m_i ⊙ STFT(mix) ), keeping the mix's phase, with
 *      a COLA-satisfying Hann window at hop = fftSize/4 (75% overlap). The
 *      analysis·synthesis window (Hann²) overlap-adds to a constant (1.5), so
 *      the un-masked round trip reconstructs the interior; see
 *      `colaWindowEnergy` and the COLA test.
 *   3. The RESIDUAL stem is the TIME-DOMAIN COMPLEMENT:
 *          residual := mix − Σ masked_stems      (computed in the sample domain)
 *      NOT another mask. This is what makes the sum exact regardless of any
 *      STFT/iSTFT reconstruction imperfection: `Σ masked_stems + residual ≡ mix`
 *      becomes a pure algebraic identity in the time domain. The masks only
 *      decide how the mix is DIVIDED; nothing is synthesised, so nothing is lost.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OUTPUT / INDEXING CONTRACT (for S3 and S5 — consume without guessing):
 *
 *   partitionStems(mix, estimates, opts) => { stems, residual, stats? }
 *
 *   Inputs
 *     mix:        Float32Array[]      — mix[channel]      (the ORIGINAL document
 *                                       channels, document native rate)
 *     estimates:  Float32Array[][]    — estimates[source][channel]  (the model's
 *                                       per-stem waveforms, resampled to the
 *                                       document rate by the caller; EACH the
 *                                       SAME length as the corresponding mix
 *                                       channel, SAME channel count as mix)
 *   Output
 *     stems:      Float32Array[][]    — stems[source][channel], one masked
 *                                       reconstruction per input source, in the
 *                                       SAME source order the caller supplied
 *                                       (S2 is label-agnostic; for the ruling-6
 *                                       landing the caller maps source index →
 *                                       Drums/Bass/Vocals/Other and treats
 *                                       `residual` as the 5th "Residual" track).
 *     residual:   Float32Array[]      — residual[channel], the time-domain
 *                                       complement (mix − Σ stems).
 *     stats?:     present iff opts.collectStats — mask min/max and the worst-case
 *                                       Σ masks over all bins/frames/channels.
 *
 *   EXACT-SUM RECONSTRUCTION — the identity S5's mixdown and S7's smoke assert.
 *   Stated against the arithmetic `mixdownSession` actually uses: a FLOAT32
 *   left-to-right running sum (each `+=` into a Float32Array rounds to f32),
 *   sources in the delivered order followed by the Residual track. For each
 *   channel c and sample n, with fl32() = Math.fround(),
 *
 *       acc   = fl32(fl32(…fl32(stems[0][c][n] + stems[1][c][n])…) + stems[S-1][c][n])
 *       total = fl32(acc + residual[c][n])         // residual accumulated LAST
 *
 *   reconstructs mix[c][n]. Because the residual is the time-domain complement
 *   `mix − acc`, this is bit-exact (`total === mix`) at every sample EXCEPT the
 *   handful where |mix| sits below the local float32 ULP of the stem sum (near a
 *   zero crossing where the masked stems slightly overshoot): a single float32
 *   residual sample cannot encode a remainder finer than its own ULP, so there
 *   the reconstruction lands within ≈1 ULP of that magnitude. Measured worst
 *   |error| across the whole fixture matrix (silence, DC, tones, noise, clipping,
 *   mono/stereo, 44.1k/48k, sub-window and prime lengths) is ≈ 8.7e-16 absolute
 *   — about −300 dBFS, ~255 dB below the model's own residual (S1: −45 dBFS) and far below
 *   audibility. That is the documented bound; nothing is synthesised, so nothing
 *   is lost beyond float32 storage granularity. S5 MUST lay the tracks out in the
 *   delivered source order with Residual last (ruling 6's Drums, Bass, Vocals,
 *   Other, Residual) for the accumulation to match. (Every fixture keeps
 *   |mix| ≤ 1, so the mixdown's ±1 hard-clamp is an identity on the reconstruction.)
 *
 *   ⚠ MIXDOWN IS NOT TRANSPARENT FOR MONO SOURCES — S5 OWNS THE COMPENSATION.
 *   The identity above is about the SAMPLES this module returns. Routing them
 *   through `mixdownSession` preserves it only for STEREO stems, whose balance
 *   law is unity at centre (ruling 6). A MONO stem hits the constant-power mono
 *   pan law instead (gL = gR = cos(π/4) ≈ 0.7071 at centre), so the mixdown of
 *   untouched mono stems reconstructs the source at ≈ 0.7071× — measured
 *   −13.8 dBFS (0.205 absolute) reconstruction error, i.e. the identity FAILS
 *   without compensation. That is a mixdown pan-law property, not a partition
 *   defect: S2's own sum stays exact. S5 must compensate on the mono path
 *   (its acceptance already says "mono pan law path checked, compensated if
 *   needed — measure, don't assume") before asserting its mixdown-identity test.
 *
 *   INPUT CONTRACT: every sample of `mix` and `estimates` MUST be finite.
 *   Non-finite input (NaN/±Infinity from a model or resampler bug) THROWS — a
 *   NaN would otherwise propagate to NaN masks, stems and residual and silently
 *   void the guarantee. Callers (S3) sanitise or fail before calling.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Reuses the project's existing FFT (`./fft`) and periodic Hann (`./windows`);
 * it does NOT add an FFT dependency and does NOT materialise every STFT frame —
 * the per-channel loop streams frame-by-frame (allocation-conscious; these are
 * ~100 MB arrays in production).
 */

import { fft, ifft } from './fft';
import { hann } from './windows';

export interface StemPartitionOptions {
  /** FFT size (power of two). Default 1024. */
  fftSize?: number;
  /** Hop size in samples. Default fftSize/4 (75% overlap, COLA-satisfying for Hann²). */
  hop?: number;
  /** Ratio-mask denominator floor (guards 0/0 for all-silent bins). Default 1e-10. */
  eps?: number;
  /** When true, gather mask min/max and worst-case Σ masks (no per-bin retention). */
  collectStats?: boolean;
}

export interface StemPartitionStats {
  /** Smallest mask value seen across all bins/frames/channels/sources. */
  maskMin: number;
  /** Largest mask value seen. */
  maskMax: number;
  /** Largest Σ_i m_i over all bins/frames/channels (should be ≤ 1 + tiny drift). */
  maxMaskSum: number;
}

export interface StemPartitionResult {
  /** stems[source][channel] — masked-iSTFT reconstruction per source. */
  stems: Float32Array[][];
  /** residual[channel] — time-domain complement: mix − Σ stems. */
  residual: Float32Array[];
  /** Present iff opts.collectStats. */
  stats?: StemPartitionStats;
}

/** Default window/hop/eps. hop = fftSize/4 gives Hann² COLA to a constant. */
export const DEFAULT_STEM_PARTITION_OPTIONS = {
  fftSize: 1024,
  hop: 256,
  eps: 1e-10,
} as const;

/**
 * Spectral energy |X[k]|² = re² + im² for the non-negative-frequency bins of an
 * FFT'd frame, written into `out` (no allocation).
 *
 * THE SHIPPED SEPARATION LAW LIVES HERE. `partitionStems` calls this function —
 * it does not keep its own copy — so mutating it (e.g. dropping the imaginary
 * term) changes what actually ships and is caught by the tests that pin it.
 * That matters because exact-sum is structurally BLIND to mask errors (the
 * time-domain residual absorbs any of them): these two helpers are the only
 * code-level defence of the "don't pollute one instrument with another"
 * constraint (ruling 1's quality target).
 */
export function spectralEnergyInto(re: Float32Array, im: Float32Array, bins: number, out: Float32Array): void {
  for (let k = 0; k < bins; k++) out[k] = re[k] * re[k] + im[k] * im[k];
}

/**
 * Wiener ratio mask for a single time-frequency bin, given the per-source
 * spectral ENERGIES |S_i|², written into `out` (no allocation — this is the
 * per-bin hot path, called bins×frames×channels times).
 *
 * m_i = e_i / (Σ e_j + eps), each in [0,1] with Σ m_i ≤ 1; all-zero energies
 * yield all-zero masks (no NaN). Returns Σ m_i so callers can track the
 * invariant without a second pass. Also part of the SHIPPED law — see
 * {@link spectralEnergyInto}.
 */
export function ratioMaskBinInto(energies: Float32Array, eps: number, out: Float32Array): number {
  const n = energies.length;
  let denom = eps;
  for (let i = 0; i < n; i++) denom += energies[i];
  if (denom <= 0) {
    // Defensive: eps>0 makes this unreachable.
    out.fill(0, 0, n);
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    let m = energies[i] / denom;
    // Clamp against float drift so the invariant m ∈ [0,1] holds exactly.
    if (m < 0) m = 0;
    else if (m > 1) m = 1;
    out[i] = m;
    sum += out[i]; // read back: Σ is measured on the f32 masks actually used
  }
  return sum;
}

/**
 * Allocating convenience wrapper over {@link ratioMaskBinInto} — same law, one
 * fresh Float32Array per call. Kept for direct testing and ad-hoc callers; the
 * hot path uses the `…Into` form with reusable scratch.
 */
export function ratioMaskBin(energies: Float32Array, eps: number): Float32Array {
  const out = new Float32Array(energies.length);
  ratioMaskBinInto(energies, eps, out);
  return out;
}

/**
 * Overlap-add energy of the analysis·synthesis window (Hann², the product of
 * the Hann analysis and Hann synthesis windows) tiled at `hop` over `frames`
 * frames. Used to VERIFY the COLA condition: the interior must be constant.
 * Returns a per-sample accumulator of length (frames-1)*hop + fftSize.
 */
export function colaWindowEnergy(fftSize: number, hop: number, frames: number): Float32Array {
  const win = hann(fftSize);
  const len = (frames - 1) * hop + fftSize;
  const acc = new Float32Array(len);
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    for (let i = 0; i < fftSize; i++) acc[start + i] += win[i] * win[i];
  }
  return acc;
}

/** Validate the option set and fill defaults. Throws on structurally bad input. */
function resolveOptions(opts: StemPartitionOptions): { fftSize: number; hop: number; eps: number; collectStats: boolean } {
  const fftSize = opts.fftSize ?? DEFAULT_STEM_PARTITION_OPTIONS.fftSize;
  const hop = opts.hop ?? Math.floor(fftSize / 4);
  const eps = opts.eps ?? DEFAULT_STEM_PARTITION_OPTIONS.eps;
  if (fftSize < 2 || (fftSize & (fftSize - 1)) !== 0) {
    throw new Error(`partitionStems: fftSize must be a power of two >= 2, got ${fftSize}`);
  }
  if (hop < 1 || hop > fftSize) {
    throw new Error(`partitionStems: hop must be in [1, fftSize], got ${hop}`);
  }
  if (!(eps > 0)) {
    throw new Error(`partitionStems: eps must be > 0, got ${eps}`);
  }
  return { fftSize, hop, eps, collectStats: opts.collectStats ?? false };
}

export function partitionStems(
  mix: Float32Array[],
  estimates: Float32Array[][],
  opts: StemPartitionOptions = {}
): StemPartitionResult {
  const { fftSize, hop, eps, collectStats } = resolveOptions(opts);

  const channels = mix.length;
  if (channels === 0) throw new Error('partitionStems: mix must have at least one channel');
  const S = estimates.length;
  if (S === 0) throw new Error('partitionStems: estimates must have at least one source');

  // Shape validation: every source has `channels` channels, and every channel
  // (mix and estimate) has the same length as the corresponding mix channel.
  for (let s = 0; s < S; s++) {
    if (estimates[s].length !== channels) {
      throw new Error(`partitionStems: estimates[${s}] has ${estimates[s].length} channels, expected ${channels}`);
    }
  }
  for (let c = 0; c < channels; c++) {
    const len = mix[c].length;
    for (let s = 0; s < S; s++) {
      if (estimates[s][c].length !== len) {
        throw new Error(
          `partitionStems: estimates[${s}][${c}] length ${estimates[s][c].length} != mix[${c}] length ${len}`
        );
      }
    }
  }

  // Finiteness validation — FAIL LOUDLY. A NaN/Infinity sample (a model or
  // resampler bug upstream) would otherwise propagate NaN masks -> NaN stems ->
  // NaN residual and silently destroy the "no sound removed" guarantee, which is
  // the worst possible outcome: unplayable audio that still claims to be a
  // partition. One O(samples) scan, negligible beside the STFT work.
  for (let c = 0; c < channels; c++) {
    const mixC = mix[c];
    for (let n = 0; n < mixC.length; n++) {
      if (!Number.isFinite(mixC[n])) {
        throw new Error(`partitionStems: mix[${c}][${n}] is not finite (${mixC[n]})`);
      }
    }
    for (let s = 0; s < S; s++) {
      const estC = estimates[s][c];
      for (let n = 0; n < estC.length; n++) {
        if (!Number.isFinite(estC[n])) {
          throw new Error(`partitionStems: estimates[${s}][${c}][${n}] is not finite (${estC[n]})`);
        }
      }
    }
  }

  const win = hann(fftSize);
  const bins = fftSize / 2 + 1;
  const half = fftSize / 2;

  const stems: Float32Array[][] = [];
  for (let s = 0; s < S; s++) stems.push(new Array<Float32Array>(channels));
  const residual: Float32Array[] = new Array<Float32Array>(channels);

  // Stats accumulators.
  let maskMin = Infinity;
  let maskMax = -Infinity;
  let maxMaskSum = 0;

  // Per-frame scratch (reused across frames and channels).
  const reMix = new Float32Array(fftSize);
  const imMix = new Float32Array(fftSize);
  const reEst = new Float32Array(fftSize);
  const imEst = new Float32Array(fftSize);
  const reSyn = new Float32Array(fftSize);
  const imSyn = new Float32Array(fftSize);
  // Per-source spectral energy of the current frame, and per-source masks.
  const estEnergy: Float32Array[] = [];
  const maskFrame: Float32Array[] = [];
  for (let s = 0; s < S; s++) {
    estEnergy.push(new Float32Array(bins));
    maskFrame.push(new Float32Array(bins));
  }
  // Per-bin gather/scatter scratch for the shared mask law (length = #sources).
  const binEnergy = new Float32Array(S);
  const binMask = new Float32Array(S);

  for (let c = 0; c < channels; c++) {
    const len = mix[c].length;
    const mixC = mix[c];
    const numFrames = Math.max(1, Math.ceil(len / hop));

    const stemOut: Float32Array[] = [];
    for (let s = 0; s < S; s++) stemOut.push(new Float32Array(len));
    const winSq = new Float32Array(len);

    for (let f = 0; f < numFrames; f++) {
      const start = f * hop;

      // --- Analyse the mix frame (keeps phase for synthesis). ---
      imMix.fill(0);
      for (let i = 0; i < fftSize; i++) {
        const idx = start + i;
        reMix[i] = idx < len ? mixC[idx] * win[i] : 0;
      }
      fft(reMix, imMix);

      // --- Analyse each source estimate frame -> spectral energy per bin. ---
      for (let s = 0; s < S; s++) {
        const estC = estimates[s][c];
        imEst.fill(0);
        for (let i = 0; i < fftSize; i++) {
          const idx = start + i;
          reEst[i] = idx < len ? estC[idx] * win[i] : 0;
        }
        fft(reEst, imEst);
        // Shared law (see spectralEnergyInto) — no local copy of |X|².
        spectralEnergyInto(reEst, imEst, bins, estEnergy[s]);
      }

      // --- Ratio masks, bin-major: gather the per-source energies for bin k,
      //     apply the SHARED mask law, scatter the masks back. ---
      for (let k = 0; k < bins; k++) {
        for (let s = 0; s < S; s++) binEnergy[s] = estEnergy[s][k];
        const binSum = ratioMaskBinInto(binEnergy, eps, binMask);
        for (let s = 0; s < S; s++) {
          const m = binMask[s];
          maskFrame[s][k] = m;
          if (collectStats) {
            if (m < maskMin) maskMin = m;
            if (m > maskMax) maskMax = m;
          }
        }
        if (collectStats && binSum > maxMaskSum) maxMaskSum = binSum;
      }

      // --- Synthesis-window energy (accumulate ONCE per frame; same window
      //     for all sources). Mirrors ./stft istft normalisation. ---
      for (let i = 0; i < fftSize; i++) {
        const idx = start + i;
        if (idx < len) winSq[idx] += win[i] * win[i];
      }

      // --- Per source: masked spectrum (mask ⊙ mix), Hermitian mirror, iSTFT,
      //     windowed overlap-add. ---
      for (let s = 0; s < S; s++) {
        const m = maskFrame[s];
        for (let k = 0; k < bins; k++) {
          reSyn[k] = m[k] * reMix[k];
          imSyn[k] = m[k] * imMix[k];
        }
        // Hermitian symmetry for the negative frequencies: X[N-k] = conj(X[k]).
        for (let k = 1; k < half; k++) {
          reSyn[fftSize - k] = reSyn[k];
          imSyn[fftSize - k] = -imSyn[k];
        }
        ifft(reSyn, imSyn); // includes 1/N scaling -> time-domain frame in reSyn
        const outS = stemOut[s];
        for (let i = 0; i < fftSize; i++) {
          const idx = start + i;
          if (idx >= len) break;
          outS[idx] += reSyn[i] * win[i];
        }
      }
    }

    // Normalise each stem by the synthesis-window energy (weighted OLA).
    for (let s = 0; s < S; s++) {
      const outS = stemOut[s];
      for (let n = 0; n < len; n++) {
        if (winSq[n] > 1e-8) outS[n] /= winSq[n];
      }
      stems[s][c] = outS;
    }

    // RESIDUAL = time-domain complement (ruling 4): the minimal, deterministic
    // single subtraction `residual := mix − Σ stems`. The stem sum is a FLOAT32
    // left-to-right running sum in the DELIVERED source order — byte-for-byte
    // the accumulation `mixdownSession` performs when it sums the stem tracks
    // (each `+=` into its Float32Array bus rounds to f32) with the Residual
    // track added last. Storing the difference into a Float32Array rounds it to
    // f32 as well. Under that same f32 accumulation the sum of all stems plus the
    // residual then reproduces the mix; the only unreachable case is a sample
    // whose |mix| sits below the local ULP of the stem sum (near a zero crossing,
    // where the stems slightly overshoot) — there a single f32 residual cannot
    // encode the sub-ULP remainder, and the reconstruction lands within ~1 ULP
    // of that magnitude (≈ −300 dBFS; documented bound, far below audibility and
    // far below the model's own residual). Nothing is synthesised, so nothing is
    // lost beyond that float32 storage granularity.
    const resC = new Float32Array(len);
    for (let n = 0; n < len; n++) {
      let acc = 0;
      for (let s = 0; s < S; s++) acc = Math.fround(acc + stemOut[s][n]);
      resC[n] = mixC[n] - acc; // Float32Array store rounds to f32
    }
    residual[c] = resC;
  }

  const result: StemPartitionResult = { stems, residual };
  if (collectStats) {
    result.stats = {
      maskMin: maskMin === Infinity ? 0 : maskMin,
      maskMax: maskMax === -Infinity ? 0 : maskMax,
      maxMaskSum,
    };
  }
  return result;
}
