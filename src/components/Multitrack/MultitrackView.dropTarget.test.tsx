/**
 * V1 review, Minor 3 — WHICH TRACK A DROP LANDS ON WHEN THE POINTER IS OVER A
 * TRACK HEADER.
 *
 * V1 clipped the lane, which fixed the reported defect (a scrolled clip painting
 * across the header) and quietly changed this: before it, a pointer over another
 * track's header hit that lane's OVERHANGING clip box, so `resolveTrackAt`
 * answered with that track; after it, the pointer hits the static header, and
 * `closest('[data-track-id]')` — an attribute only the lane carried — found
 * nothing, so `?? trackId` kept the clip on the track it came from.
 *
 * THE DECISION (T1): the track under the pointer wins, header included. A row is
 * one track, and this app draws the header INSIDE the row rather than in a
 * separate panel, so a pointer over track 3's header is a pointer over track 3 —
 * the same answer Audition gives for the timeline. The row carries the
 * `data-track-id` now, so one resolver answers for the whole row.
 *
 * The alternative considered and rejected was to REJECT a drop over a foreign
 * header (commit nothing). That was conditioned on cross-track move being out of
 * scope, and it is not: a SINGLE-clip drag has committed to the lane under the
 * pointer since the ORIGINAL multitrack commit, `0360219`. `git log -S` puts
 * `resolveTrackAt` and `onDragOverTrack` in that commit, and `git log -S` over
 * the `ClipView` docblock line that describes the behaviour — "move
 * horizontally (live transform) and across tracks (target lane highlighted),
 * committed on release" (`ClipView.tsx:179-181`) — returns that same single
 * commit, so the sentence has stood unedited since the feature landed. (An
 * earlier version of this docblock dated it "since X4". Wrong: X4 edited those
 * call sites, it did not introduce them. The behaviour is older than stated,
 * not younger.) Rejecting would also need a visual language the surface does
 * not have — a gesture that does nothing, with no target highlighted to explain
 * it — whereas routing makes the highlight and the commit agree, because both
 * read this one resolver. The GROUP branch never consults it (K1 v1 moves every
 * member on its own track, the documented limitation), so nothing here widens
 * what a group drag does.
 *
 * The last arm is the one this must not break: a pointer over NOTHING — the
 * ruler, the gap below the last row, outside the window — still commits on the
 * source track. That is what makes a purely horizontal drag survive a pointer
 * that strays vertically, and it is the behaviour the preview showed.
 */
import { act, render } from '@testing-library/react';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { createClip } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { _resetSessionUndo } from '../../multitrack/sessionUndo';
import { _resetSnapPreference, setSnapEnabled } from '../../services/snapPreference';
import { makeInitialState, useAppStore } from '../../stores/appStore';
import MultitrackView from './MultitrackView';

const SR = 44_100;
const CLIP_ID = 'dragged';

const store = () => useSessionStore.getState();

function firePointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientX: number
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY: 0,
    button: 0,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

/** The track that currently holds the dragged clip. */
function trackOfDraggedClip(): string | undefined {
  return store().session.tracks.find((t) => t.clips.some((c) => c.id === CLIP_ID))?.id;
}

let doc: AudioDocument;
const originalElementFromPoint = document.elementFromPoint;

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  store().newSession(SR);
  _resetSessionUndo();
  _resetSnapPreference();
  setSnapEnabled(false); // the magnet is not what is under test
  doc = createDocument({ name: 'src.wav', sampleRate: SR, channels: [new Float32Array(400_000)] });
  useAppStore.getState().addDocument(doc);
  const clip = createClip({
    documentId: doc.id,
    startSample: 0,
    offsetSample: 0,
    lengthSample: 20_000,
  });
  store().addClip(store().session.tracks[0].id, { ...clip, id: CLIP_ID });
});

afterEach(() => {
  document.elementFromPoint = originalElementFromPoint;
  _resetSnapPreference();
});

/** Renders the view and points `elementFromPoint` at whatever `pick` returns —
 * the ONE thing jsdom cannot answer for itself, and the only stub here. */
function mount(pick: (root: HTMLElement) => Element | null): {
  clip: HTMLElement;
  lanes: HTMLElement[];
} {
  const { container } = render(<MultitrackView />);
  const root = container as unknown as HTMLElement;
  const target = pick(root);
  document.elementFromPoint = (() => target) as unknown as typeof document.elementFromPoint;
  return {
    clip: root.querySelector('[data-testid="clip"]') as HTMLElement,
    lanes: Array.from(root.querySelectorAll('[data-testid="track-lane"]')) as HTMLElement[],
  };
}

const headers = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll('[data-testid="track-header"]')) as HTMLElement[];

function drag(clip: HTMLElement): void {
  firePointer(clip, 'pointerdown', 50);
  firePointer(clip, 'pointermove', 150);
  firePointer(clip, 'pointerup', 150);
}

describe('a clip dropped while the pointer is over another track', () => {
  it('lands on that track when the pointer is over its LANE (unchanged)', () => {
    const { clip } = mount((root) => (root.querySelectorAll('[data-testid="track-lane"]')[2] as Element));

    drag(clip);

    expect(trackOfDraggedClip()).toBe(store().session.tracks[2].id);
  });

  it('lands on that track when the pointer is over its HEADER', () => {
    const { clip } = mount((root) => headers(root)[2]);

    drag(clip);

    expect(trackOfDraggedClip()).toBe(store().session.tracks[2].id);
  });

  it('highlights the track the drop will land on while the pointer is on its header', () => {
    const { clip, lanes } = mount((root) => headers(root)[2]);

    firePointer(clip, 'pointerdown', 50);
    firePointer(clip, 'pointermove', 150);

    // The highlight and the commit read the same resolver, so the lane the user
    // sees lit is the lane the clip is about to join.
    expect(lanes[2].style.backgroundColor).toBe('var(--accent-soft)');
    expect(lanes[0].style.backgroundColor).toBe('transparent');

    firePointer(clip, 'pointerup', 150);
  });

  it('stays on its own track when the pointer is over no row at all', () => {
    const { clip } = mount(() => null);

    drag(clip);

    expect(trackOfDraggedClip()).toBe(store().session.tracks[0].id);
  });
});
