'use strict';

// Integration test for F23 as wired into ipc.cjs's file:read approval gate.
// electron.cjs is mocked per-test (jest.doMock, not hoisted) so isPackaged can
// vary; jest.resetModules() between loads forces a fresh require of ipc.cjs
// against the newly-mocked 'electron'.

const fs = require('node:fs');
const path = require('node:path');

describe('ipc.cjs file:read AUDITORIUM_TEST gate honors app.isPackaged (F23)', () => {
  const ORIGINAL_ENV = process.env.AUDITORIUM_TEST;

  afterEach(() => {
    jest.dontMock('electron');
    jest.resetModules();
    if (ORIGINAL_ENV === undefined) {
      delete process.env.AUDITORIUM_TEST;
    } else {
      process.env.AUDITORIUM_TEST = ORIGINAL_ENV;
    }
  });

  function loadIpcHandlers(isPackaged) {
    jest.resetModules();
    jest.doMock('electron', () => ({
      ipcMain: { handle: jest.fn(), on: jest.fn() },
      dialog: {},
      app: { isPackaged, getVersion: () => '0.0.0' },
    }));
    const { registerIpc } = require('./ipc.cjs');
    const { ipcMain } = require('electron');
    registerIpc(() => ({ isDestroyed: () => false, on: jest.fn(), webContents: {} }));
    const handlers = {};
    for (const [channel, fn] of ipcMain.handle.mock.calls) {
      handlers[channel] = fn;
    }
    return handlers;
  }

  test('an unapproved read is rejected when the app IS packaged, even with AUDITORIUM_TEST=1', async () => {
    process.env.AUDITORIUM_TEST = '1';
    const handlers = loadIpcHandlers(true);
    await expect(handlers['file:read']({}, 'D:\\music\\unapproved.wav')).rejects.toThrow(
      'Read not permitted'
    );
  });

  test('an unapproved read bypasses the approval gate when the app is UNPACKAGED and AUDITORIUM_TEST=1', async () => {
    process.env.AUDITORIUM_TEST = '1';
    const handlers = loadIpcHandlers(false);
    // Proves the approval check itself was skipped: the promise still rejects,
    // but with fs's ENOENT for the (nonexistent) path, not the approval error.
    await expect(
      handlers['file:read']({}, 'D:\\definitely\\does\\not\\exist-M4.wav')
    ).rejects.toThrow(/ENOENT/);
  });

  test('an unapproved read is rejected without AUDITORIUM_TEST set, regardless of isPackaged', async () => {
    delete process.env.AUDITORIUM_TEST;
    const handlers = loadIpcHandlers(false);
    await expect(handlers['file:read']({}, 'D:\\music\\unapproved.wav')).rejects.toThrow(
      'Read not permitted'
    );
  });

  // The write side of the same gate. The scripted smoke drives
  // saveActiveAs/exportActive/saveSessionAs with no native dialog at all, so
  // the test-output escape hatch has to bypass the user-approval gate as well
  // as the path policy -- while a packaged build must never do so.
  describe('file:write AUDITORIUM_TEST escape hatch', () => {
    const target = path.join(process.cwd(), 'test-output', 'auditorium-prodgate', 'smoke.wav');

    afterEach(() => {
      fs.rmSync(path.dirname(target), { recursive: true, force: true });
    });

    test('an unapproved write under test-output/ SUCCEEDS when UNPACKAGED with AUDITORIUM_TEST=1', async () => {
      process.env.AUDITORIUM_TEST = '1';
      const handlers = loadIpcHandlers(false);
      const result = await handlers['file:write']({}, target, new TextEncoder().encode('RIFF').buffer);
      expect(result).toEqual({ ok: true });
      expect(fs.readFileSync(target, 'utf8')).toBe('RIFF');
    });

    test('the same unapproved write is REFUSED when the app IS packaged, even with AUDITORIUM_TEST=1', async () => {
      process.env.AUDITORIUM_TEST = '1';
      const handlers = loadIpcHandlers(true);
      const result = await handlers['file:write']({}, target, new TextEncoder().encode('RIFF').buffer);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not user-approved/);
      expect(fs.existsSync(target)).toBe(false);
    });

    test('the escape hatch does not extend OUTSIDE test-output/, even when unpackaged', async () => {
      process.env.AUDITORIUM_TEST = '1';
      const handlers = loadIpcHandlers(false);
      const outside = path.join(process.cwd(), 'auditorium-prodgate-outside.wav');
      try {
        const result = await handlers['file:write']({}, outside, new ArrayBuffer(4));
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/not user-approved/);
        expect(fs.existsSync(outside)).toBe(false);
      } finally {
        // Belt and braces: if the gate ever regresses, this test must not
        // leave a stray file in the repo root behind as well as failing.
        fs.rmSync(outside, { force: true });
      }
    });
  });
});
