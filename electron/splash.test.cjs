'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createSplashController } = require('./splash.cjs');

/**
 * The splash controller's whole job is a handoff, and a handoff has exactly two
 * ways to go wrong: it happens too early (a window with nothing in it), or it
 * never happens (an app that is a 460x360 rectangle forever). Both are covered
 * here against fakes, because the decision is pure state — two booleans and a
 * timer — and none of it needs an Electron runtime to be true.
 */

/** A stand-in for a BrowserWindow: records what was done to it, and lets a test
 * fire the events Electron would fire. `show()` throws once destroyed, exactly
 * as the real one does, so a guard that is missing fails loudly here. */
function makeFakeWindow(options) {
  const handlers = new Map();
  const win = {
    options,
    destroyed: false,
    shown: false,
    loadedFile: null,
    sent: [],
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
      return win;
    },
    /** Fix round 2, M-7. This used to be a plain alias for `on()`, which made
     * the fake unable to tell the two apart — so a regression from
     * `win.once('ready-to-show')` to `win.on(...)`, which re-runs the milestone
     * on every subsequent paint, was invisible to this suite. Electron removes
     * the listener BEFORE invoking it, and so does this. */
    once(event, fn) {
      const oneShot = (...args) => {
        const list = handlers.get(event) ?? [];
        const at = list.indexOf(oneShot);
        if (at >= 0) list.splice(at, 1);
        fn(...args);
      };
      return win.on(event, oneShot);
    },
    emit(event, ...args) {
      // Over a COPY: a one-shot listener removes itself from this list while
      // the loop is walking it.
      for (const fn of [...(handlers.get(event) ?? [])]) fn(...args);
    },
    listenerCount(event) {
      return (handlers.get(event) ?? []).length;
    },
    isDestroyed: () => win.destroyed,
    show() {
      if (win.destroyed) throw new Error('Object has been destroyed');
      win.shown = true;
    },
    loadFile(file) {
      win.loadedFile = file;
      return Promise.resolve();
    },
    close() {
      if (win.destroyed) return;
      win.destroyed = true;
      win.emit('closed');
    },
    destroy() {
      win.destroyed = true;
    },
    webContents: {
      /** Whatever `setWindowOpenHandler` was last given, so a test can ask what
       * the real Chromium would be told when the page opens a window. */
      windowOpenHandler: null,
      on(event, fn) {
        return win.on(`webContents:${event}`, fn);
      },
      setWindowOpenHandler(fn) {
        win.webContents.windowOpenHandler = fn;
      },
      send(channel, payload) {
        if (win.destroyed) throw new Error('Object has been destroyed');
        win.sent.push({ channel, payload });
      },
    },
  };
  return win;
}

function makeFakeIpcMain() {
  const handlers = new Map();
  return {
    on(channel, fn) {
      if (!handlers.has(channel)) handlers.set(channel, []);
      handlers.get(channel).push(fn);
    },
    fire(channel, ...args) {
      for (const fn of handlers.get(channel) ?? []) fn(...args);
    },
    channels: () => [...handlers.keys()],
  };
}

/** Builds a controller over fakes. Returns the controller plus the list of
 * windows the fake BrowserWindow constructor was asked for, newest last. */
function harness(overrides = {}) {
  const created = [];
  function FakeBrowserWindow(options) {
    const win = makeFakeWindow(options);
    created.push(win);
    return win;
  }
  const ipcMain = makeFakeIpcMain();
  const splash = createSplashController({
    BrowserWindow: FakeBrowserWindow,
    ipcMain,
    splashFile: 'C:\\app\\electron\\splash.html',
    preloadFile: 'C:\\app\\electron\\splashPreload.cjs',
    icon: 'C:\\app\\assets\\icon.ico',
    ...overrides,
  });
  return { splash, ipcMain, created };
}

/** Drives one normal launch to the point just before the handoff: splash open
 * and loaded, main window adopted. */
