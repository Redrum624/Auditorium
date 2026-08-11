/**
 * CTC forced alignment — placing KNOWN text in a recording (F6).
 *
 * Pure numeric DSP: no DOM, no Electron, no `AudioContext`. The acoustic model
 * runs in `electron/alignHost.cjs` and hands this module the per-frame
 * log-probability grid; everything here is arithmetic over that grid, which is
 * why every property below can be asserted against emission grids built by
 * construction rather than against a 378 MB download.
 *
 * ## What forced alignment is, and what it is not
 *
 * The token sequence is GIVEN. A blank-extended Viterbi search finds its
 * maximum-probability placement in the frame grid and back-tracking yields the
 * frame span of every token. The model is never asked what was sung — F6's
 * spike measured this exact checkpoint free-decoding the reference sung take at
 * 47.1 % WER, more than double the Whisper the app already ships, and it still
 * placed the known words to a 20 ms cross-model median. Placing is not reading,
 * and that gap is the entire reason this feature ships while the pronunciation
 * scorer built on the same grid does not.
 *
 * ## The failure mode, stated because it is structural
 *
 * **CTC forced alignment never says "could not align".** As long as the audio
 * has more frames than the token sequence needs, a path exists and the search
 * returns it — so given the WRONG lyrics it returns a confident placement of
 * the wrong words. There is no confidence signal inside the alignment itself.
 *
 * The path score is the only handle, and it is a real one: the spike measured
 * −0.1766 nats/frame for the correct lyrics against −0.9506 for the same 51
 * words shuffled (5 seeds, length-matched so the control is not penalised for
 * its length), a 0.754 nats/frame margin. See {@link LYRICS_MATCH_THRESHOLD}
 * for what was done with that and, more importantly, for what was not.
 */

/** The word separator in the wav2vec2 character vocabulary. */
export const WORD_SEPARATOR_TOKEN = '|';

/** The CTC blank in the wav2vec2 character vocabulary. */
export const BLANK_TOKEN = '<pad>';

/**
 * Seconds per emission frame: the feature encoder's total conv stride is 320
 * samples and the model's input rate is 16 kHz, so 320/16000 = 0.02 s exactly.
 *
 * The F6 spike quotes 20.036 ms for the same quantity; that figure is
 * 11.000 s ÷ 549 frames — duration over count, which differs from the stride
 * because the conv stack's 400-sample receptive field costs the last frame.
 * The stride is what maps a frame INDEX to a time, and the spike's own aligner
 * used 0.02 s for exactly that reason.
 */
export const ALIGN_FRAME_SECONDS = 0.02;

/**
 * Upper bound on the Viterbi trellis, in cells (frames × blank-extended
 * states).
 *
 * Not a taste limit — an allocation. The back-pointer array is one entry per
 * cell, packed at 2 bits each (the arg is one of three values), so this cap is
 * 128 MB of back-pointers plus two `Float64Array(S)` rows. For scale, the
 * reference 142 s take with its 51 words needs 3.1 M cells (0.78 MB), and a
 * five-minute song with 500 words needs 82 M cells (20 MB). A request above the
 * cap is refused with the arithmetic in the message rather than being attempted
 * and killed by the allocator.
 */
export const MAX_VITERBI_CELLS = 512_000_000;

/** A word of the user's lyrics, as it will be shown and as it was tokenised. */
export interface LyricWord {
  /** Verbatim from the user's text, punctuation and case intact — this is what
   * the UI shows. The token sequence below is what the model scores. */
  text: string;
  /** 0-based line in the pasted lyrics, so the UI can lay them out as written. */
  line: number;
  /** 0-based position among the words that were tokenised. */
  index: number;
  /** Index into {@link TokenizedLyrics.tokens} of this word's first character. */
  from: number;
  /** One past this word's last character token. */
  to: number;
}

