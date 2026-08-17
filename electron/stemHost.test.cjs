'use strict';

/**
 * Tests for the stem-separation utility-process host (S1). The host core is
 * dependency-injected (`createStemHost({ ort, postMessage, exit })`) so these
 * tests drive the REAL message loop, validation and segmentation pipeline
 * with a fake onnxruntime — the real-ORT path is covered by
 * stemIntegration.test.cjs and the packaged-app selftest driver.
 */

const { SEGMENT_SAMPLES, STRIDE_SAMPLES, STEM_COUNT, MODEL_CHANNELS } = require('./stemSegmentation.cjs');
const { createStemHost, MAX_TOTAL_SAMPLES } = require('./stemHost.cjs');

/** Fake onnxruntime-node: records session options; `run` defaults to the
 * identity model (every stem = the input chunk). */
function fakeOrt({ createImpl, runImpl } = {}) {
  const created = [];
  class Tensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  const ort = {
    Tensor,
    InferenceSession: {
      create: async (modelPath, opts) => {
        if (createImpl) return createImpl(modelPath, opts);
        const session = {
          modelPath,
          opts,
          runCalls: [],
          run: async (feeds) => {
            session.runCalls.push(feeds);
            if (runImpl) return runImpl(feeds, session);
            const n = feeds.mix.dims[2];
            const out = new Float32Array(STEM_COUNT * MODEL_CHANNELS * n);
            for (let s = 0; s < STEM_COUNT; s++) out.set(feeds.mix.data, s * MODEL_CHANNELS * n);
            return { stems: new Tensor('float32', out, [1, STEM_COUNT, MODEL_CHANNELS, n]) };
          },
          release: async () => {
            session.released = true;
          },
        };
        created.push(session);
        return session;
      },
    },
    created,
  };
  return ort;
}

function makeHost(ortOpts) {
  const posted = [];
  const exits = [];
  const ort = fakeOrt(ortOpts);
  const host = createStemHost({
    ort,
    postMessage: (msg) => posted.push(msg),
    exit: (code) => exits.push(code),
  });
  return { host, posted, exits, ort };
}

/** Waits until the posted list contains a message of `type` (the run loop is
 * async), failing after ~2 s. */
async function waitFor(posted, type) {
  for (let i = 0; i < 400; i++) {
    const found = posted.find((m) => m.type === type);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`no ${type} message; got: ${posted.map((m) => m.type).join(',')}`);
}

async function initReady(host, posted) {
  await host.handleMessage({ type: 'init', modelPath: 'C:/fake/model.onnx' });
  await waitFor(posted, 'ready');
}

function toneChannels(total) {
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  for (let t = 0; t < total; t++) {
    left[t] = Math.sin((2 * Math.PI * 220 * t) / 44100) * 0.5;
    right[t] = Math.sin((2 * Math.PI * 330 * t) / 44100) * 0.25;
  }
  return [left, right];
}

describe('init', () => {
  test('creates a CPU-EP session and replies ready', async () => {
    const { host, posted, ort } = makeHost();
    await initReady(host, posted);
    expect(ort.created).toHaveLength(1);
    expect(ort.created[0].modelPath).toBe('C:/fake/model.onnx');
    // Ruling 2: CPU EP only — DML is disqualified, never configured.
    expect(ort.created[0].opts.executionProviders).toEqual(['cpu']);
    expect(JSON.stringify(ort.created[0].opts)).not.toMatch(/dml|directml|cuda/i);
  });

  test('session-creation failure posts an init error, host survives', async () => {
    const { host, posted } = makeHost({
      createImpl: async () => {
        throw new Error('bad model file');
      },
    });
    await host.handleMessage({ type: 'init', modelPath: 'x' });
    const err = await waitFor(posted, 'error');
    expect(err.stage).toBe('init');
    expect(err.message).toContain('bad model file');
  });

  test('missing/invalid modelPath is a protocol error', async () => {
    const { host, posted } = makeHost();
    await host.handleMessage({ type: 'init' });
    const err = await waitFor(posted, 'error');
    expect(err.stage).toBe('protocol');
  });
});

