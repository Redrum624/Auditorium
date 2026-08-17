'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { cleanDir, REPO_ROOT } = require('./clean-release.cjs');

describe('cleanDir safety', () => {
  test('refuses to delete a path outside the repo', () => {
    expect(() => cleanDir('..')).toThrow(/outside the repo/);
    expect(() => cleanDir(path.join('..', '..', 'somewhere'))).toThrow(/outside the repo/);
  });

  test('refuses to delete the repo root itself', () => {
    expect(() => cleanDir('.')).toThrow(/outside the repo/);
    expect(() => cleanDir(REPO_ROOT)).toThrow(/outside the repo/);
  });

  test('deletes a directory that resolves inside the repo', () => {
    const scratch = path.join(REPO_ROOT, `.clean-release-test-${process.pid}`);
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, 'f.txt'), 'x');
    expect(fs.existsSync(scratch)).toBe(true);

    const removed = cleanDir(path.basename(scratch));
    expect(removed).toBe(scratch);
    expect(fs.existsSync(scratch)).toBe(false);
  });

  test('is a no-op (no throw) when the target does not exist', () => {
    expect(() => cleanDir(`.does-not-exist-${process.pid}`)).not.toThrow();
  });
});
