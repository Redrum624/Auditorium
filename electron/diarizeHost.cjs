'use strict';

/**
 * Speaker-diarization inference host (Separate Speakers, D1/D2) — the entry
 * module for the Electron `utilityProcess` that owns onnxruntime-node for
 * pyannote-segmentation-3.0 + the WeSpeaker ResNet34-LM embedder. Shape,
 * discipline and lifetime mirror transcribeHost.cjs (v1.16) and stemHost.cjs
 * (v1.7), the proven pattern: CPU EP only (the spike timed these options;
 * DirectML is excluded from the build), one job per process lifetime, every
 * message validated at this boundary, the manager kills the child on every
 * terminal branch so Cancel is instantaneous and the ORT arena is returned to
 * the OS after each run.
 *
 * ## What this host does (D1, stage 2 of three)
 *
 * The renderer has already run HT-Demucs and resampled the Vocals stem to
 * 16 kHz mono. This host (1) segments it: 10 s windows (160,000 samples)
 * shifted by 1 s (16,000), the model's 7-class powerset argmax per frame
 * (589 frames per window) → up to 3 local speakers per window; (2) embeds
 * each (window, local speaker) with ≥ 10 active frames over that speaker's
 * CONCATENATED active audio. Clustering and assembly happen in the renderer
 * (D3). The recipe is sherpa-onnx's `speaker-diarization-onnx.py` verbatim,
 * INCLUDING its tail rule — a run that reaches the window's last frame ends
 * at frame F−1 — and including overlap frames in the embedded audio (the
 * sweep's recommended row is the overlap-inclusive set, not its P5 variant).
 * These are the fragments the sweep measured; re-deriving them would make
 * the measured threshold (D3, 0.55) apply to different evidence.
 *
 * ## Message protocol (manager side: diarizeManager.cjs)
 *
 * Parent → host:
 *   {type:'init', paths:{segmentation, embedder}}
 *       — create the two ORT sessions (CPU EP, graph optimisation 'all').
 *         The manager sha256-verifies BOTH files before sending this; the
 *         host trusts the paths but nothing else.
 *   {type:'diarize', id, sampleRate, totalSamples}
 *       — open a job. sampleRate must be 16000; audio is MONO.
 *   {type:'audio', id, offset, samples}   — Float32Array delivery in
 *                                           1<<20-sample slices; coverage
 *                                           tracked as ranges (stemHost).
 *   {type:'run', id}                      — refused unless coverage is
 *                                           exactly [0, totalSamples).
 *   {type:'cancel', id}                   — honoured between segmentation
 *                                           batches and between embeddings;
 *                                           the manager's hard cancel is
 *                                           child.kill().
 *   {type:'shutdown'}                     — release sessions, exit 0.
 *
 * Host → parent:
 *   {type:'ready'}
 *   {type:'progress', id, stage:'segment'|'embed', done, total}
 *       — 'segment': windows done / windows total (advances per batch);
 *         'embed': fragments embedded / fragments to embed.
 *   {type:'window', id, index, labels: Uint8Array(589)}
 *       — one per window, in index order; each byte is the argmax CLASS
 *         (0..6) of that frame, decoded with POWERSET by the renderer.
 *   {type:'embedding', id, windowIndex, localSpeaker, activeFrames,
 *         vector: Float32Array(256)}
 *       — L2-normalised; only for (window, speaker) pairs with
 *         activeFrames >= MIN_EMBED_FRAMES.
 *   {type:'done', id, windowCount}
 *   {type:'cancelled', id}
 *   {type:'error', stage:'init'|'protocol'|'run', message, id?}
 *
 * ## Windowing and memory (D2)
 *
 * The job buffer is 4 B/sample: 460,800,000 B (461 MB) at the 2 h cap. The
 * windows are NOT materialised per window: each batch of up to SEG_BATCH
 * (32, the configuration the spike timed at 5.5–8.6 ms per audio second)
 * windows is copied as subarrays of the job buffer into ONE reusable
 * 32 × 160,000 float32 batch buffer — 20,480,000 B (20.5 MB) allocated once
 * per job — and the final partial window is zero-padded in its slot. The
 * per-window output is a 589-byte label array (≈ 4.2 MB for the 7,191
 * windows of a 2 h job). Fragments for embedding are rebuilt from the job
 * buffer via the reference's `sample_offset`, `i·16000 + trunc(k/589·160000)`,
 * into ONE 160,000-float32 scratch (640,000 B, ≤ 640 KB) — a fragment can
 * never exceed one window. Worst case therefore stays at the job buffer plus
 * ~21 MB plus ORT's own arena, regardless of length.
 *
 * ## Embedder front-end — CMN, a deliberate measured departure from sherpa
 *
 * kaldiFbank (the app's, torchaudio-compatible, int16 scale) → subtract each
 * of the 80 bins' mean over the fragment's frames (float64 accumulation,
 * float32 result) → ResNet34-LM `feats` [1, T, 80] → `embs` [1, 256] →
 * L2-normalise. sherpa-onnx does NOT apply CMN to these WeSpeaker models (its
 * C++ only does so for feature_normalize_type == global-mean); WeSpeaker's
 * own inference does (`feat - torch.mean(feat, dim=0)`). The sweep measured
 * the difference on the four test recordings: the recommended policy
 * recovers the speaker count on 4/4 files WITH the CMN and 1/4 WITHOUT it,
 * so the CMN stays and is pinned by the host test's fake embedder (every
 * bin's mean over frames must be 0 within 1e-5). Note this is the opposite
 * finding from CAM++ (whisperFeatures.cjs: CMN COLLAPSES that export) — the
 * two models were trained with different front-ends, and each host feeds
 * its own model what that model was measured to need.
 */