export interface TokenizedLyrics {
  /** The CTC target: character ids with `|` between words, no leading or
   * trailing separator. */
  tokens: number[];
  words: LyricWord[];
  /**
   * Words that contributed NO token and were therefore dropped — a word made
   * only of characters this 32-symbol vocabulary does not have (digits, "&",
   * accented letters). Reported rather than silently skipped: a dropped word
   * shifts nothing in the alignment but it is a word the user asked to place
   * and did not get.
   */
  droppedWords: string[];
  /**
   * Distinct SOUNDED characters this vocabulary has no id for — the "2" in
   * "24/7", the "é" in "café". Same reason: visible, not silent. Collected
   * across ALL words, including ones that ended up in `droppedWords`: a word
   * lost entirely still lost it to specific characters, and naming them is what
   * tells the user why.
   *
   * Punctuation is deliberately NOT listed. Commas, full stops and quotation
   * marks are absent from a 32-symbol phonetic vocabulary by design and are
   * dropped from every line of every lyric; reporting them would bury the one
   * case that matters — a letter or digit the model cannot represent — under a
   * notice that fires on all input.
   */
  droppedCharacters: string[];
}

export interface AlignedWord extends LyricWord {
  /** First frame the Viterbi path assigned to this word's characters. */
  startFrame: number;
  /** One past the last such frame. */
  endFrame: number;
  /**
   * Mean per-frame log-probability of this word's own characters over the
   * frames assigned to them, in nats. `0` is a perfect placement; more negative
   * is a worse fit. NOT a pronunciation score — see the module header of
   * `src/services/alignLyricsService.ts`.
   */
  score: number;
}

export type AlignFailure =
  | { ok: false; reason: 'empty-text'; message: string }
  | { ok: false; reason: 'audio-too-short'; message: string }
  | { ok: false; reason: 'too-large'; message: string }
  | { ok: false; reason: 'no-path'; message: string };

export interface AlignSuccess {
  ok: true;
  words: AlignedWord[];
  /**
   * Mean per-frame log-probability of the whole path, in nats/frame — the F6
   * spike's headline quantity. Reported because it is the number the spike
   * measured, but it is NOT the gate: it charges the text for every frame,
   * including the ones the text does not describe, and the bank measured it
   * doubting a correct lyric over a take that sings it twice.
   */
  pathScore: number;
  /**
   * Median of the per-word mean log-probability. This is the quantity
   * {@link LYRICS_MATCH_THRESHOLD} is compared against — see there for the
   * bank that chose between the two.
   */
  medianWordScore: number;
  frames: number;
}

export type AlignResult = AlignSuccess | AlignFailure;

/** Per-character span from the raw Viterbi back-track. */
export interface TokenSpan {
  token: number;
  startFrame: number;
  endFrame: number;
  score: number;
}

/**
 * Splits lyrics into words and characters the model's own vocabulary knows.
 *
 * `vocab` is the model's `vocab.json`, forwarded from the host — never rebuilt
 * here. A tokeniser that invented its own ids would align a different sequence
 * than the graph scores.
 *
 * The text is upper-cased because the checkpoint's vocabulary is upper-case;
 * every character absent from the vocabulary is dropped from the target, and
 * both kinds of loss are reported.
 */
/** Letters and digits — the characters a singer actually voices. Everything
 * else is punctuation and is normalised away without a notice (see
 * {@link TokenizedLyrics.droppedCharacters}). */
const SOUNDED_CHARACTER = /[\p{L}\p{N}]/u;

export function tokenizeLyrics(text: string, vocab: Record<string, number>): TokenizedLyrics {
  const separator = vocab[WORD_SEPARATOR_TOKEN];
  const tokens: number[] = [];
  const words: LyricWord[] = [];
  const droppedWords: string[] = [];
  const droppedCharacters: string[] = [];
  const lines = text.split(/\r?\n/);

  for (let line = 0; line < lines.length; line++) {
    for (const raw of lines[line].split(/\s+/)) {
      if (raw.length === 0) continue;
      const ids: number[] = [];
      for (const ch of raw.toUpperCase()) {
        const id = vocab[ch];
        if (id === undefined) {
          if (SOUNDED_CHARACTER.test(ch) && !droppedCharacters.includes(ch)) droppedCharacters.push(ch);
          continue;
        }
        ids.push(id);
      }
      if (ids.length === 0) {
        droppedWords.push(raw);
        continue;
      }
      if (words.length > 0 && separator !== undefined) tokens.push(separator);
      const from = tokens.length;
      for (const id of ids) tokens.push(id);
      words.push({ text: raw, line, index: words.length, from, to: tokens.length });
    }
  }

  return { tokens, words, droppedWords, droppedCharacters };
}

const NEG = -1e30;

