'use strict';

/**
 * Transcription inference host (F4) — the entry module for the Electron
 * `utilityProcess` that owns onnxruntime-node for Whisper + the CAM++
 * speaker-embedding model. Shape, discipline and lifetime mirror
 * stemHost.cjs (v1.7), the proven pattern: CPU EP only, one job per process
 * lifetime, every message validated at this boundary, the manager kills the
 * child on every terminal branch so cancel is instantaneous and the ORT
 * arena is returned to the OS after each run.
 *
 * ## Message protocol (manager side: transcribeManager.cjs)
 *
 * Parent → host:
 *   {type:'init', paths:{encoder, decoder, embedder, tokenizer,
 *                        generationConfig, modelConfig}}
 *       — create the three ORT sessions (CPU EP) and parse the two pinned
 *         JSON files. The manager sha256-verifies EVERY file before sending
 *         this; the host trusts the paths but nothing else.
 *   {type:'transcribe', id, sampleRate, totalSamples, language}
 *       — open a job. sampleRate must be 16000 (the renderer resamples with
 *         the app's windowed-sinc, exactly as stems resample to 44100);
 *         audio is MONO. language: 'auto' or a code the tokenizer knows.
 *   {type:'audio', id, offset, samples}   — Float32Array delivery; coverage
 *                                           tracked as ranges (stemHost).
 *   {type:'run', id}                      — refused unless coverage is
 *                                           exactly [0, totalSamples).
 *   {type:'cancel', id}                   — honoured between decode steps
 *                                           and between segments; the
 *                                           manager's hard cancel is
 *                                           child.kill().
 *   {type:'shutdown'}                     — release sessions, exit 0.
 *
 * Host → parent:
 *   {type:'ready'}
 *   {type:'language', id, language, probability}
 *   {type:'progress', id, stage:'transcribe'|'embed', done, total}
 *       — stage 'transcribe': done/total are SAMPLES (seek position);
 *         stage 'embed': done/total are segments embedded.
 *   {type:'segment', id, index, startSample, endSample, text, avgLogprob,
 *         noSpeechProb, compressionRatio}
 *       — segments stream in index order as each 30 s window finishes.
 *   {type:'embedding', id, segmentIndex, vector}
 *       — L2-normalised Float32Array speaker embedding for segments long
 *         enough to embed (>= MIN_EMBED_SAMPLES; shorter segments get none
 *         and the renderer labels them from their neighbours or 'unknown').
 *   {type:'done', id, segmentCount}
 *   {type:'cancelled', id}
 *   {type:'error', stage:'init'|'protocol'|'run', message, id?}
 *
 * ## Decode configuration — measured or cited, never invented
 *
 *   - Greedy decoding, temperature 0, no beam (the F4 spike measured the
 *     KV-cached greedy loop at 6 ms/token for tiny; whisperDecode.test.cjs
 *     pins cached === uncached).
 *   - sampleLen 224 = max_length/2 — openai/whisper DecodingOptions
 *     (`sample_len or self.n_ctx // 2`).
 *   - NO_SPEECH_THRESHOLD 0.6, LOGPROB_THRESHOLD −1.0 — openai/whisper
 *     transcribe() defaults; a window is skipped as silence only when BOTH
 *     say so (their rule verbatim). The no-speech probability is read at the
 *     SOT POSITION of the uncached pass (openai `probs_at_sot`), which is
 *     why the decoder runner returns every row rather than only the last —
 *     `<|nospeech|>` carries no mass after `<|transcribe|>`, so reading the
 *     last row makes the rule dead code.
 *   - suppress lists, max_initial_timestamp_index — parsed from the model's
 *     own sha256-pinned generation_config.json.
 *   - MIN_EMBED_SAMPLES 0.5 s — the reference diarizer's own floor (the
 *     stt reference's diarization.py refuses to embed segments under
 *     0.5 s); at that floor the CAM++ fbank still yields ~47 frames of
 *     evidence, below which an embedding is more noise than voice.
 */

const {
  WHISPER_SAMPLE_RATE,
  WHISPER_CHUNK_SAMPLES,
  WHISPER_FRAMES_PER_CHUNK,
  WHISPER_N_MELS,
  WHISPER_SAMPLES_PER_TOKEN,
  whisperLogMel,
  createWhisperMelState,
  kaldiFbank,
  createFbankState,
  FBANK_BINS,
} = require('./whisperFeatures.cjs');
const {
  createTokenizer,
  greedyDecodeWindow,
  extractSegments,
  compressionRatio,
  logSoftmax,
} = require('./whisperDecode.cjs');

