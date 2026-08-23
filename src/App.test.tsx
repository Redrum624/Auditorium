import { act, render, screen, fireEvent, within } from '@testing-library/react';
import App from './App';
import { useAppStore, makeInitialState } from './stores/appStore';
import { createDocument } from './audio/AudioDocument';
import { playbackEngine } from './audio/PlaybackEngine';
import { multitrackPlayer } from './multitrack/MultitrackPlayer';
import { getInFlightSaveCount } from './services/fileService';
import { isProjectSaveInFlight } from './multitrack/sessionFile';
import { useSessionStore } from './multitrack/sessionStore';
import { _resetSessionUndo } from './multitrack/sessionUndo';
import { createClip } from './multitrack/session';
import { runCommand } from './services/menuActions';
import { getRemixSession } from './services/remixService';
import { focusTranscriptPanel } from './services/dialogBus';
// U2: the strip registry's own answers, so these tests assert the RULE (Files
// leads, History trails) rather than a second copy of today's roster.
import { DEFAULT_PANEL, stripTabs } from './components/Layout/ModuleStrip';

// Real fileService, except getInFlightSaveCount is swapped for a controllable
// mock so the close-guard reply tests below (Task M4/F7) can force it to a
// specific value without driving a real save through the encoder pipeline.
jest.mock('./services/fileService', () => ({
  ...jest.requireActual('./services/fileService'),
  getInFlightSaveCount: jest.fn(() => 0),
}));
const mockGetInFlightSaveCount = getInFlightSaveCount as jest.MockedFunction<
  typeof getInFlightSaveCount
>;

// Lot A: the project save's in-flight flag joins the busy count the same way.
jest.mock('./multitrack/sessionFile', () => ({
  ...jest.requireActual('./multitrack/sessionFile'),
  isProjectSaveInFlight: jest.fn(() => false),
}));
const mockIsProjectSaveInFlight = isProjectSaveInFlight as jest.MockedFunction<typeof isProjectSaveInFlight>;

// F11-8: the strip's Remix entry appears exactly while a remix DOCUMENT exists,
// which the app answers with `getRemixSession(docId) !== null` — remixService's
// own session map, the same question RemixPanel asks. Making a real session
// here would mean running the planner over real audio for a test about an icon,
// so the map's reader is the seam: everything else (which documents are open,
// when the entry appears and disappears) stays real.
jest.mock('./services/remixService', () => ({
  ...jest.requireActual('./services/remixService'),
  getRemixSession: jest.fn(() => null),
}));
const mockGetRemixSession = getRemixSession as jest.MockedFunction<typeof getRemixSession>;

/** Marks `docId` as carrying a remix session, as remixService would. */
function haveRemixSessionFor(docIds: string[]) {
  const ids = new Set(docIds);
  mockGetRemixSession.mockImplementation((id) =>
    ids.has(id) ? ({ remixDocId: id } as never) : null
  );
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  // Lot A: the close guard counts the PROJECT (session store + history +
  // path), which is module-global — every test starts from an empty,
  // never-written, clean project.
  useSessionStore.getState().newSession(44100);
  useSessionStore.getState().setProjectPath(null);
  _resetSessionUndo();
  delete (window as { electronAPI?: unknown }).electronAPI;
  mockGetInFlightSaveCount.mockReturnValue(0);
  mockIsProjectSaveInFlight.mockReturnValue(false);
  mockGetRemixSession.mockReset();
  mockGetRemixSession.mockReturnValue(null);
});

describe('App', () => {
  it('renders the app root', () => {
    render(<App />);
    expect(screen.getByTestId('app-root')).toBeInTheDocument();
  });

  it('shows the "open or create" hint when no document is open', () => {
    render(<App />);
    expect(screen.getByText(/open an audio file \(ctrl\+o\)/i)).toBeInTheDocument();
    expect(screen.getByText(/create a new one \(ctrl\+n\)/i)).toBeInTheDocument();
  });

  it('mounts the G3 chrome exactly once: toolbar pill, file chip, status pill, and each moved testid', () => {
    render(<App />);
    // The bottom TransportBar is retired; its controls live in the top pill and
    // its readouts in the status pill. Every moved testid resolves exactly once.
    expect(screen.getAllByTestId('toolbar-pill')).toHaveLength(1);
    expect(screen.getAllByTestId('file-chip')).toHaveLength(1);
    expect(screen.getAllByTestId('status-pill')).toHaveLength(1);
    expect(screen.getAllByTestId('view-toggle')).toHaveLength(1);
    expect(screen.getAllByTestId('transport-time')).toHaveLength(1);
    expect(screen.getAllByTestId('level-meter')).toHaveLength(1);
  });
});

