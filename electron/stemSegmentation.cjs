'use strict';

/**
 * Faithful port of the HF reference segmentation for htdemucs ONNX inference
 * (`StemSplitio/htdemucs-onnx` → `infer.py`, MIT) — plan ruling 5: ported,
 * not reinvented. Every constant and formula below maps 1:1 onto a line of
 * the reference; where the reference has an edge quirk we keep it (sample 0
 * of the whole track gets window weight 0 from the only chunk that covers
 * it, so it normalises to exactly 0 — that IS the reference's output).
 *
 * Reference mapping:
 *   SEGMENT_SAMPLES  = int(SEGMENT_S * SAMPLE_RATE) = int(7.8 * 44100)
 *   OVERLAP_SAMPLES  = N_SAMPLES // 4
 *   STRIDE_SAMPLES   = N_SAMPLES - overlap
 *   makeWindow       = _make_window (ones + np.linspace(0,1,overlap) fades)
 *   planSegments     = the chunk loop bounds
 *                      (n_chunks = max(1, ceil(total/stride)))
 *   accumulateSegment= out[:, :, start:end] += stems * w; weight += w
 *   extractFinalized = out /= np.maximum(weight, 1e-8), performed
 *                      progressively (see below)
 *
 * The ONLY structural deviation from the reference is WHEN normalisation
 * happens, not what it computes: the reference divides the whole track once
 * at the end; we normalise each region as soon as no later segment can touch
 * it (a sample is final once the NEXT segment's start is past it), so the
 * host can stream finalized stem chunks back per segment instead of holding
 * the full result until the end. Each sample is still divided exactly once
 * after having received every contribution, so the numbers are identical —
 * asserted bit-for-bit in stemSegmentation.test.cjs.
 *
 * This module is pure math over typed arrays — no onnxruntime, no electron —
 * so the port can be verified by fast unit tests and reused by both the
 * utility-process host (stemHost.cjs) and the integration bench.
 */

const MODEL_SAMPLE_RATE = 44100;
const SEGMENT_SECONDS = 7.8;
const SEGMENT_SAMPLES = Math.floor(SEGMENT_SECONDS * MODEL_SAMPLE_RATE); // 343,980
const OVERLAP_SAMPLES = Math.floor(SEGMENT_SAMPLES / 4); // 85,995
const STRIDE_SAMPLES = SEGMENT_SAMPLES - OVERLAP_SAMPLES; // 257,985
const STEM_NAMES = Object.freeze(['drums', 'bass', 'other', 'vocals']);
const STEM_COUNT = STEM_NAMES.length;
const MODEL_CHANNELS = 2;
/** Reference: out /= np.maximum(weight, 1e-8). */
const WEIGHT_EPSILON = 1e-8;

/**
 * The reference's `_make_window(n, overlap)`: all-ones with a linear fade-in
 * over the first `overlap` samples and the same ramp reversed over the last
 * `overlap`. `np.linspace(0, 1, overlap)` includes BOTH endpoints —
 * fade[k] = k/(overlap-1) — so w[0] and w[n-1] are exactly 0 and the two
 * ramps of adjacent chunks sum to exactly 1 across an overlap.
 */
function makeWindow(n = SEGMENT_SAMPLES, overlap = OVERLAP_SAMPLES) {
  const w = new Float32Array(n).fill(1);
  for (let k = 0; k < overlap; k++) {
    const fade = k / (overlap - 1);
    w[k] = fade;
    w[n - 1 - k] = fade;
  }
  return w;
}

/**
 * The reference's chunk loop bounds: n_chunks = max(1, ceil(total/stride)),
 * chunk i covers [i*stride, min(i*stride + SEGMENT_SAMPLES, total)). The
 * last chunk is zero-PADDED to SEGMENT_SAMPLES by the caller before
 * inference (the pad never appears in the output — only [start, end) is
 * accumulated).
 */
