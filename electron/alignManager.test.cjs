'use strict';

/**
 * Tests for alignManager.cjs (F6) — two-file ensure/verify, the manager's run
 * choreography (settle-once, kill-on-terminal, id-gating, the held emission
 * grid) and the IPC trust boundary. Mirrors transcribeManager.test.cjs's
 * discipline; the download/pin machinery itself is stemManager's, tested there.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const {
  ALIGN_FILES,
  ALIGN_TOTAL_BYTES,
  ALIGN_MODEL_DIR,
  ALIGN_IPC,
  getAlignModelPaths,
  ensureAlignModels,
  createAlignManager,
  registerAlignIpc,
  parseAlignRequest,
} = require('./alignManager.cjs');
const { MAX_TOTAL_SAMPLES, ALIGN_SAMPLE_RATE, FRAME_SAMPLES } = require('./alignHost.cjs');

const USER_DATA = 'C:\\fake\\userData';

/**
 * Two small fake files standing in for the two real pins, under the REAL keys:
 * the set is `model` + `vocab` and every loop below is probed at both
 * positions, so a loop narrowed to `files.slice(0, 1)` — which would hand an
 * unhashed 378 MB ONNX graph to onnxruntime — cannot pass.
 */
function makeFakeFiles() {
  const payloads = {
    model: Buffer.from('model-graph-bytes-0123456789'),
    vocab: Buffer.from('{"<pad>":0,"|":4}'),
  };
  return [
    ['model', 'w2v2.onnx'],
    ['vocab', 'w2v2-vocab.json'],
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

describe('the pinned file set', () => {
  test('ALIGN_TOTAL_BYTES is the size the renderer quotes with no preload answering', () => {
    // This used to restate the constant's own definition
    // (`ALIGN_FILES.reduce((n, f) => n + f.bytes, 0)`), an expression that
    // cannot fail whatever the pins say.
    //
    // The number has exactly one obligation, and it crosses a boundary:
    // `ALIGN_MODEL_BYTES` in `src/services/alignLyricsService.ts` hardcodes it
    // as the size the dialog shows before the preload answers, documented there
    // as "the sum of the two `bytes` pins in electron/alignManager.cjs
    // ALIGN_FILES". The `main` and `renderer` jest projects cannot import each
    // other, so the agreement is written down rather than computed — and a
    // re-pin of either model file now fails HERE, next to the pins, instead of
    // silently making the renderer quote a stale megabyte count.
    expect(ALIGN_TOTAL_BYTES).toBe(377912182);
    expect(ALIGN_FILES).toHaveLength(2);
  });

  test('every pin carries a full sha256, a positive size and an https URL', () => {
    expect(ALIGN_FILES).toHaveLength(2);
    for (const f of ALIGN_FILES) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.bytes).toBeGreaterThan(0);
      expect(f.url.startsWith('https://')).toBe(true);
    }
    expect(new Set(ALIGN_FILES.map((f) => f.key)).size).toBe(2);
    expect(new Set(ALIGN_FILES.map((f) => f.filename)).size).toBe(2);
  });

  test('the vocab comes from the OFFICIAL Apache-2.0 repo, not the unlicensed ONNX mirror', () => {
    // The module header's licence ruling in executable form: only the GRAPH
    // rides the inherited-licence derivation. If someone "tidies" both URLs to
    // one repo, the ruling silently stops being true.
    const model = ALIGN_FILES.find((f) => f.key === 'model');
    const vocab = ALIGN_FILES.find((f) => f.key === 'vocab');
    expect(model.url).toContain('onnx-community/wav2vec2-base-960h-ONNX');
    expect(vocab.url).toContain('facebook/wav2vec2-base-960h');
  });
});

describe('getAlignModelPaths', () => {
  test('maps both keys under models/align', () => {
    const paths = getAlignModelPaths(USER_DATA);
    expect(Object.keys(paths).sort()).toEqual(['model', 'vocab']);
    expect(paths.model).toBe(
      path.join(USER_DATA, ALIGN_MODEL_DIR, 'wav2vec2-base-960h.onnx')
    );
    expect(paths.vocab).toBe(
      path.join(USER_DATA, ALIGN_MODEL_DIR, 'wav2vec2-base-960h-vocab.json')
    );
    expect(ALIGN_MODEL_DIR).toBe(path.join('models', 'align'));
  });

  test('an injected file set is mapped instead of the pins (paths and pins must agree)', () => {
    const files = makeFakeFiles();
    const paths = getAlignModelPaths(USER_DATA, files);
    expect(paths.model).toBe(path.join(USER_DATA, ALIGN_MODEL_DIR, 'w2v2.onnx'));
  });
});

