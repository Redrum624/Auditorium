'use strict';

/**
 * Tests for the lyrics-alignment utility-process host (F6). The host core is
 * dependency-injected (`createAlignHost({ ort, postMessage, exit, fsImpl,
 * chunkSamples, contextSamples })`) exactly like `createTranscribeHost`, so
 * these tests drive the REAL message loop, validation, chunk plan,
 * whole-utterance normalisation, log-softmax and stitching against a
 * hand-rolled onnxruntime — no 378 MB checkpoint, no download.
 *
 * What a fake ORT can and cannot reach, stated up front:
 *
 *   - It CAN reach everything this host actually decides: which slice of audio
 *     each forward pass receives, with which statistics it was normalised,
 *     which frames of each pass's output are kept, and where they land in the
 *     stitched grid. Those are the host's own arithmetic, and a fake whose
 *     logits ENCODE the global frame index (see the stitching test) fails the
 *     moment any of it is off by one.
 *   - It CANNOT reach whether the acoustic model is any good. It is not asked
 *     to: the host does not align, it returns a log-probability grid, and the
 *     Viterbi that consumes the grid is asserted separately against grids built
 *     by construction (`src/dsp/ctcAlign.test.ts`).
 *
 * The fake derives each pass's output frame count with the module's own
 * `framesForSamples`, because that IS the conv stack's contract and a fake that
 * invented a different T would test nothing. `framesForSamples` therefore does
 * not mark its own homework here — it is pinned independently below against a
 * restated HF layer table, against the closed form, and against the two counts
 * the module's own doc block quotes (176000 -> 549, 30 s -> 1499).
 */

const {
  createAlignHost,
  planChunks,
  framesForSamples,
  utteranceStats,
  ALIGN_SAMPLE_RATE,
  FRAME_SAMPLES,
  RECEPTIVE_FIELD_SAMPLES,
  CHUNK_SAMPLES,
  MAX_TOTAL_SAMPLES,
} = require('./alignHost.cjs');

/**
 * Jest's 5 s default is enough for this suite in isolation (no mel pipeline, no
 * real inference — the heaviest single test allocates a 25-frame job), but the
 * `main` project runs under the full parallel gate alongside suites that drive
 * real ONNX in child processes. 15 s is ~20x this suite's isolated runtime, so
 * it still fails fast on a genuine hang.
 */
jest.setTimeout(15000);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PATHS = { model: '/fake/align.onnx', vocab: '/fake/vocab.json' };

/** A miniature stand-in for the pinned wav2vec2 character vocabulary. */
const VOCAB = { '<pad>': 0, '<s>': 1, '</s>': 2, '<unk>': 3, '|': 4, E: 5, T: 6, A: 7 };

const FILES = { [PATHS.vocab]: JSON.stringify(VOCAB) };

function makeFs(files) {
  return {
    readFileSync: (p) => {
      if (!(p in files)) throw new Error(`fakeFs: no fixture for ${p}`);
      return files[p];
    },
  };
}

/** The fake model's output width. Small so grids stay readable. */
const CLASSES = 4;

/**
 * Deterministic, non-degenerate logits. The argmax MOVES from frame to frame,
 * so an implementation that dropped, duplicated or misplaced a row produces a
 * different grid rather than an indistinguishable one.
 */
function defaultRow(t, classes) {
  const r = new Float32Array(classes);
  for (let v = 0; v < classes; v++) r[v] = 4 * Math.sin(1.7 * t + 2.3 * v);
  return r;
}

/**
 * Hand-rolled onnxruntime. One session, one input, one output — the shape the
 * host declares. `logitsFor(t, ctx)` supplies each frame's LOGITS row (pre
 * log-softmax); `onRun(call, inputTensor)` runs before the output is built and
 * may throw or send messages back into the host.
 */
function fakeOrt({ classes = CLASSES, logitsFor, onRun, onRelease } = {}) {
  class Tensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  const created = [];
  return {
    Tensor,
    created,
    InferenceSession: {
      create: async (modelPath, opts) => {
        const session = {
          modelPath,
          opts,
          released: false,
          runCalls: 0,
          runLog: [],
          inputNames: ['input_values'],
          outputNames: ['logits'],
          release: async () => {
            session.released = true;
            if (onRelease) onRelease();
          },
          run: async (feeds) => {
            const input = feeds[session.inputNames[0]];
            session.runCalls++;
            await new Promise((r) => setImmediate(r)); // yield like real ORT
            if (onRun) await onRun(session.runCalls, input);
            expect(input.type).toBe('float32');
            expect(input.dims[0]).toBe(1);
            expect(input.dims[1]).toBe(input.data.length);
            const width = input.dims[1];
            const frames = framesForSamples(width);
            const logits = new Float32Array(frames * classes);
            for (let t = 0; t < frames; t++) {
              const row = logitsFor
                ? logitsFor(t, { input, frames, classes, call: session.runCalls })
                : defaultRow(t, classes);
              logits.set(row, t * classes);
            }
            session.runLog.push({ width, frames, input: input.data, logits });
            return { logits: new Tensor('float32', logits, [1, frames, classes]) };
          },
        };
        created.push(session);
        return session;
      },
    },
  };
}

function makeHost({ files = FILES, chunkSamples, ...ortOpts } = {}) {
  const posted = [];
  const exits = [];
  const order = [];
  const ort = fakeOrt({ ...ortOpts, onRelease: () => order.push('release') });
  const host = createAlignHost({
    ort,
    postMessage: (m) => posted.push(m),
    exit: (code) => {
      order.push('exit');
      exits.push(code);
    },
    fsImpl: makeFs(files),
    // `undefined` falls through to the module default in the destructuring.
    chunkSamples,
  });
  return { host, posted, exits, order, ort };
}

