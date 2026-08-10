'use strict';

/**
 * voiceHost.cjs — protocol discipline and the F3 wiring pins, driven with a
 * fake ORT (the stemHost.test.cjs pattern: the REAL message loop, injected
 * inference).
 *
 * The load-bearing pins, each of which fails if its wiring is removed:
 *  - tau === 0.3 (float32) on EVERY converter call — the spike's round-2
 *    requirement is fed to the graph, not just declared.
 *  - src_tone is the MEAN of the per-chunk extractor outputs (whole-loop
 *    accumulation, probed with distinct per-call markers — a loop pinned only
 *    on its first element pins the loop's existence, not its extent).
 *  - dest_tone is the caller's target vector, verbatim, on the first AND the
 *    last converter call.
 *  - chunked output equals the unchunked output of the same fake pipeline
 *    BIT-EXACTLY outside the seams, and equals the analytic constant-power
 *    sum inside them (the chunking-equivalence pin, derived below).
 *  - no model run ever sees more than a SEGMENT's worth of frames (the
 *    RSS-boundedness proxy: the spike's linear-RSS finding means bounded
 *    frames-per-run IS bounded inference memory).
 */

const {
  SEGMENT_SAMPLES,
  OVERLAP_SAMPLES,
  STRIDE_SAMPLES,
  CROSSFADE_SAMPLES,
  HOP_LENGTH,
  SPEC_BINS,
  MIN_INPUT_SAMPLES,
  spectrogram,
  planVoiceSegments,
  crossfadeStart,
  framesForSamples,
} = require('./voiceChunking.cjs');
const {
  createVoiceHost,
  TAU,
  TONE_EMBEDDING_SIZE,
  MAX_TOTAL_SAMPLES,
  MAX_REFERENCE_SAMPLES,
} = require('./voiceHost.cjs');

// Several tests here drive the REAL chunk loop over a >30 s signal, which
// means three real 661k-sample spectrograms (2,584 frames of 1024-point FFT
// each) per run. That is seconds of genuine CPU, and under a full
// `--maxWorkers=100%` suite it exceeds Jest's 5 s default — observed as the
// cancel test timing out in the full gate while passing when the file runs
// alone. The work is the point (a fake that skipped the spectrogram would not
// exercise the loop), so the timeout is raised rather than the fixture shrunk.
jest.setTimeout(60 * 1000);

const EXTRACTOR_PATH = '/models/voice/tone_extract.onnx';
const CONVERTER_PATH = '/models/voice/tone_color.onnx';

/**
 * Fake ORT. Two extractor modes:
 *   'constant' — every call returns the same embedding (so chunked and
 *                unchunked source tones agree exactly; used for equivalence)
 *   'marker'   — emb[0]=frames, emb[2]=1-based call index (used to pin the
 *                mean accumulation across the WHOLE chunk loop)
 * The fake converter is LOCAL (out[t] = bin-0 magnitude of t's frame, scaled,
 * plus an embedding-derived offset), which is what makes exact-except-at-
 * boundaries equivalence provable.
 */
function createFakeOrt({ extractMode = 'constant', convertHook, extractResult, convertResult, failCreate } = {}) {
  const calls = { created: [], extract: [], convert: [], released: [] };
  class Tensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  const constantEmb = new Float32Array(TONE_EMBEDDING_SIZE);
  constantEmb[0] = 0.25;
  constantEmb[1] = -0.5;
  const ort = {
    Tensor,
    InferenceSession: {
      create: async (path, opts) => {
        calls.created.push({ path, opts });
        if (failCreate) throw new Error(`create failed: ${path}`);
        if (path === EXTRACTOR_PATH) {
          return {
            inputNames: ['input'],
            outputNames: ['tone_embedding'],
            release: async () => calls.released.push('extractor'),
            run: async (feeds) => {
              const t = feeds.input;
              calls.extract.push({ dims: t.dims.slice() });
              if (extractResult) return extractResult(calls.extract.length);
              if (extractMode === 'constant') {
                return { tone_embedding: { data: Float32Array.from(constantEmb) } };
              }
              const emb = new Float32Array(TONE_EMBEDDING_SIZE);
              emb[0] = t.dims[1]; // frames
              emb[2] = calls.extract.length; // 1-based call index
              return { tone_embedding: { data: emb } };
            },
          };
        }
        return {
          inputNames: ['audio', 'audio_length', 'src_tone', 'dest_tone', 'tau'],
          outputNames: ['converted_audio'],
          release: async () => calls.released.push('converter'),
          run: async (feeds) => {
            const call = {
              dims: feeds.audio.dims.slice(),
              audioLength: Number(feeds.audio_length.data[0]),
              srcTone: Float32Array.from(feeds.src_tone.data),
              srcDims: feeds.src_tone.dims.slice(),
              destTone: Float32Array.from(feeds.dest_tone.data),
              destDims: feeds.dest_tone.dims.slice(),
              tau: feeds.tau.data[0],
            };
            calls.convert.push(call);
            if (convertHook) await convertHook(calls.convert.length);
            if (convertResult) return convertResult(call, calls.convert.length);
            const frames = feeds.audio.dims[2];
            const spec = feeds.audio.data; // bin-major: bin 0 occupies [0, frames)
            const offset = (feeds.dest_tone.data[0] - feeds.src_tone.data[0]) * 0.5;
            const out = new Float32Array(frames * HOP_LENGTH);
            for (let t = 0; t < out.length; t++) {
              out[t] = spec[Math.floor(t / HOP_LENGTH)] * 0.001 + offset;
            }
            return { converted_audio: { data: out } };
          },
        };
      },
    },
  };
  return { ort, calls, constantEmb };
}

