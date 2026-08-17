'use strict';

/**
 * Voice-changer inference host (F3) — the entry module for the Electron
 * `utilityProcess` that owns onnxruntime-node for the OpenVoice V2
 * tone-colour converter. Shape, discipline and lifetime mirror stemHost.cjs
 * (v1.7) and transcribeHost.cjs (v1.16), the proven pattern: CPU EP only
 * (the spike measured DirectML at 13.9/16.4 GB VRAM on a 350 s input —
 * certain OOM on an 8 GB card, the same failure shape that killed DirectML
 * for stems; do not re-litigate), one job per process lifetime, every
 * message validated at this boundary, the manager kills the child on every
 * terminal branch so Cancel is instantaneous and the ORT arena is returned
 * to the OS after each run.
 *
 * ## Message protocol (manager side: voiceManager.cjs)
 *
 * Parent → host:
 *   {type:'init', paths:{extractor, converter}}
 *       — create the two ORT sessions (CPU EP). The manager sha256-verifies
 *         both files before sending this; the host trusts the paths but
 *         nothing else.
 *   {type:'embed', id, totalSamples}
 *       — open a REFERENCE-EMBEDDING job: extract the tone embedding of a
 *         whole reference clip in ONE pass (the spike's round-2 requirement:
 *         whole-utterance target embedding — chunk-averaging measurably
 *         worsened identity on 6-12 s reference clips).
 *   {type:'convert', id, totalSamples, targetVector}
 *       — open a CONVERSION job. targetVector: Float32Array(256), the stored
 *         voice-profile embedding (dest_tone).
 *   {type:'audio', id, offset, samples}   — mono 22050 Hz Float32Array
 *                                           delivery; coverage tracked as
 *                                           ranges (stemHost's discipline).
 *   {type:'run', id}                      — refused unless coverage is
 *                                           exactly [0, totalSamples).
 *   {type:'cancel', id}                   — honoured between model runs; the
 *                                           manager's hard cancel is
 *                                           child.kill().
 *   {type:'shutdown'}                     — release sessions, exit 0.
 *
 * Host → parent:
 *   {type:'ready'}
 *   {type:'progress', id, stage:'embed'|'convert', done, total}
 *       — units are CHUNKS of the plan (an embed job is one chunk).
 *   {type:'embedded', id, vector}         — embed-job terminal: the
 *                                           Float32Array(256) tone embedding.
 *   {type:'chunk', id, offset, samples, data}
 *       — a finalized converted mono region (SPLICED output, NOT raw
 *         per-chunk model output). Regions are contiguous and tile
 *         [0, totalSamples) exactly.
 *   {type:'done', id, chunkCount, sanitisedSamples}
 *                                         — convert-job terminal.
 *   {type:'cancelled', id}
 *   {type:'error', stage:'init'|'protocol'|'run', message, id?}
 *
 * ## Model configuration — measured or cited, never invented
 *
 *   - `TAU = 0.3` — OpenVoice's own official default, and the spike's
 *     round-2 sweep measured it BEST for identity (tau=1.0 was measurably
 *     worse on both probe targets). An implementation requirement, not a
 *     tunable.
 *   - The tone-colour graph converts a whole utterance in one run, so RSS is
 *     linear in length (~183 MB + 5.4 MB/s measured); conversion is chunked
 *     at ~30 s (voiceChunking.cjs SEGMENT_SAMPLES) with constant-power 25 ms
 *     seams and edge-frame discard — the seam design is derived from real
 *     measurements recorded in voiceChunking.cjs's header (the decoder is
 *     deterministic but NOT frame-shift-equivariant, and its context reaches
 *     ~64 frames past a chunk edge — 32x further than the spectrogram's own
 *     2 frames, which is why the discard margin is 16,384 samples and not
 *     512). Chunking bounds inference memory at a throughput cost of 5.3%
 *     seam re-processing, on a path measured at 4.0-4.9x realtime.
 *   - The SOURCE tone embedding is global: computed ONCE, before conversion,
 *     as the unweighted mean of the per-chunk embeddings over the same chunk
 *     plan — OpenVoice's own `se_extractor.get_se` behaviour
 *     (`torch.stack(gs).mean(0)`). For a single-chunk source this IS the
 *     whole-utterance embedding, matching the spike rig exactly. (The spike's
 *     "do not segment" finding is about SHORT references, 6-12 s, where the
 *     whole clip fits one chunk anyway; a whole-utterance pass over an
 *     arbitrarily long SOURCE is exactly the unbounded-RSS case chunking
 *     exists to prevent.)
 *   - The REFERENCE embedding is whole-utterance in one pass (spike round-2
 *     requirement), which is why embed jobs have the tighter length cap.
 */

