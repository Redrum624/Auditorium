import {
  ALIGN_ACCURACY,
  ALIGN_MODEL_BYTES,
  ALIGN_SAMPLE_RATE,
  MAX_ALIGN_SAMPLES,
  MEASURED_ALIGN_REALTIME_FACTOR,
  REPLACE_WORD_UNDO_LABEL,
  _resetAlignmentsForTest,
  _setAlignStaleWatchForTest,
  alignDocumentLyrics,
  alignRegion,
  cancelAlignment,
  ensureAlignModels,
  frameToDocSample,
  getAlignBusyCount,
  getAlignModelState,
  getLyricsAlignment,
  invalidateLyricsAlignment,
  isAligning,
  isLyricsAlignmentStale,
  loadLyricsFile,
  monoRegion,
  previewWord,
  replaceWord,
  wordGaps,
  type AlignProgress,
} from './alignLyricsService';
import { LYRICS_MATCH_THRESHOLD } from '../dsp/ctcAlign';
import { deriveSeamSamples } from '../dsp/wordSplice';
import { playbackEngine } from '../audio/PlaybackEngine';
import { createDocument, docLength } from '../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { getHistory, undo } from './undoHistory';

// ---------------------------------------------------------------------------
// The fixture: an emission grid whose word spans are known BY CONSTRUCTION, and
// a document whose audio is built to match those spans exactly.
//
// The document runs at the model's own 16 kHz, so one frame is exactly 320
// document samples and every expected position below is arithmetic rather than
// a number read off a previous run. A second rate is exercised separately.
// ---------------------------------------------------------------------------

const SR = ALIGN_SAMPLE_RATE;
const FRAME_SAMPLES = 320;

/** The model's OWN vocabulary, verbatim from the pinned
 * `facebook/wav2vec2-base-960h/vocab.json` — the same map `ctcAlign.test.ts`
 * embeds, and for the same reason: a tokeniser handed invented ids would align
 * a different sequence than the graph scores. */
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

type Run = { klass: number | null; frames: number; p?: number };

/** Every frame is a proper distribution: the owning class takes `p`, the other
 * 31 share `1 - p`. At p = 0.99 the intended path beats any other by 3069:1 per
 * frame, so the placement is construction, not luck. A run may carry its OWN
 * `p`, which is how the path score and the median word score are driven apart
 * (`ctcAlign.test.ts` uses the same seam, for the same reason). */
function buildEmissions(runs: Run[], defaultP = 0.99): Float32Array {
  const frames = runs.reduce((n, r) => n + r.frames, 0);
  const grid = new Float32Array(frames * CLASSES);
  let t = 0;
  for (const run of runs) {
    const p = run.p === undefined ? defaultP : run.p;
    const hit = Math.log(p);
    const miss = Math.log((1 - p) / (CLASSES - 1));
    const owner = run.klass ?? VOCAB['<pad>'];
    for (let i = 0; i < run.frames; i++, t++) {
      for (let v = 0; v < CLASSES; v++) grid[t * CLASSES + v] = v === owner ? hit : miss;
    }
  }
  return grid;
}

/** The same frame script with ONE confidence for the frames the lyrics
 * describe and another for every frame they do not (lead, gaps, separators,
 * tail). `pathScore` is charged for all of them; `medianWordScore` sees only
 * the first kind — so these two knobs move the two quantities independently. */
function withSplitConfidence(runs: Run[], wordP: number, restP: number): Run[] {
  return runs.map((r) => ({
    ...r,
    p: r.klass !== null && r.klass !== VOCAB['|'] ? wordP : restP,
  }));
}

/**
 * `text` laid out as a frame script, with the word boundaries construction
 * implies. Each gap is blank / the `|` separator / blank — the separator is a
 * target token like any other, and a gap made only of blanks would force the
 * preceding word to spend one of its own frames on it.
 */
