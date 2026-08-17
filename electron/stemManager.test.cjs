'use strict';

/**
 * Tests for the main-side stem-separation owner (S1): model download with
 * retry + sha256 pin + atomic write, verification-before-any-load, utility
 * process lifecycle (spawn, stream, cancel = kill, unexpected exit), and the
 * renderer-facing IPC contract. Everything electron-specific is injected —
 * the real wiring is exercised by the packaged-app selftest driver.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const {
  MODEL_URL,
  MODEL_SHA256,
  MODEL_BYTES,
  MODEL_FILENAME,
  STEM_IPC,
  getModelPath,
  verifyModelFile,
  downloadModel,
  ensureModel,
  createStemManager,
  registerStemIpc,
} = require('./stemManager.cjs');
const { MODEL_SAMPLE_RATE } = require('./stemSegmentation.cjs');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stem-mgr-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const FAKE_MODEL = Buffer.from('this is a tiny stand-in model file for hash tests');
const FAKE_SHA = sha256(FAKE_MODEL);

describe('pins and paths', () => {
  test('the sha256/size/URL pins are the plan ruling-3 values', () => {
    expect(MODEL_SHA256).toBe('d05c269d0178d2a72ad484b10b11dd370193fc923201c3b27a99f848745db70a');
    expect(MODEL_BYTES).toBe(165612636);
    expect(MODEL_URL).toBe(
      'https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/main/htdemucs_fp16weights.onnx'
    );
    expect(MODEL_FILENAME).toBe('htdemucs_fp16weights.onnx');
  });

  test('getModelPath lands in userData/models/', () => {
    expect(getModelPath('C:/ud')).toBe(path.join('C:/ud', 'models', 'htdemucs_fp16weights.onnx'));
  });
});

describe('verifyModelFile', () => {
  test('missing file', async () => {
    const r = await verifyModelFile(path.join(tmpDir, 'absent.onnx'));
    expect(r).toMatchObject({ ok: false, reason: 'missing' });
  });

  test('size mismatch fails fast without hashing', async () => {
    const p = path.join(tmpDir, 'model.onnx');
    fs.writeFileSync(p, FAKE_MODEL);
    const r = await verifyModelFile(p, { expectedSha256: FAKE_SHA, expectedBytes: FAKE_MODEL.length + 1 });
    expect(r).toMatchObject({ ok: false, reason: 'size' });
  });

  test('sha mismatch', async () => {
    const p = path.join(tmpDir, 'model.onnx');
    fs.writeFileSync(p, FAKE_MODEL);
    const r = await verifyModelFile(p, { expectedSha256: 'ab'.repeat(32), expectedBytes: FAKE_MODEL.length });
    expect(r).toMatchObject({ ok: false, reason: 'sha256' });
  });

  test('valid file', async () => {
    const p = path.join(tmpDir, 'model.onnx');
    fs.writeFileSync(p, FAKE_MODEL);
    const r = await verifyModelFile(p, { expectedSha256: FAKE_SHA, expectedBytes: FAKE_MODEL.length });
    expect(r).toEqual({ ok: true });
  });
});

/** requestImpl stub: each call consumes the next scripted behaviour. */
function scriptedRequests(script) {
  const calls = [];
  const impl = async (url, { onTotal, onData }) => {
    calls.push(url);
    const step = script.shift();
    if (!step) throw new Error('unscripted request');
    if (step.total !== undefined) onTotal(step.total);
    for (const chunk of step.chunks || []) onData(chunk);
    if (step.fail) throw new Error(step.fail);
  };
  impl.calls = calls;
  return impl;
}

