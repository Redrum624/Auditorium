'use strict';

/**
 * Main-process owner of speaker diarization (Separate Speakers, D2):
 * download/verification of the two-file model set and the lifetime of the
 * inference utility process (diarizeHost.cjs). This is transcribeManager.cjs's
 * proven shape over a different pinned set — it deliberately REUSES
 * stemManager's exported `verifyModelFile` and `downloadModel` rather than
 * reimplementing the pin/retry/oversize/abort machinery.
 *
 * Ruling 1 in code form: nothing is bundled; both files are downloaded on
 * first use into `userData/models/diarization/`, sha256+size verified BEFORE
 * ANY LOAD (and re-verified before every run), committed via the atomic
 * temp+rename pattern, deleted and re-downloaded on mismatch.
 *
 * ## The pinned file set (measured in the 2026-09-05 sweep — design-notes.md)
 *
 *   - pyannote-segmentation-3.0 as converted by k2-fsa for sherpa-onnx
 *     (MIT © 2022 CNRS; the HF original is gated, the mirror is not):
 *     input `x` [N,1,160000] float32 → `y` [N,589,7] powerset logits.
 *   - WeSpeaker ResNet34-LM from the sherpa-onnx speaker-recognition release
 *     (Apache-2.0): `feats` [B,T,80] → `embs` [B,256]. Chosen over the CAM++
 *     export the app already ships for transcription because the sweep found
 *     CAM++ internally inconsistent on real windows (33–62 % audio-anchored
 *     consistency) while ResNet34-LM with per-utterance CMN reaches 96–100 %
 *     and recovers the speaker count on 4/4 test recordings.
 *
 * Total 32,523,463 bytes (32.5 MB) — the figure the dialog's model gate shows.
 *
 * ## Renderer IPC contract (D2)
 *
 *   invoke 'diarize:model-state'    → {downloaded, bytes, expectedBytes}
 *       Cheap existence+size probe over the two files.
 *   invoke 'diarize:ensure-models'  → {ok:true} | {ok:false, error}
 *       Verifies-or-downloads both files; progress streams as
 *       'diarize:model-progress' {received, total} events (throttled, the
 *       final one always sent), received/total being OVERALL bytes.
 *   invoke 'diarize:run' {sampleRate:16000, samples:ArrayBuffer}
 *       → {ok:true, windowCount} | {ok:false, cancelled:true}
 *       | {ok:false, error}
 *       While in flight the window receives:
 *         'diarize:progress'  {stage:'segment'|'embed', done, total}
 *         'diarize:window'    {index, labels:ArrayBuffer(589)}
 *         'diarize:embedding' {windowIndex, localSpeaker, activeFrames,
 *                              vector:ArrayBuffer(1024)}
 *   invoke 'diarize:cancel'         → {cancelled:boolean}
 *       Kills the utility process (ruling 1: Cancel actually kills the work).
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { atomicWriteFile } = require('./atomicWrite.cjs');
const { verifyModelFile, downloadModel } = require('./stemManager.cjs');
const { MAX_TOTAL_SAMPLES, SAMPLE_RATE } = require('./diarizeHost.cjs');

/** sha256/size pins — the exact files the sweep validated (design-notes.md;
 * D2). Never re-tuned in place: a different file is a new bench run. */
const DIARIZE_FILES = Object.freeze([
  Object.freeze({
    key: 'segmentation',
    filename: 'pyannote-segmentation-3.0.onnx',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx',
    sha256: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079',
    bytes: 5992913,
  }),
  Object.freeze({
    key: 'embedder',
    filename: 'wespeaker_en_voxceleb_resnet34_LM.onnx',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx',
    sha256: 'e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012',
    bytes: 26530550,
  }),
]);

function totalBytes(files) {
  return files.reduce((n, f) => n + f.bytes, 0);
}

const DIARIZE_TOTAL_BYTES = totalBytes(DIARIZE_FILES);
const DIARIZE_MODEL_DIR = path.join('models', 'diarization');

/** ~4 MB of samples per 'audio' message (structured clone copies) — the
 * transcribe manager's slice, the same host-side coverage accounting. */
const AUDIO_SLICE_SAMPLES = 1 << 20;
const MODEL_PROGRESS_THROTTLE_MS = 200;

const DIARIZE_IPC = Object.freeze({
  modelState: 'diarize:model-state',
  ensureModels: 'diarize:ensure-models',
  modelProgress: 'diarize:model-progress',
  run: 'diarize:run',
  cancel: 'diarize:cancel',
  progress: 'diarize:progress',
  window: 'diarize:window',
  embedding: 'diarize:embedding',
});

/**
 * Maps each file key to its on-disk destination. `files` is a parameter, not
 * a closed-over constant: every caller that accepts an injected file set MUST
 * pass the same set here, or it would verify one set of pins against another
 * set of paths. The D6 bench resolves the same layout under
 * `<repo>/test-assets`.
 */