function layout(
  text: string,
  { framesPerChar = 10, gapFrames = 5, leadFrames = 15, tailFrames = 15 } = {}
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

/** The three-word fixture every alignment test below shares. Two characters per
 * word at 10 frames each, so each word is exactly 20 frames = 6400 samples. */
const TEXT = 'At in on';
const LAYOUT = layout(TEXT);
const TOTAL_FRAMES = LAYOUT.runs.reduce((n, r) => n + r.frames, 0);
const TOTAL_SAMPLES = TOTAL_FRAMES * FRAME_SAMPLES;

function tone(lengthSamples: number, freqHz: number, amplitude = 0.5, rate = SR): Float32Array {
  const out = new Float32Array(lengthSamples);
  for (let i = 0; i < lengthSamples; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / rate);
  return out;
}

/** Quiet room tone, so a trim has a floor to find and `measureNoiseWindow` has
 * something above digital silence to measure. Deterministic. */
function roomTone(lengthSamples: number, amplitude = 1e-4, seed = 12345): Float32Array {
  const out = new Float32Array(lengthSamples);
  let s = seed;
  for (let i = 0; i < lengthSamples; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((s / 0x7fffffff) * 2 - 1) * amplitude;
  }
  return out;
}

/**
 * A document whose audio matches {@link LAYOUT}: room tone everywhere, with a
 * tone burst filling each word's constructed span. A replacement can therefore
 * be spliced over a real word and the result measured.
 */
function fixtureAudio(): Float32Array {
  const out = roomTone(TOTAL_SAMPLES);
  const freqs = [330, 220, 440];
  LAYOUT.expected.forEach((w, i) => {
    const start = w.startFrame * FRAME_SAMPLES;
    const length = (w.endFrame - w.startFrame) * FRAME_SAMPLES;
    out.set(tone(length, freqs[i]), start);
  });
  return out;
}

/** A fresh take of one word: room tone, the word, room tone. Long enough on
 * both sides for the 500 ms noise window the trim's threshold comes from. */
function makeTake(freqHz = 260, soundSeconds = 0.4, padSeconds = 0.6, rate = SR): Float32Array {
  const pad = Math.round(padSeconds * rate);
  const sound = Math.round(soundSeconds * rate);
  const out = roomTone(pad * 2 + sound, 1e-4, 777);
  out.set(tone(sound, freqHz, 0.5, rate), pad);
  return out;
}

// ---------------------------------------------------------------------------
// The preload double
// ---------------------------------------------------------------------------

interface Bridge {
  alignModelState: jest.Mock;
  alignEnsureModels: jest.Mock;
  onAlignModelProgress: jest.Mock;
  alignRun: jest.Mock;
  alignCancel: jest.Mock;
  onAlignProgress: jest.Mock;
  showMessageBox: jest.Mock;
  showOpenDialog: jest.Mock;
  readFile: jest.Mock;
}

let bridge: Bridge;
let progressListeners: ((p: { done: number; total: number }) => void)[] = [];

function gridResponse(runs: Run[] = LAYOUT.runs, p = 0.99) {
  const grid = buildEmissions(runs, p);
  const frames = runs.reduce((n, r) => n + r.frames, 0);
  return {
    ok: true as const,
    frames,
    classes: CLASSES,
    frameSamples: FRAME_SAMPLES,
    vocab: VOCAB,
    logProbs: grid.buffer.slice(0) as ArrayBuffer,
  };
}

function installBridge(): void {
  progressListeners = [];
  bridge = {
    alignModelState: jest.fn(async () => ({ downloaded: true, bytes: ALIGN_MODEL_BYTES, expectedBytes: ALIGN_MODEL_BYTES })),
    alignEnsureModels: jest.fn(async () => ({ ok: true as const })),
    onAlignModelProgress: jest.fn(() => () => {}),
    alignRun: jest.fn(async () => gridResponse()),
    alignCancel: jest.fn(async () => ({ cancelled: true })),
    onAlignProgress: jest.fn((cb: (p: { done: number; total: number }) => void) => {
      progressListeners.push(cb);
      return () => {
        progressListeners = progressListeners.filter((l) => l !== cb);
      };
    }),
    showMessageBox: jest.fn(async () => 0),
    showOpenDialog: jest.fn(async () => null),
    readFile: jest.fn(async () => new ArrayBuffer(0)),
  };
  (window as unknown as { electronAPI?: unknown }).electronAPI = bridge;
}

function seedDoc(channels: Float32Array[] = [fixtureAudio()], sampleRate = SR): string {
  const doc = createDocument({ name: 'take.wav', sampleRate, channels });
  useAppStore.getState().addDocument(doc);
  return doc.id;
}

function activeDoc() {
  const s = useAppStore.getState();
  return s.documents.find((d) => d.id === s.activeDocumentId)!;
}

/** Replaces the document's channel ARRAYS with copies of the same samples. The
 * audio is unchanged; the identity is not, which is exactly this repo's
 * "has the audio changed" test (`peaksCache.ts:16-22`). */
function touchAudio(docId: string): void {
  const doc = useAppStore.getState().documents.find((d) => d.id === docId)!;
  useAppStore.getState().updateDocument({ ...doc, channels: doc.channels.map((c) => Float32Array.from(c)) });
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetAlignmentsForTest();
  _setAlignStaleWatchForTest(true);
  installBridge();
});

