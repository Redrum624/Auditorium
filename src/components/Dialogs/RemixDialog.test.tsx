import { render, screen, fireEvent, act } from '@testing-library/react';
import RemixDialog from './RemixDialog';
// U2-3: the module-column host, so the born-busy exemption can be observed at
// the seam the host actually reads.
import { DialogHostProvider } from './DialogHost';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument } from '../../audio/AudioDocument';
import { registerDialogSetters } from '../../services/dialogBus';
import { createRemixDocument } from '../../services/remixService';
import {
  clearAllTempo,
  regridTempo,
  runRemixAnalysis,
  setRemixAnalysis,
  type RemixAnalysis,
  type TempoEntry,
} from '../../services/tempoAnalysis';
import { planRemix, type PlanRemixOptions, type PlanRemixResult } from '../../dsp/remixPlan';
import { deriveRemixFeatures } from '../../dsp/remixFeatures';
import { DEFAULT_REMIX_WEIGHTS } from '../../dsp/remixCost';
import { CONFIDENCE_LOW } from '../../dsp/tempoCore';
import {
  _getTempoWorkerTerminateCount,
  _resetTempoWorkerTestState,
} from '../../__mocks__/createTempoWorkerMock';

// The ConvertDialog.test.tsx / TempoDialog.test.tsx pattern: everything pure
// (formatting, the option assembly, the cluster-run grouping) stays REAL via
// requireActual; only the effectful or expensive entry points this dialog
// drives are swapped for controllable mocks.
jest.mock('../../services/remixService', () => ({
  ...jest.requireActual('../../services/remixService'),
  createRemixDocument: jest.fn(),
}));

jest.mock('../../services/tempoAnalysis', () => ({
  ...jest.requireActual('../../services/tempoAnalysis'),
  runRemixAnalysis: jest.fn(),
  regridTempo: jest.fn(),
  setRemixAnalysis: jest.fn(),
}));

jest.mock('../../dsp/remixPlan', () => ({
  ...jest.requireActual('../../dsp/remixPlan'),
  planRemix: jest.fn(),
}));

jest.mock('../../dsp/remixFeatures', () => ({
  ...jest.requireActual('../../dsp/remixFeatures'),
  deriveRemixFeatures: jest.fn(),
}));

const mockCreateRemix = createRemixDocument as jest.MockedFunction<typeof createRemixDocument>;
const mockRunRemixAnalysis = runRemixAnalysis as jest.MockedFunction<typeof runRemixAnalysis>;
const mockRegridTempo = regridTempo as jest.MockedFunction<typeof regridTempo>;
const mockSetRemixAnalysis = setRemixAnalysis as jest.MockedFunction<typeof setRemixAnalysis>;
const mockPlanRemix = planRemix as jest.MockedFunction<typeof planRemix>;
const mockDeriveRemixFeatures = deriveRemixFeatures as jest.MockedFunction<typeof deriveRemixFeatures>;

const SR = 44100;
/** 120 BPM, 4/4 -> one bar = 2 s = 88200 samples. */
const BAR = 88200;
const NUM_BARS = 8;

/** Bars 0-1 are cluster 0, bars 2-7 are cluster 1 -> two runs, 25% / 75%. */
const CLUSTERS = Int32Array.from([0, 0, 1, 1, 1, 1, 1, 1, 0]);

function makeAnalysis(overrides: Partial<RemixAnalysis> = {}): RemixAnalysis {
  return {
    bpm: 120,
    confidence: 0.8,
    beatSamples: Int32Array.from({ length: NUM_BARS * 4 + 1 }, (_, i) => i * (BAR / 4)),
    salience: 1,
    peakRatio: 2,
    ibiCv: 0.02,
    truncated: false,
    analyzedEndSample: NUM_BARS * BAR,
    odf: new Float32Array(64),
    periodFrames: 40,
    decimationFactor: 4,
    bands: new Float32Array(64 * 24),
    numBands: 24,
    odfLow: new Float32Array(64),
    chroma: new Float32Array(32 * 12),
    numChromaFrames: 32,
    chromaRate: 43,
    beatsPerBar: 4,
    downbeatPhase: 0,
    downbeatConfidence: 0.3,
    barBoundary: Int32Array.from({ length: NUM_BARS + 1 }, (_, i) => i * BAR),
    numBars: NUM_BARS,
    T: new Float32Array(0),
    C: new Float32Array(0),
    L: new Float32Array(0),
    R: new Float32Array(0),
    S: new Float32Array(0),
    cluster: CLUSTERS,
    transitionSeen: new Set<string>(),
    ...overrides,
  };
}

