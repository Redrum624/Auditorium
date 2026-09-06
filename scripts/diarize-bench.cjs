'use strict';

/**
 * The Separate Speakers measurement bench (D6): the numbers every claim about
 * speaker counts in this app is allowed to cite.
 *
 *   node scripts/diarize-bench.cjs [--direct] [--full-chain]
 *                                  [--assets=<dir>] [--out=<path>]
 *
 * Two modes over the same four recordings:
 *
 *   --direct      16 kHz speech straight into the diarizer. This is the
 *                 condition the 2026-09-05 policy sweep ran under, so it is
 *                 the mode whose counts are COMPARABLE to the measured
 *                 threshold (D3: t = 0.55, m = 4) — and the mode whose counts
 *                 must match the file-name truth (0-four → 4, N-two → 2) or
 *                 this process exits 1. A bench that reports a wrong count as
 *                 a row of numbers and exits 0 is how a regression ships.
 *
 *   --full-chain  what the feature actually does (D1): WAV → 44.1 kHz stereo
 *                 → HT-Demucs → the Vocals stem → 16 kHz mono → the diarizer.
 *                 No truth check: separation changes the material, and
 *                 whether the count survives it is exactly the open question
 *                 this table exists to answer. Skipped, loudly, when the
 *                 165 MB stem model is not present.
 *
 * The run is the REAL one — `createDiarizeHost` in this process (the
 * `transcribe-bench-driver.cjs` pattern) over onnxruntime-node's CPU EP and
 * the sha256-verified model files, and `assembleDiarization` from the shipped
 * renderer DSP. Nothing is mocked; a mocked ORT would pin nothing about
 * diarization. Electron IPC is the one layer NOT exercised here: it moves
 * bytes, it does not decide speakers, and `diarizeManager`'s own tests own it.
 *
 * Output: this table on stdout plus `docs/bench/diarize-bench-baseline.json`
 * (both tables, the model pins that produced them, and the machine — timings
 * are meaningless without it, so EACH TABLE names the machine that timed it,
 * not only the file). A run publishes only the tables it MEASURED: the mode
 * it did not run keeps whatever the file already held — its rows, its own
 * machine, and a `carriedFrom` stamp naming the run that produced them —
 * because `--out` defaults to that committed file and a one-mode run must not
 * blank the other half of the verdict. And a run that measured nothing — no
 * recording on this machine, or `--full-chain` alone with the 165 MB model
 * absent — exits 1 AND leaves the file exactly as it was: it has nothing to
 * publish, and rewriting `generated` alone would date another machine's
 * numbers to this run. `SPEAKER_SEPARATION_LIMITS` and
 * `KNOWN_LIMITATIONS.md` cite that file, so what it does NOT establish is
 * written into it: four recordings, ~162 s in total, count-only truth (no
 * RTTM, no DER), one four-speaker file and it is Mandarin under an
 * English-trained embedder, near-zero overlap in the material.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DIARIZE_FILES,
  getDiarizeModelPaths,
  verifyModelFile,
} = require(path.join(__dirname, '..', 'electron', 'diarizeManager.cjs'));

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_ASSETS = path.join(ROOT, 'test-assets');
const DEFAULT_OUT = path.join(ROOT, 'docs', 'bench', 'diarize-bench-baseline.json');

const MODEL_SAMPLE_RATE_16K = 16000;
const SEG_SHIFT = 16000;
const FRAME_SHIFT = 270;
const SEG_FRAMES = 589;
/** Class → local speakers, the model's powerset order (diarizeHost POWERSET). */
const POWERSET = [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]];

/**
 * Two fragments are the SAME AUDIO when the smaller one's active frames are
 * at least this much inside the other's. 0.8 is the sweep's own anchor share
 * (`overlap80`), kept so this bench's consistency column is directly
 * comparable to the numbers that chose the embedder (100/100/96.5/100 % for
 * WeSpeaker + CMN against 33–62 % for CAM++).
 */
const ANCHOR_MIN_SHARE = 0.8;

/** English number words the recordings' names use, and only those: a name
 * this table cannot read yields NO truth rather than a guessed one. */
const COUNT_WORDS = Object.freeze({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 });

/**
 * The speaker count a recording's NAME claims — the only ground truth these
 * files carry (upstream ships no RTTM; design-notes.md).
 */
function speakersFromFilename(filename) {
  const hit = /-([a-z]+)-speakers?-/i.exec(filename);
  if (!hit) return null;
  const word = hit[1].toLowerCase();
  return Object.prototype.hasOwnProperty.call(COUNT_WORDS, word) ? COUNT_WORDS[word] : null;
}

/** The four recordings the sweep measured — the bench's denominator. One that
 * is absent is a skip, never a missing row. */
const RECORDINGS = Object.freeze(
  ['1-two-speakers-en.wav', '2-two-speakers-en.wav', '3-two-speakers-en.wav', '0-four-speakers-zh.wav'].map((filename) =>
    Object.freeze({ filename, truth: speakersFromFilename(filename) })
  )
);

// --------------------------------------------------------------- the metric

/** First global frame of window `i` — the reference's `int(i·shift/rf_shift + 0.5)`. */
function windowStartFrame(windowIndex) {
  return Math.trunc((windowIndex * SEG_SHIFT) / FRAME_SHIFT + 0.5);
}

