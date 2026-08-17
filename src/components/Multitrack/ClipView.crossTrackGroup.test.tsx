import { act, render } from '@testing-library/react';
import ClipView from './ClipView';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import type { Clip } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { _resetSessionUndo, undoSession } from '../../multitrack/sessionUndo';
import { _resetSnapPreference, setSnapEnabled } from '../../services/snapPreference';
import { makeInitialState, useAppStore } from '../../stores/appStore';

/**
 * T5 — the group drag follows the pointer ACROSS TRACKS, and the highlight
 * stops promising lanes the drop will not take.
 *
 * K1 shipped the group drag same-track-only, but `onDragOverTrack` was already
 * resolver-driven — so hovering a foreign lane during a 2+ clip drag lit that
 * lane while the commit kept every member where it was (T1 concern 2, which
 * named cross-track group drag as one of its two honest closes). Both halves
 * land here: the group moves when every member's target lane exists, and when
 * it does not, the lit lane is the one the grabbed clip will actually stay on.
 */

const SPP = 100; // 1 CSS px == 100 samples
const GRAB_X = 100;
const SESSION_RATE = 44_100;

function firePointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { clientX: number; ctrlKey?: boolean }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: 0,
    button: 0,
    ctrlKey: init.ctrlKey ?? false,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

let doc: AudioDocument;

const store = () => useSessionStore.getState();

function clipOf(id: string, startSample: number, lengthSample = 20_000): Clip {
  return { id, documentId: doc.id, startSample, offsetSample: 0, lengthSample, gainDb: 0 };
}

const trackId = (i: number) => store().session.tracks[i].id;
const trackIdxOf = (id: string) =>
  store().session.tracks.findIndex((t) => t.clips.some((c) => c.id === id));

/**
 * Seeds the given clips onto the named tracks, renders the grabbed one, and
 * returns its element plus the lanes `onDragOverTrack` was told about.
 */
