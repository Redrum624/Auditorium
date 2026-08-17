'use strict';

/**
 * Lyrics-alignment inference host (F6) — the entry module for the Electron
 * `utilityProcess` that owns onnxruntime-node for the wav2vec2 character-CTC
 * model. Shape, discipline and lifetime mirror `transcribeHost.cjs` (F4),
 * which mirrors `stemHost.cjs` (v1.7): CPU EP only, one job per process
 * lifetime, every message validated at this boundary, the manager kills the
 * child on every terminal branch so cancel is instantaneous and the ORT arena
 * is returned to the OS after each run.
 *
 * ## What this host does NOT do
 *
 * It does not align. It runs the acoustic model and returns the per-frame
 * log-probability grid; the Viterbi search that places the known text lives in
 * `src/dsp/ctcAlign.ts`, because it is pure numeric DSP with no DOM and no
 * Electron imports and the repo's standing constraint puts that in `src/dsp/`.
 * The split is also what makes the aligner testable without a 378 MB download:
 * every alignment property in `src/dsp/ctcAlign.test.ts` is asserted against
 * emission grids built by construction.
 *
 * It also does not decode. The model is never asked what was sung — F6's spike
 * measured this exact checkpoint at 47.1 % WER on the reference sung take,
 * more than double the Whisper the app already ships, and it still places
 * known text to a 20 ms cross-model median. Placing is not reading.
 *
 * ## Message protocol (manager side: alignManager.cjs)
 *
 * Parent → host:
 *   {type:'init', paths:{model, vocab}}
 *       — create the ORT session (CPU EP) and parse the pinned vocab. The
 *         manager sha256-verifies BOTH files before sending this; the host
 *         trusts the paths but nothing else.
 *   {type:'align', id, sampleRate, totalSamples}
 *       — open a job. sampleRate must be 16000 (the renderer resamples with
 *         the app's windowed-sinc, exactly as transcription does); audio is
 *         MONO.
 *   {type:'audio', id, offset, samples}   — Float32Array delivery; coverage
 *                                           tracked as ranges (stemHost).
 *   {type:'run', id}                      — refused unless coverage is
 *                                           exactly [0, totalSamples).
 *   {type:'cancel', id}                   — honoured between chunks; the
 *                                           manager's hard cancel is
 *                                           child.kill().
 *   {type:'shutdown'}                     — release the session, exit 0.
 *
 * Host → parent:
 *   {type:'ready', vocab}
 *       — `vocab` is the model's OWN token→id map, read from the pinned
 *         vocab.json. It is forwarded to the renderer rather than duplicated
 *         there: a tokeniser that invents its own ids would align a different
 *         sequence than the one the graph scores.
 *   {type:'progress', id, done, total}    — done/total are SAMPLES analysed.
 *   {type:'emissions', id, frames, classes, frameSamples, logProbs}
 *       — logProbs is a Float32Array of `frames * classes` log-softmax values,
 *         row-major [frame][class].
 *   {type:'done', id, frames}
 *   {type:'cancelled', id}
 *   {type:'error', stage:'init'|'protocol'|'run', message, id?}
 *
 * ## The numbers, measured in the F6 spike and NOT re-derived here
 *
 *   - 16 kHz mono; whole-utterance zero-mean / unit-variance
 *     (`preprocessor_config.json`: `do_normalize: true`,
 *     `return_attention_mask: false` — there is no attention-mask input).
 *   - Conv stride 320 at 16 kHz, so one output frame per 320 input samples,
 *     i.e. exactly 20 ms. (The spike quotes 20.036 ms; that figure is
 *     11.000 s ÷ 549 frames, duration-over-count rather than the stride. The
 *     conv stack loses one frame to its 400-sample receptive field, which is
 *     what makes the two differ. The stride is the quantity that maps a frame
 *     index to a time, and it is 320 samples exactly — the spike's own
 *     aligner used 0.02 s for the same reason.)
 *   - input `input_values` float32 [1, samples] → `logits` float32 [1, T, 32].
 *   - Vocab: 32 graphemes, `|` the word separator, `<pad>` the CTC blank.
 */

const fs = require('node:fs');

/** The model's fixed input rate. */
const ALIGN_SAMPLE_RATE = 16000;

