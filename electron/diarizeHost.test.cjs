'use strict';

/**
 * Tests for the speaker-diarization utility-process host (Separate Speakers,
 * D1/D2). The host core is dependency-injected (`createDiarizeHost({ ort,
 * postMessage, exit })`) so these tests drive the REAL message loop,
 * validation, window plan, batch choreography, fragment arithmetic, fbank +
 * CMN front-end and embedding pass against a fake onnxruntime:
 *
 *   - the segmentation fake emits a deterministic [N, 589, 7] pattern
 *     (`classAt(windowIndex, frame)`) and ECHOES probed samples of every
 *     window slot it was fed, so the window offsets, the zero padding of the
 *     final partial window and the reuse of the batch buffer are all
 *     checkable by value;
 *   - the embedder fake asserts the feature dims `[1, T, 80]` AND that every
 *     bin's mean over the fragment's frames is 0 within 1e-5 — the CMN pin
 *     (D2: the measured departure from sherpa-onnx, 4/4 with CMN, 1/4
 *     without) — and returns a vector derived from T so the test can read
 *     back how many fbank frames each fragment produced.
 *
 * Fixtures are off identity values: the job buffer is a ramp (k + 1, exact in
 * float32 up to 2^24), so a window read from the wrong offset, or a fragment
 * copied from the window-local chunk instead of the job buffer, changes what
 * the fakes see.
 */

const {
  createDiarizeHost,
  planWindows,
  buildFragment,
  MAX_TOTAL_SAMPLES,
  SEG_WINDOW,
  SEG_SHIFT,
  SEG_FRAMES,
  SEG_BATCH,
  LOCAL_SPEAKERS,
  NUM_CLASSES,
  POWERSET,
  MIN_EMBED_FRAMES,
  EMBEDDING_DIM,
} = require('./diarizeHost.cjs');
const { FBANK_BINS, FBANK_FRAME_SAMPLES, FBANK_SHIFT_SAMPLES } = require('./whisperFeatures.cjs');

/** Every test runs the GENUINE fbank over every fragment (up to 10 s each);
 * the 33-window batching test feeds 42 s of audio. Under 14 parallel workers
 * the 5 s default was not a safe margin — same reasoning as
 * transcribeHost.test.cjs. */
jest.setTimeout(30000);

const PATHS = { segmentation: '/fake/pyannote-segmentation-3.0.onnx', embedder: '/fake/wespeaker_resnet34_LM.onnx' };

/** The reference's frame → window-sample mapping (`sample_offset`). */
const frameToSample = (k) => Math.trunc((k / SEG_FRAMES) * SEG_WINDOW);

/** Job buffer: a ramp, exact in float32, never the identity of an index. */
function ramp(total) {
  const s = new Float32Array(total);
  for (let k = 0; k < total; k++) s[k] = k + 1;
  return s;
}

/**
 * Fake onnxruntime. `classAt(windowIndex, frame)` → 0..6 is the argmax the
 * segmentation fake plants per frame; `probe` lists offsets within a window
 * slot whose fed values are logged per window (`seg.echo[i][offset]`).
 * `failCreate` makes session creation throw for the named path.
 */
