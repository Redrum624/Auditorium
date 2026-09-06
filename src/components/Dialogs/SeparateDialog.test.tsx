import { render, screen, fireEvent, act } from '@testing-library/react';
import SeparateDialog from './SeparateDialog';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument } from '../../audio/AudioDocument';
import {
  cancelStemSeparation,
  ensureStemModel,
  getStemModelState,
  separateStems,
  type StemModelState,
  type StemSeparationOutput,
  type StemSeparationProgress,
  type StemSeparationResult,
  type StemSeparationStatus,
} from '../../services/stemService';
import {
  SPEAKER_LANDING_BUDGET_BYTES,
  landSpeakers,
  landStems,
  landVoice,
  speakerDocumentBytes,
  type StemLandingResult,
} from '../../services/stemLanding';
import {
  cancelDiarization,
  diarizeChannels,
  ensureDiarizeModels,
  getDiarizeModelState,
  limitsSentence,
  stageWeights,
  DIARIZE_MODEL_BYTES,
  type DiarizeModelState,
  type DiarizeResult,
} from '../../services/diarizeService';
import {
  MAX_SPEAKERS,
  reclusterDiarization,
  segmentsToDocSamples,
  type Diarization,
  type DiarizationEvidence,
} from '../../dsp/diarization';

// The RemixDialog.test.tsx / ConvertDialog.test.tsx pattern: everything pure
// (the label lists, the constants, the formatting) stays REAL via requireActual;
// only the effectful entry points this dialog drives — the model probe, the
// download, the separation and the landing — are swapped for controllable mocks.
jest.mock('../../services/stemService', () => ({
  ...jest.requireActual('../../services/stemService'),
  getStemModelState: jest.fn(),
  ensureStemModel: jest.fn(),
  separateStems: jest.fn(),
  cancelStemSeparation: jest.fn(),
}));

jest.mock('../../services/stemLanding', () => ({
  ...jest.requireActual('../../services/stemLanding'),
  landStems: jest.fn(),
  landVoice: jest.fn(),
  landSpeakers: jest.fn(),
}));

// D5's stages 2 and 3. The pure half stays REAL — `limitsSentence`,
// `stageWeights` and the model-byte constant are what the dialog is
// supposed to quote, so a test that mocked them would pin nothing.
jest.mock('../../services/diarizeService', () => ({
  ...jest.requireActual('../../services/diarizeService'),
  getDiarizeModelState: jest.fn(),
  ensureDiarizeModels: jest.fn(),
  diarizeChannels: jest.fn(),
  cancelDiarization: jest.fn(),
}));

// Only the re-cluster is mocked: it is the one call the review step MAKES,
// and driving the real clusterer would need real embeddings. Everything
// the dialog READS from this module — `segmentsToDocSamples`, the speaker
// cap — stays real, so the spans asserted below are the spans that land.
jest.mock('../../dsp/diarization', () => ({
  ...jest.requireActual('../../dsp/diarization'),
  reclusterDiarization: jest.fn(),
}));

const mockModelState = getStemModelState as jest.MockedFunction<typeof getStemModelState>;
const mockEnsureModel = ensureStemModel as jest.MockedFunction<typeof ensureStemModel>;
const mockSeparate = separateStems as jest.MockedFunction<typeof separateStems>;
const mockCancel = cancelStemSeparation as jest.MockedFunction<typeof cancelStemSeparation>;
const mockLandStems = landStems as jest.MockedFunction<typeof landStems>;
const mockLandVoice = landVoice as jest.MockedFunction<typeof landVoice>;
const mockLandSpeakers = landSpeakers as jest.MockedFunction<typeof landSpeakers>;
const mockDiarizeModelState = getDiarizeModelState as jest.MockedFunction<typeof getDiarizeModelState>;
const mockEnsureDiarize = ensureDiarizeModels as jest.MockedFunction<typeof ensureDiarizeModels>;
const mockDiarize = diarizeChannels as jest.MockedFunction<typeof diarizeChannels>;
const mockCancelDiarize = cancelDiarization as jest.MockedFunction<typeof cancelDiarization>;
const mockRecluster = reclusterDiarization as jest.MockedFunction<typeof reclusterDiarization>;

const SR = 44100;
/** `stemManager.cjs` MODEL_BYTES — the real pinned size, 166 MB when rounded. */
const MODEL_BYTES = 165612636;

const PRESENT: StemModelState = { downloaded: true, bytes: MODEL_BYTES, expectedBytes: MODEL_BYTES };
const MISSING: StemModelState = { downloaded: false, bytes: null, expectedBytes: MODEL_BYTES };

/** `diarizeManager.cjs` DIARIZE_FILES summed — 5,992,913 + 26,530,550 B,
 *  the 32.5 MB the model gate has to state. Read from the service rather
 *  than re-typed, so a re-pinned model set fails HERE and not in the UI. */
const DIARIZE_BYTES = DIARIZE_MODEL_BYTES;
const DIARIZE_PRESENT: DiarizeModelState = {
  downloaded: true,
  bytes: DIARIZE_BYTES,
  expectedBytes: DIARIZE_BYTES,
};
const DIARIZE_MISSING: DiarizeModelState = { downloaded: false, bytes: null, expectedBytes: DIARIZE_BYTES };
/** The measured stage shares (D5), derived from the three seeds — the bar
 *  assertions below compare against THESE, never against a literal 0.91. */
const STAGE_WEIGHTS = stageWeights();

function seedDoc(name = 'song.wav', samples = 16 * SR) {
  const doc = createDocument({
    name,
    sampleRate: SR,
    channels: [new Float32Array(samples), new Float32Array(samples)],
  });
  useAppStore.getState().addDocument(doc);
  return doc;
}

function makeOutput(overrides: Partial<StemSeparationOutput> = {}): StemSeparationOutput {
  const channels = () => [new Float32Array(8), new Float32Array(8)];
  return {
    sourceDocId: 'doc-1',
    sourceName: 'song.wav',
    sampleRate: SR,
    channelCount: 2,
    lengthSamples: 8,
    stems: [
      { label: 'Drums', channels: channels() },
      { label: 'Bass', channels: channels() },
      { label: 'Vocals', channels: channels() },
      { label: 'Other', channels: channels() },
    ],
    residual: channels(),
    sanitisedEstimateSamples: 0,
    ...overrides,
  };
}

function makeLanding(overrides: Partial<StemLandingResult> = {}): StemLandingResult {
  return {
    documentIds: ['d1', 'd2', 'd3', 'd4', 'd5'],
    trackIds: ['t1', 't2', 't3', 't4', 't5'],
    sessionName: 'song.wav — Stems',
    monoRoutedAsDualMono: false,
    sourcePeak: 0.8,
    exactSumHolds: true,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Renders with the model probe already settled (the dialog's steady state). */
async function renderSettled(onClose = jest.fn()) {
  const view = render(<SeparateDialog onClose={onClose} />);
  await act(async () => {});
  return { ...view, onClose };
}

/** Starts a separation that never settles on its own and hands back its
 *  progress callback, so a test can drive the running state. */
async function startRun(onClose = jest.fn()) {
  const pending = deferred<StemSeparationResult>();
  mockSeparate.mockReturnValue(pending.promise);
  const view = await renderSettled(onClose);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
  });
  const onProgress = mockSeparate.mock.calls[0][0].onProgress!;
  return { ...view, pending, onProgress };
}

function progressAt(overrides: Partial<StemSeparationProgress> = {}): StemSeparationProgress {
  return {
    phase: 'inference',
    segment: 3,
    totalSegments: 12,
    fraction: 0.25,
    elapsedMs: 40_000,
    estimatedRemainingMs: 158_000,
    ...overrides,
  };
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  jest.clearAllMocks();
  mockModelState.mockResolvedValue(PRESENT);
  mockEnsureModel.mockResolvedValue({ ok: true, path: 'C:/models/htdemucs.onnx' });
  mockSeparate.mockResolvedValue({ ok: true, output: makeOutput() });
  mockCancel.mockResolvedValue(true);
  mockLandStems.mockReturnValue(makeLanding());
});

