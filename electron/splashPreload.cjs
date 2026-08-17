'use strict';

/**
 * The launch splash's preload (Task S1, fix round 2 · M-3).
 *
 * The splash is a second BrowserWindow, and everywhere else in its
 * configuration that fact is treated as "a second attack surface": same
 * sandbox, same context isolation, same DevTools policy, same navigation
 * hardening as the editor — no "it is only a splash" exemption. Its preload was
 * the one place the exemption was still being taken. Running the FULL app
 * preload there handed a 9 KB static status page the entire privileged
 * `electronAPI`: arbitrary file reads and writes, every dialog, and the
 * stem/transcribe/voice/align manager IPC.
 *
 * So it gets its own, which is the two things the page actually does:
 *
 *   * `getAppVersion` — the real version, over the same channel the About box
 *     uses, because an invented version number on a launch screen is where a
 *     wrong one is least likely to be noticed.
 *   * `onSplashProgress` — the progress channel main sends milestones on.
 *
 * Deliberately absent: `splashRendererReady`. That is the OTHER end of the same
 * handoff and belongs to the EDITOR's renderer (src/splashHandoff.ts), which
 * keeps the full preload. The splash has no business announcing that the editor
 * is ready.
 *
 * The exposed object is exposed under the same name (`electronAPI`) and the
 * same method shapes as the full preload, so electron/splash.html is written
 * against one API and does not care which preload it got. splashPreload.test.cjs
 * pins the surface by exact key set.
 *
 * Requires only `electron`: the window sets `sandbox: true`, where anything
 * else would throw at launch — in the one window whose failure the user sees
 * before anything else.
 */

const { contextBridge, ipcRenderer } = require('electron');

const electronAPI = {
  getAppVersion: () => ipcRenderer.invoke('app:version'),

  onSplashProgress: (cb) => {
    // The event is dropped and only the payload passed on: an
    // IpcRendererEvent carries `sender`, and page script has no business
    // holding one.
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('splash:progress', listener);
    return () => ipcRenderer.removeListener('splash:progress', listener);
  },
};

Object.freeze(electronAPI);

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// No `__auditoriumTest` here. The splash is given no `additionalArguments`, so
// the flag would always be false — and a flag that is only ever false is a flag
// with no reason to exist in this window.

delete window.module;
delete window.exports;
