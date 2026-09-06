'use strict';

/**
 * D6 — the measurement scripts of Separate Speakers, pinned at the level a
 * test can reach without a 32.5 MB model set or onnxruntime: the pure report
 * and baseline layer of `diarize-bench.cjs`, its exit rule, and the
 * provisioning decisions of `fetch-diarization-assets.cjs`.
 *
 * The measurement table itself is NOT produced here: it needs the pinned
 * models and the four recordings (both gitignored), and the whole point of the
 * bench is that its numbers come from the real host — a mocked ORT would pin
 * nothing about diarization. The table is produced by ACTUALLY running the
 * bench (`node scripts/diarize-bench.cjs --direct --full-chain`), whose verdict
 * is committed at `docs/bench/diarize-bench-baseline.json` and read back here
 * for the properties a reader relies on. What this file guards is that the
 * verdict is reported honestly: a missing recording renders as a skip and never
 * as a row of numbers, a count that disagrees with the file-name truth fails
 * the PROCESS (not just a predicate), and a run that measured nothing neither
 * exits 0 nor overwrites the table a run that did measure something produced.
 *
 * Those last two are pinned by running the CLI for real. When the model set is
 * on this machine they run against a scratch assets root under `test-assets/`
 * with the 32.5 MB models hard-linked into it (no copy, no download); when it
 * is not, they are skipped rather than faked — the `prod-csp.test.cjs` pattern.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const bench = require(path.join(ROOT, 'scripts', 'diarize-bench.cjs'));
const fetcher = require(path.join(ROOT, 'scripts', 'fetch-diarization-assets.cjs'));

// ---------------------------------------------------------------- fixtures

/** Frame → powerset class, the model's own order (diarizeHost POWERSET). */
const CLASS_OF = new Map([
  ['', 0],
  ['0', 1],
  ['1', 2],
  ['2', 3],
  ['0,1', 4],
  ['0,2', 5],
  ['1,2', 6],
]);

/** One window of 589 class bytes from half-open active runs per local speaker. */
function windowWith(runs) {
  const active = Array.from({ length: 589 }, () => new Set());
  for (const run of runs) {
    for (let f = run.from; f < run.to; f++) active[f].add(run.local);
  }
  const w = new Uint8Array(589);
  for (let f = 0; f < 589; f++) {
    const key = [...active[f]].sort().join(',');
    const cls = CLASS_OF.get(key);
    if (cls === undefined) throw new Error(`fixture frame ${f} has no powerset class for {${key}}`);
    w[f] = cls;
  }
  return w;
}

/**
 * Three fragments whose ACTIVE AUDIO overlaps by known amounts. Window 1
 * starts at global frame 59 (`trunc(16000/270 + 0.5)`), so:
 *   A = window 0, local 0, global frames 100..109   (10 frames)
 *   B = window 1, local 0, global frames 102..111   (10 frames) → |A∩B| = 8
 *   C = window 1, local 1, global frames 103..112   (10 frames) → |A∩C| = 7
 * A/B sits EXACTLY on the 0.8 anchor share, A/C one frame past it, and B/C
 * (0.9) shares a window — three different reasons for three different
 * verdicts out of one fixture.
 */
function anchorEvidence() {
  const w0 = windowWith([{ local: 0, from: 100, to: 110 }]);
  const w1 = windowWith([
    { local: 0, from: 43, to: 53 },
    { local: 1, from: 44, to: 54 },
  ]);
  const vector = Float32Array.from([0.6, 0.8, 0, 0]);
  return {
    totalSamples16k: 176000,
    windows: [w0, w1],
    embeddings: [
      { windowIndex: 0, localSpeaker: 0, activeFrames: 10, vector },
      { windowIndex: 1, localSpeaker: 0, activeFrames: 10, vector },
      { windowIndex: 1, localSpeaker: 1, activeFrames: 10, vector },
    ],
  };
}

/** A measured-shaped row, off identity values (nothing here is 0, 1 or equal). */
function okRow(overrides = {}) {
  return {
    file: '2-two-speakers-en.wav',
    status: 'ok',
    truth: 2,
    audioSeconds: 34,
    windowCount: 25,
    fragmentCount: 48,
    speakerCount: 2,
    preFoldClusterCount: 3,
    rawClusterCount: 2,
    shares: [0.5928, 0.4072],
    speechSeconds: [16.117, 11.069],
    segmentCount: 9,
    overlapCount: 1,
    consistency: { pairs: 136, agree: 129, rate: 129 / 136 },
    ms: { decode: 12, stemInit: null, stem: null, resample: null, segment: 214, embed: 1893, assemble: 3, total: 2110 },
    msPerAudioSecond: { stem: null, segment: 6.3, embed: 55.7, assemble: 0.1, total: 62.1 },
    ...overrides,
  };
}

function skippedRow(overrides = {}) {
  return { file: '3-two-speakers-en.wav', status: 'skipped', truth: 2, reason: 'not present', ...overrides };
}

// ------------------------------------------------- audio-anchored consistency

