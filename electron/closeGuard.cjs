'use strict';

/**
 * Native close guard (Task F8/F7), replacing the renderer's best-effort
 * `beforeunload` handler with a real native flow:
 *
 *   1. The window's 'close' event is intercepted (`handleClose`): prevented,
 *      and 'app:close-requested' is sent to the renderer.
 *   2. The renderer replies over 'app:close-response' with its count of dirty
 *      (unsaved) documents and its count of in-flight BUSY WORK — saves
 *      mid-encode/write, plus (v1.7) any running stem separation, which is
 *      minutes of inference that a silent quit would throw away.
 *   3. Both zero → the window is destroyed (destroy() skips the 'close'
 *      event, so there is no re-entry). Otherwise a native Quit/Cancel
 *      message box is shown: Quit destroys, Cancel aborts the close.
 *
 * If the renderer never answers within `timeoutMs` (F7: fail CLOSED, not
 * open). A renderer that's merely busy in a long synchronous operation (an
 * encode, an export) can look identical to a hung/crashed one from main's
 * side — the old unconditional destroy() here discarded that work. Now:
 *   - webContents actually crashed, or the window is already gone: destroy
 *     as before (nothing left to ask).
 *   - otherwise: show a Quit/Cancel dialog treating the unanswered state as
 *     "busy, unknown dirty count" rather than assuming it's safe to kill.
 * A close guard must still never make the app permanently un-closable — Quit
 * on that dialog destroys the window.
 *
 * Dependencies (ipcMain, dialog) are injected so the logic is unit-testable
 * without an Electron runtime (see closeGuard.test.cjs).
 */

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * `autoConfirmQuit` (test mode only — wired from the same prod gate as the
 * renderer test hooks): every path that would show a native Quit/Cancel
 * dialog destroys the window immediately instead. An unattended run (the
 * e2e smoke, CI) has no human at the console, so a modal here is not a
 * safety net — it is a hang that a person then has to dismiss by hand.
 * The dialog flows themselves stay covered by the non-auto unit tests.
 */
function createCloseGuard({ ipcMain, dialog, timeoutMs = DEFAULT_TIMEOUT_MS, autoConfirmQuit = false }) {
  /** @type {{ win: any, timer: any } | null} */
  let pending = null;
  // True from the moment ANY Quit/Cancel-style dialog (the dirty-count one or
  // the timeout busy one) is shown until it resolves. Without this latch, a
  // second 'close' event fired while a native dialog is up (pending is
  // already null — its round trip finished) would start a brand-new round
  // trip: a second 'app:close-requested' send and a second timer, potentially
  // destroying the window out from under the still-open dialog, or stacking
  // a second dialog once the renderer replies again.
  let dialogOpen = false;

  /** Fail-safe destroy, guarded against an already-destroyed window (real
   * Electron throws "Object has been destroyed" on a second destroy() call). */
  function destroyIfAlive(win) {
    if (!win.isDestroyed?.()) {
      win.destroy();
    }
  }

  /** Shows a Quit/Cancel dialog and destroys the window on Quit. Shared by
   * the normal dirty-count reply and the F7 timeout busy-dialog path. */
  async function confirmQuit(win, message) {
    if (autoConfirmQuit) {
      destroyIfAlive(win);
      return;
    }
    dialogOpen = true;
    try {
      const result = await dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Unsaved changes',
        message,
        buttons: ['Quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      });
      // The window may have been destroyed via some OTHER path while this
      // dialog was awaiting a response (review fix round 1, IMPORTANT 2) --
      // calling destroy() again would throw "Object has been destroyed".
      if (result.response === 0 && !win.isDestroyed?.()) {
        win.destroy(); // Quit — discard unsaved/in-flight work
      }
      // Cancel: do nothing; the prevented close already kept the window alive.
    } finally {
      dialogOpen = false;
    }
  }

  ipcMain.on('app:close-response', async (_event, dirtyCount, inFlightSaveCount) => {
    if (!pending) return; // stray/duplicate reply
    const { win, timer } = pending;
    pending = null;
    clearTimeout(timer);

    const dirty = Number(dirtyCount);
    const inFlight = Number(inFlightSaveCount);
    const dirtyN = Number.isFinite(dirty) && dirty > 0 ? dirty : 0;
    const inFlightN = Number.isFinite(inFlight) && inFlight > 0 ? inFlight : 0;

    if (dirtyN <= 0 && inFlightN <= 0) {
      win.destroy();
      return;
    }

    const message =
      dirtyN > 0
        ? `${dirtyN} file(s) have unsaved changes.`
        : 'A save or stem separation is still in progress.';
    // ipcMain.on doesn't await (or catch a rejection from) this listener's
    // returned promise, so an uncaught confirmQuit failure here would become
    // an unhandled rejection exactly like the timeout path below (review fix
    // round 2, MINOR 4). Fail safe by destroying the window rather than
    // leaving it stuck un-closable (MINOR 5). The inner try/catch (review fix
    // round 3, MINOR B) guards against destroy() ITSELF throwing for some
    // reason other than "already destroyed" (destroyIfAlive only guards
    // that one case) -- an uncaught throw here would just re-create the
    // exact unhandled rejection this .catch exists to prevent.
    await confirmQuit(win, message).catch(() => {
      try {
        destroyIfAlive(win);
      } catch {
        /* swallow: this IS the last-resort fail-safe path */
      }
    });
  });

  /** Wire to `win.on('close', (event) => guard.handleClose(win, event))`. */
  function handleClose(win, event) {
    // Always prevent an uncontrolled close, even when a round trip or the
    // dialog is already in flight — only destroy() (below) closes the window.
    event.preventDefault();
    if (pending || dialogOpen) return; // a round trip or dialog is already in flight
    const timer = setTimeout(() => {
      pending = null;
      if (typeof win.isDestroyed === 'function' && win.isDestroyed()) {
        return; // already gone via some other path
      }
      const crashed =
        typeof win.webContents?.isCrashed === 'function' && win.webContents.isCrashed();
      if (crashed) {
        win.destroy(); // truly gone -- nothing left to ask
        return;
      }
      // F7: fail CLOSED. The renderer hasn't answered but its webContents is
      // still alive -- it may just be busy in a long synchronous operation
      // (encode/export), not dead. Ask instead of assuming it's safe to
      // discard its work. This is a genuinely fire-and-forget call (a
      // setTimeout callback can't be awaited) -- .catch keeps any failure
      // (e.g. a destroyed-window race, review fix round 1 IMPORTANT 2) from
      // becoming an unhandled promise rejection, and fails safe by destroying
      // the window instead of silently no-op'ing: a persistently rejecting
      // dialog must never leave an un-closable window (review fix round 2,
      // MINOR 5) -- there's no native menu or frame to force-quit from. The
      // inner try/catch (review fix round 3, MINOR B) guards against
      // destroy() itself throwing for some reason other than "already
      // destroyed" -- an uncaught throw here would just re-create the exact
      // unhandled rejection this .catch exists to prevent.
      void confirmQuit(
        win,
        'The editor is busy (a save, export or stem separation may be running). Quit anyway?'
      ).catch(() => {
        try {
          destroyIfAlive(win);
        } catch {
          /* swallow: this IS the last-resort fail-safe path */
        }
      });
    }, timeoutMs);
    pending = { win, timer };
    win.webContents.send('app:close-requested');
  }

  return { handleClose };
}

module.exports = { createCloseGuard };
