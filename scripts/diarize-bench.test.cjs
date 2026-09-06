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
 * Those last two are pinned by running the CLI for real, as is the fetcher's
 * refusal to overwrite a digest SHA256SUMS.txt already records. When the model
 * set is on this machine they run against a scratch assets root under
 * `test-assets/` with the 32.5 MB models (and, for the fetcher, the four
 * recordings) hard-linked into it — no copy, no download; when it is not, they
 * are skipped rather than faked, the `prod-csp.test.cjs` pattern, and the
 * module says out loud which pins are missing so a green run on a bare machine
 * cannot be mistaken for a complete one.
 *
 * The bench's copies of the shipped DSP constants are checked here too — the
 * pure comparison in-process, and the guard `loadDsp` arms with it in a child
 * node, because the TypeScript require hook it installs is not something
 * Jest's module registry honours.
 */

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
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

/**
 * A deep copy of a table's rows, taken BEFORE a carry. `publishedTable` builds
 * a carried table with `{...previousTable}`, so its `rows` is the SAME ARRAY
 * the previous baseline holds: `expect(carried.rows).toEqual(previous.rows)`
 * compares an object with itself and cannot fail — not on the carry logic, and
 * not on its removal. Everything a carry must preserve is compared against
 * this snapshot instead.
 */
function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
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

// -------------------------------------------------------- the drift guard

/**
 * The bench COPIES constants out of `src/dsp/diarization.ts` — the four the
 * anchored column is computed from (SEG_SHIFT, FRAME_SHIFT, SEG_FRAMES,
 * POWERSET) as well as the four policy numbers the baseline publishes. A copy
 * that drifts does not fail: it silently reports a different metric under the
 * same column name, and `docs/bench/diarize-bench-baseline.json` then quotes a
 * policy the shipped DSP no longer runs.
 *
 * The guard used to cover the four policy numbers plus `anchorMinShare` — and
 * that fifth entry compared the bench's own constant to itself, so it could
 * never fire. It is the bench's METRIC parameter (the sweep's `overlap80`);
 * the DSP has no counterpart to compare it against, and it is pinned on its
 * own by the ANCHOR_MIN_SHARE test above.
 */
