import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import TempoDialog from './TempoDialog';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument } from '../../audio/AudioDocument';
import { getTempo, regridTempo, runTempoAnalysis } from '../../services/tempoAnalysis';
import { applyTempoChange, detectRegionTempo } from '../../services/tempoService';
import type { TempoEntry } from '../../services/tempoAnalysis';
import type { TempoChangeOutcome } from '../../services/tempoService';

// Real tempoAnalysis/tempoService (checkTempoChange, tempoRatio, tempoQualityBand,
// the exported ratio constants, MAX_BEAT_MARKERS) stay REAL via requireActual so
// this dialog's guard/quality copy is exercised against the actual T7 logic and
// cannot silently drift from it; only the effectful/worker-backed entry points
// are swapped for controllable mocks (ConvertDialog.test.tsx pattern).
jest.mock('../../services/tempoAnalysis', () => ({
  ...jest.requireActual('../../services/tempoAnalysis'),
  getTempo: jest.fn(),
  regridTempo: jest.fn(),
  runTempoAnalysis: jest.fn(),
}));

jest.mock('../../services/tempoService', () => ({
  ...jest.requireActual('../../services/tempoService'),
  applyTempoChange: jest.fn(),
  detectRegionTempo: jest.fn(),
}));

const mockGetTempo = getTempo as jest.MockedFunction<typeof getTempo>;
const mockRegridTempo = regridTempo as jest.MockedFunction<typeof regridTempo>;
const mockRunTempoAnalysis = runTempoAnalysis as jest.MockedFunction<typeof runTempoAnalysis>;
const mockApplyTempoChange = applyTempoChange as jest.MockedFunction<typeof applyTempoChange>;
const mockDetectRegionTempo = detectRegionTempo as jest.MockedFunction<typeof detectRegionTempo>;

function makeEntry(overrides: Partial<TempoEntry> = {}): TempoEntry {
  return {
    bpm: 120,
    confidence: 0.8,
    beatSamples: Int32Array.from([1000, 23000, 45000]),
    salience: 1,
    peakRatio: 2,
    ibiCv: 0.05,
    truncated: false,
    analyzedEndSample: 44100 * 30,
    odf: new Float32Array(10),
    periodFrames: 40,
    decimationFactor: 4,
    bands: new Float32Array(0),
    numBands: 0,
    odfLow: new Float32Array(0),
    stale: false,
    ...overrides,
  };
}

function seedDoc(sampleRate = 44100, samples = 44100 * 30) {
  const doc = createDocument({
    name: 'song.wav',
    sampleRate,
    channels: [new Float32Array(samples)],
  });
  useAppStore.getState().addDocument(doc);
  return doc;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  jest.clearAllMocks();
  mockGetTempo.mockReturnValue(null);
  mockRegridTempo.mockResolvedValue(null);
  mockRunTempoAnalysis.mockResolvedValue(null);
  mockDetectRegionTempo.mockReturnValue(null);
  mockApplyTempoChange.mockResolvedValue({ ok: true });
});

