import { act, render, screen, fireEvent, within } from '@testing-library/react';
import App from './App';
import { useAppStore, makeInitialState } from './stores/appStore';
import { createDocument } from './audio/AudioDocument';
import { playbackEngine } from './audio/PlaybackEngine';
import { multitrackPlayer } from './multitrack/MultitrackPlayer';
import { getInFlightSaveCount } from './services/fileService';

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

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  delete (window as { electronAPI?: unknown }).electronAPI;
  mockGetInFlightSaveCount.mockReturnValue(0);
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

  it('responds 0 when nothing is dirty', () => {
    const api = installCloseApi();
    addDoc(false);

    render(<App />);
    act(() => api.fireCloseRequest());

    expect(api.respondCloseRequest).toHaveBeenCalledWith(0, 0);
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

describe('right sidebar tabs (Task 23)', () => {
  it('defaults to the History tab', () => {
    render(<App />);
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'history');
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

  it('offers the Remix tab (Task T15) and switches to it on click', () => {
    render(<App />);

    const tabs = screen.getByTestId('sidebar-tabs');
    expect(within(tabs).getByRole('button', { name: 'Remix' })).toBeInTheDocument();

    fireEvent.click(within(tabs).getByRole('button', { name: 'Remix' }));
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'remix');
    // The panel body is mounted, not just the tab state.
    expect(screen.getByText(/no remix for this document/i)).toBeInTheDocument();
  });
});

describe('G4: icon rail + glass panel cards', () => {
  it('mounts the rail exactly once, carrying all six panel entries', () => {
    render(<App />);
    const rails = screen.getAllByTestId('sidebar-tabs');
    expect(rails).toHaveLength(1);
    for (const name of ['Files', 'Effects', 'Markers', 'History', 'Properties', 'Remix']) {
      expect(within(rails[0]).getByRole('button', { name })).toBeInTheDocument();
    }
  });

  // U1 (layout E2): the strip's active entry closes its card, and a closed
  // card is what hands the module column's width back to the waveform. Both
  // halves are asserted here — the card really unmounts, and the stage's
  // right inset really collapses — because the second is the whole point of
  // the first.
  it('closes the panel card when the active strip entry is clicked, and reopens it', () => {
    render(<App />);
    const strip = screen.getByTestId('sidebar-tabs');
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'history');

    fireEvent.click(within(strip).getByRole('button', { name: 'History' }));
    expect(screen.queryByTestId('sidebar-panel')).not.toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: 'History' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    fireEvent.click(within(strip).getByRole('button', { name: 'History' }));
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'history');
  });

  it('gives the stage the module column width when no card is open', () => {
    render(<App />);
    const stage = screen.getByTestId('editor-stage');
    // 14 margin + 348 column + 14 air, published as a token every floating
    // surface centres on.
    expect(stage.style.getPropertyValue('--stage-inset-right')).toBe('376px');
    expect(stage.style.getPropertyValue('--stage-inset-left')).toBe('14px');

    fireEvent.click(within(screen.getByTestId('sidebar-tabs')).getByRole('button', { name: 'History' }));
    expect(stage.style.getPropertyValue('--stage-inset-right')).toBe('14px');
  });

  it('shows exactly one panel card at a time: Files/Effects bodies are hidden until selected', () => {
    render(<App />);
    // Default tab is History; the old always-visible left column is retired,
    // so neither the Files body nor the Effects browser is mounted yet.
    expect(screen.queryByText(/no files open/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('effects-list')).not.toBeInTheDocument();

    const rail = screen.getByTestId('sidebar-tabs');
    fireEvent.click(within(rail).getByRole('button', { name: 'Files' }));
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'files');
    expect(screen.getByText(/no files open/i)).toBeInTheDocument();

    fireEvent.click(within(rail).getByRole('button', { name: 'Effects' }));
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'effects');
    expect(screen.getByTestId('effects-list')).toBeInTheDocument();
    expect(screen.queryByText(/no files open/i)).not.toBeInTheDocument();
  });

  it('double-clicking an effect in the Effects card still routes through the dialog bus (disabled without a doc)', () => {
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

  it('marks the active rail entry with the accent tile class', () => {
    render(<App />);
    const rail = screen.getByTestId('sidebar-tabs');
    expect(within(rail).getByRole('button', { name: 'History' })).toHaveClass('is-active');

    fireEvent.click(within(rail).getByRole('button', { name: 'Markers' }));
    expect(within(rail).getByRole('button', { name: 'Markers' })).toHaveClass('is-active');
    expect(within(rail).getByRole('button', { name: 'History' })).not.toHaveClass('is-active');
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