function createHarness(fakeOpts) {
  const fake = createFakeOrt(fakeOpts);
  const posted = [];
  let exitCode = null;
  const host = createVoiceHost({
    ort: fake.ort,
    postMessage: (msg) => posted.push(msg),
    exit: (code) => {
      exitCode = code;
    },
  });
  return {
    host,
    posted,
    calls: fake.calls,
    constantEmb: fake.constantEmb,
    getExitCode: () => exitCode,
    of: (type) => posted.filter((m) => m.type === type),
    last: () => posted[posted.length - 1],
  };
}

async function initHost(h) {
  await h.host.handleMessage({ type: 'init', paths: { extractor: EXTRACTOR_PATH, converter: CONVERTER_PATH } });
  expect(h.of('ready')).toHaveLength(1);
}

async function deliverAudio(h, id, samples, sliceLen = 500000) {
  for (let off = 0; off < samples.length; off += sliceLen) {
    await h.host.handleMessage({
      type: 'audio',
      id,
      offset: off,
      samples: samples.slice(off, Math.min(off + sliceLen, samples.length)),
    });
  }
}

function makeSignal(n) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] =
      0.4 * Math.sin((2 * Math.PI * 220 * i) / 22050) +
      0.2 * Math.sin((2 * Math.PI * 953 * i) / 22050) +
      0.1 * Math.sin(i / 997);
  }
  return x;
}

function makeTarget() {
  const tv = new Float32Array(TONE_EMBEDDING_SIZE);
  for (let i = 0; i < tv.length; i++) tv[i] = (i - 100) / 1000;
  return tv;
}

describe('init', () => {
  test('bad paths are protocol errors; double init refused; create failure is an init error', async () => {
    const h = createHarness();
    await h.host.handleMessage({ type: 'init' });
    await h.host.handleMessage({ type: 'init', paths: { extractor: EXTRACTOR_PATH } });
    await h.host.handleMessage({ type: 'init', paths: { extractor: '', converter: CONVERTER_PATH } });
    expect(h.of('error')).toHaveLength(3);
    expect(h.of('error').every((e) => e.stage === 'protocol')).toBe(true);

    await initHost(h);
    await h.host.handleMessage({ type: 'init', paths: { extractor: EXTRACTOR_PATH, converter: CONVERTER_PATH } });
    expect(h.last().message).toMatch(/already created/);

    const failing = createHarness({ failCreate: true });
    await failing.host.handleMessage({
      type: 'init',
      paths: { extractor: EXTRACTOR_PATH, converter: CONVERTER_PATH },
    });
    expect(failing.of('error')[0].stage).toBe('init');
  });

  test('sessions are created CPU-EP-only with full graph optimisation', async () => {
    const h = createHarness();
    await initHost(h);
    expect(h.calls.created).toHaveLength(2);
    for (const c of h.calls.created) {
      expect(c.opts).toEqual({ executionProviders: ['cpu'], graphOptimizationLevel: 'all' });
    }
  });
});

