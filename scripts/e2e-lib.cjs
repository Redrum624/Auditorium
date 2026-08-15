'use strict';

/**
 * The shared Playwright-Electron rig (task PW1).
 *
 * Two scripts drive the BUILT app now — `e2e-smoke.cjs` (the scenario pass: a
 * round trip through open/edit/export/save on real fixtures) and
 * `e2e-navigate.cjs` (the navigation pass: every user-reachable surface opened,
 * used once and closed). Everything below is the plumbing they BOTH need, moved
 * here verbatim from the smoke rather than copied into the walker.
 *
 * The rule that decided what moved: rig, not analysis. Launching, pinning the
 * window, asserting, real pointer input, waiting for a canvas to paint and
 * reading a WAV back off disk are things any driver of this app needs. The
 * smoke's beat-tic hue arithmetic and its 20 ms RMS envelope are that script's
 * OWN measurements, and they stayed there.
 *
 * `assert` keeps printing its `ok:` line exactly as it did when it lived in the
 * smoke, because that line IS the smoke's assertion count.
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('playwright');

const ROOT = path.resolve(__dirname, '..');

// The window geometry every pixel assertion in either script is measured
// against. It is the app's own design size (electron/main.cjs creates the
// window at 1600x1000), so the harness drives the layout the app was built for
// rather than a shape only the harness ever sees.
//
// Why pin it at all: a NEW window is fitted to the work area of the display it
// is born on, floored by the window's minimum size (1100x700). A run that
// opened on a smaller second display got a 1100x700 window — a 624 CSS px
// waveform canvas instead of 1209 — and canvas width is what decides how much
// of the document is on screen, doubly so since F11-3 made a document open
// FITTED (the zoom is `docLength / laneWidth`, resolved against the width the
// lane actually measured). Pinning the content size makes every canvas readback
// reproducible.
const SMOKE_WINDOW = { width: 1600, height: 1000 };
// Content size is set in DIP but realised in whole device pixels, so at a
// fractional display scale the readback can land a pixel off the request. Only
// a real refusal to resize should fail the check.
const SMOKE_WINDOW_TOLERANCE_PX = 4;

// S1: which window is the editor.
//
// The launch splash (electron/splash.html) is a second, real BrowserWindow that
// exists at the same time as the editor's, so `app.firstWindow()` and
// `BrowserWindow.getAllWindows()[0]` — what every rig here used to say — became
// coin flips. The failure that would cause is silent rather than loud: pinning
// the SPLASH to 1600x1000 succeeds, and the run goes on to measure a window
// that is not the app.
//
// The splash is deliberately NOT switched off under AUDITORIUM_TEST. A feature
// disabled under test is a feature that only works where nobody is looking, so
// every walker run launches the real thing and identifies the real window.
//
// The test is POSITIVE — "this window loaded the app" — rather than "this
// window is not the splash", because a BrowserWindow reports `about:blank`
// between construction and its first commit, and "not the splash" would hand
// back that window. These are the only two URLs electron/main.cjs ever loads.
const MAIN_WINDOW_URL = /(dist[\\/]index\.html|localhost:3005)/i;

/**
 * Waits for the editor's own window and returns its Playwright page.
 *
 * Polls the window list rather than waiting on a 'window' event, because the
 * editor window may already be open before the first call (Playwright's
 * `launch()` resolves once the app is up) and an event-only wait would then
 * wait forever for a window that has already arrived.
 */