/** Trust-boundary cap on job length: 2 hours at 16 kHz. Arithmetic: the host
 * holds the mono job buffer (4 B/sample -> 461 MB at 2 h) plus ORT's
 * per-window arena (bounded by the 30 s window, measured ~0.7 GB for base),
 * so the worst case stays ~1.2 GB regardless of length; the renderer holds
 * the document plus one 16 kHz mono copy. 2 hours covers any realistic
 * audition/interview recording; anything above is a malformed request. */
const MAX_TOTAL_SAMPLES = WHISPER_SAMPLE_RATE * 7200;

/** openai/whisper transcribe() defaults — cited, not tuned here. */
const NO_SPEECH_THRESHOLD = 0.6;
const LOGPROB_THRESHOLD = -1.0;
/** openai/whisper DecodingTask: sample_len = n_ctx // 2 (448 // 2). */
const SAMPLE_LEN = 224;
/** Reference diarizer's 0.5 s floor (see module header). */
const MIN_EMBED_SAMPLES = WHISPER_SAMPLE_RATE / 2;

function isFloat32Array(value) {
  return Object.prototype.toString.call(value) === '[object Float32Array]';
}

/** The cancel signal used to unwind an in-flight decode loop. */
class CancelledError extends Error {}

/**
 * Builds a per-window `runDecoder` callback (whisperDecode.cjs contract)
 * over a REAL merged-decoder ORT session — the ONLY place the two branches
 * and KV-cache tensors are choreographed. Module-level so the integration
 * bench and the opt-in real-model test drive the exact production
 * choreography rather than a re-implementation.
 *
 * `dims` — {decoderLayers, decoderHeads, headDim} from the model's own
 * config.json. `shouldCancel` — optional; a truthy return unwinds the decode
 * loop with CancelledError.
 */
function createOrtDecoderRunner({ ort, session, encoderHidden, dims, shouldCancel }) {
  const { decoderLayers, decoderHeads, headDim } = dims;
  const emptyPast = new ort.Tensor('float32', new Float32Array(0), [1, decoderHeads, 0, headDim]);
  let decoderPasts = null; // present.<L>.decoder.* from the last step
  let encoderPasts = null; // present.<L>.encoder.* from the FIRST step
  const useCacheTrue = new ort.Tensor('bool', new Uint8Array([1]), [1]);
  const useCacheFalse = new ort.Tensor('bool', new Uint8Array([0]), [1]);
  return async ({ tokens, useCache }) => {
    if (shouldCancel && shouldCancel()) throw new CancelledError('cancelled');
    const feeds = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(tokens.map((t) => BigInt(t))), [1, tokens.length]),
      encoder_hidden_states: encoderHidden,
      use_cache_branch: useCache ? useCacheTrue : useCacheFalse,
    };
    for (let l = 0; l < decoderLayers; l++) {
      feeds[`past_key_values.${l}.decoder.key`] = useCache ? decoderPasts[`${l}.key`] : emptyPast;
      feeds[`past_key_values.${l}.decoder.value`] = useCache ? decoderPasts[`${l}.value`] : emptyPast;
      feeds[`past_key_values.${l}.encoder.key`] = useCache ? encoderPasts[`${l}.key`] : emptyPast;
      feeds[`past_key_values.${l}.encoder.value`] = useCache ? encoderPasts[`${l}.value`] : emptyPast;
    }
    const out = await session.run(feeds);
    const nextDecoder = {};
    for (let l = 0; l < decoderLayers; l++) {
      nextDecoder[`${l}.key`] = out[`present.${l}.decoder.key`];
      nextDecoder[`${l}.value`] = out[`present.${l}.decoder.value`];
    }
    decoderPasts = nextDecoder;
    if (!useCache) {
      // Cross-attention KV is constant per window: captured once here,
      // reused for every cached step (optimum's own modeling behaviour).
      encoderPasts = {};
      for (let l = 0; l < decoderLayers; l++) {
        encoderPasts[`${l}.key`] = out[`present.${l}.encoder.key`];
        encoderPasts[`${l}.value`] = out[`present.${l}.encoder.value`];
      }
    }
    // EVERY position's logits, copied out of the ORT-owned buffer (which the
    // next `session.run` may reuse). The uncached pass returns one row per
    // prompt token and the decode loop reads TWO of them: the last, for
    // sampling, and the SOT row, for `<|nospeech|>` (openai's `probs_at_sot`).
    // Returning only the last row — as this did — makes the no-speech
    // probability ~0 for every window, so the silence rule can never fire.
    return Float32Array.from(out.logits.data);
  };
}

