'use strict';

// dialog:* opts validation (v1.5.2): the renderer-supplied opts are forwarded
// into REAL OS chrome (showOpenDialog/showSaveDialog/showMessageBox), so a
// compromised renderer must not be able to render arbitrary content there.
// These tests pin the sanitised shape that actually reaches Electron's dialog
// module: enums from an allow-list, arrays bounded to the expected primitive
// shapes, strings length-capped (truncated, never rejected -- a long decode
// error message must still produce its dialog), unknown keys dropped -- and
// every legitimate call-site shape (fileService, menuActions, sessionFile,
// effectRunner and friends) passing through intact.

let messageBoxResult = { response: 2 };
let saveDialogResult = { canceled: true };
let openDialogResult = { canceled: true, filePaths: [] };

jest.doMock('electron', () => ({
  ipcMain: { handle: jest.fn(), on: jest.fn() },
  dialog: {
    showOpenDialog: jest.fn(async () => openDialogResult),
    showSaveDialog: jest.fn(async () => saveDialogResult),
    showMessageBox: jest.fn(async () => messageBoxResult),
  },
  app: { isPackaged: true, getVersion: () => '0.0.0' },
}));

const { registerIpc } = require('./ipc.cjs');
const { dialog, ipcMain } = require('electron');

registerIpc(() => ({ isDestroyed: () => false, on: jest.fn(), webContents: {} }));

const handlers = {};
for (const [channel, fn] of ipcMain.handle.mock.calls) {
  handlers[channel] = fn;
}

/** The opts object the handler actually forwarded on the mock's last call
 * (arg 0 is the BrowserWindow, arg 1 the dialog options). */
function forwarded(mockFn) {
  const calls = mockFn.mock.calls;
  return calls[calls.length - 1][1];
}

beforeEach(() => {
  messageBoxResult = { response: 2 };
  saveDialogResult = { canceled: true };
  openDialogResult = { canceled: true, filePaths: [] };
});

