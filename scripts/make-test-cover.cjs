'use strict';

// Generates the F10 Cover Chain smoke fixtures:
//
//   test-assets/cover-reference.wav      — stands in for the separated ORIGINAL
//                                          vocal: loud, low crest, bright, and
//                                          DRY, so Match Reverb declines.
//   test-assets/cover-take.wav           — stands in for the new take: quieter,
//                                          dark, and with sharp transients that
//                                          give it a much higher crest.
//   test-assets/cover-reference-room.wav — the same reference under a repeating
//                                          exponential fall, so Match Reverb
//                                          ENGAGES instead of declining.
//
// Every property is chosen so one packaged run exercises a specific promise:
//
//   * the two spectra differ by a monotone tilt across 500 Hz - 8 kHz, so Match
//     EQ has a real curve to realise rather than a rounding error;
//   * the reference sits about 10 dB above the take in RMS, so Match Loudness
//     has an unambiguous move;
//   * the take's transients put its peak far above its own RMS, so that move
//     lands the peak OVER full scale and the Limiter stage has something to
//     catch. That is Ruling C, exercised in the packaged app rather than
//     against the synchronous worker mock;
//   * the third file's decay is long enough that Match Reverb runs, which is
//     the only configuration in which the chain's LAST stage can be the one
//     that lifts the output back over the ceiling. That ordering shipped broken
//     once; the packaged run is where it is now caught.
//
// The tilt is a first-order FIR either side of unity: the reference gets
// x[n] - 0.5*x[n-1] (bright) and the take x[n] + 0.5*x[n-1] (dark), from the
// SAME noise, so the difference between them is a spectral shape and nothing
// else. Both are then normalised to their own target RMS.
//
// The comments here state MEASURED properties of the files this script writes,
// not arithmetic on the constants above them: it prints the peak and RMS it
// actually produced, and the figures quoted below are those printed figures.
//
// Plain Node, no app imports. Deterministic PRNG, so every file is
// byte-identical on every machine. The 44-byte RIFF/WAVE header is verbatim
// from make-test-tone.cjs.

const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_RATE = 48000;
const SECONDS = 6;
const CHANNELS = 2;
const BITS = 16;

const REFERENCE_RMS_DBFS = -16;
const TAKE_RMS_DBFS = -26;
/**
 * Transient amplitude in the take, as a fraction of full scale.
 *
 * MEASURED, not computed from this constant alone: the transients are added to
 * noise, so the file's peak is not 20*log10(0.40) = -7.96 dBFS. The generated
 * cover-take.wav measures peak -5.88 dBFS and RMS -25.35 dBFS, so the loudness
 * match (measured at +8.88 dB in the packaged run, not the nominal 10 dB —
 * the gate and the transients both move it) lands the peak at +4.26 dBFS.
 * Over full scale, which is the case Ruling C exists for.
 */
const TAKE_TRANSIENT_PEAK = 0.4;
const TAKE_TRANSIENT_COUNT = 12;
/** Per second; ~2.5 ms each. They raise the take's RMS by 0.65 dB above its
 * normalisation target — small, but not nothing, and the figure above is the
 * measured one rather than the target. */
const TRANSIENT_DECAY = 400;

