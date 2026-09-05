/**
 * D6 — the Podcast Chain.
 *
 * One pass that puts a spoken-word recording where a podcast host wants it: the
 * noise out, the pauses tightened, the level even, and the whole thing delivered
 * at a measured loudness rather than at whatever the take happened to be.
 *
 * ── It composes; it does not re-implement ───────────────────────────────────
 * Every stage that touches audio goes through `runEffectOnChannels`, the same
 * worker leg `runEffectOnSelection`, `runVocalChain` and `runCoverChain` use,
 * and the whole run lands with ONE `applyEdit`. The stage shape, the `derive*`
 * family, `StageResolution`, `DerivedValue`, `StageStatus`, `clampToParam`,
 * `announceMeasuring` and `stageRenderingDetail` are the vocal chain's,
 * IMPORTED rather than copied — the precedent `coverChain.ts:73-82` set. No
 * derivation is duplicated here: the noise print, the hum verdict, the silence
 * threshold, the gate and the de-esser are the vocal chain's own functions,
 * called with this chain's audio.
 *
 * ── The stage loop is MIRRORED, not extracted, and that is a decision ───────
 * The brief allowed either. The cover chain already mirrors it, so an extraction
 * would have to absorb THREE loops, and the three differ in more than
 * parameters: the vocal chain threads `f0P1Hz` from one stage's report into a
 * later stage's derivation and drops the gate's word spans the moment a
 * length-changing stage has run; the cover chain hoists a whole reference
 * measurement out of the loop and coalesces two different warning sources; this
 * one has a stage with NO effect id that still edits the audio (see below). A
 * generic loop that carried all three would take a callback per difference,
 * which is the same loop written twice with an indirection in front of it — and
 * it would put a behaviour-preserving rewrite of `runVocalChain` and
 * `runCoverChain` in the path of a new feature. Mirrored, and said out loud.
 *
 * ── The one stage with no effect id ─────────────────────────────────────────
 * `loudness` is not an effect: it MEASURES (ITU-R BS.1770-4 integrated loudness,
 * `src/dsp/loudness.ts`) and then applies one flat gain. `effectId: null` in the
 * two other chains means "not an unattended stage at all"; here it means "the
 * chain applies this one itself", and `loudness` is the only stage that is like
 * that — this chain has no manual stages. The gain is a single multiply, so
 * shipping the buffers to a worker to perform it would cost two transfers to
 * save nothing.
 *
 * ── Why it refuses more than two channels ───────────────────────────────────
 * `integratedLoudness` weights every channel 1.0, which is the standard's
 * weighting for L and R and is NOT the standard's weighting for a surround set
 * (Ls/Rs at 1.41, the LFE excluded). Its docblock scopes it to mono and stereo
 * for that reason, and a 5.1 document is reachable — a multichannel WAV opens
 * with all its channels. So the chain refuses rather than reporting a loudness
 * it cannot stand behind, and names the conversion that fixes it.
 *
 * ── The limiter ceiling is a SAMPLE peak ────────────────────────────────────
 * `LimiterEffect` is not oversampled, so nothing here is a true-peak / dBTP
 * reading and no text in this file says otherwise. -1.0 dBFS sample peak is the
 * ceiling; an inter-sample peak can still sit above it, and calling it dBTP
 * would be a claim the DSP does not support.
 *
 * ── The interaction between Shorten Pauses and the gate, measured ──────────
 * Shorten Pauses leaves every gap at `PODCAST_SILENCE_TARGET_MS` (400 ms) and
 * the automatic gate mutes stretches of at least `GATE_MIN_REGION_MS` (500 ms —
 * Remove Silence's own minimum pause), so the second stage is working right at
 * the first one's output length and the outcome is not obvious from the
 * constants. It was measured rather than reasoned about: on this chain's own
 * speech fixture the gate still APPLIES after the shorten, because the stretch
 * it sees is the 400 ms gap plus the decay and onset margins its region edges
 * walk out to, and it muted 7.8 % of the take. It can equally decline on a take
 * whose gaps come back tighter, and it says which when it does. The note on the
 * stage states both, because a user reading "Noise Gate: did not run" under a
 * stage that is on by default is owed the reason.
 *
 * ── One measurement that came out of building this, worth knowing ──────────
 * Noise Reduction RAISES the peak on this material: -19.9 -> -12.4 dBFS on the
 * fixture, because spectral subtraction re-phases what it keeps. Nothing here
 * depends on the peak until the limiter, which is why that is a note and not a
 * defect — but it is the reason the limiter is not decoration: on a default run
 * the loudness gain takes the peak to +0.6 dBFS and the limiter is what brings
 * it back to the -1.0 dBFS ceiling.
 */

import { cloneRegion, replaceRegion } from '../audio/AudioDocument';
import { defaultParamsFor } from '../effects/EffectRegistry';
import type { EffectParamValue } from '../effects/types';
import {
  NOISE_WINDOW_MS,
  measureStageDelta,
  programmeRmsDb,
  type StageDelta,
} from '../dsp/chainAnalysis';
import { gatedLevelDb } from '../dsp/coverMatch';
import { gainToTargetDb, integratedLoudness, samplePeakDb } from '../dsp/loudness';
import { useAppStore } from '../stores/appStore';
import { applyEdit, type MarkerRemap } from './editOps';
import {
  describeRemoval,
  reportEffectFailure,
  runEffectOnChannels,
  type EffectRunOutput,
} from './effectRunner';
import { resolveRegion } from './selectionRegion';
import {
  GATE_HEADROOM_DB,
  announceMeasuring,
  clampToParam,
  collectGateWordEvidence,
  deriveDeEsser,
  deriveDeHum,
  deriveGate,
  deriveNoiseReduction,
  deriveRemoveSilence,
  stageRenderingDetail,
  type ChainStageProgress,
  type DerivedValue,
  type GateWordEvidence,
  type StageResolution,
  type StageStatus,
} from './vocalChain';

