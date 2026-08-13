'use strict';

// preload.cjs runs `contextBridge.exposeInMainWorld` at module scope, so it is
// loaded here against a mocked 'electron' and the exposed API object is
// captured from that call -- the same jest.doMock + resetModules shape
// ipc.prodGate.test.cjs uses.

function loadPreload(invokeImpl) {
  jest.resetModules();
  const exposed = new Map();
  jest.doMock('electron', () => ({
    contextBridge: {
      exposeInMainWorld: (name, api) => exposed.set(name, api),
    },
    ipcRenderer: {
      invoke: invokeImpl,
      on: jest.fn(),
      send: jest.fn(),
      removeListener: jest.fn(),
    },
  }));
  // preload.cjs ends by deleting the CommonJS leftovers off `window`; in a
  // real sandboxed preload that global exists, so stand one up here.
  global.window = {};
  require('./preload.cjs');
  return exposed.get('electronAPI');
}

afterEach(() => {
  jest.dontMock('electron');
  jest.resetModules();
  delete global.window;
});

describe('electronAPI.readFile does not copy the file a second time', () => {
  test('an exact-size view is handed on as its own buffer, with no copy', async () => {
    // What the IPC structured clone actually produces: a Uint8Array that owns
    // its whole ArrayBuffer. Slicing it here doubled the renderer's peak
    // footprint for every file opened -- 137 MB for a 68 MB WAV, before decode
    // had allocated one sample.
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const api = loadPreload(async () => bytes);

    const result = await api.readFile('D:\\audio\\song.wav');

    expect(result).toBe(bytes.buffer); // identity: the same buffer, not a copy
    expect(new Uint8Array(result)).toEqual(bytes);
  });

  test('an OFFSET view is still copied out, so the caller gets only its bytes', async () => {
    // The case the slice was written for: a view into a larger (e.g. pooled)
    // buffer. Handing that buffer on would expose the neighbouring bytes and
    // report the wrong length, so this one has to copy.
    const pool = new Uint8Array([9, 9, 1, 2, 3, 4, 9, 9]);
    const view = pool.subarray(2, 6);
    const api = loadPreload(async () => view);

    const result = await api.readFile('D:\\audio\\song.wav');

    expect(result).not.toBe(pool.buffer);
    expect(result.byteLength).toBe(4);
    expect(Array.from(new Uint8Array(result))).toEqual([1, 2, 3, 4]);
  });

  test('a view that is short of its buffer is copied out too', async () => {
    // byteOffset 0 but not the whole buffer -- the length has to be honoured.
    const pool = new Uint8Array([1, 2, 3, 4, 9, 9, 9, 9]);
    const view = pool.subarray(0, 4);
    const api = loadPreload(async () => view);

    const result = await api.readFile('D:\\audio\\song.wav');

    expect(result).not.toBe(pool.buffer);
    expect(result.byteLength).toBe(4);
    expect(Array.from(new Uint8Array(result))).toEqual([1, 2, 3, 4]);
  });

  test('an empty file round-trips as a zero-length buffer', async () => {
    const bytes = new Uint8Array(0);
    const api = loadPreload(async () => bytes);

    const result = await api.readFile('D:\\audio\\empty.wav');

    expect(result.byteLength).toBe(0);
  });
});
