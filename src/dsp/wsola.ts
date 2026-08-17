/**
 * WSOLA — Waveform Similarity Overlap-Add time stretching (Verhelst & Roelands).
 *
 * Changes a signal's DURATION without changing its pitch. `ratio` is the target
 * output/input length ratio: 2.0 makes it twice as long (half speed), 0.5 makes
 * it half as long (double speed); the perceived frequency content is preserved.
 *
 * How it works: synthesis frames are laid down on the output at a fixed 50%-overlap
 * grid (`synthesisHop = frame/2`) using a periodic Hann window, which sums to unity
 * under 50% overlap. Each frame is copied from the input near its nominal analysis
 * position (`k * analysisHop`, where `analysisHop = synthesisHop / ratio`), but the
 * exact copy offset within a ±`SEARCH_MS` window is chosen to MAXIMIZE the normalized
 * cross-correlation between the candidate frame's leading `COMPARE_MS` samples and the
 * "natural continuation" of the previously placed frame (`input[prevChosen + synthesisHop ..]`).
 * That similarity search is what keeps successive frames phase-coherent across the
 * splice, avoiding the transient smearing / phasiness of plain OLA.
 *
 * Output is normalized by an accumulated window-weight buffer (not just assumed unity)
 * so WSOLA's variable frame offsets and the window-edge regions reconstruct cleanly.
 * The result is trimmed/zero-padded to exactly `round(inputLength * ratio)`.
 */

import { hann } from './windows';

/** Analysis/synthesis frame length target (ms), rounded to an even sample count. */
const FRAME_MS = 40;
/** Similarity search radius (± ms) around each nominal analysis position. */
const SEARCH_MS = 10;
/** Length (ms) of the leading span compared by normalized cross-correlation. */
const COMPARE_MS = 10;
/** ratio is clamped to this inclusive range. Exported so callers (e.g.
 * `tempoService.ts`'s `checkTempoChange`) can refuse an out-of-range ratio
 * explicitly instead of relying on `planStretch`'s silent clamp below. */
export const MIN_RATIO = 0.25;
export const MAX_RATIO = 4;
/** onProgress fires once every this many synthesis frames. */
const PROGRESS_FRAME_BATCH = 32;

/**
 * Finds the input index in [nominalStart - search, nominalStart + search] whose
 * `compare`-sample leading segment best matches the reference segment starting at
 * `refStart`, by normalized cross-correlation. The scan runs from -search upward and
 * only strictly-greater scores replace the best, so an exact tie resolves to the
 * FIRST candidate scanned — `-search`, the largest negative offset, not the smallest
 * |offset|. That does not spoil the identity case: at ratio 1.0 off=0 scores exactly
 * 1.0 and every other offset scores below it on non-degenerate material, so the
 * stretch reduces to a near-perfect passthrough; only a signal periodic at exactly
 * the offset spacing can tie 1.0 earlier and win. (Every golden fixture in the repo
 * encodes this behaviour — the comparison is the contract, not a bug to flip.)
 * A silent reference (norm ≈ 0) carries no phase information, so the nominal position
 * is used unchanged.
 */
function bestMatchOffset(
  read: (idx: number) => number,
  nominalStart: number,
  refStart: number,
  compare: number,
  search: number
): number {
  const ref = new Float64Array(compare);
  let refNorm = 0;
  for (let m = 0; m < compare; m++) {
    const rv = read(refStart + m);
    ref[m] = rv;
    refNorm += rv * rv;
  }
  if (refNorm < 1e-12) return nominalStart;
  const refNormSqrt = Math.sqrt(refNorm);

  let bestScore = -Infinity;
  let bestCand = nominalStart;
  for (let off = -search; off <= search; off++) {
    const cand = nominalStart + off;
    let dot = 0;
    let candNorm = 0;
    for (let m = 0; m < compare; m++) {
      const cv = read(cand + m);
      dot += cv * ref[m];
      candNorm += cv * cv;
    }
    const denom = refNormSqrt * Math.sqrt(candNorm);
    const score = denom > 1e-12 ? dot / denom : 0;
    if (score > bestScore) {
      bestScore = score;
      bestCand = cand;
    }
  }
  return bestCand;
}

