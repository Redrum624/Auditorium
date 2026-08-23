/**
 * Task CP1 — the Cover Chain as the whole journey.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * The shipped Cover Chain (F10) matched a take's tone and level to an original
 * vocal and then listed five things the user had to do BY HAND either side of
 * it: separate the song, run the Vocal Chain, repair words, align timing, and
 * build the session. Every one of those was a defensible engineering decision
 * and the sum of them was not the product the name promises. The user, after
 * running it: "you are supposed to input the original song AND the vocals,
 * clean the vocals, align with original, remove the vocals from original, add
 * cleaned vocals to music of original, smooth."
 *
 * So this module is that sentence, in order, unattended. It is ORCHESTRATION
 * and it contains no DSP: every stage below is an existing, reviewed, shipped
 * service called with the right inputs in the right order.
 *
 *   1. Separate      → `stemService.separateStems` + `stemLanding.createStemDocuments`
 *   2. Clean         → `vocalChain.runVocalChain`
 *   3. Align         → `dsp/coverAlign.alignTakeToReference`
 *   4. Match         → `coverChain.runCoverChain`, the four stages unchanged
 *   5. Place         → `multitrack/session` + the load-shaped session apply
 *   6. Smooth        → the v1.9 clip fades + `mixdown.mixdownSessionPeak`
 *
 * The one genuinely new thing is the alignment, and it lives in `dsp/coverAlign`
 * with its own ground-truth tests and a threshold it measured.
 *
 * ── What is still manual, and why it always will be ─────────────────────────
 * Align Lyrics. It replaces ONE word the user picks with a fresh take of that
 * word, and nothing in the app judges which word that should be — a per-phone
 * quality scorer was built, measured 0.642 AUC against a 0.500 chance baseline,
 * and was cut. Align Vocal Timing stays manual for Ruling E's reason (it needs
 * a confirmed grid). Both are listed as optional refinements AFTER the run,
 * because the run's alignment is a PLACEMENT and neither of those is.
 *
 * ── Cancellation, and what a cancelled run leaves behind ────────────────────
 * A run spans minutes and separation dominates it, so Cancel has to work. The
 * flag is checked between stages and inside separation (whose own
 * `cancelStemSeparation` is forwarded). The artifact story is deliberately
 * simple and is stated in the dialog rather than left to be discovered: THE
 * SESSION IS BUILT ONLY AT STAGE 5, so cancelling before then leaves documents
 * — the stems, and a take with whatever passes already committed — and no
 * session at all. Nothing is half-built, because nothing before stage 5 builds
 * anything jointly.
 *
 * CC4 (CJ-1): that sentence used to be false in the fresh-separation arm, which
 * called `stemLanding.landStems` — documents AND a `<song> — Stems` session that
 * replaced the user's, with its undo history cleared — at stage 1. Stage 1 now
 * calls `createStemDocuments`, the documents half only, so the contract above is
 * something the code does rather than something this comment claims. The
 * standalone Separate dialog still calls the whole `landStems`, because
 * replacing the session is what that dialog is for and it says so.
 *
 * ── Undo ────────────────────────────────────────────────────────────────────
 * Each sub-pass keeps its OWN undo entry, the chains' own precedent: "Vocal
 * Chain" and "Cover Chain" are two entries on the take, the stem documents are
 * creations rather than edits (nothing to undo), and the session replacement is
 * load-shaped and clears session history exactly as Open Project and stem
 * landing do. The report lists every entry the pass left.
 *
 * ONE undo entry across all of it is NOT attempted, and that is a decision
 * rather than an omission: undo entries are per-document, and a single entry
 * spanning two documents plus a session replacement is a data-model change
 * (`editOps`/`sessionUndo` would both have to learn a joint scope). Noted as
 * future work; not smuggled in behind a cover feature.
 */

import { createDocument, docLength, type AudioDocument } from '../audio/AudioDocument';
import { toDb } from '../dsp/chainAnalysis';
import {
  ALIGN_MIN_CORRELATION,
  ALIGN_MIN_PROMINENCE,
  alignTakeToReference,
  type AlignmentMeasurement,
} from '../dsp/coverAlign';
import { mixdownSessionPeak } from '../multitrack/mixdown';
import {
  createClip,
  createTrack,
  DEFAULT_FADE_CURVE,
  clampFadePair,
  documentClipLength,
  type Session,
  type Track,
} from '../multitrack/session';
import { useSessionStore } from '../multitrack/sessionStore';
import { defaultSessionZoom } from '../multitrack/sessionZoom';
// V4: the trim's two fader writes are ONE user-visible act, and the fader's
// legal range is already stated once — in the automation layer, which the
// mixer strip and the parse boundary both read.
import { clearSessionHistory, withSessionGesture } from '../multitrack/sessionUndo';
import { clampAutomationValue, resolveAutomation } from '../multitrack/automation';
import { useAppStore } from '../stores/appStore';
import { linkDerivedDocument } from './beatGrid';
import {
  COVER_CHAIN_RESIDUAL_SENTENCE,
  COVER_CHAIN_UNDO_LABEL,
  defaultCoverStageSelection,
  runCoverChain,
  type CoverChainReport,
} from './coverChain';
// CC3: the refusal arm's copy, and the fade constant it shares with the
// apply-the-guess action. One direction only — `coverPlacement` never imports
// this module.
// V3: `autoPlaces` (which outcomes this pass places) and `placedRemedy` (what a
// placed one says for itself) join the refusal copy above.
import {
  JOURNEY_FADE_MS,
  autoPlaces,
  guessCandidates,
  guessCharacterisation,
  guessKind,
  guessRemedy,
  placedRemedy,
  placementFor,
} from './coverPlacement';
import { getHistory } from './undoHistory';
import { cancelStemSeparation, separateStems, STEM_LABELS } from './stemService';
import {
  createStemDocuments,
  MONO_PAN_COMPENSATION_DB,
  STEM_TRACK_LABELS,
} from './stemLanding';
import {
  VOCAL_CHAIN_UNDO_LABEL,
  defaultStageSelection,
  runVocalChain,
  type ChainStageProgress,
  type DerivedValue,
  type VocalChainReport,
} from './vocalChain';

// ── The stages ──────────────────────────────────────────────────────────────

export type CoverJourneyStageId =
  | 'separate'
  | 'clean'
  | 'align'
  | 'match'
  | 'place'
  | 'smooth';

export interface CoverJourneyStage {
  id: CoverJourneyStageId;
  label: string;
  /** Why the stage sits where it does, shown verbatim. */
  note: string;
  /**
   * Share of the whole-pass bar. These are ORDERS OF MAGNITUDE rather than
   * measured percentages, and saying so is the honest form: separation is a
   * model run over the whole song and `stemService` measures it at 1.52× real
   * time, so on a three-minute song it is ~4.5 minutes against roughly 4 s for
   * every other stage put together. Any weighting that tried to be precise
   * about the other five would be precise about 1.5 % of the bar.
   */
  weight: number;
}

export const COVER_JOURNEY_STAGES: readonly CoverJourneyStage[] = [
  {
    id: 'separate',
    label: 'Separate the Original',
    note: `Runs the separation model over the original song and lays down its five stems. Reused rather than re-run when this song's stems are already open — a model pass is minutes, and the report says which of the two happened. ${COVER_CHAIN_RESIDUAL_SENTENCE}`,
    weight: 90,
  },
  {
    id: 'clean',
    label: 'Clean the Take (Vocal Chain)',
    // CC1: eleven, not ten — the Vocal Chain gained a Noise Gate stage, and the
    // silence it brings the pauses to is the visible half of what this stage
    // does for a cover, so the sentence names it.
    note: "The whole Vocal Chain on your take, with its own eleven stages reported live below this row rather than hidden behind one bar. It removes noise, hum and DC, gates the pauses between your phrases down to actual silence, corrects pitch, and sets a compressor, de-esser and high-pass from the take's own levels. The match that follows is a correction to a CLEAN take: matching the timbre of a noisy one matches the noise too.",
    weight: 4,
  },
  {
    id: 'align',
    label: 'Align with the Original',
    // V3: the note names the placement arms.
    note: "Finds where your take belongs on the original's timeline by cross-correlating the two onset envelopes, and reports the offset with the confidence that produced it. This is a PLACEMENT, not a warp — nothing is stretched and no syllable is moved. A lag the confidence cannot fully believe is still PLACED, with its measurement stated and its rival lags one click away; only a take nothing could relate to the song at all is placed at zero instead. Align Vocal Timing and Align Lyrics stay manual, and are worth running afterwards if the take drifts or a word came out wrong.",
    weight: 2,
  },
  {
    id: 'match',
    label: 'Match to the Original Vocal',
    note: "The Cover Chain's four matching stages, unchanged: Match EQ, Match Reverb, Match Loudness and the Limiter, measured against the separated original vocal. Each one's own reasons, refusals and derived settings are reported below this row.",
    weight: 3,
  },
  {
    id: 'place',
    label: 'Build the Session',
    note: 'Builds a two-track session: the original with its vocal removed on one track, your matched take on the other at the offset the alignment found. This is the first stage that creates anything jointly — cancel before it and you are left with documents and no session.',
    weight: 1,
  },
  {
    id: 'smooth',
    label: 'Smooth and Check the Level',
    // V4: the note used to end "the number is reported — nothing is normalised,
    // limited or mastered on your behalf", which was true and was also the
    // problem: the pass built the overshoot and then handed it back. It now
    // says what the pass does about it, and keeps the promise that matters —
    // the only thing it changes is one level, on both faders at once.
    note: "Puts edge fades on the placed take so neither end starts or stops mid-waveform, then mixes the session down to measure what the two tracks actually sum to. If that sum passes full scale, BOTH faders come down by the overshoot — equally, so the balance the match set is untouched — the trimmed session is summed again to check, and the number is reported. Nothing is normalised, limited or mastered on your behalf, and the trim is one undo away.",
    weight: 1,
  },
];

