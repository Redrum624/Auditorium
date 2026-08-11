'use strict';

/**
 * Main-process owner of transcription (F4): download/verification of the
 * model FILE SET and the lifetime of the inference utility process
 * (transcribeHost.cjs). This is stemManager.cjs's proven shape extended
 * from one pinned file to six — it deliberately REUSES that module's
 * exported `verifyModelFile` and `downloadModel` rather than reimplementing
 * the pin/retry/oversize/abort machinery.
 *
 * Ruling 1 in code form: nothing is bundled; every file is downloaded on
 * first use into `userData/models/transcription/`, sha256+size verified
 * BEFORE ANY LOAD (and re-verified before every run), committed via the
 * atomic temp+rename pattern, deleted and re-downloaded on mismatch.
 *
 * ## The pinned file set (measured/chosen in the F4 bench, 2026-08-10)
 *
 * Whisper `base` (multilingual) over `tiny`: the bench measured tiny at
 * RTF ~12.8x and base at ~9.1x on real speech (both CPU EP, this machine),
 * both transcribing the jfk.wav reference sentence exactly; base's accuracy
 * advantage on harder/multilingual audio (the reference app auto-detects
 * English/French, and openai's published WERs roughly halve from tiny to
 * base on French) costs only ~1.4x of a ~10x realtime budget. Sources:
 *   - onnx-community/whisper-base (upstream openai/whisper-base,
 *     Apache-2.0; the onnx-community conversion repo carries no separate
 *     licence tag) — ungated, no token.
 *   - wespeaker_en_voxceleb_CAM++.onnx from the sherpa-onnx model release
 *     (WeSpeaker, Apache-2.0) — ungated. Speaker-embedding model; 512-d
 *     embeddings; discrimination measured in the F4 bench (same-speaker
 *     cosine 0.65-0.88, different-speaker 0.17-0.54 on sr-data).
 *
 * ## Renderer IPC contract
 *
 *   invoke 'transcribe:model-state'  → {downloaded, bytes, expectedBytes}
 *       Cheap existence+size probe over the whole file set (~322 MB).
 *   invoke 'transcribe:ensure-models' → {ok:true} | {ok:false, error}
 *       Verifies-or-downloads every file; progress streams as
 *       'transcribe:model-progress' {file, fileIndex, fileCount, received,
 *       total} events (throttled), received/total being OVERALL bytes.
 *   invoke 'transcribe:run' {sampleRate:16000, samples:ArrayBuffer,
 *                            language:'auto'|code}
 *       → {ok:true, segmentCount} | {ok:false, cancelled:true}
 *       | {ok:false, error}
 *       While in flight the window receives:
 *         'transcribe:progress'  {stage:'transcribe'|'embed', done, total}
 *         'transcribe:language'  {language, probability}
 *         'transcribe:segment'   {index, startSample, endSample, text,
 *                                 avgLogprob, noSpeechProb, compressionRatio}
 *         'transcribe:embedding' {segmentIndex, vector:ArrayBuffer}
 *   invoke 'transcribe:cancel'       → {cancelled:boolean}
 *       Kills the utility process (ruling 1: Cancel actually kills the work).
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { atomicWriteFile } = require('./atomicWrite.cjs');
const { verifyModelFile, downloadModel } = require('./stemManager.cjs');
const { MAX_TOTAL_SAMPLES } = require('./transcribeHost.cjs');
const { WHISPER_SAMPLE_RATE } = require('./whisperFeatures.cjs');

/** sha256/size pins — computed from the exact files the F4 bench validated
 * (jfk.wav transcribed verbatim; embedder discriminating sr-data speakers). */