describe('message validation (trust boundary)', () => {
  test.each([
    ['null', null],
    ['a string', 'separate'],
    ['a number', 42],
    ['missing type', {}],
    ['unknown type', { type: 'transmogrify' }],
  ])('malformed message (%s) posts a protocol error and never throws', async (_name, msg) => {
    const { host, posted } = makeHost();
    await initReady(host, posted);
    await host.handleMessage(msg);
    const err = await waitFor(posted, 'error');
    expect(err.stage).toBe('protocol');
  });

  test('separate before init is refused', async () => {
    const { host, posted } = makeHost();
    await host.handleMessage({ type: 'separate', id: 1, sampleRate: 44100, channelCount: 2, totalSamples: 1000 });
    const err = await waitFor(posted, 'error');
    expect(err.stage).toBe('protocol');
  });

  test.each([
    ['wrong sample rate', { sampleRate: 48000 }],
    ['zero samples', { totalSamples: 0 }],
    ['negative samples', { totalSamples: -1 }],
    ['fractional samples', { totalSamples: 10.5 }],
    ['absurd samples', { totalSamples: MAX_TOTAL_SAMPLES + 1 }],
    ['bad channel count', { channelCount: 3 }],
    ['bad id', { id: 'nope' }],
  ])('separate with %s is refused', async (_name, patch) => {
    const { host, posted } = makeHost();
    await initReady(host, posted);
    const base = { type: 'separate', id: 1, sampleRate: 44100, channelCount: 2, totalSamples: 1000 };
    await host.handleMessage({ ...base, ...patch });
    const err = await waitFor(posted, 'error');
    expect(err.stage).toBe('protocol');
  });

  test('audio for an unknown job / bad offset / bad payload is refused', async () => {
    const { host, posted } = makeHost();
    await initReady(host, posted);
    await host.handleMessage({ type: 'separate', id: 7, sampleRate: 44100, channelCount: 2, totalSamples: 1000 });

    const cases = [
      { type: 'audio', id: 99, offset: 0, channels: [new Float32Array(10), new Float32Array(10)] }, // wrong id
      { type: 'audio', id: 7, offset: 995, channels: [new Float32Array(10), new Float32Array(10)] }, // overflow
      { type: 'audio', id: 7, offset: -1, channels: [new Float32Array(10), new Float32Array(10)] }, // negative
      { type: 'audio', id: 7, offset: 0, channels: [new Float32Array(10)] }, // channel count mismatch
      { type: 'audio', id: 7, offset: 0, channels: 'nope' }, // not arrays
      { type: 'audio', id: 7, offset: 0, channels: [new Float32Array(10), new Float32Array(9)] }, // ragged
    ];
    for (const msg of cases) {
      posted.length = 0;
      await host.handleMessage(msg);
      const err = await waitFor(posted, 'error');
      expect(err.stage).toBe('protocol');
    }
  });

  test('run before all audio has arrived is refused', async () => {
    const { host, posted } = makeHost();
    await initReady(host, posted);
    await host.handleMessage({ type: 'separate', id: 7, sampleRate: 44100, channelCount: 2, totalSamples: 1000 });
    await host.handleMessage({ type: 'audio', id: 7, offset: 0, channels: [new Float32Array(500), new Float32Array(500)] });
    await host.handleMessage({ type: 'run', id: 7 });
    const err = await waitFor(posted, 'error');
    expect(err.stage).toBe('protocol');
    expect(err.message).toMatch(/500/); // says how much is missing/received
  });

  test('duplicate-region delivery must NOT pass the completeness gate (coverage, not count)', async () => {
    // Review probe (fix round 1, MED-1): delivering [0,100000) twice for a
    // 200,000-sample job matches the total on a sample COUNT but leaves the
    // second half silent — run must refuse loudly, never post done.
    const { host, posted } = makeHost();
    await initReady(host, posted);
    await host.handleMessage({ type: 'separate', id: 20, sampleRate: 44100, channelCount: 2, totalSamples: 200000 });
    await host.handleMessage({ type: 'audio', id: 20, offset: 0, channels: [new Float32Array(100000), new Float32Array(100000)] });
    await host.handleMessage({ type: 'audio', id: 20, offset: 0, channels: [new Float32Array(100000), new Float32Array(100000)] });
    await host.handleMessage({ type: 'run', id: 20 });
    const err = await waitFor(posted, 'error');
    expect(err.stage).toBe('protocol');
    expect(err.message).toMatch(/100000/); // names the first missing sample
    expect(posted.find((m) => m.type === 'done')).toBeUndefined();
  });

  test('a mid-track gap is refused even when later ranges arrive', async () => {
    const { host, posted } = makeHost();
    await initReady(host, posted);
    await host.handleMessage({ type: 'separate', id: 21, sampleRate: 44100, channelCount: 2, totalSamples: 1000 });
    await host.handleMessage({ type: 'audio', id: 21, offset: 0, channels: [new Float32Array(300), new Float32Array(300)] });
    await host.handleMessage({ type: 'audio', id: 21, offset: 700, channels: [new Float32Array(300), new Float32Array(300)] });
    await host.handleMessage({ type: 'run', id: 21 });
    const err = await waitFor(posted, 'error');
    expect(err.stage).toBe('protocol');
    expect(err.message).toMatch(/300/); // first missing sample is 300
    expect(posted.find((m) => m.type === 'done')).toBeUndefined();
  });

  test('overlapping delivery that genuinely covers the whole track is accepted', async () => {
    // The contract allows overlap (re-delivered ranges overwrite); what run
    // requires is COVERAGE of [0, totalSamples).
    const { host, posted } = makeHost();
    await initReady(host, posted);
    await host.handleMessage({ type: 'separate', id: 22, sampleRate: 44100, channelCount: 2, totalSamples: 1000 });
    await host.handleMessage({ type: 'audio', id: 22, offset: 0, channels: [new Float32Array(600), new Float32Array(600)] });
    await host.handleMessage({ type: 'audio', id: 22, offset: 400, channels: [new Float32Array(600), new Float32Array(600)] });
    await host.handleMessage({ type: 'run', id: 22 });
    await waitFor(posted, 'done');
    expect(posted.filter((m) => m.type === 'error')).toHaveLength(0);
  });

  test('a second separate while a job is loaded is refused (single-job host)', async () => {
    const { host, posted } = makeHost();
    await initReady(host, posted);
    await host.handleMessage({ type: 'separate', id: 1, sampleRate: 44100, channelCount: 2, totalSamples: 1000 });
    await host.handleMessage({ type: 'separate', id: 2, sampleRate: 44100, channelCount: 2, totalSamples: 1000 });
    const err = await waitFor(posted, 'error');
    expect(err.stage).toBe('protocol');
    expect(err.message).toMatch(/busy|active/i);
  });
});