describe('downloadModel', () => {
  test('concatenates chunks and reports progress', async () => {
    const half = FAKE_MODEL.subarray(0, 20);
    const rest = FAKE_MODEL.subarray(20);
    const progress = [];
    const buf = await downloadModel({
      requestImpl: scriptedRequests([{ total: FAKE_MODEL.length, chunks: [half, rest] }]),
      onProgress: (p) => progress.push({ ...p }),
    });
    expect(Buffer.compare(buf, FAKE_MODEL)).toBe(0);
    expect(progress[0]).toEqual({ received: 20, total: FAKE_MODEL.length });
    expect(progress[progress.length - 1]).toEqual({ received: FAKE_MODEL.length, total: FAKE_MODEL.length });
  });

  test('retries after failures, restarting from scratch, and succeeds', async () => {
    const sleeps = [];
    const impl = scriptedRequests([
      { total: 100, chunks: [Buffer.from('partial-junk')], fail: 'ECONNRESET' },
      { fail: 'ETIMEDOUT' },
      { total: FAKE_MODEL.length, chunks: [FAKE_MODEL] },
    ]);
    const buf = await downloadModel({
      requestImpl: impl,
      sleep: async (ms) => sleeps.push(ms),
    });
    expect(Buffer.compare(buf, FAKE_MODEL)).toBe(0);
    expect(impl.calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2); // backed off between attempts
  });

  test('throws after all attempts fail, naming the attempt count', async () => {
    const impl = scriptedRequests([{ fail: 'offline' }, { fail: 'offline' }, { fail: 'offline' }]);
    await expect(
      downloadModel({ requestImpl: impl, sleep: async () => {} })
    ).rejects.toThrow(/3 attempts.*offline/s);
    expect(impl.calls).toHaveLength(3);
  });

  // Fix round 1, MED-3: a hostile/broken server must not be able to balloon
  // main-process memory — the download aborts the moment it exceeds the pin.
  test('aborts as soon as streamed bytes exceed the pinned size — no retry, no buffering-on', async () => {
    const impl = scriptedRequests([
      {
        total: 10,
        chunks: [Buffer.alloc(10), Buffer.alloc(10), Buffer.alloc(10_000)], // lies, then streams on
      },
    ]);
    await expect(
      downloadModel({ requestImpl: impl, maxBytes: 10, sleep: async () => {} })
    ).rejects.toThrow(/exceed.*pinned|pinned.*exceed/is);
    expect(impl.calls).toHaveLength(1); // oversize is NOT retryable
  });

  test('aborts immediately when content-length already exceeds the pin', async () => {
    const impl = scriptedRequests([{ total: 999_999_999, chunks: [Buffer.alloc(4)] }]);
    await expect(
      downloadModel({ requestImpl: impl, maxBytes: 100, sleep: async () => {} })
    ).rejects.toThrow(/exceed.*pinned|pinned.*exceed/is);
    expect(impl.calls).toHaveLength(1);
  });
});

