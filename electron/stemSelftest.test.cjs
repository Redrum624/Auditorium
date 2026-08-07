'use strict';

/**
 * Tests for the stem-host self-test (electron/stemSelftest.cjs) — the logic
 * the packaged-app proof driver relies on. The manager is faked here; the
 * real-ORT, real-packaged path is exercised by scripts/stem-packaged-proof.cjs.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runStemSelftest, parseStemSelftestArgs } = require('./stemSelftest.cjs');
const { STRIDE_SAMPLES, STEM_COUNT, MODEL_CHANNELS } = require('./stemSegmentation.cjs');

// The happy path synthesises and scans a full 7.8 s segment (~2 M floats) —
// milliseconds alone, but a fully-loaded parallel `npm test` can starve a
// worker past Jest's 5 s default.
jest.setTimeout(60000);

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stem-selftest-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const fakeApp = () => ({ isPackaged: true, getPath: () => tmpDir });

describe('parseStemSelftestArgs', () => {
  test('null when the switch is absent', () => {
    expect(parseStemSelftestArgs(['app.exe'])).toBeNull();
    expect(parseStemSelftestArgs(['app.exe', '--other'])).toBeNull();
  });

  test('parses out path and optional model path (values may contain =)', () => {
    expect(
      parseStemSelftestArgs(['app.exe', '--stem-selftest-out=C:\\out\\v=1.json', '--stem-model=D:\\m.onnx'])
    ).toEqual({ outPath: 'C:\\out\\v=1.json', modelPath: 'D:\\m.onnx' });
    expect(parseStemSelftestArgs(['app.exe', '--stem-selftest-out=o.json'])).toEqual({
      outPath: 'o.json',
      modelPath: undefined,
    });
  });
});

describe('runStemSelftest', () => {
  test('happy path: verdict ok, exit code 0', async () => {
    const outPath = path.join(tmpDir, 'verdict.json');
    const managerFactory = () => ({
      startSeparation: async ({ channels, onProgress, onStems }) => {
        const total = channels[0].length;
        expect(total).toBe(STRIDE_SAMPLES);
        onProgress({ segment: 1, totalSegments: 1 });
        onStems({ offset: 0, samples: total, data: new Float32Array(STEM_COUNT * MODEL_CHANNELS * total) });
        return { ok: true, totalSegments: 1 };
      },
      dispose: () => {},
    });
    const code = await runStemSelftest({ app: fakeApp(), outPath, managerFactory });
    expect(code).toBe(0);
    const verdict = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(verdict.ok).toBe(true);
    expect(verdict.packaged).toBe(true);
    expect(verdict.totalSegments).toBe(1);
    expect(verdict.progressEvents).toBe(1);
    expect(verdict.stemSamplesCovered).toBe(STRIDE_SAMPLES);
    expect(verdict.allFinite).toBe(true);
    expect(verdict.error).toBeNull();
  });

  test('separation failure: verdict carries the error, exit code 1', async () => {
    const outPath = path.join(tmpDir, 'verdict.json');
    const managerFactory = () => ({
      startSeparation: async () => ({ ok: false, error: 'model verification failed (sha256: ...)' }),
      dispose: () => {},
    });
    const code = await runStemSelftest({ app: fakeApp(), outPath, managerFactory });
    expect(code).toBe(1);
    const verdict = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain('sha256');
  });

  test('incomplete stem coverage fails even when the run reports ok', async () => {
    const outPath = path.join(tmpDir, 'verdict.json');
    const managerFactory = () => ({
      startSeparation: async ({ onProgress, onStems }) => {
        onProgress({ segment: 1, totalSegments: 1 });
        onStems({ offset: 0, samples: 10, data: new Float32Array(STEM_COUNT * MODEL_CHANNELS * 10) });
        return { ok: true, totalSegments: 1 };
      },
      dispose: () => {},
    });
    const code = await runStemSelftest({ app: fakeApp(), outPath, managerFactory });
    expect(code).toBe(1);
    const verdict = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(verdict.error).toMatch(/covered 10 of/);
  });

  test('a hung separation times out, disposes the manager, exit code 1', async () => {
    const outPath = path.join(tmpDir, 'verdict.json');
    let disposed = false;
    const managerFactory = () => ({
      startSeparation: () => new Promise(() => {}), // never settles
      dispose: () => {
        disposed = true;
      },
    });
    const code = await runStemSelftest({ app: fakeApp(), outPath, managerFactory, timeoutMs: 50 });
    expect(code).toBe(1);
    expect(disposed).toBe(true);
    const verdict = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(verdict.error).toMatch(/timed out/);
  });

  test('a thrown error still writes a verdict (never a silent empty file)', async () => {
    const outPath = path.join(tmpDir, 'verdict.json');
    const managerFactory = () => {
      throw new Error('factory exploded');
    };
    const code = await runStemSelftest({ app: fakeApp(), outPath, managerFactory });
    expect(code).toBe(1);
    const verdict = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(verdict.error).toContain('factory exploded');
  });
});