async function acquireMainWindow(app, { timeout = 30000, pollMs = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const pages = app.windows();
    const found = pages.find((p) => MAIN_WINDOW_URL.test(p.url()));
    if (found) return found;
    if (Date.now() >= deadline) {
      const seen = pages.map((p) => p.url()).join(', ') || 'none';
      throw new Error(
        `the editor window never appeared within ${timeout} ms (windows open: ${seen})`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// Every `ok:` line this module has printed. The smoke does not read it (its
// count is the `ok:` lines on stdout); the walker reports it as its own
// assertion count, which is the honest number precisely because it is
// incremented by the assert that printed the line rather than by a tally kept
// alongside it.
let okCount = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  okCount += 1;
  console.log(`  ok: ${msg}`);
}

/** How many assertions have passed so far in this process. */
function assertionCount() {
  return okCount;
}

// Minimal RIFF/WAVE reader, so a script can re-measure what the packaged app
// wrote WITHOUT calling back into the app for the numbers. It walks the chunk
// table rather than assuming a 44-byte header, because `saveActiveAs` writes
// 32-bit float and may carry a cue chunk.
function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file} is not a RIFF/WAVE file`);
  }
  let fmt = null;
  let data = null;
  let p = 12;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'fmt ') {
      fmt = {
        format: b.readUInt16LE(body),
        channelCount: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        bits: b.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = { offset: body, size };
    }
    p = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${file} has no fmt/data chunk`);
  const bytesPerSample = fmt.bits / 8;
  const frames = Math.floor(data.size / (bytesPerSample * fmt.channelCount));
  const channels = [];
  for (let c = 0; c < fmt.channelCount; c++) channels.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channelCount; c++) {
      const at = data.offset + (i * fmt.channelCount + c) * bytesPerSample;
      if (fmt.bits === 32 && fmt.format === 3) channels[c][i] = b.readFloatLE(at);
      else if (fmt.bits === 16) channels[c][i] = b.readInt16LE(at) / 32768;
      else throw new Error(`unsupported WAV sample format ${fmt.format}/${fmt.bits}-bit`);
    }
  }
  return { ...fmt, frames, channels };
}

// Waits until the given canvas has drawn at least two differing pixels (i.e. it
// is not a blank/uniform fill). Shared by the waveform and spectrogram checks.
async function waitNonUniform(page, testid, timeout = 15000) {
  await page.waitForFunction(
    (id) => {
      const c = document.querySelector(`[data-testid="${id}"]`);
      if (!(c instanceof HTMLCanvasElement)) return false;
      const ctx = c.getContext('2d');
      if (!ctx || c.width === 0 || c.height === 0) return false;
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let first = null;
      for (let i = 0; i < data.length; i += 4 * 97) {
        const px = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        if (first === null) first = px;
        else if (px !== first) return true;
      }
      return false;
    },
    testid,
    { timeout }
  );
}

/** FNV-1a hash of a canvas raster, so a repaint (a scale toggle, a view switch,
 * a zoom) can be detected by a changed hash. Returns -1 when the canvas is
 * absent or has no backing store — a value every caller must guard against
 * rather than compare, since -1 === -1 would make "both missing" look like "no
 * repaint". */
async function canvasHash(page, testid) {
  return page.evaluate((id) => {
    const c = document.querySelector(`[data-testid="${id}"]`);
    if (!(c instanceof HTMLCanvasElement)) return -1;
    const ctx = c.getContext('2d');
    if (!ctx || !c.width || !c.height) return -1;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let h = 2166136261 >>> 0;
    for (let i = 0; i < data.length; i += 4 * 53) {
      h = Math.imul(h ^ data[i], 16777619) >>> 0;
      h = Math.imul(h ^ data[i + 1], 16777619) >>> 0;
      h = Math.imul(h ^ data[i + 2], 16777619) >>> 0;
    }
    return h >>> 0;
  }, testid);
}

/** The spectrogram's raster hash — `canvasHash` on the one canvas the smoke has
 * always hashed, kept as its own name because that is what the smoke calls. */
async function spectroHash(page) {
  return canvasHash(page, 'spectrogram-canvas');
}

/** One REAL pointer click at a viewport position — `page.mouse`, so it goes
 * through the browser's own input path and the renderer's gesture layer, not
 * through a test hook (a hook-driven assertion can pass without the gesture
 * ever running). Clicks are separated in time by the caller so Chromium never
 * coalesces two of them into a double-click. */
