'use strict';

const os = require('node:os');
const path = require('node:path');
const {
  isWriteAllowed,
  assertWriteAllowed,
  setAppPaths,
  assertWriteTargetSafe,
  _setPlatformForTests
} = require('./writePathPolicy.cjs');

describe('writePathPolicy', () => {
  beforeEach(() => {
    setAppPaths({ appPath: null, userData: null });
  });

  test('allows a normal absolute path with an allowed extension', () => {
    expect(isWriteAllowed('D:\\music\\out.wav')).toBe(true);
  });

  test('rejects a path inside C:\\Windows', () => {
    expect(isWriteAllowed('C:\\Windows\\evil.wav')).toBe(false);
  });

  test('rejects a relative path', () => {
    expect(isWriteAllowed('foo.wav')).toBe(false);
  });

  test('allows a .audm session file', () => {
    expect(isWriteAllowed('D:\\x\\session.audm')).toBe(true);
  });

  test('rejects a disallowed extension (.exe)', () => {
    expect(isWriteAllowed('D:\\x\\run.exe')).toBe(false);
  });

  test('rejects paths containing ".." traversal segments', () => {
    expect(isWriteAllowed('D:\\music\\..\\Windows\\evil.wav')).toBe(false);
  });

  test('rejects paths inside Program Files', () => {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    expect(isWriteAllowed(path.join(pf, 'SomeApp', 'out.wav'))).toBe(false);
  });

  test('rejects paths inside Program Files (x86)', () => {
    const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    expect(isWriteAllowed(path.join(pfx86, 'SomeApp', 'out.wav'))).toBe(false);
  });

  test('rejects paths inside the injected app installation dir', () => {
    setAppPaths({ appPath: 'D:\\Apps\\Auditorium', userData: 'D:\\Users\\me\\AppData\\Auditorium' });
    expect(isWriteAllowed('D:\\Apps\\Auditorium\\resources\\evil.wav')).toBe(false);
  });

  test('allows paths inside userData (not a forbidden write target)', () => {
    setAppPaths({ appPath: 'D:\\Apps\\Auditorium', userData: 'D:\\Users\\me\\AppData\\Auditorium' });
    expect(isWriteAllowed('D:\\Users\\me\\AppData\\Auditorium\\session.audm')).toBe(true);
  });

  test('extension allow-list check is case-insensitive', () => {
    expect(isWriteAllowed('D:\\music\\OUT.WAV')).toBe(true);
  });

  test('assertWriteAllowed throws for disallowed paths', () => {
    expect(() => assertWriteAllowed('C:\\Windows\\evil.wav')).toThrow();
  });

  test('assertWriteAllowed does not throw for allowed paths', () => {
    expect(() => assertWriteAllowed('D:\\music\\out.wav')).not.toThrow();
  });

  test('rejects the \\\\?\\ extended-length path prefix', () => {
    expect(isWriteAllowed('\\\\?\\C:\\Windows\\evil.wav')).toBe(false);
  });

  test('rejects the \\\\.\\ device path prefix', () => {
    expect(isWriteAllowed('\\\\.\\C:\\x.wav')).toBe(false);
  });

  test('accepts a well-formed UNC network path (server + share + file) (F8)', () => {
    expect(isWriteAllowed('\\\\server\\share\\a.wav')).toBe(true);
  });

  test('rejects a UNC path with only a server component (no share) (F8)', () => {
    expect(isWriteAllowed('\\\\server')).toBe(false);
  });

  test('rejects a UNC path with a trailing-slash server and no share (F8)', () => {
    expect(isWriteAllowed('\\\\server\\')).toBe(false);
  });

  test('assertWriteAllowed does not throw for a well-formed UNC path (F8)', () => {
    expect(() => assertWriteAllowed('\\\\nas\\shared\\music\\out.wav')).not.toThrow();
  });

  test('a well-formed UNC path inside a forbidden dir is still rejected (containment still runs) (F8)', () => {
    setAppPaths({ appPath: '\\\\nas\\apps\\Auditorium', userData: null });
    expect(isWriteAllowed('\\\\nas\\apps\\Auditorium\\evil.wav')).toBe(false);
  });

  test('assertWriteAllowed throws for the \\\\?\\ extended-length path prefix', () => {
    expect(() => assertWriteAllowed('\\\\?\\C:\\Windows\\evil.wav')).toThrow();
  });

  describe('UNC local-alias / admin-share loopback rejection (F8 review fix, CRITICAL 1)', () => {
    test('rejects \\\\localhost\\C$\\... (admin share via localhost loopback)', () => {
      expect(isWriteAllowed('\\\\localhost\\C$\\Windows\\evil.wav')).toBe(false);
    });

    test('rejects \\\\127.0.0.1\\C$\\... (admin share via IPv4 loopback)', () => {
      expect(
        isWriteAllowed('\\\\127.0.0.1\\C$\\Program Files\\Auditorium\\resources\\x.audm')
      ).toBe(false);
    });

    test('rejects \\\\.\\... (already covered by the device-path check, still rejected)', () => {
      expect(isWriteAllowed('\\\\.\\C$\\Windows\\evil.wav')).toBe(false);
    });

    test('rejects a UNC path whose host is this machine\'s own hostname', () => {
      const hostname = os.hostname();
      expect(isWriteAllowed(`\\\\${hostname}\\C$\\Windows\\evil.wav`)).toBe(false);
    });

    test('rejects an admin share ($-suffixed) even on a remote-looking host name', () => {
      expect(isWriteAllowed('\\\\SomeRemoteServer\\C$\\Windows\\evil.wav')).toBe(false);
    });

    test('rejects \\\\localhost\\... even for a normal (non-admin) share name', () => {
      expect(isWriteAllowed('\\\\localhost\\music\\take.wav')).toBe(false);
    });

    test('host matching is case-insensitive (LOCALHOST, C$ variants)', () => {
      expect(isWriteAllowed('\\\\LOCALHOST\\c$\\Windows\\evil.wav')).toBe(false);
      expect(isWriteAllowed('\\\\Server\\C$\\evil.wav')).toBe(false);
    });

    test('a genuine remote NAS share (non-admin share, non-local-alias host) still passes', () => {
      expect(isWriteAllowed('\\\\NAS\\music\\take.wav')).toBe(true);
    });
  });

  describe('UNC loopback bypass, round 2 (review fix round 2: bracketed IPv6, ipv6-literal.net, 127.0.0.0/8, ADMIN$/IPC$)', () => {
    test('rejects \\\\[::1]\\ADMIN$\\... (bracketed IPv6 loopback + ADMIN$ share, the actual demonstrated bypass)', () => {
      expect(isWriteAllowed('\\\\[::1]\\ADMIN$\\Temp\\claude-m4-probe.wav')).toBe(false);
    });

    test('rejects \\\\[::1]\\C$\\...', () => {
      expect(isWriteAllowed('\\\\[::1]\\C$\\Windows\\evil.wav')).toBe(false);
    });

    test('rejects the Windows IPv6-literal UNC encoding \\\\0--1.ipv6-literal.net\\C$\\...', () => {
      expect(isWriteAllowed('\\\\0--1.ipv6-literal.net\\C$\\evil.wav')).toBe(false);
    });

    test('rejects a trailing-dot localhost \\\\localhost.\\C$\\...', () => {
      expect(isWriteAllowed('\\\\localhost.\\C$\\evil.wav')).toBe(false);
    });

    test('rejects any 127.0.0.0/8 loopback address, not just 127.0.0.1', () => {
      expect(isWriteAllowed('\\\\127.0.0.2\\C$\\evil.wav')).toBe(false);
    });

    test('rejects \\\\LOCALHOST\\admin$\\... (case-insensitive host, lowercase admin$)', () => {
      expect(isWriteAllowed('\\\\LOCALHOST\\admin$\\evil.wav')).toBe(false);
    });

    test('rejects any $-suffixed share on a genuinely remote host (IPC$, and a plain backup$) -- rule 1 alone must be sufficient', () => {
      expect(isWriteAllowed('\\\\NAS\\backup$\\evil.wav')).toBe(false);
      expect(isWriteAllowed('\\\\SomeRemoteServer\\IPC$\\evil.wav')).toBe(false);
    });

    test('positive: genuine remote shares (hostname, dotted IPv4, FQDN) still pass, including paths with spaces', () => {
      expect(isWriteAllowed('\\\\NAS\\music\\take.wav')).toBe(true);
      expect(isWriteAllowed('\\\\nas\\shared\\music\\out.wav')).toBe(true);
      expect(isWriteAllowed('\\\\192.168.1.50\\media\\take.mp3')).toBe(true);
      expect(isWriteAllowed('\\\\studio-nas.local\\projects\\session.audm')).toBe(true);
      expect(isWriteAllowed('\\\\NAS\\music\\My Song.wav')).toBe(true); // spaces in a path segment
      expect(isWriteAllowed('\\\\studio-nas.local\\projects\\session name.audm')).toBe(true);
    });

    test('positive: a share name containing (but not ending in) a dollar sign is not treated as an admin share', () => {
      expect(isWriteAllowed('\\\\NAS\\ba$ckup\\take.wav')).toBe(true);
    });
  });

  describe('isUnc derived from the RESOLVED path, not the raw string (review fix round 3, MINOR A)', () => {
    test('rejects a mixed-separator UNC-admin-share form (backslash+forwardslash) that resolves to \\\\localhost\\C$\\...', () => {
      expect(() => assertWriteAllowed('\\/localhost\\C$\\x.wav')).toThrow(
        /local machine or admin share/
      );
    });

    test('rejects a mixed-separator UNC-admin-share form (forwardslash+backslash) that resolves to \\\\localhost\\C$\\...', () => {
      expect(() => assertWriteAllowed('/\\localhost\\C$\\x.wav')).toThrow(
        /local machine or admin share/
      );
    });

    test('the rejection is the local-alias/admin-share reason, not the misleading drive-letter-root reason', () => {
      expect(() => assertWriteAllowed('\\/localhost\\C$\\x.wav')).not.toThrow(
        /drive letter/
      );
    });

    test('existing positives still pass after deriving isUnc from the resolved path', () => {
      expect(isWriteAllowed('\\\\NAS\\music\\take.wav')).toBe(true);
      expect(isWriteAllowed('D:\\music\\out.wav')).toBe(true);
      expect(isWriteAllowed('\\\\studio-nas.local\\projects\\session.audm')).toBe(true);
    });

    test('an incomplete UNC path (no share) with a valid extension is still rejected, not silently reinterpreted as an ordinary same-drive write', () => {
      // path.resolve('\\\\server.wav') silently discards the UNC prefix and
      // returns an ordinary drive-relative path (e.g. 'D:\\server.wav'),
      // which would otherwise sail through the normal drive-letter checks
      // with a valid extension. This must stay rejected as malformed UNC.
      expect(isWriteAllowed('\\\\server.wav')).toBe(false);
      expect(isWriteAllowed('\\\\localhost.wav')).toBe(false);
      expect(() => assertWriteAllowed('\\\\server.wav')).toThrow(/malformed UNC/);
    });
  });

  describe('\\\\?\\UNC\\ extended-length re-entry defeats the raw device-path check (review fix round 4, CRITICAL reopen)', () => {
    test('rejects //?/UNC/localhost/C$/Windows/Temp/x.wav (forward-slash extended-length UNC re-entry)', () => {
      expect(isWriteAllowed('//?/UNC/localhost/C$/Windows/Temp/claude-p4.wav')).toBe(false);
    });

    test('rejects //?/UNC/[::1]/ADMIN$/Temp/x.wav', () => {
      expect(isWriteAllowed('//?/UNC/[::1]/ADMIN$/Temp/claude-p4.wav')).toBe(false);
    });

    test("rejects //?/UNC/<this machine's own hostname>/C$/Windows/Temp/x.wav", () => {
      const hostname = os.hostname();
      expect(isWriteAllowed(`//?/UNC/${hostname}/C$/Windows/Temp/claude-p4.wav`)).toBe(false);
    });

    test('rejects //?/C:/Users/.../x.wav -- a benign-looking destination is STILL denied (the \\\\?\\ prefix itself is the leak, regardless of target)', () => {
      expect(isWriteAllowed('//?/C:/Users/someuser/AppData/Local/Temp/claude-p4.wav')).toBe(false);
    });

    test('rejects //?/UNC/localhost/C$/Program Files/Auditorium/resources/x.audm', () => {
      expect(
        isWriteAllowed('//?/UNC/localhost/C$/Program Files/Auditorium/resources/x.audm')
      ).toBe(false);
    });

    test('rejects the mixed-separator spelling \\/?\\UNC\\localhost\\C$\\x.wav', () => {
      expect(isWriteAllowed('\\/?\\UNC\\localhost\\C$\\x.wav')).toBe(false);
    });

    test('rejects //?/UNC/[::1]/ADMIN$/x.wav (second mixed spelling variant)', () => {
      expect(isWriteAllowed('//?/UNC/[::1]/ADMIN$/x.wav')).toBe(false);
    });

    test('the canonical raw \\\\?\\... form still stays rejected as before (unaffected regression check)', () => {
      expect(isWriteAllowed('\\\\?\\C:\\Users\\someuser\\AppData\\Local\\Temp\\x.wav')).toBe(false);
    });

    test('isLocalAliasOrAdminShareUncPath treats a literal "?" or "UNC" host as unsafe (defense in depth, independent of the device-path re-check)', () => {
      // Exercised indirectly through assertWriteAllowed with a path shaped so
      // it would reach the local-alias check even if the device/extended
      // re-check above were somehow bypassed or skipped by a future change.
      expect(isWriteAllowed('\\\\?\\UNC\\localhost\\C$\\evil.wav')).toBe(false);
    });

    test('round-2/round-3 matrix still holds: alias/$-share/mixed-separator/degenerate attack forms remain rejected', () => {
      expect(isWriteAllowed('\\\\localhost\\C$\\Windows\\evil.wav')).toBe(false);
      expect(isWriteAllowed('\\\\[::1]\\ADMIN$\\Temp\\claude-m4-probe.wav')).toBe(false);
      expect(isWriteAllowed('\\\\0--1.ipv6-literal.net\\C$\\evil.wav')).toBe(false);
      expect(isWriteAllowed('\\\\NAS\\backup$\\evil.wav')).toBe(false);
      expect(isWriteAllowed('\\/localhost\\C$\\x.wav')).toBe(false);
      expect(isWriteAllowed('/\\localhost\\C$\\x.wav')).toBe(false);
      expect(isWriteAllowed('\\\\server.wav')).toBe(false);
    });

    test('all positives still pass', () => {
      expect(isWriteAllowed('\\\\NAS\\music\\take.wav')).toBe(true);
      expect(isWriteAllowed('\\\\nas\\shared\\music\\out.wav')).toBe(true);
      expect(isWriteAllowed('\\\\192.168.1.50\\media\\take.mp3')).toBe(true);
      expect(isWriteAllowed('\\\\studio-nas.local\\projects\\session.audm')).toBe(true);
      expect(isWriteAllowed('D:\\music\\out.wav')).toBe(true);
      expect(isWriteAllowed('\\\\NAS\\ba$ckup\\take.wav')).toBe(true);
    });
  });

  describe('abbreviated-IPv4 loopback forms (review fix round 5: Windows expands 127.1 etc. to 127.0.0.1)', () => {
    test('rejects \\\\127.1\\... (2-part abbreviated form -> 127.0.0.1)', () => {
      expect(isWriteAllowed('\\\\127.1\\share\\a.wav')).toBe(false);
    });

    test('rejects \\\\127.0.1\\... (3-part abbreviated form -> 127.0.0.1)', () => {
      expect(isWriteAllowed('\\\\127.0.1\\share\\a.wav')).toBe(false);
    });

    test('rejects \\\\2130706433\\... (bare 32-bit decimal form of 127.0.0.1)', () => {
      expect(isWriteAllowed('\\\\2130706433\\share\\a.wav')).toBe(false);
    });

    test('rejects \\\\0177.0.0.1\\... (octal first octet -> 127.0.0.1; Windows\' inet_addr accepts C-style octal)', () => {
      expect(isWriteAllowed('\\\\0177.0.0.1\\share\\a.wav')).toBe(false);
    });

    test('positive: a remote host that merely STARTS WITH "127." is not loopback (5 dotted parts, not a valid abbreviated address)', () => {
      expect(isWriteAllowed('\\\\127.0.0.1.example.com\\audio\\take.wav')).toBe(true);
    });

    test('positive: an ordinary dotted-IPv4 remote host still passes', () => {
      expect(isWriteAllowed('\\\\192.168.1.50\\media\\take.mp3')).toBe(true);
    });

    test('positive: a plain NetBIOS hostname still passes', () => {
      expect(isWriteAllowed('\\\\NAS\\music\\take.wav')).toBe(true);
    });

    test('positive: another ordinary dotted-IPv4 remote host still passes', () => {
      expect(isWriteAllowed('\\\\10.0.0.5\\audio\\take.flac')).toBe(true);
    });
  });

  describe('trailing dot/space host & share bypass, and the UNC-named-NAS false positive (v1.9.1 security fix)', () => {
    // Pre-fix normalizeUncHost stripped exactly ONE trailing dot, so a host
    // wearing two-or-more trailing dots (or a trailing space) escaped the
    // loopback-alias refusal unrecognized. Measured ALLOWED at HEAD before the
    // fix: \\localhost..\music\x.wav, \\127.0.0.1..\music\x.wav, \\NAS\C$.\...
    // The boundary is "number of trailing dots": pinned at 0 / 1 / 2 / 3.
    test('boundary 0 dots: bare \\\\localhost\\music\\x.wav stays rejected', () => {
      expect(isWriteAllowed('\\\\localhost\\music\\x.wav')).toBe(false);
    });
    test('boundary 1 dot: \\\\localhost.\\music\\x.wav stays rejected (old strip count)', () => {
      expect(isWriteAllowed('\\\\localhost.\\music\\x.wav')).toBe(false);
    });
    test('boundary 2 dots: \\\\localhost..\\music\\x.wav now rejected (the reported bypass)', () => {
      expect(isWriteAllowed('\\\\localhost..\\music\\x.wav')).toBe(false);
    });
    test('boundary 3 dots: \\\\localhost...\\music\\x.wav now rejected', () => {
      expect(isWriteAllowed('\\\\localhost...\\music\\x.wav')).toBe(false);
    });
    test('rejects a trailing-SPACE loopback host \\\\localhost \\music\\x.wav', () => {
      expect(isWriteAllowed('\\\\localhost \\music\\x.wav')).toBe(false);
    });
    test('rejects a mixed trailing dot+space loopback host \\\\localhost. \\music\\x.wav', () => {
      expect(isWriteAllowed('\\\\localhost. \\music\\x.wav')).toBe(false);
    });
    test('rejects a double-dot 127.0.0.1 loopback \\\\127.0.0.1..\\music\\x.wav', () => {
      expect(isWriteAllowed('\\\\127.0.0.1..\\music\\x.wav')).toBe(false);
    });
    test('rejects an abbreviated-IPv4 loopback wearing trailing dots \\\\127.1..\\share\\a.wav', () => {
      expect(isWriteAllowed('\\\\127.1..\\share\\a.wav')).toBe(false);
    });
    test("rejects this machine's own hostname wearing trailing dots on a NON-$ share", () => {
      const hostname = os.hostname();
      expect(isWriteAllowed(`\\\\${hostname}..\\music\\x.wav`)).toBe(false);
    });
    // Share side of the same class: Windows strips trailing dots/spaces from a
    // share name too, so \\host\C$.\... resolves to the C$ admin share while the
    // bare /\$$/ saw the dot/space, not the '$' -- ALLOWED before the fix.
    test('rejects an admin share wearing a trailing dot \\\\NAS\\C$.\\evil.wav', () => {
      expect(isWriteAllowed('\\\\NAS\\C$.\\evil.wav')).toBe(false);
    });
    test('rejects an admin share wearing two trailing dots \\\\NAS\\ADMIN$..\\evil.wav', () => {
      expect(isWriteAllowed('\\\\NAS\\ADMIN$..\\evil.wav')).toBe(false);
    });
    test('rejects an admin share wearing a trailing space \\\\NAS\\C$ \\evil.wav', () => {
      expect(isWriteAllowed('\\\\NAS\\C$ \\evil.wav')).toBe(false);
    });
    test('positive: a MID-string dollar with a trailing dot is NOT an admin share (\\\\NAS\\ba$ckup.\\take.wav)', () => {
      expect(isWriteAllowed('\\\\NAS\\ba$ckup.\\take.wav')).toBe(true);
    });
    // Bracketed-IPv6 + trailing-dot stays rejected via the INDEPENDENT ADS colon
    // gate (any ':' past index 1); pinned so a future reorder cannot open it.
    test('rejects a bracketed IPv6 loopback wearing a trailing dot \\\\[::1].\\music\\x.wav', () => {
      expect(isWriteAllowed('\\\\[::1].\\music\\x.wav')).toBe(false);
    });
    // Degenerate all-dots host: normalizes to '' (no local-alias match, no
    // throw) -> an ordinary unknown remote host. A $-share on it is still
    // refused, fail-closed.
    test('an all-dots host does not throw, and a $-share on it is still refused', () => {
      expect(() => isWriteAllowed('\\\\...\\music\\x.wav')).not.toThrow();
      expect(isWriteAllowed('\\\\...\\C$\\evil.wav')).toBe(false);
    });
    // Sibling nit: a legitimate remote NAS literally named UNC was refused by a
    // dead defensive arm; the \\?\UNC\... re-entry it guarded is already
    // rejected upstream by the device/extended-path checks.
    test('positive: a remote NAS literally named UNC is now allowed \\\\UNC\\music\\take.wav', () => {
      expect(isWriteAllowed('\\\\UNC\\music\\take.wav')).toBe(true);
    });
    test('positive: case-insensitive UNC-named host is allowed \\\\unc\\share\\a.wav', () => {
      expect(isWriteAllowed('\\\\unc\\share\\a.wav')).toBe(true);
    });
    test('the \\\\?\\UNC\\localhost\\C$\\... re-entry stays rejected (device/extended check, not the dropped arm)', () => {
      expect(isWriteAllowed('\\\\?\\UNC\\localhost\\C$\\evil.wav')).toBe(false);
      expect(isWriteAllowed('//?/UNC/localhost/C$/Windows/Temp/x.wav')).toBe(false);
    });
    test('positive: ordinary remote shares still pass unchanged', () => {
      expect(isWriteAllowed('\\\\NAS\\music\\take.wav')).toBe(true);
      expect(isWriteAllowed('\\\\studio-nas.local\\projects\\session.audm')).toBe(true);
      expect(isWriteAllowed('D:\\music\\out.wav')).toBe(true);
    });
  });

  describe('NTFS alternate-data-stream targets (v1.5.2)', () => {
    // 'C:\x\evil.exe:payload.wav' names an ADS on evil.exe. It passes the
    // extension check (extname sees '.wav') and every containment check, and
    // the write then fails EINVAL at the atomic rename -- but only AFTER the
    // temp-file create has already materialised a 0-byte evil.exe. Any ':'
    // past the drive-letter position (resolved index 1) is never legitimate:
    // a drive path's own colon sits at index 1, and a UNC path has no drive
    // colon at all.
    test('rejects an ADS target whose visible extension is allowed (evil.exe:payload.wav)', () => {
      expect(isWriteAllowed('C:\\Users\\x\\evil.exe:payload.wav')).toBe(false);
    });

    test('rejects an ADS on an otherwise-allowed audio file (take.wav:alt.wav)', () => {
      expect(isWriteAllowed('D:\\music\\take.wav:alt.wav')).toBe(false);
    });

    test('rejects an ADS on a well-formed UNC network path', () => {
      expect(isWriteAllowed('\\\\NAS\\music\\take.wav:ads.wav')).toBe(false);
    });

    test('assertWriteAllowed names the ADS reason', () => {
      expect(() => assertWriteAllowed('C:\\Users\\x\\evil.exe:payload.wav')).toThrow(
        /alternate data stream/
      );
    });

    test('positive: the drive-letter colon itself (index 1) is untouched', () => {
      expect(isWriteAllowed('D:\\music\\out.wav')).toBe(true);
      expect(isWriteAllowed('C:\\Users\\x\\take.wav')).toBe(true);
    });

    test('positive: UNC paths without a colon are untouched', () => {
      expect(isWriteAllowed('\\\\NAS\\music\\take.wav')).toBe(true);
    });
  });

  test('rejects extensions removed from the allow-list (F24: .txt, .json, .aud)', () => {
    expect(isWriteAllowed('D:\\x\\notes.txt')).toBe(false);
    expect(isWriteAllowed('D:\\x\\config.json')).toBe(false);
    expect(isWriteAllowed('D:\\x\\legacy.aud')).toBe(false);
  });
});

