'use strict';

/**
 * Shared plumbing for the two F6 alignment benches — the context sweep that
 * fixes `alignHost.cjs`'s CONTEXT_SAMPLES and the gate bank that fixes
 * `ctcAlign.ts`'s LYRICS_MATCH_THRESHOLD.
 *
 * Neither bench is part of `npm test`: both need the 378 MB acoustic model and
 * real recordings, and `test-assets/` is gitignored. They are committed for the
 * same reason `scripts/tempo-bench.cjs` is — a threshold nobody can re-measure
 * is a threshold nobody can check.
 *
 * The renderer DSP (`src/dsp/ctcAlign.ts`) is bundled to CommonJS with esbuild
 * at run time rather than reimplemented here, so a bench measures the shipped
 * arithmetic and cannot drift from it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'test-assets');
const OUT = path.join(ROOT, 'test-output', 'f6');
const MODEL_DIR = path.join(ASSETS, 'models', 'align');

const MODEL_PATHS = {
  model: path.join(MODEL_DIR, 'wav2vec2-base-960h.onnx'),
  vocab: path.join(MODEL_DIR, 'wav2vec2-base-960h-vocab.json'),
};

/** The verbatim ground-truth lyrics for the reference sung recordings — one
 * lyric line per text line — live in a user-local sidecar, because they are
 * personal material and stay out of the committed tree with the recordings
 * they describe (test-assets/ is gitignored). `LYRIC_LINES` is null when the
 * sidecar is absent; every bench that needs it must skip with a message. */
const LYRICS_SIDECAR = path.join(ASSETS, 'align-bench-lyrics.txt');
const LYRIC_LINES = fs.existsSync(LYRICS_SIDECAR)
  ? fs
      .readFileSync(LYRICS_SIDECAR, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  : null;

/** The spoken control's verbatim text (`speech16k.wav`). */
const SPEECH_CLAUSES = [
  'And so my fellow Americans ask not what your country can do for you',
  'ask what you can do for your country',
];

function ensureOutDir() {
  fs.mkdirSync(OUT, { recursive: true });
  return OUT;
}

/** Bundles the shipped renderer DSP to CJS and requires it. */
function loadDsp() {
  ensureOutDir();
  const entry = path.join(OUT, 'dsp-entry.ts');
  const bundle = path.join(OUT, 'dsp.cjs');
  fs.writeFileSync(
    entry,
    [
      "export { decodeWav } from '../../src/audio/wavCodec';",
      "export { resampleChannel } from '../../src/dsp/resample';",
      "export * from '../../src/dsp/ctcAlign';",
      '',
    ].join('\n')
  );
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
      entry,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${bundle}`,
      '--log-level=warning',
    ],
    { cwd: ROOT, stdio: 'inherit' }
  );
  delete require.cache[require.resolve(bundle)];
  return require(bundle);
}

/** Decodes a WAV to MONO 16 kHz float32, the host's only accepted input. */
function decodeMono16k(dsp, wavPath) {
  const buf = fs.readFileSync(wavPath);
  const wav = dsp.decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const length = wav.channels[0].length;
  const mono = new Float32Array(length);
  for (const ch of wav.channels) {
    for (let i = 0; i < length; i++) mono[i] += ch[i];
  }
  if (wav.channels.length > 1) {
    for (let i = 0; i < length; i++) mono[i] /= wav.channels.length;
  }
  return dsp.resampleChannel(mono, wav.sampleRate, 16000);
}

function writeFloat32(file, data) {
  const buf = Buffer.allocUnsafe(data.length * 4);
  for (let i = 0; i < data.length; i++) buf.writeFloatLE(data[i], i * 4);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

function readFloat32(file) {
  const raw = fs.readFileSync(file);
  const out = new Float32Array(raw.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = raw.readFloatLE(i * 4);
  return out;
}

/**
 * Runs the driver over a list of `{ name, samples }` and returns
 * `{ vocab, results: Map<name, { logProbs, frames, classes, run }> }`.
 */
function runModel(jobs, { chunkSamples, contextSamples } = {}) {
  ensureOutDir();
  const specJobs = jobs.map((job) => ({
    audio: path.join(OUT, `${job.name}.f32`),
    emissions: path.join(OUT, `${job.name}.lp`),
  }));
  jobs.forEach((job, i) => writeFloat32(specJobs[i].audio, job.samples));

  const specPath = path.join(OUT, 'driver-job.json');
  const outPath = path.join(OUT, 'driver-out.json');
  fs.writeFileSync(
    specPath,
    JSON.stringify({ paths: MODEL_PATHS, jobs: specJobs, chunkSamples, contextSamples, out: outPath }, null, 2)
  );
  execFileSync(process.execPath, [path.join(__dirname, 'align-bench-driver.cjs'), specPath], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  const verdict = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  if (!verdict.ok) throw new Error(`driver failed: ${verdict.error}`);

  const results = new Map();
  jobs.forEach((job, i) => {
    const run = verdict.runs[i];
    results.set(job.name, {
      logProbs: readFloat32(specJobs[i].emissions),
      frames: run.frames,
      classes: run.classes,
      run,
    });
  });
  return { vocab: verdict.vocab, results };
}

/**
 * Deterministic Fisher-Yates over a fixed LCG — the spike's own control, kept
 * verbatim so a shuffled text here is the same kind of object it measured.
 * Shuffling preserves the word count exactly, which is the whole point: a
 * longer wrong text is penalised for its length alone.
 */
function shuffleWords(words, seed) {
  const a = [...words];
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const SHUFFLE_SEEDS = [1, 7, 42, 99, 2026];

module.exports = {
  ROOT,
  ASSETS,
  OUT,
  MODEL_DIR,
  MODEL_PATHS,
  LYRICS_SIDECAR,
  LYRIC_LINES,
  SPEECH_CLAUSES,
  SHUFFLE_SEEDS,
  ensureOutDir,
  loadDsp,
  decodeMono16k,
  writeFloat32,
  readFloat32,
  runModel,
  shuffleWords,
};