function launched(overrides = {}) {
  const h = harness(overrides);
  const splashWin = h.splash.open();
  splashWin.emit('webContents:did-finish-load');
  splashWin.emit('ready-to-show');
  const mainWin = makeFakeWindow({ role: 'main' });
  h.splash.adoptMainWindow(mainWin);
  return { ...h, splashWin, mainWin };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('the splash window itself', () => {
  test('is frameless, fixed, centred and hidden until it has painted', () => {
    const { splash, created } = harness();
    const win = splash.open();

    expect(created).toHaveLength(1);
    expect(win.options).toMatchObject({
      frame: false,
      resizable: false,
      center: true,
      skipTaskbar: true,
      show: false,
    });
    // Shown only on 'ready-to-show': a splash that appears blank and fills in
    // afterwards is worse than no splash at all, since the blank frame IS the
    // thing the user is being shown to reassure them.
    expect(win.shown).toBe(false);
    win.emit('ready-to-show');
    expect(win.shown).toBe(true);
  });

  test('loads the local page, and only the local page', () => {
    const { splash } = harness();
    const win = splash.open();
    expect(win.loadedFile).toBe('C:\\app\\electron\\splash.html');
  });

  test('runs under the same renderer hardening as the editor window', () => {
    // A splash is a second BrowserWindow, and a second BrowserWindow is a
    // second attack surface. It gets the identical sandbox the editor gets --
    // there is no "it is only a splash" exemption. The preload is the one
    // place the two windows differ, and they differ in the safe direction:
    // whatever main hands in here, the splash's is the small one (M-3, pinned
    // against main.cjs's source below and by splashPreload.test.cjs).
    const { splash } = harness();
    const win = splash.open();
    expect(win.options.webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: 'C:\\app\\electron\\splashPreload.cjs',
    });
  });

  test('cannot open a window, and cannot navigate anywhere', () => {
    // Fix round 2, M-2. The webPreferences parity with the editor was exact; the
    // NAVIGATION hardening parity (main.cjs:127-133) was not. Exploitation is
    // implausible behind `default-src 'none'` on a static local page — which is
    // the point: these two lines are free, and "it is only a splash" is the
    // exemption this window has already been denied everywhere else.
    //
    // The splash's stance is stricter than the editor's: the editor allows a
    // same-URL navigation (a reload), the splash allows none at all. It loads
    // one file and shows a progress bar; there is nowhere it could legitimately
    // go. `will-navigate` does not fire for the initial `loadFile`.
    const { splash } = harness();
    const win = splash.open();

    expect(typeof win.webContents.windowOpenHandler).toBe('function');
    expect(win.webContents.windowOpenHandler({ url: 'https://example.com' })).toEqual({
      action: 'deny',
    });

    let prevented = false;
    win.emit('webContents:will-navigate', { preventDefault: () => { prevented = true; } }, 'https://example.com');
    expect(prevented).toBe(true);
  });

  test('closes itself if it cannot load its own page, and the launch goes on', async () => {
    // The failure mode being denied is two-fold: an unhandled rejection in the
    // main process, and an empty rectangle sitting on screen. Neither the
    // editor window nor the renderer is involved in the handoff's other half,
    // so the launch itself is unaffected.
    const created = [];
    function FakeBrowserWindow(options) {
      const win = makeFakeWindow(options);
      win.loadFile = () => Promise.reject(new Error('ENOENT'));
      created.push(win);
      return win;
    }
    const splash = createSplashController({
      BrowserWindow: FakeBrowserWindow,
      ipcMain: makeFakeIpcMain(),
      splashFile: 'C:\\gone\\splash.html',
      preloadFile: 'C:\\app\\electron\\splashPreload.cjs',
    });
    const splashWin = splash.open();
    const mainWin = makeFakeWindow({});
    splash.adoptMainWindow(mainWin);

    await Promise.resolve();
    await Promise.resolve();
    expect(splashWin.destroyed).toBe(true);

    mainWin.emit('ready-to-show');
    splash.rendererIsReady();
    expect(mainWin.shown).toBe(true);
  });

  test('does not show once the handoff has already happened', () => {
    // The editor can be ready before the splash page has painted (a warm cache,
    // a fast machine). Showing the splash then would flash a window that exists
    // only to be closed 300 ms later.
    const { splash } = harness();
    const splashWin = splash.open();
    const mainWin = makeFakeWindow({});
    splash.adoptMainWindow(mainWin);
    mainWin.emit('ready-to-show');
    splash.rendererIsReady();

    splashWin.emit('ready-to-show');
    expect(splashWin.shown).toBe(false);
  });
});