describe('writePathPolicy platform gate', () => {
  beforeEach(() => {
    setAppPaths({ appPath: null, userData: null });
  });

  afterEach(() => {
    _setPlatformForTests(process.platform);
  });

  test('isWriteAllowed returns false on non-Windows platforms for an otherwise-valid path', () => {
    _setPlatformForTests('linux');
    expect(isWriteAllowed('D:\\music\\out.wav')).toBe(false);
  });

  test('assertWriteAllowed throws on non-Windows platforms', () => {
    _setPlatformForTests('linux');
    expect(() => assertWriteAllowed('D:\\music\\out.wav')).toThrow();
  });

  test('restoring the platform to win32 re-allows a valid path', () => {
    _setPlatformForTests('linux');
    expect(isWriteAllowed('D:\\music\\out.wav')).toBe(false);
    _setPlatformForTests('win32');
    expect(isWriteAllowed('D:\\music\\out.wav')).toBe(true);
  });
});

describe('assertWriteTargetSafe', () => {
  beforeEach(() => {
    setAppPaths({ appPath: null, userData: null });
  });

  test('throws when the write target itself is an existing symlink', () => {
    const fakeFs = {
      existsSync: (p) => p === 'D:\\music\\out.wav',
      lstatSync: () => ({ isSymbolicLink: () => true }),
      realpathSync: { native: (p) => p }
    };
    expect(() => assertWriteTargetSafe('D:\\music\\out.wav', fakeFs)).toThrow();
  });

  test('throws when the nearest existing ancestor directory realpaths into a forbidden dir', () => {
    const fakeFs = {
      existsSync: (p) => p === 'D:\\music',
      lstatSync: () => ({ isSymbolicLink: () => false }),
      realpathSync: { native: (p) => (p === 'D:\\music' ? 'C:\\Windows' : p) }
    };
    expect(() => assertWriteTargetSafe('D:\\music\\sub\\out.wav', fakeFs)).toThrow();
  });

  test('passes for a normal path with no symlinks involved', () => {
    const fakeFs = {
      existsSync: (p) => p === 'D:\\music',
      lstatSync: () => ({ isSymbolicLink: () => false }),
      realpathSync: { native: (p) => p }
    };
    expect(() => assertWriteTargetSafe('D:\\music\\out.wav', fakeFs)).not.toThrow();
  });
});
