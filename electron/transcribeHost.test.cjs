'use strict';

/**
 * Tests for the transcription utility-process host (F4). The host core is
 * dependency-injected (`createTranscribeHost({ ort, postMessage, exit,
 * fsImpl })`) so these tests drive the REAL message loop, validation, seek
 * loop, segment extraction and embedding pass with a fake onnxruntime and an
 * in-memory model config — the real-ORT path is covered by
 * transcribeIntegration.test.cjs (same directory), which runs the actual
 * pinned models through a child process and asserts the two things a fake
 * ORT cannot reach: that `noSpeechProb` carries a real signal (0.932 on
 * digital silence versus 0.044 on speech, measured) and that the KV cache is
 * correct against the real graph (the spoken control comes back verbatim).
 * It skips - reported, never silently green - when the model set is not in
 * the repo-local cache.
 *
 * The fake vocabulary mirrors whisperDecode.test.cjs's mini world:
 * text 0..19, eot 20, sot 21, en 22, fr 23, transcribe 24, translate 25,
 * nospeech 26, notimestamps 27, timestamps 28..78 (vocab 79).
 */

const {
  createTranscribeHost,
  MAX_TOTAL_SAMPLES,
  MIN_EMBED_SAMPLES,
} = require('./transcribeHost.cjs');

/**
 * Jest's 5 s default is not enough for this suite, and the reason is real work
 * rather than a hang: the fake stands in for onnxruntime only — every test
 * still runs the GENUINE feature pipeline, and `encodeWindow` computes a full
 * 30-second mel spectrogram (80 bins x 3000 frames) per window even for a
 * one-second job, because that is what Whisper's fixed input demands.
 *
 * Measured: 28 tests in 7.7 s with `--maxWorkers=1`. Under the full parallel
 * gate that multiplies — 16 workers compete, and on a machine with the pinned
 * models on disk `transcribeIntegration.test.cjs` is simultaneously running
 * real ONNX inference in a child process. Individual tests were observed
 * crossing 5 s there and failing as timeouts while passing in isolation.
 *
 * 30 s is ~4x the whole suite's isolated runtime, so it still fails fast on a
 * genuine hang rather than waiting out a stuck promise.
 */
jest.setTimeout(30000);

const VOCAB = 79;
const EOT = 20;
const SOT = 21;
const EN = 22;
const TS = 28;

const MINI_TOKENIZER = {
  model: { vocab: { 'Ġhi': 0, 'Ġthere': 1, 'Ġyou': 2 } },
  added_tokens: [
    { id: EOT, content: '<|endoftext|>' },
    { id: SOT, content: '<|startoftranscript|>' },
    { id: EN, content: '<|en|>' },
    { id: 23, content: '<|fr|>' },
    { id: 24, content: '<|transcribe|>' },
    { id: 25, content: '<|translate|>' },
    { id: 26, content: '<|nospeech|>' },
    { id: 27, content: '<|notimestamps|>' },
  ],
};

const PATHS = {
  encoder: '/fake/encoder.onnx',
  decoder: '/fake/decoder.onnx',
  embedder: '/fake/embedder.onnx',
  tokenizer: '/fake/tokenizer.json',
  generationConfig: '/fake/generation_config.json',
  modelConfig: '/fake/config.json',
};

const FILES = {
  [PATHS.tokenizer]: JSON.stringify(MINI_TOKENIZER),
  [PATHS.generationConfig]: JSON.stringify({
    max_initial_timestamp_index: 50,
    suppress_tokens: [17, 18],
    begin_suppress_tokens: [19, EOT],
  }),
  [PATHS.modelConfig]: JSON.stringify({
    decoder_layers: 2,
    decoder_attention_heads: 2,
    d_model: 8,
  }),
};

const fakeFs = {
  readFileSync: (p) => {
    if (!(p in FILES)) throw new Error(`fakeFs: no fixture for ${p}`);
    return FILES[p];
  },
};

/** Logits row: baseline -4 with overrides. */
function row(overrides = {}) {
  const l = new Float32Array(VOCAB).fill(-4);
  for (const [k, v] of Object.entries(overrides)) l[Number(k)] = v;
  return l;
}

