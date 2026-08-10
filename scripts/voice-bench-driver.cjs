'use strict';

/**
 * Runs the REAL voice-changer inference — `electron/voiceHost.cjs`'s core (or
 * its module-level primitives) plus onnxruntime-node on the CPU EP plus the
 * real pinned model files — over mono 22050 Hz buffers, and writes a JSON
 * verdict plus the converted audio.
 *
 * It exists as a CHILD PROCESS for the same reason the stem and transcription
 * drivers do: onnxruntime's tensor type checks need same-realm Float32Arrays,
 * which Jest's vm sandbox cannot provide. The caller
 * (`electron/voiceIntegration.test.cjs`) owns gating, input preparation and
 * the assertions; this file owns nothing but the run.
 *
 * Usage:  node scripts/voice-bench-driver.cjs <job.json>
 *
 * job.json:
 *   {
 *     "paths":     { "extractor": <onnx>, "converter": <onnx> },
 *     "mode":      "host" | "direct",
 *     "source":    "<raw little-endian Float32 mono @ 22050>",
 *     "reference": "<raw little-endian Float32 mono @ 22050>",
 *     "outAudio":  "<raw f32 output path>",
 *     "out":       "<JSON verdict path>"
 *   }
 *
 * mode 'host'   — the SHIPPED path: createVoiceHost's message loop, an embed
 *                 job for the reference and a chunked convert job, output
 *                 assembled from the streamed finalized regions.
 * mode 'direct' — the UNCHUNKED reference run: the same module primitives
 *                 (extractToneEmbedding, convertChunk) with the SAME source
 *                 tone (per-chunk mean — identical floats to the host's), one
 *                 converter run over the whole utterance. This is what a
 *                 chunk-free implementation would produce, which makes
 *                 host-vs-direct the chunking-equivalence measurement.
 *
 * Both modes sample process RSS every 200 ms across the conversion and report
 * the peak, so the caller can assert the chunked path's memory stays bounded
 * BELOW the unchunked path's on the same input.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  createVoiceHost,
  extractToneEmbedding,
  convertChunk,
  TONE_EMBEDDING_SIZE,
} = require(path.join(__dirname, '..', 'electron', 'voiceHost.cjs'));
const { planVoiceSegments } = require(path.join(__dirname, '..', 'electron', 'voiceChunking.cjs'));

function readF32(file) {
  const raw = fs.readFileSync(file);
  if (raw.length % 4 !== 0) throw new Error(`${file} is not a whole number of float32 samples`);
  const samples = new Float32Array(raw.length / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = raw.readFloatLE(i * 4);
  return samples;
}

function writeF32(file, samples) {
  const buf = Buffer.alloc(samples.length * 4);
  for (let i = 0; i < samples.length; i++) buf.writeFloatLE(samples[i], i * 4);
  fs.writeFileSync(file, buf);
}

function startRssSampler() {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  }, 200);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      const rss = process.memoryUsage().rss;
      if (rss > peak) peak = rss;
      return Math.round(peak / (1024 * 1024));
    },
  };
}

/** The host's own source-tone rule (mean of per-chunk embeddings over the
 * plan), reused verbatim so 'direct' feeds bit-identical tones. */
async function sourceTone(ort, session, samples) {
  const plan = planVoiceSegments(samples.length);
  const acc = new Float64Array(TONE_EMBEDDING_SIZE);
  for (const seg of plan) {
    const e = await extractToneEmbedding({ ort, session, samples: samples.subarray(seg.start, seg.end) });
    for (let k = 0; k < TONE_EMBEDDING_SIZE; k++) acc[k] += e[k];
  }
  return { srcTone: Float32Array.from(acc, (v) => v / plan.length), chunkCount: plan.length };
}