/** Every global frame where `localSpeaker` is active in `classes`. */
function activeGlobalFrames(classes, windowIndex, localSpeaker) {
  const base = windowStartFrame(windowIndex);
  const frames = new Set();
  for (let f = 0; f < SEG_FRAMES; f++) {
    if (POWERSET[classes[f]].includes(localSpeaker)) frames.add(base + f);
  }
  return frames;
}

/**
 * Audio-anchored consistency: of the fragment pairs that cover the SAME AUDIO
 * (≥ ANCHOR_MIN_SHARE of the smaller one's active frames, seen from two
 * different windows), the fraction that landed in one cluster.
 *
 * WHY this and not a cluster-quality score: with no reference segmentation
 * there is no DER to compute, but the 1 s window shift means the same speech
 * is embedded from up to ten different windows — and a partition that puts
 * one person's voice in two clusters depending on which window looked at it
 * cannot be right, whatever its silhouette says. This is what caught CAM++:
 * tight clusters (the largest within/cross gap of any variant) that follow
 * something other than speaker identity (33–62 % here, i.e. chance).
 *
 * Pairs from the SAME window are excluded: two local speakers of one window
 * are by construction different people, so co-clustering them would be the
 * error, not the agreement. Read the rate WITH the cluster count — it is
 * trivially 100 % for k = 1.
 */
function audioAnchoredConsistency(evidence, labels) {
  if (!Array.isArray(labels) || labels.length !== evidence.embeddings.length) {
    throw new Error(
      `audioAnchoredConsistency: ${evidence.embeddings.length} embeddings need ${evidence.embeddings.length} labels, got ${
        Array.isArray(labels) ? labels.length : typeof labels
      }`
    );
  }
  const sets = evidence.embeddings.map((e) =>
    activeGlobalFrames(evidence.windows[e.windowIndex], e.windowIndex, e.localSpeaker)
  );
  let pairs = 0;
  let agree = 0;
  for (let a = 0; a < sets.length; a++) {
    for (let b = a + 1; b < sets.length; b++) {
      if (evidence.embeddings[a].windowIndex === evidence.embeddings[b].windowIndex) continue;
      const smaller = sets[a].size <= sets[b].size ? sets[a] : sets[b];
      const larger = smaller === sets[a] ? sets[b] : sets[a];
      if (smaller.size === 0) continue;
      let shared = 0;
      for (const f of smaller) if (larger.has(f)) shared++;
      if (shared / smaller.size < ANCHOR_MIN_SHARE) continue;
      pairs++;
      if (labels[a] === labels[b]) agree++;
    }
  }
  return { pairs, agree, rate: pairs > 0 ? agree / pairs : null };
}

// ---------------------------------------------------------------- reporting

const COLUMNS = Object.freeze([
  'file',
  'audio',
  'win',
  'frag',
  'truth',
  'found',
  'pre',
  'raw',
  'shares %',
  'anchored',
  'stem ms',
  'seg ms',
  'emb ms',
  'ms/audio s',
]);

const DASH = '—';

function pct1(fraction) {
  return `${(fraction * 100).toFixed(1)}%`;
}

function num(value) {
  return value === null || value === undefined ? DASH : String(Math.round(value));
}

/** One measured row → its printed cells. Skipped rows have no cells (see
 * `reportLines`): a skip must never look like a measurement. */
function formatRow(row) {
  if (row.status !== 'ok') return null;
  return [
    row.file,
    `${row.audioSeconds.toFixed(1)} s`,
    String(row.windowCount),
    String(row.fragmentCount),
    String(row.truth),
    String(row.speakerCount),
    String(row.preFoldClusterCount),
    String(row.rawClusterCount),
    row.shares.map((s) => (s * 100).toFixed(1)).join('/'),
    row.consistency.rate === null ? DASH : pct1(row.consistency.rate),
    num(row.ms.stem),
    num(row.ms.segment),
    num(row.ms.embed),
    row.msPerAudioSecond.total === null ? DASH : row.msPerAudioSecond.total.toFixed(1),
  ];
}

function summaryLine(mode, rows) {
  const measured = rows.filter((r) => r.status === 'ok');
  const skipped = rows.length - measured.length;
  if (measured.length === 0) return `${mode}: no recording present — nothing measured`;
  const correct = measured.filter((r) => r.speakerCount === r.truth).length;
  return (
    `${mode}: counts ${measured.map((r) => r.speakerCount).join('/')} vs file-name truth ` +
    `${measured.map((r) => r.truth).join('/')} — ${correct} of ${measured.length} correct, ${skipped} skipped`
  );
}

const MODE_TITLES = Object.freeze({
  '--direct': '--direct — 16 kHz speech straight to the diarizer (the sweep condition)',
  '--full-chain': '--full-chain — WAV → 44.1 kHz stereo → HT-Demucs → Vocals → the diarizer (D1)',
});

function reportLines(mode, rows) {
  const cells = [COLUMNS, ...rows.map(formatRow).filter(Boolean)];
  const width = COLUMNS.map((_, i) => Math.max(...cells.map((c) => c[i].length)));
  const render = (c) => c.map((v, i) => (i === 0 ? v.padEnd(width[i]) : v.padStart(width[i]))).join('  ').trimEnd();
  const lines = [MODE_TITLES[mode] || mode, render(COLUMNS)];
  for (const row of rows) {
    if (row.status === 'ok') lines.push(render(formatRow(row)));
    else lines.push(`  skipped  ${row.file} — ${row.reason}`);
  }
  lines.push(summaryLine(mode, rows));
  return lines;
}

