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
 *   1. Separate      → `stemService.separateStems` + `stemLanding.landStems`
 *   2. Clean         → `vocalChain.runVocalChain`
 *   3. Align         → `dsp/coverAlign.alignTakeToReference`
 *   4. Match         → `coverChain.runCoverChain`, the four stages unchanged
 *   5. Place         → `multitrack/session` + the load-shaped session apply
 *   6. Smooth        → the v1.9 clip fades + `mixdown.mixdownSession`'s peak
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
 * ── Undo ────────────────────────────────────────────────────────────────────
 * Each sub-pass keeps its OWN undo entry, the chains' own precedent: "Vocal
 * Chain" and "Cover Chain" are two entries on the take, the stem documents are
 * creations rather than edits (nothing to undo), and the session replacement is
 * load-shaped and clears session history exactly as Open Session and stem
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
import { mixdownSession } from '../multitrack/mixdown';
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
import { clearSessionHistory } from '../multitrack/sessionUndo';
import { useAppStore } from '../stores/appStore';
import { linkDerivedDocument } from './beatGrid';
import {
  COVER_CHAIN_RESIDUAL_SENTENCE,
  COVER_CHAIN_UNDO_LABEL,
  defaultCoverStageSelection,
  runCoverChain,
  type CoverChainReport,
} from './coverChain';
import { cancelStemSeparation, separateStems, STEM_LABELS } from './stemService';
import { landStems, STEM_TRACK_LABELS } from './stemLanding';
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
    note: "Finds where your take belongs on the original's timeline by cross-correlating the two onset envelopes, and reports the offset with the confidence that produced it. This is a PLACEMENT, not a warp — nothing is stretched and no syllable is moved. If the confidence is below the measured threshold the take is placed at zero and the numbers are stated instead of guessed. Align Vocal Timing and Align Lyrics stay manual, and are worth running afterwards if the take drifts or a word came out wrong.",
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
    note: "Puts edge fades on the placed take so neither end starts or stops mid-waveform, then mixes the session down once to measure what the two tracks actually sum to. If that sum passes full scale the number is reported — nothing is normalised, limited or mastered on your behalf.",
    weight: 1,
  },
];

export function journeyStageById(id: CoverJourneyStageId): CoverJourneyStage {
  const stage = COVER_JOURNEY_STAGES.find((s) => s.id === id);
  if (!stage) throw new Error(`Unknown cover journey stage: ${id}`);
  return stage;
}

/**
 * The edge fade the smoothing stage applies, in milliseconds.
 *
 * 25 ms is not a new number: it is the Remix pass's own default crossfade
 * (`RemixDialog`'s `crossfadeMs` initial state), which is this app's existing
 * answer to the same question — how long a fade has to be to remove a splice
 * edge without being heard as a fade. Reusing it means the two features cannot
 * drift into two different opinions about the same 25 ms.
 */
export const JOURNEY_FADE_MS = 25;

/** Suffix for the summed non-vocal document the journey creates. */
export const INSTRUMENTAL_SUFFIX = '— Instrumental';

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
}

export interface CoverJourneySmoothing {
  fadeInSample: number;
  fadeOutSample: number;
  curve: string;
  /** Peak of the summed session BEFORE the master bus's ±1 clamp, in dBFS. */
  summedPeakDb: number;
  /** True when that peak passed full scale. */
  overCeiling: boolean;
}

export interface CoverJourneyReport {
  songName: string;
  takeName: string;
  stages: CoverJourneyStageResult[];
  separation: CoverJourneySeparation | null;
  alignment: AlignmentMeasurement | null;
  /** True when alignment ran but was not believed, so the take went to zero. */
  alignmentRefused: boolean;
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
    return 'cancelled before the session was built — the documents this pass produced are open and unchanged, and there is no session';
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
      landStems(result.output);
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

