import { act, fireEvent, render } from '@testing-library/react';
import TrackHeader from './TrackHeader';
import type { Track } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { SESSION_UNDO_KEY, _resetSessionUndo, undoSession } from '../../multitrack/sessionUndo';
import { getHistory } from '../../services/undoHistory';

/**
 * R3 — the fader gestures (ruling 2): a pointer drag on a range input fires
 * onChange per tick, bracketed into ONE entry; keyboard arrows fire onChange
 * with no pointer events and coalesce via the store's per-(track,param) key.
 */

function track0(): Track {
  return useSessionStore.getState().session.tracks[0];
}

const doneLabels = () => getHistory(SESSION_UNDO_KEY).done;
const sessionRef = () => useSessionStore.getState().session;

beforeEach(() => {
  _resetSessionUndo();
  useSessionStore.getState().newSession(44100);
  _resetSessionUndo();
});

describe('volume slider', () => {
  it('a pointer drag (down, N change ticks, up) is EXACTLY ONE "Set track volume" entry', () => {
    const pre = sessionRef();
    const { getByLabelText } = render(<TrackHeader track={track0()} />);
    const slider = getByLabelText('Volume (dB)') as HTMLInputElement;

    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '-2' } });
    fireEvent.change(slider, { target: { value: '-4' } });
    fireEvent.change(slider, { target: { value: '-6' } });
    fireEvent.pointerUp(slider);

    expect(track0().volumeDb).toBe(-6);
    expect(doneLabels()).toEqual(['Set track volume']);
    act(() => undoSession());
    expect(sessionRef()).toBe(pre); // one step back to the pre-drag state
  });

  it('keyboard ticks (change events with no pointer bracket) coalesce into one entry', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    const { getByLabelText } = render(<TrackHeader track={track0()} />);
    const slider = getByLabelText('Volume (dB)') as HTMLInputElement;

    fireEvent.change(slider, { target: { value: '-1' } });
    fireEvent.change(slider, { target: { value: '-2' } });
    fireEvent.change(slider, { target: { value: '-3' } });

    expect(track0().volumeDb).toBe(-3);
    expect(doneLabels()).toEqual(['Set track volume']);
    now.mockRestore();
  });

  it('two separate pointer drags are two entries (drags never coalesce)', () => {
    const { getByLabelText } = render(<TrackHeader track={track0()} />);
    const slider = getByLabelText('Volume (dB)') as HTMLInputElement;

    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '-2' } });
    fireEvent.pointerUp(slider);
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '-4' } });
    fireEvent.pointerUp(slider);

    expect(doneLabels()).toEqual(['Set track volume', 'Set track volume']);
  });
});

describe('pan slider and the toggles', () => {
  it('a pan drag is one "Set track pan" entry; M/S/R clicks are individually labeled entries', () => {
    const { getByLabelText } = render(<TrackHeader track={track0()} />);
    const pan = getByLabelText('Pan') as HTMLInputElement;

    fireEvent.pointerDown(pan);
    fireEvent.change(pan, { target: { value: '0.5' } });
    fireEvent.change(pan, { target: { value: '0.75' } });
    fireEvent.pointerUp(pan);
    fireEvent.click(getByLabelText('Mute'));
    fireEvent.click(getByLabelText('Solo'));

    expect(doneLabels()).toEqual(['Set track pan', 'Mute track', 'Solo track']);
  });
});
