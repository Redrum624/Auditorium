'use strict';

// Window-control IPC routes (v1.6 G2): the frameless window's in-app titlebar
// buttons drive these channels, so they are now the ONLY way the user closes,
// minimizes or maximizes the window. The load-bearing contract pinned here:
// 'window:close' calls win.close() — NEVER win.destroy() — because close() is
// what fires the 'close' event that closeGuard.handleClose intercepts
// (electron/closeGuard.cjs). A destroy() here would silently bypass the
// dirty-document prompt and discard unsaved work.

jest.doMock('electron', () => ({
  ipcMain: { handle: jest.fn(), on: jest.fn() },
  dialog: {
    showOpenDialog: jest.fn(async () => ({ canceled: true, filePaths: [] })),
    showSaveDialog: jest.fn(async () => ({ canceled: true })),
    showMessageBox: jest.fn(async () => ({ response: 0 })),
  },
  app: { isPackaged: true, getVersion: () => '0.0.0' },
}));

const { registerIpc } = require('./ipc.cjs');
const { ipcMain } = require('electron');

function makeWinMock({ maximized = false } = {}) {
  return {
    minimize: jest.fn(),
    maximize: jest.fn(),
    unmaximize: jest.fn(),
    close: jest.fn(),
    destroy: jest.fn(),
    isMaximized: jest.fn(() => maximized),
    isDestroyed: jest.fn(() => false),
    on: jest.fn(),
    webContents: { send: jest.fn() },
  };
}

/** Registers IPC against a fresh win mock and returns { win, ons } where ons
 * maps channel -> listener for every ipcMain.on registration. */
function register(winOpts) {
  ipcMain.on.mockClear();
  ipcMain.handle.mockClear();
  const win = makeWinMock(winOpts);
  registerIpc(() => win);
  const ons = {};
  for (const [channel, fn] of ipcMain.on.mock.calls) {
    ons[channel] = fn;
  }
  return { win, ons };
}

describe('window-control IPC routes (frameless titlebar, G2)', () => {
  test('window:minimize calls win.minimize()', () => {
    const { win, ons } = register();
    ons['window:minimize']();
    expect(win.minimize).toHaveBeenCalledTimes(1);
  });

  test('window:toggle-maximize maximizes an unmaximized window', () => {
    const { win, ons } = register({ maximized: false });
    ons['window:toggle-maximize']();
    expect(win.maximize).toHaveBeenCalledTimes(1);
    expect(win.unmaximize).not.toHaveBeenCalled();
  });

  test('window:toggle-maximize restores a maximized window', () => {
    const { win, ons } = register({ maximized: true });
    ons['window:toggle-maximize']();
    expect(win.unmaximize).toHaveBeenCalledTimes(1);
    expect(win.maximize).not.toHaveBeenCalled();
  });

  test('window:close calls win.close() so the close guard can intercept', () => {
    const { win, ons } = register();
    ons['window:close']();
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  test('window:close NEVER calls win.destroy() (would bypass closeGuard.handleClose)', () => {
    const { win, ons } = register();
    ons['window:close']();
    expect(win.destroy).not.toHaveBeenCalled();
  });

  test('registerIpc forwards maximize/unmaximize to the renderer as window:maximized-changed', () => {
    const { win } = register();
    const winEvents = {};
    for (const [event, fn] of win.on.mock.calls) {
      winEvents[event] = fn;
    }
    winEvents['maximize']();
    expect(win.webContents.send).toHaveBeenLastCalledWith('window:maximized-changed', true);
    winEvents['unmaximize']();
    expect(win.webContents.send).toHaveBeenLastCalledWith('window:maximized-changed', false);
  });

  test('window routes tolerate a missing window (getWin() -> null) without throwing', () => {
    ipcMain.on.mockClear();
    registerIpc(() => null);
    const ons = {};
    for (const [channel, fn] of ipcMain.on.mock.calls) {
      ons[channel] = fn;
    }
    expect(() => ons['window:minimize']()).not.toThrow();
    expect(() => ons['window:toggle-maximize']()).not.toThrow();
    expect(() => ons['window:close']()).not.toThrow();
  });
});
