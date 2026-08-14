'use strict';

const { isPackagedGateOpen } = require('./prodGate.cjs');

/**
 * Whether a newly created window should open its DevTools by itself.
 *
 * USER RULE: the console is open while developing, without anyone asking for
 * it. That is a DEV-run rule and only a dev-run rule — a packaged build keeps
 * today's behaviour (`webPreferences.devTools: !app.isPackaged` already
 * compiles DevTools out of an installed app entirely, so this could not open
 * them there even if it tried).
 *
 * The dev signal is `VITE_DEV_SERVER`, which `scripts/dev.cjs` sets when it
 * spawns Electron against the Vite dev server — the same variable main.cjs
 * already routes `loadURL` vs `loadFile` on, so "the app is running from
 * source" has exactly one definition here. It goes through
 * `isPackagedGateOpen`, so it fails closed on an unknown `isPackaged` and can
 * never be switched on inside a packaged installer by an env var alone.
 *
 * AUDITORIUM_TEST suppresses it unconditionally, ahead of everything else: the
 * packaged smoke pins the window to an exact CSS-pixel size and measures
 * canvases against it, and a detached DevTools window is a second window that
 * costs the run time it does not budget for. (S1: it can no longer be MISTAKEN
 * for the app — since the launch splash made a second window normal, every rig
 * identifies the editor by the URL it loaded rather than by arrival order; see
 * `acquireMainWindow` in scripts/e2e-lib.cjs. The cost reason stands on its
 * own.) Suppression is deliberately keyed on "the variable is set to anything
 * non-empty" rather than on the exact '1' the harness uses — a suppression
 * must fail SAFE (not opening) on a value it does not recognise, which is the
 * opposite of `isPackagedGateOpen`'s fail-closed direction for a capability.
 *
 * @param {{ isPackaged: unknown, viteDevServer: unknown, auditoriumTest: unknown }} env
 * @returns {boolean}
 */
function shouldAutoOpenDevTools({ isPackaged, viteDevServer, auditoriumTest }) {
  if (typeof auditoriumTest === 'string' && auditoriumTest !== '') return false;
  return isPackagedGateOpen(isPackaged, viteDevServer);
}

module.exports = { shouldAutoOpenDevTools };