async function realClick(page, clientX, clientY, { alt = false } = {}) {
  if (alt) await page.keyboard.down('Alt');
  try {
    await page.mouse.move(clientX, clientY);
    await page.mouse.down();
    await page.mouse.up();
  } finally {
    if (alt) await page.keyboard.up('Alt');
  }
}

// One REAL pointer DRAG — press at `from`, travel through intermediate
// positions, release at `to`. Same discipline as `realClick`: it goes through
// the browser's input path and the renderer's gesture layer, never a hook, so
// a drag assertion cannot pass without the gesture actually running. The
// intermediate moves are load-bearing rather than cosmetic — a press followed
// by a single jump to the end would not exercise the "follows live" half of
// either the playhead handle or the ruler scrub. `hold` leaves the button DOWN
// so a caller can assert mid-drag and release itself.
async function realDrag(page, from, to, { alt = false, steps = 4, hold = false } = {}) {
  if (alt) await page.keyboard.down('Alt');
  try {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(
        from.x + ((to.x - from.x) * i) / steps,
        from.y + ((to.y - from.y) * i) / steps
      );
    }
    if (!hold) await page.mouse.up();
  } finally {
    if (alt && !hold) await page.keyboard.up('Alt');
  }
}

// The module strip's ACTIVE entry TOGGLES its card closed (layout E2) — that is
// what lets the waveform take the column's width. Every caller that clicks a
// strip entry means "show me this panel", and a blind click on an already-open
// one would close it instead. Asking first keeps each caller's intent intact
// under the toggle; the return value says whether a click actually happened, so
// a caller that depends on one can assert it.
async function openModuleCard(page, label) {
  const already = await page.evaluate(() =>
    document.querySelector('[data-testid="sidebar-panel"]')?.getAttribute('data-active-tab')
  );
  if (already === label.toLowerCase()) return false;
  await page.click(`[data-testid="sidebar-tabs"] button[aria-label="${label}"]`);
  return true;
}

/** Pins the app window to `want` from the MAIN process, through the real
 * BrowserWindow — the only place a window's size can be set, since the renderer
 * cannot resize its own frameless shell.
 *
 * The window is first moved to the roomiest display: Windows fits a window to
 * the work area it is created on, so a window born on a small screen is created
 * at its minimum size, and that is the shape the resize has to undo. Any
 * maximized/fullscreen/minimized state is cleared for the same reason — a
 * restored window would silently take its own size back.
 *
 * Returns the geometry actually realised, so the caller can assert the pin took
 * rather than discovering it later as a mysterious pixel count. */
async function pinWindowGeometry(app, want) {
  return app.evaluate(({ BrowserWindow, screen }, { size, mainUrlPattern }) => {
    // S1: by URL, not by index — the splash is `getAllWindows()[0]` for as long
    // as it lives. A regex cannot cross `evaluate`'s structured clone, so its
    // source travels and it is rebuilt here.
    const isMain = new RegExp(mainUrlPattern, 'i');
    const win = BrowserWindow.getAllWindows().find((w) => isMain.test(w.webContents.getURL()));
    if (!win) return null;
    if (win.isMinimized()) win.restore();
    if (win.isFullScreen()) win.setFullScreen(false);
    if (win.isMaximized()) win.unmaximize();
    const displays = screen.getAllDisplays();
    const roomiest = displays.reduce(
      (best, d) =>
        d.workArea.width * d.workArea.height > best.workArea.width * best.workArea.height ? d : best,
      displays[0]
    );
    win.setPosition(roomiest.workArea.x + 8, roomiest.workArea.y + 8);
    win.setContentSize(size.width, size.height);
    const [contentWidth, contentHeight] = win.getContentSize();
    return {
      contentWidth,
      contentHeight,
      displayCount: displays.length,
      scaleFactor: roomiest.scaleFactor,
      workArea: roomiest.workArea,
    };
  }, { size: want, mainUrlPattern: MAIN_WINDOW_URL.source });
}

