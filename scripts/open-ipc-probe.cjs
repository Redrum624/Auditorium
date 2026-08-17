'use strict';

// T4 — the IPC-delivery stall probe. A MEASUREMENT, not a gate: it prints
// numbers and writes a verdict JSON, and exits 0 whatever they say.
//
// The claim on trial is the one the O1 round recorded and did not attempt:
//
//   "190-300 ms main-thread block is the IPC delivery itself (ipcRenderer is
//    main-thread-only) + 123-160 ms post-open pyramids/first-draw."
//
// and beside it "the bridge-copy floor" — `contextBridge` COPIES anything a
// preload method returns, so a 65 MiB read costs a second 65 MiB at the hand-off
// no matter what the reader does.
//
// Both are about opening a FILE, not about pressing play; the brief that
// commissioned this probe described it as play-press latency, and the ledger
// entry it cites is `file:read`. The ledger is what is measured here.
//
// What it isolates, per read, inside the real built app:
//
//   * `deliverMs`   — `await window.electronAPI.readFile(path)`, wall clock.
//     This is main→renderer IPC transfer + structured-clone deserialisation +
//     the contextBridge copy of the return value. Everything the renderer pays
//     before it owns the bytes.
//   * `blockMs`     — the LONGEST gap between ticks of a 4 ms interval running
//     across that await. A promise that resolves after 200 ms of idle waiting
//     and one that resolves after 200 ms of blocked main thread are the same
//     `deliverMs` and completely different bugs; this is the number the ledger's
//     claim is actually about.
//   * `copyMs`      — an in-renderer `slice()` of the same buffer. The floor a
//     copy of this many bytes costs on this machine, so the delivery can be
//     compared against "one copy" rather than against zero.
//
// A small file is measured too, as the control that separates fixed per-call
// overhead from per-byte cost.
//
//   npm run build && node scripts/open-ipc-probe.cjs [--repeats=5] [--out=<path>]
//     [--big1=<file>] [--big2=<file>]

const path = require('node:path');
const fs = require('node:fs');
// S1: the launch splash is a second BrowserWindow, so the editor is found by
// what it loaded rather than by arrival order.
const { acquireMainWindow } = require('./e2e-lib.cjs');
const { _electron: electron } = require('playwright');

const ROOT = path.resolve(__dirname, '..');

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

const REPEATS = Number(arg('repeats', '5'));
const OUT = path.resolve(ROOT, arg('out', path.join('test-output', 'open-ipc-probe.json')));

/** The files to read, largest first. The two big ones default to the two
 * user-local recordings the O1 incident was reported against (test-assets/
 * is gitignored; personal recordings never enter the committed tree) --
 * --big1=/--big2= point the probe at any two large local files instead.
 * `long70.wav` is the generated small control. */
const TARGETS = [
  { file: arg('big1', 'real-song-48k.wav') },
  { file: arg('big2', 'long-real-take.wav') },
  { file: 'long70.wav', control: true },
].map((t) => {
  const abs = path.isAbsolute(t.file) ? t.file : path.join(ROOT, 'test-assets', t.file);
  return { ...t, path: abs, label: `${path.basename(abs)}${t.control ? ' (control)' : ''}` };
});

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function f(n) {
  return n === null || n === undefined ? 'n/a' : `${n.toFixed(1)} ms`;
}

async function probeOnce(page, filePath) {
  return page.evaluate(async (p) => {
    // The stall detector. During a synchronous block on the main thread no
    // timer runs, so the largest gap between ticks IS the block.
    //
    // The WARM-UP is load-bearing, and its absence made the first version of
    // this probe report 4.6 ms for a block that a separate experiment measured
    // at 142.6 ms. With the read issued in the same turn as the `setInterval`,
    // a block that lands before the FIRST tick is not a gap between two ticks —
    // it is the silence before tick zero, and a loop that starts at `i = 1`
    // cannot see it. The detector's own 120 ms control passed throughout,
    // because that control happened to warm up first. Ticking for 40 ms before
    // the measurement is what makes the two agree.
    const ticks = [];
    const timer = setInterval(() => ticks.push(performance.now()), 4);
    await new Promise((r) => setTimeout(r, 40));
    const t0 = performance.now();
    let bytes = 0;
    let error = null;
    let copyMs = null;
    try {
      const buf = await window.electronAPI.readFile(p);
      const t1 = performance.now();
      bytes = buf.byteLength;
      const c0 = performance.now();
      const copy = buf.slice(0);
      const c1 = performance.now();
      copyMs = c1 - c0;
      // Keep the copy observable so the engine cannot elide it.
      if (copy.byteLength !== bytes) error = 'copy length mismatch';
      // One more turn of ticks so a block at the very END of the window is a gap
      // with a tick on both sides of it, for the same reason the warm-up exists.
      await new Promise((r) => setTimeout(r, 40));
      clearInterval(timer);
      let worst = 0;
      let ticksDuringRead = 0;
      for (let i = 1; i < ticks.length; i += 1) {
        worst = Math.max(worst, ticks[i] - ticks[i - 1]);
        if (ticks[i] >= t0 && ticks[i] <= t1) ticksDuringRead += 1;
      }
      // The copy's own block, isolated: zero ticks inside it is the proof that a
      // buffer copy of this size DOES stop the main thread, which is what makes
      // it a fair unit to compare the delivery against.
      const ticksDuringCopy = ticks.filter((t) => t >= c0 && t <= c1).length;
      return {
        deliverMs: t1 - t0,
        blockMs: worst,
        copyMs,
        bytes,
        ticks: ticks.length,
        ticksDuringRead,
        ticksDuringCopy,
        error,
      };
    } catch (err) {
      clearInterval(timer);
      return {
        deliverMs: performance.now() - t0,
        blockMs: null,
        copyMs,
        bytes,
        ticks: ticks.length,
        error: String((err && err.message) || err),
      };
    }
  }, filePath);
}

