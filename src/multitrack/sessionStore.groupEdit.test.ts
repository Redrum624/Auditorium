import { createClip, createTrack, type Clip, type Session } from './session';
import { moveClipsBy, removeClips, rippleDeleteClips, useSessionStore } from './sessionStore';
import { SESSION_UNDO_KEY, _resetSessionUndo, redoSession, undoSession } from './sessionUndo';
import { getHistory } from '../services/undoHistory';

/**
 * K1 R2/R3 — the three GROUP verbs. Each is one user act, so each is exactly
 * ONE undo entry (the store's law), and each composes the store's existing
 * single-clip actions inside a gesture bracket rather than reimplementing them:
 * that is what puts ripple-shifted overlaps through `maintainFacingFades`, the
 * same maintenance a drag gets, with no bespoke overlap logic anywhere.
 */

const store = () => useSessionStore.getState();
const doneLabels = () => getHistory(SESSION_UNDO_KEY).done;

function clipById(id: string): Clip | undefined {
  for (const t of useSessionStore.getState().session.tracks) {
    const c = t.clips.find((x) => x.id === id);
    if (c) return c;
  }
  return undefined;
}

const startOf = (id: string): number | undefined => clipById(id)?.startSample;

/** Builds a session from a per-track list of `[start, length]` spans. */
function seed(...tracks: [number, number][][]): { session: Session; ids: string[][] } {
  const built = tracks.map((spans, i) => {
    const t = createTrack(`Track ${i + 1}`);
    t.clips = spans.map(([startSample, lengthSample]) =>
      createClip({ documentId: `doc-${i + 1}`, startSample, offsetSample: 0, lengthSample })
    );
    return t;
  });
  const session: Session = { name: 'Group Fixture', sampleRate: 44100, tracks: built };
  useSessionStore.setState({
    session,
    selectedClipId: null,
    selectedClipIds: [],
    mtCursorSample: 0,
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
  });
  return { session, ids: built.map((t) => t.clips.map((c) => c.id)) };
}

beforeEach(() => {
  _resetSessionUndo();
});

describe('removeClips — Delete over a multi-selection', () => {
  it('removes every member in ONE undo entry, and one undo brings them all back', () => {
    const { ids } = seed([[0, 1000], [2000, 1000]], [[500, 1000]]);
    const pre = store().session;

    removeClips([ids[0][0], ids[1][0]]);
    expect(doneLabels()).toEqual(['Remove clips']);
    expect(clipById(ids[0][0])).toBeUndefined();
    expect(clipById(ids[1][0])).toBeUndefined();
    expect(clipById(ids[0][1])).toBeDefined();

    undoSession();
    expect(store().session).toBe(pre);
  });

  it('a single member keeps the label a single delete has always had', () => {
    const { ids } = seed([[0, 1000]]);
    removeClips([ids[0][0]]);
    expect(doneLabels()).toEqual(['Remove clip']);
  });

  it('an empty list changes nothing and records nothing', () => {
    const { session } = seed([[0, 1000]]);
    removeClips([]);
    expect(store().session).toBe(session);
    expect(doneLabels()).toEqual([]);
  });

  it('skips an id no clip carries and still removes its siblings', () => {
    const { ids } = seed([[0, 1000], [2000, 1000]]);
    removeClips([ids[0][0], 'clip-gone']);
    expect(clipById(ids[0][0])).toBeUndefined();
    expect(clipById(ids[0][1])).toBeDefined();
    // The label counts what was REMOVED, not what was asked for: one real id
    // beside a phantom is the single delete it turned out to be.
    expect(doneLabels()).toEqual(['Remove clip']);
  });
});

