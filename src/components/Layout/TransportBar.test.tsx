import { render, screen, fireEvent, act } from '@testing-library/react';
import TransportBar from './TransportBar';
import LevelMeter from './LevelMeter';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import { multitrackPlayer } from '../../multitrack/MultitrackPlayer';
import { registerDialogSetters } from '../../services/dialogBus';

function makeDoc(): AudioDocument {
  return createDocument({
    name: 'clip.wav',
    sampleRate: 44100,
    channels: [new Float32Array(4096), new Float32Array(4096)],
  });
}

describe('TransportBar', () => {
  beforeEach(() => {
    useAppStore.setState(makeInitialState());
  });

  it('renders the transport controls and time readout', () => {
    render(<TransportBar />);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Loop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record' })).toBeInTheDocument();
    expect(screen.getByTestId('transport-time')).toHaveTextContent('0:00.000');
  });

  it('disables playback controls when no document is open (Record stays enabled)', () => {
    render(<TransportBar />);
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    // Record is always enabled — the dialog owns device selection/errors and
    // recording creates a brand-new document, so no active doc is required.
    expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled();
  });

  it('enables play/stop/loop once a document is active', () => {
    const doc = makeDoc();
    useAppStore.getState().addDocument(doc);
    render(<TransportBar />);
    expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Loop' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled();
  });

  it('opens the Record dialog when the Record button is clicked', () => {
    const openRecord = jest.fn();
    registerDialogSetters({
      openExportDialog: () => {},
      openNewFileDialog: () => {},
      openEffectDialog: () => {},
      openConvertDialog: () => {},
      openRecordDialog: openRecord,
    });
    render(<TransportBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(openRecord).toHaveBeenCalled();
  });

  it('toggles the loop flag in the store when the loop button is clicked', () => {
    useAppStore.getState().addDocument(makeDoc());
    render(<TransportBar />);
    expect(useAppStore.getState().playback.loop).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Loop' }));
    expect(useAppStore.getState().playback.loop).toBe(true);
  });

  it('shows the cursor time while stopped', () => {
    const doc = makeDoc();
    useAppStore.getState().addDocument(doc);
    useAppStore.getState().setCursor(44100); // 1 second
    render(<TransportBar />);
    expect(screen.getByTestId('transport-time')).toHaveTextContent('0:01.000');
  });

  it('pushes live track-param changes to the player while multitrack is playing, then stops after', () => {
    // The multitrack position pump uses rAF while playing — stub it to a no-op so
    // no dangling frame callback survives the test (works whether or not the jsdom
    // build pre-defines it).
    const origRaf = globalThis.requestAnimationFrame;
    const origCaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (() => 0) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
    const applySpy = jest.spyOn(multitrackPlayer, 'applyTrackParams').mockImplementation(() => {});

    useSessionStore.getState().newSession(44100);
    useAppStore.getState().setView('multitrack');
    useSessionStore.getState().setMtPlayState('playing');

    const { unmount } = render(<TransportBar />);
    applySpy.mockClear();

    const trackId = useSessionStore.getState().session.tracks[0].id;
    // A track edit replaces the tracks array → subscription fires applyTrackParams.
    act(() => useSessionStore.getState().setTrackParam(trackId, { volumeDb: -3 }));
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy.mock.calls[0][0]).toBe(useSessionStore.getState().session.tracks);

    // Stopping unsubscribes; further edits do not reach the player.
    act(() => useSessionStore.getState().setMtPlayState('stopped'));
    applySpy.mockClear();
    act(() => useSessionStore.getState().setTrackParam(trackId, { volumeDb: -6 }));
    expect(applySpy).not.toHaveBeenCalled();

    unmount();
    // Restore session store + rAF for later suites.
    useSessionStore.getState().newSession(44100);
    applySpy.mockRestore();
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCaf;
  });
});

describe('LevelMeter', () => {
  it('mounts with one bar per channel', () => {
    const { container } = render(<LevelMeter channels={2} />);
    expect(screen.getByTestId('level-meter')).toBeInTheDocument();
    // Two channel rows, each an 8px (h-2) bar.
    expect(container.querySelectorAll('.h-2')).toHaveLength(2);
  });

  it('renders a single bar for mono', () => {
    const { container } = render(<LevelMeter channels={1} />);
    expect(container.querySelectorAll('.h-2')).toHaveLength(1);
  });
});
