'use strict';

/**
 * Tests for whisperDecode.cjs (F4) — the timestamp rules, the tokenizer and
 * the greedy KV-cached decode loop, driven with a mini Whisper-shaped vocab
 * so every rule can be probed at its boundary (below/on/above) without the
 * 51 MB real tokenizer.
 *
 * Mini world: text tokens 0..19, eot 20, sot 21, <|en|> 22, <|fr|> 23,
 * transcribe 24, translate 25, nospeech 26, notimestamps 27 →
 * timestampBegin 28, timestamps 28..78 (51 of them), vocab 79.
 */

const {
  unicodeToBytes,
  createTokenizer,
  logSoftmax,
  applyTimestampRules,
  applySuppress,
  compressionRatio,
  greedyDecodeWindow,
  extractSegments,
} = require('./whisperDecode.cjs');

const VOCAB = 79;
const EOT = 20;
const SOT = 21;
const NO_SPEECH = 26;
const NO_TS = 27;
const TS = 28; // timestampBegin

const CFG = {
  timestampBegin: TS,
  eot: EOT,
  noTimestamps: NO_TS,
  noSpeech: NO_SPEECH,
  // openai's `sot_index` source: the row `noSpeech` is read from. Required
  // whenever `noSpeech` is set — see the greedyDecodeWindow block below.
  sot: SOT,
  maxInitialTimestampIndex: 3,
  suppressTokens: [17, 18],
  beginSuppressTokens: [19, EOT],
  maxNewTokens: 24,
};

/** Baseline logits: every id at `base`, then overrides. */
function mk(base, overrides = {}) {
  const l = new Float32Array(VOCAB).fill(base);
  for (const [k, v] of Object.entries(overrides)) l[Number(k)] = v;
  return l;
}

const MINI_TOKENIZER = {
  model: {
    vocab: {
      // 'Ġ' (U+0120) is byte-level BPE for a leading space
      'Ġhi': 0,
      'Ġthere': 1,
      'Ġyou': 2,
      a: 3,
      b: 4,
    },
  },
  added_tokens: [
    { id: EOT, content: '<|endoftext|>' },
    { id: SOT, content: '<|startoftranscript|>' },
    { id: 22, content: '<|en|>' },
    { id: 23, content: '<|fr|>' },
    { id: 24, content: '<|transcribe|>' },
    { id: 25, content: '<|translate|>' },
    { id: NO_SPEECH, content: '<|nospeech|>' },
    { id: NO_TS, content: '<|notimestamps|>' },
  ],
};

describe('unicodeToBytes (GPT-2 byte decoder)', () => {
  test('keeps printables and maps shifted code points back to raw bytes', () => {
    const inv = unicodeToBytes();
    expect(inv.get('A'.codePointAt(0))).toBe(65);
    expect(inv.get(0x0120)).toBe(32); // 'Ġ' -> space
    expect(inv.get(0x0100)).toBe(0); // 'Ā' -> NUL
    expect(inv.get(0x0a3)).toBe(0xa3); // '£' is in the kept 161..172 range
  });
});

