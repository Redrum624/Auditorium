import { Profiler } from 'react';
import { act, render } from '@testing-library/react';
import ClipView from './ClipView';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import type { Clip } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { SESSION_UNDO_KEY, _resetSessionUndo } from '../../multitrack/sessionUndo';
import { getHistory } from '../../services/undoHistory';
import { _resetSnapPreference, setSnapEnabled } from '../../services/snapPreference';
import { makeInitialState, useAppStore } from '../../stores/appStore';

/**
 * K1 R2 — Ctrl+Click multi-select and the group drag, driven through
 * ClipView's REAL pointer handlers.
 *
 * THE MODIFIER RULING, which these tests exist to hold: `Ctrl` already meant
 * "push clear of the overlap" at the DROP (X5), and it now also means "toggle
 * this clip in the selection" on a CLICK. The two never collide because a
 * click and a drag are different gestures — the selection commit happens at
 * pointerup and only when the pointer never exceeded the drag threshold, so a
 * Ctrl-held drag is still exactly the nudge it was.
 *
 * The second half of the ruling is that a press on a clip already IN the
 * selection commits nothing at press time: collapsing the selection there
 * would destroy the group before the drag that was about to move it.
 */

const SPP = 100; // 1 CSS px == 100 samples
/** Clip-local x of a body grab. Every fixture clip below is 20 000 samples =
 * 200 px wide, and the outer 6 px at each edge are the trim handles. */
const GRAB_X = 100;
const SESSION_RATE = 44_100;

function firePointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: { clientX: number; clientY?: number; button?: number; ctrlKey?: boolean }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY ?? 0,
    button: init.button ?? 0,
    ctrlKey: init.ctrlKey ?? false,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

let doc: AudioDocument;

const store = () => useSessionStore.getState();
const doneLabels = () => getHistory(SESSION_UNDO_KEY).done;

/** Selection writes go through act(): ClipView subscribes to the extended
 * selection, so a write outside act would leave the component rendered with a
 * stale set — and its pointer handlers read that set to decide what the press
 * means. */
function select(fn: () => void): void {
  act(fn);
}

function clipOf(id: string, startSample: number, lengthSample: number): Clip {
  return { id, documentId: doc.id, startSample, offsetSample: 0, lengthSample, gainDb: 0 };
}

function clipById(id: string): Clip | undefined {
  for (const t of store().session.tracks) {
    const c = t.clips.find((x) => x.id === id);
    if (c) return c;
  }
  return undefined;
}

function startOf(id: string): number | undefined {
  return clipById(id)?.startSample;
}

/** Seeds `clips` (one entry per track index) and renders the named one. */
function mount(
  seed: { trackIdx: number; clip: Clip }[],
  renderId: string
): HTMLElement {
  const s = store();
  for (const { trackIdx, clip } of seed) {
    s.addClip(useSessionStore.getState().session.tracks[trackIdx].id, clip);
  }
  const target = seed.find((x) => x.clip.id === renderId)!;
  const trackId = useSessionStore.getState().session.tracks[target.trackIdx].id;
  const { container } = render(
    <ClipView
      clip={target.clip}
      doc={doc}
      trackId={trackId}
      zoom={{ samplesPerPixel: SPP, scrollSample: 0 }}
      sessionRate={SESSION_RATE}
      laneHeight={96}
      selected={useSessionStore.getState().selectedClipId === target.clip.id}
      resolveTrackAt={() => trackId}
      onDragOverTrack={() => {}}
    />
  );
  _resetSessionUndo();
  return container.querySelector('[data-testid="clip"]') as HTMLElement;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(SESSION_RATE);
  _resetSnapPreference();
  setSnapEnabled(false); // deterministic drag arithmetic; the magnet is not under test
  doc = createDocument({
    name: 'src.wav',
    sampleRate: SESSION_RATE,
    channels: [new Float32Array(400_000)],
  });
  useAppStore.getState().addDocument(doc);
});

