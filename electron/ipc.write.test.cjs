'use strict';

// End-to-end coverage for the file:write handler as actually wired in
// ipc.cjs (real write-policy checks + real atomicWriteFile against a real
// temp directory) -- the isolated unit suites (writePathPolicy.test.cjs,
// atomicWrite.test.cjs) cover each piece individually; this proves the wiring
// between them behaves correctly end to end (F2).

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

jest.doMock('electron', () => ({
  ipcMain: { handle: jest.fn(), on: jest.fn() },
  dialog: {},
  app: { isPackaged: true, getVersion: () => '0.0.0' },
}));

const { registerIpc } = require('./ipc.cjs');
const { setAppPaths } = require('./writePathPolicy.cjs');
const { ipcMain } = require('electron');

setAppPaths({ appPath: null, userData: null });
registerIpc(() => ({ isDestroyed: () => false, on: jest.fn(), webContents: {} }));

const handlers = {};
for (const [channel, fn] of ipcMain.handle.mock.calls) {
  handlers[channel] = fn;
}

function toArrayBuffer(text) {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

describe('ipc.cjs file:write end-to-end (F2 atomic write wiring)', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditorium-ipc-write-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('writes bytes to disk and leaves no temp file behind', async () => {
    const target = path.join(dir, 'take.wav');
    const result = await handlers['file:write']({}, target, toArrayBuffer('RIFFxxxxWAVE'));
    expect(result).toEqual({ ok: true });
    expect(fs.readFileSync(target, 'utf8')).toBe('RIFFxxxxWAVE');
    expect(fs.readdirSync(dir)).toEqual(['take.wav']);
  });

  test('overwriting an existing file via the handler replaces it atomically', async () => {
    const target = path.join(dir, 'take.wav');
    fs.writeFileSync(target, 'ORIGINAL-LONGER-CONTENT');
    const result = await handlers['file:write']({}, target, toArrayBuffer('new'));
    expect(result).toEqual({ ok: true });
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['take.wav']);
  });

  test('rejects a disallowed extension before ever touching the filesystem', async () => {
    const target = path.join(dir, 'evil.exe');
    const result = await handlers['file:write']({}, target, new ArrayBuffer(4));
    expect(result.ok).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('rejects a malformed UNC target via the handler (F8; deterministic without real network I/O)', async () => {
    // Full well-formed-UNC I/O isn't reachable in a unit test (no real network
    // share available); the malformed-path rejection IS deterministic, since
    // it's caught before any filesystem access is attempted.
    const result = await handlers['file:write']({}, '\\\\server', new ArrayBuffer(4));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/malformed UNC/);
  });
});