function fakeOrt({ classAt = () => 0, probe = [0, SEG_WINDOW - 1], failCreate = null } = {}) {
  class Tensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  const created = [];
  const ort = {
    Tensor,
    created,
    InferenceSession: {
      create: async (modelPath, opts) => {
        if (failCreate && modelPath === failCreate) throw new Error(`cannot open ${modelPath}`);
        const kind = modelPath === PATHS.segmentation ? 'segmentation' : 'embedder';
        const session = {
          kind,
          modelPath,
          opts,
          released: false,
          runCalls: 0,
          runDims: [],
          buffers: [],
          echo: [],
          frameCounts: [],
          windowsSeen: 0,
          inputNames: kind === 'segmentation' ? ['x'] : ['feats'],
          outputNames: kind === 'segmentation' ? ['y'] : ['embs'],
          release: async () => {
            session.released = true;
          },
          run: async (feeds) => {
            session.runCalls++;
            await new Promise((r) => setImmediate(r)); // yield like real ORT
            if (kind === 'segmentation') {
              const x = feeds.x;
              expect(x.dims).toHaveLength(3);
              expect(x.dims[1]).toBe(1);
              expect(x.dims[2]).toBe(SEG_WINDOW);
              const n = x.dims[0];
              expect(x.data.length).toBe(n * SEG_WINDOW);
              session.runDims.push(x.dims.slice());
              session.buffers.push(x.data.buffer);
              const y = new Float32Array(n * SEG_FRAMES * NUM_CLASSES);
              for (let i = 0; i < n; i++) {
                const echo = {};
                for (const off of probe) echo[off] = x.data[i * SEG_WINDOW + off];
                session.echo.push(echo);
                const index = session.windowsSeen + i;
                for (let f = 0; f < SEG_FRAMES; f++) {
                  const winner = classAt(index, f);
                  for (let c = 0; c < NUM_CLASSES; c++) {
                    // No ties: the winner is well clear, the rest are distinct.
                    y[(i * SEG_FRAMES + f) * NUM_CLASSES + c] = c === winner ? 5 : c * 0.1;
                  }
                }
              }
              session.windowsSeen += n;
              return { y: new Tensor('float32', y, [n, SEG_FRAMES, NUM_CLASSES]) };
            }
            const feats = feeds.feats;
            expect(feats.dims).toHaveLength(3);
            expect(feats.dims[0]).toBe(1);
            expect(feats.dims[2]).toBe(FBANK_BINS);
            const t = feats.dims[1];
            expect(feats.data.length).toBe(t * FBANK_BINS);
            // The CMN pin: every bin's mean over the fragment's frames is 0.
            for (let b = 0; b < FBANK_BINS; b++) {
              let m = 0;
              for (let f = 0; f < t; f++) m += feats.data[f * FBANK_BINS + b];
              expect(Math.abs(m / t)).toBeLessThanOrEqual(1e-5);
            }
            session.frameCounts.push(t);
            const embs = new Float32Array(EMBEDDING_DIM);
            embs.set([t, 1, 2, 3]);
            return { embs: new Tensor('float32', embs, [1, EMBEDDING_DIM]) };
          },
        };
        created.push(session);
        return session;
      },
    },
  };
  return ort;
}

function makeHost(opts = {}) {
  const posted = [];
  const exits = [];
  const ort = fakeOrt(opts);
  const host = createDiarizeHost({ ort, postMessage: (m) => posted.push(m), exit: (code) => exits.push(code) });
  const seg = () => ort.created.find((s) => s.kind === 'segmentation');
  const emb = () => ort.created.find((s) => s.kind === 'embedder');
  return { host, posted, exits, ort, seg, emb };
}

async function initHost(h) {
  await h.host.handleMessage({ type: 'init', paths: PATHS });
  expect(h.posted).toEqual([{ type: 'ready' }]);
  h.posted.length = 0;
}

/** Opens job 1, delivers the whole buffer in one audio message, runs it. */
async function runJob(h, samples, { id = 1 } = {}) {
  await h.host.handleMessage({ type: 'diarize', id, sampleRate: 16000, totalSamples: samples.length });
  await h.host.handleMessage({ type: 'audio', id, offset: 0, samples });
  await h.host.handleMessage({ type: 'run', id });
}

/** Active-frame count of local speaker j in window i under `classAt` — the
 * test's OWN reading of the powerset, so a host that mis-maps classes to
 * speakers (or drops overlap frames) disagrees with it. */
function activeFrames(classAt, i, j) {
  let n = 0;
  for (let f = 0; f < SEG_FRAMES; f++) if (POWERSET[classAt(i, f)].includes(j)) n++;
  return n;
}

/** fbank frame count for a fragment of `n` samples (snip_edges). */
const fbankFrames = (n) => (n < FBANK_FRAME_SAMPLES ? 0 : 1 + Math.floor((n - FBANK_FRAME_SAMPLES) / FBANK_SHIFT_SAMPLES));

describe('constants (D2/D3, the model metadata)', () => {
  test('window / shift / frames / batch / speakers / classes / rule', () => {
    expect(SEG_WINDOW).toBe(160000);
    expect(SEG_SHIFT).toBe(16000);
    expect(SEG_FRAMES).toBe(589);
    expect(SEG_BATCH).toBe(32);
    expect(LOCAL_SPEAKERS).toBe(3);
    expect(NUM_CLASSES).toBe(7);
    expect(POWERSET).toEqual([[], [0], [1], [2], [0, 1], [0, 2], [1, 2]]);
    expect(MIN_EMBED_FRAMES).toBe(10);
    expect(EMBEDDING_DIM).toBe(256);
    expect(MAX_TOTAL_SAMPLES).toBe(16000 * 7200);
  });
});

