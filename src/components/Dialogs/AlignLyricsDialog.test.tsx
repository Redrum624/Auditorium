import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AlignLyricsDialog, { runLabel } from './AlignLyricsDialog';
import {
  RecordingEngine,
  type RecordingContextLike,
  type WorkletNodeLike,
} from '../../audio/RecordingEngine';
import {
  ALIGN_MODEL_BYTES,
  ALIGN_SAMPLE_RATE,
  MEASURED_ALIGN_REALTIME_FACTOR,
  _resetAlignmentsForTest,
  getLyricsAlignment,
} from '../../services/alignLyricsService';
import { ALIGN_ACCURACY_SENTENCE, LYRICS_MATCH_THRESHOLD } from '../../dsp/ctcAlign';
import { playbackEngine } from '../../audio/PlaybackEngine';
import { registerDialogSetters } from '../../services/dialogBus';
import { createDocument } from '../../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { stageById } from '../../services/vocalChain';

// ---------------------------------------------------------------------------
// Fixture — the same construction the service test uses, kept small: three
// two-character words, each 20 frames, over a document at the model's own rate
// so a frame is exactly 320 document samples.
// ---------------------------------------------------------------------------

const SR = ALIGN_SAMPLE_RATE;
const FRAME_SAMPLES = 320;
const CLASSES = 32;
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

const TEXT = 'At in\non';
type Run = { klass: number | null; frames: number };

/** Frame script for {@link TEXT}: 15 blank, then each word's characters at 10
 * frames each, gaps of blank / `|` / blank, 15 blank at the end. */
function fixtureRuns(): Run[] {
  const runs: Run[] = [{ klass: null, frames: 15 }];
  TEXT.split(/\s+/).forEach((word, i) => {
    if (i > 0) {
      runs.push({ klass: null, frames: 5 }, { klass: VOCAB['|'], frames: 1 }, { klass: null, frames: 5 });
    }
    for (const ch of word.toUpperCase()) runs.push({ klass: VOCAB[ch], frames: 10 });
  });
  runs.push({ klass: null, frames: 15 });
  return runs;
}

const RUNS = fixtureRuns();
const FRAMES = RUNS.reduce((n, r) => n + r.frames, 0);
const DOC_LENGTH = FRAMES * FRAME_SAMPLES;

function buildGrid(p: number): ArrayBuffer {
  const grid = new Float32Array(FRAMES * CLASSES);
  const hit = Math.log(p);
  const miss = Math.log((1 - p) / (CLASSES - 1));
  let t = 0;
  for (const run of RUNS) {
    const owner = run.klass ?? 0;
    for (let i = 0; i < run.frames; i++, t++) {
      for (let v = 0; v < CLASSES; v++) grid[t * CLASSES + v] = v === owner ? hit : miss;
    }
  }
  return grid.buffer.slice(0) as ArrayBuffer;
}

function roomTone(length: number, amplitude = 1e-4, seed = 12345): Float32Array {
  const out = new Float32Array(length);
  let s = seed;
  for (let i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((s / 0x7fffffff) * 2 - 1) * amplitude;
  }
  return out;
}

function tone(length: number, freqHz: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / SR);
  return out;
}

/** A take with room tone on both sides of the word — long enough for the
 * 500 ms noise window the splice's trim threshold comes from. */
function take(freqHz = 260): Float32Array {
  const pad = Math.round(0.6 * SR);
  const sound = Math.round(0.4 * SR);
  const out = roomTone(pad * 2 + sound, 1e-4, 777);
  out.set(tone(sound, freqHz), pad);
  return out;
}