afterEach(() => {
  jest.restoreAllMocks();
  _resetAlignmentsForTest();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

// ---------------------------------------------------------------------------
// Position arithmetic
// ---------------------------------------------------------------------------

describe('frameToDocSample', () => {
  it('scales a frame into the document rate and offsets it by the region start', () => {
    // 5 frames = 1600 model samples; at 48 kHz that is 4800 document samples.
    expect(frameToDocSample(5, FRAME_SAMPLES, 48000, 0, 1_000_000)).toBe(4800);
    expect(frameToDocSample(5, FRAME_SAMPLES, 48000, 1000, 1_000_000)).toBe(5800);
    // …and at the model's own rate a frame is exactly its stride.
    expect(frameToDocSample(5, FRAME_SAMPLES, SR, 0, 1_000_000)).toBe(1600);
  });

  // The scaling is rounded to the NEAREST sample, not truncated, and there is a
  // rate where that is observable. 320 x 11025/16000 = 220.5 exactly, so every
  // ODD frame of an 11025 Hz document lands on a half-sample; truncating would
  // put all of them 0.5 samples early, biased consistently in one direction.
  // Every other rate this app produces is a multiple of 50, where 320 x r/16000
  // is a whole number and the two agree — which is why this case has to be
  // written down rather than assumed covered.
  it.each([
    [1, 221],
    [3, 662],
    [5, 1103],
  ])('rounds to the nearest sample at a rate where truncating differs: frame %s', (frame, expected) => {
    expect(320 * (11025 / 16000) * frame).toBe(expected - 0.5);
    expect(frameToDocSample(frame, FRAME_SAMPLES, 11025, 0, 1_000_000)).toBe(expected);
  });

  // Both clamps probed BELOW / ON / ABOVE, sized so the boundary can move the
  // answer: the last frame's span reaches one stride past the region, which is
  // a span nothing can play or splice.
  it.each([
    ['below the region end', 3, 960 + 100, 960],
    ['on the region end', 3, 960, 960],
    ['above the region end', 4, 960, 960],
  ])('clamps at the top: %s', (_name, frame, regionEnd, expected) => {
    expect(frameToDocSample(frame, FRAME_SAMPLES, SR, 0, regionEnd)).toBe(expected);
  });

  it.each([
    ['above the region start', 1, 200, 520],
    ['on the region start', 0, 200, 200],
    ['below the region start', -1, 200, 200],
  ])('clamps at the bottom: %s', (_name, frame, regionStart, expected) => {
    expect(frameToDocSample(frame, FRAME_SAMPLES, SR, regionStart, 1_000_000)).toBe(expected);
  });
});

describe('alignRegion', () => {
  const doc = createDocument({ name: 'x', sampleRate: SR, channels: [new Float32Array(1000)] });

  it('is the whole document when there is no selection', () => {
    expect(alignRegion(doc, null)).toEqual({ start: 0, end: 1000 });
  });

  it('is the selection when there is one', () => {
    expect(alignRegion(doc, { start: 100, end: 400 })).toEqual({ start: 100, end: 400 });
  });

  it('clamps a selection that runs past the document', () => {
    expect(alignRegion(doc, { start: -50, end: 5000 })).toEqual({ start: 0, end: 1000 });
  });

  it('falls back to the whole document when the selection is empty', () => {
    expect(alignRegion(doc, { start: 400, end: 400 })).toEqual({ start: 0, end: 1000 });
  });
});

describe('monoRegion', () => {
  it('averages the channels over the region and nothing outside it', () => {
    const a = Float32Array.from([1, 2, 3, 4, 5]);
    const b = Float32Array.from([3, 4, 5, 6, 7]);
    expect(Array.from(monoRegion([a, b], 1, 4))).toEqual([3, 4, 5]);
  });

  it('returns a single channel unchanged, without dividing by one', () => {
    const a = Float32Array.from([0.25, -0.5, 0.75]);
    expect(Array.from(monoRegion([a], 0, 3))).toEqual([0.25, -0.5, 0.75]);
  });
});

// ---------------------------------------------------------------------------
// alignDocumentLyrics
// ---------------------------------------------------------------------------

describe('alignDocumentLyrics — refusals, every one of them before any inference', () => {
  it('refuses empty text without asking the host for a grid', async () => {
    seedDoc();
    const result = await alignDocumentLyrics({ docId: activeDoc().id, text: '   \n  ' });
    expect(result).toMatchObject({ ok: false, status: 'empty-text' });
    expect(bridge.alignRun).not.toHaveBeenCalled();
  });

  it('refuses a document that is not open', async () => {
    const result = await alignDocumentLyrics({ docId: 'nope', text: TEXT });
    expect(result).toMatchObject({ ok: false, status: 'no-document' });
    expect(bridge.alignRun).not.toHaveBeenCalled();
  });

  it('refuses an empty document', async () => {
    seedDoc([new Float32Array(0)]);
    const result = await alignDocumentLyrics({ docId: activeDoc().id, text: TEXT });
    expect(result).toMatchObject({ ok: false, status: 'empty-document' });
  });

  it('refuses more audio than the host would accept, and accepts the cap itself', async () => {
    // The renderer's cap MUST match the host's or a job accepted here is
    // refused at the trust boundary with an opaque message. Probed on the
    // boundary and one sample over it, at the model's own rate so the two are
    // the same number.
    const onCap = seedDoc([new Float32Array(MAX_ALIGN_SAMPLES)]);
    useAppStore.getState().setActiveDocument(onCap);
    const ok = await alignDocumentLyrics({ docId: onCap, text: TEXT });
    expect(ok.ok).toBe(true);

    const over = seedDoc([new Float32Array(MAX_ALIGN_SAMPLES + 1)]);
    useAppStore.getState().setActiveDocument(over);
    const refused = await alignDocumentLyrics({ docId: over, text: TEXT });
    expect(refused).toMatchObject({ ok: false, status: 'too-long' });
  });

  it('refuses when the model has not been downloaded, and says so as a download state', async () => {
    bridge.alignModelState.mockResolvedValue({ downloaded: false, bytes: null, expectedBytes: ALIGN_MODEL_BYTES });
    seedDoc();
    const result = await alignDocumentLyrics({ docId: activeDoc().id, text: TEXT });
    expect(result).toMatchObject({ ok: false, status: 'model-missing' });
    expect(bridge.alignRun).not.toHaveBeenCalled();
  });

  it('refuses a second run while one is in flight, rather than queueing it', async () => {
    seedDoc();
    let release: () => void = () => {};
    // Resolves once the host has actually been ASKED for a grid, so the
    // release below cannot fire before the mock has handed one out.
    const reachedHost = new Promise<void>((seen) => {
      bridge.alignRun.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => resolve(gridResponse());
            seen();
          })
      );
    });
    const first = alignDocumentLyrics({ docId: activeDoc().id, text: TEXT });
    // Set SYNCHRONOUSLY, before the first await — two calls in the same tick
    // cannot both pass the gate.
    expect(isAligning()).toBe(true);
    expect(getAlignBusyCount()).toBe(1);
    const second = await alignDocumentLyrics({ docId: activeDoc().id, text: TEXT });
    expect(second).toMatchObject({ ok: false, status: 'busy' });
    await reachedHost;
    // Exactly one job reached the host: the refusal was a refusal, not a queue.
    expect(bridge.alignRun).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(getAlignBusyCount()).toBe(0);
  });
});

