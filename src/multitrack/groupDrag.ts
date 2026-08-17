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

/**
 * The VERTICAL delta a group drag may take: how many lanes down (positive) or
 * up (negative) every member shifts when the grabbed clip is dropped on
 * `pointedTrackId`. 0 means "stay where you are", which is also the answer for
 * every case the gesture cannot honour.
 *
 * THE GRABBED CLIP LANDS ON THE TRACK THE POINTER NAMES, and the rest of the
 * group shifts by that same index delta, so the relative lane offsets survive:
 * a group spanning two lanes still spans two lanes afterwards. That is the same
 * rigidity `clampGroupDelta` gives the horizontal axis, and it is what makes
 * one drop one gesture instead of N.
 *
 * ALL OR NOTHING at the edges. When any member's target lane does not exist,
 * the answer is 0 and the drag stays on its own tracks. The alternative —
 * moving the members that fit — would scatter the group and silently change
 * the arrangement's shape, and there is no partial shift that preserves the
 * offsets, so there is nothing honest between "all of it" and "none of it".
 * Adding tracks to make room would be a bigger edit than the one the user
 * made, and it is not this gesture's to make.
 *
 * Ids no clip carries are skipped rather than refused: a stale member cannot
 * fall off a track it is not on, and refusing on it would make an unrelated
 * bug look like an edge of the session.
 */
export function resolveGroupTrackDelta(
  session: Session,
  clipIds: readonly string[],
  grabbedClipId: string,
  pointedTrackId: string | null
): number {
  if (pointedTrackId === null) return 0;
  const grabbed = locate(session, grabbedClipId);
  if (grabbed === null) return 0;
  const pointedIdx = session.tracks.findIndex((t) => t.id === pointedTrackId);
  if (pointedIdx === -1) return 0;
  const delta = pointedIdx - grabbed.trackIdx;
  if (delta === 0) return 0;
  for (const id of clipIds) {
    const at = locate(session, id);
    if (at === null) continue;
    const target = at.trackIdx + delta;
    if (target < 0 || target >= session.tracks.length) return 0;
  }
  return delta;
}
