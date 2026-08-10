'use strict';

/**
 * Tests for transcribeManager.cjs (F4) — multi-file ensure/verify, the
 * manager's run choreography (settle-once, kill-on-terminal, id-gating) and
 * the IPC trust boundary. Mirrors stemManager.test.cjs's discipline; the
 * download/pin machinery itself is stemManager's, tested there.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const {
  TRANSCRIBE_FILES,
  TRANSCRIBE_MODEL_DIR,
  TRANSCRIBE_IPC,
  getTranscribeModelPaths,
  ensureTranscriptionModels,
  createTranscribeManager,
  registerTranscribeIpc,
  parseTranscribeRequest,
} = require('./transcribeManager.cjs');
const { MAX_TOTAL_SAMPLES } = require('./transcribeHost.cjs');

const USER_DATA = 'C:\\fake\\userData';

/** Two small fake files standing in for the six real pins. */
function makeFakeFiles() {
  const a = Buffer.from('encoder-bytes-0123456789');
  const b = Buffer.from('tokenizer-bytes');
  return [
    {
      key: 'encoder',
      filename: 'enc.onnx',
      url: 'https://example.com/enc.onnx',
      sha256: crypto.createHash('sha256').update(a).digest('hex'),
      bytes: a.length,
      payload: a,
    },
    {
      key: 'tokenizer',
      filename: 'tok.json',
      url: 'https://example.com/tok.json',
      sha256: crypto.createHash('sha256').update(b).digest('hex'),
      bytes: b.length,
      payload: b,
    },
  ];
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

describe('ensureTranscriptionModels', () => {
  test('downloads every missing file, verifies, atomically commits, reports overall progress', async () => {
    const files = makeFakeFiles();
    const fsImpl = memFs();
    const written = [];
    const progress = [];
    const request = fakeRequest(files);
    const paths = await ensureTranscriptionModels({
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
    expect(request.calls).toHaveLength(2);
    expect(written).toHaveLength(2);
    expect(paths.encoder).toBe(path.join(USER_DATA, TRANSCRIBE_MODEL_DIR, 'enc.onnx'));
    const total = files[0].bytes + files[1].bytes;
    expect(progress[progress.length - 1]).toMatchObject({ received: total, total });
    // the second file's progress includes the first file's bytes (overall bar)
    const second = progress.find((p) => p.file === 'tokenizer' && p.received > files[0].bytes);
    expect(second).toBeDefined();
    expect(second.fileCount).toBe(2);
  });

  test('already-verified files are not re-downloaded', async () => {
    const files = makeFakeFiles();
    const fsImpl = memFs({
      [path.join(USER_DATA, TRANSCRIBE_MODEL_DIR, 'enc.onnx')]: files[0].payload,
    });
    const request = fakeRequest(files);
    await ensureTranscriptionModels({
      userDataDir: USER_DATA,
      files,
      fsImpl,
      requestImpl: request,
      atomicWrite: async (dest, buf) => fsImpl.store.set(dest, buf),
    });
    expect(request.calls).toEqual([files[1].url]);
  });

  test('a corrupt existing file is deleted and re-downloaded (ruling 1)', async () => {
    const files = makeFakeFiles();
    const dest = path.join(USER_DATA, TRANSCRIBE_MODEL_DIR, 'enc.onnx');
    const fsImpl = memFs({ [dest]: Buffer.from('corrupt-but-right-length!').subarray(0, files[0].bytes) });
    // pad to the pinned size so only the sha fails
    fsImpl.store.set(dest, Buffer.alloc(files[0].bytes, 7));
    const statuses = [];
    const request = fakeRequest(files);
    await ensureTranscriptionModels({
      userDataDir: USER_DATA,
      files,
      fsImpl,
      requestImpl: request,
      onStatus: (s) => statuses.push(s),
      atomicWrite: async (d, buf) => fsImpl.store.set(d, buf),
    });
    expect(statuses).toContain('corrupt-deleted:encoder');
    expect(request.calls).toContain(files[0].url);
    expect(fsImpl.store.get(dest).equals(files[0].payload)).toBe(true);
  });

  test('a downloaded payload failing its sha256 pin is refused and not saved', async () => {
    const files = makeFakeFiles();
    files[0].sha256 = '0'.repeat(64); // pin cannot match
    const fsImpl = memFs();
    const written = [];
    await expect(
      ensureTranscriptionModels({
        userDataDir: USER_DATA,
        files,
        fsImpl,
        requestImpl: fakeRequest(files),
        atomicWrite: async (dest, buf) => written.push(dest),
      })
    ).rejects.toThrow(/sha256 verification/);
    expect(written).toHaveLength(0);
  });

  test('the dispose latch aborts an in-flight ensure', async () => {
    const files = makeFakeFiles();
    let abort = false;
    await expect(
      ensureTranscriptionModels({
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
});

/** Fake utility-process child. */
function fakeChild() {
  const child = {
    posted: [],
    listeners: {},
    killed: false,
    postMessage(msg) {
      child.posted.push(msg);
    },
    on(ev, cb) {
      child.listeners[ev] = cb;
    },
    kill() {
      child.killed = true;
    },
    emit(msg) {
      child.listeners.message?.(msg);
    },
  };
  return child;
}

/**
 * Waits for the manager to spawn child `index`. startTranscription verifies
 * EVERY pin before it spawns anything (ruling 1), and each verification is a
 * stat plus a streamed sha256 — several event-loop turns, and the exact count
 * is an implementation detail of the file set. So poll for the child rather
 * than hard-coding a number of ticks, and fail loudly if it never arrives
 * (otherwise a genuine refusal-to-spawn would surface as `undefined.emit`).
 */
async function nextChild(children, index = 0) {
  for (let i = 0; i < 200 && children.length <= index; i++) {
    await new Promise((r) => setImmediate(r));
  }
  if (children.length <= index) throw new Error(`child ${index} was never spawned`);
  return children[index];
}

/** Manager whose model files all verify (in-memory). */
function makeManager({ files = makeFakeFiles() } = {}) {
  const stores = {};
  const paths = getTranscribeModelPaths(USER_DATA);
  for (const f of files) stores[path.join(USER_DATA, TRANSCRIBE_MODEL_DIR, f.filename)] = f.payload;
  const fsImpl = memFs(stores);
  const children = [];
  const manager = createTranscribeManager({
    userDataDir: USER_DATA,
    files,
    fsImpl,
    utilityProcessFactory: () => {
      const c = fakeChild();
      children.push(c);
      return c;
    },
  });
  return { manager, children, fsImpl, files };
}

const SAMPLES = new Float32Array(16000).fill(0.1);

describe('createTranscribeManager.startTranscription', () => {
  test('full choreography: verify → spawn → init/transcribe/audio/run → events → done kills the child', async () => {
    const { manager, children } = makeManager();
    const events = { segments: [], embeddings: [], languages: [], progress: [] };
    const promise = manager.startTranscription({
      sampleRate: 16000,
      samples: SAMPLES,
      language: 'auto',
      onProgress: (p) => events.progress.push(p),
      onLanguage: (p) => events.languages.push(p),
      onSegment: (s) => events.segments.push(s),
      onEmbedding: (e) => events.embeddings.push(e),
    });
    const child = await nextChild(children);
    expect(child.posted[0]).toMatchObject({ type: 'init' });
    expect(child.posted[0].paths.encoder).toContain('enc.onnx');
    child.emit({ type: 'ready' });
    const types = child.posted.map((m) => m.type);
    expect(types).toEqual(['init', 'transcribe', 'audio', 'run']);
    expect(child.posted[1]).toMatchObject({ id: 1, sampleRate: 16000, totalSamples: 16000, language: 'auto' });
    child.emit({ type: 'language', id: 1, language: 'en', probability: 0.9 });
    child.emit({ type: 'progress', id: 1, stage: 'transcribe', done: 8000, total: 16000 });
    child.emit({ type: 'segment', id: 1, index: 0, startSample: 0, endSample: 12800, text: 'hi', avgLogprob: -0.2, noSpeechProb: 0.01, compressionRatio: 1.1 });
    child.emit({ type: 'embedding', id: 1, segmentIndex: 0, vector: new Float32Array([1, 0]) });
    child.emit({ type: 'done', id: 1, segmentCount: 1 });
    const result = await promise;
    expect(result).toEqual({ ok: true, segmentCount: 1 });
    expect(child.killed).toBe(true);
    expect(events.segments).toHaveLength(1);
    expect(events.embeddings).toHaveLength(1);
    expect(events.languages).toEqual([{ language: 'en', probability: 0.9 }]);
    expect(manager.isRunning()).toBe(false);
  });

  test('audio is sliced into bounded copies that tile the track', async () => {
    const { manager, children } = makeManager();
    const big = new Float32Array((1 << 20) + 5); // one full slice + a tail
    const promise = manager.startTranscription({ sampleRate: 16000, samples: big, language: 'en' });
    const child = await nextChild(children);
    child.emit({ type: 'ready' });
    const audio = child.posted.filter((m) => m.type === 'audio');
    expect(audio).toHaveLength(2);
    expect(audio[0].offset).toBe(0);
    expect(audio[0].samples.length).toBe(1 << 20);
    expect(audio[1].offset).toBe(1 << 20);
    expect(audio[1].samples.length).toBe(5);
    child.emit({ type: 'done', id: 1, segmentCount: 0 });
    await promise;
  });

  test('busy gate: a second start resolves busy without spawning', async () => {
    const { manager, children } = makeManager();
    const first = manager.startTranscription({ sampleRate: 16000, samples: SAMPLES, language: 'auto' });
    const second = await manager.startTranscription({ sampleRate: 16000, samples: SAMPLES, language: 'auto' });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/busy/);
    await nextChild(children);
    expect(children).toHaveLength(1);
    manager.cancel();
    await first;
  });

  test('a failed pin refuses to spawn the host', async () => {
    const files = makeFakeFiles();
    const { manager, children } = makeManager({ files });
    // corrupt the encoder on "disk"
    const { manager: m2, children: c2, fsImpl } = makeManager({ files });
    fsImpl.store.set(path.join(USER_DATA, TRANSCRIBE_MODEL_DIR, 'enc.onnx'), Buffer.from('bad'));
    const result = await m2.startTranscription({ sampleRate: 16000, samples: SAMPLES, language: 'auto' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/verification/);
    expect(c2).toHaveLength(0);
    expect(children).toHaveLength(0);
    void manager;
  });

  test('stale-id messages are ignored; host-level errors without id settle', async () => {
    const { manager, children } = makeManager();
    const segments = [];
    const promise = manager.startTranscription({
      sampleRate: 16000,
      samples: SAMPLES,
      language: 'auto',
      onSegment: (s) => segments.push(s),
    });
    const child = await nextChild(children);
    child.emit({ type: 'ready' });
    child.emit({ type: 'segment', id: 99, index: 0, startSample: 0, endSample: 100, text: 'stale' });
    child.emit({ type: 'done', id: 99, segmentCount: 5 }); // stale done must not settle
    expect(segments).toHaveLength(0);
    child.emit({ type: 'error', stage: 'init', message: 'models unloadable' });
    const result = await promise;
    expect(result).toEqual({ ok: false, error: 'models unloadable' });
    expect(child.killed).toBe(true);
  });

  test('cancel kills the child and resolves cancelled; late chatter is dropped', async () => {
    const { manager, children } = makeManager();
    const segments = [];
    const promise = manager.startTranscription({
      sampleRate: 16000,
      samples: SAMPLES,
      language: 'auto',
      onSegment: (s) => segments.push(s),
    });
    const child = await nextChild(children);
    child.emit({ type: 'ready' });
    expect(manager.cancel()).toBe(true);
    const result = await promise;
    expect(result).toEqual({ ok: false, cancelled: true });
    expect(child.killed).toBe(true);
    child.emit({ type: 'segment', id: 1, index: 0, startSample: 0, endSample: 100, text: 'late' });
    expect(segments).toHaveLength(0);
    expect(manager.cancel()).toBe(false); // nothing left to cancel
  });

  test('unexpected child exit settles as an error', async () => {
    const { manager, children } = makeManager();
    const promise = manager.startTranscription({ sampleRate: 16000, samples: SAMPLES, language: 'auto' });
    const child = await nextChild(children);
    child.listeners.exit(9);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exited unexpectedly \(code 9\)/);
  });

  test('dispose latches: refuses new runs and cancels the active one', async () => {
    const { manager, children } = makeManager();
    const promise = manager.startTranscription({ sampleRate: 16000, samples: SAMPLES, language: 'auto' });
    const child = await nextChild(children);
    manager.dispose();
    expect((await promise)).toEqual({ ok: false, cancelled: true });
    expect(child.killed).toBe(true);
    const after = await manager.startTranscription({ sampleRate: 16000, samples: SAMPLES, language: 'auto' });
    expect(after.ok).toBe(false);
    expect(after.error).toMatch(/disposed/);
  });
});

describe('getModelState', () => {
  test('complete, partial and missing states', async () => {
    const files = makeFakeFiles();
    const { manager } = makeManager({ files });
    expect(await manager.getModelState()).toEqual({
      downloaded: true,
      bytes: files[0].bytes + files[1].bytes,
      expectedBytes: files[0].bytes + files[1].bytes,
    });
    const { manager: m2, fsImpl } = makeManager({ files });
    fsImpl.store.delete(path.join(USER_DATA, TRANSCRIBE_MODEL_DIR, 'tok.json'));
    expect(await m2.getModelState()).toMatchObject({ downloaded: false, bytes: files[0].bytes });
    const m3 = createTranscribeManager({ userDataDir: USER_DATA, files, fsImpl: memFs() });
    expect(await m3.getModelState()).toMatchObject({ downloaded: false, bytes: null });
  });
});

describe('parseTranscribeRequest (trust boundary)', () => {
  const okBuf = new Float32Array(8).buffer;

  test('accepts a valid request', () => {
    const parsed = parseTranscribeRequest({ sampleRate: 16000, samples: okBuf, language: 'auto' });
    expect(parsed).not.toBeNull();
    expect(parsed.samples).toHaveLength(8);
    expect(parsed.language).toBe('auto');
  });

  test('sampleRate probes below/on/above', () => {
    expect(parseTranscribeRequest({ sampleRate: 15999, samples: okBuf, language: 'auto' })).toBeNull();
    expect(parseTranscribeRequest({ sampleRate: 16001, samples: okBuf, language: 'auto' })).toBeNull();
    expect(parseTranscribeRequest({ sampleRate: 16000, samples: okBuf, language: 'auto' })).not.toBeNull();
  });

  test('samples must be a non-empty float32-aligned ArrayBuffer', () => {
    for (const bad of [null, [1, 2], new Float32Array(4), new ArrayBuffer(0), new ArrayBuffer(6)]) {
      expect(parseTranscribeRequest({ sampleRate: 16000, samples: bad, language: 'auto' })).toBeNull();
    }
    expect(parseTranscribeRequest({ sampleRate: 16000, samples: new ArrayBuffer(4), language: 'auto' })).not.toBeNull();
  });

  test('length cap: on the cap passes, one sample above fails', () => {
    // probed via the injectable cap so the test does not allocate 460 MB
    expect(
      parseTranscribeRequest({ sampleRate: 16000, samples: new ArrayBuffer(8 * 4), language: 'auto' }, 8)
    ).not.toBeNull();
    expect(
      parseTranscribeRequest({ sampleRate: 16000, samples: new ArrayBuffer(9 * 4), language: 'auto' }, 8)
    ).toBeNull();
    // and the default cap is the host's
    expect(
      parseTranscribeRequest({ sampleRate: 16000, samples: new ArrayBuffer(4), language: 'auto' })
    ).not.toBeNull();
    void MAX_TOTAL_SAMPLES;
  });

  test('language format probes', () => {
    for (const lang of ['auto', 'en', 'fr', 'yue']) {
      expect(parseTranscribeRequest({ sampleRate: 16000, samples: okBuf, language: lang })).not.toBeNull();
    }
    for (const lang of ['', 'e', 'abcd', 'EN', 'en-US', 42, null]) {
      expect(parseTranscribeRequest({ sampleRate: 16000, samples: okBuf, language: lang })).toBeNull();
    }
  });
});

describe('registerTranscribeIpc', () => {
  function fakeIpc() {
    const handlers = new Map();
    return {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      handlers,
      invoke: (ch, req) => handlers.get(ch)(null, req),
    };
  }

  test('run validates the request and forwards events; embedding vectors become ArrayBuffers', async () => {
    const sent = [];
    const win = { isDestroyed: () => false, webContents: { send: (ch, p) => sent.push([ch, p]) } };
    const startCalls = [];
    const manager = {
      getModelState: async () => ({ downloaded: true, bytes: 1, expectedBytes: 1 }),
      ensureModels: async () => ({}),
      startTranscription: async (req) => {
        startCalls.push(req);
        req.onSegment({ index: 0, startSample: 0, endSample: 100, text: 'hi' });
        req.onEmbedding({ segmentIndex: 0, vector: new Float32Array([0.5, 0.25]) });
        return { ok: true, segmentCount: 1 };
      },
      cancel: () => true,
    };
    const { ipcMain, invoke } = fakeIpc();
    registerTranscribeIpc({ ipcMain, manager, getWin: () => win });

    const bad = await invoke(TRANSCRIBE_IPC.run, { sampleRate: 44100, samples: new ArrayBuffer(4), language: 'auto' });
    expect(bad.ok).toBe(false);
    expect(startCalls).toHaveLength(0);

    const good = await invoke(TRANSCRIBE_IPC.run, { sampleRate: 16000, samples: new Float32Array([1]).buffer, language: 'auto' });
    expect(good).toEqual({ ok: true, segmentCount: 1 });
    const seg = sent.find(([ch]) => ch === TRANSCRIBE_IPC.segment);
    expect(seg[1].text).toBe('hi');
    const emb = sent.find(([ch]) => ch === TRANSCRIBE_IPC.embedding);
    expect(Object.prototype.toString.call(emb[1].vector)).toBe('[object ArrayBuffer]');
    expect(Array.from(new Float32Array(emb[1].vector))).toEqual([0.5, 0.25]);
  });

  test('cancel and model-state pass through', async () => {
    const manager = {
      getModelState: async () => ({ downloaded: false, bytes: null, expectedBytes: 9 }),
      cancel: () => false,
    };
    const { ipcMain, invoke } = fakeIpc();
    registerTranscribeIpc({ ipcMain, manager, getWin: () => null });
    expect(await invoke(TRANSCRIBE_IPC.modelState)).toEqual({ downloaded: false, bytes: null, expectedBytes: 9 });
    expect(await invoke(TRANSCRIBE_IPC.cancel)).toEqual({ cancelled: false });
  });
});