/**
 * Fake onnxruntime. `script(fullSeq)` returns the LAST-position logits row for
 * the decoder given the reconstructed full token sequence; `sotRow(fullSeq)`,
 * when given, fills the row at the `<|startoftranscript|>` POSITION of an
 * uncached pass. The fake keeps its own KV bookkeeping exactly like the
 * scripted decoder in whisperDecode.test.cjs, so cache-choreography bugs
 * change its output.
 *
 * The two rows are separate on purpose. openai reads the no-speech
 * probability at the SOT position, not the last one, and a fake that filled
 * every row from one script could not tell a correct implementation from one
 * reading the wrong row — which is exactly the bug this fake used to hide.
 */
function fakeOrt({ script, sotRow } = {}) {
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
        const kind = modelPath.includes('encoder')
          ? 'encoder'
          : modelPath.includes('decoder')
            ? 'decoder'
            : 'embedder';
        let seq = null;
        const session = {
          kind,
          modelPath,
          opts,
          released: false,
          runCalls: 0,
          inputNames:
            kind === 'encoder' ? ['input_features'] : kind === 'embedder' ? ['feats'] : ['input_ids'],
          outputNames:
            kind === 'encoder' ? ['last_hidden_state'] : kind === 'embedder' ? ['embs'] : ['logits'],
          release: async () => {
            session.released = true;
          },
          run: async (feeds) => {
            session.runCalls++;
            await new Promise((r) => setImmediate(r)); // yield like real ORT
            if (kind === 'encoder') {
              expect(feeds.input_features.dims).toEqual([1, 80, 3000]);
              return { last_hidden_state: new Tensor('float32', new Float32Array(8), [1, 1, 8]) };
            }
            if (kind === 'embedder') {
              const feats = feeds.feats;
              expect(feats.dims[2]).toBe(80);
              // embedding derived from the segment's frame count so different
              // segments give different vectors
              const t = feats.dims[1];
              return { embs: new Tensor('float32', Float32Array.from([t, 1, 2, 3]), [1, 4]) };
            }
            // decoder: reconstruct the sequence from the cache choreography
            const ids = Array.from(feeds.input_ids.data, (b) => Number(b));
            const useCache = feeds.use_cache_branch.data[0] === 1;
            if (!useCache) seq = ids.slice();
            else {
              expect(ids).toHaveLength(1);
              seq.push(ids[0]);
            }
            for (let l = 0; l < 2; l++) {
              for (const side of ['decoder', 'encoder']) {
                expect(feeds[`past_key_values.${l}.${side}.key`]).toBeDefined();
                expect(feeds[`past_key_values.${l}.${side}.value`]).toBeDefined();
              }
            }
            const last = script(seq);
            const n = ids.length;
            const data = new Float32Array(n * VOCAB).fill(-30);
            data.set(last, (n - 1) * VOCAB);
            if (sotRow && !useCache) {
              const sotIndex = ids.indexOf(SOT);
              // Only when SOT is not itself the last position — the language
              // detection pass sends [SOT] alone, where the two coincide.
              if (sotIndex >= 0 && sotIndex !== n - 1) data.set(sotRow(seq), sotIndex * VOCAB);
            }
            const out = { logits: new Tensor('float32', data, [1, n, VOCAB]) };
            for (let l = 0; l < 2; l++) {
              for (const side of ['decoder', 'encoder']) {
                out[`present.${l}.${side}.key`] = new Tensor('float32', new Float32Array(4), [1, 2, seq.length, 4]);
                out[`present.${l}.${side}.value`] = new Tensor('float32', new Float32Array(4), [1, 2, seq.length, 4]);
              }
            }
            // Every decoder call recorded, feeds AND outputs, so a test can
            // assert the cache choreography BY VALUE rather than merely that
            // the past_key_values keys exist. `toBeDefined()` above is
            // satisfied by feeding the empty tensor forever — which destroys
            // cross-attention reuse and changes nothing observable.
            session.runLog.push({ useCache, ids: ids.slice(), feeds, out });
            return out;
          },
        };
        session.runLog = [];
        created.push(session);
        return session;
      },
    },
  };
  return ort;
}

/** Logits row where <|nospeech|> takes essentially all the mass — what a
 * genuinely silent window looks like at the SOT position. */
function noSpeechRow() {
  return row({ 26: 20 });
}

function makeHost(opts = {}) {
  const posted = [];
  const exits = [];
  const ort = fakeOrt(opts);
  const host = createTranscribeHost({
    ort,
    postMessage: (m) => posted.push(m),
    exit: (code) => exits.push(code),
    fsImpl: fakeFs,
  });
  return { host, posted, exits, ort };
}

