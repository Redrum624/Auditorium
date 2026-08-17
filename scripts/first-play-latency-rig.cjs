'use strict';

// R4 (P2-7) — the first-play latency RIG the audit said never existed.
//
// The claim on trial: "the multitrack player's AudioContext sometimes starts
// slowly on first play" (v1.1 behaviour; v1.5.2 only stabilised the smoke-6b
// TEST by polling up to 3 s — it never measured the behaviour). This rig
// produces the missing number: it launches the BUILT app under Playwright's
// Electron driver (same shape as e2e-smoke.cjs — real Chromium, real
// WebAudio, real OS audio device), builds a one-track session, and calls the
// window.__test.measureFirstPlayLatency() instrument
// (src/multitrack/firstPlayLatency.ts) across several APP LAUNCHES:
//
//  - launch 1, probe 1 (cold):  the process's genuinely FIRST AudioContext +
//    first device open — the P2-7 case.
//  - launch 1, probes 2..N:     fresh contexts in a warm process/device.
//  - each probe also reports a warm re-play on ITS OWN context.
//  - launches 2..M repeat the process-cold case for a distribution, because
//    a single cold sample proves nothing about "sometimes starts slowly".
//
// "First sample audible" is estimated as timeToClockAdvance + outputLatency
// (samples render when the context clock first moves; they reach the
// speaker one output-latency later). No loopback capture — stated as an
// estimate, per-field, in the JSON verdict.
//
//   npm run build   (once, so dist/ exists)
//   node scripts/first-play-latency-rig.cjs [--launches=3] [--probes-per-launch=3]
//                                           [--content=tone|songs|mixed] [--out=<path>]
//
// Verdict JSON: test-output/first-play-latency.json (default). Exit 0 when
// every probe ran (whatever the numbers say — this is a measurement, not a
// gate); exit 1 on rig failure.
//
// -------------------------------------------------------------------------
// MT1-3 — the `--content` switch, and why the default was not enough.
//
// The rig above measures the AudioContext and the graph build. It cannot see
// the defect behind "it takes a while to start the play with 2 tracks", and it
// said so in its own words: its one-track 2-second tone exists "so playCallMs
// measures graph build, not content size". Content size turned out to be the
// entire story — `play()` copies and (on a rate mismatch) RESAMPLES every
// sample of every clip synchronously before it schedules anything.
//
//   --content=tone   (default) the original P2-7 session. Unchanged, so the
//                    historical numbers stay comparable.
//   --content=songs  the REPORTED flow: a session created at 44 100 and then
//                    given two ~3-minute stereo 48 kHz files, one per track.
//                    This is the shape the user's long-real-take + real-song session
//                    had.
//   --content=mixed  a GENUINELY rate-mismatched session — the 44.1 kHz tone
//                    lands first, so the session is no longer empty when the
//                    two 48 kHz songs arrive and cannot adopt their rate. See
//                    MT2 below for why `songs` no longer produces this state.
//
// Every mode reports the rate triple (session / doc / context) in the verdict,
// because "which of these three disagree" is the whole diagnosis and reading it
// off the status bar is what misled the report in the first place.
//
// -------------------------------------------------------------------------
// MT2 — what `songs` measures NOW.
//
// It measured the resample. It no longer can, and that is the fix rather than a
// gap in the rig: an EMPTY session adopts the rate of the first document put on
// it (`sessionStore.adoptSessionRate`), so the reported flow — new session,
// insert two 48 kHz files — ends at 48 000 Hz with both clips at ratio 1 and
// nothing to convert. The verdict says so in its own words from MT2 onward —
// `rates.session` is READ BACK from the app rather than assumed, `rates.adopted`
// is true, and `rates.mismatch` is false — and that IS the result; the number to
// compare against `docs/bench/mt1-play-latency-44100.json` is `playCallMs`.
//
// `--content=mixed` keeps the resample branch reachable, so the cache that
// moved it off the play path (`clipResampleCache`) has something to be measured
// on. Its clips are warmed at INSERT time on `requestIdleCallback`, so the rig
// waits for the renderer to go idle before probing — otherwise it would time
// the warm-up instead of the play.
// -------------------------------------------------------------------------

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
// S1: the launch splash is a second BrowserWindow, so the editor's window is
// found by URL through the shared helper rather than by arrival order.
const { acquireMainWindow } = require('./e2e-lib.cjs');

const ROOT = path.resolve(__dirname, '..');
const TONE = path.join(ROOT, 'test-assets', 'tone.wav');
const SONG_A = path.join(ROOT, 'test-assets', 'latency-a.wav');
const SONG_B = path.join(ROOT, 'test-assets', 'latency-b.wav');

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

/**
 * The rate every session in this rig is created at. 44100 by default, which is
 * what `sessionStore`'s own `newSession` default was when MT1-3 was filed, and
 * the "44.1 kHz" the status bar showed over two 48 kHz files.
 *
 * `--session-rate=48000` makes it MATCH the fixtures, which is the controlled
 * experiment that separates the two costs inside `play()`: `readClipSlice`
 * always copies the clip sample by sample, and additionally resamples it when
 * the rates differ. Running both rates against the SAME build attributes the
 * measured time between them without changing a line of app code — so the fix
 * is chosen from evidence rather than from which suspect was named first.
 */
