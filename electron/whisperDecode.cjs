'use strict';

/**
 * Whisper autoregressive decoding (F4) — the KV-cached greedy decode loop,
 * timestamp rules and token→text/segment plumbing, as a pure module with the
 * ONNX session abstracted behind a `runDecoder` callback so unit tests drive
 * the REAL loop against a scripted decoder (the same DI discipline as
 * stemHost.cjs's injected `ort`).
 *
 * Ported from openai/whisper (MIT) `decoding.py` / `transcribe.py` /
 * `tokenizer.py`; where a rule below cites a name (ApplyTimestampRules,
 * SuppressTokens, …) it is that class's logic, not an invention. Model- and
 * tokenizer-derived constants (token ids, suppress lists,
 * max_initial_timestamp_index) come from the DOWNLOADED, sha256-pinned
 * `generation_config.json` / `tokenizer.json` — nothing here hardcodes a
 * vocabulary id.
 *
 * ## The KV cache contract (measured in the F4 spike, and pinned by test)
 *
 * The merged decoder graph (`decoder_model_merged.onnx`, optimum export) has
 * two branches selected by the `use_cache_branch` bool input:
 *   - false: `input_ids` is the whole prompt; `past_key_values.*` are empty
 *     [1, heads, 0, headDim] tensors; outputs `present.<L>.decoder.{key,value}`
 *     (self-attention KV for every position so far) and
 *     `present.<L>.encoder.{key,value}` (cross-attention KV computed from
 *     `encoder_hidden_states`).
 *   - true: `input_ids` is ONE new token; `past_key_values.<L>.decoder.*`
 *     carry the previous step's presents; `past_key_values.<L>.encoder.*`
 *     carry the FIRST step's encoder presents (cross-attention KV is constant
 *     for a window, so it is captured once and reused — optimum's own
 *     modeling code does the same).
 *
 * Equivalence of the cached and uncached paths over identical logits is the
 * correctness argument for the whole loop, and whisperDecode.test.cjs pins
 * it: N tokens decoded stepwise-with-cache must equal one-shot decoding.
 */

const zlib = require('node:zlib');

// ---------------------------------------------------------------------------
// Tokenizer (tokenizer.json → decode-only byte-level BPE)
// ---------------------------------------------------------------------------

/**
 * GPT-2 `bytes_to_unicode` (openai/gpt-2 encoder.py) — the printable-unicode
 * alias for each byte value that byte-level BPE token strings are written in.
 * Returns the INVERSE map (unicode code point → byte value) since decoding is
 * all this module does.
 */
function unicodeToBytes() {
  const bs = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n++;
    }
  }
  const map = new Map();
  for (let i = 0; i < bs.length; i++) map.set(cs[i], bs[i]);
  return map;
}

/**
 * Builds a decode-only tokenizer from the parsed `tokenizer.json` object.
 * Throws with a clear message when the file does not look like a Whisper
 * tokenizer (the manager verified its sha256, so a failure here is a
 * programming error, not a corrupt download).
 */