afterEach(() => {
  _resetSnapPreference();
});

describe('clicking', () => {
  it('a plain click selects only that clip (unchanged)', () => {
    const el = mount([{ trackIdx: 0, clip: clipOf('a', 0, 20_000) }], 'a');
    firePointer(el, 'pointerdown', { clientX: 100 });
    firePointer(el, 'pointerup', { clientX: 100 });
    expect(store().selectedClipId).toBe('a');
    expect(store().selectedClipIds).toEqual(['a']);
  });

  it('Ctrl+Click adds the clip to the selection and makes it the primary', () => {
    const el = mount(
      [
        { trackIdx: 0, clip: clipOf('a', 0, 20_000) },
        { trackIdx: 1, clip: clipOf('b', 0, 20_000) },
      ],
      'b'
    );
    select(() => store().setSelectedClip('a'));

    firePointer(el, 'pointerdown', { clientX: 100, ctrlKey: true });
    firePointer(el, 'pointerup', { clientX: 100, ctrlKey: true });
    expect(store().selectedClipIds).toEqual(['a', 'b']);
    expect(store().selectedClipId).toBe('b');
  });

  it('Ctrl+Click on a member takes it back OUT of the selection', () => {
    const el = mount(
      [
        { trackIdx: 0, clip: clipOf('a', 0, 20_000) },
        { trackIdx: 1, clip: clipOf('b', 0, 20_000) },
      ],
      'b'
    );
    select(() => store().setSelectedClip('a'));
    select(() => store().toggleSelectedClip('b'));

    firePointer(el, 'pointerdown', { clientX: 100, ctrlKey: true });
    firePointer(el, 'pointerup', { clientX: 100, ctrlKey: true });
    expect(store().selectedClipIds).toEqual(['a']);
    expect(store().selectedClipId).toBe('a');
  });

  it('a plain click on a member COLLAPSES the selection to that clip', () => {
    const el = mount(
      [
        { trackIdx: 0, clip: clipOf('a', 0, 20_000) },
        { trackIdx: 1, clip: clipOf('b', 0, 20_000) },
      ],
      'b'
    );
    select(() => store().setSelectedClip('a'));
    select(() => store().toggleSelectedClip('b'));

    firePointer(el, 'pointerdown', { clientX: 100 });
    firePointer(el, 'pointerup', { clientX: 100 });
    expect(store().selectedClipIds).toEqual(['b']);
  });

  it('presses on a member commit NOTHING until the pointer is released', () => {
    // The group must survive the press, or the drag that is about to start
    // would have nothing left to move.
    const el = mount(
      [
        { trackIdx: 0, clip: clipOf('a', 0, 20_000) },
        { trackIdx: 1, clip: clipOf('b', 0, 20_000) },
      ],
      'b'
    );
    select(() => store().setSelectedClip('a'));
    select(() => store().toggleSelectedClip('b'));

    firePointer(el, 'pointerdown', { clientX: 100 });
    expect(store().selectedClipIds).toEqual(['a', 'b']);
  });

  it('renders the selected chrome for a member that is not the primary', () => {
    const el = mount(
      [
        { trackIdx: 0, clip: clipOf('a', 0, 20_000) },
        { trackIdx: 1, clip: clipOf('b', 0, 20_000) },
      ],
      'b'
    );
    expect(el.style.borderColor).toBe('var(--accent-ring)'); // idle

    // b first, then Ctrl+Click a: the set holds both and the PRIMARY is a, so
    // b is a member that is not the primary. It was mounted with
    // `selected={false}` and never re-mounted, which is what makes this an
    // assertion about the extended set rather than about the prop.
    select(() => store().setSelectedClip('b'));
    select(() => store().toggleSelectedClip('a'));
    expect(store().selectedClipIds).toEqual(['b', 'a']);
    expect(store().selectedClipId).toBe('a');
    expect(el.style.borderColor).toBe('var(--accent)');
  });
});

