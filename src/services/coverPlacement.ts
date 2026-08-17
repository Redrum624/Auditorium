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
 * does not have to eyeball it.
 *
 * ── V3: and for two outcomes, the pass does the move itself ─────────────────
 * CC3 shipped the action as an OFFER and said so here: the refusal stands, the
 * guess really may be wrong. Then a user ran it, was shown three candidates,
 * clicked the first, and found it right — and said the thing this module now
 * follows: "it should place the tracks by itself!". {@link autoPlaces} is that
 * sentence, and it is deliberately narrow. `'weak'` and `'ambiguous'` carry a
 * usable guess and are PLACED, with the alternatives still one click each.
 * `'unrelated'` and an unclassified measurement carry none and are still placed
 * at zero with the button beside them, because auto-placing a lag nothing could
 * distinguish from noise is not what was asked for.
 *
 * The click is therefore no longer only "accept the guess": on a placed arm it
 * is "that was the wrong one of the lags, use this one instead" — which is the
 * question the user can actually answer.
 *
 * ── The arithmetic is not a second opinion ──────────────────────────────────
 * `applyMeasuredOffset` does not reproduce the confident arm's placement — it
 * CALLS it. {@link placementFor} is the one implementation of the both-track
 * shift, and the journey's Place stage calls the same function, so the applied
 * guess lands exactly where a believed alignment would have put it and cannot
 * drift away from it. (H1: this paragraph used to restate the shift formula in
 * the pre-refactor identifiers — a third textual copy of a rule with one
 * implementation, and the copy nothing would have failed if the rule changed.
 * Read `placementFor`.)
 *
 * Around that call it lays the journey's own edge fades and parks a cursor
 * where the take enters, so the user can press play and judge the guess by ear.
 * It is one undoable gesture, so a guess that turns out wrong costs one Ctrl+Z.
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
 * V3. Which outcomes this pass PLACES on the user's behalf.
 *
 * The user's directive was one sentence — "it should place the tracks by
 * itself!" — and it supersedes CC3's offer-only stance for the two outcomes that
 * carry a usable guess. Their real run measured `'weak'`, listed three
 * candidates, and they clicked the first one; it was right. Making them click is
 * the app asking a question it already has the best available answer to.
 *
 * `'unrelated'` is deliberately NOT here, and that is not timidity: it is the
 * outcome defined by no arm distinguishing the take from the measured unrelated
 * band. Placing that would be guessing exactly where the measurement has just
 * said it has no guess, and "place it yourself" was not a request to place
 * noise. `'unclassified'` — a measurement carrying no outcome word at all —
 * is out for the same reason `guessCharacterisation` says nothing about it: it
 * asserted nothing about itself, so nothing may be asserted on its behalf.
 *
 * ONE predicate, exported, because the journey places from it and the dialog
 * describes the placement from it. Two copies of this rule would be two
 * opinions about whether the take on screen was moved.
 */
export function autoPlaces(kind: GuessKind): boolean {
  return kind === 'weak' || kind === 'ambiguous';
}

/**
 * T3 (MIN-1). Whether an auto-placed take has ALTERNATIVES to be offered — a
 * different question from `hasCandidates`, and the one the placed arm asks.
 *
 * `candidates[0].offsetSeconds === offsetSeconds` by the emitter's contract, so
 * the first row is the lag the take is already sitting on. "Any candidates at
 * all" therefore answers "which control is on screen"; it does NOT answer "is
 * there anywhere else to go". A one-entry list is a real emission — the coarse
 * walk stops early when the guard swallows the rest of the surface, the
 * post-refinement dedupe drops a rival that converged onto the winner, and
 * {@link guessCandidates} drops any entry whose three numbers are not all
 * finite — and over it the placed copy used to promise "these OTHER lags
 * matched too" while the dialog's paragraph, one line above, told the user to
 * drag a clip instead. Two branches, two different thresholds, one state where
 * they contradicted each other on screen.
 *
 * ONE predicate, exported, for the same reason {@link autoPlaces} is: the
 * sentence is composed in `coverJourney` and the paragraph is rendered in
 * `CoverChainDialog`, and two copies of this rule would be two opinions about
 * whether the user has a choice.
 */
