/**
 * Task F10 — the measurements the Cover Chain matches a new take to an original.
 *
 * The chain's hard step sounds like blind reverse-engineering of a plugin chain:
 * "work out what was done to the voice in the finished mix". It is not, because
 * separation hands over the PROCESSED ORIGINAL VOCAL AS A SIGNAL. So it becomes
 * matching against a reference, and this module defines the four quantities that
 * matching needs — and, as importantly, records which of them the measurements
 * said were worth having.
 *
 * Every constant below traces to a measurement on the reference material
 * (`test-assets/long-real-take.wav` as the take, the separated vocal of
 * the reference song as the reference), reported in
 * `.superpowers/sdd/task-F10-analysis-report.md`. Those measurements had a
 * ground truth available that a user will not have: the official instrumental
 * release of the same song is on disk, so `mix - g * instrumental` IS the
 * original vocal, and every claim about what separation does to the reference
 * was checked against it rather than assumed.
 *
 * Pure TS, no DOM, no Electron — it runs in the renderer or in a worker.
 */

import { toDb } from './chainAnalysis';
import { envelopeFollower, maxAcrossChannels } from './envelope';
import { fft } from './fft';
import { hann } from './windows';

// ── What counts as "sounding" ───────────────────────────────────────────────

/**
 * The detector the app's compressor already uses (`CompressorEffect`'s own 10 ms
 * attack / 100 ms release defaults), which is also what `deriveCompressor`
 * measures its threshold from. Reused rather than re-chosen so the two stages
 * describe the same envelope.
 */
export const DETECTOR_ATTACK_MS = 10;
export const DETECTOR_RELEASE_MS = 100;

/**
 * Active = the detector envelope within this many dB of the signal's OWN 95th
 * percentile. Relative, not absolute, and that is the whole point.
 *
 * `deriveCompressor` calls a sample active when it is above the loudest the
 * Remove-Silence detector reads inside the quietest 500 ms — the recording's own
 * noise floor. That is right for one recording and WRONG for comparing two,
 * which is what a match does: measured here, the take's floor sits at
 * -50.4 dBFS and the separated original vocal's at -78.1 dBFS, because the
 * separation model outputs near-silence where nobody is singing. A floor-derived
 * gate therefore admits material 27.7 dB further down on one side than the
 * other, and the two "active" sets are not the same test.
 *
 * 20 dB, and it is the largest value in the swept set {15, 20, 25, 30, 40} at
 * which the reference still agrees with the ground truth: the active-envelope
 * spread measured from the separated vocal differs from the spread measured from
 * the true vocal by 0.40 dB at 15, 0.44 dB at 20, then 1.41 dB at 25, 4.21 dB at
 * 30 and 9.61 dB at 40. It is also the largest value that keeps the take's own
 * 10th percentile clear of its noise floor: 16.8 dB above it at 20 dB of gate,
 * 12.2 dB at 25, and only 3.5 dB at 30 — at which point the spread is measuring
 * the room, not the singer.
 */
export const ACTIVE_GATE_DB = 20;

/** Envelope sampling stride for the percentile scan: 1 ms. The detector has a
 * 10 ms attack and a 100 ms release so it cannot move meaningfully inside one
 * sample of that grid, and a full-resolution list of 6.8 M doubles would cost
 * more than the audio. Same reasoning, and same stride, as `deriveCompressor`. */
const PERCENTILE_STRIDE_MS = 1;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** The detector envelope in dB, sampled every `PERCENTILE_STRIDE_MS`. */
function detectorLevelsDb(channels: Float32Array[], sampleRate: number): number[] {
  const env = envelopeFollower(
    maxAcrossChannels(channels),
    sampleRate,
    DETECTOR_ATTACK_MS,
    DETECTOR_RELEASE_MS
  );
  const stride = Math.max(1, Math.round((PERCENTILE_STRIDE_MS / 1000) * sampleRate));
  const out: number[] = [];
  for (let i = 0; i < env.length; i += stride) out.push(toDb(env[i]));
  return out;
}

