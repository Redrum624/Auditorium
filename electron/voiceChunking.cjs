'use strict';

/**
 * Voice-changer chunking + spectrogram math (F3) — pure typed-array math, no
 * onnxruntime, no electron, so it is unit-testable and reusable by both the
 * utility-process host (voiceHost.cjs) and the integration bench driver.
 *
 * ## The spectrogram
 *
 * OpenVoice's `spectrogram_torch`, ported via the F3 spike harness
 * (`.superpowers/sdd/task-F3-spike.md`, step 1): resample to 22050 Hz (the
 * caller's job), reflect-pad by `(1024-256)/2 = 384`, periodic Hann, `n_fft`
 * 1024 / `hop` 256, `center=False`, magnitude `sqrt(re²+im²+1e-6)`. The spike
 * verified this preprocessing end-to-end (real audio out, cross-provider
 * agreement within 2 LSB of 16-bit).
 *
 * ## The chunking — designed from MEASUREMENT, not proportion
 *
 * The spike's binding finding: the exported graph converts a whole utterance
 * in one run, so RSS is linear in length — chunk at ~30 s, which costs
 * nothing because throughput is length-independent.
 *
 * The seam design then came from measuring the REAL model's behaviour on the
 * 70 s fixture (F3 integration bench, 2026-08-10; every figure below was
 * produced by running the shipped primitives against the pinned ONNX files,
 * and the assertions that hold each one live in voiceIntegration.test.cjs):
 *
 *  - **The graph is deterministic**: identical inputs give a BIT-IDENTICAL
 *    output (max |diff| = 0), so nothing here is chasing run-to-run noise.
 *  - **The pipeline is prefix-stable**: chunk 0 starts where the whole
 *    utterance starts, and its output was BIT-IDENTICAL to the unchunked run
 *    for 635,245 samples — right up to where its own missing right-context
 *    begins to tell.
 *  - **But the decoder is NOT frame-shift-equivariant, at all.** Extending
 *    the analysis window to the left by a SINGLE hop (256 samples) leaves the
 *    interior completely decorrelated: rms|diff| 0.349 against a signal rms
 *    of 0.186 — the difference is LARGER than the signal. Extending by 4, 40
 *    or 400 hops is no different. A chunk that starts mid-file therefore
 *    renders the same words in the same voice with entirely different fine
 *    structure; sample-level agreement with an unchunked run is not something
 *    this model offers past chunk 0, and no seam geometry can buy it.
 *  - Length is the **25 ms** the remix engine ships as its default for
 *    splicing at a join (`remixService.ts` DEFAULTS.crossfadeMs) — short,
 *    because blending two different renditions for longer only widens the
 *    doubled-voice region.
 *
 * ### The crossfade law, and a correction to the reasoning that chose it
 *
 * The first version of this header argued: the renditions are decorrelated,
 * decorrelated material is exactly what **constant power** exists for, done.
 * The first half of that is true GLOBALLY (the shift measurement above) but
 * NOT at the scale the crossfade actually operates. Measured on the seam
 * itself — the crossfade window's RMS against the equal-length windows either
 * side of it, on the 70 s fixture:
 *
 *      constant power  +2.08 dB      equal gain  −0.87 dB
 *
 * A constant-power sum only rises like that when the two sides are partly
 * COHERENT; the equal-gain figure implies a correlation near 0.45. Over 25 ms
 * of tonal material the two renditions share enough local phase to add
 * constructively, and the earlier −1.9/−5.6 dB equal-gain measurement came
 * from a 7.5 s crossfade, over which that coherence averages away. So the
 * honest statement is that neither law is exactly right here.
 *
 * Constant power is kept, for a reason that survives the correction: it is
 * exact at ρ = 0 and errs by at most +3 dB at ρ = 1, while equal gain is
 * exact at ρ = 1 and dips 3 dB at ρ = 0 — and ρ = 0 is the STRUCTURAL case
 * this decoder produces (the shift measurement), with the coherence above an
 * artefact of a locally tonal fixture. Erring toward a brief boost on tonal
 * content beats dipping on everything else, and it keeps one join law across
 * the app (the v1.9 crossfade ruling, and the remix engine's default).
 * The +2.08 dB is recorded in docs/KNOWN_LIMITATIONS.md as a real cost, not
 * argued away.
 *
 * ## EDGE_DISCARD — sized by measurement, twice, because the obvious answer
 *    was wrong by 32x
 *
 * The seam must blend two renditions that are each locally FAITHFUL. A chunk
 * is not faithful at its own edges, because it lacks the context a continuous
 * run has there. The tempting derivation — "an output sample in frame f is
 * synthesised from analysis window [f·256−384, f·256+640), so only a chunk's
 * first two and last two frames see reflected padding, discard 512 samples" —
 * accounts for the SPECTROGRAM only, and the decoder's own context reaches
 * far further. Both were measured:
 *
 *  - **Sample level, at chunk 0's tail** (the one place with a phase-locked
 *    ground truth): |chunk − unchunked| first becomes non-zero ~26,260 samples
 *    before the chunk's end (26,259 under this plan, 26,265 under the pre-fix
 *    one — the source tone is a mean over the plan's own chunks, so the onset
 *    shifts a few samples with the geometry), and rises 1.7e-6 at 14,000 →
 *    9.2e-4 at 10,000 → 2.8e-2 at 8,000 → 0.35 at 2,000 (against a signal rms
 *    of 0.106). So the last ~10,000 samples of a chunk are audibly wrong, and
 *    it is not numerically clean until ~14,000.
 *  - **Envelope level, at mid-file chunk heads and tails** (20 ms = 441-sample
 *    RMS frames — NOT the 256-sample STFT frame — 4 starts, vs the unchunked
 *    run, the only comparison that survives the shift non-equivariance above):
 *    head −6.18 dB in the first frame, −0.62 dB by 8 frames, indistinguishable
 *    from the interior control (mean 0.10 dB) by ~15 frames = 6,615 samples.
 *    Tail −2.11 dB at 6 frames, −0.47 dB at 13, gone by ~20 = 8,820 samples.
 *
 * EDGE_DISCARD is therefore **64 STFT frames = 16,384 samples (0.74 s)** —
 * past the sample-level noise floor (14,000), and 2.5x the head artefact's
 * 6,615-sample reach / 1.9x the tail's 8,820. (An earlier revision said "~3x
 * the envelope artefact's ~20-frame reach", which silently multiplied
 * 441-sample RMS frames by the 256-sample STFT frame; the margin is
 * unaffected, the multiplier was wrong.) It costs 5.3% extra inference
 * (below), on a path measured at 4.0-4.9x realtime.
 *
 * Derived constants:
 *   SEGMENT_SAMPLES     661,504  — the spike's ~30 s, rounded UP to a HOP
 *                                  multiple so a chunk's output length equals
 *                                  its input length (see framesForSamples).
 *   EDGE_DISCARD_SAMPLES 16,384  — 64 frames · HOP; the measured extent of a
 *                                  chunk's context deficiency (above).
 *   CROSSFADE_SAMPLES       551  — round(0.025 · 22050): the remix default.
 *   OVERLAP_SAMPLES      33,536  — smallest HOP multiple ≥ 2·16,384 + 551, so
 *                                  discard margins + crossfade fit and chunk
 *                                  starts stay frame-aligned.
 *   STRIDE_SAMPLES      627,968  — SEGMENT − OVERLAP. Work ratio
 *                                  SEGMENT/STRIDE ≈ 1.053: chunking costs
 *                                  ~5.3% extra inference.
 *   CROSSFADE_OFFSET     16,492  — EDGE_DISCARD + centring slack, where a
 *                                  seam's crossfade begins inside the overlap.
 *   MIN_INPUT_SAMPLES       385  — REFLECT_PAD+1: the head reflection reads
 *                                  x[384]; shorter input is unrepresentable.
 *
 * Because exactly one chunk carries weight 1 everywhere outside a 551-sample
 * crossfade, chunk interiors are copied through BIT-EXACTLY (no windowing, no
 * epsilon division) — which is also what makes the first chunk's
 * prefix-identity a pinnable integration assertion.
 */

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
 * multiple (2584·256) so that framesForSamples(SEGMENT)·HOP === SEGMENT. */
