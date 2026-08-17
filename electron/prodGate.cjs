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
 *
 * Fails CLOSED on anything other than a known, real "unpackaged" state
 * (review fix round 1, MINOR 4): the gate opens ONLY when isPackaged is
 * strictly `false`. A real Electron process (main.cjs, or the scripted/
 * Playwright smoke harness launching `electron .` unpacked) always reports a
 * genuine boolean here, so this never affects production or the smoke
 * harness. An undefined/null isPackaged -- e.g. the shape require('electron')
 * degrades to outside a real Electron process, such as under Jest without an
 * explicit electron mock -- is an UNKNOWN state and must not be treated as
 * safely unpackaged just because it happens to be falsy.
 */
function isPackagedGateOpen(isPackaged, envValue) {
  return envValue === '1' && isPackaged === false;
}

module.exports = { isPackagedGateOpen };
