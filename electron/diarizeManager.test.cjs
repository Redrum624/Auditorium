'use strict';

/**
 * Tests for diarizeManager.cjs (Separate Speakers, D2) — the two-file
 * ensure/verify set, the manager's run choreography (settle-once,
 * kill-on-terminal, id-gating, the dispose latch) and the IPC trust boundary.
 * Mirrors transcribeManager.test.cjs's discipline; the download/pin machinery
 * itself is stemManager's, tested there.
 *
 * The bridge (preload.cjs, electron.d.ts, main.cjs) cannot be required here —
 * it needs `electron` — so its D2 names are pinned by reading the files as
 * TEXT, the same way transcribeManager.test.cjs cross-checks the renderer's
 * byte constant.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
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
} = require('./diarizeManager.cjs');
const { MAX_TOTAL_SAMPLES, SEG_FRAMES, EMBEDDING_DIM } = require('./diarizeHost.cjs');

const USER_DATA = 'C:\\fake\\userData';

/** Two small fake files standing in for the two real pins — the real set has
 * exactly two members, so both positions are probed by name below. */
function makeFakeFiles() {
  const payloads = {
    segmentation: Buffer.from('segmentation-bytes-0123456789'),
    embedder: Buffer.from('embedder-bytes-abcdefghijklmnop'),
  };
  return [
    ['segmentation', 'seg.onnx'],
    ['embedder', 'emb.onnx'],
  ].map(([key, filename]) => ({
    key,
    filename,
    url: `https://example.com/${filename}`,
    sha256: crypto.createHash('sha256').update(payloads[key]).digest('hex'),
    bytes: payloads[key].length,
    payload: payloads[key],
  }));
}

/** Minimal async in-memory fs (the shape verifyModelFile/ensure use). */
function memFs(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    promises: {
      stat: async (p) => {
        if (!store.has(p)) {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
        return { size: store.get(p).length };
      },
      unlink: async (p) => {
        if (!store.has(p)) throw new Error('ENOENT');
        store.delete(p);
      },
      mkdir: async () => {},
    },
    createReadStream: (p) => {
      const listeners = {};
      const stream = {
        on: (ev, cb) => {
          listeners[ev] = cb;
          if (ev === 'end') {
            setImmediate(() => {
              if (store.has(p)) {
                listeners.data?.(store.get(p));
                listeners.end?.();
              } else {
                listeners.error?.(new Error('ENOENT'));
              }
            });
          }
          return stream;
        },
      };
      return stream;
    },
  };
}

function fakeRequest(files) {
  const byUrl = new Map(files.map((f) => [f.url, f.payload]));
  const calls = [];
  const impl = async (url, { onTotal, onData }) => {
    calls.push(url);
    const payload = byUrl.get(url);
    if (!payload) throw new Error(`404 ${url}`);
    onTotal(payload.length);
    onData(payload);
  };
  impl.calls = calls;
  return impl;
}

describe('the pinned file set (D2 — measured, never re-tuned)', () => {
  test('two files, the D2 bytes/sha256/URLs verbatim, total 32,523,463', () => {
    expect(DIARIZE_FILES).toHaveLength(2);
    const seg = DIARIZE_FILES.find((f) => f.key === 'segmentation');
    const emb = DIARIZE_FILES.find((f) => f.key === 'embedder');
    expect(seg).toMatchObject({
      filename: 'pyannote-segmentation-3.0.onnx',
      bytes: 5992913,
      sha256: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079',
      url: 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx',
    });
    expect(emb).toMatchObject({
      filename: 'wespeaker_en_voxceleb_resnet34_LM.onnx',
      bytes: 26530550,
      sha256: 'e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012',
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx',
    });
    expect(DIARIZE_TOTAL_BYTES).toBe(32523463);
    expect(DIARIZE_TOTAL_BYTES).toBe(DIARIZE_FILES.reduce((n, f) => n + f.bytes, 0));
    for (const f of DIARIZE_FILES) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.url.startsWith('https://')).toBe(true);
    }
    expect(Object.isFrozen(DIARIZE_FILES)).toBe(true);
  });

  test('model paths live under userData/models/diarization with the pinned filenames', () => {
    expect(DIARIZE_MODEL_DIR).toBe(path.join('models', 'diarization'));
    const paths = getDiarizeModelPaths(USER_DATA);
    expect(paths.segmentation).toBe(path.join(USER_DATA, 'models', 'diarization', 'pyannote-segmentation-3.0.onnx'));
    expect(paths.embedder).toBe(path.join(USER_DATA, 'models', 'diarization', 'wespeaker_en_voxceleb_resnet34_LM.onnx'));
    // The D6 layout: the repo-local test-assets tree resolves the same way.
    const bench = getDiarizeModelPaths(path.join('REPO', 'test-assets'));
    expect(bench.segmentation).toBe(path.join('REPO', 'test-assets', 'models', 'diarization', 'pyannote-segmentation-3.0.onnx'));
    // and an injected set maps ITS filenames (never one set's pins against another's paths)
    const fake = getDiarizeModelPaths(USER_DATA, makeFakeFiles());
    expect(fake.embedder).toBe(path.join(USER_DATA, DIARIZE_MODEL_DIR, 'emb.onnx'));
  });

  test('IPC ids are the D2 diarize:* set', () => {
    expect(DIARIZE_IPC).toEqual({
      modelState: 'diarize:model-state',
      ensureModels: 'diarize:ensure-models',
      modelProgress: 'diarize:model-progress',
      run: 'diarize:run',
      cancel: 'diarize:cancel',
      progress: 'diarize:progress',
      window: 'diarize:window',
      embedding: 'diarize:embedding',
    });
    expect(AUDIO_SLICE_SAMPLES).toBe(1 << 20);
  });

  test('verifyModelFile is re-exported for the bench (D6)', async () => {
    const files = makeFakeFiles();
    const dest = path.join(USER_DATA, DIARIZE_MODEL_DIR, files[0].filename);
    const fsImpl = memFs({ [dest]: files[0].payload });
    expect(await verifyModelFile(dest, { expectedSha256: files[0].sha256, expectedBytes: files[0].bytes, fsImpl })).toEqual({ ok: true });
    expect((await verifyModelFile(dest, { expectedSha256: '0'.repeat(64), expectedBytes: files[0].bytes, fsImpl })).ok).toBe(false);
  });
});