/**
 * Input samples per output frame — the wav2vec2 feature-encoder's total conv
 * stride (5·2·2·2·2·2·2 = 320). 320/16000 = 20 ms exactly.
 */
const FRAME_SAMPLES = 320;

/**
 * The conv stack's receptive field, in input samples: kernels (10,3,3,3,3,2,2)
 * over strides (5,2,2,2,2,2,2) reach 400 samples. It is why a chunk of L
 * samples yields `floor((L - 400)/320) + 1` frames rather than `L/320`, and it
 * is the reason {@link framesForSamples} is written as the conv recursion
 * rather than a division.
 */
const RECEPTIVE_FIELD_SAMPLES = 400;

/**
 * Chunk length for the forward pass, in samples — 30 s.
 *
 * MEASURED, and the binding measurement is MEMORY, not time. Self-attention is
 * quadratic in T, and `scripts/align-context-bench.cjs` sweep A reports, one
 * fresh process per size on this machine:
 *
 *     30 s -> 1499 frames, 1637 ms, 18.33x, peak RSS   827 MB
 *     60 s -> 2999 frames, 3881 ms, 15.46x, peak RSS 1 315 MB
 *    120 s -> 5999 frames, 11183 ms, 10.73x, peak RSS 4 175 MB
 *    180 s -> 8999 frames, 21620 ms,  8.33x, peak RSS 7 591 MB
 *
 * A single pass over 600 s failed outright. The realtime factor degrades
 * gently; the working set does not. 30 s is where it stays comparable to the
 * transcription host's stated ~1.2 GB worst case, and it is also the exact
 * operating point the F6 spike timed (16.4x on a 30.000 s sung excerpt).
 */
const CHUNK_SAMPLES = ALIGN_SAMPLE_RATE * 30;

/**
 * Context carried on each side of a chunk and then DISCARDED, in samples.
 *
 * ZERO, and that is a measurement rather than an omission.
 *
 * Self-attention has no finite receptive field, so no context length is
 * "enough" by construction — the only honest way to pick one is to measure the
 * chunked grid against a single-pass reference. `scripts/align-context-bench.cjs`
 * does exactly that (sweep B, over 197 words of material whose text is known
 * for every sample of it). Candidates 0, 0.5, 1, 2 and 4 s moved 30, 33, 30, 33
 * and 30 word onsets respectively — no trend — and the LARGEST movement was
 * 0.040 s at 0 s context against 0.220 s at every non-zero candidate. Context
 * measured strictly no better and, on the worst case, worse.
 *
 * The reason is that chunking perturbs the whole grid rather than its edges:
 * attention is global, so the same frame attended over a different span gets a
 * slightly different distribution wherever it sits. There is no edge for a
 * margin to cover.
 *
 * The residual is stated rather than hidden: on audio LONGER than one chunk,
 * about one word onset in six differs from a single-pass alignment, by up to
 * 40 ms. That is the same order as the aligner's own measured precision (20 ms
 * cross-model median, 88 % within 100 ms on n = 51). Audio that FITS in one
 * chunk is bit-identical to a single pass — 0 of 73 onsets moved — see
 * {@link planChunks}.
 */
const CONTEXT_SAMPLES = 0;

/**
 * Trust-boundary cap on job length: 20 minutes at 16 kHz.
 *
 * Arithmetic: the host holds the mono job buffer (4 B/sample → 76.8 MB at
 * 20 min) plus one chunk's ORT arena (bounded by the 30 s chunk, not by the
 * job), and the parent receives 32 log-probs per 20 ms frame — 60000 frames ×
 * 32 × 4 B = 7.7 MB at the cap. 20 minutes covers any vocal take; a longer
 * request is a malformed one, and the Viterbi that consumes this grid has its
 * own, tighter, cell-count cap (`src/dsp/ctcAlign.ts`).
 */
const MAX_TOTAL_SAMPLES = ALIGN_SAMPLE_RATE * 1200;

function isFloat32Array(value) {
  return Object.prototype.toString.call(value) === '[object Float32Array]';
}

/** The cancel signal used to unwind an in-flight run. */
class CancelledError extends Error {}

