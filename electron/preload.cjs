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
  respondCloseRequest: (dirtyCount, inFlightSaveCount) =>
    ipcRenderer.send('app:close-response', dirtyCount, inFlightSaveCount),

  // Stem separation (v1.7). Channels, payload shapes and event layouts are
  // documented in electron/stemManager.cjs's module header; this bridge adds
  // no logic of its own beyond the on*/unsubscribe pattern used above.
  stemsModelState: () => ipcRenderer.invoke('stems:model-state'),
  stemsEnsureModel: () => ipcRenderer.invoke('stems:ensure-model'),
  onStemsModelProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('stems:model-progress', listener);
    return () => ipcRenderer.removeListener('stems:model-progress', listener);
  },
  stemsSeparate: (req) => ipcRenderer.invoke('stems:separate', req),
  stemsCancel: () => ipcRenderer.invoke('stems:cancel'),
  onStemsProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('stems:progress', listener);
    return () => ipcRenderer.removeListener('stems:progress', listener);
  },
  onStemsChunk: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('stems:chunk', listener);
    return () => ipcRenderer.removeListener('stems:chunk', listener);
  },

  // Transcription (F4). Channels, payload shapes and event layouts are
  // documented in electron/transcribeManager.cjs's module header; this bridge
  // adds no logic of its own beyond the on*/unsubscribe pattern used above.
  transcribeModelState: () => ipcRenderer.invoke('transcribe:model-state'),
  transcribeEnsureModels: () => ipcRenderer.invoke('transcribe:ensure-models'),
  onTranscribeModelProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('transcribe:model-progress', listener);
    return () => ipcRenderer.removeListener('transcribe:model-progress', listener);
  },
  transcribeRun: (req) => ipcRenderer.invoke('transcribe:run', req),
  transcribeCancel: () => ipcRenderer.invoke('transcribe:cancel'),
  onTranscribeProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('transcribe:progress', listener);
    return () => ipcRenderer.removeListener('transcribe:progress', listener);
  },
  onTranscribeLanguage: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('transcribe:language', listener);
    return () => ipcRenderer.removeListener('transcribe:language', listener);
  },
  onTranscribeSegment: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('transcribe:segment', listener);
    return () => ipcRenderer.removeListener('transcribe:segment', listener);
  },
  onTranscribeEmbedding: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('transcribe:embedding', listener);
    return () => ipcRenderer.removeListener('transcribe:embedding', listener);
  },

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
