/**
 * Task F10 — the Cover Chain.
 *
 * The aspiration behind it, in the user's words, is "a one shot killer cover …
 * by a single take of voice in one tool". What this actually is, said plainly
 * because the project rule is that no name may be factually wrong: a pass that
 * MATCHES a new vocal take to the original singer's, measured against the
 * original vocal that separation hands over as a signal. It corrects timbre and
 * level. It does not transform a performance, and it cannot invent one.
 *
 * ── It composes; it does not re-implement ───────────────────────────────────
 * Every stage that touches audio goes through `runEffectOnChannels`, the same
 * worker leg `runEffectOnSelection` and `runVocalChain` use, and the whole run
 * lands with ONE `applyEdit`. The stage shape, the `derive*` family, the
 * `StageResolution` contract, `DerivedValue` and the `manual` status are the
 * vocal chain's, imported rather than copied.
 *
 * ── What ships, and what the measurements refused ───────────────────────────
 * `.superpowers/sdd/task-F10-analysis-report.md` is the record, measured against
 * a ground truth a user will not have (the official instrumental release of the
 * same song, so `mix - g * instrumental` IS the original vocal). It decided:
 *
 *   - EQ / spectral match SHIPS, bounded to +-10.9 dB and restricted to 500 Hz
 *     upward — below that the separated reference is measurably not the vocal.
 *   - Loudness match SHIPS, on a gated level, +9.61 dB on the reference
 *     material against a 0.08 dB reference-induced error.
 *   - DYNAMICS MATCHING DOES NOT SHIP. The move it would ask for changes SIGN
 *     across the gate sweep (+0.43 / -0.88 / -3.55 / -9.71 / -6.71 dB at
 *     K = 15 / 20 / 25 / 30 / 40). A quantity whose sign depends on an analysis
 *     parameter is not a measurement, and a knob that moves for reasons the user
 *     cannot attribute is worse than no knob. `activeEnvelopeSpread` is still
 *     REPORTED, before and after, because the number is informative even though
 *     no correction may be derived from it.
 *   - Reverb match ships as a stage that DECLINES on this material, deriving its
 *     refusal rather than hardcoding it: the original vocal measures 0.40 s and
 *     the shortest decay `ReverbEffect` can produce is 0.710 s. It will engage
 *     on a song whose vocal actually carries a room.
 *
 * ── Ruling A, the headline limitation ───────────────────────────────────────
 * The instrumental a cover is laid over still contains the original singer. That
 * is stated to the user BEFORE the chain runs, with the measured figure, and
 * NOT as a per-song computed number — three run-time estimators were tried and
 * all three were rejected (see the report's §1.5). See
 * `COVER_CHAIN_RESIDUAL_SENTENCE`.
 */

import { cloneRegion, docLength, replaceRegion } from '../audio/AudioDocument';
import { defaultParamsFor } from '../effects/EffectRegistry';
import { GRAPHIC_EQ_BANDS } from '../effects/eq/GraphicEqEffect';
import type { EffectParamValue } from '../effects/types';
import { peakDb } from '../dsp/chainAnalysis';
import {
  ACTIVE_GATE_DB,
  MATCH_BAND_CENTRES_HZ,
  MATCH_BOUND_DB,
  MATCH_MIN_CENTRE_HZ,
  activeEnvelopeSpread,
  estimateDecay,
  gatedLevelDb,
  longTermAverageSpectrum,
  matchCurve,
  reverbRt60Seconds,
  type ActiveSpread,
  type DecayEstimate,
  type Ltas,
  type MatchBandStatus,
} from '../dsp/coverMatch';
import { measureNoiseWindow, measureStageDelta, type StageDelta } from '../dsp/chainAnalysis';
import { SOLVE_TOLERANCE_DB, solveCascadeGains } from '../dsp/graphicEqCascade';
import { useAppStore } from '../stores/appStore';
import { applyEdit, type MarkerRemap } from './editOps';
import { reportEffectFailure, runEffectOnChannels, type EffectRunOutput } from './effectRunner';
import { resolveRegion } from './selectionRegion';
import {
  announceMeasuring,
  clampToParam,
  stageRenderingDetail,
  type ChainStageProgress,
  type DerivedValue,
  type StageStatus,
} from './vocalChain';

export const COVER_CHAIN_UNDO_LABEL = 'Cover Chain';

// ── Ruling A: the measured figures, stated as documentation ─────────────────
// Every number here is from the 132 vocal-active usable seconds of the
// reference song, measured against ground truth. They are CONSTANTS rather than
// a run-time estimate on purpose: the report's §1.5 records three plausible
// per-song estimators, all three of which were measured and rejected — one was
// degenerate by construction, one claimed 84 % of the bed's bass was leaked
// vocal on seconds containing no vocal at all, and the third agreed to 0.5 dB in
// one formulation and was out by 11 dB in another. A number wearing the
// authority of a measurement it has not earned is worse than a stated fact.

/** The residual original vocal, dB below the bed, over vocal-active seconds. */
export const RESIDUAL_BELOW_BED_DB = 17.95;
/** The same residual, dB below the original vocal itself — i.e. how far under
 * YOUR cover the ghost of the original singer will sit once the loudness match
 * has put your take at the original vocal's level. Stated in the sentence
 * because Ruling A's premise is that every measured figure here is one the user
 * is actually shown. */
export const RESIDUAL_BELOW_VOCAL_DB = 11.28;
/** The worst usable second measured (t = 146 s). */
export const RESIDUAL_WORST_SECOND_DB = 8.9;
/** Where it concentrates — the band a lead vocal occupies. */
export const RESIDUAL_BAND_LO_HZ = 250;
export const RESIDUAL_BAND_HI_HZ = 4000;
/** How far below the music it sits inside that band, best and worst octave. */
export const RESIDUAL_IN_BAND_BEST_DB = 11.8;
export const RESIDUAL_IN_BAND_WORST_DB = 9.5;

// V4 — the obvious remedy, measured with the real model before it was believed.
//
// A user looking at that residual asks the same question every time, and this
// pair came from one: "maybe do a more targeted second pass on what's left".
// It was answered by measuring rather than by arguing — four real model passes
// over a constructed mix whose bed is known to the sample, with the ghost read
// by the SAME `longTermAverageSpectrum` + `bandLevelDb` these figures name.
// The verdict, the gate it was judged against and every level are committed in
// `docs/bench/stem-second-pass-rejected.json`; the probe that produced them is
// `scripts/stem-second-pass-probe.cjs`, and the reasoning is in
// `docs/KNOWN_LIMITATIONS.md`.
//
// The numbers are stated to the user for the same reason all the others are:
// the suggestion is a good one, it is the first thing anyone would try, and the
// only thing that closes it permanently is a measurement they can see.

/** What a second pass over the instrumental moves the residual by, in the band
 * above. Zero — not "a little": the model's second answer is its first one. */
export const RESIDUAL_SECOND_PASS_DB = 0.0;
/** The largest per-octave move in that band, so the zero above is bounded
 * rather than rounded. */
export const RESIDUAL_SECOND_PASS_WORST_OCTAVE_DB = 0.04;

/**
 * Ruling A, in one sentence, rendered verbatim wherever the limitation is
 * stated. Same idiom as `ALIGN_ACCURACY_SENTENCE`: one string, so the UI, the
 * stage note and the docs cannot drift apart.
 */
