'use strict';

const { isPackagedGateOpen } = require('./prodGate.cjs');

describe('prodGate.isPackagedGateOpen (F23)', () => {
  test('open when the env flag is exactly "1" and the app is unpackaged', () => {
    expect(isPackagedGateOpen(false, '1')).toBe(true);
  });

  test('closed when the app is packaged, regardless of the env flag', () => {
    expect(isPackagedGateOpen(true, '1')).toBe(false);
  });

  test('closed when the env flag is unset', () => {
    expect(isPackagedGateOpen(false, undefined)).toBe(false);
  });

  test('closed when the env flag is present but not exactly "1"', () => {
    expect(isPackagedGateOpen(false, '0')).toBe(false);
    expect(isPackagedGateOpen(false, 'true')).toBe(false);
    expect(isPackagedGateOpen(false, '')).toBe(false);
  });

  test('closed when both packaged and the env flag is unset', () => {
    expect(isPackagedGateOpen(true, undefined)).toBe(false);
  });

  test('fails CLOSED for an undefined isPackaged (unknown state) even with the env flag set (review fix round 1, MINOR 4)', () => {
    // isPackaged is only ever a real boolean in a genuine Electron process
    // (main.cjs) or an explicit test double; an undefined/unknown value
    // (e.g. the require("electron") string-stub shape outside a real
    // Electron process) must never be treated as "safely unpackaged".
    expect(isPackagedGateOpen(undefined, '1')).toBe(false);
    expect(isPackagedGateOpen(null, '1')).toBe(false);
  });

  test('stays open for the real smoke-harness shape: isPackaged strictly false', () => {
    // The scripted/Playwright smoke harness launches `electron .` unpacked,
    // so the real app object reports isPackaged === false -- this exact
    // known-good state must still open the gate.
    expect(isPackagedGateOpen(false, '1')).toBe(true);
  });
});

// main.cjs cannot be require()d outside a real Electron process (it calls
// app.setName/app.whenReady at module scope), so the window-hardening options
// it passes to BrowserWindow are guarded by asserting on its source -- the
// same approach scripts/prod-csp.test.cjs uses for the built CSP.
describe('main.cjs BrowserWindow hardening', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');

  test('devTools are disabled in a PACKAGED build', () => {
    // A packaged app has no legitimate use for DevTools, and leaving them on
    // hands anyone who reaches the renderer a console against the privileged
    // window.electronAPI surface.
    expect(source).toMatch(/devTools:\s*!app\.isPackaged/);
  });

  test('the rest of the renderer sandbox is still asserted alongside it', () => {
    expect(source).toMatch(/nodeIntegration:\s*false/);
    expect(source).toMatch(/contextIsolation:\s*true/);
    expect(source).toMatch(/sandbox:\s*true/);
    expect(source).toMatch(/webSecurity:\s*true/);
  });
});
