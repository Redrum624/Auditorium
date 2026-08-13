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
 * FIVE effects get an override, and every one of the overridden values is
 * MEASURED from the audio that reaches that stage. Three of them are
 * level-relative quantities that an absolute dBFS default cannot get right when
 * nobody is listening:
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
 *
 * The other two are not levels but they are measurements all the same, and an
 * effect default cannot carry either:
 *
 *   - DeHum base frequency, set to the mains frequency actually detected — 50
 *     or 60 Hz is a fact about the recording, not a preference.
 *   - EQ high-pass: `hpEnabled` and `hpFreq`, the corner placed an octave below
 *     the lowest note Pitch Correct measured.
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
 *   - Noise Gate. Not a chain stage — Noise Reduction handles the floor here,
 *     spectrally and without a threshold that can chatter on a held note.
 *   - Pitch Correct, DeHum, Reverb, EQ band gains. No level-dependent
 *     parameter among them.
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

import { cloneRegion, docLength, replaceRegion } from '../audio/AudioDocument';
import { defaultParamsFor, getEffect } from '../effects/EffectRegistry';
import type { EffectParamValue, EffectReport } from '../effects/types';
import { reductionDb } from '../effects/dynamics/CompressorEffect';
import { ALIGN_ACCURACY_SENTENCE } from '../dsp/ctcAlign';
import { envelopeFollower, maxAcrossChannels } from '../dsp/envelope';
import { DETECT_ATTACK_MS, DETECT_RELEASE_MS } from '../dsp/silenceDetect';
import {
  HUM_EXCESS_THRESHOLD_DB,
  MAINS_BASE_FREQUENCIES,
  NOISE_WINDOW_MS,
  detectMainsHum,
  humMeasurable,
  measureNoiseWindow,
  measureStageDelta,
  monoMix,
  peakDb,
  programmeRmsDb,
  toDb,
  toneExcessDb,
  type StageDelta,
} from '../dsp/chainAnalysis';
import { useAppStore } from '../stores/appStore';
import { applyEdit, type MarkerRemap } from './editOps';
import {
  describeRemoval,
  reportEffectFailure,
  runEffectOnChannels,
  type EffectRunOutput,
} from './effectRunner';
import { averageMagnitudeSpectra } from './noiseProfile';

export const VOCAL_CHAIN_UNDO_LABEL = 'Vocal Chain';