async function runHost({ ort, paths, source, reference }) {
  const posted = [];
  const host = createVoiceHost({ ort, postMessage: (m) => posted.push(m), exit: () => {} });
  const send = (m) => host.handleMessage(m);
  const lastError = () => posted.filter((m) => m.type === 'error').pop();

  await send({ type: 'init', paths });
  if (!posted.some((m) => m.type === 'ready')) {
    throw new Error(`host init failed: ${JSON.stringify(lastError())}`);
  }

  // Reference embedding through the real embed job.
  await send({ type: 'embed', id: 1, totalSamples: reference.length });
  await send({ type: 'audio', id: 1, offset: 0, samples: reference });
  await send({ type: 'run', id: 1 });
  const embedded = posted.find((m) => m.type === 'embedded');
  if (!embedded) throw new Error(`embed job failed: ${JSON.stringify(lastError())}`);

  const sampler = startRssSampler();
  const t0 = Date.now();
  await send({ type: 'convert', id: 2, totalSamples: source.length, targetVector: embedded.vector });
  await send({ type: 'audio', id: 2, offset: 0, samples: source });
  await send({ type: 'run', id: 2 });
  const elapsedMs = Date.now() - t0;
  const peakRssMb = sampler.stop();

  const done = posted.find((m) => m.type === 'done');
  if (!done) throw new Error(`convert job failed: ${JSON.stringify(lastError())}`);
  const output = new Float32Array(source.length);
  let received = 0;
  for (const m of posted) {
    if (m.type !== 'chunk') continue;
    if (m.offset !== received) throw new Error(`non-contiguous chunk at ${m.offset}, expected ${received}`);
    output.set(m.data, m.offset);
    received += m.samples;
  }
  if (received !== source.length) {
    throw new Error(`chunks delivered ${received} of ${source.length} samples`);
  }
  return {
    output,
    verdict: {
      mode: 'host',
      chunkCount: done.chunkCount,
      sanitisedSamples: done.sanitisedSamples,
      embedVectorLength: embedded.vector.length,
      embedVectorFinite: Array.from(embedded.vector).every(Number.isFinite),
      elapsedMs,
      peakRssMb,
    },
  };
}

async function runDirect({ ort, paths, source, reference }) {
  const opts = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' };
  const [extractor, converter] = await Promise.all([
    ort.InferenceSession.create(paths.extractor, opts),
    ort.InferenceSession.create(paths.converter, opts),
  ]);
  const destTone = await extractToneEmbedding({ ort, session: extractor, samples: reference });
  const { srcTone, chunkCount } = await sourceTone(ort, extractor, source);

  const sampler = startRssSampler();
  const t0 = Date.now();
  const { data, sanitised } = await convertChunk({ ort, session: converter, samples: source, srcTone, destTone });
  const elapsedMs = Date.now() - t0;
  const peakRssMb = sampler.stop();

  await extractor.release();
  await converter.release();
  return {
    output: data.subarray(0, source.length),
    verdict: {
      mode: 'direct',
      chunkCount, // how many chunks the HOST would have used on this input
      sanitisedSamples: sanitised,
      embedVectorLength: destTone.length,
      embedVectorFinite: Array.from(destTone).every(Number.isFinite),
      elapsedMs,
      peakRssMb,
    },
  };
}

async function main() {
  const jobPath = process.argv[2];
  if (!jobPath) throw new Error('usage: voice-bench-driver.cjs <job.json>');
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  const ort = require('onnxruntime-node');
  const source = readF32(job.source);
  const reference = readF32(job.reference);

  const run = job.mode === 'direct' ? runDirect : runHost;
  const { output, verdict } = await run({ ort, paths: job.paths, source, reference });

  writeF32(job.outAudio, output);
  let peak = 0;
  let finite = true;
  let sumSquares = 0;
  for (let i = 0; i < output.length; i++) {
    const v = output[i];
    if (!Number.isFinite(v)) finite = false;
    else {
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sumSquares += v * v;
    }
  }
  fs.writeFileSync(
    job.out,
    JSON.stringify({
      ok: true,
      ...verdict,
      outputSamples: output.length,
      allFinite: finite,
      peakAbs: +peak.toFixed(5),
      rmsDb: +(20 * Math.log10(Math.max(Math.sqrt(sumSquares / output.length), 1e-12))).toFixed(2),
    })
  );
}

main().catch((err) => {
  const jobPath = process.argv[2];
  try {
    const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
    fs.writeFileSync(job.out, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
  } catch {
    /* fall through to the exit code */
  }
  console.error(err);
  process.exit(1);
});