describe('audioAnchoredConsistency', () => {
  it('counts a pair at EXACTLY the 0.8 anchor share and drops the one a frame past it', () => {
    const ev = anchorEvidence();
    const out = bench.audioAnchoredConsistency(ev, [0, 1, 0]);
    // A/B = 8 of min(10,10) = 0.80 → in. A/C = 7/10 = 0.70 → out. B/C = 0.9
    // but shares a window: two local speakers of one window are by
    // construction different people, so they are never a same-audio pair.
    expect(out.pairs).toBe(1);
    expect(out.agree).toBe(0);
    expect(out.rate).toBe(0);
  });

  it('scores agreement, not co-occurrence: the same pair with one label is 100 %', () => {
    const ev = anchorEvidence();
    expect(bench.audioAnchoredConsistency(ev, [0, 0, 1])).toEqual({ pairs: 1, agree: 1, rate: 1 });
  });

  it('reports no rate at all when nothing overlaps enough to anchor', () => {
    const ev = anchorEvidence();
    // Move C's window far away: window 5 starts at frame 296, no shared audio.
    ev.windows.push(windowWith([{ local: 0, from: 43, to: 53 }]));
    const isolated = {
      totalSamples16k: ev.totalSamples16k,
      windows: ev.windows,
      embeddings: [ev.embeddings[0], { windowIndex: 2, localSpeaker: 0, activeFrames: 10, vector: ev.embeddings[0].vector }],
    };
    expect(bench.audioAnchoredConsistency(isolated, [0, 1])).toEqual({ pairs: 0, agree: 0, rate: null });
  });

  it('refuses a label list that does not match the embeddings', () => {
    expect(() => bench.audioAnchoredConsistency(anchorEvidence(), [0, 1])).toThrow(/3 embeddings/);
  });

  it('pins the anchor share at the value the sweep measured with', () => {
    expect(bench.ANCHOR_MIN_SHARE).toBe(0.8);
  });
});

// --------------------------------------------------------- file-name truth

describe('speakersFromFilename', () => {
  it('reads the count out of the sherpa recording names', () => {
    expect(bench.speakersFromFilename('0-four-speakers-zh.wav')).toBe(4);
    expect(bench.speakersFromFilename('2-two-speakers-en.wav')).toBe(2);
  });

  it('is null when the name carries no count, so no truth is invented', () => {
    expect(bench.speakersFromFilename('tone.wav')).toBeNull();
    expect(bench.speakersFromFilename('7-many-speakers-en.wav')).toBeNull();
  });

  it('gives every pinned recording a truth', () => {
    expect(bench.RECORDINGS.map((r) => r.truth)).toEqual([2, 2, 2, 4]);
    for (const r of bench.RECORDINGS) expect(bench.speakersFromFilename(r.filename)).toBe(r.truth);
  });
});

// ------------------------------------------------------------ report lines

describe('report lines', () => {
  it('renders a measured row as cells, sharing percentages and stage times', () => {
    expect(bench.formatRow(okRow())).toEqual([
      '2-two-speakers-en.wav',
      '34.0 s',
      '25',
      '48',
      '2',
      '2',
      '3',
      '2',
      '59.3/40.7',
      '94.9%',
      '—',
      '214',
      '1893',
      '62.1',
    ]);
  });

  it('shows the stem stage only when the full chain ran it', () => {
    const row = okRow({ ms: { ...okRow().ms, stemInit: 9631, stem: 22417 }, msPerAudioSecond: { ...okRow().msPerAudioSecond, stem: 659.3 } });
    expect(bench.formatRow(row)[10]).toBe('22417');
  });

  it('gives a skipped recording a skip line and NO numbers', () => {
    const lines = bench.reportLines('--direct', [okRow(), skippedRow()]);
    const skip = lines.find((l) => l.includes('3-two-speakers-en.wav'));
    expect(skip).toBe('  skipped  3-two-speakers-en.wav — not present');
    expect(lines.filter((l) => l.includes('3-two-speakers-en.wav'))).toHaveLength(1);
  });

  it('summarises the counts against the file-name truth', () => {
    const rows = [okRow(), okRow({ file: '0-four-speakers-zh.wav', truth: 4, speakerCount: 3 }), skippedRow()];
    expect(bench.summaryLine('--direct', rows)).toBe(
      '--direct: counts 2/3 vs file-name truth 2/4 — 1 of 2 correct, 1 skipped'
    );
  });

  it('says nothing was measured rather than claiming a perfect score on zero rows', () => {
    expect(bench.summaryLine('--direct', [skippedRow()])).toBe('--direct: no recording present — nothing measured');
  });

  it('puts the header, every row and the summary in the printed block', () => {
    const lines = bench.reportLines('--direct', [okRow(), skippedRow()]);
    expect(lines[0]).toContain('--direct');
    expect(lines.some((l) => l.includes('anchored') && l.includes('truth'))).toBe(true);
    expect(lines.some((l) => l.includes('59.3/40.7'))).toBe(true);
    expect(lines[lines.length - 1]).toBe(bench.summaryLine('--direct', [okRow(), skippedRow()]));
  });
});

// -------------------------------------------------------------- exit rule

