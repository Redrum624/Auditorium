'use strict';

const fs = require('node:fs');
const path = require('node:path');

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
);

describe('package.json metadata consumed by the Windows installer', () => {
  // electron-builder's NSIS template passes `description` verbatim as the
  // shortcut comment (CreateShortCut ... "${APP_DESCRIPTION}"). A comment
  // past the shell-link limit corrupts the .lnk's icon-location field, so
  // the desktop and start-menu shortcuts render the blank default icon
  // (observed on v1.35.0: IconLocation held a slice of the description).
  test('description stays under the 260-char shell-link comment limit', () => {
    expect(typeof pkg.description).toBe('string');
    expect(pkg.description.length).toBeGreaterThan(0);
    expect(pkg.description.length).toBeLessThan(260);
  });

  test('description is plain ASCII (embedded into NSIS defines and PE version info)', () => {
    expect(pkg.description).toMatch(/^[\x20-\x7E]+$/);
  });

  test('the shortcut and shell identity fields are pinned', () => {
    expect(pkg.build.win.icon).toBe('assets/icon.ico');
    expect(pkg.build.nsis.shortcutName).toBe('Auditorium');
    expect(pkg.productName).toBe('Auditorium');
  });
});