/** Every measured row whose count disagrees with its file name. Skips are not
 * failures — a recording nobody downloaded says nothing about the detector. */
function countMismatches(rows) {
  return rows
    .filter((r) => r.status === 'ok' && r.speakerCount !== r.truth)
    .map((r) => ({ file: r.file, truth: r.truth, found: r.speakerCount }));
}

/**
 * One mode's table. The machine is stamped INTO the table and not only onto
 * the file, because a table OUTLIVES the run that wrote the file around it:
 * `publishedTable` carries a table this run did not produce, and the file-level
 * block would then sign another machine's timings. A table that measured
 * nothing carries no stamp — there is nothing to attribute.
 */
function tableOf(mode, table, machine) {
  const rows = table.rows || [];
  const measured = rows.filter((r) => r.status === 'ok');
  return {
    mode,
    description: MODE_TITLES[mode],
    ran: Boolean(table.ran),
    ...(table.notRunReason ? { notRunReason: table.notRunReason } : {}),
    ...(measured.length > 0 && machine ? { machine } : {}),
    counts: measured.map((r) => r.speakerCount),
    truth: measured.map((r) => r.truth),
    correct: measured.filter((r) => r.speakerCount === r.truth).length,
    measured: measured.length,
    skipped: rows.length - measured.length,
    rows,
  };
}

/**
 * The table to publish for one mode: this run's when it measured something,
 * otherwise the one the file being written already holds.
 *
 * WHY: `--out` defaults to the COMMITTED `docs/bench/diarize-bench-baseline.json`,
 * the verdict `SPEAKER_SEPARATION_LIMITS` and `KNOWN_LIMITATIONS.md` cite. A
 * run of one mode (or one whose recordings are not on this machine) used to
 * write an EMPTY table over the other one and exit 0 — a measurement destroyed
 * by a run that measured nothing. A run now publishes only what it measured,
 * and a carried table says whose numbers it is and why this run did not
 * produce its own, so it can never read as fresh.
 */
function publishedTable(mode, produced, previousTable, previousGenerated, machine, previousMachine) {
  const fresh = tableOf(mode, produced || {}, machine);
  if (fresh.measured > 0) return fresh;
  if (!previousTable || previousTable.ran !== true || !(previousTable.measured > 0)) return fresh;
  return {
    ...previousTable,
    // The machine that MEASURED these rows travels with them. A baseline
    // written before that stamp existed has none on its tables, and the only
    // attribution it carries for them is the machine block of the file they
    // came from — which is where those timings were produced.
    machine: previousTable.machine ?? previousMachine ?? null,
    // Same rule for the DATE beside it: a table carried a second time keeps the
    // stamp of the run that MEASURED it, not of the file it was carried
    // through — two `--direct`-only runs in a row would otherwise date these
    // rows to a run that measured no full chain at all, and the log line below
    // prints this stamp next to the machine above it.
    carriedFrom: previousTable.carriedFrom ?? previousGenerated ?? null,
    carriedReason:
      fresh.notRunReason ?? `this run measured nothing — ${fresh.skipped} recording(s) skipped`,
  };
}

/**
 * The committed verdict. Everything a reader needs to judge the numbers
 * WITHOUT re-running: the policy constants they were produced under, the model
 * files that produced them, the machine that timed them, and what the truth is
 * (and is not). The file-level `machine` is THIS run; the machine each set of
 * timings was measured on sits on its own table, which is the one that stays
 * true when a table is carried. `previous` is the baseline this one replaces,
 * when there is one — see `publishedTable`.
 */
function buildBaseline({ generated, machine, models, direct, fullChain, previous = null, policy = POLICY }) {
  const previousTables = (previous && typeof previous === 'object' && previous.tables) || null;
  const previousGenerated = previous && typeof previous === 'object' ? previous.generated : null;
  const previousMachine = (previous && typeof previous === 'object' && previous.machine) || null;
  return {
    script: 'scripts/diarize-bench.cjs',
    generated,
    policy,
    truthSource:
      'the recordings’ own file names (0-four → 4, N-two → 2) — a COUNT only. ' +
      'Upstream ships no RTTM, so there is no per-segment truth here and no DER: a row can have ' +
      'the right count with the wrong turns. Four recordings, ~162 s in total, one of them ' +
      'four-speaker and Mandarin under an English-trained embedder, near-zero overlap.',
    models,
    machine,
    tables: {
      direct: publishedTable(
        '--direct',
        direct,
        previousTables && previousTables.direct,
        previousGenerated,
        machine,
        previousMachine
      ),
      fullChain: publishedTable(
        '--full-chain',
        fullChain,
        previousTables && previousTables.fullChain,
        previousGenerated,
        machine,
        previousMachine
      ),
    },
  };
}

/**
 * Why a run that found no disagreement still must not exit 0. A bench whose
 * tables are empty has confirmed nothing, and the exit code is the only part
 * of a bench a gate reads: `--direct` over a machine with no recordings, and
 * `--full-chain` alone with the 165 MB model absent, both used to print a
 * summary saying nothing was measured and then exit 0.
 */
