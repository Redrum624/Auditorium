'use strict';

/**
 * Runs the REAL transcription host — `electron/transcribeHost.cjs`'s core plus
 * onnxruntime-node on the CPU EP plus the real pinned model files — over a
 * mono 16 kHz buffer, and writes its posted messages out as JSON.
 *
 * It exists as a CHILD PROCESS for the same reason
 * `scripts/stem-bench-driver.cjs` does: onnxruntime's tensor type checks need
 * same-realm `Float32Array`s, which Jest's vm sandbox cannot provide. The
 * caller (`electron/transcribeIntegration.test.cjs`, or a one-off bench) owns
 * gating, input preparation and the assertions; this file owns nothing but the
 * run.
 *
 * Usage:  node scripts/transcribe-bench-driver.cjs <job.json>
 *
 * job.json:
 *   {
 *     "paths":    { encoder, decoder, tokenizer, generationConfig,
 *                   modelConfig, embedder },   // as the manager resolves them
 *     "audio":    "<path to raw little-endian Float32 mono @ 16 kHz>",
 *     "language": "auto" | "<code>",
 *     "out":      "<path to write the JSON verdict>"
 *   }
 *
 * The verdict carries every posted message plus the derived numbers a caller
 * would otherwise have to recompute:
 *   { ok, error?, language, languageProbability, segmentCount,
 *     segments: [{index, startSample, endSample, text, avgLogprob,
 *                 noSpeechProb, compressionRatio}],
 *     minNoSpeechProb, maxNoSpeechProb, minAvgLogprob, maxAvgLogprob,
 *     elapsedMs, realtimeFactor }
 *
 * `noSpeechProb` is the reason this driver reports per-segment detail at all:
 * it is read at the SOT position of the uncached pass, a row the host used to
 * discard, and the only way to know the fix works against the real model is to
 * look at the number the real model produces.
 */

const fs = require('node:fs');
const path = require('node:path');

const { createTranscribeHost } = require(path.join(__dirname, '..', 'electron', 'transcribeHost.cjs'));
const { WHISPER_SAMPLE_RATE } = require(path.join(__dirname, '..', 'electron', 'whisperFeatures.cjs'));

async function main() {
  const jobPath = process.argv[2];
  if (!jobPath) throw new Error('usage: transcribe-bench-driver.cjs <job.json>');
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));

  const raw = fs.readFileSync(job.audio);
  if (raw.length % 4 !== 0) throw new Error(`${job.audio} is not a whole number of float32 samples`);
  const samples = new Float32Array(raw.length / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = raw.readFloatLE(i * 4);

  const posted = [];
  const host = createTranscribeHost({
    ort: require('onnxruntime-node'),
    postMessage: (m) => posted.push(m),
    exit: () => {},
  });

  const verdict = { ok: false, error: null, audioSamples: samples.length };
  const startedAt = Date.now();
  try {
    await host.handleMessage({ type: 'init', paths: job.paths });
    if (!posted.some((m) => m.type === 'ready')) {
      throw new Error(`host never reported ready: ${JSON.stringify(posted)}`);
    }
    await host.handleMessage({
      type: 'transcribe',
      id: 1,
      sampleRate: WHISPER_SAMPLE_RATE,
      totalSamples: samples.length,
      language: job.language || 'auto',
    });
    // One slice: the manager's chunking is the manager's business, and the
    // packaged smoke step already proves the multi-slice path end to end.
    await host.handleMessage({ type: 'audio', id: 1, offset: 0, samples });
    await host.handleMessage({ type: 'run', id: 1 });
  } catch (err) {
    verdict.error = err instanceof Error ? err.message : String(err);
  }
  const elapsedMs = Date.now() - startedAt;

  const errors = posted.filter((m) => m.type === 'error');
  const done = posted.find((m) => m.type === 'done');
  const lang = posted.find((m) => m.type === 'language');
  const segments = posted
    .filter((m) => m.type === 'segment')
    .map((m) => ({
      index: m.index,
      startSample: m.startSample,
      endSample: m.endSample,
      text: m.text,
      avgLogprob: m.avgLogprob,
      noSpeechProb: m.noSpeechProb,
      compressionRatio: m.compressionRatio,
    }));

  verdict.ok = Boolean(done) && errors.length === 0 && verdict.error === null;
  if (!verdict.error && errors.length > 0) verdict.error = errors[0].message;
  verdict.language = lang ? lang.language : null;
  verdict.languageProbability = lang ? lang.probability : null;
  verdict.segmentCount = done ? done.segmentCount : segments.length;
  verdict.segments = segments;
  verdict.embeddingCount = posted.filter((m) => m.type === 'embedding').length;
  const nsp = segments.map((s) => s.noSpeechProb);
  const alp = segments.map((s) => s.avgLogprob);
  verdict.minNoSpeechProb = nsp.length ? Math.min(...nsp) : null;
  verdict.maxNoSpeechProb = nsp.length ? Math.max(...nsp) : null;
  verdict.minAvgLogprob = alp.length ? Math.min(...alp) : null;
  verdict.maxAvgLogprob = alp.length ? Math.max(...alp) : null;
  verdict.elapsedMs = elapsedMs;
  verdict.realtimeFactor = elapsedMs > 0 ? samples.length / WHISPER_SAMPLE_RATE / (elapsedMs / 1000) : null;

  fs.mkdirSync(path.dirname(job.out), { recursive: true });
  fs.writeFileSync(job.out, JSON.stringify(verdict, null, 2));
  console.log(JSON.stringify({ ok: verdict.ok, segmentCount: verdict.segmentCount, error: verdict.error }));
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
