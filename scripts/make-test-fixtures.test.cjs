'use strict';

// Pins the two v1.5 smoke fixtures' generators (Task T16). The generated WAVs
// themselves are never committed (test-assets/ is gitignored) — the SMOKE
// shells these scripts on demand, so what must stay true is that each one
// emits a container the app can actually decode, at the exact length its
// tempo/remix assertions assume.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ASSETS = path.resolve(__dirname, '..', 'test-assets');
const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2; // 16-bit

/** Runs a generator script and parses the 44-byte RIFF/WAVE header it wrote. */
function generate(script, outName) {
  execFileSync(process.execPath, [path.join(__dirname, script)], { stdio: 'pipe' });
  const file = path.join(ASSETS, outName);
  const buf = fs.readFileSync(file);
  return {
    buf,
    riff: buf.toString('ascii', 0, 4),
    riffSize: buf.readUInt32LE(4),
    wave: buf.toString('ascii', 8, 12),
    fmtId: buf.toString('ascii', 12, 16),
    fmtSize: buf.readUInt32LE(16),
    audioFormat: buf.readUInt16LE(20),
    channels: buf.readUInt16LE(22),
    sampleRate: buf.readUInt32LE(24),
    byteRate: buf.readUInt32LE(28),
    blockAlign: buf.readUInt16LE(32),
    bitsPerSample: buf.readUInt16LE(34),
    dataId: buf.toString('ascii', 36, 40),
    dataSize: buf.readUInt32LE(40),
  };
}

/** Left-channel sample `i`, as a float in [-1, 1). Out-of-range reads are
 * silence, so the detector below can scan from sample 0 without a special
 * case for the first click. */
function sampleAt(buf, i) {
  const frames = (buf.length - 44) / (CHANNELS * BYTES_PER_SAMPLE);
  if (i < 0 || i >= frames) return 0;
  return buf.readInt16LE(44 + i * CHANNELS * BYTES_PER_SAMPLE) / 32768;
}

/**
 * CAUSAL second difference `x[i] - 2x[i-1] + x[i-2]` — a one-line high-pass
 * that isolates the click layer from the tonal bed underneath it. The bed is
 * a sum of sinusoids at 220-392 Hz, which this attenuates by roughly 60 dB
 * (`(2 sin(pi f / sr))^2` is ~1e-3 at 220 Hz), while the click's broadband
 * noise passes at roughly unity. Causal, not centred, so the response begins
 * exactly AT the onset sample rather than one sample before it — which is
 * what makes an exact-index assertion meaningful.
 */
function highPass(buf, i) {
  return sampleAt(buf, i) - 2 * sampleAt(buf, i - 1) + sampleAt(buf, i - 2);
}

/** The first index in `[expected - SEARCH, expected + SEARCH]` whose
 * high-passed magnitude clears `floor` — i.e. where the burst begins. */
function findOnset(buf, expected, floor, search = 512) {
  for (let i = Math.max(0, expected - search); i <= expected + search; i++) {
    if (Math.abs(highPass(buf, i)) > floor) return i;
  }
  return -1;
}

/** Largest high-passed magnitude in a click-free stretch (well after beat 0's
 * burst has decayed, well before beat 1's), measured from the file itself
 * rather than assumed, so the detection floor is derived, not invented. */
function clickFreeFloor(buf) {
  let max = 0;
  for (let i = 3000; i < 20000; i++) max = Math.max(max, Math.abs(highPass(buf, i)));
  return max;
}

function expectValidHeader(wav, seconds) {
  expect(wav.riff).toBe('RIFF');
  expect(wav.wave).toBe('WAVE');
  expect(wav.fmtId).toBe('fmt ');
  expect(wav.fmtSize).toBe(16);
  expect(wav.audioFormat).toBe(1); // PCM
  expect(wav.channels).toBe(CHANNELS);
  expect(wav.sampleRate).toBe(SAMPLE_RATE);
  expect(wav.bitsPerSample).toBe(BYTES_PER_SAMPLE * 8);
  expect(wav.blockAlign).toBe(CHANNELS * BYTES_PER_SAMPLE);
  expect(wav.byteRate).toBe(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE);
  expect(wav.dataId).toBe('data');

  // The data chunk is EXACTLY seconds * rate * channels * bytesPerSample —
  // the smoke asserts an integer stretched length off this, so a partial
  // frame anywhere would move the target.
  const expectedData = seconds * SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
  expect(wav.dataSize).toBe(expectedData);
  expect(wav.buf.length).toBe(44 + expectedData);
  expect(wav.riffSize).toBe(wav.buf.length - 8);
}

describe('make-test-beat.cjs', () => {
  let wav;
  beforeAll(() => {
    wav = generate('make-test-beat.cjs', 'beat120.wav');
  }, 60000);

  test('emits an 8 s 44100 Hz 16-bit stereo RIFF/WAVE file', () => {
    expectValidHeader(wav, 8);
  });

  test('places all 16 click onsets at exact multiples of 22050 samples', () => {
    // 8 s at 120 BPM is 16 beats — the count the smoke's beatCount assertion
    // is derived from.
    const floor = Math.max(clickFreeFloor(wav.buf) * 4, 1e-3);
    for (let beat = 0; beat < 16; beat++) {
      expect(findOnset(wav.buf, beat * 22050, floor)).toBe(beat * 22050);
    }
  });

  test('is deterministic — a second run produces identical bytes', () => {
    const again = generate('make-test-beat.cjs', 'beat120.wav');
    expect(again.buf.equals(wav.buf)).toBe(true);
  }, 60000);
});