describe('dragging', () => {
  it('a Ctrl-held DRAG is still the push-clear nudge, not a selection toggle', () => {
    // The clip is already selected; Ctrl through the whole gesture must not
    // deselect it, and the drop must still push clear of the overlap.
    const el = mount(
      [
        { trackIdx: 0, clip: clipOf('dragged', 0, 20_000) },
        { trackIdx: 0, clip: clipOf('other', 100_000, 100_000) },
      ],
      'dragged'
    );
    select(() => store().setSelectedClip('dragged'));

    // GRAB_X sits in the clip body: the 6 px bands at either edge are the
    // trim handles, and jsdom reports a zero-origin rect, so clientX IS the
    // clip-local x here.
    firePointer(el, 'pointerdown', { clientX: GRAB_X, ctrlKey: true });
    firePointer(el, 'pointermove', { clientX: GRAB_X + 1050, ctrlKey: true });
    firePointer(el, 'pointerup', { clientX: GRAB_X + 1050, ctrlKey: true });

    // 1050 px * 100 spp = 105 000, which overlaps `other` at [100 000, 200 000)
    // — the Ctrl nudge pushes the dragged clip clear, to its end.
    expect(startOf('dragged')).toBe(200_000);
    expect(store().selectedClipIds).toEqual(['dragged']);
  });

  it('dragging a member moves EVERY member by the same delta, in one entry', () => {
    const el = mount(
      [
        { trackIdx: 0, clip: clipOf('a', 0, 20_000) },
        { trackIdx: 1, clip: clipOf('b', 50_000, 20_000) },
      ],
      'a'
    );
    select(() => store().setSelectedClip('a'));
    select(() => store().toggleSelectedClip('b'));
    _resetSessionUndo();

    firePointer(el, 'pointerdown', { clientX: GRAB_X });
    firePointer(el, 'pointermove', { clientX: GRAB_X + 100 });
    firePointer(el, 'pointerup', { clientX: GRAB_X + 100 });

    expect(startOf('a')).toBe(10_000);
    expect(startOf('b')).toBe(60_000);
    expect(doneLabels()).toEqual(['Move clips']);
  });

  it('a group drag leaves the selection exactly as it was', () => {
    const el = mount(
      [
        { trackIdx: 0, clip: clipOf('a', 0, 20_000) },
        { trackIdx: 1, clip: clipOf('b', 50_000, 20_000) },
      ],
      'a'
    );
    select(() => store().setSelectedClip('a'));
    select(() => store().toggleSelectedClip('b'));

    firePointer(el, 'pointerdown', { clientX: GRAB_X });
    firePointer(el, 'pointermove', { clientX: GRAB_X + 100 });
    firePointer(el, 'pointerup', { clientX: GRAB_X + 100 });

    expect(store().selectedClipIds).toEqual(['a', 'b']);
    expect(store().selectedClipId).toBe('b');
  });

  it('dragging a clip that is NOT in the selection moves that clip alone', () => {
    const el = mount(
      [
        { trackIdx: 0, clip: clipOf('a', 0, 20_000) },
        { trackIdx: 1, clip: clipOf('b', 50_000, 20_000) },
      ],
      'a'
    );
    select(() => store().setSelectedClip('b'));
    _resetSessionUndo();

    firePointer(el, 'pointerdown', { clientX: GRAB_X });
    firePointer(el, 'pointermove', { clientX: GRAB_X + 100 });
    firePointer(el, 'pointerup', { clientX: GRAB_X + 100 });

    expect(startOf('a')).toBe(10_000);
    expect(startOf('b')).toBe(50_000); // untouched
    expect(doneLabels()).toEqual(['Move clip']);
    expect(store().selectedClipIds).toEqual(['a']); // what you dragged is selected
  });

  it('a single-clip drag still records the entry a single drag has always recorded', () => {
    const el = mount([{ trackIdx: 0, clip: clipOf('a', 0, 20_000) }], 'a');
    firePointer(el, 'pointerdown', { clientX: GRAB_X });
    firePointer(el, 'pointermove', { clientX: GRAB_X + 100 });
    firePointer(el, 'pointerup', { clientX: GRAB_X + 100 });
    expect(doneLabels()).toEqual(['Move clip']);
  });

  // Fix round 1, I1. The group branch deliberately passes no `clearOverlap`,
  // so a held Ctrl has NO nudge on a multi-clip drag — the rigidity that makes
  // the group one gesture is worth more than a per-member push, and a push
  // applied to only the colliding member would deform the group. Pinned here
  // because the only user-facing statement about the modifier used to say the
  // opposite; the doc row now matches this test.
  it('Ctrl at the drop of a GROUP drag does not push clear — the group commits verbatim', () => {
    const el = mount(
      [
        { trackIdx: 0, clip: clipOf('a', 0, 20_000) },
        { trackIdx: 0, clip: clipOf('blocker', 100_000, 200_000) }, // NOT selected
        { trackIdx: 1, clip: clipOf('b', 0, 20_000) },
      ],
      'a'
    );
    select(() => store().setSelectedClip('a'));
    select(() => store().toggleSelectedClip('b'));

    firePointer(el, 'pointerdown', { clientX: GRAB_X, ctrlKey: true });
    firePointer(el, 'pointermove', { clientX: GRAB_X + 1050, ctrlKey: true });
    firePointer(el, 'pointerup', { clientX: GRAB_X + 1050, ctrlKey: true });

    // 1050 px * 100 spp = 105 000. `a` lands INSIDE `blocker` [100 000,
    // 300 000) instead of being pushed to its end, and `b` moved by the very
    // same delta — the group stayed rigid.
    expect(startOf('a')).toBe(105_000);
    expect(startOf('b')).toBe(105_000);
    expect(startOf('blocker')).toBe(100_000);
  });
});