describe('rippleDeleteClips — remove and close the gap', () => {
  it('shifts every LATER clip on the same track left by the removed span', () => {
    const { ids } = seed([[0, 1000], [1000, 1000], [5000, 1000]]);
    rippleDeleteClips([ids[0][1]]);

    expect(clipById(ids[0][1])).toBeUndefined();
    expect(startOf(ids[0][0])).toBe(0); // earlier clip: untouched
    expect(startOf(ids[0][2])).toBe(4000); // later clip: closed the 1000-sample gap
    expect(doneLabels()).toEqual(['Ripple delete']);
  });

  it('leaves every OTHER track exactly where it was — the gap is per track', () => {
    const { ids } = seed([[0, 1000], [4000, 1000]], [[4000, 1000]]);
    rippleDeleteClips([ids[0][0]]);
    expect(startOf(ids[0][1])).toBe(3000);
    expect(startOf(ids[1][0])).toBe(4000);
  });

  it('closes each track’s own gap when the selection spans tracks', () => {
    const { ids } = seed([[0, 1000], [3000, 1000]], [[0, 500], [3000, 500]]);
    rippleDeleteClips([ids[0][0], ids[1][0]]);
    expect(startOf(ids[0][1])).toBe(2000);
    expect(startOf(ids[1][1])).toBe(2500);
    expect(doneLabels()).toEqual(['Ripple delete']);
  });

  it('sums the spans of several removed clips for a survivor after all of them', () => {
    const { ids } = seed([[0, 1000], [2000, 1000], [9000, 1000]]);
    rippleDeleteClips([ids[0][0], ids[0][1]]);
    expect(startOf(ids[0][2])).toBe(7000); // 9000 - (1000 + 1000)
  });

  it('shifts a survivor BETWEEN two removed spans by only the spans before it', () => {
    // T1 (K1 review, Minor M5). The case above cannot tell "sum the spans that
    // end before me" from "sum every removed span", because its survivor is
    // after all of them and the two rules agree there. This one disagrees:
    // `mid` sits between the two removals, so it closes the FIRST gap only,
    // and `tail` — the same fixture, after both — closes both.
    const { ids } = seed([[0, 1000], [3000, 1000], [6000, 1000], [9000, 1000]]);
    rippleDeleteClips([ids[0][0], ids[0][2]]);

    expect(startOf(ids[0][1])).toBe(2000); // 3000 - 1000, not 3000 - 2000
    expect(startOf(ids[0][3])).toBe(7000); // 9000 - (1000 + 1000)
  });

  it('measures the UNION of removed spans, so two overlapping removals count once', () => {
    // [0,1000) and [500,1500) remove 1500 samples of timeline, not 2000.
    const { ids } = seed([[0, 1000], [500, 1000], [9000, 1000]]);
    rippleDeleteClips([ids[0][0], ids[0][1]]);
    expect(startOf(ids[0][2])).toBe(7500);
  });

  it('does not shift a survivor that OVERLAPS the removed clip — it is not later', () => {
    const { ids } = seed([[0, 1000], [900, 1000]]);
    rippleDeleteClips([ids[0][0]]);
    expect(startOf(ids[0][1])).toBe(900);
  });

  it('is one undo entry: the clips come back AND the shifts come undone', () => {
    const { ids } = seed([[0, 1000], [1000, 1000], [5000, 1000]]);
    const pre = store().session;

    rippleDeleteClips([ids[0][1]]);
    const post = store().session;

    undoSession();
    expect(store().session).toBe(pre);
    expect(startOf(ids[0][2])).toBe(5000);
    redoSession();
    expect(store().session).toBe(post);
    expect(startOf(ids[0][2])).toBe(4000);
  });

  it('an empty list changes nothing and records nothing', () => {
    const { session } = seed([[0, 1000], [4000, 1000]]);
    rippleDeleteClips([]);
    expect(store().session).toBe(session);
    expect(doneLabels()).toEqual([]);
  });

  it('a shift that lands ON a neighbour arms the pair through the drag’s own maintenance', () => {
    // Removing [1000,2000) drags the third clip 1000 left, from 2500 to 1500 —
    // 500 samples INTO the clip that ends at 2000. No bespoke overlap code
    // runs: `moveClip` performs the shift, so `maintainFacingFades` arms the
    // facing fades to exactly the overlap width, as a drag would.
    const { ids } = seed([[0, 2000], [1000, 1000], [2500, 1000]]);
    rippleDeleteClips([ids[0][1]]);

    expect(startOf(ids[0][2])).toBe(1500);
    expect(clipById(ids[0][0])!.fadeOutSample).toBe(500);
    expect(clipById(ids[0][2])!.fadeInSample).toBe(500);
  });
});