export function offersOtherLags(candidates: readonly GuessCandidate[]): boolean {
  return candidates.length > 1;
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
 *
 * ── Which one-click control the sentence names ──────────────────────────────
 * `hasCandidates` is not decoration and it is not the outcome word: the dialog
 * renders one "Place at …" row per candidate INSTEAD of the single button
 * whenever the measurement lists any, so the sentence has to branch on exactly
 * the fact the render branches on. It was written when no emitter produced
 * candidates and named the button unconditionally; the shipped emitter
 * attaches candidates to every 'ambiguous' and every 'weak' measurement, which
 * made the primary refusal instruction point at a control that is not on
 * screen for two of the four outcomes.
 *
 * It is REQUIRED rather than defaulted, and that is the whole hardening. The
 * default it used to carry was `false` — "a caller who knows of no candidate
 * list" — which is precisely the assumption that produced the defect above: the
 * copy's author knew of no candidate list while the emitter was attaching one.
 * A second composition path calling `guessRemedy(offset)` would inherit that
 * assumption silently and regrow the wrong wording; requiredness makes it a
 * compile error instead. Callers with no measurement in hand pass `false`
 * deliberately, which is a statement rather than an omission.
 */
export function guessRemedy(offsetSeconds: number, hasCandidates: boolean): string {
  const amount = amountStr(offsetSeconds);
  const oneClick = hasCandidates
    ? `Or pick one of the “${CANDIDATE_PLACEMENT_LABEL} …” rows offered under the align row — each moves both clips to its own lag in one step.`
    : `Or press “${APPLY_GUESS_LABEL}” to have this pass move both clips there in one step.`;
  // Rounded to the same three decimals the amount is printed at: a guess that
  // displays as 0.000 s is a guess that asks for no move.
  if (Math.abs(offsetSeconds) < 0.0005) {
    const nothingToMove =
      'The guess is +0.000 s, which is where the take already sits, so there is nothing to move by hand.';
    // Zero is where the take already is, so the button offers nothing worth
    // naming — but candidate rows offer OTHER lags, and those are worth
    // pointing at even here.
    return hasCandidates ? `${nothingToMove} ${oneClick}` : nothingToMove;
  }
  if (offsetSeconds < 0) {
    return (
      `To place it by hand you have to move the INSTRUMENTAL, not the take: drag the Instrumental clip about ${amount} later. ` +
      'A clip cannot start before zero, so a guess on this side of zero can only be realised by moving the instrumental — dragging the take can only make it worse. ' +
      oneClick
    );
  }
  return (
    `To place it by hand, drag your take to about ${amount} — the take is the clip that moves for a guess on this side of zero. ` +
    oneClick
  );
}

/**
 * V3. What an AUTO-PLACED guess says for itself — the sibling of
 * {@link guessRemedy}, for the arm that moved the clips instead of describing
 * how to.
 *
 * Two things had to change and neither is cosmetic. The take is already at the
 * measured lag, so every "drag it to about 8.257 s" instruction in the refusal
 * above is now WRONG here — which is why this is a separate builder rather than
 * a flag threaded through that one: the two sentences share no clause that could
 * leak the by-hand half across. And the candidate rows change meaning: they stop
 * being "pick the answer" and become "if this is the wrong spot, these matched
 * too".
 *
 * What does NOT change is the one thing the seam fix pinned: which control this
 * names is decided by the candidate list, the same fact the dialog decides its
 * render from, so the sentence can never point at a control that is not on
 * screen.
 *
 * T3 (MIN-1). It takes the LIST rather than a `hasCandidates` boolean because
 * the placed arm has to answer two questions off it and they have different
 * thresholds: which control is on screen (any candidate → rows, none → the
 * button) and whether there is anywhere else to go ({@link offersOtherLags},
 * because `candidates[0]` IS where the take already is). Given the list, the
 * two answers cannot be supplied inconsistently; given two booleans, they
 * could — and a caller passing `true, true` for a one-entry list is exactly the
 * defect this replaces.
 */
export function placedRemedy(
  offsetSeconds: number,
  candidates: readonly GuessCandidate[]
): string {
  const amount = amountStr(offsetSeconds);
  // The placement itself is NOT undoable and the copy must not pretend it is:
  // it was made while the session was being built, and building a session
  // clears session history the way opening one does. A RE-place is one undo
  // entry, and that is the sentence each branch is allowed to make.
  //
  // Three states, not two. The middle one — one row, and it is the lag we are
  // on — has to name the control that IS rendered (the row) while promising
  // nothing the row cannot deliver, so it borrows the by-hand remedy from the
  // no-candidates branch and says plainly why the row is not the answer.
  const alternatives = offersOtherLags(candidates)
    ? `If that is the wrong spot, these other lags matched too — each “${CANDIDATE_PLACEMENT_LABEL} …” row under the align row re-places both clips at its own lag in one step, as a single undo entry.`
    : candidates.length === 1
      ? `If that is the wrong spot, drag a clip or type a new Start in the Properties panel — the single “${CANDIDATE_PLACEMENT_LABEL} …” row under the align row is this same lag, so it has nothing else to offer.`
      : `If that is the wrong spot, drag a clip or type a new Start in the Properties panel — “${APPLY_GUESS_LABEL}” only puts both clips back at the lag they are already on.`;
  // Rounded to the three decimals the amount prints at, exactly as the refusal
  // is: a placement that displays as 0.000 s moved nothing.
  if (Math.abs(offsetSeconds) < 0.0005) {
    return `Your take was placed at +0.000 s, which is where it already sat, so nothing moved. ${alternatives}`;
  }
  if (offsetSeconds < 0) {
    return (
      `Your take was placed at −${amount} — it belongs BEFORE the original's own start, so both clips were pushed ${amount} later rather than your take being clamped to zero, ` +
      'which keeps the interval between them exactly what was measured. ' +
      alternatives
    );
  }
  return (
    `Your take was placed at +${amount} into the original, and the instrumental stayed where it was. ` +
    alternatives
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