/**
 * Output frame count for `samples` input samples, as the conv stack computes
 * it: `L = floor((L - kernel)/stride) + 1` per layer. Written as the recursion
 * rather than as the closed form so it stays correct if the layer table is ever
 * checked against another checkpoint.
 *
 * For THIS table the two forms are the same function. Swept over every integer
 * length from 0 to 200,000, the recursion equals
 * `max(0, floor((L - 400)/320) + 1)` at every one — receptive field 400, hop
 * 320, i.e. RECEPTIVE_FIELD_SAMPLES and FRAME_SAMPLES. The clamp is the whole
 * of the difference: below 80 samples the bare closed form evaluates to -1
 * where the recursion's `length < layer.kernel` guard returns 0. An earlier
 * version of this comment claimed they diverge at some short lengths because an
 * intermediate layer's floor bites before the last one does; no such length
 * exists, and the claim is corrected rather than kept as folklore.
 */
const CONV_LAYERS = Object.freeze([
  { kernel: 10, stride: 5 },
  { kernel: 3, stride: 2 },
  { kernel: 3, stride: 2 },
  { kernel: 3, stride: 2 },
  { kernel: 3, stride: 2 },
  { kernel: 2, stride: 2 },
  { kernel: 2, stride: 2 },
]);

function framesForSamples(samples) {
  let length = samples;
  for (const layer of CONV_LAYERS) {
    if (length < layer.kernel) return 0;
    length = Math.floor((length - layer.kernel) / layer.stride) + 1;
  }
  return Math.max(0, length);
}

/**
 * Splits a job into forward passes.
 *
 * Every chunk starts at a MULTIPLE OF {@link FRAME_SAMPLES}, which is what
 * makes stitching exact: a chunk beginning at input sample `s` produces frames
 * whose global index is `s / FRAME_SAMPLES + local`, with no resampling of the
 * frame grid and no fractional offset to round.
 *
 * Each chunk carries `contextSamples` of audio on both sides of the frames it
 * contributes, to be computed and thrown away. {@link CONTEXT_SAMPLES} is
 * **0**, so that margin is NOT taken in production: a pass spans exactly the
 * frames it keeps, extended only by the {@link RECEPTIVE_FIELD_SAMPLES} its own
 * last frame needs to exist at all. No context frame is computed or discarded,
 * and a kept frame at a chunk's leading edge has no real audio to its left.
 *
 * That is the measured answer, not an omission: context is a parameter here
 * precisely because the sweep that chose 0 varies it (see
 * {@link CONTEXT_SAMPLES} and `scripts/align-context-bench.cjs`). A margin
 * cannot help, because chunking perturbs the emission grid globally rather than
 * at its edges — attention is global, so there is no edge for a margin to
 * cover.
 *
 * Returns `[{ start, end, keepFrom, keepTo }]` — `start`/`end` are input-sample
 * bounds of the pass, `keepFrom`/`keepTo` are GLOBAL frame indices, end
 * exclusive. The kept ranges tile `[0, totalFrames)` exactly with no gap and no
 * overlap.
 *
 * Audio that FITS in one chunk gets exactly one pass over exactly itself. That
 * is not an optimisation: chunking perturbs the emission grid globally (see
 * {@link CONTEXT_SAMPLES}), so a selection short enough to align in one pass
 * must never be split into two and given a seam it did not need.
 */
function planChunks(totalSamples, chunkSamples = CHUNK_SAMPLES, contextSamples = CONTEXT_SAMPLES) {
  const totalFrames = framesForSamples(totalSamples);
  if (totalFrames === 0) return [];
  if (totalSamples <= chunkSamples) {
    return [{ start: 0, end: totalSamples, keepFrom: 0, keepTo: totalFrames }];
  }

  const context = Math.max(0, Math.round(contextSamples / FRAME_SAMPLES) * FRAME_SAMPLES);
  // Frames a full-width pass can contribute after both context margins are cut.
  const coreSamples = Math.max(FRAME_SAMPLES, chunkSamples - 2 * context);
  const coreFrames = Math.max(1, Math.floor(coreSamples / FRAME_SAMPLES));

  const chunks = [];
  for (let keepFrom = 0; keepFrom < totalFrames; keepFrom += coreFrames) {
    const keepTo = Math.min(totalFrames, keepFrom + coreFrames);
    const start = Math.max(0, keepFrom * FRAME_SAMPLES - context);
    // The last frame kept is `keepTo - 1`; it needs samples up to
    // (keepTo - 1) * FRAME_SAMPLES + RECEPTIVE_FIELD_SAMPLES to exist at all.
    const needed = (keepTo - 1) * FRAME_SAMPLES + RECEPTIVE_FIELD_SAMPLES;
    const end = Math.min(totalSamples, Math.max(needed, keepTo * FRAME_SAMPLES + context));
    chunks.push({ start, end, keepFrom, keepTo });
  }
  return chunks;
}

