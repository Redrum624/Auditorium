import { act, render } from '@testing-library/react';
import ClipView from './ClipView';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import type { Clip } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { _resetSessionUndo } from '../../multitrack/sessionUndo';
import { _resetSnapPreference, setSnapEnabled } from '../../services/snapPreference';
import { makeInitialState, useAppStore } from '../../stores/appStore';

/**
 * T5 — THE GROUP DRAG PREVIEWS THE WHOLE GROUP.
 *
 * K1's commit was already rigid (every member moves by the drag's delta, in one
 * undo entry) but only the clip under the pointer showed it: the rest sat still
 * and jumped on release, which reads as a bug even though the result is right.
 * The other members translate live now, from one store field the grabbed clip
 * writes on each pointermove.
 *
 * The second half is the CLAMP, and it is the reason the preview is computed
 * rather than copied. `moveClipsBy` floors the delta so the earliest member
 * lands no earlier than sample 0; the preview did not know that, so a group
 * dragged left past the start previewed a move the commit refused and every
 * clip snapped back. Both read `clampGroupDelta` now.
 */

const SPP = 100; // 1 CSS px == 100 samples
const GRAB_X = 100; // clip-local x of a body grab (clips are 200 px wide)
const SESSION_RATE = 44_100;

function firePointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: { clientX: number; clientY?: number }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY ?? 0,
    button: 0,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

let doc: AudioDocument;

const store = () => useSessionStore.getState();

function clipOf(id: string, startSample: number): Clip {
  return { id, documentId: doc.id, startSample, offsetSample: 0, lengthSample: 20_000, gainDb: 0 };
}

/** The px this element is translated by, or 0 when it carries no transform. */
function translateOf(el: Element): number {
  const t = (el as HTMLElement).style.transform;
  if (!t) return 0;
  const m = /translateX\((-?[\d.]+)px\)/.exec(t);
  return m ? Number(m[1]) : 0;
}

/**
 * Seeds three clips on track 0 (a, b at the given starts, plus an unselected
 * outsider) and renders all three, returning their elements in that order.
 */