describe('planWindows (the reference window arithmetic)', () => {
  test('11.5 s → 3 windows, the third padded', () => {
    expect(planWindows(184000)).toEqual({ count: 3, hasLast: true });
  });
  test('25 s → 16 windows, none padded ((len − 160000) is a multiple of 16000)', () => {
    expect(planWindows(400000)).toEqual({ count: 16, hasLast: false });
  });
  test('boundaries: one sample past a clean fit adds a padded window; under one window is one padded window', () => {
    expect(planWindows(400001)).toEqual({ count: 17, hasLast: true });
    expect(planWindows(160000)).toEqual({ count: 1, hasLast: false });
    expect(planWindows(159999)).toEqual({ count: 1, hasLast: true });
    expect(planWindows(1)).toEqual({ count: 1, hasLast: true });
  });
});

describe('buildFragment (the reference sample_offset mapping, from the JOB buffer)', () => {
  /** Labels for one window: class per frame. */
  function labelsFrom(classOf) {
    const l = new Uint8Array(SEG_FRAMES);
    for (let f = 0; f < SEG_FRAMES; f++) l[f] = classOf(f);
    return l;
  }
  const total = 184000;
  const job = ramp(total);
  const scratch = new Float32Array(SEG_WINDOW);

  test('an interior run [100, 300) of window 1 maps to job[16000 + s(100) .. 16000 + s(300))', () => {
    const labels = labelsFrom((f) => (f >= 100 && f < 300 ? 1 : 0));
    const frag = buildFragment(job, total, 1, labels, 0, scratch);
    const ss = frameToSample(100);
    const ee = frameToSample(300);
    expect(frag.activeFrames).toBe(200);
    expect(frag.samples.length).toBe(ee - ss);
    expect(frag.samples[0]).toBe(job[SEG_SHIFT + ss]);
    expect(frag.samples[frag.samples.length - 1]).toBe(job[SEG_SHIFT + ee - 1]);
  });

  test('two runs concatenate in frame order with nothing between them', () => {
    const labels = labelsFrom((f) => (f < 20 || (f >= 400 && f < 430) ? 2 : 0));
    const frag = buildFragment(job, total, 0, labels, 1, scratch);
    const a = frameToSample(20) - frameToSample(0);
    const b = frameToSample(430) - frameToSample(400);
    expect(frag.activeFrames).toBe(50);
    expect(frag.samples.length).toBe(a + b);
    expect(frag.samples[a - 1]).toBe(job[frameToSample(20) - 1]);
    expect(frag.samples[a]).toBe(job[frameToSample(400)]);
  });

  test('a run reaching the last frame ends at frame F−1: 272 samples short of the window end', () => {
    // The reference recipe's tail rule (D1: kept verbatim, the measured
    // fragments): the loop closes a run at `k − 1` when it falls off the end,
    // so the run [a, F) maps to [s(a), s(F−1)) — trunc(588/589 · 160000) =
    // 159728, i.e. 272 samples before 160000 whatever `a` is. (The plan text
    // says 271; that is 160000/589 = 271.6 floored — the per-frame ratio,
    // not the mapped shortfall. The arithmetic is pinned here, not the prose.)
    const a = 579;
    const labels = labelsFrom((f) => (f >= a ? 3 : 0));
    const frag = buildFragment(job, total, 0, labels, 2, scratch);
    expect(frag.activeFrames).toBe(SEG_FRAMES - a);
    expect(frag.samples.length).toBe(frameToSample(SEG_FRAMES - 1) - frameToSample(a));
    expect(frag.samples.length).toBe(2445);
    expect(SEG_WINDOW - frameToSample(SEG_FRAMES - 1)).toBe(272);
    expect(frag.samples[frag.samples.length - 1]).toBe(job[frameToSample(SEG_FRAMES - 1) - 1]);
  });

  test('on the padded last window the fragment carries the reference’s zeros past the content', () => {
    // Window 2 of a 184000-sample job holds job[32000, 184000) = 152000
    // samples then zeros. A run [560, F) maps to [s(560), s(588)) =
    // [152122, 159728) — entirely past the content — so the reference's
    // zero-padded chunk yields only zeros, and so must a fragment rebuilt
    // from the job buffer (D2) rather than from a retained chunk.
    const labels = labelsFrom((f) => (f >= 560 ? 1 : 0));
    const frag = buildFragment(job, total, 2, labels, 0, scratch);
    expect(frameToSample(560)).toBeGreaterThan(total - 2 * SEG_SHIFT);
    expect(frag.samples.length).toBe(frameToSample(SEG_FRAMES - 1) - frameToSample(560));
    expect(frag.samples.every((v) => v === 0)).toBe(true);
    // ...and a run straddling the content edge: real samples then zeros.
    const straddle = labelsFrom((f) => (f >= 550 && f < 570 ? 1 : 0));
    const fr2 = buildFragment(job, total, 2, straddle, 0, scratch);
    const ss = frameToSample(550);
    const contentEnd = total - 2 * SEG_SHIFT; // 152000
    expect(ss).toBeLessThan(contentEnd);
    expect(fr2.samples[0]).toBe(job[2 * SEG_SHIFT + ss]);
    expect(fr2.samples[contentEnd - ss - 1]).toBe(job[total - 1]);
    expect(fr2.samples[contentEnd - ss]).toBe(0);
  });

  test('overlap frames count for BOTH local speakers (the sweep’s recommended set, not P5)', () => {
    const labels = labelsFrom((f) => (f < 12 ? 4 : 0)); // s0 + s1
    const f0 = buildFragment(job, total, 0, labels, 0, scratch);
    const f1 = buildFragment(job, total, 0, labels, 1, scratch);
    const f2 = buildFragment(job, total, 0, labels, 2, scratch);
    expect(f0.activeFrames).toBe(12);
    expect(f1.activeFrames).toBe(12);
    expect(f2.activeFrames).toBe(0);
    expect(f0.samples.length).toBe(frameToSample(12));
  });
});

