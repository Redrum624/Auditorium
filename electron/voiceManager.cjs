'use strict';

/**
 * Main-process owner of the voice changer (F3): download/verification of the
 * two-file OpenVoice V2 model set, the lifetime of the inference utility
 * process (voiceHost.cjs), and the on-disk voice-profile store. This is
 * transcribeManager.cjs's proven shape — it deliberately REUSES
 * stemManager.cjs's exported `verifyModelFile` and `downloadModel` rather
 * than reimplementing the pin/retry/oversize/abort machinery.
 *
 * Nothing is bundled; both files are downloaded on first use into
 * `userData/models/voice/`, sha256+size verified BEFORE ANY LOAD (and
 * re-verified before every run), committed via the atomic temp+rename
 * pattern, deleted and re-downloaded on mismatch.
 *
 * ## The pinned file set (chosen and hashed in the F3 spike, 2026-08-10)
 *
 * OpenVoice V2 tone-colour converter, ONNX export
 * (`Hinotsuba/OpenVoice-ONNX-v2`, MIT — "Free for commercial use", following
 * the official OpenVoice V2 licence; upstream weights `myshell-ai/OpenVoiceV2`
 * are MIT and ungated). The export is third-party, which is exactly why the
 * sha256 pins below are load-bearing: they pin the app to the bytes the spike
 * measured and verified, not to whatever the repo serves tomorrow.
 *
 * ## Renderer IPC contract
 *
 *   invoke 'voice:model-state'    → {downloaded, bytes, expectedBytes}
 *   invoke 'voice:ensure-models'  → {ok:true} | {ok:false, error}
 *       Progress streams as 'voice:model-progress' {file, fileIndex,
 *       fileCount, received, total} (throttled), received/total OVERALL.
 *   invoke 'voice:embed' {sampleRate:22050, samples:ArrayBuffer, consent:true}
 *       → {ok:true, vector:ArrayBuffer} | {ok:false, cancelled:true}
 *       | {ok:false, error}
 *       The whole-utterance tone embedding of a reference clip. `consent` is
 *       the F3 RULING's affirmation, REQUIRED at this trust boundary too —
 *       the renderer service gates it first with a friendly message; this
 *       gate exists so removing the UI gate cannot silently re-open the door.
 *   invoke 'voice:convert' {sampleRate:22050, samples:ArrayBuffer,
 *                           target:ArrayBuffer(1024 B), consent:true}
 *       → {ok:true, chunkCount, sanitisedSamples} | {ok:false,
 *          cancelled:true} | {ok:false, error}
 *       While in flight the window receives:
 *         'voice:progress' {stage:'embed'|'convert', done, total}   (chunks)
 *         'voice:chunk'    {offset, samples, data:ArrayBuffer}
 *   invoke 'voice:cancel'         → {cancelled:boolean}
 *       Kills the utility process — Cancel genuinely kills the work.
 *   invoke 'voice:profiles-load'  → {ok:true, profiles:[...]} | {ok:false,error}
 *   invoke 'voice:profiles-save' {profiles:[...]}
 *       → {ok:true} | {ok:false, error}
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { atomicWriteFile } = require('./atomicWrite.cjs');
const { verifyModelFile, downloadModel } = require('./stemManager.cjs');
const { MAX_TOTAL_SAMPLES, MAX_REFERENCE_SAMPLES, TONE_EMBEDDING_SIZE } = require('./voiceHost.cjs');
const { VC_SAMPLE_RATE, MIN_INPUT_SAMPLES } = require('./voiceChunking.cjs');

/** sha256/size pins — recorded in the F3 spike from the exact files whose
 * output was verified (real audio out, cross-provider agreement within 2 LSB,
 * round-2 speaker-identity verdict). */
const VOICE_FILES = Object.freeze([
  {
    key: 'converter',
    filename: 'tone_color.onnx',
    url: 'https://huggingface.co/Hinotsuba/OpenVoice-ONNX-v2/resolve/main/tone_color.onnx',
    sha256: '896195b84b0cb87a828bb8cab06577e9c024356bc9727b1a8f4174154bc0affa',
    bytes: 157196170,
  },
  {
    key: 'extractor',
    filename: 'tone_extract.onnx',
    url: 'https://huggingface.co/Hinotsuba/OpenVoice-ONNX-v2/resolve/main/tone_extract.onnx',
    sha256: 'e91c2cb696e199d2519ed8b62ca6e3c8e42cb99ca13955dd6e188051486e681c',
    bytes: 3364792,
  },
]);