/**
 * Blank-extended Viterbi over a GIVEN token sequence.
 *
 * `logProbs` is row-major `[frames][classes]` log-softmax. The extended state
 * sequence is `blank t0 blank t1 … blank`, transitions are stay / advance-one /
 * advance-two, and the two-step is legal only when it skips a blank between two
 * DIFFERENT tokens — that is the standard CTC constraint, and it is what forces
 * a blank frame between a doubled letter.
 *
 * Back-pointers are packed at 2 bits per cell. The arg is one of three values,
 * so a byte per cell would cost four times the memory for nothing; the packing
 * is what makes {@link MAX_VITERBI_CELLS} a 128 MB ceiling rather than a 512 MB
 * one.
 */
export function forcedAlign(
  logProbs: Float32Array,
  frames: number,
  classes: number,
  tokens: readonly number[],
  blankId: number,
  /**
   * Cell ceiling, injectable ONLY so the below/on/above boundary can be probed
   * — a trellis sitting exactly on the real cap is 512 M cells and cannot be
   * run in a test, so without this seam the "accepts one exactly on it" half of
   * the rule is unreachable. Same shape as `parseAlignRequest(req, maxSamples =
   * MAX_TOTAL_SAMPLES)` in `electron/alignManager.cjs`. Production never passes
   * it.
   */
  maxCells: number = MAX_VITERBI_CELLS
): { ok: true; spans: TokenSpan[]; pathScore: number } | AlignFailure {
  const n = tokens.length;
  if (n === 0) {
    return { ok: false, reason: 'empty-text', message: 'There are no words to align.' };
  }
  const states = 2 * n + 1;

  // Minimum frames the sequence can possibly occupy: one per token, plus one
  // forced blank between every pair of adjacent equal tokens.
  let minFrames = n;
  for (let i = 1; i < n; i++) {
    if (tokens[i] === tokens[i - 1]) minFrames++;
  }
  if (frames < minFrames) {
    return {
      ok: false,
      reason: 'audio-too-short',
      message: `The lyrics need at least ${minFrames} analysis frames (${(minFrames * ALIGN_FRAME_SECONDS).toFixed(2)} s) and the selection has ${frames} (${(frames * ALIGN_FRAME_SECONDS).toFixed(2)} s).`,
    };
  }

  const cells = frames * states;
  if (cells > maxCells) {
    return {
      ok: false,
      reason: 'too-large',
      message: `Aligning ${n} characters against ${frames} frames needs ${cells.toLocaleString('en-US')} search cells, over the ${maxCells.toLocaleString('en-US')} limit. Select a shorter passage, or paste only the lyrics for the part you selected.`,
    };
  }

  const ext = new Int32Array(states);
  for (let s = 0; s < states; s++) ext[s] = s % 2 === 0 ? blankId : tokens[(s - 1) / 2];

  const prev = new Float64Array(states).fill(NEG);
  const cur = new Float64Array(states).fill(NEG);
  const back = new Uint8Array(Math.ceil(cells / 4));

  prev[0] = logProbs[ext[0]];
  if (states > 1) prev[1] = logProbs[ext[1]];

  for (let t = 1; t < frames; t++) {
    cur.fill(NEG);
    const row = t * classes;
    const cellBase = t * states;
    for (let s = 0; s < states; s++) {
      let best = prev[s];
      let arg = 0;
      if (s >= 1 && prev[s - 1] > best) {
        best = prev[s - 1];
        arg = 1;
      }
      if (s >= 2 && ext[s] !== blankId && ext[s] !== ext[s - 2] && prev[s - 2] > best) {
        best = prev[s - 2];
        arg = 2;
      }
      if (best <= NEG) continue;
      cur[s] = best + logProbs[row + ext[s]];
      if (arg !== 0) {
        const cell = cellBase + s;
        back[cell >> 2] |= arg << ((cell & 3) * 2);
      }
    }
    prev.set(cur);
  }

  // The path may end on the final blank or on the final token.
  let endState = states - 1;
  let total = prev[states - 1];
  if (states >= 2 && prev[states - 2] > total) {
    endState = states - 2;
    total = prev[states - 2];
  }
  if (!(total > NEG)) {
    return {
      ok: false,
      reason: 'no-path',
      message: 'No alignment path exists for these lyrics over this audio.',
    };
  }

  const spans: TokenSpan[] = new Array(n);
  for (let i = 0; i < n; i++) spans[i] = { token: tokens[i], startFrame: -1, endFrame: -1, score: 0 };

  let state = endState;
  for (let t = frames - 1; t >= 0; t--) {
    if (state % 2 === 1) {
      const i = (state - 1) / 2;
      const span = spans[i];
      if (span.endFrame < 0) span.endFrame = t + 1;
      span.startFrame = t;
      span.score += logProbs[t * classes + tokens[i]];
    }
    if (t > 0) {
      const cell = t * states + state;
      state -= (back[cell >> 2] >> ((cell & 3) * 2)) & 3;
    }
  }

  for (const span of spans) {
    if (span.startFrame >= 0) span.score /= span.endFrame - span.startFrame;
  }
  const unplaced = spans.filter((s) => s.startFrame < 0).length;
  if (unplaced > 0) {
    return {
      ok: false,
      reason: 'no-path',
      message: `${unplaced} of ${n} characters could not be placed anywhere in this audio.`,
    };
  }

  return { ok: true, spans, pathScore: total / frames };
}

