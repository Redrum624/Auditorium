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

  it('7b. source === target WITH beat markers ticked ENABLES Apply and lays the grid at the current tempo (v1.9.1 item 2)', async () => {
    seedDoc();
    mockGetTempo.mockReturnValue(makeEntry({ bpm: 100, confidence: 0.9 }));
    mockApplyTempoChange.mockResolvedValue({ ok: true });
    const onClose = jest.fn();
    render(<TempoDialog onClose={onClose} />);

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '100' } });
    // Before ticking: still the plain no-op dead end (unchanged behaviour).
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(screen.getByTestId('tempo-quality')).toHaveTextContent('Target equals source tempo.');

    fireEvent.click(screen.getByTestId('tempo-beat-markers'));

    // After ticking: Apply is enabled and the copy explains the no-stretch path.
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
    expect(screen.getByTestId('tempo-quality')).toHaveTextContent(
      'Same tempo — beat markers will be laid at the current grid (no stretch).'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockApplyTempoChange).toHaveBeenCalledWith(
      { sourceBpm: 100, targetBpm: 100, addBeatMarkers: true, firstBeatSample: 1000, shouldCancel: expect.any(Function) },
      expect.any(Function)
    );
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
      { sourceBpm: 120, targetBpm: 90, addBeatMarkers: true, firstBeatSample: 500, shouldCancel: expect.any(Function) },
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

// ---------------------------------------------------------------------------
// R7 — the opt-in variable-rate correction
// ---------------------------------------------------------------------------

