'use strict';

// Generates test-assets/tone.wav: a 2s, 440Hz stereo, 16-bit PCM, 44100Hz WAV,
// built by hand with a DataView so the smoke test has a deterministic real file
// to open. Plain Node, no app imports.

const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_RATE = 44100;
const SECONDS = 2;
const FREQ = 440;
const CHANNELS = 2;
const BITS = 16;

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

let offset = 44;
for (let i = 0; i < numFrames; i++) {
  const sample = Math.sin((2 * Math.PI * FREQ * i) / SAMPLE_RATE) * 0.5;
  const int16 = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
  view.setInt16(offset, int16, true); // L
  view.setInt16(offset + 2, int16, true); // R
  offset += 4;
}

const outDir = path.resolve(__dirname, '..', 'test-assets');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'tone.wav');
fs.writeFileSync(outPath, Buffer.from(buffer));
console.log(`Wrote ${outPath} (${buffer.byteLength} bytes, ${numFrames} frames, ${CHANNELS}ch @ ${SAMPLE_RATE}Hz)`);
