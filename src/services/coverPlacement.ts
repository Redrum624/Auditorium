/**
 * Task CC3 — what a REFUSED alignment is allowed to do about itself.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * The Cover Chain journey measures an offset, decides it is not believable,
 * places the take at zero, and — until this module — threw the number away
 * into a sentence. A user hit that with a −8.258 s guess and was told to "drag
 * it on the timeline, or run Align Vocal Timing, to place it yourself". Both
 * halves of that advice were wrong for their case, and one of them is wrong
 * for every case:
 *
 *  - `moveClip` clamps every clip start to `Math.max(0, …)`, so a NEGATIVE
 *    offset is unreachable by dragging the take. Only the INSTRUMENTAL can
 *    move. The message named the one clip that could not help.
 *  - Align Vocal Timing is a marker-to-grid warp on the active document. It
 *    needs a confirmed beat grid the fresh take does not have, it moves audio
 *    inside a document rather than clips on a timeline, and its moves are
 *    bounded to half a grid interval — it cannot express "shift everything
 *    8.258 s relative to the other track" at all.
 *
 * So this module owns two things: the sentence that tells the truth about
 * which clip moves, and the one-click action that does the move so the user
 * does not have to eyeball it. The action is OFFERED, never applied on the
 * user's behalf: the refusal stands, because the guess really may be wrong —
 * the reported case's 0.423 correlation and 0.079 prominence sit inside the
 * measured UNRELATED-pair bands. What changes is that acting on it costs one
 * click instead of a memorised number and a drag.
 *
 * ── The arithmetic is not a second opinion ──────────────────────────────────
 * `applyMeasuredOffset` reproduces the confident arm's placement exactly: the
 * both-track shift (`shiftedSamples = rawTakeStart < 0 ? -rawTakeStart : 0`),
 * the journey's own edge fades, and a cursor parked where the take enters so
 * the user can press play and judge the guess by ear. It is one undoable
 * gesture, so a guess that turns out wrong costs one Ctrl+Z.
 */

import {
  clampFadePair,
  DEFAULT_FADE_CURVE,
  type Clip,
  type Track,
} from '../multitrack/session';
import { useSessionStore } from '../multitrack/sessionStore';
import { withSessionGesture } from '../multitrack/sessionUndo';

/**
 * The edge fade the smoothing stage applies, in milliseconds.
 *
 * 25 ms is not a new number: it is the Remix pass's own default crossfade
 * (`RemixDialog`'s `crossfadeMs` initial state), which is this app's existing
 * answer to the same question — how long a fade has to be to remove a splice
 * edge without being heard as a fade. Reusing it means the two features cannot
 * drift into two different opinions about the same 25 ms.
 *
 * CC3 moved the declaration here from `coverJourney` (which re-exports it, so
 * every existing import path still resolves) for one reason: the apply-the-
 * guess action has to lay down the SAME fades the journey's smoothing stage
 * did, and a module that imported the journey to learn its fade length would
 * close an import cycle.
 */
export const JOURNEY_FADE_MS = 25;

/** The button, named once so the copy and the control cannot disagree. */
export const APPLY_GUESS_LABEL = 'Apply the measured offset anyway';

/**
 * The candidate rows, named once for the same reason the button above is.
 *
 * The refusal's copy and the offer's controls are written in two different
 * files, and the dialog renders EITHER the single button OR one row per
 * candidate — never both. A sentence that names the wrong one of the two sends
 * the user looking for a control that is not on screen, so both names are
 * constants and both are read from here.
 */
export const CANDIDATE_PLACEMENT_LABEL = 'Place at';

/** The single session undo entry the apply gesture leaves. */
export const APPLY_GUESS_UNDO_LABEL = 'Place at the measured offset';

/**
 * How much a measurement is worth, in the vocabulary the align stage uses.
 *
 * `unclassified` is the honest answer for a measurement that carries only
 * `confident: false` — today's shape. It is NOT a synonym for 'weak': calling
 * an unclassified refusal "weak but plausible" would be a claim the
 * measurement never made. When `AlignmentMeasurement` grows an `outcome`
 * field this maps straight through it.
 */
export type GuessKind = 'confident' | 'ambiguous' | 'weak' | 'unrelated' | 'unclassified';

/** One rival lag off the correlation surface, as the outcome contract states it. */
export interface GuessCandidate {
  offsetSeconds: number;
  correlation: number;
  prominence: number;
}

const KNOWN_KINDS: readonly string[] = ['confident', 'ambiguous', 'weak', 'unrelated'];

/**
 * The measurement's outcome, feature-detected.
 *
 * Deliberately typed on the structural minimum rather than on
 * `AlignmentMeasurement`: this runs against measurements produced before the
 * outcome field existed and against ones produced after, and an unrecognised
 * value is treated as no value rather than trusted through.
 */