/**
 * The reverberant reference, which exists for ONE assertion the dry pair cannot
 * reach: the chain's last stage must not be able to lift the output back over
 * the ceiling. Match Reverb declines on the dry reference (correctly — it is
 * dry), so with only that file the packaged run never exercises a chain whose
 * reverb stage engages, and the ordering defect that shipped once is invisible.
 *
 * Three properties, each doing a job, all three verified by the run this script
 * feeds:
 *
 *   * the fall is 30 dB/s repeating every second — an RT60 of 2.00 s against the
 *     Reverb's own 0.710 s floor, so the stage ENGAGES. It is steep enough that
 *     ISO 3382-1's T20 window (-5 dB to -25 dB below each local peak) closes
 *     inside one cycle: 20 dB of fall takes 0.67 s of a 1 s cycle, and
 *     `estimateDecay` accepts 5 decays from the 6 s file;
 *   * the source is hard-clipped to a QUARTER of its peak first, which is what
 *     a loud, heavily compressed lead vocal looks like to a level meter. Without
 *     it the decay envelope leaves the file with a 15 dB crest, its gated level
 *     8 dB below the dry reference's, and the loudness match then turns the take
 *     DOWN — the peak never approaches the ceiling and the assertion is vacuous.
 *     Clipped, the reference's gated level is -9.33 dBFS and the match drives the
 *     take's peak 11.3 dB past the ceiling;
 *   * it is normalised to a -0.5 dBFS peak, so the fixture itself is not clipped.
 *
 * Measured through the real stages: in the order that shipped (limiter, then
 * reverb) this fixture ends at +2.42 dBFS — over full scale, hard-clipped by
 * both writers. With the limiter last it ends at -0.30 dBFS exactly.
 */
const ROOM_CLIP_FRACTION = 0.25;
const ROOM_FALL_DB_PER_SECOND = 30;
const ROOM_CYCLE_SECONDS = 1;
const ROOM_PEAK_DBFS = -0.5;

const numFrames = SAMPLE_RATE * SECONDS;