/**
 * The full WSOLA layout derived from an input length, sample rate and ratio, plus
 * which of the three synthesis regimes applies:
 *  - `empty`   — nothing to synthesize (zero-length input or output).
 *  - `nearest` — input too short to window; fall back to nearest-sample remap.
 *  - `ola`     — the real overlap-add path (carries all frame/search parameters).
 */
export type StretchPlan =
  | { kind: 'empty'; outLen: number }
  | { kind: 'nearest'; outLen: number; r: number; N: number }
  | {
      kind: 'ola';
      outLen: number;
      r: number;
      N: number;
      frame: number;
      synthesisHop: number;
      analysisHop: number;
      search: number;
      compare: number;
      window: Float32Array;
    };

/**
 * Derives the synthesis regime and all WSOLA parameters for one stretch job.
 *
 * Exported (together with computeOffsets / olaWithOffsets) so tests can assert the
 * linked path's shared-offset invariant directly; these are INTERNAL building blocks,
 * not public DSP surface — application code calls timeStretch / timeStretchLinked.
 */
export function planStretch(N: number, sampleRate: number, ratio: number): StretchPlan {
  const r = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
  const outLen = Math.round(N * r);

  if (N === 0 || outLen === 0) {
    return { kind: 'empty', outLen: Math.max(0, outLen) };
  }

  // Frame length in samples, forced even so synthesisHop = frame/2 is integral.
  let frame = Math.round((FRAME_MS / 1000) * sampleRate);
  if (frame % 2 !== 0) frame += 1;
  if (frame > N) frame = N - (N % 2);

  // Degenerate tiny-input fallback: nearest-sample time remap (no windows to overlap).
  if (frame < 4) {
    return { kind: 'nearest', outLen, r, N };
  }

  const synthesisHop = frame / 2;
  const analysisHop = synthesisHop / r;
  const search = Math.max(1, Math.round((SEARCH_MS / 1000) * sampleRate));
  const compare = Math.max(1, Math.min(frame, Math.round((COMPARE_MS / 1000) * sampleRate)));
  const window = hann(frame);

  return { kind: 'ola', outLen, r, N, frame, synthesisHop, analysisHop, search, compare, window };
}

/** Nearest-sample time remap used when the input is too short to window. */
function nearestRemap(channel: Float32Array, outLen: number, r: number, N: number): Float32Array {
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = channel[Math.min(N - 1, Math.round(i / r))];
  return out;
}

/**
 * Runs the WSOLA similarity search over `signal`, returning the chosen input copy
 * offset for each synthesis frame. This is the expensive phase, so `onProgress`
 * (0 → 0.99) is reported here; the caller fires the terminal 1.0. Frame 0 has no
 * predecessor and is copied straight from its nominal position.
 */
export function computeOffsets(
  signal: Float32Array,
  plan: Extract<StretchPlan, { kind: 'ola' }>,
  onProgress?: (f: number) => void
): number[] {
  const { outLen, synthesisHop, analysisHop } = plan;
  const nominalStarts: number[] = [];
  for (let k = 0; k * synthesisHop < outLen; k++) {
    nominalStarts.push(Math.round(k * analysisHop));
  }
  return computeOffsetsFromStarts(signal, plan, nominalStarts, onProgress);
}

/**
 * Core of the similarity search, generalized over the per-frame nominal
 * analysis positions so the constant-ratio path (starts = round(k·analysisHop))
 * and the variable-ratio path (starts sampled from a caller-supplied time map)
 * share one implementation. Frame 0 has no predecessor and is copied straight
 * from its nominal position.
 */
