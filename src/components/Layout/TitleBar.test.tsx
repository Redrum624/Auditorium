import { render, screen, fireEvent, act } from '@testing-library/react';
import TitleBar from './TitleBar';
import type { ElectronAPI } from '../../types/electron';

/** The G2 frameless titlebar: the window buttons must route through the
 * preload's window-control API (windowClose -> 'window:close' -> win.close(),
 * which is what lets closeGuard.handleClose intercept a dirty close). A
 * button wired to anything else — or to nothing — silently breaks the
 * unsaved-changes prompt, so the routing is pinned here. */

type MaximizedCb = (isMax: boolean) => void;

function mockElectronAPI() {
  let maximizedCb: MaximizedCb | null = null;
  const unsubscribe = jest.fn();
  const api = {
    windowMinimize: jest.fn(),
    windowToggleMaximize: jest.fn(),
    windowClose: jest.fn(),
    onWindowMaximized: jest.fn((cb: MaximizedCb) => {
      maximizedCb = cb;
      return unsubscribe;
    }),
  };
  window.electronAPI = api as unknown as ElectronAPI;
  return { api, unsubscribe, fireMaximized: (isMax: boolean) => maximizedCb?.(isMax) };
}

afterEach(() => {
  // @ts-expect-error test cleanup — the jsdom window has no preload
  delete window.electronAPI;
});

describe('TitleBar — window chrome (G2)', () => {
  it('renders the ◈ AUDITORIUM wordmark', () => {
    mockElectronAPI();
    render(<TitleBar />);
    expect(screen.getByText('◈ AUDITORIUM')).toBeInTheDocument();
  });

  it('Close routes through windowClose ONLY (the closeGuard-intercepted path)', () => {
    const { api } = mockElectronAPI();
    render(<TitleBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(api.windowClose).toHaveBeenCalledTimes(1);
    expect(api.windowMinimize).not.toHaveBeenCalled();
    expect(api.windowToggleMaximize).not.toHaveBeenCalled();
  });

  it('Minimize routes through windowMinimize', () => {
    const { api } = mockElectronAPI();
    render(<TitleBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));

    expect(api.windowMinimize).toHaveBeenCalledTimes(1);
    expect(api.windowClose).not.toHaveBeenCalled();
  });

  it('Maximize routes through windowToggleMaximize and flips to Restore on maximized-changed', () => {
    const { api, fireMaximized } = mockElectronAPI();
    render(<TitleBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
    expect(api.windowToggleMaximize).toHaveBeenCalledTimes(1);

    act(() => fireMaximized(true));
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Maximize' })).not.toBeInTheDocument();

    act(() => fireMaximized(false));
    expect(screen.getByRole('button', { name: 'Maximize' })).toBeInTheDocument();
  });

  it('unsubscribes from maximized-changed on unmount', () => {
    const { unsubscribe } = mockElectronAPI();
    const { unmount } = render(<TitleBar />);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('renders without electronAPI (jsdom / plain browser) without crashing', () => {
    render(<TitleBar />);
    expect(screen.getByText('◈ AUDITORIUM')).toBeInTheDocument();
  });
});