describe('the exit rule', () => {
  it('names every direct row whose count disagrees with its file name', () => {
    const rows = [okRow(), okRow({ file: '0-four-speakers-zh.wav', truth: 4, speakerCount: 3 })];
    expect(bench.countMismatches(rows)).toEqual([{ file: '0-four-speakers-zh.wav', truth: 4, found: 3 }]);
  });

  it('does not treat a skipped recording as a wrong count', () => {
    expect(bench.countMismatches([skippedRow()])).toEqual([]);
  });

  it('is clean when every measured count matches', () => {
    expect(bench.countMismatches([okRow(), okRow({ file: '0-four-speakers-zh.wav', truth: 4, speakerCount: 4 })])).toEqual([]);
  });
});

// ---------------------------------------------------------- baseline shape

describe('buildBaseline', () => {
  const models = [{ key: 'segmentation', filename: 'pyannote-segmentation-3.0.onnx', bytes: 5992913, sha256: '220ad67c' }];
  const machine = { platform: 'win32', arch: 'x64', cpu: 'A CPU', cpus: 16, memGb: 64, node: 'v24.13.0', onnxruntimeNode: '1.27.0' };

  function baseline(over = {}) {
    return bench.buildBaseline({
      generated: '2026-09-05T21:00:00.000Z',
      machine,
      models,
      direct: { ran: true, rows: [okRow(), skippedRow()] },
      fullChain: { ran: false, notRunReason: 'the HT-Demucs model is not present', rows: [] },
      ...over,
    });
  }

  it('carries both tables, the model pins and the machine', () => {
    const out = baseline();
    expect(Object.keys(out)).toEqual(['script', 'generated', 'policy', 'truthSource', 'models', 'machine', 'tables']);
    expect(out.script).toBe('scripts/diarize-bench.cjs');
    expect(out.generated).toBe('2026-09-05T21:00:00.000Z');
    expect(out.models).toEqual(models);
    expect(out.machine).toEqual(machine);
    expect(Object.keys(out.tables)).toEqual(['direct', 'fullChain']);
  });

  it('stamps the measured table with the machine that timed it, not only the file', () => {
    // Timings are meaningless without the machine (this script's own header
    // says so) — and a table OUTLIVES the run that wrote the file around it
    // when the next run carries it, so the stamp travels with the table.
    expect(baseline().tables.direct.machine).toEqual(machine);
  });

  it('records the policy constants the numbers were produced under', () => {
    expect(baseline().policy).toEqual({
      threshold: 0.55,
      minClusterSize: 4,
      minSpeakerShare: 0.05,
      maxSpeakers: 6,
      anchorMinShare: 0.8,
    });
  });

  it('keeps the skipped row as a skip, with no measurements beside it', () => {
    const table = baseline().tables.direct;
    expect(table.ran).toBe(true);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1]).toEqual({ file: '3-two-speakers-en.wav', status: 'skipped', truth: 2, reason: 'not present' });
    expect(table.counts).toEqual([2]);
    expect(table.truth).toEqual([2]);
    expect(table.correct).toBe(1);
    expect(table.measured).toBe(1);
    expect(table.skipped).toBe(1);
  });

  it('says why a table did not run instead of leaving an empty one to read as a pass', () => {
    const table = baseline().tables.fullChain;
    expect(table.ran).toBe(false);
    expect(table.notRunReason).toBe('the HT-Demucs model is not present');
    expect(table.rows).toEqual([]);
    expect(table.correct).toBe(0);
    expect(table.measured).toBe(0);
  });
});

// ------------------------------------------------------------ the CLI shell

describe('the CLI', () => {
  let tmp;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diarize-bench-'));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function run(args) {
    try {
      const stdout = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'diarize-bench.cjs'), ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
    }
  }

  it('refuses to measure anything when the model set is not verified', () => {
    const out = run([`--assets=${tmp}`, `--out=${path.join(tmp, 'baseline.json')}`, '--direct']);
    expect(out.code).toBe(1);
    expect(`${out.stdout}${out.stderr}`).toContain('pyannote-segmentation-3.0.onnx');
    expect(fs.existsSync(path.join(tmp, 'baseline.json'))).toBe(false);
  });

  it('rejects an unknown mode instead of silently measuring nothing', () => {
    const out = run([`--assets=${tmp}`, '--sideways']);
    expect(out.code).toBe(2);
    expect(`${out.stdout}${out.stderr}`).toContain('--sideways');
  });

  it('refuses to overwrite a verdict file it cannot read', () => {
    // The merge needs the old file; a file that will not parse is a reason to
    // stop, not a reason to blank whatever it holds. It stops BEFORE the run,
    // so nobody loses four minutes of separation to it.
    const bad = path.join(tmp, 'unreadable.json');
    fs.writeFileSync(bad, 'not json at all\n');
    const out = run([`--assets=${tmp}`, `--out=${bad}`, '--direct']);
    expect(out.code).toBe(1);
    expect(`${out.stdout}${out.stderr}`).toContain('refusing to overwrite it');
    expect(fs.readFileSync(bad, 'utf8')).toBe('not json at all\n');
  });
});

// ------------------------------------------------- fetch-diarization-assets

