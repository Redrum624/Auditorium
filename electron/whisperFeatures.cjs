'use strict';

/**
 * Feature extraction for the transcription feature (F4) — pure math over
 * typed arrays, no onnxruntime, no electron — mirroring the role
 * stemSegmentation.cjs plays for stem separation: a faithful port of the
 * reference feature pipelines, verifiable by fast unit tests and consumed by
 * the utility-process host (transcribeHost.cjs) and the integration bench.
 *
 * Two independent pipelines live here because the two models expect
 * different front ends:
 *
 * 1. Whisper log-mel spectrogram — ported from openai/whisper `audio.py`
 *    (MIT) as reimplemented by transformers' WhisperFeatureExtractor:
 *      - 16 kHz mono input, N_FFT 400, hop 160, periodic Hann window,
 *        centred STFT with reflect padding, LAST FRAME DROPPED
 *        (`stft[..., :-1]` in the reference), power spectrum
 *      - 80 slaney-scale, slaney-normalised mel filters over 0–8000 Hz
 *        (librosa `filters.mel(sr=16000, n_fft=400, n_mels=80)` defaults —
 *        Whisper ships these very filters as `mel_filters.npz`)
 *      - log10 with 1e-10 floor, clamped to (max − 8), then (x + 4) / 4
 *    Every constant below is that reference's, not a choice of ours.
 *
 * 2. Kaldi-style log-mel filterbank ("fbank") for the WeSpeaker CAM++
 *    speaker-embedding model — ported from torchaudio
 *    `compliance.kaldi.fbank` with WeSpeaker's own call parameters
 *    (`wespeaker/bin/infer_onnx.py`: num_mel_bins=80, frame_length=25,
 *    frame_shift=10, dither=0, sample_frequency=16000, all else default):
 *      - snip_edges framing (400-sample frames, 160 hop, no padding),
 *        per-frame DC removal, pre-emphasis 0.97, POVEY window
 *        (hann^0.85), zero-pad to 512 (round_to_power_of_two), power
 *        spectrum
 *      - 80 HTK-mel triangular bins over 20 Hz–Nyquist, weights computed in
 *        MEL space (Kaldi's formulation), NO area normalisation
 *      - natural log with torchaudio's 1.1921e-7 floor
 *    and NO cepstral mean subtraction — see kaldiFbank's doc comment for
 *    the measurement that settled it.
 *
 * The FFT is the repo's own radix-2 (src/dsp/fft.ts) reimplemented in CJS —
 * kept private here rather than imported because electron/ modules cannot
 * load TS, and the renderer must never load electron/ modules.
 */

// --- Whisper constants (openai/whisper audio.py) ---------------------------
const WHISPER_SAMPLE_RATE = 16000;
const WHISPER_N_FFT = 400;
const WHISPER_HOP = 160;
const WHISPER_N_MELS = 80;
const WHISPER_CHUNK_SECONDS = 30;
const WHISPER_CHUNK_SAMPLES = WHISPER_SAMPLE_RATE * WHISPER_CHUNK_SECONDS; // 480000
const WHISPER_FRAMES_PER_CHUNK = WHISPER_CHUNK_SAMPLES / WHISPER_HOP; // 3000
/** Samples of audio covered by one Whisper timestamp step (0.02 s). */
const WHISPER_SAMPLES_PER_TOKEN = WHISPER_HOP * 2; // 320

// --- Kaldi fbank constants (torchaudio.compliance.kaldi defaults +
// WeSpeaker's fbank() call) -------------------------------------------------
const FBANK_SAMPLE_RATE = 16000;
const FBANK_FRAME_SAMPLES = 400; // 25 ms
const FBANK_SHIFT_SAMPLES = 160; // 10 ms
const FBANK_BINS = 80;
const FBANK_PADDED_FFT = 512; // round_to_power_of_two(400)
const FBANK_PREEMPHASIS = 0.97;
const FBANK_LOW_FREQ = 20;
const FBANK_HIGH_FREQ = FBANK_SAMPLE_RATE / 2;
/** torchaudio compliance.kaldi EPSILON (float32 machine epsilon). */
const FBANK_LOG_FLOOR = 1.1920928955078125e-7;