/**
 * T3 — the generator's own source, plus the source of every module it reaches
 * by a RELATIVE require, best-effort and transitive.
 *
 * A generator's output is a function of its whole local recipe, not of one
 * file's bytes: `make-test-cover.cjs` reads its planted offset from
 * `cover-fixture-manifest.cjs`, so a digest of the generator alone would watch
 * the wrong file and call a fixture fresh while the ground truth in it had
 * moved. Package requires are deliberately NOT followed — these generators are
 * plain-Node by contract (standard library only), so there is nothing there to
 * follow, and walking `node_modules` would make this cost more than the
 * generation it is trying to skip.
 *
 * The regex is a reader, not a parser, and it does not have to be exact in
 * either direction: a require it misses costs a stale fixture nobody notices
 * (the state before this existed), and a string it matches that was never a
 * require costs one unnecessary regeneration. Both are cheaper than a parser.
 *
 * The likeliest miss is not a dynamic require but an EXTENSIONLESS one —
 * `require('./cover-fixture-manifest')`. `path.resolve` does not perform Node's
 * extension search, so `readFileSync` fails and the `catch` below drops that
 * module from the digest silently. No generator in this repo writes one today;
 * write requires with their extension and this keeps holding.
 *
 * The NAME is hashed beside the bytes so two generators that happen to hold
 * identical source are still told apart.
 */
function generatorRecipe(scriptPath, seen = new Set()) {
  const resolved = path.resolve(scriptPath);
  if (seen.has(resolved)) return [];
  seen.add(resolved);
  let source;
  try {
    source = fs.readFileSync(resolved, 'utf8');
  } catch {
    // A require this reader resolved to a path that is not a readable file
    // (an extensionless directory require, a name it mis-read). Skipping it
    // loses one input to the digest; throwing would take the whole run down
    // over a fixture-freshness check.
    return [];
  }
  const parts = [`${path.basename(resolved)}\n${source}`];
  for (const m of source.matchAll(/require\(\s*['"](\.[^'"]*)['"]\s*\)/g)) {
    parts.push(...generatorRecipe(path.resolve(path.dirname(resolved), m[1]), seen));
  }
  return parts;
}

/**
 * The digest of that recipe — what a fixture is stamped with.
 *
 * T3 fix round 1 — the parts are framed by LENGTH, not by a delimiter.
 *
 * This used to join them with a raw NUL, which made this shared rig file
 * BINARY to `file(1)`, to grep and to ripgrep ("Binary file … matches"), and
 * left every fixture stamp at the mercy of any tool that strips control
 * characters — one invisible rewrite and every fixture in the repo silently
 * changes its recipe.
 *
 * A printable delimiter cannot replace it honestly, which is why this is
 * framing instead. The parts are whole SOURCE FILES, so no fixed string —
 * `|#|`, a newline, any of them — is provably absent from a part, and a part
 * that happened to contain the delimiter could forge a boundary and collide
 * two different recipes onto one digest. A byte length cannot be forged by
 * content: `27:…` says how far the part runs whatever is inside it, so the
 * encoding is unambiguous without asking anything of the sources at all.
 *
 * The framing is printable, so this file reads as text again.
 */
function generatorStamp(scriptPath) {
  const framed = generatorRecipe(scriptPath)
    .map((part) => `${Buffer.byteLength(part)}:${part}`)
    .join('');
  return crypto.createHash('sha256').update(framed).digest('hex');
}

/** Where a fixture records the generator it was built by. Beside the fixture,
 * so it is deleted with it, and inside `test-assets/`, which is gitignored —
 * nothing here is ever committed. */
function stampPath(file) {
  return `${file}.generator`;
}

/** Records that `file` was built by `scriptPath` as it stands right now. */
function stampFixture(file, scriptPath) {
  fs.writeFileSync(stampPath(file), generatorStamp(scriptPath));
}

/**
 * T3 (v1.28 ledger) — whether `file` has to be built again.
 *
 * Absent, or built by a recipe that is not the one on disk now. An UNSTAMPED
 * fixture counts as stale: it is a file whose recipe is unknown, which is the
 * state every fixture was in while this only checked existence, and one
 * regeneration is the cheapest way out of it.
 */
