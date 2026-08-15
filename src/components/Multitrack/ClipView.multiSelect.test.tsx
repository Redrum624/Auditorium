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
  type: 'pointerdown' | 'pointermove' | 'pointerup',
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