const { kaldiFbank, createFbankState, FBANK_BINS } = require('./whisperFeatures.cjs');

/** The model's own metadata (design-notes.md): sample_rate 16000,
 * window_size 160000, receptive_field_size 991, receptive_field_shift 270 →
 * 589 frames per window, num_speakers 3, powerset_max_classes 2 → 7 classes. */
const SAMPLE_RATE = 16000;
const SEG_WINDOW = 160000;
/** The reference's window_shift = 0.1 · window_size. */
const SEG_SHIFT = 16000;
const SEG_FRAMES = 589;
const RECEPTIVE_FIELD = 991;
const FRAME_SHIFT = 270;
const LOCAL_SPEAKERS = 3;
const NUM_CLASSES = 7;
/** Class → local speakers (pyannote's powerset order: none, s1, s2, s3,
 * s1+s2, s1+s3, s2+s3). Frozen: the renderer decodes labels with the same
 * table (D3). */
const POWERSET = Object.freeze([[], [0], [1], [2], [0, 1], [0, 2], [1, 2]].map((r) => Object.freeze(r)));
/** The reference embeds a local speaker only with >= 10 active frames. */
const MIN_EMBED_FRAMES = 10;
/** Batch of windows per segmentation run — the measured configuration. */
const SEG_BATCH = 32;
/** ResNet34-LM `embs` is [B, 256]. */
const EMBEDDING_DIM = 256;

/** Trust-boundary cap on job length: 2 hours at 16 kHz (the transcribe
 * host's envelope; see the memory arithmetic in the header). */
const MAX_TOTAL_SAMPLES = SAMPLE_RATE * 7200;

function isFloat32Array(value) {
  return Object.prototype.toString.call(value) === '[object Float32Array]';
}

/** The cancel signal used to unwind an in-flight run. */
class CancelledError extends Error {}

/**
 * The reference's window plan: `num_full = floor((len − W) / S) + 1` full
 * windows when len >= W, plus one zero-padded window when len < W or the
 * remainder is non-zero. A length whose `(len − W)` is a multiple of S has
 * no padded window.
 */
function planWindows(totalSamples) {
  const numFull = totalSamples >= SEG_WINDOW ? Math.floor((totalSamples - SEG_WINDOW) / SEG_SHIFT) + 1 : 0;
  const hasLast = totalSamples < SEG_WINDOW || (totalSamples - SEG_WINDOW) % SEG_SHIFT > 0;
  return { count: numFull + (hasLast ? 1 : 0), hasLast };
}

