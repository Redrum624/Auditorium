'use strict';

/**
 * Voice-changer chunking + spectrogram math (F3) — pure typed-array math, no
 * onnxruntime, no electron, so it is unit-testable and reusable by both the
 * utility-process host (voiceHost.cjs) and the integration bench driver.
 *
 * Two sources, both settled elsewhere — nothing here is invented:
 *
 * 1. **The STFT is OpenVoice's `spectrogram_torch`, ported via the F3 spike
 *    harness** (`.superpowers/sdd/task-F3-spike.md`, step 1): resample to
 *    22050 Hz (the caller's job), reflect-pad by `(1024-256)/2 = 384`,
 *    periodic Hann, `n_fft` 1024 / `hop` 256, `center=False`, magnitude
 *    `sqrt(re²+im²+1e-6)`. The spike verified this preprocessing end-to-end:
 *    the converted output was real audio (envelope correlation 0.9496 to the
 *    source, all providers agreeing within 2 LSB of 16-bit).
 *
 * 2. **The chunking is stemSegmentation.cjs's proven overlap-add discipline**
 *    (itself a port of the HF htdemucs reference): linear crossfade window
 *    (`makeWindow` is REUSED from that module, not re-implemented), chunk
 *    plan `n = max(1, ceil(total/stride))`, per-chunk `out += y*w; weight
 *    += w`, progressive normalisation `out /= max(weight, 1e-8)`. The spike's
 *    ruling that forces chunking at all: the exported graph converts a whole
 *    utterance in one run, so RSS is linear in length (~183 MB + 5.4 MB per
 *    second of audio) — ~30 s chunks bound peak RSS near 350 MB and cost
 *    nothing because throughput is length-independent (4.0-4.9x realtime at
 *    11 s, 70 s and 350 s alike).
 *
 * Derived constants (each derivation stated where it is defined):
 *   SEGMENT_SAMPLES  661,504  — the spike's ~30 s, rounded UP to a HOP
 *                               multiple so a chunk's output length equals its
 *                               input length exactly (see framesForSamples).
 *   OVERLAP_SAMPLES  165,376  — SEGMENT/4, the stem reference's own overlap
 *                               proportion (`N_SAMPLES // 4`).
 *   STRIDE_SAMPLES   496,128  — SEGMENT − OVERLAP.
 *   MIN_INPUT_SAMPLES    385  — REFLECT_PAD+1: the head reflection reads
 *                               x[384], so any shorter input is out of range.
 *
 * The reference edge quirk is KEPT, exactly as stemSegmentation keeps it: the
 * crossfade window is 0 at a chunk's first sample, so the very first sample
 * of the whole output normalises to exactly 0. (Only that one: the plan law
 * always leaves the FINAL chunk truncated below SEGMENT_SAMPLES — proven in
 * voiceChunking.test.cjs — so the window's trailing zero is never applied to
 * a final sample.) One sample at 22.05 kHz is far below audibility, and
 * diverging from the proven port to "fix" it would buy a new untested branch
 * for nothing.
 */

const { makeWindow } = require('./stemSegmentation.cjs');

/** The model's fixed rate — `tone_config.json` (22050 Hz), spike step 1. */
const VC_SAMPLE_RATE = 22050;
/** OpenVoice spectrogram_torch parameters (spike step 1, tensor signature). */
const N_FFT = 1024;
const HOP_LENGTH = 256;
/** 1024/2 + 1 — the `[1, frames, 513]` / `[1, 513, frames]` tensor axis. */
const SPEC_BINS = N_FFT / 2 + 1;
/** OpenVoice pads by (n_fft − hop)/2 on each side before the centre-less STFT. */
const REFLECT_PAD = (N_FFT - HOP_LENGTH) / 2;
/** The head reflection reads x[REFLECT_PAD]; shorter input is unrepresentable. */
const MIN_INPUT_SAMPLES = REFLECT_PAD + 1;

/** ~30 s (spike ruling), rounded UP from 30·22050 = 661,500 to the next HOP
 * multiple (2584·256) so that framesForSamples(SEGMENT)·HOP === SEGMENT and a
 * full chunk's converted output covers its input exactly, sample for sample. */
const SEGMENT_SAMPLES = 661504;
/** SEGMENT/4 — the proportion the stem reference uses (`N_SAMPLES // 4`);
 * also a HOP multiple (646·256), so chunk starts stay frame-aligned. */
