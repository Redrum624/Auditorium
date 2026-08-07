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

  function addDoc(dirty: boolean) {
    const doc = createDocument({
      name: dirty ? 'dirty.wav' : 'clean.wav',
      sampleRate: 44100,
      channels: [new Float32Array(4)],
    });
    useAppStore.getState().addDocument(doc);
    if (dirty) useAppStore.getState().updateDocument({ ...doc, dirty: true });
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