/** The reference's `sample_offset`: frame k of a window → window sample. */
function frameToSample(k) {
  return Math.trunc((k / SEG_FRAMES) * SEG_WINDOW);
}

/**
 * Rebuilds the concatenated active audio of local speaker `speaker` in window
 * `windowIndex` FROM THE JOB BUFFER (D2 — no retained per-window chunk),
 * writing into `scratch` (Float32Array(SEG_WINDOW)). Runs of active frames
 * map through `frameToSample`; a run that reaches the last frame closes at
 * F−1 (the reference's `copyRun(start, k − 1)` after the loop — kept
 * verbatim, it is what the sweep measured). Samples past the job's end (the
 * padded last window) are the zeros the reference's padded chunk held.
 *
 * Returns { activeFrames, samples } where `samples` is a subarray view of
 * `scratch` — consume it before the next call.
 */
function buildFragment(job, totalSamples, windowIndex, labels, speaker, scratch) {
  let activeFrames = 0;
  for (let f = 0; f < SEG_FRAMES; f++) if (POWERSET[labels[f]].includes(speaker)) activeFrames++;
  const base = windowIndex * SEG_SHIFT;
  let idx = 0;
  const copyRun = (s, e) => {
    const ss = frameToSample(s);
    const ee = frameToSample(e);
    const n = ee - ss;
    if (n <= 0) return;
    // Real samples up to the job's end, zeros beyond it (the padded tail).
    const avail = Math.max(0, Math.min(n, totalSamples - (base + ss)));
    if (avail > 0) scratch.set(job.subarray(base + ss, base + ss + avail), idx);
    if (avail < n) scratch.fill(0, idx + avail, idx + n);
    idx += n;
  };
  let start = -1;
  let k = 0;
  for (k = 0; k < SEG_FRAMES; k++) {
    if (POWERSET[labels[k]].includes(speaker)) {
      if (start < 0) start = k;
    } else if (start >= 0) {
      copyRun(start, k);
      start = -1;
    }
  }
  if (start >= 0) copyRun(start, k - 1);
  return { activeFrames, samples: scratch.subarray(0, idx) };
}

/**
 * Embedder front-end + model + normalisation over one fragment's 16 kHz mono
 * samples (see the header's CMN section). Returns an L2-normalised
 * Float32Array(EMBEDDING_DIM), or null when the fragment is too short for a
 * single fbank frame. Module-level so the bench drives the exact production
 * path (the transcribe-bench-driver pattern, D6).
 */
async function computeDiarizeEmbedding({ ort, session, samples, fbankState }) {
  const { frames, data } = kaldiFbank(samples, fbankState);
  if (frames === 0) return null;
  // Per-utterance cepstral mean normalisation: float64 accumulation so an
  // 80-bin mean over up to ~1000 frames does not pick up float32 drift,
  // float32 result because that is what the model takes.
  const mean = new Float64Array(FBANK_BINS);
  for (let t = 0; t < frames; t++) {
    const row = t * FBANK_BINS;
    for (let b = 0; b < FBANK_BINS; b++) mean[b] += data[row + b];
  }
  for (let b = 0; b < FBANK_BINS; b++) mean[b] /= frames;
  for (let t = 0; t < frames; t++) {
    const row = t * FBANK_BINS;
    for (let b = 0; b < FBANK_BINS; b++) data[row + b] -= mean[b];
  }
  const feats = new ort.Tensor('float32', data, [1, frames, FBANK_BINS]);
  const feeds = {};
  feeds[session.inputNames[0]] = feats;
  const out = await session.run(feeds);
  const emb = out[session.outputNames[0]].data;
  if (emb.length !== EMBEDDING_DIM) {
    throw new Error(`embedder returned ${emb.length} values, expected ${EMBEDDING_DIM} (wrong model file?)`);
  }
  let norm = 0;
  for (let k = 0; k < emb.length; k++) norm += emb[k] * emb[k];
  norm = Math.sqrt(norm);
  const vector = new Float32Array(EMBEDDING_DIM);
  if (norm > 0) for (let k = 0; k < emb.length; k++) vector[k] = emb[k] / norm;
  return vector;
}