describe('init', () => {
  test('creates two CPU-EP sessions with graph optimisation and replies ready', async () => {
    const h = makeHost();
    await h.host.handleMessage({ type: 'init', paths: PATHS });
    expect(h.posted).toEqual([{ type: 'ready' }]);
    expect(h.ort.created).toHaveLength(2);
    for (const s of h.ort.created) {
      expect(s.opts).toEqual({ executionProviders: ['cpu'], graphOptimizationLevel: 'all' });
    }
    expect(h.ort.created.map((s) => s.modelPath).sort()).toEqual([PATHS.embedder, PATHS.segmentation].sort());
  });

  test('a missing path field is a protocol error', async () => {
    const h = makeHost();
    await h.host.handleMessage({ type: 'init', paths: { segmentation: PATHS.segmentation } });
    expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
    await h.host.handleMessage({ type: 'init', paths: { segmentation: PATHS.segmentation, embedder: '' } });
    expect(h.posted[1]).toMatchObject({ type: 'error', stage: 'protocol' });
  });

  test('a path the runtime cannot open is an init error, and the host survives', async () => {
    const h = makeHost({ failCreate: PATHS.embedder });
    await h.host.handleMessage({ type: 'init', paths: PATHS });
    expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'init' });
    expect(h.posted[0].message).toMatch(/cannot open/);
    await h.host.handleMessage({ type: 'diarize', id: 1, sampleRate: 16000, totalSamples: 10 });
    expect(h.posted[1]).toMatchObject({ type: 'error', stage: 'protocol' });
  });

  test('double init is refused', async () => {
    const h = makeHost();
    await initHost(h);
    await h.host.handleMessage({ type: 'init', paths: PATHS });
    expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
  });
});

