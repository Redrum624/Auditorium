'use strict';

/**
 * Main-process owner of lyrics alignment (F6): download/verification of the
 * two-file wav2vec2 model set and the lifetime of the inference utility
 * process (alignHost.cjs). This is transcribeManager.cjs's proven shape with
 * one job type instead of one-plus-embeddings — it deliberately REUSES
 * stemManager.cjs's exported `verifyModelFile` and `downloadModel` rather than
 * reimplementing the pin/retry/oversize/abort machinery.
 *
 * Nothing is bundled; both files are downloaded on first use into
 * `userData/models/align/`, sha256+size verified BEFORE ANY LOAD (and
 * re-verified before every run), committed via the atomic temp+rename pattern,
 * deleted and re-downloaded on mismatch (F4 Ruling 1).
 *
 * The manager returns the acoustic model's emission grid, not an alignment:
 * the Viterbi search that places known text lives in `src/dsp/ctcAlign.ts`.
 * See alignHost.cjs's header for why the split is where it is.
 *
 * ## Licence provenance — a DELIBERATE derivation, recorded rather than hidden
 *
 * Upstream `facebook/wav2vec2-base-960h` is Apache-2.0 and ungated (1.67 M
 * downloads). The ONNX mirror the graph is fetched from,
 * `onnx-community/wav2vec2-base-960h-ONNX`, declares NO licence of its own, so
 * the Apache-2.0 grant is INHERITED from the checkpoint it was exported from
 * rather than asserted by the repo we download from. That derivation is
 * accepted deliberately, exactly as voiceManager.cjs records F3's third-party
 * OpenVoice export — and it is precisely why the sha256 pins below are
 * load-bearing: they bind the app to the bytes this task verified, not to
 * whatever the mirror serves tomorrow.
 *
 * The vocab is taken from the OFFICIAL Apache-2.0 repo rather than from the
 * mirror (verified byte-different but semantically identical: the same 32
 * token->id entries), so only the graph itself rides the derivation.
 *
 * Exporting the graph in-house was considered and rejected on a delivery
 * constraint, not on effort: the app downloads every model from a public URL on
 * first use and bundles nothing (F4 Ruling 1), and an in-house export has no
 * public URL to be downloaded from.
 *
 * ## Renderer IPC contract
 *
 *   invoke 'align:model-state'   → {downloaded, bytes, expectedBytes}
 *       Cheap existence+size probe over the file set (~378 MB).
 *   invoke 'align:ensure-models' → {ok:true} | {ok:false, error}
 *       Verifies-or-downloads every file; progress streams as
 *       'align:model-progress' {file, fileIndex, fileCount, received, total}
 *       events (throttled), received/total being OVERALL bytes.
 *   invoke 'align:run' {sampleRate:16000, samples:ArrayBuffer}
 *       → {ok:true, frames, classes, frameSamples, vocab, logProbs:ArrayBuffer}
 *       | {ok:false, cancelled:true} | {ok:false, error}
 *       `logProbs` is `frames * classes` log-softmax values, row-major
 *       [frame][class]; `frameSamples` maps a frame index to input samples;
 *       `vocab` is the model's OWN token→id map (see alignHost.cjs — a
 *       tokeniser that invented its own ids would align a different sequence
 *       than the one the graph scored). While in flight the window receives:
 *         'align:progress' {done, total}   — SAMPLES analysed.
 *   invoke 'align:cancel'        → {cancelled:boolean}
 *       Kills the utility process (Cancel actually kills the work).
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { atomicWriteFile } = require('./atomicWrite.cjs');
const { verifyModelFile, downloadModel } = require('./stemManager.cjs');
const { MAX_TOTAL_SAMPLES, ALIGN_SAMPLE_RATE } = require('./alignHost.cjs');

/** sha256/size pins — computed from the exact files the F6 spike measured
 * (20 ms cross-model median onset placement on the reference sung take). */
const ALIGN_FILES = Object.freeze([
  {
    key: 'model',
    filename: 'wav2vec2-base-960h.onnx',
    url: 'https://huggingface.co/onnx-community/wav2vec2-base-960h-ONNX/resolve/main/onnx/model.onnx',
    sha256: '00b7cc69516c1ab63c429e63a2b543e4d42bb77441ec5b98ee935de175b00de1',
    bytes: 377911891,
  },
  {
    key: 'vocab',
    filename: 'wav2vec2-base-960h-vocab.json',
    url: 'https://huggingface.co/facebook/wav2vec2-base-960h/resolve/main/vocab.json',
    sha256: '19727f8944fe6459fc3f240ae2c198395b740f6a029bd23e06656266b83bcf64',
    bytes: 291,
  },
]);

/**
 * Sum of a file set's byte pins.
 *
 * `files` is a parameter because every caller is handed a set — the real
 * pins in production, an injected pair in a test — and summing the module
 * constant instead would report the real total for a fake download.
 */
function totalBytes(files) {
  return files.reduce((n, f) => n + f.bytes, 0);
}

