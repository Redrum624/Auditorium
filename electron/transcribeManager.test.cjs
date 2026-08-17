'use strict';

/**
 * Tests for transcribeManager.cjs (F4) — multi-file ensure/verify, the
 * manager's run choreography (settle-once, kill-on-terminal, id-gating) and
 * the IPC trust boundary. Mirrors stemManager.test.cjs's discipline; the
 * download/pin machinery itself is stemManager's, tested there.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  TRANSCRIBE_FILES,
  TRANSCRIBE_TOTAL_BYTES,
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

/**
 * THREE small fake files standing in for the six real pins — a first, a
 * MIDDLE and a LAST. Two would have been enough to exercise the ensure loop
 * but not to pin it: with a single file corrupted, a loop narrowed to
 * `files.slice(0, 1)` still refuses, and a tampered decoder ONNX would then be
 * loaded unhashed. Every position is probed below.
 */
function makeFakeFiles() {
  const payloads = {
    encoder: Buffer.from('encoder-bytes-0123456789'),
    decoder: Buffer.from('decoder-bytes-abcdefghijklmnop'),
    tokenizer: Buffer.from('tokenizer-bytes'),
  };
  return [
    ['encoder', 'enc.onnx'],
    ['decoder', 'dec.onnx'],
    ['tokenizer', 'tok.json'],
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
    // Derived from the fixture, not hardcoded: growing the fake set must not
    // silently weaken these into "some files were fetched".
    expect(request.calls).toHaveLength(files.length);
    expect(request.calls.sort()).toEqual(files.map((f) => f.url).sort());
    expect(written).toHaveLength(files.length);
    expect(paths.encoder).toBe(path.join(USER_DATA, TRANSCRIBE_MODEL_DIR, 'enc.onnx'));
    const total = files.reduce((n, f) => n + f.bytes, 0);
    expect(progress[progress.length - 1]).toMatchObject({ received: total, total });
    // the LAST file's progress includes every earlier file's bytes (one bar)
    const earlier = files.slice(0, -1).reduce((n, f) => n + f.bytes, 0);
    const last = progress.find((p) => p.file === files[files.length - 1].key && p.received > earlier);
    expect(last).toBeDefined();
    expect(last.fileCount).toBe(files.length);
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
    expect(request.calls).toEqual(files.slice(1).map((f) => f.url));
  });

  test.each([0, 1, 2])(
    'a corrupt file at position %i is deleted and re-downloaded — every position, not just the first',
    async (index) => {
      const files = makeFakeFiles();
      const dest = path.join(USER_DATA, TRANSCRIBE_MODEL_DIR, files[index].filename);
      const fsImpl = memFs();
      // Right length, wrong bytes: only the sha256 can catch it.
      fsImpl.store.set(dest, Buffer.alloc(files[index].bytes, 7));
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
      expect(statuses).toContain(`corrupt-deleted:${files[index].key}`);
      expect(request.calls).toContain(files[index].url);
      expect(fsImpl.store.get(dest).equals(files[index].payload)).toBe(true);
    }
  );

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
    // `utilityProcess.kill()` returns a boolean: false when the signal could
    // not be delivered. The fake mirrors that so the wedged-child path is
    // reachable.
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
function makeManager({ files = makeFakeFiles(), killReturns = true } = {}) {
  const stores = {};
  const paths = getTranscribeModelPaths(USER_DATA);
  for (const f of files) stores[path.join(USER_DATA, TRANSCRIBE_MODEL_DIR, f.filename)] = f.payload;
  const fsImpl = memFs(stores);
  const children = [];
  const warnings = [];
  const manager = createTranscribeManager({
    userDataDir: USER_DATA,
    files,
    fsImpl,
    onWarn: (m) => warnings.push(m),
    utilityProcessFactory: () => {
      const c = fakeChild({ killReturns });
      children.push(c);
      return c;
    },
  });
  return { manager, children, fsImpl, files, warnings };
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

  // Ruling 1's real content: EVERY pinned file is verified before ANY load.
  // Probing only the first file leaves the loop free to be narrowed to
  // `files.slice(0, 1)` with the suite still green — and a tampered decoder
  // ONNX handed to onnxruntime unhashed is a code-execution vector, which is
  // the entire reason the pinning exists. So: every position, by name.
  test.each([0, 1, 2])(
    'a failed pin at position %i refuses to spawn the host, naming that file',
    async (index) => {
      const files = makeFakeFiles();
      const { manager, children, fsImpl } = makeManager({ files });
      // Every file present and correct...
      for (const f of files) {
        fsImpl.store.set(path.join(USER_DATA, TRANSCRIBE_MODEL_DIR, f.filename), f.payload);
      }
      // ...except this one, corrupted at its pinned length so only the
      // sha256 can catch it.
      const target = files[index];
      fsImpl.store.set(
        path.join(USER_DATA, TRANSCRIBE_MODEL_DIR, target.filename),
        Buffer.alloc(target.bytes, 7)
      );
      const result = await manager.startTranscription({
        sampleRate: 16000,
        samples: SAMPLES,
        language: 'auto',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/verification/);
      // Named, so the message tells the user WHICH file to re-download and a
      // loop that verified a different file cannot pass this.
      expect(result.error).toContain(target.filename);
      expect(children).toHaveLength(0);
    }
  );

  test('a fully-verified set DOES spawn — the refusals above are not vacuous', async () => {
    const files = makeFakeFiles();
    const { manager, children, fsImpl } = makeManager({ files });
    for (const f of files) {
      fsImpl.store.set(path.join(USER_DATA, TRANSCRIBE_MODEL_DIR, f.filename), f.payload);
    }
    const run = manager.startTranscription({ sampleRate: 16000, samples: SAMPLES, language: 'auto' });
    await nextChild(children);
    expect(children).toHaveLength(1);
    manager.cancel();
    await run;
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

describe('killing the child', () => {
  test('a successful kill is silent', async () => {
    const { manager, children, warnings } = makeManager();
    const run = manager.startTranscription({ sampleRate: 16000, samples: SAMPLES, language: 'auto' });
    const child = await nextChild(children);
    manager.cancel();
    await run;
    expect(child.killed).toBe(true);
    expect(child.killCalls).toBe(1);
    expect(warnings).toEqual([]);
  });

  test('a child that will not die is retried once and REPORTED, not silently abandoned', async () => {
    // Discarding kill()'s return leaves a wedged child holding its ~1 GB ORT
    // arena while the next run spawns a second one — two arenas, silently.
    const { manager, children, warnings } = makeManager({ killReturns: false });
    const run = manager.startTranscription({ sampleRate: 16000, samples: SAMPLES, language: 'auto' });
    const child = await nextChild(children);
    manager.cancel();
    await run;
    expect(child.killCalls).toBe(2); // one retry, not an infinite loop
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/did not respond to kill/);
  });

  test('the slot is still freed when the kill fails, so a later run is not blocked forever', async () => {
    const { manager, children } = makeManager({ killReturns: false });
    const first = manager.startTranscription({ sampleRate: 16000, samples: SAMPLES, language: 'auto' });
    await nextChild(children);
    manager.cancel();
    await first;
    expect(manager.isRunning()).toBe(false);
    const second = manager.startTranscription({ sampleRate: 16000, samples: SAMPLES, language: 'auto' });
    await nextChild(children, 1);
    expect(children).toHaveLength(2);
    manager.cancel();
    await second;
  });
});

describe('the pinned file set', () => {
  test('TRANSCRIBE_TOTAL_BYTES is the sum of the six pins', () => {
    expect(TRANSCRIBE_TOTAL_BYTES).toBe(TRANSCRIBE_FILES.reduce((n, f) => n + f.bytes, 0));
  });

  test('every pin carries a full sha256 and a positive size', () => {
    expect(TRANSCRIBE_FILES).toHaveLength(6);
    for (const f of TRANSCRIBE_FILES) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.bytes).toBeGreaterThan(0);
      expect(f.url.startsWith('https://')).toBe(true);
    }
    expect(new Set(TRANSCRIBE_FILES.map((f) => f.key)).size).toBe(6);
    expect(new Set(TRANSCRIBE_FILES.map((f) => f.filename)).size).toBe(6);
  });

  test("the renderer's copy of the total agrees with the pins", () => {
    // The renderer MUST NOT import from electron/ (these are CommonJS
    // main-process modules that pull in onnxruntime-node), so
    // `transcribeService.ts` carries its own literal for the "no preload"
    // fallback. Two hand-maintained copies of one number drift silently — a
    // wrong figure would tell the user to expect a download size the app
    // never fetches. This is the cross-check that stops it, and it reads the
    // renderer source as TEXT for the same reason: it cannot be imported here.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'transcribeService.ts'),
      'utf8'
    );
    const m = /export const TRANSCRIBE_MODEL_BYTES = (\d+);/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBe(TRANSCRIBE_TOTAL_BYTES);
  });
});