const VOICE_TOTAL_BYTES = VOICE_FILES.reduce((n, f) => n + f.bytes, 0);
const VOICE_MODEL_DIR = path.join('models', 'voice');
const VOICE_PROFILES_FILENAME = 'voice-profiles.json';

/** ~4 MB of samples per 'audio' message (structured clone copies) — the same
 * slice size the stem and transcription managers use. */
const AUDIO_SLICE_SAMPLES = 1 << 20;
const MODEL_PROGRESS_THROTTLE_MS = 200;

/** Trust-boundary cap on the profile store. Arithmetic, not taste: one
 * profile serialises to ~5 KB of JSON (256 embedding floats at ~18 chars
 * each, plus name/id), so 200 profiles ≈ 1 MB — read whole at startup in one
 * cheap gulp, and far beyond any real personal voice library. Above the cap
 * the SAVE is refused (never silently truncated). */
const MAX_VOICE_PROFILES = 200;
/** Bounds on user-supplied profile strings, so a hostile save cannot park
 * megabytes inside a "name". */
const MAX_PROFILE_STRING = 200;

const VOICE_IPC = Object.freeze({
  modelState: 'voice:model-state',
  ensureModels: 'voice:ensure-models',
  modelProgress: 'voice:model-progress',
  embed: 'voice:embed',
  convert: 'voice:convert',
  cancel: 'voice:cancel',
  progress: 'voice:progress',
  chunk: 'voice:chunk',
  profilesLoad: 'voice:profiles-load',
  profilesSave: 'voice:profiles-save',
});

/** Maps file keys to on-disk destinations (transcribeManager's contract: any
 * caller injecting `files` must pass the same set here). */
function getVoiceModelPaths(userDataDir, files = VOICE_FILES) {
  const dir = path.join(userDataDir, VOICE_MODEL_DIR);
  const paths = {};
  for (const f of files) paths[f.key] = path.join(dir, f.filename);
  return paths;
}

function getVoiceProfilesPath(userDataDir) {
  return path.join(userDataDir, VOICE_PROFILES_FILENAME);
}

/**
 * Verifies-or-downloads the file set, reporting OVERALL bytes — the exact
 * shape of ensureTranscriptionModels with the voice pins.
 */
async function ensureVoiceModels({
  userDataDir,
  onProgress,
  onStatus,
  files = VOICE_FILES,
  requestImpl,
  sleep,
  fsImpl = fs,
  atomicWrite = atomicWriteFile,
  shouldAbort = () => false,
} = {}) {
  const dir = path.join(userDataDir, VOICE_MODEL_DIR);
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
  return getVoiceModelPaths(userDataDir, files);
}

// ---------------------------------------------------------------------------
// Voice profiles — validated on BOTH directions across the disk boundary.
// ---------------------------------------------------------------------------

/**
 * Validates one raw profile row from disk or from the renderer. Returns the
 * sanitised row or null. The embedding must be exactly 256 finite numbers —
 * anything else would poison a later conversion's dest_tone.
 */
function sanitizeVoiceProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { id, name, embedding, createdAt, sourceName } = raw;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_PROFILE_STRING) return null;
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > MAX_PROFILE_STRING) return null;
  if (!Array.isArray(embedding) || embedding.length !== TONE_EMBEDDING_SIZE) return null;
  const vector = new Array(TONE_EMBEDDING_SIZE);
  for (let i = 0; i < embedding.length; i++) {
    const v = embedding[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    vector[i] = v;
  }
  return {
    id,
    name: name.trim(),
    embedding: vector,
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    sourceName: typeof sourceName === 'string' ? sourceName.slice(0, MAX_PROFILE_STRING) : '',
  };
}

/**
 * Reads the profile store. A missing file is an empty store; a corrupt file
 * or row is DROPPED row-by-row rather than nuking the library (the file is
 * user-reachable on disk, so partial corruption is a normal condition, not an
 * exception).
 */