function fixtureIsStale(file, scriptPath) {
  if (!fs.existsSync(file)) return true;
  let stamped;
  try {
    stamped = fs.readFileSync(stampPath(file), 'utf8').trim();
  } catch {
    return true;
  }
  return stamped !== generatorStamp(scriptPath);
}

/**
 * Generates any missing OR STALE fixture from its own plain-Node generator.
 *
 * `test-assets/` is gitignored, so no fixture is ever committed; each generator
 * uses a deterministic PRNG, so the file it writes is byte-identical on every
 * machine. `specs` is a list of `[absolutePath, generatorScriptName, label]`.
 *
 * T3: staleness, not absence. It used to regenerate only what was missing, so
 * editing a generator left the fixture built by the previous recipe in place
 * and every rig went on running against it — silently, because a fixture's file
 * name says nothing about which version of the recipe wrote it.
 *
 * One generator writes several fixtures (`make-test-cover.cjs` writes ten), so
 * each script is run AT MOST ONCE per call and every fixture it owns is stamped
 * after it: running it per stale output would rebuild the same ten files ten
 * times.
 */
function ensureFixtures(specs) {
  const ran = new Set();
  for (const [file, script, label] of specs) {
    const scriptPath = path.join(ROOT, 'scripts', script);
    if (!fixtureIsStale(file, scriptPath)) continue;
    if (!ran.has(scriptPath)) {
      console.log(`Generating ${label}...`);
      execFileSync(process.execPath, [scriptPath], { stdio: 'inherit' });
      ran.add(scriptPath);
    }
    // Stamped from the spec rather than from what the generator happened to
    // write: these are the files the caller declared this generator owns, and
    // an output it produced that nobody declared is not one any rig will look
    // for.
    if (fs.existsSync(file)) stampFixture(file, scriptPath);
  }
}

/**
 * Launches the BUILT app under Playwright's Electron driver and waits for the
 * renderer to install `window.__test`.
 *
 * The two fake-media switches make Chromium synthesize a mic (a periodic tone)
 * and auto-accept the capture prompt, so a recording step runs headless-safe
 * with no real hardware. `AUDITORIUM_TEST=1` is what exposes `window.__test`
 * and relaxes the unpackaged file IPC gates — see electron/prodGate.cjs for why
 * it cannot do so in a packaged build.
 */
async function launchApp({ extraArgs = [] } = {}) {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing — run `npm run build` first');
  }
  const app = await electron.launch({
    args: ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...extraArgs],
    cwd: ROOT,
    env: { ...process.env, AUDITORIUM_TEST: '1' },
  });
  // S1: the editor's window, not whichever one opened first — the splash is a
  // real BrowserWindow and Playwright lists it like any other.
  const page = await acquireMainWindow(app);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => Boolean(window.__test), null, { timeout: 20000 });
  return { app, page };
}

/**
 * Tears the app down. A run must NEVER leave an Electron window for a human to
 * close by hand: graceful close first (the close guard auto-confirms in test
 * mode), but if anything still wedges it — a crashed renderer, a native dialog
 * from a path the guard doesn't own — force-kill after 10 s. `close()` may
 * itself reject once the process dies; that must not mask the real error the
 * caller is already unwinding with.
 */
async function closeApp(app) {
  const proc = app.process();
  await Promise.race([
    app.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 10000)),
  ]);
  if (proc && proc.exitCode === null && !proc.killed) {
    console.error('teardown: graceful close timed out after 10 s; force-killing Electron');
    proc.kill();
  }
}

module.exports = {
  MAIN_WINDOW_URL,
  ROOT,
  SMOKE_WINDOW,
  SMOKE_WINDOW_TOLERANCE_PX,
  acquireMainWindow,
  assert,
  assertionCount,
  canvasHash,
  closeApp,
  ensureFixtures,
  fixtureIsStale,
  launchApp,
  openModuleCard,
  pinWindowGeometry,
  readWav,
  realClick,
  realDrag,
  spectroHash,
  stampFixture,
  waitNonUniform,
};
