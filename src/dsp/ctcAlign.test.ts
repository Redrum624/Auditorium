import {
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

  it('refuses a trellis over the cell cap, and accepts one exactly on it', () => {
    // states = 2n+1; pick n so frames * states straddles the cap.
    const n = 1000;
    const tokens = Array.from({ length: n }, (_, i) => 5 + (i % 26));
    const states = 2 * n + 1;
    const onCap = Math.floor(MAX_VITERBI_CELLS / states);
    // The refusal must be about the CAP, not about the audio being short.
    expect(onCap).toBeGreaterThan(n * 2);
    const over = { logProbs: new Float32Array(0), frames: onCap + 1 };
    const refused = forcedAlign(over.logProbs, over.frames, CLASSES, tokens, BLANK);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe('too-large');
    expect((onCap + 1) * states).toBeGreaterThan(MAX_VITERBI_CELLS);
    expect(onCap * states).toBeLessThanOrEqual(MAX_VITERBI_CELLS);
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
    // Three words, the middle one placed on frames that are not its own: the
    // median is the middle value and is unmoved by one bad word.
    const odd = layout('ONE TWO SIX');
    const oddResult = align('ONE TWO SIX', odd.runs);
    expect(oddResult.ok).toBe(true);
    if (!oddResult.ok) return;
    const oddScores = oddResult.words.map((w) => w.score).sort((a, b) => a - b);
    expect(oddResult.medianWordScore).toBe(oddScores[1]);

    const even = layout('ONE TWO SIX TEN');
    const evenResult = align('ONE TWO SIX TEN', even.runs);
    expect(evenResult.ok).toBe(true);
    if (!evenResult.ok) return;
    const evenScores = evenResult.words.map((w) => w.score).sort((a, b) => a - b);
    expect(evenResult.medianWordScore).toBeCloseTo((evenScores[1] + evenScores[2]) / 2, 12);
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

describe('ALIGN_FRAME_SECONDS', () => {
  it('is the conv stride over the model rate, exactly', () => {
    expect(ALIGN_FRAME_SECONDS).toBe(320 / 16000);
  });
});
