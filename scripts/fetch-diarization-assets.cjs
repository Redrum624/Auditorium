'use strict';

/**
 * Provisions the LOCAL, GITIGNORED assets the Separate Speakers bench needs
 * (D6): the two pinned diarization models and the four multi-speaker test
 * recordings the 2026-09-05 sweep measured on.
 *
 *   node scripts/fetch-diarization-assets.cjs [--assets=<dir>] [--verify]
 *
 * Where things land, and why exactly there:
 *
 *   test-assets/models/diarization/pyannote-segmentation-3.0.onnx
 *   test-assets/models/diarization/wespeaker_en_voxceleb_resnet34_LM.onnx
 *       — `getDiarizeModelPaths(<assets dir>)`'s own layout, so
 *         `scripts/diarize-bench.cjs` resolves the set with the SHIPPED
 *         function instead of a second path table that could drift from it.
 *         Downloaded by `ensureDiarizeModels`, i.e. through the app's own
 *         pin/retry/oversize/atomic-commit machinery — sha256 + size are
 *         verified in memory BEFORE anything is committed to disk, and a
 *         corrupt file is deleted and re-fetched.
 *
 *   test-assets/diarization/{0-four,1-two,2-two,3-two}-speakers-*.wav
 *       — 16 kHz mono PCM. Each name carries its own duration, because a
 *         list of four names beside a list of four numbers reads
 *         positionally and design-notes.md's order is not this one:
 *
 *         0-four-speakers-zh.wav — 56.9 s
 *         1-two-speakers-en.wav — 16.0 s
 *         2-two-speakers-en.wav — 34.0 s
 *         3-two-speakers-en.wav — 54.8 s
 *
 *         (design-notes.md, and the `audioSeconds` the bench measures in
 *         docs/bench/diarize-bench-baseline.json.) Test material from
 *         the sherpa-onnx GitHub release `speaker-segmentation-models`
 *         (github.com/k2-fsa/sherpa-onnx). Upstream states NO licence for
 *         these recordings and gives no per-segment ground truth — only the
 *         file names carry the speaker COUNT, which is the bench's whole
 *         truth. They are therefore NOT redistributed: `test-assets/` is
 *         gitignored and every byte here is fetched on demand.
 *
 *   test-assets/diarization/SHA256SUMS.txt
 *       — a sidecar recording what was fetched, in `sha256sum -c` format.
 *         Optional and never required (nothing in the app or the bench reads
 *         it), but once it exists it is a RECORD, not a note: the recordings
 *         are pinned by SIZE here (the sizes the release serves, confirmed
 *         against `Content-Length`) because upstream publishes no digest for
 *         them, and a file swapped for a different one of the same byte count
 *         passes that pin. So every run that finds a recording present checks
 *         its digest against what this file already records — `--verify`
 *         reports a MISMATCH and fails, and a fetch run refuses to rewrite the
 *         record it disagrees with. Recomputing the digests and writing them
 *         back unconditionally, which is what this used to do, replaces the
 *         only evidence of what was fetched with a description of whatever is
 *         on the disk now.
 *
 * Idempotent by construction: a file already at its pinned size (models: at
 * their pinned sha256) is left untouched and reported as present, so a second
 * run downloads nothing. `--verify` never downloads at all — it reports and
 * exits 1 if anything is missing, off its pin, or off its recorded digest.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  DIARIZE_FILES,
  DIARIZE_TOTAL_BYTES,
  getDiarizeModelPaths,
  ensureDiarizeModels,
  verifyModelFile,
} = require(path.join(__dirname, '..', 'electron', 'diarizeManager.cjs'));
const { downloadModel } = require(path.join(__dirname, '..', 'electron', 'stemManager.cjs'));

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_ASSETS = path.join(ROOT, 'test-assets');
/** The recordings' own directory, beside `models/` under the assets root. */
const RECORDING_DIR = 'diarization';
const SIDECAR_NAME = 'SHA256SUMS.txt';

/** The release that published the four recordings (the same k2-fsa release
 * family the embedder comes from — note the upstream tag's spelling). */
const RECORDING_RELEASE =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models';

