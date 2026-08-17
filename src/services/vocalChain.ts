/**
 * Task F7 — the Vocal Chain.
 *
 * One pass that applies the corrections a rough vocal usually needs. It adds no
 * DSP: every stage is an effect that already shipped and was already reviewed.
 * What is new is the ORDER, the DERIVATION of the settings from the actual
 * audio, and a report that never hides what happened.
 *
 * ── It is not a second application path ──────────────────────────────────────
 * Each stage goes through `runEffectOnChannels`, the same worker leg
 * `runEffectOnSelection` uses, and the whole run lands with ONE `applyEdit`
 * carrying the composed marker remap. Nothing here re-implements dispatch,
 * progress, marker mapping or undo.
 *
 * ── Where the settings come from ────────────────────────────────────────────
 * Every stage starts from `defaultParamsFor(effectId)` — the effect's OWN
 * declared defaults, each already derived in its own task — and the chain
 * overrides only the parameters whose derivation the chain context provably
 * changes. There is no second table of defaults to drift.
 *
 * SIX effects get an override. Four of them are level-relative quantities that
 * an absolute dBFS default cannot get right when nobody is listening:
 *
 *   - De-esser threshold (F8 Ruling 1, binding). Measured at the DE-ESSER'S
 *     INPUT, i.e. after the compressor, because an upstream compressor changes
 *     what the detector sees regardless of the source level.
 *   - Compressor threshold and makeup. Audited and found to have the same
 *     defect, and worse: measured on the reference take the shipped -20 dBFS
 *     default applies 1.65 dB of peak gain reduction, and -16 dBFS applies
 *     0.08 dB. A compressor that does nothing is exactly the wrong default to
 *     bury inside a seven-stage pass.
 *   - Remove Silence threshold, derived from the measured noise floor.
 *   - Noise Gate threshold, derived from the same measurement (CC1).
 *
 * The other two are not levels but they are measurements all the same, and an
 * effect default cannot carry either:
 *
 *   - DeHum base frequency, set to the mains frequency actually detected — 50
 *     or 60 Hz is a fact about the recording, not a preference.
 *   - EQ high-pass: `hpEnabled` and `hpFreq`, the corner placed an octave below
 *     the lowest note Pitch Correct measured.
 *
 * The Noise Gate's OTHER three parameters — attack, release and hold — are the
 * one place the chain overrides a default with a constant rather than with a
 * measurement of this recording, and both constants come from elsewhere in this
 * app rather than from taste: the attack and release are the silence detector's
 * own, because the threshold is defined as a peak of THAT envelope, and the
 * hold is Remove Silence's minimum pause. `deriveGate` argues all three.
 *
 * Noise Reduction is NOT in that count. It hands the stage a noise print
 * measured from the quietest passage, but it changes no parameter: the print
 * travels as `extra`, and every declared default is left as the effect set it.
 *
 * Audited and deliberately NOT overridden:
 *   - Limiter ceiling (-0.3 dBFS). Absolute by definition — the ceiling IS an
 *     absolute level, and a "relative ceiling" would not be one.
 *   - Noise Reduction reduction/sensitivity. Already relative: they scale the
 *     learned noise print, so they track the material by construction.
 *   - Pitch Correct, DeHum, Reverb, EQ band gains. No level-dependent
 *     parameter among them.
 *
 * ── The gate this file used to argue against (CC1) ──────────────────────────
 * Through v1.27.0 the list above ended with "Noise Gate. Not a chain stage —
 * Noise Reduction handles the floor here, spectrally and without a threshold
 * that can chatter on a held note." A user running the Cover Chain reported the
 * consequence: "it didn't remove the noises where nothing is played, in fact if
 * no word is spoken remove all sound."
 *
 * Both halves of that claim were wrong. Noise Reduction does not handle the
 * floor: its per-bin gain is `max(floor, ...)` with `floor = 10^(-12/20)`, so
 * it can pull a pause down by 12 dB and no further — measured through this
 * chain on a take with a -45 dBFS floor, the pauses came back at -54.8 dBFS,
 * because the compressor's makeup then lifts what is left. Nothing else
 * enabled by default can silence anything: Remove Silence is off by default and
 * length-changing, which is exactly what a take synced to a backing track
 * cannot have. And the chatter the claim feared is a property of a gate's hold,
 * not of gates: at a 500 ms hold neither a 120 ms stop-consonant closure nor a
 * 400 ms dip inside a held note moves a single sample.
 *
 * So the gate IS a chain stage now, on by default, length-preserving, between
 * DeHum and the dynamics stages — the position Remove Silence's own note had
 * already argued for. The same fixture comes back at digital silence.
 *
 * ── Two deviations from the brief's order, and both are the same rule ───────
 * The brief orders ... compressor -> de-esser -> limiter -> EQ -> reverb. The
 * chain runs BOTH the EQ and the Reverb before the limiter, so that the limiter
 * is last of every stage that touches the audio. The rule behind both: the
 * limiter's note promises the user that nothing downstream can lift the output
 * back over the ceiling, and that promise is only true if nothing is
 * downstream.
 *
 *   - EQ before the limiter. Measured on the reference take: a 2nd-order
 *     Butterworth high-pass at 98 Hz applied to already-limited audio raises
 *     the peak from -9.68 to -8.73 dBFS, +0.95 dB. Filtering re-phases
 *     components and the sum can exceed the input peak even though |H| <= 1 at
 *     every frequency.
 *   - Reverb before the limiter. `ReverbEffect` sums a wet tail on top of the
 *     dry signal, so it is a level stage whatever its purpose is. Measured
 *     through `runVocalChain` itself with the limiter and reverb on, in the
 *     order that shipped through v1.23.0: full-scale noise limited to
 *     -0.3 dBFS came back at +6.53 dBFS, a 220 Hz tone at +0.98 dBFS, and the
 *     default stage selection with Reverb switched on at +5.51 dBFS. Both the
 *     WAV writer and the MP3 encoder hard-clip that. With the reverb moved
 *     ahead of the limiter the same three fixtures land at -0.30 dBFS.
 *
 * Reverb still runs after every stage that measures or shapes the voice —
 * which is the actual reason its own note gives for being late, that nothing
 * should compress or pitch-correct a tail it just added. Only the limiter now
 * sees the tail, and seeing it is its job. Everything else follows the brief.
 *
 * ── The path the reorder does not close ─────────────────────────────────────
 * The reorder makes the limiter's promise true while the limiter is RUNNING.
 * Switch it off and the reverb is once again the last stage that touches the
 * audio, and the same +6.53 dBFS arrives at both writers. That case is WARNED
 * rather than blocked, in the cover chain's Ruling C shape: `stageWarning`
 * below names the measured peak on the reverb's own result, the dialog renders
 * it in amber, and the run goes ahead.
 */

import { cloneRegion, replaceRegion } from '../audio/AudioDocument';
import { defaultParamsFor, getEffect } from '../effects/EffectRegistry';
import type { EffectParamValue, EffectReport } from '../effects/types';
import { reductionDb } from '../effects/dynamics/CompressorEffect';
import { ALIGN_ACCURACY_SENTENCE } from '../dsp/ctcAlign';
import { envelopeFollower, maxAcrossChannels } from '../dsp/envelope';
import { detectPitch } from '../dsp/pitchDetect';
import { DETECT_ATTACK_MS, DETECT_RELEASE_MS } from '../dsp/silenceDetect';
import {
  HUM_EXCESS_THRESHOLD_DB,
  MAINS_BASE_FREQUENCIES,
  NOISE_SEARCH_STEP_MS,
  NOISE_WINDOW_MAX_SILENT_FRACTION,
  NOISE_WINDOW_MS,
  TILT_FFT_SIZE,
  detectMainsHum,
  humMeasurable,
  measureNoiseWindow,
  measureStageDelta,
  monoMix,
  peakDb,
  programmeRmsDb,
  toDb,
  toneExcessDb,
  windowedTiltResidualsDb,
  type NoiseWindow,
  type StageDelta,
} from '../dsp/chainAnalysis';
import { GATE_SILENT_RUN_MS } from '../effects/dynamics/NoiseGateEffect';
import { getLyricsAlignment, isLyricsAlignmentStale } from './alignLyricsService';
import { getTranscript, isTranscriptStale } from './transcribeService';
import { useAppStore } from '../stores/appStore';
import { applyEdit, type MarkerRemap } from './editOps';
import {
  describeRemoval,
  reportEffectFailure,
  runEffectOnChannels,
  type EffectRunOutput,
} from './effectRunner';
import { averageMagnitudeSpectra } from './noiseProfile';
import { resolveRegion } from './selectionRegion';

export const VOCAL_CHAIN_UNDO_LABEL = 'Vocal Chain';

export type VocalChainStageId =
  | 'dc'
  | 'lyrics'
  | 'noise'
  | 'hum'
  | 'silence'
  | 'gate'
  | 'timing'
  | 'pitch'
  | 'compressor'
  | 'deEsser'
  | 'eq'
  | 'reverb'
  | 'limiter';

export interface VocalChainStage {
  id: VocalChainStageId;
  label: string;
  /** The registered effect this stage runs, or `null` when the stage is not an
   * unattended one at all. Two stages are like that — F9's Align Vocal Timing
   * and F6's Align Lyrics — and both for the same reason: each needs the user
   * to say WHICH thing to change (which syllables, which word), and neither has
   * a measurement good enough to decide that for them. `runVocalChain` reports
   * them as `manual` and never runs anything for them, however they are
   * switched. */
  effectId: string | null;
  defaultEnabled: boolean;
  /** Why the stage sits where it does, and why it is on or off by default.
   * Shown verbatim in the UI: a stage the user cannot reason about is a stage
   * that ran without being seen. */
  note: string;
  /** Share of the progress bar. These are MEASURED wall times on the 142 s
   * stereo reference take, as a percentage of the 108.8 s the eleven stages
   * take together, rounded to integers with a floor of 1 so no stage is
   * invisible: DC 0.1 s, Noise Reduction 27.0 s, DeHum 0.5 s, Remove Silence
   * 2.4 s, Noise Gate 4.1 s, Pitch Correct 57.7 s, Compressor 5.7 s, De-esser
   * 5.8 s, EQ 0.4 s, Reverb 1.4 s, Limiter 3.6 s. Equal weights would park the
   * bar for the minute Pitch Correct alone takes and then jump to done.
   *
   * The gate's figure was re-measured for G2, because the stage changed
   * shape: the region derivation (one shared-STFT tilt pass over the whole
   * take, the per-gap floor measurements and edge walks, and a pitch track
   * per candidate stretch) ran in 4.1-4.4 s on the 142 s reference take at
   * 48 kHz — measured wall time, three runs — and the render in region mode
   * is a copy plus fades, cheaper than the old state machine. The old weight
   * of 4 therefore stands on a new measurement rather than surviving on an
   * old one. The pitch cost scales with the candidate seconds rather than
   * the take (the kept cost test), so a take that is half pause can roughly
   * double this stage; the bar is weighted for the common case. */
  weight: number;
}

// The one geometry constant the STAGE TABLE below quotes, declared ahead of
// it. Its veto siblings live with the gate's derivation further down.
/**
 * The shortest stretch between vocal activity the automatic gate will mute,
 * in ms (G2).
 *
 * It is `NOISE_WINDOW_MS`, and that is a REUSE, not a number: Remove Silence's
 * own `minSilenceMs` — this app's already-derived answer to "how long is a gap
 * before it is unambiguously a pause rather than articulation" (stop-consonant
 * closures run to ~150 ms; pauses start reading as pauses around ~250 ms) —
 * exactly the reuse `GATE_HOLD_MS` already makes for the manual path. The gate
 * may only mute what Remove Silence would have been willing to cut.
 *
 * The vetoes CAP it from below independently, and the kept
 * `GATE_MIN_REGION_MS` suite measures that cap: the vocal-tract boundary
 * (`GATE_SHAPED_RESIDUAL_DB`) separates its floor and unvoiced-vocal
 * populations at this length at every rate — floors at most 1.92 dB, vocal
 * material at least 3.09 dB, the 2.5 dB constant inside the gap — while at
 * 250 ms the floor population CROSSES the constant (2.72 dB at 8 kHz: a
 * quarter-second of plain room tone reads as a vocal tract), and at one
 * `TILT_FFT_SIZE` frame the two populations invert outright (a floor run reads
 * 3.9 dB where a whisper reads 2.6 at 44.1 kHz). So no shorter minimum could
 * keep the vetoes trustworthy, and no longer one is asked for by them — the
 * binding value is the app's own pause definition, which the classifier's
 * floor exactly meets.
 *
 * THE COST, STATED. A real pause SHORTER than this is left un-muted, exactly
 * as the old hold left it un-faded: nothing shorter than the app's own
 * definition of a pause is worth a mute that could clip articulation, and the
 * decline says so when it is the only reason nothing qualified.
 */
export const GATE_MIN_REGION_MS = NOISE_WINDOW_MS;

/**
 * The order, and it is the brief's order but for the two stages moved ahead of
 * the limiter at the top of this file, plus F6's `lyrics` stage — whose
 * position is argued in its own note against the rules the stages around it
 * already state, not inherited from a proposal.
 */