export function guessKind(measurement: { confident: boolean; outcome?: unknown }): GuessKind {
  const outcome = measurement.outcome;
  if (typeof outcome === 'string' && KNOWN_KINDS.includes(outcome)) return outcome as GuessKind;
  return measurement.confident ? 'confident' : 'unclassified';
}

/**
 * The rival lags a measurement listed, or an empty list.
 *
 * Every candidate must carry all three numbers finite or it is dropped: a row
 * offering to place at `NaN`, or one whose correlation renders as a hole, is
 * worse than a row that is not there.
 */
export function guessCandidates(measurement: unknown): GuessCandidate[] {
  if (typeof measurement !== 'object' || measurement === null) return [];
  const raw = (measurement as { candidates?: unknown }).candidates;
  if (!Array.isArray(raw)) return [];
  const out: GuessCandidate[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const c = entry as Partial<GuessCandidate>;
    if (
      typeof c.offsetSeconds !== 'number' ||
      !Number.isFinite(c.offsetSeconds) ||
      typeof c.correlation !== 'number' ||
      !Number.isFinite(c.correlation) ||
      typeof c.prominence !== 'number' ||
      !Number.isFinite(c.prominence)
    ) {
      continue;
    }
    out.push({
      offsetSeconds: c.offsetSeconds,
      correlation: c.correlation,
      prominence: c.prominence,
    });
  }
  return out;
}

/**
 * One sentence naming WHAT KIND of failure this was — or `null` when the
 * measurement did not say, in which case the numbers already in the refusal
 * are the whole of what is known and nothing further may be asserted.
 */
export function guessCharacterisation(kind: GuessKind): string | null {
  switch (kind) {
    case 'ambiguous':
      return 'This take matches several places in the song about equally well, so the single best lag is not the answer — pick one below';
    case 'weak':
      return 'The match is weak but plausible: below the floors, above nothing at all';
    case 'unrelated':
      return 'No believable match was found anywhere in the song, so this number is probably wrong';
    default:
      return null;
  }
}

/** `8.258 s`, the amount a user has to type or drag, without the sign. */
function amountStr(offsetSeconds: number): string {
  return `${Math.abs(offsetSeconds).toFixed(3)} s`;
}

/**
 * What to do about a guess, in the user's own terms — sign-aware, because the
 * two signs need OPPOSITE clips moved and the old copy named one clip for
 * both.
 *
 * The negative branch carries its reason ("a clip cannot start before zero")
 * because the instruction is counter-intuitive: the take is the clip the user
 * is thinking about, and it is precisely the one that cannot move.
 */
export function guessRemedy(offsetSeconds: number): string {
  const amount = amountStr(offsetSeconds);
  // Rounded to the same three decimals the amount is printed at: a guess that
  // displays as 0.000 s is a guess that asks for no move.
  if (Math.abs(offsetSeconds) < 0.0005) {
    return 'The guess is +0.000 s, which is where the take already sits, so there is nothing to move by hand.';
  }
  if (offsetSeconds < 0) {
    return (
      `To place it by hand you have to move the INSTRUMENTAL, not the take: drag the Instrumental clip about ${amount} later. ` +
      'A clip cannot start before zero, so a guess on this side of zero can only be realised by moving the instrumental — dragging the take can only make it worse. ' +
      `Or press “${APPLY_GUESS_LABEL}” to have this pass move both clips there in one step.`
    );
  }
  return (
    `To place it by hand, drag your take to about ${amount} — the take is the clip that moves for a guess on this side of zero. ` +
    `Or press “${APPLY_GUESS_LABEL}” to have this pass move both clips there in one step.`
  );
}

// ── The shift arithmetic ────────────────────────────────────────────────────

/** Where the two clips of a cover session go for one signed offset. */
export interface ClipPlacement {
  /** The take's start BEFORE the shift — negative when the take belongs before
   * the reference's own zero. Reported because it is the measured quantity;
   * the two starts below are what a timeline can actually hold. */
  rawTakeStartSample: number;
  /** Samples BOTH clips were pushed later so neither starts before zero. */
  shiftedSamples: number;
  takeStartSample: number;
  instrumentalStartSample: number;
}

/**
 * One signed offset → two clip starts. THE one implementation.
 *
 * Fix round 1 (I2): the believed arm's session build and the apply-the-guess
 * arm both need this, and each used to compute it itself with a comment
 * pointing at the other. Nothing bound the two, and the Place stage is a
 * concurrent task's surface — so a change to the rule there (rate source,
 * rounding, clamp) would have left the OFFERED guess landing somewhere a
 * BELIEVED alignment would not have put it, which is precisely the failure the
 * offer exists to prevent.
 *
 * The rule itself is unchanged: a negative start is not clamped to zero —
 * that would silently discard the alignment that was just measured — so BOTH
 * clips move instead, which keeps the interval between them exactly what was
 * measured. `sampleRate` is the SESSION's rate, never the take's.
 */