describe('constantDrift', () => {
  /** The shipped values as they stand today (`src/dsp/diarization.ts:36-90`). */
  const SHIPPED = Object.freeze({
    threshold: 0.55,
    minClusterSize: 4,
    minSpeakerShare: 0.05,
    maxSpeakers: 6,
    segShift: 16000,
    frameShift: 270,
    segFrames: 589,
    powerset: [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]],
  });

  it('checks every constant the bench copies, and nothing it merely owns', () => {
    expect(Object.keys(bench.SHIPPED_CONSTANTS).sort()).toEqual([
      'frameShift',
      'maxSpeakers',
      'minClusterSize',
      'minSpeakerShare',
      'powerset',
      'segFrames',
      'segShift',
      'threshold',
    ]);
    // The bench's own metric parameter is NOT in here: it has no shipped
    // counterpart, and the entry that pretended otherwise compared it to
    // itself.
    expect(bench.SHIPPED_CONSTANTS.anchorMinShare).toBeUndefined();
    expect(bench.SHIPPED_CONSTANTS).toEqual(SHIPPED);
  });

  it('is silent when the shipped DSP still holds every copied value', () => {
    expect(bench.constantDrift(SHIPPED)).toEqual([]);
  });

  it('names a policy constant that moved one step', () => {
    expect(bench.constantDrift({ ...SHIPPED, threshold: 0.56 })).toEqual([
      { key: 'threshold', shipped: 0.56, bench: 0.55 },
    ]);
    expect(bench.constantDrift({ ...SHIPPED, minClusterSize: 5 }).map((d) => d.key)).toEqual(['minClusterSize']);
    expect(bench.constantDrift({ ...SHIPPED, minSpeakerShare: 0.04 }).map((d) => d.key)).toEqual(['minSpeakerShare']);
    expect(bench.constantDrift({ ...SHIPPED, maxSpeakers: 7 }).map((d) => d.key)).toEqual(['maxSpeakers']);
  });

  /**
   * The four the anchored column is made of, each one step off — the drift
   * nothing caught before. A FRAME_SHIFT of 271 still puts window 1 at global
   * frame 59 (`trunc(16000/271 + 0.5)`), so the metric's own fixture cannot
   * see it; only a comparison with the shipped constant can.
   */
  it('names a metric constant that moved one step, which no fixture would catch', () => {
    expect(bench.constantDrift({ ...SHIPPED, frameShift: 271 })).toEqual([
      { key: 'frameShift', shipped: 271, bench: 270 },
    ]);
    expect(bench.constantDrift({ ...SHIPPED, segShift: 16001 }).map((d) => d.key)).toEqual(['segShift']);
    expect(bench.constantDrift({ ...SHIPPED, segFrames: 588 }).map((d) => d.key)).toEqual(['segFrames']);
    expect(bench.constantDrift({ ...SHIPPED, segFrames: 590 }).map((d) => d.key)).toEqual(['segFrames']);
  });

  it('compares the powerset by VALUE, so a reordered row is drift', () => {
    // The model's class order decides which local speaker a frame belongs to;
    // swapping the two-speaker rows [0,1] and [0,2] keeps the shape, the
    // length and every member, and silently relabels overlap frames.
    const reordered = [[], [0], [1], [2], [0, 2], [0, 1], [1, 2]];
    expect(bench.constantDrift({ ...SHIPPED, powerset: reordered }).map((d) => d.key)).toEqual(['powerset']);
    // A constant that disappeared entirely (renamed upstream) is drift too,
    // not a silently passing `undefined`.
    expect(bench.constantDrift({ ...SHIPPED, powerset: undefined }).map((d) => d.key)).toEqual(['powerset']);
    expect(bench.constantDrift({ ...SHIPPED, frameShift: undefined }).map((d) => d.key)).toEqual(['frameShift']);
  });

  it('reports every drifted constant at once, not just the first', () => {
    expect(bench.constantDrift({ ...SHIPPED, threshold: 0.6, segFrames: 588 }).map((d) => d.key)).toEqual([
      'threshold',
      'segFrames',
    ]);
  });

  /**
   * The guard armed against the DSP that actually ships. It runs in a CHILD
   * node because `loadDsp` installs a `require.extensions['.ts']` hook, which
   * Jest's own module registry does not honour — the same reason the bench is
   * a plain-node script in the first place. No models and no onnxruntime are
   * touched: this is the TypeScript transpile and the constants only.
   */
  it('is armed against the shipped diarization.ts, and finds no drift today', () => {
    const benchPath = path.join(ROOT, 'scripts', 'diarize-bench.cjs');
    const code = `require(${JSON.stringify(benchPath)}).loadDsp(); process.stdout.write('drift guard clean');`;
    const out = execFileSync(process.execPath, ['-e', code], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toBe('drift guard clean');
  }, 60000);

  /**
   * And that it THROWS, not merely computes. The child seeds `require.cache`
   * for `diarization.ts` with a module whose FRAME_SHIFT is one step off and
   * everything else on its pin, so the shipped file is READ-ONLY here: the
   * drift is injected at the module boundary, and the bench must refuse to
   * measure a single number under it.
   */
  it('refuses to measure at all when the shipped DSP has moved', () => {
    const dspPath = path.join(ROOT, 'src', 'dsp', 'diarization.ts');
    const benchPath = path.join(ROOT, 'scripts', 'diarize-bench.cjs');
    const code = `
      const p = ${JSON.stringify(dspPath)};
      require.cache[p] = {
        id: p, filename: p, path: require('node:path').dirname(p), loaded: true, children: [], paths: [],
        exports: {
          DIARIZE_THRESHOLD: 0.55, MIN_CLUSTER_SIZE: 4, MIN_SPEAKER_SHARE: 0.05, MAX_SPEAKERS: 6,
          SEG_SHIFT: 16000, FRAME_SHIFT: 271, SEG_FRAMES: 589,
          POWERSET: [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]],
        },
      };
      try { require(${JSON.stringify(benchPath)}).loadDsp(); process.stdout.write('NO THROW'); }
      catch (e) { process.stdout.write(e.message); }
    `;
    const out = execFileSync(process.execPath, ['-e', code], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toContain('frameShift = 271, this bench uses 270');
    expect(out).toContain('a new bench run, not an edited baseline');
  }, 60000);
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

  /**
   * The other half of the stamp rule, and the one no assertion in this file
   * covered: a table that measured NOTHING carries no machine, because there
   * is nothing to attribute. Without this, `tableOf`'s
   * `measured.length > 0 && machine` can be cut down to `machine` — signing an
   * empty table with the machine of a run that measured none of it — and the
   * suite stays green while that function's own docblock says otherwise.
   */
  it('leaves an unmeasured table unstamped, and an anonymous run stamps nothing', () => {
    expect('machine' in baseline().tables.fullChain).toBe(false);
    // The second half of the same condition: no machine info, no stamp, even
    // on the table this run did measure.
    const anonymous = baseline({ machine: null });
    expect('machine' in anonymous.tables.direct).toBe(false);
    expect(anonymous.tables.direct.measured).toBe(1);
    expect(anonymous.machine).toBeNull();
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

  /**
   * MB is DECIMAL here, as it is everywhere else this app shows a person a
   * model download size: D2 pins the set at 32,523,463 B, D5's model gate
   * shows "32.5 MB", `diarizeService.ts:608` says "about 32.5 MB, one time",
   * and `e2e-smoke.cjs` renders every model size as `expectedBytes / 1e6`. A
   * binary MiB divisor printed "31.0 MB" for the same bytes — the one figure
   * the operator compares against the app's own line, and the one figure in
   * this file that disagreed with its own prose ("the 32.5 MB model set").
   */
  it('prints download sizes in the decimal MB the plan and the app pin', () => {
    const { DIARIZE_TOTAL_BYTES, DIARIZE_FILES } = require(path.join(ROOT, 'electron', 'diarizeManager.cjs'));
    expect(DIARIZE_TOTAL_BYTES).toBe(32523463);
    expect(fetcher.mb(DIARIZE_TOTAL_BYTES)).toBe('32.5 MB');
    expect(DIARIZE_FILES.map((f) => fetcher.mb(f.bytes))).toEqual(['6.0 MB', '26.5 MB']);
    // The largest recording, so the recordings' own lines are pinned too.
    expect(fetcher.mb(1819586)).toBe('1.8 MB');
  });

  /**
   * The sidecar is the ONLY record of what these four files were on the
   * machine that fetched them: upstream publishes no digest, so the fetcher
   * pins them by SIZE alone, and a recording swapped for a different file of
   * the same byte count passes that pin. The record only means something if it
   * is CHECKED — a run that recomputes it and writes it back over itself turns
   * the one piece of evidence into a note about whatever is on the disk now.
   */
  it('reads a sidecar back as the digests it recorded, comments and all', () => {
    const text = fetcher.sidecarText([
      { filename: '1-two-speakers-en.wav', sha256: 'f1c877dc' },
      { filename: '0-four-speakers-zh.wav', sha256: 'bedf036c' },
    ]);
    const recorded = fetcher.parseSidecar(text);
    expect([...recorded]).toEqual([
      ['1-two-speakers-en.wav', 'f1c877dc'],
      ['0-four-speakers-zh.wav', 'bedf036c'],
    ]);
    // `sha256sum` writes ` *name` for binary and two spaces for text; both are
    // its own output, so both read back.
    expect([...fetcher.parseSidecar(['# a comment', '', 'abc123  2-two-speakers-en.wav', ''].join('\n'))]).toEqual([
      ['2-two-speakers-en.wav', 'abc123'],
    ]);
    expect([...fetcher.parseSidecar('')]).toEqual([]);
  });

  it('calls a digest that changed under a recorded name a mismatch, and nothing else', () => {
    const recorded = fetcher.parseSidecar(
      fetcher.sidecarText([
        { filename: '1-two-speakers-en.wav', sha256: 'f1c877dc' },
        { filename: '2-two-speakers-en.wav', sha256: 'ee9c33d3' },
      ])
    );
    expect(
      fetcher.sidecarMismatches(recorded, [
        // Same size, different bytes — the swap the size pin cannot see.
        { filename: '1-two-speakers-en.wav', sha256: '9a3b0f11' },
        // On its record.
        { filename: '2-two-speakers-en.wav', sha256: 'ee9c33d3' },
        // Never recorded: a new file to write down, not a mismatch to fail on.
        { filename: '3-two-speakers-en.wav', sha256: 'dd3cf234' },
      ])
    ).toEqual([{ filename: '1-two-speakers-en.wav', recorded: 'f1c877dc', actual: '9a3b0f11' }]);
    // A recorded name that is not on this disk is a missing FILE, reported as
    // such by the size pass — not a digest that disagrees.
    expect(fetcher.sidecarMismatches(recorded, [])).toEqual([]);
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
    const previousRows = snapshot(previous.tables.fullChain.rows);
    const out = rerun({
      direct: { ran: true, rows: [okRow()] },
      fullChain: { ran: false, rows: [], notRunReason: 'not requested (run with --full-chain)' },
      previous,
    });
    expect(out.machine).toEqual(MACHINE_FIXTURE);
    expect(out.tables.direct.machine).toEqual(MACHINE_FIXTURE);
    expect(out.tables.fullChain.machine).toEqual(other);
    expect(out.tables.fullChain.rows).toEqual(previousRows);
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
    const originalRows = snapshot(original.tables.fullChain.rows);
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
    // Against the SNAPSHOT, never against `original.tables.fullChain.rows`:
    // `publishedTable` spreads the previous table, so the carried table holds
    // the very same `rows` ARRAY and comparing the two compares an object to
    // itself — an assertion that passes on any carry logic at all, including
    // none (task-6-full.md:226).
    expect(carriedTwice.tables.fullChain.rows).toEqual(originalRows);
    expect(carriedTwice.tables.fullChain.rows[0].file).toBe('3-two-speakers-en.wav');
    expect(carriedTwice.tables.fullChain.rows[0].audioSeconds).toBe(54.8);
    expect(carriedTwice.tables.fullChain.rows[0].ms.segment).toBe(214);
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

// ------------------------------------------------- the exit rule, at source

/**
 * The exit code is the only part of a bench a gate reads, and BOTH of its
 * sides are pinned at the process level further down — over the real host,
 * which needs the 32.5 MB model set and a recording, both gitignored. On a
 * machine without them those two tests skip, and nothing else in this file
 * connects `countMismatches` to what `main` returns: a bench mutated to
 * `return 1` (fails a correct run) or `return 0` (passes a wrong count) would
 * leave the suite green there. This reads the wiring out of the source
 * instead — weaker than running it, and the reason the skip below is loud.
 */
describe('the exit rule, as `main` wires it', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'diarize-bench.cjs'), 'utf8');
  const mainSource = source.slice(
    source.indexOf('async function main()'),
    source.indexOf('if (require.main === module)')
  );

  it('returns 1 only when a --direct count disagrees, and 0 otherwise', () => {
    expect(mainSource.length).toBeGreaterThan(0);
    expect(mainSource).toContain('const mismatches = countMismatches(tables.direct.rows);');
    expect(mainSource).toContain('return mismatches.length > 0 ? 1 : 0;');
  });

  it('refuses to publish, and fails, before that — when nothing was measured', () => {
    expect(mainSource).toContain('const empty = unmeasuredFailures(modes, tables);');
    expect(mainSource).toContain('left as it was');
    // The refusal comes BEFORE the write, or the file is already overwritten
    // by the time the run decides it had nothing to publish.
    expect(mainSource.indexOf('const empty = unmeasuredFailures')).toBeLessThan(
      mainSource.indexOf('fs.writeFileSync(outPath')
    );
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

/** Every recording the fetcher pins, at its pinned size — what the fetcher's
 * own gated tests need. */
const ALL_RECORDINGS_PRESENT = fetcher.RECORDINGS.every(
  (r) => sizeOrNull(path.join(REAL_ASSETS, 'diarization', r.filename)) === r.bytes
);

// A skipped exit-rule test must not read as a pinned one. The gated blocks
// below own the only checks that RUN these processes end to end, so a machine
// without the gitignored assets says so out loud rather than printing a green
// count that means less than it looks.
if (!MODELS_PRESENT || !RECORDING_PRESENT || !ALL_RECORDINGS_PRESENT) {
  console.warn(
    'diarize-bench.test: the process-level exit rule and the sidecar refusal are NOT pinned ' +
      `on this machine (models ${MODELS_PRESENT ? 'present' : 'ABSENT'}, ` +
      `recordings ${ALL_RECORDINGS_PRESENT ? 'present' : 'ABSENT'}). ` +
      'Run `node scripts/fetch-diarization-assets.cjs` to arm them.'
  );
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

// ------------------------------- the fetcher over the verified assets (real)

(MODELS_PRESENT && ALL_RECORDINGS_PRESENT ? describe : describe.skip)(
  'the fetcher CLI over assets that are all present',
  () => {
    const roots = [];

    afterAll(() => {
      for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
    });

    /** A scratch root with the models AND all four recordings hard-linked in,
     * so a full (non-`--verify`) run has nothing to download. */
    function linkedFullRoot(prefix) {
      const root = linkedAssetsRoot(prefix);
      roots.push(root);
      for (const r of fetcher.RECORDINGS) {
        fs.linkSync(path.join(REAL_ASSETS, 'diarization', r.filename), path.join(root, 'diarization', r.filename));
      }
      return root;
    }

    it('records the digests of a first fetch, and re-runs over them unchanged', () => {
      const root = linkedFullRoot('fetch-first-');
      const sidecar = path.join(root, 'diarization', fetcher.SIDECAR_NAME);
      expect(fs.existsSync(sidecar)).toBe(false);

      const first = runScript('fetch-diarization-assets.cjs', [`--assets=${root}`]);
      expect(first.code).toBe(0);
      expect(first.stdout).toContain('this run writes the first record');
      const written = fs.readFileSync(sidecar, 'utf8');
      const recorded = fetcher.parseSidecar(written);
      expect([...recorded.keys()]).toEqual(fetcher.RECORDINGS.map((r) => r.filename));
      for (const r of fetcher.RECORDINGS) {
        const bytes = fs.readFileSync(path.join(root, 'diarization', r.filename));
        expect(recorded.get(r.filename)).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
      }

      // The second run has the same files and the same record: it checks them
      // and leaves the record alone.
      const second = runScript('fetch-diarization-assets.cjs', [`--assets=${root}`]);
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('sha256 matches SHA256SUMS.txt');
      expect(second.stdout).not.toContain('MISMATCH');
      expect(fs.readFileSync(sidecar, 'utf8')).toBe(written);
    }, 120000);

    it('refuses to overwrite a recorded digest it disagrees with', () => {
      const root = linkedFullRoot('fetch-mismatch-');
      const sidecar = path.join(root, 'diarization', fetcher.SIDECAR_NAME);
      // One recorded digest, and it is not this file's: the sherpa recording's
      // own digest with its last character moved on. Everything else is
      // unrecorded, i.e. a new row rather than a disagreement.
      const before = fetcher.sidecarText([
        {
          filename: '1-two-speakers-en.wav',
          sha256: 'f1c877dc01595e28be7147bf2fe38e5268147a868bf3fdb5c37b97f5940e21f4',
        },
      ]);
      fs.writeFileSync(sidecar, before);

      const res = runScript('fetch-diarization-assets.cjs', [`--assets=${root}`]);
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('MISMATCH 1-two-speakers-en.wav');
      expect(res.stderr).toContain('left as it is');
      // The record of what was fetched is the only copy there is, so a run
      // that disagrees with it reports and stops instead of replacing it.
      expect(fs.readFileSync(sidecar, 'utf8')).toBe(before);
    }, 120000);
  }
);

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
    // The header the operator reads against the app's "about 32.5 MB" line.
    expect(res.stdout).toContain('models (32.5 MB total)');
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

  /**
   * The swap the SIZE pin cannot see: same byte count, different bytes. Only
   * the recorded digest can tell, so `--verify` reads it — before this it
   * returned "present" for the impostor and the next fetch run overwrote the
   * record of the file it replaced.
   */
  it('checks a present recording against the digest SHA256SUMS.txt records', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diarize-sidecar-'));
    try {
      const dir = path.join(root, 'diarization');
      fs.mkdirSync(dir, { recursive: true });
      // 512,044 bytes — 1-two-speakers-en.wav's pinned size exactly, so the
      // size pass calls it present.
      const impostor = Buffer.alloc(512044, 7);
      fs.writeFileSync(path.join(dir, '1-two-speakers-en.wav'), impostor);
      const actual = require('node:crypto').createHash('sha256').update(impostor).digest('hex');
      const recorded = 'f1c877dc01595e28be7147bf2fe38e5268147a868bf3fdb5c37b97f5940e21f3';
      expect(actual).not.toBe(recorded);
      fs.writeFileSync(
        path.join(dir, 'SHA256SUMS.txt'),
        fetcher.sidecarText([{ filename: '1-two-speakers-en.wav', sha256: recorded }])
      );

      const res = runScript('fetch-diarization-assets.cjs', [`--assets=${root}`, '--verify']);
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('MISMATCH');
      expect(res.stdout).toContain(`SHA256SUMS.txt records ${recorded}`);
      expect(res.stdout).toContain(actual);
      // And it is COUNTED: 2 models + 3 absent recordings + this one.
      expect(res.stdout).toContain('6 asset(s) missing or off their pin');
      // Read-only means read-only, even on a mismatch.
      expect(fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8')).toContain(recorded);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it('says the digest matched when the file on disk is the one recorded', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diarize-sidecar-ok-'));
    try {
      const dir = path.join(root, 'diarization');
      fs.mkdirSync(dir, { recursive: true });
      const bytes = Buffer.alloc(512044, 7);
      fs.writeFileSync(path.join(dir, '1-two-speakers-en.wav'), bytes);
      const actual = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
      fs.writeFileSync(
        path.join(dir, 'SHA256SUMS.txt'),
        fetcher.sidecarText([{ filename: '1-two-speakers-en.wav', sha256: actual }])
      );

      const res = runScript('fetch-diarization-assets.cjs', [`--assets=${root}`, '--verify']);
      expect(res.stdout).not.toContain('MISMATCH');
      expect(res.stdout).toContain('sha256 matches SHA256SUMS.txt');
      // The three absent recordings and the two models are still missing, so
      // the run still fails — the digest check adds nothing to that tally.
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('5 asset(s) missing or off their pin');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it('refuses --verify=true instead of turning the read-only check into a fetch', () => {
    const res = runScript('fetch-diarization-assets.cjs', [`--assets=${tmp}`, '--verify=true']);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('--verify takes no value');
    expect(fs.readdirSync(tmp)).toEqual([]);
  }, 60000);
});