describe('ensureDiarizeModels', () => {
  test('downloads every missing file, verifies, atomically commits, reports overall progress', async () => {
    const files = makeFakeFiles();
    const fsImpl = memFs();
    const written = [];
    const progress = [];
    const request = fakeRequest(files);
    const paths = await ensureDiarizeModels({
      userDataDir: USER_DATA,
      files,
      fsImpl,
      requestImpl: request,
      onProgress: (p) => progress.push(p),
      atomicWrite: async (dest, buf) => {
        written.push(dest);
        fsImpl.store.set(dest, buf);
      },
    });
    expect(request.calls).toHaveLength(files.length);
    expect(request.calls.sort()).toEqual(files.map((f) => f.url).sort());
    expect(written).toHaveLength(files.length);
    expect(paths.segmentation).toBe(path.join(USER_DATA, DIARIZE_MODEL_DIR, 'seg.onnx'));
    const total = files.reduce((n, f) => n + f.bytes, 0);
    expect(progress[progress.length - 1]).toMatchObject({ received: total, total });
    // the LAST file's progress includes the earlier file's bytes (one bar)
    const earlier = files[0].bytes;
    expect(progress.find((p) => p.file === files[1].key && p.received > earlier)).toBeDefined();
  });

  test('already-verified files are not re-downloaded', async () => {
    const files = makeFakeFiles();
    const fsImpl = memFs({ [path.join(USER_DATA, DIARIZE_MODEL_DIR, 'seg.onnx')]: files[0].payload });
    const request = fakeRequest(files);
    await ensureDiarizeModels({
      userDataDir: USER_DATA,
      files,
      fsImpl,
      requestImpl: request,
      atomicWrite: async (dest, buf) => fsImpl.store.set(dest, buf),
    });
    expect(request.calls).toEqual([files[1].url]);
  });

  test.each([0, 1])('a corrupt file at position %i is deleted and re-downloaded', async (index) => {
    const files = makeFakeFiles();
    const dest = path.join(USER_DATA, DIARIZE_MODEL_DIR, files[index].filename);
    const fsImpl = memFs();
    fsImpl.store.set(dest, Buffer.alloc(files[index].bytes, 7)); // right length, wrong bytes
    const statuses = [];
    const request = fakeRequest(files);
    await ensureDiarizeModels({
      userDataDir: USER_DATA,
      files,
      fsImpl,
      requestImpl: request,
      onStatus: (s) => statuses.push(s),
      atomicWrite: async (d, buf) => fsImpl.store.set(d, buf),
    });
    expect(statuses).toContain(`corrupt-deleted:${files[index].key}`);
    expect(request.calls).toContain(files[index].url);
    expect(fsImpl.store.get(dest).equals(files[index].payload)).toBe(true);
  });

  test('a downloaded payload failing its sha256 pin is refused and not saved', async () => {
    const files = makeFakeFiles();
    files[1].sha256 = '0'.repeat(64);
    const written = [];
    await expect(
      ensureDiarizeModels({
        userDataDir: USER_DATA,
        files,
        fsImpl: memFs(),
        requestImpl: fakeRequest(files),
        atomicWrite: async (dest) => written.push(dest),
      })
    ).rejects.toThrow(/sha256 verification/);
    expect(written).toHaveLength(1); // the first file passed; the bad one never landed
    expect(written[0]).toContain('seg.onnx');
  });

  test('the abort latch aborts an in-flight ensure (transcribeManager.test :223 mirrored)', async () => {
    const files = makeFakeFiles();
    let abort = false;
    await expect(
      ensureDiarizeModels({
        userDataDir: USER_DATA,
        files,
        fsImpl: memFs(),
        requestImpl: async () => {
          abort = true;
          throw new Error('unreachable');
        },
        shouldAbort: () => abort,
        atomicWrite: async () => {},
      })
    ).rejects.toThrow(/aborted/);
  });

  test("the manager's dispose() latch aborts an in-flight ensure", async () => {
    const files = makeFakeFiles();
    let disposedDuringRequest = false;
    const manager = createDiarizeManager({
      userDataDir: USER_DATA,
      files,
      fsImpl: memFs(),
      requestImpl: async () => {
        manager.dispose();
        disposedDuringRequest = true;
        throw new Error('unreachable');
      },
      atomicWrite: async () => {},
    });
    await expect(manager.ensureModels()).rejects.toThrow(/aborted/);
    expect(disposedDuringRequest).toBe(true);
  });
});

