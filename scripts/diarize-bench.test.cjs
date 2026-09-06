'use strict';

/**
 * D6 — the measurement scripts of Separate Speakers, pinned at the level a
 * test can reach without a 32.5 MB model set or onnxruntime: the pure report
 * and baseline layer of `diarize-bench.cjs`, its exit rule, and the
 * provisioning decisions of `fetch-diarization-assets.cjs`.
 *
 * What is deliberately NOT here: the real runs. Those need the pinned models
 * and the four recordings (both gitignored), and the whole point of the bench
 * is that its numbers come from the real host — a mocked ORT would pin nothing
 * about diarization. The run path is exercised by ACTUALLY running the bench
 * (`node scripts/diarize-bench.cjs --direct`), whose verdict is committed at
 * `docs/bench/diarize-bench-baseline.json`; what this file guards is that the
 * verdict is reported honestly: a missing recording renders as a skip and
 * never as a row of numbers, and a count that disagrees with the file-name
 * truth fails the process instead of being written down as a success.
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
    ms: { decode: 12, stem: null, resample: null, segment: 214, embed: 1893, assemble: 3, total: 2110 },
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
    const row = okRow({ ms: { ...okRow().ms, stem: 22417 }, msPerAudioSecond: { ...okRow().msPerAudioSecond, stem: 659.3 } });
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
});