const SEGMENT_SAMPLES = 661504;
/** 64 frames · HOP = 16,384 samples (0.74 s) — the MEASURED extent of a
 * chunk's context deficiency at its own edges, not the 2-frame spectrogram
 * figure the STFT geometry alone would suggest (see the header: sample level
 * clean past 14,000, envelope artefact gone by ~20 frames). */
const EDGE_DISCARD_FRAMES = 64;
const EDGE_DISCARD_SAMPLES = EDGE_DISCARD_FRAMES * HOP_LENGTH;
/** round(0.025 · 22050) — the remix engine's default join crossfade (25 ms,
 * `remixService.ts` DEFAULTS.crossfadeMs), the in-repo precedent for splicing
 * imperfectly-correlated audio. */
const CROSSFADE_SAMPLES = Math.round(0.025 * VC_SAMPLE_RATE);
/** Smallest HOP multiple ≥ 2·EDGE_DISCARD + CROSSFADE (= 33,319) — the seam
 * needs both discard margins plus the crossfade, and chunk starts must stay
 * frame-aligned. */
const OVERLAP_SAMPLES = Math.ceil((2 * EDGE_DISCARD_SAMPLES + CROSSFADE_SAMPLES) / HOP_LENGTH) * HOP_LENGTH;
const STRIDE_SAMPLES = SEGMENT_SAMPLES - OVERLAP_SAMPLES;
/** Where a seam's crossfade begins, relative to the later chunk's start: past
 * the discard margin, centring the 551 samples in the 768 the two margins
 * leave inside the overlap. */