describe('message validation (trust boundary)', () => {
  test('malformed and unknown messages are protocol errors, never throws', async () => {
    const h = makeHost();
    await initHost(h);
    for (const bad of [null, 42, 'x', {}, { type: 7 }, { type: 'nope' }, { type: 'transcribe', id: 1 }]) {
      h.posted.length = 0;
      await h.host.handleMessage(bad);
      expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
    }
  });

  test('diarize before init is refused', async () => {
    const h = makeHost();
    await h.host.handleMessage({ type: 'diarize', id: 1, sampleRate: 16000, totalSamples: 10 });
    expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
  });

  test('id must be an integer', async () => {
    const h = makeHost();
    await initHost(h);
    for (const id of ['1', 1.5, undefined, null]) {
      h.posted.length = 0;
      await h.host.handleMessage({ type: 'diarize', id, sampleRate: 16000, totalSamples: 10 });
      expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
    }
  });

  test('sampleRate must be exactly 16000 (probe below/on/above)', async () => {
    const h = makeHost();
    await initHost(h);
    for (const rate of [15999, 16001, 44100]) {
      h.posted.length = 0;
      await h.host.handleMessage({ type: 'diarize', id: 1, sampleRate: rate, totalSamples: 10 });
      expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol', id: 1 });
    }
    h.posted.length = 0;
    await h.host.handleMessage({ type: 'diarize', id: 1, sampleRate: 16000, totalSamples: 10 });
    expect(h.posted).toEqual([]);
  });

  test('totalSamples bounds (probe 0 / 1 / MAX / MAX+1)', async () => {
    const h = makeHost();
    await initHost(h);
    for (const total of [0, -1, 1.5, MAX_TOTAL_SAMPLES + 1]) {
      h.posted.length = 0;
      await h.host.handleMessage({ type: 'diarize', id: 1, sampleRate: 16000, totalSamples: total });
      expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
    }
    h.posted.length = 0;
    await h.host.handleMessage({ type: 'diarize', id: 1, sampleRate: 16000, totalSamples: 1 });
    expect(h.posted).toEqual([]);
    await h.host.handleMessage({ type: 'cancel', id: 1 });
    h.posted.length = 0;
    await h.host.handleMessage({ type: 'diarize', id: 2, sampleRate: 16000, totalSamples: MAX_TOTAL_SAMPLES });
    expect(h.posted).toEqual([]);
  });

  test('audio payload and range validation (probe the range boundaries)', async () => {
    const h = makeHost();
    await initHost(h);
    await h.host.handleMessage({ type: 'diarize', id: 1, sampleRate: 16000, totalSamples: 100 });
    const cases = [
      { id: 2, offset: 0, samples: new Float32Array(10) }, // wrong job
      { id: 1, offset: 0, samples: [1, 2, 3] }, // not a Float32Array
      { id: 1, offset: 0, samples: new Float64Array(10) }, // wrong element type
      { id: 1, offset: 0, samples: new Float32Array(0) }, // empty
      { id: 1, offset: -1, samples: new Float32Array(10) }, // below range
      { id: 1, offset: 91, samples: new Float32Array(10) }, // end 101 > 100
      { id: 1, offset: 0.5, samples: new Float32Array(10) }, // non-integer
    ];
    for (const c of cases) {
      h.posted.length = 0;
      await h.host.handleMessage({ type: 'audio', ...c });
      expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
    }
    h.posted.length = 0;
    await h.host.handleMessage({ type: 'audio', id: 1, offset: 90, samples: new Float32Array(10) }); // end == total
    expect(h.posted).toEqual([]);
  });

  test('run with incomplete coverage is refused; duplicates do not count', async () => {
    const h = makeHost();
    await initHost(h);
    await h.host.handleMessage({ type: 'diarize', id: 1, sampleRate: 16000, totalSamples: 100 });
    await h.host.handleMessage({ type: 'audio', id: 1, offset: 0, samples: new Float32Array(50) });
    await h.host.handleMessage({ type: 'audio', id: 1, offset: 0, samples: new Float32Array(50) });
    h.posted.length = 0;
    await h.host.handleMessage({ type: 'run', id: 1 });
    expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol', id: 1 });
    expect(h.posted[0].message).toMatch(/50 of 100/);
    expect(h.seg().runCalls).toBe(0);
  });

  test('run for an unknown id is refused', async () => {
    const h = makeHost();
    await initHost(h);
    await h.host.handleMessage({ type: 'run', id: 7 });
    expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
  });

  test('a second diarize while a job is loaded is refused (single-job host)', async () => {
    const h = makeHost();
    await initHost(h);
    await h.host.handleMessage({ type: 'diarize', id: 1, sampleRate: 16000, totalSamples: 10 });
    await h.host.handleMessage({ type: 'diarize', id: 2, sampleRate: 16000, totalSamples: 10 });
    expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol', id: 2 });
  });
});

