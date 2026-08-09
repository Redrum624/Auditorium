'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

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
 * exclude \\?\ / \\.\ forms on its own. Takes the RESOLVED path (see
 * assertWriteAllowed) -- callers must have already confirmed it starts with
 * '\\\\' before calling this.
 */
function isWellFormedUncPath(uncPath) {
  const components = uncPath.slice(2).split(/[\\/]+/).filter(Boolean);
  return components.length >= 2;
}

/**
 * True when rawPath's first two characters are BOTH path separators (any mix
 * of '\' and '/') -- i.e. it superficially looks like it starts a UNC path,
 * before any resolution/normalization happens.
 */
function rawStartsWithUncPrefix(rawPath) {
  return /^[\\/]{2}/.test(rawPath);
}

// Hosts that always mean "this machine," regardless of what a hostname
// string superficially looks like. '.' is included for documentation/
// defense-in-depth even though a UNC path literally starting \\.\ is already
// intercepted by isDeviceOrExtendedPath before this is ever consulted.
const LOCAL_ALIAS_HOSTS = new Set(['localhost', '.', '::1']);

/**
 * Strips the trailing dots and whitespace that Windows silently removes from a
 * path component during Win32 -> NT canonicalization (CreateFile drops trailing
 * dots and spaces from the last component and from share/host names). Without
 * this, a decorated spelling like `localhost..`, `localhost ` or a share `C$.`
 * / `C$ ` slips past the loopback-alias / admin-share refusals while still
 * resolving to the very target they forbid.
 *
 * EXACT behaviour of the regex, stated precisely because this is a
 * security-critical normalisation: `/[.\s]+$/` removes a trailing run of ASCII
 * dots AND every character JS `\s` matches -- space, tab, CR, LF, NBSP
 * (U+00A0), the ideographic space (U+3000), U+FEFF, and the rest of that
 * class. That is NOT the full Unicode White_Space set (R2-3c, v1.9.2): the
 * one White_Space=Yes character `\s` does NOT match is U+0085 (NEL), so an
 * NEL-decorated host survives the strip un-normalised (measured; the only
 * other asymmetry is U+FEFF, which `\s` matches despite White_Space=No).
 * Verified non-exploitable: Windows canonicalizes away only {dot, U+0020}
 * here, so an NEL-decorated spelling never resolves to the loopback or
 * admin-share target these refusals guard -- NEL simply stays part of a
 * hostname that resolves to nothing local. The strip is still intentionally
 * WIDER than that exact {dot, space} set Windows itself canonicalizes away.
 * Fail closed: we
 * refuse what we cannot confidently classify, whether or not this particular
 * Windows/DNS config resolves the decorated form (v1.9.1 security fix). No
 * legitimate host or share ends in whitespace, so nothing real is caught; every
 * stripped whitespace class resolves to REFUSED.
 *
 * Anchored to the END only -- a leading/interior dot is a real, meaningful
 * character (`127.0.0.1`, an FQDN).
 *
 * DEGENERATE case, KNOWN and deliberately left as-is (not a false positive):
 * a component that is ALL dots/whitespace collapses to '', which then matches
 * no local alias and no `$` share -- an ordinary non-loopback classification,
 * never a throw. So `\\...\music\x.wav` is ALLOWED, as if `music` were a share
 * on a remote host named ''. That is safe, and there is no reachable failure
 * behind it: it is NOT a local device path -- the dangerous `\\.\music`
 * "open the device named music" form is a DEVICE path caught by
 * isDeviceOrExtendedPath long before this runs -- and the one genuinely
 * dangerous shape on such a host, a `$`-suffixed share, is refused
 * independently by isDollarSuffixedShare. Do NOT "fix" the '' host into a hard
 * refusal: it would be a false positive with no attack behind it.
 */
function stripTrailingDotsAndSpaces(component) {
  return component.replace(/[.\s]+$/, '');
}

/**
 * Normalizes a raw UNC host component before the alias lookup (review fix
 * round 2, GAP A): strips IPv6 bracket-literal notation (\\[::1]\...), strips
 * ALL trailing dots/spaces (FQDN root-dot notation \\localhost.\..., and the
 * v1.9.1 fix for the multi-dot/space bypass \\localhost..\... / \\localhost \...
 * which the prior single-dot strip let through unrecognized), and lowercases.
 * The bracket strip stays FIRST (a bracketed IPv6 literal has no trailing dot
 * to remove; any colon it carries is caught independently by the ADS gate).
 * '127.0.0.1' alone is NOT sufficient -- see isLocal127Address below for the
 * full 127.0.0.0/8 range.
 */
