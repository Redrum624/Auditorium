import { act, fireEvent, render } from '@testing-library/react';
import TrackHeader from './TrackHeader';
import type { Track } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';

/**
 * F0 — TrackHeader's automation surface: the per-row envelope toggles (open/
 * close the lane overlay via `mtEnvelope`) and ruling B's honest fader state —
 * a slider whose parameter is GOVERNED by an active lane is disabled, because
 * the lane overrides the static field entirely while it has keys.
 */

function track0(): Track {
  return useSessionStore.getState().session.tracks[0];
}

beforeEach(() => {
  useSessionStore.getState().newSession(44100);
});

describe('envelope toggles', () => {
  it('opens and closes the envelope lane for this track and param (aria-pressed mirrors it)', () => {
    const { getByLabelText } = render(<TrackHeader track={track0()} />);
    const volBtn = getByLabelText('Volume envelope');
    expect(volBtn.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(volBtn);
    expect(useSessionStore.getState().mtEnvelope).toEqual({
      trackId: track0().id,
      param: 'volumeDb',
    });
    expect(volBtn.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(volBtn);
    expect(useSessionStore.getState().mtEnvelope).toBeNull();
    expect(volBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('the pan toggle targets the pan param, and opening one replaces the other (one open envelope)', () => {
    const { getByLabelText } = render(<TrackHeader track={track0()} />);
    fireEvent.click(getByLabelText('Volume envelope'));
    fireEvent.click(getByLabelText('Pan envelope'));
    expect(useSessionStore.getState().mtEnvelope).toEqual({
      trackId: track0().id,
      param: 'pan',
    });
    expect(getByLabelText('Volume envelope').getAttribute('aria-pressed')).toBe('false');
    expect(getByLabelText('Pan envelope').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('ruling B on the faders', () => {
  it('a slider is disabled exactly while its lane has keys; the other param stays live', () => {
    const id = track0().id;
    act(() => {
      useSessionStore.getState().upsertAutomationKey(id, 'volumeDb', { positionSample: 0, value: -6 });
    });
    const { getByLabelText, rerender } = render(<TrackHeader track={track0()} />);
    expect((getByLabelText('Volume (dB)') as HTMLInputElement).disabled).toBe(true);
    expect((getByLabelText('Pan') as HTMLInputElement).disabled).toBe(false);

    act(() => {
      useSessionStore.getState().removeAutomationKey(id, 'volumeDb', 0);
    });
    rerender(<TrackHeader track={track0()} />);
    expect((getByLabelText('Volume (dB)') as HTMLInputElement).disabled).toBe(false);
  });

  it('a zero-key lane does NOT disable the slider (zero keys === no lane)', () => {
    const t: Track = { ...track0(), automation: [{ param: 'volumeDb', keys: [] }] };
    const { getByLabelText } = render(<TrackHeader track={t} />);
    expect((getByLabelText('Volume (dB)') as HTMLInputElement).disabled).toBe(false);
  });
});

describe('F5 — ruling 4 on the pan fader', () => {
  it('an active spatial lane disables the pan slider with the SPATIAL explanation', () => {
    const id = track0().id;
    act(() => {
      useSessionStore.getState().upsertAutomationKey(id, 'azimuth', { positionSample: 0, value: 90 });
    });
    const { getByLabelText } = render(<TrackHeader track={track0()} />);
    const pan = getByLabelText('Pan') as HTMLInputElement;
    expect(pan.disabled).toBe(true);
    expect(pan.title).toBe('Overridden by the spatial position (Spatial panel)');
    // The volume fader stays live, and the pan TOGGLE stays un-governed
    // (it reflects the pan LANE, which has no keys here).
    expect((getByLabelText('Volume (dB)') as HTMLInputElement).disabled).toBe(false);
    expect(getByLabelText('Pan envelope').getAttribute('title')).toBe('Pan envelope');
  });

  it('a pan LANE keeps its own explanation when no spatial lane exists', () => {
    const id = track0().id;
    act(() => {
      useSessionStore.getState().upsertAutomationKey(id, 'pan', { positionSample: 0, value: 0.5 });
    });
    const { getByLabelText } = render(<TrackHeader track={track0()} />);
    const pan = getByLabelText('Pan') as HTMLInputElement;
    expect(pan.disabled).toBe(true);
    expect(pan.title).toBe('Overridden by the pan envelope (lane has keys)');
  });
});
