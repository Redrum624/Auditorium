import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import AlignTimingDialog from './AlignTimingDialog';
import { useAppStore, makeInitialState, type Marker } from '../../stores/appStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { getBeatGrid, type BeatGrid } from '../../services/beatGrid';
import { getTempo, regridTempo } from '../../services/tempoAnalysis';
import { applyTimingAlignment, suggestSyllableMarkers } from '../../services/timingAlignService';
import { CONFIDENCE_LOW } from '../../dsp/tempoCore';
import { DEFAULT_STRENGTH } from '../../dsp/timingWarp';

// `buildAlignPlan` stays REAL (requireActual) so the dialog's summary numbers
// are the service's actual arithmetic and cannot drift from it; only the
// worker-backed / effectful entry points are mocked.
jest.mock('../../services/timingAlignService', () => ({
  ...jest.requireActual('../../services/timingAlignService'),
  applyTimingAlignment: jest.fn(),
  suggestSyllableMarkers: jest.fn(),
}));
jest.mock('../../services/beatGrid', () => ({
  ...jest.requireActual('../../services/beatGrid'),
  getBeatGrid: jest.fn(),
}));
jest.mock('../../services/tempoAnalysis', () => ({
  ...jest.requireActual('../../services/tempoAnalysis'),
  getTempo: jest.fn(),
  regridTempo: jest.fn(),
}));

const mockGetBeatGrid = getBeatGrid as jest.MockedFunction<typeof getBeatGrid>;
const mockGetTempo = getTempo as jest.MockedFunction<typeof getTempo>;
const mockRegridTempo = regridTempo as jest.MockedFunction<typeof regridTempo>;
const mockApply = applyTimingAlignment as jest.MockedFunction<typeof applyTimingAlignment>;
const mockSuggest = suggestSyllableMarkers as jest.MockedFunction<typeof suggestSyllableMarkers>;

const SR = 48000;
/** Beats at exactly 0.5 s (120 BPM), 24 of them. */
const BEATS = Int32Array.from({ length: 24 }, (_, i) => i * (SR / 2));

function makeGrid(overrides: Partial<BeatGrid> = {}): BeatGrid {
  return {
    beatSamples: BEATS,
    sampleRate: SR,
    beatsPerBar: null,
    downbeatPhase: null,
    barCount: 0,
    confidence: 0.8,
    stale: false,
    analyzedEndSample: BEATS[BEATS.length - 1],
    truncated: false,
    origin: 'own',
    originDocId: 'doc-1',
    originOpen: true,
    ...overrides,
  };
}

function seedDoc(samples = SR * 12): AudioDocument {
  const doc = createDocument({ name: 'take.wav', sampleRate: SR, channels: [new Float32Array(samples)] });
  useAppStore.getState().addDocument(doc);
  return doc;
}

function setMarkers(docId: string, positions: number[]): void {
  const list: Marker[] = positions.map((positionSample, i) => ({
    id: `m${i}`,
    name: `Syllable ${i + 1}`,
    positionSample,
  }));
  useAppStore.getState().setMarkersForDoc(docId, list);
}

/** Places `count` markers a fixed number of samples off consecutive beats. */
function offBeatMarkers(docId: string, offset: number, count = 4): void {
  setMarkers(
    docId,
    Array.from({ length: count }, (_, i) => BEATS[i + 2] + offset)
  );
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  jest.clearAllMocks();
  mockGetBeatGrid.mockReturnValue(makeGrid());
  mockGetTempo.mockReturnValue(null);
  mockApply.mockResolvedValue({ ok: true, markersMoved: 3 });
  mockSuggest.mockReturnValue({ added: 12, truncated: false, analysedSeconds: 12 });
});

function open(): void {
  render(<AlignTimingDialog onClose={() => {}} />);
}

