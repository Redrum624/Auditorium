'use strict';

/**
 * Stem-separation inference host (S1) — the entry module for the Electron
 * `utilityProcess` that owns onnxruntime-node. Plan ruling 2: inference runs
 * on the CPU execution provider ONLY (DirectML is measured-disqualified —
 * P0: first chunk unfinished, killed at 708 s, 15.7/16 GB VRAM; do not
 * re-litigate), inside a utility process so the ~5 GB inference peak and any
 * native crash live outside both the renderer and main. The renderer NEVER
 * loads onnxruntime; neither does main — the `require('onnxruntime-node')`
 * below only ever executes inside the spawned child (or a test driver that
 * injects its own `ort`).
 *
 * ## Message protocol (the manager side lives in stemManager.cjs)
 *
 * Parent → host:
 *   {type:'init', modelPath}                — create the ORT session (CPU EP).
 *                                             The manager sha256-verifies the
 *                                             file BEFORE sending this (ruling
 *                                             3: verified before any load) —
 *                                             the host trusts the path but
 *                                             nothing else.
 *   {type:'separate', id, sampleRate, channelCount, totalSamples}
 *                                           — open a job. sampleRate must be
 *                                             the model's 44100 (resampling is
 *                                             the caller's job, as in the HF
 *                                             reference), channelCount 1|2.
 *   {type:'audio', id, offset, channels}    — deliver planar Float32Array
 *                                             audio for [offset, offset+len).
 *                                             Any order, any slicing; overlap
 *                                             is permitted (a re-delivered
 *                                             range overwrites). The host
 *                                             tracks COVERAGE — the union of
 *                                             delivered ranges — never a bare
 *                                             sample count.
 *   {type:'run', id}                        — refused unless coverage is
 *                                             exactly [0, totalSamples); then
 *                                             runs the segment loop.
 *   {type:'cancel', id}                     — abort. Takes effect between
 *                                             segments (inference on a segment
 *                                             is not interruptible; the
 *                                             manager's hard cancel is
 *                                             child.kill(), ruling 7).
 *   {type:'shutdown'}                       — release the session, exit 0.
 *
 * Host → parent:
 *   {type:'ready'}                                       — init done.
 *   {type:'progress', id, segment, totalSegments}        — after each segment.
 *   {type:'stems', id, offset, samples, data}            — a finalized region:
 *       data is planar Float32Array, stem-major/channel-minor
 *       (block s*2+c has length `samples`; stems ordered drums, bass, other,
 *       vocals — the model's own order). Regions are contiguous and tile
 *       [0, totalSamples) exactly; they are the weight-normalised overlap-add
 *       output, NOT raw per-segment model output.
 *   {type:'done', id, totalSegments}                     — job complete.
 *   {type:'cancelled', id}                               — cancel honoured.
 *   {type:'error', stage:'init'|'protocol'|'run', message, id?}
 *
 * Every incoming message is validated at this boundary (the host must
 * survive ANY malformed message — reply with a protocol error, never throw,
 * never crash the process), matching the app's trust-boundary discipline
 * (electron/ipc.cjs dialog-opts validation).
 *
 * The host runs ONE job per process lifetime by design: the manager spawns a
 * fresh child per separation and kills it on every terminal branch, so the
 * ~5 GB of ORT arena memory is returned to the OS at the end of each run
 * rather than lingering for the session.
 */

const {
  MODEL_SAMPLE_RATE,
  SEGMENT_SAMPLES,
  STEM_COUNT,
  MODEL_CHANNELS,
  makeWindow,
  planSegments,
  createAccumulator,
  accumulateSegment,
  finalizedEnd,
  extractFinalized,
} = require('./stemSegmentation.cjs');

/** Trust-boundary cap on job length: 30 minutes at the model rate.
 * Arithmetic (fix round 1, LOW): per input sample this process holds
 * 8 stem-accumulator floats (32 B) + 1 weight float (4 B) + up to 2 input
 * floats (8 B) = 44 B, so 30 min = 44100·1800 ≈ 79.4 M samples ≈ 3.5 GB of
 * buffers, on top of ORT's measured ~5 GB inference arena ≈ 8.5 GB worst
 * case — the most a 16–32 GB machine can genuinely tolerate alongside the
 * app and the OS. (1 hour would be ≈ 12 GB and start paging.) The plan's
 * no-600 s-cap rule is about covering whole real TRACKS, which sit far
 * below 30 minutes; anything above this is a malformed/hostile request. */