describe('job-opening trust boundaries — below/on/above every cap', () => {
  test('embed: 384 refused, 385 accepted, MAX_REFERENCE accepted, MAX_REFERENCE+1 refused', async () => {
    const h = createHarness();
    await initHost(h);
    await h.host.handleMessage({ type: 'embed', id: 1, totalSamples: MIN_INPUT_SAMPLES - 1 });
    expect(h.last().type).toBe('error');
    await h.host.handleMessage({ type: 'embed', id: 1, totalSamples: MIN_INPUT_SAMPLES });
    await h.host.handleMessage({ type: 'cancel', id: 1 }); // drop the open job
    await h.host.handleMessage({ type: 'embed', id: 2, totalSamples: MAX_REFERENCE_SAMPLES });
    await h.host.handleMessage({ type: 'cancel', id: 2 });
    await h.host.handleMessage({ type: 'embed', id: 3, totalSamples: MAX_REFERENCE_SAMPLES + 1 });
    expect(h.last().type).toBe('error');
    expect(h.last().message).toMatch(/350 s/);
  });

  test('convert: 384 refused, 385 accepted, MAX_TOTAL accepted, MAX_TOTAL+1 refused', async () => {
    const h = createHarness();
    await initHost(h);
    const tv = makeTarget();
    await h.host.handleMessage({ type: 'convert', id: 1, totalSamples: MIN_INPUT_SAMPLES - 1, targetVector: tv });
    expect(h.last().type).toBe('error');
    await h.host.handleMessage({ type: 'convert', id: 1, totalSamples: MIN_INPUT_SAMPLES, targetVector: tv });
    await h.host.handleMessage({ type: 'cancel', id: 1 });
    await h.host.handleMessage({ type: 'convert', id: 2, totalSamples: MAX_TOTAL_SAMPLES, targetVector: tv });
    await h.host.handleMessage({ type: 'cancel', id: 2 });
    await h.host.handleMessage({ type: 'convert', id: 3, totalSamples: MAX_TOTAL_SAMPLES + 1, targetVector: tv });
    expect(h.last().type).toBe('error');
    expect(h.last().message).toMatch(/30 minutes/);
  });

  test('convert: targetVector length 255/257, non-Float32Array, and non-finite components refused; 256 finite accepted', async () => {
    const h = createHarness();
    await initHost(h);
    for (const bad of [
      new Float32Array(TONE_EMBEDDING_SIZE - 1),
      new Float32Array(TONE_EMBEDDING_SIZE + 1),
      Array.from(new Float32Array(TONE_EMBEDDING_SIZE)),
    ]) {
      await h.host.handleMessage({ type: 'convert', id: 9, totalSamples: 1000, targetVector: bad });
      expect(h.last().type).toBe('error');
    }
    const nanFirst = makeTarget();
    nanFirst[0] = Number.NaN;
    await h.host.handleMessage({ type: 'convert', id: 9, totalSamples: 1000, targetVector: nanFirst });
    expect(h.last().message).toMatch(/component 0/);
    const infLast = makeTarget();
    infLast[TONE_EMBEDDING_SIZE - 1] = Infinity;
    await h.host.handleMessage({ type: 'convert', id: 9, totalSamples: 1000, targetVector: infLast });
    expect(h.last().message).toMatch(/component 255/);
    const errorsBefore = h.of('error').length;
    await h.host.handleMessage({ type: 'convert', id: 9, totalSamples: 1000, targetVector: makeTarget() });
    // A successful open posts nothing — the pin is that no NEW error appeared
    // and the job slot is genuinely taken.
    expect(h.of('error')).toHaveLength(errorsBefore);
    await h.host.handleMessage({ type: 'convert', id: 10, totalSamples: 1000, targetVector: makeTarget() });
    expect(h.last().message).toMatch(/already active/);
  });

  test('embed/convert before init and second job while one is open are refused', async () => {
    const h = createHarness();
    await h.host.handleMessage({ type: 'embed', id: 1, totalSamples: 1000 });
    expect(h.last().message).toMatch(/not initialised/);
    await initHost(h);
    await h.host.handleMessage({ type: 'embed', id: 1, totalSamples: 1000 });
    await h.host.handleMessage({ type: 'convert', id: 2, totalSamples: 1000, targetVector: makeTarget() });
    expect(h.last().message).toMatch(/already active/);
  });
});

