'use strict';

// V4 — does a SECOND separation pass over the instrumental reduce the ghost of
// the original singer that the first pass leaves behind?
//
// The question is the user's, from a real Cover Chain run: the Separate row
// told them the instrumental still contains the original singer 9.5–11.8 dB
// below the music across 250 Hz–4 kHz, and they asked whether "a more targeted
// second pass on what's left" would help. This script answers it by measuring,
// with the real model, before anything is built.
//
//   node scripts/stem-second-pass-probe.cjs --model=<onnx> --bed=<f32> \
//     --mix=<f32> --samples=<N> [--lag=<samples>] [--gain=<g>] [--out=<json>]
//
// ── Reproducing the committed verdict ───────────────────────────────────────
// The material is the pair `src/dsp/coverMatch.ts` already names as this app's
// reference song — a vocal master and its OFFICIAL instrumental release, both
// user-local under `test-assets/` and gitignored (plan ruling 9: copyrighted
// audio never enters a committed artifact, so the example below uses
// placeholder names — substitute the two local masters).
// Decode a 30 s window of each at the model's rate, then measure:
//
//   npx electron scripts/decode-media-slice.cjs \
//     --in="test-assets/<the vocal master>.wav" \
//     --out=test-output/sp-mix.f32 --offset=60 --seconds=30
//   npx electron scripts/decode-media-slice.cjs \
//     --in="test-assets/<the official instrumental release>.mp3" \
//     --out=test-output/sp-bed.f32 --offset=60 --seconds=30
//   node scripts/stem-second-pass-probe.cjs \
//     --model=test-assets/models/htdemucs_fp16weights.onnx \
//     --bed=test-output/sp-bed.f32 --mix=test-output/sp-mix.f32 \
//     --samples=1323000 --lag=-1024 --gain=1.2181550843498046 \
//     --out=docs/bench/stem-second-pass-rejected.json
//
// `--lag` and `--gain` put the instrumental master on the vocal master's clock
// and level: they are the argmax lag and the least-squares gain between the two
// masters over that window (r = 0.944 at -1024 samples), measured once. They do
// not need to be exact — the ghost measurement below is exact whatever they
// are, because the bed is an INPUT to the constructed mix rather than something
// recovered by subtracting one master from the other. They only decide how
// musically coherent the constructed mix is.
//
// ── THE DECISION GATE, stated before the measurement ────────────────────────
// GO — build an opt-in second pass — only if BOTH hold:
//   (a) IMPROVEMENT. The ghost's level in 250 Hz–4 kHz falls by >= 3.0 dB.
//       Three dB because the shipped figure the user is complaining about is a
//       9.5–11.8 dB margin: a change smaller than 3 dB leaves them in the same
//       complaint, and an opt-in button that costs another multi-minute model
//       run and ~5 GB of RSS has to buy an audible difference to be worth
//       offering at all.
//   (b) NO COLLATERAL DAMAGE. Vocal-free music through the same pass comes
//       back essentially unchanged: its 250 Hz–4 kHz level moves by <= 1.0 dB,
//       AND what the pass removed from it sits >= 20 dB below it in that band.
//       Twenty dB because the ghost being chased is itself 17.95 dB below the
//       music; damage nearer than that trades a known artefact for an unknown
//       one, on material the user already accepted.
// NO-GO otherwise, and then there is no feature: the numbers go into the
// report, KNOWN_LIMITATIONS and the warning copy, so the suggestion is
// answered permanently rather than re-asked every release.
//
// ── How the ghost is measured without a ground truth the user could not have ─
// The mix is CONSTRUCTED, so the bed is known to the sample:
//
//   BED  = a real, officially vocal-free master of the song (decoded slice),
//          gain- and time-aligned to the vocal master
//   VOC  = the vocals stem of a first pass over the REAL mix of the same song
//          — a real singing recording, not a synthesised one
//   MIX* = BED + VOC                        (exact, by construction)
//
//   pass 1: MIX*          -> instrumental1 (Drums+Bass+Other+Residual, the
//                            four documents the app lands and sums)
//           ghost1 = instrumental1 - BED    (EXACT: no alignment, no estimate)
//   pass 2: instrumental1 -> instrumental2
//           ghost2 = instrumental2 - BED
//   null  : BED           -> bedAfter
//           damage = bedAfter - BED
//
// Every level is `longTermAverageSpectrum` + `bandLevelDb` from
// `src/dsp/coverMatch.ts` — the SAME code the shipped residual figures name,
// used the way that module uses it (each signal gated on its own activity,
// exactly as `matchCurve` compares a reference with a take). No second metric
// is invented here. Ungated broadband RMS is reported alongside as a
// gate-independent cross-check, not as a criterion.
//
// The exact-sum law is ENFORCED on every pass — a violation throws, writes no
// verdict file and exits nonzero: stems + residual must reconstruct that pass's
// input within 2 float32 ULP and be > 99 % bit-exact, the bounds
// `stemService.test.ts` holds the shipped path to. So is the identity every
// figure below rests on — that instrumental_k is EXACTLY its pass's input minus
// that pass's Vocals stem, within -120 dBFS — because each of those figures is
// a difference of two signals, and a broken rig would otherwise print a
// confident verdict on a foundation that had silently gone.
//
// ── What the pass-1 figure does and does not corroborate ────────────────────
// Pass 1 here reads -17.29 dB below the bed against the -17.95 dB this repo
// ships. That is a check on the MEASUREMENT PATH, not an independent
// replication: it is the SAME reference song, a DIFFERENT ~28 s window, and a
// mix this script CONSTRUCTS rather than the released master the shipped figure
// was taken from. What it establishes is that this rig measures the quantity
// the shipped warning is about, by a route that shares no arithmetic with the
// original (exact bed by construction here; aligned master subtraction there).
// It is not evidence that the figure holds across songs.
//
// Out-of-process for the same reasons as `stem-bench-driver.cjs` (onnxruntime
// needs same-realm Float32Arrays, and peak RSS is the inference process), and
// ONE PROCESS PER PASS on top of that — see `runChild`.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