export type VocalChainStageId =
  | 'dc'
  | 'lyrics'
  | 'noise'
  | 'hum'
  | 'silence'
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
   * stereo reference take, as a percentage of the 104.7 s the ten stages take
   * together, rounded to integers with a floor of 1 so no stage is invisible:
   * DC 0.1 s, Noise Reduction 27.0 s, DeHum 0.5 s, Remove Silence 2.4 s, Pitch
   * Correct 57.7 s, Compressor 5.7 s, De-esser 5.8 s, EQ 0.4 s, Reverb 1.4 s,
   * Limiter 3.6 s. Equal weights would park the bar for the minute Pitch
   * Correct alone takes and then jump to done. */
  weight: number;
}

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
    note: `Not an automatic stage. It places your own lyrics in the recording and lets you replace ONE word you pick with a fresh take of just that word — nothing in it judges which word that should be. Run Pipeline → Align Lyrics… FIRST, then this chain. It sits SECOND, after Remove DC Offset and before everything else, for two reasons that are both measurements rather than preferences. A replacement is a fresh microphone take carrying its own room tone, so it has to be in the file before Noise Reduction learns its print and before the compressor, de-esser and limiter measure the levels they set themselves from — put it after them and the seam joins cleaned audio to a raw take, with no stage left to reconcile the two floors. And it has to come before Remove Silence and Align Vocal Timing, which move every sample after the point they edit, leaving the word positions describing audio that has shifted. Remove DC Offset still goes first, for the chain's own stated reason: the splice matches the new word's level to the old one's by RMS, and a DC bias inflates that measurement. ${ALIGN_ACCURACY_SENTENCE}`,
    weight: 0,
  },
  {
    id: 'noise',
    label: 'Noise Reduction',
    effectId: 'noise-reduction',
    defaultEnabled: true,
    note: `Early, because every later analysis degrades on noisy input — the pitch detector will otherwise lock onto broadband noise and "correct" pitch that is not there. Learns its noise print from the quietest ${NOISE_WINDOW_MS} ms in the selection.`,
    weight: 26,
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
    id: 'timing',
    label: 'Align Vocal Timing',
    effectId: null,
    defaultEnabled: false,
    note: 'Not an automatic stage. It needs you to confirm the beat grid and the syllable moves before it warps anything, by design — automatic onset detection measured 0.56 precision on a legato vocal, so an unconfirmed pass would move syllables that were never there. Run Pipeline → Align Vocal Timing… FIRST, then this chain: warping changes the analysis windows the pitch detector uses, so timing belongs before pitch.',
    weight: 0,
  },
  {
    id: 'pitch',
    label: 'Pitch Correct',
    effectId: 'pitch-correct',
    defaultEnabled: true,
    note: 'After noise reduction so the detector sees clean harmonics. Chromatic, so it is correct in any key; the 50 ms retune time constant leaves 5–7 Hz vibrato largely intact. This is by far the slowest stage.',
    weight: 55,
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
    weight: 6,
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
 */
export function deriveNoiseReduction(channels: Float32Array[], sampleRate: number): StageResolution {
  const params = defaultParamsFor('noise-reduction');
  const noise = measureNoiseWindow(channels, sampleRate);
  if (!noise) {
    return {
      run: false,
      reason: `no ${NOISE_WINDOW_MS} ms passage above digital silence anywhere in the selection, so there is no noise to learn — nothing was subtracted`,
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
 */
export function deriveRemoveSilence(channels: Float32Array[], sampleRate: number): StageResolution {
  const params = defaultParamsFor('remove-silence');
  const noise = measureNoiseWindow(channels, sampleRate);
  if (!noise) {
    return {
      run: false,
      reason: `no ${NOISE_WINDOW_MS} ms passage above digital silence to measure the noise floor from, so the threshold cannot be derived`,
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
  f0P1Hz: number | null
): StageResolution {
  switch (stage.id) {
    case 'noise':
      return deriveNoiseReduction(channels, sampleRate);
    case 'hum':
      return deriveDeHum(channels, sampleRate);
    case 'silence':
      return deriveRemoveSilence(channels, sampleRate);
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

export interface RunVocalChainOptions {
  enabled: Partial<Record<VocalChainStageId, boolean>>;
  onProgress?: (fraction: number) => void;
  /** Fires as each stage starts, so the UI can name what is running. */
  onStageStart?: (stage: VocalChainStage) => void;
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
  const { enabled, onProgress, onStageStart } = opts;
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
  // agree.
  const selection = state.selection;
  const length = docLength(doc);
  const start = Math.min(Math.max(selection ? selection.start : 0, 0), length);
  const end = Math.min(Math.max(selection ? selection.end : length, 0), length);
  if (end <= start) return null;
  const docId = doc.id;
  const sampleRate = doc.sampleRate;
  const regionSamples = end - start;

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

  for (const stage of VOCAL_CHAIN_STAGES) {
    if (stage.effectId === null) {
      results.push({ id: stage.id, label: stage.label, status: 'manual', derived: [] });
      continue;
    }
    if (enabled[stage.id] !== true) {
      results.push({ id: stage.id, label: stage.label, status: 'off', derived: [] });
      continue;
    }

    onStageStart?.(stage);
    const resolution = resolveStage(stage, channels, sampleRate, f0P1Hz);
    if (!resolution.run) {
      results.push({
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

    // Kept alive only until the delta is measured: the worker DETACHES the
    // buffers it is handed, so a before/after comparison needs its own copy.
    // One region-sized copy, released as soon as the stage is reported.
    let inputCopy: Float32Array[] | null = channels.map((c) => Float32Array.from(c));
    const stageStartedAt = Date.now();
    let output: EffectRunOutput;
    try {
      output = await runEffectOnChannels(stage.effectId, channels, sampleRate, resolution.params, {
        extra: resolution.extra,
        onProgress: (f) => onProgress?.(totalWeight === 0 ? 1 : (doneWeight + stage.weight * f) / totalWeight),
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

    results.push({
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