/**
 * The two pins added up. No production consumer: this is the number the
 * renderer hardcodes as `ALIGN_MODEL_BYTES` for the no-preload fallback, and
 * the electron and renderer jest projects cannot import each other, so the
 * agreement is pinned in `alignManager.test.cjs` instead.
 */
const ALIGN_TOTAL_BYTES = totalBytes(ALIGN_FILES);
const ALIGN_MODEL_DIR = path.join('models', 'align');

/** ~4 MB of samples per 'audio' message (structured clone copies) — the same
 * slice size the stem, transcription and voice managers use. */
const AUDIO_SLICE_SAMPLES = 1 << 20;
const MODEL_PROGRESS_THROTTLE_MS = 200;

const ALIGN_IPC = Object.freeze({
  modelState: 'align:model-state',
  ensureModels: 'align:ensure-models',
  modelProgress: 'align:model-progress',
  run: 'align:run',
  cancel: 'align:cancel',
  progress: 'align:progress',
});

/**
 * Maps each file key to its on-disk destination. `files` is a parameter, not a
 * closed-over constant: every caller that accepts an injected file set MUST
 * pass the same set here, or it would verify one set of pins against another
 * set of paths.
 */
function getAlignModelPaths(userDataDir, files = ALIGN_FILES) {
  const dir = path.join(userDataDir, ALIGN_MODEL_DIR);
  const paths = {};
  for (const f of files) paths[f.key] = path.join(dir, f.filename);
  return paths;
}

/**
 * Verifies-or-downloads the whole file set. Progress reports OVERALL bytes
 * across the set (already-verified files count as received), so the UI can show
 * one bar for the ~378 MB first-run download — the vocab is 291 bytes against a
 * 378 MB graph, and a per-file bar would jump from 0 % to 100 % and back.
 * Throws with a human-readable message on failure; on success every destination
 * file has passed its sha256+size pin.
 */
async function ensureAlignModels({
  userDataDir,
  onProgress,
  onStatus,
  files = ALIGN_FILES,
  requestImpl,
  sleep,
  fsImpl = fs,
  atomicWrite = atomicWriteFile,
  shouldAbort = () => false,
} = {}) {
  const dir = path.join(userDataDir, ALIGN_MODEL_DIR);
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
    // Size first, then sha256: a truncated/oversized body is the common failure
    // and its message names the numbers, which a digest mismatch cannot.
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
  return getAlignModelPaths(userDataDir, files);
}

/** Lazily resolves electron.utilityProcess (plain-node/Jest safe). */
function defaultUtilityProcessFactory() {
  const { utilityProcess } = require('electron');
  return utilityProcess.fork(path.join(__dirname, 'alignHost.cjs'), [], {
    serviceName: 'Auditorium lyrics alignment',
  });
}

/**
 * Creates the manager. All electron/network/fs dependencies are injectable;
 * production wiring passes only { userDataDir }. Worker choreography is
 * transcribeManager's discipline verbatim: monotonic run id, settle-once, child
 * killed on every terminal branch, returned promise always resolves.
 */