/**
 * The four recordings, pinned by SIZE (design-notes.md; the same bytes the
 * release's `Content-Length` reports). No sha256 pin: upstream publishes none,
 * and inventing one from whatever this machine downloaded would pin the
 * download rather than the asset. Size is the honest pin available, and the
 * sidecar records the digest that was actually received.
 */
const RECORDINGS = Object.freeze(
  [
    { filename: '0-four-speakers-zh.wav', bytes: 1819586 },
    { filename: '1-two-speakers-en.wav', bytes: 512044 },
    { filename: '2-two-speakers-en.wav', bytes: 1088078 },
    { filename: '3-two-speakers-en.wav', bytes: 1753804 },
  ].map((r) => Object.freeze({ ...r, url: `${RECORDING_RELEASE}/${r.filename}` }))
);

/** The models' destinations under an assets root — the shipped resolver, so
 * the fetcher and the bench can never disagree about where a model lives. */
function modelDestinations(assetsDir) {
  return getDiarizeModelPaths(assetsDir);
}

/**
 * What to do with one recording, given the size on disk (`null` when absent).
 * A wrong size is a truncated or replaced file, not something to measure on:
 * it is re-fetched, never trusted.
 */
function planFile(sizeOnDisk, expectedBytes) {
  if (sizeOnDisk === null || sizeOnDisk === undefined) return 'fetch';
  return sizeOnDisk === expectedBytes ? 'present' : 'refetch';
}

/** `sha256sum -c`-checkable text plus the provenance the header owes a reader. */
function sidecarText(rows) {
  const header = [
    '# sha256 of the diarization test recordings, as fetched by',
    '# scripts/fetch-diarization-assets.cjs. Check with:  sha256sum -c SHA256SUMS.txt',
    '#',
    '# Test material from the sherpa-onnx release `speaker-segmentation-models`',
    '# (github.com/k2-fsa/sherpa-onnx). Upstream states no licence for these',
    '# recordings, so they are not redistributed: this directory is gitignored and',
    '# every file in it is downloaded on demand. Upstream publishes no digest for',
    '# them either — these are the digests THIS machine received, recorded so a',
    '# later fetch elsewhere can be compared against them.',
    '#',
    '# The two model files are pinned (sha256 + size + URL) in',
    '# electron/diarizeManager.cjs and are deliberately not repeated here.',
  ];
  return `${[...header, ...rows.map((r) => `${r.sha256} *${r.filename}`)].join('\n')}\n`;
}

/**
 * The digests a sidecar records, by filename. `sha256sum` writes ` *name` for
 * a binary file and two spaces for a text one; both are its own output, so
 * both read back. Comment and blank lines are the provenance header above.
 */
function parseSidecar(text) {
  const recorded = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const hit = /^([0-9a-f]+)\s+\*?(.+)$/i.exec(trimmed);
    if (hit) recorded.set(hit[2].trim(), hit[1].toLowerCase());
  }
  return recorded;
}

/** The sidecar already at `dir`, or an empty record when there is none. */
function readSidecar(dir) {
  try {
    return parseSidecar(fs.readFileSync(path.join(dir, SIDECAR_NAME), 'utf8'));
  } catch {
    return new Map();
  }
}

/**
 * Every file whose digest disagrees with the one already recorded for that
 * name. A name with no record is NOT a mismatch — it is a new row to write
 * down; a recorded name with no file is a missing file, which the size pass
 * reports on its own.
 */