const SESSION_RATE = Number(arg('session-rate', '44100'));

/** Builds the session under test and returns what it is made of. */
async function buildSession(page, content) {
  if (content === 'tone') {
    // One-track session with a 2 s tone clip at 0 — the minimal schedulable
    // session, so playCallMs measures graph build, not content size.
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    await page.evaluate((r) => window.__test.newSession(r), SESSION_RATE);
    const inserted = await page.evaluate(() => window.__test.insertActiveDocAsClip(0, 0));
    if (!inserted) throw new Error('insertActiveDocAsClip returned null');
    return { clips: 1, tracks: 1 };
  }

  // The REPORTED flow, driven exactly as a user drives it: a session created at
  // `--session-rate` (44 100 by default — what File > New Session gave), then
  // two 48 kHz files inserted into it. Before MT2 that produced a mismatched
  // session and a 22-second `play()`; from MT2 the empty session adopts 48 000
  // at the first insert and the clips land at ratio 1. The flow is the same
  // keystrokes either way, which is what makes the two verdicts comparable.
  //
  // `mixed` differs by ONE insert: the 44.1 kHz tone goes on first, so the
  // session is not empty when the songs arrive and the mismatch is genuine.
  const preface = content === 'mixed' ? [TONE] : [];
  await page.evaluate((r) => window.__test.newSession(r), SESSION_RATE);
  let track = 0;
  for (const file of [...preface, SONG_A, SONG_B]) {
    await page.evaluate((p) => window.__test.openPath(p), file);
    const inserted = await page.evaluate((t) => window.__test.insertActiveDocAsClip(t, 0), track);
    if (!inserted) throw new Error(`insertActiveDocAsClip(${track}) returned null`);
    track++;
  }
  // MT2: the mismatched clips' conversions are warmed on `requestIdleCallback`
  // at insert time. Waiting for the renderer to go idle is waiting for that
  // work to finish — idle callbacks run in the order they were queued, so this
  // one cannot resolve before the warm-ups it was queued behind.
  if (content === 'mixed') await waitForIdle(page);
  return { clips: track, tracks: track };
}

/** Resolves once the renderer has been idle — i.e. once every idle callback
 * already queued (the MT2 resample warm-ups) has run to completion. */
async function waitForIdle(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const step = (n) => {
          if (n === 0) {
            resolve(null);
            return;
          }
          window.requestIdleCallback(() => step(n - 1), { timeout: 120_000 });
        };
        step(3);
      })
  );
}

/**
 * The sample rates that must agree, and where each is observed.
 *
 * MT2: `session` is now READ BACK (`getStateSummary().sessionSampleRate`) rather
 * than assumed to be whatever this rig passed to `newSession`. It stopped being
 * the same number the moment an empty session began adopting the first
 * document's rate, and a verdict that had gone on printing "MISMATCHED —
 * resample branch live" over a session with no mismatch would have been the
 * rig lying about the thing it exists to measure. `requested` keeps what was
 * asked for, so an adoption is visible as the two disagreeing.
 *
 * `doc` is the ACTIVE DOCUMENT's rate, which proves the fixtures really are
 * 48 kHz rather than something the WAV writer got wrong. `device` is a
 * throwaway AudioContext's rate, i.e. what the OS hands out.
 *
 * A `doc` that differs from `session` is the resample condition.
 */
async function rateTriple(page, requestedRate) {
  const observed = await page.evaluate(() => {
    const summary = window.__test.getStateSummary();
    const probe = new AudioContext();
    const deviceRate = probe.sampleRate;
    void probe.close();
    return {
      session: summary.sessionSampleRate,
      doc: summary.sampleRate ?? null,
      device: deviceRate,
    };
  });
  return {
    requested: requestedRate,
    ...observed,
    adopted: observed.session !== requestedRate,
    mismatch: observed.doc !== observed.session,
  };
}

async function measureOneLaunch(probesPerLaunch, content) {
  const app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    env: { ...process.env, AUDITORIUM_TEST: '1' },
  });
  try {
    const page = await acquireMainWindow(app); // S1: the editor, not the splash
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.__test !== 'undefined', undefined, {
      timeout: 15000,
    });

    const made = await buildSession(page, content);
    const rates = await rateTriple(page, SESSION_RATE);

    const probes = [];
    for (let i = 0; i < probesPerLaunch; i++) {
      const report = await page.evaluate(() => window.__test.measureFirstPlayLatency());
      if (!report.ok) throw new Error(`probe ${i + 1} failed: ${report.reason}`);
      probes.push(report);
    }
    return { probes, made, rates };
  } finally {
    await app.close();
  }
}

function summarize(values) {
  const xs = values.filter((v) => v !== null && Number.isFinite(v));
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return {
    n: xs.length,
    min: Number(sorted[0].toFixed(1)),
    median: Number(sorted[Math.floor(sorted.length / 2)].toFixed(1)),
    max: Number(sorted[sorted.length - 1].toFixed(1)),
  };
}

