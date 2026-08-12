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
 *     every octave's ENERGY IN THE TAKE, including the bands the solve was not
 *     allowed to touch, and that measurement is what the chain reports.
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
 * It also says IN THE TAKE, and that is the second half of the same lesson. How
 * much energy a filter removes from an octave depends on where in that octave
 * the signal's energy sits, so the band average has to be weighted by the
 * spectrum the cascade will act on. Weighting it by nothing — the plain mean of
 * |H|^2 — is the same as assuming every recording is flat across every octave,
 * and on `test-assets/vocal-30s.wav` that assumption misreported what the audio
 * received by up to 0.94 dB while the chain printed "within 0.008 dB of the
 * target". Ruling B does not distinguish between showing the user a wrong curve
 * on purpose and showing them one by approximation.
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
import { LTAS_FFT_SIZE, type Ltas } from './coverMatch';

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
 * parallel and must be the same length.
 *
 * This is the POINT response at the centre frequency, and it is NOT the quantity
 * the cover chain reports — `realisedBandEnergyDb` is. It is deliberately kept
 * as a separate measurement rather than folded in, because the leak Ruling B
 * names is stated at the centres (a lone +6 dB band leaks 1.15 dB an octave
 * away) and this is the function that measures it. Nothing in the chain calls
 * it; comparing it with a band-energy target would be comparing two different
 * quantities, which is exactly what `realisedBandEnergyDb`'s doc is about.
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
 * The change the cascade makes to each octave's ENERGY IN `signal`, in dB per
 * band — the quantity the cover chain's match curve is expressed in, and
 * therefore the one that has to be pre-compensated and reported.
 *
 * ── Why the centre response is the wrong measure here ───────────────────────
 * `matchCurve` compares the MEAN POWER of an octave in each spectrum. A peaking
 * biquad set to +3 dB delivers +3 dB at its centre and progressively less
 * towards the band edges, so a cascade whose centre response equals the curve
 * moves the band's ENERGY by measurably less than the curve asked for. Measured
 * end to end on the reference material: matching the centres closed 70 % of the
 * shape difference (1.94 -> 0.58 dB), matching the band energies closed 82 %
 * (1.94 -> 0.34 dB). Reporting the centre response as "realised" against a
 * target that means band energy would be comparing two different quantities and
 * calling the difference zero.
 *
 * ── Why `signal` is not optional ────────────────────────────────────────────
 * `bandLevelDb` averages the SIGNAL's power over the octave's bins, so the
 * change it will report after the cascade runs is
 *
 *     10*log10( SUM_k P_k*|H_k|^2 / SUM_k P_k )
 *
 * — the mean of |H|^2 WEIGHTED BY THE SPECTRUM IT ACTS ON, not the plain mean of
 * |H|^2. The two are equal only when P is flat across the octave, which no real
 * recording is. This function used to take the plain mean and was measurably
 * wrong for it: solving the reference curve on `test-assets/vocal-30s.wav` and
 * re-measuring end to end through the real `graphicEqEffect`, the plain mean
 * missed what the audio received by up to 0.94 dB (4 kHz reported -1.03 dB and
 * delivered -1.77 dB) while the weighted mean tracked it to 0.04 dB. That was
 * Ruling B's forbidden case — a curve shown to the user that the audio did not
 * receive — so the weighting is REQUIRED rather than defaulted: there is no
 * argument a caller can omit that quietly reinstates the flat assumption.
 *
 * `signal` must be measured at `sampleRate`, because the bin grid is shared:
 * both are the 2048-point grid `bandLevelDb` averages over, so the prediction
 * and the measurement are the same measurement of the same band. Bins of an
 * octave that reaches past Nyquist are simply absent, exactly as they are absent
 * from the spectrum; a band with no bin, or with no energy in the bins it has,
 * returns 0.
 */
