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
 *       — 16 kHz mono PCM, 16.0 / 34.0 / 54.8 / 56.9 s. Test material from
 *         the sherpa-onnx GitHub release `speaker-segmentation-models`
 *         (github.com/k2-fsa/sherpa-onnx). Upstream states NO licence for
 *         these recordings and gives no per-segment ground truth — only the
 *         file names carry the speaker COUNT, which is the bench's whole
 *         truth. They are therefore NOT redistributed: `test-assets/` is
 *         gitignored and every byte here is fetched on demand.
 *
 *   test-assets/diarization/SHA256SUMS.txt
 *       — a sidecar recording what was fetched, in `sha256sum -c` format.
 *         Optional and never required: nothing in the app, the suite or the
 *         bench reads it. The recordings are pinned by SIZE here (the sizes
 *         the release serves, confirmed against `Content-Length`), because
 *         no upstream digest is published for them; the sidecar is where the
 *         digest this machine actually got is written down so a later fetch
 *         on another machine can be compared to it by hand.
 *
 * Idempotent by construction: a file already at its pinned size (models: at
 * their pinned sha256) is left untouched and reported as present, so a second
 * run downloads nothing. `--verify` never downloads at all — it reports and
 * exits 1 if anything is missing or off its pin.
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

function mib(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
 */
function flagProblem(argv) {
  for (const a of argv) {
    const name = a.split('=')[0];
    if (!KNOWN_FLAGS.has(name)) {
      return `fetch-diarization-assets: unknown option ${name}\n${USAGE}`;
    }
    if (VALUE_FLAGS.has(name) && !a.includes('=')) {
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
  log(`  fetched  ${entry.filename} (${mib(entry.bytes)})`);
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
  log(`models (${mib(DIARIZE_TOTAL_BYTES)} total)`);
  const paths = modelDestinations(assetsDir);
  const missingModels = [];
  for (const f of DIARIZE_FILES) {
    const verdict = await verifyModelFile(paths[f.key], { expectedSha256: f.sha256, expectedBytes: f.bytes });
    if (verdict.ok) {
      log(`  present  ${f.filename} (${mib(f.bytes)}, sha256 verified)`);
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
  for (const entry of RECORDINGS) {
    const dest = path.join(recordingDir, entry.filename);
    const plan = planFile(sizeOf(dest), entry.bytes);
    if (plan === 'present') {
      log(`  present  ${entry.filename} (${mib(entry.bytes)})`);
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
  }

  if (verifyOnly) {
    const missing = missingModels.length + missingRecordings.length;
    if (missing > 0) {
      log(`${missing} asset(s) missing or off their pin — run without --verify to fetch them`);
      return 1;
    }
    log('every diarization asset is present and on its pin');
    return 0;
  }

  // --------------------------------------------------------------- sidecar
  const rows = [];
  for (const entry of RECORDINGS) {
    rows.push({ filename: entry.filename, sha256: await sha256File(path.join(recordingDir, entry.filename)) });
  }
  const sidecar = path.join(recordingDir, SIDECAR_NAME);
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
  RECORDING_DIR,
  RECORDING_RELEASE,
  SIDECAR_NAME,
  flagProblem,
  modelDestinations,
  planFile,
  sidecarText,
  main,
};