async function main() {
  const launches = Number(arg('launches', '3'));
  const probesPerLaunch = Number(arg('probes-per-launch', '3'));
  const content = arg('content', 'tone');
  const outPath = path.resolve(ROOT, arg('out', path.join('test-output', 'first-play-latency.json')));
  if (!Number.isInteger(launches) || launches < 1) throw new Error('--launches must be >= 1');
  if (!Number.isInteger(probesPerLaunch) || probesPerLaunch < 1) {
    throw new Error('--probes-per-launch must be >= 1');
  }
  if (content !== 'tone' && content !== 'songs' && content !== 'mixed') {
    throw new Error(`--content must be tone, songs or mixed (got ${content})`);
  }
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing — run `npm run build` first');
  }
  if ((content === 'tone' || content === 'mixed') && !fs.existsSync(TONE)) {
    console.log('Generating test tone...');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-test-tone.cjs')], {
      stdio: 'inherit',
    });
  }
  if (content !== 'tone' && (!fs.existsSync(SONG_A) || !fs.existsSync(SONG_B))) {
    console.log('Generating 3-minute 48 kHz stereo fixtures (~35 MB each)...');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-test-latency.cjs')], {
      stdio: 'inherit',
    });
  }

  const allRuns = [];
  for (let l = 0; l < launches; l++) {
    console.log(`Launch ${l + 1}/${launches} (${probesPerLaunch} probes, content=${content})...`);
    allRuns.push(await measureOneLaunch(probesPerLaunch, content));
  }
  const allLaunches = allRuns.map((r) => r.probes);
  const sessionShape = { content, ...allRuns[0].made, rates: allRuns[0].rates };
  console.log(
    `  session: ${sessionShape.tracks} track(s), ${sessionShape.clips} clip(s) at ` +
      `${sessionShape.rates.session} Hz` +
      `${sessionShape.rates.adopted ? ` (ADOPTED — asked for ${sessionShape.rates.requested})` : ''}` +
      ` from ${sessionShape.rates.doc} Hz sources ` +
      `(${sessionShape.rates.mismatch ? 'MISMATCHED — resample branch live' : 'matched'}); ` +
      `device context ${sessionShape.rates.device} Hz`
  );

  // The P2-7 population: each launch's FIRST probe's COLD numbers (first
  // AudioContext of the process + first device open).
  const processCold = allLaunches.map((probes) => probes[0].cold);
  // Fresh context in an already-warm process (probes 2..N per launch).
  const freshCtxWarmProcess = allLaunches.flatMap((probes) => probes.slice(1).map((p) => p.cold));
  // Re-play on an already-running context (every probe's warm half).
  const warmReplays = allLaunches.flatMap((probes) => probes.map((p) => p.warm));

  const field = (rows, name) => summarize(rows.map((r) => (r ? r[name] : null)));
  const block = (rows) => ({
    ctxCreateMs: field(rows, 'ctxCreateMs'),
    playCallMs: field(rows, 'playCallMs'),
    timeToRunningMs: field(rows, 'timeToRunningMs'),
    timeToClockAdvanceMs: field(rows, 'timeToClockAdvanceMs'),
    timeToPositionAdvanceMs: field(rows, 'timeToPositionAdvanceMs'),
    outputLatencyMs: field(rows, 'outputLatencyMs'),
    baseLatencyMs: field(rows, 'baseLatencyMs'),
    audibleEstimateMs: field(rows, 'audibleEstimateMs'),
    timedOutCount: rows.filter((r) => r && r.timedOut.length > 0).length,
  });

  const verdict = {
    ok: true,
    launches,
    probesPerLaunch,
    session: sessionShape,
    processCold: block(processCold),
    freshCtxWarmProcess: block(freshCtxWarmProcess),
    warmReplays: block(warmReplays),
    initialCtxStates: processCold.map((r) => (r ? r.initialCtxState : null)),
    raw: allLaunches,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(verdict, null, 2) + '\n');

  const show = (label, b) => {
    const f = (s) => (s ? `${s.min}/${s.median}/${s.max} ms (n=${s.n})` : 'n/a');
    console.log(`  ${label}:`);
    console.log(`    audible estimate (min/median/max): ${f(b.audibleEstimateMs)}`);
    console.log(`    clock advance: ${f(b.timeToClockAdvanceMs)}   ctx create: ${f(b.ctxCreateMs)}`);
    console.log(`    play() call: ${f(b.playCallMs)}   output latency: ${f(b.outputLatencyMs)}`);
    if (b.timedOutCount > 0) console.log(`    TIMED OUT probes: ${b.timedOutCount}`);
  };
  show('PROCESS-COLD first play (the P2-7 case)', verdict.processCold);
  show('fresh context, warm process', verdict.freshCtxWarmProcess);
  show('re-play on running context', verdict.warmReplays);
  console.log(`  verdict: ${outPath}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`first-play-latency-rig FAILED: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
);
