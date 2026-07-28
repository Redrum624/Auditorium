'use strict';

// End-to-end coverage for the file:write handler as actually wired in
// ipc.cjs (real write-policy checks + real user-approval gate + real
// atomicWriteFile against a real temp directory) -- the isolated unit suites
// (writePathPolicy.test.cjs, atomicWrite.test.cjs) cover each piece
// individually; this proves the wiring between them behaves correctly end to
// end (F2), including that every legitimate save/export flow's path really
// does arrive approved.

const fs = require('node:fs');
const path = require('node:path');

let saveDialogResult = { canceled: true };
let openDialogResult = { canceled: true, filePaths: [] };

jest.doMock('electron', () => ({
  ipcMain: { handle: jest.fn(), on: jest.fn() },
  dialog: {
    showSaveDialog: jest.fn(async () => saveDialogResult),
    showOpenDialog: jest.fn(async () => openDialogResult),
  },
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

function toArrayBuffer(text) {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

describe('ipc.cjs file:write end-to-end (F2 atomic write wiring)', () => {
  let dir;

  beforeEach(() => {
    // Deliberately NOT os.tmpdir(): on some Windows configurations TEMP resolves
    // under C:\Windows\Temp, which writePathPolicy correctly refuses as a
    // protected directory -- so these tests would fail on the app's own policy
    // rather than on the behaviour they mean to exercise. A repo-local scratch
    // dir is never protected. (atomicWrite.test.cjs can still use os.tmpdir()
    // because it calls atomicWriteFile directly, below the policy layer.)
    const base = path.join(process.cwd(), 'test-output');
    fs.mkdirSync(base, { recursive: true });
    dir = fs.mkdtempSync(path.join(base, 'auditorium-ipc-write-'));
    _testing.resetApproved();
    saveDialogResult = { canceled: true };
    openDialogResult = { canceled: true, filePaths: [] };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('writes bytes to disk and leaves no temp file behind', async () => {
    const target = path.join(dir, 'take.wav');
    _testing.approveWritePath(target);
    const result = await handlers['file:write']({}, target, toArrayBuffer('RIFFxxxxWAVE'));
    expect(result).toEqual({ ok: true });
    expect(fs.readFileSync(target, 'utf8')).toBe('RIFFxxxxWAVE');
    expect(fs.readdirSync(dir)).toEqual(['take.wav']);
  });

  test('overwriting an existing file via the handler replaces it atomically', async () => {
    const target = path.join(dir, 'take.wav');
    _testing.approveWritePath(target);
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

describe('ipc.cjs file:write user-approval gate', () => {
  let dir;

  beforeEach(() => {
    const base = path.join(process.cwd(), 'test-output');
    fs.mkdirSync(base, { recursive: true });
    dir = fs.mkdtempSync(path.join(base, 'auditorium-ipc-approve-'));
    _testing.resetApproved();
    saveDialogResult = { canceled: true };
    openDialogResult = { canceled: true, filePaths: [] };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a policy-legal but never-user-chosen path is REFUSED and nothing lands on disk', async () => {
    const target = path.join(dir, 'victim.wav');
    fs.writeFileSync(target, 'PRECIOUS-USER-AUDIO');

    const result = await handlers['file:write']({}, target, toArrayBuffer('overwritten'));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not user-approved/);
    // The whole point: the original file is intact, not truncated.
    expect(fs.readFileSync(target, 'utf8')).toBe('PRECIOUS-USER-AUDIO');
    expect(fs.readdirSync(dir)).toEqual(['victim.wav']);
  });

  test('the policy still gets the first word: an unapproved AND structurally invalid path reports the policy reason', async () => {
    const result = await handlers['file:write']({}, path.join(dir, 'evil.exe'), new ArrayBuffer(4));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/extension not in the allow-list/);
  });

  test('Save As / Export: a dialog:save result is approved for writing', async () => {
    const target = path.join(dir, 'exported.wav');
    saveDialogResult = { canceled: false, filePath: target };

    const chosen = await handlers['dialog:save']({}, { filters: [{ name: 'Waveform Audio', extensions: ['wav'] }] });
    expect(chosen).toBe(target);

    const result = await handlers['file:write']({}, chosen, toArrayBuffer('RIFF'));
    expect(result).toEqual({ ok: true });
    expect(fs.readFileSync(target, 'utf8')).toBe('RIFF');
  });

  test('Save As / Export: the renderer\'s extension-enforcing append is approved too (song.flac -> song.flac.wav)', async () => {
    // fileService.saveAsWav:388-390 and exportDocument:447-449 append the
    // format extension when the user retypes a filename with a different one,
    // so the ACTUAL write target is not the string the dialog returned.
    const chosen = path.join(dir, 'song.flac');
    saveDialogResult = { canceled: false, filePath: chosen };
    await handlers['dialog:save']({}, { filters: [{ name: 'Waveform Audio', extensions: ['wav'] }] });

    const actualTarget = `${chosen}.wav`;
    const result = await handlers['file:write']({}, actualTarget, toArrayBuffer('RIFF'));

    expect(result).toEqual({ ok: true });
    expect(fs.readFileSync(actualTarget, 'utf8')).toBe('RIFF');
  });

  test('every export format the app offers is covered by the appended-extension approval', async () => {
    const chosen = path.join(dir, 'mix');
    saveDialogResult = { canceled: false, filePath: chosen };
    await handlers['dialog:save']({}, {});

    for (const ext of ['wav', 'mp3', 'flac', 'ogg', 'audm']) {
      const result = await handlers['file:write']({}, `${chosen}.${ext}`, toArrayBuffer(ext));
      expect(result).toEqual({ ok: true });
    }
  });

  test('a cancelled save dialog approves nothing', async () => {
    saveDialogResult = { canceled: true, filePath: undefined };
    const chosen = await handlers['dialog:save']({}, {});
    expect(chosen).toBeNull();

    const result = await handlers['file:write']({}, path.join(dir, 'take.wav'), toArrayBuffer('x'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not user-approved/);
  });

  test('Save (in place): a dialog:open result is approved for writing, so Save-after-Open works with no second dialog', async () => {
    const target = path.join(dir, 'song.wav');
    fs.writeFileSync(target, 'ORIGINAL');
    openDialogResult = { canceled: false, filePaths: [target] };

    const opened = await handlers['dialog:open']({}, { multi: true });
    expect(opened).toEqual([target]);
    // The read gate is fed by the same call.
    expect(_testing.isReadApproved(target)).toBe(true);

    const result = await handlers['file:write']({}, target, toArrayBuffer('RE-ENCODED'));
    expect(result).toEqual({ ok: true });
    expect(fs.readFileSync(target, 'utf8')).toBe('RE-ENCODED');
  });

  test('Save Session: a .audm dialog:save result is approved', async () => {
    const target = path.join(dir, 'Session 1.audm');
    saveDialogResult = { canceled: false, filePath: target };
    await handlers['dialog:save']({}, { filters: [{ name: 'Auditorium Session', extensions: ['audm'] }] });

    const result = await handlers['file:write']({}, target, toArrayBuffer('{"v":3}'));
    expect(result).toEqual({ ok: true });
  });

  test('approving one path does not approve its siblings, and approval is case-insensitive', async () => {
    const target = path.join(dir, 'Take.WAV');
    saveDialogResult = { canceled: false, filePath: target };
    await handlers['dialog:save']({}, {});

    expect(_testing.isWriteApproved(path.join(dir, 'take.wav'))).toBe(true);
    expect(_testing.isWriteApproved(path.join(dir, 'other.wav'))).toBe(false);
  });

  test('opening a file does NOT approve writing to a sibling with an appended extension', async () => {
    // The appended-extension widening belongs to dialog:save only -- an opened
    // document's in-place Save writes to exactly the path it was opened from.
    const opened = path.join(dir, 'song.flac');
    openDialogResult = { canceled: false, filePaths: [opened] };
    await handlers['dialog:open']({}, {});

    expect(_testing.isWriteApproved(opened)).toBe(true);
    expect(_testing.isWriteApproved(`${opened}.wav`)).toBe(false);
  });
});