describe('native close guard renderer side (Task F8)', () => {
  function installCloseApi() {
    let requestCb: (() => void) | null = null;
    const unsubscribe = jest.fn();
    const respondCloseRequest = jest.fn();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      onCloseRequested: (cb: () => void) => {
        requestCb = cb;
        return unsubscribe;
      },
      respondCloseRequest,
      onWindowMaximized: () => () => {}, // TitleBar mounts inside <App />
    };
    return { fireCloseRequest: () => requestCb?.(), respondCloseRequest, unsubscribe };
  }

  /** A document that HAS a file on disk (`neverSaved: false`), dirty or not —
   * so these counting tests isolate the dirty half of the reply. The
   * never-saved half has its own tests below (Task S4). */
  function addDoc(dirty: boolean) {
    const doc = createDocument({
      name: dirty ? 'dirty.wav' : 'clean.wav',
      sampleRate: 44100,
      channels: [new Float32Array(4)],
      filePath: dirty ? 'D:\\dirty.wav' : 'D:\\clean.wav',
    });
    useAppStore.getState().addDocument(doc);
    if (dirty) useAppStore.getState().updateDocument({ ...doc, dirty: true });
  }

  /** A computed document that has never been on disk (Mix Down, Remix N, a
   * recording, a stem) — clean, but its audio exists nowhere else. */
  function addNeverSavedDoc(name = 'Remix 1') {
    const doc = createDocument({ name, sampleRate: 44100, channels: [new Float32Array(4)] });
    useAppStore.getState().addDocument(doc);
    return doc;
  }

  it('responds to a close request with the current dirty-document count', () => {
    const api = installCloseApi();
    addDoc(true);
    addDoc(false);
    addDoc(true);

    render(<App />);
    act(() => api.fireCloseRequest());

    expect(api.respondCloseRequest).toHaveBeenCalledWith(2, 0);
  });

  it('responds 0 when nothing is dirty (a SAVED project with a clean document — lot A)', () => {
    const api = installCloseApi();
    addDoc(false);
    useSessionStore.getState().setProjectPath('D:\\p.audm');

    render(<App />);
    act(() => api.fireCloseRequest());

    expect(api.respondCloseRequest).toHaveBeenCalledWith(0, 0);
  });

  it('responds 0 for an empty untitled project (N12 — lot A)', () => {
    const api = installCloseApi();

    render(<App />);
    act(() => api.fireCloseRequest());

    expect(api.respondCloseRequest).toHaveBeenCalledWith(0, 0);
  });

  it('counts a clean document in a NEVER-WRITTEN project as 1 — the file it would be saved into does not exist (M4 — lot A)', () => {
    const api = installCloseApi();
    addDoc(false);
    expect(useSessionStore.getState().projectPath).toBeNull();

    render(<App />);
    act(() => api.fireCloseRequest());

    expect(api.respondCloseRequest).toHaveBeenCalledWith(1, 0);
  });

  it('counts a dirty session with clips and no documents as 1 (lot A)', () => {
    const api = installCloseApi();
    useSessionStore.getState().setProjectPath('D:\\p.audm');
    const trackId = useSessionStore.getState().session.tracks[0].id;
    useSessionStore
      .getState()
      .addClip(trackId, createClip({ documentId: 'doc-gone', startSample: 0, offsetSample: 0, lengthSample: 10 }));

    render(<App />);
    act(() => api.fireCloseRequest());

    expect(api.respondCloseRequest).toHaveBeenCalledWith(1, 0);
  });

  it('counts a dirty document PLUS a dirty session as 2 (lot A)', () => {
    const api = installCloseApi();
    useSessionStore.getState().setProjectPath('D:\\p.audm');
    addDoc(true);
    useSessionStore.getState().addTrack();

    render(<App />);
    act(() => api.fireCloseRequest());

    expect(api.respondCloseRequest).toHaveBeenCalledWith(2, 0);
  });

  it('reports an in-flight PROJECT save in the busy count (lot A)', () => {
    const api = installCloseApi();
    addDoc(false);
    useSessionStore.getState().setProjectPath('D:\\p.audm');
    mockIsProjectSaveInFlight.mockReturnValue(true);

    render(<App />);
    act(() => api.fireCloseRequest());

    expect(api.respondCloseRequest).toHaveBeenCalledWith(0, 1);
  });

  it('reads the dirty count at request time, not mount time', () => {
    const api = installCloseApi();
    addDoc(false);
    render(<App />);

    act(() => {
      const doc = useAppStore.getState().documents[0];
      useAppStore.getState().updateDocument({ ...doc, dirty: true });
    });
    act(() => api.fireCloseRequest());

    expect(api.respondCloseRequest).toHaveBeenCalledWith(1, 0);
  });

  it('also reports a nonzero in-flight-save count alongside the dirty count (Task M4/F7)', () => {
    const api = installCloseApi();
    addDoc(false); // nothing dirty ...
    useSessionStore.getState().setProjectPath('D:\\p.audm'); // ... in a saved project (lot A) ...
    mockGetInFlightSaveCount.mockReturnValue(1); // ... but a save is mid-flight

    render(<App />);
    act(() => api.fireCloseRequest());

    expect(api.respondCloseRequest).toHaveBeenCalledWith(0, 1);
  });

  it('counts a CLEAN never-saved document (Task S4) — quitting would otherwise discard it silently', () => {
    const api = installCloseApi();
    addNeverSavedDoc(); // clean, but has never been on disk
    addDoc(false); // clean AND on disk — must not be counted

    render(<App />);
    act(() => api.fireCloseRequest());

    expect(api.respondCloseRequest).toHaveBeenCalledWith(1, 0);
  });

  it('counts a never-saved document exactly once even after it is edited (dirty && neverSaved is still one file)', () => {
    const api = installCloseApi();
    const doc = addNeverSavedDoc();
    useAppStore.getState().updateDocument({ ...doc, dirty: true });

    render(<App />);
    act(() => api.fireCloseRequest());

    expect(api.respondCloseRequest).toHaveBeenCalledWith(1, 0);
  });

  it('still counts a never-saved document after an edit is undone past the creation point (Task S4 — the derived-dirty trap)', () => {
    const api = installCloseApi();
    const doc = addNeverSavedDoc();
    // Simulate what undoHistory does on undo: it re-derives dirty and rewrites
    // the doc, which would have erased any dirty stamped at creation.
    useAppStore.getState().updateDocument({ ...doc, dirty: false });

    render(<App />);
    act(() => api.fireCloseRequest());

    expect(api.respondCloseRequest).toHaveBeenCalledWith(1, 0);
  });

  it('unsubscribes on unmount', () => {
    const api = installCloseApi();
    const { unmount } = render(<App />);
    unmount();
    expect(api.unsubscribe).toHaveBeenCalled();
  });

  it('no longer installs the legacy beforeunload guard when documents are dirty', () => {
    const addSpy = jest.spyOn(window, 'addEventListener');
    addDoc(true);
    render(<App />);
    const beforeUnloadCalls = addSpy.mock.calls.filter(([type]) => type === 'beforeunload');
    expect(beforeUnloadCalls).toHaveLength(0);
    addSpy.mockRestore();
  });
});

