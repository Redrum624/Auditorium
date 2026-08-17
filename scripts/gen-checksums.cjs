'use strict';

// Writes release/SHA256SUMS.txt covering every distributable of the current
// version: the NSIS installer, the portable exe and the plain-text README.
// Runs at the end of `build:win` — after gen-readme-txt.cjs, because the
// README.txt it hashes is generated there (photo_app convention, extended to
// cover the README since that file ships in the release too).
//
// Format is the standard `sha256sum` layout — one `<hash>  <filename>` line
// (two spaces) per file — verifiable on Windows with:
//   CertUtil -hashfile "Auditorium Setup <version>.exe" SHA256
// or cross-platform with `sha256sum -c SHA256SUMS.txt`.
//
// Fails closed: a missing expected distributable exits non-zero, so a build
// that silently dropped an artifact can never ship a sums file that pretends
// otherwise.
//
// Run: node scripts/gen-checksums.cjs

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..');

/** The three files every release ships, named for `version`. */
function expectedTargets(version) {
  return [
    `Auditorium Setup ${version}.exe`,
    `Auditorium ${version} portable.exe`,
    `Auditorium ${version} README.txt`,
  ];
}

/**
 * Hashes each of `targets` inside `dir`. Returns `lines` in sha256sum format
 * for the files that exist and `missing` for the ones that do not — the caller
 * decides whether missing is fatal (the CLI below treats it as fatal).
 */
function computeChecksums(dir, targets) {
  const lines = [];
  const missing = [];
  for (const name of targets) {
    const full = path.join(dir, name);
    if (!fs.existsSync(full)) {
      missing.push(name);
      continue;
    }
    const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    lines.push(`${hash}  ${name}`);
  }
  return { lines, missing };
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const releaseDir = path.join(REPO_ROOT, 'release');
  const targets = expectedTargets(pkg.version);

  const { lines, missing } = computeChecksums(releaseDir, targets);
  for (const line of lines) console.log(`[gen-checksums] ${line}`);
  for (const name of missing) console.error(`[gen-checksums] MISSING: ${name}`);

  if (missing.length > 0) {
    console.error(`[gen-checksums] ${missing.length} expected distributable(s) absent — run the build first.`);
    process.exit(1);
  }

  const outPath = path.join(releaseDir, 'SHA256SUMS.txt');
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  console.log(`[gen-checksums] ${lines.length} hashes -> ${path.relative(REPO_ROOT, outPath)}`);
}

if (require.main === module) {
  main();
}

module.exports = { expectedTargets, computeChecksums };
