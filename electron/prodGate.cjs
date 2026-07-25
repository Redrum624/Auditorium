'use strict';

/**
 * Shared predicate for the three "test/dev escape hatches" that must never
 * activate in a packaged production build (F23): the AUDITORIUM_TEST
 * read/write bypass (ipc.cjs), the --auditorium-test forward to the preload
 * (main.cjs), and the VITE_DEV_SERVER branch that loads the Vite dev server
 * instead of the built bundle (main.cjs). Each is "on" only when its env var
 * is exactly '1' AND the app is unpackaged -- a packaged installer can never
 * be coerced into any of these paths just by an env var being set.
 *
 * `isPackaged` is passed in (not read from `app` here) so this module stays
 * electron-free and unit-testable in plain Node, matching permissionPolicy.cjs.
 * An undefined isPackaged (the shape require('electron') degrades to outside
 * a real Electron process, e.g. under Jest) is treated as "not packaged" --
 * harmless in tests/dev, and never reachable in a real packaged build, where
 * app.isPackaged is always a real boolean.
 */
function isPackagedGateOpen(isPackaged, envValue) {
  return envValue === '1' && !isPackaged;
}

module.exports = { isPackagedGateOpen };