/**
 * The level below which this signal is not considered to be sounding, in dBFS.
 * `null` when there is nothing to measure (no channels, or no samples).
 */
export function activeThresholdDb(channels: Float32Array[], sampleRate: number): number | null {
  if (channels.length === 0 || (channels[0]?.length ?? 0) === 0) return null;
  const levels = detectorLevelsDb(channels, sampleRate);
  if (levels.length === 0) return null;
  levels.sort((a, b) => a - b);
  return percentile(levels, 0.95) - ACTIVE_GATE_DB;
}

// ── Loudness ────────────────────────────────────────────────────────────────

/**
 * Programme level over the SOUNDING part only, in dBFS — the quantity a loudness
 * match should equalise.
 *
 * Not `programmeRmsDb`, which averages over everything including the pauses: the
 * take is 88.5 % sounding and the separated original vocal 75.8 %, so an ungated
 * comparison of the two carries a 0.7 dB bias that is a fact about how much
 * silence each file contains rather than about how loud the singing is.
 *
 * The gating structure — measure the level, then keep only what is within a
 * fixed relative window of it — is the one ITU-R BS.1770-4 specifies for the
 * same reason. This is NOT that measurement and must not be called LUFS: there
 * is no K-weighting and no 400 ms block structure here, only the relative gate.
 */
export function gatedLevelDb(channels: Float32Array[], sampleRate: number): number | null {
  const thresholdDb = activeThresholdDb(channels, sampleRate);
  if (thresholdDb === null) return null;
  const env = envelopeFollower(
    maxAcrossChannels(channels),
    sampleRate,
    DETECTOR_ATTACK_MS,
    DETECTOR_RELEASE_MS
  );
  const thresholdLin = Math.pow(10, thresholdDb / 20);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < env.length; i++) {
    if (env[i] < thresholdLin) continue;
    for (const c of channels) sum += c[i] * c[i];
    n += channels.length;
  }
  if (n === 0) return null;
  return toDb(Math.sqrt(sum / n));
}

// ── Dynamics ────────────────────────────────────────────────────────────────

/**
 * The active-envelope spread: the 10th, 50th and 90th percentiles of the
 * compressor's own detector while the material is sounding.
 *
 * F7's finding is binding and is why crest factor is absent here: crest ROSE
 * 18.08 -> 22.24 dB on material the compressor was demonstrably narrowing by
 * 2.63 dB of this spread. The same instability shows up in this task's own
 * numbers — crest disagrees by 4.31 dB between the separated original vocal
 * (18.42 dB) and the ground-truth original vocal (22.73 dB), where the spread
 * measured under this module's gate disagrees by 0.44 dB.
 *
 * This is REPORTED, not used to derive a compressor. See the report: the move a
 * dynamics match would ask for is smaller than the measurement's own
 * gate-sensitivity, and changes sign with the gate.
 */
export interface ActiveSpread {
  p10Db: number;
  p50Db: number;
  p90Db: number;
  /** p90 - p10, in dB. */
  spreadDb: number;
  /** Fraction of the sampled envelope that was above the gate, 0..1. */
  activeFraction: number;
  thresholdDb: number;
}

export function activeEnvelopeSpread(
  channels: Float32Array[],
  sampleRate: number
): ActiveSpread | null {
  if (channels.length === 0 || (channels[0]?.length ?? 0) === 0) return null;
  const levels = detectorLevelsDb(channels, sampleRate);
  if (levels.length === 0) return null;
  const sorted = levels.slice().sort((a, b) => a - b);
  const thresholdDb = percentile(sorted, 0.95) - ACTIVE_GATE_DB;
  const active = sorted.filter((v) => v >= thresholdDb);
  if (active.length === 0) return null;
  const p10Db = percentile(active, 0.1);
  const p50Db = percentile(active, 0.5);
  const p90Db = percentile(active, 0.9);
  return {
    p10Db,
    p50Db,
    p90Db,
    spreadDb: p90Db - p10Db,
    activeFraction: active.length / sorted.length,
    thresholdDb,
  };
}