// ---------------------------------------------------------------------------
// Radix-2 complex FFT (iterative Cooley–Tukey), same algorithm as
// src/dsp/fft.ts. Sizes here are 512 (fbank) and 512 for Whisper's 400-point
// STFT? No — Whisper uses n_fft=400 exactly, which is NOT a power of two, so
// the Whisper path uses the Bluestein transform below built on this FFT.
// ---------------------------------------------------------------------------

function fftRadix2(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error(`fftRadix2: length ${n} is not a power of two`);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const eRe = re[i + k];
        const eIm = im[i + k];
        const oRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const oIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = eRe + oRe;
        im[i + k] = eIm + oIm;
        re[i + k + len / 2] = eRe - oRe;
        im[i + k + len / 2] = eIm - oIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

/**
 * Bluestein (chirp-z) DFT for arbitrary length n, built on the radix-2 FFT.
 * Whisper's STFT is a 400-point DFT — torch.stft computes the exact DFT, so
 * an approximation (e.g. zero-padding to 512) would NOT reproduce the
 * reference spectrogram. Returns {re, im} of length n.
 */
function createBluestein(n) {
  let m = 1;
  while (m < 2 * n + 1) m <<= 1;
  const cosT = new Float64Array(n);
  const sinT = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // angle = pi * i^2 / n, i^2 computed mod 2n to stay in double precision
    const j = (i * i) % (2 * n);
    const ang = (Math.PI * j) / n;
    cosT[i] = Math.cos(ang);
    sinT[i] = Math.sin(ang);
  }
  // Precompute FFT of the chirp filter b.
  const bRe = new Float64Array(m);
  const bIm = new Float64Array(m);
  bRe[0] = cosT[0];
  bIm[0] = sinT[0];
  for (let i = 1; i < n; i++) {
    bRe[i] = bRe[m - i] = cosT[i];
    bIm[i] = bIm[m - i] = sinT[i];
  }
  fftRadix2(bRe, bIm);
  return { n, m, cosT, sinT, bRe, bIm };
}

/** In: real signal x (length n). Out: {re, im} DFT of length n. */
function bluesteinDft(plan, x) {
  const { n, m, cosT, sinT, bRe, bIm } = plan;
  const aRe = new Float64Array(m);
  const aIm = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    aRe[i] = x[i] * cosT[i];
    aIm[i] = -x[i] * sinT[i];
  }
  fftRadix2(aRe, aIm);
  for (let i = 0; i < m; i++) {
    const tRe = aRe[i] * bRe[i] - aIm[i] * bIm[i];
    aIm[i] = aRe[i] * bIm[i] + aIm[i] * bRe[i];
    aRe[i] = tRe;
  }
  // inverse FFT via conjugation
  for (let i = 0; i < m; i++) aIm[i] = -aIm[i];
  fftRadix2(aRe, aIm);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const rRe = aRe[i] / m;
    const rIm = -aIm[i] / m;
    re[i] = rRe * cosT[i] + rIm * sinT[i];
    im[i] = rIm * cosT[i] - rRe * sinT[i];
  }
  return { re, im };
}

// ---------------------------------------------------------------------------
// Whisper log-mel spectrogram
// ---------------------------------------------------------------------------

/** Periodic Hann window (torch.hann_window default, periodic=True). */
function hannPeriodic(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}

/** librosa hz_to_mel, htk=False (slaney). */
function hzToMelSlaney(hz) {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logstep = Math.log(6.4) / 27;
  return hz < minLogHz ? hz / fSp : minLogMel + Math.log(hz / minLogHz) / logstep;
}

/** librosa mel_to_hz, htk=False (slaney). */
function melToHzSlaney(mel) {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logstep = Math.log(6.4) / 27;
  return mel < minLogMel ? mel * fSp : minLogHz * Math.exp(logstep * (mel - minLogMel));
}