const {
  VC_SAMPLE_RATE,
  HOP_LENGTH,
  SPEC_BINS,
  MIN_INPUT_SAMPLES,
  spectrogram,
  toFramesBins,
  planVoiceSegments,
  createVoiceAccumulator,
  accumulateVoiceSegment,
  voiceFinalizedEnd,
  extractVoiceFinalized,
  padToHopMultiple,
} = require('./voiceChunking.cjs');

/** OpenVoice's official default tau; spike round-2 sweep measured it best
 * (see module header). Fed to the graph verbatim — pinned by test. */
const TAU = 0.3;
/** The converter's tone-embedding width — the `[1, 256, 1]` tensor axis. */
const TONE_EMBEDDING_SIZE = 256;

/** Trust-boundary cap on a CONVERSION job: 30 minutes at 22050 Hz — the same
 * whole-real-tracks policy as stemHost's cap, with this host's arithmetic:
 * per input sample it holds the job buffer (4 B) + the splice accumulator
 * (4 B) = 8 B (the weight track the stem port needed is gone — outside a
 * 551-sample seam exactly one chunk contributes at weight 1), so 30 min =
 * 22050·1800 ≈ 39.7 M samples ≈ 318 MB of buffers, on top of the ~350 MB
 * measured per-chunk inference RSS ≈ 670 MB worst case. Anything above is a
 * malformed/hostile request. */
const MAX_TOTAL_SAMPLES = VC_SAMPLE_RATE * 1800;

/** Trust-boundary cap on an EMBED job: 350 s — the longest input the spike
 * measured end-to-end (embedding extraction included, peak RSS 2,092 MB for
 * extraction PLUS whole-utterance conversion; extraction alone sits far
 * below). The whole-utterance requirement makes this job unchunkable, so the
 * cap keeps it inside measured territory. */
const MAX_REFERENCE_SAMPLES = VC_SAMPLE_RATE * 350;

function isFloat32Array(value) {
  return Object.prototype.toString.call(value) === '[object Float32Array]';
}

/** The cancel signal used to unwind an in-flight run loop. */
class CancelledError extends Error {}

/**
 * Extracts the tone embedding of mono 22050 Hz samples: spectrogram →
 * tone_extract → Float32Array(256). Module-level (transcribeHost's
 * computeEmbedding precedent) so the integration bench drives the exact
 * production choreography rather than a re-implementation.
 */
async function extractToneEmbedding({ ort, session, samples }) {
  const { spec, frames } = spectrogram(samples);
  const feeds = {};
  feeds[session.inputNames[0]] = new ort.Tensor('float32', toFramesBins(spec, frames), [1, frames, SPEC_BINS]);
  const out = await session.run(feeds);
  const emb = out[session.outputNames[0]].data;
  if (emb.length !== TONE_EMBEDDING_SIZE) {
    throw new Error(`tone extractor returned ${emb.length} values, expected ${TONE_EMBEDDING_SIZE}`);
  }
  const vector = new Float32Array(TONE_EMBEDDING_SIZE);
  for (let i = 0; i < TONE_EMBEDDING_SIZE; i++) {
    const v = emb[i];
    if (!Number.isFinite(v)) {
      throw new Error(`tone extractor returned a non-finite embedding component at index ${i}`);
    }
    vector[i] = v;
  }
  return vector;
}

/**
 * Converts ONE chunk (mono 22050 Hz samples, zero-padded here to a HOP
 * multiple) with fixed source/target tone embeddings. Returns the raw
 * converted samples (frames·HOP of them, covering at least the chunk) plus
 * the count of non-finite output samples zeroed — the stem host's honesty
 * about model output, reported rather than silently passed through.
 * Module-level for the same bench-reuse reason as extractToneEmbedding.
 */