function getDiarizeModelPaths(userDataDir, files = DIARIZE_FILES) {
  const dir = path.join(userDataDir, DIARIZE_MODEL_DIR);
  const paths = {};
  for (const f of files) paths[f.key] = path.join(dir, f.filename);
  return paths;
}

/**
 * Cheap existence+size probe over the set: `downloaded` only when EVERY file
 * is present at its pinned size; `bytes` is what is on disk (null when
 * nothing is), `expectedBytes` the pinned total.
 */
async function getDiarizeModelState({ userDataDir, files = DIARIZE_FILES, fsImpl = fs } = {}) {
  const paths = getDiarizeModelPaths(userDataDir, files);
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
  return { downloaded: complete, bytes: bytes > 0 ? bytes : null, expectedBytes: totalBytes(files) };
}

/**
 * Verifies-or-downloads the whole file set. Progress reports OVERALL bytes
 * across the set (already-verified files count as received), so the UI can
 * show one bar for the 32.5 MB first-run download. Throws with a
 * human-readable message on failure; on success every destination file has
 * passed its sha256+size pin.
 */
async function ensureDiarizeModels({
  userDataDir,
  onProgress,
  onStatus,
  files = DIARIZE_FILES,
  requestImpl,
  sleep,
  fsImpl = fs,
  atomicWrite = atomicWriteFile,
  shouldAbort = () => false,
} = {}) {
  const dir = path.join(userDataDir, DIARIZE_MODEL_DIR);
  const status = (s) => {
    if (onStatus) onStatus(s);
  };
  const overallTotal = totalBytes(files);
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
      throw new Error(`${f.filename} failed size verification (expected ${f.bytes} bytes, got ${buf.length}) — not saved`);
    }
    const digest = crypto.createHash('sha256').update(buf).digest('hex');
    if (digest !== f.sha256) {
      throw new Error(`${f.filename} failed sha256 verification (expected ${f.sha256}, got ${digest}) — not saved`);
    }
    await fsImpl.promises.mkdir(path.dirname(dest), { recursive: true });
    await atomicWrite(dest, buf);
    overallDone += f.bytes;
    report(f, i, 0);
  }
  status('ready');
  return getDiarizeModelPaths(userDataDir, files);
}

/** Lazily resolves electron.utilityProcess (plain-node/Jest safe). The
 * factory receives what it forks so a test can pin the module and the
 * service name without electron. */
function defaultUtilityProcessFactory({ modulePath, serviceName }) {
  const { utilityProcess } = require('electron');
  return utilityProcess.fork(modulePath, [], { serviceName });
}

const HOST_MODULE = path.join(__dirname, 'diarizeHost.cjs');
const SERVICE_NAME = 'Auditorium speaker diarization';

/**
 * Creates the manager. All electron/network/fs dependencies are injectable;
 * production wiring passes only { userDataDir }. Worker choreography is
 * stemManager's T13 discipline verbatim: monotonic run id, settle-once, the
 * slot reserved synchronously, child killed on every terminal branch,
 * returned promise always resolves.
 */
