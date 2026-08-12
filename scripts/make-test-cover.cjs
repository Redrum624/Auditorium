'use strict';

// Generates the F10 Cover Chain smoke fixtures:
//
//   test-assets/cover-reference.wav  — stands in for the separated ORIGINAL
//                                      vocal: loud, low crest, bright.
//   test-assets/cover-take.wav       — stands in for the new take: 10 dB
//                                      quieter, dark, and with sharp transients
//                                      that give it a much higher crest.
//
// Every property is chosen so one packaged run exercises a specific promise:
//
//   * the two spectra differ by a monotone tilt across 500 Hz - 8 kHz, so Match
//     EQ has a real curve to realise rather than a rounding error;
//   * the reference sits exactly 10 dB above the take in RMS, so Match Loudness
//     has an unambiguous move;
//   * the take's transients put its peak ~18 dB above its own RMS, so that
//     +10 dB move lands the peak OVER full scale and the Limiter stage has
//     something to catch. That is Ruling C, exercised in the packaged app
//     rather than against the synchronous worker mock.
//
// The tilt is a first-order FIR either side of unity: the reference gets
// x[n] - 0.5*x[n-1] (bright) and the take x[n] + 0.5*x[n-1] (dark), from the
// SAME noise, so the difference between them is a spectral shape and nothing
// else. Both are then normalised to their own target RMS, which is what leaves
// the level difference exactly 10 dB.
//
// Plain Node, no app imports. Deterministic PRNG, so both files are
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
/** Transient amplitude in the take, as a fraction of full scale. 0.40 is
 * -7.96 dBFS, so a +10 dB loudness match lands the peak at +2.0 dBFS. */
const TAKE_TRANSIENT_PEAK = 0.4;
const TAKE_TRANSIENT_COUNT = 12;
const TRANSIENT_DECAY = 400; // per second; ~2.5 ms, short enough not to move RMS

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

const refFile = path.join(dir, 'cover-reference.wav');
const takeFile = path.join(dir, 'cover-take.wav');
writeWav(refFile, reference[0], reference[1]);
writeWav(takeFile, take[0], take[1]);

const peakDb = (channels) => {
  let peak = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  return 20 * Math.log10(peak);
};
console.log(
  `Wrote ${refFile} (${SECONDS}s ${SAMPLE_RATE}Hz stereo, RMS ${REFERENCE_RMS_DBFS} dBFS, peak ${peakDb(reference).toFixed(2)} dBFS)`
);
console.log(
  `Wrote ${takeFile} (${SECONDS}s ${SAMPLE_RATE}Hz stereo, RMS ${TAKE_RMS_DBFS} dBFS, peak ${peakDb(take).toFixed(2)} dBFS ` +
    `-> ${(peakDb(take) + (REFERENCE_RMS_DBFS - TAKE_RMS_DBFS)).toFixed(2)} dBFS after a ${REFERENCE_RMS_DBFS - TAKE_RMS_DBFS} dB loudness match)`
);