export const VOCAL_CHAIN_STAGES: readonly VocalChainStage[] = [
  {
    id: 'dc',
    label: 'Remove DC Offset',
    effectId: 'dc-remove',
    defaultEnabled: true,
    note: 'First, because a DC bias skews every level measurement taken after it.',
    weight: 1,
  },
  {
    id: 'lyrics',
    label: 'Align Lyrics',
    effectId: null,
    defaultEnabled: false,
    note: `Not an automatic stage. It places your own lyrics in the recording and lets you replace ONE word you pick with a fresh take of just that word — nothing in it judges which word that should be. Run Pipeline → Align Lyrics FIRST, then this chain. It sits SECOND, after Remove DC Offset and before everything else, for two reasons that are both measurements rather than preferences. A replacement is a fresh microphone take carrying its own room tone, so it has to be in the file before Noise Reduction learns its print and before the compressor, de-esser and limiter measure the levels they set themselves from — put it after them and the seam joins cleaned audio to a raw take, with no stage left to reconcile the two floors. And it has to come before Remove Silence and Align Vocal Timing, which move every sample after the point they edit, leaving the word positions describing audio that has shifted. Remove DC Offset still goes first, for the chain's own stated reason: the splice matches the new word's level to the old one's by RMS, and a DC bias inflates that measurement. ${ALIGN_ACCURACY_SENTENCE}`,
    weight: 0,
  },
  {
    id: 'noise',
    label: 'Noise Reduction',
    effectId: 'noise-reduction',
    defaultEnabled: true,
    note: `Early, because every later analysis degrades on noisy input — the pitch detector will otherwise lock onto broadband noise and "correct" pitch that is not there. Learns its noise print from the quietest ${NOISE_WINDOW_MS} ms in the selection.`,
    weight: 25,
  },
  {
    id: 'hum',
    label: 'DeHum',
    effectId: 'dehum',
    defaultEnabled: true,
    note: 'Runs only when mains hum is actually measured at 50 or 60 Hz. On a recording without it, this stage declines rather than notching a hole in nothing.',
    weight: 1,
  },
  {
    id: 'silence',
    label: 'Remove Silence',
    effectId: 'remove-silence',
    defaultEnabled: false,
    note: 'Off by default: it is length-changing, so every sample after the first shortened pause moves earlier and the take no longer lines up with a backing track (4.74 s would be removed from the reference vocal). Turn it on for spoken word. Placed before the dynamics stages so the compressor does not lift a noise floor in gaps that are about to go.',
    weight: 2,
  },
  {
    id: 'gate',
    label: 'Noise Gate',
    effectId: 'noise-gate',
    defaultEnabled: true,
    note: `Brings the stretches where you are not singing to actual silence, which nothing else in this chain can: Noise Reduction lowers the floor by at most 12 dB and leaves it there. Length-preserving — it mutes in place rather than cutting, so the take still lines up with a backing track. It decides WHERE, not how loud: a stretch is muted only when the evidence says no vocal activity lives in it, so pause noise LOUDER than your softest singing still goes — the case no level threshold can reach. The evidence, in order: your aligned lyrics or transcript place the words, when you have run either and the audio has not changed since; with or without them, every ${NOISE_WINDOW_MS} ms of the selection is measured for the resonances of a vocal tract, and anything carrying them — a whisper, a breath, a held consonant — is kept, as is anything whose frames read as voiced (singing, humming), even where no word maps. Only stretches of at least ${GATE_MIN_REGION_MS} ms qualify — the shortest gap this app calls a pause rather than articulation (Remove Silence's own minimum) — so a stop-consonant closure or a dip inside a held note comes back untouched, and each muted stretch closes behind the same fade the manual gate uses and reopens instantly at the next activity. A stretch of digital silence is left exactly as it is: zeros stay zeros, silence is never evidence about the material beside it, quiet audio surviving only as fragments between zeros is never muted unheard, and a take whose pauses are all already exact zeros declines, having nothing left for a gate to do. When nothing qualifies — the take never pauses, every stretch carries vocal evidence, or everything between activity reads like the material itself — this stage declines and says which, and the box under this note gates at a level you name instead: the one setting in this chain that comes from you, with the level-gate behaviour of earlier releases unchanged. After Noise Reduction and DeHum, which lower the floor around the activity, and BEFORE the dynamics stages, so the compressor's makeup gain multiplies zeros instead of lifting a floor back up.`,
    weight: 4,
  },
  {
    id: 'timing',
    label: 'Align Vocal Timing',
    effectId: null,
    defaultEnabled: false,
    note: 'Not an automatic stage. It needs you to confirm the beat grid and the syllable moves before it warps anything, by design — automatic onset detection measured 0.56 precision on a legato vocal, so an unconfirmed pass would move syllables that were never there. Run Pipeline → Align Vocal Timing FIRST, then this chain: warping changes the analysis windows the pitch detector uses, so timing belongs before pitch.',
    weight: 0,
  },
  {
    id: 'pitch',
    label: 'Pitch Correct',
    effectId: 'pitch-correct',
    defaultEnabled: true,
    note: 'After noise reduction so the detector sees clean harmonics. Chromatic, so it is correct in any key; the 50 ms retune time constant leaves 5–7 Hz vibrato largely intact. This is by far the slowest stage.',
    weight: 53,
  },
  {
    id: 'compressor',
    label: 'Compressor',
    effectId: 'compressor',
    defaultEnabled: true,
    note: 'Threshold set to the level the material is above half the time while it is sounding, and makeup gain set to give back exactly the level the compression took away.',
    weight: 5,
  },
  {
    id: 'deEsser',
    label: 'De-esser',
    effectId: 'de-esser',
    defaultEnabled: true,
    note: 'After the compressor, because compression makes sibilance worse. Its threshold is measured here, at its own input, for that reason.',
    weight: 5,
  },
  {
    id: 'eq',
    label: 'EQ (high-pass)',
    effectId: 'parametric-eq',
    defaultEnabled: true,
    note: 'A high-pass an octave below the lowest note actually sung, and nothing else — every band stays flat. Removing rumble under the voice is a measurement; boosting or cutting a band is taste, and the chain has no measurement that says this voice needs either. NEEDS PITCH CORRECT: the lowest note is measured by that stage, so switching it off makes this one decline rather than guess a corner.',
    weight: 1,
  },
  {
    id: 'reverb',
    label: 'Reverb',
    effectId: 'reverb',
    defaultEnabled: false,
    note: 'Off by default: it adds a tail rather than correcting anything, and no measurement of a recording says how much of a room it wants. After every stage that measures or shapes the voice, because nothing should compress or pitch-correct a tail it just added — but BEFORE the Limiter, because a wet tail summed on top of a limited signal comes back over full scale: measured through this chain, a take limited to −0.3 dBFS came back at +6.53 dBFS on noise and +0.98 dBFS on a 220 Hz tone, and both the WAV and the MP3 writer hard-clip that. Turning it on lengthens the selection by the tail.',
    weight: 1,
  },
  {
    id: 'limiter',
    label: 'Limiter',
    effectId: 'limiter',
    defaultEnabled: true,
    note: 'Last of every stage that touches the audio, so nothing downstream can lift the output back over the ceiling. It is a safety net: on material that never reaches the ceiling it will report that it did nothing.',
    weight: 3,
  },
];

export function stageById(id: VocalChainStageId): VocalChainStage {
  const stage = VOCAL_CHAIN_STAGES.find((s) => s.id === id);
  if (!stage) throw new Error(`Unknown vocal chain stage: ${id}`);
  return stage;
}

/** The enabled-map the UI opens with. */
export function defaultStageSelection(): Record<VocalChainStageId, boolean> {
  const out = {} as Record<VocalChainStageId, boolean>;
  for (const stage of VOCAL_CHAIN_STAGES) out[stage.id] = stage.defaultEnabled;
  return out;
}

/** One number the chain worked out for itself, and what it worked it out from.
 * Rendered next to the stage, because a derived setting the user cannot see is
 * indistinguishable from a guessed one. */
export interface DerivedValue {
  label: string;
  value: string;
  from: string;
}

export type StageResolution =
  | { run: true; params: Record<string, EffectParamValue>; extra?: unknown; derived: DerivedValue[] }
  | { run: false; reason: string };

const dbStr = (v: number): string => `${v.toFixed(1)} dB`;
const dbfsStr = (v: number): string => `${v.toFixed(1)} dBFS`;

// ── Derivations ─────────────────────────────────────────────────────────────
// Each takes the audio that will actually feed its stage, and returns either
// the parameters to run with or the reason it is declining. None of them can
// return a value it did not measure.

/**
 * De-esser threshold — F8 Ruling 1, and the whole reason F8 shipped before F7.
 *
 * The threshold is an absolute dBFS level, correct for a user turning a knob
 * with Listen in the loop and wrong in a chain where nobody sets anything: F8
 * measured that boosting its reference take by 5 dB takes the de-esser from
 * touching 1 vowel frame in 11643 to 45, losing the bit-exact-at-rest property
 * that justifies the subtractive design.
 *
 * F8 measured two offsets from programme RMS. `-2.2 dB` reproduces the shipped
 * operating point (-30.0 dBFS against that take's -27.76 dBFS programme RMS);
 * `-1.4 dB` sits under the loudest vowel frame and restores true bit-exactness,
 * at the cost of engaging on fewer sibilants.
 *
 * THE CHAIN USES -2.2. The property -1.4 buys is real but its measured
 * consequence is one frame in 11643 changing by 0.000 dB, and it is bought by
 * de-essing less — while removing sibilance is the entire job of the stage.
 * Inside a chain the user cannot attribute an under-de-essed result to
 * anything, whereas the purity it would gain is not audible or measurable at
 * the output. The number is shown in the report, so a user who wants the other
 * trade can see what to change.
 */
export const DE_ESSER_RMS_OFFSET_DB = -2.2;
/** The offset that would instead restore bit-exactness on vowels (F8). Not
 * used; recorded so the alternative is documented where the choice is made. */
export const DE_ESSER_BIT_EXACT_OFFSET_DB = -1.4;

export function deriveDeEsser(channels: Float32Array[]): StageResolution {
  const params = defaultParamsFor('de-esser');
  const rmsDb = programmeRmsDb(channels);
  const thresholdDb = clampToParam('de-esser', 'thresholdDb', rmsDb + DE_ESSER_RMS_OFFSET_DB);
  params.thresholdDb = thresholdDb;
  return {
    run: true,
    params,
    derived: [
      {
        label: 'Threshold',
        value: dbfsStr(thresholdDb),
        from: `programme RMS at this point ${dbfsStr(rmsDb)} ${DE_ESSER_RMS_OFFSET_DB} dB (F8's measured operating point, taken after the compressor)`,
      },
    ],
  };
}

/**
 * Compressor threshold and makeup gain.
 *
 * THRESHOLD = the median of the compressor's own detector envelope over the
 * material that is SOUNDING — that is, "the level this take is above half the
 * time while there is something there". Active is defined by the noise window,
 * not by a chosen dB figure: a sample counts when the Remove-Silence detector
 * reads above the loudest the same detector ever gets inside the quietest
 * 500 ms of the recording. Every quantity in that sentence is measured.
 *
 * On the reference take this lands at -25.3 dBFS, which is programme RMS
 * +2.5 dB, and applies about 5 dB of peak gain reduction. The shipped absolute
 * default of -20 dBFS applies 1.65 dB on the same audio.
 *
 * MAKEUP = exactly the programme level the compression removed, computed —
 * not estimated — by running the effect's OWN `reductionDb` law over the same
 * envelope to predict the output before the worker runs. It is a prediction of
 * an arithmetic identity, not a model: `out[i] = in[i] * g[i]`, so
 * sum(out^2) is computable from the inputs. Restoring the level it took is what
 * makeup gain means; choosing a delivery loudness is a mastering decision the
 * chain has no measurement for and does not make.
 *
 * ── Why this still works on a take the gate has been through (CC1 / N2) ─────
 * "Sounding" is defined against the noise floor, and the gate that now runs
 * before this stage silences the pauses that floor was measured in — so the
 * worry is that there is nothing left here to measure and this derivation would
 * decline, or would read the boundary off a window containing voice.
 *
 * What actually happens, stated precisely, because an earlier version of this
 * note got it wrong and a fixture-lucky test agreed with it. `measureNoiseWindow`
 * does NOT return the untouched window the gate's hold leaves in front of each
 * fade. It returns the QUIETEST window it accepts, and after gating that is a
 * window straddling the fade — mostly hard zeros — which is kept out of the
 * reject bin only by sitting above `SILENCE_RMS` (2^-15, chainAnalysis.ts:148).
 * Which window wins depends on where the fade falls against the 50 ms chunk
 * grid, so the FLOOR READING is not preserved at all: swept over two rates,
 * four floor levels and six fade phases it came back as much as 41 dB below
 * the ungated reading.
 *
 * The boundary this derivation builds on it moves anyway, and that is the
 * invariant worth having: the same sweep moved the derived threshold by at most
 * 0.052 dB, and the slice of it kept as a test — three floor levels x three
 * fade phases — by 0.0917 dB. Two reasons, both structural rather than lucky — the gated gaps are
 * exactly zero, so no under-read threshold can admit them (an envelope of 0 is
 * above no positive level), and the extra fade-tail samples an under-read does
 * admit are a vanishing share of the sounding population the median is taken
 * over. `what survives the gate, and what does not` in vocalChain.test.ts pins
 * both halves: that the floor reading is NOT preserved, and that the threshold
 * is.
 *
 * ── Why this stage KEEPS the bare search, measured (T2) ─────────────────────
 * The gate, Remove Silence, `wordSplice.trimSilence` and Noise Reduction were
 * each moved onto `rejectMostlySilentWindows` because a window diluted by exact
 * zeros gave them a wrong THRESHOLD or a wrong PRINT. Here the window is
 * neither: it is only the boundary between "sounding" and "silent" for a MEDIAN
 * taken over the sounding samples, and a median is decided by what sits in the
 * middle of a distribution, not by where its edge is.
 *
 * Measured on the same defect the others were destroyed by — a trimmed head of
 * exact zeros beside a settling stretch 10 dB above the take's own floor, which
 * inflates the window by 9-10 dB. On an ordinary take with three sung phrases
 * the derived threshold moves by 0.021 dB at 8 kHz and 0.017 dB at 44.1, and the
 * makeup by under 0.01 dB — two orders of magnitude under the 1 dB broadband
 * JND that was written down as the bound BEFORE the measurement was taken.
 *
 * On a take that is nearly ALL floor — Remove Silence's own RED fixture, 90 %
 * room tone around one short phrase — the same substitution moves the threshold
 * 43.66 dB, because there the boundary IS most of the distribution. That answer
 * is correct by this stage's own definition and worse in the room: it asks for
 * +31.17 dB of makeup where the shipped path asks +0.53, the parameter clamps it
 * to +24 (so the makeup identity this whole design rests on is broken by 7 dB),
 * and it lifts the take's peak from -12.0 dBFS to about -1. A gain error that
 * does nothing is a better failure than a loudness jump into the limiter, so
 * this stage keeps the bare search. Both halves are kept as measurements in
 * `the noise window this stage does NOT ask to be honest, and why`.
 */