async function initHost(h) {
  await h.host.handleMessage({ type: 'init', paths: PATHS });
  expect(h.posted).toContainEqual({ type: 'ready' });
  h.posted.length = 0;
}

/** Default script: detect en; then <|0.00|> " hi" <|0.80|> eot — a single
 * 0.8 s segment starting at 0. (40 units x 320 = 12800 samples.) */
function defaultScript(seq) {
  if (seq.length === 1 && seq[0] === SOT) return row({ [EN]: 6, 23: 2 }); // lang detect
  const step = seq.length - 3; // after [sot, en, transcribe]
  if (step === 0) return row({ [TS]: 9 });
  if (step === 1) return row({ 0: 9 });
  if (step === 2) return row({ [TS + 40]: 9 });
  return row({ [EOT]: 9 });
}

describe('init', () => {
  test('creates three CPU-EP sessions and replies ready', async () => {
    const h = makeHost({ script: defaultScript });
    await h.host.handleMessage({ type: 'init', paths: PATHS });
    expect(h.posted).toEqual([{ type: 'ready' }]);
    expect(h.ort.created).toHaveLength(3);
    for (const s of h.ort.created) {
      expect(s.opts.executionProviders).toEqual(['cpu']);
    }
  });

  test('missing path fields are a protocol error', async () => {
    const h = makeHost();
    await h.host.handleMessage({ type: 'init', paths: { encoder: '/x' } });
    expect(h.posted[0].type).toBe('error');
    expect(h.posted[0].stage).toBe('protocol');
  });

  test('double init is refused', async () => {
    const h = makeHost({ script: defaultScript });
    await initHost(h);
    await h.host.handleMessage({ type: 'init', paths: PATHS });
    expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
  });

  test('session-creation failure posts an init error, host survives', async () => {
    const posted = [];
    const host = createTranscribeHost({
      ort: {
        InferenceSession: {
          create: async () => {
            throw new Error('no such model');
          },
        },
      },
      postMessage: (m) => posted.push(m),
      exit: () => {},
      fsImpl: fakeFs,
    });
    await host.handleMessage({ type: 'init', paths: PATHS });
    expect(posted[0]).toMatchObject({ type: 'error', stage: 'init' });
    // and the loop still answers
    await host.handleMessage({ type: 'transcribe', id: 1, sampleRate: 16000, totalSamples: 10, language: 'auto' });
    expect(posted[1]).toMatchObject({ type: 'error', stage: 'protocol' });
  });
});