describe('progress reaches the page even when it was sent before the page existed', () => {
  // These are the BUFFERING contract, not the wired ladder: `progress()` takes
  // any number and any string, and what is asserted here is that the channel
  // delivers the right one at the right time. The numbers are therefore
  // deliberately generic — three arbitrary ascending values. They used to be
  // 35 / 45 / 55 with the stage names those rungs carried before fix round 1
  // renumbered the ladder to 40/60/80/90/100, which read as coverage of
  // milestones that no longer exist.
  const A = { pct: 10, msg: 'first stage…' };
  const B = { pct: 20, msg: 'second stage…' };
  const C = { pct: 30, msg: 'third stage…' };

  test('a milestone sent before the load finishes is delivered when it does', () => {
    // photo_app works around this with `setTimeout(..., 100)` before its first
    // send. A buffered last-milestone is the same intent without the guess:
    // whatever stage init had reached by the time the page could listen is the
    // stage the page is told about.
    const { splash } = harness();
    const win = splash.open();
    splash.progress(A.pct, A.msg);
    expect(win.sent).toHaveLength(0);

    win.emit('webContents:did-finish-load');
    expect(win.sent).toEqual([
      { channel: 'splash:progress', payload: { progress: A.pct, message: A.msg } },
    ]);
  });

  test('only the LATEST buffered milestone is replayed, not a backlog', () => {
    // Replaying three stages into a page that has just appeared would animate a
    // history the user never waited through. The truthful frame is where init
    // actually is now.
    const { splash } = harness();
    const win = splash.open();
    splash.progress(A.pct, A.msg);
    splash.progress(B.pct, B.msg);
    splash.progress(C.pct, C.msg);

    win.emit('webContents:did-finish-load');
    expect(win.sent).toEqual([
      { channel: 'splash:progress', payload: { progress: C.pct, message: C.msg } },
    ]);
  });

  test('milestones after the load go straight through, in order', () => {
    const { splash } = harness();
    const win = splash.open();
    win.emit('webContents:did-finish-load');
    splash.progress(B.pct, B.msg);
    splash.progress(C.pct, C.msg);

    expect(win.sent.map((s) => s.payload.progress)).toEqual([B.pct, C.pct]);
  });

  test('a milestone sent with no splash open is dropped, not thrown', () => {
    // `open()` is skipped on the macOS re-activate path; progress calls from the
    // shared init sequence must stay harmless there.
    const { splash } = harness();
    expect(() => splash.progress(A.pct, A.msg)).not.toThrow();
  });

  test('a milestone sent after the splash closed is dropped, not thrown', () => {
    const { splash, splashWin } = launched();
    splashWin.close();
    expect(() => splash.progress(90, 'too late')).not.toThrow();
  });
});

