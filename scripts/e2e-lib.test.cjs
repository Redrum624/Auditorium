'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { acquireMainWindow, MAIN_WINDOW_URL } = require('./e2e-lib.cjs');

/**
 * S1: the launch splash is a second, real BrowserWindow that exists at the same
 * time as the editor's, so "whichever window arrived first" stopped being a way
 * to find the app. Every rig that drives the built app had to change, and the
 * change is worth a test because the failure it prevents is silent: a rig that
 * pinned the SPLASH to 1600x1000 and measured its canvases would not have
 * crashed — it would have reported the geometry it asked for and then failed
 * somewhere much further downstream, or worse, passed.
 *
 * The splash is deliberately NOT disabled under AUDITORIUM_TEST. A feature
 * switched off under test is a feature that only works where nobody is looking,
 * so every walker run launches the real thing and has to find the real window.
 */

/** A stand-in for Playwright's ElectronApplication: just the window list. */
function fakeApp(frames) {
  let i = 0;
  return {
    windows() {
      const at = Math.min(i, frames.length - 1);
      i += 1;
      return frames[at].map((url) => ({ url: () => url }));
    },
  };
}

const SPLASH = 'file:///D:/Dev/Perso/audition_app/electron/splash.html';
const BUNDLE = 'file:///D:/Dev/Perso/audition_app/dist/index.html';
const DEV = 'http://localhost:3005/';

describe('acquireMainWindow', () => {
  test('skips the splash and returns the window that loaded the built bundle', async () => {
    const page = await acquireMainWindow(fakeApp([[SPLASH, BUNDLE]]), { pollMs: 1 });
    expect(page.url()).toBe(BUNDLE);
  });

  test('finds it whichever order the two windows arrive in', async () => {
    const page = await acquireMainWindow(fakeApp([[BUNDLE, SPLASH]]), { pollMs: 1 });
    expect(page.url()).toBe(BUNDLE);
  });

  test('recognises the dev-server window too', async () => {
    // `npm run dev` loads http://localhost:3005 instead of dist/index.html, and
    // the same rigs are pointed at it by hand often enough to matter.
    const page = await acquireMainWindow(fakeApp([[SPLASH, DEV]]), { pollMs: 1 });
    expect(page.url()).toBe(DEV);
  });

  test('waits for the editor window instead of taking what is there', async () => {
    // The splash opens first in wall-clock terms often enough; the rig must sit
    // through that rather than treat the first window it sees as the app.
    const app = fakeApp([[], [SPLASH], [SPLASH], [SPLASH, BUNDLE]]);
    const page = await acquireMainWindow(app, { pollMs: 1 });
    expect(page.url()).toBe(BUNDLE);
  });

  test('a page that has not navigated yet is not the editor', async () => {
    // A BrowserWindow reports about:blank between construction and the first
    // commit. Matching on the URL POSITIVELY (rather than "not the splash")
    // is what keeps that window from being mistaken for the app.
    const app = fakeApp([['about:blank'], ['about:blank', BUNDLE]]);
    const page = await acquireMainWindow(app, { pollMs: 1 });
    expect(page.url()).toBe(BUNDLE);
  });

  test('gives up rather than settling for the splash, and says what it saw', async () => {
    // If the editor window never loads, the honest outcome is a failure naming
    // the windows that DID exist — not a run that quietly drives the splash.
    await expect(
      acquireMainWindow(fakeApp([[SPLASH]]), { timeout: 30, pollMs: 5 })
    ).rejects.toThrow(/splash\.html/);
  });

  test('the pattern matches the two URLs main.cjs can load, and nothing else', () => {
    expect(MAIN_WINDOW_URL.test(BUNDLE)).toBe(true);
    expect(MAIN_WINDOW_URL.test(DEV)).toBe(true);
    expect(MAIN_WINDOW_URL.test(SPLASH)).toBe(false);
    expect(MAIN_WINDOW_URL.test('about:blank')).toBe(false);
    // Re-tested per call in the rigs, so it must not be a /g regex carrying
    // lastIndex between calls.
    expect(MAIN_WINDOW_URL.global).toBe(false);
    expect(MAIN_WINDOW_URL.test(BUNDLE)).toBe(true);
  });
});

describe('no rig acquires a window by arrival order any more', () => {
  // Six acquisition points existed when the splash landed: `launchApp` and
  // `pinWindowGeometry` here, e2e-open-large's own copies of both, the
  // first-play latency rig, and the spectral screenshot. Missing one leaves a
  // rig that drives a 460x360 splash. This scan is what makes "all of them" a
  // claim the suite can keep rather than a claim in a report.
  /** Source with its comments removed. Several of these files now carry prose
   * naming the two patterns that were removed and why; a scan that cannot tell
   * the warning from the mistake would fail on the warning. `//` counts as a
   * comment only when it is not preceded by a colon, so a URL survives. */
  function codeOnly(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  const dir = __dirname;
  const rigs = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.cjs') && !f.endsWith('.test.cjs'))
    .map((f) => [f, codeOnly(fs.readFileSync(path.join(dir, f), 'utf8'))]);

  // Assembled rather than written out, so this file never matches itself.
  const byArrival = 'first' + 'Window(';
  const byIndex = 'getAllWindows()' + '[0]';

  test.each(rigs.map(([f]) => f))('%s', (name) => {
    const source = rigs.find(([f]) => f === name)[1];
    expect(source).not.toContain(byArrival);
    expect(source).not.toContain(byIndex);
  });

  test('and the rigs that launch the app go through the shared helper', () => {
    for (const [name, source] of rigs) {
      if (!source.includes('electron.launch(')) continue;
      expect([name, source.includes('acquireMainWindow')]).toEqual([name, true]);
    }
  });
});