describe('audio delivery and the coverage gate', () => {
  test('duplicated ranges do not count toward completeness', async () => {
    const h = createHarness();
    await initHost(h);
    await h.host.handleMessage({ type: 'embed', id: 1, totalSamples: 600 });
    await h.host.handleMessage({ type: 'audio', id: 1, offset: 0, samples: new Float32Array(300) });
    await h.host.handleMessage({ type: 'audio', id: 1, offset: 0, samples: new Float32Array(300) });
    await h.host.handleMessage({ type: 'run', id: 1 });
    expect(h.last().type).toBe('error');
    expect(h.last().message).toMatch(/only 300 of 600/);
  });

  test('out-of-range and malformed audio are refused; overlapping delivery merges into full coverage', async () => {
    const h = createHarness();
    await initHost(h);
    await h.host.handleMessage({ type: 'embed', id: 1, totalSamples: 600 });
    await h.host.handleMessage({ type: 'audio', id: 1, offset: 301, samples: new Float32Array(300) });
    expect(h.last().message).toMatch(/outside job length/);
    await h.host.handleMessage({ type: 'audio', id: 1, offset: 0, samples: [] });
    expect(h.last().message).toMatch(/non-empty Float32Array/);
    await h.host.handleMessage({ type: 'audio', id: 7, offset: 0, samples: new Float32Array(10) });
    expect(h.last().message).toMatch(/no active job with id 7/);

    await h.host.handleMessage({ type: 'audio', id: 1, offset: 0, samples: new Float32Array(400) });
    await h.host.handleMessage({ type: 'audio', id: 1, offset: 350, samples: new Float32Array(250) });
    await h.host.handleMessage({ type: 'run', id: 1 });
    expect(h.of('embedded')).toHaveLength(1);
  });
});

describe('embed jobs — whole-utterance reference embedding', () => {
  test('one extractor call over the WHOLE clip, progress 1/1, embedded vector delivered', async () => {
    const h = createHarness({ extractMode: 'marker' });
    await initHost(h);
    const n = 12800; // 50 frames exactly
    await h.host.handleMessage({ type: 'embed', id: 4, totalSamples: n });
    await deliverAudio(h, 4, makeSignal(n));
    await h.host.handleMessage({ type: 'run', id: 4 });

    expect(h.calls.extract).toHaveLength(1);
    expect(h.calls.extract[0].dims).toEqual([1, framesForSamples(n), SPEC_BINS]);
    expect(h.of('progress')).toEqual([{ type: 'progress', id: 4, stage: 'embed', done: 1, total: 1 }]);
    const embedded = h.of('embedded');
    expect(embedded).toHaveLength(1);
    expect(embedded[0].vector.length).toBe(TONE_EMBEDDING_SIZE);
    expect(embedded[0].vector[0]).toBe(framesForSamples(n)); // the marker round-tripped
    // Terminal: the job slot is free again.
    await h.host.handleMessage({ type: 'embed', id: 5, totalSamples: 1000 });
    expect(h.last().type).not.toBe('error');
  });

  test('an extractor returning the wrong width or a non-finite component is a run error', async () => {
    const short = createHarness({
      extractResult: () => ({ tone_embedding: { data: new Float32Array(TONE_EMBEDDING_SIZE - 1) } }),
    });
    await initHost(short);
    await short.host.handleMessage({ type: 'embed', id: 1, totalSamples: 1000 });
    await deliverAudio(short, 1, makeSignal(1000));
    await short.host.handleMessage({ type: 'run', id: 1 });
    expect(short.last()).toMatchObject({ type: 'error', stage: 'run', id: 1 });
    expect(short.last().message).toMatch(/255 values/);

    const bad = new Float32Array(TONE_EMBEDDING_SIZE);
    bad[7] = Number.NaN;
    const nan = createHarness({ extractResult: () => ({ tone_embedding: { data: bad } }) });
    await initHost(nan);
    await nan.host.handleMessage({ type: 'embed', id: 1, totalSamples: 1000 });
    await deliverAudio(nan, 1, makeSignal(1000));
    await nan.host.handleMessage({ type: 'run', id: 1 });
    expect(nan.last().message).toMatch(/non-finite embedding component at index 7/);
  });
});