/**
 * The stall detector, measured against a block of KNOWN length.
 *
 * Without this the headline number is unfalsifiable: "the main thread was not
 * blocked" and "the detector cannot see a block" produce the same small
 * `blockMs`, and this repo has been caught by that shape of vacuous pass more
 * than once. A 120 ms busy-wait must come back as ~120 ms.
 */
async function selfTest(page, blockFor) {
  return page.evaluate((ms) => {
    const ticks = [];
    const timer = setInterval(() => ticks.push(performance.now()), 4);
    return new Promise((resolve) => {
      // One turn of the event loop first, so the interval is genuinely running
      // before the block starts.
      setTimeout(() => {
        const until = performance.now() + ms;
        while (performance.now() < until) {
          /* deliberately blocking */
        }
        setTimeout(() => {
          clearInterval(timer);
          let worst = 0;
          for (let i = 1; i < ticks.length; i += 1) {
            worst = Math.max(worst, ticks[i] - ticks[i - 1]);
          }
          resolve({ asked: ms, detected: worst, ticks: ticks.length });
        }, 30);
      }, 30);
    });
  }, blockFor);
}

async function main() {
  const missing = TARGETS.filter((t) => !fs.existsSync(t.path));
  if (missing.length > 0) {
    console.log(
      `skipped: missing fixture(s): ${missing.map((m) => m.label).join(', ')} — ` +
        'pass --big1=/--big2= to point the probe at two large local files'
    );
    return;
  }

  const app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    env: { ...process.env, AUDITORIUM_TEST: '1' },
  });
  const page = await acquireMainWindow(app); // S1: the editor, not the splash
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => window.__test !== undefined, null, { timeout: 30000 });

  const control = await selfTest(page, 120);
  console.log(
    `\nstall-detector control: blocked ${control.asked} ms on purpose, detected ` +
      `${control.detected.toFixed(1)} ms across ${control.ticks} ticks`
  );
  const detectorTrusted = control.detected >= control.asked * 0.8;
  if (!detectorTrusted) {
    console.error(
      '  the detector did NOT see a block it was told to expect — every blockMs below is ' +
        'uninformative and must be read as "not measured", not as "not blocked"'
    );
  }

  const results = [];
  for (const target of TARGETS) {
    const runs = [];
    for (let i = 0; i < REPEATS; i += 1) {
      const r = await probeOnce(page, target.path);
      if (r.error) {
        console.error(`  ${target.label} run ${i + 1}: ERROR ${r.error}`);
      }
      runs.push(r);
      // Let the renderer settle so the next run does not measure this one's GC.
      await page.waitForTimeout(250);
    }
    const ok = runs.filter((r) => !r.error);
    const entry = {
      label: target.label,
      bytes: ok.length > 0 ? ok[0].bytes : 0,
      runs: runs.map((r) => ({
        deliverMs: r.deliverMs,
        blockMs: r.blockMs,
        copyMs: r.copyMs,
        ticksDuringRead: r.ticksDuringRead,
        ticksDuringCopy: r.ticksDuringCopy,
        error: r.error,
      })),
      median: {
        deliverMs: median(ok.map((r) => r.deliverMs)),
        blockMs: median(ok.map((r) => r.blockMs).filter((v) => v !== null)),
        copyMs: median(ok.map((r) => r.copyMs).filter((v) => v !== null)),
      },
    };
    results.push(entry);
    const mib = (entry.bytes / (1024 * 1024)).toFixed(1);
    console.log(`\n${target.label}  (${mib} MiB, ${ok.length}/${runs.length} runs)`);
    console.log(`  deliver (invoke → bytes in hand): ${f(entry.median.deliverMs)}`);
    console.log(`  main-thread block (worst gap):    ${f(entry.median.blockMs)}`);
    console.log(`  one in-renderer copy of the same: ${f(entry.median.copyMs)}`);
  }

  const heap = await page.evaluate(() =>
    performance.memory
      ? {
          usedMiB: performance.memory.usedJSHeapSize / (1024 * 1024),
          limitMiB: performance.memory.jsHeapSizeLimit / (1024 * 1024),
        }
      : null
  );

  await app.close();

  const verdict = {
    what: 'main→renderer file:read delivery cost, measured in the built app',
    when: new Date().toISOString(),
    repeats: REPEATS,
    stallDetectorControl: control,
    stallDetectorTrusted: detectorTrusted,
    heap,
    targets: results,
    notes: [
      'deliverMs = ipcRenderer.invoke round trip + structured-clone deserialisation + the contextBridge copy of the return value.',
      'blockMs = longest gap between ticks of a 4 ms interval spanning the await; this is the part the user feels.',
      'copyMs = an in-renderer slice() of the delivered buffer: what ONE copy of this many bytes costs on this machine.',
    ],
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(verdict, null, 2)}\n`);
  console.log(`\nverdict: ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