function computeOffsetsFromStarts(
  signal: Float32Array,
  plan: Extract<StretchPlan, { kind: 'ola' }>,
  nominalStarts: number[],
  onProgress?: (f: number) => void
): number[] {
  const { N, outLen, synthesisHop, search, compare } = plan;
  const read = (idx: number): number => (idx >= 0 && idx < N ? signal[idx] : 0);

  const offsets: number[] = [];
  // Reference = "natural continuation" of the previously placed frame.
  let refStart = synthesisHop;

  for (let k = 0; k < nominalStarts.length; k++) {
    const nominalStart = nominalStarts[k];
    const chosen = k === 0 ? nominalStart : bestMatchOffset(read, nominalStart, refStart, compare, search);
    offsets.push(chosen);

    refStart = chosen + synthesisHop;

    if (onProgress && k % PROGRESS_FRAME_BATCH === 0) {
      onProgress(Math.min(0.99, (k * synthesisHop) / outLen));
    }
  }

  return offsets;
}

/**
 * Overlap-adds `channel` onto the synthesis grid using pre-computed copy `offsets`,
 * normalizing by the accumulated window weight. Because the offsets are an input,
 * several channels can share ONE similarity search yet keep their own OLA — the key
 * to stereo-linked stretching (identical offsets ⇒ inter-channel phase preserved).
 */
export function olaWithOffsets(
  channel: Float32Array,
  offsets: number[],
  plan: Extract<StretchPlan, { kind: 'ola' }>
): Float32Array {
  const { N, outLen, frame, synthesisHop, window } = plan;
  const read = (idx: number): number => (idx >= 0 && idx < N ? channel[idx] : 0);

  // Accumulators sized with a full-frame tail so the final synthesis frame fits.
  const bufLen = outLen + frame;
  const acc = new Float64Array(bufLen);
  const weight = new Float64Array(bufLen);

  for (let k = 0; k < offsets.length; k++) {
    const synthesisPos = k * synthesisHop;
    const chosen = offsets[k];
    for (let j = 0; j < frame; j++) {
      const w = window[j];
      acc[synthesisPos + j] += w * read(chosen + j);
      weight[synthesisPos + j] += w;
    }
  }

  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    out[i] = weight[i] > 1e-6 ? acc[i] / weight[i] : 0;
  }
  return out;
}

export function timeStretch(
  input: Float32Array,
  sampleRate: number,
  ratio: number,
  onProgress?: (f: number) => void
): Float32Array {
  const plan = planStretch(input.length, sampleRate, ratio);

  if (plan.kind === 'empty') {
    onProgress?.(1);
    return new Float32Array(plan.outLen);
  }
  if (plan.kind === 'nearest') {
    const out = nearestRemap(input, plan.outLen, plan.r, plan.N);
    onProgress?.(1);
    return out;
  }

  const offsets = computeOffsets(input, plan, onProgress);
  const out = olaWithOffsets(input, offsets, plan);
  onProgress?.(1);
  return out;
}

/**
 * Stereo-linked WSOLA. The similarity search runs ONCE on the mid signal (the
 * arithmetic mean of all channels), and the resulting per-frame copy offsets are
 * applied identically to every channel's overlap-add. This keeps the inter-channel
 * phase relationship phase-locked across the stretch — unlike running `timeStretch`
 * per channel, where each channel could pick different offsets and drift the stereo
 * image. Mono input delegates to `timeStretch` (byte-identical). All channels are
 * assumed equal length and yield identical output lengths (`round(N*ratio)`).
 */
export function timeStretchLinked(
  channels: Float32Array[],
  sampleRate: number,
  ratio: number,
  onProgress?: (f: number) => void
): Float32Array[] {
  if (channels.length === 1) {
    return [timeStretch(channels[0], sampleRate, ratio, onProgress)];
  }

  const numCh = channels.length;
  const N = channels[0].length;
  const plan = planStretch(N, sampleRate, ratio);

  if (plan.kind === 'empty') {
    onProgress?.(1);
    return channels.map(() => new Float32Array(plan.outLen));
  }
  if (plan.kind === 'nearest') {
    const out = channels.map((c) => nearestRemap(c, plan.outLen, plan.r, plan.N));
    onProgress?.(1);
    return out;
  }

  // Mid signal = arithmetic mean of the channels; the search runs on it once.
  const mid = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (let c = 0; c < numCh; c++) sum += channels[c][i];
    mid[i] = sum / numCh;
  }

  const offsets = computeOffsets(mid, plan, onProgress);
  const out = channels.map((c) => olaWithOffsets(c, offsets, plan));
  onProgress?.(1);
  return out;
}

