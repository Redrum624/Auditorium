'use strict';

// Generates test-assets/beat120.wav: an 8s, 120 BPM, 16-bit stereo click train
// at 44100Hz, so the smoke test has a deterministic file with an unambiguous
// tempo to detect. 120 BPM = 2 beats/second = 16 beats in 8s.
//
// Each beat is a short exponentially-decaying noise burst plus a tonal ping --
// broadband enough that the log-band spectral flux ODF (tempoCore.ts) sees a
// clean onset in every band, which is what makes the detected BPM stable.
// Plain Node, no app imports. The 44-byte RIFF/WAVE header is verbatim from
// make-test-tone.cjs.

const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_RATE = 44100;
const SECONDS = 8;
const BPM = 120;
const CHANNELS = 2;
const BITS = 16;

const CLICK_SECONDS = 0.04; // burst length
const DECAY = 60; // exponential decay rate; higher = tighter transient
const PING_HZ = 1200;

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

// Deterministic PRNG (mulberry32) -- the fixture must be byte-identical on
// every machine, so Math.random() is not usable here.
let seed = 0x9e3779b9;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const samplesPerBeat = Math.round((60 / BPM) * SAMPLE_RATE);
const clickLen = Math.round(CLICK_SECONDS * SAMPLE_RATE);
const numBeats = Math.floor(numFrames / samplesPerBeat);

const mono = new Float32Array(numFrames);
for (let b = 0; b < numBeats; b++) {
  const start = b * samplesPerBeat;
  // Downbeat (every 4th beat) is louder, giving the bar grid a phase to find.
  const gain = b % 4 === 0 ? 0.9 : 0.55;
  for (let i = 0; i < clickLen && start + i < numFrames; i++) {
    const env = Math.exp((-DECAY * i) / SAMPLE_RATE);
    const noise = rand() * 2 - 1;
    const ping = Math.sin((2 * Math.PI * PING_HZ * i) / SAMPLE_RATE);
    mono[start + i] += env * gain * (0.6 * noise + 0.4 * ping);
  }
}

let offset = 44;
for (let i = 0; i < numFrames; i++) {
  const s = Math.max(-1, Math.min(1, mono[i]));
  const int16 = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
  view.setInt16(offset, int16, true); // L
  view.setInt16(offset + 2, int16, true); // R
  offset += 4;
}

const outDir = path.resolve(__dirname, '..', 'test-assets');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'beat120.wav');
fs.writeFileSync(outPath, Buffer.from(buffer));
console.log(
  `Wrote ${outPath} (${buffer.byteLength} bytes, ${numFrames} frames, ${numBeats} beats @ ${BPM} BPM, ${CHANNELS}ch @ ${SAMPLE_RATE}Hz)`
);