describe('separation run', () => {
  test('stereo job: per-segment progress, contiguous stems flushes, done', async () => {
    const { host, posted } = makeHost();
    await initReady(host, posted);

    const total = 20000; // 1 segment
    const [left, right] = toneChannels(total);
    await host.handleMessage({ type: 'separate', id: 3, sampleRate: 44100, channelCount: 2, totalSamples: total });
    // Split delivery across two audio messages to exercise offset handling.
    await host.handleMessage({ type: 'audio', id: 3, offset: 0, channels: [left.slice(0, 12000), right.slice(0, 12000)] });
    await host.handleMessage({ type: 'audio', id: 3, offset: 12000, channels: [left.slice(12000), right.slice(12000)] });
    await host.handleMessage({ type: 'run', id: 3 });

    const done = await waitFor(posted, 'done');
    expect(done.id).toBe(3);
    expect(done.totalSegments).toBe(1);

    const progress = posted.filter((m) => m.type === 'progress');
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ id: 3, segment: 1, totalSegments: 1 });

    const flushes = posted.filter((m) => m.type === 'stems');
    let covered = 0;
    for (const f of flushes) {
      expect(f.id).toBe(3);
      expect(f.offset).toBe(covered);
      expect(f.data).toBeInstanceOf(Float32Array);
      expect(f.data.length).toBe(STEM_COUNT * MODEL_CHANNELS * f.samples);
      covered += f.samples;
    }
    expect(covered).toBe(total);

    // Identity fake model => each stem reproduces the input (except sample 0,
    // the reference's zero-weight endpoint).
    const f = flushes[0];
    for (const [c, src] of [[0, left], [1, right]]) {
      for (let s = 0; s < STEM_COUNT; s++) {
        const base = (s * MODEL_CHANNELS + c) * f.samples;
        expect(f.data[base]).toBe(0);
        for (let t = 1; t < total; t += 631) {
          expect(f.data[base + t]).toBeCloseTo(src[t], 4);
        }
      }
    }
  });

  test('mono job duplicates the channel into both model inputs (reference: np.repeat)', async () => {
    const { host, posted, ort } = makeHost();
    await initReady(host, posted);
    const total = 5000;
    const mono = toneChannels(total)[0];
    await host.handleMessage({ type: 'separate', id: 4, sampleRate: 44100, channelCount: 1, totalSamples: total });
    await host.handleMessage({ type: 'audio', id: 4, offset: 0, channels: [mono] });
    await host.handleMessage({ type: 'run', id: 4 });
    await waitFor(posted, 'done');

    const feeds = ort.created[0].runCalls[0];
    expect(feeds.mix.dims).toEqual([1, 2, SEGMENT_SAMPLES]);
    for (let t = 0; t < total; t += 173) {
      expect(feeds.mix.data[t]).toBeCloseTo(mono[t], 6);
      expect(feeds.mix.data[SEGMENT_SAMPLES + t]).toBeCloseTo(mono[t], 6); // R == L
    }
    // Zero-padded beyond the audio (reference: np.pad constant).
    expect(feeds.mix.data[total + 10]).toBe(0);
  });

  test('multi-segment job reports each segment and covers the whole track', async () => {
    const { host, posted } = makeHost();
    await initReady(host, posted);
    const total = STRIDE_SAMPLES + 5000; // 2 segments
    const [left, right] = toneChannels(total);
    await host.handleMessage({ type: 'separate', id: 5, sampleRate: 44100, channelCount: 2, totalSamples: total });
    await host.handleMessage({ type: 'audio', id: 5, offset: 0, channels: [left, right] });
    await host.handleMessage({ type: 'run', id: 5 });
    const done = await waitFor(posted, 'done');
    expect(done.totalSegments).toBe(2);
    const progress = posted.filter((m) => m.type === 'progress');
    expect(progress.map((p) => p.segment)).toEqual([1, 2]);
    const covered = posted.filter((m) => m.type === 'stems').reduce((n, f) => n + f.samples, 0);
    expect(covered).toBe(total);
  });

  test('cancel between segments aborts: no further inference, cancelled posted, no done', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const runCalls = [];
    const { host, posted } = makeHost({
      runImpl: async (feeds) => {
        runCalls.push(feeds);
        await gate; // hold segment 1 until the test says go
        const n = feeds.mix.dims[2];
        const out = new Float32Array(STEM_COUNT * MODEL_CHANNELS * n);
        return { stems: { data: out, dims: [1, STEM_COUNT, MODEL_CHANNELS, n] } };
      },
    });
    await initReady(host, posted);
    const total = STRIDE_SAMPLES + 5000; // 2 segments
    await host.handleMessage({ type: 'separate', id: 6, sampleRate: 44100, channelCount: 2, totalSamples: total });
    await host.handleMessage({ type: 'audio', id: 6, offset: 0, channels: [new Float32Array(total), new Float32Array(total)] });
    // Deliberately NOT awaited: handleMessage('run') resolves only when the
    // whole run loop finishes, and segment 1 is gated on `release()` below.
    const runPromise = host.handleMessage({ type: 'run', id: 6 });

    // Cancel lands while segment 1 is still inside session.run.
    await host.handleMessage({ type: 'cancel', id: 6 });
    release();
    await runPromise;

    const cancelled = await waitFor(posted, 'cancelled');
    expect(cancelled.id).toBe(6);
    expect(runCalls).toHaveLength(1); // segment 2 never ran
    expect(posted.find((m) => m.type === 'done')).toBeUndefined();
  });

  test('cancel before run drops the pending job (a new separate is then accepted)', async () => {
    const { host, posted } = makeHost();
    await initReady(host, posted);
    await host.handleMessage({ type: 'separate', id: 8, sampleRate: 44100, channelCount: 2, totalSamples: 1000 });
    await host.handleMessage({ type: 'cancel', id: 8 });
    await waitFor(posted, 'cancelled');
    posted.length = 0;
    await host.handleMessage({ type: 'separate', id: 9, sampleRate: 44100, channelCount: 2, totalSamples: 1000 });
    expect(posted.filter((m) => m.type === 'error')).toHaveLength(0);
  });

  test('inference failure posts a run error with the job id', async () => {
    const { host, posted } = makeHost({
      runImpl: async () => {
        throw new Error('ort exploded');
      },
    });
    await initReady(host, posted);
    await host.handleMessage({ type: 'separate', id: 10, sampleRate: 44100, channelCount: 2, totalSamples: 1000 });
    await host.handleMessage({ type: 'audio', id: 10, offset: 0, channels: [new Float32Array(1000), new Float32Array(1000)] });
    await host.handleMessage({ type: 'run', id: 10 });
    const err = await waitFor(posted, 'error');
    expect(err.stage).toBe('run');
    expect(err.id).toBe(10);
    expect(err.message).toContain('ort exploded');
  });
});

describe('shutdown', () => {
  test('releases the session and exits 0', async () => {
    const { host, posted, exits, ort } = makeHost();
    await initReady(host, posted);
    await host.handleMessage({ type: 'shutdown' });
    expect(ort.created[0].released).toBe(true);
    expect(exits).toEqual([0]);
  });

  test('shutdown before init still exits cleanly', async () => {
    const { host, exits } = makeHost();
    await host.handleMessage({ type: 'shutdown' });
    expect(exits).toEqual([0]);
  });
});
