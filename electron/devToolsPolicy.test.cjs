'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { shouldAutoOpenDevTools } = require('./devToolsPolicy.cjs');

describe('shouldAutoOpenDevTools', () => {
  test('opens for a dev run from source (VITE_DEV_SERVER=1, unpackaged)', () => {
    expect(
      shouldAutoOpenDevTools({ isPackaged: false, viteDevServer: '1', auditoriumTest: undefined })
    ).toBe(true);
  });

  test('does NOT open in a packaged build, even with VITE_DEV_SERVER=1 in its env', () => {
    // Same fail-closed stance as every other escape hatch (F23): an env var
    // must never be able to switch dev behaviour on inside an installer.
    expect(
      shouldAutoOpenDevTools({ isPackaged: true, viteDevServer: '1', auditoriumTest: undefined })
    ).toBe(false);
  });

  test('does NOT open for an unpackaged run that is not a dev run', () => {
    // `electron .` against the built bundle -- e.g. the smoke harness, or a
    // developer checking the production build. No dev server, no console.
    expect(
      shouldAutoOpenDevTools({ isPackaged: false, viteDevServer: undefined, auditoriumTest: undefined })
    ).toBe(false);
    expect(
      shouldAutoOpenDevTools({ isPackaged: false, viteDevServer: '', auditoriumTest: undefined })
    ).toBe(false);
    expect(
      shouldAutoOpenDevTools({ isPackaged: false, viteDevServer: '0', auditoriumTest: undefined })
    ).toBe(false);
  });

  test('AUDITORIUM_TEST suppresses it even for a dev run', () => {
    // The smoke pins window geometry and measures canvases against it; a
    // detached DevTools window is a second window and a second layout pass.
    expect(
      shouldAutoOpenDevTools({ isPackaged: false, viteDevServer: '1', auditoriumTest: '1' })
    ).toBe(false);
  });

  test('any non-empty AUDITORIUM_TEST suppresses it, not just "1"', () => {
    // A suppression fails SAFE on a value it does not recognise: a harness
    // that sets AUDITORIUM_TEST=true must not get a console it never asked
    // for. (The opposite direction from isPackagedGateOpen, which fails closed
    // on granting a capability.)
    for (const value of ['true', 'yes', '0']) {
      expect(
        shouldAutoOpenDevTools({ isPackaged: false, viteDevServer: '1', auditoriumTest: value })
      ).toBe(false);
    }
  });

  test('an empty AUDITORIUM_TEST does not suppress a dev run', () => {
    expect(
      shouldAutoOpenDevTools({ isPackaged: false, viteDevServer: '1', auditoriumTest: '' })
    ).toBe(true);
  });

  test('an unknown isPackaged never opens it', () => {
    // Inherited from isPackagedGateOpen: undefined is an UNKNOWN state, not a
    // safely-unpackaged one.
    expect(
      shouldAutoOpenDevTools({ isPackaged: undefined, viteDevServer: '1', auditoriumTest: undefined })
    ).toBe(false);
  });
});

// main.cjs cannot be require()d outside a real Electron process, so its use of
// the policy is guarded by asserting on its source -- the same approach
// prodGate.test.cjs uses for the BrowserWindow hardening options.
describe('main.cjs wires the policy to a detached DevTools open', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');

  test('the decision comes from shouldAutoOpenDevTools, not an inline condition', () => {
    expect(source).toMatch(/require\('\.\/devToolsPolicy\.cjs'\)/);
    expect(source).toMatch(/shouldAutoOpenDevTools\(\{/);
  });

  test('it opens DETACHED, so the console never resizes the app window', () => {
    expect(source).toMatch(/openDevTools\(\{\s*mode:\s*'detach'\s*\}\)/);
  });

  test('all three inputs are read from the real process state', () => {
    expect(source).toMatch(/isPackaged:\s*app\.isPackaged/);
    expect(source).toMatch(/viteDevServer:\s*process\.env\.VITE_DEV_SERVER/);
    expect(source).toMatch(/auditoriumTest:\s*process\.env\.AUDITORIUM_TEST/);
  });
});
