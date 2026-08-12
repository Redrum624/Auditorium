/**
 * Task F10, Ruling B — what the Graphic EQ actually delivers.
 *
 * The app's Graphic EQ is a CASCADE of peaking biquads at Q = 1.4, one per
 * octave. They overlap, so the response at a band centre is not the gain that
 * band was given: measured by dispatch 1, a single +6 dB band leaks 1.15 dB into
 * each neighbour an octave away, and on an alternating +-3 dB curve the realised
 * response at the centres is off by up to 1.0 dB — comparable to the whole
 * correction the cover chain's match asks for on the reference material.
 *
 * Ruling B is binding: never show the user a curve the audio did not receive.
 * This module is how that promise is kept, and it does BOTH things the ruling
 * allows rather than picking one:
 *
 *   - `solveCascadeGains` PRE-COMPENSATES — it searches for the band gains whose
 *     realised response equals the requested curve, so the audio receives the
 *     curve the measurement asked for.
 *   - `realisedBandEnergyDb` MEASURES what the solved cascade actually does to
 *     every octave's ENERGY, including the bands the solve was not allowed to
 *     touch, and that measurement is what the chain reports.
 *
 * The second bullet says ENERGY rather than "response at the centre", and the
 * distinction turned out to matter more than the leak the ruling named. The
 * curve is a difference of octave-band energies, so realising it means moving
 * those energies; a cascade whose CENTRE response equals the curve moves them by
 * measurably less, because a peaking filter delivers its full gain only at its
 * centre. Measured end to end on the reference material: matching the centres
 * closed 70 % of the spectral distance to the original vocal (1.94 -> 0.58 dB),
 * matching the band energies closed 82 % (1.94 -> 0.34 dB).
 *
 * ── The skip rule is copied, not approximated ───────────────────────────────
 * `GraphicEqEffect` builds a biquad only for a band with `|gain| > 0.01` dB and
 * `freq < nyquist`. This module applies the SAME two tests. Without that, a
 * solved gain of 0.005 dB would be counted in the realised response here and
 * skipped in the audio, and the report would be wrong in exactly the way the
 * ruling forbids. The test pins the two rules together.
 *
 * ── Why `src/dsp` re-declares Q ─────────────────────────────────────────────
 * `src/dsp` may not depend on `src/effects` — the same constraint that made
 * `coverMatch.ts` re-declare the band centres. `GRAPHIC_EQ_CASCADE_Q` is pinned
 * equal to the effect's own `Q` by test, so a change to either is a failure
 * rather than a silent divergence.
 */

import { designBiquad, magnitudeAt } from './biquad';
import { LTAS_FFT_SIZE } from './coverMatch';

/** The cascade's peaking Q. Pinned equal to `GraphicEqEffect`'s own `Q`. */
export const GRAPHIC_EQ_CASCADE_Q = 1.4;

/** `GraphicEqEffect` skips a band whose gain is no larger than this, because a
 * 0 dB peaking stage is an identity filter. Copied so the realised response is
 * computed over exactly the biquads the effect will build. */
export const GRAPHIC_EQ_SKIP_DB = 0.01;

/** The Graphic EQ's own parameter range, +-12 dB. A solved gain outside it is
 * one the effect would clamp, so the solve clamps it here and says it did. */
export const GRAPHIC_EQ_MAX_ABS_DB = 12;

function bandApplies(gainDb: number, freqHz: number, sampleRate: number): boolean {
  return Math.abs(gainDb) > GRAPHIC_EQ_SKIP_DB && freqHz < sampleRate / 2;
}

/**
 * The cascade's magnitude response in dB at each of `centresHz`, given the band
 * gains the effect would be handed.
 *
 * `gainsDb[i]` is the gain of the band at `centresHz[i]`; the two arrays are
 * parallel and must be the same length. The response is evaluated at the same
 * centres, which is what makes the result directly comparable with the curve the
 * match asked for.
 */
