import { render, screen, fireEvent, act } from '@testing-library/react';
import Toolbar from './Toolbar';
import { createDocument, docLength, type AudioDocument } from '../../audio/AudioDocument';
import { playbackEngine } from '../../audio/PlaybackEngine';
import { useAppStore, makeInitialState, defaultZoom } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import { setSessionLaneWidth } from '../../multitrack/sessionViewport';
import { defaultSessionZoom } from '../../multitrack/sessionZoom';
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

/** A document that came off disk and has no unsaved work — the shape that
 * separates "there is an active document" from "there is something to save".
 * `makeDoc()` conflates the two: with no filePath it is never-saved, so it
 * always has unsaved work. */
function makeSavedDoc(): AudioDocument {
  return createDocument({
    name: 'clip.wav',
    sampleRate: 44100,
    channels: [new Float32Array(4096), new Float32Array(4096)],
    filePath: 'D:\\audio\\clip.wav',
    neverSaved: false,
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
    openTranscribeDialog: () => {},
    openVoiceChangerDialog: () => {},
    openAlignTimingDialog: () => {},
    openVocalChainDialog: () => {},
    openCoverChainDialog: () => {},
    openAlignLyricsDialog: () => {},
    focusRemixPanel: () => {},
    focusTranscriptPanel: () => {},
    focusSpatialPanel: () => {},
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

  it('greys the Save pill for a document with nothing to save (O1-2)', () => {
    // The pill has to state the same condition as the `file.save` command it
    // runs; a lit control that runCommand then refuses is a lie about what a
    // click will do.
    const doc = createDocument({
      name: 'song.wav',
      sampleRate: 44100,
      channels: [new Float32Array(1000)],
      filePath: 'D:\\audio\\song.wav',
      neverSaved: false,
    });
    useAppStore.getState().addDocument(doc);

    const { rerender } = render(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    // Export and Close-adjacent controls are untouched by the gate.
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();

    useAppStore.getState().updateDocument({ ...doc, dirty: true });
    rerender(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('separates Open from Save with a divider', () => {
    // The two pills sat 3 px apart with nothing between them: a click aimed at
    // Open that landed one pill to the right ran Save — a full re-encode and
    // overwrite of the file on disk. Save must not be Open's immediate
    // neighbour.
    render(<Toolbar />);
    const pill = screen.getByTestId('toolbar-pill');
    const children = Array.from(pill.children);
    const openIndex = children.indexOf(screen.getByRole('button', { name: 'Open' }));
    const saveIndex = children.indexOf(screen.getByRole('button', { name: 'Save' }));
    expect(openIndex).toBeGreaterThanOrEqual(0);
    expect(saveIndex).toBeGreaterThan(openIndex);

    const dividerBetween = children
      .slice(openIndex + 1, saveIndex)
      .some((el) => el.getAttribute('data-testid') === 'toolbar-divider');
    expect(dividerBetween).toBe(true);
  });

  it('Open is always enabled; Export/zoom need an active document', () => {
    // Seeded with a SAVED, clean document on purpose. `makeDoc()` has no
    // filePath, so it is never-saved and therefore always has unsaved work —
    // which since O1-2 is what enables Save. Using it here would let this test
    // pass while measuring "the document has unsaved work" instead of "there
    // is an active document", and the two stopped being the same condition.
    render(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Open' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Zoom In' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Zoom Out' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Fit' })).toBeDisabled();

    act(() => useAppStore.getState().addDocument(makeSavedDoc()));
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Zoom In' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Zoom Out' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Fit' })).toBeEnabled();
    // Save deliberately does NOT follow document presence — its own gate is
    // measured by "greys the Save pill for a document with nothing to save".
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
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

    // F11-9: Fit and the − button used to have unrelated ideas of "as far out
    // as this goes" — Fit restored `docLength / 1600` while − clamped at
    // `docLength / 50`, 32x further out, in the range where the waveform is
    // pinned by `getPeaksForRange` and only the tics and the ruler still move.
    // They share one limit now, so these three properties hold together.
    it('F11: the − button walks down to exactly the state Fit jumps to, and stops there', () => {
      const doc = makeDoc();
      useAppStore.getState().addDocument(doc);
      render(<Toolbar />);
      const out = screen.getByRole('button', { name: 'Zoom Out' });

      // Somewhere well inside the track, then all the way back out.
      act(() => useAppStore.getState().setZoom({ samplesPerPixel: 1, scrollSample: 0 }));
      for (let i = 0; i < 40; i++) fireEvent.click(out);

      expect(useAppStore.getState().zoom).toEqual(defaultZoom(doc));
      expect(screen.getByTestId('zoom-readout')).toHaveTextContent('100%');
    });

    it('F11: pressing − at the limit writes nothing at all', () => {
      const doc = makeDoc();
      useAppStore.getState().addDocument(doc); // opens fitted
      render(<Toolbar />);
      const before = useAppStore.getState().zoom;

      fireEvent.click(screen.getByRole('button', { name: 'Zoom Out' }));

      // The SAME object — no new snapshot, so the waveform, the beat tics and
      // the ruler are not even asked to repaint.
      expect(useAppStore.getState().zoom).toBe(before);
    });

    it('F11: Fit is idempotent and is the state a freshly opened document is already in', () => {
      const doc = makeDoc();
      useAppStore.getState().addDocument(doc);
      render(<Toolbar />);
      const onOpen = useAppStore.getState().zoom;

      fireEvent.click(screen.getByRole('button', { name: 'Fit' }));

      expect(useAppStore.getState().zoom).toBe(onOpen);
    });
  });
});

// U1 (layout E2, element 1): the G3 top-left file chip is retired — its
// identity readout moved into the status pill (StatusBar.test.tsx owns those
// assertions now) and its zoom % died with it, being a duplicate of this
// pill's own readout. What survives here is the CONTRACT that the toolbar no
// longer renders a second copy of either.
describe('Toolbar — the file chip is retired (U1)', () => {
  beforeEach(() => {
    useAppStore.setState(makeInitialState());
  });

  it('renders no file chip, with or without a document', () => {
    render(<Toolbar />);
    expect(screen.queryByTestId('file-chip')).not.toBeInTheDocument();

    act(() => useAppStore.getState().addDocument(makeDoc()));
    expect(screen.queryByTestId('file-chip')).not.toBeInTheDocument();
  });

  it('keeps the zoom % in the pill, the one place it is now shown', () => {
    const doc = makeDoc();
    useAppStore.getState().addDocument(doc);
    render(<Toolbar />);
    expect(screen.getAllByText(/^\d+%$/)).toHaveLength(1);
    expect(screen.getByTestId('zoom-readout')).toHaveTextContent('100%');

    const base = defaultZoom(doc).samplesPerPixel;
    act(() => useAppStore.getState().setZoom({ samplesPerPixel: base * 4, scrollSample: 0 }));
    expect(screen.getByTestId('zoom-readout')).toHaveTextContent('25%');
  });

  // F2: this used to pin `max(var(--stage-inset-right, 376px), 362px)`. That
  // clamp put the pill 174 px off the axis whenever the module card was closed
  // — measured in the built app — while the status and edit pills stayed on it,
  // and while four doc sentences claimed all three shared one axis. It was
  // guarding against an overlap that cannot happen at the pill's realised
  // width (860.5 px clears the strip by 7.4 px with the card closed), so the
  // padding is now the stage's own inset on BOTH sides: one axis, both states.
  it('centres the band on the WAVEFORM in both card states — no clamp to knock it off axis', () => {
    const { container } = render(<Toolbar />);
    const band = container.firstElementChild as HTMLElement;
    expect(band.className).toContain('justify-center');
    expect(band.style.paddingLeft).toBe('var(--stage-inset-left, 14px)');
    expect(band.style.paddingRight).toBe('var(--stage-inset-right, 376px)');
    // Named explicitly so re-introducing a clamp has to argue with this test
    // rather than slip past it: the padding mirrors the insets, nothing more.
    expect(band.style.paddingRight).not.toContain('max(');
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

// ---------------------------------------------------------------------------
// MT1-1 — the zoom cluster follows the ACTIVE VIEW
// ---------------------------------------------------------------------------
/*
 * The reported bug was "the tracks should appear Fit on the longest one", and
 * half of it lived here: the cluster drove `applyEditorZoom` unconditionally,
 * so in the multitrack view Fit fitted a DOCUMENT — one the user was not
 * looking at, or none at all, in which case the whole cluster was dead. There
 * was no control anywhere in the app that could fit the session.
 */
describe('MT1-1: the zoom cluster in the multitrack view', () => {
  const CLIP_LEN = 44100 * 178; // 2:58, the reported length
  const LANE = 1000;

  function seedSession(): void {
    setSessionLaneWidth(LANE);
    useSessionStore.getState().newSession(44100);
    const trackIds = useSessionStore.getState().session.tracks.map((t) => t.id);
    useSessionStore.getState().addClip(trackIds[0], {
      id: 'mt1-clip',
      documentId: 'doc-1',
      startSample: 0,
      offsetSample: 0,
      lengthSample: CLIP_LEN,
      gainDb: 0,
    });
    useAppStore.getState().setView('multitrack');
  }

  it('is live with NO document open, because the session is what it zooms', () => {
    seedSession();
    render(<Toolbar />);
    expect(useAppStore.getState().documents).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Fit' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Zoom In' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Zoom Out' })).toBeEnabled();
  });

  it('Fit fits the SESSION — the longest track across the measured lane', () => {
    seedSession();
    act(() => useSessionStore.getState().setMtZoom({ samplesPerPixel: 8, scrollSample: 900 }));
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));

    const { session, mtZoom } = useSessionStore.getState();
    expect(mtZoom).toEqual(defaultSessionZoom(session));
    expect(mtZoom.samplesPerPixel).toBeCloseTo(CLIP_LEN / LANE, 6);
    expect(mtZoom.scrollSample).toBe(0);
    expect(screen.getByTestId('zoom-readout')).toHaveTextContent('100%');
  });

  it('leaves the EDITOR zoom alone while the multitrack view is active', () => {
    const doc = makeDoc();
    act(() => useAppStore.getState().addDocument(doc));
    const before = useAppStore.getState().zoom;
    seedSession();
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom In' }));

    expect(useAppStore.getState().zoom).toEqual(before);
  });

  it('the − and + buttons move the session zoom by the factor, in the right direction', () => {
    // Mutation kill: the earlier cases only asserted that the editor zoom was
    // untouched and that Fit landed on the fit, so swapping `*` and `/` inside
    // `zoomSessionBy` — or dropping the factor entirely — survived. The OUTPUT
    // is asserted here: out is coarser, in is finer, and the pair round-trips.
    seedSession();
    act(() =>
      useSessionStore.getState().setMtZoom({ samplesPerPixel: CLIP_LEN / LANE / 4, scrollSample: 0 })
    );
    render(<Toolbar />);
    const spp0 = useSessionStore.getState().mtZoom.samplesPerPixel;

    fireEvent.click(screen.getByRole('button', { name: 'Zoom Out' }));
    const out = useSessionStore.getState().mtZoom.samplesPerPixel;
    expect(out).toBeGreaterThan(spp0);
    expect(out).toBeCloseTo(spp0 * 1.25, 6);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom In' }));
    const back = useSessionStore.getState().mtZoom.samplesPerPixel;
    expect(back).toBeCloseTo(spp0, 6);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom In' }));
    expect(useSessionStore.getState().mtZoom.samplesPerPixel).toBeCloseTo(spp0 / 1.25, 6);
  });

  it('the % readout reads the session, and 100% is its fit', () => {
    seedSession();
    render(<Toolbar />);
    expect(screen.getByTestId('zoom-readout')).toHaveTextContent('100%');

    // Twice as far IN as the fit reads 200% — the same law the editor's readout
    // states, so switching view never changes what a percentage means.
    act(() => {
      const { session } = useSessionStore.getState();
      useSessionStore.getState().setMtZoom({
        samplesPerPixel: defaultSessionZoom(session).samplesPerPixel / 2,
        scrollSample: 0,
      });
    });
    expect(screen.getByTestId('zoom-readout')).toHaveTextContent('200%');
  });
});