describe('R7 — Correction mode', () => {
  /** A grid whose two intervals DIFFER, so the map is genuinely variable. */
  function varyingEntry() {
    return makeEntry({ bpm: 120, confidence: 0.8, beatSamples: Int32Array.from([1000, 23000, 43000]) });
  }

  it('defaults to one ratio — today’s behaviour — and Apply needs no confirmation for it', () => {
    seedDoc();
    mockGetTempo.mockReturnValue(varyingEntry());
    render(<TempoDialog onClose={jest.fn()} />);

    expect((screen.getByTestId('tempo-correction') as HTMLSelectElement).value).toBe('one-ratio');
    expect(screen.queryByTestId('tempo-grid-confirmed')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '110' } });
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });

  it('sends NO variableRate in one-ratio mode', async () => {
    seedDoc();
    mockGetTempo.mockReturnValue(varyingEntry());
    render(<TempoDialog onClose={jest.fn()} />);

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '110' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });
    expect(mockApplyTempoChange).toHaveBeenCalledTimes(1);
    expect(mockApplyTempoChange.mock.calls[0][0].variableRate).toBeUndefined();
  });

  it('offers following the beats only when the grid has TWO beats in the region', () => {
    seedDoc();
    mockGetTempo.mockReturnValue(makeEntry({ beatSamples: Int32Array.from([1000]) }));
    const { unmount } = render(<TempoDialog onClose={jest.fn()} />);
    expect(screen.getByTestId('tempo-correction')).toBeDisabled();
    expect(screen.getByTestId('tempo-follow-unavailable')).toBeInTheDocument();
    unmount();

    mockGetTempo.mockReturnValue(makeEntry({ beatSamples: Int32Array.from([1000, 23000]) }));
    render(<TempoDialog onClose={jest.fn()} />);
    expect(screen.getByTestId('tempo-correction')).toBeEnabled();
    expect(screen.queryByTestId('tempo-follow-unavailable')).not.toBeInTheDocument();
  });

  it('refuses a STALE grid — it describes audio from before an edit', () => {
    seedDoc();
    mockGetTempo.mockReturnValue(varyingEntry());
    const { unmount } = render(<TempoDialog onClose={jest.fn()} />);
    expect(screen.getByTestId('tempo-correction')).toBeEnabled();
    unmount();

    mockGetTempo.mockReturnValue(makeEntry({ ...varyingEntry(), stale: true }));
    render(<TempoDialog onClose={jest.fn()} />);
    expect(screen.getByTestId('tempo-correction')).toBeDisabled();
  });

  it('will not Apply until the grid is confirmed (RULING 1)', () => {
    seedDoc();
    mockGetTempo.mockReturnValue(varyingEntry());
    render(<TempoDialog onClose={jest.fn()} />);

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '110' } });
    fireEvent.change(screen.getByTestId('tempo-correction'), { target: { value: 'follow-beats' } });

    const tick = screen.getByTestId('tempo-grid-confirmed') as HTMLInputElement;
    expect(tick.checked).toBe(false);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();

    fireEvent.click(tick);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });

  it.each([
    ['x2', 'tempo-double-button'],
    ['/2', 'tempo-halve-button'],
  ])('a %s re-track clears the confirmation — it cannot outlive the grid it confirmed', async (_l, testId) => {
    seedDoc();
    mockGetTempo.mockReturnValue(varyingEntry());
    mockRegridTempo.mockResolvedValue(varyingEntry());
    render(<TempoDialog onClose={jest.fn()} />);

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '110' } });
    fireEvent.change(screen.getByTestId('tempo-correction'), { target: { value: 'follow-beats' } });
    fireEvent.click(screen.getByTestId('tempo-grid-confirmed'));
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();

    await act(async () => {
      fireEvent.click(screen.getByTestId(testId));
    });

    expect((screen.getByTestId('tempo-grid-confirmed') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('Re-detect from selection clears the confirmation too', () => {
    seedDoc();
    mockGetTempo.mockReturnValue(varyingEntry());
    mockDetectRegionTempo.mockReturnValue({ bpm: 118, confidence: 0.6 });
    render(<TempoDialog onClose={jest.fn()} />);

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '110' } });
    fireEvent.change(screen.getByTestId('tempo-correction'), { target: { value: 'follow-beats' } });
    fireEvent.click(screen.getByTestId('tempo-grid-confirmed'));

    fireEvent.click(screen.getByTestId('tempo-redetect-button'));
    expect((screen.getByTestId('tempo-grid-confirmed') as HTMLInputElement).checked).toBe(false);
  });

  it('the Detect button and the Correction control are never on screen together', () => {
    // Replaces a test that claimed to exercise `handleDetect`'s confirmation
    // reset but clicked `tempo-redetect-button` — a different handler — and so
    // only duplicated the test above it.
    //
    // `handleDetect`'s `setGridConfirmed(false)` is unreachable with effect,
    // and this is the property that makes it so: Detect renders only while
    // there is no cached entry, and without one the Correction select is
    // disabled and the tick never renders. Pinned here so that if the render
    // gate ever changes, the reset stops being dead and this test says so.
    // WITHOUT a cached entry: Detect is offered, the Correction control is not.
    seedDoc();
    mockGetTempo.mockReturnValue(null);
    const { unmount } = render(<TempoDialog onClose={jest.fn()} />);

    expect(screen.getByTestId('tempo-detect-button')).toBeInTheDocument();
    expect(screen.getByTestId('tempo-correction')).toBeDisabled();
    expect(screen.queryByTestId('tempo-grid-confirmed')).not.toBeInTheDocument();
    unmount();

    // WITH one: the Correction control is live and Detect is GONE. This half is
    // what makes the test able to fail on its own claim — the first half passes
    // with or without the `docEntry === null` gate, because a widened gate
    // still renders Detect in the no-entry state. Only asserting Detect's
    // ABSENCE once an entry exists can catch the widening, which is precisely
    // the change that would make `handleDetect`'s reset reachable again.
    mockGetTempo.mockReturnValue(varyingEntry());
    render(<TempoDialog onClose={jest.fn()} />);

    expect(screen.queryByTestId('tempo-detect-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('tempo-correction')).toBeEnabled();

    fireEvent.change(screen.getByTestId('tempo-correction'), { target: { value: 'follow-beats' } });
    expect(screen.getByTestId('tempo-grid-confirmed')).toBeInTheDocument();
    // The tick and Detect are never both reachable, which is the whole basis of
    // the unreachability claim recorded at `handleDetect`.
    expect(screen.queryByTestId('tempo-detect-button')).not.toBeInTheDocument();
  });

  it('RULING 1 — the grid comes from the cached analysis, NEVER from a region re-detect', () => {
    // The ruling this task was most explicitly bound by, and it had no test.
    // `detectRegionTempo` returns a BPM and a confidence and no beats at all,
    // so a re-detect must be able to change every number on screen without
    // changing one position in the grid the warp is built from.
    const onClose = jest.fn();
    seedDoc();
    const entry = varyingEntry();
    mockGetTempo.mockReturnValue(entry);
    mockDetectRegionTempo.mockReturnValue({ bpm: 137, confidence: 0.9 });
    render(<TempoDialog onClose={onClose} />);

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '110' } });
    fireEvent.click(screen.getByTestId('tempo-redetect-button'));

    // The re-detect really did land — otherwise this proves nothing.
    expect((screen.getByTestId('tempo-source') as HTMLInputElement).value).toBe('137');
    expect(screen.getByTestId('tempo-detected')).toHaveTextContent('137');

    fireEvent.change(screen.getByTestId('tempo-correction'), { target: { value: 'follow-beats' } });
    fireEvent.click(screen.getByTestId('tempo-grid-confirmed'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(mockApplyTempoChange).toHaveBeenCalledTimes(1);
    // The SAME array object the cached analysis holds — not a grid derived from
    // the 137 BPM the region detector just reported.
    expect(mockApplyTempoChange.mock.calls[0][0].variableRate?.beatSamples).toBe(entry.beatSamples);
  });

  it('reports the beat count, the local-ratio RANGE and the new duration', () => {
    seedDoc();
    mockGetTempo.mockReturnValue(varyingEntry());
    render(<TempoDialog onClose={jest.fn()} />);

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '110' } });
    fireEvent.change(screen.getByTestId('tempo-correction'), { target: { value: 'follow-beats' } });

    const summary = screen.getByTestId('tempo-variable-summary');
    // Three beats, and the two intervals (22000 and 20000 samples) give two
    // DIFFERENT local ratios — the readout must show a range, not one number.
    expect(summary).toHaveTextContent('3 beats');
    const spacing = (60 / 110) * 44100;
    expect(summary).toHaveTextContent(`x${(spacing / 22000).toFixed(4)}`);
    expect(summary).toHaveTextContent(`x${(spacing / 20000).toFixed(4)}`);
    expect(summary).toHaveTextContent('pitch unchanged');
    // The DURATION segment the test's own name promises, and the one thing here
    // that is not the region's own length: 30 s of region become 36.02 s,
    // because the map's tail carries the slower of the two local ratios across
    // the 29 s that follow the last beat. Written as a literal — replacing
    // `outLength / sampleRate` with `regionSeconds` made the readout say
    // "30.00 s → 30.00 s" and the whole suite stayed green.
    expect(summary).toHaveTextContent('30.00 s → 36.02 s');
  });

  it('names how many beats the ratio bound held back', () => {
    seedDoc();
    mockGetTempo.mockReturnValue(varyingEntry());
    render(<TempoDialog onClose={jest.fn()} />);

    // 20 BPM against ~120 BPM intervals needs ratio ~6, past MAX_RATIO 4.
    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '20' } });
    fireEvent.change(screen.getByTestId('tempo-correction'), { target: { value: 'follow-beats' } });

    expect(screen.getByTestId('tempo-variable-clamped')).toHaveTextContent('2 of 2 gaps between beats');
    expect(screen.getByTestId('tempo-variable-clamped')).toHaveTextContent('as far as the 0.25x–4x limit allows');
  });

  it('says nothing about clamping when nothing was clamped', () => {
    seedDoc();
    mockGetTempo.mockReturnValue(varyingEntry());
    render(<TempoDialog onClose={jest.fn()} />);

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '110' } });
    fireEvent.change(screen.getByTestId('tempo-correction'), { target: { value: 'follow-beats' } });
    expect(screen.queryByTestId('tempo-variable-clamped')).not.toBeInTheDocument();
  });

  it('labels the WORST segment, never an average', () => {
    seedDoc();
    // Intervals 22000 and 2000: at target 110 the ratios are 1.09 (transparent)
    // and 12 -> clamped to 4 (extreme). An average would read 'good' and lie.
    mockGetTempo.mockReturnValue(
      makeEntry({ bpm: 120, confidence: 0.8, beatSamples: Int32Array.from([1000, 23000, 25000]) })
    );
    render(<TempoDialog onClose={jest.fn()} />);

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '110' } });
    fireEvent.change(screen.getByTestId('tempo-correction'), { target: { value: 'follow-beats' } });
    expect(screen.getByTestId('tempo-variable-quality')).toHaveTextContent('Worst segment: extreme');
  });

  it.each([
    // The test above only ever exercises the FAST side: its ratios are 1.09 and
    // a clamped 4, so `minLocalRatio` is the transparent one and dropping the
    // `minLocalRatio` arm of `worstBand` entirely left the suite green — a bar
    // slowed to 0.40x would have read "Transparent everywhere", the exact
    // reassurance the code comment forbids. Every row below keeps the FAST side
    // transparent (interval 22000 -> ratio 1.0934 at 110 BPM) and moves the SLOW
    // side, so only the min arm can produce the expected label. The two band
    // strings that appeared in no test at all are pinned here in full.
    ['both sides transparent', 47000, 'Transparent everywhere'],
    ['the slow side merely good (0.60x)', 63000, 'Worst segment: good — slight transient smearing'],
    [
      'the slow side extreme (0.40x), unclamped',
      83000,
      'Worst segment: extreme — expect flanging on sustained tones',
    ],
  ])('labels the worst segment when the SLOW side is the bad one: %s', (_label, lastBeat, expected) => {
    seedDoc();
    mockGetTempo.mockReturnValue(
      makeEntry({ bpm: 120, confidence: 0.8, beatSamples: Int32Array.from([1000, 23000, lastBeat as number]) })
    );
    render(<TempoDialog onClose={jest.fn()} />);

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '110' } });
    fireEvent.change(screen.getByTestId('tempo-correction'), { target: { value: 'follow-beats' } });

    // Nothing was clamped, so the slow ratio really is the realised one and not
    // a bound the map hit on the way past.
    expect(screen.queryByTestId('tempo-variable-clamped')).not.toBeInTheDocument();
    expect(screen.getByTestId('tempo-variable-quality')).toHaveTextContent(expected as string);
  });

  it('hides the one-ratio summary and quality line while following the beats', () => {
    seedDoc();
    mockGetTempo.mockReturnValue(varyingEntry());
    render(<TempoDialog onClose={jest.fn()} />);

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '110' } });
    expect(screen.getByTestId('tempo-summary')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('tempo-correction'), { target: { value: 'follow-beats' } });
    expect(screen.queryByTestId('tempo-summary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tempo-quality')).not.toBeInTheDocument();
  });

  it('accepts source === target on this path — the case one ratio calls a no-op', () => {
    seedDoc();
    mockGetTempo.mockReturnValue(varyingEntry());
    render(<TempoDialog onClose={jest.fn()} />);

    fireEvent.change(screen.getByTestId('tempo-source'), { target: { value: '120' } });
    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '120' } });
    // One ratio refuses it...
    expect(screen.getByTestId('tempo-quality')).toHaveTextContent('Target equals source tempo.');

    fireEvent.change(screen.getByTestId('tempo-correction'), { target: { value: 'follow-beats' } });
    fireEvent.click(screen.getByTestId('tempo-grid-confirmed'));
    // ...and following the beats does not, because the beats are uneven.
    expect(screen.getByTestId('tempo-variable-summary')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });

  it('sends the confirmed grid to the service, and closes on success', async () => {
    const onClose = jest.fn();
    seedDoc();
    const entry = varyingEntry();
    mockGetTempo.mockReturnValue(entry);
    render(<TempoDialog onClose={onClose} />);

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '110' } });
    fireEvent.change(screen.getByTestId('tempo-correction'), { target: { value: 'follow-beats' } });
    fireEvent.click(screen.getByTestId('tempo-grid-confirmed'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });

    expect(mockApplyTempoChange).toHaveBeenCalledTimes(1);
    const req = mockApplyTempoChange.mock.calls[0][0];
    expect(req.variableRate?.beatSamples).toBe(entry.beatSamples);
    expect(req.targetBpm).toBe(110);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('surfaces a no-grid refusal from the service rather than closing', async () => {
    const onClose = jest.fn();
    seedDoc();
    mockGetTempo.mockReturnValue(varyingEntry());
    mockApplyTempoChange.mockResolvedValue({ ok: false, reason: 'no-grid' } as TempoChangeOutcome);
    render(<TempoDialog onClose={onClose} />);

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '110' } });
    fireEvent.change(screen.getByTestId('tempo-correction'), { target: { value: 'follow-beats' } });
    fireEvent.click(screen.getByTestId('tempo-grid-confirmed'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });

    expect(screen.getByTestId('tempo-apply-error')).toHaveTextContent(
      'The confirmed beat grid has fewer than two beats in this region.'
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});