/** A source document plus the computed 'Remix 1' made from it, with the SOURCE
 * left active. Two documents rather than one because the remix document is the
 * one carrying the (mocked) session: leaving it active would hand RemixPanel a
 * session object this test has no business building, and sitting on the source
 * with a remix open elsewhere is the ordinary case anyway. */
function addRemixDocument() {
  const source = createDocument({
    name: 'source.wav',
    sampleRate: 44100,
    channels: [new Float32Array(1024)],
  });
  const remix = createDocument({
    name: 'Remix 1',
    sampleRate: 44100,
    channels: [new Float32Array(1024)],
  });
  useAppStore.getState().addDocument(source);
  useAppStore.getState().addDocument(remix);
  useAppStore.getState().setActiveDocument(source.id);
  haveRemixSessionFor([remix.id]);
  return { source, remix };
}

describe('right sidebar tabs (Task 23)', () => {
  // U2: "make 'Files' default at opening" — and the assertion reads
  // `DEFAULT_PANEL` rather than the string, so App and the strip cannot come
  // to disagree about which card the app opens with. `ModuleStrip.test` is
  // where DEFAULT_PANEL is pinned to the strip's own first entry.
  it('defaults to the Files card, the strip registry’s lead entry', () => {
    render(<App />);
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute(
      'data-active-tab',
      DEFAULT_PANEL
    );
    expect(DEFAULT_PANEL).toBe('files');
  });

  // U2: nothing in the app persists panel state — `sidebarTab` is plain
  // component state with no storage read behind it, and the store's
  // `documents`/`view` are the only things restored across a session — so the
  // rule is simply "first paint opens Files", with nothing to fight. This
  // pins that: a remount is a first paint, and it opens Files again even
  // after another card was deliberately opened in the previous mount.
  it('opens Files on every first paint — no panel state is persisted', () => {
    const first = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Markers' }));
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'markers');
    first.unmount();

    render(<App />);
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'files');
  });

  it('switches to Markers and Properties on tab click', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Markers' }));
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'markers');

    fireEvent.click(screen.getByRole('button', { name: 'Properties' }));
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'properties');

    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'history');
  });

  // F11-8 rewrote this pair. T15's Remix tab was permanent; the user ruled that
  // "Remix should only appear when a remix is created", so the entry is
  // contextual now. What T15 pinned — the entry switches the card to a mounted
  // RemixPanel — is unchanged and still pinned, from the state that offers it.
  it('offers NO Remix entry until a remix document exists', () => {
    render(<App />);
    expect(
      within(screen.getByTestId('sidebar-tabs')).queryByRole('button', { name: 'Remix' })
    ).toBeNull();
  });

  it('offers the Remix entry once a remix document exists, and switches to it on click (Task T15)', () => {
    render(<App />);
    act(() => {
      addRemixDocument();
    });

    const tabs = screen.getByTestId('sidebar-tabs');
    fireEvent.click(within(tabs).getByRole('button', { name: 'Remix' }));
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'remix');
    // The panel body is mounted, not just the tab state.
    expect(screen.getByText(/no remix for this document/i)).toBeInTheDocument();
  });

  it('takes the Remix entry away again when the last remix document closes', () => {
    render(<App />);
    let remixId = '';
    act(() => {
      remixId = addRemixDocument().remix.id;
    });
    const tabs = screen.getByTestId('sidebar-tabs');
    expect(within(tabs).getByRole('button', { name: 'Remix' })).toBeInTheDocument();

    act(() => useAppStore.getState().closeDocument(remixId));
    expect(within(tabs).queryByRole('button', { name: 'Remix' })).toBeNull();
  });

  // The awkward state the contextual entry creates, decided rather than left to
  // chance: the card is showing Remix when the last remix document closes. It
  // CLOSES. Leaving it open would strand a card whose only close affordance —
  // its own strip entry — has just been taken away, and a closed card hands the
  // module column's width back to the waveform, which is E2's own rule for what
  // an empty column is worth.
  it('closes the card when the open Remix card outlives its last remix document', () => {
    render(<App />);
    let remixId = '';
    act(() => {
      remixId = addRemixDocument().remix.id;
    });
    fireEvent.click(
      within(screen.getByTestId('sidebar-tabs')).getByRole('button', { name: 'Remix' })
    );
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'remix');

    act(() => useAppStore.getState().closeDocument(remixId));

    expect(screen.queryByTestId('sidebar-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('editor-stage').style.getPropertyValue('--stage-inset-right')).toBe(
      '14px'
    );
  });
});