const TRANSCRIBE_FILES = Object.freeze([
  {
    key: 'encoder',
    filename: 'whisper-base-encoder.onnx',
    url: 'https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/encoder_model.onnx',
    sha256: 'a9f3b752833b49e880dec91ee5b6d936112be7c3ea07c221024ba493439f46fe',
    bytes: 82468078,
  },
  {
    key: 'decoder',
    filename: 'whisper-base-decoder_merged.onnx',
    url: 'https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/decoder_model_merged.onnx',
    sha256: '514903744bb1b45803ec571af99b31110491c6f77b0a154825866995fb124b73',
    bytes: 208521528,
  },
  {
    key: 'tokenizer',
    filename: 'whisper-base-tokenizer.json',
    url: 'https://huggingface.co/onnx-community/whisper-base/resolve/main/tokenizer.json',
    sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566',
    bytes: 2480466,
  },
  {
    key: 'generationConfig',
    filename: 'whisper-base-generation_config.json',
    url: 'https://huggingface.co/onnx-community/whisper-base/resolve/main/generation_config.json',
    sha256: '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0',
    bytes: 3832,
  },
  {
    key: 'modelConfig',
    filename: 'whisper-base-config.json',
    url: 'https://huggingface.co/onnx-community/whisper-base/resolve/main/config.json',
    sha256: 'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b',
    bytes: 2243,
  },
  {
    key: 'embedder',
    filename: 'campplus-voxceleb.onnx',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_CAM%2B%2B.onnx',
    sha256: 'c46fad10b5f81e1aa4a60c162714208577093655076c5450f8c469e522ec54ef',
    bytes: 29292684,
  },
]);

const TRANSCRIBE_TOTAL_BYTES = TRANSCRIBE_FILES.reduce((n, f) => n + f.bytes, 0);
const TRANSCRIBE_MODEL_DIR = path.join('models', 'transcription');

/** ~4 MB of samples per 'audio' message (structured clone copies). */
const AUDIO_SLICE_SAMPLES = 1 << 20;
const MODEL_PROGRESS_THROTTLE_MS = 200;

const TRANSCRIBE_IPC = Object.freeze({
  modelState: 'transcribe:model-state',
  ensureModels: 'transcribe:ensure-models',
  modelProgress: 'transcribe:model-progress',
  run: 'transcribe:run',
  cancel: 'transcribe:cancel',
  progress: 'transcribe:progress',
  language: 'transcribe:language',
  segment: 'transcribe:segment',
  embedding: 'transcribe:embedding',
});

/**
 * Maps each file key to its on-disk destination. `files` is a parameter, not
 * a closed-over constant: every caller that accepts an injected file set MUST
 * pass the same set here, or it would verify one set of pins against another
 * set of paths.
 */
function getTranscribeModelPaths(userDataDir, files = TRANSCRIBE_FILES) {
  const dir = path.join(userDataDir, TRANSCRIBE_MODEL_DIR);
  const paths = {};
  for (const f of files) paths[f.key] = path.join(dir, f.filename);
  return paths;
}

/**
 * Verifies-or-downloads the whole file set. Progress reports OVERALL bytes
 * across the set (already-verified files count as received), so the UI can
 * show one bar for the ~322 MB first-run download. Throws with a
 * human-readable message on failure; on success every destination file has
 * passed its sha256+size pin.
 */
async function ensureTranscriptionModels({
  userDataDir,
  onProgress,
  onStatus,
  files = TRANSCRIBE_FILES,
  requestImpl,
  sleep,
  fsImpl = fs,
  atomicWrite = atomicWriteFile,
  shouldAbort = () => false,
} = {}) {
  const dir = path.join(userDataDir, TRANSCRIBE_MODEL_DIR);
  const status = (s) => {
    if (onStatus) onStatus(s);
  };
  const overallTotal = files.reduce((n, f) => n + f.bytes, 0);
  let overallDone = 0;
  const report = (fileEntry, index, received) => {
    if (onProgress) {
      onProgress({
        file: fileEntry.key,
        fileIndex: index,
        fileCount: files.length,
        received: overallDone + received,
        total: overallTotal,
      });
    }
  };
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const dest = path.join(dir, f.filename);
    status(`verifying:${f.key}`);
    const existing = await verifyModelFile(dest, {
      expectedSha256: f.sha256,
      expectedBytes: f.bytes,
      fsImpl,
    });
    if (existing.ok) {
      overallDone += f.bytes;
      report(f, i, 0);
      continue;
    }
    if (existing.reason !== 'missing') {
      try {
        await fsImpl.promises.unlink(dest);
      } catch (err) {
        throw new Error(
          `${f.filename} failed verification (${existing.reason}) and could not be deleted (${err.code || err.message}) — close any program using it and retry`
        );
      }
      status(`corrupt-deleted:${f.key}`);
    }
    status(`downloading:${f.key}`);
    const buf = await downloadModel({
      url: f.url,
      onProgress: (p) => report(f, i, p.received),
      requestImpl,
      sleep,
      maxBytes: f.bytes,
      shouldAbort,
    });
    if (buf.length !== f.bytes) {
      throw new Error(
        `${f.filename} failed size verification (expected ${f.bytes} bytes, got ${buf.length}) — not saved`
      );
    }
    const digest = crypto.createHash('sha256').update(buf).digest('hex');
    if (digest !== f.sha256) {
      throw new Error(
        `${f.filename} failed sha256 verification (expected ${f.sha256}, got ${digest}) — not saved`
      );
    }
    await fsImpl.promises.mkdir(path.dirname(dest), { recursive: true });
    await atomicWrite(dest, buf);
    overallDone += f.bytes;
    report(f, i, 0);
  }
  status('ready');
  return getTranscribeModelPaths(userDataDir, files);
}

