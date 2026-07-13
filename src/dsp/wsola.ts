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
/** ratio is clamped to this inclusive range. */
const MIN_RATIO = 0.25;
const MAX_RATIO = 4;
/** onProgress fires once every this many synthesis frames. */
const PROGRESS_FRAME_BATCH = 32;

/**
 * Finds the input index in [nominalStart - search, nominalStart + search] whose
 * `compare`-sample leading segment best matches the reference segment starting at
 * `refStart`, by normalized cross-correlation. Ties resolve to the smallest |offset|
 * because the scan starts at -search and only strictly-greater scores replace the
 * best — combined with off=0 scoring exactly 1.0 for an identity stretch, this makes
 * ratio 1.0 reduce to a near-perfect passthrough. A silent reference (norm ≈ 0) carries
 * no phase information, so the nominal position is used unchanged.
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

export function timeStretch(
  input: Float32Array,
  sampleRate: number,
  ratio: number,
  onProgress?: (f: number) => void
): Float32Array {
  const N = input.length;
  const r = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
  const outLen = Math.round(N * r);

  if (N === 0 || outLen === 0) {
    onProgress?.(1);
    return new Float32Array(Math.max(0, outLen));
  }

  // Frame length in samples, forced even so synthesisHop = frame/2 is integral.
  let frame = Math.round((FRAME_MS / 1000) * sampleRate);
  if (frame % 2 !== 0) frame += 1;
  if (frame > N) frame = N - (N % 2);

  // Degenerate tiny-input fallback: nearest-sample time remap (no windows to overlap).
  if (frame < 4) {
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) out[i] = input[Math.min(N - 1, Math.round(i / r))];
    onProgress?.(1);
    return out;
  }

  const synthesisHop = frame / 2;
  const analysisHop = synthesisHop / r;
  const search = Math.max(1, Math.round((SEARCH_MS / 1000) * sampleRate));
  const compare = Math.max(1, Math.min(frame, Math.round((COMPARE_MS / 1000) * sampleRate)));
  const window = hann(frame);

  const read = (idx: number): number => (idx >= 0 && idx < N ? input[idx] : 0);

  // Accumulators sized with a full-frame tail so the final synthesis frame fits.
  const bufLen = outLen + frame;
  const acc = new Float64Array(bufLen);
  const weight = new Float64Array(bufLen);

  // Reference = "natural continuation" of the previously placed frame. For frame 0
  // there is no predecessor, so it is copied straight from position 0.
  let refStart = synthesisHop;

  for (let k = 0; ; k++) {
    const synthesisPos = k * synthesisHop;
    if (synthesisPos >= outLen) break;

    const nominalStart = Math.round(k * analysisHop);
    const chosen = k === 0 ? nominalStart : bestMatchOffset(read, nominalStart, refStart, compare, search);

    for (let j = 0; j < frame; j++) {
      const w = window[j];
      acc[synthesisPos + j] += w * read(chosen + j);
      weight[synthesisPos + j] += w;
    }

    refStart = chosen + synthesisHop;

    if (onProgress && k % PROGRESS_FRAME_BATCH === 0) {
      onProgress(Math.min(0.99, synthesisPos / outLen));
    }
  }

  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    out[i] = weight[i] > 1e-6 ? acc[i] / weight[i] : 0;
  }
  onProgress?.(1);
  return out;
}