describe('the handoff waits for BOTH halves of "ready"', () => {
  test('Electron painting the window is not enough on its own', () => {
    // 'ready-to-show' says a frame exists. It does not say React committed the
    // editor into it, which is the thing the user is waiting for.
    const { splash, mainWin, splashWin } = launched();
    mainWin.emit('ready-to-show');
    jest.advanceTimersByTime(1000);

    expect(mainWin.shown).toBe(false);
    expect(splashWin.destroyed).toBe(false);
  });

  test('the renderer reporting ready is not enough on its own', () => {
    // Showing before 'ready-to-show' is the white-flash this whole shape exists
    // to avoid.
    const { splash, mainWin } = launched();
    splash.rendererIsReady();
    jest.advanceTimersByTime(1000);

    expect(mainWin.shown).toBe(false);
  });

  test('both, in either order, hand the window over', () => {
    for (const order of ['paint-first', 'renderer-first']) {
      const { splash, mainWin } = launched();
      if (order === 'paint-first') {
        mainWin.emit('ready-to-show');
        splash.rendererIsReady();
      } else {
        splash.rendererIsReady();
        mainWin.emit('ready-to-show');
      }
      expect(mainWin.shown).toBe(true);
    }
  });

  test('the renderer signal arrives over IPC, not by being called by hand', () => {
    const { splash, ipcMain, mainWin } = launched();
    expect(ipcMain.channels()).toContain('splash:renderer-ready');

    mainWin.emit('ready-to-show');
    ipcMain.fire('splash:renderer-ready');
    expect(mainWin.shown).toBe(true);
  });

  test('the splash closes after the transition, not in the same frame', () => {
    // The 300 ms is the crossfade: the splash stays on top of the freshly shown
    // editor for exactly as long as it takes to stop looking like a flicker.
    const { splash, mainWin, splashWin } = launched({ transitionMs: 300 });
    mainWin.emit('ready-to-show');
    splash.rendererIsReady();

    expect(splashWin.destroyed).toBe(false);
    jest.advanceTimersByTime(299);
    expect(splashWin.destroyed).toBe(false);
    jest.advanceTimersByTime(1);
    expect(splashWin.destroyed).toBe(true);
  });

  test('a second ready signal cannot re-run the handoff', () => {
    const { splash, mainWin, splashWin } = launched();
    mainWin.emit('ready-to-show');
    splash.rendererIsReady();
    jest.advanceTimersByTime(1000);
    mainWin.shown = false;

    splash.rendererIsReady();
    jest.advanceTimersByTime(1000);
    expect(mainWin.shown).toBe(false);
    expect(splashWin.destroyed).toBe(true);
  });

  test('the editor is shown at the LAST of the two signals, never later', () => {
    // This is the zero-added-latency claim, stated as a test: the window is
    // shown in the same turn as whichever of the two conditions completes the
    // pair. Nothing is scheduled between them, so the launch cannot be slower
    // than the `ready-to-show` show it replaced unless the renderer's own
    // signal is later than its first paint.
    const { splash, mainWin } = launched();
    splash.rendererIsReady();
    expect(mainWin.shown).toBe(false);
    mainWin.emit('ready-to-show');
    expect(mainWin.shown).toBe(true); // no timer advanced
  });

  test('reports 100% before handing over, so the bar is never left mid-way', () => {
    const { splash, mainWin, splashWin } = launched();
    mainWin.emit('ready-to-show');
    splash.rendererIsReady();
    const last = splashWin.sent[splashWin.sent.length - 1];
    expect(last.payload.progress).toBe(100);
  });

  test('…and in the order the module calls NORMAL, where the renderer is first', () => {
    // Fix round 1, I-1. The module header's own claim is that the renderer's
    // signal arrives BEFORE 'ready-to-show' in a normal launch. That makes the
    // natural send order {100,'Ready.'} then {90,'Rendering the workspace…'} —
    // and with `.bar { transition: width .3s }` the bar animates BACKWARDS for
    // exactly the window in which the splash is still on screen. The sibling
    // test above only ever drove the other order, so nothing caught it.
    const { splash, mainWin, splashWin } = launched();
    splash.rendererIsReady();
    mainWin.emit('ready-to-show');

    const last = splashWin.sent[splashWin.sent.length - 1];
    expect(last.payload.progress).toBe(100);
  });

  test('progress is monotone: no milestone can ever lower the bar', () => {
    // Stated as a general rule rather than a patch on the one pair that broke
    // it, because "a bar that goes backwards is a bar that is lying" is a
    // property of the whole channel, not of those two senders.
    const { splash, mainWin, splashWin } = launched();
    splash.rendererIsReady(); // 100
    mainWin.emit('webContents:dom-ready'); // 60 — late, must not land
    mainWin.emit('webContents:did-finish-load'); // 80 — late, must not land
    mainWin.emit('ready-to-show'); // 90 — late, must not land

    const values = splashWin.sent.map((s) => s.payload.progress);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(values[values.length - 1]).toBe(100);
  });

  test('the editor DOM arriving is a milestone, because that one lands in its own turn', () => {
    // Fix round 1, I-2. main.cjs's init is ONE synchronous block: the main
    // process cannot dispatch the splash's 'did-finish-load' while it runs, so
    // every milestone sent inside it collapses to the last one and the user
    // sees a single jump. The stages that are genuinely observable are the
    // editor webContents' own async events, which land in separate turns — and
    // they cover the long part of the wait, the bundle load, which nothing was
    // reporting before.
    const { mainWin, splashWin } = launched();
    mainWin.emit('webContents:dom-ready');
    const last = splashWin.sent[splashWin.sent.length - 1];
    expect(last.payload.progress).toBe(60);
    expect(typeof last.payload.message).toBe('string');
  });

  test('so is the editor finishing its load', () => {
    const { mainWin, splashWin } = launched();
    mainWin.emit('webContents:dom-ready');
    mainWin.emit('webContents:did-finish-load');
    const values = splashWin.sent.map((s) => s.payload.progress);
    expect(values).toEqual([60, 80]);
  });

  test('the four observable stages climb in the order they can occur', () => {
    const { splash, mainWin, splashWin } = launched();
    mainWin.emit('webContents:dom-ready');
    mainWin.emit('webContents:did-finish-load');
    mainWin.emit('ready-to-show');
    splash.rendererIsReady();
    expect(splashWin.sent.map((s) => s.payload.progress)).toEqual([60, 80, 90, 100]);
  });

  test('a second paint does not re-announce the milestone the first one earned', () => {
    // Fix round 2, M-7. `win.once('ready-to-show')` regressing to `win.on(...)`
    // would re-send 90 on every subsequent paint. Before the renderer is ready
    // the bar is AT 90, so the monotone clamp does not drop it (90 < 90 is
    // false) and the page is told the same stage twice — a bar that stutters
    // while the launch is still going. The fake now honours `once`, so this can
    // be observed at all.
    const { mainWin, splashWin } = launched();
    mainWin.emit('ready-to-show');
    mainWin.emit('ready-to-show');

    expect(splashWin.sent.filter((s) => s.payload.progress === 90)).toHaveLength(1);
  });

  test("the window painting is itself a milestone the user sees", () => {
    const { splash, mainWin, splashWin } = launched();
    mainWin.emit('ready-to-show');
    const last = splashWin.sent[splashWin.sent.length - 1];
    expect(last.payload.progress).toBeGreaterThan(55);
    expect(last.payload.progress).toBeLessThan(100);
    expect(typeof last.payload.message).toBe('string');
  });
});