function createAlignManager({
  userDataDir,
  utilityProcessFactory = defaultUtilityProcessFactory,
  files = ALIGN_FILES,
  requestImpl,
  sleep,
  fsImpl = fs,
  atomicWrite = atomicWriteFile,
  // Injected so a test can observe it; `console.warn` reaches the packaged
  // app's stderr, which is where a wedged inference process has to be visible.
  // There is nothing better to do here — see `settle` below.
  onWarn = (msg) => console.warn(msg),
} = {}) {
  let active = null;
  let nextRunId = 1;
  let disposed = false; // latch, set once on app quit

  function isRunning() {
    return active !== null;
  }

  async function getModelState() {
    const paths = getAlignModelPaths(userDataDir, files);
    const expectedBytes = totalBytes(files);
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
    return ensureAlignModels({
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
   * Runs one alignment forward pass end-to-end against already-downloaded
   * models. Resolves (never rejects):
   *   {ok:true, frames, classes, frameSamples, vocab, logProbs}
   *   | {ok:false, cancelled:true} | {ok:false, error}
   * `samples`: mono Float32Array at 16 kHz; `logProbs` is the host's own
   * Float32Array (the IPC layer copies it into a transferable ArrayBuffer —
   * doing that here would cost a second copy for every in-process caller).
   * `onProgress` streams while in flight and is never called after settlement.
   */
  async function startAlignment({ sampleRate, samples, onProgress }) {
    if (disposed) {
      return { ok: false, error: 'alignment manager disposed (app is quitting)' };
    }
    if (active) {
      return { ok: false, error: 'an alignment is already running (busy)' };
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
        // delivered. Discarding that return and freeing the slot anyway means a
        // wedged child keeps its ORT arena while the NEXT run spawns a second
        // one — two arenas, silently, for the rest of the session.
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
            `alignment host for run ${entry.runId} did not respond to kill — its ONNX Runtime arena may still be resident`
          );
        }
      }
      if (entry.resolve) entry.resolve(result);
    };
    active = entry;

    const paths = getAlignModelPaths(userDataDir, files);
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
        error: `failed to spawn alignment host: ${err instanceof Error ? err.message : String(err)}`,
      });
      return entry.result;
    }
    entry.child = child;

    const totalSamples = samples.length;
    return new Promise((resolve) => {
      entry.resolve = resolve;

      // The host's own token→id map, forwarded from 'ready', and the single
      // 'emissions' payload. Both arrive BEFORE 'done' and are held here
      // because 'done' carries neither — resolving on 'done' with what was
      // captured is what makes one run produce exactly one result object.
      let vocab = null;
      let emissions = null;

      child.on('message', (msg) => {
        if (entry.settled) return; // settled-run chatter is dropped
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
        switch (msg.type) {
          case 'ready': {
            vocab = msg.vocab;
            child.postMessage({ type: 'align', id: runId, sampleRate, totalSamples });
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
              onProgress({ done: msg.done, total: msg.total });
            }
            break;
          case 'emissions':
            if (msg.id === runId) {
              emissions = {
                frames: msg.frames,
                classes: msg.classes,
                frameSamples: msg.frameSamples,
                logProbs: msg.logProbs,
              };
            }
            break;
          case 'done':
            if (msg.id !== runId) break;
            if (!emissions) {
              // 'done' without 'emissions' is a host-contract violation. Left
              // as an error rather than a half-filled success: a caller handed
              // {ok:true} with no grid would fail deeper, in the Viterbi.
              entry.settle({
                ok: false,
                error: 'alignment host finished without delivering an emission grid',
              });
              break;
            }
            entry.settle({ ok: true, ...emissions, vocab });
            break;
          case 'cancelled':
            if (msg.id === runId) entry.settle({ ok: false, cancelled: true });
            break;
          case 'error':
            // id-gated; host-level errors (init/protocol) carry no id and DO
            // settle — there is no other job they could belong to.
            if (msg.id === undefined || msg.id === runId) {
              entry.settle({ ok: false, error: msg.message || 'alignment host error' });
            }
            break;
          default:
            break; // unknown host message: ignore, never crash
        }
      });

      child.on('exit', (code) => {
        entry.settle({ ok: false, error: `alignment host exited unexpectedly (code ${code})` });
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
    startAlignment,
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
 * {samples} or null. There is no language field: the model is character-CTC
 * over one fixed 32-grapheme vocab and is never asked what was sung.
 *
 * `maxSamples` defaults to the host's own cap (the two MUST agree — the host
 * rejects the job otherwise) and is a parameter only so the boundary can be
 * probed without allocating the 76.8 MB buffer that cap implies.
 */
function parseAlignRequest(req, maxSamples = MAX_TOTAL_SAMPLES) {
  if (!req || typeof req !== 'object') return null;
  if (req.sampleRate !== ALIGN_SAMPLE_RATE) return null;
  const { samples } = req;
  if (Object.prototype.toString.call(samples) !== '[object ArrayBuffer]') return null;
  if (samples.byteLength === 0 || samples.byteLength % 4 !== 0) return null;
  if (samples.byteLength / 4 > maxSamples) return null;
  return { samples: new Float32Array(samples) };
}

function registerAlignIpc({ ipcMain, manager, getWin }) {
  const send = (channel, payload) => {
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  ipcMain.handle(ALIGN_IPC.modelState, async () => manager.getModelState());

  ipcMain.handle(ALIGN_IPC.ensureModels, async () => {
    try {
      let lastSent = 0;
      await manager.ensureModels({
        onProgress: (p) => {
          const now = Date.now();
          if (now - lastSent >= MODEL_PROGRESS_THROTTLE_MS || p.received === p.total) {
            lastSent = now;
            send(ALIGN_IPC.modelProgress, p);
          }
        },
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(ALIGN_IPC.run, async (_event, req) => {
    const parsed = parseAlignRequest(req);
    if (!parsed) {
      return {
        ok: false,
        error: `invalid align request (expected {sampleRate:${ALIGN_SAMPLE_RATE}, samples:ArrayBuffer})`,
      };
    }
    const result = await manager.startAlignment({
      sampleRate: ALIGN_SAMPLE_RATE,
      samples: parsed.samples,
      onProgress: (p) => send(ALIGN_IPC.progress, p),
    });
    if (!result.ok) return result;
    // Structured clone cannot carry a Float32Array view's identity across the
    // bridge; the renderer wants a transferable ArrayBuffer, and slicing from
    // byteOffset is what stops a view over a larger arena shipping the arena.
    const lp = result.logProbs;
    return {
      ok: true,
      frames: result.frames,
      classes: result.classes,
      frameSamples: result.frameSamples,
      vocab: result.vocab,
      logProbs: lp.buffer.slice(lp.byteOffset, lp.byteOffset + lp.byteLength),
    };
  });

  ipcMain.handle(ALIGN_IPC.cancel, async () => ({ cancelled: manager.cancel() }));
}

module.exports = {
  ALIGN_FILES,
  ALIGN_TOTAL_BYTES,
  ALIGN_MODEL_DIR,
  ALIGN_IPC,
  getAlignModelPaths,
  ensureAlignModels,
  createAlignManager,
  registerAlignIpc,
  parseAlignRequest,
};