/** Fake utility-process child. */
function fakeChild({ killReturns = true } = {}) {
  const child = {
    posted: [],
    listeners: {},
    killed: false,
    killCalls: 0,
    postMessage(msg) {
      child.posted.push(msg);
    },
    on(ev, cb) {
      child.listeners[ev] = cb;
    },
    kill() {
      child.killCalls++;
      if (killReturns === false) return false;
      child.killed = true;
      return true;
    },
    emit(msg) {
      child.listeners.message?.(msg);
    },
  };
  return child;
}

/** Polls for the child rather than counting ticks (verification is async). */
async function nextChild(children, index = 0) {
  for (let i = 0; i < 200 && children.length <= index; i++) {
    await new Promise((r) => setImmediate(r));
  }
  if (children.length <= index) throw new Error(`child ${index} was never spawned`);
  return children[index];
}

/** Manager whose model files all verify (in-memory). */
function makeManager({ files = makeFakeFiles(), killReturns = true } = {}) {
  const stores = {};
  for (const f of files) stores[path.join(USER_DATA, DIARIZE_MODEL_DIR, f.filename)] = f.payload;
  const fsImpl = memFs(stores);
  const children = [];
  const warnings = [];
  const factoryOpts = [];
  const manager = createDiarizeManager({
    userDataDir: USER_DATA,
    files,
    fsImpl,
    onWarn: (m) => warnings.push(m),
    utilityProcessFactory: (opts) => {
      factoryOpts.push(opts);
      const c = fakeChild({ killReturns });
      children.push(c);
      return c;
    },
  });
  return { manager, children, fsImpl, files, warnings, factoryOpts };
}

/** 16 kHz mono fixture off the identity: a ramp scaled into range. */
const SAMPLES = Float32Array.from({ length: 16000 }, (_, k) => ((k % 1000) - 500) / 1000);