async function initHost(h) {
  await h.host.handleMessage({ type: 'init', paths: PATHS });
  expect(h.posted).toEqual([{ type: 'ready', vocab: VOCAB }]);
  h.posted.length = 0;
}

async function runJob(h, { id = 1, totalSamples, samples } = {}) {
  await h.host.handleMessage({ type: 'align', id, sampleRate: ALIGN_SAMPLE_RATE, totalSamples });
  await h.host.handleMessage({
    type: 'audio',
    id,
    offset: 0,
    samples: samples ?? new Float32Array(totalSamples),
  });
  await h.host.handleMessage({ type: 'run', id });
}

// ---------------------------------------------------------------------------
// Independent references — written out here so the module cannot check itself
// ---------------------------------------------------------------------------

/**
 * The HF wav2vec2 feature-encoder conv stack, restated from the checkpoint's
 * `conv_kernel` / `conv_stride` rather than imported, applying HF's
 * `_get_feat_extract_output_lengths` rule `floor((L - k)/s) + 1` per layer.
 */
const REF_CONV = [
  [10, 5],
  [3, 2],
  [3, 2],
  [3, 2],
  [3, 2],
  [2, 2],
  [2, 2],
];

function refFrames(samples) {
  let length = samples;
  for (const [kernel, stride] of REF_CONV) {
    if (length < kernel) return 0;
    length = Math.floor((length - kernel) / stride) + 1;
  }
  return Math.max(0, length);
}

/** HF's `zero_mean_unit_var_norm`; 1e-7 is the reference epsilon (pinned). */
function refStats(samples) {
  const n = samples.length;
  if (n === 0) return { mean: 0, scale: 1 };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (samples[i] - mean) * (samples[i] - mean);
  return { mean, scale: 1 / Math.sqrt(variance / n + 1e-7) };
}

function refLogSoftmax(row) {
  const mx = Math.max(...row);
  let sum = 0;
  for (const v of row) sum += Math.exp(v - mx);
  const lse = mx + Math.log(sum);
  return row.map((v) => v - lse);
}

function argmax(row) {
  let best = 0;
  for (let i = 1; i < row.length; i++) if (row[i] > row[best]) best = i;
  return best;
}

function meanOf(values) {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

// ===========================================================================
// Protocol
// ===========================================================================

describe('init', () => {
  test('creates one CPU-EP session and replies ready with the PARSED vocab verbatim', async () => {
    const h = makeHost();
    await h.host.handleMessage({ type: 'init', paths: PATHS });
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0].type).toBe('ready');
    // Not merely "a vocab": the model's own token -> id map, unmodified. A host
    // that re-derived ids would score a different sequence than it reports.
    expect(h.posted[0].vocab).toEqual(VOCAB);
    expect(Object.entries(h.posted[0].vocab)).toEqual(Object.entries(VOCAB));
    expect(h.ort.created).toHaveLength(1);
    expect(h.ort.created[0].modelPath).toBe(PATHS.model);
    expect(h.ort.created[0].opts.executionProviders).toEqual(['cpu']);
  });

  test('missing or blank model/vocab paths are a protocol error', async () => {
    for (const paths of [
      undefined,
      null,
      'not-an-object',
      {},
      { model: PATHS.model },
      { vocab: PATHS.vocab },
      { model: '', vocab: PATHS.vocab },
      { model: PATHS.model, vocab: '' },
      { model: 7, vocab: PATHS.vocab },
      [PATHS.model, PATHS.vocab],
    ]) {
      const h = makeHost();
      await h.host.handleMessage({ type: 'init', paths });
      expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
      expect(h.ort.created).toHaveLength(0);
    }
  });

  test('a second init is refused ("session already created")', async () => {
    const h = makeHost();
    await initHost(h);
    await h.host.handleMessage({ type: 'init', paths: PATHS });
    expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
    expect(h.posted[0].message).toMatch(/already created/);
    expect(h.ort.created).toHaveLength(1); // no second session leaked
  });

  test('an unusable vocab.json is an init error and leaves the host uninitialised', async () => {
    const cases = {
      'unparseable JSON': 'not json at all',
      'an array': '[1, 2, 3]',
      'a number': '42',
      'null': 'null',
      'a string': '"a vocabulary"',
      'a non-integer id': '{"a": 1.5}',
      'a negative id': '{"a": -1}',
    };
    for (const [label, body] of Object.entries(cases)) {
      const h = makeHost({ files: { [PATHS.vocab]: body } });
      await h.host.handleMessage({ type: 'init', paths: PATHS });
      expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'init' });
      expect(typeof h.posted[0].message).toBe('string');
      // Uninitialised, not half-initialised: the very next align must say so.
      h.posted.length = 0;
      await h.host.handleMessage({
        type: 'align',
        id: 1,
        sampleRate: ALIGN_SAMPLE_RATE,
        totalSamples: RECEPTIVE_FIELD_SAMPLES,
      });
      expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
      expect(h.posted[0].message).toMatch(/not initialised/);
      expect(label).toBe(label); // keeps the failing case identifiable in output
    }
  });
});