export function deriveCompressor(channels: Float32Array[], sampleRate: number): StageResolution {
  const params = defaultParamsFor('compressor');
  const noise = measureNoiseWindow(channels, sampleRate);
  if (!noise) {
    return {
      run: false,
      reason: `no ${NOISE_WINDOW_MS} ms passage above digital silence to measure the noise floor from, so "sounding" cannot be told from "silent" and the threshold cannot be derived`,
    };
  }

  const ratio = Number(params.ratio);
  const kneeDb = Number(params.kneeDb);
  const detector = maxAcrossChannels(channels);
  const gateEnv = envelopeFollower(detector, sampleRate, DETECT_ATTACK_MS, DETECT_RELEASE_MS);
  const compEnv = envelopeFollower(detector, sampleRate, Number(params.attackMs), Number(params.releaseMs));
  const gateLin = Math.pow(10, noise.envelopePeakDb / 20);

  // Sampled every 1 ms: the compressor envelope has a 10 ms attack and a 100 ms
  // release, so it cannot move meaningfully inside one sample of that grid, and
  // a full-resolution list of 6.8 M doubles would cost more than the audio.
  const stride = Math.max(1, Math.round(sampleRate / 1000));
  const activeDb: number[] = [];
  for (let i = 0; i < compEnv.length; i += stride) {
    if (gateEnv[i] > gateLin) activeDb.push(toDb(compEnv[i]));
  }
  if (activeDb.length === 0) {
    return {
      run: false,
      reason: 'nothing in the selection rises above its own noise floor, so there is no programme to compress',
    };
  }
  activeDb.sort((a, b) => a - b);
  const thresholdDb = clampToParam('compressor', 'thresholdDb', activeDb[activeDb.length >> 1]);

  // Predict the level the compression will remove, using the effect's own law.
  let sumSqIn = 0;
  let sumSqOut = 0;
  let peakReductionDb = 0;
  for (let i = 0; i < compEnv.length; i++) {
    const reduction = reductionDb(toDb(compEnv[i]) - thresholdDb, ratio, kneeDb);
    if (reduction > peakReductionDb) peakReductionDb = reduction;
    const gain = Math.pow(10, -reduction / 20);
    for (const c of channels) {
      const x = c[i];
      sumSqIn += x * x;
      const y = x * gain;
      sumSqOut += y * y;
    }
  }
  const makeupDb = clampToParam(
    'compressor',
    'makeupDb',
    sumSqOut > 0 && sumSqIn > 0 ? 10 * Math.log10(sumSqIn / sumSqOut) : 0
  );

  params.thresholdDb = thresholdDb;
  params.makeupDb = makeupDb;
  return {
    run: true,
    params,
    derived: [
      {
        label: 'Threshold',
        value: dbfsStr(thresholdDb),
        from: `median detector level while sounding (louder than the ${dbfsStr(noise.envelopePeakDb)} peak of the quietest ${NOISE_WINDOW_MS} ms)`,
      },
      {
        label: 'Makeup',
        value: `${makeupDb >= 0 ? '+' : ''}${makeupDb.toFixed(1)} dB`,
        from: `the exact programme level ${dbStr(peakReductionDb)} of peak gain reduction will remove`,
      },
    ],
  };
}

/**
 * Noise Reduction: learn the print from the quietest real pause.
 *
 * Declines, loudly, in the two cases where subtraction would do harm or
 * nothing: when there is no passage above digital silence to learn from (an
 * all-zero print subtracts nothing, and a stage that silently does nothing is
 * exactly what Ruling 3 forbids), and when the quietest passage is not far
 * enough below the programme to be noise rather than voice.
 *
 * The viability margin is the stage's own `reductionDb`, not a number chosen
 * here: the effect is about to pull bins down by up to that much, so if the
 * quiet passage sits closer than that to the programme, what it would pull down
 * is the voice.
 *
 * ── The print is learned from REAL material (T2) ────────────────────────────
 * It asks for the MOSTLY-REAL search, the same one the gate, Remove Silence and
 * `wordSplice.trimSilence` each moved to, and here the reason is the sharpest of
 * the four: this stage's print IS the window's magnitude spectrum. A candidate
 * window that is mostly exact zeros has every bin of that spectrum diluted by
 * them, so the print describes the zeros rather than the recording, and the
 * subtraction that follows works to a fraction of its own depth. Nothing is
 * deleted — the failure is quiet, which is why it survived a classification
 * round as "degraded" without anyone putting a number on it.
 *
 * MEASURED, on an ordinary take: a trimmed head of exact zeros ending 25 ms
 * after a 50 ms search step, a settling stretch 10 dB above the take's own
 * between-phrase floor, three sung phrases. The bare search wins with a window
 * that is >90 % zeros; its print sits 6.79 dB (8 kHz) and 13.82 dB (44.1 kHz)
 * below the honest one in mean bin magnitude. End to end through the shipped
 * effect, out of the take's own pause: the honest print removes 9.38 dB (8 kHz)
 * and 11.22 dB (44.1 kHz) of floor where the diluted print removed 4.69 and
 * 2.88 — so the bare search was leaving 4.7 to 8.3 dB of the 12 dB this stage
 * promises in the recording. Both are kept as behaviour in
 * `the print, when the take carries digital silence beside an uneven floor`.
 *
 * The converse is fixtured beside it: the zeros are not the trigger, a diluted
 * WINNER is. On a take whose material beside the zeros is a sung phrase the
 * boundary window dilutes to about -30 dBFS and never comes near winning, both
 * searches return the same window, and the print does not move by a bin.
 *
 * And the cost, stated: when NO mostly-real window exists — a stem strip-
 * silenced by a tool with no hold, real audio surviving only as fragments
 * between zeros — the stage now DECLINES rather than learning a print from a
 * fragment's own diluted spectrum. That is the answer the gate and Remove
 * Silence already give on the same shape. It is also the cheap direction here:
 * a diluted print subtracts almost nothing, so refusing costs the user nothing
 * they were getting, and it says so instead.
 */
export function deriveNoiseReduction(channels: Float32Array[], sampleRate: number): StageResolution {
  const params = defaultParamsFor('noise-reduction');
  const noise = measureNoiseWindow(channels, sampleRate, { rejectMostlySilentWindows: true });
  if (!noise) {
    return {
      run: false,
      reason: `no ${NOISE_WINDOW_MS} ms passage of real material anywhere in the selection to learn a print from — every candidate window is digital silence, or mostly digital silence, and a print taken there is the zeros' own spectrum rather than this recording's floor — nothing was subtracted`,
    };
  }
  const rmsDb = programmeRmsDb(channels);
  const marginDb = rmsDb - noise.rmsDb;
  const reduction = Number(params.reductionDb);
  if (marginDb < reduction) {
    return {
      run: false,
      reason: `the quietest ${NOISE_WINDOW_MS} ms sits only ${dbStr(marginDb)} below programme level, less than the ${dbStr(reduction)} this stage would subtract — a print learned there would contain voice`,
    };
  }

  const window = channels.map((c) =>
    Float32Array.from(c.subarray(noise.startSample, noise.startSample + noise.lengthSamples))
  );
  return {
    run: true,
    params,
    extra: { spectra: averageMagnitudeSpectra(window) },
    derived: [
      {
        label: 'Noise print',
        value: `${(noise.startSample / sampleRate).toFixed(1)} s, ${dbfsStr(noise.rmsDb)}`,
        from: `the quietest ${NOISE_WINDOW_MS} ms in the selection, ${dbStr(marginDb)} below programme level`,
      },
    ],
  };
}

/** DeHum: notch mains hum, but only once it has been measured. */
export function deriveDeHum(channels: Float32Array[], sampleRate: number): StageResolution {
  const params = defaultParamsFor('dehum');
  if (!humMeasurable(channels[0]?.length ?? 0, sampleRate)) {
    return {
      run: false,
      reason: 'the selection is shorter than the 1 s the hum probe needs to tell 50 Hz from 60 Hz, so no verdict was reached',
    };
  }
  const hum = detectMainsHum(channels, sampleRate);
  if (!hum) {
    const mono = monoMix(channels);
    const readings = MAINS_BASE_FREQUENCIES.map((f) => {
      const excess = toneExcessDb(mono, sampleRate, f);
      return `${f} Hz ${excess === null ? 'n/a' : `${excess >= 0 ? '+' : ''}${excess.toFixed(1)} dB`}`;
    }).join(', ');
    return {
      run: false,
      reason: `no mains hum measured (${readings} above the surrounding spectrum, against a ${HUM_EXCESS_THRESHOLD_DB} dB threshold) — nothing was notched`,
    };
  }
  params.baseFreq = String(hum.baseHz);
  return {
    run: true,
    params,
    derived: [
      {
        label: 'Base frequency',
        value: `${hum.baseHz} Hz`,
        from: `measured +${hum.excessDb.toFixed(1)} dB above the surrounding spectrum, over the ${HUM_EXCESS_THRESHOLD_DB} dB threshold`,
      },
    ],
  };
}

/**
 * Remove Silence: threshold from the noise floor, with NO chosen margin.
 *
 * The threshold is the loudest the Remove-Silence detector ever reads inside
 * the quietest 500 ms — the level below which nothing in this recording
 * actually sits. Anything lower can never classify silence as silence, because
 * the room tone's own peaks stay above it: measured on the reference take the
 * noise window's envelope peaks 10.87 dB above its RMS.
 *
 * The derivation reproduces the shipped default independently, which is the
 * strongest evidence available that it is the right rule: it lands on
 * -50.4 dBFS where the effect's own hand-derived default is -50.
 *
 * It asks for the same MOSTLY-REAL search the gate does, and for the same
 * reason one stage earlier. A candidate window that is mostly exact zeros has
 * its RMS diluted by them and takes its envelope peak from the sliver of real
 * material at its edge, so on a take carrying digital silence the bare search
 * can win with a window that measures the wrong passage. On the shapes the
 * gate's own N3 was found on — a trimmed lead-in or a mid-file cut beside a
 * take with an EVEN floor — that costs nothing: the sliver is the same floor,
 * read over FEWER samples, so the boundary window's peak almost always
 * under-reads and this stage merely cut less. Measured over both shapes x 4
 * lengths (0.2/0.35/1.0/2.0 s, every cut landing wholly inside the take's
 * opening pause) x 8 and 44.1 kHz, the honest reading sits 0.00-0.82 dB ABOVE
 * the bare one in fifteen of sixteen members; the sixteenth is 0.07 dB the
 * other way, because a boundary window's envelope peak is a maximum over a
 * DIFFERENT span and the sign was never a theorem. All sixteen are kept.
 * When the floor is UNEVEN it costs material: with the louder stretch beside
 * the zeros, the boundary window is diluted under the take's own quietest
 * window and reports the LOUDER stretch's peak. Measured on a take whose
 * quietest floor is -70 dBFS and whose lead-in adjoins a -60 dBFS stretch,
 * the head ending 25 ms after a search step: threshold -54.98 dBFS against
 * the honest -64.55 at 8 kHz and -55.31 against -65.31 at 44.1 kHz, with 51
 * to 80 % of a real -62 dBFS sung phrase reading as silence to a stage that
 * DELETES what it calls silence. Unlike the gate this stage has no content
 * checks to catch it afterwards, so the measurement is the only defence.
 *
 * When no mostly-real window exists at all it DECLINES, exactly as the gate
 * does on the same shape. That refuses a strip-silenced take a stage it used
 * to run — but what it used to run was a threshold derived from a fragment's
 * own peak, and this stage removes what falls under its threshold, so the
 * alternative to refusing is deleting.
 *
 * `hiddenRealSamples` is deliberately NOT consulted here: it is the gate's
 * question ("was a threshold derived without seeing material that a gate
 * would then mute?"), and this stage's answer to hidden material is the same
 * decline the null case already gives when it is severe enough to leave no
 * mostly-real window. A take that hides fragments AND has a real floor to
 * measure is cut against that real floor, which is the right level for it.
 */
export function deriveRemoveSilence(channels: Float32Array[], sampleRate: number): StageResolution {
  const params = defaultParamsFor('remove-silence');
  const noise = measureNoiseWindow(channels, sampleRate, { rejectMostlySilentWindows: true });
  if (!noise) {
    return {
      run: false,
      reason: `no ${NOISE_WINDOW_MS} ms passage of real material to measure the noise floor from — every candidate window is digital silence, or mostly digital silence — so the threshold cannot be derived. A take whose quiet stretches are already exact zeros has no floor to tell them from`,
    };
  }
  const thresholdDb = clampToParam('remove-silence', 'thresholdDb', noise.envelopePeakDb);
  params.thresholdDb = thresholdDb;
  return {
    run: true,
    params,
    derived: [
      {
        label: 'Threshold',
        value: dbfsStr(thresholdDb),
        from: `the loudest the silence detector reads inside the quietest ${NOISE_WINDOW_MS} ms (its RMS is ${dbfsStr(noise.rmsDb)})`,
      },
    ],
  };
}

/**
 * Noise Gate — the stage the header used to argue against, and the three
 * settings that make it work on a sung take.
 *
 * THRESHOLD starts from `deriveRemoveSilence`'s number — the loudest the
 * silence detector reads inside the quietest 500 ms — and then clears it by a
 * measured headroom, which is the one place the two stages must differ.
 * Remove Silence can sit exactly ON that level because it needs a RUN of
 * 500 ms below it and a single graze merely splits one run into two. A gate
 * cannot: its reopen is instant, so one grazing sample re-opens it for a whole
 * hold. And the level IS grazed, because it is a maximum taken over 500 ms
 * being asked to bound pauses several times longer — the same floor simply
 * reaches it again. Measured over 144 constructed takes (8/22.05/44.1/48 kHz,
 * 1.5/3/6 s pauses, -35/-45/-60 dBFS floors, uniform and Gaussian floors, two
 * seeds each), the floor's envelope in the settled part of a pause exceeds that
 * threshold by up to 0.946 dB raw — and by up to 2.369 dB after Noise
 * Reduction, whose residual is peakier than the floor it replaced and which is
 * what actually reaches this stage in the chain. `GATE_HEADROOM_DB` is
 * therefore 3 dB: the smallest whole decibel above the worst measured graze.
 * It is not a safety cushion over the voice — on the reference take it moves
 * the threshold from -50.4 to -47.4 dBFS, still some 22 dB below the sounding
 * median `deriveCompressor` measures on the same take. The worst corner is
 * 8 kHz with short pauses over a Gaussian floor; the eight takes of it that
 * reproduce both figures exactly are KEPT as the `GATE_HEADROOM_DB` suite in
 * vocalChain.test.ts, rather than living only in this comment.
 *
 * It needs no clean noise print, so unlike Noise Reduction this stage does NOT
 * decline on a noisy take — which is the whole point, since that is the take
 * with the loudest gaps (N3).
 *
 * ATTACK AND RELEASE are the silence detector's own constants, and that is a
 * consequence of the threshold rather than a preference. `envelopePeakDb` is
 * defined as the peak of an `envelopeFollower(..., 1 ms, 20 ms)` envelope; a
 * gate whose detector uses a different release measures a DIFFERENT envelope
 * over the same audio and the threshold stops meaning what it was measured to
 * mean. Measured on the acceptance fixture (a sung take over a -45 dBFS floor):
 * inside the very window the threshold came from, a 150 ms release sits above
 * that threshold for 74.1 % of the window and a 400 ms release for 91.8 %,
 * against 0.0 % at 20 ms. Run end to end at the effect's shipped 150 ms the
 * gate never closes at all — the pauses came back at -62.5 dBFS instead of
 * digital silence. So `releaseMs` is 20 ms because `thresholdDb` is
 * `envelopePeakDb`; changing either without the other breaks the stage.
 *
 * The cost is stated: `releaseMs` is also the fade length, so the close is a
 * 20 ms linear-in-dB ramp to silence. That is 10x `remixRender`'s 2 ms
 * click floor and twice its ~10 ms "audible as a level change" line — and at a
 * gate close the level change IS the intent.
 *
 * HOLD is 500 ms: `SilenceRemoverEffect`'s `minSilenceMs`, this app's already
 * derived answer to "how long is a gap before it is unambiguously a pause
 * rather than articulation" (stop-consonant closures run to ~150 ms; pauses
 * start reading as pauses around ~250 ms). The gate may only close on what
 * Remove Silence would have been willing to cut. Measured on a held note with
 * two internal dips: at the effect's 50 ms hold the gate closes inside a 400 ms
 * dip — 1342 samples of a phrase faded toward zero — and at 500 ms both the
 * 120 ms and the 400 ms dip come back bit-identical. The delay this buys is
 * additive with the detector's own decay, so nothing shorter than 500 ms of
 * true silence can start the fade.
 *
 * Since G2 the automatic path is region-based and has no hold state — but the
 * constant keeps a second job there: material emerging from a
 * `GATE_SILENT_RUN_MS` run of digital silence is left un-muted for exactly
 * this long (the emergence split in `deriveGate`), which is the same one-hold
 * grace the old state machine gave whatever came out of a zero run.
 */
