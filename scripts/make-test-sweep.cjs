'use strict';

// Generates test-assets/sweep.wav — the fixture the packaged smoke's
// "every effect in the menu applies" sweep runs on (Task L7). Plain Node, no
// app imports, deterministic (a fixed LCG for the noise) so every machine gets
// a byte-identical file.
//
// WHY A SECOND FIXTURE. tone.wav is a pure, perfectly-tuned, DC-free 440 Hz
// sine with no silence and no noise, and on it a THIRD of the registered
// effects are exact identities: Remove DC Offset subtracts a zero mean, Remove
// Silence finds no silence, Noise Reduction has nothing to profile, Pitch
// Correct sees A4 already in tune and pass-through byte-identically by ruling,
// the De-esser's 5.5 kHz sidechain sees nothing, and the Noise Gate never
// closes. A sweep on tone.wav would therefore have to *allowlist* those as
// justified no-ops — six assertions that cannot fail. This fixture gives each
// of them real material to bite on, so the sweep asserts "the buffer changed"
// for every visible effect with no allowlist at all.
//
// Layout (5 s, stereo, 16-bit PCM, 44100 Hz):
//   [0.00, 1.20) tone A   — 449 Hz (35 cents SHARP of A4, for Pitch Correct),
//                           plus a 6 kHz component (for the De-esser) and a
//                           +0.03 DC bias (for Remove DC Offset). L and R
//                           differ in level and phase, so Pan, Channel Mixer
//                           and the stereo->mono downmix all have work to do.
//   [1.20, 2.10) silence  — EXACT digital zero, 900 ms, comfortably over Remove
//                           Silence's 500 ms minimum and its 2x100 ms padding.
//   [2.10, 3.20) noise    — independent per-channel LCG noise at 0.05 (-26 dBFS):
//                           the Noise Reduction print, and the region the Noise
//                           Gate closes on at a -20 dB threshold.
//   [3.20, 5.00) tone B   — tone A again. The smoke's probe window lives here,
//                           past every earlier segment, so an effect that only
//                           touches the head cannot pass by accident.
//
// Peak is 0.45 + 0.10 + 0.03 = 0.58 (-4.7 dBFS): under full scale, and far
// enough below the Limiter's -0.3 dB default that the sweep has to lower the
// ceiling to make the Limiter do anything (which it does).

const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_RATE = 44100;
const SECONDS = 5;
const CHANNELS = 2;
const BITS = 16;

// 440 Hz * 2^(35/1200) — a quarter-tone-ish sharp A4. Far enough off the
// chromatic grid that Pitch Correct's curve is non-zero, close enough that its
// detector still calls it an A.
const TONE_HZ = 440 * Math.pow(2, 35 / 1200);
const SIBILANT_HZ = 6000;
const DC_BIAS = 0.03;

const numFrames = SAMPLE_RATE * SECONDS;
const bytesPerSample = BITS / 8;
const blockAlign = CHANNELS * bytesPerSample;
const dataSize = numFrames * blockAlign;
const buffer = new ArrayBuffer(44 + dataSize);
const view = new DataView(buffer);

function writeAscii(offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

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

// Segment boundaries in frames — exported in the log so scripts/e2e-smoke.cjs's
// own copies of these numbers can be checked against the generator by eye.
const TONE_A_END = Math.round(1.2 * SAMPLE_RATE); // 52920
const SILENCE_END = Math.round(2.1 * SAMPLE_RATE); // 92610
const NOISE_END = Math.round(3.2 * SAMPLE_RATE); // 141120

// Numerical Recipes' LCG — 32-bit, deterministic, no dependency.
let seed = 0x2f6e2b1;
function rand() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000 - 0.5; // [-0.5, 0.5)
}

function toneSample(i, ampFund, ampSib, phase) {
  const t = i / SAMPLE_RATE;
  return (
    ampFund * Math.sin(2 * Math.PI * TONE_HZ * t + phase) +
    ampSib * Math.sin(2 * Math.PI * SIBILANT_HZ * t) +
    DC_BIAS
  );
}

let offset = 44;
for (let i = 0; i < numFrames; i++) {
  let l;
  let r;
  if (i < TONE_A_END || i >= NOISE_END) {
    l = toneSample(i, 0.45, 0.1, 0);
    r = toneSample(i, 0.3, 0.06, 0.7);
  } else if (i < SILENCE_END) {
    l = 0;
    r = 0;
  } else {
    l = 0.05 * 2 * rand();
    r = 0.05 * 2 * rand();
  }
  const li = Math.max(-32768, Math.min(32767, Math.round(l * 32767)));
  const ri = Math.max(-32768, Math.min(32767, Math.round(r * 32767)));
  view.setInt16(offset, li, true);
  view.setInt16(offset + 2, ri, true);
  offset += 4;
}

const outDir = path.resolve(__dirname, '..', 'test-assets');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'sweep.wav');
fs.writeFileSync(outPath, Buffer.from(buffer));
console.log(
  `Wrote ${outPath} (${buffer.byteLength} bytes, ${numFrames} frames, ${CHANNELS}ch @ ${SAMPLE_RATE}Hz) — ` +
    `tone ${TONE_HZ.toFixed(2)} Hz, silence [${TONE_A_END}, ${SILENCE_END}), noise [${SILENCE_END}, ${NOISE_END})`
);
