import type { Session } from './session';
import { sessionLaneWidth } from './sessionViewport';

/**
 * MT1-1 — ONE clamped zoom resolution for the multitrack session, mirroring the
 * editor's F11-3/F11-9 rules in `stores/appStore.ts`.
 *
 * The reported symptom: a 2:58 session opened showing about 18 seconds of
 * itself. The cause was not a bad number but the absence of a rule — FOUR
 * places wrote `{ samplesPerPixel: 512, scrollSample: 0 }` verbatim
 * (`sessionStore.newSession`, `sessionFile`'s Open Session, `stemLanding`,
 * `testHooks.openSessionFrom`), a fifth clamped differently inline
 * (`useMultitrackZoom`), and none of them knew how wide the lane was. 512
 * samples/px on a 1376 px lane is 16 seconds of timeline no matter what is on
 * it. The editor had exactly this bug and exactly this fix; this module is that
 * fix, restated for a session.
 *
 * Deliberately store-free — `sessionStore` imports this, so this must not
 * import `sessionStore`. The store-touching writers (`applySessionZoom`,
 * `publishSessionLaneWidth`) live there, next to `setMtZoom`, exactly as the
 * editor's live next to `setZoom`.
 */

/** The furthest the multitrack zooms IN, in samples per pixel. The same number
 * the editor uses (`MIN_SPP`) and the same number the wheel handler used inline
 * before this module existed — restated here rather than imported from
 * `appStore`, because the two surfaces' limits happening to agree today is not
 * a reason to make one of them unable to move without the other. */
export const MT_MIN_SPP = 1 / 32;

/**
 * How much timeline an EMPTY session shows, in seconds. Task 22's convention,
 * kept deliberately.
 *
 * Without it the fit would be `0 / laneWidth`, floored to {@link MT_MIN_SPP} —
 * i.e. an empty session would open at MAXIMUM zoom-in, showing about 40
 * milliseconds of nothing, and the first clip dropped on it would be an
 * unreadable smear. A timeline with no clips has no length to fit, so it is
 * given one.
 */
export const MT_EMPTY_TIMELINE_SEC = 60;

/**
 * How far PAST the last clip the view can still be scrolled, in seconds.
 *
 * THE ONE PLACE this deliberately diverges from the editor's rule, and the
 * reason is structural rather than cosmetic: a document has a hard end (there
 * are no samples after it, so the editor's window is clamped to
 * `[0, length - laneWidth * spp]` and nothing is lost), but a session timeline
 * is open-ended — clips are placed by dropping them on empty lane, so a lane
 * that can never show empty space past the last clip is a lane on which the
 * session can never grow. Task 22 allowed `end + 60 s` of scroll for exactly
 * this reason; that allowance survives here, now expressed against the visible
 * window rather than against its left edge.
 */
export const MT_TIMELINE_TAIL_SEC = 60;

export interface SessionZoom {
  samplesPerPixel: number;
  scrollSample: number;
}

