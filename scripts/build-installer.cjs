'use strict';

// Runs electron-builder for the Windows x64 NSIS target with TEMP/TMP repointed
// to %LOCALAPPDATA%\Temp. On Windows, real-time AV scanning of the default temp
// path frequently locks files electron-builder is unpacking, causing spurious
// EBUSY/EPERM failures; the local-appdata temp is quieter (photo_app convention).
//
// Run: node scripts/build-installer.cjs

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const tempDir = path.join(localAppData, 'Temp');
fs.mkdirSync(tempDir, { recursive: true });

const env = { ...process.env, TEMP: tempDir, TMP: tempDir };

console.log(`Building installer (TEMP=${tempDir}) ...`);
const result = spawnSync('npx electron-builder --win --x64', {
  cwd: REPO_ROOT,
  env,
  stdio: 'inherit',
  shell: true,
});

if (result.error) {
  console.error('Failed to launch electron-builder:', result.error);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