// Require hook: transpile .ts on the fly (the `tempo-bench.cjs` idiom), so the
// measurement runs the app's OWN DSP rather than a copy of it.
require.extensions['.ts'] = (module_, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  module_._compile(outputText, filename);
};

const { longTermAverageSpectrum, bandLevelDb } = require(
  path.join(ROOT, 'src', 'dsp', 'coverMatch.ts')
);
const { partitionStems } = require(path.join(ROOT, 'src', 'dsp', 'stemPartition.ts'));

const { createStemHost } = require('../electron/stemHost.cjs');
const {
  MODEL_SAMPLE_RATE,
  STEM_NAMES,
  STEM_COUNT,
  MODEL_CHANNELS,
} = require('../electron/stemSegmentation.cjs');

/**
 * The APP's stem order, which is not the HOST's.
 *
 * `stemService.ts` lands four documents in `STEM_LABELS` order and reorders the
 * host's outputs into it on the way (its private `HOST_INDEX_FOR_LABEL`). This
 * probe has to hand `partitionStems` the same order, or it would measure the
 * Other stem as the Vocals one and say so confidently.
 *
 * Only the LABEL LIST is repeated: `stemService.ts` cannot be required from a
 * plain-node script (it pulls in the whole renderer store graph), and the swap
 * is module-private there in any case. The swap and the Vocals position are
 * DERIVED from that list and from the host's own exported `STEM_NAMES`, so a
 * change to the HOST's order flows through here by itself and cannot silently
 * mis-map. The list itself, the derived swap and the derived index are pinned
 * against the real ones by `scripts/stem-second-pass-probe.test.cjs`, which
 * reads both sources as text — the `electron/prodGate.test.cjs` idiom for a
 * module a test cannot require.
 */
const STEM_LABELS = ['Drums', 'Bass', 'Vocals', 'Other'];
const HOST_INDEX_FOR_LABEL = STEM_LABELS.map((label) => STEM_NAMES.indexOf(label.toLowerCase()));
const VOCALS_LABEL_INDEX = STEM_LABELS.indexOf('Vocals');
// Loud at load rather than wrong at the verdict: a label the host no longer
// emits maps to -1, and every measurement below would then read a stem that is
// not the one it names.
if (HOST_INDEX_FOR_LABEL.some((i) => i < 0) || VOCALS_LABEL_INDEX < 0) {
  throw new Error(
    `stem order mismatch: labels [${STEM_LABELS}] against host [${STEM_NAMES}]`
  );
}