describe('AlignTimingDialog — RULING 1, confirm before warp', () => {
  it('keeps Apply disabled until the grid is explicitly confirmed', () => {
    const doc = seedDoc();
    offBeatMarkers(doc.id, 1500);
    open();

    const apply = screen.getByTestId('align-apply');
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByTestId('align-grid-confirmed'));
    expect(apply).not.toBeDisabled();
  });

  it('un-confirms when the subdivision changes, so the tick always refers to what is on screen', () => {
    const doc = seedDoc();
    offBeatMarkers(doc.id, 1500);
    open();

    fireEvent.click(screen.getByTestId('align-grid-confirmed'));
    expect(screen.getByTestId('align-apply')).not.toBeDisabled();

    fireEvent.change(screen.getByTestId('align-division'), { target: { value: '4' } });
    expect(screen.getByTestId('align-grid-confirmed')).not.toBeChecked();
    expect(screen.getByTestId('align-apply')).toBeDisabled();
  });

  it('never applies without a confirmation, even with a perfect plan', async () => {
    const doc = seedDoc();
    offBeatMarkers(doc.id, 1500);
    open();
    fireEvent.click(screen.getByTestId('align-apply'));
    await act(async () => {});
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('offers no grid, and no Apply, when nothing has been analysed', () => {
    const doc = seedDoc();
    offBeatMarkers(doc.id, 1500);
    mockGetBeatGrid.mockReturnValue(null);
    open();

    expect(screen.getByTestId('align-no-grid')).toHaveTextContent(/Detect Tempo/i);
    expect(screen.queryByTestId('align-grid-confirmed')).toBeNull();
    expect(screen.getByTestId('align-apply')).toBeDisabled();
  });

  it('warns when the detector had low confidence, and does not when it did not', () => {
    const doc = seedDoc();
    offBeatMarkers(doc.id, 1500);

    mockGetBeatGrid.mockReturnValue(makeGrid({ confidence: CONFIDENCE_LOW - 0.01 }));
    const low = render(<AlignTimingDialog onClose={() => {}} />);
    expect(screen.getByTestId('align-confidence')).toHaveTextContent(/below the/i);
    low.unmount();

    mockGetBeatGrid.mockReturnValue(makeGrid({ confidence: CONFIDENCE_LOW }));
    render(<AlignTimingDialog onClose={() => {}} />);
    expect(screen.getByTestId('align-confidence')).not.toHaveTextContent(/below the/i);
  });
});

describe('AlignTimingDialog — showing what will happen before it happens', () => {
  it('reports the BPM the tracked beats actually imply', () => {
    const doc = seedDoc();
    offBeatMarkers(doc.id, 1500);
    open();
    // BEATS are 0.5 s apart at 48 kHz => 120 BPM, derived from the positions,
    // not read from a tempo entry (an inherited grid has none).
    expect(screen.getByTestId('align-grid-summary')).toHaveTextContent('120.0 BPM');
    expect(screen.getByTestId('align-grid-summary')).toHaveTextContent('24 beats');
  });

  it('takes the MEDIAN gap, so one DROPPED beat cannot move the headline BPM', () => {
    const doc = seedDoc();
    // `BEATS` is perfectly uniform, where the median, the mean and every
    // individual gap are the same number — so `gaps.sort(...)` could be deleted
    // outright and all 22 tests stayed green, even though this figure is what
    // the user ticks 'Grid and subdivision are correct' against.
    //
    // Here beat 12 is missing, exactly the tracking failure the median exists to
    // absorb. That leaves 22 gaps, 21 of 24 000 samples and one of 48 000 — and
    // the doubled one sits at index 11, which is `floor(22 / 2)`: read
    // UNSORTED the headline would be 60.0 BPM, half the real tempo, on a grid
    // that is 120 BPM everywhere but one bar.
    const dropped = Int32Array.from(Array.from(BEATS).filter((_, i) => i !== 12));
    mockGetBeatGrid.mockReturnValue(makeGrid({ beatSamples: dropped }));
    offBeatMarkers(doc.id, 1500);
    open();

    expect(screen.getByTestId('align-grid-summary')).toHaveTextContent('120.0 BPM');
    expect(screen.getByTestId('align-grid-summary')).toHaveTextContent('23 beats');
  });

  it('reports the median and largest move over the whole marker list', () => {
    const doc = seedDoc();
    // 1440, 960, 480 and 2400 samples off the beat = 30, 20, 10 and 50 ms.
    setMarkers(doc.id, [BEATS[2] + 1440, BEATS[4] + 960, BEATS[6] + 480, BEATS[8] + 2400]);
    open();
    const summary = screen.getByTestId('align-anchor-summary');
    expect(summary).toHaveTextContent('4 markers will move');
    expect(summary).toHaveTextContent('median 30 ms');
    expect(summary).toHaveTextContent('largest 50 ms');
  });

  it('labels every subdivision with the median move it implies', () => {
    const doc = seedDoc();
    // Markers on the half-beat: 250 ms from the nearest beat, 0 from the
    // nearest half-beat. The labels have to disagree, or the control is decor.
    setMarkers(
      doc.id,
      [2, 4, 6].map((i) => (BEATS[i] + BEATS[i + 1]) / 2)
    );
    open();
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(options[0]).toContain('Beat');
    expect(options[0]).toContain('median move 250 ms');
    expect(options[1]).toContain('½ beat');
    expect(options[1]).toContain('median move 0 ms');
    expect(options[2]).toContain('¼ beat');
  });

  it('says how much of the error the current strength leaves in place', () => {
    const doc = seedDoc();
    offBeatMarkers(doc.id, 4800); // 100 ms off the beat
    open();
    // Default strength 25% leaves 75 ms of a 100 ms move.
    expect(screen.getByTestId('align-strength-readout')).toHaveTextContent(
      `${Math.round(DEFAULT_STRENGTH * 100)}%`
    );
    expect(screen.getByTestId('align-residual')).toHaveTextContent('75 ms');

    fireEvent.change(screen.getByTestId('align-strength'), { target: { value: '100' } });
    expect(screen.getByTestId('align-residual')).toHaveTextContent('0 ms');
  });

  it('warns when the stretch bound will hold moves back, and clears when it will not', () => {
    const doc = seedDoc();
    // Two markers between the same pair of beats pulled hard in opposite
    // directions: a differential the 0.88-1.14 band cannot deliver.
    setMarkers(doc.id, [BEATS[4] + 9000, BEATS[5] - 9000]);
    open();
    fireEvent.change(screen.getByTestId('align-strength'), { target: { value: '100' } });
    expect(screen.getByTestId('align-clamped')).toHaveTextContent(/limited by/i);

    fireEvent.change(screen.getByTestId('align-strength'), { target: { value: '1' } });
    expect(screen.queryByTestId('align-clamped')).toBeNull();
  });

  it('reports markers it skipped', () => {
    const doc = seedDoc();
    useAppStore.getState().setSelection({ start: BEATS[2], end: BEATS[10] });
    setMarkers(doc.id, [BEATS[2], BEATS[4] + 500, BEATS[10]]);
    open();
    expect(screen.getByTestId('align-dropped')).toHaveTextContent('2 markers skipped');
  });

  it('says there are no anchors when there are no markers, and refuses to apply', () => {
    seedDoc();
    open();
    expect(screen.getByTestId('align-anchor-summary')).toHaveTextContent(/No markers inside the region/i);
    fireEvent.click(screen.getByTestId('align-grid-confirmed'));
    expect(screen.getByTestId('align-apply')).toBeDisabled();
  });

  it('shows whether the whole file or a selection will be aligned', () => {
    const doc = seedDoc();
    offBeatMarkers(doc.id, 1500);
    const view = render(<AlignTimingDialog onClose={() => {}} />);
    expect(screen.getByTestId('align-scope')).toHaveTextContent('Whole file');
    view.unmount();

    useAppStore.getState().setSelection({ start: 0, end: SR });
    render(<AlignTimingDialog onClose={() => {}} />);
    expect(screen.getByTestId('align-scope')).toHaveTextContent('1000 ms');
  });
});

describe('AlignTimingDialog — applying', () => {
  it('passes the confirmed plan and the chosen strength through to the service', async () => {
    const doc = seedDoc();
    offBeatMarkers(doc.id, 1500);
    open();
    fireEvent.change(screen.getByTestId('align-strength'), { target: { value: '60' } });
    fireEvent.click(screen.getByTestId('align-grid-confirmed'));
    fireEvent.click(screen.getByTestId('align-apply'));

    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1));
    const [req] = mockApply.mock.calls[0];
    expect(req.strength).toBeCloseTo(0.6, 9);
    expect(req.plan.anchors).toHaveLength(4);
    expect(req.plan.effectAnchors).toHaveLength(4);
  });

  it('closes on success and stays open with the reason on refusal', async () => {
    const doc = seedDoc();
    offBeatMarkers(doc.id, 1500);
    const onClose = jest.fn();
    render(<AlignTimingDialog onClose={onClose} />);
    fireEvent.click(screen.getByTestId('align-grid-confirmed'));

    mockApply.mockResolvedValueOnce({ ok: false, reason: 'no-change' });
    fireEvent.click(screen.getByTestId('align-apply'));
    await waitFor(() => expect(screen.getByTestId('align-error')).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();

    mockApply.mockResolvedValueOnce({ ok: true, markersMoved: 3 });
    fireEvent.click(screen.getByTestId('align-apply'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('cannot apply at strength 0', () => {
    const doc = seedDoc();
    offBeatMarkers(doc.id, 1500);
    open();
    fireEvent.click(screen.getByTestId('align-grid-confirmed'));
    expect(screen.getByTestId('align-apply')).not.toBeDisabled();
    fireEvent.change(screen.getByTestId('align-strength'), { target: { value: '0' } });
    expect(screen.getByTestId('align-apply')).toBeDisabled();
  });
});

describe('AlignTimingDialog — the detector is a proposal', () => {
  it('says so on screen, with the measured reliability, next to the button', () => {
    const doc = seedDoc();
    offBeatMarkers(doc.id, 1500);
    open();
    expect(screen.getByTestId('align-suggest')).toBeInTheDocument();
    expect(screen.getByText(/one anchor in eight wrong/i)).toBeInTheDocument();
  });

  it('runs the suggester and reports what it added', async () => {
    const doc = seedDoc();
    offBeatMarkers(doc.id, 1500);
    open();
    fireEvent.click(screen.getByTestId('align-suggest'));
    await waitFor(() => expect(mockSuggest).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('align-note')).toHaveTextContent('Added 12 markers'));
    expect(screen.getByTestId('align-note')).toHaveTextContent(/delete before applying/i);
  });

  it('reports finding nothing rather than looking like it worked', async () => {
    const doc = seedDoc();
    offBeatMarkers(doc.id, 1500);
    mockSuggest.mockReturnValue({ added: 0, truncated: false, analysedSeconds: 12 });
    open();
    fireEvent.click(screen.getByTestId('align-suggest'));
    await waitFor(() => expect(screen.getByTestId('align-note')).toHaveTextContent(/No syllable onsets/i));
  });
});

describe('AlignTimingDialog — octave correction', () => {
  it('re-tracks through regridTempo rather than relabelling, and only for an own grid', async () => {
    const doc = seedDoc();
    offBeatMarkers(doc.id, 1500);
    mockGetTempo.mockReturnValue({ periodFrames: 40, bpm: 120 } as never);
    mockRegridTempo.mockResolvedValue({ bpm: 240 } as never);
    open();

    fireEvent.click(screen.getByTestId('align-octave-double'));
    await waitFor(() => expect(mockRegridTempo).toHaveBeenCalledWith(doc.id, 20));
    fireEvent.click(screen.getByTestId('align-octave-half'));
    await waitFor(() => expect(mockRegridTempo).toHaveBeenCalledWith(doc.id, 80));
  });

  it('disables re-tracking for an inherited grid, which has no analysis of its own', () => {
    const doc = seedDoc();
    offBeatMarkers(doc.id, 1500);
    mockGetBeatGrid.mockReturnValue(makeGrid({ origin: 'inherited' }));
    mockGetTempo.mockReturnValue({ periodFrames: 40, bpm: 120 } as never);
    open();
    expect(screen.getByTestId('align-octave-double')).toBeDisabled();
    expect(screen.getByTestId('align-octave-half')).toBeDisabled();
  });

  it('un-confirms the grid after a re-track, so the tick cannot outlive what it confirmed', async () => {
    const doc = seedDoc();
    offBeatMarkers(doc.id, 1500);
    mockGetTempo.mockReturnValue({ periodFrames: 40, bpm: 120 } as never);
    mockRegridTempo.mockResolvedValue({ bpm: 240 } as never);
    open();
    fireEvent.click(screen.getByTestId('align-grid-confirmed'));
    expect(screen.getByTestId('align-grid-confirmed')).toBeChecked();
    fireEvent.click(screen.getByTestId('align-octave-double'));
    await waitFor(() => expect(screen.getByTestId('align-grid-confirmed')).not.toBeChecked());
  });
});

/**
 * T6-3 — the cancel ref this dialog had none of.
 *
 * U2's fix round corrected its own claim that all nine hosted tools discard
 * their work on unmount: seven do, and the two that did not — this one and
 * `TempoDialog` — committed a finished pass into a document the user had walked
 * away from. The module lock has been standing in for the discipline; these are
 * the tests that make the discipline real, so the lock's job can be argued
 * about on evidence rather than on hope.
 *
 * Both of this dialog's committing paths are covered, because they fail
 * differently: Apply commits inside the effect runner (so the flag has to be
 * handed DOWN), Suggest commits in this file one animation frame later (so the
 * frame has to be cancelled).
 */
describe('AlignTimingDialog — a walk-away commits nothing (T6-3)', () => {
  function startApply(): { unmount: () => void; onClose: jest.Mock } {
    const doc = seedDoc();
    offBeatMarkers(doc.id, 1500);
    const onClose = jest.fn();
    const { unmount } = render(<AlignTimingDialog onClose={onClose} />);
    fireEvent.click(screen.getByTestId('align-grid-confirmed'));
    fireEvent.click(screen.getByTestId('align-apply'));
    return { unmount, onClose };
  }

  it('hands the service a cancel that reads false while it is open and true once it is gone', () => {
    // Never resolves: the pass is still in flight for the whole test, which is
    // exactly the window a walk-away lands in.
    mockApply.mockReturnValue(new Promise(() => {}));
    const { unmount } = startApply();

    const shouldCancel = mockApply.mock.calls[0][0].shouldCancel;
    expect(shouldCancel).toBeDefined();
    expect(shouldCancel!()).toBe(false);

    unmount();

    // The runner reads this between the warped audio arriving and `applyEdit`
    // writing it, so `true` here is the whole of "commits nothing".
    expect(shouldCancel!()).toBe(true);
  });

  it('acts on nothing when the pass resolves after the tool is gone', async () => {
    // Settled SUCCESSFULLY on purpose. A refusal would prove nothing here: the
    // `if (outcome.ok)` arm is already false for one, so the test would pass
    // with the unmount guard deleted — which is exactly what a mutation run
    // showed the first version of this test doing. Success is the only outcome
    // that makes the guard the reason `onClose` is not called.
    let settle: (v: { ok: true; markersMoved: number }) => void = () => {};
    mockApply.mockReturnValue(new Promise((resolve) => {
      settle = resolve as typeof settle;
    }));
    const { unmount, onClose } = startApply();

    unmount();
    await act(async () => {
      settle({ ok: true, markersMoved: 3 });
    });

    // `onClose` on an already-dropped tool asks the host to drop it twice.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cancels the frame Suggest deferred its detection to, so no markers are written', () => {
    const frames: FrameRequestCallback[] = [];
    const raf = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        frames.push(cb);
        return frames.length;
      });
    const cancelled: number[] = [];
    const caf = jest
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation((h: number) => void cancelled.push(h));
    try {
      const doc = seedDoc();
      offBeatMarkers(doc.id, 1500);
      const { unmount } = render(<AlignTimingDialog onClose={() => {}} />);

      fireEvent.click(screen.getByTestId('align-suggest'));
      expect(frames).toHaveLength(1);

      unmount();
      expect(cancelled).toEqual([1]);

      // And if the frame was already dispatched when the unmount landed, the
      // callback still runs — so it re-reads the decision rather than trusting
      // the cancel. `suggestSyllableMarkers` writes markers AND an undo entry.
      act(() => {
        frames[0](0);
      });
      expect(mockSuggest).not.toHaveBeenCalled();
    } finally {
      raf.mockRestore();
      caf.mockRestore();
    }
  });

  it('still runs Suggest normally while the tool is open', () => {
    const doc = seedDoc();
    offBeatMarkers(doc.id, 1500);
    const frames: FrameRequestCallback[] = [];
    const raf = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        frames.push(cb);
        return frames.length;
      });
    try {
      render(<AlignTimingDialog onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('align-suggest'));
      act(() => {
        frames[0](0);
      });
      expect(mockSuggest).toHaveBeenCalledTimes(1);
    } finally {
      raf.mockRestore();
    }
  });
});
