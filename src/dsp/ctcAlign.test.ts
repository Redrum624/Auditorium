import {
  ALIGN_ACCURACY,
  ALIGN_ACCURACY_SENTENCE,
  ALIGN_FRAME_SECONDS,
  LYRICS_MATCH_THRESHOLD,
  MAX_VITERBI_CELLS,
  alignLyrics,
  forcedAlign,
  lyricsMatchVerdict,
  tokenizeLyrics,
  type TokenizedLyrics,
} from './ctcAlign';

/**
 * The model's OWN vocabulary, verbatim from the pinned
 * `facebook/wav2vec2-base-960h/vocab.json` (291 bytes, sha256 19727f89…).
 * Embedded rather than invented: `tokenizeLyrics` maps text through whatever
 * map it is handed, so a test that made up its own ids would prove nothing
 * about the sequence the graph actually scores.
 */
const VOCAB: Record<string, number> = {
  '<pad>': 0,
  '<s>': 1,
  '</s>': 2,
  '<unk>': 3,
  '|': 4,
  E: 5,
  T: 6,
  A: 7,
  O: 8,
  N: 9,
  I: 10,
  H: 11,
  S: 12,
  R: 13,
  D: 14,
  L: 15,
  U: 16,
  M: 17,
  W: 18,
  C: 19,
  F: 20,
  G: 21,
  Y: 22,
  P: 23,
  B: 24,
  V: 25,
  K: 26,
  "'": 27,
  X: 28,
  J: 29,
  Q: 30,
  Z: 31,
};
const CLASSES = 32;
const BLANK = VOCAB['<pad>'];

/**
 * A frame script: one entry per RUN of frames, naming the class that owns them.
 * `null` means the CTC blank, i.e. constructed silence.
 */
type Run = { klass: number | null; frames: number; p?: number };

/**
 * Builds an emission grid in which every frame is a proper distribution: the
 * owning class gets `p` and the remaining 31 share `1 - p`. The word boundaries
 * are therefore known BY CONSTRUCTION rather than judged — the intended path is
 * the maximum-probability one by a factor of `p / ((1-p)/31)`, which at
 * p = 0.99 is 3069:1 per frame.
 */
function buildEmissions(runs: Run[], defaultP = 0.99): { logProbs: Float32Array; frames: number } {
  const frames = runs.reduce((n, r) => n + r.frames, 0);
  const grid = new Float32Array(frames * CLASSES);
  let t = 0;
  for (const run of runs) {
    const p = run.p === undefined ? defaultP : run.p;
    const hit = Math.log(p);
    const miss = Math.log((1 - p) / (CLASSES - 1));
    const owner = run.klass === null ? BLANK : run.klass;
    for (let i = 0; i < run.frames; i++, t++) {
      for (let v = 0; v < CLASSES; v++) grid[t * CLASSES + v] = v === owner ? hit : miss;
    }
  }
  return { logProbs: grid, frames };
}

/**
 * Lays out `text` as a frame script and returns both the script and the word
 * boundaries that construction implies, so a test compares against arithmetic
 * rather than against a previous run.
 *
 * Each inter-word gap is `gapFrames` of blank, ONE frame of the `|` word
 * separator, and `gapFrames` of blank again. The separator run is not
 * decoration: `|` is a target token like any other, so a gap made only of
 * blanks forces the path to spend a frame of the preceding WORD on it and every
 * word but the last comes back one frame short. That is a property of CTC, not
 * of the aligner, and a fixture that ignores it would be testing the wrong
 * thing.
 *
 * `extraSilenceBeforeWord` inserts `extraSilenceFrames` of additional blank
 * into the gap before that word index — the displacement control's splice,
 * expressed as construction rather than as surgery on the run list.
 */
