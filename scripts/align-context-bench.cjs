'use strict';

/**
 * F6 chunk bench — fixes `electron/alignHost.cjs`'s CHUNK_SAMPLES and
 * CONTEXT_SAMPLES, and measures what chunking costs.
 *
 * Two sweeps, because the two constants answer two different questions.
 *
 * **A. How long may one forward pass be?** Self-attention is quadratic in the
 * frame count, so the binding limit is memory, not time. This sweep runs a
 * single pass over 30 / 60 / 120 / 180 s of real audio, each in a FRESH child
 * process so the reported peak RSS is that pass's own, and prints both RSS and
 * realtime factor. CHUNK_SAMPLES is the largest size whose working set stays
 * comparable to the transcription host's stated ~1.2 GB worst case.
 *
 * **B. Does per-chunk context help?** Only measurement can say, because
 * attention has no finite receptive field. This sweep aligns the known text
 * against a single-pass reference grid and against chunked grids at several
 * context lengths, and compares word ONSETS. If context helped, the
 * disagreement count would fall as context grows.
 *
 * Usage:  node scripts/align-context-bench.cjs [--long=<wav>]
 * Requires: test-assets/models/align/*, the reference recordings, and the
 * lyrics sidecar (test-assets/align-bench-lyrics.txt — see
 * align-bench-common.cjs). Skips with a message when material is absent.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  ASSETS,
  MODEL_PATHS,
  LYRICS_SIDECAR,
  LYRIC_LINES,
  SPEECH_CLAUSES,
  loadDsp,
  decodeMono16k,
  runModel,
} = require('./align-bench-common.cjs');

const SINGLE_PASS = 1 << 30;
const MEMORY_SWEEP_SECONDS = [30, 60, 120, 180];
const CANDIDATE_CONTEXT_SECONDS = [0, 0.5, 1, 2, 4];
/** The chunk length sweep B runs at — keep in step with CHUNK_SAMPLES. */
const PRODUCTION_CHUNK_SAMPLES = 16000 * 30;

function alignOne(dsp, grid, text, vocab) {
  const tokenized = dsp.tokenizeLyrics(text, vocab);
  const result = dsp.alignLyrics(grid.logProbs, grid.frames, grid.classes, tokenized, vocab['<pad>']);
  if (!result.ok) throw new Error(`alignment failed: ${result.message}`);
  return result;
}