/**
 * librosa `filters.mel(sr, n_fft, n_mels, fmin=0, fmax=sr/2, htk=False,
 * norm='slaney')` — the exact filterbank Whisper ships in mel_filters.npz.
 * Returns Float64Array[n_mels], each of length n_fft/2+1.
 */
function whisperMelFilterbank(
  sr = WHISPER_SAMPLE_RATE,
  nFft = WHISPER_N_FFT,
  nMels = WHISPER_N_MELS
) {
  const nBins = Math.floor(nFft / 2) + 1;
  const fftFreqs = new Float64Array(nBins);
  for (let k = 0; k < nBins; k++) fftFreqs[k] = (k * sr) / nFft;
  const melMin = hzToMelSlaney(0);
  const melMax = hzToMelSlaney(sr / 2);
  const melPts = new Float64Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) {
    melPts[i] = melToHzSlaney(melMin + ((melMax - melMin) * i) / (nMels + 1));
  }
  const weights = [];
  for (let i = 0; i < nMels; i++) {
    const row = new Float64Array(nBins);
    const lower = melPts[i];
    const center = melPts[i + 1];
    const upper = melPts[i + 2];
    const enorm = 2 / (upper - lower); // slaney area normalisation
    for (let k = 0; k < nBins; k++) {
      const f = fftFreqs[k];
      const up = (f - lower) / (center - lower);
      const down = (upper - f) / (upper - center);
      const w = Math.min(up, down);
      row[k] = w > 0 ? w * enorm : 0;
    }
    weights.push(row);
  }
  return weights;
}

/**
 * Whisper log-mel spectrogram of ONE 30-second window.
 *
 * `samples` — Float32Array of EXACTLY WHISPER_CHUNK_SAMPLES 16 kHz mono
 * samples (the caller zero-pads the tail window; whisper pads to 30 s before
 * the STFT, and the per-window max-8 clamp depends on that padding, so the
 * padding cannot be an internal detail here).
 *
 * Returns Float32Array of N_MELS * FRAMES_PER_CHUNK values, mel-major
 * (mel m, frame t at m * FRAMES_PER_CHUNK + t) — the [1, 80, 3000] layout
 * the encoder's `input_features` expects.
 */
function whisperLogMel(samples, state) {
  if (samples.length !== WHISPER_CHUNK_SAMPLES) {
    throw new Error(
      `whisperLogMel: expected exactly ${WHISPER_CHUNK_SAMPLES} samples (zero-pad the tail window), got ${samples.length}`
    );
  }
  const st = state || createWhisperMelState();
  const { window, filters, plan } = st;
  const half = WHISPER_N_FFT / 2; // 200 — centre padding (reflect)
  const nBins = half + 1;
  // Reference drops the final STFT frame: frames = len/hop (3000), not +1.
  const nFrames = WHISPER_FRAMES_PER_CHUNK;
  const power = new Float64Array(nBins);
  const mel = new Float64Array(WHISPER_N_MELS * nFrames);
  const frame = new Float64Array(WHISPER_N_FFT);
  let maxLog = -Infinity;
  for (let t = 0; t < nFrames; t++) {
    const centerIdx = t * WHISPER_HOP;
    for (let i = 0; i < WHISPER_N_FFT; i++) {
      let idx = centerIdx - half + i;
      // reflect padding (torch.stft pad_mode='reflect'): index -k -> k,
      // index len-1+k -> len-1-k
      if (idx < 0) idx = -idx;
      else if (idx >= samples.length) idx = 2 * samples.length - 2 - idx;
      frame[i] = samples[idx] * window[i];
    }
    const { re, im } = bluesteinDft(plan, frame);
    for (let k = 0; k < nBins; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    for (let m = 0; m < WHISPER_N_MELS; m++) {
      const row = filters[m];
      let acc = 0;
      for (let k = 0; k < nBins; k++) acc += row[k] * power[k];
      const lg = Math.log10(Math.max(acc, 1e-10));
      mel[m * nFrames + t] = lg;
      if (lg > maxLog) maxLog = lg;
    }
  }
  const out = new Float32Array(WHISPER_N_MELS * nFrames);
  const floor = maxLog - 8;
  for (let i = 0; i < mel.length; i++) {
    out[i] = (Math.max(mel[i], floor) + 4) / 4;
  }
  return out;
}

/** Precomputed window/filterbank/FFT plan, reusable across windows. */
function createWhisperMelState() {
  return {
    window: hannPeriodic(WHISPER_N_FFT),
    filters: whisperMelFilterbank(),
    plan: createBluestein(WHISPER_N_FFT),
  };
}

// ---------------------------------------------------------------------------
// Kaldi fbank for WeSpeaker CAM++
// ---------------------------------------------------------------------------

/** HTK mel scale (Kaldi's MelScale): 1127 * ln(1 + f/700). */
function hzToMelHtk(hz) {
  return 1127 * Math.log(1 + hz / 700);
}

/** Povey window: hann(symmetric)^0.85 — Kaldi's default window. */
function poveyWindow(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)), 0.85);
  }
  return w;
}

