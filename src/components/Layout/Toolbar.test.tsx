import { render, screen, fireEvent, act } from '@testing-library/react';
import Toolbar from './Toolbar';
import { createDocument, docLength, type AudioDocument } from '../../audio/AudioDocument';
import { playbackEngine } from '../../audio/PlaybackEngine';
import { useAppStore, makeInitialState, defaultZoom } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import { multitrackPlayer } from '../../multitrack/MultitrackPlayer';
import { registerDialogSetters } from '../../services/dialogBus';
import { _resetSnapPreference, isSnapEnabled, setSnapEnabled } from '../../services/snapPreference';
import { formatTime } from '../../utils/timeFormat';

function makeDoc(): AudioDocument {
  return createDocument({
    name: 'clip.wav',
    sampleRate: 44100,
    channels: [new Float32Array(4096), new Float32Array(4096)],
  });
}

/** The full setter set — individual tests overwrite the spy they care about. */
function registerSetters(overrides: Partial<Parameters<typeof registerDialogSetters>[0]> = {}) {
  registerDialogSetters({
    openExportDialog: () => {},
    openNewFileDialog: () => {},
    openEffectDialog: () => {},
    openConvertDialog: () => {},
    openRecordDialog: () => {},
    openTempoDialog: () => {},
    openRemixDialog: () => {},
    openSeparateDialog: () => {},
    focusRemixPanel: () => {},
    ...overrides,
  });
}