export const GATE_HOLD_MS = NOISE_WINDOW_MS;

/** How far a floor's envelope can stray above the envelope peak of its own
 * quietest window, dB — the smallest whole decibel above the worst graze
 * measured over 144 constructed takes (0.946 dB raw, 2.369 dB after Noise
 * Reduction; the `GATE_HEADROOM_DB` suite keeps the worst corner). Through
 * v1.31 this cleared the derived THRESHOLD over that peak, so one graze could
 * not re-open the gate. G2 retired the threshold, and the constant survives in
 * the one role the same measurement still justifies: `floor peak + this` is
 * "a level the settled floor never reaches", which is what the region-edge
 * placement reads — a region's start advances off a word's decay tail while
 * the envelope still sits above it, and a region's end walks forward over the
 * floor to the next onset knowing no graze can stop it early. */
export const GATE_HEADROOM_DB = 3;

/**
 * The share of a 500 ms window's pitch frames that may read VOICED before the
 * gate refuses to call that window part of a pause — since G2, the VOICED VETO:
 * a candidate mute region is kept whole when any 500 ms window inside it
 * crosses this, however loud or quiet the region is.
 *
 * The regime it exists for, in both designs: sung material so soft that every
 * level statistic reads it as floor. Under the old threshold a pianissimo
 * verse's quietest window put the threshold above the whole passage — measured
 * on exactly that fixture, 100 % of the soft verse faded to hard zero. Under
 * the region design the same regime arrives as a voiced passage whose TILT the
 * shape veto cannot see: a soft voice with its power spread across ~40
 * partials reads a residual of 2.2 dB at 44.1 kHz — under the 2.5 dB boundary
 * — while every frame of it reads voiced (the kept "voiced veto, live" test).
 * This constant is the only protection standing there.
 *
 * Voice is periodic and room tone is not, which is a question `detectPitch`
 * already answers per frame — and `pitchDetect`'s own note says so: its silence
 * gate is a digital-silence floor, and "audible noise floors are rejected by
 * the periodicity threshold instead". The two populations do not overlap.
 * Measured over a 500 ms window at 8/22.05/44.1/48 kHz — every rate, because
 * `detectPitch` sizes its analysis frame in SAMPLES, so a population taken at
 * one rate is evidence about that rate only. Each of these members is a
 * member of the kept `GATE_VOICED_FRACTION` sweep, not a figure quoted past
 * what the test measures:
 *
 *   - 96 noise floors — uniform and Gaussian, -30 to -75 dBFS, three seeds,
 *     four rates — read a voiced fraction of 0.000. Not "near zero": every one
 *     was exactly zero voiced frames of the 45-46 the detector fits in 500 ms.
 *   - 4 post-Noise-Reduction residuals, one per rate — the floor that actually
 *     reaches this stage in the chain, taken from the middle of a real pause
 *     of a real NR pass rather than modelled — read 0.000 as well. NR's
 *     remnant is a subtracted spectrum, not the room's own, so it belongs in
 *     the population rather than beside it.
 *   - 192 sung windows — three fundamentals (98/196/392 Hz) with harmonics and
 *     vibrato, -20 to -50 dBFS, four rates, alone and carrying breaths of
 *     150/250/350 ms — read 0.156 at worst (7 voiced frames of 45, at
 *     22.05 kHz), and that worst case is a window that is 70 % breath.
 *
 * 0.05 sits between them with margin in both directions: it tolerates two
 * spurious voiced frames in a floor window (the populations gave none), and it
 * is more than three times below the hardest real sung window. Widening the
 * sweep from one rate to four moved neither end — the gap is 0.000 to 0.156
 * at 8 kHz and 0.000 to 0.156 over all four. When it fires, the region it
 * fired in is KEPT — never muted, never split around the voice — and the
 * report counts it: a gate that cannot tell a pause from a soft phrase must
 * not mute one, which is the same refusal the old design made take-wide.
 *
 * Applied per 500 ms window INSIDE a region (the sliding maximum), not as one
 * fraction over the whole region, because the populations were measured on
 * 500 ms windows and a region-wide fraction would dilute a one-second hum
 * inside a five-second pause below any constant these populations support.
 */
export const GATE_VOICED_FRACTION = 0.05;

/**
 * How far a 500 ms window's spectrum may depart from a straight line in
 * log-frequency, dB, before the gate stops believing it is room tone — since
 * G2 the boundary of BOTH halves of the vocal-tract evidence: the activity
 * segmentation (a window above it is vocal activity, so the stretches the gate
 * may mute are the stretches between such windows) and the per-region veto
 * that re-asks the question of every candidate before it is muted.
 *
 * `GATE_VOICED_FRACTION` settles the case where the material is SUNG. It
 * cannot settle the case where it is vocal but UNVOICED — a whisper, a
 * sustained aspirate, a held sibilant — because those are noise, and a pitch
 * detector reads them unvoiced exactly as it reads a floor. Measured under the
 * old threshold design, the consequence was identical to the sung one: a take
 * whose soft half is whispered and whose loud half is sung came back with
 * 100 % of the whisper faded to hard zero.
 *
 * What still separates them is where the noise has been — a vocal tract puts
 * resonances on it, a room does not. `spectralTiltResidualDb` measures exactly
 * that (see its own note for why the tilt has to be fitted out rather than
 * assumed flat). Measured over 500 ms windows at 8/22.05/44.1/48 kHz:
 *
 *   - noise floors — white and one-pole-tilted at 400, 800 and 2500 Hz, three
 *     seeds, 48 members — read 0.63 … 1.91 dB. (The post-Noise-Reduction
 *     residual is NOT among them: it was measured separately at 0.75 … 1.66 dB,
 *     inside the range, but the kept population is the 48 above and this note
 *     names only what the test measures.)
 *   - unvoiced VOCAL — whispers (three formants, sustained and with syllabic
 *     swell) and sibilants (single resonances from 2.8 to 6 kHz) — read
 *     3.20 … 10.58 dB.
 *
 * 2.5 dB is the midpoint of that gap in the ratio sense (sqrt(1.91 x 3.20) =
 * 2.47): 1.31x above the worst floor and 1.28x below the closest vocal window,
 * which is a wider margin than the voiced check's. The closest vocal member is
 * the least shaped one — a sibilant modelled as ONE broad resonance near
 * Nyquist at the lowest rate, where a single wide hump is nearly a tilt; the
 * whispers, which have three formants, sit three to five times clear.
 *
 * Four other signals were measured and rejected because their populations
 * overlap outright: spectral flatness, spectral centroid, envelope modulation
 * depth and voiced fraction all put a rolled-off floor and a whisper on the
 * same side of every possible constant.
 *
 * ── Why the veto is NOT relaxed where words say "no words here" (G2) ────────
 * The transients the user wants gone — chair creaks, thumps — are resonant,
 * and resonance is exactly what this statistic calls a vocal tract: a 120 ms
 * creak burst (a 180 Hz two-pole resonance) inside a 500 ms floor window
 * reads 4.06 dB, INSIDE the unvoiced-vocal population's own 3.20…10.58 dB
 * range. No relaxed boundary exists that admits the creak and still keeps the
 * whisper, so the veto stays even where word evidence says nothing was sung —
 * a creak-holding half-second survives as a short kept island while the floor
 * around it is muted, and the report's Kept row is where that shows up. An
 * isolated soft tick inside a LONG window is different arithmetic — averaged
 * over the window it may stay under the boundary and mute with the floor —
 * and that is the correct reading of the same evidence, not an exception.
 *
 * ── The residual this does NOT close, stated plainly ────────────────────────
 * One member of the unvoiced-vocal family survives every one of those five
 * measurements: broadband noise with no vocal-tract shaping at all, at a
 * constant level — a first-order high-passed hiss. The two members the kept
 * test measures read 1.931 dB at 8 kHz and 1.473 dB at 44.1 kHz, and across
 * four rates and four seeds it spans 1.411 … 2.075 dB — inside the floor
 * population at every rate but 8 kHz, where it sits 1 % above the worst floor
 * member (1.931 against 1.911) and still inside the population's own asserted
 * bound. It is likewise inside the floor population on flatness, centroid
 * and modulation. That is not a gap in the measurement; it is what the
 * measurement is telling us. Such a passage IS a noise floor in every physical
 * sense, and no statistic can call it voice, because the only thing that makes
 * it voice is that a person made it. `the one unvoiced passage this cannot
 * catch` pins that overlap so the limitation stays measured rather than
 * forgotten, and the user guide states it.
 *
 * ── The converse it does not close either: the SHAPED ROOM, now measured ────
 * The other direction fails on real rooms, wall to wall. The 2 min 22 s take
 * that motivated G2 (a room with resonant machinery in it) reads OVER this
 * boundary in every one of its 2833 windows — 3.01 dB at the very quietest,
 * 3.0-3.9 across its audible pauses, 4.8-10.2 across its vocal content — raw
 * AND after Noise Reduction, whose subtraction does not flatten the shape. On
 * that room this stage finds no floor anywhere and declines, saying so in the
 * message the user reads. A take-RELATIVE boundary (the take's own minimum
 * windowed residual plus a derived excess) was measured and REJECTED, because
 * its populations overlap outright: over stationary shaped-room models (a fan
 * at 180 Hz, an HVAC pair, machinery, a bass boom, at 8/44.1/48 kHz x 3
 * seeds) a room's windows spread only 0.14-0.77 dB above their own minimum —
 * but a whisper ON such a room stands 0.00-2.19 dB above it, the zero being a
 * whisper whose formants the room's stronger resonances simply bury. No
 * constant separates "the room again" from "a whisper this room drowns", so
 * the boundary stays absolute, the shaped room stays a decline, and the
 * manual threshold stays the stated tool for that room.
 */
export const GATE_SHAPED_RESIDUAL_DB = 2.5;

/**
 * How far below the quietest window's own RMS its mono MIX may sit, in dB,
 * before the gate concludes the channels cancel each other and declines
 * (M9/N5).
 *
 * The content checks read the MIX, and the mix of a channel with its own
 * inversion is digital zero — both checks would read silence and wave through
 * a take whose mono version declines. The first version of this guard counted
 * exact zeros in the mix against the window bound, and its premise — "a
 * mostly-zero mix of a mostly-real window can only mean cancellation" — was
 * measurably false: frame silence is a PRODUCT (every channel exactly zero)
 * while a mix zero is a SUM (L = -R at that sample), and for two independent
 * channels a few LSB wide the sum runs several times the product. Ordinary
 * quiet quantised stereo (8-bit floors near -42 dBFS, 12-bit near -66,
 * 16-bit near -90 — everyday material) read 26-27 % mix zeros against ~14 %
 * silent frames, tripped the count, and was told to fix a polarity flip it
 * did not have.
 *
 * LEVEL separates the cases where counting cannot. Measured on the quietest
 * window of exactly those takes: two independent channels mix to the
 * uncorrelated sum's 3.0 dB below the window RMS (3.00-3.10 dB across
 * 8/12/16-bit floors at 8 and 44.1 kHz — the value is arithmetic, not
 * fixture luck), while a truly inverted pair mixes to digital zero,
 * 203 dB deep. 60 dB sits 57 dB above anything two non-derived channels
 * measured across a whole broadband 500 ms window, and ~143 dB below a true
 * inversion: at 60 dB of cancellation the mix retains less than a thousandth
 * of the window's material, so checks reading it would be reading nothing. A
 * gain-riding inversion (R = -g·L) crosses it only for |1 - g| < 0.002 —
 * channels that are derived copies, for which the polarity diagnosis is the
 * right one — while shallower pairs keep a faithful, merely attenuated mix
 * and fall through to the ordinary checks.
 *
 * WHAT SURVIVES EVERY REDESIGN ABOUT IT (I1/G2/C1). Every other refusal is
 * per-candidate in the ordinary sense: a candidate that is not a pause is
 * kept, and the next one is asked. This one is not a refusal of that kind and
 * is never stepped past, because it is a fact about the FILE rather than about
 * one candidate's suitability: the mix of an exactly inverted pair is digital
 * zero, so a whispered line and an empty room are the same measurement, and
 * whatever a gate did there would be done to something nothing was able to
 * read. So it is asked of every 500 ms WINDOW of every candidate region
 * before any veto runs — per window and not per region, because the depth is
 * a ratio of sums and a region-wide sum dilutes: an inverted stretch sharing
 * its candidate with honest floor collapses far under this constant while its
 * own windows still read ~200 dB (the C1 regression, demonstrated and pinned)
 * — and the first window found ends the stage with the polarity diagnosis,
 * the same granularity the V2 search's window-by-window diagnosis enforced.
 */
export const GATE_CANCELLATION_DEPTH_DB = 60;

// ── The region machinery (G2) ───────────────────────────────────────────────
// The automatic gate no longer derives a level. It decides WHERE: the
// stretches between vocal activity are the candidates, every candidate must
// pass the protective evidence, and what passes is muted through the effect's
// mute-region side channel (`NoiseGateMuteRegionsExtra`). The manual path is
// untouched.

/** Word-level (or segment-level) activity spans for the automatic gate, in
 * REGION-relative samples, with the source named so the report can say which
 * evidence decided. Collected by {@link collectGateWordEvidence}. */
export interface GateWordEvidence {
  source: 'lyrics-alignment' | 'transcript-segments';
  spans: { startSample: number; endSample: number }[];
}

/**
 * The word evidence the automatic gate reads, mapped into the REGION frame.
 *
 * Word-level spans (Align Lyrics) win over segment-level ones (the
 * transcript): both mark where the performance is, but only the alignment
 * knows it word by word, and a transcript SEGMENT deliberately over-covers —
 * it can span several phrases with their internal pauses, which merely makes
 * the gate more conservative, never less.
 *
 * Either source is used only while FRESH, by the same channel-identity test
 * the panels show staleness with: an edit that moved samples leaves spans
 * describing audio that no longer exists, and gating on those would mute the
 * performance itself. Stale evidence, and evidence whose spans do not touch
 * this region at all, returns null — the caller then falls back to measured
 * activity, because evidence that says nothing must not be read as evidence
 * of absence.
 */
