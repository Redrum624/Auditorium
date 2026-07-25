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