describe('createTokenizer', () => {
  test('parses specials, language ids and the timestamp base', () => {
    const tok = createTokenizer(MINI_TOKENIZER);
    expect(tok.sot).toBe(SOT);
    expect(tok.eot).toBe(EOT);
    expect(tok.noTimestamps).toBe(NO_TS);
    expect(tok.noSpeech).toBe(NO_SPEECH);
    expect(tok.timestampBegin).toBe(TS);
    expect(tok.langIds.get('en')).toBe(22);
    expect(tok.langIds.get('fr')).toBe(23);
    // task/nospeech/notimestamps are NOT languages
    expect([...tok.langIds.keys()].sort()).toEqual(['en', 'fr']);
  });

  test('decodes byte-level BPE and skips specials/timestamps', () => {
    const tok = createTokenizer(MINI_TOKENIZER);
    expect(tok.decode([0, 1])).toBe(' hi there');
    expect(tok.decode([TS, 0, EOT, 1, TS + 9, SOT])).toBe(' hi there');
    expect(tok.decode([3, 4])).toBe('ab');
    expect(tok.decode([])).toBe('');
  });

  // -------------------------------------------------------------------
  // The no-speech token has TWO spellings across Whisper vocab revisions.
  // The model this app PINS (onnx-community/whisper-base) ships
  // `<|nocaptions|>`; looking only for `<|nospeech|>` left `noSpeech`
  // undefined, which silently disabled the whole silence rule — measured:
  // 30 s of digital silence transcribed as the word "you", and a sung
  // recording over a dance band emitted 7 fabricated segments. Both
  // spellings are therefore resolved, and both are pinned here.
  // -------------------------------------------------------------------

  test('resolves the no-speech token spelled <|nospeech|>', () => {
    expect(createTokenizer(MINI_TOKENIZER).noSpeech).toBe(NO_SPEECH);
  });

  test('resolves the no-speech token spelled <|nocaptions|> (what whisper-base actually ships)', () => {
    const older = {
      ...MINI_TOKENIZER,
      added_tokens: MINI_TOKENIZER.added_tokens.map((t) =>
        t.content === '<|nospeech|>' ? { id: t.id, content: '<|nocaptions|>' } : t
      ),
    };
    expect(createTokenizer(older).noSpeech).toBe(NO_SPEECH);
  });

  test('prefers <|nospeech|> when a vocab somehow carries both', () => {
    const both = {
      ...MINI_TOKENIZER,
      added_tokens: [...MINI_TOKENIZER.added_tokens, { id: 19, content: '<|nocaptions|>' }],
    };
    expect(createTokenizer(both).noSpeech).toBe(NO_SPEECH);
  });

  test('a vocab with neither spelling leaves noSpeech undefined rather than guessing an id', () => {
    const neither = {
      ...MINI_TOKENIZER,
      added_tokens: MINI_TOKENIZER.added_tokens.filter((t) => t.content !== '<|nospeech|>'),
    };
    // Undefined, NOT 0 — id 0 is a real text token, and a wrong id would read
    // some word's probability as "this window is silence".
    expect(createTokenizer(neither).noSpeech).toBeUndefined();
  });

  test('rejects objects that are not a tokenizer.json', () => {
    expect(() => createTokenizer({})).toThrow(/model\.vocab/);
    expect(() => createTokenizer({ model: { vocab: { a: 1 } }, added_tokens: [] })).toThrow(
      /special tokens/
    );
  });
});