const OVERLAP_SAMPLES = SEGMENT_SAMPLES / 4;
const STRIDE_SAMPLES = SEGMENT_SAMPLES - OVERLAP_SAMPLES;
/** Reference: out /= np.maximum(weight, 1e-8) (stemSegmentation.cjs). */
const WEIGHT_EPSILON = 1e-8;

/**
 * Frame count of the centre-less STFT over `n` samples after reflect padding:
 * 1 + floor((n + 2·384 − 1024) / 256). For n a HOP multiple this is exactly
 * n/HOP — the property SEGMENT_SAMPLES is rounded to preserve, and the reason
 * the host zero-pads a chunk to a HOP multiple before converting (the model
 * emits frames·HOP samples; spike: 11.00 s in → 947 frames → 10.995 s out).
 */
function framesForSamples(n) {
  if (!Number.isInteger(n) || n < MIN_INPUT_SAMPLES) {
    throw new Error(`framesForSamples: need an integer >= ${MIN_INPUT_SAMPLES}, got ${n}`);
  }
  return 1 + Math.floor((n + 2 * REFLECT_PAD - N_FFT) / HOP_LENGTH);
}

// ---------------------------------------------------------------------------
// FFT — the spike harness's radix-2 Cooley-Tukey, hoisted to module level so
// the twiddle/bit-reversal tables are built once. float64 throughout the
// transform (the spike measured ~100 ms for 11 s of audio — not a bottleneck).
// ---------------------------------------------------------------------------

function makeFft(n) {
  const levels = Math.log2(n) | 0;
  if (1 << levels !== n) throw new Error(`makeFft: ${n} is not a power of two`);
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let j = 0; j < levels; j++) r |= ((i >>> j) & 1) << (levels - 1 - j);
    rev[i] = r;
  }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  };
}

const fft1024 = makeFft(N_FFT);

/** Periodic Hann — torch.hann_window's definition (0.5 − 0.5·cos(2πi/N)),
 * built once. w[0] === 0; w has no 1.0 sample (periodic, not symmetric). */
const HANN = (() => {
  const w = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  return w;
})();

/**
 * OpenVoice's `spectrogram_torch` over mono 22050 Hz samples: reflect-pad,
 * windowed centre-less STFT, magnitude with the 1e-6 numerical floor.
 * Returns `{spec, frames}` with `spec` BIN-MAJOR (`spec[k*frames + f]`) —
 * exactly the `[1, 513, frames]` layout the converter's `audio` input takes.
 */
function spectrogram(x) {
  const n = x.length;
  if (n < MIN_INPUT_SAMPLES) {
    throw new Error(`spectrogram: need >= ${MIN_INPUT_SAMPLES} samples for the ${REFLECT_PAD}-sample reflect pad, got ${n}`);
  }
  const padded = new Float32Array(n + 2 * REFLECT_PAD);
  for (let i = 0; i < REFLECT_PAD; i++) padded[i] = x[REFLECT_PAD - i];
  padded.set(x, REFLECT_PAD);
  for (let i = 0; i < REFLECT_PAD; i++) padded[REFLECT_PAD + n + i] = x[n - 2 - i];
  const frames = 1 + Math.floor((padded.length - N_FFT) / HOP_LENGTH);
  const spec = new Float32Array(SPEC_BINS * frames);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP_LENGTH;
    for (let i = 0; i < N_FFT; i++) {
      re[i] = padded[off + i] * HANN[i];
      im[i] = 0;
    }
    fft1024(re, im);
    for (let k = 0; k < SPEC_BINS; k++) {
      spec[k * frames + f] = Math.sqrt(re[k] * re[k] + im[k] * im[k] + 1e-6);
    }
  }
  return { spec, frames };
}

/** Transposes a bin-major spectrogram into the frame-major `[1, frames, 513]`
 * layout the tone EXTRACTOR takes (the converter takes bin-major as-is). */
function toFramesBins(spec, frames) {
  const out = new Float32Array(frames * SPEC_BINS);
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < SPEC_BINS; k++) out[f * SPEC_BINS + k] = spec[k * frames + f];
  }
  return out;
}

/**
 * The stem reference's chunk-plan law with the VC constants, plus ONE derived
 * rule the stem planner does not need: a final chunk shorter than
 * MIN_INPUT_SAMPLES cannot be reflect-padded, so it is dropped — safely,
 * because such a tail is ALWAYS already covered by the previous chunk:
 * the dropped chunk starts at s = (n−1)·STRIDE with total − s < 385, and the
 * previous chunk reaches min(s + OVERLAP, total) = total since
 * OVERLAP (165,376) ≥ 385. Asserted, not assumed, in voiceChunking.test.cjs.
 */