describe('ensureAlignModels', () => {
  test('downloads every missing file, verifies, atomically commits, reports OVERALL progress', async () => {
    const files = makeFakeFiles();
    const fsImpl = memFs();
    const written = [];
    const progress = [];
    const request = fakeRequest(files);
    const paths = await ensureAlignModels({
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
    expect(paths.model).toBe(path.join(USER_DATA, ALIGN_MODEL_DIR, 'w2v2.onnx'));
    const total = files.reduce((n, f) => n + f.bytes, 0);
    expect(progress[progress.length - 1]).toMatchObject({ received: total, total });
    // The LAST file's progress includes every earlier file's bytes (one bar) —
    // this is what stops a 291-byte vocab restarting the bar after 378 MB.
    const earlier = files.slice(0, -1).reduce((n, f) => n + f.bytes, 0);
    const last = progress.find((p) => p.file === files[files.length - 1].key && p.received > earlier);
    expect(last).toBeDefined();
    expect(last.fileCount).toBe(files.length);
    expect(last.fileIndex).toBe(files.length - 1);
  });

  test.each([0, 1])('an already-verified file at position %i is not re-downloaded', async (index) => {
    const files = makeFakeFiles();
    const fsImpl = memFs({
      [path.join(USER_DATA, ALIGN_MODEL_DIR, files[index].filename)]: files[index].payload,
    });
    const request = fakeRequest(files);
    await ensureAlignModels({
      userDataDir: USER_DATA,
      files,
      fsImpl,
      requestImpl: request,
      atomicWrite: async (dest, buf) => fsImpl.store.set(dest, buf),
    });
    expect(request.calls).toEqual(files.filter((_, i) => i !== index).map((f) => f.url));
  });

  test.each([0, 1])(
    'a corrupt file at position %i is deleted and re-downloaded — every position, not just the first',
    async (index) => {
      const files = makeFakeFiles();
      const dest = path.join(USER_DATA, ALIGN_MODEL_DIR, files[index].filename);
      const fsImpl = memFs();
      // Right length, wrong bytes: only the sha256 can catch it.
      fsImpl.store.set(dest, Buffer.alloc(files[index].bytes, 7));
      const statuses = [];
      const request = fakeRequest(files);
      await ensureAlignModels({
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

  test.each([0, 1])(
    'a downloaded payload failing its sha256 pin at position %i is refused and not saved',
    async (index) => {
      const files = makeFakeFiles();
      const request = fakeRequest(files); // captured BEFORE the pin is broken
      files[index].sha256 = '0'.repeat(64); // pin cannot match
      const written = [];
      await expect(
        ensureAlignModels({
          userDataDir: USER_DATA,
          files,
          fsImpl: memFs(),
          requestImpl: request,
          atomicWrite: async (dest) => written.push(dest),
        })
      ).rejects.toThrow(/sha256 verification/);
      // Earlier files in the set may legitimately have been committed; the
      // file that failed its pin must NOT be among them.
      expect(written).not.toContain(path.join(USER_DATA, ALIGN_MODEL_DIR, files[index].filename));
    }
  );

  test('a downloaded payload of the wrong SIZE is refused and not saved', async () => {
    const files = makeFakeFiles();
    const request = fakeRequest(files);
    // One byte longer than what the server will serve: the size gate fires
    // before the digest is even computed, and its message names both numbers.
    files[0].bytes += 1;
    const written = [];
    await expect(
      ensureAlignModels({
        userDataDir: USER_DATA,
        files,
        fsImpl: memFs(),
        requestImpl: request,
        atomicWrite: async (dest) => written.push(dest),
      })
    ).rejects.toThrow(/size verification/);
    expect(written).toHaveLength(0);
  });

  test('an aborting shouldAbort stops an in-flight ensure', async () => {
    // The free function's `shouldAbort` plumbing. This test used to be NAMED
    // for the dispose latch, which it never touched — see the manager-level
    // test below for that.
    const files = makeFakeFiles();
    let abort = false;
    await expect(
      ensureAlignModels({
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

  test('the manager’s dispose() latch aborts an in-flight ensure', async () => {
    // The real latch: `disposed` is a closure variable inside
    // `createAlignManager`, read as `shouldAbort: () => disposed` by the
    // manager's own ensureModels. Nothing outside can set it except dispose(),
    // so reaching it means constructing a manager and disposing it WHILE the
    // download is in flight — which is the app-quit path this latch exists for.
    const files = makeFakeFiles();
    let disposedDuringRequest = false;
    const manager = createAlignManager({
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
    // The abort came from the latch, not from the thrown request: the request
    // really did run, and the retry that follows it is what read `disposed`.
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
 * Waits for the manager to spawn child `index`. startAlignment verifies EVERY
 * pin before it spawns anything, and each verification is a stat plus a
 * streamed sha256 — several event-loop turns, and the exact count is an
 * implementation detail of the file set. So poll for the child rather than
 * hard-coding a number of ticks, and fail loudly if it never arrives (otherwise
 * a genuine refusal-to-spawn would surface as `undefined.emit`).
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
  for (const f of files) stores[path.join(USER_DATA, ALIGN_MODEL_DIR, f.filename)] = f.payload;
  const fsImpl = memFs(stores);
  const children = [];
  const warnings = [];
  const manager = createAlignManager({
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

const SAMPLES = new Float32Array(ALIGN_SAMPLE_RATE).fill(0.1);
/** A 2-frame × 3-class grid: small enough to assert element-wise. */
const FAKE_FRAMES = 2;
const FAKE_CLASSES = 3;
const FAKE_VOCAB = Object.freeze({ '<pad>': 0, '|': 1, A: 2 });
function fakeGrid() {
  return new Float32Array([-0.1, -2.0, -3.0, -0.2, -1.5, -4.0]);
}

describe('createAlignManager.startAlignment', () => {
  test('full choreography: verify → spawn → init/align/audio/run → emissions → done', async () => {
    const { manager, children } = makeManager();
    const progress = [];
    const promise = manager.startAlignment({
      sampleRate: ALIGN_SAMPLE_RATE,
      samples: SAMPLES,
      onProgress: (p) => progress.push(p),
    });
    const child = await nextChild(children);
    expect(child.posted[0]).toMatchObject({ type: 'init' });
    expect(child.posted[0].paths.model).toContain('w2v2.onnx');
    expect(child.posted[0].paths.vocab).toContain('w2v2-vocab.json');
    child.emit({ type: 'ready', vocab: FAKE_VOCAB });
    expect(child.posted.map((m) => m.type)).toEqual(['init', 'align', 'audio', 'run']);
    expect(child.posted[1]).toMatchObject({
      id: 1,
      sampleRate: ALIGN_SAMPLE_RATE,
      totalSamples: SAMPLES.length,
    });
    // EVERY message of the job carries the same run id, not just the one that
    // opens it. The host gates on the id, so an id dropped from 'audio' or
    // 'run' strands the job — and only 'align' used to be pinned.
    expect(child.posted[2]).toMatchObject({ type: 'audio', id: 1, offset: 0 });
    expect(child.posted[3]).toEqual({ type: 'run', id: 1 });
    expect(child.posted.slice(1).map((m) => m.id)).toEqual([1, 1, 1]);
    child.emit({ type: 'progress', id: 1, done: 8000, total: SAMPLES.length });
    child.emit({
      type: 'emissions',
      id: 1,
      frames: FAKE_FRAMES,
      classes: FAKE_CLASSES,
      frameSamples: FRAME_SAMPLES,
      logProbs: fakeGrid(),
    });
    child.emit({ type: 'done', id: 1, frames: FAKE_FRAMES });
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.frames).toBe(FAKE_FRAMES);
    expect(result.classes).toBe(FAKE_CLASSES);
    expect(result.frameSamples).toBe(FRAME_SAMPLES);
    expect(result.vocab).toEqual(FAKE_VOCAB);
    expect(Array.from(result.logProbs)).toEqual(Array.from(fakeGrid()));
    expect(progress).toEqual([{ done: 8000, total: SAMPLES.length }]);
    expect(child.killed).toBe(true); // done is a terminal branch too
    expect(manager.isRunning()).toBe(false);
  });

  test('audio is sliced into bounded copies that tile the track', async () => {
    const { manager, children } = makeManager();
    const sliceSamples = 1 << 20; // AUDIO_SLICE_SAMPLES, the module's constant
    const big = new Float32Array(sliceSamples + 5); // one full slice + a tail
    const promise = manager.startAlignment({ sampleRate: ALIGN_SAMPLE_RATE, samples: big });
    const child = await nextChild(children);
    child.emit({ type: 'ready', vocab: FAKE_VOCAB });
    const audio = child.posted.filter((m) => m.type === 'audio');
    expect(audio).toHaveLength(2);
    expect(audio[0].offset).toBe(0);
    expect(audio[0].samples.length).toBe(sliceSamples);
    expect(audio[1].offset).toBe(sliceSamples);
    expect(audio[1].samples.length).toBe(5);
    // Both slices belong to the same job, and say so.
    expect(audio.map((m) => m.id)).toEqual([1, 1]);
    // .slice, not .subarray: each message owns its bytes, so structured clone
    // cannot serialise the whole track once per chunk.
    expect(audio[0].samples.buffer.byteLength).toBe(sliceSamples * 4);
    manager.cancel();
    await promise;
  });

  test('busy gate: a second start resolves busy without spawning', async () => {
    const { manager, children } = makeManager();
    const first = manager.startAlignment({ sampleRate: ALIGN_SAMPLE_RATE, samples: SAMPLES });
    const second = await manager.startAlignment({ sampleRate: ALIGN_SAMPLE_RATE, samples: SAMPLES });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/busy/);
    await nextChild(children);
    expect(children).toHaveLength(1);
    manager.cancel();
    await first;
  });

  // Ruling 1's real content: EVERY pinned file is verified before ANY load.
  // Probing only the first file leaves the loop free to be narrowed to
  // `files.slice(0, 1)` with the suite still green — and a tampered ONNX graph
  // handed to onnxruntime unhashed is a code-execution vector, which is the
  // entire reason the pinning exists. So: every position, by name.
  test.each([0, 1])(
    'a failed pin at position %i refuses to spawn the host, naming that file',
    async (index) => {
      const files = makeFakeFiles();
      const { manager, children, fsImpl } = makeManager({ files });
      const target = files[index];
      // Corrupted at its pinned length, so only the sha256 can catch it.
      fsImpl.store.set(
        path.join(USER_DATA, ALIGN_MODEL_DIR, target.filename),
        Buffer.alloc(target.bytes, 7)
      );
      const result = await manager.startAlignment({
        sampleRate: ALIGN_SAMPLE_RATE,
        samples: SAMPLES,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/verification/);
      // Named, so the message tells the user WHICH file to re-download and a
      // loop that verified a different file cannot pass this.
      expect(result.error).toContain(target.filename);
      expect(children).toHaveLength(0); // the factory was never called
    }
  );

  test('a fully-verified set DOES spawn — the refusals above are not vacuous', async () => {
    const { manager, children } = makeManager();
    const run = manager.startAlignment({ sampleRate: ALIGN_SAMPLE_RATE, samples: SAMPLES });
    await nextChild(children);
    expect(children).toHaveLength(1);
    manager.cancel();
    await run;
  });

  test('stale-id messages are ignored; host-level errors without id settle', async () => {
    const { manager, children } = makeManager();
    const progress = [];
    const promise = manager.startAlignment({
      sampleRate: ALIGN_SAMPLE_RATE,
      samples: SAMPLES,
      onProgress: (p) => progress.push(p),
    });
    const child = await nextChild(children);
    child.emit({ type: 'ready', vocab: FAKE_VOCAB });
    child.emit({ type: 'progress', id: 99, done: 1, total: 2 });
    child.emit({ type: 'done', id: 99, frames: 5 }); // stale done must not settle
    expect(progress).toHaveLength(0);
    child.emit({ type: 'error', stage: 'init', message: 'models unloadable' });
    const result = await promise;
    expect(result).toEqual({ ok: false, error: 'models unloadable' });
    expect(child.killed).toBe(true);
  });

  test('a run-stage error carrying the run id settles', async () => {
    const { manager, children } = makeManager();
    const promise = manager.startAlignment({ sampleRate: ALIGN_SAMPLE_RATE, samples: SAMPLES });
    const child = await nextChild(children);
    child.emit({ type: 'ready', vocab: FAKE_VOCAB });
    child.emit({ type: 'error', stage: 'run', id: 1, message: 'graph changed mid-job' });
    expect(await promise).toEqual({ ok: false, error: 'graph changed mid-job' });
    expect(child.killed).toBe(true);
  });

  test("'done' without an emission grid is an error, not a half-filled success", async () => {
    // A caller handed {ok:true} with no grid would fail deeper, inside the
    // Viterbi, where the message would name neither the host nor the contract.
    const { manager, children } = makeManager();
    const promise = manager.startAlignment({ sampleRate: ALIGN_SAMPLE_RATE, samples: SAMPLES });
    const child = await nextChild(children);
    child.emit({ type: 'ready', vocab: FAKE_VOCAB });
    child.emit({ type: 'done', id: 1, frames: 3 });
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/without delivering an emission grid/);
  });

  test('cancel kills the child and resolves cancelled; late chatter is dropped', async () => {
    const { manager, children } = makeManager();
    const progress = [];
    const promise = manager.startAlignment({
      sampleRate: ALIGN_SAMPLE_RATE,
      samples: SAMPLES,
      onProgress: (p) => progress.push(p),
    });
    const child = await nextChild(children);
    child.emit({ type: 'ready', vocab: FAKE_VOCAB });
    expect(manager.cancel()).toBe(true);
    expect(await promise).toEqual({ ok: false, cancelled: true });
    expect(child.killed).toBe(true);
    child.emit({ type: 'progress', id: 1, done: 1, total: 2 });
    expect(progress).toHaveLength(0);
    expect(manager.cancel()).toBe(false); // nothing left to cancel
  });

  test("a host 'cancelled' message settles cancelled", async () => {
    const { manager, children } = makeManager();
    const promise = manager.startAlignment({ sampleRate: ALIGN_SAMPLE_RATE, samples: SAMPLES });
    const child = await nextChild(children);
    child.emit({ type: 'ready', vocab: FAKE_VOCAB });
    child.emit({ type: 'cancelled', id: 1 });
    expect(await promise).toEqual({ ok: false, cancelled: true });
  });

  test('unexpected child exit settles as an error', async () => {
    const { manager, children } = makeManager();
    const promise = manager.startAlignment({ sampleRate: ALIGN_SAMPLE_RATE, samples: SAMPLES });
    const child = await nextChild(children);
    child.listeners.exit(9);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exited unexpectedly \(code 9\)/);
  });

  test('a factory that throws settles instead of rejecting', async () => {
    const files = makeFakeFiles();
    const stores = {};
    for (const f of files) stores[path.join(USER_DATA, ALIGN_MODEL_DIR, f.filename)] = f.payload;
    const manager = createAlignManager({
      userDataDir: USER_DATA,
      files,
      fsImpl: memFs(stores),
      utilityProcessFactory: () => {
        throw new Error('no utilityProcess in this build');
      },
    });
    const result = await manager.startAlignment({
      sampleRate: ALIGN_SAMPLE_RATE,
      samples: SAMPLES,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/failed to spawn alignment host/);
    expect(manager.isRunning()).toBe(false);
  });

  test('dispose latches: refuses new runs and cancels the active one', async () => {
    const { manager, children } = makeManager();
    const promise = manager.startAlignment({ sampleRate: ALIGN_SAMPLE_RATE, samples: SAMPLES });
    const child = await nextChild(children);
    manager.dispose();
    expect(await promise).toEqual({ ok: false, cancelled: true });
    expect(child.killed).toBe(true);
    const after = await manager.startAlignment({ sampleRate: ALIGN_SAMPLE_RATE, samples: SAMPLES });
    expect(after.ok).toBe(false);
    expect(after.error).toMatch(/disposed/);
    expect(children).toHaveLength(1); // the latch refuses BEFORE spawning
  });
});

describe('killing the child', () => {
  test('a successful kill is silent', async () => {
    const { manager, children, warnings } = makeManager();
    const run = manager.startAlignment({ sampleRate: ALIGN_SAMPLE_RATE, samples: SAMPLES });
    const child = await nextChild(children);
    manager.cancel();
    await run;
    expect(child.killed).toBe(true);
    expect(child.killCalls).toBe(1);
    expect(warnings).toEqual([]);
  });

  test('a child that will not die is retried once and REPORTED, not silently abandoned', async () => {
    // Discarding kill()'s return leaves a wedged child holding its ORT arena
    // while the next run spawns a second one — two arenas, silently.
    const { manager, children, warnings } = makeManager({ killReturns: false });
    const run = manager.startAlignment({ sampleRate: ALIGN_SAMPLE_RATE, samples: SAMPLES });
    const child = await nextChild(children);
    manager.cancel();
    await run;
    expect(child.killCalls).toBe(2); // one retry, not an infinite loop
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/did not respond to kill/);
  });

  test('the slot is still freed when the kill fails, so a later run is not blocked forever', async () => {
    const { manager, children } = makeManager({ killReturns: false });
    const first = manager.startAlignment({ sampleRate: ALIGN_SAMPLE_RATE, samples: SAMPLES });
    await nextChild(children);
    manager.cancel();
    await first;
    expect(manager.isRunning()).toBe(false);
    const second = manager.startAlignment({ sampleRate: ALIGN_SAMPLE_RATE, samples: SAMPLES });
    await nextChild(children, 1);
    expect(children).toHaveLength(2);
    manager.cancel();
    await second;
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

  // Every position, for the same reason the pin tests probe every position: a
  // state check that only notices the LAST file missing would report a
  // half-downloaded set as ready and send the user straight into a
  // verification failure.
  test.each([0, 1])('a set missing the file at position %i is NOT downloaded', async (index) => {
    const files = makeFakeFiles();
    const total = files.reduce((n, f) => n + f.bytes, 0);
    const { manager, fsImpl } = makeManager({ files });
    fsImpl.store.delete(path.join(USER_DATA, ALIGN_MODEL_DIR, files[index].filename));
    expect(await manager.getModelState()).toEqual({
      downloaded: false,
      bytes: total - files[index].bytes,
      expectedBytes: total,
    });
  });

  test.each([0, 1])('a WRONG-SIZED file at position %i is NOT downloaded', async (index) => {
    const files = makeFakeFiles();
    const { manager, fsImpl } = makeManager({ files });
    const dest = path.join(USER_DATA, ALIGN_MODEL_DIR, files[index].filename);
    fsImpl.store.set(dest, Buffer.alloc(files[index].bytes + 1, 7));
    expect(await manager.getModelState()).toMatchObject({ downloaded: false });
  });

  test('an empty model directory reports nothing downloaded', async () => {
    const files = makeFakeFiles();
    const m = createAlignManager({ userDataDir: USER_DATA, files, fsImpl: memFs() });
    expect(await m.getModelState()).toMatchObject({ downloaded: false, bytes: null });
  });
});

describe('parseAlignRequest (trust boundary)', () => {
  const okBuf = new Float32Array(8).buffer;

  test('accepts a valid request and WRAPS the transferred buffer in a Float32Array view', () => {
    const buf = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    const parsed = parseAlignRequest({ sampleRate: ALIGN_SAMPLE_RATE, samples: buf });
    expect(parsed).not.toBeNull();
    expect(parsed.samples).toHaveLength(8);
    expect(Object.prototype.toString.call(parsed.samples)).toBe('[object Float32Array]');

    // A VIEW, not a copy. `new Float32Array(someArrayBuffer)` aliases the
    // caller's bytes — this test used to be named for a copy, which is the
    // opposite of what the boundary does. It is safe precisely because the
    // buffer arrived by structured clone across IPC, so the renderer no longer
    // shares it; naming it a copy hid which of those two facts is load-bearing.
    expect(parsed.samples.buffer).toBe(buf);
    new Float32Array(buf)[0] = 42;
    expect(parsed.samples[0]).toBe(42);
  });

  test('sampleRate probes below/on/above', () => {
    expect(ALIGN_SAMPLE_RATE).toBe(16000); // the boundary the probes below assume
    expect(parseAlignRequest({ sampleRate: 15999, samples: okBuf })).toBeNull();
    expect(parseAlignRequest({ sampleRate: 16000, samples: okBuf })).not.toBeNull();
    expect(parseAlignRequest({ sampleRate: 16001, samples: okBuf })).toBeNull();
  });

  test('a non-object request is refused', () => {
    for (const bad of [null, undefined, 'align', 42]) {
      expect(parseAlignRequest(bad)).toBeNull();
    }
  });

  test('samples must be a non-empty float32-aligned ArrayBuffer', () => {
    // A Float32Array is NOT an ArrayBuffer: accepting a view would let the
    // renderer hand over a window onto a much larger arena.
    for (const bad of [null, [1, 2], new Float32Array(4), new ArrayBuffer(0)]) {
      expect(parseAlignRequest({ sampleRate: ALIGN_SAMPLE_RATE, samples: bad })).toBeNull();
    }
  });

  test('byteLength alignment probes below/on/above a float32', () => {
    // 4 bytes is one sample; 3 and 5 are not whole samples and a Float32Array
    // view over them would throw at the boundary instead of being refused.
    expect(parseAlignRequest({ sampleRate: ALIGN_SAMPLE_RATE, samples: new ArrayBuffer(3) })).toBeNull();
    expect(parseAlignRequest({ sampleRate: ALIGN_SAMPLE_RATE, samples: new ArrayBuffer(4) })).not.toBeNull();
    expect(parseAlignRequest({ sampleRate: ALIGN_SAMPLE_RATE, samples: new ArrayBuffer(5) })).toBeNull();
    expect(parseAlignRequest({ sampleRate: ALIGN_SAMPLE_RATE, samples: new ArrayBuffer(6) })).toBeNull();
  });

  test('length cap: below and on pass, one sample above fails', () => {
    // Probed via the injectable cap so the test does not allocate the 76.8 MB
    // the real 20-minute cap implies.
    const cap = 8;
    expect(parseAlignRequest({ sampleRate: ALIGN_SAMPLE_RATE, samples: new ArrayBuffer(7 * 4) }, cap)).not.toBeNull();
    expect(parseAlignRequest({ sampleRate: ALIGN_SAMPLE_RATE, samples: new ArrayBuffer(8 * 4) }, cap)).not.toBeNull();
    expect(parseAlignRequest({ sampleRate: ALIGN_SAMPLE_RATE, samples: new ArrayBuffer(9 * 4) }, cap)).toBeNull();
  });

  test("the default cap is the HOST's cap — probed ON it and one sample over, with no cap argument", () => {
    // The renderer's cap MUST equal the host's or a job accepted here is
    // refused at the host with an opaque message. `MAX_TOTAL_SAMPLES` is
    // imported from `./alignHost.cjs` above, so probing the DEFAULT against it
    // is what ties the two together.
    //
    // Every probe below omits the cap argument, which is the only way to
    // observe the default at all. The previous version passed a 4-byte buffer
    // each time — accepted by any default >= 1 — and its only over-cap probe
    // passed the cap explicitly, so the default's value was unobservable and
    // the `overCap` stand-in it built was never used.
    //
    // A real buffer at the cap is 76.8 MB, so both probes use a branded
    // stand-in: `Object.prototype.toString` is what the parser tests, and
    // ArrayBuffer.prototype carries the `Symbol.toStringTag` it reads.
    const branded = (byteLength) => Object.setPrototypeOf({ byteLength }, ArrayBuffer.prototype);
    expect(Object.prototype.toString.call(branded(4))).toBe('[object ArrayBuffer]');

    const at = (samples) => parseAlignRequest({ sampleRate: ALIGN_SAMPLE_RATE, samples });
    expect(at(branded((MAX_TOTAL_SAMPLES - 1) * 4))).not.toBeNull(); // below
    expect(at(branded(MAX_TOTAL_SAMPLES * 4))).not.toBeNull(); // ON
    expect(at(branded((MAX_TOTAL_SAMPLES + 1) * 4))).toBeNull(); // over
  });
});

describe('registerAlignIpc', () => {
  function fakeIpc() {
    const handlers = new Map();
    return {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      handlers,
      invoke: (ch, req) => handlers.get(ch)(null, req),
    };
  }

  /** Manager double that records calls and streams one progress event. */
  function fakeManager({ result } = {}) {
    const startCalls = [];
    return {
      startCalls,
      getModelState: async () => ({ downloaded: true, bytes: 1, expectedBytes: 1 }),
      ensureModels: async ({ onProgress }) => {
        onProgress({ file: 'model', fileIndex: 0, fileCount: 2, received: 1, total: 1 });
        return {};
      },
      startAlignment: async (req) => {
        startCalls.push(req);
        req.onProgress({ done: 320, total: 640 });
        return (
          result || {
            ok: true,
            frames: FAKE_FRAMES,
            classes: FAKE_CLASSES,
            frameSamples: FRAME_SAMPLES,
            vocab: FAKE_VOCAB,
            logProbs: fakeGrid(),
          }
        );
      },
      cancel: () => true,
    };
  }

  test('registers exactly the four documented channels', () => {
    const { ipcMain, handlers } = fakeIpc();
    registerAlignIpc({ ipcMain, manager: fakeManager(), getWin: () => null });
    expect([...handlers.keys()].sort()).toEqual(
      [ALIGN_IPC.modelState, ALIGN_IPC.ensureModels, ALIGN_IPC.run, ALIGN_IPC.cancel].sort()
    );
  });

  test('an invalid request is refused WITHOUT touching the manager', async () => {
    const manager = fakeManager();
    const { ipcMain, invoke } = fakeIpc();
    const sent = [];
    const win = { isDestroyed: () => false, webContents: { send: (ch, p) => sent.push([ch, p]) } };
    registerAlignIpc({ ipcMain, manager, getWin: () => win });
    for (const bad of [
      { sampleRate: 44100, samples: new ArrayBuffer(4) },
      { sampleRate: ALIGN_SAMPLE_RATE, samples: new ArrayBuffer(0) },
      { sampleRate: ALIGN_SAMPLE_RATE, samples: new Float32Array(4) },
      null,
    ]) {
      const res = await invoke(ALIGN_IPC.run, bad);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/invalid align request/);
    }
    expect(manager.startCalls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  test('a valid run forwards progress and hands the grid over as an ArrayBuffer', async () => {
    const manager = fakeManager();
    const sent = [];
    const win = { isDestroyed: () => false, webContents: { send: (ch, p) => sent.push([ch, p]) } };
    const { ipcMain, invoke } = fakeIpc();
    registerAlignIpc({ ipcMain, manager, getWin: () => win });
    const res = await invoke(ALIGN_IPC.run, {
      sampleRate: ALIGN_SAMPLE_RATE,
      samples: new Float32Array([1, 2]).buffer,
    });
    expect(manager.startCalls).toHaveLength(1);
    expect(manager.startCalls[0].sampleRate).toBe(ALIGN_SAMPLE_RATE);
    expect(manager.startCalls[0].samples).toHaveLength(2);
    expect(res.ok).toBe(true);
    expect(res.frames).toBe(FAKE_FRAMES);
    expect(res.classes).toBe(FAKE_CLASSES);
    expect(res.frameSamples).toBe(FRAME_SAMPLES);
    expect(res.vocab).toEqual(FAKE_VOCAB);
    expect(Object.prototype.toString.call(res.logProbs)).toBe('[object ArrayBuffer]');
    expect(Array.from(new Float32Array(res.logProbs))).toEqual(Array.from(fakeGrid()));
    expect(sent).toEqual([[ALIGN_IPC.progress, { done: 320, total: 640 }]]);
  });

  test('a Float32Array VIEW is sliced from its byteOffset, not shipped whole', async () => {
    // A view over a larger arena is the realistic shape (the host stitches
    // chunks into one grid); copying `.buffer` naively would ship the arena.
    const arena = new Float32Array([9, 9, 0.5, 0.25]);
    const manager = fakeManager({
      result: {
        ok: true,
        frames: 1,
        classes: 2,
        frameSamples: FRAME_SAMPLES,
        vocab: FAKE_VOCAB,
        logProbs: arena.subarray(2, 4),
      },
    });
    const { ipcMain, invoke } = fakeIpc();
    registerAlignIpc({ ipcMain, manager, getWin: () => null });
    const res = await invoke(ALIGN_IPC.run, {
      sampleRate: ALIGN_SAMPLE_RATE,
      samples: new Float32Array([1]).buffer,
    });
    expect(res.logProbs.byteLength).toBe(2 * 4);
    expect(Array.from(new Float32Array(res.logProbs))).toEqual([0.5, 0.25]);
  });

  test('a cancelled or failed run is passed through untouched (no grid to convert)', async () => {
    for (const result of [{ ok: false, cancelled: true }, { ok: false, error: 'boom' }]) {
      const { ipcMain, invoke } = fakeIpc();
      registerAlignIpc({ ipcMain, manager: fakeManager({ result }), getWin: () => null });
      expect(
        await invoke(ALIGN_IPC.run, {
          sampleRate: ALIGN_SAMPLE_RATE,
          samples: new Float32Array([1]).buffer,
        })
      ).toEqual(result);
    }
  });

  test('events reach a live window only — no window and a destroyed one are silent', async () => {
    for (const getWin of [() => null, () => ({ isDestroyed: () => true, webContents: { send: () => { throw new Error('sent to a destroyed window'); } } })]) {
      const { ipcMain, invoke } = fakeIpc();
      registerAlignIpc({ ipcMain, manager: fakeManager(), getWin });
      const res = await invoke(ALIGN_IPC.run, {
        sampleRate: ALIGN_SAMPLE_RATE,
        samples: new Float32Array([1]).buffer,
      });
      expect(res.ok).toBe(true); // the run still completes; only the event is dropped
      expect(await invoke(ALIGN_IPC.ensureModels)).toEqual({ ok: true });
    }
  });

  test('ensure-models reports failure as {ok:false,error} rather than rejecting', async () => {
    const manager = {
      ...fakeManager(),
      ensureModels: async () => {
        throw new Error('network down');
      },
    };
    const { ipcMain, invoke } = fakeIpc();
    registerAlignIpc({ ipcMain, manager, getWin: () => null });
    expect(await invoke(ALIGN_IPC.ensureModels)).toEqual({ ok: false, error: 'network down' });
  });

  test('cancel and model-state pass through', async () => {
    const manager = {
      getModelState: async () => ({ downloaded: false, bytes: null, expectedBytes: 9 }),
      cancel: () => false,
    };
    const { ipcMain, invoke } = fakeIpc();
    registerAlignIpc({ ipcMain, manager, getWin: () => null });
    expect(await invoke(ALIGN_IPC.modelState)).toEqual({
      downloaded: false,
      bytes: null,
      expectedBytes: 9,
    });
    expect(await invoke(ALIGN_IPC.cancel)).toEqual({ cancelled: false });
  });
});