describe('applyTimestampRules (openai ApplyTimestampRules port)', () => {
  test('<|notimestamps|> is always suppressed', () => {
    const l = applyTimestampRules(mk(0, { 5: 10 }), [TS, 3], CFG);
    expect(l[NO_TS]).toBe(-Infinity);
  });

  test('first sample must be a timestamp, capped at max_initial (probe on/above the cap)', () => {
    const l = applyTimestampRules(mk(0), [], CFG);
    for (const i of [0, 5, EOT, NO_TS]) expect(l[i]).toBe(-Infinity);
    expect(l[TS]).not.toBe(-Infinity);
    expect(l[TS + CFG.maxInitialTimestampIndex]).not.toBe(-Infinity); // on the cap
    expect(l[TS + CFG.maxInitialTimestampIndex + 1]).toBe(-Infinity); // above it
  });

  test('after a closed pair (ts,ts) text must follow: all timestamps suppressed', () => {
    // Text token 5 is boosted so the mass rule does not fire and hide the pair rule.
    const l = applyTimestampRules(mk(0, { 5: 10 }), [TS, 3, TS + 2, TS + 2], CFG);
    for (let i = TS; i < VOCAB; i++) expect(l[i]).toBe(-Infinity);
    expect(l[5]).not.toBe(-Infinity);
    expect(l[EOT]).not.toBe(-Infinity);
  });

  test('after (text,ts) the pair must close: plain text suppressed, eot allowed', () => {
    // eot boosted so the separate timestamp-MASS rule (which suppresses all of
    // [:timestampBegin], eot included — openai does the same) stays out of
    // the way of the pair rule being probed here.
    const l = applyTimestampRules(mk(0, { [EOT]: 10 }), [TS, 3, TS + 2], CFG);
    for (let i = 0; i < EOT; i++) expect(l[i]).toBe(-Infinity);
    expect(l[EOT]).not.toBe(-Infinity); // logits[:eot] excludes eot itself
    expect(l[TS + 2]).not.toBe(-Infinity); // same timestamp may repeat to close
  });

  test('timestamps never decrease (probe below/on the floor, both floor variants)', () => {
    // last token is TEXT -> floor is lastTimestamp+1
    let l = applyTimestampRules(mk(0, { 5: 10 }), [TS, 3, TS + 4, TS + 4, 6], CFG);
    expect(l[TS + 4]).toBe(-Infinity); // below floor (== lastTimestamp)
    expect(l[TS + 5]).not.toBe(-Infinity); // on floor
    // last token is an UNPAIRED TIMESTAMP -> floor is lastTimestamp (repeat allowed)
    l = applyTimestampRules(mk(0), [TS, 3, TS + 4], CFG);
    expect(l[TS + 3]).toBe(-Infinity);
    expect(l[TS + 4]).not.toBe(-Infinity);
  });

  test('timestamp probability mass overrides text (both directions of the comparison)', () => {
    // 51 timestamps at logit 0 vs best text at 2: log(51e^0) ≈ 3.93 > 2 -> text suppressed
    let l = applyTimestampRules(mk(-30, ...[]), [TS, 3], { ...CFG });
    l = applyTimestampRules(mk(0, { 5: 2 }), [TS, 3], CFG);
    expect(l[5]).toBe(-Infinity);
    // best text at 5: 3.93 < 5 -> text survives
    l = applyTimestampRules(mk(0, { 5: 5 }), [TS, 3], CFG);
    expect(l[5]).not.toBe(-Infinity);
  });
});

describe('applySuppress', () => {
  test('suppress list always, begin-suppress only at step 0 (probe both steps)', () => {
    let l = applySuppress(mk(0), [], CFG);
    expect(l[17]).toBe(-Infinity);
    expect(l[18]).toBe(-Infinity);
    expect(l[19]).toBe(-Infinity);
    expect(l[EOT]).toBe(-Infinity);
    l = applySuppress(mk(0), [TS], CFG);
    expect(l[17]).toBe(-Infinity);
    expect(l[19]).not.toBe(-Infinity);
    expect(l[EOT]).not.toBe(-Infinity);
  });
});