/**
 * Kaldi mel banks (MelBanks::MelBanks): `FBANK_BINS` triangular filters with
 * weights computed in MEL space over the padded-FFT bin frequencies, spread
 * over [low_freq, high_freq], NO area normalisation. Returns rows of length
 * FBANK_PADDED_FFT/2+1.
 */
function kaldiMelBanks() {
  const nBins = FBANK_PADDED_FFT / 2 + 1;
  const melLow = hzToMelHtk(FBANK_LOW_FREQ);
  const melHigh = hzToMelHtk(FBANK_HIGH_FREQ);
  const melDelta = (melHigh - melLow) / (FBANK_BINS + 1);
  const rows = [];
  for (let b = 0; b < FBANK_BINS; b++) {
    const left = melLow + b * melDelta;
    const center = left + melDelta;
    const right = center + melDelta;
    const row = new Float64Array(nBins);
    for (let k = 0; k < nBins; k++) {
      const mel = hzToMelHtk((k * FBANK_SAMPLE_RATE) / FBANK_PADDED_FFT);
      if (mel > left && mel < right) {
        row[k] = mel <= center ? (mel - left) / melDelta : (right - mel) / melDelta;
      }
    }
    rows.push(row);
  }
  return rows;
}

/** Kaldi waveforms are int16-scaled: WeSpeaker's dataset processor runs
 * `waveform = waveform * (1 << 15)` before torchaudio's kaldi fbank. The
 * scale is NOT cosmetic — log + CMN would cancel a pure gain, but the
 * FBANK_LOG_FLOOR clamp is applied BEFORE CMN, and at unit scale most
 * low-energy bins fall below the floor and clamp, which distorts the
 * features per-recording. Measured on the F4 bench (sr-data speaker pairs):
 * at unit scale same-speaker cross-file cosine collapsed to 0.14; at int16
 * scale the pairs separate correctly. */
const KALDI_WAVEFORM_SCALE = 1 << 15;

/**
 * Kaldi-compatible log-mel filterbank features. `samples` — 16 kHz mono
 * Float32Array in the app's [-1, 1] range (the int16 kaldi scaling above is
 * applied internally; the model's own metadata pins `normalize_samples: 0`,
 * sherpa-onnx's flag for "feed kaldi's int16 scale").
 *
 * NO cepstral mean subtraction — measured, not assumed: this CAM++ export
 * discriminates sr-data's speakers on raw fbank (same-speaker cosine 0.650
 * vs cross-speaker 0.397/0.169) and COLLAPSES when CMN is applied
 * (same-speaker 0.138), so the export evidently bakes its own input
 * statistics in. The features were verified bit-for-bit against
 * torchaudio.compliance.kaldi.fbank (max |diff| 1.9e-4 over 778 frames)
 * before that comparison, so the CMN finding is about the model, not a
 * feature bug.
 *
 * Returns { frames, data } where `data` is Float32Array frames*FBANK_BINS,
 * frame-major (frame t, bin b at t * FBANK_BINS + b) — the [1, T, 80]
 * layout CAM++ expects. Returns frames = 0 for input shorter than one
 * 25 ms frame (snip_edges drops partial frames).
 */
