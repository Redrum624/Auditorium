import type { Session } from './session';

/**
 * K1 R1 — WHERE THE MULTITRACK CURSOR JUMPS TO.
 *
 * `Ctrl+Left` / `Ctrl+Right` move the session cursor to the previous / next
 * CLIP BOUNDARY. The reported ask was the narrow one — "go to the beginning of
 * the segment under the cursor, and to its end" — and the union below is
 * exactly that ask generalised the way every NLE generalises it: with the
 * cursor inside a clip, the nearest boundary behind it IS that clip's start and
 * the nearest ahead IS its end, so the narrow behaviour falls out of the
 * general one rather than being a second rule beside it. Past the clip's edges
 * the same key keeps walking the session's edit points, which is what makes the
 * pair a navigation gesture instead of a two-position toggle.
 *
 * ACROSS TRACKS, deliberately. The cursor is one line drawn over every lane
 * (`MultitrackView` paints it outside the scroller), not a per-track caret, so
 * a per-track boundary set would depend on a "current track" this surface does
 * not have. The union is the only set the cursor could honestly navigate.
 *
 * SNAPPING DOES NOT APPLY. The magnet (`sessionSnapTargets`) exists to make a
 * dragged position land on a target it is merely NEAR; here the targets ARE the
 * destinations, already exact. Running the cursor through the magnet afterwards
 * could only move it OFF the boundary it was asked for, onto a nearby beat.
 *
 * STRICTLY EXCLUSIVE AT THE CURSOR, which is the whole of the "no dead
 * keypress" rule: standing exactly on a boundary, the next press moves to the
 * one BEYOND it. `>=`/`<=` would pin the cursor to the boundary it already
 * occupies and the key would appear broken precisely where it was just used.
 *
 * AT THE EXTREMES the answer is `null` and the caller moves nothing. There is
 * no wraparound and no implicit boundary at sample 0: 0 is a boundary only when
 * a clip actually starts there. Inventing one would put an edit point where the
 * session has no edit, and `Home` is the key for "the beginning" in every
 * surface this app has.
 */

/** Every clip start and clip end in the session, ascending and duplicate-free
 * (a butt join contributes ONE boundary, not two at the same sample). */
export function clipBoundaries(session: Session): number[] {
  const seen = new Set<number>();
  for (const track of session.tracks) {
    for (const clip of track.clips) {
      seen.add(clip.startSample);
      seen.add(clip.startSample + clip.lengthSample);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * The boundary the cursor should move to, or `null` when there is none in that
 * direction. `boundaries` must be ascending (as `clipBoundaries` returns it);
 * `cursorSample` need not be one of them, or an integer.
 */
export function nextClipEdge(
  boundaries: readonly number[],
  cursorSample: number,
  direction: 'prev' | 'next'
): number | null {
  if (direction === 'next') {
    for (const b of boundaries) if (b > cursorSample) return b;
    return null;
  }
  for (let i = boundaries.length - 1; i >= 0; i--) {
    if (boundaries[i] < cursorSample) return boundaries[i];
  }
  return null;
}
