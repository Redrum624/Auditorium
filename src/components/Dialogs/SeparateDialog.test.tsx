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
import { landStems, landVoice, type StemLandingResult } from '../../services/stemLanding';

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
}));

const mockModelState = getStemModelState as jest.MockedFunction<typeof getStemModelState>;
const mockEnsureModel = ensureStemModel as jest.MockedFunction<typeof ensureStemModel>;
const mockSeparate = separateStems as jest.MockedFunction<typeof separateStems>;
const mockCancel = cancelStemSeparation as jest.MockedFunction<typeof cancelStemSeparation>;
const mockLandStems = landStems as jest.MockedFunction<typeof landStems>;
const mockLandVoice = landVoice as jest.MockedFunction<typeof landVoice>;

const SR = 44100;
/** `stemManager.cjs` MODEL_BYTES — the real pinned size, 166 MB when rounded. */
const MODEL_BYTES = 165612636;

const PRESENT: StemModelState = { downloaded: true, bytes: MODEL_BYTES, expectedBytes: MODEL_BYTES };
const MISSING: StemModelState = { downloaded: false, bytes: null, expectedBytes: MODEL_BYTES };

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
    expect(screen.getByTestId('separate-download-status')).toHaveTextContent('83 MB of 166 MB');
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
 * D4 — the SAME dialog in voice mode. `mode` changes four things and nothing
 * else: the title, the two sentences describing what lands, the landing call,
 * and which track the sanitised-samples note names. Model state, download,
 * progress, cancel and every refusal are shared code and are NOT re-tested
 * here — the tests above already cover them, and duplicating them per mode
 * would only pin that a prop was threaded twice.
 */
describe('SeparateDialog — voice mode (D4)', () => {
  function makeVoiceLanding(overrides: Partial<StemLandingResult> = {}): StemLandingResult {
    return makeLanding({
      documentIds: ['v1', 'v2'],
      trackIds: ['vt1', 'vt2'],
      sessionName: 'song.wav — Voice + Backing',
      ...overrides,
    });
  }

  async function renderVoice(onClose = jest.fn()) {
    const view = render(<SeparateDialog mode="voice" onClose={onClose} />);
    await act(async () => {});
    return { ...view, onClose };
  }

  beforeEach(() => {
    mockLandVoice.mockReturnValue(makeVoiceLanding());
  });

  it('V1. is titled Separate Voice and names the two tracks it produces', async () => {
    seedDoc();
    await renderVoice();

    expect(screen.getByText('Separate Voice')).toBeInTheDocument();
    expect(screen.queryByText('Separate into Stems')).not.toBeInTheDocument();
    const produces = screen.getByTestId('separate-produces');
    expect(produces).toHaveTextContent('Two tracks');
    expect(produces).toHaveTextContent('Voice');
    expect(produces).toHaveTextContent('Backing');
    // The five-stem sentence must not survive into voice mode.
    expect(produces).not.toHaveTextContent('Residual');
  });

  it('V2. states what the two-track sum really is — no audio lost, not bit-identical', async () => {
    seedDoc();
    await renderVoice();

    const text = screen.getByTestId('separate-guarantees').textContent ?? '';
    expect(text).toMatch(/add back up to your original/i);
    expect(text).toMatch(/no audio is lost/i);
    // The honest half: five tracks are exact, two are not (measured — see
    // `stemLanding.ts`'s `landVoice`). The dialog must not promise otherwise.
    expect(text).not.toMatch(/sample for sample/i);
    expect(text).toMatch(/bit-for-bit/i);
    expect(text).toMatch(/bounded by the model/i);
    expect(text).toMatch(/not a bug/i);
  });

  it('V3. lands through landVoice — never landStems — and closes', async () => {
    seedDoc();
    const output = makeOutput();
    mockSeparate.mockResolvedValue({ ok: true, output });
    const { onClose } = await renderVoice();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    expect(mockLandVoice).toHaveBeenCalledTimes(1);
    expect(mockLandVoice).toHaveBeenCalledWith(output);
    expect(mockLandStems).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('V4. runs the very same separation call as stems mode', async () => {
    const doc = seedDoc();
    await renderVoice();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    // One run, one model, one source — the mode decides only what is DONE with
    // the output, never what is computed.
    expect(mockSeparate).toHaveBeenCalledTimes(1);
    expect(mockSeparate.mock.calls[0][0].sourceDocId).toBe(doc.id);
  });

  it('V5. tells an over-unity source that the TWO tracks will not add back', async () => {
    seedDoc();
    mockLandVoice.mockReturnValue(makeVoiceLanding({ sourcePeak: 2.4, exactSumHolds: false }));
    const { onClose } = await renderVoice();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    const note = screen.getByTestId('separate-note-exactness');
    expect(note).toHaveTextContent(/peaks above full scale/i);
    expect(note).toHaveTextContent('2.40');
    expect(note).toHaveTextContent(/two tracks/i);
    expect(note).not.toHaveTextContent(/five tracks/i);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('V6. sends the sanitised energy to the Backing, which is where it lands', async () => {
    seedDoc();
    mockSeparate.mockResolvedValue({ ok: true, output: makeOutput({ sanitisedEstimateSamples: 7 }) });
    await renderVoice();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    const note = screen.getByTestId('separate-note-sanitised');
    expect(note).toHaveTextContent('7');
    expect(note).toHaveTextContent(/Backing/);
    // The Residual is inside the Backing now; naming it would send the user
    // looking for a track that does not exist in this session.
    expect(note).not.toHaveTextContent(/Residual track/);
  });

  it('V7. the DEFAULT is stems — an unspecified mode still lands five', async () => {
    seedDoc();
    await renderSettled();

    expect(screen.getByText('Separate into Stems')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    });

    expect(mockLandStems).toHaveBeenCalledTimes(1);
    expect(mockLandVoice).not.toHaveBeenCalled();
  });
});
