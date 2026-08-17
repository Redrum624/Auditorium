import type { EffectDefinition, EffectReport } from '../types';
import { detectPitch, type PitchTrack } from '../../dsp/pitchDetect';
import { MAX_RATIO, MIN_RATIO, timeStretchVariableLinked } from '../../dsp/wsola';
import { resampleVariable } from '../../dsp/resample';

/**
 * Pitch Correct — detects the sung/played pitch over time (YIN, src/dsp/pitchDetect),
 * snaps it toward the nearest note of a chosen key/scale, and resynthesizes with
 * a time-varying pitch shift. Destructive, like every registry effect.
 *
 * Pipeline (the time-varying generalisation of PitchShiftEffect's two stages):
 *  1. Detect f0 per 10 ms frame on the channel MEAN (the same mid signal the
 *     linked WSOLA searches), so all channels share one correction curve.
 *  2. Per frame: correction = (nearest scale note − detected pitch) in
 *     semitones; unvoiced/silent frames target zero correction. The curve is
 *     smoothed by a one-pole with time constant `retuneMs` and scaled by
 *     `strength`.
 *  3. Per-sample ratio ρ(i) = 2^(corr/12) (linear interpolation of the
 *     correction between frame centres — pitch is log-frequency, so glides are
 *     linear in cents), defensively clamped to [MIN_RATIO, MAX_RATIO]. By
 *     construction |corr| ≤ half the largest scale gap (1 st for major/minor,
 *     0.5 st for chromatic) ⇒ ρ ∈ [0.944, 1.060], so the clamp never binds on
 *     a sane curve — it exists so no detector frame can push WSOLA outside its
 *     supported range.
 *  4. Stage 1: stereo-linked variable WSOLA along the cumulative map
 *     S(i) = Σρ (duration × ρ locally, pitch preserved, one shared similarity
 *     search ⇒ inter-channel phase preserved, as in PitchShiftEffect).
 *  5. Stage 2: windowed-sinc read-back of the stretched signal at positions
 *     S(i), i = 0..N−1 — locally a resample by ρ(i), multiplying frequencies
 *     by ρ(i) and restoring the ORIGINAL length N exactly.
 *
 * Parameter defaults (all derived — see task F1 report for the full derivations):
 *  - scale 'chromatic': the only key-agnostic choice. It snaps to the nearest
 *    equal-tempered semitone, correct for 12-TET material in ANY key; a
 *    key-specific default (e.g. C major) would actively mistune songs in other
 *    keys. Key defaults to 'C' = pitch-class 0, the origin of the numbering —
 *    irrelevant under chromatic (all 12 pcs are in the scale for every root).
 *  - strength 100 %: full correction of SUSTAINED pitch is the effect's job;
 *    musical partiality comes from the retune time constant, which chases
 *    moving pitch only partially (see below). The slider exists for explicit
 *    dry/wet-style blends, and 0 % is a byte-identical pass-through (pinned).
 *  - retuneMs 50: the one-pole's corner is 1/(2πτ) ≈ 3.2 Hz, below the 5–7 Hz
 *    singing-vibrato band (Sundberg 1994) — a sustained note's centre (DC) is
 *    fully corrected while vibrato-rate excursions are chased at
 *    |H(6 Hz)| = 1/√(1+(2π·6·0.05)²) ≈ 0.47, preserving expressive vibrato.
 *    50 ms also ≈ the analysis frame length, so the default never demands a
 *    faster response than the detector can measure. Range 0–500: 0 = instant
 *    snap (the hard "T-Pain" setting); beyond 500 ms the 95 % settling time
 *    (3τ = 1.5 s) exceeds a quarter note at 120 BPM, i.e. corrections would
 *    never complete within typical note durations.
 */

/** Chromatic pitch-class names, index = pitch class (C = 0). */
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Scale interval sets (semitones above the root). Values are persisted in
 * presets/undo history — never change them. An unknown id resolves to the
 * declared default 'chromatic' (the FadeEffect curve-lookup precedent). */
export const SCALE_INTERVALS: Record<string, readonly number[] | undefined> = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10], // natural minor
};

/** Fractional MIDI note number of a frequency. A4 = 440 Hz (ISO 16) = MIDI 69. */
export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

