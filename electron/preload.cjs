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

  getAppVersion: () => ipcRenderer.invoke('app:version'),

  pathBasename: (p) => p.split(/[\\/]/).pop()
};

Object.freeze(electronAPI);

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

delete window.module;
delete window.exports;
delete window.require;
