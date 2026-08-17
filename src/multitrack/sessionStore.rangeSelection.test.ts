import { createClip, createTrack, type Session } from './session';
import { useSessionStore } from './sessionStore';
import { _resetSessionUndo } from './sessionUndo';

/**
 * T5 — the two SET writers K1 left un-built: the one Ctrl+A needs (name the
 * whole selection at once) and the one Shift+Click needs (extend the selection
 * from the primary to a clip on the same track).
 *
 * Both obey K1's two invariants unchanged — primary null iff the set is empty,
 * and a non-null primary is always a member — and neither records an undo
 * entry, because a selection is still view state (`sessionStore.selection.test.ts`
 * holds the ruling-3 pin over the snapshot).
 */

const store = () => useSessionStore.getState();

/**
 * Track 1 carries FOUR clips, deliberately out of array order (b is written
 * before a, and d before c): a range select is defined over START ORDER, and a
 * fixture whose array order already equals its start order cannot tell the two
 * apart. Track 2 carries one clip, which is the cross-track arm.
 */
function seed(): { session: Session; a: string; b: string; c: string; d: string; e: string } {
  const t1 = createTrack('Track 1');
  const t2 = createTrack('Track 2');
  const mk = (startSample: number) =>
    createClip({ documentId: 'doc-1', startSample, offsetSample: 0, lengthSample: 1000 });
  const b = mk(4000);
  const a = mk(0);
  const d = mk(12000);
  const c = mk(8000);
  t1.clips = [b, a, d, c];
  const e = createClip({
    documentId: 'doc-2',
    startSample: 4000,
    offsetSample: 0,
    lengthSample: 1000,
  });
  t2.clips = [e];
  const session: Session = { name: 'Range Fixture', sampleRate: 44100, tracks: [t1, t2] };
  useSessionStore.setState({
    session,
    selectedClipId: null,
    selectedClipIds: [],
    mtCursorSample: 0,
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
  });
  return { session, a: a.id, b: b.id, c: c.id, d: d.id, e: e.id };
}

let fx: ReturnType<typeof seed>;

beforeEach(() => {
  _resetSessionUndo();
  fx = seed();
});

describe('setSelectedClips — the whole selection, named at once (Ctrl+A)', () => {
  it('selects every id it is given', () => {
    store().setSelectedClips([fx.a, fx.b, fx.e]);
    expect(store().selectedClipIds).toEqual([fx.a, fx.b, fx.e]);
  });

  it('KEEPS the standing primary when the new set still holds it', () => {
    // The Properties panel reads the primary's fields. Ctrl+A over a selection
    // that already had one must not make the panel jump to a different clip.
    store().setSelectedClip(fx.b);
    store().setSelectedClips([fx.a, fx.b, fx.c]);
    expect(store().selectedClipId).toBe(fx.b);
  });

  it('takes the LAST id as primary when the standing one is not in the new set', () => {
    store().setSelectedClip(fx.e);
    store().setSelectedClips([fx.a, fx.b]);
    expect(store().selectedClipId).toBe(fx.b);
  });

  it('drops ids no clip carries, and de-duplicates', () => {
    store().setSelectedClips([fx.a, 'ghost', fx.a, fx.b]);
    expect(store().selectedClipIds).toEqual([fx.a, fx.b]);
  });

  it('an empty set clears the primary too', () => {
    store().setSelectedClip(fx.a);
    store().setSelectedClips([]);
    expect(store().selectedClipId).toBeNull();
    expect(store().selectedClipIds).toEqual([]);
  });

  it('re-committing the selection it already holds returns the SAME state', () => {
    store().setSelectedClips([fx.a, fx.b]);
    const held = useSessionStore.getState();
    store().setSelectedClips([fx.a, fx.b]);
    expect(useSessionStore.getState()).toBe(held);
    expect(useSessionStore.getState().selectedClipIds).toBe(held.selectedClipIds);
  });

  it('records no undo entry', () => {
    const before = store().session;
    store().setSelectedClips([fx.a, fx.b]);
    expect(store().session).toBe(before);
  });
});

describe('extendSelectionToClip — the primary-to-here range (Shift+Click)', () => {
  it('takes every clip between the primary and the target BY START ORDER', () => {
    store().setSelectedClip(fx.a); // start 0
    store().extendSelectionToClip(fx.c); // start 8000 — b (4000) lies between
    expect([...store().selectedClipIds].sort()).toEqual([fx.a, fx.b, fx.c].sort());
    expect(store().selectedClipIds).not.toContain(fx.d);
  });

  it('runs BACKWARDS just as well — the primary may be the later clip', () => {
    store().setSelectedClip(fx.d); // start 12000
    store().extendSelectionToClip(fx.b); // start 4000
    expect([...store().selectedClipIds].sort()).toEqual([fx.b, fx.c, fx.d].sort());
    expect(store().selectedClipIds).not.toContain(fx.a);
  });

  it('makes the CLICKED clip the primary', () => {
    store().setSelectedClip(fx.a);
    store().extendSelectionToClip(fx.c);
    expect(store().selectedClipId).toBe(fx.c);
  });

  it('EXTENDS rather than replaces — a Ctrl+Click set survives the range', () => {
    store().toggleSelectedClip(fx.e); // a foreign-track member, built by Ctrl+Click
    store().toggleSelectedClip(fx.a);
    store().extendSelectionToClip(fx.b);
    expect(store().selectedClipIds).toContain(fx.e);
    expect([...store().selectedClipIds].sort()).toEqual([fx.a, fx.b, fx.e].sort());
  });

  it('a CROSS-TRACK target behaves as a plain click', () => {
    store().setSelectedClip(fx.a); // track 1
    store().extendSelectionToClip(fx.e); // track 2
    expect(store().selectedClipIds).toEqual([fx.e]);
    expect(store().selectedClipId).toBe(fx.e);
  });

  it('with NO primary it behaves as a plain click', () => {
    store().extendSelectionToClip(fx.c);
    expect(store().selectedClipIds).toEqual([fx.c]);
    expect(store().selectedClipId).toBe(fx.c);
  });

  it('the target being the primary itself selects just it', () => {
    store().setSelectedClip(fx.a);
    store().extendSelectionToClip(fx.a);
    expect(store().selectedClipIds).toEqual([fx.a]);
    expect(store().selectedClipId).toBe(fx.a);
  });

  it('an id no clip carries changes nothing', () => {
    store().setSelectedClip(fx.a);
    const held = useSessionStore.getState();
    store().extendSelectionToClip('ghost');
    expect(useSessionStore.getState()).toBe(held);
  });

  it('records no undo entry', () => {
    const before = store().session;
    store().setSelectedClip(fx.a);
    store().extendSelectionToClip(fx.c);
    expect(store().session).toBe(before);
  });
});