describe('moveClipsBy — the group drag', () => {
  it('moves every member by the same delta, on its own track, in ONE entry', () => {
    const { ids } = seed([[0, 1000]], [[4000, 1000]]);
    moveClipsBy([ids[0][0], ids[1][0]], 500);

    expect(startOf(ids[0][0])).toBe(500);
    expect(startOf(ids[1][0])).toBe(4500);
    expect(doneLabels()).toEqual(['Move clips']);
  });

  // T5: the claim this test used to make — "no cross-track group move in v1" —
  // is superseded; the group follows the pointer across lanes now (see the
  // describe below). What survives, and is what this arm was really holding, is
  // that a call which does not ASK for a lane change never causes one.
  it('never re-routes a member when no track delta is asked for', () => {
    const { ids } = seed([[0, 1000]], [[4000, 1000]]);
    moveClipsBy([ids[0][0], ids[1][0]], 500);
    const tracks = store().session.tracks;
    expect(tracks[0].clips.map((c) => c.id)).toEqual([ids[0][0]]);
    expect(tracks[1].clips.map((c) => c.id)).toEqual([ids[1][0]]);
  });

  it('clamps the DELTA, not the member: the group stays rigid at the timeline start', () => {
    const { ids } = seed([[200, 1000]], [[4000, 1000]]);
    moveClipsBy([ids[0][0], ids[1][0]], -900);
    expect(startOf(ids[0][0])).toBe(0);
    expect(startOf(ids[1][0])).toBe(3800); // moved by -200, the same as its sibling
  });

  it('a single member keeps the label a single move has always had', () => {
    const { ids } = seed([[0, 1000]]);
    moveClipsBy([ids[0][0]], 500);
    expect(doneLabels()).toEqual(['Move clip']);
  });

  it('a zero delta records nothing (the moveClip no-op guard, through the group)', () => {
    const { ids, session } = seed([[0, 1000]], [[4000, 1000]]);
    moveClipsBy([ids[0][0], ids[1][0]], 0);
    expect(store().session).toBe(session);
    expect(doneLabels()).toEqual([]);
  });

  it('an empty list changes nothing and records nothing', () => {
    const { session } = seed([[0, 1000]]);
    moveClipsBy([], 500);
    expect(store().session).toBe(session);
    expect(doneLabels()).toEqual([]);
  });

  it('two members that move together keep the crossfade they already had', () => {
    // An armed pair, both members selected, dragged 1000 right as a unit. The
    // move order (rightmost first when moving right) is what keeps them from
    // colliding on the way; the pair's geometry is identical afterwards, so
    // the facing fades are too.
    const { ids } = seed([[0, 2000], [1500, 2000]]);
    store().setClipFade(ids[0][0], 'out', { lengthSample: 500 });
    store().setClipFade(ids[0][1], 'in', { lengthSample: 500 });
    _resetSessionUndo();

    moveClipsBy([ids[0][0], ids[0][1]], 1000);

    expect(startOf(ids[0][0])).toBe(1000);
    expect(startOf(ids[0][1])).toBe(2500);
    expect(clipById(ids[0][0])!.fadeOutSample).toBe(500);
    expect(clipById(ids[0][1])!.fadeInSample).toBe(500);
    expect(doneLabels()).toEqual(['Move clips']);
  });

  it('moving LEFT past a sibling is the same one entry, with the pair intact', () => {
    const { ids } = seed([[1000, 2000], [2500, 2000]]);
    store().setClipFade(ids[0][0], 'out', { lengthSample: 500 });
    store().setClipFade(ids[0][1], 'in', { lengthSample: 500 });
    _resetSessionUndo();

    moveClipsBy([ids[0][0], ids[0][1]], -800);

    expect(startOf(ids[0][0])).toBe(200);
    expect(startOf(ids[0][1])).toBe(1700);
    expect(clipById(ids[0][0])!.fadeOutSample).toBe(500);
    expect(clipById(ids[0][1])!.fadeInSample).toBe(500);
    expect(doneLabels()).toEqual(['Move clips']);
  });
});

/** The track a clip currently sits on, by index. */
function trackIdxOf(id: string): number {
  return useSessionStore.getState().session.tracks.findIndex((t) => t.clips.some((c) => c.id === id));
}