/**
 * In-place row-wise log-softmax over a [T][V] grid. Written with the standard
 * max-subtraction so a confident frame (logits in the tens) cannot overflow
 * `Math.exp`.
 */
function logSoftmaxRows(flat, frames, classes, out = new Float32Array(frames * classes)) {
  for (let t = 0; t < frames; t++) {
    const o = t * classes;
    let mx = -Infinity;
    for (let v = 0; v < classes; v++) {
      if (flat[o + v] > mx) mx = flat[o + v];
    }
    let sum = 0;
    for (let v = 0; v < classes; v++) sum += Math.exp(flat[o + v] - mx);
    const lse = mx + Math.log(sum);
    for (let v = 0; v < classes; v++) out[o + v] = flat[o + v] - lse;
  }
  return out;
}

/**
 * The feature extractor's `zero_mean_unit_var_norm`, over the WHOLE utterance
 * (`do_normalize: true`). Returns `{mean, scale}` so the same statistics can be
 * applied to every chunk — normalising per chunk would give the same audio a
 * different input depending on where the chunk boundaries fell.
 *
 * `1e-7` inside the square root is the reference implementation's epsilon, not
 * a guard added here.
 */
function utteranceStats(samples) {
  const n = samples.length;
  if (n === 0) return { mean: 0, scale: 1 };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = samples[i] - mean;
    variance += d * d;
  }
  return { mean, scale: 1 / Math.sqrt(variance / n + 1e-7) };
}

/**
 * Creates the host core. Dependency-injected exactly like createTranscribeHost:
 *   ort         — onnxruntime-node module (Tensor, InferenceSession)
 *   postMessage — reply channel
 *   exit        — process termination
 *   fsImpl      — fs module (vocab parsing; injectable in tests)
 *
 * `chunkSamples` / `contextSamples` default to the module constants and exist
 * as parameters for ONE reason: {@link CONTEXT_SAMPLES} claims to be the
 * smallest context that reproduces a single-pass alignment exactly, and a
 * constant that cannot be varied cannot be measured. `scripts/align-context-bench.cjs`
 * sweeps them against a single-pass reference. Production wiring passes
 * neither.
 */
