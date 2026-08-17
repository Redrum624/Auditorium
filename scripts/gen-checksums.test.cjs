'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { expectedTargets, computeChecksums } = require('./gen-checksums.cjs');

describe('expectedTargets', () => {
  test('names the three distributables of a version, all version-stamped', () => {
    expect(expectedTargets('1.34.0')).toEqual([
      'Auditorium Setup 1.34.0.exe',
      'Auditorium 1.34.0 portable.exe',
      'Auditorium 1.34.0 README.txt',
    ]);
  });
});

describe('computeChecksums', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-checksums-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('emits standard sha256sum lines — <hash><two spaces><filename>', () => {
    const content = Buffer.from('portable payload');
    fs.writeFileSync(path.join(dir, 'App 1.0.0 portable.exe'), content);

    const { lines, missing } = computeChecksums(dir, ['App 1.0.0 portable.exe']);

    const hash = crypto.createHash('sha256').update(content).digest('hex');
    expect(lines).toEqual([`${hash}  App 1.0.0 portable.exe`]);
    expect(missing).toEqual([]);
  });

  test('reports absent files as missing instead of hashing nothing silently', () => {
    fs.writeFileSync(path.join(dir, 'present.txt'), 'x');

    const { lines, missing } = computeChecksums(dir, ['present.txt', 'absent.exe']);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^[0-9a-f]{64} {2}present\.txt$/);
    expect(missing).toEqual(['absent.exe']);
  });
});