describe('ensureModel', () => {
  const opts = () => ({
    userDataDir: tmpDir,
    expectedSha256: FAKE_SHA,
    expectedBytes: FAKE_MODEL.length,
    sleep: async () => {},
  });

  test('a valid existing file short-circuits (no network)', async () => {
    const dest = getModelPath(tmpDir);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, FAKE_MODEL);
    const impl = scriptedRequests([]);
    const p = await ensureModel({ ...opts(), requestImpl: impl });
    expect(p).toBe(dest);
    expect(impl.calls).toHaveLength(0);
  });

  test('a corrupt existing file is DELETED and re-downloaded (ruling 3: mismatch deletes)', async () => {
    const dest = getModelPath(tmpDir);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.concat([FAKE_MODEL, Buffer.from('corruption')]));
    const statuses = [];
    const p = await ensureModel({
      ...opts(),
      requestImpl: scriptedRequests([{ total: FAKE_MODEL.length, chunks: [FAKE_MODEL] }]),
      onStatus: (s) => statuses.push(s),
    });
    expect(p).toBe(dest);
    expect(Buffer.compare(fs.readFileSync(dest), FAKE_MODEL)).toBe(0);
    expect(statuses).toContain('corrupt-deleted');
  });

  test('a downloaded payload failing the sha pin throws and writes NOTHING', async () => {
    const dest = getModelPath(tmpDir);
    // Right SIZE, wrong CONTENT — exercises the sha256 branch specifically
    // (a wrong-size payload trips the cheaper size check first).
    const corrupted = Buffer.from(FAKE_MODEL);
    corrupted[0] ^= 0xff;
    await expect(
      ensureModel({
        ...opts(),
        requestImpl: scriptedRequests([{ total: corrupted.length, chunks: [corrupted] }]),
      })
    ).rejects.toThrow(/sha256/i);
    expect(fs.existsSync(dest)).toBe(false);

    // And the size branch, for completeness.
    await expect(
      ensureModel({
        ...opts(),
        requestImpl: scriptedRequests([{ total: 5, chunks: [Buffer.from('wrong')] }]),
      })
    ).rejects.toThrow(/size/i);
    expect(fs.existsSync(dest)).toBe(false);
  });

  test('an interrupted download (app-quit shape) leaves no partial or temp file', async () => {
    // The connection dies mid-stream — the same on-disk outcome as the app
    // quitting mid-download: nothing has been written at the destination
    // because the file only ever appears via the atomic temp+rename commit
    // AFTER full verification.
    const dest = getModelPath(tmpDir);
    await expect(
      ensureModel({
        ...opts(),
        requestImpl: scriptedRequests([
          { total: FAKE_MODEL.length, chunks: [FAKE_MODEL.subarray(0, 10)], fail: 'connection lost' },
          { fail: 'connection lost' },
          { fail: 'connection lost' },
        ]),
      })
    ).rejects.toThrow(/connection lost/);
    expect(fs.existsSync(dest)).toBe(false);
    // No stray temp files anywhere under userData.
    const entries = fs.existsSync(path.dirname(dest)) ? fs.readdirSync(path.dirname(dest)) : [];
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
  });

  test('the committed file verifies on disk after download', async () => {
    const dest = getModelPath(tmpDir);
    await ensureModel({
      ...opts(),
      requestImpl: scriptedRequests([{ total: FAKE_MODEL.length, chunks: [FAKE_MODEL] }]),
    });
    const v = await verifyModelFile(dest, { expectedSha256: FAKE_SHA, expectedBytes: FAKE_MODEL.length });
    expect(v).toEqual({ ok: true });
  });

  test('a stream that overruns the pinned size aborts (ensureModel wires the pin as the cap)', async () => {
    const dest = getModelPath(tmpDir);
    await expect(
      ensureModel({
        ...opts(),
        requestImpl: scriptedRequests([
          { total: FAKE_MODEL.length, chunks: [FAKE_MODEL, Buffer.from('overrun-bytes')] },
        ]),
      })
    ).rejects.toThrow(/exceed.*pinned|pinned.*exceed/is);
    expect(fs.existsSync(dest)).toBe(false);
  });

  // Fix round 1, LOW-5: a corrupt model behind a file lock must surface the
  // intended message, not a raw EPERM.
  test('a corrupt model that cannot be deleted reports clearly', async () => {
    const dest = getModelPath(tmpDir);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.concat([FAKE_MODEL, Buffer.from('corruption')]));
    const lockedFs = {
      ...fs,
      createReadStream: fs.createReadStream.bind(fs),
      promises: {
        ...fs.promises,
        unlink: async () => {
          const e = new Error('EPERM: operation not permitted');
          e.code = 'EPERM';
          throw e;
        },
      },
    };
    await expect(
      ensureModel({ ...opts(), fsImpl: lockedFs, requestImpl: scriptedRequests([]) })
    ).rejects.toThrow(/failed verification.*could not be deleted/is);
  });
});

// ---------------------------------------------------------------------------
// Utility-process lifecycle
// ---------------------------------------------------------------------------

