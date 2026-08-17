/**
 * Reload the renderer.
 *
 * One line in a module of its own, and that is deliberate: jsdom makes both
 * `window.location` and `location.reload` NON-CONFIGURABLE, so neither can be
 * substituted in a test. A module boundary is the only seam left, which makes
 * this the difference between a Reload button that is asserted to work and one
 * that is asserted to exist. (See CrashBoundary.test.tsx, which mocks this
 * module and then pins the real body here against its source.)
 *
 * `location.reload()` re-runs the same URL — the built bundle or the dev
 * server, whichever this window loaded — so the app comes back exactly as a
 * fresh launch would, with no document state carried over from the crash.
 */
export function reloadWindow(): void {
  window.location.reload();
}
