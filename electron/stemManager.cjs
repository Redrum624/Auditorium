'use strict';

/**
 * Main-process owner of stem separation (S1): model download/verification and
 * the lifetime of the inference utility process (stemHost.cjs). Plan rulings
 * 2 and 3 in code form:
 *
 *   - The MODEL is never bundled. It is downloaded on first use to
 *     `userData/models/htdemucs_fp16weights.onnx` from the pinned HF URL and
 *     verified against the pinned sha256 + byte size BEFORE ANY LOAD; a
 *     mismatch deletes the file and reports. The download is committed via
 *     the app's atomic temp+rename pattern (electron/atomicWrite.cjs), so an
 *     app quit mid-download can never leave a corrupt/partial model file —
 *     the destination path either holds a fully-verified model or nothing.
 *   - Inference lives in a `utilityProcess` (CPU EP only — see
 *     stemHost.cjs). The manager spawns ONE child per separation run and
 *     kills it on EVERY terminal branch (done, error, cancel, dispose), so
 *     cancel is instantaneous (ruling 7: Cancel kills the utility process),
 *     the ~5 GB inference peak is returned to the OS after each run, and app
 *     quit leaves no orphan (main.cjs calls dispose() on 'will-quit'; a
 *     utilityProcess child also dies with its parent as a backstop).
 *
 * License note: the downloaded weights are `StemSplitio/htdemucs-onnx`'s
 * `htdemucs_fp16weights.onnx`, published under MIT (verified 2026-08-16
 * against the model card), matching the upstream Meta AI HT-Demucs MIT
 * release they are exported from. See THIRD_PARTY_NOTICES.md at the repo
 * root.
 *
 * Worker-choreography discipline follows tempoAnalysis.ts / effectRunner.ts
 * (T4/T13): a monotonic run id tags every message, replies for a settled run
 * are dropped (no double settle, no late callbacks), and the returned
 * promise ALWAYS resolves — with {ok:false, error|cancelled} on failure,
 * never a rejection and never a hang.
 *
 * ## Renderer IPC contract (S3 wires the renderer side; defined here now)
 *
 * All channels are registered by registerStemIpc(). Audio travels as
 * ArrayBuffers of planar Float32 samples AT THE MODEL RATE (44100 Hz) — the
 * renderer resamples with the existing windowed-sinc before sending (ruling
 * 4: the model runs at its own rate; the document's native rate never enters
 * this process).
 *
 *   invoke 'stems:model-state'  → {downloaded:boolean, bytes:number|null,
 *                                  expectedBytes:number}
 *       Cheap existence+size probe for the S6 dialog (166 MB warning state).
 *       Does NOT hash; the full sha256 gate runs on ensure/load.
 *   invoke 'stems:ensure-model' → {ok:true, path} | {ok:false, error}
 *       Verifies-or-downloads the model. Progress streams to the window as
 *       'stems:model-progress' {received, total} events (throttled).
 *   invoke 'stems:separate' {sampleRate:44100, channels:ArrayBuffer[1|2]}
 *                               → {ok:true, totalSegments}
 *                               | {ok:false, cancelled:true}
 *                               | {ok:false, error}
 *       Runs a full separation. While in flight the window receives
 *         'stems:progress' {segment, totalSegments}   (per 7.8 s segment)
 *         'stems:chunk' {offset, samples, data:ArrayBuffer}
 *       where data is planar stem-major/channel-minor Float32 (block
 *       s*2+c of length `samples`; stems ordered drums, bass, other,
 *       vocals), chunks contiguous and tiling [0, totalSamples) — see
 *       stemHost.cjs. The result payloads are the model's stem ESTIMATES at
 *       44100 Hz; the renderer resamples them back and builds ratio masks
 *       over the original document's STFT (ruling 4) — raw estimates are
 *       never shipped as stems.
 *   invoke 'stems:cancel'       → {cancelled:boolean}
 *       Kills the utility process; the in-flight separate invoke resolves
 *       {ok:false, cancelled:true}.
 *
 * The renderer payload is validated here at the trust boundary (same
 * discipline as ipc.cjs dialog-opts validation): exact model rate, 1–2
 * equal-length float32-aligned non-empty channel buffers, length-capped.
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const https = require('node:https');
const { atomicWriteFile } = require('./atomicWrite.cjs');
const { MODEL_SAMPLE_RATE } = require('./stemSegmentation.cjs');
// Safe to require here: stemHost only loads onnxruntime inside its
// parentPort bootstrap, which never runs in the main process.
const { MAX_TOTAL_SAMPLES } = require('./stemHost.cjs');

// Ruling-3 pins (P0 report, measured + verified on this machine).
const MODEL_URL =
  'https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/main/htdemucs_fp16weights.onnx';
const MODEL_SHA256 = 'd05c269d0178d2a72ad484b10b11dd370193fc923201c3b27a99f848745db70a';
const MODEL_BYTES = 165612636;
const MODEL_FILENAME = 'htdemucs_fp16weights.onnx';
const MODEL_DIR = 'models';

const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_BACKOFF_MS = [1000, 3000];
const MAX_REDIRECTS = 5;
/** Samples per 'audio' message to the host (~4 MB per channel per message —
 * structured clone copies, so slices keep each copy bounded). */