export const COVER_CHAIN_RESIDUAL_SENTENCE =
  `The instrumental separation leaves behind is NOT clean: it still contains the original singer, ` +
  `measured ${RESIDUAL_BELOW_BED_DB} dB below the music overall — ${RESIDUAL_BELOW_VOCAL_DB} dB below ` +
  `the original vocal itself — and only ` +
  `${RESIDUAL_IN_BAND_WORST_DB}–${RESIDUAL_IN_BAND_BEST_DB} dB below it across ` +
  `${RESIDUAL_BAND_LO_HZ} Hz–${RESIDUAL_BAND_HI_HZ / 1000} kHz, the band your own voice occupies ` +
  `(worst measured second: ${RESIDUAL_WORST_SECOND_DB} dB). You will hear a ghost of the original ` +
  `singer under your cover, most audibly in sparse passages. Separation's guarantee is that the ` +
  `stems sum back to the mix exactly; it never was that each stem is perceptually clean. ` +
  // V4: and the remedy everyone reaches for first, closed off with its own
  // measurement rather than left open to be re-suggested every release.
  `Running a SECOND pass over that instrumental does not help, and that was measured rather than ` +
  `assumed: it moves the residual ${RESIDUAL_SECOND_PASS_DB.toFixed(2)} dB in that band ` +
  `(worst octave ${RESIDUAL_SECOND_PASS_WORST_OCTAVE_DB.toFixed(2)} dB). What is left is precisely ` +
  `what the model already decided was music, so asking the same model the same question a second ` +
  `time gets the same answer.`;

/**
 * Ruling D, first half. The match is a gentle shaping, and the name must not
 * promise otherwise: on the reference material the curve is +-1.2 dB across
 * 500 Hz–4 kHz with +3.5 dB of air at 8 kHz.
 */
export const COVER_CHAIN_SHAPING_SENTENCE =
  `This matches your take's TONE and LEVEL to the original singer's — on the song it was measured ` +
  `on, a shaping of about ±1.2 dB across 500 Hz–4 kHz with +3.5 dB of air at 8 kHz. It is a real, ` +
  `measured correction and it is a small one.`;

/**
 * The gate sweep that cut the dynamics match, as data rather than as prose.
 *
 * FIVE points, and the fifth is the one that matters: the move changes SIGN
 * between K = 15 and K = 20 and then reverses direction again at K = 40, so the
 * quantity is a property of the analysis gate rather than of the singer. Quoting
 * only the first four reads as a single clean downward trend, which is a weaker
 * and different claim than the measurement made.
 *
 * A constant rather than a sentence typed twice: the dialog and the module
 * header state the same sweep, and they had already drifted.
 */
export const SPREAD_GATE_SWEEP: readonly { gateDb: number; moveDb: number }[] = [
  { gateDb: 15, moveDb: 0.43 },
  { gateDb: 20, moveDb: -0.88 },
  { gateDb: 25, moveDb: -3.55 },
  { gateDb: 30, moveDb: -9.71 },
  { gateDb: 40, moveDb: -6.71 },
];

/** Ruling D's dynamics half, rendered verbatim wherever the spread is shown. */
export const COVER_CHAIN_SPREAD_SENTENCE =
  `The envelope spread is reported and NEVER corrected. A “matched compressor” was measured and cut: ` +
  `the move it would have asked for changes sign, and then changes direction again, depending only on ` +
  `how the measurement is gated (` +
  SPREAD_GATE_SWEEP.map(
    (p) => `${p.moveDb >= 0 ? '+' : '−'}${Math.abs(p.moveDb).toFixed(2)} dB at ${p.gateDb} dB`
  ).join(' / ') +
  `). A quantity whose sign depends on an analysis parameter is not a measurement of the singer.`;

/** Ruling D, second half. Correction cannot invent a performance. */
export const COVER_CHAIN_GOOD_TAKE_SENTENCE =
  `A single take still has to be a good take. Nothing here fixes a phrase that was sung wrong, and ` +
  `nothing here decides which words came out badly — you choose that, in Align Lyrics.`;

/**
 * Ruling E. Key and tempo both need the user to confirm the target, and the
 * reference song is the proof: its drums track at ~160 BPM while five other
 * sources agree at ~109, every confidence between 0.003 and 0.167 against the
 * app's own 0.35 threshold. Both grids are musically defensible, so an automatic
 * pick would be a coin flip that silently makes every correction ⅔ or 1.5×
 * wrong.
 */
export const COVER_CHAIN_CONFIRM_SENTENCE =
  `Key and tempo are not decided for you. Pitch and timing each need you to confirm the target ` +
  `first: on the song this was measured on the drums read ~160 BPM while everything else read ~109, ` +
  `every confidence below the app's own threshold — an automatic pick would have been a coin flip.`;

// ── The stages ──────────────────────────────────────────────────────────────

export type CoverChainStageId =
  | 'separate'
  | 'clean'
  | 'lyrics'
  | 'timing'
  | 'matchEq'
  | 'matchReverb'
  | 'matchLoudness'
  | 'headroom'
  | 'place';

export interface CoverChainStage {
  id: CoverChainStageId;
  label: string;
  /** The registered effect this stage runs, or `null` when it is not an
   * unattended stage at all. Five stages are like that, and each one for a
   * reason the measurements produced rather than for convenience: separation
   * needs a model run and produces new documents; the vocal chain is its own
   * one-undo-entry pass over the take; Align Lyrics needs the user to pick the
   * word (a per-phone scorer measured AUC 0.642 against a 0.500 baseline and was
   * cut); Align Vocal Timing needs a confirmed grid (Ruling E); and placing the
   * cover on the bed creates a session rather than editing this region. */
  effectId: string | null;
  defaultEnabled: boolean;
  /** Why the stage sits where it does, and why it is on or off. Shown verbatim:
   * a stage the user cannot reason about is a stage that ran without being
   * seen. */
  note: string;
  /**
   * Share of the progress bar. MEASURED in-loop wall times on the reference
   * material — the 142 s take at 48 kHz stereo against the 178 s separated
   * original vocal at 44.1 kHz — as a percentage of the 4.04 s the four
   * automatic stages take together, with a floor of 1 so no stage is invisible:
   * Match EQ 2.28 s (the take's long-term spectrum is 1.75 s of it, the EQ pass
   * 0.52 s, the pre-compensating solve 1 ms), Match Loudness 0.03 s, Limiter
   * 0.43 s, Match Reverb 1.31 s WHEN IT ENGAGES — its decline costs nothing.
   *
   * The reference's own measurements are NOT in these shares because they are
   * not in the loop: they run once before the first stage (its spectrum 1.86 s,
   * its gated level 0.33 s, its decay fit 0.06 s), which is what the dialog's
   * "Starting…" line covers.
   */
  weight: number;
}

