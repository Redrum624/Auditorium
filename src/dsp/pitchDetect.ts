/**
 * YIN fundamental-frequency detector (de Cheveigné & Kawahara 2002, "YIN, a
 * fundamental frequency estimator for speech and music", JASA 111(4):1917–1930).
 *
 * Frame-wise monophonic f0 estimation for the Pitch Correct effect. Per frame:
 *
 *  1. Difference function  d(τ) = Σ_{j=0}^{W−1} (x[j] − x[j+τ])²  over an
 *     integration window of W samples (paper step 2).
 *  2. Cumulative-mean-normalised difference  d′(τ) = d(τ)·τ / Σ_{1..τ} d(j),
 *     with d′(0) = 1 (step 3) — removes the zero-lag bias of autocorrelation.
 *  3. Absolute threshold (step 4): the SMALLEST τ whose d′ dips under
 *     YIN_THRESHOLD, descended to its local minimum. Choosing the smallest
 *     qualifying lag rather than the global minimum is the paper's defence
 *     against subharmonic (octave-down) errors. No qualifying dip ⇒ unvoiced.
 *  4. Parabolic interpolation of d′ around the chosen lag (step 5) for
 *     sub-sample period resolution.
 *
 * Octave errors remain the known failure mode of every periodicity detector
 * (this codebase measured exactly that with its tempo detector); the fixtures in
 * pitchDetect.test.ts measure this detector's behaviour rather than claim
 * immunity. Content whose f0 lies outside [F0_MIN_HZ, F0_MAX_HZ] is out of
 * contract: above-range input aliases to a subharmonic or the range edge,
 * below-range input reads as unvoiced (both pinned in the tests).
 *
 * Pure TS, no DOM — runs in Web Workers like the rest of src/dsp.
 */

/**
 * Lower bound of the f0 search range. E1 = 41.203 Hz (A440 equal temperament,
 * MIDI 28: 440·2^((28−69)/12)) is the lowest string of a standard-tuned
 * 4-string bass — the floor of common melodic material; 40 Hz covers it with
 * margin. Also determines the frame length (see detectPitch).
 */
export const F0_MIN_HZ = 40;

/**
 * Upper bound of the f0 search range. C7 = 2093 Hz sits one octave above
 * soprano high C (C6 = 1046.5 Hz), covering the whole sung range plus
 * headroom for instruments, while keeping τ_min = ⌊44100/2093⌋ = 21 samples —
 * comfortably above the τ ≥ 2 needed for 3-point parabolic interpolation.
 */
export const F0_MAX_HZ = 2093;

/**
 * Absolute threshold on d′ (paper step 4). The paper documents 0.10–0.15 as
 * the useful range; we take the strict end, 0.1 — for pitch CORRECTION a false
 * voiced frame retunes a consonant or breath (the classic pitch-correct artefact),
 * while a false unvoiced frame merely leaves audio untouched. Matches the
 * default in widely-used implementations (e.g. librosa.yin trough_threshold).
 */
export const YIN_THRESHOLD = 0.1;

/**
 * Analysis hop in milliseconds. 10 ms ⇒ a 100 Hz f0-contour sample rate,
 * ≥ 14× the 5–7 Hz singing-vibrato band (Sundberg 1994: vibrato is an f0
 * undulation of 5–7 Hz at about ±1 semitone), so the correction curve resolves
 * vibrato smoothly; it also equals the 10 ms COMPARE/SEARCH granularity
 * wsola.ts already treats as the phase-coherence timescale.
 */
export const HOP_MS = 10;

/**
 * Silence gate: frames whose RMS is below one LSB of 16-bit PCM (2^−15) are
 * indistinguishable from digital silence in the most common source format and
 * are reported unvoiced without analysis. This is a floor, NOT a noise gate —
 * audible noise floors are rejected by the periodicity threshold instead.
 */
export const SILENCE_RMS = 2 ** -15;

/** onProgress fires once every this many analysis frames (UI granularity only). */
const PROGRESS_FRAME_BATCH = 16;

export interface PitchFrame {
  /** Estimated fundamental in Hz, or null when the frame is unvoiced/silent. */
  f0Hz: number | null;
  /** 1 − d′(τ̂): > 1 − YIN_THRESHOLD when voiced by construction; 0 when unvoiced. */
  confidence: number;
}

export interface PitchTrack {
  /** Frame k analyses samples [k·hopSamples, k·hopSamples + frameSamples) and its
   * estimate is attributed to the frame CENTRE, k·hopSamples + frameSamples/2. */
  frames: PitchFrame[];
  hopSamples: number;
  frameSamples: number;
}