export const PODCAST_CHAIN_UNDO_LABEL = 'Podcast Chain';

// ── The numbers this chain owns ─────────────────────────────────────────────

/** The stereo delivery target, LUFS. The figure every podcast platform's own
 * guidance converges on, and the one D6 names. */
export const PODCAST_TARGET_LUFS_STEREO = -16.0;

/**
 * The mono target, LUFS — 3 LU lower, and that is arithmetic rather than taste.
 * BS.1770 weights L and R at 1.0 each and sums them, so the SAME programme in
 * one channel reads 10*log10(2) = 3.01 LU below the same programme in two.
 * Targeting -16 on a mono file would therefore deliver it 3 dB louder than a
 * stereo file at the same stated target. -19 is the value that makes the two
 * sound equally loud, and it is what the ITU/Apple mono equivalent says.
 */
export const PODCAST_TARGET_LUFS_MONO = -19.0;

/** Delivery ceiling, dBFS SAMPLE peak (never dBTP — the limiter is not
 * oversampled). 1 dB under full scale is the headroom lossy encoders need. */
export const PODCAST_LIMITER_CEILING_DB = -1.0;

/** Speech compression ratio (D6). */
export const PODCAST_COMPRESSOR_RATIO = 3;

/** How far under the GATED programme level the compressor threshold sits, dB
 * (D6). See `derivePodcastCompressor` for what that buys at 3:1. */
export const PODCAST_COMPRESSOR_OFFSET_DB = -6;

/** What Shorten Pauses leaves every processed gap at, ms (D6). */
export const PODCAST_SILENCE_TARGET_MS = 400;

/** The speech high-pass corner, Hz. */
export const PODCAST_EQ_HP_HZ = 80;
/** The band a close-miked voice builds up in, Hz, and the cut applied there. */
export const PODCAST_EQ_MUD_HZ = 250;
export const PODCAST_EQ_MUD_GAIN_DB = -2;
/** The consonant-definition band, Hz, and the lift applied there. */
export const PODCAST_EQ_PRESENCE_HZ = 3000;
export const PODCAST_EQ_PRESENCE_GAIN_DB = 2;

/** The most channels this chain will measure a loudness for (D5's scope). */
export const PODCAST_CHAIN_MAX_CHANNELS = 2;

/**
 * What the chain says instead of running on a surround document. It names the
 * fix because a refusal that does not is a dead end: `Edit → Convert Channels…`
 * downmixes a >2-channel document to stereo (with a selectable law), and that is
 * an ordinary undoable edit.
 */
export const PODCAST_CHANNEL_REFUSAL =
  'This document has more than two channels, and the Podcast Chain will not run on it. Its loudness measurement is ITU-R BS.1770-4, which this app implements for mono and stereo only — every channel counts equally, where the standard weights a surround pair differently and leaves the LFE out — so a reading taken here would be wrong in a way nothing downstream could correct. Convert to stereo first with Edit → Convert Channels…, then run the chain.';

// ── The stage table ─────────────────────────────────────────────────────────

export type PodcastChainStageId =
  | 'dc'
  | 'noise'
  | 'hum'
  | 'silence'
  | 'gate'
  | 'compressor'
  | 'deEsser'
  | 'eq'
  | 'loudness'
  | 'limiter';

export interface PodcastChainStage {
  id: PodcastChainStageId;
  label: string;
  /**
   * The registered effect this stage runs, or `null` for the one stage the
   * CHAIN applies itself. Unlike the vocal and cover chains, `null` here does
   * NOT mean "manual": this chain has no manual stages, every stage runs
   * unattended, and `loudness` is `null` only because measuring a loudness and
   * applying one gain is not an effect.
   */
  effectId: string | null;
  defaultEnabled: boolean;
  /** Why the stage sits where it does, and why it is on or off by default.
   * Shown verbatim in the UI: a stage the user cannot reason about is a stage
   * that ran without being seen. */
  note: string;
  /**
   * Share of the progress bar.
   *
   * These are the vocal chain's OWN measured wall times for the same effects on
   * the same reference material (DC 0.1 s, Noise Reduction 27.0 s, DeHum 0.5 s,
   * Remove Silence 2.4 s, Noise Gate 4.1 s, Compressor 5.7 s, De-esser 5.8 s,
   * EQ 0.4 s, Limiter 3.6 s — `VOCAL_CHAIN_STAGES`' own note), renormalised over
   * this chain's nine shared stages (49.6 s together) and rounded with a floor
   * of 1. They are a REUSE of a measurement, not a new one: the same effect over
   * comparable material costs the same, and inventing fresh percentages for
   * stages nobody re-timed would be a number wearing an authority it had not
   * earned. The `loudness` stage has no such measurement — it is two
   * straight-line biquad passes and a multiply, the cost class of DC removal —
   * so it takes the floor of 1.
   */
  weight: number;
}