export const COVER_CHAIN_STAGES: readonly CoverChainStage[] = [
  {
    id: 'separate',
    label: 'Separate the Original',
    effectId: null,
    defaultEnabled: false,
    note: `Not an automatic stage — it runs a model over the whole song and produces five new documents, so it is its own pass. Run Pipeline → Separate into Stems on the original mix FIRST, then pick its “— Vocals” document as the reference above: that separated vocal, carrying whatever was done to it in the mix, is what everything below matches against. ${COVER_CHAIN_RESIDUAL_SENTENCE}`,
    weight: 0,
  },
  {
    id: 'clean',
    label: 'Vocal Chain on the Take',
    effectId: null,
    defaultEnabled: false,
    note: 'Not an automatic stage — it is its own multi-stage pass with its own single undo entry, and running it inside this one would hide eleven stages behind one line. Run Pipeline → Vocal Chain on the take FIRST. It removes noise, hum and DC, gates the pauses between phrases down to silence, corrects pitch, and sets a compressor, de-esser and high-pass from the take\'s own levels. It ends on a limiter, but that one derives nothing: a ceiling is an absolute level, so it runs at the effect\'s own −0.3 dBFS. The match below is a correction to a CLEAN take: matching the timbre of a noisy one matches the noise too.',
    weight: 0,
  },
  {
    id: 'lyrics',
    label: 'Align Lyrics (word repair)',
    effectId: null,
    defaultEnabled: false,
    note: `Not an automatic stage, and deliberately never will be: it lets you replace ONE word you pick with a fresh take of just that word, and nothing in it judges which word that should be — a per-phone quality scorer was built, measured 0.642 AUC against a 0.500 chance baseline, and was cut. Run Pipeline → Align Lyrics BEFORE the vocal chain, so the replacement is in the file before any stage measures a level or learns a noise print from it. ${COVER_CHAIN_GOOD_TAKE_SENTENCE}`,
    weight: 0,
  },
  {
    id: 'timing',
    label: 'Align Vocal Timing',
    effectId: null,
    defaultEnabled: false,
    note: `Not an automatic stage. Run Pipeline → Align Vocal Timing FIRST if your take drifts against the original: it needs you to confirm the beat grid and the syllable moves before it warps anything. ${COVER_CHAIN_CONFIRM_SENTENCE}`,
    weight: 0,
  },
  {
    id: 'matchEq',
    label: 'Match EQ to the Original Vocal',
    effectId: 'graphic-eq',
    defaultEnabled: true,
    note: `Compares the long-term octave-band energy of your take with the separated original vocal's and realises the difference on the Graphic EQ. From ${MATCH_MIN_CENTRE_HZ} Hz up ONLY, and bounded to ±${MATCH_BOUND_DB} dB — both measured: below ${MATCH_MIN_CENTRE_HZ} Hz the separated reference is mostly not the vocal (at 125 Hz its own separation error EXCEEDS it by 5.1 dB), and ${MATCH_BOUND_DB} dB is the weakest retained band's own signal-to-separation-error ratio, past which a "match" would be correcting the separation rather than the singer. The broadband level difference is taken out of this curve and handed to Match Loudness, so this stage carries shape only. The curve it reports is the one the EQ cascade MEASURABLY delivers, not the one it was asked for: the cascade's bands overlap, so a request of +6 dB leaks 1.15 dB an octave away, and the gains are pre-compensated for that.`,
    weight: 56,
  },
  {
    id: 'matchReverb',
    label: 'Match Reverb',
    effectId: 'reverb',
    defaultEnabled: false,
    note: `Off by default, and on most material it will DECLINE rather than run. It estimates the original vocal's decay by ISO 3382-1's T20 method — validated against the app's own reverb at 1.26 s where the closed form says 1.45 s and 2.92 s where it says 3.20 s — and then compares it with the shortest decay this app's Reverb can produce. On the song this was measured on the original vocal reads 0.40 s against a floor of 0.710 s, so matching it would add nearly twice the space that is actually there, and the stage says so instead. Turning it on lengthens the region by the tail. It runs AFTER the EQ and BEFORE both level stages, because a tail moves the level and the peak — measured on a 30 s vocal, this reverb's own default room lifts the sounding level by 1.88 dB — so Match Loudness and the Limiter have to be the ones that see it last.`,
    weight: 32,
  },
  {
    id: 'matchLoudness',
    label: 'Match Loudness',
    effectId: 'amplify',
    defaultEnabled: true,
    note: 'Sets your take to the original vocal\'s level, measured over the SOUNDING parts of each — an ungated comparison carries a bias that is a fact about how much silence each file contains rather than about how loud the singing is (0.7 dB of it on the reference material). Runs after the EQ, because the EQ handed it the level it deliberately left out of its curve, and after Match Reverb, because a tail moves the very level this stage is setting.',
    weight: 1,
  },
  {
    id: 'headroom',
    label: 'Limiter (headroom)',
    effectId: 'limiter',
    defaultEnabled: true,
    note: 'The loudness match is arithmetic and has no view on headroom, so this stage owns it, at −0.3 dBFS. Last of every stage that touches the audio, so nothing downstream can lift the output back over the ceiling — and that is load-bearing rather than tidy. Match Reverb used to run after it, and a signal limited to −0.3 dBFS with this reverb on top of it comes back OVER full scale: measured at the reverb\'s SHORTEST room, +0.37 dBFS on a 220 Hz tone and +5.34 dBFS on noise, rising to +2.66 and +7.76 at its longest. Both the WAV and the MP3 writer hard-clip that. Measured end to end on the song this was built from it had NOTHING to catch, and says so: the match asked for +9.50 dB and the peak landed at −0.84 dBFS, because the EQ\'s cuts at 1–4 kHz had already taken 0.67 dB off the peak before the gain went on. It earns its place on a take with more crest than that one — and on any take with Match Reverb on. Switch it off and Match Loudness will say, with the number, if the result would pass 0 dBFS.',
    weight: 11,
  },
  {
    id: 'place',
    label: 'Place on the Instrumental',
    effectId: null,
    defaultEnabled: false,
    note: `Not an automatic stage — it builds a session rather than editing this take. Separate into Stems already laid the original down as a five-track session; mute its “Vocals” track, then drag this document in as a new track. ${COVER_CHAIN_RESIDUAL_SENTENCE}`,
    weight: 0,
  },
];

export function coverStageById(id: CoverChainStageId): CoverChainStage {
  const stage = COVER_CHAIN_STAGES.find((s) => s.id === id);
  if (!stage) throw new Error(`Unknown cover chain stage: ${id}`);
  return stage;
}

/** The enabled-map the UI opens with. */
export function defaultCoverStageSelection(): Record<CoverChainStageId, boolean> {
  const out = {} as Record<CoverChainStageId, boolean>;
  for (const stage of COVER_CHAIN_STAGES) out[stage.id] = stage.defaultEnabled;
  return out;
}

// ── What one match stage worked out ─────────────────────────────────────────

/** One band of the realised match curve. `targetDb` is what the measurement
 * asked for; `realisedDb` is what the cascade delivers there and is the number
 * shown to the user (Ruling B). */
export interface MatchEqBandReport {
  centreHz: number;
  status: MatchBandStatus;
  targetDb: number;
  realisedDb: number;
  /** The gain actually handed to the Graphic EQ — pre-compensated, so it differs
   * from `targetDb` by the leak it is cancelling. */
  bandGainDb: number;
  bounded: boolean;
}

export interface MatchEqDetail {
  bands: MatchEqBandReport[];
  /** The broadband level the curve did NOT carry — Match Loudness's job. */
  levelDb: number;
  /** Largest |realised − target| across the matched bands, after solving. */
  worstErrorDb: number;
  /** Refinement passes the pre-compensation took. */
  iterations: number;
  /** True when a pre-compensated gain hit the Graphic EQ's own ±12 dB range. */
  clamped: boolean;
  matchedCount: number;
}

/** A cover-chain stage's resolution. Same contract as the vocal chain's, plus
 * the two fields a match stage needs. Both are DECLARED rather than smuggled
 * through `extra: unknown`, so a branch that forgets one is a compile error. */
export type CoverStageResolution =
  | {
      run: true;
      params: Record<string, EffectParamValue>;
      derived: DerivedValue[];
      eq?: MatchEqDetail;
      /** Something the user must read that is not a refusal — a stage that will
       * run, but whose result needs a caveat with a number on it. */
      warning?: string;
    }
  | { run: false; reason: string };

