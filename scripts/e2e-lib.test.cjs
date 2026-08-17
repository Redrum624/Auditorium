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

const SPLASH = 'file:///D:/app/electron/splash.html';
const BUNDLE = 'file:///D:/app/dist/index.html';
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
   * naming the patterns that were removed and why; a scan that cannot tell the
   * warning from the mistake would fail on the warning.
   *
   * `//` counts as a comment only when preceded by neither a colon NOR a
   * slash. The colon is what lets a `http://` URL survive; the slash is fix
   * round 2, M-6 — in a `file:///…` literal the first `//` is protected by its
   * colon and the second one, one character along, was not, so the rest of that
   * line was deleted before the scan saw it. No rig contains such a literal
   * today, and the point is exactly that: a future one would have HIDDEN a
   * violation rather than reported it. */
  function codeOnly(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:/])\/\/[^\n]*/g, '$1');
  }

  test('the comment stripper keeps code and drops comments, triple slash included', () => {
    // Guards every scan below: a stripper that ate real code would make them
    // pass by having nothing left to find.
    const url = 'const u = ' + "'file:///D:/app/dist/index.html';" + ' app.firs' + 'tWindow();';
    expect(codeOnly(url)).toContain('firs' + 'tWindow(');
    expect(codeOnly("await page.goto('http://localhost:3005'); // firs" + 'tWindow()')).toContain(
      'localhost:3005'
    );
    expect(codeOnly("await page.goto('http://localhost:3005'); // firs" + 'tWindow()')).not.toContain(
      'firs' + 'tWindow('
    );
    expect(codeOnly('/* firs' + 'tWindow() */ a();')).not.toContain('firs' + 'tWindow(');
  });

  const dir = __dirname;
  const rigs = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.cjs') && !f.endsWith('.test.cjs'))
    .map((f) => [f, codeOnly(fs.readFileSync(path.join(dir, f), 'utf8'))]);

  /**
   * Every spelling of "take a window without asking which one it is".
   *
   * Fix round 2, M-5. This banned exactly two literals — `firstWindow(` and
   * `getAllWindows()[0]` — which is the two that happened to be in the tree
   * when the splash landed, not the class. `app.windows()[0]`,
   * `getAllWindows()[1]` and a `waitForEvent('window')` race all sailed
   * through, and each of them reintroduces precisely the silent failure the
   * scan exists to prevent: a rig that pins the 460x360 SPLASH to 1600x1000,
   * succeeds, and then measures a window that is not the app.
   *
   * Patterns rather than literals, so an index or a spacing variant cannot slip
   * past. Assembled from fragments so this file never matches itself.
   */
  const BY_ARRIVAL = [
    ['first' + 'Window(', /first[W]indow\s*\(/],
    ['getAllWindows()[n]', /getAllWindows\(\)\s*\[/],
    ['.windows()[n]', /\.windows\(\)\s*\[/],
    ["waitForEvent('window')", /waitForEvent\s*\(\s*['"]window['"]/],
  ];

  test.each(rigs.map(([f]) => f))('%s', (name) => {
    const source = rigs.find(([f]) => f === name)[1];
    for (const [label, pattern] of BY_ARRIVAL) {
      expect([label, pattern.test(source)]).toEqual([label, false]);
    }
  });

  test('the ban is a ban: each pattern really would catch its spelling', () => {
    // Guards the guard. Four regexes that match nothing in the tree are
    // indistinguishable from four regexes that match nothing at all, and the
    // finding this replaces was exactly that — a scan whose passing said less
    // than it looked like it said.
    const samples = [
      'const p = await app.first' + 'Window();',
      'const w = BrowserWindow.getAllWindows()[1];',
      'const p = app.windows()[0];',
      "const p = await app.waitForEvent('window');",
    ];
    samples.forEach((sample, i) => {
      expect([i, BY_ARRIVAL[i][1].test(sample)]).toEqual([i, true]);
      // …and each pattern is specific: it must not fire on the LEGITIMATE
      // acquisition, which is a `windows()` call that is iterated rather than
      // indexed (e2e-lib's own `acquireMainWindow`).
      expect([i, BY_ARRIVAL[i][1].test('const pages = app.windows();')]).toEqual([i, false]);
    });
  });

  test('and the rigs that launch the app go through the shared helper', () => {
    // The load-bearing half: a rig may not launch Electron and then find its
    // window by some means of its own. `acquireMainWindow` must be both
    // IMPORTED from here (not redeclared locally, which is how the two copies
    // in e2e-open-large drifted in the first place) and CALLED.
    let checked = 0;
    for (const [name, source] of rigs) {
      if (!source.includes('electron.launch(')) continue;
      checked += 1;
      expect([name, /acquireMainWindow\s*\(/.test(source)]).toEqual([name, true]);
      // e2e-lib.cjs is where the helper LIVES; everyone else imports it.
      if (/function acquireMainWindow/.test(source)) continue;
      expect([name, /require\((['"])\.\/e2e-lib\.cjs\1\)/.test(source)]).toEqual([name, true]);
    }
    // A scan over zero files is not evidence: if the launch spelling ever
    // changes, this says so instead of passing.
    expect(checked).toBeGreaterThan(0);
    console.log(`rigs launching Electron, all via acquireMainWindow: ${checked}`);
  });
});

/**
 * T3 (v1.28 ledger) — `ensureFixtures` regenerated on ABSENCE alone, so a
 * generator change left every fixture already on disk untouched.
 *
 * The failure that costs is the silent one: a generator's ground truth moves,
 * `test-assets/` still holds the pair built by the OLD recipe, and the run goes
 * green against a fixture nobody meant to keep — or fails somewhere downstream
 * with a number that reads like a bug in the app. Nothing on disk said which
 * generator made what.
 *
 * The DECISION is separated from the shelling-out so it can be driven over real
 * files in a temp directory rather than over this repo's own `scripts/`. What
 * is pinned here is when a fixture counts as stale, which is the whole of the
 * defect; running the generator is the part that was never in question.
 */
describe('a fixture is stale when the generator that made it has moved', () => {
  const os = require('node:os');
  const { fixtureIsStale, stampFixture } = require('./e2e-lib.cjs');

  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditorium-fixture-stamp-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (name, body) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    return file;
  };

  it('is stale while the fixture is absent, whatever the generator says', () => {
    const gen = write('gen.cjs', 'module.exports = 1;\n');
    expect(fixtureIsStale(path.join(dir, 'out.wav'), gen)).toBe(true);
  });

  it('stops being stale once the fixture is there AND carries its generator', () => {
    const gen = write('gen.cjs', 'module.exports = 1;\n');
    const out = write('out.wav', 'audio');
    // The fixture alone is not enough: an unstamped file is one whose recipe is
    // unknown, which is the state every fixture on disk was in before this.
    expect(fixtureIsStale(out, gen)).toBe(true);
    stampFixture(out, gen);
    expect(fixtureIsStale(out, gen)).toBe(false);
  });

  it('is stale again the moment the generator is edited, fixture still in place', () => {
    const gen = write('gen.cjs', 'module.exports = 1;\n');
    const out = write('out.wav', 'audio');
    stampFixture(out, gen);
    fs.writeFileSync(gen, 'module.exports = 2;\n');
    expect(fs.existsSync(out)).toBe(true);
    expect(fixtureIsStale(out, gen)).toBe(true);
  });

  it('follows the generator into the modules it requires', () => {
    // Not hypothetical: `make-test-cover.cjs`'s planted offset now lives in
    // `cover-fixture-manifest.cjs`, so a digest of the generator's own bytes
    // alone would be watching the wrong file and would miss the ground truth
    // moving.
    const dep = write('dep.cjs', 'module.exports = { OFFSET_SECONDS: 0.75 };\n');
    const gen = write(
      'gen.cjs',
      "const { OFFSET_SECONDS } = require('./dep.cjs');\nmodule.exports = OFFSET_SECONDS;\n"
    );
    const out = write('out.wav', 'audio');
    stampFixture(out, gen);
    expect(fixtureIsStale(out, gen)).toBe(false);
    fs.writeFileSync(dep, 'module.exports = { OFFSET_SECONDS: 1.5 };\n');
    expect(fixtureIsStale(out, gen)).toBe(true);
  });

  it('tells two generators apart by name, not only by their contents', () => {
    // Two generators can hold identical bytes at some point in their lives; a
    // fixture stamped by one must not be accepted as built by the other.
    const body = 'module.exports = 1;\n';
    const a = write('gen-a.cjs', body);
    const b = write('gen-b.cjs', body);
    const out = write('out.wav', 'audio');
    stampFixture(out, a);
    expect(fixtureIsStale(out, a)).toBe(false);
    expect(fixtureIsStale(out, b)).toBe(true);
  });
});
