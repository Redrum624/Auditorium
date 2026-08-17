'use strict';

/**
 * F4 acceptance (integration, REAL models + real onnxruntime): drives the real
 * `transcribeHost.cjs` core, the real pinned six-file model set and the real
 * onnxruntime-node CPU EP over prepared audio, and asserts the things a fake
 * ORT structurally cannot reach.
 *
 * `transcribeHost.test.cjs` names this file as its counterpart, so it has to
 * exist — a header claiming coverage that is nowhere on disk is worse than an
 * admitted gap.
 *
 * ---------------------------------------------------------------------------
 * WHAT ONLY THIS TEST CAN SEE
 * ---------------------------------------------------------------------------
 * 1. **The no-speech signal is real.** `noSpeechProb` is read at the SOT
 *    position of the uncached pass, from a vocabulary whose token is spelled
 *    `<|nocaptions|>` in the model actually pinned here. Both of those were
 *    wrong at one point and BOTH failed silently: every window reported
 *    exactly 0, the silence rule never fired, and 30 s of digital silence
 *    transcribed as the word "you" while a sung recording over a dance band
 *    produced seven fabricated sentences. A unit test with scripted logits
 *    cannot catch either, because it supplies the numbers the bug hides.
 *    Measured on this machine, whisper-base:
 *      digital silence -> noSpeechProb 0.932
 *      spoken control  -> noSpeechProb 0.044
 *    The assertion below is the SEPARATION of those two populations, with a
 *    wide margin, not either figure.
 * 2. **The KV cache is correct against the real graph.** The loop-level
 *    equivalence test (whisperDecode.test.cjs) proves the loop asks for the
 *    right tokens and the fake-ORT tests pin which tensors are fed back, but
 *    only the real merged decoder can show that its `present.*` shapes
 *    actually satisfy the next step's `past_key_values.*`. A cache error here
 *    does not throw — it produces fluent nonsense — so the check is that the
 *    spoken control comes back VERBATIM.
 *
 * ---------------------------------------------------------------------------
 * GATING — never downloads, never silently green
 * ---------------------------------------------------------------------------
 * A plain `npm test` NEVER fetches 323 MB. The bench runs only when the whole
 * pinned set is already in the repo-local cache
 * (`test-assets/models/transcription/`, gitignored) and otherwise REPORTS a
 * skip (`test.skip`, with the reason in the name). `TRANSCRIBE_INTEGRATION=1`
 * makes a missing set a FAILURE rather than a skip — you asked for the full
 * path, so not having it is a real failure.
 *
 * The speech assertions additionally need a spoken fixture at
 * `test-assets/speech16k.wav` (16 kHz mono 16-bit; also gitignored, and not
 * required — the silence assertions carry the no-speech claim on their own).
 *
 * Inference runs in a CHILD process (`scripts/transcribe-bench-driver.cjs`) —
 * the same one-process-per-run shape as the app's utilityProcess arrangement,
 * and required anyway because onnxruntime's tensor type checks need
 * same-realm Float32Arrays, which Jest's vm sandbox cannot provide. This file
 * owns gating, input prep and the assertions; the driver owns the run.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { TRANSCRIBE_FILES, TRANSCRIBE_MODEL_DIR } = require('./transcribeManager.cjs');
const { WHISPER_SAMPLE_RATE } = require('./whisperFeatures.cjs');

const REPO = path.resolve(__dirname, '..');
const MODEL_DIR = path.join(REPO, 'test-assets', TRANSCRIBE_MODEL_DIR);
const OUT_DIR = path.join(REPO, 'test-output');
const DRIVER = path.join(REPO, 'scripts', 'transcribe-bench-driver.cjs');
const SPEECH_WAV = path.join(REPO, 'test-assets', 'speech16k.wav');

const optIn = process.env.TRANSCRIBE_INTEGRATION === '1';

/** Collection-time gate: presence + exact size for EVERY pinned file. The
 * sha256 pins are the manager's job and are verified there; this is only
 * "is the set here at all". */
const modelPaths = Object.fromEntries(
  TRANSCRIBE_FILES.map((f) => [f.key, path.join(MODEL_DIR, f.filename)])
);
const modelsOnDisk = TRANSCRIBE_FILES.every((f) => {
  try {
    return fs.statSync(modelPaths[f.key]).size === f.bytes;
  } catch {
    return false;
  }
});

const benchTest = modelsOnDisk || optIn ? test : test.skip;
const speechTest = (modelsOnDisk || optIn) && fs.existsSync(SPEECH_WAV) ? test : test.skip;

/** Whisper's fixed input: 30 s per window, so a 30 s buffer is exactly one. */
const ONE_WINDOW_SAMPLES = WHISPER_SAMPLE_RATE * 30;

function requireModels() {
  if (!modelsOnDisk) {
    throw new Error(
      `the pinned transcription model set is not in ${MODEL_DIR} — download it in-app ` +
        `(Pipeline -> Transcribe -> Download Models) and copy it there, or unset ` +
        `TRANSCRIBE_INTEGRATION to let this test skip`
    );
  }
}

/** Writes a raw little-endian Float32 mono buffer for the driver. */
function writeF32(name, samples) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, name);
  const buf = Buffer.alloc(samples.length * 4);
  for (let i = 0; i < samples.length; i++) buf.writeFloatLE(samples[i], i * 4);
  fs.writeFileSync(out, buf);
  return out;
}