describe('message validation (trust boundary)', () => {
  test('malformed and unknown messages are protocol errors, never throws', async () => {
    const h = makeHost({ script: defaultScript });
    await initHost(h);
    for (const bad of [null, 42, 'x', {}, { type: 7 }, { type: 'nope' }]) {
      h.posted.length = 0;
      await h.host.handleMessage(bad);
      expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
    }
  });

  test('transcribe before init is refused', async () => {
    const h = makeHost({ script: defaultScript });
    await h.host.handleMessage({ type: 'transcribe', id: 1, sampleRate: 16000, totalSamples: 10, language: 'auto' });
    expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
  });

  test('sampleRate must be exactly 16000 (probe below/on/above)', async () => {
    const h = makeHost({ script: defaultScript });
    await initHost(h);
    for (const rate of [15999, 16001]) {
      h.posted.length = 0;
      await h.host.handleMessage({ type: 'transcribe', id: 1, sampleRate: rate, totalSamples: 10, language: 'auto' });
      expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
    }
    h.posted.length = 0;
    await h.host.handleMessage({ type: 'transcribe', id: 1, sampleRate: 16000, totalSamples: 10, language: 'auto' });
    expect(h.posted).toEqual([]); // accepted silently
  });

  test('totalSamples bounds (probe 0 / 1 / MAX / MAX+1)', async () => {
    const h = makeHost({ script: defaultScript });
    await initHost(h);
    for (const total of [0, MAX_TOTAL_SAMPLES + 1]) {
      h.posted.length = 0;
      await h.host.handleMessage({ type: 'transcribe', id: 1, sampleRate: 16000, totalSamples: total, language: 'auto' });
      expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
    }
    h.posted.length = 0;
    await h.host.handleMessage({ type: 'transcribe', id: 1, sampleRate: 16000, totalSamples: 1, language: 'auto' });
    expect(h.posted).toEqual([]);
    await h.host.handleMessage({ type: 'cancel', id: 1 });
    h.posted.length = 0;
    await h.host.handleMessage({ type: 'transcribe', id: 2, sampleRate: 16000, totalSamples: MAX_TOTAL_SAMPLES, language: 'auto' });
    expect(h.posted).toEqual([]);
  });

  test('language must be auto or a tokenizer-known code', async () => {
    const h = makeHost({ script: defaultScript });
    await initHost(h);
    for (const lang of ['xx', 42, undefined, null]) {
      h.posted.length = 0;
      await h.host.handleMessage({ type: 'transcribe', id: 1, sampleRate: 16000, totalSamples: 10, language: lang });
      expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
    }
    for (const lang of ['auto', 'en', 'fr']) {
      h.posted.length = 0;
      await h.host.handleMessage({ type: 'transcribe', id: 1, sampleRate: 16000, totalSamples: 10, language: lang });
      expect(h.posted).toEqual([]);
      await h.host.handleMessage({ type: 'cancel', id: 1 });
    }
  });

  test('audio payload and range validation (probe the range boundaries)', async () => {
    const h = makeHost({ script: defaultScript });
    await initHost(h);
    await h.host.handleMessage({ type: 'transcribe', id: 1, sampleRate: 16000, totalSamples: 100, language: 'auto' });
    const cases = [
      { id: 2, offset: 0, samples: new Float32Array(10) }, // wrong job
      { id: 1, offset: 0, samples: [1, 2, 3] }, // not a Float32Array
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
    const h = makeHost({ script: defaultScript });
    await initHost(h);
    await h.host.handleMessage({ type: 'transcribe', id: 1, sampleRate: 16000, totalSamples: 100, language: 'auto' });
    await h.host.handleMessage({ type: 'audio', id: 1, offset: 0, samples: new Float32Array(50) });
    await h.host.handleMessage({ type: 'audio', id: 1, offset: 0, samples: new Float32Array(50) }); // duplicate
    h.posted.length = 0;
    await h.host.handleMessage({ type: 'run', id: 1 });
    expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol' });
    expect(h.posted[0].message).toMatch(/50 of 100/);
  });

  test('a second transcribe while a job is loaded is refused (single-job host)', async () => {
    const h = makeHost({ script: defaultScript });
    await initHost(h);
    await h.host.handleMessage({ type: 'transcribe', id: 1, sampleRate: 16000, totalSamples: 10, language: 'auto' });
    await h.host.handleMessage({ type: 'transcribe', id: 2, sampleRate: 16000, totalSamples: 10, language: 'auto' });
    expect(h.posted[0]).toMatchObject({ type: 'error', stage: 'protocol', id: 2 });
  });
});

describe('transcription run', () => {
  async function runJob(h, { totalSamples = 16000, language = 'auto' } = {}) {
    await h.host.handleMessage({ type: 'transcribe', id: 1, sampleRate: 16000, totalSamples, language });
    await h.host.handleMessage({ type: 'audio', id: 1, offset: 0, samples: new Float32Array(totalSamples) });
    await h.host.handleMessage({ type: 'run', id: 1 });
  }

  test('auto language: detects, reports, transcribes one segment, embeds it, done', async () => {
    const h = makeHost({ script: defaultScript });
    await initHost(h);
    await runJob(h);
    const types = h.posted.map((m) => m.type);
    expect(types).toContain('language');
    expect(types).toContain('segment');
    expect(types).toContain('embedding');
    expect(types[types.length - 1]).toBe('done');
    const lang = h.posted.find((m) => m.type === 'language');
    expect(lang.language).toBe('en');
    expect(lang.probability).toBeGreaterThan(0.9);
    const seg = h.posted.find((m) => m.type === 'segment');
    expect(seg).toMatchObject({ id: 1, index: 0, startSample: 0, endSample: 40 * 320, text: 'hi' });
    expect(seg.noSpeechProb).toBeLessThan(0.5);
    const emb = h.posted.find((m) => m.type === 'embedding');
    expect(emb.segmentIndex).toBe(0);
    // L2-normalised
    let norm = 0;
    for (const v of emb.vector) norm += v * v;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 6);
    const done = h.posted.find((m) => m.type === 'done');
    expect(done.segmentCount).toBe(1);
    // progress covered both stages
    const stages = h.posted.filter((m) => m.type === 'progress').map((m) => m.stage);
    expect(stages).toContain('transcribe');
    expect(stages).toContain('embed');
  });

  test('explicit language skips detection (no language message, no [sot]-only call)', async () => {
    const calls = [];
    const h = makeHost({
      script: (seq) => {
        calls.push(seq.slice());
        return defaultScript(seq);
      },
    });
    await initHost(h);
    await runJob(h, { language: 'en' });
    expect(h.posted.some((m) => m.type === 'language')).toBe(false);
    expect(calls.every((seq) => !(seq.length === 1 && seq[0] === SOT))).toBe(true);
    expect(h.posted.some((m) => m.type === 'segment')).toBe(true);
  });

  test('embedding gate: a segment on the 0.5 s boundary embeds, one below does not', async () => {
    // <|0.00|> hi <|0.50|> <|0.50|> there <|0.74|> eot -> 8000 and 7680 samples
    const script = (seq) => {
      if (seq.length === 1 && seq[0] === SOT) return row({ [EN]: 6 });
      const step = seq.length - 3;
      const steps = [
        row({ [TS]: 9 }),
        row({ 0: 9 }),
        row({ [TS + 25]: 9 }),
        row({ [TS + 25]: 9 }),
        row({ 1: 9 }),
        row({ [TS + 49]: 9 }),
      ];
      return step < steps.length ? steps[step] : row({ [EOT]: 9 });
    };
    const h = makeHost({ script });
    await initHost(h);
    await runJob(h);
    const segs = h.posted.filter((m) => m.type === 'segment');
    expect(segs).toHaveLength(2);
    expect(segs[0].endSample - segs[0].startSample).toBe(MIN_EMBED_SAMPLES); // on boundary
    expect(segs[1].endSample - segs[1].startSample).toBeLessThan(MIN_EMBED_SAMPLES); // below
    const embs = h.posted.filter((m) => m.type === 'embedding');
    expect(embs).toHaveLength(1);
    expect(embs[0].segmentIndex).toBe(0);
  });

  // ---------------------------------------------------------------------
  // openai's silence rule: skip the window only when
  // `noSpeechProb > 0.6 AND avgLogprob < -1.0`. Both operands are probed in
  // both directions below, because the rule is an AND and either half alone
  // must NOT skip. The no-speech probability comes from the SOT ROW of the
  // uncached pass — a host that read the last row instead reports ~0 for
  // every window, the rule becomes dead code, and Whisper's silence
  // hallucinations land as real segments.
  // ---------------------------------------------------------------------

  /**
   * A structurally VALID one-segment decode — the same <ts> text <ts> eot
   * shape as `defaultScript` — but every choice is barely ahead of a large
   * field, so avgLogprob lands well below -1 while the tokens still form a
   * proper timestamp pair. That is what makes the 2x2 below decidable: the
   * SKIPPED cell must differ from the DECODED cells by a segment, not merely
   * by an internal counter.
   */
  const lowConfidenceScript = (seq) => {
    if (seq.length === 1 && seq[0] === SOT) return row({ [EN]: 6 });
    const spread = (ids, winner) => {
      const o = {};
      for (const id of ids) o[id] = 0;
      o[winner] = 0.001;
      return row(o);
    };
    const timestamps = Array.from({ length: 51 }, (_, i) => TS + i);
    const texts = Array.from({ length: 17 }, (_, i) => i); // 0..16 (17,18 suppressed)
    const step = seq.length - 3;
    if (step === 0) return spread(timestamps, TS);
    if (step === 1) return spread(texts, 0);
    if (step === 2) return spread(timestamps, TS + 40);
    return row({ [EOT]: 9 });
  };

  /** A confident one-segment window: <|0.00|> "hi" <|0.80|> eot. */
  const confidentScript = defaultScript;

  // The truth table. Same two scripts, same two SOT rows, four combinations;
  // exactly one skips.
  test('BOTH halves true: the window is skipped, no segments, and the job finishes', async () => {
    const h = makeHost({ script: lowConfidenceScript, sotRow: noSpeechRow });
    await initHost(h);
    await runJob(h);
    expect(h.posted.filter((m) => m.type === 'segment')).toHaveLength(0);
    expect(h.posted[h.posted.length - 1]).toMatchObject({ type: 'done', segmentCount: 0 });
  });

  test('low logprob ALONE does not skip: the identical decode yields its segment', async () => {
    // Byte-for-byte the same script as the skipped case; only the SOT row
    // differs. A segment here is what makes the skip above non-vacuous.
    const h = makeHost({ script: lowConfidenceScript });
    await initHost(h);
    await runJob(h);
    const segs = h.posted.filter((m) => m.type === 'segment');
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe('hi');
  });

  test('high noSpeech ALONE does not skip: a confident window survives', async () => {
    // <|nospeech|> owns the SOT row, but the decode is confident, so openai's
    // rule does not skip. This is the half a "noSpeechProb only" rule would
    // wrongly throw away.
    const h = makeHost({ script: confidentScript, sotRow: noSpeechRow });
    await initHost(h);
    await runJob(h);
    const segs = h.posted.filter((m) => m.type === 'segment');
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe('hi');
  });

  test('neither half true: a confident window with no <|nospeech|> mass decodes (the control)', async () => {
    const h = makeHost({ script: confidentScript });
    await initHost(h);
    await runJob(h);
    expect(h.posted.filter((m) => m.type === 'segment')).toHaveLength(1);
  });

  // ---------------------------------------------------------------------
  // The KV-cache choreography, BY VALUE.
  //
  // `greedyDecodeWindow`'s own equivalence test (whisperDecode.test.cjs)
  // proves the LOOP asks for the right tokens, but it drives an injected
  // callback and structurally cannot see this layer: which tensors
  // `createOrtDecoderRunner` actually feeds back. Asserting only that the
  // `past_key_values.*` keys are DEFINED is satisfied by feeding the empty
  // tensor on every step — which destroys cross-attention reuse entirely and
  // changes nothing else observable, because the fake's logits are scripted
  // from the token sequence rather than computed from the cache.
  //
  // So: assert the tensors are the RIGHT OBJECTS. Decoder pasts must be the
  // previous step's presents; encoder pasts must be step 0's presents, for
  // every cached step.
  // ---------------------------------------------------------------------

  test('the decoder KV fed at each cached step IS the previous present', async () => {
    const h = makeHost({ script: confidentScript });
    await initHost(h);
    await runJob(h);
    const decoder = h.ort.created.find((s) => s.kind === 'decoder');
    // Drop the language-detection pass ([SOT] alone, uncached) and keep the
    // window's own run: one uncached pass then cached steps.
    const window = decoder.runLog.slice(decoder.runLog.findIndex((c) => c.ids.length === 3));
    expect(window.length).toBeGreaterThan(2);
    expect(window[0].useCache).toBe(false);
    for (let i = 1; i < window.length; i++) {
      expect(window[i].useCache).toBe(true);
      for (let l = 0; l < 2; l++) {
        expect(window[i].feeds[`past_key_values.${l}.decoder.key`]).toBe(
          window[i - 1].out[`present.${l}.decoder.key`]
        );
        expect(window[i].feeds[`past_key_values.${l}.decoder.value`]).toBe(
          window[i - 1].out[`present.${l}.decoder.value`]
        );
      }
    }
  });

  test('the encoder KV fed at every cached step IS step 0 present (captured once)', async () => {
    const h = makeHost({ script: confidentScript });
    await initHost(h);
    await runJob(h);
    const decoder = h.ort.created.find((s) => s.kind === 'decoder');
    const window = decoder.runLog.slice(decoder.runLog.findIndex((c) => c.ids.length === 3));
    const step0 = window[0];
    for (let i = 1; i < window.length; i++) {
      for (let l = 0; l < 2; l++) {
        expect(window[i].feeds[`past_key_values.${l}.encoder.key`]).toBe(
          step0.out[`present.${l}.encoder.key`]
        );
        expect(window[i].feeds[`past_key_values.${l}.encoder.value`]).toBe(
          step0.out[`present.${l}.encoder.value`]
        );
      }
    }
    // ...and NOT the previous step's, which would also be "defined" and would
    // silently re-derive cross-attention from a decoder-length cache.
    if (window.length > 2) {
      expect(window[2].feeds['past_key_values.0.encoder.key']).not.toBe(
        window[1].out['present.0.encoder.key']
      );
    }
  });

  test('the uncached pass feeds EMPTY pasts on all four slots, not stale ones', async () => {
    const h = makeHost({ script: confidentScript });
    await initHost(h);
    await runJob(h);
    const decoder = h.ort.created.find((s) => s.kind === 'decoder');
    for (const call of decoder.runLog.filter((c) => !c.useCache)) {
      for (let l = 0; l < 2; l++) {
        for (const side of ['decoder', 'encoder']) {
          for (const part of ['key', 'value']) {
            const t = call.feeds[`past_key_values.${l}.${side}.${part}`];
            expect(t.data).toHaveLength(0);
            // [1, heads, 0, headDim] from the model config: 2 heads, d_model
            // 8 / 2 heads = 4.
            expect(t.dims).toEqual([1, 2, 0, 4]);
          }
        }
      }
    }
  });

  test('a cached step feeds ONE token and a non-empty decoder past', async () => {
    // The pair the two tests above rest on: if the runner ever fed the empty
    // tensor on a cached step, the assertions above would still hold for
    // "defined" but the cache would be doing nothing.
    const h = makeHost({ script: confidentScript });
    await initHost(h);
    await runJob(h);
    const decoder = h.ort.created.find((s) => s.kind === 'decoder');
    const cached = decoder.runLog.filter((c) => c.useCache);
    expect(cached.length).toBeGreaterThan(0);
    for (const call of cached) {
      expect(call.ids).toHaveLength(1);
      expect(call.feeds['past_key_values.0.decoder.key'].data.length).toBeGreaterThan(0);
      expect(call.feeds['past_key_values.0.encoder.key'].data.length).toBeGreaterThan(0);
    }
  });

  test('cancel during the decode loop aborts between steps: cancelled, no done', async () => {
    const h = makeHost({ script: defaultScript });
    await initHost(h);
    await h.host.handleMessage({ type: 'transcribe', id: 1, sampleRate: 16000, totalSamples: 16000, language: 'en' });
    await h.host.handleMessage({ type: 'audio', id: 1, offset: 0, samples: new Float32Array(16000) });
    const runPromise = h.host.handleMessage({ type: 'run', id: 1 });
    await h.host.handleMessage({ type: 'cancel', id: 1 });
    await runPromise;
    const types = h.posted.map((m) => m.type);
    expect(types).toContain('cancelled');
    expect(types).not.toContain('done');
    // the host is free again
    h.posted.length = 0;
    await h.host.handleMessage({ type: 'transcribe', id: 2, sampleRate: 16000, totalSamples: 10, language: 'en' });
    expect(h.posted).toEqual([]);
  });

  test('cancel before run drops the pending job', async () => {
    const h = makeHost({ script: defaultScript });
    await initHost(h);
    await h.host.handleMessage({ type: 'transcribe', id: 1, sampleRate: 16000, totalSamples: 10, language: 'en' });
    await h.host.handleMessage({ type: 'cancel', id: 1 });
    expect(h.posted[0]).toEqual({ type: 'cancelled', id: 1 });
    h.posted.length = 0;
    await h.host.handleMessage({ type: 'transcribe', id: 2, sampleRate: 16000, totalSamples: 10, language: 'en' });
    expect(h.posted).toEqual([]);
  });

  test('inference failure posts a run error with the job id and frees the host', async () => {
    const script = (seq) => {
      if (seq.length === 1 && seq[0] === SOT) return row({ [EN]: 6 });
      throw new Error('onnx exploded');
    };
    const h = makeHost({ script });
    await initHost(h);
    await h.host.handleMessage({ type: 'transcribe', id: 1, sampleRate: 16000, totalSamples: 16000, language: 'en' });
    await h.host.handleMessage({ type: 'audio', id: 1, offset: 0, samples: new Float32Array(16000) });
    await h.host.handleMessage({ type: 'run', id: 1 });
    const err = h.posted.find((m) => m.type === 'error');
    expect(err).toMatchObject({ stage: 'run', id: 1 });
    expect(err.message).toMatch(/onnx exploded/);
  });
});

describe('shutdown', () => {
  test('releases every session and exits 0', async () => {
    const h = makeHost({ script: defaultScript });
    await initHost(h);
    await h.host.handleMessage({ type: 'shutdown' });
    expect(h.exits).toEqual([0]);
    for (const s of h.ort.created) expect(s.released).toBe(true);
  });

  test('shutdown before init still exits cleanly', async () => {
    const h = makeHost();
    await h.host.handleMessage({ type: 'shutdown' });
    expect(h.exits).toEqual([0]);
  });
});