function kaldiFbank(samples, state) {
  const st = state || createFbankState();
  const { window, banks } = st;
  if (samples.length < FBANK_FRAME_SAMPLES) return { frames: 0, data: new Float32Array(0) };
  const nFrames = 1 + Math.floor((samples.length - FBANK_FRAME_SAMPLES) / FBANK_SHIFT_SAMPLES);
  const nBins = FBANK_PADDED_FFT / 2 + 1;
  const data = new Float32Array(nFrames * FBANK_BINS);
  const re = new Float64Array(FBANK_PADDED_FFT);
  const im = new Float64Array(FBANK_PADDED_FFT);
  const frame = new Float64Array(FBANK_FRAME_SAMPLES);
  const power = new Float64Array(nBins);
  for (let t = 0; t < nFrames; t++) {
    const off = t * FBANK_SHIFT_SAMPLES;
    // DC removal (remove_dc_offset=True), at kaldi's int16 scale
    let mean = 0;
    for (let i = 0; i < FBANK_FRAME_SAMPLES; i++) mean += samples[off + i];
    mean /= FBANK_FRAME_SAMPLES;
    for (let i = 0; i < FBANK_FRAME_SAMPLES; i++) {
      frame[i] = (samples[off + i] - mean) * KALDI_WAVEFORM_SCALE;
    }
    // Pre-emphasis 0.97 (Kaldi: first sample subtracts itself), applied
    // BACKWARDS so each subtraction reads the un-emphasised neighbour.
    for (let i = FBANK_FRAME_SAMPLES - 1; i > 0; i--) {
      frame[i] -= FBANK_PREEMPHASIS * frame[i - 1];
    }
    frame[0] -= FBANK_PREEMPHASIS * frame[0];
    // Window, zero-pad to 512, power spectrum.
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < FBANK_FRAME_SAMPLES; i++) re[i] = frame[i] * window[i];
    fftRadix2(re, im);
    for (let k = 0; k < nBins; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    for (let b = 0; b < FBANK_BINS; b++) {
      const row = banks[b];
      let acc = 0;
      for (let k = 0; k < nBins; k++) acc += row[k] * power[k];
      data[t * FBANK_BINS + b] = Math.log(Math.max(acc, FBANK_LOG_FLOOR));
    }
  }
  return { frames: nFrames, data };
}

/** Precomputed window + mel banks, reusable across segments. */
function createFbankState() {
  return { window: poveyWindow(FBANK_FRAME_SAMPLES), banks: kaldiMelBanks() };
}

module.exports = {
  WHISPER_SAMPLE_RATE,
  WHISPER_N_FFT,
  WHISPER_HOP,
  WHISPER_N_MELS,
  WHISPER_CHUNK_SECONDS,
  WHISPER_CHUNK_SAMPLES,
  WHISPER_FRAMES_PER_CHUNK,
  WHISPER_SAMPLES_PER_TOKEN,
  FBANK_SAMPLE_RATE,
  FBANK_FRAME_SAMPLES,
  FBANK_SHIFT_SAMPLES,
  FBANK_BINS,
  FBANK_PADDED_FFT,
  FBANK_LOG_FLOOR,
  fftRadix2,
  createBluestein,
  bluesteinDft,
  hannPeriodic,
  hzToMelSlaney,
  melToHzSlaney,
  whisperMelFilterbank,
  whisperLogMel,
  createWhisperMelState,
  hzToMelHtk,
  poveyWindow,
  kaldiMelBanks,
  kaldiFbank,
  createFbankState,
};