async function convertChunk({ ort, session, samples, srcTone, destTone }) {
  const padded = padToHopMultiple(samples);
  const { spec, frames } = spectrogram(padded);
  const out = await session.run({
    audio: new ort.Tensor('float32', spec, [1, SPEC_BINS, frames]),
    audio_length: new ort.Tensor('int64', BigInt64Array.from([BigInt(frames)]), [1]),
    src_tone: new ort.Tensor('float32', srcTone, [1, TONE_EMBEDDING_SIZE, 1]),
    dest_tone: new ort.Tensor('float32', destTone, [1, TONE_EMBEDDING_SIZE, 1]),
    tau: new ort.Tensor('float32', Float32Array.from([TAU]), [1]),
  });
  const raw = out[session.outputNames[0]].data;
  // The measured output contract (spike: 11.00 s in → 947 frames → 947·256
  // samples out). A different length means the graph is not the one the spike
  // validated — fail loudly rather than mis-align the splice.
  if (raw.length !== frames * HOP_LENGTH) {
    throw new Error(
      `converter returned ${raw.length} samples for ${frames} frames, expected ${frames * HOP_LENGTH}`
    );
  }
  const data = new Float32Array(raw.length);
  let sanitised = 0;
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (Number.isFinite(v)) {
      data[i] = v;
    } else {
      sanitised++;
    }
  }
  return { data, sanitised };
}

/**
 * Creates the host core. Dependency-injected exactly like createStemHost:
 *   ort         — onnxruntime-node module (Tensor, InferenceSession)
 *   postMessage — reply channel
 *   exit        — process termination
 */