describe('createDiarizeManager.startDiarization', () => {
  test('full choreography: verify → spawn → init/diarize/audio/run → events → done kills the child', async () => {
    const { manager, children } = makeManager();
    const events = { windows: [], embeddings: [], progress: [] };
    const promise = manager.startDiarization({
      sampleRate: 16000,
      samples: SAMPLES,
      onProgress: (p) => events.progress.push(p),
      onWindow: (w) => events.windows.push(w),
      onEmbedding: (e) => events.embeddings.push(e),
    });
    const child = await nextChild(children);
    expect(child.posted[0]).toMatchObject({ type: 'init' });
    expect(child.posted[0].paths).toEqual({
      segmentation: path.join(USER_DATA, DIARIZE_MODEL_DIR, 'seg.onnx'),
      embedder: path.join(USER_DATA, DIARIZE_MODEL_DIR, 'emb.onnx'),
    });
    child.emit({ type: 'ready' });
    expect(child.posted.map((m) => m.type)).toEqual(['init', 'diarize', 'audio', 'run']);
    expect(child.posted[1]).toEqual({ type: 'diarize', id: 1, sampleRate: 16000, totalSamples: 16000 });
    expect(child.posted[2]).toMatchObject({ type: 'audio', id: 1, offset: 0 });
    expect(Array.from(child.posted[2].samples)).toEqual(Array.from(SAMPLES));
    expect(child.posted[3]).toEqual({ type: 'run', id: 1 });
    const labels = new Uint8Array(SEG_FRAMES).fill(4);
    const vector = new Float32Array(EMBEDDING_DIM).fill(1 / 16);
    child.emit({ type: 'progress', id: 1, stage: 'segment', done: 1, total: 1 });
    child.emit({ type: 'window', id: 1, index: 0, labels });
    child.emit({ type: 'embedding', id: 1, windowIndex: 0, localSpeaker: 2, activeFrames: 37, vector });
    child.emit({ type: 'progress', id: 1, stage: 'embed', done: 1, total: 1 });
    child.emit({ type: 'done', id: 1, windowCount: 1 });
    const result = await promise;
    expect(result).toEqual({ ok: true, windowCount: 1 });
    expect(child.killed).toBe(true);
    expect(events.progress).toEqual([
      { stage: 'segment', done: 1, total: 1 },
      { stage: 'embed', done: 1, total: 1 },
    ]);
    expect(events.windows).toEqual([{ index: 0, labels }]);
    expect(events.embeddings).toEqual([{ windowIndex: 0, localSpeaker: 2, activeFrames: 37, vector }]);
    expect(manager.isRunning()).toBe(false);
  });

  test('the utility process is forked as "Auditorium speaker diarization" from diarizeHost.cjs', async () => {
    const { manager, children, factoryOpts } = makeManager();
    const run = manager.startDiarization({ sampleRate: 16000, samples: SAMPLES });
    await nextChild(children);
    expect(factoryOpts[0]).toEqual({
      modulePath: path.join(__dirname, 'diarizeHost.cjs'),
      serviceName: 'Auditorium speaker diarization',
    });
    manager.cancel();
    await run;
  });

  test('audio is sliced into bounded copies that tile the track', async () => {
    const { manager, children } = makeManager();
    const big = new Float32Array(AUDIO_SLICE_SAMPLES + 5);
    big[AUDIO_SLICE_SAMPLES] = 0.25; // first sample of the tail slice, off zero
    const promise = manager.startDiarization({ sampleRate: 16000, samples: big });
    const child = await nextChild(children);
    child.emit({ type: 'ready' });
    const audio = child.posted.filter((m) => m.type === 'audio');
    expect(audio).toHaveLength(2);
    expect(audio[0].offset).toBe(0);
    expect(audio[0].samples.length).toBe(AUDIO_SLICE_SAMPLES);
    expect(audio[1].offset).toBe(AUDIO_SLICE_SAMPLES);
    expect(audio[1].samples.length).toBe(5);
    expect(audio[1].samples[0]).toBe(0.25);
    // copies, not views: a slice's buffer is its own, not the whole track's
    expect(audio[1].samples.buffer.byteLength).toBe(5 * 4);
    child.emit({ type: 'done', id: 1, windowCount: 0 });
    await promise;
  });

  test('busy gate: a second start resolves busy without spawning', async () => {
    const { manager, children } = makeManager();
    const first = manager.startDiarization({ sampleRate: 16000, samples: SAMPLES });
    const second = await manager.startDiarization({ sampleRate: 16000, samples: SAMPLES });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/busy/);
    await nextChild(children);
    expect(children).toHaveLength(1);
    manager.cancel();
    await first;
  });

  test.each([0, 1])('a failed sha256 pin at position %i refuses to spawn the host, naming that file', async (index) => {
    const files = makeFakeFiles();
    const { manager, children, fsImpl } = makeManager({ files });
    const target = files[index];
    fsImpl.store.set(path.join(USER_DATA, DIARIZE_MODEL_DIR, target.filename), Buffer.alloc(target.bytes, 7));
    const result = await manager.startDiarization({ sampleRate: 16000, samples: SAMPLES });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/verification/);
    expect(result.error).toContain(target.filename);
    expect(children).toHaveLength(0);
    expect(manager.isRunning()).toBe(false);
  });

  test('a fully-verified set DOES spawn — the refusals above are not vacuous', async () => {
    const { manager, children } = makeManager();
    const run = manager.startDiarization({ sampleRate: 16000, samples: SAMPLES });
    await nextChild(children);
    expect(children).toHaveLength(1);
    manager.cancel();
    await run;
  });

  test('stale-id messages are ignored; host-level errors without id settle', async () => {
    const { manager, children } = makeManager();
    const windows = [];
    const promise = manager.startDiarization({ sampleRate: 16000, samples: SAMPLES, onWindow: (w) => windows.push(w) });
    const child = await nextChild(children);
    child.emit({ type: 'ready' });
    child.emit({ type: 'window', id: 99, index: 0, labels: new Uint8Array(SEG_FRAMES) });
    child.emit({ type: 'done', id: 99, windowCount: 5 });
    expect(windows).toHaveLength(0);
    child.emit({ type: 'error', stage: 'init', message: 'models unloadable' });
    expect(await promise).toEqual({ ok: false, error: 'models unloadable' });
    expect(child.killed).toBe(true);
  });

  test('a run error with the job id settles as that error', async () => {
    const { manager, children } = makeManager();
    const promise = manager.startDiarization({ sampleRate: 16000, samples: SAMPLES });
    const child = await nextChild(children);
    child.emit({ type: 'ready' });
    child.emit({ type: 'error', stage: 'run', id: 1, message: 'segmentation output dims [1,588,7]' });
    expect(await promise).toEqual({ ok: false, error: 'segmentation output dims [1,588,7]' });
  });

  test('cancel kills the child and resolves cancelled; late chatter is dropped', async () => {
    const { manager, children } = makeManager();
    const embeddings = [];
    const promise = manager.startDiarization({
      sampleRate: 16000,
      samples: SAMPLES,
      onEmbedding: (e) => embeddings.push(e),
    });
    const child = await nextChild(children);
    child.emit({ type: 'ready' });
    expect(manager.cancel()).toBe(true);
    expect(await promise).toEqual({ ok: false, cancelled: true });
    expect(child.killed).toBe(true);
    child.emit({ type: 'embedding', id: 1, windowIndex: 0, localSpeaker: 0, activeFrames: 20, vector: new Float32Array(EMBEDDING_DIM) });
    expect(embeddings).toHaveLength(0);
    expect(manager.cancel()).toBe(false);
  });

  test('a host-side cancelled message settles cancelled', async () => {
    const { manager, children } = makeManager();
    const promise = manager.startDiarization({ sampleRate: 16000, samples: SAMPLES });
    const child = await nextChild(children);
    child.emit({ type: 'cancelled', id: 1 });
    expect(await promise).toEqual({ ok: false, cancelled: true });
  });

  test('unexpected child exit settles as an error', async () => {
    const { manager, children } = makeManager();
    const promise = manager.startDiarization({ sampleRate: 16000, samples: SAMPLES });
    const child = await nextChild(children);
    child.listeners.exit(9);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exited unexpectedly \(code 9\)/);
  });

  test('a factory that throws settles as a spawn error', async () => {
    const files = makeFakeFiles();
    const stores = {};
    for (const f of files) stores[path.join(USER_DATA, DIARIZE_MODEL_DIR, f.filename)] = f.payload;
    const manager = createDiarizeManager({
      userDataDir: USER_DATA,
      files,
      fsImpl: memFs(stores),
      utilityProcessFactory: () => {
        throw new Error('no electron here');
      },
    });
    const result = await manager.startDiarization({ sampleRate: 16000, samples: SAMPLES });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/failed to spawn.*no electron here/);
    expect(manager.isRunning()).toBe(false);
  });

  test('dispose latches: refuses new runs and cancels the active one (transcribeManager.test :471 mirrored)', async () => {
    const { manager, children } = makeManager();
    const promise = manager.startDiarization({ sampleRate: 16000, samples: SAMPLES });
    const child = await nextChild(children);
    manager.dispose();
    expect(await promise).toEqual({ ok: false, cancelled: true });
    expect(child.killed).toBe(true);
    const after = await manager.startDiarization({ sampleRate: 16000, samples: SAMPLES });
    expect(after.ok).toBe(false);
    expect(after.error).toMatch(/disposed/);
  });
});