// The rig's own preconditions, as bounds rather than as recorded numbers (see
// the assertions in `main`). `stemService.test.ts`'s own exact-sum bounds, and
// -120 dBFS for the identities: ~34 dB of headroom over the worst this material
// has produced (-153.83 dB) and still ~18 dB under one float32 ULP at full
// scale, so it fails on a broken rig and not on rounding.
const EXACT_SUM_MAX_ULPS = 2;
const EXACT_SUM_MIN_EXACT_FRACTION = 0.99;
const IDENTITY_MAX_RMS_DB = -120;

// The band the shipped warning names, and its four octaves.
const BAND_LO_HZ = 250;
const BAND_HI_HZ = 4000;
const OCTAVES = [
  [250, 500],
  [500, 1000],
  [1000, 2000],
  [2000, 4000],
];
// The two bands OUTSIDE the shipped one. Not criteria — the gate is about the
// band a lead vocal occupies — but a second pass that changes nothing in that
// band and something everywhere else would be worth knowing about, and an
// unmeasured "everywhere else" is exactly the kind of gap this repo's reviews
// keep finding.
const BELOW_BAND = [20, 250];
const ABOVE_BAND = [4000, 20000];

// The gate, in dB and dB.
const IMPROVEMENT_REQUIRED_DB = 3.0;
const BED_LEVEL_TOLERANCE_DB = 1.0;
const DAMAGE_BELOW_BED_REQUIRED_DB = 20.0;

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function loadPlanarStereo(file, total) {
  const raw = fs.readFileSync(file);
  if (raw.byteLength !== total * 2 * 4) {
    throw new Error(`${file} is ${raw.byteLength} bytes, expected ${total * 2 * 4} (planar stereo f32)`);
  }
  const all = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  return [all.subarray(0, total), all.subarray(total, 2 * total)];
}

function rmsDbOf(channels) {
  let sumSq = 0;
  let n = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      sumSq += ch[i] * ch[i];
      n++;
    }
  }
  return 20 * Math.log10(Math.max(Math.sqrt(sumSq / Math.max(n, 1)), 1e-12));
}

function subtract(a, b) {
  return a.map((ch, c) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = Math.fround(ch[i] - b[c][i]);
    return out;
  });
}

function add(a, b) {
  return a.map((ch, c) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = Math.fround(ch[i] + b[c][i]);
    return out;
  });
}

/** The instrumental the app lands: the four NON-vocal stems summed, in the
 * order `coverJourney.sumInstrumental` sums the documents (Drums, Bass, Other,
 * Residual). Not `mix - vocals` — that is the same signal to within a float32
 * ULP, but the app's number is the one being measured. */
function sumInstrumental(partition) {
  const parts = [
    // Every stem that is NOT the Vocals one, in label order, then the Residual
    // last — derived from `VOCALS_LABEL_INDEX` rather than written out, for the
    // same reason the swap above is.
    ...STEM_LABELS.map((_, i) => i)
      .filter((i) => i !== VOCALS_LABEL_INDEX)
      .map((i) => partition.stems[i]),
    partition.residual,
  ];
  return [0, 1].map((c) => {
    const out = new Float32Array(parts[0][c].length);
    for (let i = 0; i < out.length; i++) {
      let acc = parts[0][c][i];
      for (let p = 1; p < parts.length; p++) acc = Math.fround(acc + parts[p][c][i]);
      out[i] = acc;
    }
    return out;
  });
}

/** Band levels of one signal, in the shipped band and its octaves. */
function levels(channels) {
  const ltas = longTermAverageSpectrum(channels, MODEL_SAMPLE_RATE);
  const round = (v) => (v === null ? null : Number(v.toFixed(2)));
  return {
    frames: ltas.frames,
    bandDb: round(bandLevelDb(ltas, BAND_LO_HZ, BAND_HI_HZ)),
    belowBandDb: round(bandLevelDb(ltas, BELOW_BAND[0], BELOW_BAND[1])),
    aboveBandDb: round(bandLevelDb(ltas, ABOVE_BAND[0], ABOVE_BAND[1])),
    octavesDb: OCTAVES.map(([lo, hi]) => round(bandLevelDb(ltas, lo, hi))),
    rmsDb: Number(rmsDbOf(channels).toFixed(2)),
  };
}