function makeTempoEntry(overrides: Partial<TempoEntry> = {}): TempoEntry {
  return { ...makeAnalysis(), stale: false, ...overrides };
}

const MIN_OUT = 2 * BAR; // 0:04
const MAX_OUT = 24 * BAR; // 0:48

/** Faithful stand-in for the real planner: it reproduces `planRemix`'s own
 * `confidence < CONFIDENCE_LOW && !tempoConfirmed -> 'no-tempo'` refusal
 * (remixPlan.ts) and otherwise bar-quantises the requested target, so a test
 * that expects Create to become reachable on a low-confidence track has to
 * prove the dialog actually handed the planner a tempo the user asserted. */
function defaultPlan(analysis: RemixAnalysis, options: PlanRemixOptions): PlanRemixResult {
  if (analysis.confidence < CONFIDENCE_LOW && !analysis.tempoConfirmed) {
    return {
      ok: false,
      reason: 'no-tempo',
      minOutputSample: analysis.analyzedEndSample,
      maxOutputSample: analysis.analyzedEndSample,
      message: `tempo confidence ${analysis.confidence.toFixed(2)} is below the required minimum ${CONFIDENCE_LOW}`,
    };
  }
  const outputSample = Math.round(options.targetSample / BAR) * BAR;
  return {
    ok: true,
    segments: [{ start: 0, end: outputSample }],
    joins: [{ fromBar: 2, toBar: 5, cost: { total: 1 } as never }],
    outputSample,
    targetSample: options.targetSample,
    totalCost: 1,
    minOutputSample: MIN_OUT,
    maxOutputSample: MAX_OUT,
    maxBarUse: 1,
    canReroll: true,
  };
}

function seedDoc(samples = NUM_BARS * BAR) {
  const doc = createDocument({ name: 'song.wav', sampleRate: SR, channels: [new Float32Array(samples)] });
  useAppStore.getState().addDocument(doc);
  return doc;
}

let focusRemixPanel: jest.Mock;

function installBus(): void {
  focusRemixPanel = jest.fn();
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
    focusRemixPanel,
    focusTranscriptPanel: () => {},
    focusSpatialPanel: () => {},
  });
}

/** Renders with a resolved analysis already in hand (phase 2). */
async function renderReady(analysis: RemixAnalysis = makeAnalysis(), onClose = jest.fn()) {
  mockRunRemixAnalysis.mockResolvedValue(analysis);
  const view = render(<RemixDialog onClose={onClose} />);
  await act(async () => {});
  return { ...view, onClose };
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  jest.clearAllMocks();
  clearAllTempo();
  _resetTempoWorkerTestState();
  installBus();
  mockPlanRemix.mockImplementation(defaultPlan);
  mockCreateRemix.mockResolvedValue({ ok: true, remixDocId: 'remix-1', plan: {} as never });
  mockRegridTempo.mockResolvedValue(null);
  mockDeriveRemixFeatures.mockImplementation(() => makeAnalysis());
});

