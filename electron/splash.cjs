'use strict';

/**
 * The launch splash (Task S1), following the shape Vitrine (photo_app) proved:
 * a small frameless window opens while the editor loads, reports what init is
 * doing, and hands over the moment the real UI is on screen.
 *
 * The lifecycle lives here rather than in main.cjs for the reason every other
 * `electron/*.cjs` module exists: the decision is pure state — two booleans and
 * a timer — and pure state can be tested without an Electron runtime. The
 * BrowserWindow constructor and ipcMain are injected (see splash.test.cjs).
 *
 * The handoff waits for BOTH halves of "ready", and this is the whole design:
 *
 *   1. `ready-to-show` — Electron says a frame exists for the editor window.
 *   2. `splash:renderer-ready` — the renderer says React actually committed the
 *      editor into the document (src/splashHandoff.ts).
 *
 * Waiting for the pair is what makes the splash free. The renderer's signal is
 * sent from the DOM mutation that commits the first UI, which happens BEFORE
 * that frame is painted, and `ready-to-show` is emitted AFTER it — so in a
 * normal launch (1) is the later of the two and the editor is shown at exactly
 * the moment the old `win.once('ready-to-show', () => win.show())` showed it.
 * Nothing is scheduled in between: `handOff()` runs inside whichever signal
 * completes the pair.
 *
 * Two deliberate divergences from the reference implementation, both for that
 * same reason:
 *
 *   * photo_app defers `createWindow()` behind `setTimeout(..., 300)` so the
 *     splash gets a head start. That is 300 ms of added launch latency. Here
 *     main.cjs creates the editor window and lets its load start FIRST, then
 *     opens the splash, so nothing on the critical path waits on this feature.
 *   * photo_app delays its first progress send by 100 ms because a `send()`
 *     before the page has loaded is dropped on the floor. Here the latest
 *     milestone is buffered and flushed on `did-finish-load` instead, so the
 *     page shows the stage init has genuinely reached rather than a stage timed
 *     to arrive after a guess.
 *
 * And one failsafe, because a splash that outlives its renderer is worse than
 * no splash: if the renderer never reports ready, the editor is shown anyway
 * after `failsafeMs`, with the reason written on the splash's error line.
 */

/** A renderer that has not committed any UI within this long is not going to.
 * Long enough that a cold packaged launch on a slow disk never trips it. */
const DEFAULT_FAILSAFE_MS = 5000;

/** How long the splash stays on top of the freshly shown editor. Below this the
 * swap reads as a flicker; above it, as a stall. */
const DEFAULT_TRANSITION_MS = 300;

function createSplashController({
  BrowserWindow,
  ipcMain,
  splashFile,
  preloadFile,
  icon = undefined,
  devTools = false,
  failsafeMs = DEFAULT_FAILSAFE_MS,
  transitionMs = DEFAULT_TRANSITION_MS,
}) {
  /** @type {any} */ let splashWindow = null;
  /** @type {any} */ let mainWindow = null;
  /** The splash page has loaded and can receive a send(). */
  let splashLoaded = false;
  /** The most recent milestone, kept so a page that loads late still gets it. */
  /** @type {{ progress?: number, message?: string, error?: string } | null} */
  let latest = null;
  let readyToShow = false;
  let rendererReady = false;
  let handedOff = false;
  /** @type {any} */ let failsafeTimer = null;

  function alive(win) {
    return Boolean(win) && !win.isDestroyed();
  }

  function flush() {
    if (!latest || !splashLoaded || !alive(splashWindow)) return;
    splashWindow.webContents.send('splash:progress', latest);
  }

  /** Report an init milestone. Safe to call with no splash open (the macOS
   * re-activate path creates a window without one) and after it has closed. */
  function progress(percent, message) {
    latest = { progress: percent, message };
    flush();
  }

  /** Write a reason on the splash's error line. Carries no progress of its own —
   * the bar keeps whatever it last showed, which is where init really stopped. */
  function reportError(error) {
    latest = { ...(latest ?? {}), error };
    flush();
  }

  function disarmFailsafe() {
    if (failsafeTimer) {
      clearTimeout(failsafeTimer);
      failsafeTimer = null;
    }
  }

  /** Show the editor and retire the splash. Idempotent: only the first call
   * does anything, so a late IPC signal cannot re-show a window the user has
   * since minimised or closed. */
  function handOff() {
    if (handedOff) return;
    handedOff = true;
    disarmFailsafe();
    // Guarded: show() on a destroyed BrowserWindow throws, and the window can
    // legitimately be gone here (the failsafe path after a crash, a close
    // during load).
    if (alive(mainWindow)) mainWindow.show();
    if (alive(splashWindow)) {
      setTimeout(() => {
        if (alive(splashWindow)) splashWindow.close();
      }, transitionMs);
    }
  }

  function maybeHandOff() {
    if (handedOff || !readyToShow || !rendererReady) return;
    handOff();
  }

  /** Opens the splash. Returns the window so main.cjs can see it was created;
   * nothing outside this module needs to touch it. */
  function open() {
    splashWindow = new BrowserWindow({
      width: 460,
      height: 360,
      frame: false,
      resizable: false,
      movable: false,
      center: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      // Shown on 'ready-to-show' only: a splash that appears blank and fills in
      // afterwards is worse than none, since the blank frame IS what the user
      // is being shown to reassure them.
      show: false,
      backgroundColor: '#0a0a0c',
      icon,
      webPreferences: {
        preload: preloadFile,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        // A second window is a second attack surface; it gets the identical
        // sandbox the editor gets, DevTools policy included.
        devTools,
      },
    });

    splashWindow.loadFile(splashFile);

    splashWindow.webContents.on('did-finish-load', () => {
      splashLoaded = true;
      flush();
    });

    splashWindow.once('ready-to-show', () => {
      // The editor can be ready before the splash has painted (warm cache, fast
      // machine). Showing it then would flash a window that exists only to be
      // closed 300 ms later.
      if (!handedOff && alive(splashWindow)) splashWindow.show();
    });

    splashWindow.on('closed', () => {
      splashWindow = null;
      splashLoaded = false;
    });

    return splashWindow;
  }

  /** Adopt the editor window: watch for its first frame, and arm the failsafe.
   * The window must have been created with `show: false` — this controller is
   * the only thing that shows it. */
  function adoptMainWindow(win) {
    mainWindow = win;

    win.once('ready-to-show', () => {
      readyToShow = true;
      progress(90, 'Rendering the workspace…');
      maybeHandOff();
    });

    // If the editor window goes away before the handoff, the splash must go
    // with it: it is a window, so leaving it open keeps 'window-all-closed'
    // from firing and the app never quits.
    win.once('closed', () => {
      if (!handedOff) handOff();
    });

    failsafeTimer = setTimeout(() => {
      failsafeTimer = null;
      reportError('The editor did not report ready — showing it anyway.');
      handOff();
    }, failsafeMs);
  }

  /** The renderer's one-shot "the real UI is committed" signal. */
  function rendererIsReady() {
    if (handedOff) return;
    rendererReady = true;
    progress(100, 'Ready.');
    maybeHandOff();
  }

  ipcMain.on('splash:renderer-ready', () => rendererIsReady());

  return { open, adoptMainWindow, progress, rendererIsReady };
}

module.exports = { createSplashController, DEFAULT_FAILSAFE_MS, DEFAULT_TRANSITION_MS };