function unmeasuredFailures(ranModes, tables) {
  const problems = [];
  for (const mode of ranModes) {
    const table = tables[mode === '--direct' ? 'direct' : 'fullChain'] || {};
    const measured = (table.rows || []).filter((r) => r.status === 'ok').length;
    if (measured === 0) problems.push(`${mode} ran but measured nothing — no recording present`);
  }
  if (ranModes.length === 0) problems.push('no mode ran — nothing was measured');
  return problems;
}

/**
 * The baseline this run is about to write over, so `publishedTable` can keep a
 * table this run did not produce. A file that will not parse is NOT a reason
 * to blank the tables it holds: the run refuses rather than overwrite
 * something it cannot read.
 */
function readPreviousBaseline(outPath) {
  if (!fs.existsSync(outPath)) return null;
  const text = fs.readFileSync(outPath, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `diarize-bench: ${outPath} exists but is not readable JSON (${err.message}) — refusing to overwrite it`
    );
  }
}

/** Filled in from the shipped DSP the first time the bench loads it; the
 * literals here are D3's and exist so `buildBaseline` is pure and testable
 * without the TypeScript require hook. Guarded against drift in `loadDsp`. */
const POLICY = Object.freeze({
  threshold: 0.55,
  minClusterSize: 4,
  minSpeakerShare: 0.05,
  maxSpeakers: 6,
  anchorMinShare: ANCHOR_MIN_SHARE,
});

/**
 * Every constant this bench COPIES from `src/dsp/diarization.ts`, against
 * which `loadDsp` checks the shipped module before a single number is
 * measured. Two groups, one rule:
 *
 *   - the four POLICY numbers, because the baseline PUBLISHES them and a JSON
 *     that quotes a threshold the DSP no longer runs is a false record;
 *   - the four metric constants above (SEG_SHIFT / FRAME_SHIFT / SEG_FRAMES /
 *     POWERSET), because the anchored column is computed FROM them here, in a
 *     second copy of the model geometry. A drift there does not fail — it
 *     reports a different metric under the same column name, and no fixture
 *     can see it: `trunc(16000/271 + 0.5)` is still 59, so even a FRAME_SHIFT
 *     off by one leaves `audioAnchoredConsistency`'s own tests green.
 *
 * `anchorMinShare` is deliberately NOT here. It is the bench's own metric
 * parameter (the sweep's `overlap80`), the DSP has no counterpart to compare
 * it against, and the entry that used to sit in this check compared
 * ANCHOR_MIN_SHARE with ANCHOR_MIN_SHARE — an identity that could never fire.
 */
const SHIPPED_CONSTANTS = Object.freeze({
  threshold: POLICY.threshold,
  minClusterSize: POLICY.minClusterSize,
  minSpeakerShare: POLICY.minSpeakerShare,
  maxSpeakers: POLICY.maxSpeakers,
  segShift: SEG_SHIFT,
  frameShift: FRAME_SHIFT,
  segFrames: SEG_FRAMES,
  powerset: POWERSET,
});

/**
 * Every copied constant the shipped DSP no longer agrees with, in declaration
 * order. Compared by VALUE, so a reordered POWERSET — same shape, same
 * members, different classes — is drift, and a constant that vanished under a
 * rename reads as drift rather than as a quietly matching `undefined`.
 */
function constantDrift(shipped) {
  const drift = [];
  for (const key of Object.keys(SHIPPED_CONSTANTS)) {
    const mine = SHIPPED_CONSTANTS[key];
    const theirs = shipped ? shipped[key] : undefined;
    const same =
      typeof mine === 'object' && mine !== null
        ? JSON.stringify(theirs) === JSON.stringify(mine)
        : theirs === mine;
    if (!same) drift.push({ key, shipped: theirs, bench: mine });
  }
  return drift;
}

// ------------------------------------------------------- the run (lazy deps)

/** onnxruntime, the TypeScript require hook and the renderer DSP are loaded
 * only when a run actually happens, so the report layer above stays requirable
 * from Jest with no models, no ORT and no transpiler in play. */
let dsp = null;

function loadDsp() {
  if (dsp) return dsp;
  const ts = require(path.join(ROOT, 'node_modules', 'typescript'));
  require.extensions['.ts'] = (module_, filename) => {
    const source = fs.readFileSync(filename, 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: filename,
    });
    module_._compile(outputText, filename);
  };
  const diarization = require(path.join(ROOT, 'src', 'dsp', 'diarization.ts'));
  const clustering = require(path.join(ROOT, 'src', 'dsp', 'speakerClustering.ts'));
  const wavCodec = require(path.join(ROOT, 'src', 'audio', 'wavCodec.ts'));
  const resample = require(path.join(ROOT, 'src', 'dsp', 'resample.ts'));
  // The baseline states the constants it was produced under and the anchored
  // column is computed from a second copy of the model geometry; if the
  // shipped DSP ever moves one of either group, the run stops here rather than
  // quoting the old value or measuring under a different one.
  const drift = constantDrift({
    threshold: diarization.DIARIZE_THRESHOLD,
    minClusterSize: diarization.MIN_CLUSTER_SIZE,
    minSpeakerShare: diarization.MIN_SPEAKER_SHARE,
    maxSpeakers: diarization.MAX_SPEAKERS,
    segShift: diarization.SEG_SHIFT,
    frameShift: diarization.FRAME_SHIFT,
    segFrames: diarization.SEG_FRAMES,
    powerset: diarization.POWERSET,
  });
  if (drift.length > 0) {
    throw new Error(
      `diarize-bench: src/dsp/diarization.ts now has ${drift
        .map((d) => `${d.key} = ${JSON.stringify(d.shipped)}, this bench uses ${JSON.stringify(d.bench)}`)
        .join('; ')} — re-tuning a constant means a new bench run, not an edited baseline`
    );
  }
  dsp = { diarization, clustering, wavCodec, resample };
  return dsp;
}