function prng(seedValue) {
  let seed = seedValue >>> 0;
  return function rand() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One channel of white noise, the SAME source for both files. */
function sourceNoise(seedValue) {
  const rand = prng(seedValue);
  const out = new Float64Array(numFrames);
  for (let i = 0; i < numFrames; i++) out[i] = rand() * 2 - 1;
  return out;
}

/** y[n] = x[n] + coefficient * x[n-1]. Negative brightens, positive darkens. */
function tilt(source, coefficient) {
  const out = new Float64Array(source.length);
  let previous = 0;
  for (let i = 0; i < source.length; i++) {
    out[i] = source[i] + coefficient * previous;
    previous = source[i];
  }
  return out;
}

function normaliseToRms(signal, targetDbfs) {
  let sum = 0;
  for (let i = 0; i < signal.length; i++) sum += signal[i] * signal[i];
  const rms = Math.sqrt(sum / signal.length);
  const scale = Math.pow(10, targetDbfs / 20) / rms;
  for (let i = 0; i < signal.length; i++) signal[i] *= scale;
  return signal;
}

/** The reference clipped flat, then put under a repeating exponential fall.
 * Returns a NEW array: the dry reference is written as it is, so this must not
 * touch it. Peak normalisation is applied afterwards, over both channels at
 * once, so the stereo balance survives. */
function makeRoom(channels) {
  let peak = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  const threshold = peak * ROOM_CLIP_FRACTION;
  const cycle = Math.round(SAMPLE_RATE * ROOM_CYCLE_SECONDS);

  const out = channels.map((c) => {
    const dst = new Float64Array(c.length);
    for (let i = 0; i < c.length; i++) {
      const clipped = Math.max(-threshold, Math.min(threshold, c[i]));
      dst[i] = clipped * Math.pow(10, (-ROOM_FALL_DB_PER_SECOND * ((i % cycle) / SAMPLE_RATE)) / 20);
    }
    return dst;
  });

  let outPeak = 0;
  for (const c of out) for (let i = 0; i < c.length; i++) outPeak = Math.max(outPeak, Math.abs(c[i]));
  const scale = Math.pow(10, ROOM_PEAK_DBFS / 20) / outPeak;
  for (const c of out) for (let i = 0; i < c.length; i++) c[i] *= scale;
  return out;
}

/** Sharp decaying transients, added AFTER normalisation so they raise the peak
 * without moving the level the loudness match measures. */
function addTransients(signal) {
  const spacing = Math.floor(numFrames / (TAKE_TRANSIENT_COUNT + 1));
  for (let k = 1; k <= TAKE_TRANSIENT_COUNT; k++) {
    const start = k * spacing;
    for (let i = 0; i < SAMPLE_RATE * 0.02 && start + i < numFrames; i++) {
      const envelope = Math.exp((-TRANSIENT_DECAY * i) / SAMPLE_RATE);
      signal[start + i] += TAKE_TRANSIENT_PEAK * envelope * (i % 2 === 0 ? 1 : -1);
    }
  }
  return signal;
}

// ── The shared-onset pair, for the alignment's CONFIDENT arm ────────────────
//
// M4. The three files above are filtered NOISE, built to give Match EQ a tilt
// and Match Loudness a move. Continuous noise has no syllables, so the pair
// shares no ONSET structure and `coverAlign` correctly REFUSES on it — measured
// in the packaged run at correlation 0.210 against the then floor of 0.607 and
// prominence 0.031 against 0.186. (CC2 rebuilt the evidence and re-derived both:
// the floors are 0.731 and 0.12 now, and these two measured figures predate the
// smoothing that raised every peak. The refusal itself is unchanged — the unit
// sweep's room-tone members are this fixture's shape and top out at 0.6538.)
// That refusal is the right answer for that material, and it means the packaged
// app has never once exercised the arm that BELIEVES an offset. These two files
// exist for exactly that arm.
//
// The ground truth is BUILT rather than measured: both files render the SAME
// syllable schedule, and the take's is laid down `SYNC_OFFSET_SECONDS` later.
// The recovered number is therefore MINUS that constant, not plus it:
// `coverAlign` reports "the take's sample 0 on the reference's timeline", and a
// take carrying 0.75 s of leading silence has to start 0.75 s EARLIER for its
// syllables to land on the song's. The journey then places it at zero and
// shifts BOTH tracks, which is the negative-offset arm doing its job.
// The schedule is what an onset envelope carries, so two renderings of one
// schedule line up and the recovered offset must come back as that constant.
// The take is a DIFFERENT PERFORMANCE of it — other pitches, other dynamics,
// its own noise — so what is recovered is the shared rhythm rather than a
// trivial autocorrelation of one signal against a copy of itself.
//
// The song carries a bed under its vocal, and ships WITH ITS STEMS ALREADY
// SEPARATED — five extra, extensionless files named exactly as the journey's
// reuse rule expects (`<song doc> — <label>`, and a document is named after the
// whole file basename, so these carry no extension). That is not a shortcut
// around stage 1; it is the only way this arm can be reached at all, and the
// reason is MEASURED:
//
//   Driving the real separation model with the mix routes essentially all of it
//   to OTHER. Measured on this fixture — source RMS -17.99 dBFS, and the stems
//   came back Drums -54.71, Bass -73.04, VOCALS -59.28, Other -17.99, Residual
//   -77.96. The model does not hear a synthetic three-harmonic tone as a voice,
//   so the Vocals stem is 41 dB below the source: empty. The journey then aligns
//   the take against a silent reference and correctly refuses (prominence 0.003,
//   measured against the pre-CC2 floor of 0.186; the floor is 0.12 now and 0.003
//   is nowhere near it either way). Nothing is wrong with the alignment there;
//   the reference simply has no onsets in it — which is the exact shape CC2's
//   unit sweep now carries as a kept LEAKAGE member of the unrelated population.
//
// Exercising the believed arm through a fresh model pass would need a song a
// trained separation model recognises as singing — i.e. a real vocal recording,
// which this repo cannot carry. So this pair takes the journey's REUSE path
// instead: stage 1 finds these five already open and says so. Reuse is a
// shipped, documented behaviour and the fresh-separation path stays covered by
// the noise pass beside this one, so between them the step covers both arms of
// stage 1 as well as both arms of stage 3.
//
// The five stems sum EXACTLY to the mix (vocals + bed, with three silent), which
// is separation's own hard guarantee — so the instrumental the journey builds by
// summing the four non-vocal stems is the bed, to the last bit.
// T3: the plant and the smoke's assertion are one constant now — see
// `cover-fixture-manifest.cjs` for why the recovered number is its negation.
const { SYNC_OFFSET_SECONDS } = require('./cover-fixture-manifest.cjs');
/** The schedule BOTH files share — the ground truth itself. */
const SYNC_SCHEDULE_SEED = 0x51d3a7;
const SYNC_SONG_VARIANCE_SEED = 0x1a2b3c;
const SYNC_TAKE_VARIANCE_SEED = 0x4d5e6f;
/** A cover sings the same words at other pitches, and does not hit the same
 * levels — so the two renderings differ in everything EXCEPT the schedule. */
const SYNC_TAKE_HZ_SCALE = 1.06;
const SYNC_TAKE_AMPLITUDE_JITTER = 0.25;
/**
 * The bed, which the alignment never sees.
 *
 * MEASURED, and the measurement changed the design. The alignment's reference
 * is the separated VOCAL, not the mix — so what matters is that the Vocals stem
 * carries the schedule, and the bed is free to be a realistic instrumental. It
 * was not always free: while this fixture drove the real separation model, the
 * bed sat in the reference and traded directly against accuracy (offset error
 * against the built-in -0.75 s, on the raw mix):
 *
 *   bed      error     peak corr   prominence
 *   -32 dB   13.0 ms     0.638       0.357     <- outside the proven +/-10 ms
 *   -40 dB   10.4 ms     0.775       0.477     <- still outside
 *   -48 dB    7.94 ms    0.849       0.541
 *   none      0.07 ms    0.956       0.684
 *
 * That trade is gone now that the stems are shipped alongside the mix (below),
 * because the reference is the pure Vocals stem — the bottom row. So the bed
 * goes back to a level that makes the instrumental worth listening to.
 */
const SYNC_BED_RMS_DBFS = -32;
const SYNC_VOCAL_RMS_DBFS = -18;

/** Bursts of 0.12-0.37 s separated by gaps of 0.04-0.39 s, which is roughly how
 * sung phrasing sits on an onset envelope. Ported from the unit fixtures
 * (`src/dsp/__fixtures__/coverAlignFixtures.ts`) rather than re-invented — this
 * script may not import app code, so the two copies are deliberate. */
function syllableSchedule(seedValue, seconds) {
  const rand = prng(seedValue);
  const out = [];
  let t = 0.2 + rand() * 0.3;
  while (t < seconds - 0.5) {
    const durationSeconds = 0.12 + rand() * 0.25;
    out.push({ startSeconds: t, durationSeconds, hz: 140 + rand() * 180, amplitude: 0.3 + rand() * 0.6 });
    t += durationSeconds + 0.04 + rand() * 0.35;
  }
  return out;
}

/** Renders a schedule as vocal-like audio into a fixed `numFrames` buffer: each
 * syllable is a raised-cosine envelope over three harmonics. Nothing here is a
 * claim about how singing SOUNDS — it is a claim about where the ATTACKS are,
 * which is the only thing an onset envelope carries. Syllables past the end are
 * dropped, so the take's later lead simply costs it its last one. */
function renderVocal(schedule, { leadSeconds = 0, hzScale = 1, amplitudeJitter = 0, varianceSeed }) {
  const out = new Float64Array(numFrames);
  const rand = prng(varianceSeed);
  for (const syl of schedule) {
    const gain = syl.amplitude * (1 + amplitudeJitter * (rand() * 2 - 1));
    const hz = syl.hz * hzScale;
    const start = Math.round((leadSeconds + syl.startSeconds) * SAMPLE_RATE);
    const len = Math.round(syl.durationSeconds * SAMPLE_RATE);
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      if (idx < 0 || idx >= numFrames) continue;
      const env = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len);
      const w = (2 * Math.PI * hz * i) / SAMPLE_RATE;
      out[idx] += gain * env * (Math.sin(w) + 0.5 * Math.sin(2 * w) + 0.25 * Math.sin(3 * w)) * 0.55;
    }
  }
  return out;
}