describe('G4 module column, U1 module strip (the rail rotated horizontal)', () => {
  // F11-8: five permanent entries, not eight. Remix is contextual (its own
  // tests above), and Spatial and Transcript left the strip altogether — the
  // user ruled them single tools rather than modules, so they are reached by
  // command and the strip never draws an icon for either.
  // U2: six permanents (Pipeline joined), and the expectation is the registry's
  // own roster rather than a restated array — App draws what `stripTabs` says,
  // so a test that restates the list only pins that someone typed it twice.
  it('mounts the strip exactly once, carrying the permanent entries and nothing else', () => {
    render(<App />);
    const rails = screen.getAllByTestId('sidebar-tabs');
    expect(rails).toHaveLength(1);
    const drawn = within(rails[0])
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    expect(drawn).toEqual(stripTabs(false).map((t) => t.label));
    // …and the two rules the user stated, at the surface they are about.
    expect(drawn[0]).toBe('Files');
    expect(drawn[drawn.length - 1]).toBe('History');
    expect(drawn).toContain('Pipeline');
  });

  it('never draws a Spatial or Transcript entry, even with a remix in play', () => {
    render(<App />);
    act(() => {
      addRemixDocument();
    });
    const strip = screen.getByTestId('sidebar-tabs');
    expect(within(strip).queryByRole('button', { name: 'Spatial' })).toBeNull();
    expect(within(strip).queryByRole('button', { name: 'Transcript' })).toBeNull();
  });

  // The two single tools still reach the SAME card, and the card still names
  // them: the panel registry is wider than the strip's roster, which is the
  // whole point of the split.
  it('shows the Transcript surface in the card when the Transcribe tool asks for it', () => {
    render(<App />);
    act(() => focusTranscriptPanel());
    const panel = screen.getByTestId('sidebar-panel');
    expect(panel).toHaveAttribute('data-active-tab', 'transcript');
    expect(within(panel).getByText('Transcript')).toBeInTheDocument();
    expect(screen.getByText('No document open.')).toBeInTheDocument();
  });

  // With no strip icon, a Spatial or Transcript card had no way to close: the
  // strip's own entry was the only affordance, and these panels have none. The
  // card header carries one now, for every panel — one rule, no branch.
  it('closes the card from its own header, including a panel the strip has no icon for', async () => {
    render(<App />);
    await act(async () => {
      await runCommand('spatial.position');
    });
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'spatial');

    fireEvent.click(screen.getByRole('button', { name: /close the spatial panel/i }));

    expect(screen.queryByTestId('sidebar-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('editor-stage').style.getPropertyValue('--stage-inset-right')).toBe(
      '14px'
    );
  });

  // U1 (layout E2): the strip's active entry closes its card, and a closed
  // card is what hands the module column's width back to the waveform. Both
  // halves are asserted here — the card really unmounts, and the stage's
  // right inset really collapses — because the second is the whole point of
  // the first.
  it('closes the panel card when the active strip entry is clicked, and reopens it', () => {
    render(<App />);
    const strip = screen.getByTestId('sidebar-tabs');
    // U2: the app opens on Files now, so Files is the ACTIVE entry this
    // exercises. The behaviour under test is unchanged.
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'files');

    fireEvent.click(within(strip).getByRole('button', { name: 'Files' }));
    expect(screen.queryByTestId('sidebar-panel')).not.toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: 'Files' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    fireEvent.click(within(strip).getByRole('button', { name: 'Files' }));
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'files');
  });

  it('gives the stage the module column width when no card is open', () => {
    render(<App />);
    const stage = screen.getByTestId('editor-stage');
    // 14 margin + 348 column + 14 air, published as a token every floating
    // surface centres on.
    expect(stage.style.getPropertyValue('--stage-inset-right')).toBe('376px');
    expect(stage.style.getPropertyValue('--stage-inset-left')).toBe('14px');

    // U2: Files is the open card at first paint, so Files is what closes it.
    fireEvent.click(within(screen.getByTestId('sidebar-tabs')).getByRole('button', { name: 'Files' }));
    expect(stage.style.getPropertyValue('--stage-inset-right')).toBe('14px');
  });

  it('shows exactly one panel card at a time: only the selected body is mounted', () => {
    render(<App />);
    // U2: the app opens on Files, so the Files body IS mounted at first paint
    // and the Effects browser is NOT — the one-card rule read from the other
    // end. (Before U2 the default was History and neither was mounted.)
    expect(screen.getByText(/no files open/i)).toBeInTheDocument();
    expect(screen.queryByTestId('effects-list')).not.toBeInTheDocument();

    const rail = screen.getByTestId('sidebar-tabs');
    fireEvent.click(within(rail).getByRole('button', { name: 'Effects' }));
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'effects');
    expect(screen.getByTestId('effects-list')).toBeInTheDocument();
    expect(screen.queryByText(/no files open/i)).not.toBeInTheDocument();

    fireEvent.click(within(rail).getByRole('button', { name: 'Files' }));
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'files');
    expect(screen.getByText(/no files open/i)).toBeInTheDocument();
    expect(screen.queryByTestId('effects-list')).not.toBeInTheDocument();
  });

  it('an effect row in the Effects card is disabled without a document', () => {
    render(<App />);
    const rail = screen.getByTestId('sidebar-tabs');
    fireEvent.click(within(rail).getByRole('button', { name: 'Effects' }));
    // Without a document every effect row is disabled — the same enablement
    // the old left-column browser had.
    const items = screen.getAllByTestId('effects-item');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(within(item).getByRole('button')).toBeDisabled();
    }
  });

  it('marks the active strip entry with the accent tile class', () => {
    render(<App />);
    const rail = screen.getByTestId('sidebar-tabs');
    // U2: Files is the card the app opens with, so Files carries the tile.
    expect(within(rail).getByRole('button', { name: 'Files' })).toHaveClass('is-active');

    fireEvent.click(within(rail).getByRole('button', { name: 'Markers' }));
    expect(within(rail).getByRole('button', { name: 'Markers' })).toHaveClass('is-active');
    expect(within(rail).getByRole('button', { name: 'Files' })).not.toHaveClass('is-active');
  });

  // F11-8: 'Spatial' is a single tool, not a module (user ruling), so the
  // Mix command is the door it is reached through (Effects > Mix since T8,
  // Pipeline > Mix before it). The card it lands
  // in is the SAME card the strip drives — one card, two kinds of door.
  it('shows the Spatial positioner in the module card when the Mix tool runs', async () => {
    render(<App />);
    await act(async () => {
      await runCommand('spatial.position');
    });
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'spatial');
    expect(screen.getByTestId('spatial-panel')).toBeInTheDocument();
  });

  it('does not render the tempo card when no analysis exists (and never starts one)', () => {
    render(<App />);
    expect(screen.queryByTestId('tempo-card')).not.toBeInTheDocument();
  });
});

