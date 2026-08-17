'use strict';

/**
 * Tests for voiceManager.cjs (F3) — ensure/verify over the two-file pin set,
 * the manager's run choreography (settle-once, kill-on-terminal, id-gating,
 * the shared embed/convert slot), the profile store's disk trust boundary,
 * and the IPC request parsers INCLUDING the consent gate.
 *
 * The consent pin lives here as well as in the renderer suites: a request
 * without `consent === true` must be refused at this boundary, so removing
 * the UI checkbox cannot silently re-open conversion.
 */

const crypto = require('node:crypto');
const {
  VOICE_FILES,
  VOICE_TOTAL_BYTES,
  VOICE_IPC,
  MAX_VOICE_PROFILES,
  getVoiceModelPaths,
  getVoiceProfilesPath,
  ensureVoiceModels,
  sanitizeVoiceProfile,
  loadVoiceProfiles,
  saveVoiceProfiles,
  createVoiceManager,
  parseVoiceEmbedRequest,
  parseVoiceConvertRequest,
  registerVoiceIpc,
} = require('./voiceManager.cjs');
const { TONE_EMBEDDING_SIZE, MAX_TOTAL_SAMPLES, MAX_REFERENCE_SAMPLES } = require('./voiceHost.cjs');
const { VC_SAMPLE_RATE, MIN_INPUT_SAMPLES } = require('./voiceChunking.cjs');

const USER_DATA = 'C:\\fake\\userData';

/** Two small fake files standing in for the two real pins — first AND last,
 * so the ensure loop's extent is pinned, not just its existence. */
function makeFakeFiles() {
  const payloads = {
    converter: Buffer.from('converter-bytes-0123456789'),
    extractor: Buffer.from('extractor-bytes-abcdef'),
  };
  return [
    ['converter', 'conv.onnx'],
    ['extractor', 'extr.onnx'],
  ].map(([key, filename]) => ({
    key,
    filename,
    url: `https://example.com/${filename}`,
    sha256: crypto.createHash('sha256').update(payloads[key]).digest('hex'),
    bytes: payloads[key].length,
    payload: payloads[key],
  }));
}