describe('message validation (trust boundary)', () => {
  test('malformed and unknown messages are protocol errors, and never throw', async () => {
    const h = makeHost();
    await initHost(h);
    for (const bad of [null, undefined, 42, 'x', [], {}, { type: 7 }, { type: 'nope' }]) {
      h.posted.length = 0;
      await expect(h.host.handleMessage(bad)).resolves.toBeUndefined();
      expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
    }
  });

  test('align before init is refused', async () => {
    const h = makeHost();
    await h.host.handleMessage({
      type: 'align',
      id: 1,
      sampleRate: ALIGN_SAMPLE_RATE,
      totalSamples: RECEPTIVE_FIELD_SAMPLES,
    });
    expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
    expect(h.posted[0].message).toMatch(/not initialised/);
  });

  test('align id must be an integer', async () => {
    const h = makeHost();
    await initHost(h);
    for (const id of [undefined, null, '1', 1.5, NaN]) {
      h.posted.length = 0;
      await h.host.handleMessage({
        type: 'align',
        id,
        sampleRate: ALIGN_SAMPLE_RATE,
        totalSamples: RECEPTIVE_FIELD_SAMPLES,
      });
      expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
    }
  });

  test('sampleRate must be exactly 16000 (probe below / on / above)', async () => {
    const h = makeHost();
    await initHost(h);
    for (const rate of [ALIGN_SAMPLE_RATE - 1, ALIGN_SAMPLE_RATE + 1]) {
      h.posted.length = 0;
      await h.host.handleMessage({
        type: 'align',
        id: 1,
        sampleRate: rate,
        totalSamples: RECEPTIVE_FIELD_SAMPLES,
      });
      expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol', id: 1 });
      expect(h.posted[0].message).toMatch(new RegExp(String(ALIGN_SAMPLE_RATE)));
    }
    h.posted.length = 0;
    await h.host.handleMessage({
      type: 'align',
      id: 1,
      sampleRate: ALIGN_SAMPLE_RATE,
      totalSamples: RECEPTIVE_FIELD_SAMPLES,
    });
    expect(h.posted).toEqual([]); // accepted silently
  });

  test('totalSamples: 0 and MAX+1 are refused, and the message names the bound', async () => {
    const h = makeHost();
    await initHost(h);
    for (const total of [0, -1, 1.5, '400', MAX_TOTAL_SAMPLES + 1]) {
      h.posted.length = 0;
      await h.host.handleMessage({
        type: 'align',
        id: 1,
        sampleRate: ALIGN_SAMPLE_RATE,
        totalSamples: total,
      });
      expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol', id: 1 });
      // The bound is stated so the caller can see WHICH limit it hit — and it
      // is checked BEFORE the job buffer is allocated, which is why probing
      // MAX + 1 here costs nothing (allocating MAX would cost 76.8 MB).
      expect(h.posted[0].message).toContain(`[1, ${MAX_TOTAL_SAMPLES}]`);
    }
    expect(MAX_TOTAL_SAMPLES).toBe(ALIGN_SAMPLE_RATE * 1200); // 20 minutes
  });

  test('the receptive field is the real lower bound: 399 yields no frames, 400 yields one', async () => {
    // 1 sample is legal by the [1, MAX] range check and still refused, because
    // audio shorter than the conv stack's 400-sample receptive field produces
    // an empty grid. Probe below / on / above that boundary.
    expect(framesForSamples(RECEPTIVE_FIELD_SAMPLES - 1)).toBe(0);
    expect(framesForSamples(RECEPTIVE_FIELD_SAMPLES)).toBe(1);
    const h = makeHost();
    await initHost(h);
    for (const total of [1, RECEPTIVE_FIELD_SAMPLES - 1]) {
      h.posted.length = 0;
      await h.host.handleMessage({
        type: 'align',
        id: 1,
        sampleRate: ALIGN_SAMPLE_RATE,
        totalSamples: total,
      });
      expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol', id: 1 });
      expect(h.posted[0].message).toMatch(/yields no frames/);
      expect(h.posted[0].message).toContain(String(RECEPTIVE_FIELD_SAMPLES));
    }
    h.posted.length = 0;
    await h.host.handleMessage({
      type: 'align',
      id: 1,
      sampleRate: ALIGN_SAMPLE_RATE,
      totalSamples: RECEPTIVE_FIELD_SAMPLES,
    });
    expect(h.posted).toEqual([]);
  });

  test('a second align while a job is open is refused (single-job host)', async () => {
    const h = makeHost();
    await initHost(h);
    await h.host.handleMessage({
      type: 'align',
      id: 1,
      sampleRate: ALIGN_SAMPLE_RATE,
      totalSamples: RECEPTIVE_FIELD_SAMPLES,
    });
    expect(h.posted).toEqual([]);
    await h.host.handleMessage({
      type: 'align',
      id: 2,
      sampleRate: ALIGN_SAMPLE_RATE,
      totalSamples: RECEPTIVE_FIELD_SAMPLES,
    });
    expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol', id: 2 });
    expect(h.posted[0].message).toMatch(/single-job/);
  });

  test('audio payload and range validation (probe the range boundaries)', async () => {
    const total = RECEPTIVE_FIELD_SAMPLES * 2;
    const len = 100;
    const h = makeHost();
    await initHost(h);
    await h.host.handleMessage({
      type: 'align',
      id: 1,
      sampleRate: ALIGN_SAMPLE_RATE,
      totalSamples: total,
    });
    const cases = [
      { id: 2, offset: 0, samples: new Float32Array(len) }, // wrong job
      { id: 1, offset: 0, samples: [1, 2, 3] }, // plain array
      { id: 1, offset: 0, samples: new Float64Array(len) }, // wrong element type
      { id: 1, offset: 0, samples: new Float32Array(0) }, // empty
      { id: 1, offset: -1, samples: new Float32Array(len) }, // below range
      { id: 1, offset: 0.5, samples: new Float32Array(len) }, // non-integer
      { id: 1, offset: total - len + 1, samples: new Float32Array(len) }, // one past the end
    ];
    for (const c of cases) {
      h.posted.length = 0;
      await h.host.handleMessage({ type: 'audio', ...c });
      expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
    }
    h.posted.length = 0;
    // ...and exactly ON the end is accepted.
    await h.host.handleMessage({
      type: 'audio',
      id: 1,
      offset: total - len,
      samples: new Float32Array(len),
    });
    expect(h.posted).toEqual([]);
  });

  test('run with incomplete coverage is refused; duplicated ranges do not count', async () => {
    const total = RECEPTIVE_FIELD_SAMPLES * 2;
    const half = total / 2;
    const h = makeHost();
    await initHost(h);
    await h.host.handleMessage({
      type: 'align',
      id: 1,
      sampleRate: ALIGN_SAMPLE_RATE,
      totalSamples: total,
    });
    await h.host.handleMessage({ type: 'audio', id: 1, offset: 0, samples: new Float32Array(half) });
    await h.host.handleMessage({ type: 'audio', id: 1, offset: 0, samples: new Float32Array(half) });
    h.posted.length = 0;
    await h.host.handleMessage({ type: 'run', id: 1 });
    expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol', id: 1 });
    expect(h.posted[0].message).toContain(`${half} of ${total}`);
    expect(h.posted[0].message).toMatch(/duplicated ranges do not count/);
    expect(h.ort.created[0].runCalls).toBe(0);

    // The control that makes the refusal non-vacuous: the SAME job runs once
    // the missing half arrives.
    h.posted.length = 0;
    await h.host.handleMessage({
      type: 'audio',
      id: 1,
      offset: half,
      samples: new Float32Array(half),
    });
    await h.host.handleMessage({ type: 'run', id: 1 });
    expect(h.posted.some((m) => m.type === 'error')).toBe(false);
    expect(h.posted.some((m) => m.type === 'done')).toBe(true);
    expect(h.ort.created[0].runCalls).toBe(1);
  });

  test('run for an unknown id is refused', async () => {
    const h = makeHost();
    await initHost(h);
    await h.host.handleMessage({ type: 'run', id: 99 }); // no job at all
    expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol', id: 99 });
    h.posted.length = 0;
    await h.host.handleMessage({
      type: 'align',
      id: 1,
      sampleRate: ALIGN_SAMPLE_RATE,
      totalSamples: RECEPTIVE_FIELD_SAMPLES,
    });
    await h.host.handleMessage({ type: 'run', id: 2 }); // wrong job
    expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol', id: 2 });
    expect(h.ort.created[0].runCalls).toBe(0);
  });

  test('cancel before run drops the job, and cancel for an unknown id is idempotent', async () => {
    const h = makeHost();
    await initHost(h);
    await h.host.handleMessage({
      type: 'align',
      id: 1,
      sampleRate: ALIGN_SAMPLE_RATE,
      totalSamples: RECEPTIVE_FIELD_SAMPLES,
    });
    await h.host.handleMessage({ type: 'cancel', id: 1 });
    expect(h.posted).toEqual([{ type: 'cancelled', id: 1 }]);
    // The job is gone: run no longer knows it, and a fresh align is accepted.
    h.posted.length = 0;
    await h.host.handleMessage({ type: 'run', id: 1 });
    expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
    h.posted.length = 0;
    await h.host.handleMessage({ type: 'cancel', id: 777 }); // never existed
    expect(h.posted).toEqual([{ type: 'cancelled', id: 777 }]);
    h.posted.length = 0;
    await h.host.handleMessage({
      type: 'align',
      id: 2,
      sampleRate: ALIGN_SAMPLE_RATE,
      totalSamples: RECEPTIVE_FIELD_SAMPLES,
    });
    expect(h.posted).toEqual([]);
  });
});

