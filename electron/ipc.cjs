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

// ---------------------------------------------------------------------------
// dialog:* opts validation (v1.5.2). The renderer-supplied opts are forwarded
// into REAL OS chrome (native open/save/message dialogs), so a compromised
// renderer must not be able to render arbitrary content there. Shapes are
// validated here at the trust boundary: enums come from an allow-list, arrays
// are bounded to the expected primitive shapes, strings are length-capped
// (TRUNCATED, never rejected -- a long decode error message must still produce
// its error dialog), and unknown keys are dropped by construction (each
// handler builds a fresh object of only the expected keys). Caps are sized
// with generous headroom over every legitimate call site: the longest real
// filter list is 1 group of 7 extensions (fileService's AUDIO_EXTENSIONS),
// the only buttons user passes 3 (closeDocumentFlow), and messages are
// one-to-two-line error/info strings.
// ---------------------------------------------------------------------------
const DIALOG_MESSAGE_TYPES = new Set(['info', 'warning', 'error', 'question']);
const DIALOG_MAX_TEXT = 2000; // title / message / button labels / filter names
const DIALOG_MAX_PATH = 1024; // defaultPath
const DIALOG_MAX_FILTERS = 10; // filter groups per dialog
const DIALOG_MAX_EXTENSIONS = 20; // extensions per filter group
const DIALOG_MAX_EXTENSION_LEN = 16;
const DIALOG_MAX_BUTTONS = 10;

/** `value` when it is a string (truncated to `maxLen`), else undefined. */
function cleanText(value, maxLen) {
  return typeof value === 'string' ? value.slice(0, maxLen) : undefined;
}

/** Renderer opts normalized to a plain object (anything else contributes no fields). */
function asObject(opts) {
  return opts && typeof opts === 'object' ? opts : {};
}

/** File-dialog filters reduced to the expected `{name, extensions[]}` shape;
 * malformed entries are dropped, a non-array is dropped entirely. */
function cleanFilters(filters) {
  if (!Array.isArray(filters)) return undefined;
  const out = [];
  for (const f of filters.slice(0, DIALOG_MAX_FILTERS)) {
    if (!f || typeof f !== 'object') continue;
    const name = cleanText(f.name, DIALOG_MAX_TEXT);
    if (name === undefined || !Array.isArray(f.extensions)) continue;
    const extensions = f.extensions
      .slice(0, DIALOG_MAX_EXTENSIONS)
      .filter((e) => typeof e === 'string')
      .map((e) => e.slice(0, DIALOG_MAX_EXTENSION_LEN));
    out.push({ name, extensions });
  }
  return out;
}

/** Message-box buttons reduced to a bounded array of length-capped strings. */
function cleanButtons(buttons) {
  if (!Array.isArray(buttons)) return undefined;
  return buttons
    .slice(0, DIALOG_MAX_BUTTONS)
    .filter((b) => typeof b === 'string')
    .map((b) => b.slice(0, DIALOG_MAX_TEXT));
}

/** Which button Enter activates. Sanitized against the buttons that SURVIVED
 * cleanButtons rather than against what the renderer sent, so an index can
 * never point past the end of the real button list; anything that is not an
 * in-range integer is dropped and the platform default applies. */
function cleanDefaultId(defaultId, buttons) {
  if (!Number.isInteger(defaultId)) return undefined;
  if (!Array.isArray(buttons) || buttons.length === 0) return undefined;
  if (defaultId < 0 || defaultId >= buttons.length) return undefined;
  return defaultId;
}

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

  /**
   * F11 (C1): read-approval for a file the USER DROPPED onto the window.
   *
   * Until this existed, approval was minted in exactly two places — after the
   * open dialog and after the save dialog (below). A path that arrives by drag
   * and drop passes through neither, so every real Explorer drop onto a track
   * lane died on the gate above. It shipped because the one environment where
   * `isTestMode()` disables that gate is precisely the smoke harness: the
   * feature worked where it was tested and nowhere else.
   *
   * WHY THIS IS NOT A HOLE IN THE GATE. This channel is never exposed to the
   * renderer. `contextIsolation` is on and the preload exposes only the frozen
   * `electronAPI` object, which carries no general-purpose approver — the only
   * caller is the preload's own drop-path resolution, immediately after
   * `webUtils.getPathForFile(file)` returned a NON-EMPTY string. That return is
   * the unforgeable part: Electron hands back "" for any `File` web content
   * constructed itself, so a non-empty path can only have come from a real
   * user drop. The preload therefore approves exactly the path the user
   * dropped, at the moment they dropped it.
   *
   * It approves for READING only — a dropped file is something to open, never
   * something we may overwrite — and it validates shape rather than existence:
   * a non-empty ABSOLUTE string. Existence is `file:read`'s problem, and
   * `openFilePath` already has the rollback for a path that turns out not to
   * be readable. A relative path is refused outright, because resolving one
   * would silently approve "whatever the working directory happens to be".
   */
  ipcMain.handle('file:approveDropped', async (_event, filePath) => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('Drop approval needs a non-empty path');
    }
    if (!path.isAbsolute(filePath)) {
      throw new Error('Drop approval needs an absolute path');
    }
    approvePath(filePath);
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

  ipcMain.handle('dialog:open', async (_event, rawOpts = {}) => {
    const opts = asObject(rawOpts);
    const win = getWin();
    const properties = ['openFile'];
    // Literal-true check: `properties` steers real dialog behaviour, so it is
    // built here from a single boolean and never taken from the renderer.
    if (opts.multi === true) properties.push('multiSelections');
    const result = await dialog.showOpenDialog(win, {
      filters: cleanFilters(opts.filters),
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

  ipcMain.handle('dialog:save', async (_event, rawOpts = {}) => {
    const opts = asObject(rawOpts);
    const win = getWin();
    const result = await dialog.showSaveDialog(win, {
      defaultPath: cleanText(opts.defaultPath, DIALOG_MAX_PATH),
      filters: cleanFilters(opts.filters)
    });
    if (result.canceled || !result.filePath) return null;
    approvePath(result.filePath);
    approveWritePath(result.filePath, true);
    return result.filePath;
  });

  ipcMain.handle('dialog:message', async (_event, rawOpts = {}) => {
    const opts = asObject(rawOpts);
    const win = getWin();
    const buttons = cleanButtons(opts.buttons);
    const result = await dialog.showMessageBox(win, {
      type: typeof opts.type === 'string' && DIALOG_MESSAGE_TYPES.has(opts.type) ? opts.type : 'info',
      title: cleanText(opts.title, DIALOG_MAX_TEXT),
      // message is the one REQUIRED field: a non-string becomes '' (an empty
      // dialog) rather than letting arbitrary renderer values reach the OS.
      message: cleanText(opts.message, DIALOG_MAX_TEXT) ?? '',
      buttons,
      // Which button Enter activates. Forwarded so a dialog whose first button
      // DOES something (the failed-write "Save As..." offer) can put the
      // keyboard default on the harmless one instead.
      defaultId: cleanDefaultId(opts.defaultId, buttons)
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
