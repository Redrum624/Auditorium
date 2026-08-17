'use strict';

// Generates test-assets/long70.wav (mono) and test-assets/long70-stereo.wav
// (its two-channel twin): 70 s of deterministic 44100 Hz, 16-bit PCM, built by
// hand with a DataView. Plain Node, no app imports.
//
// WHY 70 SECONDS, exactly. The transcription manager slices the renderer's
// 16 kHz mono buffer into `AUDIO_SLICE_SAMPLES = 1 << 20` = 1,048,576-sample
// messages (electron/transcribeManager.cjs), which is 1,048,576 / 16,000 =
// 65.536 s of audio per message. Any fixture SHORTER than that crosses the IPC
// in ONE message and cannot prove the slicing works — and the host refuses to
// run unless the delivered slices cover [0, totalSamples) exactly, so a
// multi-slice job is the only thing that exercises the offset arithmetic.
// 70 s gives 70 x 16,000 = 1,120,000 samples = 2 slices with 71,424 samples in
// the tail one, i.e. a SHORT final slice rather than an even split — the case
// an off-by-one in the loop bound would break.
//
// WHY A STEREO TWIN. The align+splice smoke step's degraded path (no real
// take on the machine) needs a ~70 s STEREO document: the fake-mic replacement
// take arrives with 2 channels no matter what the hook requests (Chromium's
// fake device treats `channelCount` as ideal, not exact — see
// RecordingEngine.concatChannels), and `replaceAlignedWord` is DESIGNED to
// refuse a channel-count mismatch. The twin carries the SAME samples in both
// channels, so the aligner's mono downmix is the exact signal the mono
// fixture carries and the two files place words identically.
//
// The content is a slow frequency sweep plus a deterministic LCG noise floor:
// non-repeating, so a decoder cannot collapse the whole file into one cached
// window, and cheap to generate. It is NOT speech and no transcript quality is
// expected of it — the smoke steps assert the TRANSPORT and the SPLICE, not
// the words.

const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_RATE = 44100;
const SECONDS = 70;
const BITS = 16;

const numFrames = SAMPLE_RATE * SECONDS;
const bytesPerSample = BITS / 8;

// The LCG recipe this repo re-declares per generator (make-test-abab.cjs).
let lcg = 20260810;
function rand() {
  lcg = (lcg * 1103515245 + 12345) & 0x7fffffff;
  return lcg / 0x7fffffff - 0.5;
}

// The signal, computed ONCE — both files carry these exact values, so the
// mono file stays byte-identical to what this generator has always written.
const samples = new Int16Array(numFrames);
let phase = 0;
for (let i = 0; i < numFrames; i++) {
  // 180 Hz -> 900 Hz over the whole file, integrated so the phase is
  // continuous (a per-sample `sin(2*pi*f(t)*t)` would click at every step).
  const freq = 180 + (720 * i) / numFrames;
  phase += (2 * Math.PI * freq) / SAMPLE_RATE;
  const sample = 0.35 * Math.sin(phase) + 0.08 * rand();
  samples[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function buildWav(channels) {
  const blockAlign = channels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < channels; c++) {
      view.setInt16(offset, samples[i], true);
      offset += bytesPerSample;
    }
  }
  return buffer;
}

const outDir = path.resolve(__dirname, '..', 'test-assets');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, channels] of [
  ['long70.wav', 1],
  ['long70-stereo.wav', 2],
]) {
  const buffer = buildWav(channels);
  const outPath = path.join(outDir, name);
  fs.writeFileSync(outPath, Buffer.from(buffer));
  console.log(
    `Wrote ${outPath} (${buffer.byteLength} bytes, ${numFrames} frames, ${channels}ch @ ${SAMPLE_RATE}Hz, ${SECONDS}s)`
  );
}