describe('fetch-diarization-assets.cjs', () => {
  it('pins the four recordings at the sizes the release serves', () => {
    expect(fetcher.RECORDINGS.map((r) => [r.filename, r.bytes])).toEqual([
      ['0-four-speakers-zh.wav', 1819586],
      ['1-two-speakers-en.wav', 512044],
      ['2-two-speakers-en.wav', 1088078],
      ['3-two-speakers-en.wav', 1753804],
    ]);
  });

  it('fetches each recording from the sherpa-onnx release that published it', () => {
    for (const r of fetcher.RECORDINGS) {
      expect(r.url).toBe(
        `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/${r.filename}`
      );
    }
  });

  it('keeps a file at its pinned size, re-fetches one that is not, and fetches what is absent', () => {
    expect(fetcher.planFile(512044, 512044)).toBe('present');
    expect(fetcher.planFile(512043, 512044)).toBe('refetch');
    expect(fetcher.planFile(512045, 512044)).toBe('refetch');
    expect(fetcher.planFile(null, 512044)).toBe('fetch');
  });

  it('writes a sidecar sha256sum -c can check, with the provenance in comments', () => {
    const text = fetcher.sidecarText([
      { filename: '1-two-speakers-en.wav', sha256: 'f1c877dc' },
      { filename: '0-four-speakers-zh.wav', sha256: 'bedf036c' },
    ]);
    const lines = text.split('\n');
    expect(lines.filter((l) => l.startsWith('#')).length).toBeGreaterThan(0);
    expect(text).toContain('sherpa-onnx');
    expect(text).toContain('not redistributed');
    expect(lines.filter((l) => l && !l.startsWith('#'))).toEqual([
      'f1c877dc *1-two-speakers-en.wav',
      'bedf036c *0-four-speakers-zh.wav',
    ]);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('resolves the models into the layout getDiarizeModelPaths reads', () => {
    const { getDiarizeModelPaths } = require(path.join(ROOT, 'electron', 'diarizeManager.cjs'));
    const assets = path.join(ROOT, 'test-assets');
    expect(fetcher.modelDestinations(assets)).toEqual(getDiarizeModelPaths(assets));
  });

  /**
   * The header pairs a recording with a duration, and that pairing is how a
   * reader knows what the bench's ~162 s of material is made of. Written as
   * four names followed by four numbers it went silently positional against
   * design-notes.md's own (unsorted) order: 0-four — 56.9 s read as 16.0 s,
   * and 3-two — 54.8 s read as 56.9 s. Each name carries its own number now,
   * and the truth it is checked against is the bench's MEASURED audioSeconds.
   */
  it('pairs each recording with its own measured duration in the header', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'fetch-diarization-assets.cjs'), 'utf8');
    const stated = new Map(
      [...source.matchAll(/^\s*\*\s+(\d-[a-z]+-speakers-[a-z]+\.wav)\s+—\s+([\d.]+) s\r?$/gm)].map((m) => [
        m[1],
        Number(m[2]),
      ])
    );
    const measured = new Map(
      JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'bench', 'diarize-bench-baseline.json'), 'utf8'))
        .tables.direct.rows.filter((r) => r.status === 'ok')
        .map((r) => [r.file, r.audioSeconds])
    );
    expect([...stated.keys()].sort()).toEqual(fetcher.RECORDINGS.map((r) => r.filename));
    for (const [filename, seconds] of stated) {
      expect(measured.has(filename)).toBe(true);
      expect(seconds).toBeCloseTo(measured.get(filename), 1);
    }
  });
});

// ------------------------------------------------------------- flag parsing

/**
 * A BOOLEAN flag written with a value is the failure this section exists for:
 * `--verify=true` and `--full-chain=1` both parse to the STRING 'true'/'1',
 * which every `arg(...) === true` test in these scripts then reads as false.
 * The read-only check became a 37 MB fetch, and `--full-chain` ran `--direct`.
 */
describe('flagProblem', () => {
  it('accepts the documented forms of both scripts', () => {
    expect(bench.flagProblem(['--direct'])).toBeNull();
    expect(bench.flagProblem(['--full-chain', '--assets=x', '--out=y'])).toBeNull();
    expect(bench.flagProblem([])).toBeNull();
    expect(fetcher.flagProblem(['--verify', '--assets=x'])).toBeNull();
    expect(fetcher.flagProblem([])).toBeNull();
  });

  it('refuses a boolean flag carrying a value, which parses as its opposite', () => {
    expect(bench.flagProblem(['--full-chain=1'])).toMatch(/--full-chain takes no value/);
    expect(bench.flagProblem(['--direct=true'])).toMatch(/--direct takes no value/);
    expect(fetcher.flagProblem(['--verify=true'])).toMatch(/--verify takes no value/);
    expect(fetcher.flagProblem(['--verify=0'])).toMatch(/--verify takes no value/);
  });

  it('still refuses a value flag with no value, and an unknown flag', () => {
    expect(bench.flagProblem(['--assets'])).toMatch(/--assets needs a value/);
    expect(bench.flagProblem(['--out'])).toMatch(/--out needs a value/);
    expect(bench.flagProblem(['--sideways'])).toMatch(/unknown option --sideways/);
    expect(fetcher.flagProblem(['--assets'])).toMatch(/--assets needs a value/);
    expect(fetcher.flagProblem(['--fetch-everything'])).toMatch(/unknown option --fetch-everything/);
  });

  /**
   * `--assets=` is what an unset shell variable expands to, and it does NOT
   * mean "use the default": `path.resolve('')` is the CWD, so the fetcher
   * would pull the 32.5 MB model set and the non-redistributable recordings
   * into `<cwd>/models/diarization/` and `<cwd>/diarization/` — neither of
   * which .gitignore covers (it ignores `test-assets/` only). An empty value
   * is a missing value.
   */
  it('refuses a value flag written with an empty value, which resolves to the CWD', () => {
    expect(fetcher.flagProblem(['--assets='])).toMatch(/--assets needs a value/);
    expect(fetcher.flagProblem(['--assets=', '--verify'])).toMatch(/--assets needs a value/);
    expect(bench.flagProblem(['--assets='])).toMatch(/--assets needs a value/);
    expect(bench.flagProblem(['--out='])).toMatch(/--out needs a value/);
  });
});

