/**
 * D3 — THE GAP SELECTION IN THE STORE: one selection on screen at a time, one
 * undo entry per close, and NOTHING of it on disk or in the undo snapshot.
 *
 * `selectedGap` is view state in the sense `mtEnvelope` and `groupDragPreview`
 * already are (ruling 3): it is never serialized, never in `SessionSnapshot`,
 * and it is reconciled against the session by the SAME subscriber that holds
 * the K1 clip-selection invariants — a gap whose track moved under it is not a
 * gap the user is still pointing at.
 */
import { serializeSession } from './sessionFile';
import { createClip, createTrack, type Session } from './session';
import { gapAt } from './gaps';
import { closeGap, useSessionStore } from './sessionStore';
import { SESSION_UNDO_KEY, _resetSessionUndo, undoSession } from './sessionUndo';
import { getHistory } from '../services/undoHistory';

const store = () => useSessionStore.getState();
const doneLabels = () => getHistory(SESSION_UNDO_KEY).done;

/**
 * Track 1: A(1000..1500) · B(2000..2500) · C(2600..2900) — the gap under test
 * is [1500, 2000). Track 2 carries one clip at a DIFFERENT position, so
 * "other tracks never move" is measured against something that could have.
 * Non-identity offsets and gains throughout: a fixture off the identity
 * measures the identity.
 */
function seed(): { session: Session; a: string; b: string; c: string; d: string } {
  const t1 = createTrack('Track 1');
  const t2 = createTrack('Track 2');
  t1.clips = [
    createClip({ documentId: 'doc-1', startSample: 1000, offsetSample: 128, lengthSample: 500, gainDb: -3 }),
    createClip({ documentId: 'doc-1', startSample: 2000, offsetSample: 256, lengthSample: 500, gainDb: 2 }),
    createClip({ documentId: 'doc-2', startSample: 2600, offsetSample: 64, lengthSample: 300, gainDb: -1 }),
  ];
  t2.clips = [
    createClip({ documentId: 'doc-2', startSample: 2200, offsetSample: 32, lengthSample: 700, gainDb: 4 }),
  ];
  const session: Session = { name: 'Gap Fixture', sampleRate: 44100, tracks: [t1, t2] };
  useSessionStore.setState({
    session,
    selectedClipId: null,
    selectedClipIds: [],
    selectedGap: null,
    mtCursorSample: 0,
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
  });
  return {
    session,
    a: t1.clips[0].id,
    b: t1.clips[1].id,
    c: t1.clips[2].id,
    d: t2.clips[0].id,
  };
}

let fx: ReturnType<typeof seed>;

/** The gap [1500, 2000) on track 1, resolved through the shipped resolver. */
function theGap() {
  return gapAt(store().session.tracks[0], 1700)!;
}

const clipsOf = (trackIdx: number) => store().session.tracks[trackIdx].clips;
const clipById = (id: string) =>
  store().session.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;

beforeEach(() => {
  _resetSessionUndo();
  fx = seed();
});

describe('one selection on screen at a time', () => {
  it('selecting a gap clears the clip selection', () => {
    store().setSelectedClip(fx.a);
    store().toggleSelectedClip(fx.b);
    expect(store().selectedClipIds).toEqual([fx.a, fx.b]);

    store().setSelectedGap(theGap());

    expect(store().selectedGap).toEqual({
      trackId: store().session.tracks[0].id,
      startSample: 1500,
      endSample: 2000,
    });
    expect(store().selectedClipId).toBeNull();
    expect(store().selectedClipIds).toEqual([]);
  });

  it('selecting a clip clears the gap — every clip-selection writer', () => {
    for (const select of [
      () => store().setSelectedClip(fx.a),
      () => store().toggleSelectedClip(fx.a),
      () => store().setSelectedClips([fx.a, fx.b]),
      () => store().extendSelectionToClip(fx.a),
    ]) {
      store().setSelectedGap(theGap());
      expect(store().selectedGap).not.toBeNull();

      select();

      expect(store().selectedGap).toBeNull();
      store().setSelectedClip(null);
    }
  });

  it('re-selecting the SAME span is a no-op — the same state object comes back', () => {
    store().setSelectedGap(theGap());
    const held = useSessionStore.getState();

    store().setSelectedGap(theGap()); // a fresh object naming the same span

    // The guard the K1 writers carry: a new object here would be a new value
    // for every lane's subscription to see, for a gesture that changed nothing.
    expect(useSessionStore.getState()).toBe(held);
  });

  it('clearing an already-clear gap is a no-op too', () => {
    const held = useSessionStore.getState();
    store().setSelectedGap(null);
    expect(useSessionStore.getState()).toBe(held);
  });

  it('selecting a gap over an EMPTY clip selection mints no fresh array', () => {
    const before = store().selectedClipIds;
    store().setSelectedGap(theGap());
    expect(store().selectedClipIds).toBe(before);
  });

  it('clearing the gap with null leaves the clip selection alone', () => {
    store().setSelectedGap(theGap());
    store().setSelectedGap(null);
    expect(store().selectedGap).toBeNull();
  });

  it('a new session selects no gap', () => {
    store().setSelectedGap(theGap());
    store().newSession(48000);
    expect(store().selectedGap).toBeNull();
  });
});