describe('RemixDialog', () => {
  it('1. mount runs the analysis exactly once and renders the progress bar', () => {
    seedDoc();
    mockRunRemixAnalysis.mockReturnValue(new Promise(() => {}));

    render(<RemixDialog onClose={jest.fn()} />);

    expect(mockRunRemixAnalysis).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('remix-progress')).toBeInTheDocument();
    expect(screen.getByText('Analyzing beat grid…')).toBeInTheDocument();
  });

  it('2. the summary reports BPM / meter / bars and the strip renders one block per cluster run', async () => {
    seedDoc();
    await renderReady();

    expect(screen.getByTestId('remix-summary')).toHaveTextContent('120.0 BPM · 4/4 · 8 bars');
    // WHOLE textContent, not `toHaveTextContent('0.80')` — that substring-
    // matches, so the five-dot meter in front of the number was unasserted and
    // `round(confidence * 5)` could degrade to `round(confidence)` unnoticed.
    // 0.80 -> round(4.0) = 4 filled + 1 hollow, and the hollow count is the
    // complement, so this one equality pins the scale, the rounding AND the
    // `'○'.repeat(5 - n)` remainder.
    expect(screen.getByTestId('remix-confidence').textContent).toBe('●●●●○ 0.80');

    const blocks = screen.getAllByTestId('remix-structure-block');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].style.width).toBe('25%');
    expect(blocks[1].style.width).toBe('75%');
    expect(blocks[0]).toHaveAttribute('title', '0:00 – 0:04');
    expect(blocks[1]).toHaveAttribute('title', '0:04 – 0:16');
  });

  it('3. an in-range target re-plans through planRemix; an out-of-range one clamps the field', async () => {
    seedDoc();
    await renderReady();

    const target = screen.getByTestId('remix-target') as HTMLInputElement;
    expect(target.value).toBe('0:16'); // seeded from the analysed length

    fireEvent.change(target, { target: { value: '0:13' } });

    expect(mockPlanRemix).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetSample: 13 * SR })
    );
    expect(screen.getByTestId('remix-will-produce')).toHaveTextContent('→ will produce 0:14 (nearest phrase)');

    fireEvent.change(target, { target: { value: '9:00' } });
    expect(target.value).toBe('0:48'); // clamped to maxOutputSample, not submitted
    expect((screen.getByTestId('remix-target-slider') as HTMLInputElement).value).toBe(String(MAX_OUT));

    fireEvent.change(target, { target: { value: '0:01' } });
    expect(target.value).toBe('0:04'); // clamped to minOutputSample
  });

  it('4. an unreachable target renders the amber hint with the offered value and disables Create', async () => {
    seedDoc();
    mockPlanRemix.mockImplementation(() => ({
      ok: false,
      reason: 'too-long',
      minOutputSample: MIN_OUT,
      maxOutputSample: MAX_OUT,
      message: 'target above the reachable maximum',
    }));
    await renderReady();

    expect(screen.getByTestId('remix-hint')).toHaveTextContent('Longest is 0:48 (3x the original).');
    expect(screen.getByTestId('remix-hint')).toHaveClass('text-[#e0a458]');
    expect(screen.getByRole('button', { name: 'Create Remix' })).toBeDisabled();

    mockPlanRemix.mockImplementation(() => ({
      ok: false,
      reason: 'too-short',
      minOutputSample: MIN_OUT,
      maxOutputSample: MAX_OUT,
      message: 'target below the reachable minimum',
    }));
    fireEvent.change(screen.getByTestId('remix-phrase'), { target: { value: '4' } });
    expect(screen.getByTestId('remix-hint')).toHaveTextContent('Shortest sensible remix is 0:04.');
    expect(screen.getByRole('button', { name: 'Create Remix' })).toBeDisabled();
  });

  it('5. a low-confidence analysis hints for a manual BPM, keeps the field editable and re-enables Create', async () => {
    const doc = seedDoc();
    const low = makeAnalysis({ confidence: 0.19 });
    await renderReady(low);

    expect(screen.getByTestId('remix-hint')).toHaveTextContent(
      'No steady tempo detected (confidence 0.19). Enter a BPM manually to continue.'
    );
    const bpm = screen.getByTestId('remix-bpm') as HTMLInputElement;
    expect(bpm).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Create Remix' })).toBeDisabled();

    // The user asserts 128 BPM: the grid is re-TRACKED at the corrected period
    // (never relabelled), then the remix features are re-derived from it.
    mockRegridTempo.mockResolvedValue(makeTempoEntry({ bpm: 128, periodFrames: 37.5, confidence: 0.19 }));
    mockDeriveRemixFeatures.mockImplementation(() => makeAnalysis({ bpm: 128, confidence: 0.19 }));

    fireEvent.change(bpm, { target: { value: '128' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('remix-redetect'));
    });

    expect(mockRegridTempo).toHaveBeenCalledWith(doc.id, 40 * (120 / 128));
    expect(screen.queryByTestId('remix-hint')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Remix' })).toBeEnabled();

    // The typed BPM is an ASSERTION, not a measurement: it opens the planner's
    // gate through its own flag and leaves `confidence` at what the detector
    // actually measured.
    const planned = mockPlanRemix.mock.calls[mockPlanRemix.mock.calls.length - 1][0];
    expect(planned.tempoConfirmed).toBe(true);
    expect(planned.confidence).toBe(0.19);
  });

  it('5b. a confirmed low-confidence track keeps its MEASURED confidence everywhere', async () => {
    seedDoc();
    await renderReady(makeAnalysis({ confidence: 0.19 }));

    expect(screen.getByRole('button', { name: 'Create Remix' })).toBeDisabled();
    fireEvent.click(screen.getByTestId('remix-tempo-confirmed'));
    expect(screen.getByRole('button', { name: 'Create Remix' })).toBeEnabled();

    const planned = mockPlanRemix.mock.calls[mockPlanRemix.mock.calls.length - 1][0];
    expect(planned.tempoConfirmed).toBe(true);
    expect(planned.confidence).toBe(0.19);
    expect(planned.confidence).toBeLessThan(CONFIDENCE_LOW);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create Remix' }));
    });

    // Nothing synthesised reaches the SHARED cache either, so the status bar's
    // uncertainty marker on this document stays honest.
    const published = mockSetRemixAnalysis.mock.calls[0][1];
    expect(published.tempoConfirmed).toBe(true);
    expect(published.confidence).toBe(0.19);
    expect(screen.getByTestId('remix-confidence')).toHaveTextContent('0.19');
  });

  it('6. time signature and downbeat re-derive the features only — never a second analysis', async () => {
    seedDoc();
    await renderReady();
    expect(mockRunRemixAnalysis).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.change(screen.getByTestId('remix-meter'), { target: { value: '3/4' } });
    });

    expect(mockDeriveRemixFeatures).toHaveBeenCalledTimes(1);
    expect(mockDeriveRemixFeatures).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ numFrames: 32, chromaRate: 43 }),
      { beatsPerBar: 3, downbeatShiftBeats: 0 }
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('remix-downbeat-next'));
    });

    expect(mockDeriveRemixFeatures).toHaveBeenCalledTimes(2);
    expect(mockDeriveRemixFeatures).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), {
      beatsPerBar: 3,
      downbeatShiftBeats: 1,
    });
    expect(mockRunRemixAnalysis).toHaveBeenCalledTimes(1);
  });

  it('7. Escape does not close while busy, and does close once idle', async () => {
    seedDoc();
    let resolve!: (a: RemixAnalysis) => void;
    mockRunRemixAnalysis.mockReturnValue(new Promise<RemixAnalysis>((r) => (resolve = r)));
    const onClose = jest.fn();
    render(<RemixDialog onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolve(makeAnalysis());
    });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('8. unmounting mid-analysis leaves no worker running', async () => {
    const actual = jest.requireActual('../../services/tempoAnalysis');
    mockRunRemixAnalysis.mockImplementation(actual.runRemixAnalysis);
    seedDoc(1000);

    const { unmount } = render(<RemixDialog onClose={jest.fn()} />);
    unmount();
    await act(async () => {});

    expect(_getTempoWorkerTerminateCount()).toBe(1);
  });

  it('9. Create Remix builds the document from the live active id, then closes and focuses the panel', async () => {
    const doc = seedDoc();
    const onClose = jest.fn();
    await renderReady(makeAnalysis(), onClose);

    fireEvent.change(screen.getByTestId('remix-target'), { target: { value: '0:12' } });
    fireEvent.change(screen.getByTestId('remix-phrase'), { target: { value: '16' } });
    fireEvent.change(screen.getByTestId('remix-strictness'), { target: { value: 'loose' } });
    fireEvent.change(screen.getByTestId('remix-crossfade'), { target: { value: '40' } });
    fireEvent.click(screen.getByTestId('remix-exact-length'));
    fireEvent.click(screen.getByTestId('remix-tempo-confirmed'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create Remix' }));
    });

    expect(mockCreateRemix).toHaveBeenCalledTimes(1);
    expect(mockCreateRemix).toHaveBeenCalledWith({
      sourceDocId: doc.id,
      targetSample: 12 * SR,
      phraseBars: 16,
      strict: false,
      allowRepeats: true,
      crossfadeMs: 40,
      exactLength: true,
      markEditPoints: true,
      weights: { ...DEFAULT_REMIX_WEIGHTS, phrase: 1.0 },
      analysisParams: { beatsPerBar: 4, downbeatShiftBeats: 0 },
      onProgress: expect.any(Function),
    });
    // The corrected/confirmed analysis is published to the shared cache first,
    // so the service plans against exactly what the dialog previewed.
    expect(mockSetRemixAnalysis).toHaveBeenCalled();
    expect(mockSetRemixAnalysis.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateRemix.mock.invocationCallOrder[0]
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(focusRemixPanel).toHaveBeenCalledTimes(1);
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(focusRemixPanel.mock.invocationCallOrder[0]);
  });

  it('10. a service refusal renders inline and keeps the dialog open', async () => {
    seedDoc();
    const onClose = jest.fn();
    await renderReady(makeAnalysis(), onClose);
    mockCreateRemix.mockResolvedValue({ ok: false, status: 'plan-failed', message: 'The remix planner did not return a plan.' });

    fireEvent.click(screen.getByTestId('remix-tempo-confirmed'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create Remix' }));
    });

    expect(screen.getByTestId('remix-error')).toHaveTextContent('The remix planner did not return a plan.');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('remix-dialog')).toBeInTheDocument();
  });

  it('11. x2 re-tracks the grid through regridTempo instead of relabelling the BPM', async () => {
    const doc = seedDoc();
    await renderReady();
    mockRegridTempo.mockResolvedValue(makeTempoEntry({ bpm: 240, periodFrames: 20 }));
    mockDeriveRemixFeatures.mockImplementation(() => makeAnalysis({ bpm: 240, periodFrames: 20 }));

    await act(async () => {
      fireEvent.click(screen.getByTestId('remix-double'));
    });

    expect(mockRegridTempo).toHaveBeenCalledWith(doc.id, 20);
    expect(mockDeriveRemixFeatures).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('remix-summary')).toHaveTextContent('240.0 BPM');
    // The re-tracked grid is published to the shared cache, so the row a
    // `regridTempo` write left without remix descriptors is repaired.
    expect(mockSetRemixAnalysis).toHaveBeenCalledTimes(1);
  });

  it('12. Create stays disabled until the tempo is confirmed', async () => {
    seedDoc();
    await renderReady();

    expect(screen.getByRole('button', { name: 'Create Remix' })).toBeDisabled();
    fireEvent.click(screen.getByTestId('remix-tempo-confirmed'));
    expect(screen.getByRole('button', { name: 'Create Remix' })).toBeEnabled();
  });

  it('13. an analysis that produced no bars refuses with a hint and no Create', async () => {
    seedDoc();
    await renderReady(makeAnalysis({ bpm: null, numBars: 0, barBoundary: new Int32Array(0), cluster: new Int32Array(0) }));

    expect(screen.getByTestId('remix-hint')).toHaveTextContent('No steady tempo detected');
    expect(screen.queryAllByTestId('remix-structure-block')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Create Remix' })).toBeDisabled();
  });

  it('14. a failed analysis reports inline rather than leaving an empty form', async () => {
    seedDoc();
    await renderReady(null as unknown as RemixAnalysis);

    expect(screen.getByTestId('remix-error')).toHaveTextContent(
      'Beat analysis did not produce a usable grid for this document.'
    );
    expect(screen.getByRole('button', { name: 'Create Remix' })).toBeDisabled();
  });

  // Defect 4a: the renderer clamps the requested crossfade to a quarter of the
  // median beat period, so the field's own 5-120 ms range over-promises above
  // ~125 BPM. The dialog states the width that will really be applied.
  it('14b. states the applied crossfade when the quarter-beat cap bites, and stays quiet when it does not', async () => {
    seedDoc();
    // 150 BPM -> beat period 17640 samples -> cap 4410 samples = 100 ms.
    const fast = makeAnalysis({
      bpm: 150,
      beatSamples: Int32Array.from({ length: NUM_BARS * 4 + 1 }, (_, i) => i * 17640),
    });
    await renderReady(fast);

    // 25 ms (the default) is nowhere near the cap — no note.
    expect(screen.queryByTestId('remix-crossfade-capped')).toBeNull();

    fireEvent.change(screen.getByTestId('remix-crossfade'), { target: { value: '120' } });
    expect(screen.getByTestId('remix-crossfade-capped')).toHaveTextContent(/100 ms/);
  });

  it('14c. leaves the crossfade field alone at 120 BPM, where the whole 5-120 ms range fits', async () => {
    seedDoc();
    await renderReady(); // 120 BPM -> cap 125 ms

    fireEvent.change(screen.getByTestId('remix-crossfade'), { target: { value: '120' } });
    expect(screen.queryByTestId('remix-crossfade-capped')).toBeNull();
  });

  it('15. renders nothing without an active document', () => {
    render(<RemixDialog onClose={jest.fn()} />);
    expect(screen.queryByTestId('remix-dialog')).not.toBeInTheDocument();
    expect(mockRunRemixAnalysis).not.toHaveBeenCalled();
  });
});