describe('alignDocumentLyrics — the placement it stores', () => {
  it('places EVERY word where the grid was constructed to put it, last word included', async () => {
    const docId = seedDoc();
    const result = await alignDocumentLyrics({ docId, text: TEXT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Asserted for every word — a loop pinned only on its first element pins
    // the loop's existence, not its extent, and drift after word 1 is the
    // expected failure mode for an aligner.
    expect(result.alignment.words).toHaveLength(LAYOUT.expected.length);
    LAYOUT.expected.forEach((want, i) => {
      const got = result.alignment.words[i];
      expect(got.text).toBe(want.text);
      expect(got.startSample).toBe(want.startFrame * FRAME_SAMPLES);
      expect(got.endSample).toBe(want.endFrame * FRAME_SAMPLES);
    });
    // …and named explicitly for the LAST one, so a regression that stopped
    // early could not pass by shortening the array.
    const last = result.alignment.words[result.alignment.words.length - 1];
    expect(last.text).toBe('on');
    expect(last.startSample).toBe(LAYOUT.expected[2].startFrame * FRAME_SAMPLES);
  });

  it('sends the SELECTION’s audio to the host, and offsets every position by it', async () => {
    // The selection is the feature's principal input, and pinning only the
    // POSITIONS cannot observe it: `regionStart` and every `startSample` come
    // from `region.start/end` through `frameToDocSample`, a path that never
    // touches the audio that was actually sent. So the request payload is
    // asserted here, sized so both ways of getting it wrong are observable:
    //
    //   • the lead is longer than the 30 s inference chunk, so a run over the
    //     WHOLE FILE reports `chunked` where a run over the selection does not;
    //   • the lead is a tone the fixture never contains, so a payload of the
    //     right LENGTH taken from the wrong offset differs sample for sample.
    //
    // Verified by mutation: `monoRegion(doc.channels, 0, docLength(doc))` in
    // place of the region call passed the whole suite before this.
    const LEAD = ALIGN_ACCURACY.chunkSeconds * SR + FRAME_SAMPLES; // 480,320 — over the chunk
    const selected = fixtureAudio();
    const audio = new Float32Array(LEAD + TOTAL_SAMPLES);
    audio.set(tone(LEAD, 110), 0);
    audio.set(selected, LEAD);
    const docId = seedDoc([audio]);
    useAppStore.getState().setSelection({ start: LEAD, end: LEAD + TOTAL_SAMPLES });

    const result = await alignDocumentLyrics({ docId, text: TEXT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The payload IS the selection: its rate label, its length, and its samples.
    expect(bridge.alignRun).toHaveBeenCalledTimes(1);
    const request = bridge.alignRun.mock.calls[0][0] as { sampleRate: number; samples: ArrayBuffer };
    expect(request.sampleRate).toBe(ALIGN_SAMPLE_RATE);
    const sent = new Float32Array(request.samples);
    expect(sent).toHaveLength(TOTAL_SAMPLES);
    expect(sent.length).toBeLessThan(audio.length); // …and not the file's
    // The document runs at the model's own rate, so the resample is an exact
    // copy and this is an equality, not a tolerance.
    expect(sent).toEqual(selected);

    // …and the run is single-pass, which ONLY the selection is: the file itself
    // is longer than the chunk, so the flag would flip if the file were sent.
    expect(audio.length).toBeGreaterThan(ALIGN_ACCURACY.chunkSeconds * SR);
    expect(result.alignment.chunked).toBe(false);

    // …and every position is a DOCUMENT position, offset by the region.
    expect(result.alignment.regionStart).toBe(LEAD);
    expect(result.alignment.regionEnd).toBe(LEAD + TOTAL_SAMPLES);
    LAYOUT.expected.forEach((want, i) => {
      expect(result.alignment.words[i].startSample).toBe(LEAD + want.startFrame * FRAME_SAMPLES);
    });
  });

  it('reports the words the vocabulary could not represent instead of dropping them silently', async () => {
    const docId = seedDoc();
    const result = await alignDocumentLyrics({ docId, text: 'At 24, in caf\u00e9 on' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // '24' contributed no token at all, so it is a dropped WORD\u2026
    expect(result.alignment.droppedWords).toEqual(['24,']);
    // \u2026and every SOUNDED character this 32-symbol alphabet has no id for is
    // named too, whether its word survived ('\u00c9' in caf\u00e9) or not (the digits).
    expect(result.alignment.droppedCharacters).toEqual(['2', '4', '\u00c9']);
    // Punctuation is deliberately absent: it is dropped from every line of
    // every lyric, so listing it would bury the two cases above.
    expect(result.alignment.droppedCharacters).not.toContain(',');
  });

  // The 30 s inference chunk, probed BELOW / ON / ABOVE. Sized so the boundary
  // can move the answer: one frame either side of the chunk is 320 samples, and
  // the flag is what tells the user about the measured 40 ms multi-pass
  // residual, so a stuck flag either hides that or invents it.
  it.each([
    ['below the chunk', -1, false],
    ['on the chunk', 0, false],
    ['above the chunk', 1, true],
  ])('reports whether the run needed more than one inference pass: %s', async (_name, frameDelta, expected) => {
    const chunkFrames = (ALIGN_ACCURACY.chunkSeconds * SR) / FRAME_SAMPLES; // 1500
    const frames = chunkFrames + frameDelta;
    // One word over a grid of exactly that many frames: blank, the word, blank.
    const runs: Run[] = [
      { klass: null, frames: 5 },
      { klass: VOCAB.A, frames: 10 },
      { klass: VOCAB.T, frames: 10 },
      { klass: null, frames: frames - 25 },
    ];
    const docId = seedDoc([new Float32Array(frames * FRAME_SAMPLES)]);
    bridge.alignRun.mockResolvedValue(gridResponse(runs));
    const result = await alignDocumentLyrics({ docId, text: 'At' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alignment.chunked).toBe(expected);
  });

  it('stores the alignment under the document and reports it as fresh', async () => {
    const docId = seedDoc();
    await alignDocumentLyrics({ docId, text: TEXT });
    expect(getLyricsAlignment(docId)).not.toBeNull();
    expect(isLyricsAlignmentStale(docId)).toBe(false);
  });

  it('marks the alignment stale when the audio changes under it, and keeps it', async () => {
    const docId = seedDoc();
    await alignDocumentLyrics({ docId, text: TEXT });
    // Any other edit replaces the channel arrays — this repo's identity test.
    touchAudio(docId);
    expect(isLyricsAlignmentStale(docId)).toBe(true);
    expect(getLyricsAlignment(docId)).not.toBeNull();
  });

  it('drops the alignment when the document closes', async () => {
    const docId = seedDoc();
    await alignDocumentLyrics({ docId, text: TEXT });
    invalidateLyricsAlignment(docId);
    expect(getLyricsAlignment(docId)).toBeNull();
  });
});

describe('alignDocumentLyrics — the lyrics-match warning', () => {
  /** Drives the median per-word score by flattening the grid's confidence: at
   * `p` per owning frame, every word's mean log-probability is exactly
   * `log(p)`, so the median is too and the threshold can be probed exactly. */
  async function verdictAtWordScore(score: number) {
    const docId = seedDoc();
    bridge.alignRun.mockResolvedValue(gridResponse(LAYOUT.runs, Math.exp(score)));
    const result = await alignDocumentLyrics({ docId, text: TEXT });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    return result.alignment;
  }

  it('reads MATCH on the threshold and above it, and WEAK below — probed on all three', async () => {
    const eps = 0.01;
    const below = await verdictAtWordScore(LYRICS_MATCH_THRESHOLD - eps);
    expect(below.medianWordScore).toBeCloseTo(LYRICS_MATCH_THRESHOLD - eps, 4);
    expect(below.verdict).toBe('weak');

    const on = await verdictAtWordScore(LYRICS_MATCH_THRESHOLD);
    expect(on.medianWordScore).toBeCloseTo(LYRICS_MATCH_THRESHOLD, 4);
    expect(on.verdict).toBe('match');

    const above = await verdictAtWordScore(LYRICS_MATCH_THRESHOLD + eps);
    expect(above.medianWordScore).toBeCloseTo(LYRICS_MATCH_THRESHOLD + eps, 4);
    expect(above.verdict).toBe('match');
  });

  it('still returns the spans when the verdict is weak — it warns, it never refuses', async () => {
    // Still a valid grid: the owning class must stay the per-frame maximum,
    // which needs p > 1/32, i.e. a word score above log(1/32) = -3.466.
    const weak = await verdictAtWordScore(LYRICS_MATCH_THRESHOLD - 0.5);
    expect(weak.verdict).toBe('weak');
    expect(weak.words).toHaveLength(LAYOUT.expected.length);
    LAYOUT.expected.forEach((want, i) => {
      expect(weak.words[i].startSample).toBe(want.startFrame * FRAME_SAMPLES);
    });
  });

  /** Aligns TEXT against an arbitrary frame script, over a document long
   * enough to hold it, and hands back the stored alignment. */
  async function alignRuns(runs: Run[]) {
    const frames = runs.reduce((n, r) => n + r.frames, 0);
    const docId = seedDoc([roomTone(frames * FRAME_SAMPLES)]);
    bridge.alignRun.mockResolvedValue(gridResponse(runs));
    const result = await alignDocumentLyrics({ docId, text: TEXT });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    return result.alignment;
  }

  it('reads the median and NOT the path score, in both directions where they disagree', async () => {
    // The path score is charged for every frame, including the ones the lyrics
    // do not describe; the median never sees them. Reading the path score
    // instead is the swap `ctcAlign.ts` documents as producing a false "these
    // lyrics don't match" on a correct take, so BOTH arms are probed here.

    // Quiet words inside confident silence: the median is below the threshold
    // and the path score is above it. The verdict must follow the median.
    const quietWords = await alignRuns(withSplitConfidence(LAYOUT.runs, 0.05, 0.99));
    expect(quietWords.medianWordScore).toBeCloseTo(Math.log(0.05), 4);
    expect(quietWords.medianWordScore).toBeLessThan(LYRICS_MATCH_THRESHOLD);
    expect(quietWords.pathScore).toBeGreaterThan(LYRICS_MATCH_THRESHOLD);
    expect(quietWords.verdict).toBe('weak');

    // …and the mirror: confident words adrift in a long, uncertain silence.
    // The median says match, the path score says weak — this is the bank's own
    // false negative, the take that sings its six lines twice.
    const spacious = layout(TEXT, { leadFrames: 200, tailFrames: 200 });
    const loudWords = await alignRuns(withSplitConfidence(spacious.runs, 0.99, 0.035));
    expect(loudWords.medianWordScore).toBeCloseTo(Math.log(0.99), 4);
    expect(loudWords.medianWordScore).toBeGreaterThan(LYRICS_MATCH_THRESHOLD);
    expect(loudWords.pathScore).toBeLessThan(LYRICS_MATCH_THRESHOLD);
    expect(loudWords.verdict).toBe('match');
  });

  it('derives its ONE verdict from the median word score and from nothing else', async () => {
    // The alignment carries a per-word `score` because the Viterbi produces
    // one, and the feature's rule is that nothing ranks or flags a word. What
    // is checkable here is that the verdict is a pure function of the median:
    // driven across the threshold, only the median moves it, and per-word
    // scores that are all equal to it cannot be what is being consulted.
    for (const offset of [-0.5, -0.01, 0, 0.01, 0.5]) {
      const a = await verdictAtWordScore(LYRICS_MATCH_THRESHOLD + offset);
      expect(a.verdict).toBe(a.medianWordScore >= LYRICS_MATCH_THRESHOLD ? 'match' : 'weak');
      expect(a.verdict).toBe(offset < 0 ? 'weak' : 'match');
    }
  });
});

describe('alignDocumentLyrics — the host contract and the always-resolves promise', () => {
  it('resolves failed rather than rejecting when the IPC invoke itself dies, and kills the child', async () => {
    seedDoc();
    bridge.alignRun.mockRejectedValue(new Error('channel closed'));
    const result = await alignDocumentLyrics({ docId: activeDoc().id, text: TEXT });
    expect(result).toMatchObject({ ok: false, status: 'failed', message: 'channel closed' });
    expect(bridge.alignCancel).toHaveBeenCalled();
    expect(getAlignBusyCount()).toBe(0);
  });

  it('refuses a grid whose size contradicts the frame and class counts it came with', async () => {
    seedDoc();
    const bad = gridResponse();
    bad.logProbs = new Float32Array(10).buffer;
    bridge.alignRun.mockResolvedValue(bad);
    const result = await alignDocumentLyrics({ docId: activeDoc().id, text: TEXT });
    expect(result).toMatchObject({ ok: false, status: 'failed' });
    expect(getLyricsAlignment(activeDoc().id)).toBeNull();
  });

  it('refuses a vocabulary with no CTC blank rather than aligning against a guessed one', async () => {
    seedDoc();
    const noBlank = gridResponse();
    const { '<pad>': _pad, ...rest } = VOCAB;
    noBlank.vocab = rest;
    bridge.alignRun.mockResolvedValue(noBlank);
    const result = await alignDocumentLyrics({ docId: activeDoc().id, text: TEXT });
    expect(result).toMatchObject({ ok: false, status: 'failed' });
  });

  it('reports a cancel as cancelled, not as a failure, and raises no error box', async () => {
    seedDoc();
    bridge.alignRun.mockImplementation(async () => {
      await cancelAlignment();
      return { ok: false as const, cancelled: true as const };
    });
    const result = await alignDocumentLyrics({ docId: activeDoc().id, text: TEXT });
    expect(result).toMatchObject({ ok: false, status: 'cancelled' });
    expect(bridge.showMessageBox).not.toHaveBeenCalled();
  });

  it('discards a result whose audio changed while it was in flight', async () => {
    _setAlignStaleWatchForTest(false); // exercise the DELIVERY-TIME gate on its own
    const docId = seedDoc();
    bridge.alignRun.mockImplementation(async () => {
      touchAudio(docId);
      return gridResponse();
    });
    const result = await alignDocumentLyrics({ docId, text: TEXT });
    expect(result).toMatchObject({ ok: false, status: 'stale' });
    expect(getLyricsAlignment(docId)).toBeNull();
  });

  it('publishes progress from the host and unsubscribes when the run settles', async () => {
    seedDoc();
    const seen: AlignProgress[] = [];
    bridge.alignRun.mockImplementation(async () => {
      for (const l of progressListeners) l({ done: 1600, total: TOTAL_SAMPLES });
      return gridResponse();
    });
    await alignDocumentLyrics({
      docId: activeDoc().id,
      text: TEXT,
      onProgress: (p) => seen.push({ ...p }),
    });
    expect(seen.some((p) => p.fraction > 0 && p.fraction < 1)).toBe(true);
    expect(progressListeners).toHaveLength(0);

    // The seed estimate is the region's duration DIVIDED by the measured
    // realtime factor — 2.24 s of audio at 16.4x is 137 ms. Multiplying
    // instead would advertise 37 s for this fixture and 5.5 hours for a
    // 20-minute file, and nothing here ever looked at the number.
    const seed = seen.find((p) => p.phase === 'resampling');
    expect(seed).toBeDefined();
    expect(seed!.estimatedRemainingMs).toBeCloseTo(136.585, 3);
    expect(seed!.estimatedRemainingMs).toBeCloseTo(
      ((TOTAL_SAMPLES / SR) * 1000) / MEASURED_ALIGN_REALTIME_FACTOR,
      9
    );
    // …and the last thing published before the words land promises no wait.
    expect(seen[seen.length - 1].estimatedRemainingMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reaching a word
// ---------------------------------------------------------------------------

describe('previewWord', () => {
  it('asks the engine for EXACTLY the word span, and for nothing wider', async () => {
    const docId = seedDoc();
    const result = await alignDocumentLyrics({ docId, text: TEXT });
    if (!result.ok) throw new Error('unreachable');
    const play = jest.spyOn(playbackEngine, 'play').mockImplementation(() => {});
    jest.spyOn(playbackEngine, 'load').mockImplementation(() => {});

    expect(previewWord(docId, 1)).toBe(true);
    const word = result.alignment.words[1];
    expect(play).toHaveBeenCalledWith(word.startSample, {
      playRegion: { start: word.startSample, end: word.endSample },
    });
  });

  it('returns false when there is no alignment, and when the index is not a word', async () => {
    const docId = seedDoc();
    jest.spyOn(playbackEngine, 'play').mockImplementation(() => {});
    jest.spyOn(playbackEngine, 'load').mockImplementation(() => {});
    expect(previewWord(docId, 0)).toBe(false);
    await alignDocumentLyrics({ docId, text: TEXT });
    expect(previewWord(docId, 99)).toBe(false);
    expect(previewWord(docId, -1)).toBe(false);
  });
});

describe('wordGaps', () => {
  it('measures to the neighbours inside, and to the region edges at the ends', async () => {
    const docId = seedDoc();
    const result = await alignDocumentLyrics({ docId, text: TEXT });
    if (!result.ok) throw new Error('unreachable');
    const a = result.alignment;

    const middle = wordGaps(a, 1);
    expect(middle.before).toBe(a.words[1].startSample - a.words[0].endSample);
    expect(middle.after).toBe(a.words[2].startSample - a.words[1].endSample);

    expect(wordGaps(a, 0).before).toBe(a.words[0].startSample - a.regionStart);
    expect(wordGaps(a, 2).after).toBe(a.regionEnd - a.words[2].endSample);
  });

  it('clamps at zero when two aligned words touch', () => {
    const a = {
      regionStart: 0,
      regionEnd: 1000,
      words: [
        { startSample: 0, endSample: 100 },
        { startSample: 90, endSample: 200 },
      ],
    } as unknown as Parameters<typeof wordGaps>[0];
    expect(wordGaps(a, 1).before).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Replacing a word
// ---------------------------------------------------------------------------

describe('replaceWord', () => {
  async function seedAligned() {
    const docId = seedDoc();
    const result = await alignDocumentLyrics({ docId, text: TEXT });
    if (!result.ok) throw new Error('alignment fixture failed');
    return { docId, alignment: result.alignment };
  }

  it('refuses before there is an alignment to replace inside', async () => {
    const docId = seedDoc();
    const result = await replaceWord({
      docId,
      wordIndex: 1,
      replacement: [makeTake()],
      replacementSampleRate: SR,
    });
    expect(result).toMatchObject({ ok: false, status: 'no-alignment' });
  });

  it('refuses a word index that is not in the alignment', async () => {
    const { docId } = await seedAligned();
    const result = await replaceWord({
      docId,
      wordIndex: 99,
      replacement: [makeTake()],
      replacementSampleRate: SR,
    });
    expect(result).toMatchObject({ ok: false, status: 'bad-word' });
  });

  it('refuses an empty take', async () => {
    const { docId } = await seedAligned();
    const result = await replaceWord({
      docId,
      wordIndex: 1,
      replacement: [new Float32Array(0)],
      replacementSampleRate: SR,
    });
    expect(result).toMatchObject({ ok: false, status: 'empty-replacement' });
  });

  it('refuses when the audio moved under the alignment, and names the reason', async () => {
    const { docId } = await seedAligned();
    touchAudio(docId);
    const result = await replaceWord({
      docId,
      wordIndex: 1,
      replacement: [makeTake()],
      replacementSampleRate: SR,
    });
    expect(result).toMatchObject({ ok: false, status: 'stale' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Align the lyrics again');
  });

  it('rewrites only the seam-widened word region, leaves the length alone, and lands as one undo entry', async () => {
    const { docId, alignment } = await seedAligned();
    const before = Float32Array.from(activeDoc().channels[0]);
    const historyBefore = getHistory(docId).done.length;
    const word = alignment.words[1];
    const gaps = wordGaps(alignment, 1);
    const seam = deriveSeamSamples(SR, gaps.before, gaps.after);

    const result = await replaceWord({
      docId,
      wordIndex: 1,
      replacement: [makeTake()],
      replacementSampleRate: SR,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = activeDoc().channels[0];
    expect(after.length).toBe(before.length);
    expect(docLength(activeDoc())).toBe(TOTAL_SAMPLES);

    // Everything OUTSIDE the region is bit-identical…
    const regionStart = word.startSample - seam;
    const regionEnd = word.endSample + seam;
    expect(result.report.regionStart).toBe(regionStart);
    expect(result.report.regionEnd).toBe(regionEnd);
    for (let i = 0; i < regionStart; i++) expect(after[i]).toBe(before[i]);
    for (let i = regionEnd; i < after.length; i++) expect(after[i]).toBe(before[i]);

    // …and the word itself is gone. `spliceWord` puts 100% replacement across
    // [start, end), so not one sample of the old word can survive.
    let changed = 0;
    for (let i = word.startSample; i < word.endSample; i++) if (after[i] !== before[i]) changed++;
    expect(changed).toBe(word.endSample - word.startSample);

    expect(getHistory(docId).done.length).toBe(historyBefore + 1);
    expect(getHistory(docId).done[getHistory(docId).done.length - 1]).toBe(REPLACE_WORD_UNDO_LABEL);
  });

  it('one undo puts the whole replacement back', async () => {
    const { docId } = await seedAligned();
    const before = Float32Array.from(activeDoc().channels[0]);
    await replaceWord({ docId, wordIndex: 1, replacement: [makeTake()], replacementSampleRate: SR });
    undo(docId);
    const after = activeDoc().channels[0];
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i]);
  });

  it('leaves the alignment usable, so a second word can be replaced without re-running the model', async () => {
    const { docId, alignment } = await seedAligned();
    const runsBefore = bridge.alignRun.mock.calls.length;

    const first = await replaceWord({ docId, wordIndex: 1, replacement: [makeTake()], replacementSampleRate: SR });
    expect(first.ok).toBe(true);
    // The splice moved no sample position, so the spans still describe the
    // audio — the service re-arms the identity snapshot rather than pretending
    // an edit did not happen.
    expect(isLyricsAlignmentStale(docId)).toBe(false);
    const kept = getLyricsAlignment(docId)!;
    expect(kept.words.map((w) => w.startSample)).toEqual(alignment.words.map((w) => w.startSample));

    const second = await replaceWord({ docId, wordIndex: 2, replacement: [makeTake(300)], replacementSampleRate: SR });
    expect(second.ok).toBe(true);
    expect(bridge.alignRun.mock.calls.length).toBe(runsBefore);
  });

  it('matches the take to the replaced word’s pitch by default, and reports the shift it made', async () => {
    const { docId } = await seedAligned();
    // Word 1 is the 220 Hz burst; the take is 260 Hz. Matching transposes it
    // by 12·log2(220/260) = −2.90 semitones. `matchPitch` is left unset, which
    // is what the dialog does — `wordSplice` defaults it to ON, and passing
    // `req.matchPitch === true` instead of `req.matchPitch` would silently
    // turn pitch matching off for every replacement the app makes.
    const result = await replaceWord({
      docId,
      wordIndex: 1,
      replacement: [makeTake(260)],
      replacementSampleRate: SR,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.originalF0Hz).toBeCloseTo(220, 0);
    expect(result.report.replacementF0Hz).toBeCloseTo(260, 0);
    expect(result.report.pitchShiftSemitones).toBeCloseTo(12 * Math.log2(220 / 260), 1);
    // Stated as a number, not just as "non-zero": a disabled match reports 0.
    expect(result.report.pitchShiftSemitones).toBeCloseTo(-2.9, 1);
  });

  it('resamples a take captured at another rate rather than splicing it at the wrong speed', async () => {
    const { docId, alignment } = await seedAligned();
    const word = alignment.words[1];
    // A 44.1 kHz take of the SAME 0.4 s word. If the rate were ignored, the
    // fitted material would be 2.76x too long and WSOLA would have to squeeze
    // it by that much — outside its own ratio bound, which is a refusal.
    const result = await replaceWord({
      docId,
      wordIndex: 1,
      replacement: [makeTake(260, 0.4, 0.6, 44100)],
      replacementSampleRate: 44100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The observable that separates the two readings: the take is a 260 Hz
    // tone. Resampled correctly it still measures 260 Hz. Spliced as if its
    // samples were already at 16 kHz it would measure 260 x 16000/44100 =
    // 94 Hz, and the pitch match would then transpose it by 17 semitones.
    expect(result.report.replacementF0Hz).not.toBeNull();
    expect(result.report.replacementF0Hz!).toBeGreaterThan(250);
    expect(result.report.replacementF0Hz!).toBeLessThan(270);
    expect(result.report.regionEnd - result.report.regionStart).toBeGreaterThan(word.endSample - word.startSample);
  });

  it('surfaces the splice’s own refusal instead of committing a bad edit', async () => {
    const { docId } = await seedAligned();
    const historyBefore = getHistory(docId).done.length;
    // Digital silence — a muted microphone. `spliceWord` refuses, and the
    // document must be untouched. (Room tone would NOT refuse: the trim judges
    // silence against the absolute 16-bit LSB, not against the recording's own
    // level, so a take with a floor above that floor is spliced. See
    // `wordSplice.ts`.)
    const result = await replaceWord({
      docId,
      wordIndex: 1,
      replacement: [new Float32Array(SR)],
      replacementSampleRate: SR,
    });
    expect(result).toMatchObject({ ok: false, status: 'refused' });
    expect(getHistory(docId).done.length).toBe(historyBefore);
  });
});

// ---------------------------------------------------------------------------
// Model state, and lyrics loaded from a text file
// ---------------------------------------------------------------------------

describe('the model bridge', () => {
  it('reads as not-downloaded, with a stated size, when the preload is absent', async () => {
    delete (window as { electronAPI?: unknown }).electronAPI;
    await expect(getAlignModelState()).resolves.toEqual({
      downloaded: false,
      bytes: null,
      expectedBytes: ALIGN_MODEL_BYTES,
    });
    await expect(ensureAlignModels()).resolves.toMatchObject({ ok: false });
  });

  it('reads as not-downloaded when the probe itself throws, rather than propagating', async () => {
    bridge.alignModelState.mockRejectedValue(new Error('nope'));
    await expect(getAlignModelState()).resolves.toMatchObject({ downloaded: false });
  });

  it('unsubscribes from download progress once the download settles', async () => {
    const off = jest.fn();
    bridge.onAlignModelProgress.mockReturnValue(off);
    await ensureAlignModels(() => {});
    expect(off).toHaveBeenCalled();
  });
});

describe('loadLyricsFile', () => {
  it('returns null when the dialog is cancelled', async () => {
    bridge.showOpenDialog.mockResolvedValue(null);
    await expect(loadLyricsFile()).resolves.toBeNull();
  });

  it('decodes UTF-8 and strips the BOM Notepad writes', async () => {
    bridge.showOpenDialog.mockResolvedValue(['C:/lyrics.txt']);
    const bytes = new TextEncoder().encode('\ufeffYou, you stole my heart');
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    bridge.readFile.mockResolvedValue(buffer);
    await expect(loadLyricsFile()).resolves.toEqual({ ok: true, text: 'You, you stole my heart' });
  });

  it('reports a read failure rather than throwing out of the dialog', async () => {
    bridge.showOpenDialog.mockResolvedValue(['C:/gone.txt']);
    bridge.readFile.mockRejectedValue(new Error('ENOENT'));
    await expect(loadLyricsFile()).resolves.toEqual({ ok: false, error: 'ENOENT' });
  });
});