function createDiarizeManager({
  userDataDir,
  utilityProcessFactory = defaultUtilityProcessFactory,
  files = DIARIZE_FILES,
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

  function getModelState() {
    return getDiarizeModelState({ userDataDir, files, fsImpl });
  }

  function managerEnsureModels({ onProgress, onStatus } = {}) {
    return ensureDiarizeModels({
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
   * Runs one diarization end-to-end against already-downloaded models.
   * Resolves (never rejects):
   *   {ok:true, windowCount} | {ok:false, cancelled:true} | {ok:false, error}
   * `samples`: mono Float32Array at 16 kHz. Event callbacks stream while in
   * flight; none is ever called after settlement.
   */
  async function startDiarization({ sampleRate, samples, onProgress, onWindow, onEmbedding }) {
    if (disposed) {
      return { ok: false, error: 'diarization manager disposed (app is quitting)' };
    }
    if (active) {
      return { ok: false, error: 'a diarization is already running (busy)' };
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
        // delivered. The slot is still freed (refusing every later run
        // because one child hung would be worse), but the failure is retried
        // once and then REPORTED rather than swallowed — a wedged child
        // keeps its ORT arena and the job buffer (up to ~0.5 GB) resident.
        let killed = false;
        try {
          killed = entry.child.kill() !== false;
        } catch {
          killed = true; // already dead — the point was that it isn't alive after this line
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
            `diarization host for run ${entry.runId} did not respond to kill — its ONNX Runtime arena and job buffer may still be resident`
          );
        }
      }
      if (entry.resolve) entry.resolve(result);
    };
    active = entry;

    const paths = getDiarizeModelPaths(userDataDir, files);
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
      child = utilityProcessFactory({ modulePath: HOST_MODULE, serviceName: SERVICE_NAME });
    } catch (err) {
      entry.settle({
        ok: false,
        error: `failed to spawn diarization host: ${err instanceof Error ? err.message : String(err)}`,
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
            child.postMessage({ type: 'diarize', id: runId, sampleRate, totalSamples });
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
          case 'window':
            if (msg.id === runId && onWindow) {
              onWindow({ index: msg.index, labels: msg.labels });
            }
            break;
          case 'embedding':
            if (msg.id === runId && onEmbedding) {
              onEmbedding({
                windowIndex: msg.windowIndex,
                localSpeaker: msg.localSpeaker,
                activeFrames: msg.activeFrames,
                vector: msg.vector,
              });
            }
            break;
          case 'done':
            if (msg.id === runId) entry.settle({ ok: true, windowCount: msg.windowCount });
            break;
          case 'cancelled':
            if (msg.id === runId) entry.settle({ ok: false, cancelled: true });
            break;
          case 'error':
            // id-gated; host-level errors (init/protocol) carry no id and DO
            // settle — there is no other job they could belong to.
            if (msg.id === undefined || msg.id === runId) {
              entry.settle({ ok: false, error: msg.message || 'diarization host error' });
            }
            break;
          default:
            break; // unknown host message: ignore, never crash
        }
      });

      child.on('exit', (code) => {
        entry.settle({ ok: false, error: `diarization host exited unexpectedly (code ${code})` });
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
    startDiarization,
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
 * {samples} or null — and refuses BEFORE any Float32Array is built over the
 * payload, so a malformed or over-cap buffer never costs a view.
 *
 * `maxSamples` defaults to the host's own cap (the two MUST agree — the host
 * rejects the job otherwise) and is a parameter only so the boundary can be
 * probed without allocating the 461 MB buffer that cap implies.
 */
function parseDiarizeRequest(req, maxSamples = MAX_TOTAL_SAMPLES) {
  if (!req || typeof req !== 'object') return null;
  if (req.sampleRate !== SAMPLE_RATE) return null;
  const { samples } = req;
  if (Object.prototype.toString.call(samples) !== '[object ArrayBuffer]') return null;
  if (samples.byteLength === 0 || samples.byteLength % 4 !== 0) return null;
  if (samples.byteLength / 4 > maxSamples) return null;
  return { samples: new Float32Array(samples) };
}

/** A typed array's bytes as a standalone ArrayBuffer (what crosses IPC). */
function toArrayBuffer(view) {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function registerDiarizeIpc({ ipcMain, manager, getWin }) {
  const send = (channel, payload) => {
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  ipcMain.handle(DIARIZE_IPC.modelState, async () => manager.getModelState());

  ipcMain.handle(DIARIZE_IPC.ensureModels, async () => {
    try {
      let lastSent = 0;
      await manager.ensureModels({
        onProgress: (p) => {
          const now = Date.now();
          if (now - lastSent >= MODEL_PROGRESS_THROTTLE_MS || p.received === p.total) {
            lastSent = now;
            // D2: {received, total} — the dialog names the set in flight
            // itself (it runs the two ensures sequentially), so per-file
            // detail is not part of this contract.
            send(DIARIZE_IPC.modelProgress, { received: p.received, total: p.total });
          }
        },
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(DIARIZE_IPC.run, async (_event, req) => {
    const parsed = parseDiarizeRequest(req);
    if (!parsed) {
      return {
        ok: false,
        error: 'invalid diarize request (expected {sampleRate:16000, samples:ArrayBuffer} of float32 samples, at most 2 hours)',
      };
    }
    return manager.startDiarization({
      sampleRate: SAMPLE_RATE,
      samples: parsed.samples,
      onProgress: (p) => send(DIARIZE_IPC.progress, p),
      onWindow: (w) => send(DIARIZE_IPC.window, { index: w.index, labels: toArrayBuffer(w.labels) }),
      onEmbedding: (e) =>
        send(DIARIZE_IPC.embedding, {
          windowIndex: e.windowIndex,
          localSpeaker: e.localSpeaker,
          activeFrames: e.activeFrames,
          vector: toArrayBuffer(e.vector),
        }),
    });
  });

  ipcMain.handle(DIARIZE_IPC.cancel, async () => ({ cancelled: manager.cancel() }));
}

module.exports = {
  DIARIZE_FILES,
  DIARIZE_TOTAL_BYTES,
  DIARIZE_MODEL_DIR,
  DIARIZE_IPC,
  AUDIO_SLICE_SAMPLES,
  getDiarizeModelPaths,
  getDiarizeModelState,
  ensureDiarizeModels,
  createDiarizeManager,
  registerDiarizeIpc,
  parseDiarizeRequest,
  verifyModelFile,
};
