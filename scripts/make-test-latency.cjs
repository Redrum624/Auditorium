'use strict';

// MT1-3 — the fixture pair the first-play latency rig needs to reproduce the
// reported stall: test-assets/latency-a.wav and latency-b.wav.
//
// WHY THESE PARAMETERS, exactly. The report is "it takes a while to start the
// play with 2 tracks", filed against a session holding two ~3-minute songs.
// Three properties of that session matter, and every one of them is missing
// from `tone.wav`, which is what the rig used before:
//
//   180 SECONDS. The work `MultitrackPlayer.play()` does before it schedules
//   anything is O(samples): `readClipSlice` copies the clip's span
//   sample-by-sample, `buildClipBuffer` walks it again to apply gain/fades. A
//   2-second tone makes that cost invisible — which the old rig said out loud
//   ("so playCallMs measures graph build, not content size") without noticing
//   that content size was the thing users were feeling.
//
//   STEREO. Both loops run per channel, so two channels is twice the work, and
//   two channels is what a song is.
//
//   48000 Hz. This is the load-bearing one. A session is created at 44100
//   (sessionStore's `makeSession(44100)`), so a 48 kHz source takes the
//   `resampleChannel` branch in mixdown.ts — a 64-tap windowed sinc over every
//   output sample, synchronously, inside play(). 48 kHz is also simply what the
//   user's files were, and what any modern recording is; 44.1 kHz sources would
//   measure a session that does not resample and would miss the defect
//   entirely. The status bar reading "44.1 kHz" while both files are 48 kHz is
//   the visible corner of exactly this mismatch.
//
// Two files rather than one used twice, with different content, so nothing can
// collapse them into a shared cache and report a second track as free.
//
// Content: a slow sweep plus a deterministic LCG noise floor, per the house
// style of the other generators — non-repeating, cheap, and NOT musical. This
// fixture measures the transport, not anything audible about it.
//
// ~34.6 MB each, so `test-assets/` is gitignored and these are generated on
// demand (`ensureFixtures`), never committed.

const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_RATE = 48000;
const SECONDS = 180;
const CHANNELS = 2;
const BITS = 16;

const OUT_DIR = path.join(__dirname, '..', 'test-assets');

/** Deterministic per-file content: a sweep whose band and a noise floor whose
 * seed both come from the variant, so the two files are genuinely different
 * audio and not the same buffer under two names. */
function writeVariant(file, { seed, f0, f1 }) {
  const numFrames = SAMPLE_RATE * SECONDS;
  const bytesPerSample = BITS / 8;
  const blockAlign = CHANNELS * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(BITS, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  let rng = seed >>> 0;
  let phase = 0;
  for (let i = 0; i < numFrames; i++) {
    const u = i / numFrames;
    const freq = f0 + (f1 - f0) * u;
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    const noise = (rng / 0xffffffff) * 2 - 1;
    const sweep = Math.sin(phase);
    // The channels differ (the right one is the sweep a little behind and the
    // noise inverted) so a mono-collapsing bug cannot pass as correct here.
    const l = 0.6 * sweep + 0.05 * noise;
    const r = 0.6 * Math.sin(phase - 0.4) - 0.05 * noise;
    const off = 44 + i * blockAlign;
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l * 32767))), off);
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r * 32767))), off + 2);
  }

  fs.writeFileSync(file, buffer);
  const mb = (buffer.length / (1024 * 1024)).toFixed(1);
  console.log(`wrote ${file} (${SECONDS}s, ${CHANNELS}ch, ${SAMPLE_RATE} Hz, ${mb} MB)`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
writeVariant(path.join(OUT_DIR, 'latency-a.wav'), { seed: 0x5eed1, f0: 110, f1: 880 });
writeVariant(path.join(OUT_DIR, 'latency-b.wav'), { seed: 0xb0b2, f0: 220, f1: 1760 });