export interface SessionZoomRequest {
  samplesPerPixel: number;
  /**
   * Either an absolute scroll position, or a function of the RESOLVED
   * samples-per-pixel. The anchored paths (wheel-zoom on the pointer, the −/+
   * buttons on the multitrack cursor) need the CLAMPED spp to keep their anchor
   * under the same x: computing the scroll from the REQUESTED spp and then
   * clamping it separately is how an anchor drifts at the limit.
   */
  scrollSample: number | ((resolvedSamplesPerPixel: number) => number);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * THE shared "how long is this session" helper — the furthest clip END across
 * every track, 0 when there are no clips.
 *
 * It was duplicated three times before MT1-1 (`useMultitrackZoom`'s private
 * copy, `mixdown`'s inline loop, and a third in `mixdown.fades.test`), which is
 * how the wheel handler and the rest of the app could disagree about where the
 * session ends. `mixdown`'s copy is NOT replaced by this one and that is
 * deliberate: it measures only the AUDIBLE tracks, because a muted track must
 * not lengthen the rendered file with silence. The zoom answers "what is
 * drawn", the mixdown answers "what is heard", and a muted track is still on
 * the timeline and must still be reachable — so this one counts every track.
 */
export function sessionEndSample(session: Session): number {
  let end = 0;
  for (const t of session.tracks) {
    for (const c of t.clips) end = Math.max(end, c.startSample + c.lengthSample);
  }
  return end;
}

/** The length the session is laid across: its last clip end, or
 * {@link MT_EMPTY_TIMELINE_SEC} seconds when it has no clips. */
export function sessionTimelineLength(session: Session): number {
  const end = sessionEndSample(session);
  return end > 0 ? end : MT_EMPTY_TIMELINE_SEC * session.sampleRate;
}

/**
 * **The zoom-out limit AND the fit — deliberately the same number**, the F11-9
 * ruling applied to the session.
 *
 * Before MT1-1 they were unrelated here too: the fit did not exist (a constant
 * 512 stood in for it) and the wheel's zoom-out ceiling was
 * `sessionEndSample / 50`. Everything past the fit is a state the surface
 * cannot draw coherently — the clip bodies (`ClipView`, whose width is
 * `lengthSample / spp`) shrink toward zero while the ruler and the beat tics
 * carry on compressing at their own rate — and it is a state nothing wants:
 * "further out than the whole session" shows the whole session plus emptiness.
 *
 * Floored at {@link MT_MIN_SPP}: a session shorter than `laneWidth * MT_MIN_SPP`
 * (~43 samples on a 1376 px lane) cannot fill the lane without exceeding the
 * app's maximum zoom-in, so it fits as far as the zoom range allows.
 */
export function fitSessionSamplesPerPixel(
  session: Session,
  laneWidth = sessionLaneWidth()
): number {
  return Math.max(MT_MIN_SPP, sessionTimelineLength(session) / laneWidth);
}

/**
 * The ONLY place the session's zoom is clamped: `samplesPerPixel` into
 * `[MT_MIN_SPP, fit]`, `scrollSample` into
 * `[0, timelineLength + tail - laneWidth * spp]`.
 *
 * Every consumer reads what this returns and none of them clamps again — the
 * Ctrl/Shift-wheel gesture, the toolbar's −/+/Fit cluster while the multitrack
 * view is active, the four session-load paths' default zoom, and the lane-width
 * republish. "ONLY" is a claim about `setMtZoom` callers and it is only as true
 * as the next commit leaves it, so grep `setMtZoom` before believing this
 * paragraph.
 *
 * The two clamps are one rule stated twice: the visible window
 * `[scrollSample, scrollSample + laneWidth * spp)` never runs past the end of
 * the timeline's scrollable extent (see {@link MT_TIMELINE_TAIL_SEC} for why
 * that extent is longer than the session).
 */
export function resolveSessionZoom(
  session: Session,
  requested: SessionZoomRequest,
  laneWidth = sessionLaneWidth()
): SessionZoom {
  const samplesPerPixel = clamp(
    requested.samplesPerPixel,
    MT_MIN_SPP,
    fitSessionSamplesPerPixel(session, laneWidth)
  );
  const scrollable =
    sessionTimelineLength(session) + MT_TIMELINE_TAIL_SEC * session.sampleRate;
  const wanted =
    typeof requested.scrollSample === 'function'
      ? requested.scrollSample(samplesPerPixel)
      : requested.scrollSample;
  const maxScroll = Math.max(0, scrollable - laneWidth * samplesPerPixel);
  // A NaN request (an anchor computed from a zero-width rect, say) resolves to
  // the start rather than poisoning the store.
  const scrollSample = Number.isFinite(wanted) ? clamp(wanted, 0, maxScroll) : 0;
  return { samplesPerPixel, scrollSample };
}

/**
 * The zoom a session is opened at, and what the Fit button restores while the
 * multitrack view is active: the LONGEST track laid across the measured lane
 * exactly, from sample 0. This is the user report — "the tracks should appear
 * Fit on the longest one" — expressed as a function.
 *
 * `Infinity` resolves to the ceiling, so "fit" is literally "as far out as the
 * session goes" and cannot drift from {@link fitSessionSamplesPerPixel}.
 */
export function defaultSessionZoom(session: Session): SessionZoom {
  return resolveSessionZoom(session, {
    samplesPerPixel: Number.POSITIVE_INFINITY,
    scrollSample: 0,
  });
}