/**
 * D3's auto policy, re-run here for its PER-FRAGMENT LABELS — the quantity the
 * anchored metric needs and `assembleDiarization` deliberately does not
 * return (it reports speakers and segments, not cluster membership). The
 * caller checks the partition against the diarization's own reported cluster
 * counts, so a drift between this copy and the shipped policy fails the bench
 * instead of quietly changing the consistency column.
 */
function autoPartition(vectors) {
  const { diarization, clustering } = loadDsp();
  const cut = diarization.agglomerateAverage(vectors, { threshold: diarization.DIARIZE_THRESHOLD }).labels;
  const folded = diarization.foldSmallClusters(cut, vectors, { minClusterSize: diarization.MIN_CLUSTER_SIZE });
  const rawCount = new Set(folded).size;
  const labels =
    rawCount > diarization.MAX_SPEAKERS
      ? clustering.clusterSpeakers(vectors, { speakerCount: diarization.MAX_SPEAKERS }).labels
      : folded;
  return { preFoldClusterCount: new Set(cut).size, rawClusterCount: rawCount, labels };
}

function readWav(file) {
  const { wavCodec } = loadDsp();
  const buf = fs.readFileSync(file);
  return wavCodec.decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/** `transcribeService.monoMix`'s formula, inlined: that module is renderer
 * code with store imports this plain-node script must not pull in. */
function monoMix(channels, length) {
  const out = new Float32Array(length);
  if (channels.length === 0) return out;
  for (const ch of channels) {
    const n = Math.min(length, ch.length);
    for (let i = 0; i < n; i++) out[i] += ch[i];
  }
  if (channels.length > 1) for (let i = 0; i < length; i++) out[i] /= channels.length;
  return out;
}

/** One diarization run on a fresh host — the app's one-process-per-run shape
 * (D2), so the init cost the app pays every run is the init cost timed here. */
async function diarize(samples16k, modelPaths) {
  const { createDiarizeHost } = require(path.join(ROOT, 'electron', 'diarizeHost.cjs'));
  const ort = require(path.join(ROOT, 'node_modules', 'onnxruntime-node'));
  const windows = [];
  const embeddings = [];
  const errors = [];
  let lastSegmentAt = null;
  let lastEmbedAt = null;
  const host = createDiarizeHost({
    ort,
    postMessage: (m) => {
      if (m.type === 'window') windows.push(m.labels);
      else if (m.type === 'embedding') {
        embeddings.push({
          windowIndex: m.windowIndex,
          localSpeaker: m.localSpeaker,
          activeFrames: m.activeFrames,
          vector: m.vector,
        });
      } else if (m.type === 'progress') {
        if (m.stage === 'segment') lastSegmentAt = performance.now();
        else lastEmbedAt = performance.now();
      } else if (m.type === 'error') errors.push(`${m.stage}: ${m.message}`);
    },
    exit: () => {},
  });

  try {
    const tInit = performance.now();
    await host.handleMessage({ type: 'init', paths: modelPaths });
    const initMs = performance.now() - tInit;
    if (errors.length > 0) throw new Error(errors[0]);

    await host.handleMessage({ type: 'diarize', id: 1, sampleRate: MODEL_SAMPLE_RATE_16K, totalSamples: samples16k.length });
    await host.handleMessage({ type: 'audio', id: 1, offset: 0, samples: samples16k });
    const tRun = performance.now();
    await host.handleMessage({ type: 'run', id: 1 });
    const tEnd = performance.now();
    if (errors.length > 0) throw new Error(errors[0]);

    // The stage boundary is the LAST 'segment' progress: everything after it
    // is the embedding pass. Session creation is timed separately (`initMs`)
    // rather than folded into a stage — the spike's numbers excluded it, and
    // on a 16 s file it is a third of the run.
    const segmentMs = (lastSegmentAt ?? tEnd) - tRun;
    const embedMs = lastEmbedAt === null ? 0 : lastEmbedAt - (lastSegmentAt ?? tRun);
    return { windows, embeddings, initMs, segmentMs, embedMs };
  } finally {
    // Whatever happened, the ORT sessions go back to the OS before the next
    // recording loads its own — four files must not hold twelve sessions.
    await host.handleMessage({ type: 'shutdown' });
  }
}

/**
 * The Vocals stem of a 44.1 kHz stereo buffer, through the REAL stem host
 * (`scripts/stem-bench-driver.cjs`'s shape, in-process).
 *
 * Session creation is timed SEPARATELY (`stemInitMs`), exactly as the diarize
 * host's is, and for the same reason: loading the 165 MB HT-Demucs model is a
 * fixed per-run cost, so folding it into the separation stage turns
 * `msPerAudioSecond.stem` into something that falls with file length instead
 * of a rate. That column is read as a rate — it is what `MEASURED_REALTIME_FACTOR`
 * (1.52, i.e. 658 ms per audio second) is compared against — and
 * `stem-bench-driver.cjs`, which produced that constant, times the `run` only.
 */
async function separateVocals(channels44k, stemModelPath) {
  const { createStemHost } = require(path.join(ROOT, 'electron', 'stemHost.cjs'));
  const { MODEL_SAMPLE_RATE, STEM_NAMES, MODEL_CHANNELS } = require(
    path.join(ROOT, 'electron', 'stemSegmentation.cjs')
  );
  const ort = require(path.join(ROOT, 'node_modules', 'onnxruntime-node'));
  const total = channels44k[0].length;
  const posted = [];
  const host = createStemHost({ ort, postMessage: (m) => posted.push(m), exit: () => {} });
  const fail = () => {
    const err = posted.find((m) => m.type === 'error');
    if (err) throw new Error(`${err.stage}: ${err.message}`);
  };
  try {
    const tInit = performance.now();
    await host.handleMessage({ type: 'init', modelPath: stemModelPath });
    fail();
    const stemInitMs = performance.now() - tInit;
    const t0 = performance.now();
    await host.handleMessage({
      type: 'separate',
      id: 1,
      sampleRate: MODEL_SAMPLE_RATE,
      channelCount: MODEL_CHANNELS,
      totalSamples: total,
    });
    await host.handleMessage({ type: 'audio', id: 1, offset: 0, channels: [channels44k[0].slice(), channels44k[1].slice()] });
    await host.handleMessage({ type: 'run', id: 1 });
    fail();
    const stemMs = performance.now() - t0;

    const vocalsIndex = STEM_NAMES.indexOf('vocals');
    if (vocalsIndex < 0) throw new Error(`no 'vocals' stem in ${STEM_NAMES.join(', ')}`);
    const vocals = [new Float32Array(total), new Float32Array(total)];
    let covered = 0;
    for (const chunk of posted.filter((m) => m.type === 'stems')) {
      if (chunk.offset !== covered) throw new Error(`non-contiguous stems chunk at ${chunk.offset}, expected ${covered}`);
      for (let c = 0; c < MODEL_CHANNELS; c++) {
        const block = (vocalsIndex * MODEL_CHANNELS + c) * chunk.samples;
        vocals[c].set(chunk.data.subarray(block, block + chunk.samples), chunk.offset);
      }
      covered = chunk.offset + chunk.samples;
    }
    if (covered !== total) throw new Error(`stems covered ${covered} of ${total} samples`);
    return { vocals, stemMs, stemInitMs };
  } finally {
    // The 165 MB session goes back to the OS before the next recording loads
    // its own, on the error path too.
    await host.handleMessage({ type: 'shutdown' });
  }
}

const round1 = (v) => Math.round(v * 10) / 10;
const round3 = (v) => Math.round(v * 1000) / 1000;
const round4 = (v) => Math.round(v * 10000) / 10000;

/** One recording, one mode → one measured row. */
async function measure({ mode, file, filename, truth, modelPaths, stemModelPath }) {
  const { diarization, resample } = loadDsp();
  const tDecode = performance.now();
  const wav = readWav(file);
  const decodeMs = performance.now() - tDecode;

  let mono16k;
  let resampleMs = null;
  let stemMs = null;
  let stemInitMs = null;
  if (mode === '--direct') {
    const tR = performance.now();
    const mono = monoMix(wav.channels, wav.channels[0].length);
    mono16k =
      wav.sampleRate === MODEL_SAMPLE_RATE_16K
        ? mono
        : resample.resampleChannel(mono, wav.sampleRate, MODEL_SAMPLE_RATE_16K);
    resampleMs = performance.now() - tR;
  } else {
    const tR = performance.now();
    const mono = monoMix(wav.channels, wav.channels[0].length);
    const at44k = resample.resampleChannel(mono, wav.sampleRate, 44100);
    // The dialog hands the separator the document as it is; these recordings
    // are mono, so both channels carry the same signal — the stem model still
    // sees the stereo input it was trained on.
    const stereo = [at44k, Float32Array.from(at44k)];
    resampleMs = performance.now() - tR;
    const separated = await separateVocals(stereo, stemModelPath);
    stemMs = separated.stemMs;
    stemInitMs = separated.stemInitMs;
    const tR2 = performance.now();
    const vocalsMono = monoMix(separated.vocals, separated.vocals[0].length);
    mono16k = resample.resampleChannel(vocalsMono, 44100, MODEL_SAMPLE_RATE_16K);
    resampleMs += performance.now() - tR2;
  }

  const run = await diarize(mono16k, modelPaths);
  const evidence = { totalSamples16k: mono16k.length, windows: run.windows, embeddings: run.embeddings };

  const tAssemble = performance.now();
  const result = diarization.assembleDiarization(evidence);
  const assembleMs = performance.now() - tAssemble;

  let consistency = { pairs: 0, agree: 0, rate: null };
  if (run.embeddings.length > 0) {
    const partition = autoPartition(run.embeddings.map((e) => e.vector));
    if (
      partition.preFoldClusterCount !== result.preFoldClusterCount ||
      partition.rawClusterCount !== result.rawClusterCount
    ) {
      throw new Error(
        `the bench's label path drifted from assembleDiarization on ${filename}: ` +
          `pre-fold ${partition.preFoldClusterCount} vs ${result.preFoldClusterCount}, ` +
          `raw ${partition.rawClusterCount} vs ${result.rawClusterCount}`
      );
    }
    consistency = audioAnchoredConsistency(evidence, partition.labels);
  }

  const audioSeconds = mono16k.length / MODEL_SAMPLE_RATE_16K;
  const totalSpeech = result.speechSeconds.reduce((a, b) => a + b, 0);
  // `init` and `stemInit` are the two session creations — reported, and kept
  // out of the stages so `msPerAudioSecond` holds rates and not rates plus a
  // fixed cost. Both are in `total`, which is what a run actually costs.
  const ms = {
    decode: round1(decodeMs),
    init: round1(run.initMs),
    stemInit: stemInitMs === null ? null : round1(stemInitMs),
    stem: stemMs === null ? null : round1(stemMs),
    resample: round1(resampleMs),
    segment: round1(run.segmentMs),
    embed: round1(run.embedMs),
    assemble: round1(assembleMs),
    total: round1(
      (stemInitMs || 0) + (stemMs || 0) + resampleMs + run.initMs + run.segmentMs + run.embedMs + assembleMs
    ),
  };
  const per = (v) => (v === null ? null : round1(v / audioSeconds));
  return {
    file: filename,
    status: 'ok',
    truth,
    audioSeconds: round1(audioSeconds),
    windowCount: run.windows.length,
    fragmentCount: run.embeddings.length,
    speakerCount: result.speakerCount,
    preFoldClusterCount: result.preFoldClusterCount,
    rawClusterCount: result.rawClusterCount,
    shares: result.speechSeconds.map((s) => (totalSpeech > 0 ? round4(s / totalSpeech) : 0)),
    speechSeconds: result.speechSeconds.map(round3),
    segmentCount: result.segments.length,
    overlapCount: result.overlapSegments.length,
    consistency: { pairs: consistency.pairs, agree: consistency.agree, rate: consistency.rate === null ? null : round4(consistency.rate) },
    ms,
    msPerAudioSecond: {
      stem: per(ms.stem),
      segment: per(ms.segment),
      embed: per(ms.embed),
      assemble: per(ms.assemble),
      total: per(ms.total),
    },
  };
}

function machineInfo() {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus.length > 0 ? cpus[0].model.trim() : 'unknown',
    cpus: cpus.length,
    memGb: Math.round(os.totalmem() / 1024 ** 3),
    node: process.version,
    onnxruntimeNode: require(path.join(ROOT, 'node_modules', 'onnxruntime-node', 'package.json')).version,
  };
}

