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
    once(event, fn) {
      return win.on(event, fn);
    },
    emit(event, ...args) {
      for (const fn of handlers.get(event) ?? []) fn(...args);
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
      on(event, fn) {
        return win.on(`webContents:${event}`, fn);
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
    preloadFile: 'C:\\app\\electron\\preload.cjs',
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
    // there is no "it is only a splash" exemption.
    const { splash } = harness();
    const win = splash.open();
    expect(win.options.webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: 'C:\\app\\electron\\preload.cjs',
    });
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
      preloadFile: 'C:\\app\\electron\\preload.cjs',
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
  test('a milestone sent before the load finishes is delivered when it does', () => {
    // photo_app works around this with `setTimeout(..., 100)` before its first
    // send. A buffered last-milestone is the same intent without the guess:
    // whatever stage init had reached by the time the page could listen is the
    // stage the page is told about.
    const { splash } = harness();
    const win = splash.open();
    splash.progress(35, 'Opening the editor window…');
    expect(win.sent).toHaveLength(0);

    win.emit('webContents:did-finish-load');
    expect(win.sent).toEqual([
      { channel: 'splash:progress', payload: { progress: 35, message: 'Opening the editor window…' } },
    ]);
  });

  test('only the LATEST buffered milestone is replayed, not a backlog', () => {
    // Replaying 35 → 45 → 55 into a page that has just appeared would animate a
    // history the user never waited through. The truthful frame is where init
    // actually is now.
    const { splash } = harness();
    const win = splash.open();
    splash.progress(35, 'Opening the editor window…');
    splash.progress(45, 'Wiring services…');
    splash.progress(55, 'Preparing audio engines…');

    win.emit('webContents:did-finish-load');
    expect(win.sent).toEqual([
      { channel: 'splash:progress', payload: { progress: 55, message: 'Preparing audio engines…' } },
    ]);
  });

  test('milestones after the load go straight through, in order', () => {
    const { splash } = harness();
    const win = splash.open();
    win.emit('webContents:did-finish-load');
    splash.progress(45, 'Wiring services…');
    splash.progress(55, 'Preparing audio engines…');

    expect(win.sent.map((s) => s.payload.progress)).toEqual([45, 55]);
  });

  test('a milestone sent with no splash open is dropped, not thrown', () => {
    // `open()` is skipped on the macOS re-activate path; progress calls from the
    // shared init sequence must stay harmless there.
    const { splash } = harness();
    expect(() => splash.progress(35, 'Opening the editor window…')).not.toThrow();
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

  test('says why on the splash before it goes', () => {
    // The error line exists for exactly this: the one case where the user is
    // owed a reason rather than a window that simply appears blank.
    const { splash, mainWin, splashWin } = launched({ failsafeMs: 5000 });
    jest.advanceTimersByTime(5000);
    const errored = splashWin.sent.filter((s) => s.payload.error);
    expect(errored).toHaveLength(1);
    expect(typeof errored[0].payload.error).toBe('string');
    expect(errored[0].payload.error.length).toBeGreaterThan(0);
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

// main.cjs cannot be require()d outside a real Electron process (it calls
// app.setName/app.whenReady at module scope), so its use of the controller is
// guarded by asserting on its source -- the same approach prodGate.test.cjs and
// devToolsPolicy.test.cjs use for the hardening options and the DevTools policy.
describe('main.cjs wires the splash without inserting a wait', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');

  /** Source with its comments removed, for the assertions that are about what
   * the file DOES. The prose in main.cjs names the 300 ms `setTimeout` this
   * implementation deliberately does not copy, and a scan that cannot tell the
   * warning from the mistake would fail on the warning. `//` is only treated as
   * a comment when it is not preceded by a colon, so the dev-server URL in
   * `loadURL` survives. */
  function codeOnly(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

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

  test('nothing in the launch path is deferred behind a timer', () => {
    // The splash must overlap the wait that already existed, never add one.
    const whenReady = codeOnly(source.slice(source.indexOf('app.whenReady()')));
    expect(whenReady).not.toMatch(/setTimeout/);
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

  test('the milestones are real init stages, sent as they complete', () => {
    // Not a fixed script on a timer: each send sits after the work it reports.
    expect(source).toMatch(/splash\.progress\(\s*\d+/);
    const sends = [...source.matchAll(/splash\.progress\(\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(sends.length).toBeGreaterThanOrEqual(4);
    // Strictly increasing: a bar that goes backwards is a bar that is lying.
    expect([...sends].sort((a, b) => a - b)).toEqual(sends);
    expect(new Set(sends).size).toBe(sends.length);
  });

  test('the dev run gets the longer failsafe, keyed off the same dev-server gate', () => {
    expect(source).toMatch(/failsafeMs:/);
    expect(source).toMatch(/VITE_DEV_SERVER/);
  });
});
