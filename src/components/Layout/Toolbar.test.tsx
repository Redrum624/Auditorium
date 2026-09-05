import { useRef, type RefObject } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import Toolbar from './Toolbar';
import { useMultitrackZoom } from '../Multitrack/useMultitrackZoom';
import { createDocument, docLength, type AudioDocument } from '../../audio/AudioDocument';
import { playbackEngine } from '../../audio/PlaybackEngine';
import { useAppStore, makeInitialState, defaultZoom, applyEditorZoom } from '../../stores/appStore';
import { anchoredZoom } from '../../services/zoomAnchor';
import { useSessionStore } from '../../multitrack/sessionStore';
import { _resetSessionUndo } from '../../multitrack/sessionUndo';
import { createClip, createTrack, type Session } from '../../multitrack/session';
import { setSessionLaneWidth } from '../../multitrack/sessionViewport';
import {
  FALLBACK_EDITOR_LANE_WIDTH,
  _resetEditorLaneWidth,
} from '../../services/editorViewport';
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

/** D1: a document long enough to be scrolled INTO, so "the bar is off screen"
 * is a state the store can actually hold. `makeDoc`'s 4096 samples fit the lane
 * whole at every zoom, which makes every scroll clamp to 0 and every cursor on
 * screen — a fixture that cannot express the case under test. */
