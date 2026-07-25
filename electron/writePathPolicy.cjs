'use strict';

const path = require('node:path');
const fs = require('node:fs');

// Exactly what the app writes via file:write (F24). The atomic-write '.tmp'
// suffix (atomicWrite.cjs) is handled entirely internally and is never
// checked against this list -- it's never accepted as renderer input.
const ALLOWED_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.ogg', '.audm']);

let appPaths = { appPath: null, userData: null };
let currentPlatform = process.platform;

/**
 * Test-injection / startup hook. In production, main.cjs calls this once at
 * startup with app.getAppPath() and app.getPath('userData'). userData is NOT
 * a forbidden write target -- only the app installation dir and system dirs are.
 */
function setAppPaths({ appPath = null, userData = null } = {}) {
  appPaths = { appPath, userData };
}

/**
 * Test-injection hook for process.platform. Production code never calls this;
 * currentPlatform always starts as the real process.platform.
 */
function _setPlatformForTests(platform) {
  currentPlatform = platform;
}

/**
 * True when rawPath uses a Windows extended-length prefix (\\?\...) or a
 * device-path prefix (\\.\...). Both bypass the drive-letter-rooted
 * containment checks below entirely (\\?\ paths skip normalization; \\.\
 * paths address a raw device, not a filesystem path at all), so they are
 * rejected outright before any other check runs. A well-formed UNC network
 * path (\\server\share\...) is NOT one of these -- see isWellFormedUncPath
 * (F8): real network shares must remain writable.
 */
function isDeviceOrExtendedPath(rawPath) {
  return rawPath.startsWith('\\\\?\\') || rawPath.startsWith('\\\\.\\');
}

/**
 * True for a well-formed UNC network path: \\server\share\... with at least
 * a server AND a share component. A bare \\server (no share) or a lone \\ is
 * malformed and rejected outright -- there is no drive-letter root to fall
 * back to for such a path, so it can't be safely evaluated further (F8).
 * Callers must check isDeviceOrExtendedPath first; this function does not
 * exclude \\?\ / \\.\ forms on its own.
 */
function isWellFormedUncPath(rawPath) {
  if (!rawPath.startsWith('\\\\')) return false;
  const components = rawPath.slice(2).split(/[\\/]+/).filter(Boolean);
  return components.length >= 2;
}

function resolveLower(p) {
  return path.resolve(p).toLowerCase();
}

function isInside(resolvedTarget, dir) {
  if (!dir) return false;
  const t = resolvedTarget.toLowerCase();
  const d = resolveLower(dir);
  return t === d || t.startsWith(d + path.sep);
}

function forbiddenDirs() {
  return [
    appPaths.appPath,
    'C:\\Windows',
    process.env['ProgramFiles'] || 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  ].filter(Boolean);
}

/**
 * Throws when a write to absPath is not allowed. Fails closed: any
 * unrecognized or ambiguous input is rejected.
 */
function assertWriteAllowed(rawPath) {
  // Fail closed off-Windows. This app ships as a Windows-only NSIS build and
  // every check below (drive-letter roots, C:\Windows, Program Files) is
  // Windows-specific; a future cross-platform port must revisit this gate.
  if (currentPlatform !== 'win32') {
    throw new Error('Write denied: unsupported platform (this app is Windows-only)');
  }

  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new Error('Write denied: path must be a non-empty string');
  }

  // Reject Windows extended-length (\\?\...) and device (\\.\...) path forms
  // before any other check runs -- these bypass drive-letter-rooted
  // normalization entirely (F8).
  if (isDeviceOrExtendedPath(rawPath)) {
    throw new Error(`Write denied: extended-length/device paths are not allowed: ${rawPath}`);
  }

  // A well-formed UNC network path (\\server\share\...) is a legitimate save
  // target (F8: users can open from a NAS, they must be able to save back
  // too) but has no drive letter, so it skips the drive-letter-root
  // assertion below; every other check (traversal, extension, forbidden-dir
  // containment, assertWriteTargetSafe) still runs against it.
  const isUnc = rawPath.startsWith('\\\\');
  if (isUnc && !isWellFormedUncPath(rawPath)) {
    throw new Error(`Write denied: malformed UNC path (need \\\\server\\share\\...): ${rawPath}`);
  }

  if (!path.isAbsolute(rawPath)) {
    throw new Error(`Write denied: path is not absolute: ${rawPath}`);
  }

  const segments = rawPath.split(/[\\/]+/);
  if (segments.includes('..')) {
    throw new Error(`Write denied: path traversal ("..") is not allowed: ${rawPath}`);
  }

  const ext = path.extname(rawPath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Write denied: extension not in the allow-list: ${ext || '(none)'}`);
  }

  const resolved = path.resolve(rawPath);

  if (!isUnc) {
    const root = path.parse(resolved).root;
    if (!/^[A-Za-z]:\\$/.test(root)) {
      throw new Error(`Write denied: path root is not a plain drive letter: ${rawPath}`);
    }
  }

  const resolvedLower = resolved.toLowerCase();
  for (const dir of forbiddenDirs()) {
    if (isInside(resolvedLower, dir)) {
      throw new Error(`Write denied: path is inside a protected directory (${dir}): ${rawPath}`);
    }
  }
}

/**
 * Symlink/TOCTOU guard, run after assertWriteAllowed just before the actual
 * write. Two checks:
 *  1. If absPath itself already exists and is a symlink, refuse (a symlink
 *     could point anywhere, bypassing the string-based checks above).
 *  2. Walk up to the nearest EXISTING ancestor directory, resolve it with
 *     the OS-native realpath (following any symlinks in the chain), re-join
 *     the non-existing tail segments, and re-run the forbidden-dir
 *     containment check against that real path -- catches a parent
 *     directory that is itself a symlink into a protected location.
 *
 * fsImpl is injectable for unit tests; production callers use the real
 * node:fs module (the default).
 */
function assertWriteTargetSafe(absPath, fsImpl = fs) {
  if (fsImpl.existsSync(absPath)) {
    const stat = fsImpl.lstatSync(absPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Write denied: target is a symlink: ${absPath}`);
    }
  }

  const remainingSegments = [];
  let dir = path.dirname(absPath);
  while (!fsImpl.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root without finding an existing dir
    remainingSegments.unshift(path.basename(dir));
    dir = parent;
  }

  const realDir = fsImpl.realpathSync.native(dir);
  const rejoined = path.join(realDir, ...remainingSegments, path.basename(absPath));

  for (const forbidden of forbiddenDirs()) {
    if (isInside(rejoined, forbidden)) {
      throw new Error(`Write denied: resolved real path is inside a protected directory (${forbidden}): ${absPath}`);
    }
  }
}

function isWriteAllowed(absPath) {
  try {
    assertWriteAllowed(absPath);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  isWriteAllowed,
  assertWriteAllowed,
  setAppPaths,
  assertWriteTargetSafe,
  _setPlatformForTests
};