export function placementFor(offsetSeconds: number, sampleRate: number): ClipPlacement {
  const rawTakeStartSample = Math.round(offsetSeconds * sampleRate);
  const shiftedSamples = rawTakeStartSample < 0 ? -rawTakeStartSample : 0;
  return {
    rawTakeStartSample,
    shiftedSamples,
    takeStartSample: rawTakeStartSample + shiftedSamples,
    instrumentalStartSample: shiftedSamples,
  };
}

// ── Applying the guess ──────────────────────────────────────────────────────

export interface ApplyMeasuredOffsetOptions {
  /** The signed guess, in seconds, exactly as it was measured. */
  offsetSeconds: number;
  /** The document the Instrumental clip carries. */
  instrumentalDocId: string;
  /** The document the take clip carries. */
  takeDocId: string;
}

export type ApplyMeasuredOffsetResult =
  | {
      applied: true;
      sessionRate: number;
      takeStartSample: number;
      instrumentalStartSample: number;
      /** Samples BOTH clips were pushed later so neither starts before zero. */
      shiftedSamples: number;
      fadeInSample: number;
      fadeOutSample: number;
      /** Where the cursor and playhead were parked: the take's entry. */
      cursorSample: number;
    }
  | { applied: false; reason: string };

function locate(tracks: readonly Track[], documentId: string): { track: Track; clip: Clip } | null {
  for (const track of tracks) {
    const clip = track.clips.find((c) => c.documentId === documentId);
    if (clip) return { track, clip };
  }
  return null;
}

/**
 * Re-places the cover session's two clips at `offsetSeconds`, as ONE undoable
 * gesture.
 *
 * This is the confident arm's arithmetic run late: the take goes to the
 * offset, and when the offset is negative BOTH clips are pushed later by
 * exactly its magnitude so the measured interval survives without any clip
 * starting before zero. The take's edge fades are re-asserted with the
 * journey's own fade so the outcome is indistinguishable from the placement a
 * believed alignment would have produced, and the cursor is parked where the
 * take enters so the very next thing the user can do is press play and judge
 * the guess.
 *
 * Refuses (rather than half-applying) when either clip has left the session or
 * the offset is not a finite number.
 */
export function applyMeasuredOffset({
  offsetSeconds,
  instrumentalDocId,
  takeDocId,
}: ApplyMeasuredOffsetOptions): ApplyMeasuredOffsetResult {
  if (!Number.isFinite(offsetSeconds)) {
    return { applied: false, reason: 'the measured offset is not a number, so there is nothing to place at' };
  }

  const store = useSessionStore.getState();
  const session = store.session;
  const instrumental = locate(session.tracks, instrumentalDocId);
  const take = locate(session.tracks, takeDocId);
  if (!instrumental || !take) {
    const missing = !instrumental && !take ? 'the instrumental and the take are' : !instrumental ? 'the instrumental is' : 'the take is';
    return {
      applied: false,
      reason: `${missing} no longer on this session's timeline, so there is nothing left to re-place`,
    };
  }

  const sessionRate = session.sampleRate;
  // Not the confident arm's rule copied — the confident arm's rule ITSELF: the
  // journey's Place stage calls this same function.
  const { shiftedSamples, takeStartSample, instrumentalStartSample } = placementFor(
    offsetSeconds,
    sessionRate
  );

  // The journey's smoothing stage, on the clip it is being applied to. Computed
  // as ONE pair (rather than two sequential edge writes) so a take too short to
  // carry both full fades is shortened by the same rule the journey used.
  const nominal = Math.round((JOURNEY_FADE_MS / 1000) * sessionRate);
  const { fadeIn, fadeOut } = clampFadePair(nominal, nominal, take.clip.lengthSample, 'in');

  withSessionGesture(APPLY_GUESS_UNDO_LABEL, () => {
    store.moveClip(instrumental.clip.id, instrumental.track.id, instrumentalStartSample);
    store.moveClip(take.clip.id, take.track.id, takeStartSample);
    store.setClipFade(take.clip.id, 'in', { lengthSample: fadeIn, curve: DEFAULT_FADE_CURVE });
    store.setClipFade(take.clip.id, 'out', { lengthSample: fadeOut, curve: DEFAULT_FADE_CURVE });
  });

  // Outside the gesture on purpose: ruling 3 keeps the cursor, playhead and
  // zoom OUT of the session snapshot, so an undo of this placement must not
  // yank the viewport back as a side effect.
  useSessionStore.setState({ mtCursorSample: takeStartSample, mtPlayheadSample: takeStartSample });

  return {
    applied: true,
    sessionRate,
    takeStartSample,
    instrumentalStartSample,
    shiftedSamples,
    fadeInSample: fadeIn,
    fadeOutSample: fadeOut,
    cursorSample: takeStartSample,
  };
}