export function collectGateWordEvidence(
  docId: string,
  regionStart: number,
  regionEnd: number
): GateWordEvidence | null {
  const clip = (
    spans: readonly { startSample: number; endSample: number }[]
  ): { startSample: number; endSample: number }[] =>
    spans
      .filter((s) => s.startSample < regionEnd && s.endSample > regionStart)
      .map((s) => ({
        startSample: Math.max(0, s.startSample - regionStart),
        endSample: Math.min(regionEnd, s.endSample) - regionStart,
      }));

  const alignment = getLyricsAlignment(docId);
  if (alignment && !isLyricsAlignmentStale(docId)) {
    const spans = clip(alignment.words);
    if (spans.length > 0) return { source: 'lyrics-alignment', spans };
  }
  const transcript = getTranscript(docId);
  if (transcript && !isTranscriptStale(docId)) {
    const spans = clip(transcript.segments);
    if (spans.length > 0) return { source: 'transcript-segments', spans };
  }
  return null;
}

/** The mono MIX of one span — what the vetoes read, so a whisper living in ONE
 * channel is still a whisper (M4). Mixed over the SPAN only, not the take:
 * `monoMix` on a 142 s stereo take would allocate 25 MB to look at a stretch
 * of it. */
function mixSpan(channels: Float32Array[], start: number, end: number): Float32Array {
  const out = new Float32Array(end - start);
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (const c of channels) sum += c[start + i];
    out[i] = sum / channels.length;
  }
  return out;
}

/**
 * The M9 CANCELLATION diagnosis for one candidate region, or `null`.
 *
 * Not one of the vetoes: those answer "is this stretch a pause", and a `no`
 * keeps the stretch. This answers "can this stretch be judged AT ALL", and a
 * `no` is a fact about the FILE — the mix of an exactly polarity-inverted
 * pair is digital zero, so every mix-reading measurement here (the activity
 * windows, both vetoes) sees silence where there may be a whispered line.
 *
 * PER 500 ms WINDOW, never per region — the depth is a ratio of sums, and a
 * sum over a MIXED region dilutes: an inverted stretch sharing its candidate
 * with honest floor reads the floor's real mix in the denominator, the
 * ~200 dB the inverted windows carry on their own collapses far under the
 * 60 dB constant, and the whisper is muted with nothing having read it
 * (demonstrated — the C1 regression, 9600 of 9600 whisper samples destroyed
 * where base declined). So the statistic slides on the same 50 ms grid the
 * vetoes read, depth = window channel-RMS − window mix-RMS, and the FIRST
 * window crossing `GATE_CANCELLATION_DEPTH_DB` ends the stage — the old
 * design's own window-by-window granularity, restored at region level.
 *
 * Windows whose FRAMES are mostly digital silence are skipped as the
 * non-measurements they are (the `NOISE_WINDOW_MAX_SILENT_FRACTION` rule):
 * true silence must not read as cancellation. The mask is on FRAME silence,
 * never on mix silence — an inverted stretch's mix is all zeros while its
 * frames are not, and a mix-silence mask would skip exactly the windows this
 * diagnosis exists to catch (the same trap `maxWindowedTilt`'s mask note
 * warns about, from the other side).
 *
 * Detected by LEVEL, not by counting zeros in the mix: frame silence is a
 * product where a mix zero is a sum, and a zero count mistakes ordinary quiet
 * quantised stereo for an inverted pair (N5) — the depth populations behind
 * the constant were measured on 500 ms windows, so this statistic is the one
 * they actually justify. Asked of EVERY candidate region, before any veto,
 * and never stepped past (I1).
 */
function regionCancellation(
  channels: Float32Array[],
  sampleRate: number,
  span: { start: number; end: number }
): string | null {
  const length = span.end - span.start;
  if (length <= 0) return null;
  const nch = Math.max(1, channels.length);
  const win = Math.min(length, Math.round((NOISE_WINDOW_MS / 1000) * sampleRate));
  const step = Math.max(1, Math.round((NOISE_SEARCH_STEP_MS / 1000) * sampleRate));

  // Prefix sums over the span: channel energy, mix energy, frame-silent count.
  const chSq = new Float64Array(length + 1);
  const mixSq = new Float64Array(length + 1);
  const silent = new Float64Array(length + 1);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    let sq = 0;
    let allZero = true;
    for (const c of channels) {
      const v = c[span.start + i];
      sum += v;
      sq += v * v;
      if (v !== 0) allZero = false;
    }
    const mix = sum / nch;
    chSq[i + 1] = chSq[i] + sq;
    mixSq[i + 1] = mixSq[i] + mix * mix;
    silent[i + 1] = silent[i] + (allZero ? 1 : 0);
  }

  // Window positions on the step grid, plus one anchored at the span's end so
  // coverage reaches the final sample (the same coverage rule the vetoes use).
  for (let s = 0; ; s += step) {
    const at = s + win <= length ? s : length - win;
    const end = at + win;
    if ((silent[end] - silent[at]) / win <= NOISE_WINDOW_MAX_SILENT_FRACTION) {
      const chRmsDb = toDb(Math.sqrt((chSq[end] - chSq[at]) / (win * nch)));
      const mixRmsDb = toDb(Math.sqrt((mixSq[end] - mixSq[at]) / win));
      if (chRmsDb - mixRmsDb > GATE_CANCELLATION_DEPTH_DB) {
        return `the channels of the stretch at ${((span.start + at) / sampleRate).toFixed(1)} s cancel each other to digital silence when mixed — one is the other inverted — so the checks that tell a pause from a phrase cannot see it at all, and muting between activity could silence something nothing was able to read. Fix the inverted channel's polarity and run the chain again`;
      }
    }
    if (s + win > length) break;
  }
  return null;
}

/**
 * The VOICED veto's statistic: the worst (largest) voiced fraction of any
 * `NOISE_WINDOW_MS` group of pitch frames inside the region — a sliding
 * maximum rather than one region-wide fraction, because
 * `GATE_VOICED_FRACTION`'s populations were measured on 500 ms windows and a
 * region-wide fraction would dilute a one-second hum inside a five-second
 * pause below any constant those populations support. The pitch track runs
 * once over the region; the sliding maximum reuses its frames.
 */
function maxWindowedVoicedFraction(mix: Float32Array, sampleRate: number): number {
  const track = detectPitch(mix, sampleRate);
  const frames = track.frames;
  if (frames.length === 0) return 0;
  const winSamples = Math.round((NOISE_WINDOW_MS / 1000) * sampleRate);
  const perGroup = Math.min(
    frames.length,
    Math.max(1, Math.floor((winSamples - track.frameSamples) / track.hopSamples) + 1)
  );
  const prefix = new Int32Array(frames.length + 1);
  for (let i = 0; i < frames.length; i++) {
    prefix[i + 1] = prefix[i] + (frames[i].f0Hz !== null ? 1 : 0);
  }
  let worst = 0;
  for (let i = 0; i + perGroup <= frames.length; i++) {
    const fraction = (prefix[i + perGroup] - prefix[i]) / perGroup;
    if (fraction > worst) worst = fraction;
  }
  return worst;
}

/** The VOCAL-TRACT veto's statistic: the worst windowed tilt residual inside
 * the region — the same per-window measurement the activity segmentation
 * reads, re-asked of the candidate on its own grid so a region whose edges
 * moved during padding is still judged whole. Grid coverage reaches to within
 * one 50 ms step of the region's end; the remainder is shorter than any
 * length the classifier can carry a verdict on (see `GATE_MIN_REGION_MS`).
 *
 * MOSTLY-SILENT windows are not verdicts and are skipped, by the same
 * `NOISE_WINDOW_MAX_SILENT_FRACTION` bound the noise search applies: the
 * spectrum of a window straddling a digital-silence edge is the edge's own
 * broadband step, not a room's or a voice's (the N2 boundary artefact), and a
 * candidate holding a stretch of zeros beside its floor would otherwise be
 * vetoed by its own silence. Nothing vocal hides in what this skips: a window
 * that is mostly zeros beside REAL vocal material reads the material's shape
 * and was already activity at segmentation, and an exactly cancelling pair —
 * whose mix is zeros wall to wall — was declined before any veto ran. */
function maxWindowedTilt(mix: Float32Array, sampleRate: number): number {
  const win = Math.round((NOISE_WINDOW_MS / 1000) * sampleRate);
  const zeroPrefix = new Float64Array(mix.length + 1);
  for (let i = 0; i < mix.length; i++) zeroPrefix[i + 1] = zeroPrefix[i] + (mix[i] === 0 ? 1 : 0);
  let worst = 0;
  for (const row of windowedTiltResidualsDb(mix, sampleRate)) {
    const zeros = zeroPrefix[Math.min(mix.length, row.startSample + win)] - zeroPrefix[row.startSample];
    if (zeros / win > NOISE_WINDOW_MAX_SILENT_FRACTION) continue;
    if (row.residualDb > worst) worst = row.residualDb;
  }
  return worst;
}

/**
 * @param manualThresholdDb A level the USER named, in dBFS. When present the
 * region derivation is not attempted at all and the old level-gate runs at
 * this threshold — see the block below for why the escape has to exist and
 * why it wins.
 * @param words Fresh word evidence for this region, from
 * {@link collectGateWordEvidence}, or null/absent when none exists — the
 * automatic path then finds the activity by measurement alone, which is the
 * MORE conservative rule (sub-floor singing is invisible to measurement, so
 * without words such a take declines rather than gambles).
 */