export function realisedBandEnergyDb(
  gainsDb: readonly number[],
  centresHz: readonly number[],
  sampleRate: number,
  signal: Ltas
): number[] {
  if (signal.sampleRate !== sampleRate) {
    throw new Error(
      `realisedBandEnergyDb: the weighting spectrum is at ${signal.sampleRate} Hz but the cascade runs at ${sampleRate} Hz — ` +
        'they share a bin grid, so they must share a sample rate'
    );
  }
  const coeffs = centresHz
    .map((freq, i) => ({ freq, gainDb: gainsDb[i] ?? 0 }))
    .filter((b) => bandApplies(b.gainDb, b.freq, sampleRate))
    .map((b) => designBiquad('peaking', sampleRate, b.freq, GRAPHIC_EQ_CASCADE_Q, b.gainDb));

  const bins = Math.min(LTAS_FFT_SIZE / 2 + 1, signal.power.length);
  return centresHz.map((centre) => {
    const lo = centre / BAND_EDGE_RATIO;
    const hi = centre * BAND_EDGE_RATIO;
    let weighted = 0;
    let total = 0;
    for (let k = 1; k < bins; k++) {
      const f = (k * sampleRate) / LTAS_FFT_SIZE;
      if (f < lo || f >= hi) continue;
      const power = signal.power[k];
      if (power <= 0) continue;
      let magnitude = 1;
      for (const c of coeffs) magnitude *= magnitudeAt(c, f, sampleRate);
      weighted += power * magnitude * magnitude;
      total += power;
    }
    return total <= 0 ? 0 : 10 * Math.log10(Math.max(weighted / total, 1e-30));
  });
}

/**
 * How many refinement passes the solve is allowed.
 *
 * The correction each pass applies is the residual error, and the cascade's
 * off-diagonal leakage is a fraction of its diagonal, so the residual shrinks by
 * roughly that fraction per pass. The budget is MEASURED against the thing that
 * must never happen: a run reporting a shortfall the EQ could actually have
 * delivered, given one more pass.
 *
 * Twelve — what this was first written as — was too few. On an alternating
 * +-4 dB target over 500 Hz-8 kHz at 48 kHz the residual contracts by about 0.64
 * per pass and crosses the tolerance on the THIRTEENTH; at twelve it stopped at
 * 0.011 dB, just outside, and the chain printed a delivery warning produced
 * entirely by the pass budget.
 *
 * Weighting the realisation by the take's own spectrum (see
 * `realisedBandEnergyDb`) makes the diagonal weaker still on a steeply shaped
 * signal, and therefore slower. Measured over 600 random mean-centred curves per
 * span, at five spans, against two weighting spectra — white noise and a
 * formant-shaped noise with two Q = 8 resonances over a falling tail — the
 * slowest run that the effect's +-12 dB range could actually deliver needed
 * TWENTY-THREE passes (formant, +-10.9 dB span). At twenty-four, every single
 * unclamped run in all 6000 finished inside tolerance; every run that did not
 * was one where a gain hit +-12 dB, which is a limit of the effect and not of
 * the arithmetic. `worstErrorDb` says by how much, and that is what the chain
 * reports.
 *
 * The margin is free: the whole solve is 1 ms of the 2.28 s the Match EQ stage
 * takes, and the loop exits as soon as it converges.
 */
const SOLVE_MAX_PASSES = 24;
/** Stop once every solvable centre is within this of its target. 0.01 dB is the
 * effect's own skip threshold — below it a band is not applied at all, so
 * chasing a smaller error would be chasing a difference the effect cannot make. */
export const SOLVE_TOLERANCE_DB = 0.01;