export const PODCAST_CHAIN_STAGES: readonly PodcastChainStage[] = [
  {
    id: 'dc',
    label: 'Remove DC Offset',
    effectId: 'dc-remove',
    defaultEnabled: true,
    note: 'First, because a DC bias skews every level measurement taken after it — and this chain takes four of them: the noise floor, the gated programme level, the de-esser’s input level and the integrated loudness.',
    weight: 1,
  },
  {
    id: 'noise',
    label: 'Noise Reduction',
    effectId: 'noise-reduction',
    defaultEnabled: true,
    note: 'Early, because every later measurement degrades on noisy input — the pause threshold, the gated level and the loudness are all read off the audio that reaches them. It learns its noise print from the quietest passage of the recording, so it runs only when there IS one: a take whose quiet stretches are already exact zeros has no floor to learn from, and this stage says so and is skipped rather than subtracting a print made of silence.',
    weight: 54,
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
    label: 'Shorten Pauses',
    effectId: 'remove-silence',
    defaultEnabled: true,
    note: `ON by default here, where the vocal chain has it off: that chain protects a take that has to stay in sync with a backing track, and a spoken-word recording has nothing to stay in sync with. Every gap longer than the effect’s minimum pause is shortened to ${PODCAST_SILENCE_TARGET_MS} ms, keeping room tone at each end so the join is not a butt cut. The threshold is measured from this recording’s own noise floor, not assumed. Before the dynamics stages, so the compressor does not lift a floor in gaps that are about to go.`,
    weight: 5,
  },
  {
    id: 'gate',
    label: 'Noise Gate',
    effectId: 'noise-gate',
    defaultEnabled: true,
    note: `Brings the stretches where nobody is talking to actual silence, which Noise Reduction cannot: it lowers a floor by at most 12 dB and leaves it there. Length-preserving — it mutes in place rather than cutting. It decides WHERE, not how loud: a stretch is muted only when the evidence says no voice lives in it, so pause noise louder than your quietest word still goes. It works on what Shorten Pauses left, and the two sit close together by design — that stage leaves every gap at ${PODCAST_SILENCE_TARGET_MS} ms and this one only mutes a stretch it MEASURES at 500 ms or more, the shortest gap this app calls a pause rather than articulation. Which way that lands is not read off the two numbers: the stretch it measures is the gap plus the decay and onset margins its region edges walk out to, so on this chain's own reference take it still applies (it mutes 7.8 % of it) and on a take whose gaps come back shorter it declines — and says so on its line, which is the reason to read that line rather than assume either. Switching Shorten Pauses off gives it full-length pauses again.`,
    weight: 8,
  },
  {
    id: 'compressor',
    label: 'Compressor',
    effectId: 'compressor',
    defaultEnabled: true,
    note: `Speech compression at ${PODCAST_COMPRESSOR_RATIO}:1, with the threshold set ${-PODCAST_COMPRESSOR_OFFSET_DB} dB below the GATED programme level — the level measured over the parts that are actually sounding, so the pauses cannot drag it down and the setting does not change because a take has more silence in it. At ${PODCAST_COMPRESSOR_RATIO}:1 a DETECTOR reading n dB over the threshold comes back 2n/3 dB quieter, and this compressor's detector is a peak envelope follower, not the gated RMS the threshold was placed under — it sits above that level, so the sounding material runs further over the threshold than the ${-PODCAST_COMPRESSOR_OFFSET_DB} dB offset by itself suggests. On this chain's reference take that is about 7 dB of gain reduction while someone is talking, and every extra dB a passage carries lands another 2/3 dB. It derives NO makeup gain: the Loudness stage below sets the delivery level from a measurement, and a makeup gain here would only be something for it to take back out.`,
    weight: 11,
  },
  {
    id: 'deEsser',
    label: 'De-esser',
    effectId: 'de-esser',
    defaultEnabled: true,
    note: 'After the compressor, because compression makes sibilance worse. Its threshold is measured here, at its own input, for that reason.',
    weight: 12,
  },
  {
    id: 'eq',
    label: 'EQ (speech)',
    effectId: 'parametric-eq',
    defaultEnabled: true,
    note: `Three fixed moves for a spoken voice, and they are fixed rather than derived on purpose: a ${PODCAST_EQ_HP_HZ} Hz high-pass, because a voice carries nothing under it and handling noise, footfalls and desk rumble do; ${PODCAST_EQ_MUD_GAIN_DB} dB at ${PODCAST_EQ_MUD_HZ} Hz, the band a close-miked voice builds up in; and +${PODCAST_EQ_PRESENCE_GAIN_DB} dB at ${PODCAST_EQ_PRESENCE_HZ / 1000} kHz, where consonant definition lives. Every other band stays flat. The vocal chain derives its high-pass from the lowest note sung, measured by a stage that does not exist here — speech has no key, and a corner under the speaking range is the same corner for everyone.`,
    weight: 1,
  },
  {
    id: 'loudness',
    label: 'Loudness',
    effectId: null,
    defaultEnabled: true,
    note: `Measures the integrated loudness to ITU-R BS.1770-4 and applies one flat gain that lands the delivery target: ${PODCAST_TARGET_LUFS_STEREO.toFixed(1)} LUFS in stereo, ${PODCAST_TARGET_LUFS_MONO.toFixed(1)} LUFS in mono — 3 LU lower because the standard sums two channels, so the same programme in one channel reads 3.01 LU below the same programme in two. The report shows both readings, before and after. It runs after every stage that shapes the voice, because each of them moves the level it is setting, and before the Limiter, because a limiter is the only thing that should decide what happens at the ceiling — a loudness is an average over gated 400 ms blocks and says nothing about the peak, so with the Limiter switched off this stage can and does leave the take over full scale, and it says so with the measured figure when it happens. On a take with no measurable loudness — digital silence — it declines rather than asking for infinite gain.`,
    weight: 1,
  },
  {
    id: 'limiter',
    label: 'Limiter',
    effectId: 'limiter',
    defaultEnabled: true,
    note: `Last of every stage that touches the audio, so nothing downstream can lift the output back over the ceiling. ${PODCAST_LIMITER_CEILING_DB.toFixed(1)} dBFS, measured as SAMPLE peak: this limiter is not oversampled, so an inter-sample peak can still sit above it and nothing here is a dBTP reading. On material the loudness gain never brings near the ceiling it will report that it did nothing, which is what a safety net looks like when it is not needed.`,
    weight: 7,
  },
];

export function podcastStageById(id: PodcastChainStageId): PodcastChainStage {
  const stage = PODCAST_CHAIN_STAGES.find((s) => s.id === id);
  if (!stage) throw new Error(`Unknown podcast chain stage: ${id}`);
  return stage;
}