describe('shutdown', () => {
  test('releases the session and THEN exits 0', async () => {
    const h = makeHost();
    await initHost(h);
    await h.host.handleMessage({ type: 'shutdown' });
    expect(h.ort.created[0].released).toBe(true);
    expect(h.exits).toEqual([0]);
    // Order matters: exiting first would leak the ORT arena to process teardown.
    expect(h.order).toEqual(['release', 'exit']);
  });

  test('shutdown before init still exits cleanly', async () => {
    const h = makeHost();
    await h.host.handleMessage({ type: 'shutdown' });
    expect(h.exits).toEqual([0]);
    expect(h.order).toEqual(['exit']);
  });
});

// ===========================================================================
// Inference
// ===========================================================================

describe('alignment run', () => {
  test('happy path: progress, exactly one emissions, then done', async () => {
    const h = makeHost();
    await initHost(h);
    const totalSamples = ALIGN_SAMPLE_RATE; // 1 s — one chunk at the real 30 s width
    await runJob(h, { totalSamples });

    const types = h.posted.map((m) => m.type);
    expect(types).not.toContain('error');
    expect(types.filter((t) => t === 'emissions')).toHaveLength(1);
    expect(types[types.length - 1]).toBe('done');
    expect(types.indexOf('progress')).toBeLessThan(types.indexOf('emissions'));

    const frames = framesForSamples(totalSamples);
    const em = h.posted.find((m) => m.type === 'emissions');
    expect(em).toMatchObject({ id: 1, frames, classes: CLASSES });
    expect(em.frameSamples).toBe(320); // 20 ms at 16 kHz, the documented stride
    expect(em.frameSamples).toBe(FRAME_SAMPLES);
    expect(em.logProbs).toBeInstanceOf(Float32Array);
    expect(em.logProbs).toHaveLength(frames * CLASSES);
    expect(h.posted[h.posted.length - 1]).toEqual({ type: 'done', id: 1, frames });

    for (const p of h.posted.filter((m) => m.type === 'progress')) {
      expect(p.total).toBe(totalSamples);
      expect(p.done).toBeGreaterThan(0);
      expect(p.done).toBeLessThanOrEqual(totalSamples);
    }

    // The host is single-job: finishing frees it for the next align.
    h.posted.length = 0;
    await h.host.handleMessage({
      type: 'align',
      id: 2,
      sampleRate: ALIGN_SAMPLE_RATE,
      totalSamples: RECEPTIVE_FIELD_SAMPLES,
    });
    expect(h.posted).toEqual([]);
  });

  test('the emissions grid is the row-wise log-softmax of the model logits', async () => {
    const h = makeHost();
    await initHost(h);
    const totalSamples = ALIGN_SAMPLE_RATE;
    await runJob(h, { totalSamples });
    const em = h.posted.find((m) => m.type === 'emissions');
    const session = h.ort.created[0];
    expect(session.runLog).toHaveLength(1);
    const raw = session.runLog[0].logits;
    const seenArgmax = new Set();
    for (let t = 0; t < em.frames; t++) {
      const rawRow = Array.from(raw.subarray(t * CLASSES, (t + 1) * CLASSES));
      const lpRow = Array.from(em.logProbs.subarray(t * CLASSES, (t + 1) * CLASSES));
      // A normalised distribution, in log space.
      let mass = 0;
      for (const v of lpRow) mass += Math.exp(v);
      expect(Math.abs(mass - 1)).toBeLessThan(1e-6);
      // ...that preserves the model's decision.
      expect(argmax(lpRow)).toBe(argmax(rawRow));
      seenArgmax.add(argmax(rawRow));
      const ref = refLogSoftmax(rawRow);
      for (let v = 0; v < CLASSES; v++) expect(lpRow[v]).toBeCloseTo(ref[v], 5);
    }
    // The argmax test above is only meaningful if the argmax actually moves.
    expect(seenArgmax.size).toBeGreaterThan(1);
  });

  test('confident logits do not overflow the softmax', async () => {
    // Max-subtraction, not exp-then-normalise: logits in the tens would
    // otherwise produce Infinity / NaN across the whole row.
    const h = makeHost({
      logitsFor: (t) => Float32Array.from({ length: CLASSES }, (_, v) => (v === t % CLASSES ? 400 : -400)),
    });
    await initHost(h);
    await runJob(h, { totalSamples: RECEPTIVE_FIELD_SAMPLES * 4 });
    const em = h.posted.find((m) => m.type === 'emissions');
    for (const v of em.logProbs) expect(Number.isFinite(v)).toBe(true);
    for (let t = 0; t < em.frames; t++) {
      expect(em.logProbs[t * CLASSES + (t % CLASSES)]).toBeCloseTo(0, 6); // p ~ 1
    }
  });

  // -------------------------------------------------------------------------
  // Whole-utterance normalisation.
  //
  // `preprocessor_config.json` sets `do_normalize: true`, and the statistics
  // are the UTTERANCE's. Normalising per chunk would give the same audio a
  // different input depending on where the boundaries fell — and on a chunk
  // that happens to be constant it would map every sample to exactly 0, which
  // is what makes the assertion below sharp.
  // -------------------------------------------------------------------------
  test('every chunk is normalised with the WHOLE job statistics, not its own', async () => {
    const chunkSamples = FRAME_SAMPLES * 10;
    const totalSamples = 8080; // > 2 chunks, and an exact multiple of 2
    const dc = 1;
    const half = totalSamples / 2;
    const samples = new Float32Array(totalSamples);
    samples.fill(dc, half); // a large DC step in the second half

    const h = makeHost({ chunkSamples });
    await initHost(h);
    await runJob(h, { totalSamples, samples });
    expect(h.posted.some((m) => m.type === 'error')).toBe(false);

    const { mean, scale } = refStats(samples);
    const quietValue = (0 - mean) * scale;
    const loudValue = (dc - mean) * scale;
    const chunks = planChunks(totalSamples, chunkSamples);
    const runLog = h.ort.created[0].runLog;
    expect(runLog).toHaveLength(chunks.length);
    expect(chunks.length).toBeGreaterThan(2);

    // 1. Every sample of every pass is the whole-job normalisation of the
    //    corresponding job sample.
    for (let k = 0; k < chunks.length; k++) {
      const { start, end } = chunks[k];
      expect(runLog[k].width).toBe(end - start);
      for (let i = 0; i < runLog[k].width; i++) {
        expect(runLog[k].input[i]).toBeCloseTo((samples[start + i] - mean) * scale, 4);
      }
    }

    // 2. A pass lying wholly inside one constant half is a CONSTANT non-zero
    //    input. Per-chunk normalisation of a constant chunk is exactly 0, so
    //    this single assertion separates the two policies.
    const quietIdx = chunks.findIndex((c) => c.end <= half);
    const loudIdx = chunks.findIndex((c) => c.start >= half);
    expect(quietIdx).toBeGreaterThanOrEqual(0);
    expect(loudIdx).toBeGreaterThanOrEqual(0);
    expect(Math.abs(quietValue)).toBeGreaterThan(0.5);
    expect(Math.abs(loudValue)).toBeGreaterThan(0.5);
    for (const v of runLog[quietIdx].input) expect(v).toBeCloseTo(quietValue, 4);
    for (const v of runLog[loudIdx].input) expect(v).toBeCloseTo(loudValue, 4);

    // 3. And the pass that straddles the step is NOT zero-mean on its own —
    //    the direct form of "no individual chunk is separately normalised".
    const straddleIdx = chunks.findIndex((c) => c.start < half && c.end > half);
    expect(straddleIdx).toBeGreaterThanOrEqual(0);
    const straddle = chunks[straddleIdx];
    const quietCount = half - straddle.start;
    const loudCount = straddle.end - half;
    const expectedMean = (quietCount * quietValue + loudCount * loudValue) / (straddle.end - straddle.start);
    expect(meanOf(runLog[straddleIdx].input)).toBeCloseTo(expectedMean, 4);
    expect(Math.abs(expectedMean)).toBeGreaterThan(0.4);

    // 4. Sanity on the statistics themselves: over the whole job the normalised
    //    signal is zero-mean and unit-variance.
    const normalised = Float32Array.from(samples, (v) => (v - mean) * scale);
    const whole = refStats(normalised);
    expect(whole.mean).toBeCloseTo(0, 5);
    expect(1 / whole.scale).toBeCloseTo(1, 5);
  });

  // -------------------------------------------------------------------------
  // Chunking. The plan's unit is FRAMES, not samples, so the boundary at which
  // a second forward pass appears is derived rather than assumed.
  // -------------------------------------------------------------------------
  test('one pass up to the frame budget, two beyond it (probe below / on / above)', async () => {
    const chunkSamples = FRAME_SAMPLES * 10;
    const coreFrames = Math.floor(chunkSamples / FRAME_SAMPLES);
    // The smallest job whose frame count exceeds what one pass contributes.
    let firstTwoPass = chunkSamples + 1;
    while (framesForSamples(firstTwoPass) <= coreFrames) firstTwoPass++;
    // It lands one receptive field past the chunk width, not one frame past it:
    // a pass of `chunkSamples` samples yields coreFrames - 1 frames, so the
    // first `chunkSamples + FRAME_SAMPLES` of extra audio still fits one pass.
    expect(firstTwoPass).toBe(chunkSamples + RECEPTIVE_FIELD_SAMPLES);

    const probes = [
      [chunkSamples - FRAME_SAMPLES, 1],
      [chunkSamples, 1],
      [firstTwoPass - 1, 1],
      [firstTwoPass, 2],
    ];
    for (const [totalSamples, expectedPasses] of probes) {
      expect(planChunks(totalSamples, chunkSamples)).toHaveLength(expectedPasses);
      const h = makeHost({ chunkSamples });
      await initHost(h);
      await runJob(h, { totalSamples });
      expect(h.posted.some((m) => m.type === 'error')).toBe(false);
      expect(h.ort.created[0].runCalls).toBe(expectedPasses);
      expect(h.posted.filter((m) => m.type === 'progress')).toHaveLength(expectedPasses);
      const em = h.posted.find((m) => m.type === 'emissions');
      expect(em.frames).toBe(framesForSamples(totalSamples));
    }
  });

  // -------------------------------------------------------------------------
  // Stitching, asserted by CONSTRUCTION rather than by re-running the planner.
  //
  // The job's audio is the sample-index ramp, so the fake can recover the
  // absolute start of whatever slice it was handed by inverting the (known)
  // whole-job normalisation. It then writes the GLOBAL frame index into class 0
  // of every row. Because log-softmax of [a, 0, 0, 0] satisfies
  // out[0] - out[1] = a exactly, the test reads each global index back out of
  // the stitched grid. Any gap, overlap, off-by-one localOffset or kept-range
  // mistake shows up as frame g carrying some other frame's index.
  // -------------------------------------------------------------------------
  test('the stitched grid tiles [0, frames) with each frame from its owning pass', async () => {
    const chunkSamples = FRAME_SAMPLES * 10;
    const totalSamples = 8080;
    const samples = Float32Array.from({ length: totalSamples }, (_, i) => i);
    const { mean, scale } = refStats(samples);

    const h = makeHost({
      chunkSamples,
      logitsFor: (t, { input, classes }) => {
        const startFrame = Math.round((input.data[0] / scale + mean) / FRAME_SAMPLES);
        const row = new Float32Array(classes);
        row[0] = startFrame + t; // the GLOBAL frame index
        return row;
      },
    });
    await initHost(h);
    await runJob(h, { totalSamples, samples });
    expect(h.posted.some((m) => m.type === 'error')).toBe(false);

    const em = h.posted.find((m) => m.type === 'emissions');
    const totalFrames = framesForSamples(totalSamples);
    expect(em.frames).toBe(totalFrames);
    expect(h.ort.created[0].runCalls).toBeGreaterThan(1); // stitching is non-vacuous
    for (let g = 0; g < totalFrames; g++) {
      const recovered = em.logProbs[g * CLASSES] - em.logProbs[g * CLASSES + 1];
      expect(recovered).toBeCloseTo(g, 3);
    }
  });

  test('progress reports samples analysed, monotonically, bounded by the job length', async () => {
    const chunkSamples = FRAME_SAMPLES * 10;
    const totalSamples = 8080;
    const h = makeHost({ chunkSamples });
    await initHost(h);
    await runJob(h, { totalSamples });
    const chunks = planChunks(totalSamples, chunkSamples);
    const progress = h.posted.filter((m) => m.type === 'progress');
    expect(progress).toHaveLength(chunks.length);
    let previous = 0;
    for (let k = 0; k < progress.length; k++) {
      expect(progress[k]).toMatchObject({ id: 1, total: totalSamples });
      expect(progress[k].done).toBe(Math.min(totalSamples, chunks[k].keepTo * FRAME_SAMPLES));
      expect(progress[k].done).toBeGreaterThan(previous);
      previous = progress[k].done;
    }
    expect(previous).toBeLessThanOrEqual(totalSamples);
  });

  test('cancel DURING the run unwinds between chunks: cancelled, no emissions', async () => {
    const chunkSamples = FRAME_SAMPLES * 10;
    const totalSamples = 8080;
    const ref = {};
    const h = makeHost({
      chunkSamples,
      onRun: async (call) => {
        if (call === 2) await ref.host.handleMessage({ type: 'cancel', id: 1 });
      },
    });
    ref.host = h.host;
    await initHost(h);
    await runJob(h, { totalSamples });

    const types = h.posted.map((m) => m.type);
    expect(types).toContain('cancelled');
    expect(types).not.toContain('emissions');
    expect(types).not.toContain('done');
    expect(types).not.toContain('error');
    expect(h.posted.find((m) => m.type === 'cancelled')).toEqual({ type: 'cancelled', id: 1 });
    // Honoured BETWEEN chunks: the pass in flight finished, the rest never ran.
    expect(h.ort.created[0].runCalls).toBe(2);
    expect(planChunks(totalSamples, chunkSamples).length).toBeGreaterThan(2);
    // ...and the host is free again.
    h.posted.length = 0;
    await h.host.handleMessage({
      type: 'align',
      id: 2,
      sampleRate: ALIGN_SAMPLE_RATE,
      totalSamples: RECEPTIVE_FIELD_SAMPLES,
    });
    expect(h.posted).toEqual([]);
  });

  test('inference failure posts a run error with the job id and frees the host', async () => {
    const h = makeHost({
      onRun: () => {
        throw new Error('onnx exploded');
      },
    });
    await initHost(h);
    await runJob(h, { totalSamples: ALIGN_SAMPLE_RATE });
    const err = h.posted.find((m) => m.type === 'error');
    expect(err).toMatchObject({ type: 'error', stage: 'run', id: 1 });
    expect(err.message).toMatch(/onnx exploded/);
    expect(h.posted.some((m) => m.type === 'emissions')).toBe(false);
    expect(h.posted.some((m) => m.type === 'done')).toBe(false);
    h.posted.length = 0;
    await h.host.handleMessage({
      type: 'align',
      id: 2,
      sampleRate: ALIGN_SAMPLE_RATE,
      totalSamples: RECEPTIVE_FIELD_SAMPLES,
    });
    expect(h.posted).toEqual([]);
  });
});

