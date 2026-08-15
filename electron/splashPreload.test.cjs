'use strict';

/**
 * Fix round 2, M-3. The splash used to run the FULL app preload: a 9 KB status
 * page was handed the entire privileged `electronAPI` — file dialogs, arbitrary
 * reads and writes, the stem/transcribe/voice/align manager IPC — when the two
 * things it does are read the version and listen to a progress channel.
 *
 * The window's own configuration already refuses the "it is only a splash"
 * exemption (same sandbox, same DevTools policy, same navigation hardening as
 * the editor). Its preload is the last place that exemption was still being
 * taken, and this suite is what keeps it taken back: the surface is asserted by
 * EXACT KEY SET, so a future convenience method added here fails loudly rather
 * than growing the second attack surface quietly.
 *
 * Loaded the same way preload.readFile.test.cjs loads the real preload: against
 * a mocked 'electron', capturing what `exposeInMainWorld` was given.
 */

function loadSplashPreload() {
  jest.resetModules();
  const exposed = new Map();
  const ipcRenderer = {
    invoke: jest.fn(async () => '9.9.9'),
    on: jest.fn(),
    send: jest.fn(),
    removeListener: jest.fn(),
  };
  jest.doMock('electron', () => ({
    contextBridge: {
      exposeInMainWorld: (name, api) => exposed.set(name, api),
    },
    ipcRenderer,
  }));
  global.window = {};
  require('./splashPreload.cjs');
  return { api: exposed.get('electronAPI'), exposed, ipcRenderer };
}

afterEach(() => {
  jest.dontMock('electron');
  jest.resetModules();
  delete global.window;
});

describe('the splash preload is the two methods the splash page uses, and nothing else', () => {
  test('exposes EXACTLY getAppVersion and onSplashProgress', () => {
    const { api } = loadSplashPreload();
    expect(Object.keys(api).sort()).toEqual(['getAppVersion', 'onSplashProgress']);
  });

  test('none of the privileged app surface comes with it', () => {
    // Named individually rather than left to the key-set assertion above, so
    // the diff on a regression says WHICH capability leaked into the splash.
    const { api } = loadSplashPreload();
    for (const method of [
      'readFile',
      'writeFile',
      'showOpenDialog',
      'showSaveDialog',
      'showMessageBox',
      'pathForFile',
      'splashRendererReady',
    ]) {
      expect([method, method in api]).toEqual([method, false]);
    }
  });

  test('exposes one world, not two: the splash gets no test hook either', () => {
    // The full preload also exposes `__auditoriumTest`. The splash is given no
    // `additionalArguments`, so it would always be false — but a flag that is
    // only ever false is a flag with no reason to exist in this window.
    const { exposed } = loadSplashPreload();
    expect([...exposed.keys()]).toEqual(['electronAPI']);
  });

  test('the surface is frozen, as the editor surface is', () => {
    const { api } = loadSplashPreload();
    expect(Object.isFrozen(api)).toBe(true);
  });

  test('getAppVersion asks over the same channel the About box uses', async () => {
    const { api, ipcRenderer } = loadSplashPreload();
    await expect(api.getAppVersion()).resolves.toBe('9.9.9');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('app:version');
  });

  test('onSplashProgress subscribes to the progress channel and hands back the payload', () => {
    const { api, ipcRenderer } = loadSplashPreload();
    const seen = [];
    api.onSplashProgress((p) => seen.push(p));

    expect(ipcRenderer.on).toHaveBeenCalledTimes(1);
    const [channel, listener] = ipcRenderer.on.mock.calls[0];
    expect(channel).toBe('splash:progress');

    // The event object is dropped and the payload passed on, exactly as the
    // full preload does it — the page must never be handed an IpcRendererEvent
    // (it carries `sender`).
    listener({ sender: 'nope' }, { progress: 60, message: 'Loading the editor…' });
    expect(seen).toEqual([{ progress: 60, message: 'Loading the editor…' }]);
  });

  test('…and returns a disposer that removes that same listener', () => {
    const { api, ipcRenderer } = loadSplashPreload();
    const dispose = api.onSplashProgress(() => {});
    const listener = ipcRenderer.on.mock.calls[0][1];

    expect(typeof dispose).toBe('function');
    dispose();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith('splash:progress', listener);
  });

  test('it can run in a sandboxed preload: it requires only electron', () => {
    // A sandboxed preload has no `require` for anything but a small allowlist.
    // The splash window sets `sandbox: true`, so a stray `require('node:fs')`
    // here would throw at launch — in the one window whose failure the user
    // sees first.
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, 'splashPreload.cjs'), 'utf8');
    const requires = [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
    expect(requires).toEqual(['electron']);
  });
});
