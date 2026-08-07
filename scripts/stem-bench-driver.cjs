'use strict';

// Plain-node driver for the S1 integration bench: feeds planar-stereo f32
// audio through the REAL stem host core (electron/stemHost.cjs +
// onnxruntime-node CPU EP + the HF segmentation port) in ITS OWN process —
// the same one-process-per-run shape the app's utilityProcess arrangement
// uses — and prints a single JSON verdict on stdout.
//
// Run out-of-process on purpose: (a) onnxruntime's tensor type checks
// require same-realm Float32Arrays, which Jest's vm sandbox breaks, and
// (b) peak RSS measured here is the inference process itself, not a Jest
// worker.
//
//   node scripts/stem-bench-driver.cjs --model=<onnx> --audio-f32=<planar LR f32> --samples=<N>
//
// Verdict: { ok, error?, segments, wallMs, realtimeFactor, peakRssMb,
//            mixRmsDb, stems:[{stem,rmsDb}], rawResidualDb, rawResidualVsMixDb,
//            coveredSamples, allFinite }

const fs = require('node:fs');
const path = require('node:path');

const { createStemHost } = require('../electron/stemHost.cjs');
const {
  MODEL_SAMPLE_RATE,
  STEM_NAMES,
  STEM_COUNT,
  MODEL_CHANNELS,
} = require('../electron/stemSegmentation.cjs');

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function rmsDb(sumSquares, count) {
  const rms = Math.sqrt(sumSquares / count);
  return 20 * Math.log10(Math.max(rms, 1e-12));
}

async function main() {
  const modelPath = path.resolve(arg('model'));
  const audioPath = path.resolve(arg('audio-f32'));
  const total = Number(arg('samples'));
  if (!fs.existsSync(modelPath) || !fs.existsSync(audioPath) || !Number.isInteger(total) || total <= 0) {
    throw new Error('usage: --model=<onnx> --audio-f32=<planar stereo f32> --samples=<N>');
  }
  const raw = fs.readFileSync(audioPath);
  if (raw.byteLength !== total * 2 * 4) {
    throw new Error(`audio file is ${raw.byteLength} bytes, expected ${total * 2 * 4} (planar stereo f32)`);
  }
  const all = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const channels = [all.subarray(0, total), all.subarray(total, 2 * total)];

  const posted = [];
  let peakRss = process.memoryUsage().rss;
  const sampleRss = () => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  };
  const rssTimer = setInterval(sampleRss, 250);

  const host = createStemHost({
    ort: require('onnxruntime-node'),
    postMessage: (msg) => {
      posted.push(msg);
      sampleRss();
    },
    exit: () => {},
  });

  try {
    await host.handleMessage({ type: 'init', modelPath });
    const bad = posted.find((m) => m.type === 'error');
    if (bad) throw new Error(`${bad.stage}: ${bad.message}`);
    if (!posted.find((m) => m.type === 'ready')) throw new Error('host never became ready');

    await host.handleMessage({ type: 'separate', id: 1, sampleRate: MODEL_SAMPLE_RATE, channelCount: 2, totalSamples: total });
    await host.handleMessage({ type: 'audio', id: 1, offset: 0, channels: [channels[0].slice(), channels[1].slice()] });

    const t0 = Date.now();
    await host.handleMessage({ type: 'run', id: 1 });
    const wallMs = Date.now() - t0;

    const err = posted.find((m) => m.type === 'error');
    if (err) throw new Error(`${err.stage}: ${err.message}`);
    const done = posted.find((m) => m.type === 'done');
    if (!done) throw new Error('no done message');

    // Reassemble streamed estimates; verify contiguous tiling.
    const stems = [];
    for (let i = 0; i < STEM_COUNT * MODEL_CHANNELS; i++) stems.push(new Float32Array(total));
    let covered = 0;
    for (const f of posted.filter((m) => m.type === 'stems')) {
      if (f.offset !== covered) throw new Error(`non-contiguous stems chunk at ${f.offset}, expected ${covered}`);
      for (let sc = 0; sc < STEM_COUNT * MODEL_CHANNELS; sc++) {
        stems[sc].set(f.data.subarray(sc * f.samples, (sc + 1) * f.samples), f.offset);
      }
      covered = f.offset + f.samples;
    }

    const progressCount = posted.filter((m) => m.type === 'progress').length;

    let allFinite = true;
    const stemStats = [];
    for (let s = 0; s < STEM_COUNT; s++) {
      let sumSq = 0;
      for (let c = 0; c < MODEL_CHANNELS; c++) {
        const arr = stems[s * MODEL_CHANNELS + c];
        for (let t = 0; t < total; t++) {
          const v = arr[t];
          if (!Number.isFinite(v)) allFinite = false;
          sumSq += v * v;
        }
      }
      stemStats.push({ stem: STEM_NAMES[s], rmsDb: Number(rmsDb(sumSq, total * MODEL_CHANNELS).toFixed(1)) });
    }

    let mixSumSq = 0;
    let residSumSq = 0;
    for (let c = 0; c < MODEL_CHANNELS; c++) {
      const mix = channels[c];
      for (let t = 0; t < total; t++) {
        let est = 0;
        for (let s = 0; s < STEM_COUNT; s++) est += stems[s * MODEL_CHANNELS + c][t];
        const r = mix[t] - est;
        mixSumSq += mix[t] * mix[t];
        residSumSq += r * r;
      }
    }
    const mixRmsDb = Number(rmsDb(mixSumSq, total * MODEL_CHANNELS).toFixed(1));
    const rawResidualDb = Number(rmsDb(residSumSq, total * MODEL_CHANNELS).toFixed(1));

    const audioSeconds = total / MODEL_SAMPLE_RATE;
    // fs.writeSync(1, ...): synchronous, so the verdict is fully flushed
    // before the explicit process.exit below (ORT worker threads can
    // otherwise keep the event loop alive indefinitely).
    fs.writeSync(
      1,
      JSON.stringify({
        ok: true,
        segments: done.totalSegments,
        progressCount,
        wallMs,
        realtimeFactor: Number((audioSeconds / (wallMs / 1000)).toFixed(2)),
        peakRssMb: Math.round(peakRss / (1024 * 1024)),
        mixRmsDb,
        stems: stemStats,
        rawResidualDb,
        rawResidualVsMixDb: Number((rawResidualDb - mixRmsDb).toFixed(1)),
        coveredSamples: covered,
        totalSamples: total,
        allFinite,
      }) + '\n'
    );
  } finally {
    clearInterval(rssTimer);
    await host.handleMessage({ type: 'shutdown' });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    fs.writeSync(1, JSON.stringify({ ok: false, error: err.message }) + '\n');
    process.exit(1);
  }
);