// ------------------------------------------ the baseline this run overwrites

const MODELS_FIXTURE = [
  { key: 'segmentation', filename: 'pyannote-segmentation-3.0.onnx', bytes: 5992913, sha256: '220ad67c' },
];
const MACHINE_FIXTURE = {
  platform: 'win32',
  arch: 'x64',
  cpu: 'A CPU',
  cpus: 16,
  memGb: 64,
  node: 'v24.13.0',
  onnxruntimeNode: '1.27.0',
};

/** A committed-looking verdict: both tables measured, on two different files. */
function committedBaseline(generated = '2026-09-05T20:00:00.000Z') {
  return bench.buildBaseline({
    generated,
    machine: MACHINE_FIXTURE,
    models: MODELS_FIXTURE,
    direct: { ran: true, rows: [okRow()] },
    fullChain: {
      ran: true,
      rows: [okRow({ file: '3-two-speakers-en.wav', audioSeconds: 54.8, speakerCount: 2 })],
    },
  });
}

describe('buildBaseline merges with the baseline it is about to overwrite', () => {
  function rerun(over) {
    return bench.buildBaseline({
      generated: '2026-09-06T09:00:00.000Z',
      machine: MACHINE_FIXTURE,
      models: MODELS_FIXTURE,
      previous: committedBaseline(),
      ...over,
    });
  }

  it('keeps the table this run did not produce, stamped with the run that did', () => {
    const out = rerun({
      direct: { ran: true, rows: [okRow()] },
      fullChain: { ran: false, rows: [], notRunReason: 'not requested (run with --full-chain)' },
    });
    expect(out.tables.fullChain.rows).toEqual(committedBaseline().tables.fullChain.rows);
    expect(out.tables.fullChain.measured).toBe(1);
    expect(out.tables.fullChain.ran).toBe(true);
    expect(out.tables.fullChain.carriedFrom).toBe('2026-09-05T20:00:00.000Z');
    expect(out.tables.fullChain.carriedReason).toBe('not requested (run with --full-chain)');
    // The table this run DID measure is this run's, with no carry stamp.
    expect(out.tables.direct.carriedFrom).toBeUndefined();
    expect(out.tables.direct.rows).toEqual([okRow()]);
  });

  it('does not let a run that measured nothing overwrite a table that did', () => {
    const out = rerun({
      direct: { ran: true, rows: [skippedRow(), skippedRow({ file: '1-two-speakers-en.wav' })] },
      fullChain: { ran: false, rows: [], notRunReason: 'not requested (run with --full-chain)' },
    });
    expect(out.tables.direct.rows).toEqual(committedBaseline().tables.direct.rows);
    expect(out.tables.direct.measured).toBe(1);
    expect(out.tables.direct.carriedFrom).toBe('2026-09-05T20:00:00.000Z');
    expect(out.tables.direct.carriedReason).toMatch(/measured nothing/);
  });

  it('publishes the honest empty table when there is nothing to carry', () => {
    const out = bench.buildBaseline({
      generated: '2026-09-06T09:00:00.000Z',
      machine: MACHINE_FIXTURE,
      models: MODELS_FIXTURE,
      direct: { ran: true, rows: [okRow()] },
      fullChain: { ran: false, rows: [], notRunReason: 'the HT-Demucs model is not present' },
      previous: null,
    });
    expect(out.tables.fullChain.ran).toBe(false);
    expect(out.tables.fullChain.notRunReason).toBe('the HT-Demucs model is not present');
    expect(out.tables.fullChain.rows).toEqual([]);
    expect(out.tables.fullChain.carriedFrom).toBeUndefined();
  });

  it('will not carry a previous table that measured nothing either', () => {
    const empty = bench.buildBaseline({
      generated: '2026-09-05T20:00:00.000Z',
      machine: MACHINE_FIXTURE,
      models: MODELS_FIXTURE,
      direct: { ran: true, rows: [skippedRow()] },
      fullChain: { ran: false, rows: [], notRunReason: 'not requested (run with --full-chain)' },
    });
    const out = rerun({
      direct: { ran: true, rows: [skippedRow()] },
      fullChain: { ran: false, rows: [], notRunReason: 'not requested (run with --full-chain)' },
      previous: empty,
    });
    expect(out.tables.direct.rows).toEqual([skippedRow()]);
    expect(out.tables.direct.carriedFrom).toBeUndefined();
  });

  /**
   * The failure this pins: a carried table keeps the rows machine A measured
   * while the file around it is stamped with machine B's `machine` block — B
   * signing A's timings, with nothing in the file to say otherwise, because
   * there was no per-table machine at all. The stamp travels with the table.
   */
  it('keeps the carried table stamped with the machine that measured it', () => {
    const other = { ...MACHINE_FIXTURE, cpu: 'Xeon Gold 6248 (CI runner)', cpus: 40, memGb: 192 };
    const previous = bench.buildBaseline({
      generated: '2026-09-05T20:00:00.000Z',
      machine: other,
      models: MODELS_FIXTURE,
      direct: { ran: true, rows: [okRow()] },
      fullChain: { ran: true, rows: [okRow({ file: '3-two-speakers-en.wav', audioSeconds: 54.8 })] },
    });
    const out = rerun({
      direct: { ran: true, rows: [okRow()] },
      fullChain: { ran: false, rows: [], notRunReason: 'not requested (run with --full-chain)' },
      previous,
    });
    expect(out.machine).toEqual(MACHINE_FIXTURE);
    expect(out.tables.direct.machine).toEqual(MACHINE_FIXTURE);
    expect(out.tables.fullChain.machine).toEqual(other);
    expect(out.tables.fullChain.rows).toEqual(previous.tables.fullChain.rows);
  });

  /**
   * The SECOND carry. A table carried once already names the run that measured
   * it; carrying it again must not re-date it to the file it was merely carried
   * THROUGH — that file's run measured nothing of this mode, and the header
   * (:38-40) says a carried table keeps "a `carriedFrom` stamp naming the run
   * that produced them". Two `--direct`-only runs in a row is all it takes, and
   * `main` prints `carriedFrom` beside the table's own machine, so a drifting
   * stamp makes the two halves of one log line disagree.
   */
  it('does not re-date or re-sign a table that was already carried once', () => {
    const other = { ...MACHINE_FIXTURE, cpu: 'Xeon Gold 6248 (CI runner)', cpus: 40, memGb: 192 };
    const original = bench.buildBaseline({
      generated: '2026-09-05T20:00:00.000Z',
      machine: other,
      models: MODELS_FIXTURE,
      direct: { ran: true, rows: [okRow()] },
      fullChain: {
        ran: true,
        rows: [okRow({ file: '3-two-speakers-en.wav', audioSeconds: 54.8, speakerCount: 2 })],
      },
    });
    const carriedOnce = rerun({
      direct: { ran: true, rows: [okRow()] },
      fullChain: { ran: false, rows: [], notRunReason: 'not requested (run with --full-chain)' },
      previous: original,
    });
    expect(carriedOnce.tables.fullChain.carriedFrom).toBe('2026-09-05T20:00:00.000Z');

    const carriedTwice = bench.buildBaseline({
      generated: '2026-09-07T11:30:00.000Z',
      machine: MACHINE_FIXTURE,
      models: MODELS_FIXTURE,
      direct: { ran: true, rows: [okRow()] },
      fullChain: { ran: false, rows: [], notRunReason: 'not requested (run with --full-chain)' },
      previous: carriedOnce,
    });
    // Byte-identical rows, so the stamp beside them must still be the run that
    // measured them — neither the middle file (09-06) nor this one (09-07).
    expect(carriedTwice.tables.fullChain.rows).toEqual(original.tables.fullChain.rows);
    expect(carriedTwice.tables.fullChain.carriedFrom).toBe('2026-09-05T20:00:00.000Z');
    expect(carriedTwice.tables.fullChain.machine).toEqual(other);
    // The reason is THIS run's — why it published no full chain of its own.
    expect(carriedTwice.tables.fullChain.carriedReason).toBe('not requested (run with --full-chain)');
    expect(carriedTwice.generated).toBe('2026-09-07T11:30:00.000Z');
    expect(carriedTwice.tables.direct.carriedFrom).toBeUndefined();
  });

  it('falls back to the previous FILE machine for a table written before the stamp existed', () => {
    // A baseline from before the per-table stamp has no machine on its tables,
    // and the only attribution it carries for them is the file's own machine
    // block — which is where those timings actually came from.
    const other = { ...MACHINE_FIXTURE, cpu: 'Xeon Gold 6248 (CI runner)', cpus: 40, memGb: 192 };
    const legacy = committedBaseline();
    legacy.machine = other;
    delete legacy.tables.direct.machine;
    delete legacy.tables.fullChain.machine;
    const out = rerun({
      direct: { ran: true, rows: [okRow()] },
      fullChain: { ran: false, rows: [], notRunReason: 'not requested (run with --full-chain)' },
      previous: legacy,
    });
    expect(out.tables.fullChain.machine).toEqual(other);
    expect(out.tables.direct.machine).toEqual(MACHINE_FIXTURE);
  });
});