describe('killing the child', () => {
  test('a successful kill is silent', async () => {
    const { manager, children, warnings } = makeManager();
    const run = manager.startDiarization({ sampleRate: 16000, samples: SAMPLES });
    const child = await nextChild(children);
    manager.cancel();
    await run;
    expect(child.killed).toBe(true);
    expect(child.killCalls).toBe(1);
    expect(warnings).toEqual([]);
  });

  test('a child that will not die is retried once and REPORTED', async () => {
    const { manager, children, warnings } = makeManager({ killReturns: false });
    const run = manager.startDiarization({ sampleRate: 16000, samples: SAMPLES });
    const child = await nextChild(children);
    manager.cancel();
    await run;
    expect(child.killCalls).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/did not respond to kill/);
    expect(manager.isRunning()).toBe(false);
  });
});

describe('getModelState', () => {
  test('the real set reports expectedBytes 32,523,463 and nothing downloaded on an empty directory', async () => {
    const manager = createDiarizeManager({ userDataDir: USER_DATA, fsImpl: memFs() });
    expect(await manager.getModelState()).toEqual({ downloaded: false, bytes: null, expectedBytes: 32523463 });
  });

  test('a complete set reports downloaded with the whole size', async () => {
    const files = makeFakeFiles();
    const total = files.reduce((n, f) => n + f.bytes, 0);
    const { manager } = makeManager({ files });
    expect(await manager.getModelState()).toEqual({ downloaded: true, bytes: total, expectedBytes: total });
  });

  test.each([0, 1])('a set missing the file at position %i is NOT downloaded', async (index) => {
    const files = makeFakeFiles();
    const total = files.reduce((n, f) => n + f.bytes, 0);
    const { manager, fsImpl } = makeManager({ files });
    fsImpl.store.delete(path.join(USER_DATA, DIARIZE_MODEL_DIR, files[index].filename));
    expect(await manager.getModelState()).toEqual({
      downloaded: false,
      bytes: total - files[index].bytes,
      expectedBytes: total,
    });
  });

  test.each([0, 1])('a WRONG-SIZED file at position %i is NOT downloaded (one byte over, one under)', async (index) => {
    const files = makeFakeFiles();
    const dest = path.join(USER_DATA, DIARIZE_MODEL_DIR, files[index].filename);
    for (const delta of [1, -1]) {
      const { manager, fsImpl } = makeManager({ files });
      fsImpl.store.set(dest, Buffer.alloc(files[index].bytes + delta, 7));
      expect(await manager.getModelState()).toMatchObject({ downloaded: false });
    }
  });

  test('the module-level getDiarizeModelState is what the manager reports', async () => {
    const files = makeFakeFiles();
    const stores = {};
    for (const f of files) stores[path.join(USER_DATA, DIARIZE_MODEL_DIR, f.filename)] = f.payload;
    const fsImpl = memFs(stores);
    expect(await getDiarizeModelState({ userDataDir: USER_DATA, files, fsImpl })).toEqual({
      downloaded: true,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      expectedBytes: files.reduce((n, f) => n + f.bytes, 0),
    });
  });
});