const CROSSFADE_OFFSET =
  EDGE_DISCARD_SAMPLES +
  Math.floor((OVERLAP_SAMPLES - 2 * EDGE_DISCARD_SAMPLES - CROSSFADE_SAMPLES) / 2);

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
 * The chunk-plan law: n = max(1, ceil(total/STRIDE)), chunk i covering
 * [i·STRIDE, min(i·STRIDE + SEGMENT, total)), plus ONE derived rule: a final
 * chunk shorter than OVERLAP_SAMPLES is dropped — safely, because such a tail
 * is ALWAYS already covered by the previous chunk (the dropped chunk starts
 * at s = (n−1)·STRIDE with total − s < OVERLAP, and the previous chunk
 * reaches min(s + OVERLAP, total) = total). The rule also guarantees every
 * surviving seam has the FULL overlap: the last chunk being ≥ OVERLAP long
 * forces the previous chunk's end to s + OVERLAP exactly. Both proofs are
 * asserted, not assumed, in voiceChunking.test.cjs.
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
  if (plan.length > 1 && last.end - last.start < OVERLAP_SAMPLES) plan.pop();
  return plan;
}

/** Where the crossfade between plan[i] and plan[i+1] begins (global sample). */
function crossfadeStart(plan, i) {
  return plan[i + 1].start + CROSSFADE_OFFSET;
}

/** Splice state: the assembled output plus the progressive-flush cursor. No
 * weight track — outside a crossfade exactly one chunk contributes at
 * weight 1, so interiors are bit-exact copies. */
function createVoiceAccumulator(totalSamples) {
  return { total: totalSamples, out: new Float32Array(totalSamples), flushed: 0 };
}

/**
 * Adds chunk `i`'s converted samples into the splice. Piecewise, in global
 * coordinates:
 *   entry crossfade  [xfStart(i−1), +CROSSFADE)  — sin-weighted add
 *   body             up to xfStart(i) (or total) — exact copy
 *   exit crossfade   [xfStart(i), +CROSSFADE)    — cos-weighted add
 * Everything else of the chunk (discard margins, coverage past its seams) is
 * dropped. sin/cos use the half-sample midpoint (k+0.5)/CROSSFADE, so the two
 * sides' POWERS sum to exactly 1 at every sample — the constant-power law the
 * measured decorrelation calls for (module header).
 */
function accumulateVoiceSegment(acc, plan, i, data) {
  const seg = plan[i];
  const clen = seg.end - seg.start;
  if (data.length < clen) {
    throw new Error(`accumulateVoiceSegment: data length ${data.length} < segment length ${clen}`);
  }
  const out = acc.out;
  const contributeFrom = i > 0 ? crossfadeStart(plan, i - 1) : seg.start;
  const contributeTo = i + 1 < plan.length ? crossfadeStart(plan, i) + CROSSFADE_SAMPLES : seg.end;
  for (let t = contributeFrom; t < contributeTo; t++) {
    let w = 1;
    if (i > 0 && t < contributeFrom + CROSSFADE_SAMPLES) {
      w = Math.sin((Math.PI / 2) * ((t - contributeFrom + 0.5) / CROSSFADE_SAMPLES));
    } else if (i + 1 < plan.length && t >= contributeTo - CROSSFADE_SAMPLES) {
      w = Math.cos((Math.PI / 2) * ((t - (contributeTo - CROSSFADE_SAMPLES) + 0.5) / CROSSFADE_SAMPLES));
    }
    out[t] += data[t - seg.start] * w;
  }
}

/** First sample NOT final after chunk i: the next seam's crossfade needs the
 * next chunk, so everything before it is done; the last chunk ends the run. */
function voiceFinalizedEnd(plan, i, totalSamples) {
  return i + 1 < plan.length ? crossfadeStart(plan, i) : totalSamples;
}

/** Emits [acc.flushed, upTo) — a plain copy; splicing already happened. */
function extractVoiceFinalized(acc, upTo) {
  if (upTo > acc.total) {
    throw new Error(`extractVoiceFinalized: upTo ${upTo} past total ${acc.total}`);
  }
  const offset = acc.flushed;
  const samples = upTo - offset;
  if (samples <= 0) return null;
  const data = acc.out.slice(offset, upTo);
  acc.flushed = upTo;
  return { offset, samples, data };
}

/** Zero-pads `x` up to the next HOP multiple (returns `x` itself when it
 * already is one), so the converter's output (frames·HOP samples) covers the
 * chunk completely. The pad is at most HOP−1 = 255 zero samples (11.6 ms)
 * whose converted tail is discarded by the accumulator's bounds. */
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
  EDGE_DISCARD_SAMPLES,
  CROSSFADE_SAMPLES,
  OVERLAP_SAMPLES,
  STRIDE_SAMPLES,
  CROSSFADE_OFFSET,
  framesForSamples,
  makeFft,
  spectrogram,
  toFramesBins,
  planVoiceSegments,
  crossfadeStart,
  createVoiceAccumulator,
  accumulateVoiceSegment,
  voiceFinalizedEnd,
  extractVoiceFinalized,
  padToHopMultiple,
};