/**
 * Nearest note of the scale (any octave) to a fractional MIDI pitch, as an
 * integer MIDI note. Candidates are scanned in ascending order and an equal
 * distance REPLACES the incumbent, so exact midpoints snap UP — consistent
 * with Math.round's half-up convention (pinned in the tests).
 */
export function snapMidiToScale(midi: number, rootPc: number, intervals: readonly number[]): number {
  const baseOct = Math.floor((midi - rootPc) / 12);
  let best = rootPc + 12 * baseOct;
  let bestDist = Infinity;
  // The oct = baseOct − 1 candidates can only win when the interval set lacks
  // the root (0): with 0 present, the in-octave root sits at distance
  // (midi − rootPc) mod 12 while the octave-below's best candidate is at least
  // one semitone further, so for every SHIPPED scale the branch never fires.
  // It is kept (and pinned live in the tests via a rootless interval set)
  // because this function accepts arbitrary interval arrays.
  for (let oct = baseOct - 1; oct <= baseOct + 1; oct++) {
    for (const iv of intervals) {
      const cand = rootPc + 12 * oct + iv;
      const dist = Math.abs(midi - cand);
      if (dist <= bestDist) {
        bestDist = dist;
        best = cand;
      }
    }
  }
  return best;
}

/**
 * Per-frame correction curve in semitones: (snapped − detected) per voiced
 * frame, 0 for unvoiced frames, smoothed by a one-pole exponential and scaled
 * by strength01. `alpha = 1 − exp(−hopSec/τ)` is the standard discrete-time
 * mapping, so `retuneMs` IS the glide's time constant: 63 % of a step change
 * in retuneMs, ~95 % in 3·retuneMs; retuneMs = 0 ⇒ alpha = 1 ⇒ instant snap.
 * The smoother runs across unvoiced gaps (target 0), so corrections glide out
 * of and back into voiced regions instead of stepping.
 */
export function correctionCurve(
  track: PitchTrack,
  sampleRate: number,
  rootPc: number,
  intervals: readonly number[],
  strength01: number,
  retuneMs: number
): Float64Array {
  const hopSec = track.hopSamples / sampleRate;
  const alpha = retuneMs <= 0 ? 1 : 1 - Math.exp(-hopSec / (retuneMs / 1000));
  const out = new Float64Array(track.frames.length);
  let state = 0;
  for (let k = 0; k < track.frames.length; k++) {
    const f0 = track.frames[k].f0Hz;
    let target = 0;
    if (f0 !== null) {
      const midi = hzToMidi(f0);
      target = snapMidiToScale(midi, rootPc, intervals) - midi;
    }
    state += alpha * (target - state);
    out[k] = state * strength01;
  }
  return out;
}

/**
 * What the corrector actually did, and the one measurement of the SOURCE that
 * only this effect has already paid for (F7).
 *
 * `detectPitch` measured 282 ms of work per audio-second on the reference take,
 * so anything downstream that needs the sung range — the Vocal Chain's
 * high-pass corner is the shipped case — takes it from here rather than running
 * the detector a second time. `f0P1Hz` is the 1st percentile rather than the
 * minimum deliberately: on that take the minimum voiced f0 is 76.1 Hz against a
 * p1 of 195.2 Hz and a p50 of 330.9 Hz, i.e. the extreme tail is octave-error
 * contamination, and a corner placed under it would be placed under nothing.
 *
 * Cents are reported as the MEDIAN and MAX of |correction| over frames the
 * corrector actually moved, which is the number Ruling 3 asks the chain to
 * show; frames it left alone are excluded so a mostly-in-tune take does not
 * report "0 cents" for the notes it did fix.
 */
export function summarizeCorrection(track: PitchTrack, corr: ArrayLike<number>): EffectReport {
  const voiced: number[] = [];
  for (const f of track.frames) if (f.f0Hz !== null && f.f0Hz > 0) voiced.push(f.f0Hz);
  voiced.sort((a, b) => a - b);

  const moved: number[] = [];
  for (let k = 0; k < corr.length; k++) {
    const cents = Math.abs(corr[k]) * 100;
    if (cents > 0) moved.push(cents);
  }
  moved.sort((a, b) => a - b);

  const report: EffectReport = {
    voicedFrames: voiced.length,
    totalFrames: track.frames.length,
    correctedFrames: moved.length,
    medianCorrectionCents: moved.length === 0 ? 0 : moved[moved.length >> 1],
    maxCorrectionCents: moved.length === 0 ? 0 : moved[moved.length - 1],
  };
  // Omitted rather than zeroed when there is nothing voiced: 0 Hz would be read
  // downstream as a measured fundamental of zero.
  if (voiced.length > 0) {
    report.f0P1Hz = voiced[Math.min(voiced.length - 1, Math.round(0.01 * (voiced.length - 1)))];
    report.f0MedianHz = voiced[voiced.length >> 1];
  }
  return report;
}