function docAudio(): Float32Array {
  const out = roomTone(DOC_LENGTH);
  // Each word's constructed span gets a burst, so a splice has something real
  // to measure a level and a pitch against.
  [15, 46, 77].forEach((startFrame, i) => {
    out.set(tone(20 * FRAME_SAMPLES, [330, 220, 440][i]), startFrame * FRAME_SAMPLES);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Doubles
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

function gridResponse(p = 0.99) {
  return {
    ok: true as const,
    frames: FRAMES,
    classes: CLASSES,
    frameSamples: FRAME_SAMPLES,
    vocab: VOCAB,
    logProbs: buildGrid(p),
  };
}

/** A `RecordingEngine` stand-in — jsdom has no `navigator.mediaDevices`, so the
 * real one cannot start. Same injection point `RecordDialog` uses. */
class FakeEngine {
  recording = false;
  started: { channels: number; sampleRate: number }[] = [];
  stopped = 0;
  failStart: string | null = null;
  result: { channels: Float32Array[]; sampleRate: number } = { channels: [take()], sampleRate: SR };

  get isRecording(): boolean {
    return this.recording;
  }
  async start(opts: { channels: 1 | 2; sampleRate: number }): Promise<void> {
    if (this.failStart) throw new Error(this.failStart);
    this.started.push(opts);
    this.recording = true;
  }
  async stop(): Promise<{ channels: Float32Array[]; sampleRate: number }> {
    this.stopped++;
    this.recording = false;
    return this.result;
  }
}

function asEngine(e: FakeEngine | RecordingEngine): RecordingEngine {
  return e as unknown as RecordingEngine;
}

/**
 * A REAL {@link RecordingEngine} over a fake capture graph, with `getUserMedia`
 * held open until `grant()` is called.
 *
 * `FakeEngine` above cannot express the window this models: the real `start()`
 * claims the recording slot SYNCHRONOUSLY (`RecordingEngine.ts:156`) and only
 * acquires the microphone when `getUserMedia` resolves, so there is a stretch —
 * the whole permission prompt — during which `isRecording` is already true and
 * the engine owns nothing at all. Measuring what an unmount does inside that
 * stretch needs the real object.
 */
function heldMicEngine() {
  const track = { stopped: false, kind: 'audio', stop(): void { track.stopped = true; } };
  const stream = { getTracks: () => [track] };
  const ctxState = { closed: false };
  const port = {
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage(message: unknown): void {
      // Answer the flush immediately, so a stop() in this test resolves on the
      // final batch rather than on the engine's 3 s safety timeout.
      if (message === 'flush') port.onmessage?.({ data: { channels: [take()], final: true } });
    },
  };
  const node = { port, connect: () => undefined, disconnect: () => undefined };
  const ctx = {
    sampleRate: SR,
    destination: {},
    audioWorklet: { addModule: async () => undefined },
    createMediaStreamSource: () => ({ connect: () => undefined, disconnect: () => undefined }),
    createGain: () => ({ gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined }),
    close: async () => {
      ctxState.closed = true;
    },
  };
  let release: () => void = () => {};
  const engine = new RecordingEngine({
    getUserMedia: () =>
      new Promise<MediaStream>((resolve) => {
        release = () => resolve(stream as unknown as MediaStream);
      }),
    createContext: () => ctx as unknown as RecordingContextLike,
    createWorkletNode: () => node as unknown as WorkletNodeLike,
    createModuleUrl: () => 'blob:test',
  });
  return { engine, track, ctxState, grant: () => release() };
}

function seedDoc(channels: Float32Array[] = [docAudio()]): string {
  const doc = createDocument({ name: 'Take.wav', sampleRate: SR, channels });
  useAppStore.getState().addDocument(doc);
  useAppStore.getState().setActiveDocument(doc.id);
  return doc.id;
}

function activeDoc() {
  const s = useAppStore.getState();
  return s.documents.find((d) => d.id === s.activeDocumentId)!;
}

/** Flushes the model-state probe and any settled promise chain. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

function open(engine?: FakeEngine | RecordingEngine, onClose: () => void = () => {}) {
  return render(<AlignLyricsDialog onClose={onClose} engine={engine ? asEngine(engine) : undefined} />);
}

/** Types the lyrics in and runs the alignment to completion. */
async function alignIn(): Promise<void> {
  fireEvent.change(screen.getByTestId('align-lyrics-text'), { target: { value: TEXT } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('align-lyrics-run'));
  });
  await settle();
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetAlignmentsForTest();
  jest.spyOn(playbackEngine, 'play').mockImplementation(() => {});
  jest.spyOn(playbackEngine, 'load').mockImplementation(() => {});
  bridge = {
    alignModelState: jest.fn(async () => ({
      downloaded: true,
      bytes: ALIGN_MODEL_BYTES,
      expectedBytes: ALIGN_MODEL_BYTES,
    })),
    alignEnsureModels: jest.fn(async () => ({ ok: true as const })),
    onAlignModelProgress: jest.fn(() => () => {}),
    alignRun: jest.fn(async () => gridResponse()),
    alignCancel: jest.fn(async () => ({ cancelled: true })),
    onAlignProgress: jest.fn(() => () => {}),
    showMessageBox: jest.fn(async () => 0),
    showOpenDialog: jest.fn(async () => null),
    readFile: jest.fn(async () => new ArrayBuffer(0)),
  };
  (window as unknown as { electronAPI?: unknown }).electronAPI = bridge;
  registerDialogSetters({
    openExportDialog: () => {},
    openNewFileDialog: () => {},
    openEffectDialog: () => {},
    openConvertDialog: () => {},
    openRecordDialog: () => {},
    openTempoDialog: () => {},
    openRemixDialog: () => {},
    openSeparateDialog: () => {},
    openTranscribeDialog: () => {},
    openVoiceChangerDialog: () => {},
    openAlignTimingDialog: () => {},
    openVocalChainDialog: () => {},
    openCoverChainDialog: () => {},
    openPodcastChainDialog: () => {},
    openAlignLyricsDialog: () => {},
    focusRemixPanel: () => {},
    focusTranscriptPanel: () => {},
    focusSpatialPanel: () => {},
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  _resetAlignmentsForTest();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

// ---------------------------------------------------------------------------
// Ruling 1 — the name promises no coaching, and neither does anything on screen
// ---------------------------------------------------------------------------

describe('AlignLyricsDialog — nothing here judges a word', () => {
  /** The vocabulary of assessment this dialog is forbidden to use. */
  const FORBIDDEN = ['pronunciation', 'mispronounce', 'coach', 'grade', 'accuracy score', 'may need attention'];

  it('is titled Align Lyrics, and says nowhere that it assesses pronunciation', async () => {
    seedDoc();
    // Scored BELOW the match threshold, so the sweep also covers the ONE piece
    // of this dialog that says anything evaluative at all — the lyrics-match
    // warning — and not just the inert opening view.
    //
    // This test used to sweep the dialog before any alignment had run, so
    // `alignment` was null and the results view it exists to police never
    // rendered: not one word, no warning, no selected-word panel. The ruling it
    // guards is the feature's hardest one (scoring measured AUC 0.642 against a
    // 0.500 chance baseline and was cut), so the sweep has to see the screen
    // the user actually ends up looking at.
    bridge.alignRun.mockResolvedValue(gridResponse(Math.exp(LYRICS_MATCH_THRESHOLD - 0.5)));
    const { container } = open(new FakeEngine());
    await settle();

    const sweep = (stage: string): string => {
      const prose = (container.textContent ?? '').toLowerCase();
      for (const forbidden of FORBIDDEN) {
        // Phrased so a failure names the WORD and the STAGE it appeared at.
        expect(`${stage} — ${prose.includes(forbidden) ? forbidden : 'clean'}`).toBe(`${stage} — clean`);
      }
      return prose;
    };

    expect(screen.getByText('Align Lyrics')).toBeInTheDocument();
    sweep('before aligning');

    await alignIn();
    // The results are genuinely on screen for this sweep: every word, and the
    // weak-match warning.
    expect(screen.getByTestId('align-lyrics-word-0')).toBeInTheDocument();
    expect(screen.getByTestId('align-lyrics-word-2')).toBeInTheDocument();
    expect(screen.getByTestId('align-lyrics-weak')).toBeInTheDocument();
    sweep('with the words placed and the match warning up');

    // …and with a word picked — the only state that renders prose about ONE
    // word, and so the likeliest place a verdict would ever appear.
    fireEvent.click(screen.getByTestId('align-lyrics-word-1'));
    const selected = sweep('with a word selected');
    // What that panel is allowed to say about a word: where it is and how long
    // it is. Asserted positively, so "clean" cannot be achieved by rendering
    // nothing at all.
    expect(selected).toContain('ms long');
  });

  it('renders every word with the SAME appearance until one is selected', async () => {
    seedDoc();
    open();
    await settle();
    await alignIn();

    const words = [0, 1, 2].map((i) => screen.getByTestId(`align-lyrics-word-${i}`));
    // No score, no rank, no colour scale: with nothing selected the three are
    // indistinguishable, which is what "the tool does not tell you which word
    // is wrong" has to look like on screen.
    const styles = words.map((w) => w.getAttribute('style'));
    expect(new Set(styles).size).toBe(1);
    for (const w of words) expect(w.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(words[1]);
    // …and after a click exactly ONE differs, and it is the selected one.
    const after = [0, 1, 2].map((i) => screen.getByTestId(`align-lyrics-word-${i}`));
    expect(after.map((w) => w.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    expect(after[0].getAttribute('style')).toBe(after[2].getAttribute('style'));
    expect(after[1].getAttribute('style')).not.toBe(after[0].getAttribute('style'));
  });

  it('quotes the cross-model accuracy verbatim, and the Vocal Chain stage quotes the same sentence', async () => {
    seedDoc();
    open();
    await settle();
    // Two pieces of shipped UI describing ONE measurement. Asserted as the same
    // string from the same source rather than as two hand-written claims that
    // could drift.
    expect(screen.getByTestId('align-lyrics-accuracy')).toHaveTextContent(ALIGN_ACCURACY_SENTENCE);
    expect(stageById('lyrics').note).toContain(ALIGN_ACCURACY_SENTENCE);
  });

  it('never quotes a hand-marked figure — those are upper bounds', async () => {
    seedDoc();
    const { container } = open();
    await settle();
    for (const upperBound of ['28 ms', '36 ms', '48 ms']) {
      expect(container.textContent).not.toContain(upperBound);
    }
  });
});

// ---------------------------------------------------------------------------
// The wrong-lyrics gate
// ---------------------------------------------------------------------------

describe('AlignLyricsDialog — the lyrics-match warning', () => {
  it('warns below the threshold, stays silent on it and above, and shows the words either way', async () => {
    // Probed BELOW / ON / ABOVE. The grid's per-frame confidence IS the median
    // per-word score by construction, so the boundary can be placed exactly.
    for (const [score, expectWarning] of [
      [LYRICS_MATCH_THRESHOLD - 0.01, true],
      [LYRICS_MATCH_THRESHOLD, false],
      [LYRICS_MATCH_THRESHOLD + 0.01, false],
    ] as const) {
      _resetAlignmentsForTest();
      useAppStore.setState(makeInitialState());
      seedDoc();
      bridge.alignRun.mockResolvedValue(gridResponse(Math.exp(score)));
      const view = open();
      await settle();
      await alignIn();

      expect(screen.queryByTestId('align-lyrics-weak') !== null).toBe(expectWarning);
      // A WARNING, never a refusal: the spans are on screen in all three cases.
      expect(screen.getByTestId('align-lyrics-word-2')).toBeInTheDocument();
      view.unmount();
    }
  });

  it('says the lyrics do not appear to match, without saying the user is wrong', async () => {
    seedDoc();
    bridge.alignRun.mockResolvedValue(gridResponse(Math.exp(LYRICS_MATCH_THRESHOLD - 0.5)));
    open();
    await settle();
    await alignIn();
    const warning = screen.getByTestId('align-lyrics-weak').textContent ?? '';
    expect(warning).toContain('don’t appear to match this audio');
    expect(warning.toLowerCase()).not.toContain('you are wrong');
  });
});

// ---------------------------------------------------------------------------
// Reaching a word
// ---------------------------------------------------------------------------

describe('AlignLyricsDialog — reaching a word', () => {
  it('lays the words out on the lines they were written on', async () => {
    seedDoc();
    open();
    await settle();
    await alignIn();
    const rows = screen.getByTestId('align-lyrics-words').children;
    expect(rows).toHaveLength(2); // 'At in' then 'on'
    expect(rows[0].textContent).toBe('Atin');
    expect(rows[1].textContent).toBe('on');
  });

  it('asks the playback engine for exactly the clicked word’s span, and nothing wider', async () => {
    const docId = seedDoc();
    open();
    await settle();
    await alignIn();

    fireEvent.click(screen.getByTestId('align-lyrics-word-1'));
    const word = getLyricsAlignment(docId)!.words[1];
    expect(playbackEngine.play).toHaveBeenLastCalledWith(word.startSample, {
      playRegion: { start: word.startSample, end: word.endSample },
    });
  });

  it('names the selected word with its position and its length', async () => {
    const docId = seedDoc();
    open();
    await settle();
    await alignIn();
    fireEvent.click(screen.getByTestId('align-lyrics-word-1'));
    const word = getLyricsAlignment(docId)!.words[1];
    const expectedMs = Math.round(((word.endSample - word.startSample) / SR) * 1000);
    expect(screen.getByTestId('align-lyrics-selected')).toHaveTextContent(`${expectedMs} ms long`);
  });
});

// ---------------------------------------------------------------------------
// Replacing a word — the state machine, asserted as an invariant over EVERY
// combination rather than as a handful of chosen cases.
// ---------------------------------------------------------------------------

describe('AlignLyricsDialog — the Replace state machine', () => {
  /**
   * Replace must be available EXACTLY when the take in hand belongs to the word
   * currently selected and the alignment still describes the audio.
   *
   * Driven over ALL EIGHT combinations of three axes that are each reachable
   * from the UI — a take exists, the selection has since moved, the audio has
   * since changed — rather than over the three cases that are obvious. The
   * second axis is why: clicking a word is also how you LISTEN to one, so a
   * user holding a take can move the selection just by auditioning a
   * neighbour, and the sweep is what surfaced that a take could then be
   * spliced into the wrong word.
   *
   * Two separate pieces of UI report parts of the same fact — the button's own
   * enabled state and the paragraph beneath it — so the invariant tying them is
   * asserted in every cell rather than left as four string comparisons.
   */
  it.each([
    [false, false, false],
    [false, false, true],
    [false, true, false],
    [false, true, true],
    [true, false, false],
    [true, false, true],
    [true, true, false],
    [true, true, true],
  ])(
    'take recorded=%s, selection moved after it=%s, audio changed under it=%s',
    async (takeRecorded, selectionMoved, madeStale) => {
      _resetAlignmentsForTest();
      useAppStore.setState(makeInitialState());
      const docId = seedDoc();
      const engine = new FakeEngine();
      const view = open(engine);
      await settle();
      await alignIn();

      // Every cell starts from a selected word, because Record is gated on one
      // — recording a replacement for nothing is not a state this dialog has.
      fireEvent.click(screen.getByTestId('align-lyrics-word-1'));
      if (takeRecorded) {
        await act(async () => {
          fireEvent.click(screen.getByTestId('align-lyrics-record'));
        });
        await act(async () => {
          fireEvent.click(screen.getByTestId('align-lyrics-stop-record'));
        });
      }
      if (selectionMoved) fireEvent.click(screen.getByTestId('align-lyrics-word-2'));
      if (madeStale) {
        const doc = activeDoc();
        act(() => {
          useAppStore
            .getState()
            .updateDocument({ ...doc, channels: doc.channels.map((c) => Float32Array.from(c)) });
        });
      }

      const replace = screen.getByTestId('align-lyrics-replace') as HTMLButtonElement;
      const takeLine = screen.getByTestId('align-lyrics-take').textContent ?? '';
      const selectedText = getLyricsAlignment(docId)!.words[selectionMoved ? 2 : 1].text;
      const canReplace = takeRecorded && !selectionMoved && !madeStale;

      expect(replace.disabled).toBe(!canReplace);
      // The tie between the two elements: the button is live exactly when the
      // paragraph says a take is ready FOR THE WORD THAT IS SELECTED.
      expect(takeLine.startsWith(`Take ready for “${selectedText}”`)).toBe(
        takeRecorded && !selectionMoved
      );
      expect(!replace.disabled && !takeLine.startsWith('Take ready for')).toBe(false);
      // A take that no longer matches says so instead of silently doing nothing.
      if (takeRecorded && selectionMoved) expect(takeLine).toContain('was recorded for');
      // Stale is stated, not merely enforced — a disabled button with no reason
      // beside it is the failure this dialog is not allowed to have.
      expect(screen.queryByTestId('align-lyrics-stale') !== null).toBe(madeStale);
      expect(getLyricsAlignment(docId)).not.toBeNull();
      view.unmount();
    }
  );

  it('offers neither Record nor Replace until a word is picked, and says which to pick', async () => {
    seedDoc();
    open(new FakeEngine());
    await settle();
    await alignIn();
    expect((screen.getByTestId('align-lyrics-record') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('align-lyrics-replace') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('align-lyrics-preview') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('align-lyrics-selected')).toHaveTextContent('Click a word above to hear it');
  });

  it('records at the document rate, splices the take, and reports what was matched', async () => {
    const docId = seedDoc();
    const engine = new FakeEngine();
    open(engine);
    await settle();
    await alignIn();

    const before = Float32Array.from(activeDoc().channels[0]);
    fireEvent.click(screen.getByTestId('align-lyrics-word-1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('align-lyrics-record'));
    });
    expect(engine.started).toEqual([{ channels: 1, sampleRate: SR }]);
    await act(async () => {
      fireEvent.click(screen.getByTestId('align-lyrics-stop-record'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('align-lyrics-replace'));
    });
    await settle();

    const note = screen.getByTestId('align-lyrics-note').textContent ?? '';
    expect(note).toContain('Replaced');
    // The FIGURE, not just the word: word 1 is the 220 Hz burst and the take is
    // 260 Hz, so matching transposes it by 12·log2(220/260) = −2.90 semitones.
    // A splice that quietly stopped matching pitch reports "+0.00 semitones",
    // which `toContain('semitones')` accepts.
    expect(note).toContain('pitch -2.89 semitones');
    expect(note).not.toContain('+0.00 semitones');
    expect(note).toContain('Undo is one step');

    const after = activeDoc().channels[0];
    expect(after.length).toBe(before.length);
    const word = getLyricsAlignment(docId)!.words[1];
    let changed = 0;
    for (let i = word.startSample; i < word.endSample; i++) if (after[i] !== before[i]) changed++;
    expect(changed).toBe(word.endSample - word.startSample);
    // The take is consumed, so the same recording cannot be pasted twice by a
    // second click on a still-enabled button.
    expect((screen.getByTestId('align-lyrics-replace') as HTMLButtonElement).disabled).toBe(true);
  });

  it('surfaces the splice’s refusal inline rather than as a native error box', async () => {
    seedDoc();
    const engine = new FakeEngine();
    // Digital silence — a muted microphone, the one recording `spliceWord`
    // refuses. Room tone does NOT refuse: silence is judged against the
    // absolute 16-bit LSB, not the recording's own level (see `wordSplice.ts`).
    engine.result = { channels: [new Float32Array(SR)], sampleRate: SR };
    open(engine);
    await settle();
    await alignIn();
    fireEvent.click(screen.getByTestId('align-lyrics-word-1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('align-lyrics-record'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('align-lyrics-stop-record'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('align-lyrics-replace'));
    });
    await settle();
    expect(screen.getByTestId('align-lyrics-error')).toBeInTheDocument();
    expect(bridge.showMessageBox).not.toHaveBeenCalled();
  });

  it('has no file input for the replacement, and says where the replacement comes from instead', async () => {
    seedDoc();
    const { container } = open(new FakeEngine());
    await settle();
    await alignIn();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.getByTestId('align-lyrics-take')).toHaveTextContent('there is no file to import');
    // The only file affordance in the dialog reads WORDS, never audio.
    expect(screen.getByTestId('align-lyrics-load')).toHaveTextContent('Load from file');
  });

  it('stops a running recorder when the dialog unmounts, so the mic is not held open', async () => {
    seedDoc();
    const engine = new FakeEngine();
    const view = open(engine);
    await settle();
    await alignIn();
    fireEvent.click(screen.getByTestId('align-lyrics-word-1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('align-lyrics-record'));
    });
    expect(engine.isRecording).toBe(true);
    view.unmount();
    await settle();
    expect(engine.stopped).toBe(1);
    expect(engine.isRecording).toBe(false);
  });

  /**
   * The microphone is acquired ASYNCHRONOUSLY, and the dialog used to be
   * dismissable for the whole of it.
   *
   * `recording` was set only after `await engine.start(...)` resolved, so during
   * the permission prompt `busy` was false: Escape, a backdrop click and the
   * Close button were all live. And the unmount cleanup keyed off
   * `engine.isRecording`, which `start()` sets synchronously before it has
   * acquired anything — so the cleanup stopped an engine that owned nothing,
   * dropped the reference, and the resolving `start()` then handed a LIVE
   * MediaStream and an open AudioContext to an engine nothing could reach. The
   * microphone stayed lit for the rest of the session.
   *
   * Both halves are pinned here: the window is closed (nothing dismisses it),
   * and the leak is closed (an unmount inside it still releases the mic).
   */
  it('holds the dialog shut while the mic is being acquired, and releases it if the dialog goes anyway', async () => {
    seedDoc();
    const mic = heldMicEngine();
    const onClose = jest.fn();
    const view = open(mic.engine, onClose);
    await settle();
    await alignIn();
    fireEvent.click(screen.getByTestId('align-lyrics-word-1'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('align-lyrics-record'));
    });
    // Inside the window: the slot is claimed, nothing is acquired yet.
    expect(mic.engine.isRecording).toBe(true);
    expect(mic.track.stopped).toBe(false);

    // …and the dialog is NOT dismissable through any of its three routes.
    fireEvent.mouseDown(screen.getByTestId('dialog-overlay'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByText('Close').closest('button') as HTMLButtonElement).disabled).toBe(true);

    // Unmount anyway — the parent can drop this dialog for reasons Escape
    // cannot reach (the document closes, the app quits). The mic must still be
    // released once the acquisition it cannot cancel finally lands.
    view.unmount();
    await act(async () => {
      mic.grant();
      await settle();
    });

    expect(mic.track.stopped).toBe(true); // the mic indicator goes out
    expect(mic.ctxState.closed).toBe(true); // …and the AudioContext is not leaked
    expect(mic.engine.isRecording).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Download, run, and the ordinary dialog obligations
// ---------------------------------------------------------------------------

describe('AlignLyricsDialog — model, run and refusals', () => {
  it('offers the download with its size when the model is missing, and no Align button', async () => {
    bridge.alignModelState.mockResolvedValue({ downloaded: false, bytes: null, expectedBytes: ALIGN_MODEL_BYTES });
    seedDoc();
    open();
    await settle();
    expect(screen.getByTestId('align-lyrics-model-missing')).toHaveTextContent('378 MB');
    expect(screen.queryByTestId('align-lyrics-run')).toBeNull();
  });

  it('states the measured realtime factor and an estimate for this file', async () => {
    // 32.8 s of audio, so the estimate this factor implies is a legible 2 s.
    // The factor alone was asserted before, and a `/ factor` that became
    // `* factor` still prints "16.4x realtime" — while promising 8:58 here,
    // and five and a half hours for a twenty-minute file.
    seedDoc([new Float32Array(Math.round(32.8 * SR))]);
    open();
    await settle();
    expect(screen.getByTestId('align-lyrics-estimate')).toHaveTextContent(
      `Runs on the CPU at about ${MEASURED_ALIGN_REALTIME_FACTOR.toFixed(1)}x realtime — ` +
        'roughly 0:02 for this file.'
    );
  });

  it('keeps Align disabled until there are lyrics to place', async () => {
    seedDoc();
    open();
    await settle();
    const run = () => screen.getByTestId('align-lyrics-run') as HTMLButtonElement;
    expect(run().disabled).toBe(true);
    fireEvent.change(screen.getByTestId('align-lyrics-text'), { target: { value: '   ' } });
    expect(run().disabled).toBe(true);
    fireEvent.change(screen.getByTestId('align-lyrics-text'), { target: { value: TEXT } });
    expect(run().disabled).toBe(false);
  });

  it('reads the lyrics out of a text file when asked, without touching the audio path', async () => {
    seedDoc();
    open();
    await settle();
    bridge.showOpenDialog.mockResolvedValue(['C:/lyrics.txt']);
    const bytes = new TextEncoder().encode(TEXT);
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    bridge.readFile.mockResolvedValue(buffer);

    await act(async () => {
      fireEvent.click(screen.getByTestId('align-lyrics-load'));
    });
    await settle();
    expect(screen.getByTestId('align-lyrics-text')).toHaveValue(TEXT);
    expect(bridge.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ name: 'Lyrics or text', extensions: ['txt', 'lrc', 'md'] }] })
    );
  });

  it('says which scope the run will use, and follows the selection', async () => {
    seedDoc();
    open();
    await settle();
    expect(screen.getByTestId('align-lyrics-scope')).toHaveTextContent('Whole file');
    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: DOC_LENGTH / 2 });
    });
    expect(screen.getByTestId('align-lyrics-scope')).toHaveTextContent('Selection');
  });

  it('reports a run failure inline and leaves the dialog open', async () => {
    seedDoc();
    bridge.alignRun.mockResolvedValue({ ok: false, error: 'the host fell over' });
    open();
    await settle();
    await alignIn();
    await waitFor(() => expect(screen.getByTestId('align-lyrics-error')).toHaveTextContent('the host fell over'));
    expect(screen.getByTestId('align-lyrics-dialog')).toBeInTheDocument();
  });

  it('names the words the alphabet could not represent', async () => {
    seedDoc();
    open();
    await settle();
    fireEvent.change(screen.getByTestId('align-lyrics-text'), { target: { value: 'At 24 in\non' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('align-lyrics-run'));
    });
    await settle();
    expect(screen.getByTestId('align-lyrics-dropped-words')).toHaveTextContent('24');
  });
});

describe('runLabel', () => {
  it('names the phase, and appends the estimate only when there is one', () => {
    expect(runLabel(null, null)).toBe('Preparing the audio…');
    expect(runLabel(null, 30000)).toContain('0:30 left');
    expect(
      runLabel({ phase: 'aligning', done: 50, total: 100, fraction: 0.5, elapsedMs: 0, estimatedRemainingMs: null }, null)
    ).toBe('Listening — 50%');
    expect(
      runLabel({ phase: 'placing', done: 1, total: 1, fraction: 1, elapsedMs: 0, estimatedRemainingMs: 0 }, 0)
    ).toBe('Placing the words…');
  });
});