describe('segmentation run', () => {
  const pattern = (i, f) => (i + f) % NUM_CLASSES;

  test('(a) 11.5 s: windows at 0 and 16000 full, the third from 32000 zero-padded; done {windowCount: 3}', async () => {
    const total = 184000;
    const content3 = total - 2 * SEG_SHIFT; // 152000
    const h = makeHost({ classAt: pattern, probe: [0, content3 - 1, content3, SEG_WINDOW - 1] });
    await initHost(h);
    const job = ramp(total);
    await runJob(h, job);

    const seg = h.seg();
    expect(seg.runDims).toEqual([[3, 1, SEG_WINDOW]]);
    // Echoed first samples: the window at i starts at job[i · 16000].
    for (let i = 0; i < 3; i++) expect(seg.echo[i][0]).toBe(job[i * SEG_SHIFT]);
    // Full windows end on real samples...
    expect(seg.echo[0][SEG_WINDOW - 1]).toBe(job[SEG_WINDOW - 1]);
    expect(seg.echo[1][SEG_WINDOW - 1]).toBe(job[SEG_SHIFT + SEG_WINDOW - 1]);
    // ...the third holds job[32000, 184000) then zeros: pinned at the edge and one step past.
    expect(seg.echo[2][content3 - 1]).toBe(job[total - 1]);
    expect(seg.echo[2][content3]).toBe(0);
    expect(seg.echo[2][SEG_WINDOW - 1]).toBe(0);

    const windows = h.posted.filter((m) => m.type === 'window');
    expect(windows.map((w) => w.index)).toEqual([0, 1, 2]);
    for (const w of windows) {
      expect(w.id).toBe(1);
      expect(Object.prototype.toString.call(w.labels)).toBe('[object Uint8Array]');
      expect(w.labels).toHaveLength(SEG_FRAMES);
      for (let f = 0; f < SEG_FRAMES; f++) expect(w.labels[f]).toBe(pattern(w.index, f));
    }
    expect(h.posted[h.posted.length - 1]).toEqual({ type: 'done', id: 1, windowCount: 3 });
  });

  test('(b) 25 s: 16 windows, none padded, windowCount 16', async () => {
    const total = 400000;
    const h = makeHost({ classAt: pattern });
    await initHost(h);
    const job = ramp(total);
    await runJob(h, job);
    const seg = h.seg();
    expect(seg.runDims).toEqual([[16, 1, SEG_WINDOW]]);
    for (let i = 0; i < 16; i++) {
      expect(seg.echo[i][0]).toBe(job[i * SEG_SHIFT]);
      expect(seg.echo[i][SEG_WINDOW - 1]).toBe(job[i * SEG_SHIFT + SEG_WINDOW - 1]); // no zero anywhere
    }
    expect(h.posted.filter((m) => m.type === 'window')).toHaveLength(16);
    expect(h.posted[h.posted.length - 1]).toEqual({ type: 'done', id: 1, windowCount: 16 });
  });

  test('33 windows run as a batch of 32 then 1, through ONE reused batch buffer, offsets intact', async () => {
    const total = SEG_WINDOW + 32 * SEG_SHIFT; // 672000: exactly 33 full windows
    expect(planWindows(total)).toEqual({ count: 33, hasLast: false });
    const h = makeHost(); // class 0 everywhere: no fragments, so this is about batching alone
    await initHost(h);
    const job = ramp(total);
    await runJob(h, job);
    const seg = h.seg();
    expect(seg.runDims).toEqual([[SEG_BATCH, 1, SEG_WINDOW], [1, 1, SEG_WINDOW]]);
    expect(seg.buffers[1]).toBe(seg.buffers[0]); // the batch tensor is not reallocated per batch
    expect(seg.buffers[0].byteLength).toBe(SEG_BATCH * SEG_WINDOW * 4); // 20.5 MB, the D2 arithmetic
    expect(seg.echo[32][0]).toBe(job[32 * SEG_SHIFT]);
    expect(seg.echo[31][0]).toBe(job[31 * SEG_SHIFT]);
    expect(h.posted.filter((m) => m.type === 'window').map((w) => w.index)).toEqual([...Array(33).keys()]);
    expect(h.posted.filter((m) => m.type === 'embedding')).toHaveLength(0);
    expect(h.posted[h.posted.length - 1]).toEqual({ type: 'done', id: 1, windowCount: 33 });
  });

  test('a segmentation output with the wrong shape is a run error, not a silent misread', async () => {
    const h = makeHost();
    await initHost(h);
    const seg = h.seg();
    const realRun = seg.run;
    seg.run = async (feeds) => {
      const out = await realRun(feeds);
      out.y.dims = [out.y.dims[0], 588, NUM_CLASSES];
      return out;
    };
    await runJob(h, ramp(SEG_WINDOW));
    const err = h.posted.find((m) => m.type === 'error');
    expect(err).toMatchObject({ stage: 'run', id: 1 });
    expect(err.message).toMatch(/589/);
  });
});