function createVoiceHost({ ort, postMessage, exit }) {
  let sessions = null; // { extractor, converter }
  let job = null;

  function post(msg) {
    postMessage(msg);
  }

  function protocolError(message, id) {
    post({ type: 'error', stage: 'protocol', message, ...(id !== undefined ? { id } : {}) });
  }

  async function handleInit(msg) {
    const p = msg.paths;
    if (
      !p ||
      typeof p !== 'object' ||
      ['extractor', 'converter'].some((k) => typeof p[k] !== 'string' || p[k].length === 0)
    ) {
      protocolError('init: paths must name extractor and converter');
      return;
    }
    if (sessions) {
      protocolError('init: session already created');
      return;
    }
    try {
      const opts = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' };
      const [extractor, converter] = await Promise.all([
        ort.InferenceSession.create(p.extractor, opts),
        ort.InferenceSession.create(p.converter, opts),
      ]);
      sessions = { extractor, converter };
      post({ type: 'ready' });
    } catch (err) {
      post({ type: 'error', stage: 'init', message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Shared open-a-job validation: id, totalSamples bounds, single-job rule. */
  function openJob(msg, kind, maxSamples, maxLabel) {
    if (!sessions) {
      protocolError(`${kind}: not initialised (send init first)`);
      return false;
    }
    if (job) {
      protocolError(`${kind}: a job is already active (single-job host)`, msg.id);
      return false;
    }
    if (!Number.isInteger(msg.id)) {
      protocolError(`${kind}: id must be an integer`);
      return false;
    }
    if (
      !Number.isInteger(msg.totalSamples) ||
      msg.totalSamples < MIN_INPUT_SAMPLES ||
      msg.totalSamples > maxSamples
    ) {
      protocolError(
        `${kind}: totalSamples must be an integer in [${MIN_INPUT_SAMPLES}, ${maxSamples}] — ${maxLabel} — got ${msg.totalSamples}`,
        msg.id
      );
      return false;
    }
    return true;
  }

  function handleEmbed(msg) {
    if (!openJob(msg, 'embed', MAX_REFERENCE_SAMPLES, `a reference clip longer than 350 s at ${VC_SAMPLE_RATE} Hz cannot be embedded whole-utterance`)) {
      return;
    }
    job = {
      kind: 'embed',
      id: msg.id,
      totalSamples: msg.totalSamples,
      samples: new Float32Array(msg.totalSamples),
      covered: [],
      running: false,
      cancelled: false,
    };
  }

  function handleConvert(msg) {
    if (!openJob(msg, 'convert', MAX_TOTAL_SAMPLES, `audio longer than 30 minutes at ${VC_SAMPLE_RATE} Hz cannot be converted in one job`)) {
      return;
    }
    const target = msg.targetVector;
    if (!isFloat32Array(target) || target.length !== TONE_EMBEDDING_SIZE) {
      protocolError(
        `convert: targetVector must be a Float32Array of length ${TONE_EMBEDDING_SIZE}`,
        msg.id
      );
      return;
    }
    for (let i = 0; i < target.length; i++) {
      if (!Number.isFinite(target[i])) {
        protocolError(`convert: targetVector component ${i} is not finite`, msg.id);
        return;
      }
    }
    job = {
      kind: 'convert',
      id: msg.id,
      totalSamples: msg.totalSamples,
      samples: new Float32Array(msg.totalSamples),
      targetVector: Float32Array.from(target),
      covered: [],
      running: false,
      cancelled: false,
    };
  }

  /** Same interval-merge coverage accounting as stemHost.cjs. */
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
      protocolError(
        `audio: range [${msg.offset}, ${msg.offset + len}) outside job length ${job.totalSamples}`,
        job.id
      );
      return;
    }
    job.samples.set(msg.samples, msg.offset);
    addCoverage(job.covered, msg.offset, msg.offset + len);
  }

  function checkCancelled(thisJob) {
    if (thisJob.cancelled) throw new CancelledError('cancelled');
  }

  async function runEmbed(thisJob) {
    const vector = await extractToneEmbedding({
      ort,
      session: sessions.extractor,
      samples: thisJob.samples,
    });
    checkCancelled(thisJob);
    post({ type: 'progress', id: thisJob.id, stage: 'embed', done: 1, total: 1 });
    job = null;
    post({ type: 'embedded', id: thisJob.id, vector });
  }

  async function runConvert(thisJob) {
    const plan = planVoiceSegments(thisJob.totalSamples);

    // Pass 1 — the global source tone: unweighted mean of per-chunk
    // embeddings over the SAME plan (OpenVoice se_extractor's mean; see the
    // module header for why this is not the spike's short-reference case).
    const acc64 = new Float64Array(TONE_EMBEDDING_SIZE);
    for (let i = 0; i < plan.length; i++) {
      checkCancelled(thisJob);
      const seg = plan[i];
      const e = await extractToneEmbedding({
        ort,
        session: sessions.extractor,
        samples: thisJob.samples.subarray(seg.start, seg.end),
      });
      for (let k = 0; k < TONE_EMBEDDING_SIZE; k++) acc64[k] += e[k];
      post({ type: 'progress', id: thisJob.id, stage: 'embed', done: i + 1, total: plan.length });
    }
    const srcTone = Float32Array.from(acc64, (v) => v / plan.length);

    // Pass 2 — convert each chunk with the fixed embeddings, splice at the
    // constant-power seams, stream each region as soon as it is final.
    const acc = createVoiceAccumulator(thisJob.totalSamples);
    let sanitisedSamples = 0;
    for (let i = 0; i < plan.length; i++) {
      checkCancelled(thisJob);
      const seg = plan[i];
      const { data, sanitised } = await convertChunk({
        ort,
        session: sessions.converter,
        samples: thisJob.samples.subarray(seg.start, seg.end),
        srcTone,
        destTone: thisJob.targetVector,
      });
      // Cancel may have landed while inference was in flight — honour it
      // before doing any more work on a result nobody wants (stemHost).
      checkCancelled(thisJob);
      sanitisedSamples += sanitised;
      accumulateVoiceSegment(acc, plan, i, data);
      const flushed = extractVoiceFinalized(acc, voiceFinalizedEnd(plan, i, thisJob.totalSamples));
      if (flushed) {
        post({
          type: 'chunk',
          id: thisJob.id,
          offset: flushed.offset,
          samples: flushed.samples,
          data: flushed.data,
        });
      }
      post({ type: 'progress', id: thisJob.id, stage: 'convert', done: i + 1, total: plan.length });
    }
    job = null;
    post({ type: 'done', id: thisJob.id, chunkCount: plan.length, sanitisedSamples });
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
    const fullyCovered =
      job.covered.length === 1 && job.covered[0][0] === 0 && job.covered[0][1] === job.totalSamples;
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
      if (thisJob.kind === 'embed') {
        await runEmbed(thisJob);
      } else {
        await runConvert(thisJob);
      }
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
      job.cancelled = true; // honoured between model runs by checkCancelled
    } else {
      const id = job.id;
      job = null;
      post({ type: 'cancelled', id });
    }
  }

  async function handleShutdown() {
    try {
      if (sessions) {
        for (const s of Object.values(sessions)) {
          if (s && typeof s.release === 'function') await s.release();
        }
      }
    } catch {
      // Best-effort — shutdown must never fail loudly.
    }
    sessions = null;
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
        case 'embed':
          handleEmbed(msg);
          break;
        case 'convert':
          handleConvert(msg);
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
  const host = createVoiceHost({
    ort: require('onnxruntime-node'),
    postMessage: (msg) => process.parentPort.postMessage(msg),
    exit: (code) => process.exit(code),
  });
  process.parentPort.on('message', (e) => {
    void host.handleMessage(e.data);
  });
}

module.exports = {
  createVoiceHost,
  extractToneEmbedding,
  convertChunk,
  CancelledError,
  TAU,
  TONE_EMBEDDING_SIZE,
  MAX_TOTAL_SAMPLES,
  MAX_REFERENCE_SAMPLES,
};