/**
 * Cumulative stretch map from the per-frame correction curve. S[i] is the
 * stretched-signal position of input sample i (S[0] = 0, S[N] = the stretched
 * total length); the per-sample ratio is ρ(i) = 2^(c(i)/12) where c(i)
 * interpolates the correction linearly in SEMITONES between frame centres
 * (centerSamples + k·hopSamples) and HOLDS the first/last frame's value across
 * the head/tail edges. Every ρ is clamped to [MIN_RATIO, MAX_RATIO]: corrections
 * from snapMidiToScale are bounded by half the largest scale gap (≤ 1 st ⇒
 * ρ ∈ [0.944, 1.060]) so the clamp never binds in the effect, but this function
 * accepts ARBITRARY curves and must never emit a ratio WSOLA does not support
 * (the clamp is pinned directly in the tests via out-of-range curves).
 * Exported for exact-arithmetic unit pinning of the edge-hold and clamp
 * branches, which are unobservable at f0-measurement scale (the tail hold
 * affects only the last ~25 ms).
 */
export function buildCorrectionMap(
  corr: ArrayLike<number>,
  N: number,
  centerSamples: number,
  hopSamples: number
): { S: Float64Array; maxRho: number } {
  const K = corr.length;
  const S = new Float64Array(N + 1);
  let acc = 0;
  let maxRho = 0;
  for (let i = 0; i < N; i++) {
    const t = (i - centerSamples) / hopSamples; // fractional frame index at sample i
    let c: number;
    if (t <= 0) {
      c = corr[0];
    } else if (t >= K - 1) {
      c = corr[K - 1];
    } else {
      const k0 = Math.floor(t);
      const fr = t - k0;
      c = corr[k0] + fr * (corr[k0 + 1] - corr[k0]);
    }
    let rho = Math.pow(2, c / 12);
    if (rho < MIN_RATIO) rho = MIN_RATIO;
    else if (rho > MAX_RATIO) rho = MAX_RATIO;
    if (rho > maxRho) maxRho = rho;
    acc += rho;
    S[i + 1] = acc;
  }
  return { S, maxRho };
}

// Progress budget per stage, from per-sample op-count estimates at 44.1 kHz:
// detection ≈ τmax·W/hop ≈ 1103²/441 ≈ 2760 ops/sample, WSOLA search ≈
// (2·search+1)·compare/analysisHop ≈ 883·441/882 ≈ 442, sinc read-back = 64
// taps ⇒ shares ≈ 0.85 / 0.13 / 0.02.
const P_DETECT = 0.85;
const P_STRETCH = 0.13;