describe('embedding pass', () => {
  test('(c) exactly the ≥ 10-frame embeddings, overlap counted, the F−1 tail measured in fbank frames', async () => {
    // Window 0: frames 0..8 are s0+s1 (class 4), frame 9 is s0 alone (class 1):
    //   s0 → 10 frames (ON the rule)  s1 → 9 frames (one under)  s2 → 0.
    //   With overlap frames excluded s0 would have 1 frame and nothing embeds.
    // Window 1: s2 alone (class 3) from frame 579 to the end: 10 frames, a
    //   run that reaches F, so its audio is [s(579), s(588)) = 2445 samples
    //   → 13 fbank frames. Had the run closed at F (the un-truncated
    //   mapping) it would be 2717 samples → 15 frames. T tells them apart.
    // Window 2: silent.
    const classAt = (i, f) => {
      if (i === 0) return f < 9 ? 4 : f === 9 ? 1 : 0;
      if (i === 1) return f >= 579 ? 3 : 0;
      return 0;
    };
    const h = makeHost({ classAt });
    await initHost(h);
    await runJob(h, ramp(184000));

    const embs = h.posted.filter((m) => m.type === 'embedding');
    expect(embs.map((e) => [e.windowIndex, e.localSpeaker, e.activeFrames])).toEqual([
      [0, 0, 10],
      [1, 2, 10],
    ]);
    expect(activeFrames(classAt, 0, 0)).toBe(MIN_EMBED_FRAMES);
    expect(activeFrames(classAt, 0, 1)).toBe(MIN_EMBED_FRAMES - 1);
    for (const e of embs) {
      expect(e.id).toBe(1);
      expect(Object.prototype.toString.call(e.vector)).toBe('[object Float32Array]');
      expect(e.vector).toHaveLength(EMBEDDING_DIM);
      let norm = 0;
      for (const v of e.vector) norm += v * v;
      expect(Math.sqrt(norm)).toBeCloseTo(1, 6);
    }
    const emb = h.emb();
    expect(emb.frameCounts).toEqual([
      fbankFrames(frameToSample(10) - frameToSample(0)),
      fbankFrames(frameToSample(SEG_FRAMES - 1) - frameToSample(579)),
    ]);
    expect(emb.frameCounts[1]).toBe(13);
    expect(fbankFrames(SEG_WINDOW - frameToSample(579))).toBe(15); // what the un-truncated tail would give
    // The fake's vector encodes T at [0]/[1]; L2 normalisation must keep the ratio.
    expect(Math.round(embs[1].vector[0] / embs[1].vector[1])).toBe(13);
  });

  test('every (window, local speaker) with ≥ 10 frames embeds, in window order then speaker order', async () => {
    const pattern = (i, f) => (i + f) % NUM_CLASSES;
    const h = makeHost({ classAt: pattern });
    await initHost(h);
    await runJob(h, ramp(184000));
    const embs = h.posted.filter((m) => m.type === 'embedding');
    const expected = [];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < LOCAL_SPEAKERS; j++) {
        const n = activeFrames(pattern, i, j);
        if (n >= MIN_EMBED_FRAMES) expected.push([i, j, n]);
      }
    }
    expect(expected).toHaveLength(9); // the pattern keeps every local speaker busy
    expect(embs.map((e) => [e.windowIndex, e.localSpeaker, e.activeFrames])).toEqual(expected);
  });

  test('a fragment is fed as [1, T, 80] with per-bin zero mean (the fake asserts it; this pins that it ran)', async () => {
    const h = makeHost({ classAt: (i, f) => (i === 0 && f < 200 ? 2 : 0) });
    await initHost(h);
    // A non-trivial signal, so the fbank is not a constant row (where CMN
    // would be trivially zero): a 440 Hz tone with a slow envelope.
    const total = 184000;
    const job = new Float32Array(total);
    for (let k = 0; k < total; k++) job[k] = Math.sin((2 * Math.PI * 440 * k) / 16000) * (0.3 + 0.2 * Math.sin(k / 9000));
    await runJob(h, job);
    expect(h.emb().runCalls).toBe(1);
    expect(h.emb().frameCounts).toEqual([fbankFrames(frameToSample(200))]);
  });

  test('a wrong embedding size is a run error', async () => {
    const h = makeHost({ classAt: (i, f) => (f < 50 ? 1 : 0) });
    await initHost(h);
    const emb = h.emb();
    emb.run = async () => ({ embs: { data: new Float32Array(512), dims: [1, 512] } });
    await runJob(h, ramp(SEG_WINDOW));
    const err = h.posted.find((m) => m.type === 'error');
    expect(err).toMatchObject({ stage: 'run', id: 1 });
    expect(err.message).toMatch(/256/);
  });
});