describe('parseDiarizeRequest (trust boundary)', () => {
  const okBuf = new Float32Array(8).buffer;

  test('accepts a valid request and returns the samples as a Float32Array view', () => {
    const parsed = parseDiarizeRequest({ sampleRate: 16000, samples: okBuf });
    expect(parsed).not.toBeNull();
    expect(Object.prototype.toString.call(parsed.samples)).toBe('[object Float32Array]');
    expect(parsed.samples).toHaveLength(8);
  });

  test('sampleRate probes below/on/above', () => {
    expect(parseDiarizeRequest({ sampleRate: 15999, samples: okBuf })).toBeNull();
    expect(parseDiarizeRequest({ sampleRate: 16001, samples: okBuf })).toBeNull();
    expect(parseDiarizeRequest({ sampleRate: 44100, samples: okBuf })).toBeNull();
    expect(parseDiarizeRequest({ sampleRate: 16000, samples: okBuf })).not.toBeNull();
  });

  test('samples must be a non-empty float32-aligned ArrayBuffer', () => {
    for (const bad of [undefined, null, [1, 2], new Float32Array(4), new Uint8Array(8), new ArrayBuffer(0), new ArrayBuffer(6), new ArrayBuffer(9)]) {
      expect(parseDiarizeRequest({ sampleRate: 16000, samples: bad })).toBeNull();
    }
    expect(parseDiarizeRequest({ sampleRate: 16000, samples: new ArrayBuffer(4) })).not.toBeNull();
    expect(parseDiarizeRequest({ sampleRate: 16000, samples: new ArrayBuffer(8) })).not.toBeNull();
  });

  test('length cap: on the cap passes, one sample above fails; the default cap is the host’s', () => {
    expect(parseDiarizeRequest({ sampleRate: 16000, samples: new ArrayBuffer(8 * 4) }, 8)).not.toBeNull();
    expect(parseDiarizeRequest({ sampleRate: 16000, samples: new ArrayBuffer(9 * 4) }, 8)).toBeNull();
    expect(MAX_TOTAL_SAMPLES).toBe(16000 * 7200);
    expect(parseDiarizeRequest({ sampleRate: 16000, samples: new ArrayBuffer(4) })).not.toBeNull();
  });

  test('non-object requests are refused', () => {
    for (const bad of [null, undefined, 42, 'x']) expect(parseDiarizeRequest(bad)).toBeNull();
  });
});