function planVoiceSegments(totalSamples) {
  if (!Number.isInteger(totalSamples) || totalSamples < MIN_INPUT_SAMPLES) {
    throw new Error(
      `planVoiceSegments: totalSamples must be an integer >= ${MIN_INPUT_SAMPLES}, got ${totalSamples}`
    );
  }
  const nChunks = Math.max(1, Math.ceil(totalSamples / STRIDE_SAMPLES));
  const plan = [];
  for (let i = 0; i < nChunks; i++) {
    const start = i * STRIDE_SAMPLES;
    plan.push({ start, end: Math.min(start + SEGMENT_SAMPLES, totalSamples) });
  }
  const last = plan[plan.length - 1];
  if (plan.length > 1 && last.end - last.start < MIN_INPUT_SAMPLES) plan.pop();
  return plan;
}

/** The full-segment crossfade window, shared with stemSegmentation (linear
 * ramps over OVERLAP at both ends; adjacent ramps sum to exactly 1). Chunks
 * shorter than SEGMENT read a truncated view of it, exactly as stemHost does. */
function makeVoiceWindow() {
  return makeWindow(SEGMENT_SAMPLES, OVERLAP_SAMPLES);
}

/** Mono overlap-add state — stemSegmentation.createAccumulator with one block. */
function createVoiceAccumulator(totalSamples) {
  return {
    total: totalSamples,
    out: new Float32Array(totalSamples),
    weight: new Float32Array(totalSamples),
    flushed: 0,
  };
}

/** out[start:end] += data·window; weight[start:end] += window — the reference
 * accumulation, mono. `data` must cover at least `seg.end − seg.start`. */
function accumulateVoiceSegment(acc, seg, data, window) {
  const clen = seg.end - seg.start;
  if (data.length < clen) {
    throw new Error(`accumulateVoiceSegment: data length ${data.length} < segment length ${clen}`);
  }
  const out = acc.out;
  const weight = acc.weight;
  for (let t = 0; t < clen; t++) {
    out[seg.start + t] += data[t] * window[t];
    weight[seg.start + t] += window[t];
  }
}

/** First sample NOT final after segment i — stemSegmentation.finalizedEnd. */
function voiceFinalizedEnd(plan, i, totalSamples) {
  return i + 1 < plan.length ? plan[i + 1].start : totalSamples;
}

/** Normalises and emits [acc.flushed, upTo) — progressive
 * `out /= max(weight, 1e-8)`. Returns {offset, samples, data} or null. */
function extractVoiceFinalized(acc, upTo) {
  if (upTo > acc.total) {
    throw new Error(`extractVoiceFinalized: upTo ${upTo} past total ${acc.total}`);
  }
  const offset = acc.flushed;
  const samples = upTo - offset;
  if (samples <= 0) return null;
  const data = new Float32Array(samples);
  for (let t = 0; t < samples; t++) {
    data[t] = acc.out[offset + t] / Math.max(acc.weight[offset + t], WEIGHT_EPSILON);
  }
  acc.flushed = upTo;
  return { offset, samples, data };
}

/** Zero-pads `x` up to the next HOP multiple (returns `x` itself when it
 * already is one), so the converter's output (frames·HOP samples) covers the
 * chunk completely. The pad is at most HOP−1 = 255 zero samples (11.6 ms)
 * whose converted tail is discarded by the accumulator's `clen` bound. */
function padToHopMultiple(x) {
  const rem = x.length % HOP_LENGTH;
  if (rem === 0) return x;
  const padded = new Float32Array(x.length + (HOP_LENGTH - rem));
  padded.set(x, 0);
  return padded;
}

module.exports = {
  VC_SAMPLE_RATE,
  N_FFT,
  HOP_LENGTH,
  SPEC_BINS,
  REFLECT_PAD,
  MIN_INPUT_SAMPLES,
  SEGMENT_SAMPLES,
  OVERLAP_SAMPLES,
  STRIDE_SAMPLES,
  WEIGHT_EPSILON,
  framesForSamples,
  makeFft,
  spectrogram,
  toFramesBins,
  planVoiceSegments,
  makeVoiceWindow,
  createVoiceAccumulator,
  accumulateVoiceSegment,
  voiceFinalizedEnd,
  extractVoiceFinalized,
  padToHopMultiple,
};