describe('dialog:message opts validation', () => {
  test('a legitimate close-prompt shape passes through intact and the response is returned', async () => {
    // closeDocumentFlow (fileService.ts:516) -- the app's only buttons user.
    const response = await handlers['dialog:message']({}, {
      type: 'question',
      title: 'Unsaved changes',
      message: 'Save changes to take.wav before closing?',
      buttons: ['Save', "Don't Save", 'Cancel'],
    });
    expect(response).toBe(2);
    const opts = forwarded(dialog.showMessageBox);
    expect(opts.type).toBe('question');
    expect(opts.title).toBe('Unsaved changes');
    expect(opts.message).toBe('Save changes to take.wav before closing?');
    expect(opts.buttons).toEqual(['Save', "Don't Save", 'Cancel']);
  });

  test('a legitimate error shape (no buttons) passes through intact', async () => {
    await handlers['dialog:message']({}, { type: 'error', title: 'Save failed', message: 'disk full' });
    const opts = forwarded(dialog.showMessageBox);
    expect(opts.type).toBe('error');
    expect(opts.title).toBe('Save failed');
    expect(opts.message).toBe('disk full');
    expect(opts.buttons).toBeUndefined();
  });

  test('a type outside the allow-list falls back to info', async () => {
    await handlers['dialog:message']({}, { type: 'evil-custom-type', message: 'x' });
    expect(forwarded(dialog.showMessageBox).type).toBe('info');
  });

  test("Electron's own 'none' type is still outside the renderer's contract and falls back to info", async () => {
    await handlers['dialog:message']({}, { type: 'none', message: 'x' });
    expect(forwarded(dialog.showMessageBox).type).toBe('info');
  });

  test('a non-string type (object/array injection) falls back to info', async () => {
    await handlers['dialog:message']({}, { type: { toString: () => 'question' }, message: 'x' });
    expect(forwarded(dialog.showMessageBox).type).toBe('info');
  });

  test('unknown keys are dropped -- only the five expected keys ever reach the OS dialog', async () => {
    // `defaultId` joined the contract with the failed-write "Save As..." offer
    // (O1-3/M3), so the accepted set is five, not four. `detail`,
    // `checkboxLabel`, `icon` and `cancelId` are still refused.
    await handlers['dialog:message']({}, {
      message: 'x',
      detail: 'spoofed detail text',
      checkboxLabel: 'evil checkbox',
      icon: 'C:\\anything.png',
      cancelId: 0,
    });
    const opts = forwarded(dialog.showMessageBox);
    expect(Object.keys(opts).sort()).toEqual(['buttons', 'defaultId', 'message', 'title', 'type']);
  });

  describe('defaultId (which button Enter activates)', () => {
    test('an in-range index passes through', async () => {
      await handlers['dialog:message']({}, {
        message: 'Write denied (protected directory)',
        buttons: ['Save As…', 'Cancel'],
        defaultId: 1,
      });
      expect(forwarded(dialog.showMessageBox).defaultId).toBe(1);
    });

    test('an index past the end of the button list is dropped', async () => {
      // Sanitized against the buttons that SURVIVED cleanButtons, so it can
      // never name a button that is not there.
      await handlers['dialog:message']({}, {
        message: 'x',
        buttons: ['Save As…', 'Cancel'],
        defaultId: 7,
      });
      expect(forwarded(dialog.showMessageBox).defaultId).toBeUndefined();
    });

    test('an index that only survives because a non-string button was dropped is refused', async () => {
      // cleanButtons removes the object, leaving one button; index 1 no longer
      // exists and must not be forwarded.
      await handlers['dialog:message']({}, {
        message: 'x',
        buttons: ['Only', { evil: true }],
        defaultId: 1,
      });
      const opts = forwarded(dialog.showMessageBox);
      expect(opts.buttons).toEqual(['Only']);
      expect(opts.defaultId).toBeUndefined();
    });

    test('a negative, fractional, or non-numeric index is dropped', async () => {
      for (const defaultId of [-1, 0.5, '1', null, { valueOf: () => 1 }, NaN, Infinity]) {
        await handlers['dialog:message']({}, {
          message: 'x',
          buttons: ['Save As…', 'Cancel'],
          defaultId,
        });
        expect(forwarded(dialog.showMessageBox).defaultId).toBeUndefined();
      }
    });

    test('an index with no buttons at all is dropped', async () => {
      await handlers['dialog:message']({}, { message: 'x', defaultId: 0 });
      expect(forwarded(dialog.showMessageBox).defaultId).toBeUndefined();
    });
  });

  test('an overlong message is truncated, not rejected', async () => {
    await handlers['dialog:message']({}, { message: 'm'.repeat(100000) });
    const opts = forwarded(dialog.showMessageBox);
    expect(opts.message.length).toBeLessThanOrEqual(2000);
    expect(opts.message.startsWith('mmm')).toBe(true);
  });

  test('a non-string message becomes an empty string rather than crashing the dialog', async () => {
    await handlers['dialog:message']({}, { message: { injected: true } });
    expect(forwarded(dialog.showMessageBox).message).toBe('');
  });

  test('buttons: capped in count, non-string entries dropped, overlong labels truncated', async () => {
    const buttons = Array.from({ length: 50 }, (_, i) => `B${i}`);
    buttons[1] = { evil: true };
    buttons[2] = 'L'.repeat(5000);
    await handlers['dialog:message']({}, { message: 'x', buttons });
    const opts = forwarded(dialog.showMessageBox);
    expect(opts.buttons.length).toBeLessThanOrEqual(10);
    for (const b of opts.buttons) {
      expect(typeof b).toBe('string');
      expect(b.length).toBeLessThanOrEqual(2000);
    }
  });

  test('a non-array buttons value is dropped', async () => {
    await handlers['dialog:message']({}, { message: 'x', buttons: 'Save' });
    expect(forwarded(dialog.showMessageBox).buttons).toBeUndefined();
  });

  test('non-object opts do not throw and produce a safe default dialog', async () => {
    await expect(handlers['dialog:message']({}, 'just a string')).resolves.toBe(2);
    const opts = forwarded(dialog.showMessageBox);
    expect(opts.type).toBe('info');
    expect(opts.message).toBe('');
  });
});