function mountThree(aStart: number, bStart: number): HTMLElement[] {
  const s = store();
  const t0 = s.session.tracks[0].id;
  const clips = [clipOf('a', aStart), clipOf('b', bStart), clipOf('out', 300_000)];
  for (const c of clips) s.addClip(t0, c);
  const trackId = useSessionStore.getState().session.tracks[0].id;
  const { container } = render(
    <>
      {clips.map((c) => (
        <ClipView
          key={c.id}
          clip={c}
          doc={doc}
          trackId={trackId}
          zoom={{ samplesPerPixel: SPP, scrollSample: 0 }}
          sessionRate={SESSION_RATE}
          laneHeight={96}
          selected={false}
          resolveTrackAt={() => trackId}
          onDragOverTrack={() => {}}
        />
      ))}
    </>
  );
  _resetSessionUndo();
  return [...container.querySelectorAll('[data-testid="clip"]')] as HTMLElement[];
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

describe('every member of a group drag previews the move', () => {
  it('translates the members the pointer is NOT on', () => {
    const [a, b, out] = mountThree(40_000, 100_000);
    act(() => store().setSelectedClips(['a', 'b']));

    firePointer(a, 'pointerdown', { clientX: GRAB_X });
    firePointer(a, 'pointermove', { clientX: GRAB_X + 60 });

    expect(translateOf(a)).toBe(60); // the grabbed clip, as before
    expect(translateOf(b)).toBe(60); // the member that used to sit still
    expect(translateOf(out)).toBe(0); // not in the selection, not moving
  });

  it('puts the preview back on release, having committed the same delta', () => {
    const [a, b] = mountThree(40_000, 100_000);
    act(() => store().setSelectedClips(['a', 'b']));

    firePointer(a, 'pointerdown', { clientX: GRAB_X });
    firePointer(a, 'pointermove', { clientX: GRAB_X + 60 });
    firePointer(a, 'pointerup', { clientX: GRAB_X + 60 });

    expect(translateOf(a)).toBe(0);
    expect(translateOf(b)).toBe(0);
    const clips = store().session.tracks[0].clips;
    expect(clips.find((c) => c.id === 'a')?.startSample).toBe(40_000 + 6000);
    expect(clips.find((c) => c.id === 'b')?.startSample).toBe(100_000 + 6000);
  });

  it('puts the preview back on a CANCEL, committing nothing', () => {
    const [a, b] = mountThree(40_000, 100_000);
    act(() => store().setSelectedClips(['a', 'b']));

    firePointer(a, 'pointerdown', { clientX: GRAB_X });
    firePointer(a, 'pointermove', { clientX: GRAB_X + 60 });
    firePointer(a, 'pointercancel', { clientX: GRAB_X + 60 });

    expect(translateOf(a)).toBe(0);
    expect(translateOf(b)).toBe(0);
    const clips = store().session.tracks[0].clips;
    expect(clips.find((c) => c.id === 'a')?.startSample).toBe(40_000);
  });

  // The divergence this half exists to close: the commit floors the delta so
  // the earliest member lands no earlier than 0, and before T5 the preview did
  // not know it.
  it('previews the CLAMPED delta, so the group does not snap back on release', () => {
    const [a, b] = mountThree(0, 60_000); // `a` already sits at sample 0
    act(() => store().setSelectedClips(['a', 'b']));

    firePointer(a, 'pointerdown', { clientX: GRAB_X });
    firePointer(a, 'pointermove', { clientX: GRAB_X - 50 }); // 5 000 samples left

    expect(translateOf(a)).toBe(0); // refused, and the preview says so
    expect(translateOf(b)).toBe(0);
  });

  it('clamps PARTIAL leftward travel to what the commit will take', () => {
    const [a, b] = mountThree(2000, 60_000); // 20 px of headroom at this zoom
    act(() => store().setSelectedClips(['a', 'b']));

    firePointer(a, 'pointerdown', { clientX: GRAB_X });
    firePointer(a, 'pointermove', { clientX: GRAB_X - 50 }); // asks for 5 000
    expect(translateOf(a)).toBe(-20); // gets 2 000 samples == 20 px
    expect(translateOf(b)).toBe(-20);

    firePointer(a, 'pointerup', { clientX: GRAB_X - 50 });
    const clips = store().session.tracks[0].clips;
    expect(clips.find((c) => c.id === 'a')?.startSample).toBe(0);
    expect(clips.find((c) => c.id === 'b')?.startSample).toBe(58_000);
  });

  it('a SINGLE-clip drag writes no group preview at all', () => {
    const [a, b] = mountThree(40_000, 100_000);
    act(() => store().setSelectedClip('a'));

    firePointer(a, 'pointerdown', { clientX: GRAB_X });
    firePointer(a, 'pointermove', { clientX: GRAB_X + 60 });

    expect(translateOf(a)).toBe(60);
    expect(translateOf(b)).toBe(0);
    expect(store().groupDragPreview).toBeNull();
  });

  it('a sub-threshold press previews nothing', () => {
    const [a, b] = mountThree(40_000, 100_000);
    act(() => store().setSelectedClips(['a', 'b']));

    firePointer(a, 'pointerdown', { clientX: GRAB_X });
    firePointer(a, 'pointermove', { clientX: GRAB_X + 2 }); // under DRAG_THRESHOLD
    expect(translateOf(a)).toBe(0);
    expect(translateOf(b)).toBe(0);
    expect(store().groupDragPreview).toBeNull();
  });

  it('a grabbed clip UNMOUNTED mid-drag does not strand the preview', () => {
    const s = store();
    const t0 = s.session.tracks[0].id;
    const a = clipOf('a', 40_000);
    s.addClip(t0, a);
    s.addClip(t0, clipOf('b', 100_000));
    const trackId = useSessionStore.getState().session.tracks[0].id;
    const { container, unmount } = render(
      <ClipView
        clip={a}
        doc={doc}
        trackId={trackId}
        zoom={{ samplesPerPixel: SPP, scrollSample: 0 }}
        sessionRate={SESSION_RATE}
        laneHeight={96}
        selected={false}
        resolveTrackAt={() => trackId}
        onDragOverTrack={() => {}}
      />
    );
    _resetSessionUndo();
    const el = container.querySelector('[data-testid="clip"]')!;
    act(() => store().setSelectedClips(['a', 'b']));
    firePointer(el, 'pointerdown', { clientX: GRAB_X });
    firePointer(el, 'pointermove', { clientX: GRAB_X + 60 });
    expect(store().groupDragPreview).not.toBeNull();

    act(() => unmount());
    // A preview left standing would translate every other member of that
    // selection for the rest of the session.
    expect(store().groupDragPreview).toBeNull();
  });
});