export function deriveGate(
  channels: Float32Array[],
  sampleRate: number,
  manualThresholdDb?: number,
  words?: GateWordEvidence | null
): StageResolution {
  const params = defaultParamsFor('noise-gate');
  // EVERY refusal of this stage ends the same way (V2/R2). Whatever the
  // measurement could not do — no pause anywhere, no floor above digital
  // silence, an unshaped breath no statistic can tell from a room — the user
  // can still name a level, and a refusal that does not say so leaves them
  // with a paragraph where they asked for silence.
  //
  // M4 — and the escape has to be reachable FROM WHERE THIS TEXT IS READ. The
  // usual way to reach it is a mixed run: another stage applied, this one
  // declined. The dialog is then finished (`report.applied`) and greys every
  // control including the tick this sentence points at, so the recovery is
  // close-and-reopen, not tick-and-Apply. Naming the control by the words
  // printed on it and naming the reopen is what makes the sentence true in
  // both states; the gate-only refusal leaves the dialog unlocked, where
  // "reopen if it applied" simply does not apply.
  const decline = (reason: string): StageResolution => ({
    run: false,
    reason: `${reason}. If you can hear a gap that ought to be silent, set this stage's threshold yourself: tick “Gate at a level I set instead” on the Vocal Chain's Noise Gate row, type a level in dBFS and Apply — it gates at that level with the same hold, fades and digital-silence rules. If the rest of the chain already applied, this dialog is finished and its controls are greyed, so reopen Vocal Chain first. Nothing was gated`,
  });
  const attackMs = clampToParam('noise-gate', 'attackMs', DETECT_ATTACK_MS);
  const releaseMs = clampToParam('noise-gate', 'releaseMs', DETECT_RELEASE_MS);
  const holdMs = clampToParam('noise-gate', 'holdMs', GATE_HOLD_MS);
  params.attackMs = attackMs;
  params.releaseMs = releaseMs;
  params.holdMs = holdMs;

  /** How many samples of `env` sit ABOVE a level — the effect's own comparison,
   * so both things this function asks of it (is anything left at all, and how
   * many seconds go quiet) predict what the effect will actually do. */
  const soundingAbove = (db: number, env: Float32Array): number => {
    const lin = Math.pow(10, db / 20);
    let n = 0;
    for (let i = 0; i < env.length; i++) if (env[i] > lin) n++;
    return n;
  };
  const gatedSecondsAt = (db: number, env: Float32Array): number =>
    (env.length - soundingAbove(db, env)) / sampleRate;

  // R2 — THE LAST WORD IS THE USER'S.
  //
  // Everything below this block is a measurement, and a measurement can be
  // absent: no statistic tells an UNSHAPED breath from room tone (see
  // `GATE_SHAPED_RESIDUAL_DB`'s closing note), no evidence finds a pause in a
  // take that has none, and the region path deliberately refuses to mute a
  // take whose singing is too quiet for any measurement to vouch for when no
  // word evidence exists. On those takes the stage used to have nothing to
  // offer but a paragraph, and "no word, no sound" — the thing the user
  // actually asked for — was unreachable.
  //
  // So a threshold the user names is taken as given. It wins over a successful
  // derivation as well, because a box that silently did nothing on the takes
  // that DO measure would be worse than no box: the user sets it after reading
  // a refusal, and would have no way to tell whether it had been honoured.
  // Only the threshold's SOURCE changes — the detector constants, the hold, the
  // fades and the digital-silence rule are the stage's own, unchanged — and the
  // `Gated` row still reports what the level will actually silence, which is
  // the only way to see that it was set too high.
  if (manualThresholdDb !== undefined && Number.isFinite(manualThresholdDb)) {
    const thresholdDb = clampToParam('noise-gate', 'thresholdDb', manualThresholdDb);
    params.thresholdDb = thresholdDb;
    const env = envelopeFollower(maxAcrossChannels(channels), sampleRate, attackMs, releaseMs);
    return {
      run: true,
      params,
      derived: [
        {
          label: 'Threshold (manual)',
          value: dbfsStr(thresholdDb),
          from: `the level you set yourself — this stage measured nothing, and says so rather than dressing your number up as a derivation`,
        },
        {
          label: 'Gated',
          value: `${gatedSecondsAt(thresholdDb, env).toFixed(1)} s`,
          from: `the part of the selection sitting under that threshold — the rest stays at full level. Set it lower if this is more than the pauses`,
        },
        {
          label: 'Hold',
          value: `${holdMs.toFixed(0)} ms`,
          from: `the shortest gap this app calls a pause rather than articulation (Remove Silence's own minimum), so nothing briefer can close the gate — the ${releaseMs.toFixed(0)} ms release is the detector this stage always runs`,
        },
      ],
    };
  }
  // ── The automatic path: regions from activity (G2) ──────────────────────
  //
  // No level is derived. The stage asks WHERE the vocal activity is, takes
  // the stretches between as candidates, and mutes a candidate only when
  // every protective check agrees nothing vocal lives in it:
  //
  //   1. ACTIVITY — word spans, when `collectGateWordEvidence` found fresh
  //      ones: the only evidence that can vouch for singing too quiet to
  //      measure (the louder-pauses scenario, which is the user's actual
  //      complaint). With or without words, every 500 ms window reading
  //      vocal-tract shape (`windowedTiltResidualsDb` over
  //      `GATE_SHAPED_RESIDUAL_DB`) is activity too, so a whisper, a breath
  //      or an unscripted line between words keeps its stretch out of the
  //      candidates entirely.
  //   2. GEOMETRY — a candidate seed is the union of the windows that read
  //      as FLOOR, minus every word span, so a sample qualifies only when a
  //      whole half-second around it measured floor-like and no word claims
  //      it. Its start advances off the preceding activity's decay while the
  //      envelope sits above the gap's own floor reference (the gap's
  //      quietest mostly-real window's envelope peak plus `GATE_HEADROOM_DB`
  //      — the level the settled floor never reaches); its end walks forward
  //      over the floor to the next true onset the same way — the grid's
  //      straddling windows leave up to half a second of plain floor
  //      before an onset outside the seed, and the walk claims it, stopped
  //      only by the envelope rising off the floor, by a word span's start,
  //      or by material emerging from a `GATE_SILENT_RUN_MS` run of digital
  //      silence, because silence is not evidence about what sits beside it
  //      (N6's principle, region form). A finished candidate is at least
  //      `GATE_MIN_REGION_MS` long.
  //   3. VETOES — cancellation first, asked of every 500 ms WINDOW of every
  //      candidate (a fact about the file, never stepped past, and per
  //      window because a region-wide depth dilutes — C1); then the voiced
  //      veto and the vocal-tract veto per candidate, in the order the
  //      messages were derived in. No stretch is muted on word-absence alone.
  //   4. SILENCE — a gap that is digital silence, or that holds real audio
  //      only as fragments inside digital silence, is skipped whole: zeros
  //      stay zeros, and fragments the search cannot measure must not be
  //      muted unheard (the eviction census's principle, in region form).
  const n = channels[0]?.length ?? 0;
  const windowSamples = Math.round((NOISE_WINDOW_MS / 1000) * sampleRate);
  const stepSamples = Math.max(1, Math.round((NOISE_SEARCH_STEP_MS / 1000) * sampleRate));
  const minRegionSamples = Math.round((GATE_MIN_REGION_MS / 1000) * sampleRate);
  const silentRunSamples = Math.max(1, Math.round((GATE_SILENT_RUN_MS / 1000) * sampleRate));
  if (n < windowSamples) {
    return decline(
      `the selection is shorter than the ${NOISE_WINDOW_MS} ms this app calls a pause, so nothing in it can be one`
    );
  }

  const mono = monoMix(channels);
  const frameSilent = (i: number): boolean => {
    for (const c of channels) if (c[i] !== 0) return false;
    return true;
  };

  // 1. The per-window verdicts, once over the whole region. A window over the
  // vocal-tract boundary is ACTIVITY; a window under it is a FLOOR VERDICT,
  // and the muteable seed is the union of the floor windows' spans minus
  // every word span — a sample is a candidate only when at least one whole
  // half-second containing it measured floor-like AND no word claims it.
  // Both edge behaviours of this construction are load-bearing: a window
  // straddling a phrase edge reads the phrase's shape (activity), so the
  // seed's boundary lands within one 50 ms grid step of where the floor
  // really begins; and a window that touches vocal material with almost all
  // of its span in digital silence still reads the MATERIAL's shape — zeros
  // have no spectrum to dilute with — so silence never vouches for what sits
  // beside it (the N2/N3 family).
  const tiltRows = windowedTiltResidualsDb(mono, sampleRate);
  const shapedSpans: { start: number; end: number }[] = [];
  const floorCovered = new Uint8Array(n);
  for (const row of tiltRows) {
    const rowEnd = Math.min(n, row.startSample + windowSamples);
    if (row.residualDb > GATE_SHAPED_RESIDUAL_DB) {
      const last = shapedSpans[shapedSpans.length - 1];
      if (last && row.startSample <= last.end) last.end = rowEnd;
      else shapedSpans.push({ start: row.startSample, end: rowEnd });
      continue;
    }
    floorCovered.fill(1, row.startSample, rowEnd);
  }
  // What is deliberately NOT subtracted: the SPANS of the shaped windows. A
  // shaped window straddling a phrase edge covers up to 450 ms of plain
  // floor, and subtracting its whole span erases every pause shorter than
  // about 1.4 s — measured, the fixtures with 0.8-1.0 s pauses lost their
  // seeds entirely. The floor-verdict windows' own testimony stands instead,
  // and the cost is bounded and stated: a boundary window can carry a sliver
  // of an adjacent quiet vocal's edge (at most the fraction that still reads
  // under the boundary — beyond ~a fifth of a window the shape verdict flips)
  // and that sliver can be muted with the floor. The vocal's BODY is
  // protected by the windows centred on it, the envelope contraction below
  // trims any edge that rises above the local floor, and the old threshold
  // design muted the same sub-floor slivers wholesale.
  const wordSpans = (words ? words.spans : [])
    .map((s) => ({
      start: Math.max(0, Math.min(n, Math.floor(s.startSample))),
      end: Math.max(0, Math.min(n, Math.ceil(s.endSample))),
    }))
    .filter((s) => s.end > s.start);
  for (const s of wordSpans) floorCovered.fill(0, s.start, s.end);

  if (shapedSpans.length === 0 && wordSpans.length === 0) {
    // Nothing anywhere reads as a performance, so "the stretches between
    // activity" would be the whole selection and muting them would mute all
    // of it. Before saying so, the one file this measurement cannot read at
    // all: the activity pass reads the MIX, and the mix of an exactly
    // inverted pair is digital zero — silence to every window — so the
    // quietest real half-second is asked whether it cancels first (M9).
    const quietest = measureNoiseWindow(channels, sampleRate, { rejectMostlySilentWindows: true });
    if (quietest) {
      const cancelling = regionCancellation(channels, sampleRate, {
        start: quietest.startSample,
        end: quietest.startSample + quietest.lengthSamples,
      });
      if (cancelling !== null) return decline(cancelling);
      return decline(
        `nothing in the selection reads as vocal activity — every ${NOISE_WINDOW_MS} ms of it measures like a noise floor, with no voiced frames and no vocal-tract shape — so the quiet stretches ARE the material, and muting the stretches between activity would mute all of it`
      );
    }
    return decline(
      `no ${NOISE_WINDOW_MS} ms passage of real material anywhere in the selection — every stretch is digital silence, or real audio surviving only as fragments inside digital silence — and a take whose pauses are already exact zeros has nothing for a gate to do`
    );
  }

  // The word spans' starts bound the end-walk below: evidence boundaries are
  // never crossed, where a measured window boundary is grid quantisation the
  // walk exists to cross.
  const hardStarts = wordSpans.map((s) => s.start).sort((a, b) => a - b);
  // Infinity, not `n`, when no word start lies ahead: the sentinel must not
  // masquerade as a word boundary, because a cap AT a word boundary is
  // trusted evidence while a cap at the take's end is as blind as any other.
  const nextHardStart = (from: number): number => {
    for (const h of hardStarts) if (h >= from) return h;
    return Infinity;
  };

  // 2. The gaps: maximal runs of the muteable seed, each judged on its own
  // local evidence.
  const gaps: { start: number; end: number }[] = [];
  {
    let runStart = -1;
    for (let i = 0; i <= n; i++) {
      const covered = i < n && floorCovered[i] === 1;
      if (covered && runStart < 0) runStart = i;
      else if (!covered && runStart >= 0) {
        gaps.push({ start: runStart, end: i });
        runStart = -1;
      }
    }
  }
  if (gaps.length === 0) {
    // The decline the shaped-room user actually reads, so it carries the
    // run's own measured figures — every stage reports what it measured, and
    // this refusal is a measurement like any other. No mostly-silent windows
    // can be hiding here: a mostly-zero window reads a residual of ~0 and
    // would have seeded a gap, so reaching this branch means every window
    // read OVER the boundary and the minimum below is a real reading.
    let minResidualDb = Infinity;
    for (const row of tiltRows) if (row.residualDb < minResidualDb) minResidualDb = row.residualDb;
    return decline(
      `the selection never pauses — every one of its ${tiltRows.length} half-seconds reads as vocal activity, the quietest at ${minResidualDb.toFixed(1)} dB of vocal-tract shape against the ${GATE_SHAPED_RESIDUAL_DB} dB boundary, and a stretch between activity is the only thing this stage may mute. A room whose own noise carries resonances (a fan, an air conditioner, a machine) reads the same way, and no measurement here can tell the two apart`
    );
  }

  const env = envelopeFollower(maxAcrossChannels(channels), sampleRate, attackMs, releaseMs);
  const holdSamples = Math.max(1, Math.round((GATE_HOLD_MS / 1000) * sampleRate));
  // Shape coverage, for the edges level cannot place: a vocal QUIETER than
  // the gap's own floor never lifts the envelope over the reference, so where
  // the envelope rule runs out, the region's edge retreats out of any sample
  // the shaped windows claim.
  const shapedCovered = new Uint8Array(n);
  for (const s of shapedSpans) shapedCovered.fill(1, s.start, s.end);
  let shortGaps = 0;
  let silentGaps = 0;
  const candidates: { start: number; end: number }[] = [];
  for (const gap of gaps) {
    if (gap.end - gap.start < minRegionSamples) {
      shortGaps++;
      continue;
    }
    // The gap's own floor, as CONTEXT only — the energy reference the edges
    // are placed against, never a threshold that decides muting. Two refusals
    // ride on the same measurement, and both are the eviction census's
    // principle in region form (quiet content must not be destroyed
    // unexamined): a gap with NO mostly-real window is digital silence or
    // fragments inside it, and a gap whose census reports at least one
    // `TILT_FFT_SIZE` frame of real audio hidden inside evicted windows is
    // skipped whole, because at fragment lengths the veto populations invert
    // (an all-real floor run of 1024 samples reads 3.9 dB where a whisper
    // reads 2.6 at 44.1 kHz) and no veto can vouch for what it cannot read.
    //
    // The census arm is LAST-LINE defence, stated honestly: every constructed
    // member of the hidden-fragment family is caught before it — a fragment
    // needs digital silence around it to hide, a window straddling a silence
    // edge reads the edge's broadband step as vocal shape and splits the gap,
    // and the emergence hold below spares whatever follows a run of zeros —
    // so no fixture has reached this check with the guards above intact. It
    // stands because the cost of a shape that someday defeats all three is a
    // muted whisper, and the check is one comparison on a measurement already
    // taken.
    const gapChannels = channels.map((c) => c.subarray(gap.start, gap.end));
    const local = measureNoiseWindow(gapChannels, sampleRate, { rejectMostlySilentWindows: true });
    if (!local || (local.hiddenRealSamples ?? 0) >= TILT_FFT_SIZE) {
      silentGaps++;
      continue;
    }
    const floorRefLin = Math.pow(10, (local.envelopePeakDb + GATE_HEADROOM_DB) / 20);
    // Start: pad off the preceding activity's decay tail — grow while the
    // envelope still sits above the floor reference (evidence-extended, not a
    // fixed pad). When there is no decay to pad off — the envelope already
    // sits at the floor — level has nothing to say about this edge, and the
    // start instead advances out of any samples the SHAPED windows claim:
    // after an ordinary phrase that is the straddle slack (about the old
    // design's hold), and after a sub-floor vocal it is the vocal's own tail,
    // which the envelope could never have seen.
    // The follower warms up from zero over its 1 ms attack, so a gap starting
    // at the take's very first sample reads a cold envelope there; the branch
    // is decided where the envelope first carries a settled reading (four
    // attack constants in — 98 % settled), and the pad walks through the cold
    // zone it skipped.
    let start = gap.start;
    const settledAt =
      start === 0
        ? Math.min(gap.end - 1, Math.max(1, Math.round(((DETECT_ATTACK_MS * 4) / 1000) * sampleRate)))
        : start;
    if (env[settledAt] > floorRefLin) {
      while (start < gap.end && (start < settledAt || env[start] > floorRefLin)) start++;
    } else {
      while (start < gap.end && shapedCovered[start] === 1) start++;
    }
    // End: pad back off onset energy the same way — or, when the gap already
    // ends at the floor, walk forward to the true onset over the one grid
    // step of slack the seed's window quantisation leaves before real
    // material. The floor cannot stop that walk early — its envelope never
    // reaches the reference, which is GATE_HEADROOM_DB's own population.
    // HOW THE WALK STOPS is itself evidence: stopping on the envelope rising
    // means a real onset was found and the edge is placed exactly there;
    // running out of cap with the envelope still at the floor means whatever
    // comes next is QUIETER than the muteable floor — an edge level cannot
    // place — and the end then retreats out of every sample the shaped
    // windows claim, so a whisper's sub-floor head is surrendered to the
    // shape evidence rather than muted on level's blindness.
    let end = gap.end;
    if (end > start && env[end - 1] > floorRefLin) {
      while (end > start && env[end - 1] > floorRefLin) end--;
    } else {
      const hardCap = nextHardStart(gap.end);
      const cap = Math.min(n, gap.end + stepSamples, hardCap);
      while (end < cap && env[end] <= floorRefLin) end++;
      // A blind stop — the cap reached with the envelope still at the floor —
      // only counts as blind when the cap was NOT a word boundary: a word
      // span's start IS the evidence of the edge (a word can begin from
      // nothing), where a grid cap with no envelope rise means the next
      // material is quieter than the floor and only the shape evidence can
      // place the edge.
      if (end >= cap && cap < hardCap && (end >= n || env[end] <= floorRefLin)) {
        while (end > start && shapedCovered[end - 1] === 1) end--;
      }
    }
    if (end <= start) {
      shortGaps++;
      continue;
    }
    // The GATE_SILENT_RUN_MS principle in region form (N6): a run of digital
    // silence is silence somebody put there, and the material that emerges
    // from it must not be muted on the silence's account — it gets the same
    // `GATE_HOLD_MS` the old gate spent open after every such run. So the
    // region is SPLIT at each emergence: the part before the run is kept as
    // its own candidate, the emerging material and one hold after it are
    // left alone, and muting may resume beyond the hold. A quiet island
    // bracketed by zeros, a stray blip inside a trimmed lead-in, and the
    // first pause after that lead-in all fall out of this one rule exactly
    // as they fell out of the old state machine.
    const parts: { start: number; end: number }[] = [];
    {
      let partStart = start;
      let zeroRun = 0;
      let i = start;
      while (i < end) {
        if (frameSilent(i)) {
          zeroRun++;
          i++;
          continue;
        }
        if (zeroRun >= silentRunSamples) {
          if (i > partStart) parts.push({ start: partStart, end: i });
          partStart = Math.min(end, i + holdSamples);
          i = partStart;
        } else {
          i++;
        }
        zeroRun = 0;
      }
      if (end > partStart) parts.push({ start: partStart, end });
    }
    for (const part of parts) {
      if (part.end - part.start < minRegionSamples) {
        shortGaps++;
        continue;
      }
      let anyReal = false;
      for (let i = part.start; i < part.end && !anyReal; i++) if (!frameSilent(i)) anyReal = true;
      if (!anyReal) {
        silentGaps++;
        continue;
      }
      candidates.push(part);
    }
  }

  // 3a. Cancellation — every 500 ms window of every candidate, before any
  // veto, never stepped past (C1: the depth dilutes over a mixed region, so
  // the diagnosis slides window by window inside `regionCancellation`).
  for (const candidate of candidates) {
    const cancelling = regionCancellation(channels, sampleRate, candidate);
    if (cancelling !== null) return decline(cancelling);
  }

  // 3b. The vetoes, voiced first — the canonical order the messages were
  // derived in. A veto keeps the WHOLE candidate: a gate that cannot tell a
  // pause from a soft phrase must not mute one, and chopping around a voice
  // would be muting on the same ignorance.
  let keptVoiced = 0;
  let keptShapedVeto = 0;
  const muteRegions: { start: number; end: number }[] = [];
  for (const candidate of candidates) {
    const mix = mixSpan(channels, candidate.start, candidate.end);
    // The vetoes stop one grid step short of the region's end. The end was
    // placed by the envelope CROSSING INTO the next activity, so the final
    // samples can carry the onset's own leading edge (the follower's 1 ms
    // attack admits it) — and on a quiet floor even a few full-scale onset
    // samples dominate a window's average spectrum and would veto the region
    // with evidence about the NEIGHBOUR, which the walk already knew was
    // activity when it stopped there. Regions at the minimum length keep
    // their one full window regardless — a false veto there errs toward
    // keeping audio, never toward muting it.
    const vetoLen = Math.max(windowSamples, mix.length - stepSamples);
    const vetoMix = vetoLen < mix.length ? mix.subarray(0, vetoLen) : mix;
    if (maxWindowedVoicedFraction(vetoMix, sampleRate) > GATE_VOICED_FRACTION) {
      keptVoiced++;
      continue;
    }
    if (maxWindowedTilt(vetoMix, sampleRate) > GATE_SHAPED_RESIDUAL_DB) {
      keptShapedVeto++;
      continue;
    }
    muteRegions.push(candidate);
  }

  if (muteRegions.length === 0) {
    const parts: string[] = [];
    if (keptVoiced + keptShapedVeto > 0) {
      parts.push(
        `${keptVoiced + keptShapedVeto} carry vocal evidence themselves (${keptVoiced} voiced — singing or humming — and ${keptShapedVeto} shaped by a vocal tract: a whisper, a breath, a held consonant)`
      );
    }
    if (shortGaps > 0) {
      parts.push(`${shortGaps} are shorter than the ${GATE_MIN_REGION_MS} ms this app calls a pause rather than articulation`);
    }
    if (silentGaps > 0) {
      parts.push(
        `${silentGaps} are already digital silence, or hold real audio only as fragments inside digital silence, and a gate has nothing to do with either`
      );
    }
    return decline(
      `no stretch between this take's vocal activity qualifies for muting — of the ${gaps.length} ${
        gaps.length === 1 ? 'stretch' : 'stretches'
      } found, ${parts.join('; ')}`
    );
  }

  // 4. The honest report: which evidence decided, what is muted, what was
  // kept. The `Gated` truth is measured on the OUTPUT by `describeStage`, so
  // these rows state the plan and the output row corroborates it.
  // The stretches between words kept purely on MEASURED vocal-tract evidence
  // (an unscripted whisper or breath no word claims) — counted only when word
  // evidence exists, because without words the shaped stretches ARE how the
  // performance itself is found and counting the singing as "kept" would be
  // noise dressed as information. Counted as fragments of the shaped coverage
  // OUTSIDE the word spans that are at least one window long: shorter
  // remainders are the straddle slack every word's own edge windows leave and
  // name nothing the user could listen for.
  let keptShapedSpans = 0;
  if (words) {
    for (const s of shapedSpans) {
      let cursor = s.start;
      const cuts = wordSpans
        .filter((w) => w.start < s.end && w.end > s.start)
        .sort((a, b) => a.start - b.start);
      for (const w of cuts) {
        if (w.start - cursor >= windowSamples) keptShapedSpans++;
        cursor = Math.max(cursor, w.end);
      }
      if (s.end - cursor >= windowSamples) keptShapedSpans++;
    }
  }
  const mutedSamples = muteRegions.reduce((sum, r) => sum + (r.end - r.start), 0);
  const derived: DerivedValue[] = [
    {
      label: 'Evidence',
      value: words
        ? words.source === 'lyrics-alignment'
          ? 'your aligned lyrics, plus measured activity'
          : 'the transcript’s segments, plus measured activity'
        : 'measured activity (no fresh lyrics alignment or transcript)',
      from: words
        ? `${words.spans.length} ${words.source === 'lyrics-alignment' ? 'word' : 'segment'} ${words.spans.length === 1 ? 'span' : 'spans'} placed for exactly this audio mark the singing, every ${NOISE_WINDOW_MS} ms reading vocal-tract shape is kept as well, and only the stretches between all of that are candidates`
        : `no word placement exists for this audio (run Pipeline → Align Lyrics or Transcribe first for word-level evidence), so activity is what the vocal-tract measurement finds per ${NOISE_WINDOW_MS} ms, and only the stretches showing neither voice nor vocal shape are candidates`,
    },
    {
      label: 'Muted',
      value: `${muteRegions.length} ${muteRegions.length === 1 ? 'region' : 'regions'} · ${(mutedSamples / sampleRate).toFixed(1)} s`,
      from: `the stretches of at least ${GATE_MIN_REGION_MS} ms between vocal activity that passed every protective check — each becomes digital silence behind a ${releaseMs.toFixed(0)} ms fade and reopens instantly at the next activity`,
    },
  ];
  const keptTotal = keptVoiced + keptShapedVeto + keptShapedSpans;
  if (keptTotal > 0) {
    derived.push({
      label: 'Kept',
      value: `${keptTotal} ${keptTotal === 1 ? 'stretch' : 'stretches'}`,
      from: `no stretch is muted on word-absence alone: ${keptVoiced} kept for voiced frames (singing or humming) and ${keptShapedVeto + keptShapedSpans} for vocal-tract evidence (a whisper, a breath, a held consonant)`,
    });
  }
  return { run: true, params, extra: { muteRegions }, derived };
}