/** Fake UtilityProcess child: records postMessage calls; the test emits
 * 'message'/'exit' events to script the host side. */
function fakeChild() {
  const child = new EventEmitter();
  child.sent = [];
  child.killed = false;
  child.postMessage = (msg) => child.sent.push(msg);
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

function managerWithChild({ verifyOk = true } = {}) {
  const children = [];
  const modelPath = path.join(tmpDir, 'models', MODEL_FILENAME);
  fs.mkdirSync(path.dirname(modelPath), { recursive: true });
  fs.writeFileSync(modelPath, FAKE_MODEL);
  const manager = createStemManager({
    userDataDir: tmpDir,
    expectedSha256: verifyOk ? FAKE_SHA : 'ff'.repeat(32),
    expectedBytes: FAKE_MODEL.length,
    utilityProcessFactory: () => {
      const c = fakeChild();
      children.push(c);
      return c;
    },
  });
  return { manager, children, modelPath };
}

function stereo(total) {
  return [new Float32Array(total), new Float32Array(total)];
}

async function tick() {
  await new Promise((r) => setTimeout(r, 0));
}

/** The pre-spawn sha256 verification is real async I/O — poll until the
 * child exists (or a condition holds) instead of guessing tick counts. */
async function waitUntil(cond, what = 'condition') {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`${what} never became true`);
}