function sidecarMismatches(recorded, rows) {
  return rows
    .filter((r) => recorded.has(r.filename) && recorded.get(r.filename) !== r.sha256)
    .map((r) => ({ filename: r.filename, recorded: recorded.get(r.filename), actual: r.sha256 }));
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function sizeOf(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

/**
 * DECIMAL MB, the unit every download size in this app is quoted in: D2 pins
 * the diarization set at 32,523,463 B and D5's model gate shows "32.5 MB",
 * `diarizeService.ts` says "about 32.5 MB, one time", and `e2e-smoke.cjs`
 * renders every model size as `expectedBytes / 1e6`. Dividing by 1024² instead
 * printed "31.0 MB" for those same bytes — the one figure in this file that
 * disagreed with its own prose below ("the 32.5 MB model set") and with the
 * line the operator is comparing it against in the app.
 */
function mb(bytes) {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function arg(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(name.length + 3) : true;
}

/** Options that MUST carry a value. */
const VALUE_FLAGS = new Set(['--assets']);
/** Options that must NOT carry one. `--verify=true` parses to the STRING
 * 'true', which `arg('verify') === true` reads as false — so the read-only
 * check silently became a full fetch: a file deleted and 37 MB pulled by the
 * one flag whose whole purpose is to touch nothing. A boolean written with a
 * value is a typo, and a typo here costs a download. */
const BOOLEAN_FLAGS = new Set(['--verify']);
const KNOWN_FLAGS = new Set([...VALUE_FLAGS, ...BOOLEAN_FLAGS]);

const USAGE = 'usage: node scripts/fetch-diarization-assets.cjs [--assets=<dir>] [--verify]\n';

/**
 * What is wrong with this argv, or `null` when nothing is. A mistyped flag
 * must not be read as "fetch everything into the default tree" — that is a
 * 37 MB download the caller did not ask for. `--assets` without a value is the
 * same mistake in the other direction, and `--verify=<anything>` the third.
 *
 * An EMPTY value is a MISSING value: `--assets=` is what an unset shell
 * variable expands to, and `path.resolve('')` is the CWD, not the default
 * tree. Accepted, it puts the 32.5 MB model set and the non-redistributable
 * recordings in `<cwd>/models/diarization/` and `<cwd>/diarization/` —
 * outside the one directory .gitignore covers (`test-assets/`), where the
 * next `git add -A` sweeps them into the repo.
 */
function flagProblem(argv) {
  for (const a of argv) {
    const name = a.split('=')[0];
    if (!KNOWN_FLAGS.has(name)) {
      return `fetch-diarization-assets: unknown option ${name}\n${USAGE}`;
    }
    if (VALUE_FLAGS.has(name) && (!a.includes('=') || a.slice(a.indexOf('=') + 1) === '')) {
      return `fetch-diarization-assets: ${name} needs a value, as ${name}=<dir>\n`;
    }
    if (BOOLEAN_FLAGS.has(name) && a.includes('=')) {
      return `fetch-diarization-assets: ${name} takes no value — write it as ${name}\n`;
    }
  }
  return null;
}

async function fetchRecording(entry, dest, log) {
  const buf = await downloadModel({
    url: entry.url,
    maxBytes: entry.bytes,
    onProgress: () => {},
  });
  if (buf.length !== entry.bytes) {
    throw new Error(
      `${entry.filename}: downloaded ${buf.length} bytes, pinned at ${entry.bytes} — not saved`
    );
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Temp + rename so an interrupted fetch never leaves a half file at the
  // pinned name for the next run to accept on size alone.
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  log(`  fetched  ${entry.filename} (${mb(entry.bytes)})`);
}

async function main() {
  const problem = flagProblem(process.argv.slice(2));
  if (problem) {
    process.stderr.write(problem);
    return 2;
  }
  const assetsArg = arg('assets');
  const assetsDir = typeof assetsArg === 'string' ? path.resolve(assetsArg) : DEFAULT_ASSETS;
  const verifyOnly = arg('verify') === true;
  const log = (line) => process.stdout.write(`${line}\n`);

  log(`diarization assets → ${assetsDir}`);

  // ---------------------------------------------------------------- models
  log(`models (${mb(DIARIZE_TOTAL_BYTES)} total)`);
  const paths = modelDestinations(assetsDir);
  const missingModels = [];
  for (const f of DIARIZE_FILES) {
    const verdict = await verifyModelFile(paths[f.key], { expectedSha256: f.sha256, expectedBytes: f.bytes });
    if (verdict.ok) {
      log(`  present  ${f.filename} (${mb(f.bytes)}, sha256 verified)`);
    } else {
      missingModels.push({ file: f, verdict });
      log(`  ${verifyOnly ? 'MISSING' : 'need'}     ${f.filename} — ${verdict.reason} (${verdict.detail})`);
    }
  }
  if (missingModels.length > 0 && !verifyOnly) {
    // ensureDiarizeModels re-verifies every file itself; the loop above only
    // decides whether to spend a network round trip at all.
    await ensureDiarizeModels({
      userDataDir: assetsDir,
      onStatus: (s) => log(`  ${s}`),
    });
    log('  models verified after download');
  }

  // ------------------------------------------------------------ recordings
  const recordingDir = path.join(assetsDir, RECORDING_DIR);
  log('recordings (16 kHz mono PCM, sherpa-onnx test material — not redistributed)');
  const missingRecordings = [];
  const onDisk = [];
  for (const entry of RECORDINGS) {
    const dest = path.join(recordingDir, entry.filename);
    const plan = planFile(sizeOf(dest), entry.bytes);
    if (plan === 'present') {
      onDisk.push(entry);
      log(`  present  ${entry.filename} (${mb(entry.bytes)})`);
      continue;
    }
    if (verifyOnly) {
      missingRecordings.push(entry);
      log(`  MISSING  ${entry.filename} — ${plan === 'fetch' ? 'absent' : `wrong size (${sizeOf(dest)} B)`}`);
      continue;
    }
    if (plan === 'refetch') {
      log(`  replacing ${entry.filename} — ${sizeOf(dest)} B on disk, pinned at ${entry.bytes} B`);
      fs.rmSync(dest, { force: true });
    }
    await fetchRecording(entry, dest, log);
    onDisk.push(entry);
  }

  // --------------------------------------------------------------- sidecar
  // The digests of what is actually on this disk, against what the sidecar
  // already records. This is the ONLY check that can see a recording swapped
  // for a different file of the same byte count — the size pin above calls
  // that impostor "present", and upstream publishes no digest to check it
  // with. A run that recomputed the record and wrote it back over itself
  // could not fail this way, and destroyed the evidence while it was at it.
  const recorded = readSidecar(recordingDir);
  const rows = [];
  for (const entry of onDisk) {
    rows.push({ filename: entry.filename, sha256: await sha256File(path.join(recordingDir, entry.filename)) });
  }
  const mismatches = sidecarMismatches(recorded, rows);
  for (const m of mismatches) {
    log(`  MISMATCH ${m.filename} — ${SIDECAR_NAME} records ${m.recorded}, this file is ${m.actual}`);
  }
  const checked = rows.filter((r) => recorded.has(r.filename) && !mismatches.some((m) => m.filename === r.filename));
  for (const r of checked) log(`  ok       ${r.filename} — sha256 matches ${SIDECAR_NAME}`);
  if (recorded.size === 0) {
    log(
      verifyOnly
        ? `  no ${SIDECAR_NAME} yet — nothing recorded to check these recordings against`
        : `  no ${SIDECAR_NAME} yet — this run writes the first record`
    );
  }

  if (verifyOnly) {
    const missing = missingModels.length + missingRecordings.length + mismatches.length;
    if (missing > 0) {
      log(`${missing} asset(s) missing or off their pin — run without --verify to fetch them`);
      return 1;
    }
    log('every diarization asset is present and on its pin');
    return 0;
  }

  const sidecar = path.join(recordingDir, SIDECAR_NAME);
  if (mismatches.length > 0) {
    // The record and the disk disagree. Which one is right is not this
    // script's call to make silently: overwriting the record would erase the
    // digest of the file that WAS fetched, and it is the only copy of it.
    process.stderr.write(
      `fetch-diarization-assets: ${mismatches.length} recording(s) differ from the digests ` +
        `${path.relative(ROOT, sidecar) || sidecar} records — the sidecar is left as it is. Delete the ` +
        'recording(s) and re-run to fetch them again, or delete the sidecar to record what is here now.\n'
    );
    return 1;
  }
  fs.writeFileSync(sidecar, sidecarText(rows));
  log(`wrote ${path.relative(ROOT, sidecar) || sidecar}`);
  return 0;
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
  mb,
  parseSidecar,
  readSidecar,
  sidecarMismatches,
  RECORDING_DIR,
  RECORDING_RELEASE,
  SIDECAR_NAME,
  flagProblem,
  modelDestinations,
  planFile,
  sidecarText,
  main,
};