describe('the fade corner handles', () => {
  /** Mounts `renderId` with `selected` forced on, so its corner handles exist. */
  function mountWithHandles(seed: { trackIdx: number; clip: Clip }[], renderId: string): HTMLElement {
    const s = store();
    for (const { trackIdx, clip } of seed) {
      s.addClip(useSessionStore.getState().session.tracks[trackIdx].id, clip);
    }
    const target = seed.find((x) => x.clip.id === renderId)!;
    const trackId = useSessionStore.getState().session.tracks[target.trackIdx].id;
    const { container } = render(
      <ClipView
        clip={target.clip}
        doc={doc}
        trackId={trackId}
        zoom={{ samplesPerPixel: SPP, scrollSample: 0 }}
        sessionRate={SESSION_RATE}
        laneHeight={96}
        selected={true}
        resolveTrackAt={() => trackId}
        onDragOverTrack={() => {}}
      />
    );
    _resetSessionUndo();
    return container.querySelector('[data-testid="fade-handle-in"]') as HTMLElement;
  }

  // Fix round 1, I2. Grabbing a fade corner is an EDIT gesture on one clip, not
  // a selection act — the same rule the trim bands already follow. Before this
  // it called `setSelectedClip`, which under K1 IS the whole selection, so
  // touching the primary's corner silently dropped every other member and a
  // following Delete took one clip instead of N.
  it('grabbing the corner of a clip already in the selection keeps the whole set', () => {
    const handle = mountWithHandles(
      [
        { trackIdx: 0, clip: clipOf('a', 0, 20_000) },
        { trackIdx: 1, clip: clipOf('b', 0, 20_000) },
      ],
      'a'
    );
    select(() => store().setSelectedClip('b'));
    select(() => store().toggleSelectedClip('a')); // primary = a, set = [b, a]

    firePointer(handle, 'pointerdown', { clientX: 0 });
    firePointer(handle, 'pointerup', { clientX: 0 });

    expect(store().selectedClipIds).toEqual(['b', 'a']);
    expect(store().selectedClipId).toBe('a');
  });

  it('a fade drag on a member still edits only that clip, and still keeps the set', () => {
    const handle = mountWithHandles(
      [
        { trackIdx: 0, clip: clipOf('a', 0, 20_000) },
        { trackIdx: 1, clip: clipOf('b', 0, 20_000) },
      ],
      'a'
    );
    select(() => store().setSelectedClip('b'));
    select(() => store().toggleSelectedClip('a'));

    firePointer(handle, 'pointerdown', { clientX: 0 });
    firePointer(handle, 'pointermove', { clientX: 50 });
    firePointer(handle, 'pointerup', { clientX: 50 });

    // 50 px * 100 spp = 5 000 samples of fade-in on the primary only.
    expect(clipById('a')!.fadeInSample).toBe(5_000);
    expect(clipById('b')!.fadeInSample).toBeUndefined();
    expect(store().selectedClipIds).toEqual(['b', 'a']);
  });

  it('grabbing the corner of a clip that is NOT selected selects it, as before', () => {
    const handle = mountWithHandles(
      [
        { trackIdx: 0, clip: clipOf('a', 0, 20_000) },
        { trackIdx: 1, clip: clipOf('b', 0, 20_000) },
      ],
      'a'
    );
    select(() => store().setSelectedClip('b')); // `a` is not in the selection

    firePointer(handle, 'pointerdown', { clientX: 0 });
    firePointer(handle, 'pointerup', { clientX: 0 });

    expect(store().selectedClipId).toBe('a');
    expect(store().selectedClipIds).toEqual(['a']);
  });
});