/**
 * EQ: a high-pass an octave below the lowest note sung, and nothing else.
 *
 * The corner comes from the 1st percentile of the voiced fundamental measured
 * by Pitch Correct — the chain does not run the pitch detector twice at 282 ms
 * per audio-second. An octave of margin is not a round number picked for
 * comfort: a 2nd-order Butterworth high-pass at f/2 attenuates f by
 * 20*log10(4/sqrt(17)) = 0.27 dB, so the lowest note the singer actually sings
 * is left effectively untouched while everything an octave under it goes.
 *
 * Declines when that measurement is absent — with Pitch Correct switched off
 * there is no measured lowest note, and a corner chosen without one is a guess.
 */
export function deriveEq(f0P1Hz: number | null): StageResolution {
  const params = defaultParamsFor('parametric-eq');
  if (f0P1Hz === null || !(f0P1Hz > 0)) {
    return {
      run: false,
      reason: 'the high-pass corner is derived from the lowest note actually sung, which is measured by the Pitch Correct stage — with that stage off there is no measurement, and the chain does not guess a corner',
    };
  }
  const corner = clampToParam('parametric-eq', 'hpFreq', f0P1Hz / 2);
  params.hpEnabled = true;
  params.hpFreq = corner;
  return {
    run: true,
    params,
    derived: [
      {
        label: 'High-pass',
        value: `${corner.toFixed(0)} Hz`,
        from: `an octave below the ${f0P1Hz.toFixed(0)} Hz 1st-percentile sung fundamental, where it costs that note 0.3 dB`,
      },
    ],
  };
}

/** Clamps a derived value into the param's own declared range. The bounds are
 * the effect's, never new numbers — and a derivation that lands outside them is
 * a derivation the effect could not have honoured anyway.
 *
 * Exported for F10's cover chain, which derives settings for three more effects
 * — the graphic EQ's band gains, the amplify stage's gain and the reverb's room
 * size — and must clamp them the same way. Sharing the helper is what stops a
 * second chain inventing a second set of bounds. Its fourth automatic stage, the
 * limiter, derives NOTHING: a ceiling is an absolute level, so that stage runs
 * on the effect's own default and has nothing to clamp. */
export function clampToParam(effectId: string, paramId: string, value: number): number {
  const def = getEffect(effectId);
  if (!def) throw new Error(`Unknown effect: ${effectId}`);
  const param = def.params.find((p) => p.id === paramId);
  if (!param) throw new Error(`Unknown param ${effectId}.${paramId}`);
  let v = value;
  if (param.min !== undefined && v < param.min) v = param.min;
  if (param.max !== undefined && v > param.max) v = param.max;
  return v;
}

// ── The run ─────────────────────────────────────────────────────────────────

export type StageStatus = 'applied' | 'declined' | 'off' | 'manual';

export interface VocalChainStageResult {
  id: VocalChainStageId;
  label: string;
  status: StageStatus;
  /** Present for `declined`: what was measured, and why that means nothing to do. */
  reason?: string;
  /** Present when the stage RAN but the user must read something about what it
   * produced. Not a refusal — the same field, and the same amber, the cover
   * chain uses for Ruling C. */
  warning?: string;
  derived: DerivedValue[];
  /** Present for `applied`: what the stage did to the audio, measured. */
  delta?: StageDelta;
  /** Present for `applied` when the stage knows something a caller cannot
   * measure (Remove Silence's gaps, Pitch Correct's cents). */
  detail?: string;
  elapsedMs?: number;
}

export interface VocalChainMetrics {
  rmsDb: number;
  peakDb: number;
  crestDb: number;
  /** `null` when there is no passage above digital silence to measure. */
  noiseFloorDb: number | null;
}

export interface VocalChainReport {
  before: VocalChainMetrics;
  after: VocalChainMetrics;
  stages: VocalChainStageResult[];
  sampleRate: number;
  regionSamples: number;
  outputSamples: number;
  elapsedMs: number;
  /** True when at least one stage ran and the document was edited. */
  applied: boolean;
}

function measureMetrics(channels: Float32Array[], sampleRate: number): VocalChainMetrics {
  const rmsDb = programmeRmsDb(channels);
  const peak = peakDb(channels);
  const noise = measureNoiseWindow(channels, sampleRate);
  return {
    rmsDb,
    peakDb: peak,
    crestDb: peak - rmsDb,
    noiseFloorDb: noise ? noise.rmsDb : null,
  };
}

function resolveStage(
  stage: VocalChainStage,
  channels: Float32Array[],
  sampleRate: number,
  f0P1Hz: number | null,
  gateThresholdDb?: number,
  gateWords?: GateWordEvidence | null
): StageResolution {
  switch (stage.id) {
    case 'noise':
      return deriveNoiseReduction(channels, sampleRate);
    case 'hum':
      return deriveDeHum(channels, sampleRate);
    case 'silence':
      return deriveRemoveSilence(channels, sampleRate);
    case 'gate':
      return deriveGate(channels, sampleRate, gateThresholdDb, gateWords);
    case 'compressor':
      return deriveCompressor(channels, sampleRate);
    case 'deEsser':
      return deriveDeEsser(channels);
    case 'eq':
      return deriveEq(f0P1Hz);
    default:
      // Stages with nothing level-dependent to derive run on the effect's own
      // defaults, which are already derived in that effect's own task.
      return { run: true, params: defaultParamsFor(stage.effectId as string), derived: [] };
  }
}

/** The one-line "what it did" for the stages that know something the buffers
 * do not show. Returns undefined when there is nothing extra to say. */
function describeStage(
  stage: VocalChainStage,
  output: EffectRunOutput,
  sampleRate: number,
  delta: StageDelta
): string | undefined {
  if (output.removedSpans) return describeRemoval(output.removedSpans, sampleRate);

  // A stage's OWN account comes first, because it is the more specific one.
  // Order is load-bearing: when Pitch Correct finds nothing to correct it
  // returns a byte-identical copy, so the generic clause below would fire and
  // "already in tune" could never be reached. (Found in review — it never was.)
  const report: EffectReport | undefined = output.report;
  if (stage.id === 'pitch' && report && report.correctedFrames !== undefined) {
    const corrected = Number(report.correctedFrames);
    if (corrected === 0) return 'already in tune — no frame was moved';
    const total = Number(report.totalFrames ?? 0);
    const median = Number(report.medianCorrectionCents ?? 0);
    const max = Number(report.maxCorrectionCents ?? 0);
    return `${corrected} of ${total} frames moved, median ${median.toFixed(1)} cents, largest ${max.toFixed(1)} cents`;
  }

  // The gate's own account: how much of the selection it actually silenced.
  // Nothing else in the report can say this — the delta's RMS and peak barely
  // move when a pause goes to zero, and `identicalFraction` counts the samples
  // it left alone rather than the ones it took. Measured on the output, so a
  // gate that found nothing to close reports 0.0 s rather than an intention.
  if (stage.id === 'gate') {
    const length = output.channels[0]?.length ?? 0;
    let silent = 0;
    for (let i = 0; i < length; i++) {
      let allZero = true;
      for (const c of output.channels) {
        if (c[i] !== 0) {
          allZero = false;
          break;
        }
      }
      if (allZero) silent++;
    }
    const seconds = silent / sampleRate;
    const pct = length === 0 ? 0 : (silent / length) * 100;
    return `${seconds.toFixed(1)} s of the selection now sits at digital silence (${pct.toFixed(0)}%)`;
  }

  // Ruling 3: a stage that turned out to have nothing to do says so. Measured,
  // not assumed — every sample came back bit-identical. The limiter is the
  // stage this fires on in practice: on material that never approaches the
  // ceiling it is a safety net that never had to catch anything, and without
  // this it would report a blank where its work should be.
  if (delta.identicalFraction === 1) return 'nothing to do — every sample came back unchanged';
  return undefined;
}

/**
 * The one over-scale path the L8 reorder leaves open, said out loud.
 *
 * Moving the reverb ahead of the limiter makes the limiter's promise true —
 * nothing downstream can lift the output back over the ceiling — but only while
 * the limiter is RUNNING. Switch it off and the reverb becomes the last stage
 * that touches the audio, and it is a level stage: it sums a wet tail on top of
 * the dry signal, which is exactly how the +6.53 dBFS measured through this
 * chain came about. Both `encodeWav` and the MP3 encoder hard-clip that, and
 * nothing between here and the file says so.
 *
 * The cover chain already had this case and the ruling that goes with it
 * (Ruling C, `deriveMatchLoudness`): a stage that WILL run but whose result
 * needs a caveat says the caveat with the number on it, and the run is not
 * blocked. Refusing would be worse — a user who wants a tail over an already-hot
 * take and intends to lower it afterwards is asking for something legitimate,
 * and the chain has no measurement that says otherwise.
 *
 * Three conditions, and all three are observations rather than settings: the
 * stage is the reverb, the limiter that would have caught it is off, and the
 * output ACTUALLY came back over full scale. The last one is why this is not a
 * banner: on material the tail never takes over 0 dBFS there is nothing to warn
 * about, and a warning that always shows is a warning nobody reads.
 */
