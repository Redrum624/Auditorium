'use strict';

/**
 * Native close guard (Task F8), replacing the renderer's best-effort
 * `beforeunload` handler with a real native flow:
 *
 *   1. The window's 'close' event is intercepted (`handleClose`): prevented,
 *      and 'app:close-requested' is sent to the renderer.
 *   2. The renderer replies over 'app:close-response' with its count of dirty
 *      (unsaved) documents.
 *   3. Zero dirty → the window is destroyed (destroy() skips the 'close'
 *      event, so there is no re-entry). Otherwise a native Quit/Cancel
 *      message box is shown: Quit destroys, Cancel aborts the close.
 *
 * If the renderer never answers (hung/crashed before its listener mounted),
 * a timeout destroys the window anyway — a close guard must never make the
 * app un-closable.
 *
 * Dependencies (ipcMain, dialog) are injected so the logic is unit-testable
 * without an Electron runtime (see closeGuard.test.cjs).
 */

const DEFAULT_TIMEOUT_MS = 2000;

function createCloseGuard({ ipcMain, dialog, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  /** @type {{ win: any, timer: any } | null} */
  let pending = null;
  // True from the moment the Quit/Cancel dialog is shown until it resolves.
  // Without this latch, a second 'close' event fired while the native dialog
  // is up (pending is already null — its round trip finished) would start a
  // brand-new round trip: a second 'app:close-requested' send and a second
  // timer, potentially destroying the window out from under the still-open
  // dialog, or stacking a second dialog once the renderer replies again.
  let dialogOpen = false;

  ipcMain.on('app:close-response', async (_event, dirtyCount) => {
    if (!pending) return; // stray/duplicate reply
    const { win, timer } = pending;
    pending = null;
    clearTimeout(timer);

    const n = Number(dirtyCount);
    if (!Number.isFinite(n) || n <= 0) {
      win.destroy();
      return;
    }
    dialogOpen = true;
    try {
      const result = await dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Unsaved changes',
        message: `${n} file(s) have unsaved changes.`,
        buttons: ['Quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      });
      if (result.response === 0) {
        win.destroy(); // Quit — discard unsaved changes
      }
      // Cancel: do nothing; the prevented close already kept the window alive.
    } finally {
      dialogOpen = false;
    }
  });

  /** Wire to `win.on('close', (event) => guard.handleClose(win, event))`. */
  function handleClose(win, event) {
    // Always prevent an uncontrolled close, even when a round trip or the
    // dialog is already in flight — only destroy() (below) closes the window.
    event.preventDefault();
    if (pending || dialogOpen) return; // a round trip or dialog is already in flight
    const timer = setTimeout(() => {
      // Renderer unresponsive — close anyway rather than trap the user.
      pending = null;
      win.destroy();
    }, timeoutMs);
    pending = { win, timer };
    win.webContents.send('app:close-requested');
  }

  return { handleClose };
}

module.exports = { createCloseGuard };