describe('convert jobs — the chunk loop and its pins', () => {
  // >30 s: 3 chunks (two full segments + a 51,200-sample tail, HOP-aligned).
  const N = 2 * STRIDE_SAMPLES + 51200;

  /** The constant-power pair, restated here rather than imported. */
  const fadeIn = (k) => Math.sin((Math.PI / 2) * ((k + 0.5) / CROSSFADE_SAMPLES));
  const fadeOut = (k) => Math.cos((Math.PI / 2) * ((k + 0.5) / CROSSFADE_SAMPLES));

  test('single-chunk conversion: output equals the fake pipeline BIT-EXACTLY, sample 0 included', async () => {
    const h = createHarness();
    await initHost(h);
    const n = 2048;
    const x = makeSignal(n);
    const tv = makeTarget();
    await h.host.handleMessage({ type: 'convert', id: 1, totalSamples: n, targetVector: tv });
    await deliverAudio(h, 1, x);
    await h.host.handleMessage({ type: 'run', id: 1 });

    expect(h.calls.convert).toHaveLength(1);
    const done = h.of('done');
    expect(done).toEqual([{ type: 'done', id: 1, chunkCount: 1, sanitisedSamples: 0 }]);

    const chunks = h.of('chunk');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].offset).toBe(0);
    expect(chunks[0].samples).toBe(n);

    const { spec } = spectrogram(x); // n is a HOP multiple — no padding
    const offset = (tv[0] - h.constantEmb[0]) * 0.5;
    // A single-chunk plan carries weight 1 everywhere — no window, no
    // normalisation — so the model's samples are copied through unchanged.
    // Sample 0 included: the old overlap-add's zero-weight first sample is
    // gone by construction, so it is probed here rather than excused.
    for (const t of [0, 1, 500, 1024, n - 2, n - 1]) {
      const expected = Math.fround(spec[Math.floor(t / HOP_LENGTH)] * 0.001 + offset);
      expect(chunks[0].data[t]).toBe(expected);
    }
  });

  test('THE CHUNKING PIN: a >30 s input matches an unchunked run of the same fake pipeline', async () => {
    const h = createHarness();
    await initHost(h);
    const x = makeSignal(N);
    const tv = makeTarget();
    await h.host.handleMessage({ type: 'convert', id: 2, totalSamples: N, targetVector: tv });
    await deliverAudio(h, 2, x);
    await h.host.handleMessage({ type: 'run', id: 2 });
    expect(h.of('done')).toHaveLength(1);

    // Reassemble the streamed regions and check they tile [0, N) contiguously.
    const chunks = h.of('chunk');
    const out = new Float32Array(N);
    let next = 0;
    for (const c of chunks) {
      expect(c.offset).toBe(next);
      expect(c.data.length).toBe(c.samples);
      out.set(c.data, c.offset);
      next = c.offset + c.samples;
    }
    expect(next).toBe(N);

    // The unchunked reference: the same fake conversion applied to the WHOLE
    // signal's spectrogram (the constant extractor makes src_tone identical in
    // both runs, so this isolates the chunking itself).
    const { spec } = spectrogram(x);
    const offset = (tv[0] - h.constantEmb[0]) * 0.5;
    const expected = new Float32Array(N);
    for (let t = 0; t < N; t++) expected[t] = spec[Math.floor(t / HOP_LENGTH)] * 0.001 + offset;

    // The tolerance is DERIVED, and outside the seams it is ZERO.
    //
    // The fake converter is frame-local, and chunk starts are HOP multiples,
    // so a chunk's frame f is the whole signal's frame f + start/HOP with
    // IDENTICAL window samples — except in the outermost 2 frames of each
    // chunk, whose analysis window reads reflected padding instead of the true
    // neighbour audio. Those are exactly the 512 samples per side the seam
    // geometry discards (EDGE_DISCARD_SAMPLES), so no contaminated frame ever
    // contributes. The first chunk's head and the last chunk's tail reflect
    // the same samples the unchunked run reflects, so they are not special.
    // Outside a seam exactly one chunk contributes at weight 1 → BIT-EXACT.
    //
    // Inside a seam both chunks render the SAME value, so the output is
    // exactly that value times (sin + cos) — up to +41% on this perfectly
    // correlated fake. That over-sum is the deliberate trade, not a defect:
    // the REAL decoder's chunk renditions are decorrelated (measured sample
    // correlation 0.02-0.18 — voiceChunking.cjs's header), which is the case
    // constant power exists for and where equal gain measured a -5.6 dB dip.
    // Pinning the analytic factor pins the seam law itself; the real-model
    // equivalence, where the two renditions differ, is measured against the
    // actual unchunked run in voiceIntegration.test.cjs.
    const plan = planVoiceSegments(N);
    expect(plan).toHaveLength(3); // two full segments + a HOP-aligned tail
    const seams = [];
    for (let i = 0; i + 1 < plan.length; i++) seams.push(crossfadeStart(plan, i));
    const seamPos = (t) => {
      for (const s of seams) if (t >= s && t < s + CROSSFADE_SAMPLES) return t - s;
      return -1;
    };

    let outsideWorst = 0;
    let insideWorst = 0;
    let insideCount = 0;
    let boostedSamples = 0;
    for (let t = 0; t < N; t++) {
      const k = seamPos(t);
      if (k < 0) {
        outsideWorst = Math.max(outsideWorst, Math.abs(out[t] - expected[t]));
      } else {
        insideCount++;
        insideWorst = Math.max(insideWorst, Math.abs(out[t] - expected[t] * (fadeIn(k) + fadeOut(k))));
        if (Math.abs(out[t]) > Math.abs(expected[t]) * 1.05) boostedSamples++;
      }
    }
    // Sample 0 is included in the sweep above — no exclusion, no quirk.
    expect(outsideWorst).toBe(0);
    expect(insideCount).toBe(2 * CROSSFADE_SAMPLES); // 1,102 samples of 1,370,624
    expect(insideWorst).toBeLessThan(1e-6);
    // The seams are genuinely being exercised: the analytic factor is not
    // vacuously 1, so `outsideWorst === 0` above is a real claim about a real
    // split rather than a plan that never actually crossfaded.
    expect(boostedSamples).toBeGreaterThan(insideCount * 0.9);
  });

  test('loop extents and per-call feeds: tau, dest_tone, audio_length, frame bound — every call, not just the first', async () => {
    const h = createHarness({ extractMode: 'marker' });
    await initHost(h);
    const x = makeSignal(N);
    const tv = makeTarget();
    await h.host.handleMessage({ type: 'convert', id: 3, totalSamples: N, targetVector: tv });
    await deliverAudio(h, 3, x);
    await h.host.handleMessage({ type: 'run', id: 3 });

    const plan = planVoiceSegments(N);
    expect(plan).toHaveLength(3);

    // Pass 1 extent: one extractor call per chunk, sized to that chunk.
    expect(h.calls.extract).toHaveLength(plan.length);
    for (let i = 0; i < plan.length; i++) {
      expect(h.calls.extract[i].dims).toEqual([1, framesForSamples(plan[i].end - plan[i].start), SPEC_BINS]);
    }

    // Pass 2 extent: one converter call per chunk.
    expect(h.calls.convert).toHaveLength(plan.length);
    const maxFrames = SEGMENT_SAMPLES / HOP_LENGTH; // 2584 — the RSS proxy
    const expectedSrc0 =
      plan.reduce((s, seg) => s + framesForSamples(seg.end - seg.start), 0) / plan.length;
    const expectedSrc2 = (1 + plan.length) / 2; // mean of call markers 1..n
    for (let i = 0; i < h.calls.convert.length; i++) {
      const c = h.calls.convert[i];
      // tau: the spike's 0.3, as float32, on EVERY call. Fails if TAU drifts.
      expect(c.tau).toBe(Math.fround(0.3));
      expect(TAU).toBe(0.3);
      // dest_tone: the caller's vector verbatim, right shape.
      expect(c.destDims).toEqual([1, TONE_EMBEDDING_SIZE, 1]);
      expect(Array.from(c.destTone)).toEqual(Array.from(tv));
      // src_tone: the whole-loop mean of per-chunk embeddings.
      expect(c.srcDims).toEqual([1, TONE_EMBEDDING_SIZE, 1]);
      expect(c.srcTone[0]).toBeCloseTo(expectedSrc0, 3);
      expect(c.srcTone[2]).toBeCloseTo(expectedSrc2, 5);
      // audio_length is the frame count of THIS chunk's tensor.
      expect(c.audioLength).toBe(c.dims[2]);
      // RSS proxy: no run ever sees more than one segment of frames.
      expect(c.dims[2]).toBeLessThanOrEqual(maxFrames);
    }
    for (const e of h.calls.extract) {
      expect(e.dims[1]).toBeLessThanOrEqual(maxFrames);
    }

    // Progress narrates BOTH passes to their full extent.
    const progress = h.of('progress');
    expect(progress.filter((p) => p.stage === 'embed').map((p) => p.done)).toEqual([1, 2, 3]);
    expect(progress.filter((p) => p.stage === 'convert').map((p) => p.done)).toEqual([1, 2, 3]);
    expect(progress.every((p) => p.total === plan.length)).toBe(true);
  });

  test('non-finite converter output is zeroed and counted, never delivered', async () => {
    const h = createHarness({
      convertResult: (call) => {
        const frames = call.dims[2];
        const out = new Float32Array(frames * HOP_LENGTH).fill(0.5);
        out[10] = Number.NaN;
        out[11] = Infinity;
        out[12] = -Infinity;
        return { converted_audio: { data: out } };
      },
    });
    await initHost(h);
    const n = 2048;
    await h.host.handleMessage({ type: 'convert', id: 5, totalSamples: n, targetVector: makeTarget() });
    await deliverAudio(h, 5, makeSignal(n));
    await h.host.handleMessage({ type: 'run', id: 5 });
    expect(h.of('done')[0].sanitisedSamples).toBe(3);
    const data = h.of('chunk')[0].data;
    for (let t = 0; t < data.length; t++) expect(Number.isFinite(data[t])).toBe(true);
    expect(data[10]).toBe(0);
    expect(data[13]).toBeCloseTo(0.5, 5);
  });

  test('a converter returning the wrong sample count is a run error, not a mis-aligned output', async () => {
    const h = createHarness({
      convertResult: (call) => ({
        converted_audio: { data: new Float32Array(call.dims[2] * HOP_LENGTH - 1) },
      }),
    });
    await initHost(h);
    await h.host.handleMessage({ type: 'convert', id: 6, totalSamples: 1024, targetVector: makeTarget() });
    await deliverAudio(h, 6, makeSignal(1024));
    await h.host.handleMessage({ type: 'run', id: 6 });
    expect(h.last()).toMatchObject({ type: 'error', stage: 'run', id: 6 });
    expect(h.last().message).toMatch(/expected 1024/);
  });
});