/** Lazily resolves electron.utilityProcess (plain-node/Jest safe). */
function defaultUtilityProcessFactory() {
  const { utilityProcess } = require('electron');
  return utilityProcess.fork(path.join(__dirname, 'transcribeHost.cjs'), [], {
    serviceName: 'Auditorium transcription',
  });
}

/**
 * Creates the manager. All electron/network/fs dependencies are injectable;
 * production wiring passes only { userDataDir }. Worker choreography is
 * stemManager's T13 discipline verbatim: monotonic run id, settle-once,
 * child killed on every terminal branch, returned promise always resolves.
 */
function createTranscribeManager({
  userDataDir,
  utilityProcessFactory = defaultUtilityProcessFactory,
  files = TRANSCRIBE_FILES,
  requestImpl,
  sleep,
  fsImpl = fs,
  atomicWrite = atomicWriteFile,
  // Injected so a test can observe it; `console.warn` reaches the packaged
  // app's stderr, which is where a wedged inference process has to be
  // visible. There is nothing better to do here — see `settle` below.
  onWarn = (msg) => console.warn(msg),
} = {}) {
  let active = null;
  let nextRunId = 1;
  let disposed = false; // latch, set once on app quit

  function isRunning() {
    return active !== null;
  }

  async function getModelState() {
    const paths = getTranscribeModelPaths(userDataDir, files);
    const expectedBytes = files.reduce((n, f) => n + f.bytes, 0);
    let bytes = 0;
    let complete = true;
    for (const f of files) {
      try {
        const stat = await fsImpl.promises.stat(paths[f.key]);
        bytes += stat.size;
        if (stat.size !== f.bytes) complete = false;
      } catch {
        complete = false;
      }
    }
    return { downloaded: complete, bytes: bytes > 0 ? bytes : null, expectedBytes };
  }

  function managerEnsureModels({ onProgress, onStatus } = {}) {
    return ensureTranscriptionModels({
      userDataDir,
      onProgress,
      onStatus,
      files,
      requestImpl,
      sleep,
      fsImpl,
      atomicWrite,
      shouldAbort: () => disposed,
    });
  }

  /**
   * Runs one transcription end-to-end against already-downloaded models.
   * Resolves (never rejects):
   *   {ok:true, segmentCount} | {ok:false, cancelled:true} | {ok:false, error}
   * `samples`: mono Float32Array at 16 kHz. Event callbacks stream while in
   * flight; none is ever called after settlement.
   */
  async function startTranscription({
    sampleRate,
    samples,
    language,
    onProgress,
    onLanguage,
    onSegment,
    onEmbedding,
  }) {
    if (disposed) {
      return { ok: false, error: 'transcription manager disposed (app is quitting)' };
    }
    if (active) {
      return { ok: false, error: 'a transcription is already running (busy)' };
    }
    // Reserve the slot SYNCHRONOUSLY (before the async verification) so two
    // overlapping calls can never both pass the busy gate.
    const runId = nextRunId++;
    const entry = { runId, child: null, settled: false, resolve: null, result: null, settle: null };
    entry.settle = (result) => {
      if (entry.settled) return;
      entry.settled = true;
      entry.result = result;
      if (active === entry) active = null;
      if (entry.child) {
        // `utilityProcess.kill()` returns false when the signal could not be
        // delivered. Discarding that return and freeing the slot anyway means
        // a wedged child keeps its ~1 GB ORT arena while the NEXT run spawns a
        // second one — two arenas, silently, for the rest of the session.
        //
        // The slot is still freed (refusing every later run because one child
        // hung would be worse), but the failure is retried once and then
        // REPORTED rather than swallowed.
        let killed = false;
        try {
          killed = entry.child.kill() !== false;
        } catch {
          // already dead — the point was that it isn't alive after this line
          killed = true;
        }
        if (!killed) {
          try {
            killed = entry.child.kill() !== false;
          } catch {
            killed = true;
          }
        }
        if (!killed) {
          onWarn(
            `transcription host for run ${entry.runId} did not respond to kill — its ONNX Runtime arena (~1 GB) may still be resident`
          );
        }
      }
      if (entry.resolve) entry.resolve(result);
    };
    active = entry;

    const paths = getTranscribeModelPaths(userDataDir, files);
    // Ruling 1: every file sha256-verified before ANY load — the utility
    // process is not spawned for a set that fails a single pin.
    for (const f of files) {
      const v = await verifyModelFile(paths[f.key], {
        expectedSha256: f.sha256,
        expectedBytes: f.bytes,
        fsImpl,
      });
      if (entry.settled) return entry.result; // cancelled/disposed mid-verify
      if (!v.ok) {
        entry.settle({
          ok: false,
          error: `${f.filename} failed verification (${v.reason}: ${v.detail}) — re-download required`,
        });
        return entry.result;
      }
    }

    let child;
    try {
      child = utilityProcessFactory();
    } catch (err) {
      entry.settle({
        ok: false,
        error: `failed to spawn transcription host: ${err instanceof Error ? err.message : String(err)}`,
      });
      return entry.result;
    }
    entry.child = child;

    const totalSamples = samples.length;
    return new Promise((resolve) => {
      entry.resolve = resolve;

      child.on('message', (msg) => {
        if (entry.settled) return; // settled-run chatter is dropped
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
        switch (msg.type) {
          case 'ready': {
            child.postMessage({
              type: 'transcribe',
              id: runId,
              sampleRate,
              totalSamples,
              language,
            });
            for (let offset = 0; offset < totalSamples; offset += AUDIO_SLICE_SAMPLES) {
              const end = Math.min(offset + AUDIO_SLICE_SAMPLES, totalSamples);
              child.postMessage({
                type: 'audio',
                id: runId,
                offset,
                // .slice (copy), NOT .subarray — structured clone would
                // serialise a subarray's whole backing buffer per message.
                samples: samples.slice(offset, end),
              });
            }
            child.postMessage({ type: 'run', id: runId });
            break;
          }
          case 'progress':
            if (msg.id === runId && onProgress) {
              onProgress({ stage: msg.stage, done: msg.done, total: msg.total });
            }
            break;
          case 'language':
            if (msg.id === runId && onLanguage) {
              onLanguage({ language: msg.language, probability: msg.probability });
            }
            break;
          case 'segment':
            if (msg.id === runId && onSegment) {
              onSegment({
                index: msg.index,
                startSample: msg.startSample,
                endSample: msg.endSample,
                text: msg.text,
                avgLogprob: msg.avgLogprob,
                noSpeechProb: msg.noSpeechProb,
                compressionRatio: msg.compressionRatio,
              });
            }
            break;
          case 'embedding':
            if (msg.id === runId && onEmbedding) {
              onEmbedding({ segmentIndex: msg.segmentIndex, vector: msg.vector });
            }
            break;
          case 'done':
            if (msg.id === runId) entry.settle({ ok: true, segmentCount: msg.segmentCount });
            break;
          case 'cancelled':
            if (msg.id === runId) entry.settle({ ok: false, cancelled: true });
            break;
          case 'error':
            // id-gated; host-level errors (init/protocol) carry no id and DO
            // settle — there is no other job they could belong to.
            if (msg.id === undefined || msg.id === runId) {
              entry.settle({ ok: false, error: msg.message || 'transcription host error' });
            }
            break;
          default:
            break; // unknown host message: ignore, never crash
        }
      });

      child.on('exit', (code) => {
        entry.settle({ ok: false, error: `transcription host exited unexpectedly (code ${code})` });
      });

      child.postMessage({ type: 'init', paths });
    });
  }

  /** Cancel kills the utility process — instantaneous. */
  function cancel() {
    if (!active) return false;
    active.settle({ ok: false, cancelled: true });
    return true;
  }

  /** App-quit path: latch + cancel; aborts an in-flight download too. */
  function dispose() {
    disposed = true;
    cancel();
  }

  return {
    ensureModels: managerEnsureModels,
    getModelState,
    startTranscription,
    cancel,
    isRunning,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// Renderer-facing IPC
// ---------------------------------------------------------------------------

/**
 * Validates the renderer's run request at the trust boundary. Returns
 * {samples, language} or null.
 *
 * `maxSamples` defaults to the host's own cap (the two MUST agree — the host
 * rejects the job otherwise) and is a parameter only so the boundary can be
 * probed without allocating the 460 MB buffer that cap implies.
 */
function parseTranscribeRequest(req, maxSamples = MAX_TOTAL_SAMPLES) {
  if (!req || typeof req !== 'object') return null;
  if (req.sampleRate !== WHISPER_SAMPLE_RATE) return null;
  const { samples, language } = req;
  if (Object.prototype.toString.call(samples) !== '[object ArrayBuffer]') return null;
  if (samples.byteLength === 0 || samples.byteLength % 4 !== 0) return null;
  if (samples.byteLength / 4 > maxSamples) return null;
  if (typeof language !== 'string' || !/^(auto|[a-z]{2,3})$/.test(language)) return null;
  return { samples: new Float32Array(samples), language };
}

function registerTranscribeIpc({ ipcMain, manager, getWin }) {
  const send = (channel, payload) => {
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  ipcMain.handle(TRANSCRIBE_IPC.modelState, async () => manager.getModelState());

  ipcMain.handle(TRANSCRIBE_IPC.ensureModels, async () => {
    try {
      let lastSent = 0;
      await manager.ensureModels({
        onProgress: (p) => {
          const now = Date.now();
          if (now - lastSent >= MODEL_PROGRESS_THROTTLE_MS || p.received === p.total) {
            lastSent = now;
            send(TRANSCRIBE_IPC.modelProgress, p);
          }
        },
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(TRANSCRIBE_IPC.run, async (_event, req) => {
    const parsed = parseTranscribeRequest(req);
    if (!parsed) {
      return {
        ok: false,
        error:
          "invalid transcribe request (expected {sampleRate:16000, samples:ArrayBuffer, language:'auto'|code})",
      };
    }
    return manager.startTranscription({
      sampleRate: WHISPER_SAMPLE_RATE,
      samples: parsed.samples,
      language: parsed.language,
      onProgress: (p) => send(TRANSCRIBE_IPC.progress, p),
      onLanguage: (p) => send(TRANSCRIBE_IPC.language, p),
      onSegment: (p) => send(TRANSCRIBE_IPC.segment, p),
      onEmbedding: (p) => {
        const v = p.vector;
        const buf = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
        send(TRANSCRIBE_IPC.embedding, { segmentIndex: p.segmentIndex, vector: buf });
      },
    });
  });

  ipcMain.handle(TRANSCRIBE_IPC.cancel, async () => ({ cancelled: manager.cancel() }));
}

module.exports = {
  TRANSCRIBE_FILES,
  TRANSCRIBE_TOTAL_BYTES,
  TRANSCRIBE_MODEL_DIR,
  TRANSCRIBE_IPC,
  getTranscribeModelPaths,
  ensureTranscriptionModels,
  createTranscribeManager,
  registerTranscribeIpc,
  parseTranscribeRequest,
};