const dbStr = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)} dB`;
const dbfsStr = (v: number): string => `${v.toFixed(2)} dBFS`;

// ── Derivations ─────────────────────────────────────────────────────────────

/** What the reference vocal contributes, measured once per run. Every field is
 * `null` when there is no reference document to measure. */
export interface ReferenceMeasurements {
  ltas: Ltas | null;
  gatedLevelDb: number | null;
  decay: DecayEstimate | null;
  sampleRate: number;
  name: string;
  /**
   * CC4 (CJ-3): the sounding level of the MIX this reference was separated
   * from, when the caller knows what that mix is — the cover journey always
   * does, the standalone chain never does (there the user picks any document
   * they like as the reference, and this module has no business second-guessing
   * that choice). `null` switches the plausibility floor below off entirely.
   */
  mixGatedLevelDb: number | null;
  /** The mix's name, for the floor's decline reason. `null` with the level. */
  mixName: string | null;
}

/**
 * CC4 (CJ-3) — how far below its own mix a separated vocal may sit before this
 * chain stops believing it is a vocal at all.
 *
 * DERIVED, not chosen, and from a constant this app already ships:
 * `ACTIVE_GATE_DB` (20 dB) is the span below a signal's own p95 at which
 * `coverMatch` already declares material NOT SOUNDING. A Vocals stem whose own
 * sounding level sits more than that below the song's own would not clear the
 * song's activity gate — by the app's existing definition it is not the lead
 * vocal, it is what the separator swept there.
 *
 * The two measurements this repo owns bracket it, which is why one number can
 * serve both ends:
 *
 *  - `RESIDUAL_BELOW_BED_DB` = 17.95 dB is where vocal content the separator
 *    FAILED to extract sits relative to the music. Vocal content that is really
 *    present therefore reads no lower than that against the mix even in the
 *    separator's worst case, so the floor must sit ABOVE 17.95 dB or it would
 *    decline on real vocals.
 *  - The measured pathology is 41.29 dB down (a real model run over the smoke's
 *    synthetic mix: source −17.99 dBFS, Vocals −59.28 dBFS,
 *    `scripts/e2e-smoke.cjs`), so the floor must sit well below 41.29.
 *
 * 20 dB is the app's own gate span sitting inside that bracket with 2 dB of
 * margin on one side and 21 dB on the other. It is a floor on PLAUSIBILITY, not
 * an opinion about mixing: a lead vocal 20 dB under the full mix is not audible
 * in the song it came from.
 */
export const REFERENCE_BELOW_MIX_FLOOR_DB = ACTIVE_GATE_DB;

/**
 * CC4 (CJ-3) — how far the reference sits below its mix, or `null` when the
 * comparison cannot be made (no mix supplied, or either side not sounding).
 */
export function referenceBelowMixDb(reference: ReferenceMeasurements | null): number | null {
  if (!reference) return null;
  if (reference.gatedLevelDb === null || reference.mixGatedLevelDb === null) return null;
  return reference.mixGatedLevelDb - reference.gatedLevelDb;
}

/**
 * CC4 (CJ-3) — the decline reason when the reference is implausibly quiet
 * against its own mix, or `null` when it is not. ONE sentence, shared by every
 * stage that would otherwise match against it, so the two stages cannot end up
 * describing the same measurement two different ways.
 */
export function implausibleReferenceReason(
  reference: ReferenceMeasurements | null
): string | null {
  const belowDb = referenceBelowMixDb(reference);
  if (belowDb === null || belowDb <= REFERENCE_BELOW_MIX_FLOOR_DB) return null;
  const ref = reference as ReferenceMeasurements;
  return (
    `${ref.name} sounds at ${dbfsStr(ref.gatedLevelDb as number)} against ` +
    `${ref.mixName}'s own ${dbfsStr(ref.mixGatedLevelDb as number)} — ${belowDb.toFixed(2)} dB below the ` +
    `song it came out of, past the ${REFERENCE_BELOW_MIX_FLOOR_DB} dB this chain will believe. A lead ` +
    `vocal is not that far under its own mix, so this is a separation that left the singing ` +
    `somewhere else and returned leakage; matching to it would shape and level your take against ` +
    `the wrong signal. Nothing was changed. Check the “— Vocals” document: if it is not the ` +
    `original singer, separate the song again or pick a different reference.`
  );
}

/**
 * Match EQ — the spectral match, pre-compensated and reported as realised.
 *
 * Declines when there is no reference to match against, when either spectrum has
 * no sounding frame to average, or when no band survives the measured range: the
 * curve is restricted to `MATCH_MIN_CENTRE_HZ` upward and to octaves lying
 * entirely below BOTH spectra's Nyquist, and on a narrow-band or low-rate pair
 * that can leave nothing.
 */
export function deriveMatchEq(
  reference: ReferenceMeasurements | null,
  take: Float32Array[],
  sampleRate: number
): CoverStageResolution {
  if (!reference || !reference.ltas) {
    return {
      run: false,
      reason: 'no original vocal chosen to match against — separate the original mix and pick its Vocals document above',
    };
  }
  if (reference.ltas.frames === 0) {
    return {
      run: false,
      reason: `nothing in ${reference.name} rises above its own gate, so there is no spectrum to match to`,
    };
  }
  // CC4 (CJ-3): a leakage-only stem HAS frames — that is the whole problem —
  // so the emptiness guards above cannot catch it. Shaping toward a leakage
  // spectrum is a real, bounded, wrong correction.
  const implausible = implausibleReferenceReason(reference);
  if (implausible) return { run: false, reason: implausible };
  const takeLtas = longTermAverageSpectrum(take, sampleRate);
  if (takeLtas.frames === 0) {
    return {
      run: false,
      reason: 'nothing in this take rises above its own gate, so there is no spectrum to match',
    };
  }

  const curve = matchCurve(reference.ltas, takeLtas);
  if (curve.matchedCount === 0) {
    return {
      run: false,
      reason: `no octave band survives the measured range — the match runs from ${MATCH_MIN_CENTRE_HZ} Hz up, and only over octaves lying entirely below both recordings' Nyquist (${(Math.min(reference.sampleRate, sampleRate) / 2 / 1000).toFixed(1)} kHz here)`,
    };
  }

  const targets = curve.bands.map((b) => b.gainDb);
  const solvable = curve.bands.map((b) => b.status === 'matched');
  // `takeLtas` is the weighting, not a convenience: the realised figures are the
  // change this cascade makes to THIS take's octave energies, which is what
  // `bandLevelDb` will read back off the processed audio. Solving and reporting
  // against an unweighted average would assume the take is flat across every
  // octave — measurably wrong by up to 0.94 dB on real singing.
  const solution = solveCascadeGains(targets, MATCH_BAND_CENTRES_HZ, sampleRate, solvable, takeLtas);

  const params = defaultParamsFor('graphic-eq');
  GRAPHIC_EQ_BANDS.forEach((band, i) => {
    params[band.id] = clampToParam('graphic-eq', band.id, solution.gainsDb[i]);
  });

  const bands: MatchEqBandReport[] = curve.bands.map((b, i) => ({
    centreHz: b.centreHz,
    status: b.status,
    targetDb: b.gainDb,
    realisedDb: solution.realisedDb[i],
    bandGainDb: Number(params[GRAPHIC_EQ_BANDS[i].id]),
    bounded: b.bounded,
  }));

  const matched = bands.filter((b) => b.status === 'matched');
  const lo = Math.min(...matched.map((b) => b.realisedDb));
  const hi = Math.max(...matched.map((b) => b.realisedDb));
  const boundedCount = matched.filter((b) => b.bounded).length;

  const derived: DerivedValue[] = [
    {
      label: 'Curve',
      value: `${matched.length} band${matched.length === 1 ? '' : 's'}, ${dbStr(lo)} to ${dbStr(hi)}`,
      from: `the octave-band energy of ${reference.name} minus this take's, over the sounding frames of each, from ${MATCH_MIN_CENTRE_HZ} Hz up`,
    },
    {
      label: 'Level removed',
      value: dbStr(curve.levelDb),
      from: 'the broadband difference, taken out of the curve and handed to Match Loudness — this stage carries shape only',
    },
    {
      label: 'Realised',
      value:
        solution.worstErrorDb > SOLVE_TOLERANCE_DB
          ? `up to ${solution.worstErrorDb.toFixed(2)} dB SHORT of the target`
          : `within ${solution.worstErrorDb.toFixed(3)} dB of the target`,
      from: `the cascade's measured effect on THIS take's octave-band energy after ${solution.iterations} pre-compensation pass${solution.iterations === 1 ? '' : 'es'} — the Realised column in the table below is what the audio receives, not what was requested`,
    },
  ];
  if (boundedCount > 0) {
    derived.push({
      label: 'Bounded',
      value: `${boundedCount} band${boundedCount === 1 ? '' : 's'} cut to ±${MATCH_BOUND_DB} dB`,
      from: 'the weakest retained band\'s own signal-to-separation-error ratio — a larger correction would be correcting the separation, not the singer',
    });
  }

  const eq: MatchEqDetail = {
    bands,
    levelDb: curve.levelDb,
    worstErrorDb: solution.worstErrorDb,
    iterations: solution.iterations,
    clamped: solution.clamped,
    matchedCount: curve.matchedCount,
  };

  // The pre-compensation does not always reach the target: a band-energy move
  // near the ±10.9 dB bound is not reachable at all through a ±12 dB band gain
  // once the cascade's roll-off across the octave is accounted for. Measured at
  // 48 kHz, a lone band at the +12 dB rail delivers +9.73 dB of band energy at
  // 500 Hz and +9.17 dB at 8 kHz, and −12 dB delivers −8.91 to −7.94 dB.
  // Ruling B's requirement is that the shortfall is SAID, not that it never
  // happens — the Realised column of the per-band table already shows it band by
  // band, and this is the line that makes it impossible to miss. Both this
  // sentence and the derived row above point DOWN at that table, because
  // `StageResult` renders the warning first, then the derived rows, then the
  // table (CoverChainDialog.tsx:149-171).
  // EVERY band that fell short, not just the worst one. Naming only the worst
  // leaves the others "short and silent" — shown in the table, but not in the
  // line that exists to make a shortfall impossible to miss — and which bands
  // fall short is not a property of one fixture: any run whose solve ends above
  // tolerance can leave several.
  const short = matched
    .filter((b) => Math.abs(b.realisedDb - b.targetDb) > SOLVE_TOLERANCE_DB)
    .sort((a, b) => Math.abs(b.realisedDb - b.targetDb) - Math.abs(a.realisedDb - a.targetDb));
  const warning =
    short.length > 0
      ? `the EQ could not fully deliver this curve. ` +
        short
          .map(
            (b) =>
              // The direction word FOLLOWS the sign. `Math.abs` alone printed
              // "short" over a band the cascade landed ABOVE its target — on a
              // cut band that is the common case (wanted -10.90 dB, realised
              // -6.61 dB, reported "4.29 dB short"), and it contradicts the two
              // signed figures standing beside it in the same sentence.
              `At ${b.centreHz} Hz it wanted ${dbStr(b.targetDb)} and realised ${dbStr(b.realisedDb)}, ${Math.abs(b.realisedDb - b.targetDb).toFixed(2)} dB ${b.realisedDb > b.targetDb ? 'over' : 'short'}`
          )
          .join('; ') +
        `${solution.clamped ? ` — the solve ran into the Graphic EQ's own ±12 dB limit` : ''}. The Realised column in the table below is what the audio received.`
      : undefined;

  return { run: true, params, derived, eq, warning };
}