/**
 * Places `tokenized` in the emission grid and folds the per-character spans up
 * into per-word ones.
 *
 * A word's span runs from the first frame of its first character to the last
 * frame of its last character. Its score is the mean of its characters' scores,
 * which is the spike's own per-word quantity — kept identical so the numbers
 * measured there describe what ships.
 */
export function alignLyrics(
  logProbs: Float32Array,
  frames: number,
  classes: number,
  tokenized: TokenizedLyrics,
  blankId: number
): AlignResult {
  if (tokenized.words.length === 0) {
    return { ok: false, reason: 'empty-text', message: 'There are no words to align.' };
  }
  const placed = forcedAlign(logProbs, frames, classes, tokenized.tokens, blankId);
  if (!placed.ok) return placed;

  const words: AlignedWord[] = tokenized.words.map((word) => {
    const span = placed.spans.slice(word.from, word.to);
    let startFrame = Infinity;
    let endFrame = -Infinity;
    let score = 0;
    for (const s of span) {
      if (s.startFrame < startFrame) startFrame = s.startFrame;
      if (s.endFrame > endFrame) endFrame = s.endFrame;
      score += s.score;
    }
    return { ...word, startFrame, endFrame, score: score / span.length };
  });

  const sorted = words.map((w) => w.score).sort((a, b) => a - b);
  const medianWordScore =
    sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

  return { ok: true, words, pathScore: placed.pathScore, medianWordScore, frames };
}

/**
 * The median per-word score below which the lyrics are reported as possibly not
 * matching the audio.
 *
 * ## Where the number comes from
 *
 * The spike measured a 0.754 nats/frame path-score margin on ONE sung file and
 * 1.201 on ONE spoken one, and said in as many words that n = 2 materials
 * supports "a gate is feasible" and not an operating point.
 * `scripts/align-gate-bench.cjs` builds the bank that was missing: the real
 * recordings on disk cut into 15 passages whose text is known for the whole of
 * them, each scored against its own text and against length-matched wrong text
 * — the same words shuffled under five fixed seeds, plus another passage's
 * text at the closest word count, plus lyrics over material with no voice in it
 * at all. 16 correct rows, 103 wrong rows.
 *
 * The split is by MATERIAL, not by row: the spoken control and sung lines 1–3
 * calibrate; sung lines 4–6, the whole sung take, the partially-covered take
 * and the no-speech negatives are held out and only ever reported against.
 * Candidate thresholds are midpoints between consecutive CALIBRATION scores, so
 * no held-out value can even be selected.
 *
 * ## Why the statistic is the median per-word score and not the path score
 *
 * Both were carried through the bank. Both reach AUC 1.000 on calibration and
 * 0.998 held out. They differ on the case that matters:
 *
 * | statistic | threshold | calibration | held-out |
 * |---|---|---|---|
 * | path score        | −0.6568 | TP 8 FN 0 FP 0 TN 48 | TP 7 **FN 1** FP 1 TN 54 |
 * | median word score | −2.6799 | TP 8 FN 0 FP 0 TN 48 | TP 8 **FN 0** FP 4 TN 51 |
 *
 * The false negative is the reference 142 s take, which sings the six lines
 * TWICE. Its correct lyrics describe half of it, so the path score — a mean
 * over EVERY frame — charges them for the half they do not describe and lands
 * at −0.6998, below the threshold. The median per-word score looks only at
 * frames the words were actually placed on and lands at −0.1778, in the clear.
 * Telling a user their correct lyrics do not match their own recording is
 * exactly the confident-wrong failure this feature exists to avoid, so the
 * statistic that never does it wins.
 *
 * ## It is a WARNING, never a refusal
 *
 * Held-out is NOT separable: the wrong text closest to the line sits 0.09 nats
 * above the correct text furthest from it, and four wrong rows pass the chosen
 * threshold (three shuffles over the two-pass take, where the aligner has 70
 * spare seconds to hide a wrong word order in, and one 6-word shuffle). A gate
 * that REFUSED would eventually refuse correct work, and a gate that accepted
 * silently would eventually accept nonsense. It says what it measured and shows
 * the spans anyway, which is the rule the whole feature follows: nothing here
 * tells the user they are wrong.
 */
