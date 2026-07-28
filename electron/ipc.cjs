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

// Paths the renderer is allowed to WRITE via file:write, populated only by
// dialog:save/dialog:open results -- the same "the user picked this in a
// native OS dialog" rule the read gate above already enforces, applied to the
// other direction. Until this existed, file:write was gated ONLY by the path
// policy (writePathPolicy.cjs), which answers "is this a sane place for an
// audio app to write" and NOT "did the user ever ask for this file": a
// compromised renderer could silently overwrite every .wav/.mp3/.flac/.ogg/
// .audm on the machine outside the protected directories.
//
// Fed by BOTH dialogs because both legitimately produce a write target:
//   * dialog:save  -- Save As, every Export format, Save Session.
//   * dialog:open  -- an opened document keeps its `filePath`, and plain Save
//                     re-encodes into it in place (fileService.ts:326) with no
//                     second dialog. Without this arm, Save-after-Open (the
//                     single most common save in the app) would break.
const approvedWritePaths = new Set();

// Extensions the renderer may APPEND to a dialog:save result before writing.
// It does this deliberately -- saveAsWav (fileService.ts:388-390) and
// exportDocument (:447-449) both enforce the format's extension on the actual
// write target when the user retypes the filename, so `song.flac` chosen in a
// WAV save dialog is written as `song.flac.wav`. The appended path is
// therefore a legitimate target the user's own dialog choice produced, but it
// is NOT the string the dialog returned, so it has to be approved alongside
// it. Deliberately this fixed list (writePathPolicy's own allow-list) rather
// than the renderer-supplied `opts.filters`: the set of extra approvals must
// not be steerable from the renderer.
const APPENDABLE_EXTENSIONS = ['wav', 'mp3', 'flac', 'ogg', 'audm'];

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

/** Approves `rawPath` for writing. `withAppendedExtensions` is set only for
 * dialog:save results -- see APPENDABLE_EXTENSIONS. */
function approveWritePath(rawPath, withAppendedExtensions = false) {
  approvedWritePaths.add(normalizeForApproval(rawPath));
  if (!withAppendedExtensions) return;
  for (const ext of APPENDABLE_EXTENSIONS) {
    approvedWritePaths.add(normalizeForApproval(`${rawPath}.${ext}`));
  }
}

function isWriteApproved(rawPath) {
  return approvedWritePaths.has(normalizeForApproval(rawPath));
}

function resetApproved() {
  approvedReadPaths.clear();
  approvedWritePaths.clear();
}

const _testing = { approvePath, isReadApproved, approveWritePath, isWriteApproved, resetApproved };

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
        // policy AND the user-approval gate (see isTestMode's comment) -- the
        // scripted smoke drives saveActiveAs/exportActive/saveSessionAs with
        // no native dialog to approve anything. Ensure the dir exists first.
        await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
      } else {
        assertWriteAllowed(filePath);
        assertWriteTargetSafe(resolved);
        // Ordered LAST of the three so the policy's specific diagnostics
        // ("extension not in the allow-list", "malformed UNC path", ...) still
        // win for a path that is both unapproved and structurally invalid.
        if (!isWriteApproved(filePath)) {
          throw new Error('Write not permitted: path was not user-approved');
        }
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
    result.filePaths.forEach((p) => {
      approvePath(p);
      // No appended-extension variants here: an opened document's in-place
      // Save writes to exactly the path it was opened from, and a Save that
      // changes the format goes through dialog:save instead.
      approveWritePath(p);
    });
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
    approveWritePath(result.filePath, true);
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
