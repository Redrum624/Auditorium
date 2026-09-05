import type { Track } from './session';

/**
 * D3 — A GAP: the empty span on ONE track, named so it can be selected and
 * closed. `trackId` rides along because a gap only means anything on the track
 * that has it — "localized" is the whole point of the feature, and a span
 * without its lane would be a time selection, which this app deliberately does
 * not have (`edit.rippleDeleteTime` in `menuActions.ts` says why).
 *
 * Half-open, like every other span in this codebase: `[startSample,
 * endSample)`, session samples, `endSample > startSample` by construction.
 */
export interface TrackGap {
  trackId: string;
  startSample: number;
  endSample: number;
}

/**
 * D3 — THE gap resolver: the gap `sample` falls in, or `null`.
 *
 * WHAT COUNTS. A gap is bounded on BOTH sides — a clip's end (or sample 0) on
 * the left, a clip's start on the right. So:
 *  - the open end after the last clip is not a gap (nothing to close it
 *    against, and shifting nothing is not an edit);
 *  - a sample any clip COVERS is not in a gap, which is also how an overlapped
 *    span is refused without a second overlap rule: the union of the two clips
 *    covers it;
 *  - `sample` must be STRICTLY inside — `start < sample < end`. The boundary
 *    samples belong to the clips that define them, and a double-click on the
 *    seam between a clip and the space beside it is ambiguous; refusing it
 *    means the user has to be inside the span they mean to close.
 *
 * DERIVED FROM THE COVERAGE, NOT FROM ADJACENT PAIRS. Walking `clips` in start
 * order and pairing neighbours gives the same answer for a tidy track and the
 * WRONG one as soon as clips overlap or nest — a short clip inside a long one
 * would end the pair at its own end, naming a "gap" the long clip is still
 * playing over. Taking the farthest end on the left and the nearest start on
 * the right is one rule that covers both. It also means the array order is
 * irrelevant, which matters: `Track.clips` is insertion-ordered and
 * `trimClip('start')` writes in place without re-sorting (trap T40).
 */
export function gapAt(track: Track, sample: number): TrackGap | null {
  let startSample = 0;
  let endSample = Number.POSITIVE_INFINITY;
  for (const clip of track.clips) {
    const clipEnd = clip.startSample + clip.lengthSample;
    if (clip.startSample <= sample && sample < clipEnd) return null; // covered
    if (clipEnd <= sample) startSample = Math.max(startSample, clipEnd);
    else if (clip.startSample > sample) endSample = Math.min(endSample, clip.startSample);
  }
  if (!Number.isFinite(endSample)) return null; // the open end after the last clip
  if (!(startSample < sample && sample < endSample)) return null; // the edges belong to the clips
  return { trackId: track.id, startSample, endSample };
}

/**
 * D3 — the moves that CLOSE a gap: every clip on the track that starts at or
 * after the gap's end, shifted left by the gap's length, LEFTMOST FIRST.
 *
 * "At or after the end" rather than "after the start" is `rippleDeleteClips`'s
 * own `survivor.start >= removed.end` rule, and it is exact here rather than
 * defensive: nothing can start inside a gap, since a clip starting there would
 * have bounded the gap at its own start.
 *
 * Leftmost first so the list names the moves in timeline order, which is how
 * the fixture reads and how `rippleDeleteClips` orders its own shifts. It is no
 * longer load-bearing: `closeGap` commits the whole set as ONE `translateClips`
 * write, precisely because NO application order is safe one clip at a time.
 * Ordering fixes the mover-vs-stationary collisions and cannot fix the
 * mover-vs-mover ones — two clips that already overlap each other are pulled
 * apart by the first move and re-joined by the second, whichever end you start
 * from, and the facing-fade maintenance reads that re-join as a brand-new
 * overlap and arms a crossfade the gesture never asked for (final review, C3).
 *
 * Pure: it names the moves and commits nothing.
 */
export function closeGapShifts(
  track: Track,
  gap: TrackGap
): { clipId: string; toSample: number }[] {
  const length = gap.endSample - gap.startSample;
  return track.clips
    .filter((c) => c.startSample >= gap.endSample)
    .map((c) => ({ clipId: c.id, toSample: c.startSample - length }))
    .sort((a, b) => a.toSample - b.toSample);
}

/**
 * D3 — a sample strictly inside `gap`, so a standing selection can be
 * re-resolved through the SAME resolver it came from instead of a second
 * definition of "still there".
 *
 * The exact midpoint, NOT floored (review round 1, I1). Flooring made the probe
 * land on the gap's own start edge for a one-sample gap — a span `gapAt` can
 * still name when the caller's sample is fractional, which the test hooks allow
 * and a 32-px-per-sample zoom used to allow from the lane too. `gapAt` then
 * refused its own edge and `closeGap` became a silent no-op: Delete did
 * nothing. `(start + end) / 2` is strictly between the two for EVERY span with
 * `end > start`, integer or not, which is every span this module produces.
 */
export function gapProbeSample(gap: TrackGap): number {
  return (gap.startSample + gap.endSample) / 2;
}