/**
 * Match Loudness — the gated level difference, and the headroom it forces.
 *
 * The gain is arithmetic. What is not arithmetic is the gate: over the reference
 * material an UNGATED comparison of the same two files is biased by 0.7 dB purely
 * because 88.5 % of the take is sounding against 75.8 % of the separated
 * reference. `gatedLevelDb` uses BS.1770-4's relative-gate structure and is
 * deliberately not called LUFS — there is no K-weighting and no 400 ms block
 * structure, and the name would be factually wrong.
 *
 * Ruling C: +9.61 dB puts the reference take's peak at -0.07 dBFS. The decision
 * is a limiter stage AFTER this one at the app's own -0.3 dBFS ceiling. With
 * that stage switched off, this one WARNS with the measured peak rather than
 * shipping a silent clip.
 */
export function deriveMatchLoudness(
  reference: ReferenceMeasurements | null,
  take: Float32Array[],
  sampleRate: number,
  headroomEnabled: boolean
): CoverStageResolution {
  if (!reference || reference.gatedLevelDb === null) {
    return {
      run: false,
      reason: reference
        ? `nothing in ${reference.name} rises above its own gate, so it has no sounding level to match to`
        : 'no original vocal chosen to match against — separate the original mix and pick its Vocals document above',
    };
  }
  // CC4 (CJ-3): before the arithmetic, the plausibility of the number it is
  // about to trust. `gatedLevelDb` gates each signal against its own p95, so a
  // near-empty Vocals stem reports a perfectly finite level and this stage
  // would commit `reference − take` — measured at −41 dB on this repo's own
  // material — bounded only by Amplify's ±60 dB range.
  const implausible = implausibleReferenceReason(reference);
  if (implausible) return { run: false, reason: implausible };

  const takeLevel = gatedLevelDb(take, sampleRate);
  if (takeLevel === null) {
    return {
      run: false,
      reason: 'nothing in this take rises above its own gate, so it has no sounding level to move',
    };
  }

  const gainDb = clampToParam('amplify', 'gainDb', reference.gatedLevelDb - takeLevel);
  const peakBefore = peakDb(take);
  const peakAfter = peakBefore + gainDb;

  const derived: DerivedValue[] = [
    {
      label: 'Gain',
      value: dbStr(gainDb),
      from: `${reference.name}'s sounding level ${dbfsStr(reference.gatedLevelDb)} minus this take's ${dbfsStr(takeLevel)}, both measured over the sounding parts only`,
    },
    {
      label: 'Resulting peak',
      value: dbfsStr(peakAfter),
      from: `this take's ${dbfsStr(peakBefore)} peak plus that gain`,
    },
  ];

  const resolution: CoverStageResolution = { run: true, params: { gainDb }, derived };
  if (!headroomEnabled && peakAfter > 0) {
    return {
      ...resolution,
      warning: `this puts the peak at ${dbfsStr(peakAfter)}, above full scale, and the Limiter stage that would catch it is switched off — the file will clip when it is written or played`,
    };
  }
  return resolution;
}

/**
 * Match Reverb — derived refusal, not a hardcoded one.
 *
 * The estimator was validated before it was believed (1.26 s measured against a
 * 1.45 s closed form, 2.92 s against 3.20 s, 0.28 s on a dry take). What it says
 * about the reference material is that the original vocal decays in 0.40 s —
 * barely longer than dry — and the shortest decay `ReverbEffect` can produce at
 * `roomSize = 0` is 0.710 s. So the stage declines by COMPARING the two, which
 * means it will engage on a song whose vocal really does carry a room.
 *
 * Two limits are stated rather than corrected. The estimator reads 9–13 % SHORT
 * of the closed form on the app's own reverb, so a matched room size errs
 * slightly dry; and the linearity check cannot tell a curved fall from a real
 * decay (a pure amplitude ramp containing no reverberation at all scores a
 * higher minimum r² than either validated reverb control). No correction factor
 * is applied for either, because the only material available to calibrate one on
 * is material where this stage declines.
 */
export function deriveMatchReverb(
  reference: ReferenceMeasurements | null,
  sampleRate: number
): CoverStageResolution {
  if (!reference) {
    return {
      run: false,
      reason: 'no original vocal chosen to match against — separate the original mix and pick its Vocals document above',
    };
  }
  const floorSeconds = reverbRt60Seconds(0, sampleRate);
  if (reference.decay === null) {
    return {
      run: false,
      reason: `nothing in ${reference.name} decays cleanly enough to measure a reverb time from — no fall reached 25 dB below its peak along a straight enough line to be a tail rather than a gap between syllables`,
    };
  }
  const measured = reference.decay;
  if (measured.seconds < floorSeconds) {
    return {
      run: false,
      reason: `estimated decay ${measured.seconds.toFixed(2)} s (${measured.count} decays, quartiles ${measured.p25Seconds.toFixed(2)}–${measured.p75Seconds.toFixed(2)} s); the shortest this reverb can produce is ${floorSeconds.toFixed(2)} s, so matching it would add more space than the original has`,
    };
  }

  // Invert the effect's own closed form: rt60 = (60 / -20log10(g)) * (D / rate),
  // g = 0.7 + 0.28 * roomSize. Nothing new is chosen here — the law is
  // `reverbRt60Seconds`'s, read backwards.
  const delaySeconds = reverbRt60Seconds(0, sampleRate) * -20 * Math.log10(0.7) / 60;
  const dbPerLoop = (60 * delaySeconds) / measured.seconds;
  const feedback = Math.pow(10, -dbPerLoop / 20);
  const roomSize = clampToParam('reverb', 'roomSize', (feedback - 0.7) / 0.28);

  const params = defaultParamsFor('reverb');
  params.roomSize = roomSize;
  return {
    run: true,
    params,
    derived: [
      {
        label: 'Room size',
        value: roomSize.toFixed(2),
        from: `an estimated ${measured.seconds.toFixed(2)} s decay on ${reference.name} (${measured.count} decays, quartiles ${measured.p25Seconds.toFixed(2)}–${measured.p75Seconds.toFixed(2)} s), read back through this reverb's own decay law — the estimator measures this effect 9–13 % short, so the result errs slightly dry`,
      },
      {
        label: 'Mix',
        value: `${((Number(params.mix) || 0) * 100).toFixed(0)}%`,
        from: 'the effect\'s own default — the decay time is measurable from the reference, the wet/dry balance is not',
      },
    ],
  };
}

