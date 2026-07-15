'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const electronAPI = {
  readFile: (path) =>
    ipcRenderer
      .invoke('file:read', path)
      .then((buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),

  writeFile: (path, data) => ipcRenderer.invoke('file:write', path, data),

  showOpenDialog: (opts) => ipcRenderer.invoke('dialog:open', opts),
  showSaveDialog: (opts) => ipcRenderer.invoke('dialog:save', opts),
  showMessageBox: (opts) => ipcRenderer.invoke('dialog:message', opts),

  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  windowClose: () => ipcRenderer.send('window:close'),

  onWindowMaximized: (cb) => {
    const listener = (_event, isMax) => cb(isMax);
    ipcRenderer.on('window:maximized-changed', listener);
    return () => ipcRenderer.removeListener('window:maximized-changed', listener);
  },

  // Native close guard (Task F8): main asks over 'app:close-requested'; the
  // renderer answers with its dirty-document count over 'app:close-response'.
  onCloseRequested: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('app:close-requested', listener);
    return () => ipcRenderer.removeListener('app:close-requested', listener);
  },
  respondCloseRequest: (dirtyCount) => ipcRenderer.send('app:close-response', dirtyCount),

  getAppVersion: () => ipcRenderer.invoke('app:version'),

  pathBasename: (p) => p.split(/[\\/]/).pop()
};

Object.freeze(electronAPI);

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// TEST-ONLY: expose whether the app was launched by the smoke harness so
// App.tsx can install its window.__test hooks. The flag arrives via
// webPreferences.additionalArguments (see electron/main.cjs); false in a
// normal run.
contextBridge.exposeInMainWorld(
  '__auditoriumTest',
  process.argv.includes('--auditorium-test')
);

delete window.module;
delete window.exports;
delete window.require;
