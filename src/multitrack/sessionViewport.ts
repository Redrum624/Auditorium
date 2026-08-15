/**
 * MT1-1 — the multitrack lane's measured width, published to whoever needs it.
 * The session's twin of `services/editorViewport.ts`, and deliberately a second
 * module rather than a second reader of that one: the two surfaces are visible
 * at different times, are laid out differently (this one carries a header
 * column the editor has no equivalent of), and a resize of one must never
 * re-fit the other.
 *
 * "Fit the longest track" has the same shape of problem the editor had in
 * F11-3: the session store cannot know how wide the stage is, because the width
 * is a layout fact discovered by `MultitrackView`'s ResizeObserver long after
 * the store was created. This module is the one place it is recorded — written
 * by that view's resize effect, read by `sessionZoom`'s fit and clamp.
 *
 * **The header column.** Unlike the editor's, the observed element is NOT the
 * lane. Each track row is `[TrackHeader | TrackLane]` and BOTH live inside the
 * scroller, so the scroller reports {@link MT_HEADER_W} more pixels than the
 * clips are drawn across. Fitting to that number would overshoot the fit by
 * exactly one header column — the last clip's tail hanging off the right edge,
 * which is the failure {@link laneWidthFromScrollerWidth} exists to prevent.
 *
 * **The fallback.** Until something measures — the very first paint, jsdom, any
 * unit test that never mounts the view — the width reads
 * {@link FALLBACK_SESSION_LANE_WIDTH}. Nothing therefore becomes
 * undefined-shaped or zero-shaped, and a measurement of 0 (what jsdom and a
 * `display:none` view both report, and what a window dragged narrower than the
 * header column produces here) is REJECTED rather than recorded, because a zero
 * width makes every derived samples-per-pixel infinite.
 *
 * Deliberately store-free: `sessionStore` and `sessionZoom` import this, so this
 * must import neither.
 */

/** The width of the track-header column, in CSS px — Tailwind `w-56` (14rem).
 * Lives here rather than in `MultitrackView` because it is a fact about the
 * lane geometry that the width arithmetic below needs, and two copies of a
 * geometry constant is exactly how a lane and its ruler drift apart. */
export const MT_HEADER_W = 224;

/** The lane width assumed before anything has measured: the nominal 1600 px
 * window `editorViewport` uses, minus the header column this surface spends on
 * track names. Chosen to match the editor's fallback so a session and a
 * document opened in the same unmeasured state are fitted by the same
 * assumption. */
export const FALLBACK_SESSION_LANE_WIDTH = 1600 - MT_HEADER_W;

let measured = 0;

/** The lane width to lay a session across, in CSS px. Never 0. */
export function sessionLaneWidth(): number {
  return measured > 0 ? measured : FALLBACK_SESSION_LANE_WIDTH;
}

/**
 * The usable lane width for a scroller of `scrollerWidth` CSS px — i.e. minus
 * the header column that sits inside every row. Exported (rather than inlined
 * in the view) so the subtraction is pinned by a test instead of by a reader
 * noticing it; a scroller narrower than the header yields <= 0, which
 * {@link setSessionLaneWidth} then rejects.
 *
 * V1 review, Minor 1 — THE ONLY COPY OF THIS SUBTRACTION. `clipBeatTics`'
 * `laneWidthBound` needs the same `x − MT_HEADER_W` over the WINDOW rather than
 * the scroller (an upper bound on any lane, for the raster band) and had written
 * its own. The header note above says two copies of a geometry CONSTANT is how a
 * lane and its ruler drift apart; the arithmetic over it is no different, so the
 * bound calls this. The argument is any outer box the row lies inside — a
 * scroller for the fit, the window for the bound — and the subtraction is the
 * same fact about the row either way.
 */
export function laneWidthFromScrollerWidth(scrollerWidth: number): number {
  return scrollerWidth - MT_HEADER_W;
}

/**
 * Record a fresh measurement. Returns whether the EFFECTIVE width changed —
 * callers use that to decide whether anything needs re-fitting, so a resize
 * observer firing with the same number stays free.
 *
 * Non-finite and non-positive widths are ignored (see the fallback note).
 */
export function setSessionLaneWidth(width: number): boolean {
  if (!Number.isFinite(width) || width <= 0) return false;
  const before = sessionLaneWidth();
  measured = width;
  return sessionLaneWidth() !== before;
}

/** Test-only: forget the measurement so the fallback applies again. */
export function _resetSessionLaneWidth(): void {
  measured = 0;
}