function stageWarning(
  stage: VocalChainStage,
  delta: StageDelta,
  enabled: Partial<Record<VocalChainStageId, boolean>>
): string | undefined {
  if (stage.id !== 'reverb') return undefined;
  if (enabled.limiter === true) return undefined;
  if (!(delta.peakAfterDb > 0)) return undefined;
  return `this stage summed a tail on top of the audio and the output now peaks at +${delta.peakAfterDb.toFixed(1)} dBFS, above full scale. The Limiter — the only stage that runs after this one, and the one that would have caught it — is switched off, and both the WAV writer and the MP3 encoder hard-clip anything over full scale. Switch the Limiter on, or bring the level down before you export.`;
}

// ── The live view (P1) ──────────────────────────────────────────────────────
// `onProgress` is ONE number over the whole pass, weighted by the measured
// stage times above. It is the right number for a bar and the wrong one for a
// stepper: it cannot say WHICH stage is running, how far through THAT stage the
// run is, or what the stage is doing while it takes its minute. The loop below
// knows all three, so it says them. Everything here is ADDITIVE — every
// callback is optional, no chain behaviour depends on one being passed, and the
// test hooks and the packaged smoke drive the chain with none of them.
//
// Shared with the cover chain, which runs the same two-phase loop over its own
// stage table. One vocabulary, so the two live views cannot describe the same
// thing in different words.

/**
 * The two phases every automatic stage passes through, in this order.
 *
 * `measuring` is `resolveStage` working the settings out from the audio that
 * actually reaches the stage — it is not a formality, and on the stages that
 * scan the whole region for a noise window or an envelope median it can be the
 * longer of the two. `rendering` is the effect itself running in the worker.
 *
 * They are reported separately because the fraction only means something in the
 * second: a measurement is one indivisible pass with no progress to report, so
 * it is announced rather than counted.
 */
export type ChainStagePhase = 'measuring' | 'rendering';

/** The `measuring` phase's line. One sentence, because there is nothing to
 * report but what is happening. */
export const STAGE_MEASURING_DETAIL = 'measuring the audio that reaches this stage';

/** The `rendering` line for a stage that derived nothing — the limiter and the
 * effects whose defaults are already right in their own task. Saying so beats a
 * blank: "no setting was derived here" is information. */
export const STAGE_RENDERING_DETAIL =
  "running on the effect's own declared defaults — this stage derives nothing";

/**
 * The `rendering` line for a stage that DID derive something: the settings it
 * just worked out, in the report's own words.
 *
 * Built from the `DerivedValue`s the stage resolution produced, which are the
 * same objects the finished report renders. There is deliberately no second
 * table of phrasings here — a live line and a report line that disagree about
 * what a stage measured is worse than either alone.
 */
export function stageRenderingDetail(derived: DerivedValue[]): string {
  if (derived.length === 0) return STAGE_RENDERING_DETAIL;
  return derived.map((d) => `${d.label} ${d.value}`).join(' · ');
}

/** What the stage that is running right now is doing. Emitted per stage; the
 * `stageId` is what tells a stepper which row to highlight. */
export interface ChainStageProgress<Id extends string> {
  stageId: Id;
  /** The stage's own label, so a consumer never has to look the table up. */
  label: string;
  phase: ChainStagePhase;
  /** How far through THIS stage, in [0, 1] — not the overall fraction, which
   * `onProgress` already carries and which cannot return to 0 at a boundary. */
  stageFraction: number;
  /** One line of what the stage is doing, or the measurement it just took. */
  detail: string;
}

export type VocalChainStageProgress = ChainStageProgress<VocalChainStageId>;

/**
 * Hand the main thread back long enough for a frame to actually be PRESENTED.
 *
 * Announcing a measurement is worthless if the announcement cannot be seen, and
 * that is what shipped first: `resolveStage` is a plain synchronous call, so the
 * `measuring` emission, the measurement itself and the `rendering` emission all
 * ran inside one non-yielding block. React collapses the two state updates into
 * a single flush — the final value wins — and no frame can paint until the task
 * ends, so the word "Measuring" was emitted in the right order and never
 * reached a screen. The worst case is the exact one the live view was built
 * for: the cover chain's Match Reverb, whose entire cost IS the measurement,
 * went from Waiting to Did not run while the main thread sat frozen on the
 * previous stage's row.
 *
 * A MICROTASK IS NOT ENOUGH. `await Promise.resolve()` drains before the browser
 * paints, so it would satisfy an ordering test and present nothing. The yield
 * has to cross a real task boundary: `requestAnimationFrame` runs immediately
 * before a paint, and a `setTimeout` scheduled from inside it resolves after
 * that frame has been presented. The `setTimeout`-only path is the fallback for
 * a context with no rAF at all — a worker or a bare Node test environment —
 * where there is nothing to paint and the task boundary is all that is left to
 * honour.
 */
function yieldToPaint(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

/**
 * The `measuring` announcement, and the paint that makes it visible — or
 * nothing at all.
 *
 * The whole thing is gated on the callback being present. A frame per stage is
 * real work, and `testHooks` and the packaged smoke drive both chains with no
 * callbacks whatsoever, so the gate is part of the additive contract rather
 * than an optimisation. Shared by both chains so neither can quietly stop
 * yielding.
 *
 * What the gate costs when it fires, stated exactly. This is an `async`
 * function, so `await announceMeasuring(...)` still suspends the caller for one
 * microtask tick before `resolveStage` runs, where pre-P1 the call was plainly
 * synchronous. That tick is the whole difference: no `requestAnimationFrame`,
 * no task boundary, no timer, and nothing on the audio path — the samples, the
 * stage order and every derived number are identical. "Unchanged" here means
 * unchanged in result and in scheduling CLASS, not a claim that the callback-
 * free run is instruction-for-instruction what it was.
 */
export async function announceMeasuring<Id extends string>(
  onStageProgress: ((progress: ChainStageProgress<Id>) => void) | undefined,
  stageId: Id,
  label: string
): Promise<void> {
  if (!onStageProgress) return;
  onStageProgress({
    stageId,
    label,
    phase: 'measuring',
    stageFraction: 0,
    detail: STAGE_MEASURING_DETAIL,
  });
  await yieldToPaint();
}

export interface RunVocalChainOptions {
  enabled: Partial<Record<VocalChainStageId, boolean>>;
  /**
   * A Noise Gate threshold in dBFS the USER named, which the stage takes as
   * given instead of deriving one (V2/R2). The one setting in this chain that
   * comes from a person rather than from the recording, and it exists because
   * the derivation can legitimately have no answer — see `deriveGate`. Absent
   * on an ordinary run, and its absence changes nothing.
   */
  gateThresholdDb?: number;
  onProgress?: (fraction: number) => void;
  /** Fires as each stage starts, so the UI can name what is running. */
  onStageStart?: (stage: VocalChainStage) => void;
  /** Fires repeatedly while a stage is in flight, scoped to that stage. */
  onStageProgress?: (progress: VocalChainStageProgress) => void;
  /**
   * Fires as each stage's result is decided — with the VERY object that lands in
   * `report.stages`, not a copy of it. That identity is the point: a live view
   * built on this shows the finished report's own strings by construction, so
   * there is no second set of phrasings to drift.
   *
   * Fires for EVERY stage, run or not, in registry order — an `off` or `manual`
   * stage owes the user its status just as much as an applied one does.
   */
  onStageResult?: (result: VocalChainStageResult) => void;
}

/**
 * Runs the chain over the active selection (or the whole document when there is
 * none) and commits the result as ONE undo entry.
 *
 * Resolves `null` without touching the document in exactly two cases: when
 * there is nothing to run ON — no active document, or an empty region — and
 * when a stage fails. A failure aborts the remaining stages and leaves the
 * document exactly as it was, because a half-applied chain is the one outcome
 * the user could not reason about; it is surfaced through the same error dialog
 * a single Apply uses.
 *
 * A run where every stage was off or declined is NOT one of them. It resolves a
 * full report with `applied: false`, so the dialog can show which stage said
 * what: a chain that did nothing still owes the user the reason each stage gave.
 */
export async function runVocalChain(opts: RunVocalChainOptions): Promise<VocalChainReport | null> {
  const { enabled, gateThresholdDb, onProgress, onStageStart, onStageProgress, onStageResult } = opts;
  const state = useAppStore.getState();
  const doc = state.documents.find((d) => d.id === state.activeDocumentId) ?? null;
  if (!doc) return null;

  // ONE resolved region, read by every consumer below — the audio the stages
  // receive, the `replaceRegion` write, `regionSamples` (which the report and
  // the tail's own length are measured against), the marker rules' absolute
  // offsets, and the post-edit selection/cursor. `cloneRegion` and
  // `replaceRegion` clamp to [0, docLength] internally while `setSelection`
  // stores whatever it is handed, so reading the raw selection HERE gave the
  // arithmetic a region the audio never used: an `end` past the document
  // inflated `regionSamples` and put the tail's insert point past every marker
  // there is, and a `start` before 0 slid every cut the same distance earlier
  // and left the document selected from a negative sample. Same defect family
  // as R7's `plan.regionStart`, L1's `resolveRegion` and L9's
  // `runEffectOnSelection`: resolve once, not clamp twice and hope the two
  // agree — and T6-1 made that ruling an import rather than six copies of two
  // expressions.
  const { start, end } = resolveRegion(doc, state.selection);
  if (end <= start) return null;
  const docId = doc.id;
  const sampleRate = doc.sampleRate;
  const regionSamples = end - start;

  // G2: the word evidence the gate reads, collected ONCE against the document
  // the chain is about to edit and mapped into this run's region frame —
  // there is no second doc identity to drift from, because this is the same
  // `docId` the edit below lands on. Collected BEFORE any stage runs: the
  // freshness test compares the stored spans' channel identity with the
  // document's, and the chain's own edit has not landed yet.
  const gateWords = collectGateWordEvidence(docId, start, end);

  const active = VOCAL_CHAIN_STAGES.filter((s) => s.effectId !== null && enabled[s.id] === true);
  const totalWeight = active.reduce((sum, s) => sum + s.weight, 0);

  let channels = cloneRegion(doc, start, end);
  const before = measureMetrics(channels, sampleRate);
  const startedAt = Date.now();

  const results: VocalChainStageResult[] = [];
  // Marker rules accumulate in the coordinates each stage produced, and are
  // composed into one remap at the end — see MarkerRemap's 'compose'.
  const remapSteps: MarkerRemap[] = [];
  let f0P1Hz: number | null = null;
  let doneWeight = 0;
  let anyApplied = false;

  // ONE place a stage result is recorded, so the live callback cannot be given a
  // different object — or a different set of stages — from the report's.
  const record = (result: VocalChainStageResult): void => {
    results.push(result);
    onStageResult?.(result);
  };

  for (const stage of VOCAL_CHAIN_STAGES) {
    if (stage.effectId === null) {
      record({ id: stage.id, label: stage.label, status: 'manual', derived: [] });
      continue;
    }
    if (enabled[stage.id] !== true) {
      record({ id: stage.id, label: stage.label, status: 'off', derived: [] });
      continue;
    }

    onStageStart?.(stage);
    // Announced AND painted before the measurement runs — see `announceMeasuring`.
    // Every stage gets this, including the ones about to decline: a decline is
    // the verdict of a measurement that has to happen first, and Match Reverb's
    // is the longest in either chain.
    await announceMeasuring(onStageProgress, stage.id, stage.label);
    // The gate's word spans are region-frame sample positions, so they are
    // only handed over while the audio still HAS that frame: a length-changing
    // stage ahead of the gate (Remove Silence) moves every sample after its
    // first cut, and spans applied to the moved audio would gate the
    // performance itself. Dropped rather than mis-applied — the same rule the
    // document-level staleness test enforces, one edit earlier.
    const wordsStillPlaced = (channels[0]?.length ?? 0) === regionSamples ? gateWords : null;
    const resolution = resolveStage(stage, channels, sampleRate, f0P1Hz, gateThresholdDb, wordsStillPlaced);
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
    // One region-sized copy, released as soon as the stage is reported.
    let inputCopy: Float32Array[] | null = channels.map((c) => Float32Array.from(c));
    const stageStartedAt = Date.now();
    let output: EffectRunOutput;
    try {
      output = await runEffectOnChannels(stage.effectId, channels, sampleRate, resolution.params, {
        extra: resolution.extra,
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
    if (output.removedSpans && output.removedSpans.length > 0) {
      remapSteps.push({
        type: 'cuts',
        cuts: output.removedSpans.map((s) => ({ start: start + s.start, end: start + s.end })),
      });
    }
    if (stage.id === 'pitch' && output.report && typeof output.report.f0P1Hz === 'number') {
      f0P1Hz = output.report.f0P1Hz;
    }

    record({
      id: stage.id,
      label: stage.label,
      status: 'applied',
      derived: resolution.derived,
      warning: stageWarning(stage, delta, enabled),
      delta,
      detail: describeStage(stage, output, sampleRate, delta),
      elapsedMs: Date.now() - stageStartedAt,
    });
    anyApplied = true;
    doneWeight += stage.weight;
    onProgress?.(totalWeight === 0 ? 1 : doneWeight / totalWeight);
  }

  const after = measureMetrics(channels, sampleRate);
  const outputSamples = channels[0]?.length ?? 0;

  if (!anyApplied) {
    return {
      before,
      after,
      stages: results,
      sampleRate,
      regionSamples,
      outputSamples,
      elapsedMs: Date.now() - startedAt,
      applied: false,
    };
  }

  // A stage that GREW the region (Reverb's tail) appends at the end of what the
  // earlier stages left, so its rule is an insert at that point — expressed in
  // the coordinates the cuts above produced, which is exactly what 'compose'
  // applies it in.
  const lengthDelta = outputSamples - regionSamples;
  let removedTotal = 0;
  for (const step of remapSteps) {
    if (step.type !== 'cuts') continue;
    for (const cut of step.cuts) removedTotal += cut.end - cut.start;
  }
  const grew = lengthDelta + removedTotal;
  if (grew > 0) {
    remapSteps.push({ type: 'insert', start: start + regionSamples - removedTotal, length: grew });
  }

  try {
    applyEdit(
      VOCAL_CHAIN_UNDO_LABEL,
      docId,
      (d) => replaceRegion(d, start, end, channels),
      { selection: { start, end: start + outputSamples }, cursorSample: start },
      { type: 'compose', steps: remapSteps }
    );
    // No `onProgress?.(1)` here: the loop above already emitted exactly 1 when
    // the last stage's weight landed, and emitting it twice would report the
    // run complete once before the commit and once after.
  } catch (err) {
    // The doc may have been closed while the chain was running.
    reportEffectFailure(err);
    return null;
  }

  return {
    before,
    after,
    stages: results,
    sampleRate,
    regionSamples,
    outputSamples,
    elapsedMs: Date.now() - startedAt,
    applied: true,
  };
}