describe('closeGap', () => {
  it('moves every clip at or after the gap and leaves the rest IDENTICAL', () => {
    const beforeA = clipById(fx.a);
    const beforeD = clipById(fx.d);
    const beforeTrack2 = clipsOf(1);
    store().setSelectedGap(theGap());

    closeGap(theGap());

    expect(clipById(fx.b).startSample).toBe(1500);
    expect(clipById(fx.c).startSample).toBe(2100);
    // The clip before the gap, and the whole other track, are the SAME objects
    // — "localized" measured by reference, not by deep equality.
    expect(clipById(fx.a)).toBe(beforeA);
    expect(clipById(fx.d)).toBe(beforeD);
    // The other track's clip LIST is deep-equal too — `moveClip` rebuilds every
    // track's array on every commit, so the reference is expected to change
    // while nothing in it does.
    expect(clipsOf(1)).toEqual(beforeTrack2);
    // The leftmost-first order, measured. Every shift goes through `moveClip`,
    // which runs `maintainFacingFades` on each commit — so a shift that passed
    // THROUGH a clip that had not moved yet would arm a crossfade the gesture
    // never asked for. Left to right, each clip moves into space already
    // vacated, and the closed gap leaves B butt-joined to A rather than over
    // it, so no edge fade may exist anywhere on the track afterwards.
    for (const clip of clipsOf(0)) {
      expect(clip.fadeInSample).toBeUndefined();
      expect(clip.fadeOutSample).toBeUndefined();
    }
  });

  it('is ONE undo entry labeled Close gap, and undo puts the timeline back', () => {
    const before = store().session;
    store().setSelectedGap(theGap());

    closeGap(theGap());

    expect(doneLabels()).toEqual(['Close gap']);
    undoSession();
    expect(store().session).toBe(before);
  });

  it('clears the gap selection once it is closed', () => {
    store().setSelectedGap(theGap());

    closeGap(theGap());

    expect(store().selectedGap).toBeNull();
  });

  it('closes the LEADING gap too — every clip on the track moves up', () => {
    const leading = gapAt(store().session.tracks[0], 500)!;
    store().setSelectedGap(leading);

    closeGap(leading);

    expect(clipById(fx.a).startSample).toBe(0);
    expect(clipById(fx.b).startSample).toBe(1000);
    expect(clipById(fx.c).startSample).toBe(1600);
    expect(clipById(fx.d).startSample).toBe(2200); // the other track never moves
    expect(doneLabels()).toEqual(['Close gap']);
  });

  it('is a NO-OP — no gesture at all — for a gap the track no longer has', () => {
    const stale = { trackId: store().session.tracks[0].id, startSample: 1500, endSample: 3000 };
    const before = store().session;

    closeGap(stale);

    expect(store().session).toBe(before);
    expect(doneLabels()).toEqual([]);
  });

  it('is a no-op for a track that is gone', () => {
    const before = store().session;

    closeGap({ trackId: 'track-nope', startSample: 1500, endSample: 2000 });

    expect(store().session).toBe(before);
    expect(doneLabels()).toEqual([]);
  });
});

describe('the gap selection is reconciled against the session', () => {
  it('a removeClip that redraws the span clears it', () => {
    store().setSelectedGap(theGap());

    store().removeClip(fx.a); // the gap becomes [0, 2000) — a different span

    expect(gapAt(store().session.tracks[0], 1700)).toEqual({
      trackId: store().session.tracks[0].id,
      startSample: 0,
      endSample: 2000,
    });
    expect(store().selectedGap).toBeNull();
  });

  it('a removeTrack under the gap clears it', () => {
    store().setSelectedGap(theGap());

    store().removeTrack(store().session.tracks[0].id);

    expect(store().selectedGap).toBeNull();
  });

  it('a change on ANOTHER track leaves it standing', () => {
    const gap = theGap();
    store().setSelectedGap(gap);

    store().moveClip(fx.d, store().session.tracks[1].id, 5000);

    expect(store().selectedGap).toEqual(gap);
  });
});

describe('ruling 3 — the gap is view state, on disk and in the snapshot', () => {
  it('SessionSnapshot carries no gap: undoing an unrelated gesture leaves it as it was', () => {
    store().moveClip(fx.d, store().session.tracks[1].id, 5000); // one recorded entry
    const gap = theGap();
    store().setSelectedGap(gap);

    undoSession();

    expect(doneLabels()).toEqual([]);
    expect(store().selectedGap).toEqual(gap); // the undo restored no gap, and stole none
  });

  it('serializeSession writes the same bytes with and without a selected gap', () => {
    const without = serializeSession(store().session, []).json;

    store().setSelectedGap(theGap());
    const withGap = serializeSession(store().session, []).json;

    expect(withGap).toBe(without);
  });
});