describe('progress, cancel, failure, shutdown', () => {
  test('(d) progress is monotone per stage and lands on total for both stages', async () => {
    const h = makeHost({ classAt: (i, f) => (i + f) % NUM_CLASSES });
    await initHost(h);
    await runJob(h, ramp(SEG_WINDOW + 32 * SEG_SHIFT)); // two batches, 99 fragments
    const prog = h.posted.filter((m) => m.type === 'progress');
    for (const stage of ['segment', 'embed']) {
      const p = prog.filter((m) => m.stage === stage);
      expect(p.length).toBeGreaterThan(0);
      for (let k = 1; k < p.length; k++) expect(p[k].done).toBeGreaterThan(p[k - 1].done);
      for (const m of p) {
        expect(m.id).toBe(1);
        expect(m.done).toBeLessThanOrEqual(m.total);
      }
      expect(p[p.length - 1].done).toBe(p[p.length - 1].total);
    }
    expect(prog.filter((m) => m.stage === 'segment')[0].total).toBe(33);
    expect(prog.filter((m) => m.stage === 'embed')[0].total).toBe(99);
    // segment progress precedes embed progress
    const firstEmbed = prog.findIndex((m) => m.stage === 'embed');
    expect(prog.slice(0, firstEmbed).every((m) => m.stage === 'segment')).toBe(true);
  });

  test('cancel between batches: cancelled, then silence; the second batch and the embeddings never run', async () => {
    const h = makeHost({ classAt: (i, f) => (i + f) % NUM_CLASSES });
    await initHost(h);
    const total = SEG_WINDOW + 32 * SEG_SHIFT;
    await h.host.handleMessage({ type: 'diarize', id: 1, sampleRate: 16000, totalSamples: total });
    await h.host.handleMessage({ type: 'audio', id: 1, offset: 0, samples: ramp(total) });
    const runPromise = h.host.handleMessage({ type: 'run', id: 1 });
    await h.host.handleMessage({ type: 'cancel', id: 1 });
    await runPromise;
    const types = h.posted.map((m) => m.type);
    expect(types).toContain('cancelled');
    expect(types).not.toContain('done');
    expect(types.indexOf('cancelled')).toBe(types.length - 1);
    expect(h.seg().runCalls).toBe(1);
    expect(h.emb().runCalls).toBe(0);
    // the host is free again
    h.posted.length = 0;
    await h.host.handleMessage({ type: 'diarize', id: 2, sampleRate: 16000, totalSamples: 10 });
    expect(h.posted).toEqual([]);
  });

  test('cancel between embeddings: at most one embedding, then cancelled, then silence', async () => {
    const h = makeHost({ classAt: (i, f) => (i + f) % NUM_CLASSES });
    await initHost(h);
    const total = 184000;
    await h.host.handleMessage({ type: 'diarize', id: 1, sampleRate: 16000, totalSamples: total });
    await h.host.handleMessage({ type: 'audio', id: 1, offset: 0, samples: ramp(total) });
    const emb = h.emb();
    const realRun = emb.run;
    let cancelPromise = null;
    emb.run = async (feeds) => {
      // Cancel arrives while the first embedding is inside the runtime.
      if (!cancelPromise) cancelPromise = h.host.handleMessage({ type: 'cancel', id: 1 });
      return realRun(feeds);
    };
    await h.host.handleMessage({ type: 'run', id: 1 });
    await cancelPromise;
    const types = h.posted.map((m) => m.type);
    expect(emb.runCalls).toBe(1);
    expect(types.filter((t) => t === 'embedding').length).toBeLessThanOrEqual(1);
    expect(types[types.length - 1]).toBe('cancelled');
    expect(types).not.toContain('done');
  });

  test('cancel before run drops the pending job; cancel for an unknown id answers cancelled', async () => {
    const h = makeHost();
    await initHost(h);
    await h.host.handleMessage({ type: 'diarize', id: 1, sampleRate: 16000, totalSamples: 10 });
    await h.host.handleMessage({ type: 'cancel', id: 1 });
    expect(h.posted[0]).toEqual({ type: 'cancelled', id: 1 });
    h.posted.length = 0;
    await h.host.handleMessage({ type: 'cancel', id: 9 });
    expect(h.posted[0]).toEqual({ type: 'cancelled', id: 9 });
    h.posted.length = 0;
    await h.host.handleMessage({ type: 'diarize', id: 2, sampleRate: 16000, totalSamples: 10 });
    expect(h.posted).toEqual([]);
  });

  test('inference failure posts a run error with the job id and frees the host', async () => {
    const h = makeHost();
    await initHost(h);
    h.seg().run = async () => {
      throw new Error('onnx exploded');
    };
    await runJob(h, ramp(SEG_WINDOW));
    const err = h.posted.find((m) => m.type === 'error');
    expect(err).toMatchObject({ stage: 'run', id: 1 });
    expect(err.message).toMatch(/onnx exploded/);
    h.posted.length = 0;
    await h.host.handleMessage({ type: 'diarize', id: 2, sampleRate: 16000, totalSamples: 10 });
    expect(h.posted).toEqual([]);
  });

  test('shutdown releases every session and exits 0; before init it still exits cleanly', async () => {
    const h = makeHost();
    await initHost(h);
    await h.host.handleMessage({ type: 'shutdown' });
    expect(h.exits).toEqual([0]);
    for (const s of h.ort.created) expect(s.released).toBe(true);
    const cold = makeHost();
    await cold.host.handleMessage({ type: 'shutdown' });
    expect(cold.exits).toEqual([0]);
  });
});