describe('dialog:save opts validation', () => {
  test('a legitimate Save As shape passes through intact', async () => {
    await handlers['dialog:save']({}, {
      defaultPath: 'song.wav',
      filters: [{ name: 'Waveform Audio', extensions: ['wav'] }],
    });
    const opts = forwarded(dialog.showSaveDialog);
    expect(opts.defaultPath).toBe('song.wav');
    expect(opts.filters).toEqual([{ name: 'Waveform Audio', extensions: ['wav'] }]);
  });

  test('unknown keys are dropped -- only defaultPath and filters ever reach the OS dialog', async () => {
    await handlers['dialog:save']({}, {
      defaultPath: 'a.wav',
      properties: ['showHiddenFiles'],
      nameFieldLabel: 'spoof',
      message: 'spoofed macOS sheet text',
      securityScopedBookmarks: true,
    });
    const opts = forwarded(dialog.showSaveDialog);
    expect(Object.keys(opts).sort()).toEqual(['defaultPath', 'filters']);
  });

  test('a non-string defaultPath is dropped and an overlong one is truncated', async () => {
    await handlers['dialog:save']({}, { defaultPath: { evil: true } });
    expect(forwarded(dialog.showSaveDialog).defaultPath).toBeUndefined();

    await handlers['dialog:save']({}, { defaultPath: 'p'.repeat(10000) });
    expect(forwarded(dialog.showSaveDialog).defaultPath.length).toBeLessThanOrEqual(1024);
  });

  test('malformed filter entries are dropped; a non-array filters value is dropped entirely', async () => {
    await handlers['dialog:save']({}, {
      filters: [
        { name: 5, extensions: ['wav'] }, // non-string name
        { name: 'no extensions array' }, // missing extensions
        { name: 'ok', extensions: ['wav', 7, 'mp3'] }, // non-string extension dropped
        'not an object',
      ],
    });
    expect(forwarded(dialog.showSaveDialog).filters).toEqual([
      { name: 'ok', extensions: ['wav', 'mp3'] },
    ]);

    await handlers['dialog:save']({}, { filters: 'wav' });
    expect(forwarded(dialog.showSaveDialog).filters).toBeUndefined();
  });

  test('filter list and per-filter extension list are bounded', async () => {
    const filters = Array.from({ length: 100 }, (_, i) => ({
      name: `F${i}`,
      extensions: Array.from({ length: 100 }, (_, j) => `e${j}`),
    }));
    await handlers['dialog:save']({}, { filters });
    const opts = forwarded(dialog.showSaveDialog);
    expect(opts.filters.length).toBeLessThanOrEqual(10);
    for (const f of opts.filters) {
      expect(f.extensions.length).toBeLessThanOrEqual(20);
    }
  });
});

describe('dialog:open opts validation', () => {
  test('the legitimate multi-open shape passes through: filters intact, multiSelections enabled', async () => {
    // openFilesViaDialog (fileService.ts:242).
    await handlers['dialog:open']({}, {
      multi: true,
      filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm'] }],
    });
    const opts = forwarded(dialog.showOpenDialog);
    expect(opts.filters).toEqual([
      { name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm'] },
    ]);
    expect(opts.properties).toEqual(['openFile', 'multiSelections']);
  });

  test('multi must be literally true -- truthy junk does not enable multi-select', async () => {
    await handlers['dialog:open']({}, { multi: 'yes' });
    expect(forwarded(dialog.showOpenDialog).properties).toEqual(['openFile']);
  });

  test('unknown keys are dropped -- only filters and properties ever reach the OS dialog', async () => {
    await handlers['dialog:open']({}, {
      filters: [{ name: 'Auditorium Session', extensions: ['audm'] }],
      properties: ['openDirectory', 'showHiddenFiles'], // renderer must not steer properties
      message: 'spoofed macOS sheet text',
      defaultPath: 'C:\\somewhere',
    });
    const opts = forwarded(dialog.showOpenDialog);
    expect(Object.keys(opts).sort()).toEqual(['filters', 'properties']);
    expect(opts.properties).toEqual(['openFile']);
  });
});