describe('the failsafe: a splash that outlives its renderer still ends', () => {
  test('shows the editor anyway when the ready signal never comes', () => {
    // A renderer that crashed before its first commit sends nothing, ever. The
    // app must not be a 460x360 rectangle for the rest of the session.
    const { splash, mainWin, splashWin } = launched({ failsafeMs: 5000 });
    mainWin.emit('ready-to-show');

    jest.advanceTimersByTime(4999);
    expect(mainWin.shown).toBe(false);
    jest.advanceTimersByTime(1);
    expect(mainWin.shown).toBe(true);

    jest.advanceTimersByTime(300);
    expect(splashWin.destroyed).toBe(true);
  });

  test('fires even when the window never painted at all', () => {
    const { splash, mainWin, splashWin } = launched({ failsafeMs: 5000 });
    jest.advanceTimersByTime(5000);
    expect(mainWin.shown).toBe(true);
    jest.advanceTimersByTime(300);
    expect(splashWin.destroyed).toBe(true);
  });

  test('says why on the splash before it goes, when the window never painted', () => {
    // The error line exists for exactly this: the one case where the user is
    // owed a reason rather than a window that simply appears blank.
    const { mainWin, splashWin } = launched({ failsafeMs: 5000 });
    jest.advanceTimersByTime(5000);
    const errored = splashWin.sent.filter((s) => s.payload.error);
    expect(errored).toHaveLength(1);
    expect(typeof errored[0].payload.error).toBe('string');
    expect(errored[0].payload.error.length).toBeGreaterThan(0);
    expect(mainWin.shown).toBe(true);
  });

  test('but says NOTHING when the window painted and only the renderer was slow', () => {
    // Fix round 1, I-4. A launch that is merely slow is not a launch that
    // failed. If Electron has painted, the window has something in it and
    // showing it silently is the correct, non-alarming behaviour; a red "did
    // not report ready" line there would be a false alarm at the user.
    const { mainWin, splashWin } = launched({ failsafeMs: 5000 });
    mainWin.emit('ready-to-show');
    jest.advanceTimersByTime(5000);

    expect(splashWin.sent.filter((s) => s.payload.error)).toHaveLength(0);
    expect(mainWin.shown).toBe(true);
  });

  test('is disarmed by a normal handoff, so it can never fire afterwards', () => {
    const { splash, mainWin, splashWin } = launched({ failsafeMs: 5000 });
    mainWin.emit('ready-to-show');
    splash.rendererIsReady();
    jest.advanceTimersByTime(10000);

    const errored = splashWin.sent.filter((s) => s.payload.error);
    expect(errored).toHaveLength(0);
  });

  test('a dev run gets a longer rope, because Vite legitimately takes it', () => {
    // `npm run dev` loads http://localhost:3005, and a cold Vite transforms the
    // whole module graph on that first request. Ending the splash at 5 s there
    // would report a failure that is really just a dev server doing its job.
    const { splash, mainWin } = launched({ failsafeMs: 20000 });
    jest.advanceTimersByTime(19999);
    expect(mainWin.shown).toBe(false);
    jest.advanceTimersByTime(1);
    expect(mainWin.shown).toBe(true);
  });

  test('a destroyed editor window ends the splash instead of showing a corpse', () => {
    // show() on a destroyed BrowserWindow throws. Worse, a splash left alone
    // after the editor is gone keeps `window-all-closed` from firing, so the
    // app never quits.
    const { splash, mainWin, splashWin } = launched({ failsafeMs: 5000 });
    mainWin.close();

    expect(() => jest.advanceTimersByTime(5300)).not.toThrow();
    expect(splashWin.destroyed).toBe(true);
  });

  test('a splash closed by hand does not break the handoff', () => {
    const { splash, mainWin, splashWin } = launched();
    splashWin.close();
    mainWin.emit('ready-to-show');
    expect(() => splash.rendererIsReady()).not.toThrow();
    expect(mainWin.shown).toBe(true);
  });
});

