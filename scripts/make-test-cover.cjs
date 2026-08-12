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

const refFile = path.join(dir, 'cover-reference.wav');
const takeFile = path.join(dir, 'cover-take.wav');
const roomFile = path.join(dir, 'cover-reference-room.wav');
writeWav(refFile, reference[0], reference[1]);
writeWav(takeFile, take[0], take[1]);
writeWav(roomFile, room[0], room[1]);

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