function layout(
  text: string,
  {
    framesPerChar = 3,
    gapFrames = 5,
    leadFrames = 4,
    tailFrames = 6,
    extraSilenceBeforeWord = -1,
    extraSilenceFrames = 0,
  } = {}
): { runs: Run[]; expected: { text: string; startFrame: number; endFrame: number }[] } {
  const words = text.split(/\s+/).filter(Boolean);
  const runs: Run[] = [{ klass: null, frames: leadFrames }];
  const expected: { text: string; startFrame: number; endFrame: number }[] = [];
  let t = leadFrames;
  const push = (klass: number | null, frames: number) => {
    if (frames <= 0) return;
    runs.push({ klass, frames });
    t += frames;
  };
  words.forEach((word, i) => {
    if (i > 0) {
      push(null, gapFrames);
      if (i === extraSilenceBeforeWord) push(null, extraSilenceFrames);
      push(VOCAB['|'], 1);
      push(null, gapFrames);
    }
    const startFrame = t;
    for (const ch of word.toUpperCase()) push(VOCAB[ch], framesPerChar);
    expected.push({ text: word, startFrame, endFrame: t });
  });
  push(null, tailFrames);
  return { runs, expected };
}

/**
 * {@link layout}'s frame script for `text`, with a DIFFERENT per-frame
 * confidence for each word: `ps[i]` owns word `i`'s character runs, so word `i`
 * scores about `log(ps[i])` and no two words score the same double.
 *
 * The blanks and the `|` separators keep the default confidence, so the
 * intended path still wins by construction — at the lowest confidence used
 * here the owning class still beats each of the other 31 by more than 20:1 per
 * frame.
 */
function wordConfidences(text: string, ps: number[]): Run[] {
  let word = 0;
  return layout(text).runs.map((run) => {
    if (run.klass === null) return run;
    if (run.klass === VOCAB['|']) {
      word++;
      return run;
    }
    return { ...run, p: ps[word] };
  });
}

function align(text: string, runs: Run[], p?: number) {
  const { logProbs, frames } = buildEmissions(runs, p);
  return alignLyrics(logProbs, frames, CLASSES, tokenizeLyrics(text, VOCAB), BLANK);
}

/** The spike's own deterministic shuffle, so a wrong-text control here is the
 * same kind of object the bank measured: same words, different order, EXACTLY
 * the same length. */
