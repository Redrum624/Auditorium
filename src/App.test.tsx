import { act, render, screen, fireEvent } from '@testing-library/react';
import App from './App';
import { useAppStore, makeInitialState } from './stores/appStore';
import { playbackEngine } from './audio/PlaybackEngine';
import { multitrackPlayer } from './multitrack/MultitrackPlayer';

beforeEach(() => {
  useAppStore.setState(makeInitialState());
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