// ===========================================================================
// Pure helpers
// ===========================================================================

describe('framesForSamples', () => {
  test('matches the HF conv recursion, including the documented 176000 -> 549', async () => {
    // The figure the module's own doc block quotes: 11.000 s at 16 kHz is 549
    // frames, which is what makes 11.000 / 549 = 20.036 ms rather than 20.
    expect(framesForSamples(11 * ALIGN_SAMPLE_RATE)).toBe(549);
    expect(11 * ALIGN_SAMPLE_RATE).toBe(176000);
    // The 30 s operating point from the chunk-size measurement table.
    expect(framesForSamples(CHUNK_SAMPLES)).toBe(1499);
    for (const n of [0, 1, 9, 10, 100, 319, 320, 399, 400, 401, 719, 720, 721, 1000, 16000, 44100, 176000, 480000, 1234567]) {
      expect(framesForSamples(n)).toBe(refFrames(n));
    }
  });

  test('the receptive field is where frames begin, and the stride is 320 thereafter', async () => {
    expect(framesForSamples(RECEPTIVE_FIELD_SAMPLES - 1)).toBe(0);
    expect(framesForSamples(RECEPTIVE_FIELD_SAMPLES)).toBe(1);
    expect(framesForSamples(RECEPTIVE_FIELD_SAMPLES + FRAME_SAMPLES)).toBe(2);
    // Every extra FRAME_SAMPLES buys exactly one more frame.
    for (let k = 0; k < 50; k++) {
      expect(framesForSamples(RECEPTIVE_FIELD_SAMPLES + k * FRAME_SAMPLES)).toBe(k + 1);
      expect(framesForSamples(RECEPTIVE_FIELD_SAMPLES + k * FRAME_SAMPLES - 1)).toBe(k);
    }
  });

  test('is non-decreasing and never negative', async () => {
    let previous = 0;
    for (let n = 0; n <= 5000; n++) {
      const frames = framesForSamples(n);
      expect(frames).toBeGreaterThanOrEqual(previous);
      previous = frames;
    }
  });

  test('IS the closed form max(0, floor((L - 400)/320) + 1), at every length', async () => {
    // The doc block used to claim the recursion and the closed form "are NOT
    // the same function (they differ for some short lengths, where an
    // intermediate layer's floor bites before the last one does)". No such
    // length exists for this layer table. Swept exhaustively rather than
    // spot-checked, because "they differ SOMEWHERE" is precisely the claim a
    // handful of samples cannot refute.
    const closedForm = (n) =>
      Math.max(0, Math.floor((n - RECEPTIVE_FIELD_SAMPLES) / FRAME_SAMPLES) + 1);
    const divergences = [];
    for (let n = 0; n <= 200000; n++) {
      if (framesForSamples(n) !== closedForm(n)) divergences.push(n);
      if (divergences.length > 4) break;
    }
    expect(divergences).toEqual([]);
    // The clamp is load-bearing and is the whole of the difference: the BARE
    // closed form goes negative below the receptive field, which is where the
    // "they differ" story came from.
    expect(Math.floor((79 - RECEPTIVE_FIELD_SAMPLES) / FRAME_SAMPLES) + 1).toBe(-1);
    expect(framesForSamples(79)).toBe(0);
    expect(Math.floor((80 - RECEPTIVE_FIELD_SAMPLES) / FRAME_SAMPLES) + 1).toBe(0);
  });
});