/**
 * T1 (K1 review, Minor M3) — WHAT A SELECTION WRITE COSTS THE TIMELINE.
 *
 * K1 gave every ClipView a subscription to `selectedClipIds`, whose ARRAY
 * IDENTITY changes on every selection write; before K1 only the two clips whose
 * `selected` prop flipped re-rendered. So Ctrl+Clicking one clip re-rendered
 * every clip in the session — React reconcile only (the canvas draws are
 * dep-gated), but it grows with the clip count, which is exactly the direction
 * a timeline grows in.
 *
 * The fix is to subscribe to THIS clip's membership — a boolean — so the store
 * write only reaches the clips whose answer changed. The handlers still need the
 * whole set, and read it from `getState()` at pointerdown, which is where they
 * capture it anyway (the set must not change under the user's hand mid-drag).
 *
 * `Profiler.onRender` fires once per commit INSIDE its subtree, so a render
 * zustand never scheduled is a callback that never fires — which is the
 * property under test, rather than a proxy for it.
 */
describe('a selection write reaches only the clips it changes', () => {
  /** Mounts `renderId` under a Profiler; the returned counter reads renders
   * SINCE the mount, so the mount's own commits are not in the number. */
  function mountCounted(seed: { trackIdx: number; clip: Clip }[], renderId: string): () => number {
    const s = store();
    for (const { trackIdx, clip } of seed) {
      s.addClip(useSessionStore.getState().session.tracks[trackIdx].id, clip);
    }
    const target = seed.find((x) => x.clip.id === renderId)!;
    const trackId = useSessionStore.getState().session.tracks[target.trackIdx].id;
    let renders = 0;
    render(
      <Profiler
        id={renderId}
        onRender={() => {
          renders += 1;
        }}
      >
        <ClipView
          clip={target.clip}
          doc={doc}
          trackId={trackId}
          zoom={{ samplesPerPixel: SPP, scrollSample: 0 }}
          sessionRate={SESSION_RATE}
          laneHeight={96}
          selected={useSessionStore.getState().selectedClipId === target.clip.id}
          resolveTrackAt={() => trackId}
          onDragOverTrack={() => {}}
        />
      </Profiler>
    );
    _resetSessionUndo();
    const atMount = renders;
    return () => renders - atMount;
  }

  const three = () => [
    { trackIdx: 0, clip: clipOf('a', 0, 20_000) },
    { trackIdx: 0, clip: clipOf('b', 40_000, 20_000) },
    { trackIdx: 1, clip: clipOf('c', 0, 20_000) },
  ];

  it('leaves a clip that is in neither the old nor the new selection alone', () => {
    const renders = mountCounted(three(), 'a');

    select(() => store().setSelectedClip('b'));
    select(() => store().toggleSelectedClip('c'));
    select(() => store().toggleSelectedClip('c'));
    select(() => store().setSelectedClip(null));

    expect(renders()).toBe(0);
  });

  it('still re-renders the clip whose OWN membership changed, once per change', () => {
    const renders = mountCounted(three(), 'a');

    select(() => store().setSelectedClip('a')); // joins
    expect(renders()).toBe(1);

    select(() => store().toggleSelectedClip('b')); // `a` stays in: nothing to say
    expect(renders()).toBe(1);

    select(() => store().setSelectedClip('b')); // leaves
    expect(renders()).toBe(2);
  });
});

