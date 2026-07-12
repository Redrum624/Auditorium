'use strict';

const { ipcMain, dialog, app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { assertWriteAllowed, assertWriteTargetSafe } = require('./writePathPolicy.cjs');

// Paths the renderer is allowed to read via file:read, populated only by
// dialog:open/dialog:save results (i.e. paths the user explicitly picked in
// a native OS dialog). Normalized absolute + lowercase so lookups are
// case-insensitive and immune to '..'/relative-segment mismatches.
const approvedReadPaths = new Set();

function normalizeForApproval(rawPath) {
  return path.resolve(rawPath).toLowerCase();
}

function approvePath(rawPath) {
  approvedReadPaths.add(normalizeForApproval(rawPath));
}

function isReadApproved(rawPath) {
  return approvedReadPaths.has(normalizeForApproval(rawPath));
}

function resetApproved() {
  approvedReadPaths.clear();
}

const _testing = { approvePath, isReadApproved, resetApproved };

/**
 * Registers every IPC handler used by the renderer's window.electronAPI.
 * `getWin` is a getter (not the window itself) so handlers always operate on
 * the current BrowserWindow instance.
 */
function registerIpc(getWin) {
  ipcMain.handle('file:read', async (_event, filePath) => {
    if (!isReadApproved(filePath)) {
      throw new Error('Read not permitted: path was not user-approved');
    }
    return fs.promises.readFile(path.resolve(filePath));
  });

  ipcMain.handle('file:write', async (_event, filePath, arrayBuffer) => {
    try {
      assertWriteAllowed(filePath);
      const resolved = path.resolve(filePath);
      assertWriteTargetSafe(resolved);
      await fs.promises.writeFile(resolved, Buffer.from(arrayBuffer));
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
    result.filePaths.forEach(approvePath);
    return result.filePaths;
  });

  ipcMain.handle('dialog:save', async (_event, opts = {}) => {
    const win = getWin();
    const result = await dialog.showSaveDialog(win, {
      defaultPath: opts.defaultPath,
      filters: opts.filters
    });
    if (result.canceled || !result.filePath) return null;
    approvePath(result.filePath);
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

module.exports = { registerIpc, _testing };