describe('createStemManager.startSeparation', () => {
  test('verification failure never spawns a process ("before any load")', async () => {
    const { manager, children } = managerWithChild({ verifyOk: false });
    const result = await manager.startSeparation({ sampleRate: MODEL_SAMPLE_RATE, channels: stereo(100) });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/verif/i);
    expect(children).toHaveLength(0);
  });

  test('happy path: init → separate/audio/run stream, progress + stems forwarded, done resolves and kills', async () => {
    const { manager, children, modelPath } = managerWithChild();
    const progress = [];
    const stems = [];
    const total = 3_000_000; // forces multiple audio slices
    const channels = stereo(total);
    channels[0][12345] = 0.5;
    const done = manager.startSeparation({
      sampleRate: MODEL_SAMPLE_RATE,
      channels,
      onProgress: (p) => progress.push(p),
      onStems: (c) => stems.push(c),
    });
    expect(manager.isRunning()).toBe(true); // reserved synchronously
    await waitUntil(() => children.length === 1, 'child spawn');
    const child = children[0];
    expect(child.sent[0]).toEqual({ type: 'init', modelPath });

    child.emit('message', { type: 'ready' });
    await tick();
    const sep = child.sent.find((m) => m.type === 'separate');
    expect(sep).toMatchObject({ sampleRate: MODEL_SAMPLE_RATE, channelCount: 2, totalSamples: total });
    const jobId = sep.id;

    // The audio slices must tile [0, total) exactly, in order, as COPIES.
    const audio = child.sent.filter((m) => m.type === 'audio');
    expect(audio.length).toBeGreaterThan(1);
    let covered = 0;
    for (const a of audio) {
      expect(a.id).toBe(jobId);
      expect(a.offset).toBe(covered);
      expect(a.channels).toHaveLength(2);
      expect(a.channels[0].buffer).not.toBe(channels[0].buffer); // sliced copy, not a view
      covered += a.channels[0].length;
    }
    expect(covered).toBe(total);
    // Sample integrity across the slice boundary.
    const holder = audio.find((a) => 12345 >= a.offset && 12345 < a.offset + a.channels[0].length);
    expect(holder.channels[0][12345 - holder.offset]).toBe(0.5);

    expect(child.sent[child.sent.length - 1]).toEqual({ type: 'run', id: jobId });

    child.emit('message', { type: 'progress', id: jobId, segment: 1, totalSegments: 2 });
    const flushData = new Float32Array(8);
    child.emit('message', { type: 'stems', id: jobId, offset: 0, samples: 1, data: flushData });
    child.emit('message', { type: 'progress', id: jobId, segment: 2, totalSegments: 2 });
    child.emit('message', { type: 'done', id: jobId, totalSegments: 2 });

    const result = await done;
    expect(result).toEqual({ ok: true, totalSegments: 2 });
    expect(progress).toEqual([
      { segment: 1, totalSegments: 2 },
      { segment: 2, totalSegments: 2 },
    ]);
    expect(stems).toEqual([{ offset: 0, samples: 1, data: flushData }]);
    expect(child.killed).toBe(true);
    expect(manager.isRunning()).toBe(false);
  });

  test('a second run while one is active is refused as busy', async () => {
    const { manager } = managerWithChild();
    const first = manager.startSeparation({ sampleRate: MODEL_SAMPLE_RATE, channels: stereo(10) });
    await tick();
    const second = await manager.startSeparation({ sampleRate: MODEL_SAMPLE_RATE, channels: stereo(10) });
    expect(second).toMatchObject({ ok: false, error: expect.stringMatching(/busy/i) });
    manager.cancel();
    await first;
  });

  test('cancel kills the process and resolves cancelled (ruling 7)', async () => {
    const { manager, children } = managerWithChild();
    const done = manager.startSeparation({ sampleRate: MODEL_SAMPLE_RATE, channels: stereo(10) });
    await waitUntil(() => children.length === 1, 'child spawn');
    expect(manager.cancel()).toBe(true);
    const result = await done;
    expect(result).toEqual({ ok: false, cancelled: true });
    expect(children[0].killed).toBe(true);
    expect(manager.isRunning()).toBe(false);
    expect(manager.cancel()).toBe(false); // nothing left to cancel
  });

  test('messages from a settled run are dropped (no double settle, no late callbacks)', async () => {
    const { manager, children } = managerWithChild();
    const progress = [];
    const done = manager.startSeparation({
      sampleRate: MODEL_SAMPLE_RATE,
      channels: stereo(10),
      onProgress: (p) => progress.push(p),
    });
    await waitUntil(() => children.length === 1, 'child spawn');
    manager.cancel();
    await done;
    // Belated host chatter after the kill — T13 discipline: dropped.
    children[0].emit('message', { type: 'progress', id: 1, segment: 1, totalSegments: 1 });
    children[0].emit('message', { type: 'done', id: 1, totalSegments: 1 });
    children[0].emit('exit', 0);
    expect(progress).toEqual([]);
  });

  test('an unexpected child exit resolves with an error', async () => {
    const { manager, children } = managerWithChild();
    const done = manager.startSeparation({ sampleRate: MODEL_SAMPLE_RATE, channels: stereo(10) });
    await waitUntil(() => children.length === 1, 'child spawn');
    children[0].emit('exit', 3221225477);
    const result = await done;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exited.*3221225477/);
    expect(manager.isRunning()).toBe(false);
  });

  test('a host error message resolves with that error and kills', async () => {
    const { manager, children } = managerWithChild();
    const done = manager.startSeparation({ sampleRate: MODEL_SAMPLE_RATE, channels: stereo(10) });
    await waitUntil(() => children.length === 1, 'child spawn');
    children[0].emit('message', { type: 'error', stage: 'run', id: 1, message: 'ort exploded' });
    const result = await done;
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('ort exploded') });
    expect(children[0].killed).toBe(true);
  });

  test('malformed host messages are ignored, the run continues', async () => {
    const { manager, children } = managerWithChild();
    const done = manager.startSeparation({ sampleRate: MODEL_SAMPLE_RATE, channels: stereo(10) });
    await waitUntil(() => children.length === 1, 'child spawn');
    children[0].emit('message', null);
    children[0].emit('message', 'garbage');
    children[0].emit('message', { type: 'unknown-thing' });
    expect(manager.isRunning()).toBe(true);
    manager.cancel();
    await done;
  });

  test('dispose kills an active run (app-quit: no orphan process)', async () => {
    const { manager, children } = managerWithChild();
    const done = manager.startSeparation({ sampleRate: MODEL_SAMPLE_RATE, channels: stereo(10) });
    await waitUntil(() => children.length === 1, 'child spawn');
    manager.dispose();
    const result = await done;
    expect(result).toEqual({ ok: false, cancelled: true });
    expect(children[0].killed).toBe(true);
  });

  // Fix round 1, LOW-3: terminal error replies are id-gated like every other
  // message type — a stale job's error must not settle the current run. An
  // id-less error (init-stage/protocol, which carry no job id) still settles.
  test('a host error carrying a DIFFERENT job id is dropped', async () => {
    const { manager, children } = managerWithChild();
    const done = manager.startSeparation({ sampleRate: MODEL_SAMPLE_RATE, channels: stereo(10) });
    await waitUntil(() => children.length === 1, 'child spawn');
    children[0].emit('message', { type: 'error', stage: 'run', id: 999, message: 'stale-job error' });
    expect(manager.isRunning()).toBe(true); // still alive
    manager.cancel();
    const result = await done;
    expect(result).toEqual({ ok: false, cancelled: true });
  });

  test('an id-less host error (init/protocol stage) still settles the run', async () => {
    const { manager, children } = managerWithChild();
    const done = manager.startSeparation({ sampleRate: MODEL_SAMPLE_RATE, channels: stereo(10) });
    await waitUntil(() => children.length === 1, 'child spawn');
    children[0].emit('message', { type: 'error', stage: 'init', message: 'bad model file' });
    const result = await done;
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('bad model file') });
  });

  // Fix round 1, LOW-4: dispose is a LATCH — the manager is dead afterwards.
  test('startSeparation after dispose is refused', async () => {
    const { manager } = managerWithChild();
    manager.dispose();
    const result = await manager.startSeparation({ sampleRate: MODEL_SAMPLE_RATE, channels: stereo(10) });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/disposed/i);
  });

  test('dispose aborts an in-flight ensureModel download', async () => {
    const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stem-dl-abort-'));
    try {
      let started = false;
      const manager = createStemManager({
        userDataDir: modelDir,
        expectedSha256: FAKE_SHA,
        expectedBytes: FAKE_MODEL.length,
        utilityProcessFactory: () => fakeChild(),
        requestImpl: (url, handlers) =>
          new Promise(() => {
            started = true; // hangs forever, like a stalled-but-open socket
          }),
      });
      const download = manager.ensureModel();
      await waitUntil(() => started, 'download start');
      manager.dispose();
      await expect(download).rejects.toThrow(/abort/i);
    } finally {
      fs.rmSync(modelDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// IPC contract (the renderer-facing surface S3 will consume)
// ---------------------------------------------------------------------------

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    handlers,
  };
}

function fakeWin() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
}

describe('registerStemIpc', () => {
  test('registers the documented channels', () => {
    const ipc = fakeIpcMain();
    registerStemIpc({ ipcMain: ipc, manager: {}, getWin: () => null });
    for (const ch of [STEM_IPC.modelState, STEM_IPC.ensureModel, STEM_IPC.separate, STEM_IPC.cancel]) {
      expect(ipc.handlers.has(ch)).toBe(true);
    }
  });

  test('separate: validates the renderer payload at the trust boundary', async () => {
    const ipc = fakeIpcMain();
    const calls = [];
    registerStemIpc({
      ipcMain: ipc,
      manager: {
        startSeparation: async (req) => {
          calls.push(req);
          return { ok: true, totalSegments: 1 };
        },
      },
      getWin: fakeWin,
    });

    const bad = [
      undefined,
      null,
      'nope',
      {},
      { sampleRate: 48000, channels: [new ArrayBuffer(8)] }, // wrong rate (resampling is the renderer's job)
      { sampleRate: MODEL_SAMPLE_RATE, channels: [] }, // no channels
      { sampleRate: MODEL_SAMPLE_RATE, channels: [new ArrayBuffer(8), new ArrayBuffer(8), new ArrayBuffer(8)] }, // too many
      { sampleRate: MODEL_SAMPLE_RATE, channels: [new ArrayBuffer(8), new ArrayBuffer(4)] }, // ragged
      { sampleRate: MODEL_SAMPLE_RATE, channels: [new ArrayBuffer(6), new ArrayBuffer(6)] }, // not float32-aligned
      { sampleRate: MODEL_SAMPLE_RATE, channels: ['x', 'y'] }, // not buffers
      { sampleRate: MODEL_SAMPLE_RATE, channels: [new ArrayBuffer(0), new ArrayBuffer(0)] }, // empty
    ];
    for (const payload of bad) {
      const r = await ipc.invoke(STEM_IPC.separate, payload);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/invalid/i);
    }
    expect(calls).toHaveLength(0);

    const ch = new Float32Array([0.25, -0.5, 1]);
    const ok = await ipc.invoke(STEM_IPC.separate, {
      sampleRate: MODEL_SAMPLE_RATE,
      channels: [ch.buffer.slice(0), ch.buffer.slice(0)],
    });
    expect(ok).toEqual({ ok: true, totalSegments: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].sampleRate).toBe(MODEL_SAMPLE_RATE);
    expect(Array.from(calls[0].channels[0])).toEqual([0.25, -0.5, 1]);
  });

  test('separate: streams progress and stem chunks to the window as transferable payloads', async () => {
    const ipc = fakeIpcMain();
    const win = fakeWin();
    registerStemIpc({
      ipcMain: ipc,
      manager: {
        startSeparation: async ({ onProgress, onStems }) => {
          onProgress({ segment: 1, totalSegments: 3 });
          onStems({ offset: 0, samples: 2, data: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 5, 6, 7, 8]) });
          return { ok: true, totalSegments: 3 };
        },
      },
      getWin: () => win,
    });
    const ch = new Float32Array([0.1]);
    const r = await ipc.invoke(STEM_IPC.separate, {
      sampleRate: MODEL_SAMPLE_RATE,
      channels: [ch.buffer.slice(0)],
    });
    expect(r.ok).toBe(true);
    const progress = win.sent.filter((s) => s.channel === STEM_IPC.progress);
    expect(progress).toEqual([{ channel: STEM_IPC.progress, payload: { segment: 1, totalSegments: 3 } }]);
    const chunks = win.sent.filter((s) => s.channel === STEM_IPC.chunk);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].payload.offset).toBe(0);
    expect(chunks[0].payload.samples).toBe(2);
    // Brand check, not toBeInstanceOf: jest's node env can hand typed arrays
    // whose .buffer comes from another realm's ArrayBuffer constructor.
    expect(Object.prototype.toString.call(chunks[0].payload.data)).toBe('[object ArrayBuffer]');
    expect(new Float32Array(chunks[0].payload.data)[0]).toBe(1);
  });

  test('ensure-model returns {ok:false,error} on failure instead of throwing across IPC', async () => {
    const ipc = fakeIpcMain();
    registerStemIpc({
      ipcMain: ipc,
      manager: {
        ensureModel: async () => {
          throw new Error('offline: download failed after 3 attempts');
        },
      },
      getWin: fakeWin,
    });
    const r = await ipc.invoke(STEM_IPC.ensureModel);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('offline');
  });

  test('cancel resolves with whether anything was cancelled', async () => {
    const ipc = fakeIpcMain();
    registerStemIpc({
      ipcMain: ipc,
      manager: { cancel: () => true },
      getWin: fakeWin,
    });
    expect(await ipc.invoke(STEM_IPC.cancel)).toEqual({ cancelled: true });
  });
});