describe('a splash that is gone stops holding the editor back', () => {
  // Fix round 2, M-4. The pair-wait is only free because the user is looking at
  // the splash for the whole of it. Take the splash away — its page failed to
  // load, so it closed itself (the `loadFile` rejection path above) — and a slow
  // or crashed renderer leaves the user with NO WINDOW AT ALL until the failsafe
  // fires seconds later. That is strictly worse than the behaviour this feature
  // replaced, which showed the editor on `ready-to-show` alone. So the moment
  // the splash is gone the gate drops back to exactly that.

  test('the editor is shown on ready-to-show alone once the splash has closed', () => {
    const { splash, mainWin, splashWin } = launched({ failsafeMs: 5000 });
    splashWin.close();

    mainWin.emit('ready-to-show');
    expect(mainWin.shown).toBe(true); // no timer advanced: not the failsafe
  });

  test('…including the case that motivates it: the page never loaded', () => {
    // The compound edge, end to end. `loadFile` rejects, the splash closes
    // itself, the renderer never reports ready at all.
    const created = [];
    function FakeBrowserWindow(options) {
      const win = makeFakeWindow(options);
      win.loadFile = () => Promise.reject(new Error('ENOENT'));
      created.push(win);
      return win;
    }
    const splash = createSplashController({
      BrowserWindow: FakeBrowserWindow,
      ipcMain: makeFakeIpcMain(),
      splashFile: 'C:\\gone\\splash.html',
      preloadFile: 'C:\\app\\electron\\splashPreload.cjs',
      failsafeMs: 5000,
    });
    splash.open();
    const mainWin = makeFakeWindow({});
    splash.adoptMainWindow(mainWin);

    return Promise.resolve()
      .then(() => Promise.resolve())
      .then(() => {
        mainWin.emit('ready-to-show');
        expect(mainWin.shown).toBe(true); // no timer advanced
      });
  });

  test('but a closed splash still cannot show a window that has not painted', () => {
    // Relaxing the gate must not turn into showing an unpainted window: the
    // white flash is the thing this whole shape exists to prevent, and
    // `ready-to-show` is the half that rules it out. Only the renderer's half
    // is dropped.
    const { mainWin, splashWin } = launched({ failsafeMs: 5000 });
    splashWin.close();

    jest.advanceTimersByTime(4999);
    expect(mainWin.shown).toBe(false);
  });

  test('the splash closing AFTER a normal handoff changes nothing', () => {
    // The handoff closes the splash itself, 300 ms later. That `closed` must not
    // re-enter the handoff it was caused by.
    const { splash, mainWin, splashWin } = launched();
    mainWin.emit('ready-to-show');
    splash.rendererIsReady();
    mainWin.shown = false;

    jest.advanceTimersByTime(300);
    expect(splashWin.destroyed).toBe(true);
    expect(mainWin.shown).toBe(false);
  });
});