const AUDIO_SLICE_SAMPLES = 1 << 20;
/** Trust-boundary cap for renderer separate requests — THE host cap
 * (stemHost.cjs documents the 30-minute memory arithmetic). */
const MAX_REQUEST_SAMPLES = MAX_TOTAL_SAMPLES;

const STEM_IPC = Object.freeze({
  modelState: 'stems:model-state',
  ensureModel: 'stems:ensure-model',
  modelProgress: 'stems:model-progress',
  separate: 'stems:separate',
  cancel: 'stems:cancel',
  progress: 'stems:progress',
  chunk: 'stems:chunk',
});

function getModelPath(userDataDir) {
  return path.join(userDataDir, MODEL_DIR, MODEL_FILENAME);
}

/**
 * Verifies the on-disk model against the pinned size and sha256. Size is
 * checked first (cheap stat) so an obviously-truncated file fails without
 * hashing 166 MB; the hash streams (64 KB chunks) rather than loading the
 * whole file. Returns {ok:true} or {ok:false, reason:'missing'|'size'|
 * 'sha256', detail} — it never throws for a bad file, only for I/O faults
 * on a file that exists (surfaced as {ok:false, reason:'missing'} when the
 * path is simply absent).
 */
async function verifyModelFile(
  filePath,
  { expectedSha256 = MODEL_SHA256, expectedBytes = MODEL_BYTES, fsImpl = fs } = {}
) {
  let stat;
  try {
    stat = await fsImpl.promises.stat(filePath);
  } catch {
    return { ok: false, reason: 'missing', detail: filePath };
  }
  if (stat.size !== expectedBytes) {
    return { ok: false, reason: 'size', detail: `expected ${expectedBytes} bytes, found ${stat.size}` };
  }
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fsImpl.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const digest = hash.digest('hex');
  if (digest !== expectedSha256) {
    return { ok: false, reason: 'sha256', detail: `expected ${expectedSha256}, found ${digest}` };
  }
  return { ok: true };
}

/** Real HTTP GET: follows up to MAX_REDIRECTS redirects (the HF resolve URL
 * 302s to a CDN), rejects on any non-2xx terminal status, streams data out
 * through the handlers. A THROW from onTotal/onData (the oversize/abort
 * guards in downloadModel) destroys the request immediately — the socket
 * must not keep streaming into a rejected download. Injectable in tests
 * (`requestImpl`). */
function httpsRequestImpl(url, { onTotal, onData }, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume(); // drain and discard
        if (redirectsLeft <= 0) {
          reject(new Error('too many redirects'));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        resolve(httpsRequestImpl(next, { onTotal, onData }, redirectsLeft - 1));
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`HTTP ${status} from ${new URL(url).host}`));
        return;
      }
      const guarded = (fn, arg) => {
        try {
          fn(arg);
          return true;
        } catch (err) {
          req.destroy();
          reject(err);
          return false;
        }
      };
      const total = Number(res.headers['content-length']);
      if (Number.isFinite(total) && total > 0 && !guarded(onTotal, total)) return;
      res.on('data', (chunk) => guarded(onData, chunk));
      res.on('end', resolve);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('download timed out (60 s without data)')));
  });
}

