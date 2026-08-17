import { createClip, createTrack, type Session } from './session';
import { useSessionStore } from './sessionStore';
import { _resetSessionUndo, undoSession } from './sessionUndo';

/**
 * K1 R2 — the multi-clip selection, which is VIEW STATE beside the primary
 * `selectedClipId` and not a second source of truth for it. Two invariants are
 * pinned throughout, and everything else follows from them:
 *
 *   1. `selectedClipId === null` iff `selectedClipIds` is empty.
 *   2. a non-null primary is always a member of `selectedClipIds`.
 *
 * The ruling-3 pin (a session undo restores `{session, selectedClipId}` and
 * NOTHING else) gets its own test at the bottom: the extended set is
 * reconciled against the restored session, never remembered by the snapshot.
 */

const store = () => useSessionStore.getState();

/** Three clips: a and b on track 1, c on track 2. `session` is the object the
 * store was seeded with, so a test can build a "reloaded" copy of it. */
function seed(): { session: Session; a: string; b: string; c: string } {
  const t1 = createTrack('Track 1');
  const t2 = createTrack('Track 2');
  t1.clips = [
    createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 1000 }),
    createClip({ documentId: 'doc-1', startSample: 4000, offsetSample: 0, lengthSample: 1000 }),
  ];
  t2.clips = [
    createClip({ documentId: 'doc-2', startSample: 8000, offsetSample: 0, lengthSample: 1000 }),
  ];
  const session: Session = { name: 'Selection Fixture', sampleRate: 44100, tracks: [t1, t2] };
  useSessionStore.setState({
    session,
    selectedClipId: null,
    selectedClipIds: [],
    mtCursorSample: 0,
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
  });
  return { session, a: t1.clips[0].id, b: t1.clips[1].id, c: t2.clips[0].id };
}

let fx: ReturnType<typeof seed>;

beforeEach(() => {
  _resetSessionUndo();
  fx = seed();
});

describe('the primary selection carries the set with it', () => {
  it('a fresh session selects nothing', () => {
    store().newSession(44100);
    expect(store().selectedClipId).toBeNull();
    expect(store().selectedClipIds).toEqual([]);
  });

  it('setSelectedClip is a SINGLE select — it replaces the whole set', () => {
    store().toggleSelectedClip(fx.a);
    store().toggleSelectedClip(fx.b);
    expect(store().selectedClipIds).toEqual([fx.a, fx.b]);

    store().setSelectedClip(fx.c);
    expect(store().selectedClipId).toBe(fx.c);
    expect(store().selectedClipIds).toEqual([fx.c]);
  });

  it('setSelectedClip(null) empties the set', () => {
    store().setSelectedClip(fx.a);
    store().setSelectedClip(null);
    expect(store().selectedClipId).toBeNull();
    expect(store().selectedClipIds).toEqual([]);
  });

  // The no-op guard the rest of this store already spells for its session
  // writers, needed here for the same kind of reason. `TrackLane` calls
  // `setSelectedClip(null)` on EVERY empty-lane press, and a fresh `[]` each
  // time would be a new array for every clip's subscription to see — a repaint
  // of the whole timeline for a click that changed nothing.
  it('re-committing the selection it already holds returns the SAME state', () => {
    store().setSelectedClip(fx.a);
    const held = useSessionStore.getState();
    store().setSelectedClip(fx.a);
    expect(useSessionStore.getState()).toBe(held);
    expect(useSessionStore.getState().selectedClipIds).toBe(held.selectedClipIds);

    store().setSelectedClip(null);
    const cleared = useSessionStore.getState();
    store().setSelectedClip(null);
    expect(useSessionStore.getState()).toBe(cleared);
  });

  it('still collapses a MULTI selection down to the clip it names', () => {
    // The guard must compare the whole selection, not just the primary: the
    // primary is already `a` here and the set must still shrink to [a].
    store().setSelectedClip(fx.b);
    store().toggleSelectedClip(fx.a);
    expect(store().selectedClipIds).toEqual([fx.b, fx.a]);

    store().setSelectedClip(fx.a);
    expect(store().selectedClipIds).toEqual([fx.a]);
  });
});

