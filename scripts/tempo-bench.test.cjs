'use strict';

// R4: pins that the tempo-bench DRIVER (the .cjs entry, TS require hook and
// all) actually runs out-of-process, is byte-for-byte deterministic across
// two invocations, and rejects a bogus family selection instead of silently
// measuring nothing. The classifier/bank/vacuity logic is pinned at the TS
// level in src/dsp/__fixtures__/tempoBench.test.ts — this file tests the
// runnable shape those tests cannot reach.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DRIVER = path.join(ROOT, 'scripts', 'tempo-bench.cjs');

function runDriver(args) {
  return execFileSync(process.execPath, [DRIVER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('tempo-bench.cjs driver', () => {
  let tmpDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-bench-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    'two invocations over the same subset write BYTE-IDENTICAL reports',
    () => {
      const out1 = path.join(tmpDir, 'run1.json');
      const out2 = path.join(tmpDir, 'run2.json');
      runDriver([`--out=${out1}`, '--families=click,atempo', '--limit-per-family=2']);
      runDriver([`--out=${out2}`, '--families=click,atempo', '--limit-per-family=2']);

      const bytes1 = fs.readFileSync(out1);
      const bytes2 = fs.readFileSync(out2);
      expect(bytes1.equals(bytes2)).toBe(true);

      const report = JSON.parse(bytes1.toString('utf8'));
      expect(report.fixtureCount).toBe(4); // 2 click + 2 atempo
      expect(report.rows).toHaveLength(4);
      const { correct, octave, other } = report.aggregate;
      expect(correct + octave + other).toBe(4);
      // Self-describing identity fields a diff of two result files relies on.
      expect(typeof report.bankVersion).toBe('string');
      expect(report.sampleRate).toBe(44100);
      expect(typeof report.tolerancePct).toBe('number');
    },
    240000
  );

  it(
    'rejects an unknown --families value with a non-zero exit',
    () => {
      expect(() => runDriver(['--families=bogus', `--out=${path.join(tmpDir, 'x.json')}`])).toThrow(
        /unknown family/
      );
    },
    120000
  );
});