/**
 * Runs the speaker-embedding model over 16 kHz mono samples: Kaldi fbank →
 * CAM++ → L2-normalised Float32Array (or null when the clip is too short
 * for a single fbank frame). Module-level for the same bench-reuse reason.
 */
async function computeEmbedding({ ort, session, samples, fbankState }) {
  const { frames, data } = kaldiFbank(samples, fbankState);
  if (frames === 0) return null;
  const feats = new ort.Tensor('float32', data, [1, frames, FBANK_BINS]);
  const feeds = {};
  feeds[session.inputNames[0]] = feats;
  const out = await session.run(feeds);
  const emb = out[session.outputNames[0]].data;
  let norm = 0;
  for (let k = 0; k < emb.length; k++) norm += emb[k] * emb[k];
  norm = Math.sqrt(norm);
  const vector = new Float32Array(emb.length);
  if (norm > 0) for (let k = 0; k < emb.length; k++) vector[k] = emb[k] / norm;
  return vector;
}

/**
 * Creates the host core. Dependency-injected exactly like createStemHost:
 *   ort         — onnxruntime-node module (Tensor, InferenceSession)
 *   postMessage — reply channel
 *   exit        — process termination
 *   fsImpl      — fs module (tokenizer/config parsing; injectable in tests)
 */