describe('moveClipsBy — the group crosses tracks (T5)', () => {
  it('shifts every member by the SAME track delta, keeping the shape', () => {
    const { ids } = seed([[0, 1000]], [[4000, 1000]], [], []);
    moveClipsBy([ids[0][0], ids[1][0]], 500, 1);
    expect(trackIdxOf(ids[0][0])).toBe(1);
    expect(trackIdxOf(ids[1][0])).toBe(2);
    expect(startOf(ids[0][0])).toBe(500); // and the horizontal move still happens
    expect(startOf(ids[1][0])).toBe(4500);
    expect(doneLabels()).toEqual(['Move clips']);
  });

  it('is ONE undo entry that puts both the lane and the position back', () => {
    const { ids } = seed([[0, 1000]], [[4000, 1000]], [], []);
    moveClipsBy([ids[0][0], ids[1][0]], 500, 1);
    undoSession();
    expect(trackIdxOf(ids[0][0])).toBe(0);
    expect(trackIdxOf(ids[1][0])).toBe(1);
    expect(startOf(ids[0][0])).toBe(0);
    expect(startOf(ids[1][0])).toBe(4000);
    redoSession();
    expect(trackIdxOf(ids[1][0])).toBe(2);
    expect(startOf(ids[1][0])).toBe(4500);
  });

  it('a lane change with NO horizontal travel is still a move', () => {
    // The `delta === 0` early return is about the horizontal delta only; a
    // purely vertical drag is a real gesture and must not be swallowed by it.
    const { ids } = seed([[1000, 1000]], []);
    moveClipsBy([ids[0][0]], 0, 1);
    expect(trackIdxOf(ids[0][0])).toBe(1);
    expect(startOf(ids[0][0])).toBe(1000);
    expect(doneLabels()).toEqual(['Move clip']);
  });

  it('a member landing where a sibling still sits does not arm a crossfade with it', () => {
    // Two members one lane apart, both moving DOWN one lane: the upper one's
    // target is the lane the lower one is vacating. Ordering the moves so the
    // lower one leaves first is what stops the pair colliding in mid-gesture
    // and writing facing fades the drag never asked for.
    const { ids } = seed([[0, 2000]], [[0, 2000]], []);
    moveClipsBy([ids[0][0], ids[1][0]], 0, 1);
    expect(trackIdxOf(ids[0][0])).toBe(1);
    expect(trackIdxOf(ids[1][0])).toBe(2);
    expect(clipById(ids[0][0])!.fadeOutSample ?? 0).toBe(0);
    expect(clipById(ids[0][0])!.fadeInSample ?? 0).toBe(0);
    expect(clipById(ids[1][0])!.fadeInSample ?? 0).toBe(0);
  });

  it('the same collision avoided in the other direction (moving UP)', () => {
    const { ids } = seed([], [[0, 2000]], [[0, 2000]]);
    moveClipsBy([ids[1][0], ids[2][0]], 0, -1);
    expect(trackIdxOf(ids[1][0])).toBe(0);
    expect(trackIdxOf(ids[2][0])).toBe(1);
    expect(clipById(ids[1][0])!.fadeOutSample ?? 0).toBe(0);
    expect(clipById(ids[2][0])!.fadeInSample ?? 0).toBe(0);
  });

  it('a track delta that would run off the end moves nothing at all', () => {
    // The store is the last line of defence: `resolveGroupTrackDelta` will not
    // hand it such a delta, but a caller that computed one itself must not be
    // able to scatter half the group or drop clips into nowhere.
    const { ids, session } = seed([[0, 1000]], [[4000, 1000]]);
    moveClipsBy([ids[0][0], ids[1][0]], 500, 1);
    expect(store().session).toBe(session);
    expect(doneLabels()).toEqual([]);
  });

  it('lands on the track under it, overlaps included, through the usual maintenance', () => {
    const { ids } = seed([[0, 2000]], [[1000, 2000]]);
    moveClipsBy([ids[0][0]], 0, 1);
    expect(trackIdxOf(ids[0][0])).toBe(1);
    // The pair now overlaps on track 2 and is armed as a crossfade, exactly as
    // a single-clip drag onto it would be — no bespoke logic for the group.
    expect(clipById(ids[0][0])!.fadeOutSample).toBeGreaterThan(0);
    expect(clipById(ids[1][0])!.fadeInSample).toBeGreaterThan(0);
  });
});