/**
 * Analyses one frame starting at `s`. `d` and `dp` are caller-owned scratch
 * buffers of length tauMax+1 (reused across frames to avoid per-frame GC).
 */
function analyzeFrame(
  x: Float32Array,
  s: number,
  W: number,
  tauMin: number,
  tauMax: number,
  sampleRate: number,
  d: Float64Array,
  dp: Float64Array
): PitchFrame {
  // Silence gate over the full analysed span [s, s + 2W).
  const span = 2 * W;
  let energy = 0;
  for (let j = 0; j < span; j++) {
    const v = x[s + j];
    energy += v * v;
  }
  const rms = Math.sqrt(energy / span);
  if (rms < SILENCE_RMS) return { f0Hz: null, confidence: 0 };

  // Steps 1–2: difference function. τ ∈ [1, tauMax]; j+τ ≤ W−1+tauMax = span−1.
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    const b = s + tau;
    for (let j = 0; j < W; j++) {
      const diff = x[s + j] - x[b + j];
      sum += diff * diff;
    }
    d[tau] = sum;
  }

  // Step 3: cumulative-mean-normalised difference. A zero cumulative sum means
  // d ≡ 0 so far (e.g. a constant/DC frame): define d′ = 1 (aperiodic), which
  // can never cross the threshold — such frames read as unvoiced.
  dp[0] = 1;
  let cumsum = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    cumsum += d[tau];
    dp[tau] = cumsum > 0 ? (d[tau] * tau) / cumsum : 1;
  }

  // Step 4: smallest τ under the absolute threshold, descended to its local minimum.
  let tauEst = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (dp[tau] < YIN_THRESHOLD) {
      let t = tau;
      while (t + 1 <= tauMax && dp[t + 1] < dp[t]) t++;
      tauEst = t;
      break;
    }
  }
  if (tauEst < 0) return { f0Hz: null, confidence: 0 };

  // Step 5: parabolic interpolation of d′ around τ̂ for sub-sample resolution.
  // At a discrete local minimum the curvature (denom) is positive; a flat or
  // degenerate neighbourhood (denom ≤ 0) skips refinement. |δ| ≤ 0.5 always
  // holds for a true local minimum; the clamp guards float pathology.
  let tauRefined = tauEst;
  if (tauEst > 1 && tauEst < tauMax) {
    const y0 = dp[tauEst - 1];
    const y1 = dp[tauEst];
    const y2 = dp[tauEst + 1];
    const denom = y0 - 2 * y1 + y2;
    if (denom > 0) {
      let delta = (0.5 * (y0 - y2)) / denom;
      if (delta > 0.5) delta = 0.5;
      else if (delta < -0.5) delta = -0.5;
      tauRefined = tauEst + delta;
    }
  }

  return { f0Hz: sampleRate / tauRefined, confidence: 1 - dp[tauEst] };
}

/**
 * Frame-wise YIN f0 estimation over `signal`.
 *
 * Frame geometry: τ_max = ⌈sr/F0_MIN_HZ⌉ is the longest searched period; the
 * integration window W = τ_max is the minimum that spans one full period of
 * the lowest detectable f0, and the frame must additionally reach x[j+τ_max],
 * so frameSamples = 2·τ_max (≈ 50 ms at 44.1 kHz). Inputs shorter than one
 * frame yield zero frames.
 */
export function detectPitch(
  signal: Float32Array,
  sampleRate: number,
  onProgress?: (fraction: number) => void
): PitchTrack {
  const tauMax = Math.ceil(sampleRate / F0_MIN_HZ);
  const tauMin = Math.max(2, Math.floor(sampleRate / F0_MAX_HZ));
  const W = tauMax;
  const frameSamples = 2 * tauMax;
  const hopSamples = Math.max(1, Math.round((HOP_MS / 1000) * sampleRate));
  const N = signal.length;

  const frameCount = N >= frameSamples ? Math.floor((N - frameSamples) / hopSamples) + 1 : 0;
  const frames: PitchFrame[] = [];
  const d = new Float64Array(tauMax + 1);
  const dp = new Float64Array(tauMax + 1);

  for (let k = 0; k < frameCount; k++) {
    frames.push(analyzeFrame(signal, k * hopSamples, W, tauMin, tauMax, sampleRate, d, dp));
    if (onProgress && k % PROGRESS_FRAME_BATCH === 0) {
      onProgress(Math.min(0.99, k / frameCount));
    }
  }

  onProgress?.(1);
  return { frames, hopSamples, frameSamples };
}