describe('toggleSelectedClip (Ctrl+Click)', () => {
  it('adds a clip to the set and makes it the primary — last clicked wins', () => {
    store().setSelectedClip(fx.a);
    store().toggleSelectedClip(fx.b);
    expect(store().selectedClipIds).toEqual([fx.a, fx.b]);
    expect(store().selectedClipId).toBe(fx.b);
  });

  it('reaches across tracks', () => {
    store().setSelectedClip(fx.a);
    store().toggleSelectedClip(fx.c);
    expect(store().selectedClipIds).toEqual([fx.a, fx.c]);
  });

  it('toggles the primary back OUT and promotes the last remaining member', () => {
    store().setSelectedClip(fx.a);
    store().toggleSelectedClip(fx.b);
    store().toggleSelectedClip(fx.b);
    expect(store().selectedClipIds).toEqual([fx.a]);
    expect(store().selectedClipId).toBe(fx.a);
  });

  it('toggles a NON-primary out and leaves the primary alone', () => {
    store().setSelectedClip(fx.a);
    store().toggleSelectedClip(fx.b);
    store().toggleSelectedClip(fx.a);
    expect(store().selectedClipIds).toEqual([fx.b]);
    expect(store().selectedClipId).toBe(fx.b);
  });

  it('toggling out the only member selects nothing', () => {
    store().toggleSelectedClip(fx.a);
    store().toggleSelectedClip(fx.a);
    expect(store().selectedClipIds).toEqual([]);
    expect(store().selectedClipId).toBeNull();
  });

  it('ignores an id no clip in the session carries', () => {
    store().setSelectedClip(fx.a);
    store().toggleSelectedClip('clip-does-not-exist');
    expect(store().selectedClipIds).toEqual([fx.a]);
    expect(store().selectedClipId).toBe(fx.a);
  });

  it('records no undo entry — a selection is view state, not a session edit', () => {
    const before = store().session;
    store().toggleSelectedClip(fx.a);
    expect(store().session).toBe(before);
  });
});

describe('a member whose clip is gone is not a member, whatever removed it', () => {
  it('removeClip drops a NON-primary member and leaves the primary alone', () => {
    store().setSelectedClip(fx.b);
    store().toggleSelectedClip(fx.a); // primary = a
    store().removeClip(fx.b);
    expect(store().selectedClipIds).toEqual([fx.a]);
    expect(store().selectedClipId).toBe(fx.a);
  });

  it('removeClip of the only member still selects nothing (the pre-K1 behaviour)', () => {
    store().setSelectedClip(fx.a);
    store().removeClip(fx.a);
    expect(store().selectedClipIds).toEqual([]);
    expect(store().selectedClipId).toBeNull();
  });

  it('removing the PRIMARY clears the whole selection — the set never invents one', () => {
    // The reconcile follows the primary and only ever removes references; it
    // must never promote, or a session load (whose clip ids are preserved on
    // disk) would have its explicit `selectedClipId: null` overridden by a
    // stale member and hand back a selection nobody made.
    store().setSelectedClip(fx.a);
    store().toggleSelectedClip(fx.b); // primary = b
    store().removeClip(fx.b);
    expect(store().selectedClipId).toBeNull();
    expect(store().selectedClipIds).toEqual([]);
  });

  it('a reloaded session whose clip ids repeat does not resurrect the old selection', () => {
    // What `sessionFile.openSession` does: replace the session and state that
    // nothing is selected — with clip ids that came back verbatim off disk.
    store().setSelectedClip(fx.a);
    store().toggleSelectedClip(fx.b);
    const reloaded: Session = {
      ...fx.session,
      tracks: fx.session.tracks.map((t) => ({ ...t, clips: [...t.clips] })),
    };
    useSessionStore.setState({ session: reloaded, selectedClipId: null });
    expect(store().selectedClipId).toBeNull();
    expect(store().selectedClipIds).toEqual([]);
  });

  it('removeTrack drops every member that lived on it', () => {
    store().setSelectedClip(fx.a);
    store().toggleSelectedClip(fx.b);
    store().toggleSelectedClip(fx.c); // primary = c, on the surviving track
    store().removeTrack(store().session.tracks[0].id);
    expect(store().selectedClipIds).toEqual([fx.c]);
    expect(store().selectedClipId).toBe(fx.c);
  });
});

describe('ruling 3 — the snapshot carries {session, selectedClipId} and nothing else', () => {
  it('an undo that restores the primary heals the invariant instead of remembering a set', () => {
    // Three members, primary c. A rename records an entry with THAT primary.
    store().setSelectedClip(fx.a);
    store().toggleSelectedClip(fx.b);
    store().toggleSelectedClip(fx.c);
    store().renameTrack(store().session.tracks[0].id, 'Lead');

    // Then the user single-selects a: the set shrinks to exactly [a].
    store().setSelectedClip(fx.a);
    expect(store().selectedClipIds).toEqual([fx.a]);

    undoSession();
    // The snapshot's primary comes back, and the set is reconciled to contain
    // it. If `selectedClipIds` rode the snapshot this would be [a, b, c] —
    // b was never re-selected, and nothing may re-select it.
    expect(store().selectedClipId).toBe(fx.c);
    expect(store().selectedClipIds).toEqual([fx.a, fx.c]);
  });

  it('undoing a removal re-selects the clip and puts it back in the set', () => {
    store().setSelectedClip(fx.a);
    store().removeClip(fx.a);
    expect(store().selectedClipIds).toEqual([]);

    undoSession();
    expect(store().selectedClipId).toBe(fx.a);
    expect(store().selectedClipIds).toEqual([fx.a]);
  });

  it('undo leaves the cursor, zoom, transport and playhead untouched (unchanged pin)', () => {
    useSessionStore.setState({ mtCursorSample: 777, mtPlayheadSample: 555 });
    store().setSelectedClip(fx.a);
    store().removeClip(fx.a);
    undoSession();
    expect(store().mtCursorSample).toBe(777);
    expect(store().mtPlayheadSample).toBe(555);
    expect(store().mtPlayState).toBe('stopped');
  });
});