// --------------------------------------------------- the empty-run exit rule

describe('unmeasuredFailures', () => {
  const table = (rows) => ({ ran: rows.length > 0, rows });

  it('fails a mode that ran over no recording at all', () => {
    expect(
      bench.unmeasuredFailures(['--direct'], { direct: table([skippedRow()]), fullChain: table([]) })
    ).toEqual(['--direct ran but measured nothing — no recording present']);
  });

  it('fails a run where no mode ran at all', () => {
    expect(bench.unmeasuredFailures([], { direct: table([]), fullChain: table([]) })).toEqual([
      'no mode ran — nothing was measured',
    ]);
  });

  it('is clean when every attempted mode measured at least one row', () => {
    expect(
      bench.unmeasuredFailures(['--direct', '--full-chain'], {
        direct: table([okRow(), skippedRow()]),
        fullChain: table([okRow()]),
      })
    ).toEqual([]);
  });
});

// ----------------------------------------------------- the committed verdict

describe('docs/bench/diarize-bench-baseline.json', () => {
  const committed = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'docs', 'bench', 'diarize-bench-baseline.json'), 'utf8')
  );
  const fullChainRows = committed.tables.fullChain.rows.filter((r) => r.status === 'ok');
  const directRows = committed.tables.direct.rows.filter((r) => r.status === 'ok');

  it('keeps the HT-Demucs session load OUT of the separation rate', () => {
    // `msPerAudioSecond.stem` is read as a RATE — Task 8 compares it with
    // MEASURED_REALTIME_FACTOR = 1.52 (658 ms per audio second). Folding the
    // 165 MB session creation into the stage made it a fixed cost wearing a
    // rate's units: it fell with file length instead of holding steady. The
    // diarizer already reports its own session creation as `ms.init` and
    // excludes it from `segment`/`embed`; the stem stage now does the same.
    expect(fullChainRows.length).toBeGreaterThan(0);
    for (const row of fullChainRows) {
      expect(typeof row.ms.stemInit).toBe('number');
      expect(row.ms.stemInit).toBeGreaterThan(0);
      expect(row.ms.total).toBeGreaterThanOrEqual(row.ms.stem + row.ms.stemInit);
      const rateFromStem = row.ms.stem / row.audioSeconds;
      const rateWithInit = (row.ms.stem + row.ms.stemInit) / row.audioSeconds;
      expect(Math.abs(row.msPerAudioSecond.stem - rateFromStem)).toBeLessThan(1);
      expect(row.msPerAudioSecond.stem).toBeLessThan(rateWithInit - 1);
    }
  });

  it('has no stem stage at all on the direct rows', () => {
    expect(directRows.length).toBeGreaterThan(0);
    for (const row of directRows) {
      expect(row.ms.stem).toBeNull();
      expect(row.ms.stemInit).toBeNull();
      expect(row.msPerAudioSecond.stem).toBeNull();
    }
  });
});