export function realisedCascadeDb(
  gainsDb: readonly number[],
  centresHz: readonly number[],
  sampleRate: number
): number[] {
  const coeffs = centresHz
    .map((freq, i) => ({ freq, gainDb: gainsDb[i] ?? 0 }))
    .filter((b) => bandApplies(b.gainDb, b.freq, sampleRate))
    .map((b) => designBiquad('peaking', sampleRate, b.freq, GRAPHIC_EQ_CASCADE_Q, b.gainDb));

  return centresHz.map((freq) => {
    // A centre at or above Nyquist has no response to report: the cascade
    // cannot act there and neither can the effect.
    if (freq >= sampleRate / 2) return 0;
    let magnitude = 1;
    for (const c of coeffs) magnitude *= magnitudeAt(c, freq, sampleRate);
    return 20 * Math.log10(Math.max(magnitude, 1e-30));
  });
}

/** Octave band edges: centre / sqrt(2) .. centre * sqrt(2). The same edges
 * `matchCurve` uses, because the curve being realised is expressed in them. */
const BAND_EDGE_RATIO = Math.SQRT2;

/**
 * The cascade's response as OCTAVE-BAND ENERGY, in dB per band — the quantity
 * the cover chain's match curve is actually expressed in, and therefore the one
 * that has to be pre-compensated and reported.
 *
 * ── Why the centre response is the wrong measure here ───────────────────────
 * `matchCurve` compares the MEAN POWER of an octave in each spectrum. A peaking
 * biquad set to +3 dB delivers +3 dB at its centre and progressively less
 * towards the band edges, so a cascade whose centre response equals the curve
 * moves the band's ENERGY by measurably less than the curve asked for. Measured
 * end to end on the reference material: matching the centres closed 70 % of the
 * shape difference (1.94 -> 0.58 dB), matching the band energies closed 82 %
 * (1.94 -> 0.34 dB). Reporting the centre
 * response as "realised" against a target that means band energy would be
 * comparing two different quantities and calling the difference zero.
 *
 * Integrated over the SAME bins `bandLevelDb` averages — the 2048-point grid at
 * this sample rate — so the two are the same measurement of the same band. Bins
 * of an octave that reaches past Nyquist are simply absent, exactly as they are
 * absent from the spectrum; a band with no bin at all returns 0.
 */
export function realisedBandEnergyDb(
  gainsDb: readonly number[],
  centresHz: readonly number[],
  sampleRate: number
): number[] {
  const coeffs = centresHz
    .map((freq, i) => ({ freq, gainDb: gainsDb[i] ?? 0 }))
    .filter((b) => bandApplies(b.gainDb, b.freq, sampleRate))
    .map((b) => designBiquad('peaking', sampleRate, b.freq, GRAPHIC_EQ_CASCADE_Q, b.gainDb));

  const bins = LTAS_FFT_SIZE / 2 + 1;
  return centresHz.map((centre) => {
    const lo = centre / BAND_EDGE_RATIO;
    const hi = centre * BAND_EDGE_RATIO;
    let sum = 0;
    let count = 0;
    for (let k = 1; k < bins; k++) {
      const f = (k * sampleRate) / LTAS_FFT_SIZE;
      if (f < lo || f >= hi) continue;
      let magnitude = 1;
      for (const c of coeffs) magnitude *= magnitudeAt(c, f, sampleRate);
      sum += magnitude * magnitude;
      count++;
    }
    return count === 0 ? 0 : 10 * Math.log10(Math.max(sum / count, 1e-30));
  });
}

/** How many refinement passes the solve is allowed. The correction each pass
 * applies is the residual error, and the cascade's off-diagonal leakage is a
 * fraction of its diagonal, so the residual shrinks by roughly that fraction per
 * pass. Twelve is enough for the band-energy target, whose diagonal is weaker
 * than the centre response's (a band has to be pushed HARDER than its target to
 * move its energy by the target). Convergence is reported in `iterations` and a
 * run that used them all is one that did NOT converge — `worstErrorDb` says by
 * how much, and that number is what the chain reports. */