function main() {
  for (const p of Object.values(MODEL_PATHS)) {
    if (!fs.existsSync(p)) throw new Error(`missing pinned model file: ${p}`);
  }
  if (!LYRIC_LINES) {
    console.log(
      `skipped: the ground-truth lyrics sidecar is absent (${LYRICS_SIDECAR}) — ` +
        'both sweeps score known text against real recordings, so there is nothing to measure without it'
    );
    return;
  }
  const dsp = loadDsp();

  // The long reference take: any long real sung recording works; the default
  // is the user-local take this bench was originally measured on.
  const longArg = process.argv.find((a) => a.startsWith('--long='));
  const longWav = longArg
    ? path.resolve(longArg.slice('--long='.length))
    : path.join(ASSETS, 'long-real-take.wav');
  const shortWav = path.join(ASSETS, 'vocal-30s.wav');
  const speechWav = path.join(ASSETS, 'speech16k.wav');
  if (!fs.existsSync(longWav)) {
    console.log(`skipped: long reference take absent (${longWav}) — pass --long=<wav> to point at one`);
    return;
  }
  const long = decodeMono16k(dsp, longWav);

  // ── A. single-pass length -> memory and speed ─────────────────────────────
  console.log('# A. How long may one forward pass be?');
  console.log('seconds  frames   elapsed      rtf    peak RSS');
  for (const seconds of MEMORY_SWEEP_SECONDS) {
    const n = 16000 * seconds;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = long[i % long.length];
    // One job per invocation: a fresh process per size, so RSS is not the
    // high-water mark of the previous size's arena.
    const { results } = runModel([{ name: `mem-${seconds}`, samples }], {
      chunkSamples: SINGLE_PASS,
      contextSamples: 0,
    });
    const run = results.get(`mem-${seconds}`).run;
    console.log(
      `${String(seconds).padStart(7)} ${String(run.frames).padStart(7)} ` +
        `${String(run.elapsedMs).padStart(8)} ms ${run.realtimeFactor.toFixed(2).padStart(7)}x ` +
        `${(run.rssBytes / 1048576).toFixed(0).padStart(7)} MB`
    );
  }

  // ── B. does per-chunk context help? ───────────────────────────────────────
  //
  // The material has to be longer than one chunk AND fully described by its
  // text. The long reference take is not: it is a whole performance containing
  // the lyric lines more than once (vocal from ~17 s to ~137 s with two
  // sections), so the lyric covers a fraction of it, the aligner is free to
  // place those words almost anywhere among the rest, and what a sweep would
  // measure is that freedom rather than the seam. It is excluded for that
  // reason, and the long material is built by CONCATENATING passages whose
  // text is known for every sample of them.
  const shortSung = fs.existsSync(shortWav) ? decodeMono16k(dsp, shortWav) : null;
  const speech = fs.existsSync(speechWav) ? decodeMono16k(dsp, speechWav) : null;
  if (!shortSung || !speech) throw new Error('sweep B needs both vocal-30s.wav and speech16k.wav');

  const concatenated = new Float32Array(shortSung.length * 2 + speech.length);
  concatenated.set(shortSung, 0);
  concatenated.set(speech, shortSung.length);
  concatenated.set(shortSung, shortSung.length + speech.length);
  const materials = [
    {
      name: 'sung+spoken+sung',
      samples: concatenated,
      text: [LYRIC_LINES.join('\n'), SPEECH_CLAUSES.join(' '), LYRIC_LINES.join('\n')].join('\n'),
    },
    { name: 'vocal-30s', samples: shortSung, text: LYRIC_LINES.join('\n') },
    { name: 'speech16k', samples: speech, text: SPEECH_CLAUSES.join(' ') },
  ];

  console.log(`\n# B. Does per-chunk context help? (chunk ${PRODUCTION_CHUNK_SAMPLES / 16000} s)`);
  const jobs = materials.map((m) => ({ name: m.name, samples: m.samples }));
  const reference = runModel(jobs, { chunkSamples: SINGLE_PASS, contextSamples: 0 });
  const referenceWords = new Map();
  for (const m of materials) {
    referenceWords.set(m.name, alignOne(dsp, reference.results.get(m.name), m.text, reference.vocab));
  }

  const rows = [];
  for (const contextSeconds of CANDIDATE_CONTEXT_SECONDS) {
    const swept = runModel(jobs, {
      chunkSamples: PRODUCTION_CHUNK_SAMPLES,
      contextSamples: Math.round(16000 * contextSeconds),
    });
    for (const m of materials) {
      const grid = swept.results.get(m.name);
      const got = alignOne(dsp, grid, m.text, swept.vocab);
      const ref = referenceWords.get(m.name);
      let maxOnsetFrames = 0;
      let disagreeing = 0;
      for (let i = 0; i < ref.words.length; i++) {
        const d = Math.abs(got.words[i].startFrame - ref.words[i].startFrame);
        if (d > 0) disagreeing++;
        if (d > maxOnsetFrames) maxOnsetFrames = d;
      }
      rows.push({
        material: m.name,
        contextSeconds,
        chunks: grid.run.chunkCount,
        words: ref.words.length,
        disagreeing,
        maxOnsetSeconds: maxOnsetFrames * 0.02,
        pathScoreDelta: got.pathScore - ref.pathScore,
      });
    }
  }

  console.log('material    context  chunks  words  onsets!=ref  max|dOnset|   dPathScore');
  for (const r of rows) {
    console.log(
      `${r.material.padEnd(11)} ${String(r.contextSeconds).padStart(5)} s ` +
        `${String(r.chunks).padStart(6)} ${String(r.words).padStart(6)} ` +
        `${String(r.disagreeing).padStart(12)} ${r.maxOnsetSeconds.toFixed(3)} s ` +
        `${r.pathScoreDelta.toExponential(2).padStart(12)}`
    );
  }

  const perContext = new Map();
  for (const r of rows) {
    const cur = perContext.get(r.contextSeconds) || { disagreeing: 0, maxOnset: 0, words: 0 };
    cur.disagreeing += r.disagreeing;
    cur.words += r.words;
    cur.maxOnset = Math.max(cur.maxOnset, r.maxOnsetSeconds);
    perContext.set(r.contextSeconds, cur);
  }
  console.log('\nTotals across all material:');
  for (const c of CANDIDATE_CONTEXT_SECONDS) {
    const v = perContext.get(c);
    console.log(`  ${String(c).padStart(4)} s -> ${v.disagreeing}/${v.words} onsets differ, max ${v.maxOnset.toFixed(3)} s`);
  }
  const best = CANDIDATE_CONTEXT_SECONDS.reduce((a, b) =>
    perContext.get(b).disagreeing < perContext.get(a).disagreeing ? b : a
  );
  console.log(
    `\nVERDICT: best candidate ${best} s. Context is worth paying for only if the count ` +
      'falls monotonically with it; read the totals above before changing CONTEXT_SAMPLES.'
  );
}

main();