function makeLongDoc(): AudioDocument {
  const ch = new Float32Array(2_000_000);
  for (let i = 0; i < ch.length; i += 512) ch[i] = 0.25;
  return createDocument({ name: 'long.wav', sampleRate: 44100, channels: [ch] });
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
    openPodcastChainDialog: () => {},
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
    // Lot A: the Save / Export pills read the PROJECT (session store + history
    // + path), which is module-global — start every test from an empty,
    // never-written, clean project.
    useSessionStore.getState().newSession(44100);
    useSessionStore.getState().setProjectPath(null);
    _resetSessionUndo();
    registerSetters();
  });

  /** A clip on track 0 — a session edit that changes NO appStore state. */
  function addClipToTrack0(docId = 'doc-elsewhere') {
    const trackId = useSessionStore.getState().session.tracks[0].id;
    useSessionStore
      .getState()
      .addClip(trackId, createClip({ documentId: docId, startSample: 0, offsetSample: 0, lengthSample: 10 }));
  }

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

  it('greys the Save pill for a SAVED project whose document has nothing to save, and lights it for a never-written one (O1-2 lifted to the project — lot A)', () => {
    // The pill has to state the same condition as the `file.save` command it
    // runs; a lit control that runCommand then refuses is a lie about what a
    // click will do. Under M4 that command saves the PROJECT: a clean document
    // in a project that has a file is nothing to save; the same document in a
    // project that has never been written IS (the file does not exist yet).
    const doc = createDocument({
      name: 'song.wav',
      sampleRate: 44100,
      channels: [new Float32Array(1000)],
      filePath: 'D:\\audio\\song.wav',
      neverSaved: false,
    });
    useAppStore.getState().addDocument(doc);
    useSessionStore.getState().setProjectPath('D:\\p.audm');

    const { rerender } = render(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    // Export and Close-adjacent controls are untouched by the gate.
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();

    useAppStore.getState().updateDocument({ ...doc, dirty: true });
    rerender(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    // Never-written project, clean document: content exists and no file does.
    useAppStore.getState().updateDocument({ ...doc, dirty: false });
    act(() => useSessionStore.getState().setProjectPath(null));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('lights the Save pill after a session edit that changes no appStore state (history version — lot A)', () => {
    useSessionStore.getState().setProjectPath('D:\\p.audm');
    render(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    act(() => addClipToTrack0());

    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('titles the Save pill "Save Project (Ctrl+S)" (lot A)', () => {
    render(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('title', 'Save Project (Ctrl+S)');
    expect(screen.getByRole('button', { name: 'Export' })).toHaveAttribute('title', 'Export (Ctrl+E)');
  });

  it('the Export pill follows the session in the multitrack view: enabled with clips and no document, disabled with no clips (lot A, M5)', () => {
    useAppStore.setState({ view: 'multitrack' });
    render(<Toolbar />);
    expect(useAppStore.getState().documents).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();

    act(() => addClipToTrack0());
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();

    act(() => useSessionStore.getState().newSession(44100));
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
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
    // Lot A: Save is the PROJECT's gate now, so the project has a file too —
    // otherwise "content exists, never written" would light Save and the
    // assertion at the end would measure M4 instead of document presence.
    useSessionStore.getState().setProjectPath('D:\p.audm');
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

    // Lot E (item 4, N14): the segment's editor arms go through
    // `showEditorView`, so a click out of the multitrack with a clip selected
    // carries that clip's source span; the multitrack arm stays the raw setter.
    it('leaving multitrack with a clip selected opens that clip’s source span', () => {
      const A = makeDoc();
      const B = createDocument({
        name: 'other.wav',
        sampleRate: 44100,
        channels: [new Float32Array(10000)],
      });
      useAppStore.getState().addDocument(A);
      useAppStore.getState().addDocument(B);
      useAppStore.getState().setActiveDocument(A.id);
      const clip = createClip({ documentId: B.id, startSample: 0, offsetSample: 2000, lengthSample: 3000 });
      const track = createTrack('Track 1');
      track.clips = [clip];
      const session: Session = { name: 'Carry', sampleRate: 44100, tracks: [track] };
      useSessionStore.setState({
        session,
        selectedClipId: clip.id,
        selectedClipIds: [clip.id],
        mtCursorSample: 0,
        mtPlayState: 'stopped',
        mtPlayheadSample: 0,
        mtEnvelope: null,
      });
      useAppStore.setState({ view: 'multitrack' });
      render(<Toolbar />);

      fireEvent.click(screen.getByRole('button', { name: 'waveform view' }));

      const s = useAppStore.getState();
      expect(s.activeDocumentId).toBe(B.id);
      expect(s.selection).toEqual({ start: 2000, end: 5000 });
      expect(s.view).toBe('waveform');
      expect(screen.getByRole('button', { name: 'waveform view' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    });

    it('entering multitrack is the raw setter: the document selection survives', () => {
      useAppStore.getState().addDocument(makeDoc());
      useAppStore.getState().setSelection({ start: 10, end: 20 });
      expect(useAppStore.getState().view).toBe('waveform');
      render(<Toolbar />);

      fireEvent.click(screen.getByRole('button', { name: 'multitrack view' }));

      expect(useAppStore.getState().view).toBe('multitrack');
      expect(useAppStore.getState().selection).toEqual({ start: 10, end: 20 });
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

    // D1 — the buttons already anchored on the bar; what is new is the second
    // half of the rule, for a bar the current window does not contain.
    it('D1: − / + centre a cursor that is off screen', () => {
      _resetEditorLaneWidth(); // nothing here mounts a lane, so the fallback applies
      const doc = makeLongDoc();
      useAppStore.getState().addDocument(doc);
      // A window well inside a long document, with the bar 200 px to the LEFT
      // of it. Holding the bar's negative x would zoom toward something the
      // user cannot see.
      act(() =>
        useAppStore.getState().setZoom({ samplesPerPixel: 200, scrollSample: 500_000 })
      );
      act(() => useAppStore.getState().setCursor(500_000 - 200 * 200));
      render(<Toolbar />);

      fireEvent.click(screen.getByRole('button', { name: 'Zoom In' }));

      const { samplesPerPixel, scrollSample } = useAppStore.getState().zoom;
      expect(samplesPerPixel).toBeCloseTo(200 / 1.25, 6);
      expect((460_000 - scrollSample) / samplesPerPixel).toBeCloseTo(
        FALLBACK_EDITOR_LANE_WIDTH / 2,
        3
      );
    });

    it('D1: − / + keep an on-screen cursor at its x', () => {
      _resetEditorLaneWidth();
      const doc = makeLongDoc();
      useAppStore.getState().addDocument(doc);
      act(() =>
        useAppStore.getState().setZoom({ samplesPerPixel: 200, scrollSample: 500_000 })
      );
      const cursor = 500_000 + 300 * 200; // x = 300, comfortably on screen
      act(() => useAppStore.getState().setCursor(cursor));
      render(<Toolbar />);

      fireEvent.click(screen.getByRole('button', { name: 'Zoom In' }));

      const { samplesPerPixel, scrollSample } = useAppStore.getState().zoom;
      expect((cursor - scrollSample) / samplesPerPixel).toBeCloseTo(300, 3);
    });

    /**
     * D1, review round 1 — the editor twin of the multitrack tail case.
     *
     * `zoomEditorBy` used to clamp its anchor to `docLength`; it uses the raw
     * bar now, so both controls name the same sample.
     *
     * HONEST LIMIT OF THIS PIN: unlike the multitrack twin, this one passes
     * with or without the clamp, and it is worth writing down why rather than
     * leaving a reader to assume it is load-bearing. A cursor past `docLength`
     * is necessarily off screen (`resolveZoom` never lets the window run past
     * the end), so both anchors take the centre arm, and the centred scroll —
     * `cursor − (lane/2)·spp` for any `cursor > docLength` — always exceeds
     * `maxScroll = docLength − lane·spp` and is clamped to it either way. The
     * store's own ceiling masks the difference. It is kept as a parity guard:
     * it fails if the two paths are ever made to differ in a way the ceiling
     * does NOT absorb.
     */
    it('D1: with the cursor past the document end, − / + and the wheel agree', () => {
      _resetEditorLaneWidth();
      const doc = makeLongDoc();
      useAppStore.getState().addDocument(doc);
      const past = docLength(doc) + 500_000;
      const start = { samplesPerPixel: 200, scrollSample: 1_000_000 };

      act(() => {
        useAppStore.getState().setCursor(past);
        useAppStore.getState().setZoom(start);
      });
      render(<Toolbar />);
      fireEvent.click(screen.getByRole('button', { name: 'Zoom In' }));
      const viaButton = useAppStore.getState().zoom;

      act(() => {
        useAppStore.getState().setCursor(past);
        useAppStore.getState().setZoom(start);
      });
      applyEditorZoom(
        anchoredZoom({
          zoom: start,
          laneWidth: FALLBACK_EDITOR_LANE_WIDTH,
          anchorSample: past,
          factor: 1 / 1.25,
        })
      );
      const viaWheelRule = useAppStore.getState().zoom;

      expect(viaButton).toEqual(viaWheelRule);
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
/**
 * D1 (review round 1) — the multitrack WHEEL, mounted next to the toolbar so
 * one test can compare what the two controls actually do to the store.
 *
 * A stable `useRef`, matching `MultitrackView`'s own lane ref: `createRef()` in
 * a render body mints a new object per render and would re-install the hook's
 * listener behind the test's back.
 */
function WheelLane() {
  const ref = useRef<HTMLDivElement | null>(null);
  useMultitrackZoom(ref as RefObject<HTMLElement | null>);
  return <div ref={ref} data-testid="wheel-lane" />;
}

/** One Ctrl+wheel notch toward the user — the zoom-IN half of the gesture, the
 * same direction the `+` button takes. No rect stub: the handler reads none. */
function ctrlWheelIn(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, ctrlKey: true })
    );
  });
}

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

  // D1 — the session twin of the editor's two cases above. Both surfaces obey
  // one rule now, so both have to be pinned: a bug that only ever reached one
  // of `zoomEditorBy` / `zoomSessionBy` is exactly the drift D1 removes.
  it('D1: − / + keep an on-screen multitrack cursor at its x', () => {
    seedSession();
    act(() =>
      useSessionStore.getState().setMtZoom({ samplesPerPixel: 200, scrollSample: 500_000 })
    );
    const cursor = 500_000 + 300 * 200; // x = 300
    act(() => useSessionStore.getState().setMtCursor(cursor));
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom In' }));

    const { mtZoom } = useSessionStore.getState();
    expect(mtZoom.samplesPerPixel).toBeCloseTo(200 / 1.25, 6);
    expect((cursor - mtZoom.scrollSample) / mtZoom.samplesPerPixel).toBeCloseTo(300, 3);
  });

  it('D1: − / + centre an off-screen multitrack cursor', () => {
    seedSession();
    act(() =>
      useSessionStore.getState().setMtZoom({ samplesPerPixel: 200, scrollSample: 500_000 })
    );
    const cursor = 500_000 - 200 * 200; // x = −200, off the left edge
    act(() => useSessionStore.getState().setMtCursor(cursor));
    render(<Toolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom In' }));

    const { mtZoom } = useSessionStore.getState();
    expect(mtZoom.samplesPerPixel).toBeCloseTo(200 / 1.25, 6);
    expect((cursor - mtZoom.scrollSample) / mtZoom.samplesPerPixel).toBeCloseTo(LANE / 2, 3);
  });

  /**
   * D1, review round 1 — THE TWO CONTROLS MUST LAND ON THE SAME ZOOM.
   *
   * The multitrack timeline is scrollable 60 s PAST the last clip
   * (`MT_TIMELINE_TAIL_SEC`) and `setMtCursor` does not clamp, so the bar can
   * legitimately sit in that tail. The wheel anchored on the raw
   * `mtCursorSample` while this button clamped its anchor to
   * `sessionTimelineLength` — one rule, two anchor VALUES, and the divergence
   * was invisible anywhere the bar sat over a clip.
   *
   * Asserted on the resolved store state rather than on the request, because
   * "same request" is not the claim — "same place on screen" is.
   */
  it('D1: with the bar in the 60 s tail, the wheel and + land on the SAME zoom', () => {
    seedSession();
    const bar = CLIP_LEN + 30 * 44100; // 30 s past the last clip
    // A start where the bar is ON screen, so the on-screen arm is the one under
    // test; the clamped anchor would have been off screen and centred instead.
    const start = { samplesPerPixel: 200, scrollSample: bar - 300 * 200 };

    act(() => {
      useSessionStore.getState().setMtCursor(bar);
      useSessionStore.getState().setMtZoom(start);
    });
    const toolbar = render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom In' }));
    const viaButton = useSessionStore.getState().mtZoom;
    toolbar.unmount();

    act(() => {
      useSessionStore.getState().setMtCursor(bar);
      useSessionStore.getState().setMtZoom(start);
    });
    const lane = render(<WheelLane />);
    ctrlWheelIn(lane.getByTestId('wheel-lane'));
    const viaWheel = useSessionStore.getState().mtZoom;
    lane.unmount();

    expect(viaWheel).toEqual(viaButton);
    // ...and both actually held the bar where it was, rather than agreeing on
    // some third thing (two broken controls agreeing is not the property).
    expect((bar - viaWheel.scrollSample) / viaWheel.samplesPerPixel).toBeCloseTo(300, 3);
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
