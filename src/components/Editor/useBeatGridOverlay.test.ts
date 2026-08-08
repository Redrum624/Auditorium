/**
 * The adapter's whole job is mapping a `BeatGrid` onto the renderer's overlay
 * shape, so `getBeatGrid` is mocked here and the mapping is asserted directly.
 * The selector's own behaviour (resolution order, inheritance, never starting
 * an analysis) is covered by `services/beatGrid.test.ts` against the real
 * analysis path.
 */
import { renderHook, act } from '@testing-library/react';
import { useBeatGridOverlay } from './useBeatGridOverlay';
import { getBeatGrid, type BeatGrid } from '../../services/beatGrid';
import { setBeatGridVisible, toggleBeatGrid } from '../../services/beatGridDisplay';
import { CONFIDENCE_LOW } from '../../dsp/tempoCore';

jest.mock('../../services/beatGrid', () => {
  const actual = jest.requireActual('../../services/beatGrid');
  return { ...actual, getBeatGrid: jest.fn() };
});

const mockGetBeatGrid = getBeatGrid as jest.MockedFunction<typeof getBeatGrid>;

function grid(over: Partial<BeatGrid> = {}): BeatGrid {
  return {
    beatSamples: Int32Array.from([0, 22050, 44100, 66150, 88200]),
    sampleRate: 44100,
    beatsPerBar: null,
    downbeatPhase: null,
    barCount: 0,
    confidence: 0.9,
    stale: false,
    analyzedEndSample: 88200,
    truncated: false,
    origin: 'own',
    originDocId: 'doc-1',
    originOpen: true,
    ...over,
  };
}

const CHANNELS = [new Float32Array(8)];

beforeEach(() => {
  setBeatGridVisible(true);
  mockGetBeatGrid.mockReset();
});

describe('useBeatGridOverlay (Task B2)', () => {
  it('returns null when the document has no cached grid — and never asks for one', () => {
    mockGetBeatGrid.mockReturnValue(null);
    const { result } = renderHook(() => useBeatGridOverlay('doc-1', CHANNELS));
    expect(result.current).toBeNull();
  });

  it('returns null while the toggle is off, without consulting the grid at all', () => {
    mockGetBeatGrid.mockReturnValue(grid());
    setBeatGridVisible(false);
    const { result } = renderHook(() => useBeatGridOverlay('doc-1', CHANNELS));
    expect(result.current).toBeNull();
    expect(mockGetBeatGrid).not.toHaveBeenCalled();
  });

  it('passes the grid through by REFERENCE — the shared Int32Array is never copied', () => {
    const g = grid();
    mockGetBeatGrid.mockReturnValue(g);
    const { result } = renderHook(() => useBeatGridOverlay('doc-1', CHANNELS));
    expect(result.current!.beats).toBe(g.beatSamples);
    expect(result.current!.endSample).toBe(88200);
  });

  it('supplies NO isDownbeat predicate when no metre was measured', () => {
    mockGetBeatGrid.mockReturnValue(grid({ beatsPerBar: null, downbeatPhase: null }));
    const { result } = renderHook(() => useBeatGridOverlay('doc-1', CHANNELS));
    expect(result.current!.isDownbeat).toBeUndefined();
  });

  it('supplies a real isDownbeat predicate when the metre WAS measured', () => {
    mockGetBeatGrid.mockReturnValue(
      grid({ beatsPerBar: 2, downbeatPhase: 1, barCount: 2 })
    );
    const { result } = renderHook(() => useBeatGridOverlay('doc-1', CHANNELS));
    const pred = result.current!.isDownbeat!;
    // Bars start at beat 1 and beat 3; beat 0 precedes the first measured
    // downbeat and is deliberately unclassified.
    expect([0, 1, 2, 3, 4].map(pred)).toEqual([false, true, false, true, false]);
  });

  it('marks a STALE grid provisional (the drawn analogue of the status bar *)', () => {
    mockGetBeatGrid.mockReturnValue(grid({ stale: true, confidence: 0.9 }));
    const { result } = renderHook(() => useBeatGridOverlay('doc-1', CHANNELS));
    expect(result.current!.provisional).toBe(true);
  });

  it('marks a LOW-CONFIDENCE grid provisional (the drawn analogue of the ?)', () => {
    mockGetBeatGrid.mockReturnValue(grid({ confidence: CONFIDENCE_LOW - 0.01 }));
    const { result } = renderHook(() => useBeatGridOverlay('doc-1', CHANNELS));
    expect(result.current!.provisional).toBe(true);
  });

  it('leaves a fresh, confident grid unmarked — exactly at the threshold counts as confident', () => {
    mockGetBeatGrid.mockReturnValue(grid({ confidence: CONFIDENCE_LOW, stale: false }));
    const { result } = renderHook(() => useBeatGridOverlay('doc-1', CHANNELS));
    expect(result.current!.provisional).toBe(false);
  });

  it('keeps a STABLE identity across re-renders so the canvas is not repainted for nothing', () => {
    mockGetBeatGrid.mockImplementation(() => grid()); // a fresh object every call
    const { result, rerender } = renderHook(() => useBeatGridOverlay('doc-1', CHANNELS));
    const first = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(first);
    expect(mockGetBeatGrid).toHaveBeenCalledTimes(1);
  });

  it('recomputes when the audio CHANGES, so an edit is reflected as stale', () => {
    mockGetBeatGrid.mockReturnValueOnce(grid({ stale: false }));
    let channels = CHANNELS;
    const { result, rerender } = renderHook(() => useBeatGridOverlay('doc-1', channels));
    expect(result.current!.provisional).toBe(false);

    mockGetBeatGrid.mockReturnValueOnce(grid({ stale: true }));
    channels = [new Float32Array(8)]; // what an edit produces: new arrays
    rerender();
    expect(result.current!.provisional).toBe(true);
  });

  it('reacts to the toggle', () => {
    mockGetBeatGrid.mockImplementation(() => grid());
    const { result } = renderHook(() => useBeatGridOverlay('doc-1', CHANNELS));
    expect(result.current).not.toBeNull();
    act(() => {
      toggleBeatGrid();
    });
    expect(result.current).toBeNull();
    act(() => {
      toggleBeatGrid();
    });
    expect(result.current).not.toBeNull();
  });
});