// ------------------------------------------------------ the stem stage clock

describe('the separation clock', () => {
  // The committed baseline above can only catch a re-folded session load AFTER
  // someone re-runs the bench. This catches it at the edit: `separateVocals`
  // must create the session, stop that clock, and only then start the one whose
  // number is published as a rate.
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'diarize-bench.cjs'), 'utf8');
  const separateVocals = source.slice(
    source.indexOf('async function separateVocals'),
    source.indexOf('const round1 =')
  );

  it('starts only after the 165 MB session exists, and reports that cost separately', () => {
    expect(separateVocals.length).toBeGreaterThan(0);
    const initAt = separateVocals.indexOf("type: 'init'");
    const clockAt = separateVocals.indexOf('const t0 = performance.now()');
    expect(initAt).toBeGreaterThan(-1);
    expect(clockAt).toBeGreaterThan(initAt);
    expect(separateVocals).toContain('return { vocals, stemMs, stemInitMs };');
  });
});

// ------------------------------------------- the CLI over the verified models

const REAL_ASSETS = path.join(ROOT, 'test-assets');
const { DIARIZE_FILES, getDiarizeModelPaths } = require(path.join(ROOT, 'electron', 'diarizeManager.cjs'));
const REAL_MODEL_PATHS = getDiarizeModelPaths(REAL_ASSETS);
const sizeOrNull = (p) => {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
};
const MODELS_PRESENT = DIARIZE_FILES.every((f) => sizeOrNull(REAL_MODEL_PATHS[f.key]) === f.bytes);
const TWO_SPEAKER_WAV = path.join(REAL_ASSETS, 'diarization', '1-two-speakers-en.wav');
const RECORDING_PRESENT = sizeOrNull(TWO_SPEAKER_WAV) === 512044;

function runScript(script, args) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

/** A scratch assets root INSIDE `test-assets/` (gitignored, and on the same
 * volume as the models, so the 32.5 MB set is hard-linked, never copied). */
function linkedAssetsRoot(prefix) {
  const root = fs.mkdtempSync(path.join(REAL_ASSETS, prefix));
  const models = getDiarizeModelPaths(root);
  for (const f of DIARIZE_FILES) {
    fs.mkdirSync(path.dirname(models[f.key]), { recursive: true });
    fs.linkSync(REAL_MODEL_PATHS[f.key], models[f.key]);
  }
  fs.mkdirSync(path.join(root, 'diarization'), { recursive: true });
  return root;
}