function normalizeUncHost(rawHost) {
  let host = rawHost;
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  host = stripTrailingDotsAndSpaces(host);
  return host.toLowerCase();
}

/**
 * Parses one dot-separated component of an abbreviated-IPv4 host string
 * using Windows' inet_addr numeral rules: a leading '0x'/'0X' is hex, a
 * leading '0' followed by more digits is legacy C-style octal (Windows'
 * inet_addr accepts this -- e.g. '0177' === 127 decimal), anything else is
 * plain decimal. Returns null when `str` isn't a valid numeral under any of
 * those rules (e.g. contains a letter outside a hex body, or an invalid
 * octal digit like '8'/'9') -- the caller treats that as "not an address at
 * all" rather than guessing.
 */
function parseAbbreviatedIPv4Component(str) {
  if (/^0x[0-9a-f]+$/i.test(str)) {
    return parseInt(str, 16);
  }
  if (/^0[0-7]+$/.test(str)) {
    return parseInt(str, 8);
  }
  if (/^(?:0|[1-9]\d*)$/.test(str)) {
    return parseInt(str, 10);
  }
  return null;
}

/**
 * True when `host` names a loopback (127.0.0.0/8) address under Windows'
 * ABBREVIATED IPv4 host rules (review fix round 5, GAP: the prior check only
 * matched the exact 4-octet dotted form, so '\\127.1\...' -- which Windows'
 * inet_addr expands to 127.0.0.1 -- sailed through unrecognized). Like
 * classic BSD inet_aton, Windows accepts 1-, 2-, 3- and 4-part dotted host
 * forms: every part before the last is exactly one octet, and the LAST part
 * absorbs however many octets the earlier parts didn't claim (so 'a.b' is
 * octet1=a, octets2-4=b as a 24-bit value; a bare single numeral is the
 * entire 32-bit address in one go). Each part may be decimal, octal
 * (leading zero), or hex (leading 0x) -- see parseAbbreviatedIPv4Component.
 * A host with more than 4 dot-separated parts, or any part that fails to
 * parse or is out of range for its position, is not a valid abbreviated
 * IPv4 address at all and is left alone as an ordinary hostname -- this is
 * what correctly excludes '127.0.0.1.example.com' (5 parts) from matching.
 */
function isLocal127Address(host) {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return false;

  const values = parts.map(parseAbbreviatedIPv4Component);
  if (values.some((v) => v === null)) return false;

  // Every part but the last is exactly one octet (0-255).
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i] < 0 || values[i] > 255) return false;
  }

  // The last part absorbs whatever bits the earlier parts didn't claim: all
  // 32 bits for a single bare numeral, down to just the low 8 for the
  // standard 4-part dotted form.
  const lastBits = 32 - (values.length - 1) * 8;
  const last = values[values.length - 1];
  if (last < 0 || last > 2 ** lastBits - 1) return false;

  // Only the resulting address's first octet matters for 127.0.0.0/8
  // membership: for a 2-4 part form the first part IS that octet already;
  // for the 1-part form it's the top 8 bits of the 32-bit value.
  const firstOctet = values.length === 1 ? Math.floor(values[0] / 2 ** 24) : values[0];
  return firstOctet === 127;
}

/** True for Windows' UNC encoding of an IPv6 literal address
 * (<address-with-dashes-for-colons>.ipv6-literal.net) -- ANY address in this
 * form is treated as local, not just the loopback one, since this app has no
 * legitimate use for addressing a share by raw IPv6 literal. */
function isIpv6LiteralHost(host) {
  return host.endsWith('.ipv6-literal.net');
}

/** True when `host` (the first UNC path component, already normalized)
 * resolves to THIS machine -- a fixed alias, this machine's own hostname, a
 * 127.0.0.0/8 loopback literal, or an ipv6-literal.net encoding. */
function isLocalAliasHost(rawHost) {
  const host = normalizeUncHost(rawHost);
  return (
    LOCAL_ALIAS_HOSTS.has(host) ||
    host === os.hostname().toLowerCase() ||
    isLocal127Address(host) ||
    isIpv6LiteralHost(host)
  );
}