describe('planChunks', () => {
  const WIDTHS = [FRAME_SAMPLES * 2, FRAME_SAMPLES * 3, FRAME_SAMPLES * 5, FRAME_SAMPLES * 10, ALIGN_SAMPLE_RATE];

  test('a job that fits in one chunk gets one pass over exactly itself (below / on / above)', async () => {
    const chunkSamples = FRAME_SAMPLES * 10;
    for (const totalSamples of [chunkSamples - FRAME_SAMPLES, chunkSamples]) {
      const chunks = planChunks(totalSamples, chunkSamples);
      expect(chunks).toEqual([
        { start: 0, end: totalSamples, keepFrom: 0, keepTo: framesForSamples(totalSamples) },
      ]);
    }
    // Just above the comparison the general path takes over. It is still ONE
    // pass — the plan budgets frames, not samples — but the pass now stops at
    // the last kept frame's receptive field instead of at the job's end, so the
    // trailing samples that belong to no frame are not fed to the graph.
    const above = chunkSamples + FRAME_SAMPLES;
    const chunks = planChunks(above, chunkSamples);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ start: 0, keepFrom: 0, keepTo: framesForSamples(above) });
    expect(chunks[0].end).toBe((framesForSamples(above) - 1) * FRAME_SAMPLES + RECEPTIVE_FIELD_SAMPLES);
    expect(chunks[0].end).toBeLessThan(above);
  });

  test('audio too short for a single frame yields no passes at all', async () => {
    for (const totalSamples of [0, 1, RECEPTIVE_FIELD_SAMPLES - 1]) {
      expect(framesForSamples(totalSamples)).toBe(0);
      expect(planChunks(totalSamples, FRAME_SAMPLES * 10)).toEqual([]);
    }
  });

  test('kept ranges tile [0, totalFrames) with no gap and no overlap', async () => {
    for (const chunkSamples of WIDTHS) {
      for (let totalSamples = 1; totalSamples <= chunkSamples * 3 + RECEPTIVE_FIELD_SAMPLES; totalSamples += 13) {
        const totalFrames = framesForSamples(totalSamples);
        const chunks = planChunks(totalSamples, chunkSamples);
        let expected = 0;
        for (const chunk of chunks) {
          expect(chunk.keepFrom).toBe(expected);
          expect(chunk.keepTo).toBeGreaterThan(chunk.keepFrom);
          expected = chunk.keepTo;
        }
        expect(expected).toBe(totalFrames);
      }
    }
  });

  test('every pass starts on a frame boundary and reaches its last kept frame', async () => {
    for (const chunkSamples of WIDTHS) {
      for (let totalSamples = 1; totalSamples <= chunkSamples * 3 + RECEPTIVE_FIELD_SAMPLES; totalSamples += 13) {
        for (const chunk of planChunks(totalSamples, chunkSamples)) {
          // Frame-aligned starts are what make stitching exact: local frame 0
          // of a pass beginning at sample s IS global frame s / 320.
          expect(chunk.start % FRAME_SAMPLES).toBe(0);
          expect(chunk.start).toBeGreaterThanOrEqual(0);
          expect(chunk.end).toBeLessThanOrEqual(totalSamples);
          // The last kept frame must physically exist in the pass.
          const needed = (chunk.keepTo - 1) * FRAME_SAMPLES + RECEPTIVE_FIELD_SAMPLES;
          expect(chunk.end).toBeGreaterThanOrEqual(needed);
          // ...which is the same statement in frames: every kept global index
          // maps to a local index the pass actually produced.
          const localOffset = chunk.start / FRAME_SAMPLES;
          const chunkFrames = framesForSamples(chunk.end - chunk.start);
          expect(chunk.keepFrom - localOffset).toBeGreaterThanOrEqual(0);
          expect(chunk.keepTo - 1 - localOffset).toBeLessThan(chunkFrames);
        }
      }
    }
  });

  test('at the shipped constants, 30 s is one pass and the second appears a receptive field later', async () => {
    expect(planChunks(CHUNK_SAMPLES)).toHaveLength(1);
    expect(planChunks(CHUNK_SAMPLES + FRAME_SAMPLES)).toHaveLength(1);
    expect(planChunks(CHUNK_SAMPLES + RECEPTIVE_FIELD_SAMPLES)).toHaveLength(2);
  });
});