/**
 * Creates the host core. Dependency-injected exactly like createTranscribeHost:
 *   ort         — onnxruntime-node module (Tensor, InferenceSession)
 *   postMessage — reply channel
 *   exit        — process termination
 */
function createDiarizeHost({ ort, postMessage, exit }) {
  let sessions = null; // { segmentation, embedder }
  let job = null;
  const fbankState = createFbankState();

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
      ['segmentation', 'embedder'].some((k) => typeof p[k] !== 'string' || p[k].length === 0)
    ) {
      protocolError('init: paths must name segmentation, embedder');
      return;
    }
    if (sessions) {
      protocolError('init: session already created');
      return;
    }
    try {
      // The options the spike timed (D2). DirectML is excluded from the build.
      const opts = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' };
      const [segmentation, embedder] = await Promise.all([
        ort.InferenceSession.create(p.segmentation, opts),
        ort.InferenceSession.create(p.embedder, opts),
      ]);
      sessions = { segmentation, embedder };
      post({ type: 'ready' });
    } catch (err) {
      post({ type: 'error', stage: 'init', message: err instanceof Error ? err.message : String(err) });
    }
  }

  function handleDiarize(msg) {
    if (!sessions) {
      protocolError('diarize: not initialised (send init first)');
      return;
    }
    if (job) {
      protocolError('diarize: a job is already active (single-job host)', msg.id);
      return;
    }
    if (!Number.isInteger(msg.id)) {
      protocolError('diarize: id must be an integer');
      return;
    }
    if (msg.sampleRate !== SAMPLE_RATE) {
      protocolError(`diarize: sampleRate must be ${SAMPLE_RATE} (resample before sending), got ${msg.sampleRate}`, msg.id);
      return;
    }
    if (!Number.isInteger(msg.totalSamples) || msg.totalSamples <= 0 || msg.totalSamples > MAX_TOTAL_SAMPLES) {
      protocolError(
        `diarize: totalSamples must be an integer in [1, ${MAX_TOTAL_SAMPLES}] — audio longer than 2 hours at ${SAMPLE_RATE} Hz cannot be diarized in one job — got ${msg.totalSamples}`,
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

  /** Same interval-merge coverage accounting as stemHost/transcribeHost. */
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

  function checkCancelled(thisJob) {
    if (thisJob.cancelled) throw new CancelledError('cancelled');
  }

  /**
   * Stage 'segment': every window through the segmentation model in batches
   * of SEG_BATCH over ONE reusable buffer; per-frame argmax → one
   * Uint8Array(589) of classes per window, posted as it is produced and kept
   * for the embedding pass. Returns the label arrays in window order.
   */
  async function segment(thisJob) {
    const { count } = planWindows(thisJob.totalSamples);
    const batchBuf = new Float32Array(SEG_BATCH * SEG_WINDOW);
    const session = sessions.segmentation;
    const allLabels = new Array(count);
    for (let b = 0; b < count; b += SEG_BATCH) {
      checkCancelled(thisJob);
      const n = Math.min(SEG_BATCH, count - b);
      for (let i = 0; i < n; i++) {
        const start = (b + i) * SEG_SHIFT;
        const end = Math.min(start + SEG_WINDOW, thisJob.totalSamples);
        const slot = i * SEG_WINDOW;
        batchBuf.set(thisJob.samples.subarray(start, end), slot);
        // Only the final window can be short; zero its tail (the slot may
        // hold a previous batch's samples).
        if (end - start < SEG_WINDOW) batchBuf.fill(0, slot + (end - start), slot + SEG_WINDOW);
      }
      const feeds = {};
      feeds[session.inputNames[0]] = new ort.Tensor('float32', batchBuf.subarray(0, n * SEG_WINDOW), [n, 1, SEG_WINDOW]);
      const out = await session.run(feeds);
      const y = out[session.outputNames[0]];
      const dims = y.dims;
      if (!dims || dims.length !== 3 || dims[0] !== n || dims[1] !== SEG_FRAMES || dims[2] !== NUM_CLASSES) {
        throw new Error(
          `segmentation output dims [${dims}] — expected [${n}, ${SEG_FRAMES}, ${NUM_CLASSES}] (wrong model file?)`
        );
      }
      const logits = y.data;
      for (let i = 0; i < n; i++) {
        const labels = new Uint8Array(SEG_FRAMES);
        const baseIdx = i * SEG_FRAMES * NUM_CLASSES;
        for (let f = 0; f < SEG_FRAMES; f++) {
          const row = baseIdx + f * NUM_CLASSES;
          let best = 0;
          let bestV = -Infinity;
          for (let c = 0; c < NUM_CLASSES; c++) {
            const v = logits[row + c];
            if (v > bestV) {
              bestV = v;
              best = c;
            }
          }
          labels[f] = best;
        }
        allLabels[b + i] = labels;
        post({ type: 'window', id: thisJob.id, index: b + i, labels });
      }
      post({ type: 'progress', id: thisJob.id, stage: 'segment', done: b + n, total: count });
    }
    return allLabels;
  }

  /**
   * Stage 'embed': each (window, local speaker) with >= MIN_EMBED_FRAMES
   * active frames, in window order then speaker order — the fragments the
   * sweep measured — through the embedder. Cancel is honoured between
   * fragments.
   */
  async function embed(thisJob, allLabels) {
    const scratch = new Float32Array(SEG_WINDOW);
    const pending = [];
    for (let i = 0; i < allLabels.length; i++) {
      const labels = allLabels[i];
      for (let j = 0; j < LOCAL_SPEAKERS; j++) {
        let active = 0;
        for (let f = 0; f < SEG_FRAMES; f++) if (POWERSET[labels[f]].includes(j)) active++;
        if (active >= MIN_EMBED_FRAMES) pending.push([i, j]);
      }
    }
    for (let k = 0; k < pending.length; k++) {
      checkCancelled(thisJob);
      const [i, j] = pending[k];
      const frag = buildFragment(thisJob.samples, thisJob.totalSamples, i, allLabels[i], j, scratch);
      const vector = await computeDiarizeEmbedding({
        ort,
        session: sessions.embedder,
        samples: frag.samples,
        fbankState,
      });
      if (vector) {
        post({
          type: 'embedding',
          id: thisJob.id,
          windowIndex: i,
          localSpeaker: j,
          activeFrames: frag.activeFrames,
          vector,
        });
      }
      post({ type: 'progress', id: thisJob.id, stage: 'embed', done: k + 1, total: pending.length });
    }
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
      const allLabels = await segment(thisJob);
      await embed(thisJob, allLabels);
      job = null;
      post({ type: 'done', id: thisJob.id, windowCount: allLabels.length });
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
      job.cancelled = true; // honoured between batches / embeddings by checkCancelled
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
        case 'diarize':
          handleDiarize(msg);
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
  const host = createDiarizeHost({
    ort: require('onnxruntime-node'),
    postMessage: (msg) => process.parentPort.postMessage(msg),
    exit: (code) => process.exit(code),
  });
  process.parentPort.on('message', (e) => {
    void host.handleMessage(e.data);
  });
}

module.exports = {
  createDiarizeHost,
  computeDiarizeEmbedding,
  buildFragment,
  planWindows,
  frameToSample,
  CancelledError,
  SAMPLE_RATE,
  MAX_TOTAL_SAMPLES,
  SEG_WINDOW,
  SEG_SHIFT,
  SEG_FRAMES,
  SEG_BATCH,
  RECEPTIVE_FIELD,
  FRAME_SHIFT,
  LOCAL_SPEAKERS,
  NUM_CLASSES,
  POWERSET,
  MIN_EMBED_FRAMES,
  EMBEDDING_DIM,
};