const SOLVE_MAX_PASSES = 12;
/** Stop once every solvable centre is within this of its target. 0.01 dB is the
 * effect's own skip threshold — below it a band is not applied at all, so
 * chasing a smaller error would be chasing a difference the effect cannot make. */
const SOLVE_TOLERANCE_DB = 0.01;

export interface CascadeSolution {
  /** The gains to hand the effect, parallel to `centresHz`. */
  gainsDb: number[];
  /** The octave-band ENERGY those gains actually produce, per band. Report THIS:
   * it is the same quantity the target is expressed in. */
  realisedDb: number[];
  /** Passes taken. Fewer than `SOLVE_MAX_PASSES` means it converged. */
  iterations: number;
  /** Largest |realised - target| over the SOLVED centres, dB. */
  worstErrorDb: number;
  /** True when a solved gain hit the effect's own +-12 dB range. */
  clamped: boolean;
}

/**
 * Band gains whose realised response matches `targetDb` at the centres named by
 * `solvable`.
 *
 * ── Why the solve is restricted ─────────────────────────────────────────────
 * Only the bands the match is allowed to touch may be moved. The cover chain's
 * match runs from 500 Hz upward because below that the separated reference is
 * measurably not the vocal (its own error EXCEEDS it by 5.1 dB at 125 Hz). If
 * the solve were free to put a gain at 250 Hz to cancel the 500 Hz band's leak
 * into it, the EQ would carry a deliberate correction in a band the chain's own
 * measurement forbids — and "the match runs from 500 Hz upward" would stop being
 * true of the audio. So the excluded bands are held at exactly 0, their leak is
 * MEASURED by `realisedCascadeDb`, and the chain reports it.
 *
 * ── The iteration ───────────────────────────────────────────────────────────
 * `g <- g + (target - realised(g))`, clamped to the effect's range each pass,
 * where `realised` is the BAND-ENERGY response (see `realisedBandEnergyDb`).
 * The cascade's dB response is very nearly additive across bands, so this is a
 * fixed-point iteration on a diagonally dominant system rather than a search.
 *
 * It does not always converge, and that is reported rather than hidden: a band
 * whose octave runs into Nyquist, or whose target needs more than the effect's
 * own +-12 dB once the roll-off is compensated, ends short. `worstErrorDb` is
 * the shortfall and `realisedDb` is what was actually delivered — never the
 * target dressed up as an outcome.
 */
export function solveCascadeGains(
  targetDb: readonly number[],
  centresHz: readonly number[],
  sampleRate: number,
  solvable: readonly boolean[]
): CascadeSolution {
  const gainsDb = centresHz.map((_, i) => (solvable[i] ? (targetDb[i] ?? 0) : 0));
  let clamped = false;
  let realisedDb = realisedBandEnergyDb(gainsDb, centresHz, sampleRate);
  let iterations = 0;

  const worst = (r: number[]): number => {
    let w = 0;
    for (let i = 0; i < centresHz.length; i++) {
      if (!solvable[i]) continue;
      const e = Math.abs(r[i] - (targetDb[i] ?? 0));
      if (e > w) w = e;
    }
    return w;
  };

  while (iterations < SOLVE_MAX_PASSES && worst(realisedDb) > SOLVE_TOLERANCE_DB) {
    for (let i = 0; i < centresHz.length; i++) {
      if (!solvable[i]) continue;
      let next = gainsDb[i] + ((targetDb[i] ?? 0) - realisedDb[i]);
      if (next > GRAPHIC_EQ_MAX_ABS_DB) {
        next = GRAPHIC_EQ_MAX_ABS_DB;
        clamped = true;
      } else if (next < -GRAPHIC_EQ_MAX_ABS_DB) {
        next = -GRAPHIC_EQ_MAX_ABS_DB;
        clamped = true;
      }
      gainsDb[i] = next;
    }
    realisedDb = realisedBandEnergyDb(gainsDb, centresHz, sampleRate);
    iterations++;
  }

  return { gainsDb, realisedDb, iterations, worstErrorDb: worst(realisedDb), clamped };
}