/**
 * True when `share` (the second UNC path component) ends in '$' -- ANY
 * dollar-suffixed share (C$, D$, ADMIN$, IPC$, or a custom hidden share),
 * regardless of host (review fix round 2, GAP B: the original pattern only
 * matched single-LETTER admin shares like C$/D$, missing ADMIN$ and IPC$,
 * which are real shares on a real Windows machine). No legitimate audio/
 * session save target is a '$'-suffixed share, so rejecting all of them is
 * strictly safe, not merely a narrower "admin share" heuristic.
 */
function isDollarSuffixedShare(share) {
  // v1.9.1: normalize the trailing dots/spaces Windows strips before the '$'
  // test -- \\host\C$.\... and \\host\C$ \... resolve to the C$ admin share,
  // but the bare /\$$/ saw the dot/space and not the '$'. Same "handles one,
  // not N" bypass as the host side (stripTrailingDotsAndSpaces).
  return /\$$/.test(stripTrailingDotsAndSpaces(share));
}

/**
 * CRITICAL (F8 review fix, rounds 1-2): a UNC path can name THIS machine
 * under a loopback alias (\\localhost\..., \\127.0.0.1\..., \\[::1]\...,
 * \\0--1.ipv6-literal.net\..., \\<own-hostname>\...) or reach a local drive
 * root directly via a '$'-suffixed share (\\anyhost\C$\..., \\anyhost\ADMIN$\...).
 * Both forms resolve to the exact same filesystem the drive-letter checks
 * already protect, but as a UNC string they match none of the forbidden-dir
 * prefixes (which are drive-letter-rooted) -- and `fs.realpathSync.native`
 * returns the UNC form unchanged, so assertWriteTargetSafe's realpath
 * containment re-check doesn't catch it either. A real network share is
 * never a local-alias host and never a '$'-suffixed share, so both forms are
 * rejected outright rather than attempting to map them back to a drive
 * letter for containment (simpler and strictly safer). The two checks are
 * independent -- either one alone is sufficient to catch a given attack
 * spelling; this function ORs them for defense in depth. Takes the RESOLVED
 * path (see assertWriteAllowed) -- callers must already know it's a
 * well-formed UNC path (isWellFormedUncPath) before calling this.
 */
