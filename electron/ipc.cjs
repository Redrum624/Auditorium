'use strict';

const { ipcMain, dialog, app } = require('electron');
const fs = require('node:fs');
const { assertWriteAllowed } = require('./writePathPolicy.cjs');

/**
 * Registers every IPC handler used by the renderer's window.electronAPI.
 * `getWin` is a getter (not the window itself) so handlers always operate on
 * the current BrowserWindow instance.
 */
function registerIpc(getWin) {
  ipcMain.handle('file:read', async (_event, filePath) => {
    return fs.promises.readFile(filePath);
  });

  ipcMain.handle('file:write', async (_event, filePath, arrayBuffer) => {
    try {
      assertWriteAllowed(filePath);
      await fs.promises.writeFile(filePath, Buffer.from(arrayBuffer));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message) };
    }
  });

  ipcMain.handle('dialog:open', async (_event, opts = {}) => {
    const win = getWin();
    const properties = ['openFile'];
    if (opts.multi) properties.push('multiSelections');
    const result = await dialog.showOpenDialog(win, {
      filters: opts.filters,
      properties
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths;
  });

  ipcMain.handle('dialog:save', async (_event, opts = {}) => {
    const win = getWin();
    const result = await dialog.showSaveDialog(win, {
      defaultPath: opts.defaultPath,
      filters: opts.filters
    });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  ipcMain.handle('dialog:message', async (_event, opts = {}) => {
    const win = getWin();
    const result = await dialog.showMessageBox(win, {
      type: opts.type || 'info',
      title: opts.title,
      message: opts.message,
      buttons: opts.buttons
    });
    return result.response;
  });

  ipcMain.handle('app:version', () => {
    return app.getVersion();
  });

  ipcMain.on('window:minimize', () => {
    const win = getWin();
    if (win) win.minimize();
  });

  ipcMain.on('window:toggle-maximize', () => {
    const win = getWin();
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });

  ipcMain.on('window:close', () => {
    const win = getWin();
    if (win) win.close();
  });

  const win = getWin();
  if (win && !win.isDestroyed()) {
    win.on('maximize', () => win.webContents.send('window:maximized-changed', true));
    win.on('unmaximize', () => win.webContents.send('window:maximized-changed', false));
  }
}

module.exports = { registerIpc };