describe('SeparateDialog', () => {
  it('1. probes the model on mount and offers Separate once it is present', async () => {
    seedDoc();
    await renderSettled();

    expect(mockModelState).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('separate-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('separate-model-missing')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Separate' })).toBeEnabled();
  });

  it('2. states the 166 MB download plainly and withholds Separate while the model is missing', async () => {
    seedDoc();
    mockModelState.mockResolvedValue(MISSING);
    await renderSettled();

    expect(screen.getByTestId('separate-model-missing')).toHaveTextContent('166 MB');
    expect(screen.getByTestId('separate-model-missing')).toHaveTextContent(/one[- ]time/i);
    expect(screen.getByRole('button', { name: 'Download Model' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Separate' })).not.toBeInTheDocument();
  });

  it('3. Download streams byte progress and flips to the ready state when it lands', async () => {
    seedDoc();
    mockModelState.mockResolvedValueOnce(MISSING);
    const pending = deferred<{ ok: true; path: string } | { ok: false; error: string }>();
    mockEnsureModel.mockReturnValue(pending.promise);
    await renderSettled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download Model' }));
    });
    const onProgress = mockEnsureModel.mock.calls[0][0]!;

    act(() => {
      onProgress({ received: 82_806_318, total: MODEL_BYTES });
    });
    // Both halves of "X of Y" come off ONE formatter, so the counter is quoted
    // to the same three figures as the bill: 82,806,318 B is 82.8 MB, not the
    // 83 whole megabytes would round it to.
    expect(screen.getByTestId('separate-download-status')).toHaveTextContent('82.8 MB of 166 MB');
    expect(screen.getByTestId('separate-download-progress').style.width).toBe('50%');

    mockModelState.mockResolvedValue(PRESENT);
    await act(async () => {
      pending.resolve({ ok: true, path: 'C:/models/htdemucs.onnx' });
    });

    expect(screen.queryByTestId('separate-model-missing')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Separate' })).toBeEnabled();
  });

  it('4. a failed download reports inline in amber and leaves the Download button usable', async () => {
    seedDoc();
    mockModelState.mockResolvedValue(MISSING);
    mockEnsureModel.mockResolvedValue({ ok: false, error: 'Download failed: getaddrinfo ENOTFOUND huggingface.co' });
    await renderSettled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download Model' }));
    });

    expect(screen.getByTestId('separate-error')).toHaveTextContent(
      'Download failed: getaddrinfo ENOTFOUND huggingface.co'
    );
    expect(screen.getByTestId('separate-error')).toHaveClass('text-[#e0a458]');
    expect(screen.getByRole('button', { name: 'Download Model' })).toBeEnabled();
  });

  it('5. the header follows the live active document', async () => {
    seedDoc('first.wav');
    await renderSettled();
    expect(screen.getByText(/^first\.wav · 0:16$/)).toBeInTheDocument();

    await act(async () => {
      seedDoc('second.wav', 8 * SR);
    });

    expect(screen.getByText(/^second\.wav · 0:08$/)).toBeInTheDocument();
  });

  it('5b. Separate resolves its target from the STORE at confirm time, not from the render closure', async () => {
    const first = seedDoc('first.wav');
    await renderSettled();
    await act(async () => {
      seedDoc('second.wav', 8 * SR);
    });

    // The switch back and the click happen in ONE act, so React has not
    // re-rendered when the handler runs: a dialog that captured its target
    // from the last render would separate `second.wav` here.
    await act(async () => {
      useAppStore.getState().setActiveDocument(first.id);
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    expect(mockSeparate).toHaveBeenCalledTimes(1);
    expect(mockSeparate).toHaveBeenCalledWith({
      sourceDocId: first.id,
      onProgress: expect.any(Function),
    });
  });

  it('6. the running state renders per-segment progress with a time estimate', async () => {
    seedDoc();
    const { onProgress } = await startRun();

    act(() => {
      onProgress(progressAt());
    });

    expect(screen.getByTestId('separate-progress-label')).toHaveTextContent('segment 3 of 12');
    expect(screen.getByTestId('separate-progress-label')).toHaveTextContent('2:38 left');
    expect(screen.getByTestId('separate-progress').style.width).toBe('25%');
  });

  it('6b. names all THREE phases of a run, not just inference', async () => {
    seedDoc();
    const { onProgress } = await startRun();
    const label = () => screen.getByTestId('separate-progress-label').textContent ?? '';

    // Before the host has said anything: the run is already visible, and the
    // label may not claim a segment it has no number for.
    expect(label()).toBe('Preparing the audio…');

    // The resample leg — minutes on a long file, and it carries the seed
    // estimate rather than a countdown from nothing.
    act(() => {
      onProgress(progressAt({ phase: 'resampling', segment: 0, totalSegments: 0, fraction: 0 }));
    });
    expect(label()).toBe('Preparing the audio… 2:38 left');

    act(() => {
      onProgress(progressAt());
    });
    expect(label()).toBe('Separating — segment 3 of 12 · 2:38 left');

    // The partition is its own minutes-long leg with every segment already in.
    // Without its branch it reads "segment 12 of 12 · 0:00 left" and then sits
    // there — a finished-looking line in front of the longest wait.
    act(() => {
      onProgress(
        progressAt({ phase: 'partitioning', segment: 12, fraction: 1, estimatedRemainingMs: 0 })
      );
    });
    expect(label()).toBe('Building the stems…');
    expect(label()).not.toContain('0:00 left');
  });

  it('7. Cancel while running kills the run through the service', async () => {
    seedDoc();
    const { pending } = await startRun();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(mockCancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ ok: false, status: 'cancelled', message: 'Stem separation was cancelled.' });
    });
    expect(screen.getByTestId('separate-error')).toHaveTextContent('Stem separation was cancelled.');
  });

  // Ruling 8: every refusal the service can return renders INLINE, in amber,
  // with the dialog still open so the user can react to it.
  const STATUSES: [StemSeparationStatus, string][] = [
    ['no-document', 'Document doc-1 is not open.'],
    ['empty-document', 'song.wav has no audio to separate.'],
    ['too-long', 'Stem separation is limited to 15 minutes of audio.'],
    ['busy', 'A stem separation is already running.'],
    ['model-missing', 'The separation model has not been downloaded yet (166 MB, one time).'],
    ['cancelled', 'Stem separation was cancelled.'],
    ['stale', 'The source audio changed during separation — the stems were discarded.'],
    ['source-closed', 'The source document was closed during separation.'],
    ['failed', 'The separation host failed.'],
  ];

  it.each(STATUSES)('8. status "%s" renders inline in amber and keeps the dialog open', async (status, message) => {
    seedDoc();
    const onClose = jest.fn();
    mockSeparate.mockResolvedValue({ ok: false, status, message });
    await renderSettled(onClose);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    const error = screen.getByTestId('separate-error');
    expect(error).toHaveTextContent(message);
    expect(error).toHaveClass('text-[#e0a458]');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('separate-dialog')).toBeInTheDocument();
    expect(mockLandStems).not.toHaveBeenCalled();
  });

  it('9. a model-missing refusal returns the dialog to its download state', async () => {
    seedDoc();
    mockSeparate.mockResolvedValue({
      ok: false,
      status: 'model-missing',
      message: 'The separation model has not been downloaded yet (166 MB, one time).',
    });
    await renderSettled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    expect(screen.getByTestId('separate-model-missing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download Model' })).toBeInTheDocument();
  });

  it('10. Escape does not close while busy, and does close once idle', async () => {
    seedDoc();
    const onClose = jest.fn();
    const { pending } = await startRun(onClose);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({ ok: false, status: 'cancelled', message: 'Stem separation was cancelled.' });
    });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('11. unmounting mid-run cancels the separation', async () => {
    seedDoc();
    const { unmount, pending } = await startRun();

    expect(mockCancel).not.toHaveBeenCalled();
    unmount();
    expect(mockCancel).toHaveBeenCalledTimes(1);

    // The service still settles; nothing lands and nothing throws.
    await act(async () => {
      pending.resolve({ ok: false, status: 'cancelled', message: 'Stem separation was cancelled.' });
    });
    expect(mockLandStems).not.toHaveBeenCalled();
  });

  it('11b. stems that arrive AFTER the unmount are discarded, not landed', async () => {
    seedDoc();
    const output = makeOutput();
    const { unmount, pending, onClose } = await startRun();

    unmount();
    expect(mockCancel).toHaveBeenCalledTimes(1);

    // Test 11 resolves CANCELLED, and `!result.ok` returns before the landing
    // on its own — so the unmount guard it looks like it is testing can be
    // deleted with test 11 still green. This is the resolve that reaches it:
    // the host was already partitioning when the dialog went away and hands
    // back a finished output. It must be dropped. Landing it builds five
    // documents and a multitrack session into a session the user has closed
    // the dialog on, and calls `onClose` on a component that is gone.
    await act(async () => {
      pending.resolve({ ok: true, output });
    });

    expect(mockLandStems).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('12. success lands the five documents and closes', async () => {
    seedDoc();
    const output = makeOutput();
    mockSeparate.mockResolvedValue({ ok: true, output });
    const { onClose } = await renderSettled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    expect(mockLandStems).toHaveBeenCalledTimes(1);
    expect(mockLandStems).toHaveBeenCalledWith(output);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockLandStems.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0]);
  });

  it('13. an over-unity source is told the truth: the stems land, the exact sum does not hold', async () => {
    seedDoc();
    mockLandStems.mockReturnValue(makeLanding({ sourcePeak: 2.4, exactSumHolds: false }));
    const { onClose } = await renderSettled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    expect(mockLandStems).toHaveBeenCalledTimes(1);
    const note = screen.getByTestId('separate-note-exactness');
    expect(note).toHaveTextContent(/peaks above full scale/i);
    expect(note).toHaveTextContent('2.40');
    expect(note).toHaveTextContent(/will not add back/i);
    // The stems half of `exactnessNote`'s voice ternary, pinned in BOTH
    // directions. Without the negatives the whole branch is free: the note
    // could tell a five-stem user that "the two tracks will not add back" and
    // that "The Voice and the Backing themselves are complete" — two lanes
    // that only exist in voice mode. VR9 pins the mirror image.
    expect(note).toHaveTextContent(/five tracks/i);
    expect(note).not.toHaveTextContent(/two tracks/i);
    expect(note).toHaveTextContent(/The stems themselves are complete/);
    expect(note).not.toHaveTextContent(/Voice and the Backing/);
    expect(note).toHaveClass('text-[#e0a458]');
    // The result has to stay readable, so this one does NOT auto-close.
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('13b. an undetermined verdict (source closed) makes no claim either way', async () => {
    seedDoc();
    mockLandStems.mockReturnValue(makeLanding({ sourcePeak: null, exactSumHolds: null }));
    const { onClose } = await renderSettled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    expect(screen.queryByTestId('separate-note-exactness')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('14. sanitised model samples are reported as a short, non-alarming note', async () => {
    seedDoc();
    mockSeparate.mockResolvedValue({ ok: true, output: makeOutput({ sanitisedEstimateSamples: 7 }) });
    const { onClose } = await renderSettled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    const note = screen.getByTestId('separate-note-sanitised');
    expect(note).toHaveTextContent('7');
    expect(note).toHaveTextContent(/Residual/);
    expect(note).toHaveTextContent(/sum is still exact/i);
    expect(onClose).not.toHaveBeenCalled();
  });

  // Ruling 1: the hard guarantee and the quality target are different kinds and
  // the dialog says so before the user commits minutes of inference to it.
  it('15. states both guarantees in plain language before the run', async () => {
    seedDoc();
    await renderSettled();

    const text = screen.getByTestId('separate-guarantees').textContent ?? '';
    expect(text).toMatch(/add back up to your original, sample for sample/i);
    expect(text).toMatch(/no audio is lost/i);
    expect(text).toMatch(/bounded by the model/i);
    expect(text).toMatch(/expect some bleed/i);
    expect(text).toMatch(/not a bug/i);
  });

  it('16. names the five tracks it will produce and estimates the run', async () => {
    seedDoc('song.wav', 16 * SR);
    await renderSettled();

    expect(screen.getByTestId('separate-produces')).toHaveTextContent(
      'Drums, Bass, Vocals, Other and Residual'
    );
    // 16 s at the measured 1.52x realtime factor -> ~10.5 s.
    expect(screen.getByTestId('separate-estimate')).toHaveTextContent('1.5x realtime');
    expect(screen.getByTestId('separate-estimate')).toHaveTextContent('0:11');
  });

  it('17. reports plainly when no document is open and withholds Separate', async () => {
    await renderSettled();

    expect(screen.getByTestId('separate-error')).toHaveTextContent('No document is open.');
    expect(screen.getByRole('button', { name: 'Separate' })).toBeDisabled();
  });
});

describe('G5 glass header', () => {
  it('carries a lucide icon tile and a "name · duration" subtitle (mockup anatomy)', async () => {
    seedDoc();
    await renderSettled();
    expect(screen.getByTestId('dialog-icon')).toBeInTheDocument();
    expect(screen.getByText(/^song\.wav · \d+:\d{2}$/)).toBeInTheDocument();
  });
});

/**
 * D5 — the SAME dialog in voice mode, now a THREE-stage run: HT-Demucs, then
 * the segmentation + embedding host, then a CONFIRMATION step the user lands
 * from. Nothing lands until they press the Land button, which is the whole
 * point of the step: a speaker split is a guess, and a guess that has already
 * built six full-length documents is expensive to disagree with.
 *
 * What is deliberately NOT re-tested here: the stem model probe, the
 * per-segment progress line, the nine refusal statuses and the live-document
 * resolution. Those are one code path shared with stems mode and the suite
 * above pins them; repeating them per mode would only pin that a prop was
 * threaded twice.
 */
describe('SeparateDialog — voice mode (D5, three stages)', () => {
  /** 15 minutes of 44.1 kHz stereo — D4's own worked example, so
   *  `speakerDocumentBytes` returns its 317,520,000 B and the budget maths in
   *  these tests is the maths the plan measured. The channel arrays stay tiny:
   *  every landing is mocked, so nothing here ever reads them. */
  const FIFTEEN_MIN = 15 * 60 * SR;

  function makeVoiceOutput(overrides: Partial<StemSeparationOutput> = {}): StemSeparationOutput {
    return makeOutput({ lengthSamples: FIFTEEN_MIN, ...overrides });
  }

  /** Evidence the dialog only ever counts (it is handed back to
   *  `reclusterDiarization` untouched), so the vectors are shaped, not real. */
  function makeEvidence(count = 12): DiarizationEvidence {
    return {
      totalSamples16k: 16 * 16_000,
      windows: [],
      embeddings: Array.from({ length: count }, (_, i) => ({
        windowIndex: i,
        localSpeaker: i % 3,
        activeFrames: 17 + i,
        vector: new Float32Array(256),
      })),
    };
  }

  /** Two speakers, three turns, 10 s against 3 s — deliberately unequal, and
   *  deliberately NOT dividing into whole percents. 10 of 13 is 76.92 % and 3
   *  of 13 is 23.08 %, so `Math.round` (77/23), `Math.floor` (76/23) and
   *  `Math.ceil` (77/24) all disagree and the share line's rounding is
   *  measured. A 9/3 split reads 75/25 under all three — the identity. */
  function makeDiarization(overrides: Partial<Diarization> = {}): Diarization {
    return {
      speakerCount: 2,
      preFoldClusterCount: 4,
      rawClusterCount: 2,
      segments: [
        { startSample16k: 8_000, endSample16k: 56_000, speaker: 0 },
        { startSample16k: 72_000, endSample16k: 120_000, speaker: 1 },
        { startSample16k: 136_000, endSample16k: 232_000, speaker: 0 },
      ],
      overlapSegments: [],
      speechSeconds: [10, 3],
      ...overrides,
    };
  }

  function makeThreeSpeakers(): Diarization {
    return makeDiarization({
      speakerCount: 3,
      preFoldClusterCount: 3,
      rawClusterCount: 3,
      segments: [
        { startSample16k: 8_000, endSample16k: 56_000, speaker: 0 },
        { startSample16k: 72_000, endSample16k: 120_000, speaker: 1 },
        { startSample16k: 136_000, endSample16k: 232_000, speaker: 2 },
      ],
      speechSeconds: [3, 3, 6],
    });
  }

  const EMPTY_DIARIZATION: Diarization = {
    speakerCount: 0,
    preFoldClusterCount: 0,
    rawClusterCount: 0,
    segments: [],
    overlapSegments: [],
    speechSeconds: [],
  };

  function makeVoiceLanding(overrides: Partial<StemLandingResult> = {}): StemLandingResult {
    return makeLanding({ documentIds: ['v1', 'v2'], trackIds: ['vt1', 'vt2'], ...overrides });
  }

  function makeSpeakerLanding(overrides: Partial<StemLandingResult> = {}): StemLandingResult {
    return makeLanding({
      documentIds: ['s1', 's2', 's3'],
      trackIds: ['st1', 'st2', 'st3'],
      // D4: a speaker split is not a partition, so the landing makes no claim.
      exactSumHolds: null,
      ...overrides,
    });
  }

  beforeEach(() => {
    mockDiarizeModelState.mockResolvedValue(DIARIZE_PRESENT);
    mockEnsureDiarize.mockResolvedValue({ ok: true });
    mockDiarize.mockResolvedValue({ ok: true, evidence: makeEvidence(), diarization: makeDiarization() });
    mockCancelDiarize.mockResolvedValue(true);
    mockRecluster.mockReturnValue(makeDiarization());
    mockLandVoice.mockReturnValue(makeVoiceLanding());
    mockLandSpeakers.mockReturnValue(makeSpeakerLanding());
    mockSeparate.mockResolvedValue({ ok: true, output: makeVoiceOutput() });
  });

  async function renderVoice(onClose = jest.fn()) {
    const view = render(<SeparateDialog mode="voice" onClose={onClose} />);
    await act(async () => {});
    return { ...view, onClose };
  }

  /** Runs both stages to their end and leaves the dialog on the review step. */
  async function runToReview(
    diarization: Diarization = makeDiarization(),
    evidence: DiarizationEvidence = makeEvidence(),
    onClose = jest.fn()
  ) {
    const output = makeVoiceOutput();
    mockSeparate.mockResolvedValue({ ok: true, output });
    mockDiarize.mockResolvedValue({ ok: true, evidence, diarization });
    const view = await renderVoice(onClose);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });
    return { ...view, output, evidence, diarization };
  }

  const width = (testId: string): number => Number.parseInt(screen.getByTestId(testId).style.width, 10);

  // ---------------------------------------------------------------- the gate

  it('VG1. names BOTH model sets with their sizes when either one is missing', async () => {
    seedDoc();
    mockDiarizeModelState.mockResolvedValue(DIARIZE_MISSING);
    await renderVoice();

    // The Demucs set is already here and is still listed: the user is about to
    // start a download and needs to know what the whole bill is, not the
    // unpaid half of it.
    expect(screen.getByTestId('separate-model-line-stems')).toHaveTextContent('166 MB');
    expect(screen.getByTestId('separate-model-line-speakers')).toHaveTextContent('32.5 MB');
    expect(screen.queryByRole('button', { name: 'Separate' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download Models' })).toBeEnabled();
  });

  it('VG2. Download runs ONLY the missing ensure, and the bar spans that set alone', async () => {
    seedDoc();
    mockDiarizeModelState.mockResolvedValue(DIARIZE_MISSING);
    const pending = deferred<{ ok: true } | { ok: false; error: string }>();
    mockEnsureDiarize.mockReturnValue(pending.promise);
    await renderVoice();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download Models' }));
    });

    // The Demucs model is present, so its ensure is never called.
    expect(mockEnsureModel).not.toHaveBeenCalled();
    expect(mockEnsureDiarize).toHaveBeenCalledTimes(1);
    const status = screen.getByTestId('separate-download-status');
    expect(status).toHaveTextContent('speaker models');
    // ONE download, ONE size. VG1 pins the per-set line at 32.5 MB and the
    // progress line four lines under it has to agree: whole megabytes round
    // 32,523,463 B up to "33 MB" and put two different figures for the same
    // file on one panel. VG2b pins the other half of that rule — the running
    // counter is quoted the same way, so it can never overshoot its own total.
    expect(status).toHaveTextContent('of 32.5 MB');
    expect(status).not.toHaveTextContent('of 33 MB');
    expect(screen.getByTestId('separate-model-line-speakers')).toHaveTextContent('32.5 MB');

    act(() => {
      mockEnsureDiarize.mock.calls[0][0]!({ received: DIARIZE_BYTES / 2, total: DIARIZE_BYTES });
    });
    expect(width('separate-download-progress')).toBe(50);

    mockDiarizeModelState.mockResolvedValue(DIARIZE_PRESENT);
    await act(async () => {
      pending.resolve({ ok: true });
    });
    expect(screen.getByRole('button', { name: 'Separate' })).toBeEnabled();
  });

  it('VG2b. the counter is quoted like the total, so the last tick cannot overshoot it', async () => {
    seedDoc();
    mockDiarizeModelState.mockResolvedValue(DIARIZE_MISSING);
    const pending = deferred<{ ok: true } | { ok: false; error: string }>();
    mockEnsureDiarize.mockReturnValue(pending.promise);
    await renderVoice();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download Models' }));
    });
    const onProgress = mockEnsureDiarize.mock.calls[0][0]!;
    const status = () => screen.getByTestId('separate-download-status');

    // Mid-download, off every identity in sight: 24,178,000 B is not the
    // total, not a whole megabyte, and not half of anything.
    act(() => {
      onProgress({ received: 24_178_000, total: DIARIZE_BYTES });
    });
    expect(status().textContent).toBe('Downloading the speaker models… 24.2 MB of 32.5 MB');

    // The tick EVERY download ends on — diarizeManager sends the
    // received === total event unthrottled. A counter on whole megabytes
    // rounded 32,523,463 B up to 33 and printed "33 MB of 32.5 MB": a received
    // figure larger than the total it was counting towards.
    act(() => {
      onProgress({ received: DIARIZE_BYTES, total: DIARIZE_BYTES });
    });
    expect(status().textContent).toBe('Downloading the speaker models… 32.5 MB of 32.5 MB');
    expect(status()).not.toHaveTextContent('33 MB');
    expect(width('separate-download-progress')).toBe(100);

    // ...and a mirror that serves a few hundred kilobytes past the pinned size
    // still cannot bill more than the bill: 32.9 MB would print if the counter
    // were not held to the total.
    act(() => {
      onProgress({ received: DIARIZE_BYTES + 400_000, total: DIARIZE_BYTES });
    });
    expect(status().textContent).toBe('Downloading the speaker models… 32.5 MB of 32.5 MB');

    mockDiarizeModelState.mockResolvedValue(DIARIZE_PRESENT);
    await act(async () => {
      pending.resolve({ ok: true });
    });
    expect(screen.getByRole('button', { name: 'Separate' })).toBeEnabled();
  });

  it('VG3. both sets missing: the two ensures run in ORDER over one monotone bar', async () => {
    seedDoc();
    mockModelState.mockResolvedValue(MISSING);
    mockDiarizeModelState.mockResolvedValue(DIARIZE_MISSING);
    const stemPending = deferred<{ ok: true; path: string } | { ok: false; error: string }>();
    const diarPending = deferred<{ ok: true } | { ok: false; error: string }>();
    mockEnsureModel.mockReturnValue(stemPending.promise);
    mockEnsureDiarize.mockReturnValue(diarPending.promise);
    await renderVoice();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download Models' }));
    });

    // Demucs first, and the speaker set has NOT started: sequential, not both
    // at once — two concurrent multi-hundred-megabyte downloads on one link is
    // how the slower of them times out.
    expect(mockEnsureModel).toHaveBeenCalledTimes(1);
    expect(mockEnsureDiarize).not.toHaveBeenCalled();
    expect(screen.getByTestId('separate-download-status')).toHaveTextContent('voice separation model');

    const total = MODEL_BYTES + DIARIZE_BYTES;
    act(() => {
      mockEnsureModel.mock.calls[0][0]!({ received: MODEL_BYTES / 2, total: MODEL_BYTES });
    });
    // Half of Demucs is half of Demucs against the SUM, not half the bar.
    expect(width('separate-download-progress')).toBe(Math.round((MODEL_BYTES / 2 / total) * 100));
    const afterHalfStems = width('separate-download-progress');

    mockModelState.mockResolvedValue(PRESENT);
    await act(async () => {
      stemPending.resolve({ ok: true, path: 'C:/models/htdemucs.onnx' });
    });
    expect(mockEnsureDiarize).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('separate-download-status')).toHaveTextContent('speaker models');
    // The second set's own progress restarts at zero; the shared bar must not.
    const afterStems = width('separate-download-progress');
    expect(afterStems).toBeGreaterThanOrEqual(afterHalfStems);

    act(() => {
      mockEnsureDiarize.mock.calls[0][0]!({ received: DIARIZE_BYTES / 2, total: DIARIZE_BYTES });
    });
    expect(width('separate-download-progress')).toBeGreaterThanOrEqual(afterStems);
    expect(width('separate-download-progress')).toBe(
      Math.round(((MODEL_BYTES + DIARIZE_BYTES / 2) / total) * 100)
    );

    mockDiarizeModelState.mockResolvedValue(DIARIZE_PRESENT);
    await act(async () => {
      diarPending.resolve({ ok: true });
    });
    expect(screen.getByRole('button', { name: 'Separate' })).toBeEnabled();
  });

  it('VG4. a set that DID land is re-probed even when the next one fails', async () => {
    seedDoc();
    mockModelState.mockResolvedValue(MISSING);
    mockDiarizeModelState.mockResolvedValue(DIARIZE_MISSING);
    mockEnsureDiarize.mockResolvedValue({ ok: false, error: 'Download failed: ECONNRESET' });
    await renderVoice();

    // Demucs lands; the speaker set does not.
    mockModelState.mockResolvedValue(PRESENT);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download Models' }));
    });

    expect(screen.getByTestId('separate-error')).toHaveTextContent('Download failed: ECONNRESET');
    // The 166 MB set is on disk now and the gate has to say so: a line still
    // reading "needed" asks the user to pay a bill they already paid.
    expect(screen.getByTestId('separate-model-line-stems')).toHaveTextContent('already here');
    expect(mockModelState).toHaveBeenCalledTimes(2);

    // ...and the retry runs only the ensure that is still missing, over a bar
    // that spans the 32.5 MB set alone, not the 198 MB both would have cost.
    const pending = deferred<{ ok: true } | { ok: false; error: string }>();
    mockEnsureDiarize.mockReturnValue(pending.promise);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download Models' }));
    });
    expect(mockEnsureModel).toHaveBeenCalledTimes(1);
    expect(mockEnsureDiarize).toHaveBeenCalledTimes(2);
    const status = screen.getByTestId('separate-download-status');
    expect(status).toHaveTextContent('of 32.5 MB');
    expect(status).not.toHaveTextContent('of 198 MB');
  });

  // ------------------------------------------------------------- the pre-run

  it('VP1. states what a speaker split produces — one track per speaker, never "two tracks"', async () => {
    seedDoc();
    await renderVoice();

    expect(screen.getByText('Separate Voice')).toBeInTheDocument();
    expect(screen.queryByText('Separate into Stems')).not.toBeInTheDocument();
    const produces = screen.getByTestId('separate-produces');
    expect(produces).toHaveTextContent('One track per speaker plus Backing.');
    expect(produces).toHaveTextContent('separated from everything else first');
    // The two-track sentence belonged to the old Voice + Backing landing and
    // is wrong for every run that finds more than one speaker.
    expect(produces).not.toHaveTextContent('Two tracks');
    expect(produces).not.toHaveTextContent('Residual');
  });

  it('VP2. promises the Backing sum and REFUSES the speaker one (D4: fades, shared overlap)', async () => {
    seedDoc();
    await renderVoice();

    const text = screen.getByTestId('separate-guarantees').textContent ?? '';
    expect(text).toMatch(/Backing adds back to your original as before/);
    expect(text).toMatch(/short fades at each edge/);
    expect(text).toMatch(/do not add back sample for sample/);
  });

  it('VP3. the estimate sums stage 1 and the WHOLE of stage 2 — segmentation AND embedding', async () => {
    // 900 audio seconds, not the 16 s a small fixture would use: at 16 s
    // Demucs alone (10.53 s), Demucs + segmentation (10.66 s) and D1's whole
    // stage 1 + 2 (11.54 s) all round to the same 0:11, so the pin would be
    // measuring the identity. At 900 s they separate: 9:52 / 9:59 / 10:49.
    // A mono 8 kHz document because only length / sampleRate reaches the
    // estimate, and 900 s of 44.1 kHz stereo is 317 MB of fixture.
    const doc = createDocument({
      name: 'long.wav',
      sampleRate: 8_000,
      channels: [new Float32Array(900 * 8_000)],
    });
    useAppStore.getState().addDocument(doc);
    await renderVoice();

    // 900 / 1.52 = 592.11 s of Demucs + 900 x (8 + 55) ms = 56.7 s of
    // segmentation + embedding = 648.81 s. The embedding half is 6.9x the
    // segmentation half, so dropping it is the bigger of the two errors.
    const estimate = screen.getByTestId('separate-estimate');
    expect(estimate).toHaveTextContent('10:49');
    // Demucs alone, and Demucs + segmentation only: both understate the wait.
    expect(estimate).not.toHaveTextContent('9:52');
    expect(estimate).not.toHaveTextContent('9:59');
    expect(estimate).toHaveTextContent('plus a short pass to tell the voices apart');
  });

  // ----------------------------------------------------------------- the run

  it('VR1. shows the three stage labels in order over ONE monotone weighted bar', async () => {
    seedDoc();
    const stemPending = deferred<StemSeparationResult>();
    mockSeparate.mockReturnValue(stemPending.promise);
    await renderVoice();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });
    const label = (): string => screen.getByTestId('separate-progress-label').textContent ?? '';

    act(() => {
      mockSeparate.mock.calls[0][0].onProgress!(progressAt());
    });
    expect(label()).toContain('Separating — segment 3 of 12');
    const atStemQuarter = width('separate-progress');
    // Demucs owns ~91 % of the run, so a quarter of it is ~23 % of the bar —
    // NOT 25 %, which is what an unweighted bar would show.
    expect(atStemQuarter).toBe(Math.round(0.25 * STAGE_WEIGHTS.separate * 100));

    const diarPending = deferred<DiarizeResult>();
    mockDiarize.mockReturnValue(diarPending.promise);
    await act(async () => {
      stemPending.resolve({ ok: true, output: makeVoiceOutput() });
    });
    // Stage 1 is over: the bar sits at exactly its weight.
    expect(width('separate-progress')).toBe(Math.round(STAGE_WEIGHTS.separate * 100));

    const onDiarizeProgress = mockDiarize.mock.calls[0][0].onProgress!;
    act(() => {
      onDiarizeProgress({
        phase: 'segmenting',
        done: 14,
        total: 57,
        fraction: 0.03,
        elapsedMs: 400,
        estimatedRemainingMs: 900,
      });
    });
    expect(label()).toContain('Listening for speakers — window 14 of 57');
    const atSegment = width('separate-progress');
    // The stage-2 span is BOTH remaining weights, not the segmentation share
    // alone: at fraction 0.03 the whole span reads 92 % and segmentation-only
    // reads 91, so an exact pin is what tells the two apart. A relative
    // `toBeGreaterThan` cannot — every wrong span still rises.
    expect(atSegment).toBe(
      Math.round((STAGE_WEIGHTS.separate + (STAGE_WEIGHTS.segment + STAGE_WEIGHTS.embed) * 0.03) * 100)
    );

    act(() => {
      onDiarizeProgress({
        phase: 'embedding',
        done: 23,
        total: 41,
        fraction: 0.6,
        elapsedMs: 3_000,
        estimatedRemainingMs: 2_000,
      });
    });
    expect(label()).toContain('Comparing voices — 23 of 41');
    expect(width('separate-progress')).toBeGreaterThan(atSegment);
    expect(width('separate-progress')).toBe(
      Math.round((STAGE_WEIGHTS.separate + (STAGE_WEIGHTS.segment + STAGE_WEIGHTS.embed) * 0.6) * 100)
    );

    // D5: the assembly runs behind the LAST label after a yield — a
    // 'clustering' event must not blank the line the user is reading.
    act(() => {
      onDiarizeProgress({
        phase: 'clustering',
        done: 0,
        total: 0,
        fraction: 1,
        elapsedMs: 3_100,
        estimatedRemainingMs: 0,
      });
    });
    expect(label()).toContain('Comparing voices — 23 of 41');
    // The terminal stage-2 event FILLS the bar. D5's weights are a partition
    // of the run, so stage 1's weight plus the whole of stage 2 is 1 — a bar
    // that stops at 92 % here means the embedding share was dropped from the
    // span and the review panel opens over an unfinished bar.
    expect(width('separate-progress')).toBe(100);

    await act(async () => {
      diarPending.resolve({ ok: true, evidence: makeEvidence(), diarization: makeDiarization() });
    });
    expect(screen.getByTestId('speaker-review')).toBeInTheDocument();
  });

  it('VR1b. the weighted bar never falls: a late stem event during stage 2 cannot walk it back', async () => {
    seedDoc();
    const stemPending = deferred<StemSeparationResult>();
    mockSeparate.mockReturnValue(stemPending.promise);
    const diarPending = deferred<DiarizeResult>();
    mockDiarize.mockReturnValue(diarPending.promise);
    await renderVoice();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });
    const onStemProgress = mockSeparate.mock.calls[0][0].onProgress!;

    act(() => {
      onStemProgress(progressAt({ segment: 12, fraction: 1, estimatedRemainingMs: 0 }));
    });
    const atStemEnd = width('separate-progress');
    expect(atStemEnd).toBe(Math.round(STAGE_WEIGHTS.separate * 100));

    await act(async () => {
      stemPending.resolve({ ok: true, output: makeVoiceOutput() });
    });
    const onDiarizeProgress = mockDiarize.mock.calls[0][0].onProgress!;

    // Stage 2's first event carries fraction 0. The bar is a WHOLE-RUN bar, so
    // it stays at stage 1's weight instead of restarting from nothing.
    act(() => {
      onDiarizeProgress({
        phase: 'segmenting',
        done: 0,
        total: 57,
        fraction: 0,
        elapsedMs: 0,
        estimatedRemainingMs: 1_200,
      });
    });
    expect(width('separate-progress')).toBe(atStemEnd);

    // The stem host's onProgress closure is still callable after its promise
    // settled, and D5's clamp is what that costs: one straggling event at a
    // quarter computes ~23 % of the bar and, unclamped, walks it back from
    // 91 % in front of the user.
    act(() => {
      onStemProgress(progressAt());
    });
    expect(width('separate-progress')).toBe(atStemEnd);
    expect(screen.getByTestId('separate-progress-label')).toHaveTextContent(
      'Listening for speakers — window 0 of 57'
    );
  });

  it('VR2. hands the VOCALS stem to the diarizer at the output rate, and nothing else', async () => {
    // The document is 44.1 kHz and the OUTPUT is 48 kHz, on purpose: with both
    // at 44,100 the rate the dialog forwards, the document's rate and a
    // hardcoded literal are one number, and the assertion below would be
    // measuring the identity. `diarizeService` resamples from THIS rate, so a
    // dialog that passed the document's would put every window index and every
    // returned span out by 8.8 % on a 48 kHz source.
    seedDoc();
    // And the stems arrive SHUFFLED, on purpose. The dialog selects Vocals by
    // LABEL because `stemService` does not guarantee the host's order, and
    // every other fixture here emits Drums, Bass, Vocals, Other — an order in
    // which `stems[2]` and the label agree, so an index-based pick would read
    // as correct. Here Vocals is last and index 2 is Other: a dialog that
    // indexed would hand the diarizer the wrong hundreds of megabytes and
    // split the wrong audio.
    const base = makeVoiceOutput({ sampleRate: 48_000 });
    const output: StemSeparationOutput = {
      ...base,
      stems: [base.stems[0], base.stems[1], base.stems[3], base.stems[2]],
    };
    const vocals = output.stems.find((s) => s.label === 'Vocals')!;
    expect(output.stems.map((s) => s.label)).toEqual(['Drums', 'Bass', 'Other', 'Vocals']);
    mockSeparate.mockResolvedValue({ ok: true, output });
    await renderVoice();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    expect(mockDiarize).toHaveBeenCalledTimes(1);
    const req = mockDiarize.mock.calls[0][0];
    // By REFERENCE: the Vocals stem is hundreds of megabytes and is read, not
    // copied — and it is Vocals BY LABEL, not whatever sits at a fixed index.
    expect(req.channels).toBe(vocals.channels);
    expect(req.channels).not.toBe(output.stems[0].channels);
    expect(req.channels).not.toBe(output.stems[2].channels);
    expect(req.sampleRate).toBe(48_000);
    expect(req.sampleRate).toBe(output.sampleRate);
    expect(req.sampleRate).not.toBe(SR);
    expect(typeof req.shouldCancel).toBe('function');
    expect(mockLandSpeakers).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------- the review

  it('VR3. the review reports the count, each speaker’s speech and share, and the size', async () => {
    seedDoc();
    await runToReview();

    expect(screen.getByTestId('speaker-review')).toBeInTheDocument();
    expect(screen.getByTestId('speaker-review-headline')).toHaveTextContent('Found 2 speakers');
    expect(screen.getByTestId('speaker-review-row-1')).toHaveTextContent('0:10');
    expect(screen.getByTestId('speaker-review-row-2')).toHaveTextContent('0:03');
    // 10 s and 3 s of 13 s placed: 76.92 % and 23.08 %. Pinned as the ROUNDED
    // pair AND as a pair that still sums to 100 — `Math.floor` prints 76/23
    // (99 in total) and `Math.ceil` prints 77/24 (101). Whole-percent fixtures
    // agree under all three, so they pin the seconds, not the rounding.
    const shares = [1, 2].map((row) =>
      Number(
        /(\d+)% of what was placed/.exec(
          screen.getByTestId(`speaker-review-row-${row}`).textContent ?? ''
        )![1]
      )
    );
    expect(shares).toEqual([77, 23]);
    expect(shares[0] + shares[1]).toBe(100);
    // D4's worked example: 15 min of 44.1 kHz stereo is 317.5 MB per speaker.
    expect(screen.getByTestId('speaker-review-size')).toHaveTextContent('317.5 MB');
    expect(screen.getByTestId('speaker-review-size')).toHaveTextContent('635.0 MB');
    expect(screen.getByTestId('speaker-count')).toHaveValue('2');
    expect(screen.getByTestId('speaker-review-limits')).toHaveTextContent(limitsSentence());
    expect(mockLandSpeakers).not.toHaveBeenCalled();
    expect(mockLandVoice).not.toHaveBeenCalled();
  });

  it('VR4. a new count re-clusters the SAME evidence — no second model run', async () => {
    seedDoc();
    const { evidence } = await runToReview();
    mockRecluster.mockReturnValue(makeThreeSpeakers());

    await act(async () => {
      fireEvent.change(screen.getByTestId('speaker-count'), { target: { value: '3' } });
    });

    expect(mockRecluster).toHaveBeenCalledTimes(1);
    expect(mockRecluster).toHaveBeenCalledWith(evidence, 3);
    expect(mockSeparate).toHaveBeenCalledTimes(1);
    expect(mockDiarize).toHaveBeenCalledTimes(1);
    // The panel now describes the NEW clustering, not the old one.
    expect(screen.getByTestId('speaker-review-headline')).toHaveTextContent('Found 3 speakers');
    expect(screen.getByTestId('speaker-review-row-3')).toHaveTextContent('0:06');
    expect(screen.getByTestId('speaker-review-row-3')).toHaveTextContent('50%');
    expect(screen.getByTestId('speaker-review-size')).toHaveTextContent('952.6 MB');
    expect(screen.getByRole('button', { name: 'Land 3 speakers + Backing' })).toBeInTheDocument();
  });

  it('VR5. asking for more than the speech supports says so instead of pretending', async () => {
    seedDoc();
    await runToReview();
    mockRecluster.mockReturnValue(makeThreeSpeakers());

    await act(async () => {
      fireEvent.change(screen.getByTestId('speaker-count'), { target: { value: '4' } });
    });

    expect(mockRecluster).toHaveBeenCalledWith(expect.anything(), 4);
    expect(screen.getByTestId('speaker-review-headline')).toHaveTextContent(
      'Asked for 4 — 3 had enough speech to keep'
    );
    // The button names what will actually land, not what was asked for.
    expect(screen.getByRole('button', { name: 'Land 3 speakers + Backing' })).toBeInTheDocument();
    // The select keeps showing the ASKED number, or the user cannot tell that
    // their choice was heard and could not be honoured.
    expect(screen.getByTestId('speaker-count')).toHaveValue('4');
  });

  it('VR6. the select offers 1..MAX_SPEAKERS and never fewer than the count in hand', async () => {
    seedDoc();
    await runToReview();

    const options = Array.from(screen.getByTestId('speaker-count').querySelectorAll('option')).map((o) =>
      o.getAttribute('value')
    );
    expect(options).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(MAX_SPEAKERS).toBe(6);
  });

  const optionValues = (): (string | null)[] =>
    Array.from(screen.getByTestId('speaker-count').querySelectorAll('option')).map((o) =>
      o.getAttribute('value')
    );

  it('VR6b. the offer is pinned AT MAX_SPEAKERS and one step past it', async () => {
    seedDoc();
    // VR6 renders two speakers, where `Math.max(MAX_SPEAKERS, speakerCount)`
    // and the bare constant are the same six options — the identity. These two
    // counts separate them. Six is the cap D3 puts on the auto policy; SEVEN is
    // one step past it, and this dialog does not enforce that cap for itself —
    // it renders the count the service hands back. A select whose value is not
    // among its options selects NOTHING (measured in this jsdom: value '',
    // selectedIndex -1), so a bound frozen at six leaves a blank speaker
    // control on a panel whose headline and Land button both say seven.
    const six = await runToReview(
      makeDiarization({ speakerCount: 6, rawClusterCount: 6, speechSeconds: [10, 3, 3, 3, 3, 3] })
    );
    expect(optionValues()).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(screen.getByTestId('speaker-count')).toHaveValue('6');
    six.unmount();

    await runToReview(
      makeDiarization({ speakerCount: 7, rawClusterCount: 7, speechSeconds: [10, 3, 3, 3, 3, 3, 3] })
    );
    expect(optionValues()).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(screen.getByTestId('speaker-count')).toHaveValue('7');
  });

  const BUTTONS: [number, string][] = [
    [1, 'Land Voice + Backing'],
    [2, 'Land 2 speakers + Backing'],
    [3, 'Land 3 speakers + Backing'],
  ];

  it.each(BUTTONS)('VR7. a count of %s offers "%s"', async (count, label) => {
    seedDoc();
    const diarization =
      count === 1
        ? makeDiarization({ speakerCount: 1, rawClusterCount: 1, speechSeconds: [9] })
        : count === 3
          ? makeThreeSpeakers()
          : makeDiarization();
    await runToReview(diarization);

    expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
  });

  it('VR8. one voice is reported as one voice, and lands the way it always did', async () => {
    seedDoc();
    const { output, onClose } = await runToReview(
      makeDiarization({ speakerCount: 1, rawClusterCount: 1, speechSeconds: [9] })
    );

    expect(screen.getByTestId('speaker-review-headline')).toHaveTextContent('Found one voice');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Land Voice + Backing' }));
    });

    expect(mockLandVoice).toHaveBeenCalledTimes(1);
    expect(mockLandVoice).toHaveBeenCalledWith(output);
    expect(mockLandSpeakers).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('VR9. a one-voice landing over full scale still gets today’s exactness note', async () => {
    seedDoc();
    mockLandVoice.mockReturnValue(makeVoiceLanding({ sourcePeak: 2.4, exactSumHolds: false }));
    const { onClose } = await runToReview(
      makeDiarization({ speakerCount: 1, rawClusterCount: 1, speechSeconds: [9] })
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Land Voice + Backing' }));
    });

    const note = screen.getByTestId('separate-note-exactness');
    expect(note).toHaveTextContent(/peaks above full scale/i);
    expect(note).toHaveTextContent('2.40');
    // "Today's note" is the VOICE wording, not just the peak figure: two
    // tracks, and the Voice and the Backing named as the complete pair. The
    // peak assertions alone leave `exactnessNote`'s whole voice branch free to
    // say "the five tracks" and "The stems themselves are complete" to someone
    // who has neither in their session. Stems test 13 pins the mirror.
    expect(note).toHaveTextContent(/two tracks/i);
    expect(note).not.toHaveTextContent(/five tracks/i);
    expect(note).toHaveTextContent(/The Voice and the Backing themselves are complete/);
    expect(note).not.toHaveTextContent(/The stems themselves are complete/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('VR10. no evidence at all is said plainly, the count is not offered, and the voice lands whole', async () => {
    seedDoc();
    const { output, onClose } = await runToReview(EMPTY_DIARIZATION, makeEvidence(0));

    expect(screen.getByTestId('speaker-review-headline')).toHaveTextContent(
      'No distinct speakers were found — the voice will land as one track'
    );
    expect(screen.getByTestId('speaker-count')).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Land Voice + Backing' }));
    });
    expect(mockLandVoice).toHaveBeenCalledWith(output);
    expect(mockLandSpeakers).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('VR10b. the count select is gated on the EVIDENCE, not on the count in hand', async () => {
    seedDoc();
    // Out of D3's contract on purpose, and that is the point of it: the
    // assembler never returns zero clusters from a non-empty embedding set, so
    // on every input the pipeline can produce "no embeddings" and "no
    // speakers" are the same state and VR10 — which has both at once — cannot
    // tell the two apart. They differ on exactly one state, and it is the one
    // where being wrong is unrecoverable: with embeddings in hand a forced
    // re-cluster is still free, and the select is the only way out of a pass
    // that placed nobody. Gated on the COUNT instead, an empty result would be
    // final.
    const { evidence } = await runToReview(EMPTY_DIARIZATION, makeEvidence(12));

    const select = screen.getByTestId('speaker-count');
    expect(select).toBeEnabled();

    mockRecluster.mockReturnValue(makeDiarization());
    await act(async () => {
      fireEvent.change(select, { target: { value: '2' } });
    });
    expect(mockRecluster).toHaveBeenCalledWith(evidence, 2);
    expect(screen.getByTestId('speaker-review-headline')).toHaveTextContent('Found 2 speakers');
  });

  it('VR11. Land hands landSpeakers the per-speaker SPANS, in document samples', async () => {
    seedDoc();
    const diarization = makeDiarization();
    const { output, onClose } = await runToReview(diarization);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Land 2 speakers + Backing' }));
    });

    expect(mockLandSpeakers).toHaveBeenCalledTimes(1);
    expect(mockLandSpeakers).toHaveBeenCalledWith(
      output,
      segmentsToDocSamples(diarization, output.sampleRate, output.lengthSamples)
    );
    // Two speakers, three turns: speaker 1 owns two of them.
    expect(mockLandSpeakers.mock.calls[0][1]).toHaveLength(2);
    expect(mockLandSpeakers.mock.calls[0][1][0]).toHaveLength(2);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockLandSpeakers.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0]);
    // No exactness claim for a speaker split (D4) — and no note pretending one.
    expect(screen.queryByTestId('separate-note-exactness')).not.toBeInTheDocument();
  });

  it('VR11b. the spans land at the OUTPUT rate, clamped to the output length', async () => {
    // Both arguments the dialog chooses for `segmentsToDocSamples` are pinned
    // here, and both are invisible everywhere else in this suite.
    //
    // The RATE: `stemService` sets the run's rate to the document's, so a
    // 48 kHz source produces a 48 kHz output and the 16 kHz model positions
    // have to be mapped through THAT. Every other voice fixture is 44.1 kHz,
    // where `output.sampleRate`, the document's rate and a hardcoded 44100 are
    // one number — the definition of measuring the identity. At 48 kHz a
    // dialog that passed 44,100 would land every speaker span 8.1 % early and
    // 8.1 % short, silently.
    //
    // The BOUND: the model's own segments may run past the audio (D1: a
    // closing run overshoots by up to half a receptive field, and a re-cluster
    // inherits that), so the OUTPUT's length is the clamp. Every other fixture
    // is 15 minutes long against segments that end 5 seconds in, so the clamp
    // never bites and the bound could be `Number.MAX_SAFE_INTEGER`. This
    // document is short enough that it does: one span ends past it (and comes
    // back exactly AT the bound) while another ends one sample inside it (and
    // must come back untouched), so the clamp is pinned on both sides.
    seedDoc();
    const output = makeVoiceOutput({ sampleRate: 48_000, lengthSamples: 400_000 });
    mockSeparate.mockResolvedValue({ ok: true, output });
    const diarization = makeDiarization({
      segments: [
        // 8,000 → 56,000 at 16 kHz is 24,000 → 168,000 at 48 kHz: well inside.
        // (At 44.1 kHz it would be 22,050 → 154,350, so the rate shows here.)
        { startSample16k: 8_000, endSample16k: 56_000, speaker: 0 },
        // 133,333 maps to 399,999 — one sample short of the end, so a clamp at
        // the document length must leave it exactly where it is.
        { startSample16k: 130_000, endSample16k: 133_333, speaker: 0 },
        // 232,000 maps to 696,000, past the end of a 400,000-sample document;
        // its start (396,000) is inside, so the span survives the clamp.
        { startSample16k: 132_000, endSample16k: 232_000, speaker: 1 },
      ],
    });
    mockDiarize.mockResolvedValue({ ok: true, evidence: makeEvidence(), diarization });
    await renderVoice();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Land 2 speakers + Backing' }));
    });

    // Written out rather than recomputed through `segmentsToDocSamples`: the
    // point of the test is the ARGUMENTS the dialog chooses, and a re-run of
    // the same function with the same rate and bound would agree with whatever
    // the dialog picked.
    expect(mockLandSpeakers).toHaveBeenCalledWith(output, [
      [
        { startSample: 24_000, endSample: 168_000 },
        { startSample: 390_000, endSample: 399_999 },
      ],
      [{ startSample: 396_000, endSample: 400_000 }],
    ]);
  });

  it('VR12. Land uses the RE-CLUSTERED spans, not the ones the auto pass produced', async () => {
    seedDoc();
    const { output } = await runToReview();
    const three = makeThreeSpeakers();
    mockRecluster.mockReturnValue(three);

    await act(async () => {
      fireEvent.change(screen.getByTestId('speaker-count'), { target: { value: '3' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Land 3 speakers + Backing' }));
    });

    expect(mockLandSpeakers).toHaveBeenCalledWith(
      output,
      segmentsToDocSamples(three, output.sampleRate, output.lengthSamples)
    );
  });

  it('VR13. Close from the review lands NOTHING', async () => {
    seedDoc();
    const { onClose } = await runToReview();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    });

    expect(mockLandSpeakers).not.toHaveBeenCalled();
    expect(mockLandVoice).not.toHaveBeenCalled();
    expect(mockLandStems).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('VR14. a landing that would not fit in memory is refused with its own figure', async () => {
    seedDoc();
    // D4: 4 x 317.52 MB = 1.27 GB, over the 1.2 GB budget by a margin the
    // user can act on. Three of the same speakers (952.6 MB) is under it.
    await runToReview(makeThreeSpeakers());
    expect(screen.getByRole('button', { name: 'Land 3 speakers + Backing' })).toBeEnabled();
    expect(screen.queryByTestId('speaker-review-budget')).not.toBeInTheDocument();

    mockRecluster.mockReturnValue(
      makeDiarization({
        speakerCount: 4,
        rawClusterCount: 4,
        speechSeconds: [3, 3, 3, 3],
        segments: [
          { startSample16k: 8_000, endSample16k: 56_000, speaker: 0 },
          { startSample16k: 72_000, endSample16k: 120_000, speaker: 1 },
          { startSample16k: 136_000, endSample16k: 184_000, speaker: 2 },
          { startSample16k: 200_000, endSample16k: 248_000, speaker: 3 },
        ],
      })
    );
    await act(async () => {
      fireEvent.change(screen.getByTestId('speaker-count'), { target: { value: '4' } });
    });

    expect(screen.getByTestId('speaker-review-budget')).toHaveTextContent(
      'These 4 speaker tracks would need 1.3 GB; pick fewer speakers or trim the source.'
    );
    const land = screen.getByRole('button', { name: 'Land 4 speakers + Backing' });
    expect(land).toBeDisabled();
    fireEvent.click(land);
    expect(mockLandSpeakers).not.toHaveBeenCalled();

    // ...and picking fewer speakers is the way BACK. The refusal is a live
    // reading of the count in hand, not a latch the panel keeps once it has
    // been over the ceiling: exercised only upward, a one-way door would pass
    // every assertion above and leave the user with a dead Land button and a
    // budget line about a count they no longer want. The landing here is also
    // what proves the click above landed nothing because the button was
    // refused, and not because the mock was never going to be called.
    mockRecluster.mockReturnValue(makeThreeSpeakers());
    await act(async () => {
      fireEvent.change(screen.getByTestId('speaker-count'), { target: { value: '3' } });
    });
    expect(screen.queryByTestId('speaker-review-budget')).not.toBeInTheDocument();
    const backDown = screen.getByRole('button', { name: 'Land 3 speakers + Backing' });
    expect(backDown).toBeEnabled();
    await act(async () => {
      fireEvent.click(backDown);
    });
    expect(mockLandSpeakers).toHaveBeenCalledTimes(1);
  });

  it('VR15. the budget gate is pinned AT the constant and one step past it', async () => {
    seedDoc();
    // Two speakers, so the ceiling is reached by the document size alone.
    const atBudget = SPEAKER_LANDING_BUDGET_BYTES / 2 / (2 * 4);
    const output = makeVoiceOutput({ lengthSamples: atBudget });
    expect(speakerDocumentBytes(output) * 2).toBe(SPEAKER_LANDING_BUDGET_BYTES);
    mockSeparate.mockResolvedValue({ ok: true, output });
    const first = await renderVoice();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });
    // Exactly AT the budget is allowed — the refusal is for above it.
    expect(screen.getByRole('button', { name: 'Land 2 speakers + Backing' })).toBeEnabled();
    first.unmount();

    // One sample more per document is one step past the constant.
    mockSeparate.mockResolvedValue({ ok: true, output: makeVoiceOutput({ lengthSamples: atBudget + 1 }) });
    await renderVoice();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });
    expect(screen.getByRole('button', { name: 'Land 2 speakers + Backing' })).toBeDisabled();
  });

  it('VR15b. the memory refusal is about the SPLIT — one voice lands however big it is', async () => {
    seedDoc();
    // One document over the whole ceiling on its own, with a confirmed count of
    // ONE. D4 prices a split at N x the document and refuses THAT; Voice +
    // Backing is the landing this dialog has always done and has never been
    // gated on memory. The `speakerCount >= 2` half of the refusal is what
    // keeps a long recording landable at all: without it the panel refuses
    // with "These 1 speaker tracks would need 1.2 GB" — a sentence about
    // speaker tracks the landing does not contain — and the user has no way
    // left to get their voice out of the dialog.
    const lengthSamples = SPEAKER_LANDING_BUDGET_BYTES / (2 * 4) + 1;
    const output = makeVoiceOutput({ lengthSamples });
    expect(speakerDocumentBytes(output)).toBeGreaterThan(SPEAKER_LANDING_BUDGET_BYTES);
    mockSeparate.mockResolvedValue({ ok: true, output });
    mockDiarize.mockResolvedValue({
      ok: true,
      evidence: makeEvidence(),
      diarization: makeDiarization({ speakerCount: 1, rawClusterCount: 1, speechSeconds: [10] }),
    });
    const { onClose } = await renderVoice();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    expect(screen.queryByTestId('speaker-review-budget')).not.toBeInTheDocument();
    const land = screen.getByRole('button', { name: 'Land Voice + Backing' });
    expect(land).toBeEnabled();
    await act(async () => {
      fireEvent.click(land);
    });
    expect(mockLandVoice).toHaveBeenCalledWith(output);
    expect(mockLandSpeakers).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('VR16. the sanitised-samples note is shown in the review, before anything lands', async () => {
    seedDoc();
    mockSeparate.mockResolvedValue({
      ok: true,
      output: makeVoiceOutput({ sanitisedEstimateSamples: 7 }),
    });
    await renderVoice();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    const note = screen.getByTestId('separate-note-sanitised');
    expect(note).toHaveTextContent('7');
    expect(note).toHaveTextContent(/Backing/);
    expect(note).not.toHaveTextContent(/Residual track/);
    // D4 forbids an exactness claim for a SPLIT: two speaker tracks carry edge
    // fades and share their overlap regions, so they do not add back up.
    expect(note).not.toHaveTextContent('add back up');
    expect(mockLandSpeakers).not.toHaveBeenCalled();
  });

  it('VR16b. one voice keeps the two-track sum claim the split may not make (D4)', async () => {
    seedDoc();
    mockSeparate.mockResolvedValue({
      ok: true,
      output: makeVoiceOutput({ sanitisedEstimateSamples: 7 }),
    });
    mockDiarize.mockResolvedValue({
      ok: true,
      evidence: makeEvidence(),
      diarization: makeDiarization({ speakerCount: 1, rawClusterCount: 1, speechSeconds: [9] }),
    });
    await renderVoice();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    // A confirmed count of one IS Voice + Backing, and that pair does add back
    // up — the sentence D4 forbids for a split is the true one here. Pinned
    // one step below the >= 2 boundary the note branches on, so moving that
    // boundary fails either this test or VR16.
    const note = screen.getByTestId('separate-note-sanitised');
    expect(note).toHaveTextContent('7');
    expect(note).toHaveTextContent('The two tracks still add back up');
  });

  // ------------------------------------------------------- refusals + cancel

  it.each([
    ['model-missing' as const, 'The speaker models have not been downloaded yet (32.5 MB, one time).'],
    ['failed' as const, 'The speaker separation host failed.'],
  ])('VC1. a diarize "%s" after a good stem run shows the message and lands NOTHING', async (status, message) => {
    seedDoc();
    mockDiarize.mockResolvedValue({ ok: false, status, message });
    const { onClose } = await renderVoice();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    expect(screen.getByTestId('separate-error')).toHaveTextContent(message);
    expect(screen.getByTestId('separate-error')).toHaveClass('text-[#e0a458]');
    expect(screen.queryByTestId('speaker-review')).not.toBeInTheDocument();
    expect(mockLandSpeakers).not.toHaveBeenCalled();
    expect(mockLandVoice).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('VC1b. a diarize "model-missing" puts the SPEAKER half of the gate back', async () => {
    seedDoc();
    mockDiarize.mockResolvedValue({
      ok: false,
      status: 'model-missing',
      message: 'The speaker models have not been downloaded yet (32.5 MB, one time).',
    });
    await renderVoice();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    // The message alone (VC1) leaves the user staring at an amber line with no
    // way to act on it: the state a missing model describes is the DOWNLOAD
    // state, and stems mode has said so since test 9. Both lines are read,
    // because the interesting half is the OTHER one — the Demucs set just ran
    // a whole separation, so it is on disk, and a gate that re-priced its
    // 166 MB would ask the user to pay a bill they have already paid.
    expect(screen.getByTestId('separate-model-missing')).toBeInTheDocument();
    expect(screen.getByTestId('separate-model-line-speakers')).toHaveTextContent('needed');
    expect(screen.getByTestId('separate-model-line-speakers')).toHaveTextContent('32.5 MB');
    expect(screen.getByTestId('separate-model-line-stems')).toHaveTextContent('already here');
    expect(screen.getByRole('button', { name: 'Download Models' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('VC1c. a diarize "failed" leaves the models alone — no gate, no re-download', async () => {
    seedDoc();
    mockDiarize.mockResolvedValue({
      ok: false,
      status: 'failed',
      message: 'The speaker separation host failed.',
    });
    await renderVoice();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    // The mirror image of VC1b, and the reason the branch is a branch: a host
    // that crashed says nothing about the files on disk. Flipping the model
    // state on every refusal would hide the failure behind a 32.5 MB download
    // that re-verifies two files which are already there and changes nothing.
    expect(screen.getByTestId('separate-error')).toHaveTextContent('The speaker separation host failed.');
    expect(screen.queryByTestId('separate-model-missing')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download Models' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Separate' })).toBeEnabled();
  });

  it('VS1. a stem-stage refusal in voice mode ends the run instead of hanging it', async () => {
    seedDoc();
    const message = 'Stem separation is limited to 15 minutes of audio.';
    mockSeparate.mockResolvedValue({ ok: false, status: 'too-long', message });
    const { onClose } = await renderVoice();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    // In voice mode the stem stage's `finally` deliberately does NOT clear the
    // stage — stage 2 starts behind it without flashing the idle state — so
    // the refusal path has to clear it itself. Without that the dialog is
    // UNCLOSABLE: the bar and Cancel stay up on a run that is over, and
    // `dismissable={!busy}` kills Escape while no Close button is rendered.
    expect(screen.getByTestId('separate-error')).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Separate' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('separate-progress')).not.toBeInTheDocument();
    expect(mockDiarize).not.toHaveBeenCalled();
    expect(mockLandSpeakers).not.toHaveBeenCalled();
    expect(mockLandVoice).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('VS2. a stem "model-missing" in voice mode puts the two-set gate back', async () => {
    seedDoc();
    mockSeparate.mockResolvedValue({
      ok: false,
      status: 'model-missing',
      message: 'The separation model has not been downloaded yet (166 MB, one time).',
    });
    await renderVoice();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    expect(screen.getByTestId('separate-model-missing')).toBeInTheDocument();
    expect(screen.getByTestId('separate-model-line-stems')).toHaveTextContent('needed');
    expect(screen.getByRole('button', { name: 'Download Models' })).toBeEnabled();
    // The run is over: a gate behind a live Cancel button cannot be used.
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('separate-progress')).not.toBeInTheDocument();
    expect(mockDiarize).not.toHaveBeenCalled();
  });

  it('VC2. Cancel during the separation spawns NO diarizer', async () => {
    seedDoc();
    const stemPending = deferred<StemSeparationResult>();
    mockSeparate.mockReturnValue(stemPending.promise);
    await renderVoice();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockCancelDiarize).not.toHaveBeenCalled();

    // The host was already finishing when Cancel landed, so it resolves ok.
    // The stems are DISCARDED anyway: the user asked for it to stop.
    await act(async () => {
      stemPending.resolve({ ok: true, output: makeVoiceOutput() });
    });
    expect(mockDiarize).not.toHaveBeenCalled();
    expect(screen.getByTestId('separate-error')).toHaveTextContent('Speaker separation was cancelled.');
    expect(screen.queryByTestId('speaker-review')).not.toBeInTheDocument();
  });

  it('VC2b. the NEXT run after a cancel is a clean run — the cancel latch is per-run', async () => {
    // D5's `cancelledRef` is what makes a cancelled stem result get discarded,
    // and it is only ever set to false at the START of a run. Without that
    // reset a Cancel poisons the dialog for the rest of its life: every later
    // run pays Demucs in full (ten minutes on a 15-minute source), then throws
    // the output away before a diarizer is ever spawned and prints the cancel
    // message for a run the user never cancelled.
    seedDoc();
    const first = deferred<StemSeparationResult>();
    mockSeparate.mockReturnValue(first.promise);
    await renderVoice();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    await act(async () => {
      first.resolve({ ok: true, output: makeVoiceOutput() });
    });
    expect(mockDiarize).not.toHaveBeenCalled();
    expect(screen.getByTestId('separate-error')).toHaveTextContent('Speaker separation was cancelled.');

    // Second run, same mounted dialog.
    const output = makeVoiceOutput();
    mockSeparate.mockResolvedValue({ ok: true, output });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    expect(mockDiarize).toHaveBeenCalledTimes(1);
    expect(mockDiarize.mock.calls[0][0].channels).toBe(
      output.stems.find((s) => s.label === 'Vocals')!.channels
    );
    // The predicate `diarizeChannels` polls reads false again, so the service
    // is not asked to cancel itself before it spawns.
    expect(mockDiarize.mock.calls[0][0].shouldCancel!()).toBe(false);
    expect(screen.getByTestId('speaker-review')).toBeInTheDocument();
    expect(screen.queryByTestId('separate-error')).not.toBeInTheDocument();
  });

  it('VC3. Cancel during the speaker stage kills the DIARIZER, not the stem host', async () => {
    seedDoc();
    const diarPending = deferred<DiarizeResult>();
    mockDiarize.mockReturnValue(diarPending.promise);
    await renderVoice();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });
    expect(mockDiarize).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(mockCancelDiarize).toHaveBeenCalledTimes(1);
    // The stem host is already gone; killing it again is a second utility
    // process teardown for a run that is not running.
    expect(mockCancel).not.toHaveBeenCalled();
    // And the predicate the service polls now reads true.
    expect(mockDiarize.mock.calls[0][0].shouldCancel!()).toBe(true);

    await act(async () => {
      diarPending.resolve({ ok: false, status: 'cancelled', message: 'Speaker separation was cancelled.' });
    });
    expect(screen.getByTestId('separate-error')).toHaveTextContent('Speaker separation was cancelled.');
  });

  it('VC4. unmounting during the speaker stage cancels the diarizer ONCE, and only it', async () => {
    seedDoc();
    const diarPending = deferred<DiarizeResult>();
    mockDiarize.mockReturnValue(diarPending.promise);
    const { unmount } = await renderVoice();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    unmount();
    expect(mockCancelDiarize).toHaveBeenCalledTimes(1);
    expect(mockCancel).not.toHaveBeenCalled();

    await act(async () => {
      diarPending.resolve({ ok: true, evidence: makeEvidence(), diarization: makeDiarization() });
    });
    expect(mockLandSpeakers).not.toHaveBeenCalled();
  });

  it('VC4b. a stem result that arrives after the unmount spawns NO diarizer', async () => {
    seedDoc();
    const stemPending = deferred<StemSeparationResult>();
    mockSeparate.mockReturnValue(stemPending.promise);
    const { unmount } = await renderVoice();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    unmount();
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockCancelDiarize).not.toHaveBeenCalled();

    // VC4 unmounts during stage TWO, which a different guard covers, and every
    // other unmount test resolves a refusal that returns on `!result.ok`
    // before the guard is ever consulted. This is the resolve that reaches it:
    // the stem host was already partitioning when the dialog went away and
    // hands back four finished stems. Unguarded, the run walks straight on
    // into stage 2 — a second utility process, gigabytes of it, spawned for a
    // dialog that no longer exists and whose review nobody can see, with
    // nothing left to cancel it.
    await act(async () => {
      stemPending.resolve({ ok: true, output: makeVoiceOutput() });
    });

    expect(mockDiarize).not.toHaveBeenCalled();
    expect(mockCancelDiarize).not.toHaveBeenCalled();
    expect(mockLandSpeakers).not.toHaveBeenCalled();
    expect(mockLandVoice).not.toHaveBeenCalled();
  });

  it('VC5. unmounting during the REVIEW cancels nothing and lands nothing', async () => {
    seedDoc();
    const { unmount } = await runToReview();

    unmount();

    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockCancelDiarize).not.toHaveBeenCalled();
    expect(mockLandSpeakers).not.toHaveBeenCalled();
    expect(mockLandVoice).not.toHaveBeenCalled();
  });

  it('VC6. the DEFAULT is still stems — an unspecified mode never reaches the diarizer', async () => {
    seedDoc();
    await renderSettled();

    expect(screen.getByText('Separate into Stems')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    expect(mockLandStems).toHaveBeenCalledTimes(1);
    expect(mockDiarize).not.toHaveBeenCalled();
    expect(mockLandSpeakers).not.toHaveBeenCalled();
  });
});