function arg(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(name.length + 3) : true;
}

/** Options that MUST carry a value. `--out` with none would silently overwrite
 * the COMMITTED baseline, and `--assets` with none would measure the real
 * assets while the caller believed it was pointed elsewhere. */
const VALUE_FLAGS = new Set(['--assets', '--out']);
/** Options that must NOT carry one. `--full-chain=1` parses to the STRING '1',
 * which `arg('full-chain') === true` reads as false — so the run measured
 * `--direct` (the default mode) under the name of the chain the caller asked
 * for, and wrote that down as the full-chain verdict. */
const BOOLEAN_FLAGS = new Set(['--direct', '--full-chain']);
const KNOWN_FLAGS = new Set([...BOOLEAN_FLAGS, ...VALUE_FLAGS]);

const USAGE =
  'usage: node scripts/diarize-bench.cjs [--direct] [--full-chain] [--assets=<dir>] [--out=<path>]\n';

/** What is wrong with this argv, or `null` when nothing is. */
function flagProblem(argv) {
  for (const a of argv) {
    const name = a.split('=')[0];
    if (!KNOWN_FLAGS.has(name)) return `diarize-bench: unknown option ${name}\n${USAGE}`;
    // An EMPTY value is a MISSING one: `--out=` is what an unset shell variable
    // expands to, and `path.resolve('')` is the CWD, not the default.
    if (VALUE_FLAGS.has(name) && (!a.includes('=') || a.slice(a.indexOf('=') + 1) === '')) {
      return `diarize-bench: ${name} needs a value, as ${name}=<path>\n`;
    }
    if (BOOLEAN_FLAGS.has(name) && a.includes('=')) {
      return `diarize-bench: ${name} takes no value — write it as ${name}\n`;
    }
  }
  return null;
}

