'use strict';

// Generates test-assets/abab120.wav: 64s, 120 BPM 4/4, 16-bit stereo at
// 44100Hz, with the A B A B structure the remix analysis (T9) was designed
// against -- 8 bars each, so the clusterer sees two distinct repeating
// sections and the planner has genuine A->A and B->B repeat candidates to
// join on.
//
//   A = 220 Hz (A3) + 329.63 Hz (E4)  -- pitch classes {A, E}
//   B = 261.63 Hz (C4) + 392.00 Hz (G4) -- pitch classes {C, G}
//   plus a click layer on every beat so the tempo/beat grid is unambiguous.
//
// The two sets are DISJOINT in pitch class, which matters: an earlier version
// used A = A+E and B = A+C#, and because both contain A the chroma vectors
// overlapped enough that the clusterer produced five blurred groups instead of
// two, symmetric about the middle -- it was tracking drift, not structure. The
// sections also differ timbrally (B carries a 3rd-harmonic edge) so the timbre
// descriptor separates them too, not only chroma.
//
// 120 BPM 4/4 -> 2 s per bar -> 8 bars = 16 s per section -> 4 sections = 64 s.
// Plain Node, no app imports. The 44-byte RIFF/WAVE header is verbatim from
// make-test-tone.cjs.

const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_RATE = 44100;
const BPM = 120;
const BEATS_PER_BAR = 4;
const BARS_PER_SECTION = 8;
const SECTIONS = ['A', 'B', 'A', 'B'];
const CHANNELS = 2;
const BITS = 16;

const TONES = {
  A: [220, 329.63], // A3 + E4
  B: [261.63, 392.0], // C4 + G4
};
// Relative level of the 3rd harmonic, per section -- a timbral separator on
// top of the chroma one.
const HARMONIC3 = { A: 0.0, B: 0.35 };

const CLICK_SECONDS = 0.04;
const DECAY = 60;
const PING_HZ = 1200;

const samplesPerBeat = Math.round((60 / BPM) * SAMPLE_RATE);
const samplesPerBar = samplesPerBeat * BEATS_PER_BAR;
const samplesPerSection = samplesPerBar * BARS_PER_SECTION;
const numFrames = samplesPerSection * SECTIONS.length;

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

const mono = new Float32Array(numFrames);

// Tonal bed, phase-continuous WITHIN a section so a section is internally
// smooth; sections butt against each other, which is exactly the boundary the
// bar-boundary descriptors are meant to characterise.
for (let s = 0; s < SECTIONS.length; s++) {
  const freqs = TONES[SECTIONS[s]];
  const h3 = HARMONIC3[SECTIONS[s]];
  const start = s * samplesPerSection;
  for (let i = 0; i < samplesPerSection; i++) {
    let v = 0;
    for (const f of freqs) {
      v += Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE);
      if (h3 > 0) v += h3 * Math.sin((2 * Math.PI * 3 * f * i) / SAMPLE_RATE);
    }
    mono[start + i] += (v / freqs.length) * 0.35;
  }
}

// Click layer on every beat, with a louder downbeat so the bar phase is clear.
const clickLen = Math.round(CLICK_SECONDS * SAMPLE_RATE);
const numBeats = Math.floor(numFrames / samplesPerBeat);
for (let b = 0; b < numBeats; b++) {
  const start = b * samplesPerBeat;
  const gain = b % BEATS_PER_BAR === 0 ? 0.5 : 0.3;
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
const outPath = path.join(outDir, 'abab120.wav');
fs.writeFileSync(outPath, Buffer.from(buffer));
console.log(
  `Wrote ${outPath} (${buffer.byteLength} bytes, ${numFrames} frames, ${SECTIONS.join('')} ` +
    `${BARS_PER_SECTION} bars each @ ${BPM} BPM ${BEATS_PER_BAR}/4, ${CHANNELS}ch @ ${SAMPLE_RATE}Hz)`
);