const sub = (a, b) => (a === null || b === null ? null : Number((a - b).toFixed(2)));
const subEach = (a, b) => a.map((v, i) => sub(v, b[i]));

/** `stemService.test.ts`'s reconstruction check, verbatim in shape: the
 * exact-sum law is that stems + residual give the input back to float32
 * granularity, and it is asserted on every pass here too. */
function reconstructionError(stems, residual, mix) {
  let worstAbs = 0;
  let worstUlps = 0;
  let exact = 0;
  let total = 0;
  for (let c = 0; c < mix.length; c++) {
    for (let n = 0; n < mix[c].length; n++) {
      let acc = stems[0][c][n];
      for (let s = 1; s < stems.length; s++) acc = Math.fround(acc + stems[s][c][n]);
      const recon = Math.fround(acc + residual[c][n]);
      const err = Math.abs(recon - mix[c][n]);
      const scale = Math.max(Math.abs(mix[c][n]), Math.abs(acc), Math.abs(residual[c][n]));
      const ulp = scale * Math.pow(2, -23);
      worstAbs = Math.max(worstAbs, err);
      if (ulp > 0) worstUlps = Math.max(worstUlps, err / ulp);
      if (recon === mix[c][n]) exact++;
      total++;
    }
  }
  return {
    worstAbs: Number(worstAbs.toExponential(3)),
    worstUlps: Number(worstUlps.toFixed(3)),
    exactFraction: Number((exact / total).toFixed(6)),
  };
}

/**
 * The CHILD half: one separation, in a process of its own, writing the model's
 * raw estimates out in host order (drums, bass, other, vocals) x (L, R) as one
 * planar Float32 blob.
 *
 * ONE PROCESS PER PASS, deliberately. The first version of this probe reused a
 * single host for all four passes and produced a result it could not defend:
 * pass 2's Vocals stem came back 53 dB louder than the null pass's on an input
 * 1 dB away from it. One process per separation is what the app itself does
 * (one `utilityProcess` per job) and it removes the whole question — at the
 * cost of one model load per pass, which is minutes well spent on a
 * measurement that decides whether a feature exists.
 */
async function runChild() {
  const modelPath = path.resolve(arg('model'));
  const inPath = path.resolve(arg('in'));
  const estPath = path.resolve(arg('estimates'));
  const total = Number(arg('samples'));
  const channels = loadPlanarStereo(inPath, total);

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

    await host.handleMessage({
      type: 'separate',
      id: 1,
      sampleRate: MODEL_SAMPLE_RATE,
      channelCount: MODEL_CHANNELS,
      totalSamples: total,
    });
    await host.handleMessage({
      type: 'audio',
      id: 1,
      offset: 0,
      channels: [channels[0].slice(), channels[1].slice()],
    });
    const t0 = Date.now();
    await host.handleMessage({ type: 'run', id: 1 });
    const wallMs = Date.now() - t0;

    const err = posted.find((m) => m.type === 'error');
    if (err) throw new Error(`${err.stage}: ${err.message}`);
    if (!posted.find((m) => m.type === 'done')) throw new Error('no done message');

    const flat = [];
    for (let i = 0; i < STEM_COUNT * MODEL_CHANNELS; i++) flat.push(new Float32Array(total));
    let covered = 0;
    for (const f of posted.filter((m) => m.type === 'stems')) {
      if (f.offset !== covered) throw new Error(`non-contiguous stems chunk at ${f.offset}`);
      for (let sc = 0; sc < STEM_COUNT * MODEL_CHANNELS; sc++) {
        flat[sc].set(f.data.subarray(sc * f.samples, (sc + 1) * f.samples), f.offset);
      }
      covered = f.offset + f.samples;
    }
    if (covered !== total) throw new Error(`covered ${covered} of ${total} samples`);

    const blob = new Float32Array(STEM_COUNT * MODEL_CHANNELS * total);
    for (let i = 0; i < flat.length; i++) blob.set(flat[i], i * total);
    fs.writeFileSync(estPath, Buffer.from(blob.buffer));
    fs.writeSync(
      1,
      JSON.stringify({ ok: true, wallMs, peakRssMb: Math.round(peakRss / (1024 * 1024)) }) + '\n'
    );
  } finally {
    clearInterval(rssTimer);
    await host.handleMessage({ type: 'shutdown' });
  }
}

