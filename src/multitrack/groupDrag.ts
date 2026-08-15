import type { Session } from './session';

/**
 * T5 — THE GROUP DRAG'S ARITHMETIC, extracted so the preview and the commit
 * read the same answer instead of agreeing by coincidence.
 *
 * K1 computed the horizontal clamp inside `moveClipsBy`, where nothing else
 * could see it: a group dragged left past sample 0 previewed a move the commit
 * then refused, and the clips snapped back on release. That is the same defect
 * class T1 closed for the drop ghost (a painted position the drop would not
 * take), and it closes the same way — one resolver, two readers.
 *
 * Both functions are pure and take the session explicitly, so a caller may ask
 * them what WOULD happen without writing anything.
 */

/** Where a clip lives, as an index pair — `null` when the session has no such
 * clip. Track index rather than id, because the vertical delta is counted in
 * lanes. */
function locate(session: Session, clipId: string): { trackIdx: number; startSample: number } | null {
  for (let i = 0; i < session.tracks.length; i++) {
    const clip = session.tracks[i].clips.find((c) => c.id === clipId);
    if (clip) return { trackIdx: i, startSample: clip.startSample };
  }
  return null;
}

/**
 * The horizontal delta a group drag may actually take: the request, rounded to
 * a whole sample and floored so the EARLIEST member lands no earlier than 0.
 *
 * Clamped once against the earliest member rather than per member by
 * `moveClip`'s own `>= 0`, because clamping per member would silently deform
 * the group — the leading clip stops at zero while the rest keep going — and a
 * group drag that changes the spacing between the clips it is dragging is not
 * the gesture the user made. Rigid or nothing.
 *
 * Ids no clip carries are skipped; a request that is not a finite number, or a
 * list with no live member in it, answers 0 (move nothing).
 */
export function clampGroupDelta(
  session: Session,
  clipIds: readonly string[],
  deltaSample: number
): number {
  if (!Number.isFinite(deltaSample)) return 0;
  let earliest = Number.POSITIVE_INFINITY;
  for (const id of clipIds) {
    const at = locate(session, id);
    if (at !== null) earliest = Math.min(earliest, at.startSample);
  }
  if (!Number.isFinite(earliest)) return 0;
  // `|| 0` normalises the NEGATIVE ZERO this arithmetic really produces: a
  // member sitting at 0 makes the floor `-0`, and `Math.max(-10000, -0)` is
  // `-0`. Harmless to `=== 0` and to CSS, but it is a value that reads as a
  // number this function did not mean, and a caller comparing with `Object.is`
  // (a test, a memo) would be told the delta changed when it did not.
  return Math.round(Math.max(deltaSample, -earliest)) || 0;
}