/**
 * Stereo-linked WSOLA time-stretch with a TIME-VARYING ratio — the
 * generalisation of `timeStretchLinked` used by Pitch Correct, where the stretch
 * factor follows a pitch-correction curve instead of being constant.
 *
 * The caller supplies the target output length `outLen` (the rounded integral
 * of its per-sample ratio curve) and `analysisPosAt`, the inverse of that
 * cumulative map: for a synthesis (output) position v ∈ [0, outLen] it returns
 * the input position whose content belongs there. Nominal analysis starts are
 * sampled from it at every synthesis-grid point; the similarity search and
 * overlap-add are the SAME code as the constant path (one shared search over
 * the channel mean, identical offsets applied to every channel), so the
 * inter-channel phase relationship is preserved exactly as in
 * `timeStretchLinked`. With a constant map (analysisPosAt = v ↦ v/r, r a
 * dyadic ratio) the chosen offsets — and therefore the output — are
 * byte-identical to `timeStretchLinked` (pinned in wsola.test.ts).
 *
 * The plan is derived from the AVERAGE ratio outLen/N — only its frame/window
 * geometry is used (per-frame positions come from `analysisPosAt`) — and its
 * outLen is overridden with the caller's exact value so the cumulative map and
 * the plan can never disagree by a rounding ulp. `analysisPosAt` must be
 * monotone non-decreasing with range within [0, N]; the caller enforces
 * per-sample ratio clamping to [MIN_RATIO, MAX_RATIO] when building its map
 * (this function cannot see the ratio curve, only its inverse).
 */
export function timeStretchVariableLinked(
  channels: Float32Array[],
  sampleRate: number,
  outLen: number,
  analysisPosAt: (synthesisPos: number) => number,
  onProgress?: (f: number) => void
): Float32Array[] {
  const numCh = channels.length;
  const N = channels[0]?.length ?? 0;
  const basePlan = planStretch(N, sampleRate, N > 0 ? outLen / N : 1);

  if (basePlan.kind === 'empty' || outLen <= 0) {
    onProgress?.(1);
    return channels.map(() => new Float32Array(Math.max(0, outLen)));
  }
  if (basePlan.kind === 'nearest') {
    const out = channels.map((c) => {
      const o = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        o[i] = c[Math.min(N - 1, Math.max(0, Math.round(analysisPosAt(i))))];
      }
      return o;
    });
    onProgress?.(1);
    return out;
  }

  const plan = { ...basePlan, outLen };

  // Nominal analysis start per synthesis frame, from the caller's time map.
  const nominalStarts: number[] = [];
  for (let k = 0; k * plan.synthesisHop < outLen; k++) {
    nominalStarts.push(Math.round(analysisPosAt(k * plan.synthesisHop)));
  }

  // Shared search on the channel mean (the mid signal), as in timeStretchLinked;
  // a mono input searches its own channel directly (identical to the mean of one).
  let searchSignal: Float32Array;
  if (numCh === 1) {
    searchSignal = channels[0];
  } else {
    const mid = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let sum = 0;
      for (let c = 0; c < numCh; c++) sum += channels[c][i];
      mid[i] = sum / numCh;
    }
    searchSignal = mid;
  }

  const offsets = computeOffsetsFromStarts(searchSignal, plan, nominalStarts, onProgress);
  const out = channels.map((c) => olaWithOffsets(c, offsets, plan));
  onProgress?.(1);
  return out;
}
