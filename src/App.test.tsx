import { act, render, screen, fireEvent } from '@testing-library/react';
import App from './App';
import { useAppStore, makeInitialState } from './stores/appStore';
import { createDocument } from './audio/AudioDocument';
import { playbackEngine } from './audio/PlaybackEngine';
import { multitrackPlayer } from './multitrack/MultitrackPlayer';

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  delete (window as { electronAPI?: unknown }).electronAPI;
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

    expect(api.respondCloseRequest).toHaveBeenCalledWith(2);
  });

  it('responds 0 when nothing is dirty', () => {
    const api = installCloseApi();
    addDoc(false);

    render(<App />);
    act(() => api.fireCloseRequest());

    expect(api.respondCloseRequest).toHaveBeenCalledWith(0);
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

    expect(api.respondCloseRequest).toHaveBeenCalledWith(1);
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