function writeWav(file, left, right) {
  const bytesPerSample = BITS / 8;
  const blockAlign = CHANNELS * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (const channel of [left, right]) {
      const clamped = Math.max(-1, Math.min(1, channel[i]));
      view.setInt16(offset, Math.round(clamped * 32767), true);
      offset += 2;
    }
  }
  fs.writeFileSync(file, Buffer.from(buffer));
  return dataSize;
}

const dir = path.join(__dirname, '..', 'test-assets');
fs.mkdirSync(dir, { recursive: true });

// Two independent noise seeds for L and R so the files are genuinely stereo,
// but the SAME two seeds on both sides of the pair — the only difference
// between reference and take is the tilt, the level and the transients.
const sources = [sourceNoise(0x5f3a1c07), sourceNoise(0x21b8d4e9)];

const reference = sources.map((s) => normaliseToRms(tilt(s, -0.5), REFERENCE_RMS_DBFS));
const take = sources.map((s) => addTransients(normaliseToRms(tilt(s, 0.5), TAKE_RMS_DBFS)));

const room = makeRoom(reference);

// The shared-onset pair. ONE schedule, rendered twice — the take's laid down
// SYNC_OFFSET_SECONDS later, with its own pitches, dynamics and noise.
const syncSchedule = syllableSchedule(SYNC_SCHEDULE_SEED, SECONDS);
const syncSongVocal = normaliseToRms(
  renderVocal(syncSchedule, { varianceSeed: SYNC_SONG_VARIANCE_SEED }),
  SYNC_VOCAL_RMS_DBFS
);
const syncBed = normaliseToRms(tilt(sourceNoise(0x7c4e11), 0.7), SYNC_BED_RMS_DBFS);
const syncSong = new Float64Array(numFrames);
for (let i = 0; i < numFrames; i++) syncSong[i] = syncSongVocal[i] + syncBed[i];
const syncTake = normaliseToRms(
  renderVocal(syncSchedule, {
    leadSeconds: SYNC_OFFSET_SECONDS,
    hzScale: SYNC_TAKE_HZ_SCALE,
    amplitudeJitter: SYNC_TAKE_AMPLITUDE_JITTER,
    varianceSeed: SYNC_TAKE_VARIANCE_SEED,
  }),
  SYNC_VOCAL_RMS_DBFS
);