/** The enabled-map the UI opens with. */
export function defaultPodcastStageSelection(): Record<PodcastChainStageId, boolean> {
  const out = {} as Record<PodcastChainStageId, boolean>;
  for (const stage of PODCAST_CHAIN_STAGES) out[stage.id] = stage.defaultEnabled;
  return out;
}

const dbStr = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`;
const dbfsStr = (v: number): string => `${v.toFixed(1)} dBFS`;
const lufsStr = (v: number): string => `${v.toFixed(1)} LUFS`;

// ── The derivations this chain owns ─────────────────────────────────────────
// Everything else is imported: `deriveNoiseReduction`, `deriveDeHum`,
// `deriveRemoveSilence`, `deriveGate` and `deriveDeEsser` are the vocal chain's
// own functions, called with this chain's audio. Nothing is copied.

/**
 * Compressor threshold and ratio (D6).
 *
 * THRESHOLD = `gatedLevelDb` - 6 dB. The gated level is the programme level over
 * the parts that are actually SOUNDING (`coverMatch.ts`), which is the quantity
 * a speech compressor's threshold has to sit under: an ungated level moves with
 * how much silence a take contains rather than with how loud the talking is, and
 * a podcast take is mostly pauses by design. It is deliberately NOT the vocal
 * chain's `deriveCompressor`, whose threshold is the MEDIAN of the compressor's
 * own envelope over the sounding material and whose makeup is computed to give
 * back exactly what it took — that pair is built to leave a sung take's level
 * where it found it, and this chain has a loudness stage whose whole job is to
 * move the level somewhere specific.
 *
 * RATIO 3:1, so a DETECTOR reading n dB over the threshold comes back 2n/3 dB
 * quieter. That is NOT 4 dB at the sounding level, which is what the 6 dB offset
 * says on its own (final review, C4): the threshold is placed under the gated
 * RMS, while the effect's detector is an envelope follower on max|x| — a
 * peak-ish quantity that sits ABOVE that RMS — so the sounding material runs
 * further over the threshold than the offset suggests. Measured through the
 * shipped detector on this chain's own speech fixture, the bursts land about
 * 6.8 dB (`podcastChain.test.ts`, "lands the gain reduction its note claims");
 * a louder passage lands 2/3 dB more for every extra dB it carries. The figure
 * follows the take's crest, which is why the stage reports its own measured
 * before/after rather than promising one.
 *
 * MAKEUP is left at the effect's own default (0 dB), and that is the point of
 * having the loudness stage: a makeup gain here would be a second, unmeasured
 * level decision for the measured one to undo.
 */
export function derivePodcastCompressor(
  channels: Float32Array[],
  sampleRate: number
): StageResolution {
  const params = defaultParamsFor('compressor');
  const level = gatedLevelDb(channels, sampleRate);
  if (level === null) {
    return {
      run: false,
      reason:
        'nothing in the selection rises above its own noise floor, so there is no gated programme level to place a threshold under and nothing to compress',
    };
  }
  const thresholdDb = clampToParam('compressor', 'thresholdDb', level + PODCAST_COMPRESSOR_OFFSET_DB);
  params.thresholdDb = thresholdDb;
  params.ratio = PODCAST_COMPRESSOR_RATIO;
  return {
    run: true,
    params,
    derived: [
      {
        label: 'Threshold',
        value: dbfsStr(thresholdDb),
        from: `the gated programme level ${dbfsStr(level)} — measured over the parts that are sounding — less ${-PODCAST_COMPRESSOR_OFFSET_DB} dB`,
      },
      {
        label: 'Ratio',
        value: `${PODCAST_COMPRESSOR_RATIO}:1`,
        from: `speech; at this ratio a detector reading n dB over the threshold comes back 2n/3 dB quieter, and the detector sits above the gated level the threshold was placed under`,
      },
    ],
  };
}

/**
 * Shorten Pauses: the vocal chain's measured threshold, CLEARED by the same
 * measured headroom its gate uses, plus this chain's two explicit choices.
 *
 * ── Why the headroom, measured on this chain's own fixture ──────────────────
 * `deriveRemoveSilence` puts the threshold exactly ON the loudest the silence
 * detector reads inside the quietest 500 ms, and argues that a stage needing a
 * RUN of 500 ms below it can sit there because "a single graze merely splits one
 * run into two". Measured through THIS chain, where Noise Reduction runs first
 * and Shorten Pauses is ON by default, that is not what happens.
 *
 * On the speech fixture (-60 dBFS floor, 1.2 s pauses, 44.1 kHz stereo) after
 * Noise Reduction: derived threshold -67.35 dBFS, settled pause envelope peak
 * -67.03 — a graze of 0.32 dB. 59-85 % of each pause sits below the threshold
 * and the LONGEST continuous run below it is 0.048-0.352 s. Against a 500 ms
 * minimum, that is not two runs, it is forty, and every one of them is too short:
 * `detectSilentRuns` returned an EMPTY list and not one pause was shortened. The
 * stage ran, reported "applied", and did nothing — the worst shape a stage can
 * have.
 *
 * The cause is the one the vocal chain already measured for its gate: Noise
 * Reduction's residual is peakier than the floor it replaced, so the settled
 * floor keeps re-crossing a threshold taken as a maximum over one 500 ms window.
 * `GATE_HEADROOM_DB` is that measurement's answer — 3 dB, "the smallest whole
 * decibel above the worst measured graze" over 144 constructed takes, 2.369 dB
 * of it after Noise Reduction. It is reused here rather than re-derived: same
 * quantity, same cause, and this chain's graze (0.32 dB) is well inside it.
 *
 * THE COST, STATED. The threshold moves 3 dB up, so material between the floor
 * and floor+3 dB now reads as silence. In `shorten` mode that costs nothing a
 * user would hear: the stage does not delete a gap, it leaves
 * `PODCAST_SILENCE_TARGET_MS` of it plus the padding at each end, and 3 dB over
 * a noise floor is not speech. The vocal chain's warning about this stage
 * DELETING what it calls silence is about `remove` mode, which this chain never
 * selects.
 *
 * The mode and the target are set explicitly rather than left to the effect's
 * defaults even though they happen to match today: this chain's contract is
 * "gaps come back at PODCAST_SILENCE_TARGET_MS", and a contract that only holds
 * while somebody else's default does not move is not a contract.
 */
export function derivePodcastRemoveSilence(
  channels: Float32Array[],
  sampleRate: number
): StageResolution {
  const resolved = deriveRemoveSilence(channels, sampleRate);
  if (!resolved.run) return resolved;
  const floorPeakDb = Number(resolved.params.thresholdDb);
  const thresholdDb = clampToParam('remove-silence', 'thresholdDb', floorPeakDb + GATE_HEADROOM_DB);
  const params: Record<string, EffectParamValue> = {
    ...resolved.params,
    thresholdDb,
    mode: 'shorten',
    targetMs: PODCAST_SILENCE_TARGET_MS,
  };
  return {
    run: true,
    params,
    derived: [
      {
        label: 'Threshold',
        value: dbfsStr(thresholdDb),
        from: `the loudest the silence detector reads inside the quietest ${NOISE_WINDOW_MS} ms (${dbfsStr(floorPeakDb)}), cleared by ${GATE_HEADROOM_DB} dB so a peaky floor cannot break one pause into fragments too short to shorten`,
      },
      {
        label: 'Pauses',
        value: `${PODCAST_SILENCE_TARGET_MS} ms`,
        from: `every gap longer than ${Number(params.minSilenceMs)} ms is shortened to this, keeping ${Number(params.padMs)} ms of room tone at each end`,
      },
    ],
  };
}

/**
 * The speech EQ: three fixed moves, and they are reported as derived values even
 * though nothing measured them.
 *
 * That is deliberate. `stageRenderingDetail([])` prints "running on the effect's
 * own declared defaults — this stage derives nothing", which would be false the
 * moment a parameter is overridden; the honest alternative is to show what the
 * stage set and say plainly where it came from. `from` therefore reads "fixed
 * for speech", not a measurement this chain did not take.
 */
export function derivePodcastEq(): StageResolution {
  const params = defaultParamsFor('parametric-eq');
  params.hpEnabled = true;
  params.hpFreq = clampToParam('parametric-eq', 'hpFreq', PODCAST_EQ_HP_HZ);
  // Band 2 (400 Hz, on by default) becomes the mud cut; band 4 (4 kHz, off by
  // default) becomes the presence lift. Every other band stays exactly as the
  // effect declared it, at 0 dB — a band left on at a gain nobody chose would be
  // a third move this chain never argued for.
  params.band2Enabled = true;
  params.band2Freq = clampToParam('parametric-eq', 'band2Freq', PODCAST_EQ_MUD_HZ);
  params.band2Gain = clampToParam('parametric-eq', 'band2Gain', PODCAST_EQ_MUD_GAIN_DB);
  params.band4Enabled = true;
  params.band4Freq = clampToParam('parametric-eq', 'band4Freq', PODCAST_EQ_PRESENCE_HZ);
  params.band4Gain = clampToParam('parametric-eq', 'band4Gain', PODCAST_EQ_PRESENCE_GAIN_DB);
  return {
    run: true,
    params,
    derived: [
      {
        label: 'High-pass',
        value: `${PODCAST_EQ_HP_HZ} Hz`,
        from: 'fixed for speech — a voice carries nothing under it, handling noise and rumble do',
      },
      {
        label: 'Mud',
        value: `${dbStr(PODCAST_EQ_MUD_GAIN_DB)} at ${PODCAST_EQ_MUD_HZ} Hz`,
        from: 'fixed for speech — the band a close-miked voice builds up in',
      },
      {
        label: 'Presence',
        value: `${dbStr(PODCAST_EQ_PRESENCE_GAIN_DB)} at ${PODCAST_EQ_PRESENCE_HZ} Hz`,
        from: 'fixed for speech — where consonant definition, and so intelligibility, lives',
      },
    ],
  };
}

/**
 * The limiter's ceiling.
 *
 * The vocal chain deliberately derives NOTHING here, on the argument that a
 * ceiling is an absolute level. That argument still holds — this is not a
 * derivation, it is a different absolute level: -1.0 dBFS rather than the
 * effect's own -0.3, because the delivery format is lossy and an encoder needs
 * the extra dB. It is reported as a value with a stated origin so the live line
 * does not claim the stage ran on defaults it did not run on.
 */
export function derivePodcastLimiter(): StageResolution {
  const params = defaultParamsFor('limiter');
  params.ceilingDb = clampToParam('limiter', 'ceilingDb', PODCAST_LIMITER_CEILING_DB);
  return {
    run: true,
    params,
    derived: [
      {
        label: 'Ceiling',
        value: dbfsStr(PODCAST_LIMITER_CEILING_DB),
        from: 'the podcast delivery ceiling — SAMPLE peak, since this limiter is not oversampled, so it is not a true-peak figure',
      },
    ],
  };
}

/** What the loudness stage measured and did. `afterLufs` is measured on the
 * result, not inferred from the arithmetic — it is `null` only in the case that
 * cannot arise from a finite gain on a measurable take. */
export interface LoudnessMeasurement {
  beforeLufs: number;
  afterLufs: number | null;
  targetLufs: number;
  gainDb: number;
}

export type LoudnessResolution =
  | { run: true; beforeLufs: number; targetLufs: number; gainDb: number; derived: DerivedValue[] }
  | { run: false; reason: string };

/**
 * The loudness stage's measurement: BS.1770-4 integrated loudness, the target
 * that goes with this document's channel count, and the gain between them.
 *
 * Channel count picks the target and nothing else: a mono file read against the
 * stereo target would be delivered 3 dB hot, because the standard sums the
 * channels. Anything above two never reaches here — `runPodcastChain` refuses
 * the document.
 */
export function deriveLoudness(channels: Float32Array[], sampleRate: number): LoudnessResolution {
  const targetLufs =
    channels.length === 1 ? PODCAST_TARGET_LUFS_MONO : PODCAST_TARGET_LUFS_STEREO;
  const beforeLufs = integratedLoudness(channels, sampleRate);
  if (beforeLufs === null) {
    return {
      run: false,
      reason:
        'no 400 ms block of this selection survives BS.1770-4’s gating — it is digital silence, or shorter than one gating block — so there is no loudness to measure and no gain that could land a target',
    };
  }
  const gainDb = gainToTargetDb(beforeLufs, targetLufs);
  return {
    run: true,
    beforeLufs,
    targetLufs,
    gainDb,
    derived: [
      {
        label: 'Gain',
        value: dbStr(gainDb),
        from: `measured ${lufsStr(beforeLufs)} against the ${lufsStr(targetLufs)} ${channels.length === 1 ? 'mono' : 'stereo'} podcast target`,
      },
    ],
  };
}

/**
 * The settings for one EFFECT stage. The `loudness` stage is not one — it has no
 * effect and no params — and asking for it here is a programming error rather
 * than a case to fall through, because the fall-through would call
 * `defaultParamsFor(null)` and throw a message about an unknown effect.
 */
export function resolvePodcastStage(
  stage: PodcastChainStage,
  channels: Float32Array[],
  sampleRate: number,
  gateThresholdDb?: number,
  gateWords?: GateWordEvidence | null
): StageResolution {
  switch (stage.id) {
    case 'noise':
      return deriveNoiseReduction(channels, sampleRate);
    case 'hum':
      return deriveDeHum(channels, sampleRate);
    case 'silence':
      return derivePodcastRemoveSilence(channels, sampleRate);
    case 'gate':
      return deriveGate(channels, sampleRate, gateThresholdDb, gateWords);
    case 'compressor':
      return derivePodcastCompressor(channels, sampleRate);
    case 'deEsser':
      return deriveDeEsser(channels);
    case 'eq':
      return derivePodcastEq();
    case 'limiter':
      return derivePodcastLimiter();
    case 'loudness':
      throw new Error('The loudness stage is applied by the chain, not through an effect');
    default:
      // `dc` — the effect's own declared defaults, already derived in its task.
      return { run: true, params: defaultParamsFor(stage.effectId as string), derived: [] };
  }
}

// ── The run ─────────────────────────────────────────────────────────────────

export interface PodcastChainStageResult {
  id: PodcastChainStageId;
  label: string;
  /** `manual` never occurs in this chain — every stage runs unattended. */
  status: StageStatus;
  /** Present for `declined`: what was measured, and why that means nothing to do. */
  reason?: string;
  /** Present when the stage RAN but the user must read something about what it
   * produced. Not a refusal — the same field, and the same amber, the cover
   * chain uses for its Ruling C. */
  warning?: string;
  derived: DerivedValue[];
  /** Present for `applied`: what the stage did to the audio, measured. */
  delta?: StageDelta;
  /** Present for `applied` when the stage knows something a caller cannot
   * measure (Shorten Pauses' gaps, the loudness stage's readings). */
  detail?: string;
  /** The loudness stage's own before/after numbers, for the report's LUFS row. */
  loudness?: LoudnessMeasurement;
  elapsedMs?: number;
}

export interface PodcastChainMetrics {
  rmsDb: number;
  /** SAMPLE peak (D5's `samplePeakDb`) — never a true-peak reading. */
  peakDb: number;
  crestDb: number;
  /** Integrated loudness, LUFS. `null` when every gating block was gated out —
   * and on a refused document, where the measurement is out of its own scope. */
  lufs: number | null;
}

export interface PodcastChainReport {
  before: PodcastChainMetrics;
  after: PodcastChainMetrics;
  stages: PodcastChainStageResult[];
  sampleRate: number;
  regionSamples: number;
  outputSamples: number;
  elapsedMs: number;
  /** True when at least one stage ran and the document was edited. */
  applied: boolean;
  /** Non-null when the chain refused to run at all — today only D6's >2-channel
   * case. A refusal is not a decline: no stage was resolved, so `stages` is
   * empty and this sentence is the whole account. */
  refusal: string | null;
}

function measureMetrics(
  channels: Float32Array[],
  sampleRate: number,
  measureLoudness: boolean
): PodcastChainMetrics {
  const rmsDb = programmeRmsDb(channels);
  const peak = samplePeakDb(channels);
  return {
    rmsDb,
    peakDb: peak,
    crestDb: peak - rmsDb,
    lufs: measureLoudness ? integratedLoudness(channels, sampleRate) : null,
  };
}

/**
 * The one over-scale path this chain leaves open, said out loud.
 *
 * The Limiter is last, so nothing downstream can lift the output back over the
 * ceiling — but only while the Limiter is RUNNING. Switch it off and the
 * Loudness stage becomes the last stage that touches the audio, and it is a pure
 * gain: it sets a LOUDNESS, which is an average over gated 400 ms blocks and has
 * no view whatsoever on the peak. Measured through this chain on its own speech
 * fixture, a default run's loudness gain takes the peak to +0.6 dBFS; both
 * `encodeWav` and the MP3 encoder hard-clip that, and nothing between here and
 * the file says so.
 *
 * The vocal and cover chains already had this case and the ruling that goes with
 * it: a stage that WILL run but whose result needs a caveat says the caveat with
 * the number on it, and the run is not blocked. Refusing would be worse — a user
 * who wants the measured loudness and intends to handle the peak elsewhere is
 * asking for something legitimate.
 *
 * Three conditions, all three observations rather than settings: the stage is
 * the loudness stage, the Limiter that would have caught it is off, and the
 * output ACTUALLY came back over full scale. The last one is why this is not a
 * banner — on material the gain never takes over 0 dBFS there is nothing to warn
 * about, and a warning that always shows is a warning nobody reads.
 */
function loudnessWarning(
  delta: StageDelta,
  enabled: Partial<Record<PodcastChainStageId, boolean>>
): string | undefined {
  if (enabled.limiter === true) return undefined;
  if (!(delta.peakAfterDb > 0)) return undefined;
  return `this stage set the loudness, which says nothing about the peak, and the output now peaks at +${delta.peakAfterDb.toFixed(1)} dBFS — above full scale. The Limiter, the only stage that runs after this one and the one that would have caught it, is switched off, and both the WAV writer and the MP3 encoder hard-clip anything over full scale. Switch the Limiter on, or bring the level down before you export.`;
}

/** One flat gain, out of place — the input is never mutated, because the delta
 * is measured against it. */
function applyGain(channels: Float32Array[], gainDb: number): Float32Array[] {
  const gain = Math.pow(10, gainDb / 20);
  return channels.map((c) => {
    const out = new Float32Array(c.length);
    for (let i = 0; i < c.length; i++) out[i] = c[i] * gain;
    return out;
  });
}

/** The one-line "what it did" for the stages that know something the buffers do
 * not show. Returns undefined when there is nothing extra to say. */
function describeStage(
  stage: PodcastChainStage,
  output: EffectRunOutput,
  sampleRate: number,
  delta: StageDelta
): string | undefined {
  if (output.removedSpans) return describeRemoval(output.removedSpans, sampleRate);

  // The gate's own account: how much of the selection it actually silenced.
  // Nothing else in the report can say this — the RMS and the peak barely move
  // when a pause goes to zero, and `identicalFraction` counts the samples it
  // left alone rather than the ones it took. Measured on THIS stage's output,
  // which is the only place it is still true: the EQ two stages later is an IIR
  // filter, so it smears a decaying tail into what the gate zeroed.
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
    const pct = length === 0 ? 0 : (silent / length) * 100;
    return `${(silent / sampleRate).toFixed(1)} s of the selection now sits at digital silence (${pct.toFixed(0)}%)`;
  }

  // A stage that turned out to have nothing to do says so, measured rather than
  // assumed. The limiter is the stage this fires on in practice.
  if (delta.identicalFraction === 1) return 'nothing to do — every sample came back unchanged';
  return undefined;
}

export type PodcastChainStageProgress = ChainStageProgress<PodcastChainStageId>;

export interface RunPodcastChainOptions {
  enabled: Partial<Record<PodcastChainStageId, boolean>>;
  /** A Noise Gate threshold in dBFS the USER named, passed straight through to
   * the vocal chain's `deriveGate` — the same escape hatch, for the same reason:
   * that derivation can legitimately have no answer. */
  gateThresholdDb?: number;
  onProgress?: (fraction: number) => void;
  /** Fires as each stage starts, so the UI can name what is running. */
  onStageStart?: (stage: PodcastChainStage) => void;
  /** Fires repeatedly while a stage is in flight, scoped to that stage. */
  onStageProgress?: (progress: PodcastChainStageProgress) => void;
  /** Fires as each stage's result is decided — with the VERY object that lands
   * in `report.stages`. Fires for every stage, run or not, in registry order. */
  onStageResult?: (result: PodcastChainStageResult) => void;
}

/**
 * Runs the chain over the active selection (or the whole document when there is
 * none) and commits the result as ONE undo entry.
 *
 * Resolves `null` without touching the document in exactly two cases: when there
 * is nothing to run ON — no active document, or an empty region — and when a
 * stage fails. A failure aborts the remaining stages and leaves the document
 * exactly as it was, because a half-applied chain is the one outcome the user
 * could not reason about.
 *
 * A run where every stage was off or declined is NOT one of them, and neither is
 * the >2-channel refusal: both resolve a full report with `applied: false`, so
 * the dialog can show which stage said what — or, for the refusal, the one
 * sentence that applies to the whole run.
 */
export async function runPodcastChain(
  opts: RunPodcastChainOptions
): Promise<PodcastChainReport | null> {
  const { enabled, gateThresholdDb, onProgress, onStageStart, onStageProgress, onStageResult } =
    opts;
  const state = useAppStore.getState();
  const doc = state.documents.find((d) => d.id === state.activeDocumentId) ?? null;
  if (!doc) return null;

  // ONE resolved region, read by every consumer below — the audio the stages
  // receive, the `replaceRegion` write, `regionSamples`, the marker rules'
  // absolute offsets and the post-edit selection. Resolve once rather than clamp
  // twice and hope the two agree (the ruling `resolveRegion` exists for).
  const { start, end } = resolveRegion(doc, state.selection);
  if (end <= start) return null;
  const docId = doc.id;
  const sampleRate = doc.sampleRate;
  const regionSamples = end - start;
  const startedAt = Date.now();

  let channels = cloneRegion(doc, start, end);

  // D6 — refused before anything is measured that this chain could not stand
  // behind. `lufs` stays null in both metrics on this path for exactly that
  // reason: the loudness of a surround document is the number being refused, so
  // reporting one here would be the defect wearing a report's authority.
  if (channels.length > PODCAST_CHAIN_MAX_CHANNELS) {
    const metrics = measureMetrics(channels, sampleRate, false);
    return {
      before: metrics,
      after: metrics,
      stages: [],
      sampleRate,
      regionSamples,
      outputSamples: regionSamples,
      elapsedMs: Date.now() - startedAt,
      applied: false,
      refusal: PODCAST_CHANNEL_REFUSAL,
    };
  }

  // The word evidence the gate reads, collected ONCE against the document the
  // chain is about to edit and mapped into this run's region frame — before any
  // stage runs, because the freshness test compares the stored spans' channel
  // identity with the document's.
  const gateWords = collectGateWordEvidence(docId, start, end);

  const active = PODCAST_CHAIN_STAGES.filter((s) => enabled[s.id] === true);
  const totalWeight = active.reduce((sum, s) => sum + s.weight, 0);

  const before = measureMetrics(channels, sampleRate, true);

  const results: PodcastChainStageResult[] = [];
  // Marker rules accumulate in the coordinates each stage produced, and are
  // composed into one remap at the end — see MarkerRemap's 'compose'.
  const remapSteps: MarkerRemap[] = [];
  let doneWeight = 0;
  let anyApplied = false;

  // ONE place a stage result is recorded, so the live callback cannot be given a
  // different object — or a different set of stages — from the report's.
  const record = (result: PodcastChainStageResult): void => {
    results.push(result);
    onStageResult?.(result);
  };
  const advance = (): void => {
    onProgress?.(totalWeight === 0 ? 1 : doneWeight / totalWeight);
  };

  for (const stage of PODCAST_CHAIN_STAGES) {
    if (enabled[stage.id] !== true) {
      record({ id: stage.id, label: stage.label, status: 'off', derived: [] });
      continue;
    }

    onStageStart?.(stage);
    // Announced AND painted before the measurement runs — see `announceMeasuring`
    // in vocalChain.ts. Every stage gets this, including the ones about to
    // decline: a decline is the verdict of a measurement that has to happen.
    await announceMeasuring(onStageProgress, stage.id, stage.label);

    // ── The stage the chain applies itself ───────────────────────────────────
    if (stage.id === 'loudness') {
      const resolution = deriveLoudness(channels, sampleRate);
      if (!resolution.run) {
        record({
          id: stage.id,
          label: stage.label,
          status: 'declined',
          reason: resolution.reason,
          derived: [],
        });
        doneWeight += stage.weight;
        advance();
        continue;
      }
      const renderingDetail = stageRenderingDetail(resolution.derived);
      onStageProgress?.({
        stageId: stage.id,
        label: stage.label,
        phase: 'rendering',
        stageFraction: 0,
        detail: renderingDetail,
      });
      const stageStartedAt = Date.now();
      const input = channels;
      channels = applyGain(input, resolution.gainDb);
      // MEASURED on the result. The arithmetic says it must be the target; a
      // report that stated the target and called it a measurement would be
      // untestable, and float32 rounding is real.
      const afterLufs = integratedLoudness(channels, sampleRate);
      const delta = measureStageDelta(input, channels);
      onStageProgress?.({
        stageId: stage.id,
        label: stage.label,
        phase: 'rendering',
        stageFraction: 1,
        detail: renderingDetail,
      });
      record({
        id: stage.id,
        label: stage.label,
        status: 'applied',
        warning: loudnessWarning(delta, enabled),
        derived: resolution.derived,
        delta,
        detail: `${dbStr(resolution.gainDb)} applied — ${lufsStr(resolution.beforeLufs)} before, ${afterLufs === null ? 'nothing measurable' : lufsStr(afterLufs)} after`,
        loudness: {
          beforeLufs: resolution.beforeLufs,
          afterLufs,
          targetLufs: resolution.targetLufs,
          gainDb: resolution.gainDb,
        },
        elapsedMs: Date.now() - stageStartedAt,
      });
      anyApplied = true;
      doneWeight += stage.weight;
      advance();
      continue;
    }

    // ── The effect stages ────────────────────────────────────────────────────
    // The gate's word spans are region-frame sample positions, so they are only
    // handed over while the audio still HAS that frame: Shorten Pauses runs
    // ahead of the gate and moves every sample after its first cut, and spans
    // applied to the moved audio would gate the speech itself. On a default run
    // that stage IS on, so this drops them — deliberately, and it is why the
    // gate's own decline is the common outcome here.
    const wordsStillPlaced = (channels[0]?.length ?? 0) === regionSamples ? gateWords : null;
    const resolution = resolvePodcastStage(
      stage,
      channels,
      sampleRate,
      gateThresholdDb,
      wordsStillPlaced
    );
    if (!resolution.run) {
      record({
        id: stage.id,
        label: stage.label,
        status: 'declined',
        reason: resolution.reason,
        derived: [],
      });
      doneWeight += stage.weight;
      advance();
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
      output = await runEffectOnChannels(
        stage.effectId as string,
        channels,
        sampleRate,
        resolution.params,
        {
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
        }
      );
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

    record({
      id: stage.id,
      label: stage.label,
      status: 'applied',
      derived: resolution.derived,
      delta,
      detail: describeStage(stage, output, sampleRate, delta),
      elapsedMs: Date.now() - stageStartedAt,
    });
    anyApplied = true;
    doneWeight += stage.weight;
    advance();
  }

  const after = measureMetrics(channels, sampleRate, true);
  const outputSamples = channels[0]?.length ?? 0;

  const report: PodcastChainReport = {
    before,
    after,
    stages: results,
    sampleRate,
    regionSamples,
    outputSamples,
    elapsedMs: Date.now() - startedAt,
    applied: false,
    refusal: null,
  };
  if (!anyApplied) return report;

  // No stage in this chain grows the region today, but the arithmetic is the
  // vocal chain's rather than an assumption: if one ever does, its rule is an
  // insert at the end of what the earlier stages left, expressed in the
  // coordinates the cuts above produced — which is what 'compose' applies it in.
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
      PODCAST_CHAIN_UNDO_LABEL,
      docId,
      (d) => replaceRegion(d, start, end, channels),
      { selection: { start, end: start + outputSamples }, cursorSample: start },
      { type: 'compose', steps: remapSteps }
    );
    // No `onProgress?.(1)` here: the loop already emitted exactly 1 when the last
    // stage's weight landed.
  } catch (err) {
    // The doc may have been closed while the chain was running.
    reportEffectFailure(err);
    return null;
  }

  return { ...report, applied: true };
}
