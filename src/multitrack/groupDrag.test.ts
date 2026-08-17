import { createClip, createTrack, type Session } from './session';
import { clampGroupDelta, resolveGroupTrackDelta } from './groupDrag';

/**
 * T5 — the group drag's arithmetic, as pure functions, so the PREVIEW and the
 * COMMIT can be computed from one source instead of agreeing by coincidence.
 *
 * K1 clamped the delta inside `moveClipsBy` and nothing else could see it, so
 * a group dragged left past sample 0 previewed a move the commit then refused.
 * That divergence is the same defect class T1 closed for the drop ghost, and
 * it closes the same way: one resolver, two readers.
 */

function sessionOf(spec: { track: number; start: number }[]): {
  session: Session;
  ids: string[];
} {
  const tracks = [createTrack('Track 1'), createTrack('Track 2'), createTrack('Track 3')];
  const ids: string[] = [];
  for (const { track, start } of spec) {
    const clip = createClip({
      documentId: 'doc-1',
      startSample: start,
      offsetSample: 0,
      lengthSample: 1000,
    });
    tracks[track].clips.push(clip);
    ids.push(clip.id);
  }
  return { session: { name: 'Group Fixture', sampleRate: 44100, tracks }, ids };
}

describe('clampGroupDelta — rigid or nothing', () => {
  it('passes a delta that no member would take past sample 0 through unchanged', () => {
    const { session, ids } = sessionOf([
      { track: 0, start: 5000 },
      { track: 1, start: 9000 },
    ]);
    expect(clampGroupDelta(session, ids, 3000)).toBe(3000);
    expect(clampGroupDelta(session, ids, -5000)).toBe(-5000);
  });

  it('clamps against the EARLIEST member, so the group never deforms', () => {
    const { session, ids } = sessionOf([
      { track: 0, start: 5000 },
      { track: 1, start: 9000 },
    ]);
    // −8 000 would put the earliest member at −3 000. Clamping per member would
    // stop that one at 0 and let the other keep going, changing the spacing
    // between clips the user is dragging together.
    expect(clampGroupDelta(session, ids, -8000)).toBe(-5000);
  });

  it('refuses any leftward travel when a member already sits at 0', () => {
    const { session, ids } = sessionOf([
      { track: 0, start: 0 },
      { track: 0, start: 40_000 },
    ]);
    expect(clampGroupDelta(session, ids, -10_000)).toBe(0);
    expect(clampGroupDelta(session, ids, 10_000)).toBe(10_000); // rightward is free
  });

  it('rounds, so the preview and the commit agree on a whole sample', () => {
    const { session, ids } = sessionOf([{ track: 0, start: 5000 }]);
    expect(clampGroupDelta(session, ids, 1234.6)).toBe(1235);
  });

  it('ignores ids no clip carries, and answers 0 when none of them are live', () => {
    const { session, ids } = sessionOf([{ track: 0, start: 5000 }]);
    expect(clampGroupDelta(session, [...ids, 'ghost'], -8000)).toBe(-5000);
    expect(clampGroupDelta(session, ['ghost'], -8000)).toBe(0);
  });

  it('answers 0 for a delta that is not a finite number', () => {
    const { session, ids } = sessionOf([{ track: 0, start: 5000 }]);
    expect(clampGroupDelta(session, ids, Number.NaN)).toBe(0);
    expect(clampGroupDelta(session, ids, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

/**
 * The VERTICAL half. Same rigidity rule as the horizontal one and for the same
 * reason: the group keeps its shape or it does not move. Here that shows as
 * all-or-nothing rather than as a floor — there is no "as far down as it will
 * go" that preserves the relative track offsets, so a group that cannot fit
 * stays on the tracks it is on.
 */
describe('resolveGroupTrackDelta — the lanes the group can reach', () => {
  const trackId = (session: Session, i: number) => session.tracks[i].id;

  it('is the offset from the grabbed clip’s track to the pointed one', () => {
    const { session, ids } = sessionOf([
      { track: 0, start: 0 },
      { track: 1, start: 0 },
    ]);
    expect(resolveGroupTrackDelta(session, ids, ids[0], trackId(session, 1))).toBe(1);
  });

  it('is 0 when the pointer is on the grabbed clip’s own track', () => {
    const { session, ids } = sessionOf([
      { track: 0, start: 0 },
      { track: 1, start: 0 },
    ]);
    expect(resolveGroupTrackDelta(session, ids, ids[0], trackId(session, 0))).toBe(0);
  });

  it('is 0 when the pointer is over no track at all', () => {
    const { session, ids } = sessionOf([{ track: 0, start: 0 }]);
    expect(resolveGroupTrackDelta(session, ids, ids[0], null)).toBe(0);
  });

  it('refuses the move when ANY member would fall off the bottom', () => {
    // Members on tracks 1 and 2 (of three). Grabbing the track-1 member and
    // pointing at track 2 would send the other one to a track 3 that does not
    // exist — so nothing changes lane, rather than one clip scattering.
    const { session, ids } = sessionOf([
      { track: 1, start: 0 },
      { track: 2, start: 0 },
    ]);
    expect(resolveGroupTrackDelta(session, ids, ids[0], trackId(session, 2))).toBe(0);
  });

  it('refuses the move when ANY member would fall off the top', () => {
    const { session, ids } = sessionOf([
      { track: 0, start: 0 },
      { track: 1, start: 0 },
    ]);
    // Grab the track-1 member, point at track 0: the other would go to −1.
    expect(resolveGroupTrackDelta(session, ids, ids[1], trackId(session, 0))).toBe(0);
  });

  it('allows the move when every member’s target exists, edges included', () => {
    const { session, ids } = sessionOf([
      { track: 0, start: 0 },
      { track: 1, start: 0 },
    ]);
    // Grab the track-0 member and point at track 1: members land on 1 and 2,
    // the last of which is exactly the last track.
    expect(resolveGroupTrackDelta(session, ids, ids[0], trackId(session, 1))).toBe(1);
  });

  it('preserves the relative offsets — a two-lane gap stays two lanes', () => {
    const { session, ids } = sessionOf([
      { track: 0, start: 0 },
      { track: 2, start: 0 },
    ]);
    // Any downward move would push the track-2 member off the end; upward is
    // impossible for the track-0 member. A three-track session pins the group.
    expect(resolveGroupTrackDelta(session, ids, ids[0], trackId(session, 1))).toBe(0);
    expect(resolveGroupTrackDelta(session, ids, ids[1], trackId(session, 1))).toBe(0);
  });

  it('is 0 when the grabbed clip is not in the session', () => {
    const { session, ids } = sessionOf([{ track: 0, start: 0 }]);
    expect(resolveGroupTrackDelta(session, ids, 'ghost', trackId(session, 1))).toBe(0);
  });

  it('is 0 for a track id the session does not carry', () => {
    const { session, ids } = sessionOf([{ track: 0, start: 0 }]);
    expect(resolveGroupTrackDelta(session, ids, ids[0], 'no-such-track')).toBe(0);
  });

  it('ignores members no clip carries rather than refusing on them', () => {
    const { session, ids } = sessionOf([{ track: 0, start: 0 }]);
    expect(resolveGroupTrackDelta(session, [...ids, 'ghost'], ids[0], trackId(session, 1))).toBe(1);
  });
});