// main.cjs cannot be require()d outside a real Electron process (it calls
// app.setName/app.whenReady at module scope), so its use of the controller is
// guarded by asserting on its source -- the same approach prodGate.test.cjs and
// devToolsPolicy.test.cjs use for the hardening options and the DevTools policy.
describe('main.cjs wires the splash without inserting a wait', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');

  /** Source with its comments removed, for the assertions that are about what
   * the file DOES. The prose in main.cjs names the 300 ms `setTimeout` this
   * implementation deliberately does not copy, and a scan that cannot tell the
   * warning from the mistake would fail on the warning.
   *
   * `//` is only treated as a comment when it is preceded by neither a colon
   * NOR a slash. The colon is what keeps the dev-server URL in `loadURL`; the
   * slash is fix round 2, M-6 — in a `file:///…` literal the FIRST `//` is
   * protected by its colon and the SECOND one, one character along, was not, so
   * everything after it on that line was silently deleted before the scan ran.
   * No source here contains such a literal today; the point is that a future
   * one would have hidden a real violation rather than failed. */
  function codeOnly(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:/])\/\/[^\n]*/g, '$1');
  }

  test('the comment stripper keeps code and drops comments, triple slash included', () => {
    // Guards every assertion below that runs over `codeOnly`: a stripper that
    // ate real code would make those scans pass by having nothing to find.
    expect(codeOnly("win.loadURL('http://localhost:3005'); // gone")).toContain('localhost:3005');
    expect(codeOnly("win.loadURL('http://localhost:3005'); // gone")).not.toContain('gone');
    expect(codeOnly("const u = 'file:///C:/app/x.html'; setTimeout(f, 300);")).toContain(
      'setTimeout'
    );
    expect(codeOnly('a(); // setTimeout(f, 300)')).not.toContain('setTimeout');
    expect(codeOnly('/* setTimeout(f, 300) */ a();')).not.toContain('setTimeout');
  });

  test('the controller owns the lifecycle, not an inline BrowserWindow', () => {
    expect(source).toMatch(/require\('\.\/splash\.cjs'\)/);
    expect(source).toMatch(/createSplashController\(\{/);
  });

  test('the editor window is created and told to load BEFORE the splash opens', () => {
    // The single hard requirement on this feature: the splash overlaps the wait
    // that already existed and never adds one. photo_app defers createWindow()
    // behind `setTimeout(..., 300)`, which is 300 ms of pure added latency; the
    // editor's `loadURL`/`loadFile` here is already in flight before the splash
    // BrowserWindow is even constructed.
    const createAt = source.indexOf('createWindow({ showWhenReady: false })');
    const openAt = source.indexOf('splash.open()');
    expect(createAt).toBeGreaterThan(-1);
    expect(openAt).toBeGreaterThan(-1);
    expect(createAt).toBeLessThan(openAt);
  });

  /** The body of `app.whenReady().then(…)`, from its head to the `});` that
   * closes it at column 0.
   *
   * Fix round 2, M-8. This used to be "from `app.whenReady()` to END OF FILE",
   * which quietly put `window-all-closed`, `before-quit` and anything else
   * added below the launch path inside a scan that is only about the launch
   * path. A `setTimeout` in a quit handler would have failed a test named for
   * something else entirely. */
  function launchPath() {
    // The CALL, not the first mention: main.cjs's heap-flag comment near the
    // top names `app.whenReady()` in prose, and the bare-string search found
    // that instead — which the sibling test below caught the moment this slice
    // stopped running to end of file and started having a beginning that
    // mattered.
    const from = source.indexOf('app.whenReady().then(');
    const end = source.indexOf('\n});', from);
    expect(from).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(from);
    return codeOnly(source.slice(from, end));
  }

  test('nothing in the launch path is deferred behind a timer', () => {
    // The splash must overlap the wait that already existed, never add one.
    expect(launchPath()).not.toMatch(/setTimeout/);
  });

  test('…and that scan really is reading the launch path, and only it', () => {
    // Guards the guard both ways: the slice must contain the launch (otherwise
    // "no setTimeout in it" is a statement about nothing) and must stop before
    // the app-lifetime handlers that follow it (otherwise the test above is
    // secretly about them too).
    const body = launchPath();
    expect(body).toContain('splash.open()');
    expect(body).toContain('registerIpc(');
    expect(body).not.toContain('window-all-closed');
  });

  test('the splash is skipped for the self-test mode, which has no windows at all', () => {
    // `--stem-selftest-out=` runs headless and exits; a splash there would be a
    // window nobody asked for in a mode whose whole point is not having one.
    const selftestGate = source.indexOf('if (stemSelftestArgs)');
    const openAt = source.indexOf('splash.open()');
    expect(selftestGate).toBeGreaterThan(-1);
    expect(selftestGate).toBeLessThan(openAt);
    expect(source.slice(selftestGate, openAt)).toMatch(/return;/);
  });

  test('main sends ONE milestone, because it only has one turn to send in', () => {
    // Fix round 1, I-2. Everything from `splash.open()` to the last manager is
    // one synchronous block, so the main process cannot dispatch the splash
    // page's 'did-finish-load' anywhere inside it: only the LAST value written
    // there can ever reach the page. Emitting 35/45/55/75 from that block put
    // three stage names in the code, the report and the README that no user
    // could ever see. One send, after the work it names, is the honest shape;
    // the stages that the user CAN see hang off the editor's async events in
    // splash.cjs.
    const sends = [...source.matchAll(/splash\.progress\(\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(sends).toHaveLength(1);
  });

  test('and sends it AFTER the work it names, not before', () => {
    const sendAt = source.indexOf('splash.progress(');
    const lastManager = source.lastIndexOf('registerAlignIpc(');
    expect(lastManager).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(lastManager);
  });

  test('the splash is given its own preload, not the editor’s', () => {
    // Fix round 2, M-3. The controller takes `preloadFile` as an argument, so
    // the only place the choice is visible is here. A 9 KB status page must not
    // be handed the privileged `electronAPI` — see electron/splashPreload.cjs
    // and the exact-key-set assertion in splashPreload.test.cjs.
    const wiring = codeOnly(source.slice(source.indexOf('createSplashController({')));
    expect(wiring).toMatch(/preloadFile:\s*path\.join\(__dirname,\s*'splashPreload\.cjs'\)/);
    expect(wiring.slice(0, wiring.indexOf('});'))).not.toMatch(/'preload\.cjs'/);
  });

  test('the dev run gets the longer failsafe, keyed off the same dev-server gate', () => {
    expect(source).toMatch(/failsafeMs:/);
    expect(source).toMatch(/VITE_DEV_SERVER/);
  });
});