/**
 * U2-3: the in-card Cancel, while a pass is running.
 *
 * The hosted module column blocks the two doors that would unmount a running
 * tool — the module strip and a tool swap — and it does so from the
 * `dismissable={!busy}` this dialog already publishes. But `dismissable` only
 * governs Escape, the modal backdrop and the host's own ✕; it says nothing
 * about a button INSIDE the body. This Cancel called `onClose` unconditionally,
 * so mid-pass it walked straight through the block and unmounted the very tool
 * the greyed-out strip beside it existed to protect. Seven of the nine already
 * disable their in-card cancel while busy; this is the eighth.
 */
describe('U2 — Cancel refuses while a tempo change is applying', () => {
  it('disables Cancel once Apply is running, and ignores a click on it', () => {
    const onClose = jest.fn();
    seedDoc();
    mockGetTempo.mockReturnValue(makeEntry({ bpm: 120, confidence: 0.9 }));
    // Never resolves: `busy` stays true for the duration of the assertions,
    // which is the state the block exists for.
    mockApplyTempoChange.mockImplementation(() => new Promise(() => {}));
    render(<TempoDialog onClose={onClose} />);

    expect((screen.getByTestId('tempo-cancel') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '110' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect((screen.getByTestId('tempo-cancel') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('tempo-cancel'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

/**
 * T6-3 — the unmount guard this dialog only half had.
 *
 * U2's fix round found the "all nine discard on unmount" claim false and named
 * this one of the two exceptions: it guarded a DOM ref, which stops a focus call
 * and nothing else, so an Apply that resolved after the tool was gone committed
 * its stretch, its marker correction and its beat grid — up to three undo
 * entries — into a document the user had walked away from.
 */
describe('TempoDialog — a walk-away commits nothing (T6-3)', () => {
  function startApply(onClose = jest.fn()): { unmount: () => void; onClose: jest.Mock } {
    seedDoc();
    mockGetTempo.mockReturnValue(makeEntry({ bpm: 120, confidence: 0.8 }));
    const { unmount } = render(<TempoDialog onClose={onClose} />);
    fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    return { unmount, onClose };
  }

  it('hands the service a cancel that reads false while it is open and true once it is gone', () => {
    // Never resolves: the pass is in flight for the whole test, which is the
    // window a walk-away actually lands in.
    mockApplyTempoChange.mockReturnValue(new Promise<TempoChangeOutcome>(() => {}));
    const { unmount } = startApply();

    const shouldCancel = mockApplyTempoChange.mock.calls[0][0].shouldCancel;
    expect(shouldCancel).toBeDefined();
    expect(shouldCancel!()).toBe(false);

    unmount();

    // The runner reads this between the stretched audio arriving and `applyEdit`
    // writing it, and everything after that answer — the marker correction and
    // the beat grid — is synchronous with it. So `true` here is the whole of
    // "commits nothing", for all three entries.
    expect(shouldCancel!()).toBe(true);
  });

  it('acts on nothing when the pass resolves after the tool is gone', async () => {
    // Settled SUCCESSFULLY on purpose: a refusal would leave `if (outcome.ok)`
    // false anyway, so the test would pass with the guard deleted.
    let settle: (v: TempoChangeOutcome) => void = () => {};
    mockApplyTempoChange.mockReturnValue(
      new Promise<TempoChangeOutcome>((resolve) => {
        settle = resolve;
      })
    );
    const { unmount, onClose } = startApply();

    unmount();
    await act(async () => {
      settle({ ok: true });
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('lets a detection that lands after it is gone finish, and commits nothing for it', async () => {
    const doc = seedDoc();
    mockGetTempo.mockReturnValue(null);
    let settle: (v: TempoEntry | null) => void = () => {};
    mockRunTempoAnalysis.mockReturnValue(
      new Promise<TempoEntry | null>((resolve) => {
        settle = resolve;
      })
    );
    const { unmount } = render(<TempoDialog onClose={jest.fn()} />);
    fireEvent.click(screen.getByTestId('tempo-detect-button'));

    unmount();
    await act(async () => {
      settle(makeEntry({ bpm: 128 }));
    });

    // The analysis is deliberately NOT cancelled: it warms a per-document
    // analysis cache, keyed to the document it measured, and throwing that away
    // would cost the user the wait for nothing. What it must never do is commit
    // — and this is the assertion that would notice if it ever started to.
    const post = useAppStore.getState().documents.find((d) => d.id === doc.id)!;
    expect(post.channels[0]).toBe(doc.channels[0]);
    expect(useAppStore.getState().markers[doc.id] ?? []).toEqual([]);
    // The guard on the setState that follows is hygiene rather than a fix — as
    // of React 19 a setState after unmount is a silent no-op, so deleting it
    // changes nothing observable. It is stated here rather than pinned, because
    // a test that cannot fail is worse than a sentence that is true.
  });
});