function createTranscribeHost({ ort, postMessage, exit, fsImpl = require('node:fs') }) {
  let sessions = null; // { encoder, decoder, embedder }
  let tokenizer = null;
  let decodeCfg = null; // suppress lists etc. from generation_config.json
  let dims = null; // { decoderLayers, decoderHeads, headDim }
  let job = null;
  const melState = createWhisperMelState();
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
      ['encoder', 'decoder', 'embedder', 'tokenizer', 'generationConfig', 'modelConfig'].some(
        (k) => typeof p[k] !== 'string' || p[k].length === 0
      )
    ) {
      protocolError('init: paths must name encoder, decoder, embedder, tokenizer, generationConfig, modelConfig');
      return;
    }
    if (sessions) {
      protocolError('init: session already created');
      return;
    }
    try {
      const opts = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' };
      const [encoder, decoder, embedder] = await Promise.all([
        ort.InferenceSession.create(p.encoder, opts),
        ort.InferenceSession.create(p.decoder, opts),
        ort.InferenceSession.create(p.embedder, opts),
      ]);
      tokenizer = createTokenizer(JSON.parse(fsImpl.readFileSync(p.tokenizer, 'utf8')));
      const genCfg = JSON.parse(fsImpl.readFileSync(p.generationConfig, 'utf8'));
      const modelCfg = JSON.parse(fsImpl.readFileSync(p.modelConfig, 'utf8'));
      const layers = modelCfg.decoder_layers;
      const heads = modelCfg.decoder_attention_heads;
      const dModel = modelCfg.d_model;
      if (!Number.isInteger(layers) || !Number.isInteger(heads) || !Number.isInteger(dModel) || dModel % heads !== 0) {
        throw new Error('modelConfig lacks decoder_layers / decoder_attention_heads / d_model');
      }
      dims = { decoderLayers: layers, decoderHeads: heads, headDim: dModel / heads };
      decodeCfg = {
        timestampBegin: tokenizer.timestampBegin,
        eot: tokenizer.eot,
        noTimestamps: tokenizer.noTimestamps,
        noSpeech: tokenizer.noSpeech,
        // Locates the row `noSpeech` is read from (openai `sot_index`).
        sot: tokenizer.sot,
        maxInitialTimestampIndex: Number.isInteger(genCfg.max_initial_timestamp_index)
          ? genCfg.max_initial_timestamp_index
          : 50,
        suppressTokens: Array.isArray(genCfg.suppress_tokens) ? genCfg.suppress_tokens : [],
        beginSuppressTokens: Array.isArray(genCfg.begin_suppress_tokens) ? genCfg.begin_suppress_tokens : [],
        maxNewTokens: SAMPLE_LEN,
      };
      sessions = { encoder, decoder, embedder };
      post({ type: 'ready' });
    } catch (err) {
      post({ type: 'error', stage: 'init', message: err instanceof Error ? err.message : String(err) });
    }
  }

  function handleTranscribe(msg) {
    if (!sessions) {
      protocolError('transcribe: not initialised (send init first)');
      return;
    }
    if (job) {
      protocolError('transcribe: a job is already active (single-job host)', msg.id);
      return;
    }
    if (!Number.isInteger(msg.id)) {
      protocolError('transcribe: id must be an integer');
      return;
    }
    if (msg.sampleRate !== WHISPER_SAMPLE_RATE) {
      protocolError(
        `transcribe: sampleRate must be ${WHISPER_SAMPLE_RATE} (resample before sending), got ${msg.sampleRate}`,
        msg.id
      );
      return;
    }
    if (!Number.isInteger(msg.totalSamples) || msg.totalSamples <= 0 || msg.totalSamples > MAX_TOTAL_SAMPLES) {
      protocolError(
        `transcribe: totalSamples must be an integer in [1, ${MAX_TOTAL_SAMPLES}] — audio longer than 2 hours at ${WHISPER_SAMPLE_RATE} Hz cannot be transcribed in one job — got ${msg.totalSamples}`,
        msg.id
      );
      return;
    }
    const language = msg.language;
    if (language !== 'auto' && !(typeof language === 'string' && tokenizer.langIds.has(language))) {
      protocolError(`transcribe: language must be 'auto' or a supported code, got ${String(language)}`, msg.id);
      return;
    }
    job = {
      id: msg.id,
      totalSamples: msg.totalSamples,
      samples: new Float32Array(msg.totalSamples),
      language,
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
   * Runs the encoder over one zero-padded 30 s window starting at `seek`.
   * Returns the `last_hidden_state` tensor, reused across all decode steps
   * of the window.
   */
  async function encodeWindow(thisJob, seek) {
    const windowSamples = new Float32Array(WHISPER_CHUNK_SAMPLES);
    const content = Math.min(WHISPER_CHUNK_SAMPLES, thisJob.totalSamples - seek);
    windowSamples.set(thisJob.samples.subarray(seek, seek + content));
    const mel = whisperLogMel(windowSamples, melState);
    const input = new ort.Tensor('float32', mel, [1, WHISPER_N_MELS, WHISPER_FRAMES_PER_CHUNK]);
    const feeds = {};
    feeds[sessions.encoder.inputNames[0]] = input;
    const out = await sessions.encoder.run(feeds);
    return { hidden: out[sessions.encoder.outputNames[0]], contentSamples: content };
  }

  /** Per-window runDecoder over the real decoder session (module-level
   * choreography above; cancel unwinds via CancelledError). */
  function createDecoderRunner(thisJob, encoderHidden) {
    return createOrtDecoderRunner({
      ort,
      session: sessions.decoder,
      encoderHidden,
      dims,
      shouldCancel: () => thisJob.cancelled,
    });
  }

  /** Whisper language detection (openai decoding.detect_language): one
   * uncached decoder step over [sot], softmax restricted to language
   * tokens. */
  async function detectLanguage(thisJob, encoderHidden) {
    const run = createDecoderRunner(thisJob, encoderHidden);
    // ONE token in, so the returned grid is exactly one row and the SOT row
    // and the last row are the same thing — openai's `detect_language` reads
    // that single position too (`logits[:, 0]` over `[sot]`).
    const logits = await run({ tokens: [tokenizer.sot], useCache: false });
    const entries = [...tokenizer.langIds.entries()];
    const lp = logSoftmax(logits);
    let best = entries[0];
    let bestLp = -Infinity;
    let mass = 0;
    for (const [code, id] of entries) {
      if (lp[id] > bestLp) {
        bestLp = lp[id];
        best = [code, id];
      }
    }
    for (const [, id] of entries) mass += Math.exp(lp[id]);
    return { language: best[0], probability: mass > 0 ? Math.exp(bestLp) / mass : 0 };
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
      const segments = [];
      let language = thisJob.language;
      let seek = 0;
      let firstWindow = await encodeWindow(thisJob, 0);
      if (language === 'auto') {
        if (tokenizer.langIds.size === 0) {
          language = 'en'; // an English-only vocab has no language tokens
        } else {
          const det = await detectLanguage(thisJob, firstWindow.hidden);
          language = det.language;
          post({ type: 'language', id: thisJob.id, language, probability: det.probability });
        }
      }
      const langId = tokenizer.langIds.get(language);
      const prompt =
        langId !== undefined ? [tokenizer.sot, langId, tokenizer.transcribe] : [tokenizer.sot];

      while (seek < thisJob.totalSamples) {
        checkCancelled(thisJob);
        const { hidden, contentSamples } = firstWindow || (await encodeWindow(thisJob, seek));
        firstWindow = null;
        const runDecoder = createDecoderRunner(thisJob, hidden);
        const { tokens, avgLogprob, noSpeechProb } = await greedyDecodeWindow(runDecoder, prompt, decodeCfg);
        const windowUnits = Math.ceil(contentSamples / WHISPER_SAMPLES_PER_TOKEN);
        // openai's silence rule: skip the window only when BOTH thresholds
        // agree (no_speech alone is not trusted when the decoder was
        // confident about its text).
        const skipAsSilence = noSpeechProb > NO_SPEECH_THRESHOLD && avgLogprob < LOGPROB_THRESHOLD;
        let advanceUnits = windowUnits;
        if (!skipAsSilence) {
          const extracted = extractSegments(tokens, decodeCfg, windowUnits);
          advanceUnits = Math.max(1, extracted.seekAdvanceUnits);
          for (const seg of extracted.segments) {
            const text = tokenizer.decode(seg.tokens).trim();
            if (text.length === 0) continue;
            const startSample = Math.min(seek + seg.startUnits * WHISPER_SAMPLES_PER_TOKEN, thisJob.totalSamples);
            const endSample = Math.min(seek + seg.endUnits * WHISPER_SAMPLES_PER_TOKEN, thisJob.totalSamples);
            if (endSample <= startSample) continue;
            const segment = {
              index: segments.length,
              startSample,
              endSample,
              text,
              avgLogprob,
              noSpeechProb,
              compressionRatio: compressionRatio(text),
            };
            segments.push(segment);
            post({ type: 'segment', id: thisJob.id, ...segment });
          }
        }
        seek += advanceUnits * WHISPER_SAMPLES_PER_TOKEN;
        post({
          type: 'progress',
          id: thisJob.id,
          stage: 'transcribe',
          done: Math.min(seek, thisJob.totalSamples),
          total: thisJob.totalSamples,
        });
      }

      // Speaker-embedding pass over the finished segments.
      const embeddable = segments.filter((s) => s.endSample - s.startSample >= MIN_EMBED_SAMPLES);
      for (let i = 0; i < embeddable.length; i++) {
        checkCancelled(thisJob);
        const seg = embeddable[i];
        const vector = await computeEmbedding({
          ort,
          session: sessions.embedder,
          samples: thisJob.samples.subarray(seg.startSample, seg.endSample),
          fbankState,
        });
        if (vector) post({ type: 'embedding', id: thisJob.id, segmentIndex: seg.index, vector });
        post({ type: 'progress', id: thisJob.id, stage: 'embed', done: i + 1, total: embeddable.length });
      }

      job = null;
      post({ type: 'done', id: thisJob.id, segmentCount: segments.length });
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
      job.cancelled = true; // honoured between decode steps by checkCancelled
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
        case 'transcribe':
          handleTranscribe(msg);
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
  const host = createTranscribeHost({
    ort: require('onnxruntime-node'),
    postMessage: (msg) => process.parentPort.postMessage(msg),
    exit: (code) => process.exit(code),
  });
  process.parentPort.on('message', (e) => {
    void host.handleMessage(e.data);
  });
}

module.exports = {
  createTranscribeHost,
  createOrtDecoderRunner,
  computeEmbedding,
  CancelledError,
  MAX_TOTAL_SAMPLES,
  NO_SPEECH_THRESHOLD,
  LOGPROB_THRESHOLD,
  SAMPLE_LEN,
  MIN_EMBED_SAMPLES,
};