(MODELS_PRESENT ? describe : describe.skip)('the CLI with the model set verified', () => {
  const roots = [];

  afterAll(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  });

  it('refuses to publish a verdict for a run that measured nothing, and keeps the old one', () => {
    const root = linkedAssetsRoot('bench-empty-');
    roots.push(root);
    const out = path.join(root, 'out.json');
    const before = `${JSON.stringify(committedBaseline(), null, 2)}\n`;
    fs.writeFileSync(out, before);

    const res = runScript('diarize-bench.cjs', [`--assets=${root}`, `--out=${out}`, '--direct']);
    expect(res.code).toBe(1);
    expect(`${res.stdout}${res.stderr}`).toContain('--direct ran but measured nothing');

    // A run that measured nothing has nothing to publish, so it does not
    // touch the verdict at ALL — not the tables, and above all not
    // `generated`, the one field that would make an untouched table read
    // as freshly measured on whatever machine ran the empty pass.
    expect(fs.readFileSync(out, 'utf8')).toBe(before);
    expect(res.stdout).toContain('left as it was');
  }, 120000);

  (RECORDING_PRESENT ? it : it.skip)(
    'exits 1 when a --direct count disagrees with the file name',
    () => {
      // The two-speaker recording under the four-speaker name: the detector is
      // right and the truth is wrong, which is exactly the shape of a
      // regression this exit code has to catch. It is the only test that runs
      // the real host, and it is skipped when the assets are not on the disk.
      const root = linkedAssetsRoot('bench-mislabelled-');
      roots.push(root);
      fs.linkSync(TWO_SPEAKER_WAV, path.join(root, 'diarization', '0-four-speakers-zh.wav'));
      const out = path.join(root, 'out.json');

      const res = runScript('diarize-bench.cjs', [`--assets=${root}`, `--out=${out}`, '--direct']);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('0-four-speakers-zh.wav: found 2, name says 4');
      const written = JSON.parse(fs.readFileSync(out, 'utf8'));
      expect(written.tables.direct.correct).toBe(0);
      expect(written.tables.direct.measured).toBe(1);
    },
    300000
  );

  (RECORDING_PRESENT ? it : it.skip)(
    'exits 0 and publishes a FRESH table when every --direct count matches its name',
    () => {
      // The other side of the exit rule. Without it a bench mutated to
      // `return 1` — one that fails even on a fully correct run — leaves this
      // suite green, and the exit code is the only part of a bench a gate
      // reads. Same recording as the mislabelled case above, under its OWN
      // name, so this pays the same one-file real-host cost.
      const root = linkedAssetsRoot('bench-correct-');
      roots.push(root);
      fs.linkSync(TWO_SPEAKER_WAV, path.join(root, 'diarization', '1-two-speakers-en.wav'));
      const out = path.join(root, 'out.json');
      const before = committedBaseline();
      fs.writeFileSync(out, `${JSON.stringify(before, null, 2)}\n`);

      const res = runScript('diarize-bench.cjs', [`--assets=${root}`, `--out=${out}`, '--direct']);
      expect(res.code).toBe(0);
      expect(res.stderr).not.toContain('diarize-bench:');

      const after = JSON.parse(fs.readFileSync(out, 'utf8'));
      const measured = after.tables.direct.rows.filter((r) => r.status === 'ok');
      expect(measured.map((r) => r.file)).toEqual(['1-two-speakers-en.wav']);
      expect(after.tables.direct.correct).toBe(1);
      expect(after.tables.direct.measured).toBe(1);
      expect(after.tables.direct.carriedFrom).toBeUndefined();
      expect(after.generated).not.toBe(before.generated);
      // Each table names the machine that timed it: this run's rows carry
      // this machine, the carried rows keep the one that measured them.
      expect(after.tables.direct.machine).toEqual(after.machine);
      expect(after.tables.fullChain.carriedFrom).toBe(before.generated);
      expect(after.tables.fullChain.machine).toEqual(MACHINE_FIXTURE);
      expect(after.machine.cpu).not.toBe(MACHINE_FIXTURE.cpu);
    },
    300000
  );
});

// ---------------------------------------------------------- the fetcher CLI

describe('the fetcher CLI', () => {
  let tmp;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diarize-fetch-'));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reports every missing asset and exits 1 WITHOUT downloading anything', () => {
    const res = runScript('fetch-diarization-assets.cjs', [`--assets=${tmp}`, '--verify']);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('MISSING');
    expect(res.stdout).toContain('6 asset(s) missing or off their pin');
    expect(fs.readdirSync(tmp)).toEqual([]);
  }, 60000);

  it('refuses --assets= instead of resolving it to the CWD and fetching there', () => {
    // `--verify` keeps this harmless either way; what it pins is the exit
    // code and the message, i.e. that the empty value is rejected BEFORE any
    // path resolution — the same argv without `--verify` is a 37 MB download
    // into the repo.
    const res = runScript('fetch-diarization-assets.cjs', ['--assets=', '--verify']);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('--assets needs a value');
  }, 60000);

  it('refuses --verify=true instead of turning the read-only check into a fetch', () => {
    const res = runScript('fetch-diarization-assets.cjs', [`--assets=${tmp}`, '--verify=true']);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('--verify takes no value');
    expect(fs.readdirSync(tmp)).toEqual([]);
  }, 60000);
});