function createAlignHost({
  ort,
  postMessage,
  exit,
  fsImpl = fs,
  chunkSamples = CHUNK_SAMPLES,
  contextSamples = CONTEXT_SAMPLES,
}) {
  let session = null;
  let vocab = null;
  let job = null;

  function post(msg) {
    postMessage(msg);
  }

  function protocolError(message, id) {
    post({ type: 'error', stage: 'protocol', message, ...(id !== undefined ? { id } : {}) });
  }

  async function handleInit(msg) {
    const p = msg.paths;
    if (!p || typeof p !== 'object' || ['model', 'vocab'].some((k) => typeof p[k] !== 'string' || p[k].length === 0)) {
      protocolError('init: paths must name model and vocab');
      return;
    }
    if (session) {
      protocolError('init: session already created');
      return;
    }
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(p.vocab, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('vocab.json is not a token -> id object');
      }
      for (const [token, id] of Object.entries(parsed)) {
        if (!Number.isInteger(id) || id < 0) throw new Error(`vocab.json entry ${token} is not a non-negative integer id`);
      }
      session = await ort.InferenceSession.create(p.model, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });
      vocab = parsed;
      post({ type: 'ready', vocab: parsed });
    } catch (err) {
      post({ type: 'error', stage: 'init', message: err instanceof Error ? err.message : String(err) });
    }
  }

  function handleAlign(msg) {
    if (!session) {
      protocolError('align: not initialised (send init first)');
      return;
    }
    if (job) {
      protocolError('align: a job is already active (single-job host)', msg.id);
      return;
    }
    if (!Number.isInteger(msg.id)) {
      protocolError('align: id must be an integer');
      return;
    }
    if (msg.sampleRate !== ALIGN_SAMPLE_RATE) {
      protocolError(
        `align: sampleRate must be ${ALIGN_SAMPLE_RATE} (resample before sending), got ${msg.sampleRate}`,
        msg.id
      );
      return;
    }
    if (!Number.isInteger(msg.totalSamples) || msg.totalSamples <= 0 || msg.totalSamples > MAX_TOTAL_SAMPLES) {
      protocolError(
        `align: totalSamples must be an integer in [1, ${MAX_TOTAL_SAMPLES}] — audio longer than 20 minutes at ${ALIGN_SAMPLE_RATE} Hz cannot be aligned in one job — got ${msg.totalSamples}`,
        msg.id
      );
      return;
    }
    if (framesForSamples(msg.totalSamples) === 0) {
      protocolError(
        `align: ${msg.totalSamples} samples is shorter than the model's ${RECEPTIVE_FIELD_SAMPLES}-sample receptive field, so it yields no frames`,
        msg.id
      );
      return;
    }
    job = {
      id: msg.id,
      totalSamples: msg.totalSamples,
      samples: new Float32Array(msg.totalSamples),
      covered: [],
      running: false,
      cancelled: false,
    };
  }

  /** Same interval-merge coverage accounting as stemHost.cjs / transcribeHost.cjs. */
  function addCoverage(list, start, end) {
    let i = 0;
    while (i < list.length && list[i][1] < start) i++;
    let ns = start;
    let ne = end;
    let j = i;
    while (j < list.length && list[j][0] <= ne) {
      ns = Math.min(ns, list[j][0]);
      ne = Math.max(ne, list[j][1]);
      j++;
    }
    list.splice(i, j - i, [ns, ne]);
  }

  function handleAudio(msg) {
    if (!job || msg.id !== job.id) {
      protocolError(`audio: no active job with id ${msg && msg.id}`, msg && msg.id);
      return;
    }
    if (job.running) {
      protocolError('audio: job already running', job.id);
      return;
    }
    if (!isFloat32Array(msg.samples) || msg.samples.length === 0) {
      protocolError('audio: samples must be a non-empty Float32Array', job.id);
      return;
    }
    const len = msg.samples.length;
    if (!Number.isInteger(msg.offset) || msg.offset < 0 || msg.offset + len > job.totalSamples) {
      protocolError(`audio: range [${msg.offset}, ${msg.offset + len}) outside job length ${job.totalSamples}`, job.id);
      return;
    }
    job.samples.set(msg.samples, msg.offset);
    addCoverage(job.covered, msg.offset, msg.offset + len);
  }

  async function handleRun(msg) {
    if (!job || msg.id !== job.id) {
      protocolError(`run: no active job with id ${msg && msg.id}`, msg && msg.id);
      return;
    }
    if (job.running) {
      protocolError('run: already running', job.id);
      return;
    }
    const fullyCovered = job.covered.length === 1 && job.covered[0][0] === 0 && job.covered[0][1] === job.totalSamples;
    if (!fullyCovered) {
      const delivered = job.covered.reduce((n, [s, e]) => n + (e - s), 0);
      protocolError(
        `run: audio coverage incomplete — only ${delivered} of ${job.totalSamples} samples delivered; duplicated ranges do not count`,
        job.id
      );
      return;
    }
    job.running = true;
    const thisJob = job;
    try {
      const totalFrames = framesForSamples(thisJob.totalSamples);
      const chunks = planChunks(thisJob.totalSamples, chunkSamples, contextSamples);
      const { mean, scale } = utteranceStats(thisJob.samples);
      let classes = 0;
      let logProbs = null;
      const inputName = session.inputNames[0];
      const outputName = session.outputNames[0];

      for (const chunk of chunks) {
        if (thisJob.cancelled) throw new CancelledError('cancelled');
        const width = chunk.end - chunk.start;
        const normalised = new Float32Array(width);
        for (let i = 0; i < width; i++) normalised[i] = (thisJob.samples[chunk.start + i] - mean) * scale;
        const feeds = {};
        feeds[inputName] = new ort.Tensor('float32', normalised, [1, width]);
        const out = await session.run(feeds);
        const tensor = out[outputName];
        const chunkFrames = tensor.dims[1];
        const chunkClasses = tensor.dims[2];
        if (classes === 0) {
          classes = chunkClasses;
          logProbs = new Float32Array(totalFrames * classes);
        } else if (chunkClasses !== classes) {
          throw new Error(`model returned ${chunkClasses} classes after ${classes} — the graph changed mid-job`);
        }
        const chunkLp = logSoftmaxRows(tensor.data, chunkFrames, classes);
        // The chunk's local frame 0 corresponds to global frame
        // chunk.start / FRAME_SAMPLES, because every chunk starts on a frame
        // boundary. Frames outside [keepFrom, keepTo) are context and dropped.
        const localOffset = chunk.start / FRAME_SAMPLES;
        for (let g = chunk.keepFrom; g < chunk.keepTo; g++) {
          const local = g - localOffset;
          if (local < 0 || local >= chunkFrames) {
            throw new Error(`chunk at ${chunk.start} produced ${chunkFrames} frames, short of global frame ${g}`);
          }
          logProbs.set(chunkLp.subarray(local * classes, (local + 1) * classes), g * classes);
        }
        post({
          type: 'progress',
          id: thisJob.id,
          done: Math.min(thisJob.totalSamples, chunk.keepTo * FRAME_SAMPLES),
          total: thisJob.totalSamples,
        });
      }

      if (!logProbs) throw new Error('no frames were produced');
      job = null;
      post({
        type: 'emissions',
        id: thisJob.id,
        frames: totalFrames,
        classes,
        frameSamples: FRAME_SAMPLES,
        logProbs,
      });
      post({ type: 'done', id: thisJob.id, frames: totalFrames });
    } catch (err) {
      job = null;
      if (err instanceof CancelledError) {
        post({ type: 'cancelled', id: thisJob.id });
        return;
      }
      post({
        type: 'error',
        stage: 'run',
        id: thisJob.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function handleCancel(msg) {
    if (!job || msg.id !== job.id) {
      post({ type: 'cancelled', id: msg && msg.id });
      return;
    }
    if (job.running) {
      job.cancelled = true; // honoured between chunks
    } else {
      const id = job.id;
      job = null;
      post({ type: 'cancelled', id });
    }
  }

  async function handleShutdown() {
    try {
      if (session && typeof session.release === 'function') await session.release();
    } catch {
      // Best-effort — shutdown must never fail loudly.
    }
    session = null;
    vocab = null;
    exit(0);
  }

  /** The single entry point — never throws, whatever arrives. */
  async function handleMessage(msg) {
    try {
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
        protocolError(`malformed message: ${JSON.stringify(msg)?.slice(0, 200)}`);
        return;
      }
      switch (msg.type) {
        case 'init':
          await handleInit(msg);
          break;
        case 'align':
          handleAlign(msg);
          break;
        case 'audio':
          handleAudio(msg);
          break;
        case 'run':
          await handleRun(msg);
          break;
        case 'cancel':
          handleCancel(msg);
          break;
        case 'shutdown':
          await handleShutdown();
          break;
        default:
          protocolError(`unknown message type: ${msg.type}`);
      }
    } catch (err) {
      post({
        type: 'error',
        stage: 'protocol',
        message: `internal: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return {
    handleMessage,
    dispose: () => handleShutdown(),
  };
}

// ---------------------------------------------------------------------------
// utilityProcess bootstrap — only runs inside a real Electron utility process.
// ---------------------------------------------------------------------------
if (process.parentPort) {
  const host = createAlignHost({
    ort: require('onnxruntime-node'),
    postMessage: (msg) => process.parentPort.postMessage(msg),
    exit: (code) => process.exit(code),
  });
  process.parentPort.on('message', (e) => {
    void host.handleMessage(e.data);
  });
}

module.exports = {
  createAlignHost,
  planChunks,
  framesForSamples,
  logSoftmaxRows,
  utteranceStats,
  CancelledError,
  ALIGN_SAMPLE_RATE,
  FRAME_SAMPLES,
  RECEPTIVE_FIELD_SAMPLES,
  CHUNK_SAMPLES,
  CONTEXT_SAMPLES,
  MAX_TOTAL_SAMPLES,
};
