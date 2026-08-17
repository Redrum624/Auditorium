'use strict';

// Removes the electron-builder output directory (release/) before a fresh build.
// Fails closed: refuses to delete anything that resolves outside the repo root,
// so a bad argument can never rimraf a parent directory.
//
// Run: node scripts/clean-release.cjs

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Recursively delete `target` (relative to the repo root or absolute), but only
 * when it resolves strictly inside REPO_ROOT. Returns the resolved path removed.
 * Throws if the target escapes the repo or equals the repo root itself.
 */
function cleanDir(target) {
  const resolved = path.resolve(REPO_ROOT, target);
  const rel = path.relative(REPO_ROOT, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to delete a path outside the repo: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  return resolved;
}

function cleanRelease() {
  return cleanDir('release');
}

if (require.main === module) {
  const removed = cleanRelease();
  console.log(`Cleaned ${path.relative(REPO_ROOT, removed)}/`);
}

module.exports = { cleanDir, cleanRelease, REPO_ROOT };