// ── The run ─────────────────────────────────────────────────────────────────

export interface CoverChainMetrics {
  /** Programme level over the SOUNDING part only — the quantity the match
   * equalises. `null` when nothing is sounding. */
  gatedLevelDb: number | null;
  peakDb: number;
  /** F7's active-envelope spread, p90 − p10. REPORTED, never corrected: the
   * dynamics match the analysis refused would have derived a compressor from
   * this, and its required move changes sign with the gate. */
  spreadDb: number | null;
  /** `null` when there is no passage above digital silence to measure. */
  noiseFloorDb: number | null;
  /**
   * How far this signal's octave-band SHAPE sits from the reference's, in dB
   * RMS across the matched bands with the broadband level removed. This is the
   * quantity Match EQ reduces, so before/after is the measurement that shows
   * whether it worked. `null` when there is no reference.
   */
  matchDistanceDb: number | null;
}

export interface CoverChainStageResult {
  id: CoverChainStageId;
  label: string;
  status: StageStatus;
  /** Present for `declined`: what was measured, and why that means nothing to do. */
  reason?: string;
  /** Present when the stage ran but the user must read something about it. */
  warning?: string;
  derived: DerivedValue[];
  /** Present for `applied`: what the stage did to the audio, measured. */
  delta?: StageDelta;
  /** Present for `applied` on Match EQ: the per-band curve, realised. */
  eq?: MatchEqDetail;
  detail?: string;
  elapsedMs?: number;
}

export interface CoverChainReport {
  before: CoverChainMetrics;
  after: CoverChainMetrics;
  /** The reference's own metrics — the target the match was aiming at. `null`
   * when no reference was chosen. */
  reference: CoverChainMetrics | null;
  referenceName: string | null;
  /**
   * CC4 (CJ-3): how far the reference sat below its own mix when that was
   * FURTHER than {@link REFERENCE_BELOW_MIX_FLOOR_DB} — i.e. the number that
   * made the match stages decline. `null` whenever the floor did not fire,
   * including every run with no mix supplied.
   */
  referenceImplausibleBelowDb: number | null;
  stages: CoverChainStageResult[];
  sampleRate: number;
  regionSamples: number;
  outputSamples: number;
  elapsedMs: number;
  applied: boolean;
}

/**
 * The shape distance between two long-term spectra: RMS of the centred per-band
 * differences over the bands the match is allowed to touch. Uses `matchCurve`'s
 * own band selection and centring, so "the distance" and "what the EQ corrects"
 * cannot describe different sets. `null` when no band matched.
 *
 * It is measured on `rawDb - levelDb` — the centred difference BEFORE the bound
 * — and not on `gainDb`, which is the same quantity after `MATCH_BOUND_DB` has
 * cut it. That is not a detail: `gainDb` saturates at 10.9 dB per band, so a
 * take sitting 30 dB below the reference in one octave would report a distance
 * of 8.48 dB where the shape difference is 12.99 dB, and because the before and
 * after readings saturate the same way the IMPROVEMENT this metric exists to
 * show would be compressed too. The bound is a limit on what the EQ may correct;
 * it is not a limit on how far apart two spectra are.
 */
export function matchDistanceDb(reference: Ltas, take: Ltas): number | null {
  const curve = matchCurve(reference, take);
  const matched = curve.bands.filter((b) => b.status === 'matched' && b.rawDb !== null);
  if (matched.length === 0) return null;
  let sum = 0;
  for (const b of matched) {
    const centred = (b.rawDb as number) - curve.levelDb;
    sum += centred * centred;
  }
  return Math.sqrt(sum / matched.length);
}

/**
 * `ownLtas` is this signal's OWN long-term spectrum when the caller already has
 * it. It exists to stop the reference document's spectrum being computed twice:
 * a three-minute LTAS is 1.86 s of work on the reference material, and the
 * second pass would produce a value that is zero by construction — the
 * reference's distance from itself.
 */
function measureMetrics(
  channels: Float32Array[],
  sampleRate: number,
  referenceLtas: Ltas | null,
  ownLtas: Ltas | null = null
): CoverChainMetrics {
  const spread: ActiveSpread | null = activeEnvelopeSpread(channels, sampleRate);
  const noise = measureNoiseWindow(channels, sampleRate);
  let distance: number | null = null;
  if (referenceLtas && referenceLtas.frames > 0) {
    const ltas = ownLtas ?? longTermAverageSpectrum(channels, sampleRate);
    if (ltas.frames > 0) distance = matchDistanceDb(referenceLtas, ltas);
  }
  return {
    gatedLevelDb: gatedLevelDb(channels, sampleRate),
    peakDb: peakDb(channels),
    spreadDb: spread ? spread.spreadDb : null,
    noiseFloorDb: noise ? noise.rmsDb : null,
    matchDistanceDb: distance,
  };
}

/**
 * Everything the reference's STAGES need, measured once per run and only for the
 * stages that are actually switched on. The long-term spectrum of a three-minute
 * file is thousands of FFTs (1.86 s on the reference material) and the decay fit
 * is a second scan of it; paying for either when its stage is off would be a
 * cost with no corresponding stage in the report.
 *
 * "Only for the stages that are on" is about the STAGES, and it is worth being
 * exact because the reference's spectrum is computed for one more reason: the
 * before/after `matchDistanceDb` is reported whenever a reference document is
 * open, whether or not Match EQ is on, because a run with only the loudness
 * stage still tells the user how far the timbre sits from the target. See
 * `metricLtas` in `runCoverChain`, which REUSES this one when Match EQ asked
 * for it and computes it once otherwise — never twice.
 */
export function measureReference(
  channels: Float32Array[],
  sampleRate: number,
  name: string,
  need: { ltas: boolean; level: boolean; decay: boolean },
  /**
   * CC4 (CJ-3): the MIX the reference was separated from, when the caller knows
   * it. One extra gated-level scan of the song — the same measurement the
   * reference already pays for, over material the caller is already holding —
   * and it is what makes {@link REFERENCE_BELOW_MIX_FLOOR_DB} checkable at all.
   * Omitted by the standalone chain, whose reference is whatever document the
   * user picked.
   */
  mix?: { channels: Float32Array[]; sampleRate: number; name: string } | null
): ReferenceMeasurements {
  return {
    ltas: need.ltas ? longTermAverageSpectrum(channels, sampleRate) : null,
    gatedLevelDb: need.level ? gatedLevelDb(channels, sampleRate) : null,
    decay: need.decay ? estimateDecay(channels, sampleRate) : null,
    sampleRate,
    name,
    mixGatedLevelDb: mix ? gatedLevelDb(mix.channels, mix.sampleRate) : null,
    mixName: mix ? mix.name : null,
  };
}

function resolveStage(
  stage: CoverChainStage,
  channels: Float32Array[],
  sampleRate: number,
  reference: ReferenceMeasurements | null,
  enabled: Partial<Record<CoverChainStageId, boolean>>
): CoverStageResolution {
  switch (stage.id) {
    case 'matchEq':
      return deriveMatchEq(reference, channels, sampleRate);
    case 'matchLoudness':
      return deriveMatchLoudness(reference, channels, sampleRate, enabled.headroom === true);
    case 'matchReverb':
      return deriveMatchReverb(reference, sampleRate);
    default:
      // The limiter's ceiling is an ABSOLUTE level by definition — the same
      // audit the vocal chain records. There is nothing level-relative to
      // derive, so it runs on the effect's own default.
      return { run: true, params: defaultParamsFor(stage.effectId as string), derived: [] };
  }
}