    // The instrumental document. Created rather than reused even on a reused
    // separation: it is this pass's own artifact, it is cheap (a sum of four
    // arrays already in memory), and a stale one from an earlier run would be
    // the one thing here that could silently describe a different song.
    const instrumental = createDocument({
      name: `${song.name} ${INSTRUMENTAL_SUFFIX}`,
      sampleRate: song.sampleRate,
      channels: sumInstrumental(stems),
    });
    useAppStore.getState().addDocument(instrumental);
    // Same identity-copy precondition `landStems` records for the stems: the
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
          from: `${nonVocalNames.join(' + ')} summed — separation's guarantee is that its stems sum back to the mix exactly, so this is the original with its vocal removed to the last bit`,
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
    // Both are set here rather than assumed: `landStems` activates a stem, and a
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

    if (!alignment) {
      // A refusal to MEASURE, which is not the same as a refusal to BELIEVE.
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
    } else if (!alignment.confident) {
      alignmentRefused = true;
      takeStartSeconds = 0;
      record({
        id: stage.id,
        label: stage.label,
        status: 'declined',
        reason: `the best alignment found was ${secondsStr(alignment.offsetSeconds)}, and it is not believable: correlation ${alignment.peakCorrelation.toFixed(3)} against a floor of ${ALIGN_MIN_CORRELATION}, standing ${alignment.prominence.toFixed(3)} above the next best lag against a floor of ${ALIGN_MIN_PROMINENCE}. The take is placed at the start of the original instead of at a guess — drag it on the timeline, or run Align Vocal Timing, to place it yourself`,
        derived: [],
        undoEntries: [],
        elapsedMs: Date.now() - at,
      });
    } else {
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
            from: `two floors, both measured rather than chosen: ${ALIGN_MIN_CORRELATION} and ${ALIGN_MIN_PROMINENCE}. Below either one this stage places at zero and says so instead of guessing`,
          },
        ],
        warning:
          'This is a PLACEMENT, not a warp: the whole take is moved by one offset, and a take that drifts against the original still drifts. Align Vocal Timing (which needs you to confirm a beat grid) and Align Lyrics (which needs you to pick the word) remain manual, and are the tools for that.',
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
    const rawTakeStart = Math.round(takeStartSeconds * sessionRate);
    // A negative start is not clamped to zero — that would silently discard the
    // alignment this pass just measured. BOTH tracks move instead, which keeps
    // the interval between them exactly what was measured.
    const shiftedSamples = rawTakeStart < 0 ? -rawTakeStart : 0;
    const takeStartSample = rawTakeStart + shiftedSamples;
    const instrumentalStartSample = shiftedSamples;
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
    const takeTrack: Track = createTrack('Cover Vocal');
    const takeClip = createClip({
      documentId: matched.id,
      startSample: takeStartSample,
      offsetSample: 0,
      lengthSample: takeLengthSample,
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
              : `the measured offset ${secondsStr(takeStartSeconds)} at the session's ${sessionRate} Hz`,
        },
        {
          label: 'Session',
          value: `${session.name} — 2 tracks`,
          from: 'the instrumental on one track and your matched take on the other, ready to play and to Mix Down',
        },
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

    // ONE mixdown of the finished session, for its pre-clamp peak. The clamped
    // output cannot answer the question — its peak is 1.0 by construction — so
    // `mixdownSession` reports what the bus reached before the clamp.
    const docs = new Map(useAppStore.getState().documents.map((d) => [d.id, d] as const));
    const mixed = mixdownSession(useSessionStore.getState().session, docs, (f) =>
      emit(stage, 'summing the session to measure what it peaks at', f)
    );
    const summedPeakDb = toDb(mixed.peakBeforeClamp);
    const overCeiling = mixed.peakBeforeClamp > 1;

    smoothing = {
      fadeInSample: fadeIn,
      fadeOutSample: fadeOut,
      curve: DEFAULT_FADE_CURVE,
      summedPeakDb,
      overCeiling,
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
      ],
      warning: overCeiling
        ? `the two tracks sum to ${dbfsStr(summedPeakDb)}, above full scale, and both the WAV writer and the MP3 encoder hard-clip that. Nothing here normalises or limits it on your behalf: bring the Cover Vocal track's fader (or the Instrumental's) down by at least ${summedPeakDb.toFixed(2)} dB before you Mix Down, or accept the clipping.`
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
