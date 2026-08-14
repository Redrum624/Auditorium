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

  it('never re-routes a member to another track (no cross-track group move in v1)', () => {
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
