'use strict';

const { createCloseGuard } = require('./closeGuard.cjs');

function fakeIpcMain() {
  const handlers = {};
  return {
    on: (channel, fn) => {
      handlers[channel] = fn;
    },
    // Returns the handler's promise so tests can await async completion.
    emit: (channel, ...args) => handlers[channel]({}, ...args),
  };
}

function fakeWin() {
  return {
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
    webContents: { send: jest.fn() },
  };
}

function fakeEvent() {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

function setup({ dialogResponse = 0, timeoutMs = 2000 } = {}) {
  const ipcMain = fakeIpcMain();
  const dialog = { showMessageBox: jest.fn(async () => ({ response: dialogResponse })) };
  const guard = createCloseGuard({ ipcMain, dialog, timeoutMs });
  const win = fakeWin();
  const event = fakeEvent();
  return { ipcMain, dialog, guard, win, event };
}

describe('closeGuard (Task F8 native close guard)', () => {
  test('handleClose prevents the close and asks the renderer for its dirty count', () => {
    const { guard, win, event } = setup();
    guard.handleClose(win, event);
    expect(event.prevented).toBe(true);
    expect(win.webContents.send).toHaveBeenCalledWith('app:close-requested');
    expect(win.destroyed).toBe(false);
  });

  test('a zero dirty count destroys the window without any dialog', async () => {
    const { ipcMain, dialog, guard, win, event } = setup();
    guard.handleClose(win, event);
    await ipcMain.emit('app:close-response', 0);
    expect(win.destroyed).toBe(true);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  test('a dirty count shows the native Quit/Cancel dialog with the count in the message', async () => {
    const { ipcMain, dialog, guard, win, event } = setup({ dialogResponse: 0 }); // Quit
    guard.handleClose(win, event);
    await ipcMain.emit('app:close-response', 2);
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      win,
      expect.objectContaining({
        message: '2 file(s) have unsaved changes.',
        buttons: ['Quit', 'Cancel'],
      })
    );
    expect(win.destroyed).toBe(true); // Quit chosen
  });

  test('Cancel aborts the close (window stays alive)', async () => {
    const { ipcMain, guard, win, event } = setup({ dialogResponse: 1 }); // Cancel
    guard.handleClose(win, event);
    await ipcMain.emit('app:close-response', 3);
    expect(win.destroyed).toBe(false);
  });

  test('the window can be closed again after a cancelled close', async () => {
    const { ipcMain, guard, win, event } = setup({ dialogResponse: 1 }); // Cancel
    guard.handleClose(win, event);
    await ipcMain.emit('app:close-response', 1);
    expect(win.destroyed).toBe(false);

    // Second attempt with a now-clean renderer closes normally.
    const again = fakeEvent();
    guard.handleClose(win, again);
    expect(again.prevented).toBe(true);
    await ipcMain.emit('app:close-response', 0);
    expect(win.destroyed).toBe(true);
  });

  test('an unresponsive renderer is not un-closable: the guard destroys after the timeout', () => {
    jest.useFakeTimers();
    try {
      const { guard, win, event } = setup({ timeoutMs: 2000 });
      guard.handleClose(win, event);
      expect(win.destroyed).toBe(false);
      jest.advanceTimersByTime(2001);
      expect(win.destroyed).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a stray close-response with no pending close is ignored', async () => {
    const { ipcMain, dialog, guard, win } = setup();
    void guard; // guard registered the ipc handler
    await ipcMain.emit('app:close-response', 5);
    expect(win.destroyed).toBe(false);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  test('non-numeric dirty counts are treated as zero (close proceeds)', async () => {
    const { ipcMain, dialog, guard, win, event } = setup();
    guard.handleClose(win, event);
    await ipcMain.emit('app:close-response', 'garbage');
    expect(win.destroyed).toBe(true);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });
});