describe('greedyDecodeWindow', () => {
  /**
   * Scripted decoder: a pure function of the FULL token sequence, with its
   * own KV bookkeeping — when useCache is true it receives ONLY the newest
   * token and must reconstruct the sequence from its stored state, so any
   * bookkeeping error in the loop produces different logits and the
   * equivalence test below goes red.
   */
  function scriptedDecoder(logitsFor, sotFor) {
    let full = null;
    return async ({ tokens, useCache }) => {
      if (!useCache) {
        full = tokens.slice();
      } else {
        expect(tokens).toHaveLength(1);
        full.push(tokens[0]);
      }
      // The contract is one row per REQUESTED position, row-major. Every row
      // other than the last (and the SOT row, when the caller scripts one) is
      // filled with a DIFFERENT constant, so a loop that samples from — or
      // reads the no-speech probability from — the wrong row produces visibly
      // wrong numbers instead of quietly working.
      const rows = tokens.length;
      const grid = new Float32Array(rows * VOCAB).fill(FILLER_LOGIT);
      grid.set(logitsFor(full), (rows - 1) * VOCAB);
      if (sotFor && !useCache) {
        const sotIndex = tokens.indexOf(SOT);
        if (sotIndex >= 0 && sotIndex !== rows - 1) grid.set(sotFor(full), sotIndex * VOCAB);
      }
      return grid;
    };
  }

  /** Fills the rows nobody should be reading. Distinct from `mk`'s baseline
   * so a wrong-row read is a wrong NUMBER, not merely a wrong index. */
  const FILLER_LOGIT = -12;

  /** Deterministic pseudo-random logits from the sequence — enough structure
   * to exercise several rule branches over a decode. */
  function hashLogits(full) {
    let h = 2166136261 >>> 0;
    for (const t of full) {
      h ^= t;
      h = Math.imul(h, 16777619) >>> 0;
    }
    const l = new Float32Array(VOCAB);
    for (let i = 0; i < VOCAB; i++) {
      h ^= i;
      h = Math.imul(h, 16777619) >>> 0;
      l[i] = ((h >>> 8) / (1 << 24)) * 8 - 4;
    }
    return l;
  }

  const PROMPT = [SOT, 22, 24];

  test('KV-cached decoding produces exactly the tokens of uncached decoding', async () => {
    const cached = await greedyDecodeWindow(scriptedDecoder(hashLogits), PROMPT, CFG);
    const uncached = await greedyDecodeWindow(scriptedDecoder(hashLogits), PROMPT, {
      ...CFG,
      useKvCache: false,
    });
    expect(cached.tokens.length).toBeGreaterThan(0);
    expect(cached.tokens).toEqual(uncached.tokens);
    expect(cached.avgLogprob).toBeCloseTo(uncached.avgLogprob, 10);
  });

  test('the cached path really is asked for one token per step after the prompt', async () => {
    const calls = [];
    const inner = scriptedDecoder(hashLogits);
    const spy = async (req) => {
      calls.push({ n: req.tokens.length, useCache: req.useCache });
      return inner(req);
    };
    await greedyDecodeWindow(spy, PROMPT, CFG);
    expect(calls[0]).toEqual({ n: PROMPT.length, useCache: false });
    for (const c of calls.slice(1)) expect(c).toEqual({ n: 1, useCache: true });
    expect(calls.length).toBeGreaterThan(1);
  });

  test('eot ends the decode; sampled tokens exclude it', async () => {
    // Step 0 must be a timestamp; step 1: eot wins (boosted, allowed there).
    const run = scriptedDecoder((full) =>
      full.length === PROMPT.length ? mk(0, { [TS]: 5 }) : mk(0, { [EOT]: 50, 5: 10 })
    );
    const out = await greedyDecodeWindow(run, PROMPT, CFG);
    expect(out.tokens).toEqual([TS]);
  });

  test('maxNewTokens bounds a decode that never emits eot', async () => {
    const out = await greedyDecodeWindow(scriptedDecoder(hashLogits), PROMPT, {
      ...CFG,
      maxNewTokens: 5,
    });
    expect(out.tokens.length).toBeLessThanOrEqual(5);
  });

  // -------------------------------------------------------------------------
  // noSpeechProb — openai reads it at the SOT POSITION of the uncached pass
  // (decoding.py `_main_loop`: `probs_at_sot = logits[:, self.sot_index]`),
  // NOT at the last position. `<|nospeech|>` is only ever a training target
  // for the token after `<|startoftranscript|>`; after `<|transcribe|>` it
  // carries no mass, so reading the last row returns ~0 for every window and
  // the silence rule becomes dead code. The three tests below pin the ROW.
  // -------------------------------------------------------------------------

  test('noSpeechProb is measured on the RAW first-step logits, before suppression', async () => {
    // nospeech is in neither suppress list of this cfg, but the timestamp
    // rules would zero it at sampling time; the probability must still see it.
    const sot = mk(0, { [NO_SPEECH]: 3, [TS]: 4 });
    const expected = Math.exp(logSoftmax(sot)[NO_SPEECH]);
    const run = scriptedDecoder(
      (full) => (full.length === PROMPT.length ? mk(0, { [TS]: 4 }) : mk(0, { [EOT]: 50 })),
      () => sot
    );
    const out = await greedyDecodeWindow(run, PROMPT, CFG);
    expect(out.noSpeechProb).toBeCloseTo(expected, 10);
  });

  test('noSpeechProb comes from the SOT row, NOT the last prompt row', async () => {
    // The two rows disagree as loudly as they can: nospeech dominates the SOT
    // row and is absent from the last row. Reading the last row would report
    // near-zero; reading the SOT row reports near-one.
    const sot = mk(0, { [NO_SPEECH]: 20 });
    const last = mk(0, { [TS]: 4 });
    const run = scriptedDecoder(
      (full) => (full.length === PROMPT.length ? last : mk(0, { [EOT]: 50 })),
      () => sot
    );
    const out = await greedyDecodeWindow(run, PROMPT, CFG);
    expect(out.noSpeechProb).toBeCloseTo(Math.exp(logSoftmax(sot)[NO_SPEECH]), 10);
    expect(out.noSpeechProb).toBeGreaterThan(0.99);
    // and the last row's own answer is what it must NOT have reported
    expect(Math.exp(logSoftmax(last)[NO_SPEECH])).toBeLessThan(0.05);
  });

  test('nospeech mass in the LAST row alone does NOT raise noSpeechProb', async () => {
    // The converse, and the shape the real model actually has: a confident
    // <|nospeech|> at the sampling position with nothing at SOT must NOT be
    // read as silence.
    const sot = mk(0, { [TS]: 4 });
    const last = mk(0, { [NO_SPEECH]: 20 });
    const run = scriptedDecoder(
      (full) => (full.length === PROMPT.length ? last : mk(0, { [EOT]: 50 })),
      () => sot
    );
    const out = await greedyDecodeWindow(run, PROMPT, CFG);
    expect(out.noSpeechProb).toBeLessThan(0.05);
    expect(out.noSpeechProb).toBeCloseTo(Math.exp(logSoftmax(sot)[NO_SPEECH]), 10);
  });

  test('the SOT row is located by cfg.sot, not assumed to be row 0', async () => {
    // A prompt whose SOT is NOT first (openai supports exactly this via
    // prefix/prompt conditioning, where sot_index > 0). The probability must
    // follow the token, not the index.
    const prefixed = [99, SOT, 22, 24];
    const sot = mk(0, { [NO_SPEECH]: 20 });
    const run = scriptedDecoder(
      (full) => (full.length === prefixed.length ? mk(0, { [TS]: 4 }) : mk(0, { [EOT]: 50 })),
      () => sot
    );
    const out = await greedyDecodeWindow(run, prefixed, CFG);
    expect(out.noSpeechProb).toBeGreaterThan(0.99);
  });

  test('cfg.noSpeech without cfg.sot is refused rather than guessed', async () => {
    const run = scriptedDecoder(() => mk(0, { [EOT]: 50 }));
    await expect(greedyDecodeWindow(run, PROMPT, { ...CFG, sot: undefined })).rejects.toThrow(
      /requires cfg\.sot/
    );
  });

  test('a prompt that does not contain cfg.sot is refused', async () => {
    const run = scriptedDecoder(() => mk(0, { [EOT]: 50 }));
    await expect(greedyDecodeWindow(run, [22, 24], CFG)).rejects.toThrow(/is not in the prompt/);
  });

  test('a decoder returning a partial row is refused rather than mis-sliced', async () => {
    const run = async () => new Float32Array(VOCAB + 1);
    await expect(greedyDecodeWindow(run, PROMPT, CFG)).rejects.toThrow(
      /not a whole number of rows/
    );
  });

  test('sampling still reads the LAST row, not the SOT row', async () => {
    // The mirror of the tests above: the SOT row is only for noSpeechProb.
    // If sampling read it, the first sampled token would be NO_SPEECH.
    const run = scriptedDecoder(
      (full) => (full.length === PROMPT.length ? mk(0, { [TS]: 9 }) : mk(0, { [EOT]: 50 })),
      () => mk(0, { [NO_SPEECH]: 20 })
    );
    const out = await greedyDecodeWindow(run, PROMPT, CFG);
    expect(out.tokens).toEqual([TS]);
  });

  test('avgLogprob divides the summed logprobs by sampled count + 1 (openai)', async () => {
    // Two deterministic steps: ts then eot.
    const step0 = mk(0, { [TS]: 9 });
    const step1 = mk(0, { [EOT]: 9, 5: 3 });
    const run = scriptedDecoder((full) => (full.length === PROMPT.length ? step0 : step1));
    const out = await greedyDecodeWindow(run, PROMPT, CFG);
    expect(out.tokens).toEqual([TS]);
    const s0 = applyTimestampRules(applySuppress(mk(0, { [TS]: 9 }), [], CFG), [], CFG);
    const s1 = applyTimestampRules(applySuppress(mk(0, { [EOT]: 9, 5: 3 }), [TS], CFG), [TS], CFG);
    const expected = (logSoftmax(s0)[TS] + logSoftmax(s1)[EOT]) / 2;
    expect(out.avgLogprob).toBeCloseTo(expected, 10);
  });
});