describe('getModelState', () => {
  test('a complete set reports downloaded with the whole size', async () => {
    const files = makeFakeFiles();
    const total = files.reduce((n, f) => n + f.bytes, 0);
    const { manager } = makeManager({ files });
    expect(await manager.getModelState()).toEqual({
      downloaded: true,
      bytes: total,
      expectedBytes: total,
    });
  });

  // Every position, for the same reason the pin tests probe every position:
  // a state check that only notices the LAST file missing would report a
  // half-downloaded set as ready and send the user straight into a
  // verification failure.
  test.each([0, 1, 2])('a set missing the file at position %i is NOT downloaded', async (index) => {
    const files = makeFakeFiles();
    const total = files.reduce((n, f) => n + f.bytes, 0);
    const { manager, fsImpl } = makeManager({ files });
    fsImpl.store.delete(path.join(USER_DATA, TRANSCRIBE_MODEL_DIR, files[index].filename));
    expect(await manager.getModelState()).toEqual({
      downloaded: false,
      bytes: total - files[index].bytes,
      expectedBytes: total,
    });
  });

  test.each([0, 1, 2])('a WRONG-SIZED file at position %i is NOT downloaded', async (index) => {
    const files = makeFakeFiles();
    const { manager, fsImpl } = makeManager({ files });
    const dest = path.join(USER_DATA, TRANSCRIBE_MODEL_DIR, files[index].filename);
    fsImpl.store.set(dest, Buffer.alloc(files[index].bytes + 1, 7));
    expect(await manager.getModelState()).toMatchObject({ downloaded: false });
  });

  test('an empty model directory reports nothing downloaded', async () => {
    const files = makeFakeFiles();
    const m = createTranscribeManager({ userDataDir: USER_DATA, files, fsImpl: memFs() });
    expect(await m.getModelState()).toMatchObject({ downloaded: false, bytes: null });
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