describe('cancel', () => {
  test('cancel mid-run stops between model runs: no further inference, no done, cancelled posted', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const h = createHarness({
      convertHook: async () => {
        await gate;
      },
    });
    await initHost(h);
    const x = makeSignal(2 * STRIDE_SAMPLES + 51200);
    await h.host.handleMessage({ type: 'convert', id: 7, totalSamples: x.length, targetVector: makeTarget() });
    await deliverAudio(h, 7, x);
    const running = h.host.handleMessage({ type: 'run', id: 7 });
    // Let pass 1 finish and the first converter call begin.
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls.convert.length).toBe(1);
    await h.host.handleMessage({ type: 'cancel', id: 7 });
    release();
    await running;
    expect(h.calls.convert).toHaveLength(1); // the loop did NOT continue
    expect(h.of('done')).toHaveLength(0);
    expect(h.of('cancelled')).toEqual([{ type: 'cancelled', id: 7 }]);
  });

  test('cancel before run drops the job; cancel with a stale id still answers', async () => {
    const h = createHarness();
    await initHost(h);
    await h.host.handleMessage({ type: 'embed', id: 8, totalSamples: 1000 });
    await h.host.handleMessage({ type: 'cancel', id: 8 });
    expect(h.of('cancelled')).toEqual([{ type: 'cancelled', id: 8 }]);
    await h.host.handleMessage({ type: 'cancel', id: 99 });
    expect(h.of('cancelled')).toHaveLength(2);
    // The slot is free.
    await h.host.handleMessage({ type: 'embed', id: 9, totalSamples: 1000 });
    expect(h.last().type).not.toBe('error');
  });
});

describe('lifecycle', () => {
  test('malformed and unknown messages are protocol errors, never crashes', async () => {
    const h = createHarness();
    await h.host.handleMessage(null);
    await h.host.handleMessage('convert');
    await h.host.handleMessage({ type: 42 });
    await h.host.handleMessage({ type: 'transmogrify' });
    expect(h.of('error')).toHaveLength(4);
    expect(h.of('error').every((e) => e.stage === 'protocol')).toBe(true);
  });

  test('shutdown releases both sessions and exits 0', async () => {
    const h = createHarness();
    await initHost(h);
    await h.host.handleMessage({ type: 'shutdown' });
    expect(h.calls.released.sort()).toEqual(['converter', 'extractor']);
    expect(h.getExitCode()).toBe(0);
  });
});