async function main() {
  const log = (line) => process.stdout.write(`${line}\n`);
  const problem = flagProblem(process.argv.slice(2));
  if (problem) {
    process.stderr.write(problem);
    return 2;
  }
  const assetsArg = arg('assets');
  const assetsDir = typeof assetsArg === 'string' ? path.resolve(assetsArg) : DEFAULT_ASSETS;
  const outArg = arg('out');
  const outPath = typeof outArg === 'string' ? path.resolve(outArg) : DEFAULT_OUT;
  // Read the verdict this run will merge into BEFORE measuring: a file that
  // will not parse must stop the run at second one, not after four minutes of
  // separation.
  const previousBaseline = readPreviousBaseline(outPath);
  const wantFullChain = arg('full-chain') === true;
  // Default to the mode that carries the truth check: a bare invocation must
  // never be the one that measures nothing.
  const wantDirect = arg('direct') === true || !wantFullChain;

  // Models first: a bench that runs on an unverified file is measuring an
  // unknown (D6). Verification is the shipped one, over the shipped layout.
  const modelPaths = getDiarizeModelPaths(assetsDir);
  for (const f of DIARIZE_FILES) {
    const verdict = await verifyModelFile(modelPaths[f.key], { expectedSha256: f.sha256, expectedBytes: f.bytes });
    if (!verdict.ok) {
      process.stderr.write(
        `diarize-bench: ${f.filename} failed verification (${verdict.reason}: ${verdict.detail}).\n` +
          'Run `node scripts/fetch-diarization-assets.cjs` first.\n'
      );
      return 1;
    }
  }
  log(`models verified: ${DIARIZE_FILES.map((f) => f.filename).join(', ')}`);

  const recordingDir = path.join(assetsDir, 'diarization');
  const present = RECORDINGS.map((r) => ({ ...r, file: path.join(recordingDir, r.filename) })).map((r) => ({
    ...r,
    exists: fs.existsSync(r.file),
  }));

  let stemModelPath = null;
  let fullChainSkip = null;
  if (wantFullChain) {
    const { getModelPath, MODEL_SHA256, MODEL_BYTES } = require(path.join(ROOT, 'electron', 'stemManager.cjs'));
    stemModelPath = getModelPath(assetsDir);
    const verdict = await verifyModelFile(stemModelPath, { expectedSha256: MODEL_SHA256, expectedBytes: MODEL_BYTES });
    if (!verdict.ok) {
      fullChainSkip = `the HT-Demucs model failed verification (${verdict.reason}: ${verdict.detail})`;
      log(`--full-chain skipped: ${fullChainSkip}`);
    }
  }

  // Arm the policy-drift guard even on a run that measures nothing: the
  // baseline states the constants either way, so they must be checked either
  // way.
  loadDsp();

  const tables = {
    direct: { ran: false, rows: [], notRunReason: 'not requested (run with --direct)' },
    fullChain: { ran: false, rows: [], notRunReason: 'not requested (run with --full-chain)' },
  };
  const modes = [];
  if (wantDirect) modes.push('--direct');
  if (wantFullChain && !fullChainSkip) modes.push('--full-chain');
  if (wantFullChain && fullChainSkip) tables.fullChain.notRunReason = fullChainSkip;

  for (const mode of modes) {
    const rows = [];
    for (const rec of present) {
      if (!rec.exists) {
        rows.push({ file: rec.filename, status: 'skipped', truth: rec.truth, reason: 'not present' });
        continue;
      }
      rows.push(await measure({ mode, file: rec.file, filename: rec.filename, truth: rec.truth, modelPaths, stemModelPath }));
    }
    const key = mode === '--direct' ? 'direct' : 'fullChain';
    tables[key] = { ran: true, rows };
    log('');
    for (const line of reportLines(mode, rows)) log(line);
  }

  const outLabel = path.relative(ROOT, outPath) || outPath;

  // Half the exit rule (D6) is decided BEFORE the write: a run that measured
  // nothing confirms nothing, so it neither reports success nor publishes.
  // Stamping a fresh `generated` over tables it did not produce would date
  // another machine's numbers to this run, and `generated` is what a reader
  // uses to tell a fresh table from a carried one.
  const empty = unmeasuredFailures(modes, tables);
  for (const failure of empty) process.stderr.write(`diarize-bench: ${failure}\n`);
  if (empty.length > 0) {
    log('');
    log(`nothing measured — ${outLabel} left as it was`);
    return 1;
  }

  const baseline = buildBaseline({
    generated: new Date().toISOString(),
    machine: machineInfo(),
    models: DIARIZE_FILES.map((f) => ({ key: f.key, filename: f.filename, bytes: f.bytes, sha256: f.sha256 })),
    direct: tables.direct,
    fullChain: tables.fullChain,
    previous: previousBaseline,
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(baseline, null, 2)}\n`);
  log('');
  log(`wrote ${outLabel}`);
  for (const key of ['direct', 'fullChain']) {
    const table = baseline.tables[key];
    if (!table.carriedFrom) continue;
    const where = table.machine && table.machine.cpu ? table.machine.cpu : 'an unrecorded machine';
    log(`  ${key}: kept the table measured at ${table.carriedFrom} on ${where} (${table.carriedReason})`);
  }

  // The other half: only --direct is judged against the file-name truth.
  const mismatches = countMismatches(tables.direct.rows);
  if (mismatches.length > 0) {
    process.stderr.write(
      `diarize-bench: ${mismatches.length} --direct count(s) disagree with the file name — ` +
        `${mismatches.map((m) => `${m.file}: found ${m.found}, name says ${m.truth}`).join('; ')}\n`
    );
  }
  return mismatches.length > 0 ? 1 : 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
      process.exit(1);
    }
  );
}

module.exports = {
  RECORDINGS,
  ANCHOR_MIN_SHARE,
  COLUMNS,
  POLICY,
  SHIPPED_CONSTANTS,
  constantDrift,
  loadDsp,
  speakersFromFilename,
  audioAnchoredConsistency,
  formatRow,
  reportLines,
  summaryLine,
  countMismatches,
  unmeasuredFailures,
  flagProblem,
  buildBaseline,
  main,
};