describe('Toolbar (transport pill — previously TransportBar)', () => {
  beforeEach(() => {
    useAppStore.setState(makeInitialState());
  });

  it('renders the transport controls', () => {
    render(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Go to Start' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Loop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record' })).toBeInTheDocument();
  });

  it('disables playback controls when no document is open (Record stays enabled)', () => {
    render(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    // Record is always enabled — the dialog owns device selection/errors and
    // recording creates a brand-new document, so no active doc is required.
    expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled();
  });

  it('enables play/stop/loop once a document is active', () => {
    const doc = makeDoc();
    useAppStore.getState().addDocument(doc);
    render(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Loop' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled();
  });

  it('opens the Record dialog when the Record button is clicked', () => {
    const openRecord = jest.fn();
    registerSetters({ openRecordDialog: openRecord });
    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(openRecord).toHaveBeenCalled();
  });

  it('disables Record in the multitrack view until a track is armed', () => {
    useSessionStore.getState().newSession(44100);
    useAppStore.getState().setView('multitrack');
    render(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Record' })).toBeDisabled();

    const trackId = useSessionStore.getState().session.tracks[0].id;
    act(() => useSessionStore.getState().setTrackParam(trackId, { armed: true }));
    expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled();

    // Restore session store for later suites.
    act(() => useSessionStore.getState().newSession(44100));
  });

  describe('reload effect narrowing (Task M9 / F13)', () => {
    it('does not reload the engine for a metadata-only doc replacement (dirty/name/filePath/sourceBitDepth)', () => {
      const doc = makeDoc();
      useAppStore.getState().addDocument(doc);
      render(<Toolbar />);

      const loadSpy = jest.spyOn(playbackEngine, 'load');
      loadSpy.mockClear(); // drop the mount-time load(); we only care about the update below

      // Exactly what every marker add/rename/delete does via appStore's
      // markDirty (Task M1): a new doc object, same id/channels/sampleRate.
      act(() => {
        useAppStore.getState().updateDocument({
          ...doc,
          dirty: true,
          name: 'renamed.wav',
          filePath: 'D:\\renamed.wav',
          sourceBitDepth: 24,
        });
      });

      expect(loadSpy).not.toHaveBeenCalled();
      loadSpy.mockRestore();
    });

    it('does reload the engine when the channels array reference changes (a real audio edit)', () => {
      const doc = makeDoc();
      useAppStore.getState().addDocument(doc);
      render(<Toolbar />);

      const loadSpy = jest.spyOn(playbackEngine, 'load');
      loadSpy.mockClear();

      act(() => {
        useAppStore.getState().updateDocument({
          ...doc,
          channels: [new Float32Array(4096), new Float32Array(4096)],
        });
      });

      expect(loadSpy).toHaveBeenCalledTimes(1);
      loadSpy.mockRestore();
    });

    it('does reload the engine when a different document becomes active (id changes)', () => {
      const docA = makeDoc();
      useAppStore.getState().addDocument(docA);
      render(<Toolbar />);

      const loadSpy = jest.spyOn(playbackEngine, 'load');
      loadSpy.mockClear();

      const docB = makeDoc();
      act(() => useAppStore.getState().addDocument(docB));

      expect(loadSpy).toHaveBeenCalledTimes(1);
      expect(loadSpy).toHaveBeenCalledWith(docB);
      loadSpy.mockRestore();
    });
  });

  it('toggles the loop flag in the store when the loop button is clicked', () => {
    useAppStore.getState().addDocument(makeDoc());
    render(<Toolbar />);
    expect(useAppStore.getState().playback.loop).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Loop' }));
    expect(useAppStore.getState().playback.loop).toBe(true);
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

    const { unmount } = render(<Toolbar />);
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

describe('Toolbar — G3 floating pill (file ops · transport · view segment · zoom)', () => {
  beforeEach(() => {
    useAppStore.setState(makeInitialState());
    registerSetters();
  });

  it('renders the pill on the chrome surface with all four groups', () => {
    render(<Toolbar />);
    const pill = screen.getByTestId('toolbar-pill');
    expect(pill.className).toContain('glass-chrome');
    // File ops
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    // View segment
    expect(screen.getByTestId('view-toggle')).toBeInTheDocument();
    // Zoom cluster
    expect(screen.getByRole('button', { name: 'Zoom Out' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoom In' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fit' })).toBeInTheDocument();
  });

  it('Open is always enabled; Save/Export/zoom need an active document', () => {
    render(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Open' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Zoom In' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Zoom Out' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Fit' })).toBeDisabled();

    act(() => useAppStore.getState().addDocument(makeDoc()));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Zoom In' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Zoom Out' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Fit' })).toBeEnabled();
  });

  it('Export routes through the file.export command to the export dialog', () => {
    const openExport = jest.fn();
    registerSetters({ openExportDialog: openExport });
    useAppStore.getState().addDocument(makeDoc());
    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(openExport).toHaveBeenCalled();
  });

  it('Go to Start resets the cursor and scroll (transport.goToStart wiring)', () => {
    useAppStore.getState().addDocument(makeDoc());
    useAppStore.getState().setCursor(2000);
    useAppStore.getState().setZoom({ samplesPerPixel: 2, scrollSample: 1000 });
    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Go to Start' }));
    expect(useAppStore.getState().cursorSample).toBe(0);
    expect(useAppStore.getState().zoom.scrollSample).toBe(0);
  });

  it('Play flips to Pause and carries the accent style while playing', () => {
    useAppStore.getState().addDocument(makeDoc());
    render(<Toolbar />);
    const play = screen.getByRole('button', { name: 'Play' });
    expect(play.style.background).not.toContain('--accent-soft');

    act(() => useAppStore.getState().setPlayback({ state: 'playing' }));
    const pause = screen.getByRole('button', { name: 'Pause' });
    expect(pause).toBeInTheDocument();
    expect(pause.style.background).toContain('--accent-soft');
  });

  describe('view segment (moved with its testid from the bottom bar)', () => {
    it('renders the three views; single-doc views need a document, multitrack never does', () => {
      render(<Toolbar />);
      const toggle = screen.getByTestId('view-toggle');
      expect(toggle).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'waveform view' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'spectral view' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'multitrack view' })).toBeEnabled();

      act(() => useAppStore.getState().addDocument(makeDoc()));
      expect(screen.getByRole('button', { name: 'waveform view' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'spectral view' })).toBeEnabled();
    });

    it('clicking a segment switches the view and moves aria-pressed', () => {
      useAppStore.getState().addDocument(makeDoc());
      render(<Toolbar />);
      expect(screen.getByRole('button', { name: 'waveform view' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );

      fireEvent.click(screen.getByRole('button', { name: 'spectral view' }));
      expect(useAppStore.getState().view).toBe('spectral');
      expect(screen.getByRole('button', { name: 'spectral view' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(screen.getByRole('button', { name: 'waveform view' })).toHaveAttribute(
        'aria-pressed',
        'false'
      );
    });
  });

  describe('zoom cluster (drives the editor zoom the wheel gesture uses)', () => {
    it('zoom in halves nothing magic — it divides samplesPerPixel by the wheel factor', () => {
      const doc = makeDoc();
      useAppStore.getState().addDocument(doc);
      const spp0 = useAppStore.getState().zoom.samplesPerPixel;
      render(<Toolbar />);

      fireEvent.click(screen.getByRole('button', { name: 'Zoom In' }));
      const spp1 = useAppStore.getState().zoom.samplesPerPixel;
      expect(spp1).toBeLessThan(spp0);
      expect(spp1).toBeCloseTo(spp0 / 1.25, 6);

      fireEvent.click(screen.getByRole('button', { name: 'Zoom Out' }));
      expect(useAppStore.getState().zoom.samplesPerPixel).toBeCloseTo(spp0, 6);
    });

    it('Fit restores the document default zoom (the 100% state)', () => {
      const doc = makeDoc();
      useAppStore.getState().addDocument(doc);
      useAppStore.getState().setZoom({ samplesPerPixel: 1, scrollSample: 500 });
      render(<Toolbar />);

      fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
      expect(useAppStore.getState().zoom).toEqual(defaultZoom(doc));
      expect(screen.getByTestId('zoom-readout')).toHaveTextContent('100%');
    });

    it('the % readout tracks the store zoom', () => {
      const doc = makeDoc();
      useAppStore.getState().addDocument(doc);
      render(<Toolbar />);
      expect(screen.getByTestId('zoom-readout')).toHaveTextContent('100%');

      const base = defaultZoom(doc).samplesPerPixel;
      act(() =>
        useAppStore.getState().setZoom({ samplesPerPixel: base * 2, scrollSample: 0 })
      );
      expect(screen.getByTestId('zoom-readout')).toHaveTextContent('50%');
    });
  });
});

describe('Toolbar — G3 file chip (top-left)', () => {
  beforeEach(() => {
    useAppStore.setState(makeInitialState());
  });

  it('shows "no document" when nothing is open', () => {
    render(<Toolbar />);
    expect(screen.getByTestId('file-chip')).toHaveTextContent('no document');
  });

  it('shows name · duration · rate · channels · zoom % live from the store', () => {
    const doc = makeDoc();
    useAppStore.getState().addDocument(doc);
    render(<Toolbar />);
    const chip = screen.getByTestId('file-chip');
    expect(chip).toHaveTextContent('clip.wav');
    expect(chip).toHaveTextContent(formatTime(docLength(doc), doc.sampleRate));
    expect(chip).toHaveTextContent('44.1 kHz');
    expect(chip).toHaveTextContent('stereo');
    expect(chip).toHaveTextContent('100%');
  });

  it('the chip zoom % follows setZoom', () => {
    const doc = makeDoc();
    useAppStore.getState().addDocument(doc);
    render(<Toolbar />);
    const base = defaultZoom(doc).samplesPerPixel;
    act(() => useAppStore.getState().setZoom({ samplesPerPixel: base * 4, scrollSample: 0 }));
    expect(screen.getByTestId('file-chip')).toHaveTextContent('25%');
  });

  it('labels mono documents "mono"', () => {
    useAppStore
      .getState()
      .addDocument(
        createDocument({ name: 'm.wav', sampleRate: 48000, channels: [new Float32Array(1024)] })
      );
    render(<Toolbar />);
    expect(screen.getByTestId('file-chip')).toHaveTextContent('mono');
    expect(screen.getByTestId('file-chip')).toHaveTextContent('48.0 kHz');
  });
});

describe('Toolbar — the snap magnet (Task B4)', () => {
  beforeEach(() => {
    useAppStore.setState(makeInitialState());
    _resetSnapPreference();
  });
  afterEach(() => _resetSnapPreference());

  it('renders a magnet toggle that is enabled with NO document open', () => {
    render(<Toolbar />);
    const btn = screen.getByRole('button', { name: 'Snap to Grid' });
    expect(btn).toBeInTheDocument();
    // A preference, not a document action: the multitrack works with no open
    // document and snapping governs its clip drag/trim too.
    expect(btn).toBeEnabled();
  });

  it('clicking it flips the preference, and the title carries the escape hatch', () => {
    render(<Toolbar />);
    const btn = screen.getByRole('button', { name: 'Snap to Grid' });
    expect(isSnapEnabled()).toBe(true);
    expect(btn).toHaveAttribute('title', expect.stringContaining('Alt'));

    fireEvent.click(btn);
    expect(isSnapEnabled()).toBe(false);
    expect(screen.getByRole('button', { name: 'Snap to Grid' })).toHaveAttribute(
      'title',
      'Snap to Grid: off'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Snap to Grid' }));
    expect(isSnapEnabled()).toBe(true);
  });

  it('shows the accent tile only while snapping is on', () => {
    render(<Toolbar />);
    const on = screen.getByRole('button', { name: 'Snap to Grid' });
    expect(on.style.color).toBe('var(--accent)');

    act(() => {
      setSnapEnabled(false);
    });
    const off = screen.getByRole('button', { name: 'Snap to Grid' });
    expect(off.style.color).not.toBe('var(--accent)');
  });

  it('re-renders when the preference is flipped from outside the toolbar', () => {
    render(<Toolbar />);
    act(() => {
      setSnapEnabled(false);
    });
    expect(screen.getByRole('button', { name: 'Snap to Grid' })).toHaveAttribute(
      'title',
      'Snap to Grid: off'
    );
  });
});