describe('registerDiarizeIpc', () => {
  function fakeIpc() {
    const handlers = new Map();
    return {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      handlers,
      invoke: (ch, req) => handlers.get(ch)(null, req),
    };
  }

  test('registers exactly the five invoke channels', () => {
    const { ipcMain, handlers } = fakeIpc();
    registerDiarizeIpc({ ipcMain, manager: {}, getWin: () => null });
    expect([...handlers.keys()].sort()).toEqual(
      [DIARIZE_IPC.modelState, DIARIZE_IPC.ensureModels, DIARIZE_IPC.run, DIARIZE_IPC.cancel].sort()
    );
  });

  test('run validates the request and forwards events; labels and vectors cross as ArrayBuffers', async () => {
    const sent = [];
    const win = { isDestroyed: () => false, webContents: { send: (ch, p) => sent.push([ch, p]) } };
    const startCalls = [];
    const labels = new Uint8Array(SEG_FRAMES);
    labels[0] = 4;
    labels[SEG_FRAMES - 1] = 6;
    const vector = new Float32Array(EMBEDDING_DIM);
    vector[0] = 0.5;
    vector[EMBEDDING_DIM - 1] = 0.25;
    const manager = {
      startDiarization: async (req) => {
        startCalls.push(req);
        req.onProgress({ stage: 'segment', done: 1, total: 3 });
        req.onWindow({ index: 0, labels });
        req.onEmbedding({ windowIndex: 0, localSpeaker: 1, activeFrames: 12, vector });
        return { ok: true, windowCount: 3 };
      },
      cancel: () => true,
    };
    const { ipcMain, invoke } = fakeIpc();
    registerDiarizeIpc({ ipcMain, manager, getWin: () => win });

    for (const bad of [
      { sampleRate: 44100, samples: new ArrayBuffer(4) },
      { sampleRate: 16000, samples: new ArrayBuffer(6) },
      { sampleRate: 16000, samples: new Float32Array(1) },
      { sampleRate: 16000 },
      null,
    ]) {
      const res = await invoke(DIARIZE_IPC.run, bad);
      expect(res.ok).toBe(false);
      expect(typeof res.error).toBe('string');
    }
    expect(startCalls).toHaveLength(0); // the manager is never touched by a refused request

    const good = await invoke(DIARIZE_IPC.run, { sampleRate: 16000, samples: new Float32Array([1, 2]).buffer });
    expect(good).toEqual({ ok: true, windowCount: 3 });
    expect(startCalls[0].sampleRate).toBe(16000);
    expect(Array.from(startCalls[0].samples)).toEqual([1, 2]);
    const prog = sent.find(([ch]) => ch === DIARIZE_IPC.progress);
    expect(prog[1]).toEqual({ stage: 'segment', done: 1, total: 3 });
    const win0 = sent.find(([ch]) => ch === DIARIZE_IPC.window);
    expect(win0[1].index).toBe(0);
    expect(Object.prototype.toString.call(win0[1].labels)).toBe('[object ArrayBuffer]');
    expect(win0[1].labels.byteLength).toBe(SEG_FRAMES);
    expect(new Uint8Array(win0[1].labels)[0]).toBe(4);
    expect(new Uint8Array(win0[1].labels)[SEG_FRAMES - 1]).toBe(6);
    const emb = sent.find(([ch]) => ch === DIARIZE_IPC.embedding);
    expect(emb[1]).toMatchObject({ windowIndex: 0, localSpeaker: 1, activeFrames: 12 });
    expect(Object.prototype.toString.call(emb[1].vector)).toBe('[object ArrayBuffer]');
    expect(emb[1].vector.byteLength).toBe(EMBEDDING_DIM * 4); // 1024
    expect(new Float32Array(emb[1].vector)[0]).toBe(0.5);
    expect(new Float32Array(emb[1].vector)[EMBEDDING_DIM - 1]).toBe(0.25);
  });

  test('ensure-models streams {received, total} progress (throttled, final always sent) and maps errors', async () => {
    const sent = [];
    const win = { isDestroyed: () => false, webContents: { send: (ch, p) => sent.push([ch, p]) } };
    let mode = 'ok';
    const manager = {
      ensureModels: async ({ onProgress }) => {
        if (mode === 'fail') throw new Error('disk full');
        onProgress({ file: 'segmentation', fileIndex: 0, fileCount: 2, received: 10, total: 100 });
        onProgress({ file: 'embedder', fileIndex: 1, fileCount: 2, received: 100, total: 100 });
        return {};
      },
    };
    const { ipcMain, invoke } = fakeIpc();
    registerDiarizeIpc({ ipcMain, manager, getWin: () => win });
    expect(await invoke(DIARIZE_IPC.ensureModels)).toEqual({ ok: true });
    const prog = sent.filter(([ch]) => ch === DIARIZE_IPC.modelProgress).map(([, p]) => p);
    expect(prog[prog.length - 1]).toEqual({ received: 100, total: 100 });
    for (const p of prog) expect(Object.keys(p).sort()).toEqual(['received', 'total']);
    mode = 'fail';
    expect(await invoke(DIARIZE_IPC.ensureModels)).toEqual({ ok: false, error: 'disk full' });
  });

  test('cancel and model-state pass through; a destroyed window receives nothing', async () => {
    const manager = {
      getModelState: async () => ({ downloaded: false, bytes: null, expectedBytes: 9 }),
      cancel: () => false,
      startDiarization: async (req) => {
        req.onProgress({ stage: 'segment', done: 1, total: 1 });
        return { ok: true, windowCount: 1 };
      },
    };
    const { ipcMain, invoke } = fakeIpc();
    const sent = [];
    const dead = { isDestroyed: () => true, webContents: { send: (ch, p) => sent.push([ch, p]) } };
    registerDiarizeIpc({ ipcMain, manager, getWin: () => dead });
    expect(await invoke(DIARIZE_IPC.modelState)).toEqual({ downloaded: false, bytes: null, expectedBytes: 9 });
    expect(await invoke(DIARIZE_IPC.cancel)).toEqual({ cancelled: false });
    await invoke(DIARIZE_IPC.run, { sampleRate: 16000, samples: new ArrayBuffer(4) });
    expect(sent).toEqual([]);
  });
});