describe('G5 glass header', () => {
  it('carries a lucide icon tile and a "name · duration" subtitle (mockup anatomy)', async () => {
    seedDoc();
    await renderReady();
    expect(screen.getByTestId('dialog-icon')).toBeInTheDocument();
    expect(screen.getByText(/^song\.wav · \d+:\d{2}$/)).toBeInTheDocument();
  });
});

/**
 * U2-3: the in-card Cancel, while a remix is being created.
 *
 * The hosted module column blocks the doors that would unmount a running tool,
 * reading the `dismissable={!busy}` this dialog already publishes. But
 * `dismissable` governs only Escape, the modal backdrop and the host's own ✕ —
 * never a button inside the body. This Cancel called `onClose` unconditionally,
 * so mid-create it walked through the block and unmounted the tool the greyed
 * strip beside it existed to protect, discarding the run (`cancelledRef` makes
 * the create return early and drop its result).
 *
 * Note what is NOT asserted here: that the mount ANALYSIS disables Cancel. It
 * deliberately does not — see `U2 — the mount analysis does not lock the app`
 * below and `moduleLock` in DialogShell. Cancel follows `busy`, matching the
 * other eight; the strip lock is the thing that follows the narrower flag.
 */
/**
 * U2-3 / I3: Auto-Remix is born busy, and that must not grey the app.
 *
 * This dialog starts a tempo analysis in a mount effect — before the user has
 * touched anything — so `busy` is true from the first paint. While the module
 * lock was simply `!dismissable`, opening Auto-Remix instantly greyed every
 * module-strip entry and suspended the global shortcuts for a pass the user had
 * not started, and could not have stopped. The lock is for passes the USER
 * starts; the mount analysis keeps its own in-body busy UI and its ✕ veto.
 */