/** 16 kHz mono 16-bit WAV -> Float32, by the 44-byte canonical header. */
function readWavMono16k(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file} is not a RIFF/WAVE file`);
  }
  const channels = b.readUInt16LE(22);
  const sampleRate = b.readUInt32LE(24);
  const bits = b.readUInt16LE(34);
  if (sampleRate !== WHISPER_SAMPLE_RATE || bits !== 16) {
    throw new Error(`${file} must be ${WHISPER_SAMPLE_RATE} Hz 16-bit (got ${sampleRate} Hz, ${bits}-bit)`);
  }
  const frames = (b.length - 44) / (2 * channels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += b.readInt16LE(44 + (i * channels + c) * 2);
    out[i] = acc / channels / 32768;
  }
  return out;
}

/** Runs the driver and returns its JSON verdict. */
function runBench(name, audioPath, language = 'auto') {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `verdict-${name}.json`);
  const jobPath = path.join(OUT_DIR, `job-${name}.json`);
  fs.writeFileSync(
    jobPath,
    JSON.stringify({ paths: modelPaths, audio: audioPath, language, out: outPath })
  );
  execFileSync(process.execPath, [DRIVER, jobPath], { stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(outPath, 'utf8'));
}

// A run loads ~290 MB of ONNX and decodes 30 s of audio; ~30 s of budget each.
jest.setTimeout(180000);

describe('transcription integration (real models, real onnxruntime)', () => {
  let silence = null;

  benchTest('digital silence reports a HIGH no-speech probability', () => {
    requireModels();
    const audio = writeF32('integration-silence.f32', new Float32Array(ONE_WINDOW_SAMPLES));
    silence = runBench('integration-silence', audio);
    expect(silence.error).toBeNull();
    expect(silence.ok).toBe(true);
    // A segment IS expected here, and its presence is not a bug: openai's rule
    // needs BOTH halves, and digital silence decodes at avgLogprob -0.818,
    // ABOVE the -1.0 threshold. So the window is deliberately NOT skipped and
    // Whisper's classic "you" hallucination survives — matching openai rather
    // than a residual miss. Read this before "fixing" a future change that
    // drives this count to 0: that would mean the LOGPROB half started firing,
    // not that the no-speech half was repaired.
    expect(silence.segments.length).toBeGreaterThan(0);
    expect(silence.maxAvgLogprob).toBeGreaterThan(-1);
    // The no-speech SIGNAL must be alive. Exactly 0 is the fingerprint of both
    // historical bugs (wrong logits row; unresolved token spelling), so the
    // floor is deliberately far from 0 and is the rule's own threshold.
    for (const s of silence.segments) {
      expect(s.noSpeechProb).toBeGreaterThan(0.6);
    }
    console.log(
      `  silence: ${silence.segmentCount} segment(s), noSpeechProb ${silence.maxNoSpeechProb.toFixed(3)}, ` +
        `avgLogprob ${silence.maxAvgLogprob.toFixed(3)}, ${silence.realtimeFactor.toFixed(1)}x realtime`
    );
  });

  speechTest('real speech reports a LOW no-speech probability, and transcribes it', () => {
    requireModels();
    const samples = readWavMono16k(SPEECH_WAV);
    const audio = writeF32('integration-speech.f32', samples);
    const speech = runBench('integration-speech', audio);
    expect(speech.error).toBeNull();
    expect(speech.ok).toBe(true);
    expect(speech.segments.length).toBeGreaterThan(0);
    // THE KV-CACHE PROOF, and it has to be the WORDS.
    //
    // A cache error does not throw — it produces fluent nonsense of about the
    // right length. A broken cache was measured returning "I'm going to be a
    // politician. ." for this clip: seven words, a low no-speech probability,
    // every loose assertion satisfied. So a word COUNT proves nothing here,
    // and neither does "some text came out".
    //
    // The fixture is the public-domain JFK inaugural line and whisper-base
    // transcribes it exactly, so the assertion is the CONTENT. Two distinctive
    // phrases rather than the whole string: punctuation and casing are
    // legitimately model-version-dependent, these words are not.
    const text = speech.segments.map((s) => s.text).join(' ');
    expect(text).toMatch(/ask not what your country can do for you/i);
    expect(text).toMatch(/what you can do for your country/i);
    for (const s of speech.segments) {
      expect(s.noSpeechProb).toBeLessThan(0.6);
    }
    console.log(
      `  speech: ${speech.segmentCount} segment(s), noSpeechProb ${speech.maxNoSpeechProb.toFixed(3)}, ` +
        `avgLogprob ${speech.maxAvgLogprob.toFixed(3)}, ${speech.realtimeFactor.toFixed(1)}x realtime`
    );
    console.log(`  text: ${JSON.stringify(text.slice(0, 120))}`);
    // The separation is the claim, not either absolute figure.
    if (silence) {
      expect(speech.maxNoSpeechProb).toBeLessThan(silence.minNoSpeechProb);
    }
  });

  benchTest('every pinned file is present at its exact pinned size', () => {
    requireModels();
    for (const f of TRANSCRIBE_FILES) {
      expect(fs.statSync(modelPaths[f.key]).size).toBe(f.bytes);
    }
  });
});