describe('extractSegments (openai transcribe.py port)', () => {
  const cfg = { timestampBegin: TS };

  test('consecutive pairs split segments; the unfinished tail is discarded and re-decoded', () => {
    // <|0|> hi there <|2|> <|2|> you <|4|> then a dangling partial <|5|> a
    const tokens = [TS, 0, 1, TS + 2, TS + 2, 2, TS + 4, TS + 5, 3];
    const { segments, seekAdvanceUnits } = extractSegments(tokens, cfg, 100);
    expect(segments).toEqual([
      { startUnits: 0, endUnits: 2, tokens: [0, 1] },
      { startUnits: 2, endUnits: 4, tokens: [2] },
    ]);
    expect(seekAdvanceUnits).toBe(4); // restart at the last closed boundary
  });

  test('a single trailing timestamp closes the final segment and consumes the window', () => {
    const tokens = [TS, 0, 1, TS + 2, TS + 2, 2, TS + 6];
    const { segments, seekAdvanceUnits } = extractSegments(tokens, cfg, 100);
    expect(segments).toEqual([
      { startUnits: 0, endUnits: 2, tokens: [0, 1] },
      { startUnits: 2, endUnits: 6, tokens: [2] },
    ]);
    expect(seekAdvanceUnits).toBe(100);
  });

  test('no consecutive pair: one segment, ended by the last timestamp when present', () => {
    const { segments, seekAdvanceUnits } = extractSegments([TS, 0, 1, TS + 4], cfg, 100);
    expect(segments).toEqual([{ startUnits: 0, endUnits: 4, tokens: [0, 1] }]);
    expect(seekAdvanceUnits).toBe(100);
  });

  test('no timestamps at all: the segment spans the whole window', () => {
    const { segments, seekAdvanceUnits } = extractSegments([0, 1], cfg, 42);
    expect(segments).toEqual([{ startUnits: 0, endUnits: 42, tokens: [0, 1] }]);
    expect(seekAdvanceUnits).toBe(42);
  });

  test('empty and text-free windows produce no segments', () => {
    expect(extractSegments([], cfg, 10).segments).toEqual([]);
    expect(extractSegments([TS, TS + 2], cfg, 10).segments).toEqual([]);
  });

  test('a zero-span pair is dropped (probe: span of 0 dropped, span of 1 kept)', () => {
    const zero = extractSegments([TS + 2, 0, TS + 2, TS + 2, 1, TS + 3], cfg, 10);
    expect(zero.segments).toEqual([{ startUnits: 2, endUnits: 3, tokens: [1] }]);
  });
});

describe('compressionRatio', () => {
  test('repetition compresses better than varied text; empty is 0', () => {
    const loop = compressionRatio('la la la la la la la la la la la la la la la la');
    const varied = compressionRatio('The quick brown fox jumps over one lazy dog.');
    expect(loop).toBeGreaterThan(varied);
    expect(loop).toBeGreaterThan(2.4); // openai's hallucination threshold
    expect(compressionRatio('')).toBe(0);
  });
});