function createTokenizer(tokenizerJson) {
  if (!tokenizerJson || typeof tokenizerJson !== 'object' || !tokenizerJson.model || !tokenizerJson.model.vocab) {
    throw new Error('createTokenizer: not a tokenizer.json object (missing model.vocab)');
  }
  const vocab = tokenizerJson.model.vocab;
  const idToToken = new Map();
  for (const [tok, id] of Object.entries(vocab)) idToToken.set(id, tok);
  const specials = new Map(); // token string -> id, e.g. '<|startoftranscript|>' -> 50258
  for (const added of tokenizerJson.added_tokens || []) {
    specials.set(added.content, added.id);
    idToToken.set(added.id, added.content);
  }
  const inv = unicodeToBytes();
  const langIds = new Map(); // 'en' -> id of <|en|>
  for (const [content, id] of specials) {
    const m = /^<\|([a-z]{2,3})\|>$/.exec(content);
    if (m) langIds.set(m[1], id);
  }
  const sot = specials.get('<|startoftranscript|>');
  const eot = specials.get('<|endoftext|>');
  const transcribe = specials.get('<|transcribe|>');
  const translate = specials.get('<|translate|>');
  const noTimestamps = specials.get('<|notimestamps|>');
  const noSpeech = specials.get('<|nospeech|>');
  if (sot === undefined || eot === undefined || noTimestamps === undefined) {
    throw new Error('createTokenizer: tokenizer.json lacks Whisper special tokens');
  }
  return {
    idToToken,
    specials,
    langIds,
    sot,
    eot,
    transcribe,
    translate,
    noTimestamps,
    noSpeech,
    /** Timestamp tokens are every id after <|notimestamps|> (structural fact
     * of the Whisper vocab; openai tokenizer.py `timestamp_begin`). */
    timestampBegin: noTimestamps + 1,
    /** Decodes text tokens to a string; special tokens are skipped. */
    decode(ids) {
      let s = '';
      for (const id of ids) {
        if (id >= this.eot) continue; // specials + timestamps sit above eot
        const tok = this.idToToken.get(id);
        if (tok !== undefined) s += tok;
      }
      const bytes = [];
      for (const ch of s) {
        const b = inv.get(ch.codePointAt(0));
        if (b !== undefined) bytes.push(b);
      }
      return Buffer.from(bytes).toString('utf8');
    },
  };
}

// ---------------------------------------------------------------------------
// Logit helpers
// ---------------------------------------------------------------------------

/** log-softmax over a Float32Array slice; returns Float64Array. */
function logSoftmax(logits) {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i];
  let sum = 0;
  for (let i = 0; i < logits.length; i++) sum += Math.exp(logits[i] - max);
  const logSum = max + Math.log(sum);
  const out = new Float64Array(logits.length);
  for (let i = 0; i < logits.length; i++) out[i] = logits[i] - logSum;
  return out;
}

function argmax(arr) {
  let best = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] > arr[best]) best = i;
  return best;
}

/**
 * openai/whisper ApplyTimestampRules, applied IN PLACE to the last position's
 * logits before sampling. `sampled` — tokens sampled so far this window
 * (excluding the prompt). `cfg` — {timestampBegin, eot, noTimestamps,
 * maxInitialTimestampIndex}.
 */
function applyTimestampRules(logits, sampled, cfg) {
  const { timestampBegin, eot, noTimestamps, maxInitialTimestampIndex } = cfg;
  logits[noTimestamps] = -Infinity;
  const lastWasTimestamp = sampled.length >= 1 && sampled[sampled.length - 1] >= timestampBegin;
  const penultimateWasTimestamp = sampled.length < 2 || sampled[sampled.length - 2] >= timestampBegin;
  if (lastWasTimestamp) {
    if (penultimateWasTimestamp) {
      // two timestamps in a row: the pair is closed, text must follow
      for (let i = timestampBegin; i < logits.length; i++) logits[i] = -Infinity;
    } else {
      // timestamp after text: it must be paired — no plain text next
      for (let i = 0; i < eot; i++) logits[i] = -Infinity;
    }
  }
  // Timestamps must be monotonically non-decreasing across the window.
  let lastTimestamp = -1;
  for (const t of sampled) if (t >= timestampBegin) lastTimestamp = t;
  if (lastTimestamp >= 0) {
    const floor = lastWasTimestamp && !penultimateWasTimestamp ? lastTimestamp : lastTimestamp + 1;
    for (let i = timestampBegin; i < floor; i++) logits[i] = -Infinity;
  }
  if (sampled.length === 0) {
    // The first sampled token must be a timestamp, no later than
    // max_initial_timestamp (generation_config max_initial_timestamp_index).
    for (let i = 0; i < timestampBegin; i++) logits[i] = -Infinity;
    const lastAllowed = timestampBegin + maxInitialTimestampIndex;
    for (let i = lastAllowed + 1; i < logits.length; i++) logits[i] = -Infinity;
  }
  // If the total probability mass on timestamps beats every text token,
  // a timestamp must be sampled (the log-sum-exp rule).
  const lp = logSoftmax(logits);
  let tsMass = -Infinity;
  for (let i = timestampBegin; i < lp.length; i++) {
    const v = lp[i];
    if (v === -Infinity) continue;
    tsMass = tsMass === -Infinity ? v : Math.max(tsMass, v) + Math.log1p(Math.exp(-Math.abs(tsMass - v)));
  }
  let maxText = -Infinity;
  for (let i = 0; i < timestampBegin; i++) if (lp[i] > maxText) maxText = lp[i];
  if (tsMass > maxText) {
    for (let i = 0; i < timestampBegin; i++) logits[i] = -Infinity;
  }
  return logits;
}