function shuffleWords(words: string[], seed: number): string[] {
  const a = [...words];
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

describe('tokenizeLyrics', () => {
  it('emits one separator BETWEEN words and none at either end', () => {
    const t = tokenizeLyrics('MY HEART', VOCAB);
    expect(t.tokens).toEqual([VOCAB.M, VOCAB.Y, VOCAB['|'], VOCAB.H, VOCAB.E, VOCAB.A, VOCAB.R, VOCAB.T]);
    expect(t.tokens[0]).not.toBe(VOCAB['|']);
    expect(t.tokens[t.tokens.length - 1]).not.toBe(VOCAB['|']);
  });

  it('upper-cases, and keeps the apostrophe the vocabulary actually has', () => {
    const t = tokenizeLyrics("don't", VOCAB);
    expect(t.tokens).toEqual([VOCAB.D, VOCAB.O, VOCAB.N, VOCAB["'"], VOCAB.T]);
    expect(t.droppedCharacters).toEqual([]);
  });

  it('keeps the word verbatim for display while tokenising the normalised form', () => {
    const t = tokenizeLyrics('You,', VOCAB);
    expect(t.words[0].text).toBe('You,');
    expect(t.tokens).toEqual([VOCAB.Y, VOCAB.O, VOCAB.U]);
  });

  it('reports a dropped LETTER but stays silent about punctuation', () => {
    const t = tokenizeLyrics('café, please.', VOCAB);
    expect(t.droppedCharacters).toEqual(['É']);
    expect(t.droppedWords).toEqual([]);
  });

  it('drops a word with no representable character at all, and names it', () => {
    const t = tokenizeLyrics('take 24 steps', VOCAB);
    expect(t.droppedWords).toEqual(['24']);
    expect(t.words.map((w) => w.text)).toEqual(['take', 'steps']);
    // The dropped word must not leave a separator behind, or the target would
    // ask the model to place a word boundary that is not there.
    expect(t.tokens.filter((id) => id === VOCAB['|'])).toHaveLength(1);
  });

  it('records the line each word came from', () => {
    const t = tokenizeLyrics('one two\nthree', VOCAB);
    expect(t.words.map((w) => w.line)).toEqual([0, 0, 1]);
  });
});

describe('alignLyrics on a fixture whose word boundaries are known by construction', () => {
  const TEXT = 'MY HEART WITH GRACE';

  it('places EVERY word exactly where it was constructed, last word included', () => {
    const { runs, expected } = layout(TEXT);
    const result = align(TEXT, runs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.words).toHaveLength(expected.length);
    // Asserted as the whole vector, not word 0: an aligner that is correct at
    // the first word and drifts afterwards is the expected failure mode.
    expect(result.words.map((w) => [w.text, w.startFrame, w.endFrame])).toEqual(
      expected.map((e) => [e.text, e.startFrame, e.endFrame])
    );
    const last = result.words[result.words.length - 1];
    expect(last.startFrame).toBe(expected[expected.length - 1].startFrame);
    expect(last.endFrame).toBe(expected[expected.length - 1].endFrame);
  });

  it('displacement control: 1.000 s of inserted silence moves every later word by exactly 1.000 s', () => {
    const { runs, expected } = layout(TEXT);
    const before = align(TEXT, runs);
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    // 1.000 s at the 20 ms frame period is 50 frames, exactly.
    const insertFrames = Math.round(1 / ALIGN_FRAME_SECONDS);
    expect(insertFrames).toBe(50);

    const displaced = layout(TEXT, { extraSilenceBeforeWord: 2, extraSilenceFrames: insertFrames });
    const after = align(TEXT, displaced.runs);
    expect(after.ok).toBe(true);
    if (!after.ok) return;

    const errors = after.words.map((w, i) => {
      const shift = i >= 2 ? insertFrames : 0;
      return Math.abs(w.startFrame - (before.words[i].startFrame + shift));
    });
    expect(Math.max(...errors)).toBe(0);
    // And the words BEFORE the splice did not move at all, which is the half a
    // "shifted by the right amount" assertion can pass while being wrong.
    expect(after.words.slice(0, 2).map((w) => w.startFrame)).toEqual(
      before.words.slice(0, 2).map((w) => w.startFrame)
    );
    expect(after.words[2].startFrame - before.words[2].startFrame).toBe(insertFrames);
  });

  it('span-energy control: no word span lands on a frame constructed as silence', () => {
    const { runs } = layout(TEXT, { framesPerChar: 4, gapFrames: 7, leadFrames: 9, tailFrames: 11 });
    const silent = new Set<number>();
    let t = 0;
    for (const run of runs) {
      for (let i = 0; i < run.frames; i++, t++) if (run.klass === null) silent.add(t);
    }
    const result = align(TEXT, runs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const landedOnSilence: string[] = [];
    for (const word of result.words) {
      for (let f = word.startFrame; f < word.endFrame; f++) {
        if (silent.has(f)) landedOnSilence.push(`${word.text}@${f}`);
      }
    }
    expect(landedOnSilence).toEqual([]);
    // The control is only meaningful if there WAS silence to land on:
    // lead + two blank runs per gap + tail.
    expect(silent.size).toBe(9 + 7 * 2 * 3 + 11);
  });

  it('a doubled letter costs one extra frame, and the boundary is probed on both sides', () => {
    // "SEE" needs a blank between the two Es, so its minimum is 4 frames, not 3.
    const tokens = tokenizeLyrics('SEE', VOCAB).tokens;
    const tooShort = buildEmissions([{ klass: null, frames: 3 }]);
    const exact = buildEmissions([{ klass: null, frames: 4 }]);
    expect(forcedAlign(tooShort.logProbs, tooShort.frames, CLASSES, tokens, BLANK).ok).toBe(false);
    expect(forcedAlign(exact.logProbs, exact.frames, CLASSES, tokens, BLANK).ok).toBe(true);
    // …and a word with no doubled letter needs exactly one frame per character.
    const plain = tokenizeLyrics('SET', VOCAB).tokens;
    const three = buildEmissions([{ klass: null, frames: 3 }]);
    const two = buildEmissions([{ klass: null, frames: 2 }]);
    expect(forcedAlign(two.logProbs, two.frames, CLASSES, plain, BLANK).ok).toBe(false);
    expect(forcedAlign(three.logProbs, three.frames, CLASSES, plain, BLANK).ok).toBe(true);
  });

  it('refuses empty text rather than returning an empty alignment', () => {
    const { logProbs, frames } = buildEmissions([{ klass: null, frames: 10 }]);
    const empty: TokenizedLyrics = { tokens: [], words: [], droppedWords: [], droppedCharacters: [] };
    const result = alignLyrics(logProbs, frames, CLASSES, empty, BLANK);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty-text');
  });

  it('refuses a trellis over the cell cap and accepts one exactly on it, at an injected cap', () => {
    // BELOW / ON / ABOVE, all three RUN. The real cap cannot be probed this way
    // — a trellis sitting exactly on 512 M cells is 128 MB of back-pointers and
    // half a billion DP steps — so the acceptance half used to be asserted only
    // as arithmetic in a comment, which is the "on" case missing from a
    // below/on/above rule. `forcedAlign` takes the cap as an injectable
    // parameter for exactly this reason; the DEFAULT is pinned separately
    // below, against the real constant.
    const tokens = tokenizeLyrics('SET', VOCAB).tokens; // 3 tokens
    const states = 2 * tokens.length + 1; // 7
    const frames = 6; // comfortably over the 3-frame minimum for 'SET'
    const cells = frames * states; // 42
    const grid = buildEmissions([{ klass: null, frames }]);

    for (const [name, cap, expected] of [
      ['below the cap', cells + 1, true],
      ['on the cap', cells, true],
      ['over the cap', cells - 1, false],
    ] as const) {
      const result = forcedAlign(grid.logProbs, frames, CLASSES, tokens, BLANK, cap);
      // Named in the assertion so a failure says WHICH side of the boundary
      // moved rather than just `false !== true`.
      expect(`${name}: ${result.ok}`).toBe(`${name}: ${expected}`);
      if (!result.ok) expect(result.reason).toBe('too-large');
    }
  });

  it('defaults that cap to MAX_VITERBI_CELLS, and says so in the refusal', () => {
    // The default is what production runs under, so it is pinned against the
    // real constant rather than left to the seam above. Probed one cell over
    // the real cap, which refuses without allocating anything.
    const n = 1000;
    const tokens = Array.from({ length: n }, (_, i) => 5 + (i % 26));
    const states = 2 * n + 1;
    const onCap = Math.floor(MAX_VITERBI_CELLS / states);
    // The refusal must be about the CAP, not about the audio being short.
    expect(onCap).toBeGreaterThan(n * 2);
    expect((onCap + 1) * states).toBeGreaterThan(MAX_VITERBI_CELLS);
    expect(onCap * states).toBeLessThanOrEqual(MAX_VITERBI_CELLS);

    const refused = forcedAlign(new Float32Array(0), onCap + 1, CLASSES, tokens, BLANK);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe('too-large');
    // The message quotes the limit it applied, so this pins the default's VALUE
    // and not merely that some default exists.
    expect(refused.message).toContain(MAX_VITERBI_CELLS.toLocaleString('en-US'));
    expect(refused.message).toContain(((onCap + 1) * states).toLocaleString('en-US'));
  });
});

describe('the lyrics-match gate', () => {
  it('is a >= comparison against the threshold, probed below / on / above', () => {
    expect(lyricsMatchVerdict(LYRICS_MATCH_THRESHOLD - 1e-9)).toBe('weak');
    expect(lyricsMatchVerdict(LYRICS_MATCH_THRESHOLD)).toBe('match');
    expect(lyricsMatchVerdict(LYRICS_MATCH_THRESHOLD + 1e-9)).toBe('match');
  });

  it('the threshold sits between the two things the bank measured', () => {
    // Guards the sign and the order of magnitude, so a mutation to a positive
    // value or to zero fails here rather than silently accepting everything.
    expect(LYRICS_MATCH_THRESHOLD).toBeLessThan(0);
    expect(LYRICS_MATCH_THRESHOLD).toBeGreaterThan(-9.6607); // worst no-speech row
    expect(LYRICS_MATCH_THRESHOLD).toBeLessThan(-1.3467); // worst held-out correct row
  });

  it('reads MATCH for the correct text and WEAK for the same words in a wrong order', () => {
    const TEXT = 'YOU STOLE MY HEART WITH GRACE AND I DO NOT WANT IT BACK';
    const { runs } = layout(TEXT);
    const correct = align(TEXT, runs);
    expect(correct.ok).toBe(true);
    if (!correct.ok) return;
    expect(lyricsMatchVerdict(correct.medianWordScore)).toBe('match');

    // LENGTH-MATCHED: the same words, shuffled. A longer wrong text would be
    // penalised for its length alone and would pass a broken gate.
    const shuffled = shuffleWords(TEXT.split(' '), 42).join(' ');
    expect(shuffled.split(' ')).toHaveLength(TEXT.split(' ').length);
    expect(shuffled).not.toBe(TEXT);
    const wrong = align(shuffled, runs);
    expect(wrong.ok).toBe(true);
    if (!wrong.ok) return;
    expect(lyricsMatchVerdict(wrong.medianWordScore)).toBe('weak');
    expect(wrong.medianWordScore).toBeLessThan(correct.medianWordScore);
  });

  it('takes the MEDIAN word score, not the mean, for both parities of word count', () => {
    // Every word gets its OWN per-frame confidence, so the scores are distinct.
    // This test used to run on the plain fixture, where every word scores the
    // identical double — and when all the scores are the same number the mean,
    // the median, the minimum and the maximum are all that same number, so the
    // test could not observe the statistic it is named for.
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

    // ODD — the middle value. Distinct from the mean, the smallest and the
    // largest, so a mutation to any of those fails here.
    const oddText = 'ONE TWO SIX';
    const oddResult = align(oddText, wordConfidences(oddText, [0.3, 0.7, 0.99]));
    expect(oddResult.ok).toBe(true);
    if (!oddResult.ok) return;
    const odd = oddResult.words.map((w) => w.score).sort((a, b) => a - b);
    expect(new Set(odd).size).toBe(3); // the fixture really did separate them
    expect(oddResult.medianWordScore).toBe(odd[1]);
    expect(oddResult.medianWordScore).not.toBeCloseTo(mean(odd), 2);
    expect(oddResult.medianWordScore).not.toBeCloseTo(odd[0], 2);
    expect(oddResult.medianWordScore).not.toBeCloseTo(odd[2], 2);

    // EVEN — the mean of the TWO MIDDLE values, which are themselves different
    // here, so returning either one alone fails as well.
    const evenText = 'ONE TWO SIX TEN';
    const evenResult = align(evenText, wordConfidences(evenText, [0.3, 0.7, 0.9, 0.99]));
    expect(evenResult.ok).toBe(true);
    if (!evenResult.ok) return;
    const even = evenResult.words.map((w) => w.score).sort((a, b) => a - b);
    expect(new Set(even).size).toBe(4);
    expect(evenResult.medianWordScore).toBeCloseTo((even[1] + even[2]) / 2, 12);
    expect(evenResult.medianWordScore).not.toBeCloseTo(even[1], 2);
    expect(evenResult.medianWordScore).not.toBeCloseTo(even[2], 2);
    expect(evenResult.medianWordScore).not.toBeCloseTo(mean(even), 2);
  });

  it('the path score is reported too, and is NOT the same quantity as the median word score', () => {
    const TEXT = 'MY HEART';
    // 400 frames the text does not describe, and the model is only half sure
    // they are blank. The path score is charged for every one of them; the
    // per-word score never sees them. That difference IS the bank's false
    // negative — the reference take that sings its six lines twice.
    const { runs } = layout(TEXT, { leadFrames: 200, tailFrames: 200 });
    const uncertainEnds = runs.map((r, i) => (i === 0 || i === runs.length - 1 ? { ...r, p: 0.5 } : r));
    const { logProbs, frames } = buildEmissions(uncertainEnds);
    const result = alignLyrics(logProbs, frames, CLASSES, tokenizeLyrics(TEXT, VOCAB), BLANK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.medianWordScore).toBeCloseTo(Math.log(0.99), 6);
    expect(result.pathScore).toBeLessThan(result.medianWordScore - 0.5);
    expect(result.frames).toBe(uncertainEnds.reduce((n, r) => n + r.frames, 0));
  });
});

describe('the accuracy the UI is allowed to quote (F6 Ruling 5)', () => {
  it('states the percentages it derives, rather than a second hand-typed number', () => {
    // 45/51 = 88.2 % and 20/22 = 90.9 %. Derived here the same way the sentence
    // derives them, so a change to either count moves both.
    expect(ALIGN_ACCURACY_SENTENCE).toContain(
      `${Math.round((ALIGN_ACCURACY.sung.withinWords / ALIGN_ACCURACY.sung.words) * 100)}%`
    );
    expect(ALIGN_ACCURACY_SENTENCE).toContain(
      `${Math.round((ALIGN_ACCURACY.spoken.withinWords / ALIGN_ACCURACY.spoken.words) * 100)}%`
    );
    expect(ALIGN_ACCURACY_SENTENCE).toContain(`${ALIGN_ACCURACY.sung.medianOnsetMs} ms`);
    expect(ALIGN_ACCURACY_SENTENCE).toContain(`${ALIGN_ACCURACY.sung.words} sung words`);
  });

  it('quotes the figures that were MEASURED — written out here, not recomputed from the source', () => {
    // Every expectation above derives its number from ALIGN_ACCURACY exactly
    // the way the sentence does, so moving a count moves BOTH sides and the
    // claim inflates in silence: withinWords 45 -> 51 turns "88%" into "100%"
    // with the whole suite still green. These are the bank's own numbers,
    // typed once, so changing what ships means re-typing them here.
    expect(ALIGN_ACCURACY).toEqual({
      sung: { words: 51, medianOnsetMs: 20, withinMs: 100, withinWords: 45 },
      spoken: { words: 22, medianOnsetMs: 20, withinMs: 100, withinWords: 20 },
      chunkSeconds: 30,
      chunkedOnsetMaxMs: 40,
    });
    expect(ALIGN_ACCURACY_SENTENCE).toContain('within a median 20 ms');
    expect(ALIGN_ACCURACY_SENTENCE).toContain('88% of them within 100 ms');
    expect(ALIGN_ACCURACY_SENTENCE).toContain('over 51 sung words');
    expect(ALIGN_ACCURACY_SENTENCE).toContain('91% within 100 ms');
    expect(ALIGN_ACCURACY_SENTENCE).toContain('22-word spoken control');
    // Six of the fifty-one are missed. A sentence that claimed otherwise would
    // be promising something no measurement supports.
    expect(ALIGN_ACCURACY_SENTENCE).not.toContain('100% of them');
  });

  it('names the conditions, because a figure without them reads as a field expectation', () => {
    expect(ALIGN_ACCURACY_SENTENCE).toContain('one performance by one singer');
    expect(ALIGN_ACCURACY_SENTENCE).toContain('share no training data');
  });

  it('quotes NO hand-marked figure — every one of those is an upper bound', () => {
    // The spike could not listen, so legato word boundaries with no amplitude
    // or F0 cue are absent from its ground truth. 28 ms (sung, n=7), 36 ms
    // (spoken, n=22) and 48 ms (nearest-onset, n=19) are therefore inflated by
    // an unknown amount and must not reach a user.
    for (const upperBound of ['28 ms', '36 ms', '48 ms']) {
      expect(ALIGN_ACCURACY_SENTENCE).not.toContain(upperBound);
    }
  });

  it('promises nothing about how a word was SUNG', () => {
    const lower = ALIGN_ACCURACY_SENTENCE.toLowerCase();
    for (const forbidden of ['pronunciation', 'mispronounce', 'wrong', 'grade', 'coach']) {
      expect(lower).not.toContain(forbidden);
    }
  });
});

describe('ALIGN_FRAME_SECONDS', () => {
  it('is the conv stride over the model rate, exactly', () => {
    expect(ALIGN_FRAME_SECONDS).toBe(320 / 16000);
  });
});
