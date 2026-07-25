'use strict';

const { ipcMain, dialog, app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { assertWriteAllowed, assertWriteTargetSafe } = require('./writePathPolicy.cjs');
const { atomicWriteFile } = require('./atomicWrite.cjs');
const { isPackagedGateOpen } = require('./prodGate.cjs');

// Paths the renderer is allowed to read via file:read, populated only by
// dialog:open/dialog:save results (i.e. paths the user explicitly picked in
// a native OS dialog). Normalized absolute + lowercase so lookups are
// case-insensitive and immune to '..'/relative-segment mismatches.
const approvedReadPaths = new Set();

// TEST-ONLY: the scripted smoke harness sets AUDITORIUM_TEST=1 so it can
// openPath()/exportActive()/saveActiveAs() without native dialogs. In that mode
// only, reads are auto-approved and writes are permitted under <cwd>/test-output/
// (which the production write policy would otherwise reject as inside the app
// path). Never true in a normal run.
//
// F23: also requires the app to be UNPACKAGED, so a packaged production build
// can never be coerced into this mode just by an env var being set. Evaluated
// lazily (per call, not at module load) via isPackagedGateOpen so `app` -- a
// plain string when this module is required outside a real Electron process,
// e.g. under Jest -- is never dereferenced eagerly. The scripted smoke harness
// launches `electron .` unpacked, so app.isPackaged is false there and this
// gate is unaffected.
function isTestMode() {
  return isPackagedGateOpen(app && app.isPackaged, process.env.AUDITORIUM_TEST);
}
const TEST_OUTPUT_DIR = path.resolve(process.cwd(), 'test-output');

function isUnderTestOutput(resolvedPath) {
  return resolvedPath === TEST_OUTPUT_DIR || resolvedPath.startsWith(TEST_OUTPUT_DIR + path.sep);
}

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
    if (!isTestMode() && !isReadApproved(filePath)) {
      throw new Error('Read not permitted: path was not user-approved');
    }
    return fs.promises.readFile(path.resolve(filePath));
  });

  ipcMain.handle('file:write', async (_event, filePath, arrayBuffer) => {
    try {
      const resolved = path.resolve(filePath);
      if (isTestMode() && isUnderTestOutput(resolved)) {
        // Test-only escape hatch: writes under test-output/ bypass the write
        // policy (see isTestMode's comment). Ensure the dir exists first.
        await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
      } else {
        assertWriteAllowed(filePath);
        assertWriteTargetSafe(resolved);
      }
      // F2: never truncate the destination directly -- write to a validated
      // sibling temp file, fsync it, then rename it over the target so a
      // failed/interrupted write can never leave a truncated original.
      await atomicWriteFile(resolved, Buffer.from(arrayBuffer));
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