function isLocalAliasOrAdminShareUncPath(uncPath) {
  const [host, share] = uncPath.slice(2).split(/[\\/]+/).filter(Boolean);
  // Defense in depth (review fix round 4): a literal '?' or 'UNC' as the
  // first component means this is actually a \\?\UNC\server\share\...
  // extended-length re-entry into UNC-space, not a plain \\server\share\...
  // path -- the REAL host/share sit two positions further in, which this
  // function's positional host/share assumption can't see. The
  // device/extended-path re-check in assertWriteAllowed should already have
  // rejected this shape outright before this function is ever reached; this
  // is a backstop against the positional assumption silently drifting again
  // if that ordering ever changes, or a new caller doesn't guarantee it.
  // v1.9.1: only the literal '?' arm is kept. The former `|| host === 'unc'`
  // arm was a false positive -- it refused a legitimate remote NAS literally
  // named UNC (\\UNC\music\take.wav) while adding no real protection: a genuine
  // \\?\UNC\server\share\... re-entry is a device/extended path that
  // assertWriteAllowed's raw-string AND resolved-path checks (isDeviceOrExtendedPath)
  // already reject outright before this function is ever reached ('?' is itself
  // an illegal Windows host/share char, so the '?' arm covers the residual
  // shape). Do NOT reintroduce a components[1] === 'UNC' shape check -- it would
  // re-break \\server\UNC\... style shares.
  if (host === '?') {
    return true;
  }
  return isLocalAliasHost(host) || isDollarSuffixedShare(share);
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

  // Resolve BEFORE deciding whether this is a UNC path (review fix round 3,
  // MINOR A): a raw '\\\\'-prefix check misses mixed-separator forms like
  // '\/localhost\C$\...' or '/\localhost\C$\...', which Node still resolves
  // to a genuine '\\localhost\C$\...' UNC path -- those forms used to skip
  // the local-alias/$-share checks entirely and fail closed only by
  // accident (via the unrelated, misleading drive-letter-root assertion).
  // Deriving isUnc from the SAME resolved string every later check uses
  // closes that gap: the check that runs always matches the path that
  // actually gets written.
  const resolved = path.resolve(rawPath);

  // SECOND device/extended-path check, now against the RESOLVED path (review
  // fix round 4, CRITICAL reopen): a \\?\... or \\.\... prefix spelled with
  // forward or mixed separators (e.g. '//?/UNC/localhost/C$/Windows/Temp/x.wav')
  // evades the raw-string check above -- which only recognizes the literal
  // backslash spelling -- but Node's path.resolve normalizes it right back
  // into a genuine \\?\... string. That resolved string then satisfies the
  // isUnc check below (it starts with '\\\\'), skipping the drive-letter-root
  // assertion, while the \\?\ prefix ALSO defeats the plain forbidden-dir
  // containment further down (the resolved string doesn't textually match
  // 'C:\Windows\...' etc. at all -- it's shaped '\\?\C:\Windows\...' or
  // '\\?\UNC\host\share\...') and the local-alias/$-share check (whose real
  // host/share sit two positions further in, past the literal '?'/'UNC'
  // markers -- see isLocalAliasOrAdminShareUncPath's own defensive check for
  // that shape). Re-run the exact same device/extended check the raw string
  // already had to run, this time against what actually gets written --
  // this alone catches every \\?\... re-entry regardless of what it points
  // to, benign-looking or not.
  if (isDeviceOrExtendedPath(resolved)) {
    throw new Error(`Write denied: extended-length/device paths are not allowed: ${rawPath}`);
  }

  const isUnc = resolved.startsWith('\\\\');

  // An INCOMPLETE UNC path (no share component, e.g. '\\\\server' or
  // '\\\\server.wav') is not a valid UNC root at all: Node's path.resolve
  // silently discards the '\\\\' entirely and re-resolves it as an ordinary
  // same-drive path (e.g. 'D:\\server.wav') instead of leaving it UNC-shaped.
  // Left unchecked, that would let raw input that LOOKS like a UNC reference
  // quietly fall through as a normal drive-letter write. Reject outright
  // whenever the raw string looked like it was starting a UNC path but the
  // resolved form isn't UNC anymore.
  if (rawStartsWithUncPrefix(rawPath) && !isUnc) {
    throw new Error(`Write denied: malformed UNC path (need \\\\server\\share\\...): ${rawPath}`);
  }

  // A well-formed UNC network path (\\server\share\...) is a legitimate save
  // target (F8: users can open from a NAS, they must be able to save back
  // too) but has no drive letter, so it skips the drive-letter-root
  // assertion below; every other check (traversal, extension, forbidden-dir
  // containment, assertWriteTargetSafe) still runs against it. (This check is
  // a defensive backstop: empirically, resolve() never leaves a '\\\\'-prefixed
  // result with fewer than 2 real components -- see the check above -- but
  // fail-closed philosophy keeps it rather than assume that's exhaustive.)
  if (isUnc && !isWellFormedUncPath(resolved)) {
    throw new Error(`Write denied: malformed UNC path (need \\\\server\\share\\...): ${rawPath}`);
  }

  // CRITICAL (F8 review fix): reject a UNC path that loops back to this
  // machine (localhost/127.0.0.1/::1/own-hostname) or uses an administrative
  // share (C$, D$, ...) BEFORE containment -- see isLocalAliasOrAdminShareUncPath.
  if (isUnc && isLocalAliasOrAdminShareUncPath(resolved)) {
    throw new Error(
      `Write denied: UNC path resolves to a local machine or admin share, not a real network location: ${rawPath}`
    );
  }

  // Reject NTFS alternate-data-stream (ADS) targets (v1.5.2): any ':' past
  // the drive-letter position (index 1) of the RESOLVED path. A path like
  // 'C:\x\evil.exe:payload.wav' names an ADS on evil.exe -- it passes the
  // extension check below (extname sees '.wav') and every containment check,
  // and the write then fails EINVAL at the atomic rename, but only AFTER the
  // temp-file create has already materialised a 0-byte evil.exe. A drive
  // path's own colon sits exactly at index 1; a well-formed UNC path has no
  // drive colon at all, so a colon at index >= 2 is never legitimate. (This
  // also rejects bracket-IPv6 UNC hosts like '\\[2001:db8::1]\share\...' --
  // deliberate: as with ipv6-literal.net hosts, a raw-IPv6-addressed share is
  // no legitimate save target for this app, and the policy fails closed.)
  if (resolved.indexOf(':', 2) !== -1) {
    throw new Error(`Write denied: NTFS alternate data stream targets are not allowed: ${rawPath}`);
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
