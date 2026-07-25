'use strict';

const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteFile } = require('./atomicWrite.cjs');

describe('atomicWriteFile (F2)', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditorium-atomic-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('writes the buffer to the target path', async () => {
    const target = path.join(dir, 'out.wav');
    await atomicWriteFile(target, Buffer.from('hello'));
    expect(fs.readFileSync(target, 'utf8')).toBe('hello');
  });

  test('overwrites an existing file atomically (no O_TRUNC window)', async () => {
    const target = path.join(dir, 'out.wav');
    fs.writeFileSync(target, 'ORIGINAL-LONGER-CONTENT');
    await atomicWriteFile(target, Buffer.from('new'));
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
  });

  test('leaves no leftover temp files after a successful write', async () => {
    const target = path.join(dir, 'out.wav');
    await atomicWriteFile(target, Buffer.from('data'));
    expect(fs.readdirSync(dir)).toEqual(['out.wav']);
  });

  test('the temp file is a sibling of the target sharing its directory and ends in .tmp', async () => {
    const target = path.join(dir, 'sub.wav');
    let capturedTempPath = null;
    const fsImpl = {
      open: async (p, flag) => {
        capturedTempPath = p;
        return fsp.open(p, flag);
      },
      unlink: fsp.unlink,
      rename: fsp.rename,
    };
    await atomicWriteFile(target, Buffer.from('x'), fsImpl);
    expect(path.dirname(capturedTempPath)).toBe(dir);
    expect(capturedTempPath.startsWith(target + '.')).toBe(true);
    expect(capturedTempPath.endsWith('.tmp')).toBe(true);
  });

  test('opens the temp file with the exclusive "wx" flag, not "w" (review fix round 1, MINOR 3: refuses to open through a pre-planted file/symlink at a predictable name)', async () => {
    const target = path.join(dir, 'out.wav');
    let capturedFlag = null;
    const fsImpl = {
      open: async (p, flag) => {
        capturedFlag = flag;
        return fsp.open(p, flag);
      },
      unlink: fsp.unlink,
      rename: fsp.rename,
    };
    await atomicWriteFile(target, Buffer.from('x'), fsImpl);
    expect(capturedFlag).toBe('wx');
  });

  test('the temp filename includes an unpredictable random component in addition to pid/seq (review fix round 1, MINOR 3)', async () => {
    const target = path.join(dir, 'out.wav');
    let capturedTempPath = null;
    const fsImpl = {
      open: async (p, flag) => {
        capturedTempPath = p;
        return fsp.open(p, flag);
      },
      unlink: fsp.unlink,
      rename: fsp.rename,
    };
    await atomicWriteFile(target, Buffer.from('x'), fsImpl);
    const base = path.basename(capturedTempPath);
    expect(base).toMatch(/^out\.wav\.\d+\.\d+\.[0-9a-f]{8}\.tmp$/);
    expect(path.dirname(capturedTempPath)).toBe(dir); // still the same parent dir
  });

  test('a rename failure leaves the original file untouched and cleans up the temp file', async () => {
    const target = path.join(dir, 'out.wav');
    fs.writeFileSync(target, 'ORIGINAL');
    const fsImpl = {
      open: (...args) => fsp.open(...args),
      unlink: (...args) => fsp.unlink(...args),
      rename: async () => {
        throw new Error('injected rename failure');
      },
    };

    await expect(atomicWriteFile(target, Buffer.from('CORRUPT'), fsImpl)).rejects.toThrow(
      'injected rename failure'
    );

    expect(fs.readFileSync(target, 'utf8')).toBe('ORIGINAL'); // untouched
    expect(fs.readdirSync(dir)).toEqual(['out.wav']); // temp file cleaned up
  });

  test('an open failure propagates and there is nothing left to clean up', async () => {
    const target = path.join(dir, 'out.wav');
    const fsImpl = {
      open: async () => {
        throw new Error('injected open failure');
      },
      unlink: fsp.unlink,
      rename: fsp.rename,
    };
    await expect(atomicWriteFile(target, Buffer.from('x'), fsImpl)).rejects.toThrow(
      'injected open failure'
    );
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('an open failure does not attempt to unlink anything -- nothing was created by us (review fix round 2, MINOR 3)', async () => {
    const target = path.join(dir, 'out.wav');
    const unlinkSpy = jest.fn((...args) => fsp.unlink(...args));
    const fsImpl = {
      open: async () => {
        throw new Error('injected open failure');
      },
      unlink: unlinkSpy,
      rename: fsp.rename,
    };
    await expect(atomicWriteFile(target, Buffer.from('x'), fsImpl)).rejects.toThrow(
      'injected open failure'
    );
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  test('a fsync failure closes the handle, leaves the original untouched, and cleans up the temp file', async () => {
    const target = path.join(dir, 'out.wav');
    fs.writeFileSync(target, 'ORIGINAL');
    const fsImpl = {
      open: async (p, flag) => {
        const fh = await fsp.open(p, flag);
        return {
          writeFile: fh.writeFile.bind(fh),
          sync: async () => {
            throw new Error('injected fsync failure');
          },
          close: fh.close.bind(fh),
        };
      },
      unlink: fsp.unlink,
      rename: fsp.rename,
    };
    await expect(atomicWriteFile(target, Buffer.from('CORRUPT'), fsImpl)).rejects.toThrow(
      'injected fsync failure'
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('ORIGINAL');
    expect(fs.readdirSync(dir)).toEqual(['out.wav']);
  });

  test('a cleanup unlink failure (temp already gone) does not mask the original error', async () => {
    const target = path.join(dir, 'out.wav');
    fs.writeFileSync(target, 'ORIGINAL');
    const fsImpl = {
      open: (...args) => fsp.open(...args),
      unlink: async () => {
        throw new Error('unlink also failed');
      },
      rename: async () => {
        throw new Error('injected rename failure');
      },
    };
    await expect(atomicWriteFile(target, Buffer.from('CORRUPT'), fsImpl)).rejects.toThrow(
      'injected rename failure'
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('ORIGINAL');
  });

  test('concurrent writes to the same target use distinct temp filenames', async () => {
    const target = path.join(dir, 'race.wav');
    const seen = [];
    const fsImpl = {
      open: async (p, flag) => {
        seen.push(p);
        return fsp.open(p, flag);
      },
      unlink: fsp.unlink,
      rename: fsp.rename,
    };
    await Promise.all([
      atomicWriteFile(target, Buffer.from('a'), fsImpl),
      atomicWriteFile(target, Buffer.from('b'), fsImpl),
    ]);
    expect(new Set(seen).size).toBe(2);
  });
});