describe('G6: the canvas is the stage; the chrome floats over it', () => {
  it('renders the editor stage with the radial canvas background', () => {
    render(<App />);
    const stage = screen.getByTestId('editor-stage');
    expect(stage.style.backgroundImage).toBe('var(--canvas-bg)');
    expect(stage.className).toContain('relative');
  });

  it('floats the toolbar band, status band, card column and rail as absolute z-20 overlays inside the stage (dialogs sit above at z-40)', () => {
    render(<App />);
    const stage = screen.getByTestId('editor-stage');
    // Walk each floating surface up to its stage-level band and pin the
    // overlay contract: absolutely positioned, chrome z-layer 20 — below
    // DialogShell's fixed z-40 overlay, above the in-flow editor lanes.
    const bandOf = (el: HTMLElement): HTMLElement => {
      let node: HTMLElement = el;
      while (node.parentElement && node.parentElement !== stage) {
        node = node.parentElement;
      }
      return node;
    };
    for (const id of ['toolbar-pill', 'status-pill', 'sidebar-tabs', 'sidebar-panel']) {
      const band = bandOf(screen.getByTestId(id));
      expect(band.parentElement).toBe(stage);
      expect(band.className).toContain('absolute');
      expect(band.className).toContain('z-20');
    }
  });

  // U1 (layout E2, element 5): the edit pill shares the status pill's band —
  // same axis, 16px of clear air above it, and absent altogether in the empty
  // app. Mounted here rather than inside StatusBar so the gap is a property of
  // the container, not of either pill's height.
  it('floats the edit pill above the status pill on the same waveform axis, once a file is loaded', () => {
    render(<App />);
    expect(screen.queryByTestId('edit-pill')).not.toBeInTheDocument();

    act(() =>
      useAppStore.getState().addDocument(
        createDocument({ name: 'e.wav', sampleRate: 44100, channels: [new Float32Array(1024)] })
      )
    );

    const editPill = screen.getByTestId('edit-pill');
    const statusPill = screen.getByTestId('status-pill');
    const band = editPill.parentElement as HTMLElement;
    expect(statusPill.parentElement).toBe(band);
    expect(band.className).toContain('absolute');
    expect(band.className).toContain('z-20');
    expect(band.className).toContain('flex-col');
    expect(band.style.gap).toBe('16px');
    expect(band.style.paddingLeft).toBe('var(--stage-inset-left)');
    expect(band.style.paddingRight).toBe('var(--stage-inset-right)');
    // Above, not below: the edit pill is the band's first child.
    expect(band.firstElementChild).toBe(editPill);
  });
});