// ── Long-term average spectrum ──────────────────────────────────────────────

/** 2048 / 512, the resolution this app already uses for a spectral average
 * (`noiseProfile.averageMagnitudeSpectra`, and the Noise Reduction effect that
 * consumes it). Not a new choice. */
export const LTAS_FFT_SIZE = 2048;
export const LTAS_HOP = 512;

export interface Ltas {
  /** Mean POWER per bin over the sounding frames, length fftSize/2+1. */
  power: Float64Array;
  /** How many frames were averaged. Zero means nothing was sounding. */
  frames: number;
  sampleRate: number;
}

/**
 * Mean power spectrum over the frames whose CENTRE the gate calls sounding.
 *
 * Gated, because an average taken over the pauses measures the two recordings'
 * noise floors rather than the two singers' timbres. Measured: the match curve
 * this feeds is insensitive to WHICH sounding gate is used (the curve moves by
 * at most 0.06 dB per band across an absolute noise-floor gate and relative
 * gates of 15, 20 and 25 dB) — so the module can use one definition of active
 * throughout without costing the match anything.
 */
export function longTermAverageSpectrum(channels: Float32Array[], sampleRate: number): Ltas {
  const bins = LTAS_FFT_SIZE / 2 + 1;
  const power = new Float64Array(bins);
  const length = channels[0]?.length ?? 0;
  if (channels.length === 0 || length < LTAS_FFT_SIZE) return { power, frames: 0, sampleRate };

  const thresholdDb = activeThresholdDb(channels, sampleRate);
  if (thresholdDb === null) return { power, frames: 0, sampleRate };
  const env = envelopeFollower(
    maxAcrossChannels(channels),
    sampleRate,
    DETECTOR_ATTACK_MS,
    DETECTOR_RELEASE_MS
  );
  const thresholdLin = Math.pow(10, thresholdDb / 20);

  const win = hann(LTAS_FFT_SIZE);
  const re = new Float32Array(LTAS_FFT_SIZE);
  const im = new Float32Array(LTAS_FFT_SIZE);
  let frames = 0;
  for (let start = 0; start + LTAS_FFT_SIZE <= length; start += LTAS_HOP) {
    if (env[start + LTAS_FFT_SIZE / 2] < thresholdLin) continue;
    frames++;
    for (const channel of channels) {
      for (let i = 0; i < LTAS_FFT_SIZE; i++) {
        re[i] = channel[start + i] * win[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 0; k < bins; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    }
  }
  if (frames > 0) {
    const divisor = frames * channels.length;
    for (let k = 0; k < bins; k++) power[k] /= divisor;
  }
  return { power, frames, sampleRate };
}

/**
 * Mean power in `[loHz, hiHz)` as dB, or `null` when the band holds no bin of
 * this spectrum (it is above Nyquist, or narrower than one bin).
 *
 * Bin 0 (DC) is excluded: it carries any residual offset, not programme.
 * Working in Hz rather than in bins is what lets a 44.1 kHz reference be
 * compared with a 48 kHz take without resampling either of them.
 */
export function bandLevelDb(ltas: Ltas, loHz: number, hiHz: number): number | null {
  let sum = 0;
  let count = 0;
  for (let k = 1; k < ltas.power.length; k++) {
    const f = (k * ltas.sampleRate) / LTAS_FFT_SIZE;
    if (f >= loHz && f < hiHz) {
      sum += ltas.power[k];
      count++;
    }
  }
  return count === 0 ? null : 10 * Math.log10(Math.max(sum / count, 1e-30));
}

// ── The match curve ─────────────────────────────────────────────────────────

/**
 * The band centres of the app's own Graphic EQ, which is what realises this
 * curve. Declared here rather than imported because `src/dsp` may not depend on
 * `src/effects`; the test pins the two lists equal, so a change to either is a
 * failure rather than a silent divergence.
 */
export const MATCH_BAND_CENTRES_HZ = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

/** Octave band edges: centre / sqrt(2) .. centre * sqrt(2). */
const BAND_EDGE_RATIO = Math.SQRT2;

/**
 * The lowest band the match is allowed to touch.
 *
 * MEASURED, against the ground truth, on the reference material. Per band, the
 * separated original vocal's level minus the level of its own error against the
 * true vocal:
 *
 *      31 Hz  -18.0 dB      250 Hz   +5.3 dB      4 kHz  +10.9 dB
 *      63 Hz  -16.2 dB      500 Hz  +13.0 dB      8 kHz  +16.8 dB
 *     125 Hz   -5.1 dB        1 kHz +13.4 dB     16 kHz  +15.1 dB
 *                             2 kHz +13.2 dB
 *
 * Below 500 Hz the "separated vocal" is mostly not the vocal: at 125 Hz its own
 * error exceeds it by 5.1 dB. And the raw curve asks for the largest corrections
 * exactly there — +9.5 dB at 31 Hz, +15.0 at 63 Hz, +17.9 at 125 Hz — so an
 * unrestricted match would apply its biggest moves where its reference is worst,
 * which is Ruling 2's failure in one sentence. The cut sits at 500 Hz because
 * the readings fall into two groups with an empty 5.6 dB gap between them (the
 * highest excluded is 250 Hz at +5.3, the lowest retained is 4 kHz at +10.9);
 * 8 dB is the middle of that gap and 500 Hz is the lowest centre above it.
 */
export const MATCH_MIN_CENTRE_HZ = 500;

/**
 * The largest correction any band may be given, in dB.
 *
 * 10.9 dB is the WEAKEST reference in the retained set: the 4 kHz band's own
 * signal-to-separation-error ratio from the table above. A correction larger
 * than that is a correction to the separation rather than to the singer.
 *
 * On the reference material it does not bind — the curve there peaks at 3.5 dB —
 * which is the point: it is a guard against material this song did not produce,
 * and the test that pins it uses a fixture whose raw difference exceeds it.
 *
 * WHAT IT IS NOT: it is not the only limit that can act. The bound is a
 * correction in octave-band ENERGY, and the Graphic EQ's own +-12 dB is a band
 * GAIN, which is a different quantity — a peaking filter delivers its full gain
 * only at its centre, so a band pushed to the +12 dB rail moves its octave's
 * energy by less than 12 dB. Measured at 48 kHz on a flat spectrum, a lone band
 * at +12 dB delivers +9.73 dB of band energy at 500 Hz falling to +9.17 dB at
 * 8 kHz, and at -12 dB delivers -8.91 dB falling to -7.94 dB. So the top of this
 * bound is not reachable at all, and above roughly +-9 dB it is the effect's
 * clamp that acts rather than this constant. That is not hidden: the solve
 * reports `clamped`, and the chain names the shortfall band by band
 * (`coverChain.ts`'s `warning`).
 */
export const MATCH_BOUND_DB = 10.9;

/** Why a band carries no correction. Exhaustive and exclusive: every centre in
 * `MATCH_BAND_CENTRES_HZ` gets exactly one status. */
export type MatchBandStatus =
  | 'matched'
  | 'below-range'
  | 'above-nyquist'
  | 'no-signal';

export interface MatchBand {
  centreHz: number;
  status: MatchBandStatus;
  /** The correction to apply, dB. Zero for every status but `matched`. */
  gainDb: number;
  /** The difference before centring and bounding, dB. `null` when unmeasurable. */
  rawDb: number | null;
  /** True when `gainDb` was cut down to `MATCH_BOUND_DB`. */
  bounded: boolean;
}

export interface MatchCurve {
  /** One entry per centre in `MATCH_BAND_CENTRES_HZ`, in that order. */
  bands: MatchBand[];
  /**
   * The broadband level difference removed from the curve, dB — what the EQ is
   * NOT doing, because it is the loudness match's job. The curve is the shape
   * that is left once this is taken out.
   */
  levelDb: number;
  /** How many bands carry a correction. */
  matchedCount: number;
}

/**
 * The EQ curve that takes the take's long-term spectrum toward the reference's.
 *
 * SMOOTHED to octave bands, and that is not a stylistic choice. Measured on the
 * reference material, the raw bin-by-bin difference (both spectra on a common
 * frequency grid) spans -84.0 to +29.7 dB, with a standard deviation of 33.8 dB
 * inside the 16 kHz octave alone against a band value of +3.9 dB there. The
 * -84 dB extreme is the separation model's own band limit: it runs at 44.1 kHz,
 * so the reference has NOTHING above 22.05 kHz while a 48 kHz take does, and a
 * bin-by-bin match would ask for an 84 dB cut on the strength of it. Averaging
 * ENERGY across the octave is what disarms that: a notch, however deep, removes
 * only the energy of the bins it covers, so two bins at -84 dB inside a 33-bin
 * octave move the band by 0.3 dB rather than by 84. Octave bands are also
 * exactly what the Graphic EQ has, so the curve is smoothed to the resolution
 * that will realise it and no finer.
 *
 * The mirror case is not symmetric and is worth saying plainly: a narrow SPIKE
 * is real energy, so it does move the band average, and it is `MATCH_BOUND_DB`
 * rather than the smoothing that stops it becoming a 40 dB boost.
 *
 * Third-octave was measured too and rejected: inside the well-behaved bands its
 * structure (2.7-3.0 dB across an octave) is no larger than the raw difference's
 * own spread within those bands (sd 1.2-6.2 dB), so it is not distinguishable
 * from the noise it sits in; and at 4 kHz its three points run 4.1 / 10.0 /
 * 17.8 dB, the top one asking for 6.9 dB more than that band's reference can
 * justify.
 *
 * The top of the range is not a constant: a band is dropped when its octave does
 * not lie entirely below BOTH spectra's Nyquist. On the reference material that
 * drops 16 kHz, whose octave reaches 22.6 kHz against the separation model's
 * 22.05 kHz — the cliff that produced the -84 dB bin above.
 */
export function matchCurve(reference: Ltas, take: Ltas): MatchCurve {
  const nyquist = Math.min(reference.sampleRate, take.sampleRate) / 2;
  const bands: MatchBand[] = [];
  const raw: { index: number; value: number }[] = [];

  for (const centreHz of MATCH_BAND_CENTRES_HZ) {
    const lo = centreHz / BAND_EDGE_RATIO;
    const hi = centreHz * BAND_EDGE_RATIO;
    const index = bands.length;
    if (centreHz < MATCH_MIN_CENTRE_HZ) {
      bands.push({ centreHz, status: 'below-range', gainDb: 0, rawDb: null, bounded: false });
      continue;
    }
    if (hi > nyquist) {
      bands.push({ centreHz, status: 'above-nyquist', gainDb: 0, rawDb: null, bounded: false });
      continue;
    }
    const refDb = bandLevelDb(reference, lo, hi);
    const takeDb = bandLevelDb(take, lo, hi);
    if (refDb === null || takeDb === null || reference.frames === 0 || take.frames === 0) {
      bands.push({ centreHz, status: 'no-signal', gainDb: 0, rawDb: null, bounded: false });
      continue;
    }
    const value = refDb - takeDb;
    raw.push({ index, value });
    bands.push({ centreHz, status: 'matched', gainDb: 0, rawDb: value, bounded: false });
  }

  if (raw.length === 0) return { bands, levelDb: 0, matchedCount: 0 };

  // Centre the curve: the EQ carries the SHAPE, the loudness match carries the
  // level. Without this the curve on the reference material asks for +5 to
  // +28 dB across the board, which is a mastered vocal against a raw recording,
  // not a timbre difference.
  const levelDb = raw.reduce((acc, r) => acc + r.value, 0) / raw.length;
  for (const r of raw) {
    const centred = r.value - levelDb;
    const bounded = Math.abs(centred) > MATCH_BOUND_DB;
    bands[r.index].gainDb = bounded ? Math.sign(centred) * MATCH_BOUND_DB : centred;
    bands[r.index].bounded = bounded;
  }
  return { bands, levelDb, matchedCount: raw.length };
}

// ── Reverb ──────────────────────────────────────────────────────────────────

/** Level curve resolution for the decay fit: 20 ms windows every 10 ms. A
 * 20 ms window resolves a decay of a few hundred ms into tens of points while
 * still averaging out one pitch period of a low male voice (~12 ms at 80 Hz). */
const DECAY_BLOCK_MS = 20;
const DECAY_HOP_MS = 10;
/**
 * ISO 3382-1's T20 evaluation range: fit the decay between 5 dB and 25 dB below
 * the peak, then extrapolate the slope to 60 dB. The first 5 dB are skipped
 * because the direct sound dominates there, and stopping at 25 dB keeps the fit
 * clear of the noise floor. RT60 = 3 * T20 follows from the extrapolation.
 */
const DECAY_UPPER_DB = -5;
const DECAY_LOWER_DB = -25;
/** A fit needs at least this many points — 8 points at a 10 ms hop is 80 ms, so
 * a "decay" shorter than that is a gap between syllables, not a tail. */
const DECAY_MIN_POINTS = 8;
/**
 * ISO 3382-1 requires a decay to be evaluated for linearity, so a fit is
 * rejected when too little of its variance is explained by the straight line.
 *
 * 0.85, DERIVED FROM WHAT REAL REVERB SCORES rather than picked: across the two
 * validated Freeverb controls the lowest r-squared any fit produced was 0.883
 * (roomSize 0.5) and 0.859 (roomSize 0.8), so 0.85 sits below every genuine
 * decay measured here and the check cannot throw one away. The 0.9 this was
 * first written as would have rejected the quietest 5 % of a real 2.9 s reverb.
 *
 * WHAT IT DOES NOT DO, measured, because the obvious reading of "linearity
 * check" is wrong: it does not reject a decay for being CURVED. An amplitude
 * ramp — falling linearly in amplitude, so strongly bent in dB, and containing
 * no reverberation at all — scores a minimum of 0.910, HIGHER than either real
 * reverb control's minimum. What it removes is RAGGED fits: on a decay with
 * +-6 dB of block jitter it rejects half of them (67 accepted, against 137 with
 * the check disabled). Both behaviours are pinned in the tests.
 */
const DECAY_MIN_R2 = 0.85;

export interface DecayEstimate {
  /** Median RT60 over the accepted decays, seconds. */
  seconds: number;
  p25Seconds: number;
  p75Seconds: number;
  /** How many decays were accepted. */
  count: number;
}

/**
 * Estimated RT60, from the decays that follow note offsets.
 *
 * VALIDATED, not asserted: run on the reference take through the app's own
 * Freeverb it recovers 1.26 s where the closed form says 1.45 s (-13 %) and
 * 2.92 s where it says 3.20 s (-9 %), and reads 0.26 s on the same take dry. So
 * it can tell dry from 1.4 s from 3.2 s on real singing.
 *
 * Returns `null` when no decay passed — which is a real answer ("nothing here
 * decays cleanly enough to measure"), not an error.
 */
export function estimateDecay(channels: Float32Array[], sampleRate: number): DecayEstimate | null {
  const length = channels[0]?.length ?? 0;
  const block = Math.max(1, Math.round((DECAY_BLOCK_MS / 1000) * sampleRate));
  const hop = Math.max(1, Math.round((DECAY_HOP_MS / 1000) * sampleRate));
  if (channels.length === 0 || length < block) return null;

  const curve: number[] = [];
  for (let s = 0; s + block <= length; s += hop) {
    let sum = 0;
    for (const c of channels) for (let i = 0; i < block; i++) sum += c[s + i] * c[s + i];
    curve.push(toDb(Math.sqrt(sum / (block * channels.length))));
  }

  const hopSeconds = hop / sampleRate;
  const rt60s: number[] = [];
  for (let i = 1; i < curve.length - 1; i++) {
    if (!(curve[i] >= curve[i - 1] && curve[i] > curve[i + 1])) continue;
    const peak = curve[i];
    const xs: number[] = [];
    const ys: number[] = [];
    let started = false;
    let reachedLower = false;
    for (let j = i + 1; j < curve.length; j++) {
      const rel = curve[j] - peak;
      if (rel > DECAY_UPPER_DB) {
        if (started) break; // came back up — the decay ended before -25 dB
        continue;
      }
      started = true;
      if (rel < DECAY_LOWER_DB) {
        reachedLower = true;
        break;
      }
      xs.push((j - i) * hopSeconds);
      ys.push(rel);
    }
    if (!reachedLower || xs.length < DECAY_MIN_POINTS) continue;

    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let k = 0; k < n; k++) {
      sxy += (xs[k] - mx) * (ys[k] - my);
      sxx += (xs[k] - mx) * (xs[k] - mx);
      syy += (ys[k] - my) * (ys[k] - my);
    }
    if (sxx <= 0 || syy <= 0) continue;
    const slope = sxy / sxx;
    if (slope >= 0) continue;
    if ((sxy * sxy) / (sxx * syy) < DECAY_MIN_R2) continue;
    rt60s.push(-60 / slope);
  }

  if (rt60s.length === 0) return null;
  rt60s.sort((a, b) => a - b);
  return {
    seconds: percentile(rt60s, 0.5),
    p25Seconds: percentile(rt60s, 0.25),
    p75Seconds: percentile(rt60s, 0.75),
    count: rt60s.length,
  };
}

/**
 * The RT60 the app's Reverb produces at a given room size, in seconds — in
 * closed form from the effect's own topology, so a caller can ask whether a
 * measured decay is inside the range the effect can actually deliver.
 *
 * `ReverbEffect` is Freeverb: `combFeedback = 0.7 + 0.28 * roomSize`, applied
 * once per comb delay, and the tail is set by the LONGEST comb (base 1617
 * samples at the 44.1 kHz reference rate, scaled by `round(base * rate / 44100)`
 * — the effect's own `scaleDelay`). A loop loses `-20*log10(g)` dB, so 60 dB
 * takes `60 / -20log10(g)` loops. The damping the effect also applies makes the
 * high end decay faster than this, so the figure is the low-frequency bound and
 * a broadband measurement of the effect reads shorter — measured 9-13 % shorter.
 *
 * At `roomSize = 0`, the effect's own minimum, this is 0.710 s at both 44.1 and
 * 48 kHz: THE SHORTEST REVERB THE APP CAN MAKE. The reference material's
 * original vocal measures 0.40 s, so the closest this effect could offer is
 * nearly twice the decay that is actually there.
 */
export const REVERB_LONGEST_COMB_44K = 1617;

export function reverbRt60Seconds(roomSize: number, sampleRate: number): number {
  const feedback = 0.7 + 0.28 * roomSize;
  const delaySamples = Math.round((REVERB_LONGEST_COMB_44K * sampleRate) / 44100);
  const dbPerLoop = -20 * Math.log10(feedback);
  return (60 / dbPerLoop) * (delaySamples / sampleRate);
}