export function journeyStageById(id: CoverJourneyStageId): CoverJourneyStage {
  const stage = COVER_JOURNEY_STAGES.find((s) => s.id === id);
  if (!stage) throw new Error(`Unknown cover journey stage: ${id}`);
  return stage;
}

// CC3: the edge-fade constant's DECLARATION moved to `coverPlacement`, which
// has to lay down the same fades when the refused guess is applied late; a
// module importing this one to learn its fade length would close an import
// cycle. Re-exported here so every existing import path still resolves and the
// smoothing stage below reads the same 25 ms it always did.
export { JOURNEY_FADE_MS };

/** Suffix for the summed non-vocal document the journey creates. */
export const INSTRUMENTAL_SUFFIX = '— Instrumental';

/**
 * V4 — the level stage 6 trims its own session down to when the two tracks it
 * built sum past full scale, in dBFS.
 *
 * ONE dB of headroom, not zero, and both halves of that are deliberate.
 *
 * Zero would be the arithmetically exact answer — scaling both faders by the
 * same factor scales the summed peak by exactly that factor, so a trim of
 * `summedPeakDb` lands the sum on 1.0. But it lands there through a dB→linear
 * round trip in double and a per-sample multiply in float32, either of which
 * may leave the last sample a ULP above 1.0, and the WAV writer's clamp and
 * the MP3 encoder do not care that it was a rounding error. A target that can
 * fail by rounding is not a target.
 *
 * A dB is also the smallest margin that answers the OTHER half of the warning
 * this stage has always carried: the MP3 encoder. A stream whose sample peak
 * is 0 dBFS reconstructs, on decode, above 0 dBFS between the samples — the
 * inter-sample overshoot lossy delivery is conventionally given ~1 dB for. The
 * journey cannot measure a decoder's reconstruction, so it spends the
 * conventional dB and SAYS it did, rather than hitting a ceiling it can only
 * verify at the sample grid.
 *
 * It is a level trim on two faders and nothing else: no normalisation (the sum
 * is never brought UP to a target), no limiting, no mastering. A session that
 * already fits is not touched.
 */
export const JOURNEY_PEAK_TARGET_DB = -1;

/**
 * V4 — the History label the trim's single session entry carries. Named for
 * what it is rather than for the stage, because it is the one thing in the
 * finished session that the user did not ask for and may want back: undoing it
 * restores the faders the pass found, clipping and all.
 */
export const JOURNEY_TRIM_UNDO_LABEL = 'Cover level trim';

/** Name of the session the journey builds: `<song> — Cover`. */
export function coverSessionName(songName: string): string {
  return `${songName} — Cover`;
}

// ── Results ─────────────────────────────────────────────────────────────────

export type CoverJourneyStageStatus =
  /** It ran and did what it says. */
  | 'done'
  /** It ran, measured, and declined — with a reason. */
  | 'declined'
  /** It did not need to run (a reused separation). */
  | 'reused'
  /** The user cancelled at or before this stage. */
  | 'cancelled'
  /** It could not run and the pass stopped. */
  | 'failed'
  /** Not reached. */
  | 'pending';

export interface CoverJourneyStageResult {
  id: CoverJourneyStageId;
  label: string;
  status: CoverJourneyStageStatus;
  /** Present for `declined` / `failed`: what was measured, and why that means
   * this stage could not do its job. */
  reason?: string;
  /** Present when the stage ran but the user must read something about it. */
  warning?: string;
  derived: DerivedValue[];
  /** Undo entries this stage left on a document, by label. */
  undoEntries: string[];
  elapsedMs?: number;
  /** The nested report, when this stage IS one of the existing chains. Carried
   * whole rather than summarised: the chains already say everything about
   * themselves, and a second phrasing here could only disagree with them. */
  vocalChain?: VocalChainReport;
  coverChain?: CoverChainReport;
}

export interface CoverJourneySeparation {
  /** True when an existing separation of this song was reused. */
  reused: boolean;
  vocalsDocId: string;
  instrumentalDocId: string;
  /** The four stem documents the instrumental was summed from, by name. */
  summedFrom: string[];
  sampleRate: number;
  lengthSamples: number;
}

export interface CoverJourneyPlacement {
  sessionName: string;
  sessionRate: number;
  instrumentalStartSample: number;
  takeStartSample: number;
  /**
   * Samples BOTH tracks were pushed later so neither starts before zero. Non-
   * zero exactly when the take belonged before the original's own start; the
   * alternative — clamping the take to 0 — would have silently changed the
   * alignment the stage above just measured.
   */
  shiftedSamples: number;
  takeLengthSample: number;
  /** CC4 (CJ-2): the clip gain the take was placed with. */
  takeGainDb: number;
}

export interface CoverJourneySmoothing {
  fadeInSample: number;
  fadeOutSample: number;
  curve: string;
  /** Peak of the summed session BEFORE the master bus's ±1 clamp, in dBFS.
   * ALWAYS the peak as the pass BUILT it — the trim below does not rewrite
   * this number, because what the two tracks summed to is the reason the trim
   * happened and stays reportable. */
  summedPeakDb: number;
  /** True when that peak passed full scale. */
  overCeiling: boolean;
  /** V4 — how far DOWN both faders were moved, in dB, or 0 when the sum fitted
   * and nothing was touched. Positive; the faders hold its negation. */
  trimDb: number;
  /** V4 — the peak of the trimmed session, in dBFS, MEASURED by a second
   * summation rather than derived from `summedPeakDb - trimDb`. `null` when
   * there was no trim, which is also how a reader tells that no second
   * summation was spent. */
  trimmedPeakDb: number | null;
}

export interface CoverJourneyReport {
  songName: string;
  takeName: string;
  stages: CoverJourneyStageResult[];
  separation: CoverJourneySeparation | null;
  alignment: AlignmentMeasurement | null;
  /**
   * True when alignment ran, was not believed, and the take therefore went to
   * ZERO.
   *
   * V3 narrowed this. It used to mean "not believed", which was the same thing
   * as "placed at zero" because nothing but the confident arm placed. Now the
   * two OFFER outcomes are placed at their own measured lag, so "not believed"
   * and "placed at zero" have come apart, and this field kept the meaning that
   * describes what happened to the timeline. `'unrelated'` and a measurement
   * carrying no outcome word are what reach it; see
   * {@link alignmentAutoPlaced} for the other half.
   */
  alignmentRefused: boolean;
  /**
   * V3. True when the take was placed at a lag the pass could not fully believe
   * — the `'weak'` and `'ambiguous'` outcomes, which carry a usable guess and
   * its alternatives.
   *
   * Set from `coverPlacement.autoPlaces`, the SAME predicate the dialog uses to
   * decide what to say about the placement, so the report and the screen cannot
   * disagree about whether the clips were moved.
   */
  alignmentAutoPlaced: boolean;
  placement: CoverJourneyPlacement | null;
  smoothing: CoverJourneySmoothing | null;
  /** The stage the user cancelled at, or `null` for a run that finished. */
  cancelledAt: CoverJourneyStageId | null;
  /** Every undo entry the pass left, in the order it left them. */
  undoEntries: string[];
  elapsedMs: number;
  /** True only when all six stages completed. */
  completed: boolean;
}

// ── Live view ───────────────────────────────────────────────────────────────

/**
 * The journey's live row, in the chains' own vocabulary — `ChainStageProgress`
 * is imported rather than restated, so three steppers cannot describe the same
 * thing in three ways.
 *
 * `sub` is the whole point of nesting rather than flattening: stages 2 and 4 are
 * themselves multi-stage chains with their own live rows, and collapsing ten
 * vocal-chain stages into one opaque bar is exactly the thing P1 was built to
 * stop. When `sub` is set, the consumer renders the nested chain's own row
 * underneath this one.
 */
export interface CoverJourneyStageProgress extends ChainStageProgress<CoverJourneyStageId> {
  sub?: ChainStageProgress<string> | null;
}

export interface RunCoverJourneyOptions {
  /** The original song — the full mix, the thing that gets separated. */
  songDocId: string;
  /** The vocal take. */
  takeDocId: string;
  onProgress?: (fraction: number) => void;
  onStageStart?: (stage: CoverJourneyStage) => void;
  onStageProgress?: (progress: CoverJourneyStageProgress) => void;
  /** Fires as each stage's result is decided, with the VERY object that lands
   * in `report.stages` rather than a copy. */
  onStageResult?: (result: CoverJourneyStageResult) => void;
  /** Polled between stages, and during separation. */
  shouldCancel?: () => boolean;
}

// ── Separation reuse ────────────────────────────────────────────────────────

