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
//   node scripts/first-play-latency-rig.cjs [--launches=3] [--probes-per-launch=3] [--out=<path>]
//
// Verdict JSON: test-output/first-play-latency.json (default). Exit 0 when
// every probe ran (whatever the numbers say — this is a measurement, not a
// gate); exit 1 on rig failure.

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TONE = path.join(ROOT, 'test-assets', 'tone.wav');

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

async function measureOneLaunch(probesPerLaunch) {
  const app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    env: { ...process.env, AUDITORIUM_TEST: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.__test !== 'undefined', undefined, {
      timeout: 15000,
    });

    // One-track session with a 2 s tone clip at 0 — the minimal schedulable
    // session, so playCallMs measures graph build, not content size.
    await page.evaluate((p) => window.__test.openPath(p), TONE);
    await page.evaluate(() => window.__test.newSession(44100));
    const inserted = await page.evaluate(() => window.__test.insertActiveDocAsClip(0, 0));
    if (!inserted) throw new Error('insertActiveDocAsClip returned null');

    const probes = [];
    for (let i = 0; i < probesPerLaunch; i++) {
      const report = await page.evaluate(() => window.__test.measureFirstPlayLatency());
      if (!report.ok) throw new Error(`probe ${i + 1} failed: ${report.reason}`);
      probes.push(report);
    }
    return probes;
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
  const outPath = path.resolve(ROOT, arg('out', path.join('test-output', 'first-play-latency.json')));
  if (!Number.isInteger(launches) || launches < 1) throw new Error('--launches must be >= 1');
  if (!Number.isInteger(probesPerLaunch) || probesPerLaunch < 1) {
    throw new Error('--probes-per-launch must be >= 1');
  }
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing — run `npm run build` first');
  }
  if (!fs.existsSync(TONE)) {
    console.log('Generating test tone...');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-test-tone.cjs')], {
      stdio: 'inherit',
    });
  }

  const allLaunches = [];
  for (let l = 0; l < launches; l++) {
    console.log(`Launch ${l + 1}/${launches} (${probesPerLaunch} probes)...`);
    allLaunches.push(await measureOneLaunch(probesPerLaunch));
  }

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
