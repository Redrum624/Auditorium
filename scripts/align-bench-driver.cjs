'use strict';

/**
 * Runs the REAL lyrics-alignment host — `electron/alignHost.cjs`'s core plus
 * onnxruntime-node on the CPU EP plus the real pinned model files — over one or
 * more mono 16 kHz buffers, and writes the emission grids out as raw float32
 * plus a JSON verdict.
 *
 * It exists as a CHILD PROCESS for the same reason
 * `scripts/transcribe-bench-driver.cjs` does: onnxruntime's tensor type checks
 * need same-realm `Float32Array`s, which Jest's vm sandbox cannot provide. The
 * caller owns gating, input preparation and the assertions; this file owns
 * nothing but the run.
 *
 * Several jobs per invocation, deliberately: the session costs a 378 MB load
 * and ~1 s of graph optimisation, and every bench that uses this driver runs
 * the same model over many passages.
 *
 * Usage:  node scripts/align-bench-driver.cjs <job.json>
 *
 * job.json:
 *   {
 *     "paths": { "model": "...onnx", "vocab": "...json" },
 *     "jobs": [
 *       { "audio": "<raw little-endian Float32 mono @ 16 kHz>",
 *         "emissions": "<path to write raw float32 [frames][classes]>" }
 *     ],
 *     "chunkSamples":   <optional, host default when absent>,
 *     "contextSamples": <optional, host default when absent>,
 *     "out": "<path to write the JSON verdict>"
 *   }
 *
 * The chunk settings are per-INVOCATION rather than per-job because changing
 * them means a new host, and a new host means reloading 378 MB of weights.
 *
 * Verdict:
 *   { ok, error?, vocab, runs: [{ audio, samples, frames, classes,
 *                                 frameSamples, elapsedMs, realtimeFactor,
 *                                 chunkCount }] }
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  createAlignHost,
  planChunks,
  ALIGN_SAMPLE_RATE,
  CHUNK_SAMPLES,
  CONTEXT_SAMPLES,
} = require(path.join(__dirname, '..', 'electron', 'alignHost.cjs'));

function readFloat32(file) {
  const raw = fs.readFileSync(file);
  if (raw.length % 4 !== 0) throw new Error(`${file} is not a whole number of float32 samples`);
  const out = new Float32Array(raw.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = raw.readFloatLE(i * 4);
  return out;
}

function writeFloat32(file, data) {
  const buf = Buffer.allocUnsafe(data.length * 4);
  for (let i = 0; i < data.length; i++) buf.writeFloatLE(data[i], i * 4);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

async function main() {
  const jobPath = process.argv[2];
  if (!jobPath) throw new Error('usage: align-bench-driver.cjs <job.json>');
  const spec = JSON.parse(fs.readFileSync(jobPath, 'utf8'));

  const posted = [];
  const ort = require('onnxruntime-node');
  const makeHost = (chunkSamples, contextSamples) =>
    createAlignHost({
      ort,
      postMessage: (m) => posted.push(m),
      exit: () => {},
      chunkSamples,
      contextSamples,
    });
  const host = makeHost(spec.chunkSamples, spec.contextSamples);

  const take = (type) => {
    const found = posted.filter((m) => m.type === type);
    return found[found.length - 1];
  };

  await host.handleMessage({ type: 'init', paths: spec.paths });
  const ready = take('ready');
  if (!ready) {
    const err = take('error');
    throw new Error(`init failed: ${err ? err.message : 'no ready message'}`);
  }

  const runs = [];
  let id = 1;
  for (const job of spec.jobs) {
    const samples = readFloat32(job.audio);
    posted.length = 0;
    const startedAt = Date.now();
    await host.handleMessage({
      type: 'align',
      id,
      sampleRate: ALIGN_SAMPLE_RATE,
      totalSamples: samples.length,
    });
    await host.handleMessage({ type: 'audio', id, offset: 0, samples });
    await host.handleMessage({ type: 'run', id });
    const elapsedMs = Date.now() - startedAt;

    const emissions = take('emissions');
    if (!emissions) {
      const err = take('error');
      throw new Error(`run failed for ${job.audio}: ${err ? err.message : 'no emissions message'}`);
    }
    writeFloat32(job.emissions, emissions.logProbs);
    runs.push({
      audio: job.audio,
      samples: samples.length,
      frames: emissions.frames,
      classes: emissions.classes,
      frameSamples: emissions.frameSamples,
      elapsedMs,
      realtimeFactor: samples.length / ALIGN_SAMPLE_RATE / (elapsedMs / 1000),
      // Reported so the chunk-size choice in alignHost.cjs cites a number a
      // reader can reproduce. Meaningful only for the FIRST job of an
      // invocation — ORT does not return its arena to the OS between runs, so
      // later jobs read the high-water mark of everything before them.
      rssBytes: process.memoryUsage().rss,
      chunkCount: planChunks(
        samples.length,
        spec.chunkSamples === undefined ? CHUNK_SAMPLES : spec.chunkSamples,
        spec.contextSamples === undefined ? CONTEXT_SAMPLES : spec.contextSamples
      ).length,
    });
    id++;
  }

  fs.writeFileSync(spec.out, JSON.stringify({ ok: true, vocab: ready.vocab, runs }, null, 2));
}

main().catch((err) => {
  const spec = (() => {
    try {
      return JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    } catch {
      return null;
    }
  })();
  const message = err instanceof Error ? err.message : String(err);
  if (spec && spec.out) fs.writeFileSync(spec.out, JSON.stringify({ ok: false, error: message }, null, 2));
  console.error(message);
  process.exit(1);
});