function planSegments(totalSamples) {
  if (!Number.isInteger(totalSamples) || totalSamples <= 0) {
    throw new Error(`planSegments: totalSamples must be a positive integer, got ${totalSamples}`);
  }
  const nChunks = Math.max(1, Math.ceil(totalSamples / STRIDE_SAMPLES));
  const plan = [];
  for (let i = 0; i < nChunks; i++) {
    const start = i * STRIDE_SAMPLES;
    plan.push({ start, end: Math.min(start + SEGMENT_SAMPLES, totalSamples) });
  }
  return plan;
}

/**
 * Overlap-add state: one planar Float32Array per (stem, channel) —
 * `out[s * MODEL_CHANNELS + c]` — plus the shared weight track (the window
 * weight is identical for every stem/channel, so the reference accumulates
 * it once per chunk; so do we). `flushed` tracks how far extractFinalized
 * has already normalised-and-emitted.
 */
function createAccumulator(totalSamples) {
  const out = [];
  for (let i = 0; i < STEM_COUNT * MODEL_CHANNELS; i++) out.push(new Float32Array(totalSamples));
  return { total: totalSamples, out, weight: new Float32Array(totalSamples), flushed: 0 };
}

/**
 * The reference's accumulation for one chunk:
 *   out[:, :, start:end] += stems[:, :, :clen] * window[:clen]
 *   weight[start:end]    += window[:clen]
 * `stemData` is the raw ORT output tensor data — Float32Array of shape
 * (1, 4, 2, SEGMENT_SAMPLES) row-major, i.e. stem s / channel c / sample t
 * lives at ((s*2 + c) * SEGMENT_SAMPLES) + t.
 */
function accumulateSegment(acc, seg, stemData, window) {
  const clen = seg.end - seg.start;
  for (let s = 0; s < STEM_COUNT; s++) {
    for (let c = 0; c < MODEL_CHANNELS; c++) {
      const src = (s * MODEL_CHANNELS + c) * SEGMENT_SAMPLES;
      const dst = acc.out[s * MODEL_CHANNELS + c];
      for (let t = 0; t < clen; t++) {
        dst[seg.start + t] += stemData[src + t] * window[t];
      }
    }
  }
  const w = acc.weight;
  for (let t = 0; t < clen; t++) w[seg.start + t] += window[t];
}

/**
 * The first sample index NOT yet final after segment `i` completes: segment
 * i+1 (if any) still contributes from its own `start` onward, so everything
 * BEFORE plan[i+1].start has received every contribution it will ever get;
 * after the last segment the whole track is final.
 */
function finalizedEnd(plan, i, totalSamples) {
  return i + 1 < plan.length ? plan[i + 1].start : totalSamples;
}

/**
 * Normalises and emits the region [acc.flushed, upTo) — the reference's
 * `out /= np.maximum(weight, 1e-8)`, applied progressively. Returns
 * `{ offset, samples, data }` where `data` is planar
 * (stem-major, channel-minor: block sc = s*MODEL_CHANNELS+c of length
 * `samples`), or null when the region is empty. Throws when asked to flush
 * past the end of the track (a caller bug, not a data condition).
 */
function extractFinalized(acc, upTo) {
  if (upTo > acc.total) {
    throw new Error(`extractFinalized: upTo ${upTo} past total ${acc.total}`);
  }
  const offset = acc.flushed;
  const samples = upTo - offset;
  if (samples <= 0) return null;
  const blocks = STEM_COUNT * MODEL_CHANNELS;
  const data = new Float32Array(blocks * samples);
  const weight = acc.weight;
  for (let sc = 0; sc < blocks; sc++) {
    const src = acc.out[sc];
    const base = sc * samples;
    for (let t = 0; t < samples; t++) {
      data[base + t] = src[offset + t] / Math.max(weight[offset + t], WEIGHT_EPSILON);
    }
  }
  acc.flushed = upTo;
  return { offset, samples, data };
}

module.exports = {
  MODEL_SAMPLE_RATE,
  SEGMENT_SECONDS,
  SEGMENT_SAMPLES,
  OVERLAP_SAMPLES,
  STRIDE_SAMPLES,
  STEM_NAMES,
  STEM_COUNT,
  MODEL_CHANNELS,
  WEIGHT_EPSILON,
  makeWindow,
  planSegments,
  createAccumulator,
  accumulateSegment,
  finalizedEnd,
  extractFinalized,
};