/**
 * The one-line "what it did" for a stage that knows something the buffers do not
 * show. `LimiterEffect` returns no `EffectReport`, so how much it caught is read
 * from the measured peaks rather than from a field that does not exist.
 *
 * The limiter's three cases are TOTAL, which they were not: a run that caught
 * 0.008 dB fell past the `> 0.01` branch, past `identicalFraction === 1`
 * (samples did change), and reported as applied with no detail at all. Below
 * 0.01 dB there is nothing worth printing to two decimals, so it says that
 * instead of saying nothing.
 *
 * Exported for its test: 0.01 dB of peak is not a quantity a fixture can be
 * built to land either side of through the real limiter, so the boundary is
 * probed on the `StageDelta` this function actually reads.
 */
export function describeStage(stage: CoverChainStage, delta: StageDelta): string | undefined {
  // The stage's OWN account first, because it is the more specific one.
  if (stage.id === 'headroom') {
    const caught = delta.peakBeforeDb - delta.peakAfterDb;
    if (caught > 0.01) return `caught ${caught.toFixed(2)} dB of peak`;
    // Ruling F: a stage that turned out to have nothing to do says so, measured
    // rather than assumed.
    return delta.identicalFraction === 1
      ? 'nothing to do — every sample came back unchanged'
      : 'nothing to catch — the peak was already under the ceiling';
  }
  if (delta.identicalFraction === 1) return 'nothing to do — every sample came back unchanged';
  return undefined;
}

/**
 * The over-scale path Ruling C left open in THIS chain, back-ported from the
 * vocal chain that borrowed the ruling (`vocalChain.ts`'s `stageWarning`, L4).
 *
 * Ruling C is that a stage whose result needs a caveat says the caveat with the
 * number on it and the run goes ahead — and `deriveMatchLoudness` is where it
 * was implemented. But that function is only ever resolved for a stage that is
 * SWITCHED ON, so with `{matchReverb: on, matchLoudness: off, headroom: off}`
 * nothing in the chain warned at all: the reverb sums a wet tail on top of the
 * dry signal and is then the last stage that touches the audio, which is
 * exactly the case the Limiter's own note measures at +0.37 dBFS on a 220 Hz
 * tone and +5.34 dBFS on noise at the reverb's SHORTEST room, rising to +2.66
 * and +7.76 at its longest. Both `encodeWav` and the MP3 encoder hard-clip
 * that, and nothing between here and the file said so.
 *
 * Three conditions, all observations rather than settings: the stage is Match
 * Reverb, neither level stage that runs after it is on, and the output ACTUALLY
 * came back over full scale. The last one is why this is not a banner — on
 * material the tail never takes over 0 dBFS there is nothing to warn about.
 *
 * `enabled` rather than "did it apply" is the same narrowing the vocal chain
 * has, and the residue is stated rather than hidden: Match Loudness switched ON
 * but DECLINING (a reference with no sounding level) leaves the peak
 * un-warned-about, because whether it declines is not known until after this
 * result is pushed. Every other arm is covered — with Match Loudness on and
 * running, `deriveMatchLoudness` measures the post-reverb take itself and
 * carries Ruling C's warning; with the Limiter on, the peak cannot pass the
 * ceiling in the first place.
 */
export function stageWarning(
  stage: CoverChainStage,
  delta: StageDelta,
  enabled: Partial<Record<CoverChainStageId, boolean>>
): string | undefined {
  if (stage.id !== 'matchReverb') return undefined;
  if (enabled.matchLoudness === true || enabled.headroom === true) return undefined;
  if (!(delta.peakAfterDb > 0)) return undefined;
  return `this stage summed a tail on top of the audio and the output now peaks at ${dbfsStr(delta.peakAfterDb)}, above full scale. Both level stages that run after it — Match Loudness, which would have said so with the number, and the Limiter, which would have caught it — are switched off, and both the WAV writer and the MP3 encoder hard-clip anything over full scale. Switch the Limiter on, or bring the level down before you export.`;
}

/**
 * The live view (P1), in the vocal chain's vocabulary — `ChainStageProgress`,
 * `STAGE_MEASURING_DETAIL` and `stageRenderingDetail` are imported rather than
 * restated, so the two chains' steppers cannot describe the same thing in
 * different words.
 *
 * It matters more here than it does there: the four automatic stages are
 * weighted 56/32/1/11, so the overall bar spends most of a run inside Match EQ
 * saying nothing about what Match EQ is doing.
 */
export type CoverChainStageProgress = ChainStageProgress<CoverChainStageId>;

export interface RunCoverChainOptions {
  enabled: Partial<Record<CoverChainStageId, boolean>>;
  /** The document holding the separated original vocal. `null` is a legal run:
   * every stage that needs it declines saying so, rather than the chain
   * refusing to start. */
  referenceDocId: string | null;
  /**
   * CC4 (CJ-3): the document the reference was SEPARATED FROM, when the caller
   * knows it. Supplying it switches on the plausibility floor
   * ({@link REFERENCE_BELOW_MIX_FLOOR_DB}); omitting it leaves this chain's
   * behaviour exactly as shipped, which is what the standalone dialog wants —
   * there the reference is whatever document the user chose.
   */
  mixDocId?: string | null;
  onProgress?: (fraction: number) => void;
  onStageStart?: (stage: CoverChainStage) => void;
  /** Fires repeatedly while a stage is in flight, scoped to that stage. */
  onStageProgress?: (progress: CoverChainStageProgress) => void;
  /** Fires as each stage's result is decided, with the VERY object that lands
   * in `report.stages` rather than a copy — so a live view shows the finished
   * report's own strings by construction. Fires for every stage, run or not. */
  onStageResult?: (result: CoverChainStageResult) => void;
}

/**
 * Runs the chain over the active selection (or the whole document when there is
 * none) and commits the result as ONE undo entry.
 *
 * Resolves `null` without touching the document in exactly two cases: when
 * there is nothing to run ON — no active document, or an empty region — and
 * when a stage fails. A failure aborts the remaining stages and leaves the
 * document exactly as it was, because a half-applied chain is the one outcome
 * the user could not reason about.
 *
 * A run where every automatic stage was off or declined is NOT one of them. It
 * resolves a full report with `applied: false`, so the dialog can show which
 * stage said what — a chain that did nothing still owes the user the reason each
 * stage gave, and Match Reverb's decline is the most common outcome there is.
 */