/**
 * The five stem documents of `song`, if they are all still open and still
 * describe it — or `null`.
 *
 * The rule, stated exactly because a reuse that is wrong costs the user a
 * whole cover: a document named `<song> — <label>` for every one of the five
 * labels, each at the song's sample rate and the song's length. That is the
 * same precondition `linkDerivedDocument` verifies before it lets a stem
 * inherit the song's beat grid, and it is checkable from what is on screen.
 *
 * What it CANNOT see, said rather than hidden: an edit to the song that left
 * its length unchanged, or a stem document renamed to match by coincidence. A
 * user who has edited the song since separating it should separate it again;
 * the report names every document it reused so that is visible rather than
 * assumed.
 */
export function findExistingSeparation(
  documents: readonly AudioDocument[],
  song: AudioDocument
): AudioDocument[] | null {
  const length = docLength(song);
  if (length === 0) return null;
  const found: AudioDocument[] = [];
  for (const label of STEM_TRACK_LABELS) {
    const name = `${song.name} — ${label}`;
    const doc = documents.find(
      (d) =>
        d.id !== song.id &&
        d.name === name &&
        d.sampleRate === song.sampleRate &&
        docLength(d) === length
    );
    if (!doc) return null;
    found.push(doc);
  }
  return found;
}

/**
 * CC4 (CJ-4) — the journey passes this take has already been through, oldest
 * first, read from its own undo history.
 *
 * The two labels are the ones the nested chains commit under, so this is a fact
 * about the document rather than a flag this module would have to store and keep
 * in sync. A take carrying them has already been noise-reduced, pitch-corrected,
 * matched and limited; running the journey again learns a noise print from
 * already-gated audio and corrects pitch a second time, which is a real audible
 * cost and is not what a user pressing Run a second time is usually after (they
 * are usually after the placement). Undone entries are deliberately NOT counted:
 * an undone pass is not in the audio.
 */
export function priorJourneyPasses(docId: string): string[] {
  const known: string[] = [VOCAL_CHAIN_UNDO_LABEL, COVER_CHAIN_UNDO_LABEL];
  return getHistory(docId).done.filter((label) => known.includes(label));
}

/**
 * CC4 fix-round 2 (N1) — whether `doc` ALREADY holds exactly `channels`, sample
 * for sample.
 *
 * This is the whole adoption test, and it is a content test rather than a
 * provenance one for a reason no in-process signal can get around: `.audm`
 * persists a document's samples and NOT its undo history, and reopening a
 * session re-adds every document under a fresh id, so an instrumental the user
 * edited, saved and reopened reads pristine to any history test while carrying
 * their edit in its samples. Round 1's history predicate closed the live-session
 * half of that and could not close this one.
 *
 * What the content test buys instead is a proof rather than an inference: when a
 * candidate already equals the sum this pass computed, adopting it is a no-op —
 * there is nothing to write, so there is nothing to destroy, whoever made it and
 * whatever else they did to it. When it differs, SOMETHING changed it (their
 * edit, a different separation, another song) and the pass creates its own
 * beside it rather than deciding whose bytes those were.
 *
 * A non-finite sample compares unequal to itself, so a document carrying NaN
 * never matches and is never adopted — the safe direction, and unreachable in
 * practice: `separateStems` sanitises non-finite model output before it lands.
 *
 * COST, measured rather than assumed: 29.7 ms median (min 28.1, max 32.5, five
 * runs, node v24.13.0) for the worst case — two channels of a four-minute song
 * at 44.1 kHz, 21.17 M samples / 80.7 MB per side, scanned to the end because
 * they are EQUAL, which is the adoption path. A mismatch exits at the first
 * differing sample: 0.0 ms when it differs early, 27.8 ms when it differs only
 * at the very last sample. Against a pass whose separation stage alone is
 * minutes (`stemService` measures 1.52x real time), and once per run, this is
 * not a cost worth trading a data-loss hole for.
 */
function holdsExactly(doc: AudioDocument, channels: readonly Float32Array[]): boolean {
  if (doc.channels.length !== channels.length) return false;
  for (let c = 0; c < channels.length; c++) {
    const held = doc.channels[c];
    const wanted = channels[c];
    if (held.length !== wanted.length) return false;
    for (let i = 0; i < held.length; i++) if (held[i] !== wanted[i]) return false;
  }
  return true;
}

/**
 * The instrumental: the four non-vocal stems summed.
 *
 * Not a new separation and not an approximation — separation's one hard
 * guarantee is that its five outputs sum back to the mix EXACTLY, so
 * `mix − vocals` and `drums + bass + other + residual` are the same signal to
 * the last bit. Summing the four is the form that needs no subtraction and no
 * gain, which is why it is the one used.
 *
 * `COVER_CHAIN_RESIDUAL_SENTENCE` still applies to the result and is still
 * shown: exact summation is a statement about arithmetic, not about whether the
 * original singer is audible in the bed. She is.
 */
export function sumInstrumental(stems: readonly AudioDocument[]): Float32Array[] {
  const nonVocal = stems.filter((_, i) => STEM_TRACK_LABELS[i] !== 'Vocals');
  const channelCount = Math.max(...nonVocal.map((d) => d.channels.length));
  const length = Math.max(...nonVocal.map((d) => docLength(d)));
  const out: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) {
    const acc = new Float32Array(length);
    for (const doc of nonVocal) {
      const src = doc.channels[c] ?? doc.channels[0];
      if (!src) continue;
      const n = Math.min(src.length, length);
      for (let i = 0; i < n; i++) acc[i] += src[i];
    }
    out.push(acc);
  }
  return out;
}

// ── The run ─────────────────────────────────────────────────────────────────

const secondsStr = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)} s`;
const dbfsStr = (v: number): string => `${v.toFixed(2)} dBFS`;
/** CC4 (CJ-2): a signed gain, the cover chain's own idiom for the same thing. */
const dbStr = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)} dB`;

/**
 * What the align stage says when it will not believe the offset it measured.
 *
 * Exported because the sentence and the controls it names live in two files:
 * this composes the copy, `CoverChainDialog` renders the offer, and the ONE
 * thing that must hold between them — the reason never names a control the
 * dialog does not render for that same measurement — is only testable if both
 * sides can be driven from the same measurement.
 */
export function refusalReason(alignment: AlignmentMeasurement): string {
  const characterisation = guessCharacterisation(guessKind(alignment));
  // The remedy's one-click half names the control the dialog will render, and
  // the dialog decides that from the candidate list — so this reads the same
  // list rather than the outcome word.
  const hasCandidates = guessCandidates(alignment).length > 0;
  return (
    `the best alignment found was ${secondsStr(alignment.offsetSeconds)}, and it is not believable: correlation ${alignment.peakCorrelation.toFixed(3)} against a floor of ${ALIGN_MIN_CORRELATION}, standing ${alignment.prominence.toFixed(3)} above the next best lag against a floor of ${ALIGN_MIN_PROMINENCE}. ` +
    (characterisation ? `${characterisation}. ` : '') +
    `The take is placed at the start of the original instead of at a guess. ${guessRemedy(alignment.offsetSeconds, hasCandidates)}`
  );
}

/**
 * V3. What the align stage says when it PLACED an offset it could not fully
 * believe — the sibling of {@link refusalReason}, for the arm the user asked
 * for ("it should place the tracks by itself!").
 *
 * The seam it has to hold is the same one, for the same reason: the copy is
 * written here and the controls are rendered in `CoverChainDialog`, so the ONE
 * fact both branch on is the candidate list — the rows exist, or the single
 * button does. Nothing here may name the other.
 *
 * T3 (MIN-1): the LIST is handed over whole rather than reduced to a boolean
 * here, because the placed arm also has to say whether there is anywhere ELSE
 * to go, and `candidates[0]` is the lag the take is already on. Reducing it
 * here is what let the sentence promise "these other lags matched too" over a
 * single row that was the winner's own.
 */
export function autoPlacedReason(alignment: AlignmentMeasurement): string {
  const characterisation = guessCharacterisation(guessKind(alignment));
  const candidates = guessCandidates(alignment);
  return (
    `this placement was made on evidence BELOW the floors, and the numbers are worth reading before you trust it: correlation ${alignment.peakCorrelation.toFixed(3)} against a floor of ${ALIGN_MIN_CORRELATION}, standing ${alignment.prominence.toFixed(3)} above the next best lag against a floor of ${ALIGN_MIN_PROMINENCE}. ` +
    (characterisation ? `${characterisation}. ` : '') +
    placedRemedy(alignment.offsetSeconds, candidates)
  );
}

/**
 * T3 (V4 MIN-5). Why the level trim's arithmetic is allowed to work the way it
 * does — stated, and checked, instead of held by construction alone.
 *
 * The trim clamps ONCE, to the delta both tracks share
 * (`clampAutomationValue('volumeDb', -wanted)`), and then writes
 * `t.volumeDb + faderDb` to each. Two facts make that valid, and neither is
 * enforced anywhere else in the system:
 *
 *  - **Every fader starts at 0.** `setTrackParam` stores its patch verbatim
 *    with no clamp of its own (`sessionStore.ts`), so on a track that started
 *    below 0 the sum can land past the −60 dB floor — a level the mixer strip
 *    cannot show and the automation layer would refuse — while the stage's
 *    warning goes on quoting the floor as though it had been respected.
 *  - **No track carries a volume LANE.** A lane OVERRIDES the static fader
 *    rather than offsetting it (F0's override-not-offset ruling), so the write
 *    would land and change nothing audible: the trim inert, the second
 *    summation still over, and the `stillOver` copy blaming the fader floor for
 *    a floor that was never reached.
 *
 * Both hold because stage 5 builds this session two stages earlier, through
 * `createTrack` (fader 0) and with no automation. That is exactly why this
 * THROWS rather than declining: a violation is this module contradicting
 * itself, not a state a user can arrive in, and the journey's own catch turns a
 * throw into a failed stage carrying the reason. Trimming the wrong amount
 * quietly is the outcome worth refusing.
 *
 * Returns the reason the trim may not proceed, or `null`.
 */
