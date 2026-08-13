'use strict';

// F11 fix round (C1) — the approval gate, with the gate ON.
//
// THE BUG THIS SUITE EXISTS FOR. `file:read` refuses any path the user has not
// approved (`ipc.cjs`), and approval was minted in exactly two places: after
// the open dialog and after the save dialog. A path that arrives from an
// Explorer DROP passes through neither, so every real OS drop onto a track lane
// died with "Read not permitted: path was not user-approved".
//
// It shipped because the ONE environment where the gate is disabled —
// `isTestMode()`, i.e. unpackaged + AUDITORIUM_TEST=1 — is exactly the smoke
// harness. The feature worked precisely where it was tested and nowhere else.
// So this file mocks `app.isPackaged: true`, which makes `isTestMode()` false
// and the gate LIVE, and drives the real handlers registered by `registerIpc`.
//
// The approval is minted by the PRELOAD, not by the renderer: the renderer
// cannot reach `ipcRenderer` at all (contextIsolation, and only `electronAPI`
// is exposed), so `file:approveDropped` is reachable only from preload code.
// What makes that safe rather than merely indirect is `webUtils.getPathForFile`
// returning "" for any `File` web content constructed itself — a non-empty path
// can only have come from a real drop, so the preload approves exactly that
// path and nothing else.

const fs = require('node:fs');
const path = require('node:path');

jest.doMock('electron', () => ({
  ipcMain: { handle: jest.fn(), on: jest.fn() },
  dialog: {
    showSaveDialog: jest.fn(async () => ({ canceled: true })),
    showOpenDialog: jest.fn(async () => ({ canceled: true, filePaths: [] })),
  },
  // isPackaged TRUE => isPackagedGateOpen(...) is false => isTestMode() is
  // false => the approval gate is enforced. This is the whole point.
  app: { isPackaged: true, getVersion: () => '0.0.0' },
}));

const { registerIpc, _testing } = require('./ipc.cjs');
const { setAppPaths } = require('./writePathPolicy.cjs');
const { ipcMain } = require('electron');

setAppPaths({ appPath: null, userData: null });
registerIpc(() => ({ isDestroyed: () => false, on: jest.fn(), webContents: {} }));

const handlers = {};
for (const [channel, fn] of ipcMain.handle.mock.calls) {
  handlers[channel] = fn;
}

describe('a dropped file becomes readable, and nothing else does (C1)', () => {
  let dir;
  let dropped;
  let neighbour;

  beforeEach(() => {
    _testing.resetApproved();
    const base = path.join(process.cwd(), 'test-output');
    fs.mkdirSync(base, { recursive: true });
    dir = fs.mkdtempSync(path.join(base, 'auditorium-drop-approval-'));
    dropped = path.join(dir, 'dropped.wav');
    neighbour = path.join(dir, 'neighbour.wav');
    fs.writeFileSync(dropped, 'RIFFdropped');
    fs.writeFileSync(neighbour, 'RIFFneighbour');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the gate really is live in this suite — an unapproved read is refused', async () => {
    // The premise every other test here depends on. Without it a green suite
    // would prove nothing: this is the exact condition the smoke cannot see.
    await expect(handlers['file:read'](null, dropped)).rejects.toThrow(
      /not user-approved/
    );
  });

  test('approving a dropped path lets THAT path be read', async () => {
    await handlers['file:approveDropped'](null, dropped);

    const bytes = await handlers['file:read'](null, dropped);
    expect(Buffer.from(bytes).toString()).toBe('RIFFdropped');
  });

  test('it approves that path ONLY — its neighbour in the same folder stays refused', async () => {
    await handlers['file:approveDropped'](null, dropped);

    await expect(handlers['file:read'](null, neighbour)).rejects.toThrow(
      /not user-approved/
    );
  });

  test('it approves for READING only — the write gate is untouched', async () => {
    await handlers['file:approveDropped'](null, dropped);

    expect(_testing.isReadApproved(dropped)).toBe(true);
    expect(_testing.isWriteApproved(dropped)).toBe(false);
  });

  test('a relative path is refused, so the channel cannot be used to approve "whatever cwd is"', async () => {
    await expect(handlers['file:approveDropped'](null, 'dropped.wav')).rejects.toThrow(
      /absolute/i
    );
    expect(_testing.isReadApproved(path.resolve('dropped.wav'))).toBe(false);
  });

  test('a non-string is refused rather than coerced', async () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      await expect(handlers['file:approveDropped'](null, bad)).rejects.toThrow();
    }
  });

  test('an empty string is refused — that is exactly what getPathForFile returns for a forged File', async () => {
    await expect(handlers['file:approveDropped'](null, '')).rejects.toThrow();
  });

  test('the approval survives the round trip through path normalisation', async () => {
    const nonCanonical = path.join(dir, 'sub', '..', 'dropped.wav');
    await handlers['file:approveDropped'](null, nonCanonical);

    const bytes = await handlers['file:read'](null, dropped);
    expect(Buffer.from(bytes).toString()).toBe('RIFFdropped');
  });
});