const MAX_TOTAL_SAMPLES = MODEL_SAMPLE_RATE * 1800;

// Brand check, not instanceof: a Float32Array that crossed a realm boundary
// (structured clone over the MessagePort) must still validate.
function isFloat32Array(value) {
  return Object.prototype.toString.call(value) === '[object Float32Array]';
}

function isFloat32ArrayOfLength(value, length) {
  return isFloat32Array(value) && value.length === length;
}

/**
 * Creates the host core. Dependency-injected so unit tests drive the real
 * message loop with a fake ORT and the utilityProcess bootstrap below wires
 * the real ones:
 *   ort         — onnxruntime-node module (Tensor, InferenceSession).
 *   postMessage — reply channel (process.parentPort.postMessage in the child).
 *   exit        — process termination (process.exit in the child).
 */
function createStemHost({ ort, postMessage, exit }) {
  let session = null;
  let job = null; // { id, channelCount, totalSamples, channels, received, running, cancelled }

  function post(msg) {
    postMessage(msg);
  }

  function protocolError(message, id) {
    post({ type: 'error', stage: 'protocol', message, ...(id !== undefined ? { id } : {}) });
  }

  async function handleInit(msg) {
    if (typeof msg.modelPath !== 'string' || msg.modelPath.length === 0) {
      protocolError('init: modelPath must be a non-empty string');
      return;
    }
    if (session) {
      protocolError('init: session already created');
      return;
    }
    try {
      // Ruling 2: CPU EP only. graphOptimizationLevel mirrors the reference
      // (ort.GraphOptimizationLevel.ORT_ENABLE_ALL / 'all').
      session = await ort.InferenceSession.create(msg.modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });
      post({ type: 'ready' });
    } catch (err) {
      post({ type: 'error', stage: 'init', message: err instanceof Error ? err.message : String(err) });
    }
  }

  function handleSeparate(msg) {
    if (!session) {
      protocolError('separate: not initialised (send init first)');
      return;
    }
    if (job) {
      protocolError('separate: a job is already active (single-job host)', msg.id);
      return;
    }
    if (!Number.isInteger(msg.id)) {
      protocolError('separate: id must be an integer');
      return;
    }
    if (msg.sampleRate !== MODEL_SAMPLE_RATE) {
      protocolError(
        `separate: sampleRate must be ${MODEL_SAMPLE_RATE} (resample before sending), got ${msg.sampleRate}`,
        msg.id
      );
      return;
    }
    if (msg.channelCount !== 1 && msg.channelCount !== 2) {
      protocolError(`separate: channelCount must be 1 or 2, got ${msg.channelCount}`, msg.id);
      return;
    }
    if (
      !Number.isInteger(msg.totalSamples) ||
      msg.totalSamples <= 0 ||
      msg.totalSamples > MAX_TOTAL_SAMPLES
    ) {
      protocolError(
        `separate: totalSamples must be an integer in [1, ${MAX_TOTAL_SAMPLES}] — audio longer than 30 minutes at ${MODEL_SAMPLE_RATE} Hz cannot be separated in one job — got ${msg.totalSamples}`,
        msg.id
      );
      return;
    }
    const channels = [];
    for (let c = 0; c < msg.channelCount; c++) channels.push(new Float32Array(msg.totalSamples));
    job = {
      id: msg.id,
      channelCount: msg.channelCount,
      totalSamples: msg.totalSamples,
      channels,
      /** Sorted, disjoint [start, end) ranges actually delivered — the
       * completeness gate checks COVERAGE, never a sample count (fix round
       * 1, MED-1: duplicate delivery of the same range must not stand in
       * for the undelivered rest of the track). */
      covered: [],
      running: false,
      cancelled: false,
    };
  }

  /** Inserts [start, end) into the sorted disjoint interval list, merging
   * neighbours/overlaps. The manager sends ordered contiguous slices, so
   * the list stays at one element in practice. */
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
    if (!Array.isArray(msg.channels) || msg.channels.length !== job.channelCount) {
      protocolError(`audio: expected ${job.channelCount} channel array(s)`, job.id);
      return;
    }
    const len = isFloat32Array(msg.channels[0]) ? msg.channels[0].length : -1;
    if (len <= 0 || !msg.channels.every((ch) => isFloat32ArrayOfLength(ch, len))) {
      protocolError('audio: channels must be equal-length non-empty Float32Arrays', job.id);
      return;
    }
    if (!Number.isInteger(msg.offset) || msg.offset < 0 || msg.offset + len > job.totalSamples) {
      protocolError(
        `audio: range [${msg.offset}, ${msg.offset + len}) outside job length ${job.totalSamples}`,
        job.id
      );
      return;
    }
    for (let c = 0; c < job.channelCount; c++) job.channels[c].set(msg.channels[c], msg.offset);
    addCoverage(job.covered, msg.offset, msg.offset + len);
  }

  /** Builds the (1, 2, SEGMENT_SAMPLES) model input for one segment:
   * zero-padded (reference: np.pad constant), mono repeated into both
   * channels (reference: np.repeat). */
  function buildSegmentInput(seg) {
    const data = new Float32Array(MODEL_CHANNELS * SEGMENT_SAMPLES);
    const clen = seg.end - seg.start;
    const left = job.channels[0];
    const right = job.channelCount === 2 ? job.channels[1] : job.channels[0];
    data.set(left.subarray(seg.start, seg.start + clen), 0);
    data.set(right.subarray(seg.start, seg.start + clen), SEGMENT_SAMPLES);
    return new ort.Tensor('float32', data, [1, MODEL_CHANNELS, SEGMENT_SAMPLES]);
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
      const firstGap = job.covered.length === 0 || job.covered[0][0] > 0 ? 0 : job.covered[0][1];
      protocolError(
        `run: audio coverage incomplete — only ${delivered} of ${job.totalSamples} samples delivered (first missing sample at ${firstGap}); duplicated ranges do not count`,
        job.id
      );
      return;
    }
    job.running = true;
    const thisJob = job;
    const plan = planSegments(thisJob.totalSamples);
    const window = makeWindow();
    const acc = createAccumulator(thisJob.totalSamples);
    try {
      for (let i = 0; i < plan.length; i++) {
        if (thisJob.cancelled) {
          job = null;
          post({ type: 'cancelled', id: thisJob.id });
          return;
        }
        const feeds = { mix: buildSegmentInput(plan[i]) };
        const results = await session.run(feeds);
        // Cancel may have landed while inference was in flight — honour it
        // before doing any more work on a result nobody wants.
        if (thisJob.cancelled) {
          job = null;
          post({ type: 'cancelled', id: thisJob.id });
          return;
        }
        const stems = results.stems;
        const expected = STEM_COUNT * MODEL_CHANNELS * SEGMENT_SAMPLES;
        if (!stems || !stems.data || stems.data.length !== expected) {
          throw new Error(
            `model returned unexpected output shape (wanted ${expected} values, got ${stems && stems.data ? stems.data.length : 'none'})`
          );
        }
        accumulateSegment(acc, plan[i], stems.data, window);
        const flushed = extractFinalized(acc, finalizedEnd(plan, i, thisJob.totalSamples));
        if (flushed) {
          post({
            type: 'stems',
            id: thisJob.id,
            offset: flushed.offset,
            samples: flushed.samples,
            data: flushed.data,
          });
        }
        post({ type: 'progress', id: thisJob.id, segment: i + 1, totalSegments: plan.length });
      }
      job = null;
      post({ type: 'done', id: thisJob.id, totalSegments: plan.length });
    } catch (err) {
      job = null;
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
      // Nothing to cancel is not an error worth crashing a run over; reply
      // cancelled so the parent's state machine can settle either way.
      post({ type: 'cancelled', id: msg && msg.id });
      return;
    }
    if (job.running) {
      job.cancelled = true; // honoured between segments by the run loop
    } else {
      const id = job.id;
      job = null; // job never started — drop it immediately
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
        case 'separate':
          handleSeparate(msg);
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
      // Absolute backstop: nothing may escape the message loop.
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
// utilityProcess bootstrap — only runs inside a real Electron utility process
// (process.parentPort exists there and nowhere else). Under Jest / plain node
// this module only exports the factory.
// ---------------------------------------------------------------------------
if (process.parentPort) {
  const host = createStemHost({
    // The one and only place in the app that loads onnxruntime (ruling 2).
    ort: require('onnxruntime-node'),
    postMessage: (msg) => process.parentPort.postMessage(msg),
    exit: (code) => process.exit(code),
  });
  process.parentPort.on('message', (e) => {
    void host.handleMessage(e.data);
  });
}

module.exports = { createStemHost, MAX_TOTAL_SAMPLES };
