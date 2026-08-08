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

function fakeWin({ crashed = false } = {}) {
  return {
    destroyed: false,
    destroy() {
      // Mirrors real Electron: calling destroy() on an already-destroyed
      // BrowserWindow throws "Object has been destroyed" -- this is exactly
      // the crash IMPORTANT 2 (review fix round 1) guards against.
      if (this.destroyed) {
        throw new Error('Object has been destroyed');
      }
      this.destroyed = true;
    },
    isDestroyed() {
      return this.destroyed;
    },
    webContents: {
      send: jest.fn(),
      isCrashed: () => crashed,
    },
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

function setup({ dialogResponse = 0, timeoutMs = 2000, autoConfirmQuit = false } = {}) {
  const ipcMain = fakeIpcMain();
  const dialog = { showMessageBox: jest.fn(async () => ({ response: dialogResponse })) };
  const guard = createCloseGuard({ ipcMain, dialog, timeoutMs, autoConfirmQuit });
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

  test('a second close event while the Quit/Cancel dialog is open still prevents the close but does not start a second round trip', async () => {
    jest.useFakeTimers();
    try {
      let resolveDialog;
      const dialogPromise = new Promise((resolve) => {
        resolveDialog = resolve;
      });
      const ipcMain = fakeIpcMain();
      const dialog = { showMessageBox: jest.fn(() => dialogPromise) };
      const guard = createCloseGuard({ ipcMain, dialog, timeoutMs: 2000 });
      const win = fakeWin();
      const event = fakeEvent();

      guard.handleClose(win, event);
      const responded = ipcMain.emit('app:close-response', 2); // dialog now "open" (unresolved)

      const secondEvent = fakeEvent();
      guard.handleClose(win, secondEvent);
      expect(secondEvent.prevented).toBe(true); // window must never close uncontrolled
      expect(win.webContents.send).toHaveBeenCalledTimes(1); // exactly one round trip
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1); // exactly one dialog

      // A rogue second timer (from a second round trip) would fire here and
      // destroy the window out from under the still-open dialog.
      jest.advanceTimersByTime(2001);
      expect(win.destroyed).toBe(false);

      resolveDialog({ response: 1 }); // Cancel
      await responded;
      expect(win.destroyed).toBe(false);

      // The guard must still work normally afterwards.
      const thirdEvent = fakeEvent();
      guard.handleClose(win, thirdEvent);
      expect(thirdEvent.prevented).toBe(true);
      expect(win.webContents.send).toHaveBeenCalledTimes(2);
      await ipcMain.emit('app:close-response', 0);
      expect(win.destroyed).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  describe('timeout fail-closed behavior (Task F7)', () => {
    test('an alive-but-unresponsive renderer gets a Quit/Cancel dialog instead of an immediate destroy', async () => {
      jest.useFakeTimers();
      try {
        const { dialog, guard, win, event } = setup({ timeoutMs: 2000, dialogResponse: 1 }); // Cancel
        guard.handleClose(win, event);
        expect(win.destroyed).toBe(false);

        await jest.advanceTimersByTimeAsync(2001);

        expect(dialog.showMessageBox).toHaveBeenCalledWith(
          win,
          expect.objectContaining({
            message: 'The editor is busy (a save, export or stem separation may be running). Quit anyway?',
            buttons: ['Quit', 'Cancel'],
          })
        );
        expect(win.destroyed).toBe(false); // Cancel chosen -- window stays alive
      } finally {
        jest.useRealTimers();
      }
    });

    test('choosing Quit on the busy dialog destroys the window', async () => {
      jest.useFakeTimers();
      try {
        const { guard, win, event } = setup({ timeoutMs: 2000, dialogResponse: 0 }); // Quit
        guard.handleClose(win, event);
        await jest.advanceTimersByTimeAsync(2001);
        expect(win.destroyed).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    test('a crashed webContents destroys immediately on timeout, with no dialog', async () => {
      jest.useFakeTimers();
      try {
        const { dialog, guard, win, event } = setup({ timeoutMs: 2000 });
        win.webContents.isCrashed = () => true;
        guard.handleClose(win, event);
        await jest.advanceTimersByTimeAsync(2001);
        expect(win.destroyed).toBe(true);
        expect(dialog.showMessageBox).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    test('a window already destroyed before the timeout fires is left alone (no double-destroy, no dialog)', async () => {
      jest.useFakeTimers();
      try {
        const { dialog, guard, win, event } = setup({ timeoutMs: 2000 });
        guard.handleClose(win, event);
        win.destroy(); // simulate the window already gone via some other path
        await jest.advanceTimersByTimeAsync(2001);
        expect(dialog.showMessageBox).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    test('a window destroyed by another path while the busy dialog is open: a later Quit resolution neither throws nor produces an unhandled rejection (review fix round 1, IMPORTANT 2)', async () => {
      jest.useFakeTimers();
      const unhandled = [];
      const onUnhandledRejection = (err) => unhandled.push(err);
      process.on('unhandledRejection', onUnhandledRejection);
      try {
        let resolveDialog;
        const dialogPromise = new Promise((resolve) => {
          resolveDialog = resolve;
        });
        const ipcMain = fakeIpcMain();
        const dialog = { showMessageBox: jest.fn(() => dialogPromise) };
        const guard = createCloseGuard({ ipcMain, dialog, timeoutMs: 2000 });
        const win = fakeWin();
        const event = fakeEvent();

        guard.handleClose(win, event);
        await jest.advanceTimersByTimeAsync(2001); // busy dialog now showing (unresolved)
        expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);

        win.destroy(); // window closed via some OTHER path while the dialog is up
        expect(win.destroyed).toBe(true);

        resolveDialog({ response: 0 }); // Quit chosen after the window is already gone
        jest.useRealTimers();
        await new Promise((resolve) => setTimeout(resolve, 0)); // flush real microtasks/macrotasks

        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
        jest.useRealTimers();
      }
    });

    test('the guard still works normally after a busy-dialog Cancel', async () => {
      jest.useFakeTimers();
      try {
        const { ipcMain, guard, win, event } = setup({ timeoutMs: 2000, dialogResponse: 1 });
        guard.handleClose(win, event);
        await jest.advanceTimersByTimeAsync(2001); // busy dialog shown, Cancel chosen
        expect(win.destroyed).toBe(false);

        const secondEvent = fakeEvent();
        guard.handleClose(win, secondEvent);
        expect(secondEvent.prevented).toBe(true);
        await ipcMain.emit('app:close-response', 0);
        expect(win.destroyed).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('in-flight-save count widens the warn condition (Task F7)', () => {
    test('a nonzero in-flight-save count shows the dialog even when dirtyCount is 0', async () => {
      const { ipcMain, dialog, guard, win, event } = setup({ dialogResponse: 1 }); // Cancel
      guard.handleClose(win, event);
      await ipcMain.emit('app:close-response', 0, 1);
      expect(dialog.showMessageBox).toHaveBeenCalledWith(
        win,
        expect.objectContaining({ buttons: ['Quit', 'Cancel'] })
      );
      expect(win.destroyed).toBe(false); // Cancel chosen
    });

    test('zero dirty and zero in-flight-saves still closes silently', async () => {
      const { ipcMain, dialog, guard, win, event } = setup();
      guard.handleClose(win, event);
      await ipcMain.emit('app:close-response', 0, 0);
      expect(win.destroyed).toBe(true);
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    });

    test('an omitted in-flight-save count (legacy single-arg reply) behaves as zero', async () => {
      const { ipcMain, dialog, guard, win, event } = setup();
      guard.handleClose(win, event);
      await ipcMain.emit('app:close-response', 0);
      expect(win.destroyed).toBe(true);
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    });

    test('Quit on an in-flight-save-only warning (dirty=0) destroys the window', async () => {
      const { ipcMain, guard, win, event } = setup({ dialogResponse: 0 }); // Quit
      guard.handleClose(win, event);
      await ipcMain.emit('app:close-response', 0, 2);
      expect(win.destroyed).toBe(true);
    });
  });

  describe('a rejecting dialog fails safe on BOTH call sites (review fix round 2, MINOR 4/5)', () => {
    test('normal dirty-count reply path: a rejecting dialog does not produce an unhandled rejection and destroys the window instead of leaving it stuck', async () => {
      const unhandled = [];
      const onUnhandledRejection = (err) => unhandled.push(err);
      process.on('unhandledRejection', onUnhandledRejection);
      try {
        const ipcMain = fakeIpcMain();
        const dialog = {
          showMessageBox: jest.fn(async () => {
            throw new Error('native dialog failed');
          }),
        };
        const guard = createCloseGuard({ ipcMain, dialog });
        const win = fakeWin();
        const event = fakeEvent();

        guard.handleClose(win, event);
        await ipcMain.emit('app:close-response', 2, 0); // dirty > 0 -> confirmQuit path

        expect(win.destroyed).toBe(true); // fail-safe: quitting always terminates
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }
    });

    test('busy-timeout path: a rejecting dialog does not produce an unhandled rejection and destroys the window instead of leaving it un-closable', async () => {
      jest.useFakeTimers();
      const unhandled = [];
      const onUnhandledRejection = (err) => unhandled.push(err);
      process.on('unhandledRejection', onUnhandledRejection);
      try {
        const ipcMain = fakeIpcMain();
        const dialog = {
          showMessageBox: jest.fn(async () => {
            throw new Error('native dialog failed');
          }),
        };
        const guard = createCloseGuard({ ipcMain, dialog, timeoutMs: 2000 });
        const win = fakeWin();
        const event = fakeEvent();

        guard.handleClose(win, event);
        await jest.advanceTimersByTimeAsync(2001);
        jest.useRealTimers();
        await new Promise((resolve) => setTimeout(resolve, 0)); // flush the rejection's .catch

        expect(win.destroyed).toBe(true); // fail-safe: quitting always terminates
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
        jest.useRealTimers();
      }
    });

    test('a rejecting dialog on an already-destroyed window does not throw a second time', async () => {
      const ipcMain = fakeIpcMain();
      const dialog = {
        showMessageBox: jest.fn(async () => {
          throw new Error('native dialog failed');
        }),
      };
      const guard = createCloseGuard({ ipcMain, dialog });
      const win = fakeWin();
      win.destroy(); // already gone before the reply arrives
      const event = fakeEvent();

      guard.handleClose(win, event);
      await expect(ipcMain.emit('app:close-response', 2, 0)).resolves.toBeUndefined();
      expect(win.destroyed).toBe(true);
    });
  });

  describe('a throwing destroy() inside the fail-safe .catch does not itself create an unhandled rejection (review fix round 3, MINOR B)', () => {
    test('normal dirty-count reply path: destroy() throws a non-"already destroyed" error', async () => {
      const unhandled = [];
      const onUnhandledRejection = (err) => unhandled.push(err);
      process.on('unhandledRejection', onUnhandledRejection);
      try {
        const ipcMain = fakeIpcMain();
        const dialog = {
          showMessageBox: jest.fn(async () => {
            throw new Error('native dialog failed');
          }),
        };
        const guard = createCloseGuard({ ipcMain, dialog });
        const win = fakeWin();
        win.isDestroyed = () => false; // not destroyed -- destroyIfAlive WILL attempt destroy()
        win.destroy = () => {
          throw new Error('some other native destroy failure');
        };
        const event = fakeEvent();

        guard.handleClose(win, event);
        await expect(ipcMain.emit('app:close-response', 2, 0)).resolves.toBeUndefined();

        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }
    });

    test('busy-timeout path: destroy() throws a non-"already destroyed" error', async () => {
      jest.useFakeTimers();
      const unhandled = [];
      const onUnhandledRejection = (err) => unhandled.push(err);
      process.on('unhandledRejection', onUnhandledRejection);
      try {
        const ipcMain = fakeIpcMain();
        const dialog = {
          showMessageBox: jest.fn(async () => {
            throw new Error('native dialog failed');
          }),
        };
        const guard = createCloseGuard({ ipcMain, dialog, timeoutMs: 2000 });
        const win = fakeWin();
        win.isDestroyed = () => false;
        win.destroy = () => {
          throw new Error('some other native destroy failure');
        };
        const event = fakeEvent();

        guard.handleClose(win, event);
        await jest.advanceTimersByTimeAsync(2001);
        jest.useRealTimers();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
        jest.useRealTimers();
      }
    });
  });

  describe('autoConfirmQuit (unattended test runs must never block on a dialog)', () => {
    test('a dirty count destroys immediately without showing any dialog', async () => {
      const { ipcMain, dialog, guard, win, event } = setup({ autoConfirmQuit: true });
      guard.handleClose(win, event);
      await ipcMain.emit('app:close-response', 3, 1);
      expect(win.destroyed).toBe(true);
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    });

    test('the timeout busy path destroys immediately without showing any dialog', async () => {
      jest.useFakeTimers();
      try {
        const { dialog, guard, win, event } = setup({ autoConfirmQuit: true, timeoutMs: 2000 });
        guard.handleClose(win, event);
        jest.advanceTimersByTime(2001); // renderer never answers -> busy path
        await Promise.resolve(); // let confirmQuit's microtask run
        expect(win.destroyed).toBe(true);
        expect(dialog.showMessageBox).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    test('OFF by default: the dirty path still asks (packaged behaviour unchanged)', async () => {
      const { ipcMain, dialog, guard, win, event } = setup({ dialogResponse: 1 }); // Cancel
      guard.handleClose(win, event);
      await ipcMain.emit('app:close-response', 2);
      expect(dialog.showMessageBox).toHaveBeenCalled();
      expect(win.destroyed).toBe(false); // Cancel keeps it alive
    });
  });
});