describe('utteranceStats', () => {
  test('zero-length input is the identity transform', async () => {
    expect(utteranceStats(new Float32Array(0))).toEqual({ mean: 0, scale: 1 });
  });

  test('constant input: the mean is the constant and the epsilon caps the scale', async () => {
    for (const constant of [0, 1, -3.5]) {
      const samples = new Float32Array(64).fill(constant);
      const { mean, scale } = utteranceStats(samples);
      expect(mean).toBeCloseTo(constant, 6);
      // Zero variance would divide by zero; HF's 1e-7 epsilon bounds it.
      expect(scale).toBeCloseTo(1 / Math.sqrt(1e-7), 6);
      expect(Number.isFinite(scale)).toBe(true);
      for (const v of samples) expect((v - mean) * scale).toBeCloseTo(0, 6);
    }
  });

  test('(x - mean) * scale has zero mean and unit variance', async () => {
    const samples = Float32Array.from({ length: 4096 }, (_, i) => 3 + 7 * Math.sin(i * 0.31) + 2 * Math.cos(i * 0.07));
    const { mean, scale } = utteranceStats(samples);
    expect(mean).toBeCloseTo(refStats(samples).mean, 5);
    expect(scale).toBeCloseTo(refStats(samples).scale, 5);
    const normalised = Float32Array.from(samples, (v) => (v - mean) * scale);
    let m = 0;
    for (const v of normalised) m += v;
    m /= normalised.length;
    let variance = 0;
    for (const v of normalised) variance += (v - m) * (v - m);
    variance /= normalised.length;
    expect(m).toBeCloseTo(0, 5);
    expect(variance).toBeCloseTo(1, 5);
  });
});