/** Errors that must NOT be retried: an oversize stream is hostile/broken (a
 * fresh attempt would overrun again) and an abort is deliberate. */
const NON_RETRYABLE = new Set(['STEM_DOWNLOAD_OVERSIZE', 'STEM_DOWNLOAD_ABORTED']);

function oversizeError(got, maxBytes) {
  const err = new Error(
    `download exceeded the pinned model size (received ${got} of at most ${maxBytes} bytes) — aborted`
  );
  err.code = 'STEM_DOWNLOAD_OVERSIZE';
  return err;
}

function abortError() {
  const err = new Error('model download aborted (manager disposed)');
  err.code = 'STEM_DOWNLOAD_ABORTED';
  return err;
}

/**
 * Downloads the model INTO MEMORY (166 MB — a deliberate trade: the bytes
 * must be fully sha256-verified before anything is committed to disk, and
 * the atomic write wants the whole payload; a one-time transient buffer in
 * main is cheaper than inventing a second temp-file scheme next to
 * atomicWrite's). Retries from scratch on failure (no resume — a partial
 * from a dropped connection is worthless anyway) with backoff between
 * attempts. Progress reports {received, total} per chunk; total is null
 * until/unless the server sends content-length.
 */
async function downloadModel({
  url = MODEL_URL,
  onProgress,
  requestImpl = httpsRequestImpl,
  attempts = DOWNLOAD_ATTEMPTS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxBytes = MODEL_BYTES,
  shouldAbort = () => false,
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (shouldAbort()) throw abortError();
    if (attempt > 0) {
      await sleep(DOWNLOAD_BACKOFF_MS[Math.min(attempt - 1, DOWNLOAD_BACKOFF_MS.length - 1)]);
      if (shouldAbort()) throw abortError();
    }
    const chunks = [];
    let received = 0;
    let total = null;
    // The abort watcher settles the race even when requestImpl is stuck in a
    // stalled-but-open socket that will never call a handler again.
    let watcherTimer = null;
    const abortWatcher = new Promise((_, rejectWatch) => {
      watcherTimer = setInterval(() => {
        if (shouldAbort()) rejectWatch(abortError());
      }, 100);
    });
    try {
      const request = requestImpl(url, {
        onTotal: (t) => {
          // Fix round 1, MED-3: a content-length past the pin is refused
          // before a single body byte is buffered...
          if (t > maxBytes) throw oversizeError(t, maxBytes);
          total = t;
        },
        onData: (chunk) => {
          if (shouldAbort()) throw abortError();
          received += chunk.length;
          // ...and a stream that overruns the pin (with or without an
          // honest content-length) aborts at the crossing chunk instead of
          // buffering an attacker-sized payload in main-process memory.
          if (received > maxBytes) throw oversizeError(received, maxBytes);
          chunks.push(chunk);
          if (onProgress) onProgress({ received, total });
        },
      });
      // If the abort watcher wins the race, the request promise is orphaned
      // but may still reject later — that must not surface as an unhandled
      // rejection.
      request.catch(() => {});
      await Promise.race([request, abortWatcher]);
      return Buffer.concat(chunks);
    } catch (err) {
      if (err && NON_RETRYABLE.has(err.code)) throw err;
      lastErr = err;
    } finally {
      clearInterval(watcherTimer);
    }
  }
  throw new Error(
    `model download failed after ${attempts} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  );
}

/**
 * The first-use gate: returns the path to a VERIFIED model, downloading it
 * if absent and deleting-then-redownloading if corrupt (ruling 3: mismatch
 * deletes and reports — the report is the 'corrupt-deleted' status event
 * plus, when download is impossible, the thrown error the caller surfaces
 * as a clear inline message, never a broken state). Throws on failure with
 * a human-readable message; on success the destination file has passed the
 * full sha256 + size pin in memory before the atomic commit.
 */
async function ensureModel({
  userDataDir,
  modelPath,
  onProgress,
  onStatus,
  expectedSha256 = MODEL_SHA256,
  expectedBytes = MODEL_BYTES,
  requestImpl,
  sleep,
  url,
  fsImpl = fs,
  atomicWrite = atomicWriteFile,
  shouldAbort,
} = {}) {
  const dest = modelPath || getModelPath(userDataDir);
  const status = (s) => {
    if (onStatus) onStatus(s);
  };

  status('verifying');
  const existing = await verifyModelFile(dest, { expectedSha256, expectedBytes, fsImpl });
  if (existing.ok) {
    status('ready');
    return dest;
  }
  if (existing.reason !== 'missing') {
    // Mismatch deletes (ruling 3) — a corrupt file must never be loadable.
    try {
      await fsImpl.promises.unlink(dest);
    } catch (err) {
      // Fix round 1, LOW-5: a locked file must surface the intended clear
      // message, not a raw EPERM stack.
      throw new Error(
        `model file failed verification (${existing.reason}) and could not be deleted (${err.code || err.message}) — close any program using it and retry`
      );
    }
    status('corrupt-deleted');
  }

  status('downloading');
  const buf = await downloadModel({
    url,
    onProgress,
    requestImpl,
    sleep,
    maxBytes: expectedBytes,
    shouldAbort,
  });

  status('verifying-download');
  if (buf.length !== expectedBytes) {
    throw new Error(
      `downloaded model failed size verification (expected ${expectedBytes} bytes, got ${buf.length}) — not saved`
    );
  }
  const digest = crypto.createHash('sha256').update(buf).digest('hex');
  if (digest !== expectedSha256) {
    throw new Error(
      `downloaded model failed sha256 verification (expected ${expectedSha256}, got ${digest}) — not saved`
    );
  }

  await fsImpl.promises.mkdir(path.dirname(dest), { recursive: true });
  // Atomic temp+rename commit (electron/atomicWrite.cjs): the verified bytes
  // land under a random sibling temp name and are renamed over the target in
  // one filesystem operation — an app quit at ANY point leaves either the
  // old state or the fully-verified new file, never a partial.
  await atomicWrite(dest, buf);
  status('ready');
  return dest;
}

/** Lazily resolves electron.utilityProcess so this module loads under plain
 * node (Jest); only the real main process ever calls this default. */
function defaultUtilityProcessFactory() {
  const { utilityProcess } = require('electron');
  return utilityProcess.fork(path.join(__dirname, 'stemHost.cjs'), [], {
    serviceName: 'Auditorium stem separation',
  });
}

/**
 * Creates the manager. All electron/network/fs dependencies are injectable;
 * production wiring passes only { userDataDir }.
 */
function createStemManager({
  userDataDir,
  utilityProcessFactory = defaultUtilityProcessFactory,
  expectedSha256 = MODEL_SHA256,
  expectedBytes = MODEL_BYTES,
  requestImpl,
  sleep,
  url,
  fsImpl = fs,
  atomicWrite = atomicWriteFile,
} = {}) {
  let active = null; // { runId, child, settled, settle }
  let nextRunId = 1;
  /** Fix round 1, LOW: dispose is a LATCH — set once on app quit, never
   * cleared. It refuses new runs and aborts an in-flight model download. */
  let disposed = false;
  const verifyOpts = { expectedSha256, expectedBytes, fsImpl };

  function isRunning() {
    return active !== null;
  }

  async function getModelState() {
    const dest = getModelPath(userDataDir);
    try {
      const stat = await fsImpl.promises.stat(dest);
      return { downloaded: stat.size === expectedBytes, bytes: stat.size, expectedBytes };
    } catch {
      return { downloaded: false, bytes: null, expectedBytes };
    }
  }

  function managerEnsureModel({ onProgress, onStatus } = {}) {
    return ensureModel({
      userDataDir,
      onProgress,
      onStatus,
      expectedSha256,
      expectedBytes,
      requestImpl,
      sleep,
      url,
      fsImpl,
      atomicWrite,
      shouldAbort: () => disposed,
    });
  }

  /**
   * Runs one separation end-to-end against an already-downloaded model.
   * Resolves (never rejects):
   *   {ok:true, totalSegments} | {ok:false, cancelled:true} | {ok:false, error}
   * `channels`: planar Float32Array[1|2] at MODEL_SAMPLE_RATE.
   * `onProgress({segment,totalSegments})`, `onStems({offset,samples,data})`
   * stream while in flight; neither is ever called after settlement.
   */
  async function startSeparation({ modelPath, sampleRate, channels, onProgress, onStems }) {
    if (disposed) {
      return { ok: false, error: 'stem manager disposed (app is quitting)' };
    }
    if (active) {
      return { ok: false, error: 'a separation is already running (busy)' };
    }
    // Reserve the active slot SYNCHRONOUSLY, before the (async) sha256
    // verification: two overlapping calls must never both pass the busy gate
    // and spawn two children, and cancel()/dispose() arriving while the
    // verification is still hashing must already have something to settle.
    const runId = nextRunId++;
    const entry = { runId, child: null, settled: false, resolve: null, result: null, settle: null };
    entry.settle = (result) => {
      if (entry.settled) return;
      entry.settled = true;
      entry.result = result;
      if (active === entry) active = null;
      if (entry.child) {
        try {
          entry.child.kill();
        } catch {
          // already dead — the point was that it isn't alive after this line
        }
      }
      if (entry.resolve) entry.resolve(result);
    };
    active = entry;

    const resolvedModelPath = modelPath || getModelPath(userDataDir);
    // Ruling 3: sha256-verified before ANY load — the utility process is not
    // even spawned for a file that fails the pin.
    const v = await verifyModelFile(resolvedModelPath, verifyOpts);
    if (entry.settled) return entry.result; // cancelled/disposed mid-verify
    if (!v.ok) {
      entry.settle({
        ok: false,
        error: `model verification failed (${v.reason}: ${v.detail}) — re-download required`,
      });
      return entry.result;
    }

    let child;
    try {
      child = utilityProcessFactory();
    } catch (err) {
      entry.settle({
        ok: false,
        error: `failed to spawn stem host: ${err instanceof Error ? err.message : String(err)}`,
      });
      return entry.result;
    }
    entry.child = child;

    const totalSamples = channels[0].length;
    return new Promise((resolve) => {
      entry.resolve = resolve;

      child.on('message', (msg) => {
        if (entry.settled) return; // T13: a settled run's chatter is dropped
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
        switch (msg.type) {
          case 'ready': {
            child.postMessage({
              type: 'separate',
              id: runId,
              sampleRate,
              channelCount: channels.length,
              totalSamples,
            });
            for (let offset = 0; offset < totalSamples; offset += AUDIO_SLICE_SAMPLES) {
              const end = Math.min(offset + AUDIO_SLICE_SAMPLES, totalSamples);
              child.postMessage({
                type: 'audio',
                id: runId,
                offset,
                // .slice (copy), NOT .subarray: structured clone serialises a
                // view's ENTIRE underlying buffer, so a subarray would re-copy
                // the whole track once per slice message.
                channels: channels.map((ch) => ch.slice(offset, end)),
              });
            }
            child.postMessage({ type: 'run', id: runId });
            break;
          }
          case 'progress':
            if (msg.id === runId && onProgress) {
              onProgress({ segment: msg.segment, totalSegments: msg.totalSegments });
            }
            break;
          case 'stems':
            if (msg.id === runId && onStems) {
              onStems({ offset: msg.offset, samples: msg.samples, data: msg.data });
            }
            break;
          case 'done':
            if (msg.id === runId) entry.settle({ ok: true, totalSegments: msg.totalSegments });
            break;
          case 'cancelled':
            if (msg.id === runId) entry.settle({ ok: false, cancelled: true });
            break;
          case 'error':
            // Fix round 1, LOW: id-gated like every other message type — a
            // stale job's error must not settle the current run. Host-level
            // errors (init/protocol stages) legitimately carry no id and DO
            // settle: there is no other job they could belong to.
            if (msg.id === undefined || msg.id === runId) {
              entry.settle({ ok: false, error: msg.message || 'stem host error' });
            }
            break;
          default:
            break; // unknown host message: ignore, never crash
        }
      });

      child.on('exit', (code) => {
        entry.settle({ ok: false, error: `stem host exited unexpectedly (code ${code})` });
      });

      child.postMessage({ type: 'init', modelPath: resolvedModelPath });
    });
  }

  /** Ruling 7: Cancel kills the utility process — instantaneous, regardless
   * of where inference is. Returns whether a run was actually cancelled. */
  function cancel() {
    if (!active) return false;
    active.settle({ ok: false, cancelled: true });
    return true;
  }

  /** App-quit path (main.cjs 'will-quit'): no orphan process, ever, and no
   * further work — the latch refuses new runs and aborts an in-flight
   * model download. */
  function dispose() {
    disposed = true;
    cancel();
  }

  return {
    ensureModel: managerEnsureModel,
    getModelState,
    startSeparation,
    cancel,
    isRunning,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// Renderer-facing IPC (contract documented in the module header)
// ---------------------------------------------------------------------------

const MODEL_PROGRESS_THROTTLE_MS = 200;

/** Validates the renderer's separate request at the trust boundary. Returns
 * Float32Array channels or null. */
function parseSeparateRequest(req) {
  if (!req || typeof req !== 'object') return null;
  if (req.sampleRate !== MODEL_SAMPLE_RATE) return null;
  const { channels } = req;
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2) return null;
  // Brand check, not instanceof: an ArrayBuffer that crossed a realm
  // boundary (structured clone, vm context) fails instanceof against this
  // realm's constructor while still being a genuine ArrayBuffer.
  if (!channels.every((b) => Object.prototype.toString.call(b) === '[object ArrayBuffer]')) return null;
  const byteLength = channels[0].byteLength;
  if (byteLength === 0 || byteLength % 4 !== 0) return null;
  if (!channels.every((b) => b.byteLength === byteLength)) return null;
  if (byteLength / 4 > MAX_REQUEST_SAMPLES) return null;
  return channels.map((b) => new Float32Array(b));
}

function registerStemIpc({ ipcMain, manager, getWin }) {
  const send = (channel, payload) => {
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  ipcMain.handle(STEM_IPC.modelState, async () => manager.getModelState());

  ipcMain.handle(STEM_IPC.ensureModel, async () => {
    try {
      let lastSent = 0;
      const modelPath = await manager.ensureModel({
        onProgress: (p) => {
          const now = Date.now();
          // Throttled: a 166 MB download emits thousands of chunks; the
          // renderer needs a progress bar, not an event flood.
          if (now - lastSent >= MODEL_PROGRESS_THROTTLE_MS || p.received === p.total) {
            lastSent = now;
            send(STEM_IPC.modelProgress, { received: p.received, total: p.total });
          }
        },
      });
      return { ok: true, path: modelPath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(STEM_IPC.separate, async (_event, req) => {
    const channels = parseSeparateRequest(req);
    if (!channels) {
      return { ok: false, error: 'invalid separate request (expected {sampleRate:44100, channels:ArrayBuffer[1|2]})' };
    }
    return manager.startSeparation({
      sampleRate: MODEL_SAMPLE_RATE,
      channels,
      onProgress: (p) => send(STEM_IPC.progress, p),
      onStems: (c) => {
        // Re-wrap as a bare ArrayBuffer: the payload came from the utility
        // process as a Float32Array; the renderer contract is a transferable
        // buffer + explicit layout metadata.
        const buf = c.data.buffer.slice(c.data.byteOffset, c.data.byteOffset + c.data.byteLength);
        send(STEM_IPC.chunk, { offset: c.offset, samples: c.samples, data: buf });
      },
    });
  });

  ipcMain.handle(STEM_IPC.cancel, async () => ({ cancelled: manager.cancel() }));
}

module.exports = {
  MODEL_URL,
  MODEL_SHA256,
  MODEL_BYTES,
  MODEL_FILENAME,
  MODEL_DIR,
  STEM_IPC,
  getModelPath,
  verifyModelFile,
  downloadModel,
  ensureModel,
  createStemManager,
  registerStemIpc,
};