const refFile = path.join(dir, 'cover-reference.wav');
const takeFile = path.join(dir, 'cover-take.wav');
const roomFile = path.join(dir, 'cover-reference-room.wav');
const syncSongFile = path.join(dir, 'cover-song-sync.wav');
const syncTakeFile = path.join(dir, 'cover-take-sync.wav');
writeWav(refFile, reference[0], reference[1]);
writeWav(takeFile, take[0], take[1]);
writeWav(roomFile, room[0], room[1]);
writeWav(syncSongFile, syncSong, syncSong);
writeWav(syncTakeFile, syncTake, syncTake);

// The pre-separated stems. Named for the journey's reuse rule — a document is
// named after the WHOLE file basename, so `<song>.wav — Vocals` must be the
// entire filename and carries no extension of its own. The four non-vocal stems
// sum to the bed and all five sum to the mix, exactly.
const silence = new Float64Array(numFrames);
const syncStems = {
  Drums: silence,
  Bass: silence,
  Vocals: syncSongVocal,
  Other: syncBed,
  Residual: silence,
};
const syncStemFiles = [];
for (const [label, signal] of Object.entries(syncStems)) {
  const file = path.join(dir, `cover-song-sync.wav — ${label}`);
  writeWav(file, signal, signal);
  syncStemFiles.push([label, file, signal]);
}
// The exact-sum guarantee, checked here rather than asserted: if these five stop
// summing to the mix, the instrumental the journey builds stops being the bed.
let worstSumError = 0;
for (let i = 0; i < numFrames; i++) {
  let s = 0;
  for (const [, , signal] of syncStemFiles) s += signal[i];
  worstSumError = Math.max(worstSumError, Math.abs(s - syncSong[i]));
}
if (worstSumError > 1e-12) {
  throw new Error(`the sync stems do not sum to the mix (worst |err| ${worstSumError})`);
}