/**
 * T1 (K1 review, Minor M4) — A CANCELLED GESTURE COMMITS NOTHING.
 *
 * `onPointerCancel` was bound straight to `onPointerUp`, so a cancel routed
 * into the branches that decide what the gesture MEANT: a sub-threshold cancel
 * on a deferred press committed a selection toggle, and a cancel past the
 * threshold committed the move. A pointercancel is the platform saying the
 * gesture was taken away from the element (the OS claimed it for a scroll or a
 * gesture, the pointer device was lost) — the user never finished it, and an
 * interrupted press must not be read as a click.
 *
 * What a cancel still does is RELEASE: the trim/fade undo bracket opened at
 * pointerdown is closed (its live writes are already in the store, and leaving
 * the bracket open would fold the user's next act into this one), the pointer
 * capture is released, and the move preview is cleared.
 */
describe('a cancelled gesture', () => {
  it('commits no selection toggle for a press the user never completed', () => {
    const el = mount(
      [
        { trackIdx: 0, clip: clipOf('a', 0, 20_000) },
        { trackIdx: 1, clip: clipOf('b', 0, 20_000) },
      ],
      'a'
    );
    select(() => store().setSelectedClip('a'));
    select(() => store().toggleSelectedClip('b')); // set = [a, b]

    // Ctrl on a member: the press defers, so pointerup would have toggled.
    firePointer(el, 'pointerdown', { clientX: GRAB_X, ctrlKey: true });
    firePointer(el, 'pointercancel', { clientX: GRAB_X, ctrlKey: true });

    expect(store().selectedClipIds).toEqual(['a', 'b']);
    expect(store().selectedClipId).toBe('b');
  });

  it('commits no move for a drag the user never dropped', () => {
    const el = mount([{ trackIdx: 0, clip: clipOf('a', 0, 20_000) }], 'a');

    firePointer(el, 'pointerdown', { clientX: GRAB_X });
    firePointer(el, 'pointermove', { clientX: GRAB_X + 100 });
    firePointer(el, 'pointercancel', { clientX: GRAB_X + 100 });

    expect(startOf('a')).toBe(0);
    expect(doneLabels()).toEqual([]);
  });

  it('still closes the undo bracket a trim opened, so the next act is its own entry', () => {
    // Grabbed inside the 6 px trim-start band (jsdom's rect.left is 0, so the
    // clip-local x IS the clientX), and dragged far enough to write samples.
    const el = mount([{ trackIdx: 0, clip: clipOf('a', 0, 20_000) }], 'a');

    firePointer(el, 'pointerdown', { clientX: 2 });
    firePointer(el, 'pointermove', { clientX: 52 });
    firePointer(el, 'pointercancel', { clientX: 52 });

    // The 5 000 samples the live trim already wrote are one closed entry — not
    // an open bracket waiting to swallow whatever the user does next.
    expect(startOf('a')).toBe(5_000);
    expect(doneLabels()).toEqual(['Trim clip']);
  });
});