export const pitchCorrectEffect: EffectDefinition = {
  id: 'pitch-correct',
  name: 'Pitch Correct',
  category: 'Time & Pitch',
  params: [
    {
      id: 'key',
      label: 'Key',
      type: 'select',
      options: NOTE_NAMES.map((n) => ({ value: n, label: n })),
      default: 'C',
    },
    {
      id: 'scale',
      label: 'Scale',
      type: 'select',
      options: [
        { value: 'chromatic', label: 'Chromatic (nearest semitone)' },
        { value: 'major', label: 'Major' },
        { value: 'minor', label: 'Minor (natural)' },
      ],
      default: 'chromatic',
    },
    { id: 'strength', label: 'Strength', type: 'number', min: 0, max: 100, step: 1, unit: '%', default: 100 },
    {
      id: 'retuneMs',
      label: 'Retune Speed',
      type: 'number',
      min: 0,
      max: 500,
      step: 1,
      unit: 'ms',
      default: 50,
      // Shows which modulation rates the corrector chases vs preserves: the
      // one-pole's corner 1/(2πτ). Mirrors correctionCurve's alpha derivation
      // exactly (same τ semantics); vibrato (5–7 Hz) above the corner is what
      // survives correction. 0 ms has no corner — it is the instant hard snap.
      readout: (value) => {
        const ms = Number(value);
        return ms <= 0 ? 'instant snap' : `corner ≈ ${(1000 / (2 * Math.PI * ms)).toFixed(1)} Hz`;
      },
    },
  ],
  process(channels, sampleRate, params, onProgress) {
    const keyName = String(params.key ?? 'C');
    const scaleName = String(params.scale ?? 'chromatic');
    const strength01 = Math.min(1, Math.max(0, Number(params.strength ?? 100) / 100));
    const retuneMs = Number(params.retuneMs ?? 50);

    const copy = (report?: EffectReport) => ({
      channels: channels.map((c) => Float32Array.from(c)),
      report,
    });

    // Ruling 4: zero strength is a byte-identical pass-through (the
    // PitchShiftEffect 0-semitone precedent — exact copy, new arrays). No
    // report beyond the fact itself: the detector never ran, so there is no
    // pitch measurement to hand on (F7's chain reads that as "unknown", not
    // as "no voiced material").
    if (strength01 === 0) {
      onProgress?.(1);
      return copy({ strengthPercent: 0 });
    }

    const numCh = channels.length;
    const N = channels[0]?.length ?? 0;

    // Unknown persisted ids resolve to the declared defaults (FadeEffect precedent).
    const keyPc = NOTE_NAMES.indexOf(keyName as (typeof NOTE_NAMES)[number]);
    const rootPc = keyPc >= 0 ? keyPc : 0;
    const intervals = SCALE_INTERVALS[scaleName] ?? (SCALE_INTERVALS.chromatic as readonly number[]);

    // Detection on the channel mean — one correction curve for all channels.
    let mid: Float32Array;
    if (numCh === 1) {
      mid = channels[0];
    } else {
      mid = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        let sum = 0;
        for (let c = 0; c < numCh; c++) sum += channels[c][i];
        mid[i] = sum / numCh;
      }
    }
    const track = detectPitch(mid, sampleRate, (f) => onProgress?.(P_DETECT * f));

    const corr = correctionCurve(track, sampleRate, rootPc, intervals, strength01, retuneMs);

    // Ruling 3: silence/unvoiced (and already-perfectly-snapped) audio passes
    // through byte-identically — an all-zero correction curve means there is
    // nothing to resynthesize. Also covers inputs shorter than one analysis
    // frame (zero frames ⇒ zero-length curve).
    let anyCorrection = false;
    for (let k = 0; k < corr.length; k++) {
      if (corr[k] !== 0) {
        anyCorrection = true;
        break;
      }
    }
    if (!anyCorrection) {
      onProgress?.(1);
      return copy(summarizeCorrection(track, corr));
    }

    // Per-sample ratio and its cumulative map S (S[i] = stretched position of
    // input sample i). Correction interpolates linearly in SEMITONES between
    // frame centres and holds at the edges; see buildCorrectionMap.
    const { S, maxRho } = buildCorrectionMap(corr, N, track.frameSamples / 2, track.hopSamples);
    const M = Math.round(S[N]);

    // Inverse of S for the WSOLA stage (binary search; S is strictly
    // increasing because ρ ≥ MIN_RATIO > 0, so the interpolation divisor
    // can never be zero).
    const analysisPosAt = (v: number): number => {
      if (v <= 0) return 0;
      if (v >= S[N]) return N;
      let lo = 0;
      let hi = N;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (S[m] <= v) lo = m;
        else hi = m;
      }
      return lo + (v - S[lo]) / (S[lo + 1] - S[lo]);
    };

    // Stage 1: pitch-preserving variable stretch to length M.
    const stretched = timeStretchVariableLinked(channels, sampleRate, M, analysisPosAt, (f) =>
      onProgress?.(P_DETECT + P_STRETCH * f)
    );

    // Stage 2: read back at S(i) — output sample i carries input-time-i content
    // with frequencies scaled by ρ(i); the output length is exactly N.
    const positions = new Float64Array(N);
    for (let i = 0; i < N; i++) positions[i] = S[i];
    const fc = 0.5 * Math.min(1, 1 / maxRho);
    const base = P_DETECT + P_STRETCH;
    const out = stretched.map((c, ch) =>
      resampleVariable(c, positions, fc, (f) => onProgress?.(base + (1 - base) * ((ch + f) / numCh)))
    );
    onProgress?.(1);
    return { channels: out, report: summarizeCorrection(track, corr) };
  },
};