/** Minimal async in-memory fs (transcribeManager.test.cjs's shape, plus
 * readFile for the profile store). */
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
      readFile: async (p) => {
        if (!store.has(p)) {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
        return store.get(p).toString('utf8');
      },
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

const memAtomicWrite = (fsImpl) => async (dest, buf) => {
  fsImpl.store.set(dest, Buffer.from(buf));
};

/** A controllable fake utility process. */
function fakeChild() {
  const child = {
    sent: [],
    listeners: {},
    killCount: 0,
    killResult: true,
    postMessage(msg) {
      child.sent.push(msg);
    },
    on(ev, cb) {
      child.listeners[ev] = cb;
    },
    kill() {
      child.killCount++;
      return child.killResult;
    },
    emit(msg) {
      child.listeners.message?.(msg);
    },
    exit(code) {
      child.listeners.exit?.(code);
    },
  };
  return child;
}

/** A manager whose two model files already verify, with a fake child. */
function readyManager({ child = fakeChild(), onWarn } = {}) {
  const files = makeFakeFiles();
  const fsImpl = memFs();
  const paths = getVoiceModelPaths(USER_DATA, files);
  for (const f of files) fsImpl.store.set(paths[f.key], f.payload);
  const manager = createVoiceManager({
    userDataDir: USER_DATA,
    files,
    fsImpl,
    atomicWrite: memAtomicWrite(fsImpl),
    utilityProcessFactory: () => child,
    onWarn,
  });
  return { manager, child, files, fsImpl };
}

/** Lets the manager's async pin-verification (streamed sha256 over the memFs,
 * several setImmediate turns per file) finish before the test proceeds. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

describe('pins and paths', () => {
  test('the shipped pin set matches the spike record', () => {
    expect(VOICE_FILES).toHaveLength(2);
    const byKey = Object.fromEntries(VOICE_FILES.map((f) => [f.key, f]));
    expect(byKey.converter.bytes).toBe(157196170);
    expect(byKey.converter.sha256).toBe('896195b84b0cb87a828bb8cab06577e9c024356bc9727b1a8f4174154bc0affa');
    expect(byKey.extractor.bytes).toBe(3364792);
    expect(byKey.extractor.sha256).toBe('e91c2cb696e199d2519ed8b62ca6e3c8e42cb99ca13955dd6e188051486e681c');
    expect(VOICE_TOTAL_BYTES).toBe(157196170 + 3364792);
  });

  test('model paths land under userData/models/voice; profiles beside them', () => {
    const paths = getVoiceModelPaths(USER_DATA);
    expect(paths.converter).toBe(`${USER_DATA}\\models\\voice\\tone_color.onnx`);
    expect(paths.extractor).toBe(`${USER_DATA}\\models\\voice\\tone_extract.onnx`);
    expect(getVoiceProfilesPath(USER_DATA)).toBe(`${USER_DATA}\\voice-profiles.json`);
  });
});

describe('ensureVoiceModels', () => {
  test('downloads every missing file (first AND last), verifies, commits, reports OVERALL progress', async () => {
    const files = makeFakeFiles();
    const fsImpl = memFs();
    const progress = [];
    const request = fakeRequest(files);
    const paths = await ensureVoiceModels({
      userDataDir: USER_DATA,
      files,
      fsImpl,
      requestImpl: request,
      onProgress: (p) => progress.push(p),
      atomicWrite: memAtomicWrite(fsImpl),
    });
    expect(request.calls).toEqual(files.map((f) => f.url)); // loop extent
    for (const f of files) {
      expect(fsImpl.store.get(paths[f.key]).equals(f.payload)).toBe(true);
    }
    const total = files.reduce((n, f) => n + f.bytes, 0);
    expect(progress[progress.length - 1]).toMatchObject({ received: total, total });
  });

  test('a corrupt existing file is deleted and re-downloaded; a verified one is not re-fetched', async () => {
    const files = makeFakeFiles();
    const fsImpl = memFs();
    const paths = getVoiceModelPaths(USER_DATA, files);
    fsImpl.store.set(paths.converter, Buffer.from('garbage-of-wrong-length'));
    fsImpl.store.set(paths.extractor, files[1].payload); // valid
    const request = fakeRequest(files);
    await ensureVoiceModels({
      userDataDir: USER_DATA,
      files,
      fsImpl,
      requestImpl: request,
      atomicWrite: memAtomicWrite(fsImpl),
    });
    expect(request.calls).toEqual([files[0].url]); // only the corrupt one
    expect(fsImpl.store.get(paths.converter).equals(files[0].payload)).toBe(true);
  });

  test('a download whose bytes fail the sha pin is refused and never written', async () => {
    const files = makeFakeFiles();
    const tampered = files.map((f, i) =>
      i === 1 ? { ...f, payload: Buffer.from('tampered-bytes-abcdefg') } : f
    );
    expect(tampered[1].payload.length).toBe(files[1].bytes); // same size, wrong hash
    const fsImpl = memFs();
    await expect(
      ensureVoiceModels({
        userDataDir: USER_DATA,
        files,
        fsImpl,
        requestImpl: fakeRequest(tampered),
        atomicWrite: memAtomicWrite(fsImpl),
      })
    ).rejects.toThrow(/sha256 verification/);
    expect(fsImpl.store.has(getVoiceModelPaths(USER_DATA, files).extractor)).toBe(false);
  });
});

describe('run choreography', () => {
  test('embed: init → open → sliced audio → run; embedded settles with the vector', async () => {
    const { manager, child } = readyManager();
    const samples = new Float32Array(1500).fill(0.5);
    const promise = manager.startEmbed({ samples });
    await flush();
    expect(child.sent[0]).toMatchObject({ type: 'init' });
    child.emit({ type: 'ready' });
    expect(child.sent[1]).toMatchObject({ type: 'embed', totalSamples: 1500 });
    expect(child.sent[child.sent.length - 1]).toMatchObject({ type: 'run' });
    const id = child.sent[1].id;
    const vector = new Float32Array(TONE_EMBEDDING_SIZE).fill(0.25);
    child.emit({ type: 'embedded', id, vector });
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.vector).toBe(vector);
    expect(child.killCount).toBeGreaterThan(0); // child killed on settle
    expect(manager.isRunning()).toBe(false);
  });

  test('convert: chunk and progress events stream through; done settles with counts', async () => {
    const { manager, child } = readyManager();
    const chunks = [];
    const progress = [];
    const target = new Float32Array(TONE_EMBEDDING_SIZE);
    const promise = manager.startConversion({
      samples: new Float32Array(2000),
      targetVector: target,
      onProgress: (p) => progress.push(p),
      onChunk: (c) => chunks.push(c),
    });
    await flush();
    child.emit({ type: 'ready' });
    const open = child.sent[1];
    expect(open).toMatchObject({ type: 'convert', totalSamples: 2000 });
    expect(open.targetVector).toBe(target);
    child.emit({ type: 'progress', id: open.id, stage: 'embed', done: 1, total: 1 });
    child.emit({ type: 'chunk', id: open.id, offset: 0, samples: 2000, data: new Float32Array(2000) });
    child.emit({ type: 'progress', id: open.id, stage: 'convert', done: 1, total: 1 });
    child.emit({ type: 'done', id: open.id, chunkCount: 1, sanitisedSamples: 2 });
    const result = await promise;
    expect(result).toEqual({ ok: true, chunkCount: 1, sanitisedSamples: 2 });
    expect(progress.map((p) => p.stage)).toEqual(['embed', 'convert']);
    expect(chunks).toHaveLength(1);
  });

  test('audio is sliced at 1M samples and covers the input exactly', async () => {
    const { manager, child } = readyManager();
    const n = (1 << 20) + 1000;
    const promise = manager.startEmbed({ samples: new Float32Array(n) });
    await flush();
    child.emit({ type: 'ready' });
    const audio = child.sent.filter((m) => m.type === 'audio');
    expect(audio).toHaveLength(2);
    expect(audio[0].offset).toBe(0);
    expect(audio[0].samples.length).toBe(1 << 20);
    expect(audio[1].offset).toBe(1 << 20);
    expect(audio[1].samples.length).toBe(1000);
    child.emit({ type: 'embedded', id: audio[0].id, vector: new Float32Array(TONE_EMBEDDING_SIZE) });
    await promise;
  });

  test('the slot is shared: an embed refuses while a conversion runs (and vice versa)', async () => {
    const { manager, child } = readyManager();
    const first = manager.startConversion({
      samples: new Float32Array(1000),
      targetVector: new Float32Array(TONE_EMBEDDING_SIZE),
    });
    const second = await manager.startEmbed({ samples: new Float32Array(1000) });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/busy/);
    manager.cancel();
    await expect(first).resolves.toEqual({ ok: false, cancelled: true });
  });

  test('a failed pin settles with an error and never spawns the child', async () => {
    const files = makeFakeFiles();
    const fsImpl = memFs(); // nothing on disk
    let spawned = 0;
    const manager = createVoiceManager({
      userDataDir: USER_DATA,
      files,
      fsImpl,
      utilityProcessFactory: () => {
        spawned++;
        return fakeChild();
      },
    });
    const result = await manager.startEmbed({ samples: new Float32Array(1000) });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/failed verification/);
    expect(spawned).toBe(0);
  });

  test('THE VERIFY LOOP RUNS TO ITS END: a valid first file does not excuse a corrupt second', async () => {
    // The test above puts NOTHING on disk, so files[0] fails and the loop
    // returns before it ever reaches files[1]. It therefore pins the loop's
    // EXISTENCE, not its EXTENT — `for (const f of files.slice(0, 1))` passes
    // it. That is not academic: the un-verified file would be loaded straight
    // into the utility process, so a build checking only the converter would
    // happily load a substituted tone_extract.onnx. Every element needs a
    // fixture in which the EARLIER ones pass.
    for (const badIndex of [0, 1]) {
      const files = makeFakeFiles();
      const fsImpl = memFs();
      const paths = getVoiceModelPaths(USER_DATA, files);
      // Every file valid on disk...
      for (const f of files) fsImpl.store.set(paths[f.key], f.payload);
      // ...except one, corrupted while keeping a plausible length so the
      // refusal has to come from the sha256 and not merely from the size.
      const bad = files[badIndex];
      const corrupt = Buffer.from(bad.payload);
      corrupt[0] ^= 0xff;
      expect(corrupt.length).toBe(bad.bytes);
      fsImpl.store.set(paths[bad.key], corrupt);

      let spawned = 0;
      const manager = createVoiceManager({
        userDataDir: USER_DATA,
        files,
        fsImpl,
        atomicWrite: memAtomicWrite(fsImpl),
        utilityProcessFactory: () => {
          spawned++;
          return fakeChild();
        },
      });
      const result = await manager.startEmbed({ samples: new Float32Array(1000) });
      expect(result.ok).toBe(false);
      // The refusal names the file that actually failed — so a loop that
      // checked the wrong element could not pass by luck.
      expect(result.error).toContain(bad.filename);
      expect(result.error).toMatch(/failed verification/);
      expect(spawned).toBe(0);
      // And the OTHER file was genuinely valid, so this really did require
      // reaching index ${badIndex} rather than stopping at the first.
      const other = files[1 - badIndex];
      expect(fsImpl.store.get(paths[other.key]).equals(other.payload)).toBe(true);
      expect(result.error).not.toContain(other.filename);
    }
  });

  test('spawn failure, host error and unexpected exit each settle exactly once', async () => {
    const files = makeFakeFiles();
    const fsImpl = memFs();
    const paths = getVoiceModelPaths(USER_DATA, files);
    for (const f of files) fsImpl.store.set(paths[f.key], f.payload);
    const throwing = createVoiceManager({
      userDataDir: USER_DATA,
      files,
      fsImpl,
      utilityProcessFactory: () => {
        throw new Error('no fork for you');
      },
    });
    const spawnFail = await throwing.startEmbed({ samples: new Float32Array(1000) });
    expect(spawnFail).toMatchObject({ ok: false, error: expect.stringMatching(/no fork for you/) });

    const errCase = readyManager();
    const errPromise = errCase.manager.startEmbed({ samples: new Float32Array(1000) });
    await flush();
    errCase.child.emit({ type: 'error', stage: 'init', message: 'model exploded' });
    await expect(errPromise).resolves.toEqual({ ok: false, error: 'model exploded' });

    const exitCase = readyManager();
    const exitPromise = exitCase.manager.startConversion({
      samples: new Float32Array(1000),
      targetVector: new Float32Array(TONE_EMBEDDING_SIZE),
    });
    await flush();
    exitCase.child.exit(9);
    await expect(exitPromise).resolves.toEqual({
      ok: false,
      error: 'voice host exited unexpectedly (code 9)',
    });
  });

  test('messages for another run id are ignored; settled-run chatter is dropped', async () => {
    const { manager, child } = readyManager();
    const promise = manager.startEmbed({ samples: new Float32Array(1000) });
    await flush();
    child.emit({ type: 'ready' });
    const id = child.sent[1].id;
    child.emit({ type: 'embedded', id: id + 5, vector: new Float32Array(TONE_EMBEDDING_SIZE) });
    child.emit({ type: 'error', id: id + 5, message: 'someone else' });
    // Still unsettled — now settle for real, then throw late chatter at it.
    child.emit({ type: 'embedded', id, vector: new Float32Array(TONE_EMBEDDING_SIZE) });
    const result = await promise;
    expect(result.ok).toBe(true);
    child.emit({ type: 'error', id, message: 'late' });
    expect(manager.isRunning()).toBe(false);
  });

  test('an unkillable child is retried then WARNED about, and the slot is still freed', async () => {
    const warnings = [];
    const child = fakeChild();
    child.killResult = false;
    const { manager } = readyManager({ child, onWarn: (m) => warnings.push(m) });
    const promise = manager.startEmbed({ samples: new Float32Array(1000) });
    await flush();
    child.emit({ type: 'ready' });
    child.emit({ type: 'embedded', id: child.sent[1].id, vector: new Float32Array(TONE_EMBEDDING_SIZE) });
    await promise;
    expect(child.killCount).toBe(2); // first attempt + one retry
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/did not respond to kill/);
    expect(manager.isRunning()).toBe(false);
  });

  test('cancel kills the child and settles cancelled; dispose latches every later run', async () => {
    const { manager, child } = readyManager();
    const promise = manager.startConversion({
      samples: new Float32Array(1000),
      targetVector: new Float32Array(TONE_EMBEDDING_SIZE),
    });
    await flush();
    child.emit({ type: 'ready' });
    expect(manager.cancel()).toBe(true);
    await expect(promise).resolves.toEqual({ ok: false, cancelled: true });
    expect(child.killCount).toBeGreaterThan(0);
    expect(manager.cancel()).toBe(false);

    manager.dispose();
    const after = await manager.startEmbed({ samples: new Float32Array(1000) });
    expect(after.ok).toBe(false);
    expect(after.error).toMatch(/disposed/);
  });

  test('an embed that settles done-without-vector is reported as a host-contract violation', async () => {
    const { manager, child } = readyManager();
    const promise = manager.startEmbed({ samples: new Float32Array(1000) });
    await flush();
    child.emit({ type: 'ready' });
    child.emit({ type: 'done', id: child.sent[1].id, chunkCount: 0, sanitisedSamples: 0 });
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/without delivering an embedding/);
  });
});

describe('profile store — the disk trust boundary', () => {
  const validProfile = (overrides = {}) => ({
    id: 'voice-1',
    name: 'Alice',
    embedding: new Array(TONE_EMBEDDING_SIZE).fill(0.1),
    createdAt: 1234,
    sourceName: 'alice.wav',
    ...overrides,
  });

  test('sanitize: every malformed shape is refused; the valid row round-trips trimmed', () => {
    expect(sanitizeVoiceProfile(null)).toBeNull();
    expect(sanitizeVoiceProfile('x')).toBeNull();
    expect(sanitizeVoiceProfile(validProfile({ id: '' }))).toBeNull();
    expect(sanitizeVoiceProfile(validProfile({ id: 'x'.repeat(201) }))).toBeNull();
    expect(sanitizeVoiceProfile(validProfile({ name: '   ' }))).toBeNull();
    expect(sanitizeVoiceProfile(validProfile({ embedding: new Array(255).fill(0) }))).toBeNull();
    expect(sanitizeVoiceProfile(validProfile({ embedding: new Array(257).fill(0) }))).toBeNull();
    const nanAt0 = new Array(TONE_EMBEDDING_SIZE).fill(0);
    nanAt0[0] = Number.NaN;
    expect(sanitizeVoiceProfile(validProfile({ embedding: nanAt0 }))).toBeNull();
    const infAtLast = new Array(TONE_EMBEDDING_SIZE).fill(0);
    infAtLast[TONE_EMBEDDING_SIZE - 1] = Infinity;
    expect(sanitizeVoiceProfile(validProfile({ embedding: infAtLast }))).toBeNull();
    const stringAt7 = new Array(TONE_EMBEDDING_SIZE).fill(0);
    stringAt7[7] = '0.5';
    expect(sanitizeVoiceProfile(validProfile({ embedding: stringAt7 }))).toBeNull();

    const clean = sanitizeVoiceProfile(validProfile({ name: '  Alice  ' }));
    expect(clean).toMatchObject({ id: 'voice-1', name: 'Alice', createdAt: 1234, sourceName: 'alice.wav' });
    expect(clean.embedding).toHaveLength(TONE_EMBEDDING_SIZE);
  });

  test('load: missing file is an empty store; corrupt JSON is an error; bad rows are dropped one by one', async () => {
    expect(await loadVoiceProfiles({ userDataDir: USER_DATA, fsImpl: memFs() })).toEqual({
      ok: true,
      profiles: [],
    });

    const corrupt = memFs({ [getVoiceProfilesPath(USER_DATA)]: Buffer.from('{nope') });
    const bad = await loadVoiceProfiles({ userDataDir: USER_DATA, fsImpl: corrupt });
    expect(bad.ok).toBe(false);

    const mixed = memFs({
      [getVoiceProfilesPath(USER_DATA)]: Buffer.from(
        JSON.stringify({
          version: 1,
          profiles: [validProfile(), { id: 'broken' }, validProfile({ id: 'voice-2', name: 'Bob' })],
        })
      ),
    });
    const loaded = await loadVoiceProfiles({ userDataDir: USER_DATA, fsImpl: mixed });
    expect(loaded.ok).toBe(true);
    expect(loaded.profiles.map((p) => p.id)).toEqual(['voice-1', 'voice-2']);
  });

  test('save: refuses over-cap (201), malformed rows and duplicate ids; a saved store loads back identically', async () => {
    const fsImpl = memFs();
    const overCap = Array.from({ length: MAX_VOICE_PROFILES + 1 }, (_, i) =>
      validProfile({ id: `voice-${i}` })
    );
    expect(
      (await saveVoiceProfiles({ userDataDir: USER_DATA, profiles: overCap, fsImpl, atomicWrite: memAtomicWrite(fsImpl) })).ok
    ).toBe(false);
    const atCap = overCap.slice(0, MAX_VOICE_PROFILES);
    expect(
      (await saveVoiceProfiles({ userDataDir: USER_DATA, profiles: atCap, fsImpl, atomicWrite: memAtomicWrite(fsImpl) })).ok
    ).toBe(true);

    expect(
      (await saveVoiceProfiles({
        userDataDir: USER_DATA,
        profiles: [validProfile(), { id: 'nope' }],
        fsImpl,
        atomicWrite: memAtomicWrite(fsImpl),
      })).ok
    ).toBe(false);
    expect(
      (await saveVoiceProfiles({
        userDataDir: USER_DATA,
        profiles: [validProfile(), validProfile()],
        fsImpl,
        atomicWrite: memAtomicWrite(fsImpl),
      })).error
    ).toMatch(/duplicate/);

    const two = [validProfile(), validProfile({ id: 'voice-2', name: 'Bob' })];
    await saveVoiceProfiles({ userDataDir: USER_DATA, profiles: two, fsImpl, atomicWrite: memAtomicWrite(fsImpl) });
    const reloaded = await loadVoiceProfiles({ userDataDir: USER_DATA, fsImpl });
    expect(reloaded.profiles).toHaveLength(2);
    expect(reloaded.profiles[1]).toMatchObject({ id: 'voice-2', name: 'Bob' });
  });
});

describe('request parsers — the trust boundary INCLUDING the consent gate', () => {
  const embedBuf = (samples) => new Float32Array(samples).buffer;

  test('CONSENT PIN: embed and convert are refused without consent === true, in every falsy/near-true shape', () => {
    const base = { sampleRate: VC_SAMPLE_RATE, samples: embedBuf(1000) };
    const target = new Float32Array(TONE_EMBEDDING_SIZE).buffer;
    for (const consent of [undefined, false, null, 0, 1, 'true', 'yes']) {
      expect(parseVoiceEmbedRequest({ ...base, consent })).toBeNull();
      expect(parseVoiceConvertRequest({ ...base, target, consent })).toBeNull();
    }
    expect(parseVoiceEmbedRequest({ ...base, consent: true })).not.toBeNull();
    expect(parseVoiceConvertRequest({ ...base, target, consent: true })).not.toBeNull();
  });

  test('embed: sampleRate, buffer shape and length bounds probed below/on/above', () => {
    const ok = { sampleRate: VC_SAMPLE_RATE, samples: embedBuf(MIN_INPUT_SAMPLES), consent: true };
    expect(parseVoiceEmbedRequest(ok)).not.toBeNull();
    expect(parseVoiceEmbedRequest({ ...ok, sampleRate: 22051 })).toBeNull();
    expect(parseVoiceEmbedRequest({ ...ok, sampleRate: 16000 })).toBeNull();
    expect(parseVoiceEmbedRequest({ ...ok, samples: new Float32Array(1000) })).toBeNull(); // not an ArrayBuffer
    expect(parseVoiceEmbedRequest({ ...ok, samples: new ArrayBuffer(0) })).toBeNull();
    expect(parseVoiceEmbedRequest({ ...ok, samples: new ArrayBuffer(MIN_INPUT_SAMPLES * 4 + 2) })).toBeNull();
    expect(parseVoiceEmbedRequest({ ...ok, samples: embedBuf(MIN_INPUT_SAMPLES - 1) })).toBeNull();
    // The cap, probed via the injectable bound (real cap would need a 30 MB alloc).
    expect(parseVoiceEmbedRequest({ ...ok, samples: embedBuf(1001) }, 1000)).toBeNull();
    expect(parseVoiceEmbedRequest({ ...ok, samples: embedBuf(1000) }, 1000)).not.toBeNull();
    // The default bound is the host's own reference cap.
    expect(MAX_REFERENCE_SAMPLES).toBe(VC_SAMPLE_RATE * 350);
  });

  test('convert: target must be exactly 256 finite float32s', () => {
    const base = { sampleRate: VC_SAMPLE_RATE, samples: embedBuf(1000), consent: true };
    expect(parseVoiceConvertRequest({ ...base, target: new ArrayBuffer(TONE_EMBEDDING_SIZE * 4 - 4) })).toBeNull();
    expect(parseVoiceConvertRequest({ ...base, target: new ArrayBuffer(TONE_EMBEDDING_SIZE * 4 + 4) })).toBeNull();
    expect(parseVoiceConvertRequest({ ...base, target: new Float32Array(TONE_EMBEDDING_SIZE) })).toBeNull();
    const nanTarget = new Float32Array(TONE_EMBEDDING_SIZE);
    nanTarget[128] = Number.NaN;
    expect(parseVoiceConvertRequest({ ...base, target: nanTarget.buffer })).toBeNull();
    const good = parseVoiceConvertRequest({ ...base, target: new Float32Array(TONE_EMBEDDING_SIZE).buffer });
    expect(good).not.toBeNull();
    expect(good.samples).toHaveLength(1000);
    expect(good.target).toHaveLength(TONE_EMBEDDING_SIZE);
    // The default convert bound is the host's 30-minute cap.
    expect(MAX_TOTAL_SAMPLES).toBe(VC_SAMPLE_RATE * 1800);
  });
});

describe('registerVoiceIpc', () => {
  function fakeIpc() {
    const handlers = new Map();
    return {
      handlers,
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      invoke: (ch, req) => handlers.get(ch)(null, req),
    };
  }

  test('embed/convert refusals name the consent affirmation; events stream as ArrayBuffers', async () => {
    const sent = [];
    const manager = {
      getModelState: async () => ({ downloaded: true, bytes: 1, expectedBytes: 1 }),
      ensureModels: async () => ({}),
      startEmbed: async () => ({ ok: true, vector: new Float32Array(TONE_EMBEDDING_SIZE).fill(0.5) }),
      startConversion: async ({ onChunk, onProgress }) => {
        onProgress({ stage: 'convert', done: 1, total: 1 });
        onChunk({ offset: 0, samples: 4, data: new Float32Array([1, 2, 3, 4]) });
        return { ok: true, chunkCount: 1, sanitisedSamples: 0 };
      },
      cancel: () => true,
      loadProfiles: async () => ({ ok: true, profiles: [] }),
      saveProfiles: async () => ({ ok: true }),
    };
    const { ipcMain, invoke } = fakeIpc();
    registerVoiceIpc({
      ipcMain,
      manager,
      getWin: () => ({ isDestroyed: () => false, webContents: { send: (ch, p) => sent.push([ch, p]) } }),
    });

    const noConsent = await invoke(VOICE_IPC.embed, {
      sampleRate: VC_SAMPLE_RATE,
      samples: new Float32Array(1000).buffer,
    });
    expect(noConsent.ok).toBe(false);
    expect(noConsent.error).toMatch(/consent affirmation is required/);

    const embedded = await invoke(VOICE_IPC.embed, {
      sampleRate: VC_SAMPLE_RATE,
      samples: new Float32Array(1000).buffer,
      consent: true,
    });
    expect(embedded.ok).toBe(true);
    expect(embedded.vector.byteLength).toBe(TONE_EMBEDDING_SIZE * 4);

    const converted = await invoke(VOICE_IPC.convert, {
      sampleRate: VC_SAMPLE_RATE,
      samples: new Float32Array(1000).buffer,
      target: new Float32Array(TONE_EMBEDDING_SIZE).buffer,
      consent: true,
    });
    expect(converted).toEqual({ ok: true, chunkCount: 1, sanitisedSamples: 0 });
    const chunkEvent = sent.find(([ch]) => ch === VOICE_IPC.chunk);
    // Brand check, not instanceof — jest's vm realm can hand ArrayBuffers a
    // different global identity (the same reason the hosts brand-check).
    expect(Object.prototype.toString.call(chunkEvent[1].data)).toBe('[object ArrayBuffer]');
    expect(Array.from(new Float32Array(chunkEvent[1].data))).toEqual([1, 2, 3, 4]);

    expect(await invoke(VOICE_IPC.cancel)).toEqual({ cancelled: true });
    expect(await invoke(VOICE_IPC.profilesLoad)).toEqual({ ok: true, profiles: [] });
    expect((await invoke(VOICE_IPC.profilesSave, { profiles: [] })).ok).toBe(true);
    expect((await invoke(VOICE_IPC.profilesSave, { nope: 1 })).ok).toBe(false);
  });
});