/** openai/whisper SuppressTokens + SuppressBlank (step 0 only). */
function applySuppress(logits, sampled, cfg) {
  for (const id of cfg.suppressTokens) logits[id] = -Infinity;
  if (sampled.length === 0) {
    for (const id of cfg.beginSuppressTokens) logits[id] = -Infinity;
  }
  return logits;
}

/** gzip compression ratio of the text — openai/whisper's hallucination
 * heuristic (utils.py compression_ratio: len(text)/len(zlib(text))). */
function compressionRatio(text) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length === 0) return 0;
  return buf.length / zlib.deflateSync(buf).length;
}

// ---------------------------------------------------------------------------
// The greedy KV-cached decode loop
// ---------------------------------------------------------------------------

/**
 * Greedy-decodes one 30-second window.
 *
 * `runDecoder({tokens, useCache})` — the injected merged-decoder call:
 *   - `tokens`: number[] — the WHOLE prompt+sampled sequence when
 *     `useCache` is false, or ONLY the newest token when true.
 *   - returns Promise<Float32Array> — the logits for the LAST position
 *     ([vocab] length). The callback owns the ORT session, the KV-cache
 *     tensors and the encoder hidden state; this loop owns WHICH branch is
 *     requested, so the cache choreography above stays testable.
 *
 * `cfg`: {timestampBegin, eot, noTimestamps, maxInitialTimestampIndex,
 *         suppressTokens, beginSuppressTokens, noSpeech, maxNewTokens,
 *         useKvCache (default true)}.
 *
 * Returns {tokens (sampled, WITHOUT prompt/eot), avgLogprob, noSpeechProb}.
 */
async function greedyDecodeWindow(runDecoder, prompt, cfg) {
  const useKv = cfg.useKvCache !== false;
  const sampled = [];
  let sumLogprob = 0;
  let noSpeechProb = 0;
  for (let step = 0; step < cfg.maxNewTokens; step++) {
    let logits;
    if (useKv) {
      logits = await runDecoder({
        tokens: step === 0 ? prompt.slice() : [sampled[sampled.length - 1]],
        useCache: step > 0,
      });
    } else {
      logits = await runDecoder({ tokens: prompt.concat(sampled), useCache: false });
    }
    if (step === 0 && cfg.noSpeech !== undefined) {
      // P(<|nospeech|>) at the transcription start (openai: probs_at_sot) —
      // measured on the RAW logits, before any suppression edits.
      const lp = logSoftmax(logits);
      noSpeechProb = Math.exp(lp[cfg.noSpeech]);
    }
    applySuppress(logits, sampled, cfg);
    applyTimestampRules(logits, sampled, cfg);
    const lp = logSoftmax(logits);
    const next = argmax(lp);
    sumLogprob += lp[next];
    if (next === cfg.eot) break;
    sampled.push(next);
  }
  // openai: avg over len(tokens) + 1 (the eot counts, sampled tokens do).
  const avgLogprob = sumLogprob / (sampled.length + 1);
  return { tokens: sampled, avgLogprob, noSpeechProb };
}