describe('view-change stops both playback engines (Task 23 / Task 22 review finding)', () => {
  it('calls stop on both PlaybackEngine and MultitrackPlayer when the view changes', () => {
    const peStop = jest.spyOn(playbackEngine, 'stop').mockImplementation(() => {});
    const mtStop = jest.spyOn(multitrackPlayer, 'stop').mockImplementation(() => {});

    render(<App />);
    peStop.mockClear();
    mtStop.mockClear();

    act(() => {
      useAppStore.getState().setView('multitrack');
    });

    expect(peStop).toHaveBeenCalled();
    expect(mtStop).toHaveBeenCalled();

    peStop.mockRestore();
    mtStop.mockRestore();
  });

  it('does not call stop on mount (only on an actual view change)', () => {
    const peStop = jest.spyOn(playbackEngine, 'stop').mockImplementation(() => {});
    const mtStop = jest.spyOn(multitrackPlayer, 'stop').mockImplementation(() => {});

    render(<App />);

    expect(peStop).not.toHaveBeenCalled();
    expect(mtStop).not.toHaveBeenCalled();

    peStop.mockRestore();
    mtStop.mockRestore();
  });
});

// F11 fix round (I1): the window drop guard — and, just as importantly, what
// it must NOT catch.
//
// The first version preventDefault'd EVERY drop on the window, justified by a
// data-loss story that cannot actually happen here: `navigateOnDragDrop` has
// defaulted to FALSE since Electron 3 and this app never sets it, so Chromium
// does not navigate on a dropped file. What the unconditional preventDefault
// DID do was suppress the default action of text drops — which is how text
// gets inserted into a text control — silently breaking drag-into-field in the
// lyrics, remix, voice-changer and properties surfaces.
//
// The guard stays, because insuring against config drift costs one condition;
// it now fires only for drags that actually carry files.
describe('the window drop guard is about Files, and only Files (F11)', () => {
  function dispatch(type: 'dragover' | 'drop', types: string[]): Event {
    // jsdom has neither DragEvent nor DataTransfer. The guard reads exactly one
    // thing off the event — `dataTransfer.types` — so a cancelable Event with
    // that one property attached is a faithful stand-in, and `defaultPrevented`
    // is precisely what Chromium consults afterwards.
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types } });
    act(() => {
      window.dispatchEvent(event);
    });
    return event;
  }

  it('refuses a FILE drop anywhere on the window', () => {
    render(<App />);
    expect(dispatch('drop', ['Files']).defaultPrevented).toBe(true);
  });

  it('refuses file dragover too, so the cursor does not contradict the rule', () => {
    render(<App />);
    expect(dispatch('dragover', ['Files']).defaultPrevented).toBe(true);
  });

  it('LEAVES A TEXT DRAG ALONE — dropping text into a text field still inserts it', () => {
    render(<App />);
    expect(dispatch('drop', ['text/plain']).defaultPrevented).toBe(false);
    expect(dispatch('dragover', ['text/plain']).defaultPrevented).toBe(false);
  });

  it('leaves a drag carrying nothing recognisable alone, including our own clip payload', () => {
    render(<App />);
    expect(dispatch('drop', []).defaultPrevented).toBe(false);
    expect(
      dispatch('drop', ['application/x-auditorium-document-id']).defaultPrevented
    ).toBe(false);
  });

  it('does not throw when an event carries no dataTransfer at all', () => {
    render(<App />);
    const event = new Event('drop', { bubbles: true, cancelable: true });
    expect(() => {
      act(() => {
        window.dispatchEvent(event);
      });
    }).not.toThrow();
    expect(event.defaultPrevented).toBe(false);
  });

  it('stops refusing once the app unmounts — the listeners are cleaned up', () => {
    const { unmount } = render(<App />);
    expect(dispatch('drop', ['Files']).defaultPrevented).toBe(true);

    unmount();

    expect(dispatch('drop', ['Files']).defaultPrevented).toBe(false);
  });
});