async function loadVoiceProfiles({ userDataDir, fsImpl = fs } = {}) {
  const file = getVoiceProfilesPath(userDataDir);
  let text;
  try {
    text = await fsImpl.promises.readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, profiles: [] };
    return { ok: false, error: `could not read ${VOICE_PROFILES_FILENAME}: ${err.code || err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `${VOICE_PROFILES_FILENAME} is not valid JSON — profiles unavailable` };
  }
  const rows = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
  const profiles = [];
  for (const row of rows) {
    if (profiles.length >= MAX_VOICE_PROFILES) break;
    const clean = sanitizeVoiceProfile(row);
    if (clean) profiles.push(clean);
  }
  return { ok: true, profiles };
}

/** Validates and atomically writes the whole store. Refuses (never truncates)
 * an over-cap or invalid payload. */
async function saveVoiceProfiles({ userDataDir, profiles, fsImpl = fs, atomicWrite = atomicWriteFile } = {}) {
  if (!Array.isArray(profiles)) return { ok: false, error: 'profiles must be an array' };
  if (profiles.length > MAX_VOICE_PROFILES) {
    return { ok: false, error: `profile store is capped at ${MAX_VOICE_PROFILES} voices` };
  }
  const clean = [];
  const seen = new Set();
  for (const row of profiles) {
    const c = sanitizeVoiceProfile(row);
    if (!c) return { ok: false, error: 'a profile row is malformed — nothing was saved' };
    if (seen.has(c.id)) return { ok: false, error: `duplicate profile id ${c.id} — nothing was saved` };
    seen.add(c.id);
    clean.push(c);
  }
  const file = getVoiceProfilesPath(userDataDir);
  try {
    await fsImpl.promises.mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, Buffer.from(JSON.stringify({ version: 1, profiles: clean }), 'utf8'));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `could not save profiles: ${err.code || err.message}` };
  }
}

// ---------------------------------------------------------------------------
// The manager — transcribeManager's T13 worker choreography verbatim.
// ---------------------------------------------------------------------------

/** Lazily resolves electron.utilityProcess (plain-node/Jest safe). */
function defaultUtilityProcessFactory() {
  const { utilityProcess } = require('electron');
  return utilityProcess.fork(path.join(__dirname, 'voiceHost.cjs'), [], {
    serviceName: 'Auditorium voice changer',
  });
}

function createVoiceManager({
  userDataDir,
  utilityProcessFactory = defaultUtilityProcessFactory,
  files = VOICE_FILES,
  requestImpl,
  sleep,
  fsImpl = fs,
  atomicWrite = atomicWriteFile,
  onWarn = (msg) => console.warn(msg),
} = {}) {
  let active = null;
  let nextRunId = 1;
  let disposed = false; // latch, set once on app quit

  function isRunning() {
    return active !== null;
  }

  async function getModelState() {
    const paths = getVoiceModelPaths(userDataDir, files);
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
    return ensureVoiceModels({
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
   * Shared single-slot run start: reserves the slot SYNCHRONOUSLY, verifies
   * every pin, spawns the child and wires the message pump. `openMessage`
   * builds the job-opening message once the host is ready; `handlers` maps
   * job-specific host messages. Settle discipline (settle-once, kill on every
   * terminal branch, kill-retry then WARN) is transcribeManager's verbatim.
   */
  function startRun({ label, samples, openMessage, onProgress, onChunk, onEmbedded }) {
    if (disposed) {
      return Promise.resolve({ ok: false, error: `voice manager disposed (app is quitting)` });
    }
    if (active) {
      return Promise.resolve({ ok: false, error: `a voice ${label} is already running (busy)` });
    }
    const runId = nextRunId++;
    const entry = { runId, child: null, settled: false, resolve: null, result: null, settle: null };
    entry.settle = (result) => {
      if (entry.settled) return;
      entry.settled = true;
      entry.result = result;
      if (active === entry) active = null;
      if (entry.child) {
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
            `voice host for run ${entry.runId} did not respond to kill — its ONNX Runtime arena may still be resident`
          );
        }
      }
      if (entry.resolve) entry.resolve(result);
    };
    active = entry;

    return (async () => {
      const paths = getVoiceModelPaths(userDataDir, files);
      // Every file sha256-verified before ANY load — the utility process is
      // not spawned for a set that fails a single pin.
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
          error: `failed to spawn voice host: ${err instanceof Error ? err.message : String(err)}`,
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
              child.postMessage(openMessage(runId));
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
            case 'chunk':
              if (msg.id === runId && onChunk) {
                onChunk({ offset: msg.offset, samples: msg.samples, data: msg.data });
              }
              break;
            case 'embedded':
              // The embed job's TERMINAL message (convert jobs settle on
              // 'done'; each job kind only ever emits its own terminal).
              if (msg.id === runId) {
                if (onEmbedded) onEmbedded(msg.vector);
                entry.settle({ ok: true });
              }
              break;
            case 'done':
              if (msg.id === runId) {
                entry.settle({ ok: true, chunkCount: msg.chunkCount, sanitisedSamples: msg.sanitisedSamples });
              }
              break;
            case 'cancelled':
              if (msg.id === runId) entry.settle({ ok: false, cancelled: true });
              break;
            case 'error':
              // id-gated; host-level errors (init/protocol) carry no id and
              // DO settle — there is no other job they could belong to.
              if (msg.id === undefined || msg.id === runId) {
                entry.settle({ ok: false, error: msg.message || 'voice host error' });
              }
              break;
            default:
              break; // unknown host message: ignore, never crash
          }
        });

        child.on('exit', (code) => {
          entry.settle({ ok: false, error: `voice host exited unexpectedly (code ${code})` });
        });

        child.postMessage({ type: 'init', paths });
      });
    })();
  }

  /**
   * Whole-utterance reference embedding. Resolves (never rejects):
   *   {ok:true, vector:Float32Array} | {ok:false, cancelled:true}
   *   | {ok:false, error}
   */
  async function startEmbed({ samples, onProgress }) {
    let vector = null;
    const result = await startRun({
      label: 'embedding',
      samples,
      openMessage: (id) => ({ type: 'embed', id, totalSamples: samples.length }),
      onProgress,
      onEmbedded: (v) => {
        vector = v;
      },
    });
    if (!result.ok) return result;
    if (!vector || vector.length !== TONE_EMBEDDING_SIZE) {
      // 'done' settled without a vector — a host-contract violation.
      return { ok: false, error: 'voice host finished without delivering an embedding' };
    }
    return { ok: true, vector };
  }

  /**
   * Chunked conversion. Resolves (never rejects):
   *   {ok:true, chunkCount, sanitisedSamples} | {ok:false, cancelled:true}
   *   | {ok:false, error}
   */
  function startConversion({ samples, targetVector, onProgress, onChunk }) {
    return startRun({
      label: 'conversion',
      samples,
      openMessage: (id) => ({
        type: 'convert',
        id,
        totalSamples: samples.length,
        targetVector,
      }),
      onProgress,
      onChunk,
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
    startEmbed,
    startConversion,
    loadProfiles: () => loadVoiceProfiles({ userDataDir, fsImpl }),
    saveProfiles: (profiles) => saveVoiceProfiles({ userDataDir, profiles, fsImpl, atomicWrite }),
    cancel,
    isRunning,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// Renderer-facing IPC
// ---------------------------------------------------------------------------

/** Shared by both request parsers so they cannot disagree on what a valid
 * sample payload is. */
function parseSamples(samples, minSamples, maxSamples) {
  if (Object.prototype.toString.call(samples) !== '[object ArrayBuffer]') return null;
  if (samples.byteLength === 0 || samples.byteLength % 4 !== 0) return null;
  const count = samples.byteLength / 4;
  if (count < minSamples || count > maxSamples) return null;
  return new Float32Array(samples);
}

/**
 * Validates the renderer's embed request at the trust boundary. Returns
 * {samples} or null. `consent === true` is REQUIRED — the F3 consent RULING,
 * enforced below the UI so removing the dialog gate cannot re-open the door.
 * `maxSamples` is a parameter only so the boundary can be probed without
 * allocating the 30 MB the real cap implies.
 */
function parseVoiceEmbedRequest(req, maxSamples = MAX_REFERENCE_SAMPLES) {
  if (!req || typeof req !== 'object') return null;
  if (req.consent !== true) return null;
  if (req.sampleRate !== VC_SAMPLE_RATE) return null;
  const samples = parseSamples(req.samples, MIN_INPUT_SAMPLES, maxSamples);
  if (!samples) return null;
  return { samples };
}

/**
 * Validates the renderer's convert request. Returns {samples, target} or
 * null. Same consent rule; the target must be exactly 256 finite float32s.
 */
function parseVoiceConvertRequest(req, maxSamples = MAX_TOTAL_SAMPLES) {
  if (!req || typeof req !== 'object') return null;
  if (req.consent !== true) return null;
  if (req.sampleRate !== VC_SAMPLE_RATE) return null;
  const samples = parseSamples(req.samples, MIN_INPUT_SAMPLES, maxSamples);
  if (!samples) return null;
  if (Object.prototype.toString.call(req.target) !== '[object ArrayBuffer]') return null;
  if (req.target.byteLength !== TONE_EMBEDDING_SIZE * 4) return null;
  const target = new Float32Array(req.target);
  for (let i = 0; i < target.length; i++) {
    if (!Number.isFinite(target[i])) return null;
  }
  return { samples, target };
}

function registerVoiceIpc({ ipcMain, manager, getWin }) {
  const send = (channel, payload) => {
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  ipcMain.handle(VOICE_IPC.modelState, async () => manager.getModelState());

  ipcMain.handle(VOICE_IPC.ensureModels, async () => {
    try {
      let lastSent = 0;
      await manager.ensureModels({
        onProgress: (p) => {
          const now = Date.now();
          if (now - lastSent >= MODEL_PROGRESS_THROTTLE_MS || p.received === p.total) {
            lastSent = now;
            send(VOICE_IPC.modelProgress, p);
          }
        },
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(VOICE_IPC.embed, async (_event, req) => {
    const parsed = parseVoiceEmbedRequest(req);
    if (!parsed) {
      return {
        ok: false,
        error:
          "invalid voice embed request (expected {sampleRate:22050, samples:ArrayBuffer, consent:true} — the consent affirmation is required)",
      };
    }
    const result = await manager.startEmbed({ samples: parsed.samples });
    if (!result.ok) return result;
    const v = result.vector;
    const buf = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
    return { ok: true, vector: buf };
  });

  ipcMain.handle(VOICE_IPC.convert, async (_event, req) => {
    const parsed = parseVoiceConvertRequest(req);
    if (!parsed) {
      return {
        ok: false,
        error:
          "invalid voice convert request (expected {sampleRate:22050, samples:ArrayBuffer, target:ArrayBuffer, consent:true} — the consent affirmation is required)",
      };
    }
    return manager.startConversion({
      samples: parsed.samples,
      targetVector: parsed.target,
      onProgress: (p) => send(VOICE_IPC.progress, p),
      onChunk: (c) => {
        const d = c.data;
        const buf = d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
        send(VOICE_IPC.chunk, { offset: c.offset, samples: c.samples, data: buf });
      },
    });
  });

  ipcMain.handle(VOICE_IPC.cancel, async () => ({ cancelled: manager.cancel() }));

  ipcMain.handle(VOICE_IPC.profilesLoad, async () => manager.loadProfiles());

  ipcMain.handle(VOICE_IPC.profilesSave, async (_event, req) => {
    if (!req || typeof req !== 'object' || !Array.isArray(req.profiles)) {
      return { ok: false, error: 'invalid profiles-save request (expected {profiles:[...]})' };
    }
    return manager.saveProfiles(req.profiles);
  });
}

module.exports = {
  VOICE_FILES,
  VOICE_TOTAL_BYTES,
  VOICE_MODEL_DIR,
  VOICE_PROFILES_FILENAME,
  VOICE_IPC,
  MAX_VOICE_PROFILES,
  getVoiceModelPaths,
  getVoiceProfilesPath,
  ensureVoiceModels,
  sanitizeVoiceProfile,
  loadVoiceProfiles,
  saveVoiceProfiles,
  createVoiceManager,
  registerVoiceIpc,
  parseVoiceEmbedRequest,
  parseVoiceConvertRequest,
};