export const LYRICS_MATCH_THRESHOLD = -2.6799;

/**
 * What the aligner was MEASURED to do, in the numbers the UI is allowed to
 * quote — F6 Ruling 5.
 *
 * Every figure here is CROSS-MODEL: `wav2vec2-base-960h` (95 M params,
 * LibriSpeech, 32 graphemes) and `wav2vec2-lv-60-espeak-cv-ft` (317 M params,
 * multilingual CommonVoice, 392 IPA phones) were each asked to place the SAME
 * known text, and their word starts compared. Two models that share no training
 * data, no label set and no size agreeing to 20 ms is a measurement that
 * involves no hand-marking at all.
 *
 * The spike ALSO produced figures against a hand-marked ground truth (median
 * 28–48 ms). **Those are deliberately not here.** The spike could not listen to
 * the audio, so legato word boundaries — the ones with no amplitude, flux or F0
 * cue — are absent from that ground truth, which can only INFLATE the
 * hand-marked numbers. They are upper bounds, and an upper bound is not what a
 * dialog should quote.
 *
 * Frozen and exported so the dialog and the Vocal Chain stage note read from
 * ONE source: two pieces of shipped UI text describing the same measurement
 * cannot be allowed to drift apart.
 */
export const ALIGN_ACCURACY = Object.freeze({
  /** The reference sung take: 51 words, one performance, one singer. */
  sung: Object.freeze({ words: 51, medianOnsetMs: 20, withinMs: 100, withinWords: 45 }),
  /** The spoken control: 22 words. */
  spoken: Object.freeze({ words: 22, medianOnsetMs: 20, withinMs: 100, withinWords: 20 }),
  /**
   * Audio longer than the host's 30 s inference chunk is aligned in several
   * passes, and `scripts/align-context-bench.cjs` measured that about one word
   * onset in six then differs from a single-pass alignment by up to 40 ms —
   * the same order as the aligner's own precision. Stated, not hidden.
   */
  chunkSeconds: 30,
  chunkedOnsetMaxMs: 40,
});

/** Percent-within, derived from the counts above rather than re-typed. */
function withinPercent(m: { withinWords: number; words: number }): number {
  return Math.round((m.withinWords / m.words) * 100);
}

/**
 * The ONE sentence the dialog and the Vocal Chain stage note both show. Built
 * from {@link ALIGN_ACCURACY} so a change to the measurement changes both, and
 * so a test can assert the two pieces of UI carry the same claim rather than
 * comparing two hand-written strings.
 */
export const ALIGN_ACCURACY_SENTENCE =
  `Word starts land within a median ${ALIGN_ACCURACY.sung.medianOnsetMs} ms, and ` +
  `${withinPercent(ALIGN_ACCURACY.sung)}% of them within ${ALIGN_ACCURACY.sung.withinMs} ms — ` +
  `measured as the agreement between two acoustic models that share no training data, label set or ` +
  `size, over ${ALIGN_ACCURACY.sung.words} sung words of one performance by one singer. Speech is ` +
  `easier: ${withinPercent(ALIGN_ACCURACY.spoken)}% within ${ALIGN_ACCURACY.spoken.withinMs} ms on ` +
  `the ${ALIGN_ACCURACY.spoken.words}-word spoken control, so a script against a recording is a real use.`;

export type LyricsMatchVerdict = 'match' | 'weak';

/** Compares {@link AlignSuccess.medianWordScore} against
 * {@link LYRICS_MATCH_THRESHOLD}. */
export function lyricsMatchVerdict(medianWordScore: number): LyricsMatchVerdict {
  return medianWordScore >= LYRICS_MATCH_THRESHOLD ? 'match' : 'weak';
}