const peakDb = (channels) => {
  let peak = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  return 20 * Math.log10(peak);
};
const rmsDb = (channels) => {
  let sum = 0;
  let n = 0;
  for (const c of channels) {
    for (let i = 0; i < c.length; i++) sum += c[i] * c[i];
    n += c.length;
  }
  return 10 * Math.log10(sum / n);
};
// MEASURED off the buffers just written, so the log is a fact about the files
// rather than a restatement of the constants at the top.
console.log(
  `Wrote ${refFile} (${SECONDS}s ${SAMPLE_RATE}Hz stereo, RMS ${rmsDb(reference).toFixed(2)} dBFS, peak ${peakDb(reference).toFixed(2)} dBFS)`
);
console.log(
  `Wrote ${takeFile} (${SECONDS}s ${SAMPLE_RATE}Hz stereo, RMS ${rmsDb(take).toFixed(2)} dBFS, peak ${peakDb(take).toFixed(2)} dBFS; ` +
    `the reference sits ${(rmsDb(reference) - rmsDb(take)).toFixed(2)} dB above it, so the match lands the peak near ` +
    `${(peakDb(take) + (rmsDb(reference) - rmsDb(take))).toFixed(2)} dBFS)`
);
console.log(
  `Wrote ${roomFile} (${SECONDS}s ${SAMPLE_RATE}Hz stereo, RMS ${rmsDb(room).toFixed(2)} dBFS, peak ${peakDb(room).toFixed(2)} dBFS, ` +
    `clipped to ${ROOM_CLIP_FRACTION} of its peak then a ${ROOM_FALL_DB_PER_SECOND} dB/s fall every ${ROOM_CYCLE_SECONDS}s ` +
    `= RT60 ${(60 / ROOM_FALL_DB_PER_SECOND).toFixed(2)}s, so Match Reverb engages)`
);
console.log(
  `Wrote ${syncSongFile} (${SECONDS}s ${SAMPLE_RATE}Hz stereo, RMS ${rmsDb([syncSong]).toFixed(2)} dBFS, peak ${peakDb([syncSong]).toFixed(2)} dBFS; ` +
    `${syncSchedule.length} syllables over a ${SYNC_BED_RMS_DBFS} dBFS bed, so separation has both a vocal and an instrumental to find)`
);
console.log(
  `Wrote ${syncTakeFile} (${SECONDS}s ${SAMPLE_RATE}Hz stereo, RMS ${rmsDb([syncTake]).toFixed(2)} dBFS, peak ${peakDb([syncTake]).toFixed(2)} dBFS; ` +
    `the SAME ${syncSchedule.length}-syllable schedule laid down ${SYNC_OFFSET_SECONDS}s later at ×${SYNC_TAKE_HZ_SCALE} pitch — ` +
    `the take's own sample 0 therefore sits ${SYNC_OFFSET_SECONDS}s BEFORE the song's, so the believed arm must ` +
    `recover ${(-SYNC_OFFSET_SECONDS).toFixed(2)}s: offset is the take's zero on the song's timeline)`
);
console.log(
  `Wrote ${syncStemFiles.length} pre-separated stems beside it (${syncStemFiles.map(([l]) => l).join(', ')}), ` +
    `summing to the mix exactly (worst |err| ${worstSumError}) — so the journey's stage 1 REUSES them and ` +
    `the alignment gets a real vocal reference instead of the empty Vocals stem the model produces from synthetic audio`
);