// ---------------------------------------------------------------------------
// Segment extraction + the seek rule (openai/whisper transcribe.py)
// ---------------------------------------------------------------------------

/**
 * Splits one window's sampled tokens into timestamped segments and computes
 * how far the seek pointer advances, in timestamp UNITS (multiply by
 * WHISPER_SAMPLES_PER_TOKEN for samples).
 *
 * Returns {segments: [{startUnits, endUnits, tokens}], seekAdvanceUnits}
 * where units are 0.02 s ticks relative to the window start and
 * `seekAdvanceUnits` is `windowUnits` (whole window) unless the window ended
 * with a final consecutive-timestamp boundary, in which case decoding stops
 * there and the next window starts at that boundary.
 */
function extractSegments(tokens, cfg, windowUnits) {
  const { timestampBegin } = cfg;
  const n = tokens.length;
  const isTs = tokens.map((t) => t >= timestampBegin);
  // openai: single_timestamp_ending = timestamp_tokens[-2:] == [False, True]
  const singleTimestampEnding = n >= 2 && !isTs[n - 2] && isTs[n - 1];
  // "consecutive": positions i where tokens[i-1] and tokens[i] are both
  // timestamps — each is a segment boundary (end of one pair, start of next).
  const boundaries = [];
  for (let i = 1; i < n; i++) {
    if (isTs[i] && isTs[i - 1]) boundaries.push(i);
  }
  const segments = [];
  if (boundaries.length > 0) {
    const slices = boundaries.slice();
    // A single (unpaired) trailing timestamp closes the final segment — there
    // is no speech after it, so the whole tail is consumed too.
    if (singleTimestampEnding) slices.push(n);
    let sliceStart = 0;
    for (const b of slices) {
      segments.push(sliceFromTokens(tokens.slice(sliceStart, b), timestampBegin));
      sliceStart = b;
    }
    if (singleTimestampEnding) {
      return { segments: segments.filter(Boolean), seekAdvanceUnits: windowUnits };
    }
    // Otherwise the tokens after the LAST boundary are an unfinished segment:
    // openai discards them and restarts the next window at that boundary.
    const lastEnd = tokens[sliceStart - 1] - timestampBegin;
    return { segments: segments.filter(Boolean), seekAdvanceUnits: lastEnd };
  }
  // No consecutive pair: one segment spanning the window's speech; its end is
  // the last timestamp when one exists (and is not the window start), else
  // the full window.
  let lastTs = -1;
  for (let i = 0; i < n; i++) if (isTs[i]) lastTs = tokens[i] - timestampBegin;
  const seg = sliceFromTokens(tokens, timestampBegin, lastTs > 0 ? lastTs : windowUnits);
  return { segments: seg ? [seg] : [], seekAdvanceUnits: windowUnits };
}

/** One segment from a [ts, text..., ts?] token slice; null when empty. */
function sliceFromTokens(slice, timestampBegin, fallbackEndUnits) {
  if (slice.length === 0) return null;
  const startUnits = slice[0] >= timestampBegin ? slice[0] - timestampBegin : 0;
  let endUnits = fallbackEndUnits;
  const last = slice[slice.length - 1];
  if (slice.length > 1 && last >= timestampBegin) endUnits = last - timestampBegin;
  if (endUnits === undefined || endUnits === null) endUnits = startUnits;
  const text = slice.filter((t) => t < timestampBegin);
  if (text.length === 0) return null;
  if (endUnits <= startUnits) return null; // zero/negative span carries no audio
  return { startUnits, endUnits, tokens: text };
}

module.exports = {
  unicodeToBytes,
  createTokenizer,
  logSoftmax,
  argmax,
  applyTimestampRules,
  applySuppress,
  compressionRatio,
  greedyDecodeWindow,
  extractSegments,
};