describe('TempoDialog', () => {
  it('1. renders the detected BPM and a teal confident chip from a seeded cached entry', () => {
    seedDoc();
    mockGetTempo.mockReturnValue(makeEntry({ bpm: 128, confidence: 0.8 }));
    render(<TempoDialog onClose={jest.fn()} />);

    expect(screen.getByTestId('tempo-detected')).toHaveTextContent('128');
    expect(screen.getByTestId('tempo-confidence')).toHaveTextContent('confident');
    expect((screen.getByTestId('tempo-source') as HTMLInputElement).value).toBe('128');
  });

  it('2. renders the amber low-confidence chip at confidence 0.2', () => {
    seedDoc();
    mockGetTempo.mockReturnValue(makeEntry({ bpm: 90, confidence: 0.2 }));
    render(<TempoDialog onClose={jest.fn()} />);

    expect(screen.getByTestId('tempo-confidence')).toHaveTextContent('low confidence — check this');
  });

  it('3. a null estimate renders the manual-entry hint and Apply stays disabled until a valid Source is typed', () => {
    seedDoc();
    mockGetTempo.mockReturnValue(makeEntry({ bpm: null, confidence: 0, beatSamples: Int32Array.from([]) }));
    render(<TempoDialog onClose={jest.fn()} />);

    expect(screen.getByTestId('tempo-detected')).toHaveTextContent('Could not detect a tempo');
    expect(
      screen.getByText('Type the tempo if you know it, or select a steady 8–16 bar passage and press Re-detect.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '110' } });
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled(); // Source still empty

    fireEvent.change(screen.getByTestId('tempo-source'), { target: { value: '100' } });
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });

  it('4. x2 doubles the Source field via regridTempo; /2 halves it back', async () => {
    const doc = seedDoc();
    const base = makeEntry({ bpm: 100, periodFrames: 40, confidence: 0.9 });
    mockGetTempo.mockReturnValue(base);
    mockRegridTempo.mockImplementation(async (_docId: string, newPeriodFrames: number) =>
      makeEntry({
        bpm: (base.periodFrames / newPeriodFrames) * (base.bpm as number),
        periodFrames: newPeriodFrames,
        confidence: base.confidence,
      })
    );
    render(<TempoDialog onClose={jest.fn()} />);

    fireEvent.click(screen.getByTestId('tempo-double-button'));
    await waitFor(() =>
      expect((screen.getByTestId('tempo-source') as HTMLInputElement).value).toBe('200')
    );
    expect(mockRegridTempo).toHaveBeenCalledWith(doc.id, 20);

    fireEvent.click(screen.getByTestId('tempo-halve-button'));
    await waitFor(() =>
      expect((screen.getByTestId('tempo-source') as HTMLInputElement).value).toBe('100')
    );
    expect(mockRegridTempo).toHaveBeenCalledWith(doc.id, 40);
  });

  it('5. typing a target BPM updates tempo-summary ratio and both durations', () => {
    seedDoc(44100, 44100 * 20); // whole file, exactly 20.00s, no selection
    mockGetTempo.mockReturnValue(makeEntry({ bpm: 120, confidence: 0.9 }));
    render(<TempoDialog onClose={jest.fn()} />);

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '90' } });

    const summary = screen.getByTestId('tempo-summary');
    expect(summary).toHaveTextContent('x1.3333');
    expect(summary).toHaveTextContent('20.00 s');
    expect(summary).toHaveTextContent('26.67 s');
  });

  it('6. an out-of-range target disables Apply and shows the red message with the computed BPM range', () => {
    seedDoc();
    mockGetTempo.mockReturnValue(makeEntry({ bpm: 100, confidence: 0.9 }));
    render(<TempoDialog onClose={jest.fn()} />);

    // ratio = 100/500 = 0.2, below MIN_RATIO (0.25)
    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '500' } });

    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    const quality = screen.getByTestId('tempo-quality');
    expect(quality).toHaveTextContent('Out of range');
    expect(quality).toHaveTextContent('25');
    expect(quality).toHaveTextContent('400');
  });

  it('7. source === target disables Apply with "Target equals source tempo."', () => {
    seedDoc();
    mockGetTempo.mockReturnValue(makeEntry({ bpm: 100, confidence: 0.9 }));
    render(<TempoDialog onClose={jest.fn()} />);

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '100' } });

    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(screen.getByTestId('tempo-quality')).toHaveTextContent('Target equals source tempo.');
  });

  it('8. Apply calls applyTempoChange with exactly the expected request, then onClose', async () => {
    seedDoc(44100, 44100 * 20);
    mockGetTempo.mockReturnValue(
      makeEntry({ bpm: 120, confidence: 0.9, beatSamples: Int32Array.from([500, 44100 * 5]) })
    );
    mockApplyTempoChange.mockResolvedValue({ ok: true });
    const onClose = jest.fn();
    render(<TempoDialog onClose={onClose} />);

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '90' } });
    fireEvent.click(screen.getByTestId('tempo-beat-markers'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockApplyTempoChange).toHaveBeenCalledWith(
      { sourceBpm: 120, targetBpm: 90, addBeatMarkers: true, firstBeatSample: 500 },
      expect.any(Function)
    );
  });

  it('8b. does not close when applyTempoChange resolves ok:false', async () => {
    seedDoc();
    mockGetTempo.mockReturnValue(makeEntry({ bpm: 120, confidence: 0.9 }));
    mockApplyTempoChange.mockResolvedValue({ ok: false });
    const onClose = jest.fn();
    render(<TempoDialog onClose={onClose} />);

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(mockApplyTempoChange).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('tempo-apply-error')).toBeInTheDocument();
  });

  it('9. Escape does not close while busy, but does once idle', async () => {
    seedDoc();
    mockGetTempo.mockReturnValue(makeEntry({ bpm: 120, confidence: 0.9 }));
    let resolveApply!: (v: TempoChangeOutcome) => void;
    mockApplyTempoChange.mockReturnValue(
      new Promise((resolve) => {
        resolveApply = resolve;
      })
    );
    const onClose = jest.fn();
    render(<TempoDialog onClose={onClose} />);

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveApply({ ok: false });
      await Promise.resolve();
    });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('10. does not call runTempoAnalysis on mount when a cached entry exists', () => {
    seedDoc();
    mockGetTempo.mockReturnValue(makeEntry({ bpm: 120, confidence: 0.9 }));
    render(<TempoDialog onClose={jest.fn()} />);

    expect(mockRunTempoAnalysis).not.toHaveBeenCalled();
  });

  it('11. flags "Selection changed — re-detect" when the store selection changes while mounted', () => {
    seedDoc();
    useAppStore.getState().setSelection({ start: 1000, end: 20000 });
    mockDetectRegionTempo.mockReturnValue({ bpm: 110, confidence: 0.7 });
    mockGetTempo.mockReturnValue(makeEntry({ bpm: 120, confidence: 0.9 }));
    render(<TempoDialog onClose={jest.fn()} />);

    expect(screen.queryByTestId('tempo-selection-changed')).not.toBeInTheDocument();

    act(() => {
      useAppStore.getState().setSelection({ start: 5000, end: 25000 });
    });

    expect(screen.getByTestId('tempo-selection-changed')).toBeInTheDocument();
  });

  describe('additional spec-fidelity checks', () => {
    it('shows a Detect button and calls runTempoAnalysis when there is no cached entry', async () => {
      const doc = seedDoc();
      mockGetTempo.mockReturnValue(null);
      mockRunTempoAnalysis.mockResolvedValue(makeEntry({ bpm: 133, confidence: 0.9 }));
      render(<TempoDialog onClose={jest.fn()} />);

      fireEvent.click(screen.getByTestId('tempo-detect-button'));

      await waitFor(() => expect(mockRunTempoAnalysis).toHaveBeenCalledWith(doc));
      await waitFor(() =>
        expect((screen.getByTestId('tempo-source') as HTMLInputElement).value).toBe('133')
      );
    });

    it('scope line reads "Whole file — m:ss.d" with no selection', () => {
      seedDoc(44100, 44100 * (3 * 60 + 41)); // ~3:41.0
      mockGetTempo.mockReturnValue(null);
      render(<TempoDialog onClose={jest.fn()} />);

      expect(screen.getByTestId('tempo-scope')).toHaveTextContent('Whole file — 3:41.0');
      expect(screen.queryByTestId('tempo-selection-note')).not.toBeInTheDocument();
    });

    it('scope line reads "Selection — start → end (dur s)" and shows the amber edge-seam note with a selection', () => {
      const doc = seedDoc();
      useAppStore.getState().setSelection({ start: Math.round(0.4 * 44100), end: Math.round(19.9 * 44100) });
      mockGetTempo.mockReturnValue(null);
      render(<TempoDialog onClose={jest.fn()} />);

      expect(screen.getByTestId('tempo-scope')).toHaveTextContent('Selection —');
      expect(screen.getByTestId('tempo-scope')).toHaveTextContent('19.50 s');
      expect(screen.getByTestId('tempo-selection-note')).toHaveTextContent(
        'Only the selection is stretched; the rest of the file keeps its original tempo.'
      );
      void doc;
    });

    it('beat-markers checkbox is disabled when there is no beat phase', () => {
      seedDoc();
      mockGetTempo.mockReturnValue(makeEntry({ bpm: null, beatSamples: Int32Array.from([]) }));
      render(<TempoDialog onClose={jest.fn()} />);

      expect(screen.getByTestId('tempo-beat-markers')).toBeDisabled();
    });

    it('a failed x2 correction (regridTempo resolves null) leaves the grid and Source unchanged and shows the failure note', async () => {
      seedDoc();
      mockGetTempo.mockReturnValue(makeEntry({ bpm: 100, periodFrames: 40, confidence: 0.9 }));
      mockRegridTempo.mockResolvedValue(null);
      render(<TempoDialog onClose={jest.fn()} />);

      fireEvent.click(screen.getByTestId('tempo-double-button'));

      await waitFor(() => expect(screen.getByTestId('tempo-correction-failed')).toBeInTheDocument());
      expect((screen.getByTestId('tempo-source') as HTMLInputElement).value).toBe('100');
      expect(screen.getByTestId('tempo-detected')).toHaveTextContent('100');
    });

    it('Re-detect from selection calls detectRegionTempo and updates Source, including with no selection (whole-file fallback)', () => {
      seedDoc();
      mockGetTempo.mockReturnValue(makeEntry({ bpm: 100, confidence: 0.9 }));
      mockDetectRegionTempo.mockReturnValue({ bpm: 133, confidence: 0.6 });
      render(<TempoDialog onClose={jest.fn()} />);

      fireEvent.click(screen.getByTestId('tempo-redetect-button'));

      expect(mockDetectRegionTempo).toHaveBeenCalledTimes(1);
      expect((screen.getByTestId('tempo-source') as HTMLInputElement).value).toBe('133');
      expect(screen.getByTestId('tempo-detected')).toHaveTextContent('133');
    });
  });
});

describe('G5 glass header', () => {
  it('carries a lucide icon tile and the active doc name as subtitle', () => {
    seedDoc();
    render(<TempoDialog onClose={jest.fn()} />);
    expect(screen.getByTestId('dialog-icon')).toBeInTheDocument();
    expect(screen.getByText('song.wav')).toBeInTheDocument();
  });
});