export async function runCoverChain(opts: RunCoverChainOptions): Promise<CoverChainReport | null> {
  const { enabled, referenceDocId, mixDocId, onProgress, onStageStart, onStageProgress, onStageResult } =
    opts;
  const state = useAppStore.getState();
  const doc = state.documents.find((d) => d.id === state.activeDocumentId) ?? null;
  if (!doc) return null;

  // ONE resolved region, read by every consumer below — the audio the stages
  // receive, the `replaceRegion` write, `regionSamples` (which the report shows
  // and Match Reverb's tail is measured against), the grow remap's insert point,
  // and the post-edit selection/cursor. `cloneRegion` and `replaceRegion` clamp
  // to [0, docLength] internally while `setSelection` stores whatever it is
  // handed, so reading the raw selection HERE gave the arithmetic a region the
  // audio never used: an `end` past the document inflated `regionSamples` and
  // put the tail's insert point past every marker there is, and a `start` before
  // 0 left the document selected from a negative sample. Same defect family as
  // R7's `plan.regionStart`, L1's `resolveRegion` and L9's
  // `runEffectOnSelection`: resolve once, not clamp twice and hope the two
  // agree — and T6-1 made that ruling an import rather than six copies of two
  // expressions.
  const { start, end } = resolveRegion(doc, state.selection);
  if (end <= start) return null;
  const docId = doc.id;
  const sampleRate = doc.sampleRate;
  const regionSamples = end - start;

  const active = COVER_CHAIN_STAGES.filter((s) => s.effectId !== null && enabled[s.id] === true);
  const totalWeight = active.reduce((sum, s) => sum + s.weight, 0);

  // The reference is measured for exactly the stages that are switched on, and
  // only if it is still open. A reference document closed between choosing it
  // and pressing Apply is the same case as never having chosen one: the stages
  // that need it decline saying so.
  const refDoc = referenceDocId
    ? (state.documents.find((d) => d.id === referenceDocId) ?? null)
    : null;
  const needsReference =
    enabled.matchEq === true || enabled.matchLoudness === true || enabled.matchReverb === true;
  // CC4 (CJ-3): the mix the reference came out of, when the caller named one and
  // it is still open. The gated LEVEL of the reference is measured whenever a
  // mix is supplied, whether or not Match Loudness is on: it is the floor's own
  // input, and Match EQ declines on it too.
  const mixDoc = mixDocId
    ? (state.documents.find((d) => d.id === mixDocId && d.id !== refDoc?.id) ?? null)
    : null;
  const mix =
    mixDoc && docLength(mixDoc) > 0
      ? { channels: mixDoc.channels, sampleRate: mixDoc.sampleRate, name: mixDoc.name }
      : null;
  let reference: ReferenceMeasurements | null = null;
  if (refDoc && needsReference && docLength(refDoc) > 0) {
    reference = measureReference(
      refDoc.channels,
      refDoc.sampleRate,
      refDoc.name,
      {
        ltas: enabled.matchEq === true,
        level: enabled.matchLoudness === true || mix !== null,
        decay: enabled.matchReverb === true,
      },
      mix
    );
  }
  // CC4 (CJ-3): the floor's verdict as a typed field rather than a string the
  // caller would have to recognise — the cover journey warns on its own row with
  // this number, and the nested stage rows carry the full sentence.
  const referenceBelowMix = referenceBelowMixDb(reference);
  const referenceImplausibleBelowDb =
    implausibleReferenceReason(reference) === null ? null : (referenceBelowMix as number);

  // The before/after spectral distance needs the reference's spectrum whether or
  // not Match EQ is on — a run with only the loudness stage still reports how
  // far the timbre sits from the target, it just does not correct it. Match EQ
  // may already have paid for it, in which case this REUSES it: the spectrum of
  // a three-minute file is 1.86 s of work and the progress bar has not started
  // moving yet.
  const metricLtas =
    reference?.ltas ??
    (refDoc && docLength(refDoc) > 0
      ? longTermAverageSpectrum(refDoc.channels, refDoc.sampleRate)
      : null);

  let channels = cloneRegion(doc, start, end);
  const before = measureMetrics(channels, sampleRate, metricLtas);
  // The reference's own metrics are measured against the reference's own
  // spectrum, which is `metricLtas` — handed in rather than recomputed, because
  // recomputing it would be a second 1.86 s pass to produce a distance that is
  // zero by construction.
  const referenceMetrics =
    refDoc && docLength(refDoc) > 0
      ? measureMetrics(refDoc.channels, refDoc.sampleRate, metricLtas, metricLtas)
      : null;
  const startedAt = Date.now();

  const results: CoverChainStageResult[] = [];
  const remapSteps: MarkerRemap[] = [];
  let doneWeight = 0;
  let anyApplied = false;

  // ONE place a stage result is recorded, so the live callback cannot be given a
  // different object — or a different set of stages — from the report's.
  const record = (result: CoverChainStageResult): void => {
    results.push(result);
    onStageResult?.(result);
  };

  for (const stage of COVER_CHAIN_STAGES) {
    if (stage.effectId === null) {
      record({ id: stage.id, label: stage.label, status: 'manual', derived: [] });
      continue;
    }
    if (enabled[stage.id] !== true) {
      record({ id: stage.id, label: stage.label, status: 'off', derived: [] });
      continue;
    }

    onStageStart?.(stage);
    // Announced AND painted before the measurement runs — see `announceMeasuring`
    // in vocalChain.ts.
    //
    // Match EQ is the stage that needed it, and it is worth being exact about
    // which measurement is which. The reverb's ISO 3382-1 decay fit is hoisted
    // OUT of this loop into `measureReference` above, so Match Reverb's in-loop
    // resolve is cheap and its decline is nearly free. What is NOT hoisted is
    // `deriveMatchEq`'s own long-term spectrum of the take — 1.75 s of the
    // 2.28 s that makes this stage 56 of the 68 weight — and without a yield
    // that whole pass ran with the main thread frozen and the PREVIOUS stage's
    // row still on screen, which is the symptom the live view exists to remove.
    await announceMeasuring(onStageProgress, stage.id, stage.label);
    const resolution = resolveStage(stage, channels, sampleRate, reference, enabled);
    if (!resolution.run) {
      record({
        id: stage.id,
        label: stage.label,
        status: 'declined',
        reason: resolution.reason,
        derived: [],
      });
      doneWeight += stage.weight;
      onProgress?.(totalWeight === 0 ? 1 : doneWeight / totalWeight);
      continue;
    }

    // The measurement it just took, phrased once — the same string for every
    // rendering event of this stage, so the line does not flicker between the
    // settings and a generic verb while the worker runs.
    const renderingDetail = stageRenderingDetail(resolution.derived);
    onStageProgress?.({
      stageId: stage.id,
      label: stage.label,
      phase: 'rendering',
      stageFraction: 0,
      detail: renderingDetail,
    });

    // Kept alive only until the delta is measured: the worker DETACHES the
    // buffers it is handed, so a before/after comparison needs its own copy.
    let inputCopy: Float32Array[] | null = channels.map((c) => Float32Array.from(c));
    const stageStartedAt = Date.now();
    let output: EffectRunOutput;
    try {
      output = await runEffectOnChannels(stage.effectId, channels, sampleRate, resolution.params, {
        onProgress: (f) => {
          onProgress?.(totalWeight === 0 ? 1 : (doneWeight + stage.weight * f) / totalWeight);
          onStageProgress?.({
            stageId: stage.id,
            label: stage.label,
            phase: 'rendering',
            stageFraction: f,
            detail: renderingDetail,
          });
        },
      });
    } catch (err) {
      reportEffectFailure(err);
      return null;
    }

    const delta = measureStageDelta(inputCopy, output.channels);
    inputCopy = null;
    channels = output.channels;

    record({
      id: stage.id,
      label: stage.label,
      status: 'applied',
      derived: resolution.derived,
      // The resolved (pre-run, predicted) warning is Match Loudness's; the
      // post-hoc measured one is Match Reverb's. No stage carries both, so the
      // coalesce cannot drop one.
      warning: resolution.warning ?? stageWarning(stage, delta, enabled),
      delta,
      eq: resolution.eq,
      detail: describeStage(stage, delta),
      elapsedMs: Date.now() - stageStartedAt,
    });
    anyApplied = true;
    doneWeight += stage.weight;
    onProgress?.(totalWeight === 0 ? 1 : doneWeight / totalWeight);
  }

  const after = measureMetrics(channels, sampleRate, metricLtas);
  const outputSamples = channels[0]?.length ?? 0;

  const report: CoverChainReport = {
    before,
    after,
    reference: referenceMetrics,
    referenceName: refDoc ? refDoc.name : null,
    referenceImplausibleBelowDb, // CC4 (CJ-3)
    stages: results,
    sampleRate,
    regionSamples,
    outputSamples,
    elapsedMs: Date.now() - startedAt,
    applied: false,
  };
  if (!anyApplied) return report;

  // Match Reverb is the one stage here that GROWS the region, appending its tail
  // at the end of what the earlier stages left. No stage in this chain removes
  // spans, so the grow is the whole length delta.
  const grew = outputSamples - regionSamples;
  if (grew > 0) remapSteps.push({ type: 'insert', start: start + regionSamples, length: grew });

  try {
    applyEdit(
      COVER_CHAIN_UNDO_LABEL,
      docId,
      (d) => replaceRegion(d, start, end, channels),
      { selection: { start, end: start + outputSamples }, cursorSample: start },
      { type: 'compose', steps: remapSteps }
    );
  } catch (err) {
    // The doc may have been closed while the chain was running.
    reportEffectFailure(err);
    return null;
  }

  return { ...report, applied: true };
}
