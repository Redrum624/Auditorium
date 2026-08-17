import { act, fireEvent, render } from '@testing-library/react';
import SpatialPanel from './SpatialPanel';
import { useSessionStore } from '../../multitrack/sessionStore';
import { SESSION_UNDO_KEY, _resetSessionUndo, undoSession } from '../../multitrack/sessionUndo';
import { getHistory } from '../../services/undoHistory';

/**
 * R3 — the spatial panel's commits as undo entries: the stage drop is one
 * intent-labeled entry ('Set spatial position'); elevation commits are
 * labeled 'Set elevation', and ONLY the keyboard path coalesces (contiguous
 * arrow taps merge; pointer commits are one entry per drag).
 */

function firePointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { clientX: number; clientY: number; button?: number }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
    button: init.button ?? 0,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

const doneLabels = () => getHistory(SESSION_UNDO_KEY).done;
const sessionRef = () => useSessionStore.getState().session;

beforeEach(() => {
  _resetSessionUndo();
  useSessionStore.getState().newSession(44100);
  _resetSessionUndo();
});

describe('stage drop', () => {
  it('one drop = one "Set spatial position" entry; undo removes both keys at once', () => {
    const pre = sessionRef();
    const { getByTestId } = render(<SpatialPanel />);
    const stage = getByTestId('spatial-stage');

    firePointer(stage, 'pointerdown', { clientX: 216, clientY: 150 });
    firePointer(stage, 'pointermove', { clientX: 150, clientY: 216 });
    firePointer(stage, 'pointerup', { clientX: 150, clientY: 216 });

    expect(doneLabels()).toEqual(['Set spatial position']);
    act(() => undoSession());
    expect(sessionRef()).toBe(pre); // azimuth AND distance keys lifted together
  });
});

describe('elevation commits', () => {
  it('contiguous keyboard keyups coalesce into ONE "Set elevation" entry', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    const { getByTestId } = render(<SpatialPanel />);
    const slider = getByTestId('spatial-elevation') as HTMLInputElement;

    fireEvent.change(slider, { target: { value: '10' } }); // preview
    fireEvent.keyUp(slider); // commit (keyboard)
    fireEvent.change(slider, { target: { value: '20' } });
    fireEvent.keyUp(slider);
    fireEvent.change(slider, { target: { value: '30' } });
    fireEvent.keyUp(slider);

    expect(doneLabels()).toEqual(['Set elevation']);
    now.mockRestore();
  });

  it('keyboard commits on DIFFERENT tracks never merge — the track-id operand of the coalesce key', () => {
    // Review round 1: `elevation:${track.id}` survived a mutant that fixed
    // the key — nudge track A's elevation, switch the panel to track B,
    // nudge within the window, and both merged into one entry. This fixture
    // pins the id operand: two tracks, two entries, undo lifts only B's key.
    const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    const { getByTestId } = render(<SpatialPanel />);
    const slider = getByTestId('spatial-elevation') as HTMLInputElement;
    const tracks = useSessionStore.getState().session.tracks;

    fireEvent.change(slider, { target: { value: '10' } });
    fireEvent.keyUp(slider); // commits on track 1 (the default governed track)
    act(() => {
      fireEvent.change(getByTestId('spatial-track-select'), { target: { value: tracks[1].id } });
    });
    fireEvent.change(slider, { target: { value: '20' } });
    fireEvent.keyUp(slider); // commits on track 2, same param, in-window

    expect(doneLabels()).toEqual(['Set elevation', 'Set elevation']);

    const hasElevation = (trackId: string) =>
      (useSessionStore.getState().session.tracks.find((t) => t.id === trackId)?.automation ?? []).some(
        (l) => l.param === 'elevation' && l.keys.length > 0
      );
    expect(hasElevation(tracks[0].id)).toBe(true);
    expect(hasElevation(tracks[1].id)).toBe(true);
    act(() => undoSession()); // must lift ONLY track 2's key
    expect(hasElevation(tracks[0].id)).toBe(true);
    expect(hasElevation(tracks[1].id)).toBe(false);
    now.mockRestore();
  });

  it('pointer commits never coalesce: two slider releases are two entries', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    const { getByTestId } = render(<SpatialPanel />);
    const slider = getByTestId('spatial-elevation') as HTMLInputElement;

    fireEvent.change(slider, { target: { value: '10' } });
    fireEvent.pointerUp(slider); // commit (pointer)
    fireEvent.change(slider, { target: { value: '20' } });
    fireEvent.pointerUp(slider);

    expect(doneLabels()).toEqual(['Set elevation', 'Set elevation']);
    now.mockRestore();
  });
});