export function trimBlockedBy(tracks: readonly Track[]): string | null {
  for (const t of tracks) {
    if (t.volumeDb !== 0) {
      return `track ${t.id}'s fader starts at ${t.volumeDb} dB, but the level trim clamps one shared delta against a start of 0`;
    }
    // Through the shipped resolver, so "a lane with no keys" and "a lane on
    // another parameter" mean here exactly what they mean to the engines.
    if (resolveAutomation(t.automation)?.volume) {
      return `track ${t.id} carries a volume automation lane, which overrides the fader the level trim writes rather than taking it`;
    }
  }
  return null;
}

/** The cancellation sentinel, so every stage's early return is one shape. */
const CANCELLED = Symbol('cancelled');

/**
 * Runs the whole journey.
 *
 * Resolves `null` only when the pass could not START — a missing song, a missing
 * take, an empty document, or the two being the same document. Everything else
 * resolves a report: a stage that failed, declined or was cancelled says so in
 * its own row, because a pass that stopped half way still owes the user an
 * account of what it did before it stopped.
 */
export async function runCoverJourney(
  opts: RunCoverJourneyOptions
): Promise<CoverJourneyReport | null> {
  const { songDocId, takeDocId, onProgress, onStageStart, onStageProgress, onStageResult } = opts;
  const cancelled = (): boolean => opts.shouldCancel?.() === true;

  const initial = useAppStore.getState();
  const song = initial.documents.find((d) => d.id === songDocId) ?? null;
  const take = initial.documents.find((d) => d.id === takeDocId) ?? null;
  if (!song || !take) return null;
  if (song.id === take.id) return null;
  if (docLength(song) === 0 || docLength(take) === 0) return null;

  const startedAt = Date.now();
  const results: CoverJourneyStageResult[] = [];
  const undoEntries: string[] = [];
  const totalWeight = COVER_JOURNEY_STAGES.reduce((sum, s) => sum + s.weight, 0);
  let doneWeight = 0;

  const record = (result: CoverJourneyStageResult): CoverJourneyStageResult => {
    results.push(result);
    onStageResult?.(result);
    return result;
  };

  /** Everything after `id` that never got a chance to run. */
  const fillPending = (id: CoverJourneyStageId): void => {
    const from = COVER_JOURNEY_STAGES.findIndex((s) => s.id === id) + 1;
    for (const stage of COVER_JOURNEY_STAGES.slice(from)) {
      record({ id: stage.id, label: stage.label, status: 'pending', derived: [], undoEntries: [] });
    }
  };

  /** The stage `begin` last admitted, so a throw can name what was running. A
   * holder rather than a bare `let`: TypeScript's control-flow analysis cannot
   * see an assignment made inside `begin`'s closure and would narrow the bare
   * binding to `null` in the catch block below. */
  const running: { stage: CoverJourneyStage | null } = { stage: null };
  let separation: CoverJourneySeparation | null = null;
  let alignment: AlignmentMeasurement | null = null;
  let alignmentRefused = false;
  // V3: the other half of the same question — whether the take was PLACED at a
  // lag the pass could not fully believe, rather than sent to zero.
  let alignmentAutoPlaced = false;
  /** CC2 (ALIGN-5): the take's channels as the singer recorded them, taken at
   * stage 2 before the Vocal Chain rewrites them, because stage 3 measures onset
   * envelopes and the chain moves onsets. Set in stage 2, read in stage 3. */
  let preCleanTakeChannels: Float32Array[] | null = null;
  let placement: CoverJourneyPlacement | null = null;
  let smoothing: CoverJourneySmoothing | null = null;
  let cancelledAt: CoverJourneyStageId | null = null;

  const finish = (completed: boolean): CoverJourneyReport => ({
    songName: song.name,
    takeName: take.name,
    stages: results,
    separation,
    alignment,
    alignmentRefused,
    // V3:
    alignmentAutoPlaced,
    placement,
    smoothing,
    cancelledAt,
    undoEntries,
    elapsedMs: Date.now() - startedAt,
    completed,
  });

  /**
   * What a cancel at THIS stage actually leaves behind.
   *
   * CP1 fix-round (I1): this used to tell the user "there is no session"
   * whenever the cancel landed at `place` OR `smooth` — and at `smooth` the
   * session has already been built and is on screen. The copy has to describe
   * the artifacts that exist at each boundary, or the coherent-artifact story
   * the whole cancellation design rests on is just a sentence.
   */
  const cancelReason = (id: CoverJourneyStageId): string => {
    if (id === 'smooth') {
      return (
        'cancelled after the session was built — “' +
        (placement ? placement.sessionName : coverSessionName(song.name)) +
        '” is open and your take is placed at the offset that was measured, but its edges are ' +
        'NOT faded and the summed level has not been checked. Fade the clip edges yourself, and ' +
        'watch the level when you mix down'
      );
    }
    // CC4 (CJ-1): "there is no session" was a claim about the SCREEN, and it
    // was false for anyone who had a session open — which, in the fresh arm,
    // this pass had already replaced by stage 1. The stems now land as
    // documents only, so the accurate claim is about THIS PASS: it built no
    // session, and whatever was open is still exactly what it was.
    return 'cancelled before the session was built — the documents this pass produced are open and unchanged, this pass built no session, and whatever session you had open before you ran it is still there, untouched';
  };

  /** Starts a stage, or returns CANCELLED when the user asked to stop first. */
  const begin = (stage: CoverJourneyStage): typeof CANCELLED | null => {
    if (cancelled()) {
      cancelledAt = stage.id;
      record({
        id: stage.id,
        label: stage.label,
        status: 'cancelled',
        reason: cancelReason(stage.id),
        derived: [],
        undoEntries: [],
      });
      fillPending(stage.id);
      return CANCELLED;
    }
    running.stage = stage;
    onStageStart?.(stage);
    return null;
  };

  const advance = (stage: CoverJourneyStage): void => {
    doneWeight += stage.weight;
    onProgress?.(doneWeight / totalWeight);
  };

  const emit = (
    stage: CoverJourneyStage,
    detail: string,
    stageFraction: number,
    sub?: ChainStageProgress<string> | null
  ): void => {
    onStageProgress?.({
      stageId: stage.id,
      label: stage.label,
      phase: stageFraction > 0 ? 'rendering' : 'measuring',
      stageFraction,
      detail,
      sub: sub ?? null,
    });
    if (stageFraction > 0) {
      onProgress?.((doneWeight + stage.weight * stageFraction) / totalWeight);
    }
  };

  /**
   * CP1 fix-round (I2). Every stage below calls into a service that can throw —
   * a worker that dies, a document closed mid-flight, an out-of-memory decode.
   * Without this the exception escaped `runCoverJourney` entirely: the dialog's
   * `try/finally` has no `catch`, so the promise rejected, no report was ever
   * set, and the stage rows from the part of the run that DID happen stayed on
   * screen looking like an outcome.
   *
   * A throw is now an outcome like any other: the stage that was running is
   * recorded as `failed` WITH the error's own message, everything after it is
   * `pending`, and the report comes back with `completed: false`. The caller
   * gets an account of exactly how far the pass got.
   */
  try {
  // ── 1. Separate ───────────────────────────────────────────────────────────
  const separateStage = journeyStageById('separate');
  {
    const stage = separateStage;
    if (begin(stage) === CANCELLED) return finish(false);
    const at = Date.now();

    let stems = findExistingSeparation(useAppStore.getState().documents, song);
    const reused = stems !== null;

    if (!stems) {
      emit(stage, 'starting the separation model', 0);
      const result = await separateStems({
        sourceDocId: song.id,
        onProgress: (p) => {
          // The model's own three phases are carried in the detail line rather
          // than mapped onto the two-phase chain vocabulary, which has no word
          // for "resampling" and would have had to lie about one of them.
          const of = p.totalSegments > 0 ? ` — segment ${p.segment} of ${p.totalSegments}` : '';
          emit(stage, `${p.phase}${of}`, p.fraction);
          if (cancelled()) void cancelStemSeparation();
        },
      });
      if (!result.ok) {
        const isCancel = result.status === 'cancelled';
        if (isCancel) cancelledAt = stage.id;
        record({
          id: stage.id,
          label: stage.label,
          status: isCancel ? 'cancelled' : 'failed',
          reason: result.message,
          derived: [],
          undoEntries: [],
          elapsedMs: Date.now() - at,
        });
        fillPending(stage.id);
        return finish(false);
      }
      // CC4 (CJ-1): the DOCUMENTS half of the landing, never the session half.
      // `landStems` also installs a `<song> — Stems` session and clears the
      // session undo history — at stage 1, four stages before this module's
      // header, `cancelReason` below, and the dialog all promise any session is
      // touched. A user who cancelled at stage 2 lost the arrangement they had
      // open, and the row they were shown said "there is no session". The stems
      // are still landed as documents (everything downstream finds them by
      // name); the session this pass builds is still stage 5's, and it is the
      // only one.
      createStemDocuments(result.output);
      stems = findExistingSeparation(useAppStore.getState().documents, song);
      if (!stems) {
        record({
          id: stage.id,
          label: stage.label,
          status: 'failed',
          reason:
            'the separation finished but its five documents could not be found again by name — nothing further can be matched or placed against them',
          derived: [],
          undoEntries: [],
          elapsedMs: Date.now() - at,
        });
        fillPending(stage.id);
        return finish(false);
      }
    }

    const vocals = stems[STEM_TRACK_LABELS.indexOf('Vocals')];
    const nonVocalNames = stems
      .filter((_, i) => STEM_TRACK_LABELS[i] !== 'Vocals')
      .map((d) => d.name);

    // The instrumental document, RE-SUMMED every run and re-used in place when
    // this pass's own earlier copy is still open and still describes the song.
    //
    // CC4 (CJ-4): it used to be created outright every run. The reasoning — a
    // stale copy could silently describe a different song — is right and is kept:
    // the samples below are always the fresh sum, never last run's. What it did
    // not do was close or reuse the previous copy, so a second pass (the fast
    // path the reuse arm exists FOR, exercised by the product's own smoke) left
    // two full-length documents with the SAME name open, a third after a third
    // pass, at ~85 MB apiece for a four-minute stereo song.
    //
    // The adoption precondition is `findExistingSeparation`'s, verbatim: the
    // name this pass gives it, the song's sample rate, and the song's exact
    // length. That is the same test a stem must pass to inherit the song's beat
    // grid, and it is what makes adoption safe — a copy that no longer matches
    // is left alone and a fresh one is created beside it, exactly as before.
    //
    // CC4 fix-round 2 (N1/N2/N3): and adoption REWRITES NOTHING. A candidate is
    // adopted only when `holdsExactly` proves it already IS the sum this pass
    // computed, which makes reuse a no-op that cannot destroy anything — see
    // that function for why a content test rather than a provenance one is the
    // only thing that survives a project save and reopen. Anything else — the
    // user's edit, a stale sum, another song's — is left exactly where it is and
    // this pass creates its own document beside it.
    //
    // One consequence of adopting rather than copying, stated because round 1
    // did not have it (round-2 re-review, Note 3): the document stage 5 hangs
    // the `Instrumental` clip on is the USER'S, live, with its undo stack
    // intact. A copy they edited and then UNDID holds this sum again and is
    // adopted — and their redo is still there, so one Ctrl+Y after the pass
    // changes the audio under the built session's instrumental clip. That is
    // the app's model everywhere (a clip references a live document, and any
    // later edit to an adopted copy does the same), and it is the price of not
    // spending an ~85 MB document on a case that is provably a no-op — but it
    // is a consequence worth being able to read here rather than discover.
    //
    // EVERY name-matching candidate is tested, not just the first (N2): a user
    // who edits the pass-1 copy once would otherwise have the pass re-find that
    // same document forever and stack a fresh full-length one on every later
    // pass. Testing all of them means pass 3 adopts the pristine copy pass 2
    // created, so the cost of an edited copy is one document, once.
    const instrumentalName = `${song.name} ${INSTRUMENTAL_SUFFIX}`;
    const instrumentalChannels = sumInstrumental(stems);
    const candidates = useAppStore
      .getState()
      .documents.filter(
        (d) =>
          d.id !== song.id &&
          d.name === instrumentalName &&
          d.sampleRate === song.sampleRate &&
          docLength(d) === docLength(song)
      );
    const previous = candidates.find((d) => holdsExactly(d, instrumentalChannels)) ?? null;
    // A candidate of the right shape this pass did not adopt.
    //
    // H1 (round-2 re-review, Nit 2): asked of the candidates OTHER than the
    // adopted one, not of `previous === null`. The pass that both adopts a
    // pristine copy and leaves the user's edited one open is the one where the
    // Files panel really does hold two same-named full-length documents, and it
    // was the one pass that said nothing about the second.
    //
    // H1 fix-round 1 (I1): and what it says about them is asked of their
    // SAMPLES, not inferred from the fact that they were not adopted. `previous`
    // is `find`'s answer — the FIRST content match — so a second copy can hold
    // the sum too and simply not be the one picked (the user edits pass 1's
    // copy, pass 2 creates a pristine one beside it, the user presses Ctrl+Z:
    // now both hold it). Calling that one "your own edits to it" is a statement
    // about their document that is not true. The test runs only over the copies
    // left beside, which is empty on the ordinary reuse pass, so it costs a scan
    // only when there is something to describe.
    const otherCopies = candidates.filter((d) => d !== previous);
    const editedCopies = otherCopies.some((d) => !holdsExactly(d, instrumentalChannels));
    const foreignCopies = otherCopies.length > 0;
    const instrumental: AudioDocument =
      previous ??
      createDocument({
        name: instrumentalName,
        sampleRate: song.sampleRate,
        channels: instrumentalChannels,
      });
    if (!previous) useAppStore.getState().addDocument(instrumental);
    // Same identity-copy precondition `createStemDocuments` records for the stems: the
    // instrumental is a time-aligned combination of the song at the same rate
    // and length, so the song's beat grid IS its grid. `linkDerivedDocument`
    // re-verifies that and simply declines if it ever stops holding.
    linkDerivedDocument(instrumental.id, song.id);

    separation = {
      reused,
      vocalsDocId: vocals.id,
      instrumentalDocId: instrumental.id,
      summedFrom: nonVocalNames,
      sampleRate: song.sampleRate,
      lengthSamples: docLength(song),
    };

    record({
      id: stage.id,
      label: stage.label,
      status: reused ? 'reused' : 'done',
      derived: [
        {
          label: reused ? 'Reused' : 'Separated',
          value: reused
            ? `the ${STEM_LABELS.length + 1} stem documents already open for ${song.name}`
            : `${song.name} into ${STEM_LABELS.length + 1} documents`,
          from: reused
            ? 'a document named for every stem of this song, each at its sample rate and its exact length — the same precondition a stem must meet to inherit the song\'s beat grid. An edit to the song that left its length unchanged is the one thing this cannot see; separate again if you have edited it'
            : `a model pass over the whole song, ${STEM_LABELS.join(', ')} and a residual`,
        },
        {
          label: 'Instrumental',
          value: instrumental.name,
          // CC4 (CJ-4): which of the three happened, said rather than left to be
          // counted in the files panel.
          from:
            `${nonVocalNames.join(' + ')} summed — separation's guarantee is that its stems sum back to the mix exactly, so this is the original with its vocal removed to the last bit` +
            (previous
              ? '. A document of this name from an earlier pass was already open and already holds exactly this sum, sample for sample, so it was reused as it stands — nothing was written to it'
              : '') +
            (foreignCopies
              ? previous
                ? editedCopies
                  ? '. Another document of this name is open too, whose samples are NOT this sum — your own edits to it, or an earlier separation — and it was left exactly as it is'
                  : '. Another document of this name is open too, holding this same sum — only one of them can be the one reused, and the other was left exactly as it is'
                : '. A document of this name is also open whose samples are NOT this sum — your own edits to it, or an earlier separation — so it was left exactly as it is and this is a new one beside it'
              : ''),
        },
      ],
      warning: COVER_CHAIN_RESIDUAL_SENTENCE,
      undoEntries: [],
      elapsedMs: Date.now() - at,
    });
    advance(stage);
  }

  // ── 2. Clean ──────────────────────────────────────────────────────────────
  {
    const stage = journeyStageById('clean');
    if (begin(stage) === CANCELLED) return finish(false);
    const at = Date.now();

    // `runVocalChain` runs on the ACTIVE document over the ACTIVE selection.
    // Both are set here rather than assumed: the stem landing activates a stem, and a
    // selection left over from before the dialog opened would silently make the
    // chain a partial-region pass.
    const app = useAppStore.getState();
    app.setActiveDocument(take.id);
    app.setSelection(null);

    // CC2 (ALIGN-5): the channels stage 3 will align on, snapshotted BEFORE the
    // chain touches them. The aligner correlates ONSET envelopes — pure spectral
    // flux — so every amplitude discontinuity the chain introduces IS an onset
    // to it, and every one it removes is an onset taken away. A gate that cuts
    // between phrases writes an attack at each open and close and deletes real
    // breath and consonant onsets; the pitch corrector moves them. Measuring the
    // take the singer actually recorded is the only version of this measurement
    // that is about the singer.
    //
    // This holds a reference to the pre-chain Float32Arrays rather than a copy.
    // That is sound for the same reason undo is: `applyEdit` keeps the pre-edit
    // document and restores it wholesale (editOps.ts:166-235), so an effect that
    // mutated channels in place would already have broken undo. The cost is one
    // take's worth of memory held until stage 3, and nothing else.
    preCleanTakeChannels = app.documents.find((d) => d.id === take.id)?.channels ?? null;

    const report = await runVocalChain({
      enabled: defaultStageSelection(),
      onStageProgress: (p) => emit(stage, `Vocal Chain — ${p.label}`, p.stageFraction, p),
      onProgress: (f) => emit(stage, 'Vocal Chain', f),
    });

    if (!report) {
      record({
        id: stage.id,
        label: stage.label,
        status: 'failed',
        reason:
          'the Vocal Chain did not run — the take was left exactly as it was, and nothing downstream would have a clean take to match',
        derived: [],
        undoEntries: [],
        elapsedMs: Date.now() - at,
      });
      fillPending(stage.id);
      return finish(false);
    }
    if (report.applied) undoEntries.push(VOCAL_CHAIN_UNDO_LABEL);

    record({
      id: stage.id,
      label: stage.label,
      status: report.applied ? 'done' : 'declined',
      reason: report.applied
        ? undefined
        : 'every stage of the Vocal Chain was off or declined, so the take was not changed — each stage says why in its own row below',
      derived: [],
      undoEntries: report.applied ? [VOCAL_CHAIN_UNDO_LABEL] : [],
      vocalChain: report,
      elapsedMs: Date.now() - at,
    });
    advance(stage);
  }

  // ── 3. Align ──────────────────────────────────────────────────────────────
  let takeStartSeconds = 0;
  // CC3: why the take went to zero, when it went there as a FALLBACK rather
  // than as a measurement. `null` means the zero (if it is zero) really was
  // measured, so the Place row below may cite it as one.
  let placedAtZeroBecause: string | null = null;
  {
    const stage = journeyStageById('align');
    if (begin(stage) === CANCELLED) return finish(false);
    const at = Date.now();
    emit(stage, 'cross-correlating the two onset envelopes', 0);

    const state = useAppStore.getState();
    const vocals = state.documents.find((d) => d.id === separation!.vocalsDocId) ?? null;
    const cleaned = state.documents.find((d) => d.id === take.id) ?? null;

    // CC2 (ALIGN-5): the PRE-clean channels when stage 2 captured them, falling
    // back to the document's current ones when it did not (the take was closed
    // and reopened, or a future caller reaches this stage another way). The
    // document is still the right source for the RATE and for existence — only
    // the samples come from before the chain.
    const takeChannels = preCleanTakeChannels ?? cleaned?.channels ?? null;

    alignment =
      vocals && cleaned && takeChannels
        ? alignTakeToReference(
            vocals.channels,
            vocals.sampleRate,
            takeChannels,
            cleaned.sampleRate
          )
        : null;

    if (!vocals || !cleaned) {
      // CC4 (CJ-5): a documents-lookup failure, not a measurement. This branch
      // used to share the no-attack wording below and so asserted a measurement
      // that never ran — over a window (the Vocal Chain's) that is minutes long
      // and during which the files panel stays live, so closing one is
      // reachable. Stage 5 already words this case accurately; the two now
      // agree rather than describing the same event two different ways.
      record({
        id: stage.id,
        label: stage.label,
        status: 'declined',
        reason: `the ${vocals ? 'take' : 'separated original vocal'} was closed while the pass was running, so there was nothing left to align against — nothing was measured, and the take is placed at the start of the original`,
        derived: [],
        undoEntries: [],
        elapsedMs: Date.now() - at,
      });
    } else if (!alignment) {
      // A refusal to MEASURE, which is not the same as a refusal to BELIEVE.
      // CC3: and the Place row has to say which of the two it was.
      placedAtZeroBecause =
        'the fallback this pass uses when it cannot guess: the alignment above could not be measured at all, so the take starts where the original does';
      record({
        id: stage.id,
        label: stage.label,
        status: 'declined',
        reason:
          'there was nothing to align on — one of the two recordings has no attack anywhere in it, or the two are too short to overlap by the minimum the measurement needs. The take is placed at the start of the original',
        derived: [],
        undoEntries: [],
        elapsedMs: Date.now() - at,
      });
    } else if (!alignment.confident && !autoPlaces(guessKind(alignment))) {
      // V3: the place-at-zero arm, narrowed to the outcomes with no usable guess.
      alignmentRefused = true;
      takeStartSeconds = 0;
      // CC3: the guess survives the refusal as an OFFER. Three things changed
      // here and each answers a reported defect:
      //  - the remedy is sign-aware. A clip start clamps to >= 0, so a
      //    NEGATIVE guess (the reported case: −8.258 s) can only be realised
      //    by dragging the INSTRUMENTAL later. The old sentence named the
      //    take for both signs, i.e. named the one clip that cannot help.
      //  - 'or run Align Vocal Timing' is gone. It warps document audio to a
      //    beat grid the fresh take does not have and cannot move a clip at
      //    all; it survives in the BELIEVED arm's drift warning below, which
      //    is the question it actually answers.
      //  - the measurement's own outcome word rides along when it carries
      //    one, and NOTHING is asserted about the kind of failure when it
      //    does not.
      //
      // V3 narrowed this arm to what it should always have been: the outcomes
      // with NO usable guess. 'unrelated' means no arm distinguished the take
      // from the measured unrelated band, and a measurement with no outcome
      // word asserted nothing about itself — placing either would be the pass
      // guessing exactly where it has just said it cannot. The two that DO
      // carry a guess are placed by the arm below.
      placedAtZeroBecause = `the fallback this pass uses when it will not guess: the alignment above was refused, so the take starts where the original does. Nothing measured +0.000 s — the guess was ${secondsStr(alignment.offsetSeconds)}, and it is offered rather than applied`;
      record({
        id: stage.id,
        label: stage.label,
        status: 'declined',
        reason: refusalReason(alignment),
        derived: [],
        undoEntries: [],
        elapsedMs: Date.now() - at,
      });
    } else {
      // V3: ONE placed arm, for the believed alignment and for the two OFFER
      // outcomes alike. They differ in what is SAID about the placement, never
      // in the placement itself: `takeStartSeconds` is the measured lag either
      // way, and stage 5 turns it into two clip starts through the one shared
      // `placementFor`. An arm that placed its own way is how a row comes to
      // promise one number while another sits on the timeline.
      const believed = alignment.confident;
      alignmentAutoPlaced = !believed;
      takeStartSeconds = alignment.offsetSeconds;
      record({
        id: stage.id,
        label: stage.label,
        status: 'done',
        derived: [
          {
            label: 'Offset',
            value: secondsStr(alignment.offsetSeconds),
            from: `the lag at which your take's onset envelope best matches the separated original vocal's, measured over ${alignment.overlapSeconds.toFixed(1)} s of overlap`,
          },
          {
            label: 'Confidence',
            value: `correlation ${alignment.peakCorrelation.toFixed(3)}, standing ${alignment.prominence.toFixed(3)} above the next best lag`,
            from: believed
              ? `two floors, both measured rather than chosen: ${ALIGN_MIN_CORRELATION} and ${ALIGN_MIN_PROMINENCE}. Your take cleared both, so the offset above was applied without asking`
              // V3: deliberately NAMES NO FLOOR. Which piece of evidence fell
              // short differs by outcome — 'ambiguous' clears the correlation
              // floor and fails the prominence one, and a 'weak' run can clear
              // both and still be weak because the piecewise windows disagreed
              // or the take drifts. The warning below carries the measurement's
              // own word for it; this row must not guess.
              : `two floors, both measured rather than chosen: ${ALIGN_MIN_CORRELATION} and ${ALIGN_MIN_PROMINENCE}. The evidence did not add up to a believed alignment — the warning below says what it did add up to — but the offset above is still the best evidence there is, so it was applied rather than thrown away, and the alternatives are one click below`,
          },
        ],
        warning: believed
          ? 'This is a PLACEMENT, not a warp: the whole take is moved by one offset, and a take that drifts against the original still drifts. Align Vocal Timing (which needs you to confirm a beat grid) and Align Lyrics (which needs you to pick the word) remain manual, and are the tools for that.'
          : autoPlacedReason(alignment),
        undoEntries: [],
        elapsedMs: Date.now() - at,
      });
    }
    advance(stage);
  }

  // ── 4. Match ──────────────────────────────────────────────────────────────
  {
    const stage = journeyStageById('match');
    if (begin(stage) === CANCELLED) return finish(false);
    const at = Date.now();

    const app = useAppStore.getState();
    app.setActiveDocument(take.id);
    app.setSelection(null);

    const report = await runCoverChain({
      enabled: defaultCoverStageSelection(),
      referenceDocId: separation!.vocalsDocId,
      // CC4 (CJ-3): the song the reference was separated FROM. Nothing else in
      // the app can supply this — the standalone chain's reference is whatever
      // document the user picked — and without it the match stages have no way
      // to tell a separated vocal from the leakage a failed separation returns.
      // The measured pathology is 41 dB down, and it is reachable with this
      // repo's own model on its own fixtures.
      mixDocId: song.id,
      onStageProgress: (p) => emit(stage, `Cover Chain — ${p.label}`, p.stageFraction, p),
      onProgress: (f) => emit(stage, 'Cover Chain', f),
    });

    if (!report) {
      record({
        id: stage.id,
        label: stage.label,
        status: 'failed',
        reason:
          'the matching stages did not run — the take was left exactly as the Vocal Chain finished it, and nothing was placed',
        derived: [],
        undoEntries: [],
        elapsedMs: Date.now() - at,
      });
      fillPending(stage.id);
      return finish(false);
    }
    if (report.applied) undoEntries.push(COVER_CHAIN_UNDO_LABEL);

    record({
      id: stage.id,
      label: stage.label,
      status: report.applied ? 'done' : 'declined',
      reason: report.applied
        ? undefined
        : 'every matching stage was off or declined, so the take was not changed — each stage says why in its own row below',
      // CC4 (CJ-3): the floor's verdict, on the row the user is looking at. The
      // full sentence is in the declined stages' own rows underneath; without
      // this the headline could still read "done" (the limiter always applies)
      // while the two stages the pass exists for had refused.
      warning:
        report.referenceImplausibleBelowDb === null
          ? undefined
          : `the matching stages DECLINED: the separated vocal sounds ${report.referenceImplausibleBelowDb.toFixed(2)} dB below the song it came out of, so it is leakage rather than the singer, and matching your take to it would have shaped and levelled it against the wrong signal. Your take was not matched — read the rows below, check the “— Vocals” document, and separate the song again if it is not the original singer.`,
      derived: [],
      undoEntries: report.applied ? [COVER_CHAIN_UNDO_LABEL] : [],
      coverChain: report,
      elapsedMs: Date.now() - at,
    });
    advance(stage);
  }

  // ── 5. Place ──────────────────────────────────────────────────────────────
  let takeClipId = '';
  {
    const stage = journeyStageById('place');
    if (begin(stage) === CANCELLED) return finish(false);
    const at = Date.now();
    emit(stage, 'laying the instrumental and the take onto one timeline', 0);

    const state = useAppStore.getState();
    const instrumental = state.documents.find((d) => d.id === separation!.instrumentalDocId);
    const matched = state.documents.find((d) => d.id === take.id);
    if (!instrumental || !matched) {
      record({
        id: stage.id,
        label: stage.label,
        status: 'failed',
        reason:
          'the instrumental or the take was closed while the pass was running, so there was nothing left to place',
        derived: [],
        undoEntries: [],
        elapsedMs: Date.now() - at,
      });
      fillPending(stage.id);
      return finish(false);
    }

    const sessionRate = instrumental.sampleRate;
    // CC3: the shift arithmetic lives in `coverPlacement.placementFor` and is
    // SHARED with the apply-the-guess arm rather than written out twice — an
    // offered guess has to land exactly where a believed one would, and two
    // copies of the rule cannot guarantee that. The rule is unchanged: a
    // negative start is not clamped to zero (that would silently discard the
    // alignment this pass just measured), BOTH tracks move instead, and the
    // interval between them stays exactly what was measured.
    const { shiftedSamples, takeStartSample, instrumentalStartSample } = placementFor(
      takeStartSeconds,
      sessionRate
    );
    const takeLengthSample = documentClipLength(matched, sessionRate);

    const instrumentalTrack: Track = createTrack('Instrumental');
    instrumentalTrack.clips = [
      createClip({
        documentId: instrumental.id,
        startSample: instrumentalStartSample,
        offsetSample: 0,
        lengthSample: documentClipLength(instrumental, sessionRate),
      }),
    ];
    // CC4 (CJ-2): a MONO take is placed with the compensation that makes it
    // render at the level Match Loudness just calibrated for it.
    //
    // `mixdownSession` (and the realtime player, which shares its math) picks
    // its pan law from the CLIP SOURCE's channel count: a mono clip takes the
    // constant-power law, 0.7071 per side at centre, while the instrumental —
    // always stereo, because `landStems` dual-mono-routes a mono source and
    // `sumInstrumental` takes the max channel count — takes the unity balance
    // law. Match Loudness works in DOCUMENT space, so without this a mono take
    // (the normal case for a mic recording) sounded 3.01 dB under the level the
    // stage above measured for it, with every report self-consistent.
    //
    // `MONO_PAN_COMPENSATION_DB` is stemLanding's own constant — the same hazard,
    // the same number, defined once. stemLanding REJECTS this route for stems and
    // lays them down as dual-mono documents instead, and its measurement table
    // says why: the fader leaves a 5.96e-8 (−144.5 dBFS) residue that flips one
    // float32 ULP on 2.5 % of samples, and ruling 1 demands the stems reconstruct
    // the source "not to a tolerance". NOTHING is reconstructed here — the take
    // has already been through amplify, EQ and a limiter — so the requirement is
    // only that the rendered level match the calibrated one, which this meets to
    // ~8 orders below float32 granularity. The exact route stemLanding took is
    // not available to this stage anyway: it would mean placing a dual-mono COPY
    // of the take, doubling a four-minute take's memory and severing the clip
    // from the document the user goes on editing.
    const takeGainDb = matched.channels.length === 1 ? MONO_PAN_COMPENSATION_DB : 0;
    const takeTrack: Track = createTrack('Cover Vocal');
    const takeClip = createClip({
      documentId: matched.id,
      startSample: takeStartSample,
      offsetSample: 0,
      lengthSample: takeLengthSample,
      gainDb: takeGainDb,
    });
    takeClipId = takeClip.id;
    takeTrack.clips = [takeClip];

    const session: Session = {
      name: coverSessionName(song.name),
      sampleRate: sessionRate,
      tracks: [instrumentalTrack, takeTrack],
    };

    // The load-shaped replacement `openSessionViaDialog` and `landStems` both
    // use: every transient belonged to the session that just went away, and the
    // previous session's undo entries are whole-state snapshots, so undoing one
    // would silently revert this landing.
    useSessionStore.setState({
      session,
      selectedClipId: null,
      mtCursorSample: 0,
      // MT1 (C1): fitted, not the hardcoded 512 — the same ruling as
      // `sessionFile`, `stemLanding` and the `openSessionFrom` test hook. This
      // is the FIFTH load-shaped apply and it was written in parallel with that
      // fix, so it inherited the constant those four had just lost. It matters
      // most here: a cover session is a whole song plus a take, and 512
      // samples/px is ~16 s of timeline whatever is on it.
      mtZoom: defaultSessionZoom(session),
      mtPlayState: 'stopped',
      mtPlayheadSample: 0,
      // Lot A (M4): a cover session is a new, unsaved project.
      projectPath: null,
    });
    // MT1 (I7) deleted `clipWaveformCache` and its eight call sites: clips now
    // draw straight to the on-screen canvas, so nothing produces an entry and
    // there is no per-clip bitmap left to strand here. This was the ninth call
    // site, written in parallel with that deletion.
    clearSessionHistory();
    useAppStore.getState().setView('multitrack');

    placement = {
      sessionName: session.name,
      sessionRate,
      instrumentalStartSample,
      takeStartSample,
      shiftedSamples,
      takeLengthSample,
      takeGainDb,
    };

    record({
      id: stage.id,
      label: stage.label,
      status: 'done',
      derived: [
        {
          label: 'Take at',
          value: `${(takeStartSample / sessionRate).toFixed(3)} s`,
          from:
            shiftedSamples > 0
              ? `the measured offset ${secondsStr(takeStartSeconds)}, with BOTH tracks pushed ${(shiftedSamples / sessionRate).toFixed(3)} s later so neither starts before zero — the interval between them is exactly what was measured`
              : // CC3: the zero fallback is not a measurement. This branch used
                // to render "from the measured offset +0.000 s" whenever the
                // align stage above had refused or had nothing to measure —
                // asserting a measurement that never happened, and directly
                // contradicting the row above it. The believed arm keeps citing
                // its real offset, zero included.
                placedAtZeroBecause !== null
                ? placedAtZeroBecause
                : `the measured offset ${secondsStr(takeStartSeconds)} at the session's ${sessionRate} Hz`,
        },
        {
          label: 'Session',
          value: `${session.name} — 2 tracks`,
          from: 'the instrumental on one track and your matched take on the other, ready to play and to Mix Down',
        },
        // CC4 (CJ-2): stated rather than applied quietly. A clip gain the user
        // did not set is exactly the kind of thing they are entitled to find in
        // the report when they notice it in the properties panel.
        ...(takeGainDb > 0
          ? [
              {
                label: 'Take routing',
                value: `${dbStr(takeGainDb)} on the take clip`,
                from: 'your take is MONO, and a mono clip feeds both master sides through the constant-power pan law at 0.707 each — 3.01 dB under the stereo instrumental, which takes the unity balance law. Match Loudness calibrated the take as a file, so without this the placed take would play 3.01 dB below the level it was just matched to. It is the exact inverse of that law, and it is the only thing on this clip that is not a default',
              },
            ]
          : []),
      ],
      undoEntries: [],
      elapsedMs: Date.now() - at,
    });
    advance(stage);
  }

  // ── 6. Smooth ─────────────────────────────────────────────────────────────
  {
    const stage = journeyStageById('smooth');
    if (begin(stage) === CANCELLED) return finish(false);
    const at = Date.now();
    emit(stage, 'fading the take\'s edges and summing the session once to measure it', 0);

    const sessionRate = placement!.sessionRate;
    const nominal = Math.round((JOURNEY_FADE_MS / 1000) * sessionRate);
    const { fadeIn, fadeOut } = clampFadePair(
      nominal,
      nominal,
      placement!.takeLengthSample,
      'in'
    );

    useSessionStore.setState((prev) => ({
      session: {
        ...prev.session,
        tracks: prev.session.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === takeClipId
              ? {
                  ...c,
                  // 0 is stored as absent, never as 0: the Clip contract is that
                  // an absent key and an explicit 0 must be indistinguishable.
                  fadeInSample: fadeIn > 0 ? fadeIn : undefined,
                  fadeOutSample: fadeOut > 0 ? fadeOut : undefined,
                  fadeInCurve: fadeIn > 0 ? DEFAULT_FADE_CURVE : undefined,
                  fadeOutCurve: fadeOut > 0 ? DEFAULT_FADE_CURVE : undefined,
                }
              : c
          ),
        })),
      },
    }));

    // ONE summation of the finished session, for its pre-clamp peak. The clamped
    // output cannot answer the question — its peak is 1.0 by construction — so
    // the mixdown reports what the bus reached before the clamp.
    //
    // CC4 (CJ-6): the PEAK-ONLY mode, which sums block by block and keeps only
    // the running maximum. This stage reads one number and discarded the render,
    // and `mixdownSession` allocated two session-length Float32Arrays to produce
    // it — ~346 MB for the 15-minute session the separation cap admits,
    // synchronously on the renderer thread, at the moment the app is already
    // holding the song, five stems, the instrumental and the take. An OOM here
    // lands in this module's catch as a failed final stage after everything else
    // succeeded. The number is identical (mixdown's suite asserts that with
    // `toBe` over every fixture shape), so nothing about the report changes.
    const docs = new Map(useAppStore.getState().documents.map((d) => [d.id, d] as const));
    // V4: HALF the stage's range, because there may be a second summation
    // below and the stage's fraction feeds the journey's single overall bar —
    // two 0→1 sweeps inside one stage would walk that bar backwards in front
    // of the user. When the sum fits, the other half is not spent and the
    // fraction is completed immediately after, so the common path still fills.
    const peakBeforeClamp = mixdownSessionPeak(useSessionStore.getState().session, docs, (f) =>
      emit(stage, 'summing the session to measure what it peaks at', f * 0.5)
    );
    const summedPeakDb = toDb(peakBeforeClamp);
    const overCeiling = peakBeforeClamp > 1;

    // V4: the pass built this overshoot, so the pass takes it back out.
    //
    // Until now the stage measured the sum, named the number, told the user to
    // move a fader by it and stopped — which made the journey's own arithmetic
    // the user's problem, on a session the journey had just built out of two
    // levels IT chose (Match Loudness's, and the mono routing compensation).
    // The fix is the one the sentence already named: move the faders.
    //
    // BOTH faders, by the SAME amount. Match Loudness spent a whole stage
    // deciding where the take sits against the original vocal; trimming one
    // side would spend that decision on a level problem it did not cause. An
    // equal trim is a change of overall level and nothing else — every
    // relative level in the session, faders and clip gains alike, survives it,
    // and because the mixdown is linear the summed peak moves by exactly the
    // trim.
    //
    // Clamped to the fader's own floor via `clampAutomationValue`, the range
    // the automation lanes, the parse boundary and the mixer strip already
    // share — a trim written past the floor would be a number the mixer cannot
    // show and the automation layer would refuse. Nothing musical reaches it
    // (it would need a sum ~60 dB over full scale); when something does, the
    // measurement below reports what the floor actually achieved and the
    // warning goes back to naming what is left for the user to do.
    let trimDb = 0;
    let trimmedPeakDb: number | null = null;
    if (overCeiling) {
      // T3 (V4 MIN-5): the assumption under the single shared clamp below,
      // checked against the session as it stands rather than trusted from two
      // stages ago. See `trimBlockedBy` for what each arm would cost.
      const blocked = trimBlockedBy(useSessionStore.getState().session.tracks);
      if (blocked) throw new Error(`the level trim cannot be applied: ${blocked}`);
      const wanted = summedPeakDb - JOURNEY_PEAK_TARGET_DB;
      const faderDb = clampAutomationValue('volumeDb', -wanted);
      trimDb = -faderDb;
      const { setTrackParam } = useSessionStore.getState();
      // ONE session-history entry for what is ONE act. The two writes are
      // recorded store mutations, so bracketing them is also what keeps this
      // stage inside the recording invariant: stage 5 cleared the session
      // stack, and this is the first thing to push onto it.
      withSessionGesture(JOURNEY_TRIM_UNDO_LABEL, () => {
        for (const t of useSessionStore.getState().session.tracks) {
          setTrackParam(t.id, { volumeDb: t.volumeDb + faderDb });
        }
      });
      // A SECOND summation, and only on this arm. The trimmed peak is
      // arithmetically `summedPeakDb - trimDb` and stating it that way would be
      // a promise about the mixdown rather than a reading of it — and on the
      // clamped arm it would be a false one. The peak-only mode makes the
      // second pass cost one block-sized buffer and one more walk of the same
      // two clips, which is what a measured number is worth here.
      trimmedPeakDb = toDb(
        mixdownSessionPeak(useSessionStore.getState().session, docs, (f) =>
          emit(stage, 'summing the trimmed session to check what it peaks at', 0.5 + f * 0.5)
        )
      );
    } else {
      emit(stage, 'summing the session to measure what it peaks at', 1);
    }
    const stillOver = trimmedPeakDb !== null && trimmedPeakDb > 0;

    smoothing = {
      fadeInSample: fadeIn,
      fadeOutSample: fadeOut,
      curve: DEFAULT_FADE_CURVE,
      summedPeakDb,
      overCeiling,
      trimDb,
      trimmedPeakDb,
    };

    record({
      id: stage.id,
      label: stage.label,
      status: 'done',
      derived: [
        {
          label: 'Edge fades',
          value: `${(fadeIn / sessionRate) * 1000 < 1 ? 0 : Math.round((fadeIn / sessionRate) * 1000)} ms in, ${Math.round((fadeOut / sessionRate) * 1000)} ms out, ${DEFAULT_FADE_CURVE}`,
          from: `${JOURNEY_FADE_MS} ms at the session's ${sessionRate} Hz — the Remix pass's own default crossfade, this app's existing answer to how long a fade has to be to remove an edge without being heard${fadeIn + fadeOut < nominal * 2 ? ', shortened here because the take is not long enough to carry two full ones' : ''}`,
        },
        {
          label: 'Summed peak',
          value: dbfsStr(summedPeakDb),
          from: 'one mixdown of the finished session, measured BEFORE the master bus\'s ±1 clamp — the clamped output peaks at 0 dBFS by construction and could not tell you this',
        },
        // V4: stated, with the number, beside the peak that caused it — the
        // same rule the mono routing compensation follows one stage up. A level
        // the user did not set is exactly the kind of thing they are entitled
        // to find in the report when they notice it on the faders.
        ...(trimDb > 0
          ? [
              {
                label: 'Level trim',
                value: `${dbStr(-trimDb)} on both tracks`,
                from:
                  `the sum reached ${dbfsStr(summedPeakDb)} and this session's target is ${dbfsStr(JOURNEY_PEAK_TARGET_DB)}, so both faders came down by the same ${trimDb.toFixed(2)} dB — equally, because the balance Match Loudness set is between the two tracks and an equal trim does not touch it. Summing the trimmed session measures ${dbfsStr(trimmedPeakDb!)}. It is one undo entry, “${JOURNEY_TRIM_UNDO_LABEL}”, on the session's own history` +
                  (stillOver
                    ? `, and it is the deepest the faders go: ${dbfsStr(trimmedPeakDb!)} is still above full scale`
                    : ''),
              },
            ]
          : []),
      ],
      // V4: the copy still opens on the measured overshoot, because that is
      // still what happened and the number is still the user's to know. What
      // changed is the second half: the pass no longer names a fader move and
      // leaves it undone. The old sentence survives verbatim on the clamped
      // arm, where naming it IS all that is left.
      warning: overCeiling
        ? stillOver
          ? `the two tracks sum to ${dbfsStr(summedPeakDb)}, above full scale, and both the WAV writer and the MP3 encoder hard-clip that. Both faders were taken to ${dbStr(-trimDb)}, as far down as a track fader goes, and the session STILL peaks at ${dbfsStr(trimmedPeakDb!)}: bring the levels down inside the clips or the documents themselves before you Mix Down, or accept the clipping.`
          : `the two tracks summed to ${dbfsStr(summedPeakDb)}, above full scale, and both the WAV writer and the MP3 encoder hard-clip that — so both faders were brought down ${trimDb.toFixed(2)} dB, equally, and the session now peaks at ${dbfsStr(trimmedPeakDb!)}. Nothing was normalised, limited or mastered: this is a level trim on two faders, and undoing “${JOURNEY_TRIM_UNDO_LABEL}” puts the clipping level back. Raising either fader again can put the sum back over full scale, and nothing checks it a second time.`
        : undefined,
      undoEntries: [],
      elapsedMs: Date.now() - at,
    });
    advance(stage);
  }

  } catch (err) {
    const stage = running.stage;
    const message = err instanceof Error ? err.message : String(err);
    if (stage) {
      // The stage was admitted by `begin` but never recorded a result, so this
      // is its one and only row — no stale remnant, and no second row for a
      // stage that already reported.
      if (!results.some((r) => r.id === stage.id)) {
        record({
          id: stage.id,
          label: stage.label,
          status: 'failed',
          reason: `this stage threw and the pass stopped: ${message}`,
          derived: [],
          undoEntries: [],
        });
      }
      fillPending(stage.id);
    }
    return finish(false);
  }

  onProgress?.(1);
  return finish(true);
}