describe('make-test-abab.cjs', () => {
  let wav;
  beforeAll(() => {
    wav = generate('make-test-abab.cjs', 'abab120.wav');
  }, 120000);

  test('emits a 64 s 44100 Hz 16-bit stereo RIFF/WAVE file', () => {
    expectValidHeader(wav, 64);
  });

  test('places the first 8 click onsets at exact multiples of 22050 samples', () => {
    // 120 BPM at 44100 Hz = 22050 samples per beat. This SCANS a +/-512-sample
    // band around each expected position for the burst onset rather than
    // merely probing the index itself, so a click placed near — but not on —
    // the beat fails. The bar grid the remix splices on is derived from these
    // positions, so a drifting generator would quietly invalidate every
    // structural assertion downstream.
    const floor = clickFreeFloor(wav.buf) * 4;
    expect(floor).toBeLessThan(0.01); // the bed really is suppressed
    for (let beat = 0; beat < 8; beat++) {
      expect(findOnset(wav.buf, beat * 22050, floor)).toBe(beat * 22050);
    }
  });

  test('A and B sections differ — the 16 s boundary is a real content change', () => {
    // Section A is A3+E4, section B is C4+G4 with a 3rd-harmonic edge: two
    // bars either side of the 16 s boundary must not be interchangeable, or
    // the clusterer has nothing to separate.
    const bar = 2 * SAMPLE_RATE; // 2 s per bar at 120 BPM 4/4
    let diff = 0;
    for (let i = 0; i < bar; i++) {
      // Compare bar 6 (inside A) against bar 14 (inside B).
      diff += Math.abs(sampleAt(wav.buf, 6 * bar + i) - sampleAt(wav.buf, 14 * bar + i));
    }
    expect(diff / bar).toBeGreaterThan(0.05);
  });
});

// F4b: the transcription transport fixture. Its ONLY job is to be longer than
// one IPC audio slice, so the assertions below are about length and
// decodability, not content.
describe('make-test-long.cjs', () => {
  /** electron/transcribeManager.cjs AUDIO_SLICE_SAMPLES, restated here rather
   * than imported: the point of the fixture is to outlast that constant, so a
   * silent change to it must break this test. */
  const AUDIO_SLICE_SAMPLES = 1 << 20;
  const WHISPER_SAMPLE_RATE = 16000;

  it('writes a decodable mono 44100 Hz 16-bit WAV', () => {
    const h = generate('make-test-long.cjs', 'long70.wav');
    expect(h.riff).toBe('RIFF');
    expect(h.wave).toBe('WAVE');
    expect(h.audioFormat).toBe(1);
    expect(h.channels).toBe(1);
    expect(h.sampleRate).toBe(SAMPLE_RATE);
    expect(h.bitsPerSample).toBe(16);
    expect(h.riffSize).toBe(h.buf.length - 8);
    expect(h.dataSize).toBe(h.buf.length - 44);
  });

  it('is long enough to force MORE THAN ONE audio slice over IPC', () => {
    const h = generate('make-test-long.cjs', 'long70.wav');
    const frames = h.dataSize / (h.channels * (h.bitsPerSample / 8));
    const modelSamples = Math.round((frames * WHISPER_SAMPLE_RATE) / h.sampleRate);
    expect(modelSamples).toBeGreaterThan(AUDIO_SLICE_SAMPLES);
    expect(Math.ceil(modelSamples / AUDIO_SLICE_SAMPLES)).toBe(2);
  });

  it('leaves a SHORT final slice rather than an even split', () => {
    const h = generate('make-test-long.cjs', 'long70.wav');
    const frames = h.dataSize / (h.channels * (h.bitsPerSample / 8));
    const modelSamples = Math.round((frames * WHISPER_SAMPLE_RATE) / h.sampleRate);
    const tail = modelSamples % AUDIO_SLICE_SAMPLES;
    expect(tail).toBeGreaterThan(0);
    expect(tail).toBeLessThan(AUDIO_SLICE_SAMPLES);
  });

  it('carries real signal, not silence', () => {
    const h = generate('make-test-long.cjs', 'long70.wav');
    let peak = 0;
    for (let i = 44; i + 1 < h.buf.length; i += 2) {
      peak = Math.max(peak, Math.abs(h.buf.readInt16LE(i)));
    }
    expect(peak).toBeGreaterThan(0.2 * 32767);
  });

  it('writes a stereo twin whose every frame duplicates the mono sample', () => {
    // The align+splice smoke step's degraded path opens the twin (the fake-mic
    // replacement take is stereo and the splice refuses a channel-count
    // mismatch). What it depends on is that the twin's mono downmix IS the
    // mono fixture's signal — so the aligner places words identically on both.
    const mono = generate('make-test-long.cjs', 'long70.wav');
    const st = generate('make-test-long.cjs', 'long70-stereo.wav');
    expect(st.audioFormat).toBe(1);
    expect(st.channels).toBe(2);
    expect(st.sampleRate).toBe(SAMPLE_RATE);
    expect(st.bitsPerSample).toBe(16);
    expect(st.riffSize).toBe(st.buf.length - 8);
    expect(st.dataSize).toBe(st.buf.length - 44);
    const monoFrames = mono.dataSize / 2;
    expect(st.dataSize).toBe(monoFrames * 4);
    let mismatches = 0;
    for (let i = 0; i < monoFrames; i++) {
      const m = mono.buf.readInt16LE(44 + i * 2);
      if (st.buf.readInt16LE(44 + i * 4) !== m || st.buf.readInt16LE(44 + i * 4 + 2) !== m) {
        mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  });
});