function mount(
  seed: { trackIdx: number; clip: Clip }[],
  grabbedId: string,
  pointedTrackIdx: number
): { el: HTMLElement; lit: (string | null)[]; container: HTMLElement } {
  for (const { trackIdx, clip } of seed) {
    useSessionStore.getState().addClip(trackId(trackIdx), clip);
  }
  const target = seed.find((x) => x.clip.id === grabbedId)!;
  const lit: (string | null)[] = [];
  const { container } = render(
    <ClipView
      clip={target.clip}
      doc={doc}
      trackId={trackId(target.trackIdx)}
      zoom={{ samplesPerPixel: SPP, scrollSample: 0 }}
      sessionRate={SESSION_RATE}
      laneHeight={96}
      selected={false}
      resolveTrackAt={() => trackId(pointedTrackIdx)}
      onDragOverTrack={(id) => lit.push(id)}
    />
  );
  _resetSessionUndo();
  return {
    el: container.querySelector('[data-testid="clip"]') as HTMLElement,
    lit,
    container: container as HTMLElement,
  };
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(SESSION_RATE); // four tracks
  _resetSnapPreference();
  setSnapEnabled(false);
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

describe('a group drag onto another lane', () => {
  it('moves every member by the same lane offset, keeping the shape', () => {
    const { el } = mount(
      [
        { trackIdx: 0, clip: clipOf('a', 0) },
        { trackIdx: 1, clip: clipOf('b', 60_000) },
      ],
      'a',
      2 // the pointer is on track 3 (index 2), two lanes below `a`
    );
    act(() => store().setSelectedClips(['a', 'b']));

    firePointer(el, 'pointerdown', { clientX: GRAB_X });
    firePointer(el, 'pointermove', { clientX: GRAB_X + 30 });
    firePointer(el, 'pointerup', { clientX: GRAB_X + 30 });

    expect(trackIdxOf('a')).toBe(2);
    expect(trackIdxOf('b')).toBe(3); // the one-lane gap survived
    expect(store().session.tracks[2].clips.find((c) => c.id === 'a')?.startSample).toBe(3000);
    expect(store().session.tracks[3].clips.find((c) => c.id === 'b')?.startSample).toBe(63_000);
  });

  it('stays on its own tracks when a member’s target lane does not exist', () => {
    const { el } = mount(
      [
        { trackIdx: 0, clip: clipOf('a', 0) },
        { trackIdx: 3, clip: clipOf('b', 60_000) }, // already on the LAST track
      ],
      'a',
      1
    );
    act(() => store().setSelectedClips(['a', 'b']));

    firePointer(el, 'pointerdown', { clientX: GRAB_X });
    firePointer(el, 'pointermove', { clientX: GRAB_X + 30 });
    firePointer(el, 'pointerup', { clientX: GRAB_X + 30 });

    expect(trackIdxOf('a')).toBe(0); // no partial scatter
    expect(trackIdxOf('b')).toBe(3);
    expect(store().session.tracks[0].clips.find((c) => c.id === 'a')?.startSample).toBe(3000);
  });

  it('lights the lane the grabbed clip will LAND on, not the one under the pointer', () => {
    const { el, lit } = mount(
      [
        { trackIdx: 0, clip: clipOf('a', 0) },
        { trackIdx: 3, clip: clipOf('b', 60_000) },
      ],
      'a',
      1 // hovering track 2, which the group cannot reach
    );
    act(() => store().setSelectedClips(['a', 'b']));

    firePointer(el, 'pointerdown', { clientX: GRAB_X });
    firePointer(el, 'pointermove', { clientX: GRAB_X + 30 });

    expect(lit[lit.length - 1]).toBe(trackId(0)); // its own lane: it is staying
  });

  it('lights the pointed lane when the group CAN reach it', () => {
    const { el, lit } = mount(
      [
        { trackIdx: 0, clip: clipOf('a', 0) },
        { trackIdx: 1, clip: clipOf('b', 60_000) },
      ],
      'a',
      2
    );
    act(() => store().setSelectedClips(['a', 'b']));

    firePointer(el, 'pointerdown', { clientX: GRAB_X });
    firePointer(el, 'pointermove', { clientX: GRAB_X + 30 });

    expect(lit[lit.length - 1]).toBe(trackId(2));
  });

  it('a SINGLE-clip drag still lights exactly the lane under the pointer', () => {
    const { el, lit } = mount([{ trackIdx: 0, clip: clipOf('a', 0) }], 'a', 3);
    act(() => store().setSelectedClip('a'));

    firePointer(el, 'pointerdown', { clientX: GRAB_X });
    firePointer(el, 'pointermove', { clientX: GRAB_X + 30 });

    expect(lit[lit.length - 1]).toBe(trackId(3)); // unchanged
    firePointer(el, 'pointerup', { clientX: GRAB_X + 30 });
    expect(trackIdxOf('a')).toBe(3);
  });

  it('is one undo entry that puts the lanes back', () => {
    const { el } = mount(
      [
        { trackIdx: 0, clip: clipOf('a', 0) },
        { trackIdx: 1, clip: clipOf('b', 60_000) },
      ],
      'a',
      2
    );
    act(() => store().setSelectedClips(['a', 'b']));

    firePointer(el, 'pointerdown', { clientX: GRAB_X });
    firePointer(el, 'pointermove', { clientX: GRAB_X + 30 });
    firePointer(el, 'pointerup', { clientX: GRAB_X + 30 });

    act(() => undoSession());
    expect(trackIdxOf('a')).toBe(0);
    expect(trackIdxOf('b')).toBe(1);
  });
});

describe('the overlap drop hint tells the truth about Ctrl', () => {
  const hintOf = (container: HTMLElement) =>
    container.querySelector('[data-testid="overlap-drag-hint"]')?.textContent ?? null;

  it('offers the Ctrl nudge for a SINGLE-clip drag (unchanged)', () => {
    const { el, container } = mount(
      [
        { trackIdx: 0, clip: clipOf('a', 0) },
        { trackIdx: 0, clip: clipOf('blocker', 40_000) },
      ],
      'a',
      0
    );
    act(() => store().setSelectedClip('a'));

    firePointer(el, 'pointerdown', { clientX: GRAB_X });
    firePointer(el, 'pointermove', { clientX: GRAB_X + 250 }); // preview lands on the blocker

    expect(hintOf(container)).toBe('Drop crossfades — hold Ctrl to push clear');
  });

  // The label-lies defect class, in the surface the user actually reads during
  // the gesture. `moveClipsBy` passes no `clearOverlap`, so Ctrl at a group
  // drop does nothing at all — T1's I1 corrected the DOCS about this and left
  // the in-app hint saying the opposite.
  it('promises no nudge during a GROUP drag, because there is none', () => {
    const { el, container } = mount(
      [
        { trackIdx: 0, clip: clipOf('a', 0) },
        { trackIdx: 0, clip: clipOf('blocker', 40_000) },
        { trackIdx: 1, clip: clipOf('b', 200_000) },
      ],
      'a',
      0
    );
    act(() => store().setSelectedClips(['a', 'b']));

    firePointer(el, 'pointerdown', { clientX: GRAB_X });
    firePointer(el, 'pointermove', { clientX: GRAB_X + 250 });

    expect(hintOf(container)).toBe('Drop crossfades');
  });

  /**
   * Review I1 — the other arm of the same label-lie, in the membership test
   * rather than in the text. The scan excluded only the GRABBED clip, so a
   * CO-MOVING sibling counted as something to crossfade with — but the group is
   * rigid, so a member the preview crosses is a member that will have moved by
   * the identical delta by the time the drop lands. The hint promised a
   * crossfade the commit then did not arm.
   */
  it('does not promise a crossfade with a sibling that is moving out of the way', () => {
    const { el, container } = mount(
      [
        { trackIdx: 0, clip: clipOf('a', 0) },
        { trackIdx: 0, clip: clipOf('b', 40_000) }, // the ONLY clip under the preview
      ],
      'a',
      0
    );
    act(() => store().setSelectedClips(['a', 'b']));

    firePointer(el, 'pointerdown', { clientX: GRAB_X });
    // +250 px == +25 000 samples: `a` previews [25 000, 45 000), which crosses
    // `b`'s STORED span [40 000, 60 000).
    firePointer(el, 'pointermove', { clientX: GRAB_X + 250 });
    expect(hintOf(container)).toBeNull();

    // And the drop proves the hint would have been lying: both moved by the
    // same delta, they are as far apart as they were, and nothing armed.
    firePointer(el, 'pointerup', { clientX: GRAB_X + 250 });
    const clips = store().session.tracks[0].clips;
    expect(clips.find((c) => c.id === 'a')?.startSample).toBe(25_000);
    expect(clips.find((c) => c.id === 'b')?.startSample).toBe(65_000);
    expect(clips.find((c) => c.id === 'a')?.fadeOutSample ?? 0).toBe(0);
    expect(clips.find((c) => c.id === 'b')?.fadeInSample ?? 0).toBe(0);
  });

  it('still promises one when the overlap is with a clip that is NOT moving', () => {
    // The converse, so the fix cannot be "never show the hint during a group
    // drag": same gesture, same geometry, but the clip under the preview is an
    // outsider that will still be there at the drop.
    const { el, container } = mount(
      [
        { trackIdx: 0, clip: clipOf('a', 0) },
        { trackIdx: 0, clip: clipOf('blocker', 40_000) },
        { trackIdx: 1, clip: clipOf('b', 200_000) },
      ],
      'a',
      0
    );
    act(() => store().setSelectedClips(['a', 'b']));

    firePointer(el, 'pointerdown', { clientX: GRAB_X });
    firePointer(el, 'pointermove', { clientX: GRAB_X + 250 });
    expect(hintOf(container)).toBe('Drop crossfades');

    firePointer(el, 'pointerup', { clientX: GRAB_X + 250 });
    const clips = store().session.tracks[0].clips;
    expect(clips.find((c) => c.id === 'a')?.fadeOutSample).toBeGreaterThan(0);
    expect(clips.find((c) => c.id === 'blocker')?.fadeInSample).toBeGreaterThan(0);
  });

  it('a SINGLE-clip drag still counts every other clip on the lane (unchanged)', () => {
    // The membership rule must narrow only by what THIS gesture moves: with one
    // clip selected, `groupIds` is `[a]` and every neighbour still counts.
    const { el, container } = mount(
      [
        { trackIdx: 0, clip: clipOf('a', 0) },
        { trackIdx: 0, clip: clipOf('b', 40_000) },
      ],
      'a',
      0
    );
    act(() => store().setSelectedClip('a')); // `b` is NOT in the selection

    firePointer(el, 'pointerdown', { clientX: GRAB_X });
    firePointer(el, 'pointermove', { clientX: GRAB_X + 250 });
    expect(hintOf(container)).toBe('Drop crossfades — hold Ctrl to push clear');
  });
});