/**
 * The PARENT half: one separation in a fresh child, returning the partitioned
 * stems the APP would land — not the raw model estimates. Same ordering swap
 * `stemService` applies (`HOST_INDEX_FOR_LABEL`), same `partitionStems` call,
 * and the input is already at the model's rate so no resample leg is involved.
 */
function separateOnce(modelPath, channels, tag, workDir) {
  const total = channels[0].length;
  const inPath = path.join(workDir, `second-pass-${tag}-in.f32`);
  const estPath = path.join(workDir, `second-pass-${tag}-est.f32`);
  const inBlob = new Float32Array(2 * total);
  inBlob.set(channels[0], 0);
  inBlob.set(channels[1], total);
  fs.writeFileSync(inPath, Buffer.from(inBlob.buffer));

  const res = spawnSync(
    process.execPath,
    [
      __filename,
      '--child',
      `--model=${modelPath}`,
      `--in=${inPath}`,
      `--samples=${total}`,
      `--estimates=${estPath}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 24 }
  );
  if (res.status !== 0) {
    throw new Error(`pass ${tag} child exited ${res.status}: ${String(res.stderr).slice(-500)}`);
  }
  const childVerdict = JSON.parse(String(res.stdout).trim().split('\n').pop());

  const raw = fs.readFileSync(estPath);
  const blob = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const flat = [];
  for (let i = 0; i < STEM_COUNT * MODEL_CHANNELS; i++) {
    flat.push(blob.subarray(i * total, (i + 1) * total));
  }
  fs.unlinkSync(inPath);
  fs.unlinkSync(estPath);

  const estimates = STEM_LABELS.map((_, li) => {
    const hostIndex = HOST_INDEX_FOR_LABEL[li];
    return [flat[hostIndex * MODEL_CHANNELS + 0], flat[hostIndex * MODEL_CHANNELS + 1]];
  });
  const partition = partitionStems(channels, estimates);
  const exactSum = reconstructionError(partition.stems, partition.residual, channels);
  return { partition, wallMs: childVerdict.wallMs, peakRssMb: childVerdict.peakRssMb, exactSum };
}

async function main() {
  const modelPath = path.resolve(arg('model'));
  const bedPath = path.resolve(arg('bed'));
  const mixPath = path.resolve(arg('mix'));
  const total = Number(arg('samples'));
  const lag = Number(arg('lag') ?? 0);
  const gain = Number(arg('gain') ?? 1);
  const outPath = arg('out') ? path.resolve(arg('out')) : null;
  const edge = Number(arg('edge') ?? MODEL_SAMPLE_RATE); // trimmed from each end
  if (!fs.existsSync(modelPath) || !Number.isInteger(total) || total <= 0) {
    throw new Error('usage: --model=<onnx> --bed=<f32> --mix=<f32> --samples=<N> [--lag] [--gain] [--out]');
  }

  const bedRaw = loadPlanarStereo(bedPath, total);
  const mixRaw = loadPlanarStereo(mixPath, total);
  const n = total - 2 * edge;
  if (n <= 0 || edge + lag < 0 || edge + lag + n > total) {
    throw new Error('edge/lag leave no usable window');
  }
  // BED: the vocal-free master, put on the vocal master's clock and level.
  // VOCSRC: the vocal master over the same window.
  const bed = [0, 1].map((c) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.fround(gain * bedRaw[c][edge + lag + i]);
    return out;
  });
  const vocSrc = [0, 1].map((c) => mixRaw[c].slice(edge, edge + n));

  const workDir = path.join(ROOT, 'test-output');
  fs.mkdirSync(workDir, { recursive: true });

  const t0 = Date.now();
  {
    // Pass A — harvest a REAL vocal from the real mix.
    const passA = separateOnce(modelPath, vocSrc, 'a', workDir);
    const voc = passA.partition.stems[VOCALS_LABEL_INDEX];

    // The constructed mix, whose bed is known to the sample.
    const mixStar = add(bed, voc);

    // Pass 1 — what the app does today.
    const pass1 = separateOnce(modelPath, mixStar, '1', workDir);
    const vocals1 = pass1.partition.stems[VOCALS_LABEL_INDEX];
    const instrumental1 = sumInstrumental(pass1.partition);
    const ghost1 = subtract(instrumental1, bed);

    // Pass 2 — the user's suggestion.
    const pass2 = separateOnce(modelPath, instrumental1, '2', workDir);
    const vocals2 = pass2.partition.stems[VOCALS_LABEL_INDEX];
    const instrumental2 = sumInstrumental(pass2.partition);
    const ghost2 = subtract(instrumental2, bed);

    // The null test — vocal-free music through the very same pass.
    const passN = separateOnce(modelPath, bed, 'n', workDir);
    const vocalsN = passN.partition.stems[VOCALS_LABEL_INDEX];
    const bedAfter = sumInstrumental(passN.partition);
    const damage = subtract(bedAfter, bed);

    // Identity checks: the exact-sum law says instrumental_k is EXACTLY its
    // pass's input minus that pass's Vocals stem. Measured on the signals
    // themselves rather than trusted, because every number below is a
    // difference of two of them.
    const checks = {
      pass2IdentityRmsDb: Number(
        rmsDbOf(subtract(subtract(instrumental1, vocals2), instrumental2)).toFixed(2)
      ),
      nullIdentityRmsDb: Number(
        rmsDbOf(subtract(subtract(bed, vocalsN), bedAfter)).toFixed(2)
      ),
      pass1IdentityRmsDb: Number(
        rmsDbOf(subtract(subtract(mixStar, vocals1), instrumental1)).toFixed(2)
      ),
      ghost1IsVocMinusVocals1RmsDb: Number(
        rmsDbOf(subtract(ghost1, subtract(voc, vocals1))).toFixed(2)
      ),
    };

    // …and now ENFORCED. Recording these and carrying on would mean a rig whose
    // foundation had silently gone still printed a confident go/no-go: the
    // residual figures are differences of two signals, so a partition that no
    // longer reconstructs, or an instrumental that is no longer its input minus
    // its Vocals stem, does not make the verdict visibly wrong — it makes it
    // wrong and plausible. A violation is a hard stop: no verdict, no file,
    // nonzero exit.
    const exactSumByPass = {
      passA: passA.exactSum,
      pass1: pass1.exactSum,
      pass2: pass2.exactSum,
      nullPass: passN.exactSum,
    };
    for (const [name, e] of Object.entries(exactSumByPass)) {
      // Negated comparisons, so a NaN fails rather than slipping through.
      if (!(e.worstUlps <= EXACT_SUM_MAX_ULPS)) {
        throw new Error(
          `exact-sum law broken on ${name}: worst ${e.worstUlps} float32 ULP, bound ${EXACT_SUM_MAX_ULPS}`
        );
      }
      if (!(e.exactFraction >= EXACT_SUM_MIN_EXACT_FRACTION)) {
        throw new Error(
          `exact-sum law broken on ${name}: ${e.exactFraction} bit-exact, bound ${EXACT_SUM_MIN_EXACT_FRACTION}`
        );
      }
    }
    for (const [name, rms] of Object.entries(checks)) {
      if (!(rms <= IDENTITY_MAX_RMS_DB)) {
        throw new Error(
          `identity broken — ${name} is ${rms} dB, bound ${IDENTITY_MAX_RMS_DB} dB`
        );
      }
    }

    const L = {
      bed: levels(bed),
      voc: levels(voc),
      mixStar: levels(mixStar),
      instrumental1: levels(instrumental1),
      instrumental2: levels(instrumental2),
      vocals1: levels(vocals1),
      vocals2: levels(vocals2),
      vocalsN: levels(vocalsN),
      ghost1: levels(ghost1),
      ghost2: levels(ghost2),
      bedAfter: levels(bedAfter),
      damage: levels(damage),
    };

    const improvementDb = sub(L.ghost1.bandDb, L.ghost2.bandDb);
    const bedLevelShiftDb = sub(L.bedAfter.bandDb, L.bed.bandDb);
    const damageBelowBedDb = sub(L.bed.bandDb, L.damage.bandDb);
    const improved = improvementDb !== null && improvementDb >= IMPROVEMENT_REQUIRED_DB;
    const harmless =
      bedLevelShiftDb !== null &&
      damageBelowBedDb !== null &&
      Math.abs(bedLevelShiftDb) <= BED_LEVEL_TOLERANCE_DB &&
      damageBelowBedDb >= DAMAGE_BELOW_BED_REQUIRED_DB;

    const verdict = {
      ok: true,
      go: improved && harmless,
      gate: {
        improvementRequiredDb: IMPROVEMENT_REQUIRED_DB,
        bedLevelToleranceDb: BED_LEVEL_TOLERANCE_DB,
        damageBelowBedRequiredDb: DAMAGE_BELOW_BED_REQUIRED_DB,
        improvementDb,
        bedLevelShiftDb,
        damageBelowBedDb,
        improved,
        harmless,
      },
      // What the shipped warning states, measured on this material for
      // comparability — the ghost below the bed and below the original vocal.
      ghost: {
        bandLoHz: BAND_LO_HZ,
        bandHiHz: BAND_HI_HZ,
        pass1BelowBedDb: sub(L.ghost1.bandDb, L.bed.bandDb),
        pass1BelowVocalDb: sub(L.ghost1.bandDb, L.voc.bandDb),
        pass2BelowBedDb: sub(L.ghost2.bandDb, L.bed.bandDb),
        pass2BelowVocalDb: sub(L.ghost2.bandDb, L.voc.bandDb),
        pass1BelowBedPerOctaveDb: subEach(L.ghost1.octavesDb, L.bed.octavesDb),
        pass2BelowBedPerOctaveDb: subEach(L.ghost2.octavesDb, L.bed.octavesDb),
        improvementPerOctaveDb: subEach(L.ghost1.octavesDb, L.ghost2.octavesDb),
      },
      // Where the second pass's own output sits: in the band the warning is
      // about, and in the two bands either side of it.
      secondPassOutput: {
        vocals2BelowInstrumental1Db: sub(L.vocals2.bandDb, L.instrumental1.bandDb),
        vocals2BelowInstrumental1BelowBandDb: sub(L.vocals2.belowBandDb, L.instrumental1.belowBandDb),
        vocals2BelowInstrumental1AboveBandDb: sub(L.vocals2.aboveBandDb, L.instrumental1.aboveBandDb),
        instrumentalBroadbandShiftDb: sub(L.instrumental2.rmsDb, L.instrumental1.rmsDb),
        instrumentalBelowBandShiftDb: sub(L.instrumental2.belowBandDb, L.instrumental1.belowBandDb),
        instrumentalAboveBandShiftDb: sub(L.instrumental2.aboveBandDb, L.instrumental1.aboveBandDb),
      },
      nullTest: {
        bedLevelShiftDb,
        damageBelowBedDb,
        damageBelowBedPerOctaveDb: subEach(L.bed.octavesDb, L.damage.octavesDb).map((v) =>
          v === null ? null : Number((-v).toFixed(2))
        ),
        damageRmsDb: L.damage.rmsDb,
        bedRmsDb: L.bed.rmsDb,
      },
      checks,
      exactSum: exactSumByPass,
      levels: L,
      material: {
        samples: n,
        seconds: Number((n / MODEL_SAMPLE_RATE).toFixed(2)),
        sampleRate: MODEL_SAMPLE_RATE,
        bedGain: gain,
        bedLagSamples: lag,
        edgeTrimSamples: edge,
      },
      cost: {
        passWallMs: [passA.wallMs, pass1.wallMs, pass2.wallMs, passN.wallMs],
        // Wall clock INCLUDING the four model loads a process-per-pass costs.
        totalWallMs: Date.now() - t0,
        peakRssMb: Math.max(passA.peakRssMb, pass1.peakRssMb, pass2.peakRssMb, passN.peakRssMb),
      },
    };
    const text = JSON.stringify(verdict, null, 2) + '\n';
    if (outPath) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, text);
    }
    fs.writeSync(1, text);
  }
}

(process.argv.includes('--child') ? runChild() : main()).then(
  () => process.exit(0),
  (err) => {
    fs.writeSync(1, JSON.stringify({ ok: false, error: err.message }) + '\n');
    process.exit(1);
  }
);