describe('the bridge (preload.cjs, electron.d.ts, main.cjs) carries the D2 names', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8');
  const METHODS = [
    'diarizeModelState',
    'diarizeEnsureModels',
    'onDiarizeModelProgress',
    'diarizeRun',
    'diarizeCancel',
    'onDiarizeProgress',
    'onDiarizeWindow',
    'onDiarizeEmbedding',
  ];

  test('preload exposes every D2 method over the matching diarize:* channel', () => {
    const src = read('preload.cjs');
    for (const m of METHODS) expect(src).toMatch(new RegExp(`^\\s*${m}:\\s*\\(`, 'm'));
    for (const ch of Object.values(DIARIZE_IPC)) expect(src).toContain(`'${ch}'`);
    // invoke channels go through ipcRenderer.invoke; events through on/removeListener
    expect(src).toMatch(/diarizeRun: \(req\) => ipcRenderer\.invoke\('diarize:run', req\)/);
    expect(src).toMatch(/diarizeCancel: \(\) => ipcRenderer\.invoke\('diarize:cancel'\)/);
    expect(src).toMatch(/diarizeModelState: \(\) => ipcRenderer\.invoke\('diarize:model-state'\)/);
    expect(src).toMatch(/diarizeEnsureModels: \(\) => ipcRenderer\.invoke\('diarize:ensure-models'\)/);
    for (const ch of [DIARIZE_IPC.modelProgress, DIARIZE_IPC.progress, DIARIZE_IPC.window, DIARIZE_IPC.embedding]) {
      expect(src).toContain(`ipcRenderer.on('${ch}', listener)`);
      expect(src).toContain(`ipcRenderer.removeListener('${ch}', listener)`);
    }
  });

  test('electron.d.ts declares every D2 method with the D2 payload types', () => {
    const src = read('..', 'src', 'types', 'electron.d.ts');
    for (const m of METHODS) expect(src).toMatch(new RegExp(`^\\s*${m}\\(`, 'm'));
    expect(src).toContain('diarizeModelState(): Promise<{ downloaded: boolean; bytes: number | null; expectedBytes: number }>');
    expect(src).toContain('diarizeEnsureModels(): Promise<{ ok: true } | { ok: false; error: string }>');
    expect(src).toContain('onDiarizeModelProgress(cb: (p: { received: number; total: number }) => void): () => void');
    expect(src).toContain(
      'diarizeRun(req: { sampleRate: number; samples: ArrayBuffer }): Promise<{ ok: true; windowCount: number } | { ok: false; cancelled?: true; error?: string }>'
    );
    expect(src).toContain('diarizeCancel(): Promise<{ cancelled: boolean }>');
    expect(src).toContain("onDiarizeProgress(cb: (p: { stage: 'segment' | 'embed'; done: number; total: number }) => void): () => void");
    expect(src).toContain('onDiarizeWindow(cb: (w: { index: number; labels: ArrayBuffer }) => void): () => void');
    expect(src).toContain(
      'onDiarizeEmbedding(cb: (e: { windowIndex: number; localSpeaker: number; activeFrames: number; vector: ArrayBuffer }) => void): () => void'
    );
  });

  test('main.cjs registers the manager and wires dispose() at will-quit like the four others', () => {
    const src = read('main.cjs');
    expect(src).toMatch(/const \{ createDiarizeManager, registerDiarizeIpc \} = require\('\.\/diarizeManager\.cjs'\);/);
    expect(src).toMatch(/const diarizeManager = createDiarizeManager\(\{ userDataDir: app\.getPath\('userData'\) \}\);/);
    expect(src).toMatch(/registerDiarizeIpc\(\{ ipcMain, manager: diarizeManager, getWin: \(\) => mainWindow \}\);/);
    expect(src).toMatch(/app\.on\('will-quit', \(\) => diarizeManager\.dispose\(\)\);/);
  });
});