export interface CascadeSolution {
  /** The gains to hand the effect, parallel to `centresHz`. */
  gainsDb: number[];
  /** The octave-band ENERGY those gains actually produce in the signal the solve
   * was given, per band. Report THIS: it is the same quantity the target is
   * expressed in, measured on the spectrum the audio actually has. */
  realisedDb: number[];
  /** Passes taken — a cost figure, NOT the convergence signal. The loop tests
   * the residual at the top of a pass, so a run whose last allowed pass lands
   * inside tolerance is indistinguishable by this number from one that ran out.
   * `worstErrorDb <= SOLVE_TOLERANCE_DB` is the test that observes convergence,
   * and it is the one the chain makes. */
  iterations: number;
  /** Largest |realised - target| over the SOLVED centres, dB. */
  worstErrorDb: number;
  /** True when the solve RAN INTO the effect's own +-12 dB range — at any pass,
   * whether or not a gain in the returned iterate still sits on it. It is a
   * statement about what limited the solve, which is what makes it worth
   * reporting: a shortfall the effect's range caused is a different fact from a
   * shortfall the arithmetic caused. */
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
 * MEASURED by `realisedBandEnergyDb` along with every other band, and the chain
 * reports it.
 *
 * ── The iteration ───────────────────────────────────────────────────────────
 * `g <- g + (target - realised(g))`, clamped to the effect's range each pass,
 * where `realised` is the BAND-ENERGY response in `signal` (see
 * `realisedBandEnergyDb`). The cascade's dB response is very nearly additive
 * across bands, so this is a fixed-point iteration on a diagonally dominant
 * system rather than a search.
 *
 * It does not always converge, and that is reported rather than hidden: a band
 * whose octave runs into Nyquist, or whose target needs more than the effect's
 * own +-12 dB once the roll-off is compensated, ends short. `worstErrorDb` is
 * the shortfall and `realisedDb` is what was actually delivered — never the
 * target dressed up as an outcome.
 *
 * ── Why the LAST iterate is kept, with the best one only as a fallback ──────
 * Once the +-12 dB clamp saturates, the iteration is no longer a contraction:
 * it can settle on a fixed point strictly FURTHER from the target than the
 * gains it started from. Measured over targets of the shape `matchCurve`
 * produces (mean-centred, bounded to +-10.9), a third of the runs ended worse
 * than their own starting point, and on an alternating +-8 dB target the leak
 * into 250 Hz — a band the chain's measurement forbids touching — grew across
 * the solve. That harm has to be guarded against for "pre-compensated" to be a
 * claim the returned gains can support.
 *
 * But "keep whichever iterate scores best" is the wrong guard, and the packaged
 * smoke caught it doing damage. Scoring on the worst band freezes every OTHER
 * band the moment one of them clamps: the worst error stops moving, no later
 * iterate can beat it, and bands the EQ could have delivered exactly are left
 * wherever they happened to be. On the smoke's own fixture that left 500 Hz
 * 0.15 dB and 4 kHz 0.25 dB short of targets the cascade reaches to three
 * decimals, in exchange for 0.04 dB on a 16 kHz band pinned at the rail and
 * short by 2.1 dB either way. Measured over 300 mean-centred targets: keeping
 * the last iterate leaves ZERO deliverable bands short but ends worse than its
 * own starting point in 48 of them; keeping the best-scoring one never ends
 * worse but leaves 749 deliverable bands short.
 *
 * So the rule is: return the LAST iterate — the fixed point, where every band
 * the cascade can reach is reached — UNLESS it is worse than the un-compensated
 * gains the solve started from by more than `SOLVE_TOLERANCE_DB`, in which case
 * return the best iterate seen. That is 2 of 300 ending worse (all of them
 * inside `SOLVE_TOLERANCE_DB`, which is the effect's own skip threshold: below
 * it a band is not applied at all)
 * and 203 deliverable bands left short, in the 16 % of runs where the fixed
 * point is genuinely worse than not compensating.
 */
export function solveCascadeGains(
  targetDb: readonly number[],
  centresHz: readonly number[],
  sampleRate: number,
  solvable: readonly boolean[],
  signal: Ltas
): CascadeSolution {
  /** The worst band error and the total squared error, over the solved bands. */
  const score = (r: readonly number[]): { errorDb: number; sumSq: number } => {
    let errorDb = 0;
    let sumSq = 0;
    for (let i = 0; i < centresHz.length; i++) {
      if (!solvable[i]) continue;
      const e = Math.abs(r[i] - (targetDb[i] ?? 0));
      if (e > errorDb) errorDb = e;
      sumSq += e * e;
    }
    return { errorDb, sumSq };
  };
  const snapshot = (g: readonly number[], r: readonly number[]) => ({
    gainsDb: [...g],
    realisedDb: [...r],
    ...score(r),
  });

  const gainsDb = centresHz.map((_, i) => (solvable[i] ? (targetDb[i] ?? 0) : 0));
  let realisedDb = realisedBandEnergyDb(gainsDb, centresHz, sampleRate, signal);
  let iterations = 0;
  let clamped = false;
  /** The un-compensated gains. Whatever else happens, the result must not be
   * worse than this — that is what "pre-compensated" has to mean. */
  const start = snapshot(gainsDb, realisedDb);
  let best = start;
  let last = start;

  while (iterations < SOLVE_MAX_PASSES && best.errorDb > SOLVE_TOLERANCE_DB) {
    for (let i = 0; i < centresHz.length; i++) {
      if (!solvable[i]) continue;
      const next = gainsDb[i] + ((targetDb[i] ?? 0) - realisedDb[i]);
      if (Math.abs(next) > GRAPHIC_EQ_MAX_ABS_DB) clamped = true;
      gainsDb[i] = Math.max(-GRAPHIC_EQ_MAX_ABS_DB, Math.min(GRAPHIC_EQ_MAX_ABS_DB, next));
    }
    realisedDb = realisedBandEnergyDb(gainsDb, centresHz, sampleRate, signal);
    iterations++;
    last = snapshot(gainsDb, realisedDb);
    if (last.errorDb < best.errorDb) best = last;
  }

  const pick = last.errorDb > start.errorDb + SOLVE_TOLERANCE_DB ? best : last;
  return {
    gainsDb: pick.gainsDb,
    realisedDb: pick.realisedDb,
    iterations,
    worstErrorDb: pick.errorDb,
    clamped,
  };
}