describe('U2 — the mount analysis does not lock the app', () => {
  function Harness({ onModuleLockChange }: { onModuleLockChange: (v: boolean) => void }) {
    return (
      <DialogHostProvider onModuleLockChange={onModuleLockChange}>
        <RemixDialog onClose={() => {}} />
      </DialogHostProvider>
    );
  }

  it('reports no module lock while the mount analysis runs, though it is un-dismissable', async () => {
    seedDoc();
    const onModuleLockChange = jest.fn();
    // Never resolves: the dialog stays in its born-busy mount analysis.
    mockRunRemixAnalysis.mockImplementation(() => new Promise(() => {}));
    render(<Harness onModuleLockChange={onModuleLockChange} />);
    await act(async () => {});

    // Un-dismissable — the ✕ refuses, exactly as before…
    expect((screen.getByTestId('hosted-tool-close') as HTMLButtonElement).disabled).toBe(true);
    // …and yet the module column is NOT held.
    expect(onModuleLockChange).toHaveBeenLastCalledWith(false);
  });

  it('DOES lock once the user starts a create', async () => {
    seedDoc();
    const onModuleLockChange = jest.fn();
    mockCreateRemix.mockImplementation(() => new Promise(() => {}));
    mockRunRemixAnalysis.mockResolvedValue(makeAnalysis());
    render(<Harness onModuleLockChange={onModuleLockChange} />);
    await act(async () => {});
    expect(onModuleLockChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByTestId('remix-tempo-confirmed'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create Remix' }));
    });

    expect(mockCreateRemix).toHaveBeenCalled();
    expect(onModuleLockChange).toHaveBeenLastCalledWith(true);
  });
});

describe('U2 — Cancel refuses while a remix is being created', () => {
  it('disables Cancel once Create Remix is running, and ignores a click on it', async () => {
    const doc = seedDoc();
    const onClose = jest.fn();
    // Never resolves: `creating` stays true for the assertions.
    mockCreateRemix.mockImplementation(() => new Promise(() => {}));
    await renderReady(makeAnalysis(), onClose);

    const cancel = () => screen.getByTestId('remix-cancel') as HTMLButtonElement;
    expect(cancel().disabled).toBe(false);

    // `canCreate` needs the grid confirmed, exactly as the user must confirm it.
    fireEvent.click(screen.getByTestId('remix-tempo-confirmed'));
    expect(screen.getByRole('button', { name: 'Create Remix' })).toBeEnabled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create Remix' }));
    });

    expect(mockCreateRemix).toHaveBeenCalled();
    expect(cancel().disabled).toBe(true);
    fireEvent.click(cancel());
    expect(onClose).not.toHaveBeenCalled();
    expect(doc.id).toBeDefined();
  });
});
