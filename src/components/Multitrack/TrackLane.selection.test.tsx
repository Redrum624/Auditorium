/**
 * K1 R2 — CLICKING EMPTY LANE SPACE CLEARS THE SELECTION, wired.
 *
 * The K1 review confirmed the behaviour was already right and that only the
 * WIRING was untested: `TrackLane` calls `setSelectedClip(null)` on a left
 * press, `setSelectedClip(null)` empties the extended set (pinned in
 * `sessionStore.selection.test.ts`), and `ClipView.onPointerDown` calls
 * `stopPropagation` so a press on a clip never reaches the lane. Three facts,
 * each held somewhere else, with nothing holding them TOGETHER — so a lane that
 * stopped calling the action, or a clip that stopped stopping the event, would
 * have taken the whole "click away to deselect" gesture with it silently.
 *
 * This is the join: a real press on the real lane element, against a real
 * multi-clip selection in the store.
 */
import { act, render } from '@testing-library/react';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { createClip, createTrack, type Session, type Track } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import TrackLane from './TrackLane';

const SR = 44_100;
const SPP = 100;

const store = () => useSessionStore.getState();

function press(element: Element, button = 0): void {
  const event = new MouseEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 10,
    button,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

let doc: AudioDocument;
let track: Track;
let ids: [string, string];

beforeEach(() => {
  doc = createDocument({ name: 'src.wav', sampleRate: SR, channels: [new Float32Array(200_000)] });
  const t = createTrack('Track 1');
  t.clips = [
    createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 20_000 }),
    createClip({ documentId: doc.id, startSample: 40_000, offsetSample: 0, lengthSample: 20_000 }),
  ];
  const session: Session = { name: 'Lane Fixture', sampleRate: SR, tracks: [t] };
  useSessionStore.setState({
    session,
    selectedClipId: null,
    selectedClipIds: [],
    mtCursorSample: 0,
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
  });
  track = t;
  ids = [t.clips[0].id, t.clips[1].id];
});

/** The lane, holding both clips, with a two-clip selection standing. */
function renderLane(): { lane: HTMLElement; clip: HTMLElement } {
  const { container } = render(
    <TrackLane
      track={track}
      docs={new Map([[doc.id, doc]])}
      zoom={{ samplesPerPixel: SPP, scrollSample: 0 }}
      sessionRate={SR}
      laneHeight={96}
      selectedClipId={store().selectedClipId}
      isDragTarget={false}
      resolveTrackAt={() => track.id}
      onDragOverTrack={() => {}}
    />
  );
  return {
    lane: container.querySelector('[data-testid="track-lane"]') as HTMLElement,
    clip: container.querySelector('[data-testid="clip"]') as HTMLElement,
  };
}

function selectBoth(): void {
  act(() => {
    store().setSelectedClip(ids[0]);
    store().toggleSelectedClip(ids[1]);
  });
  expect(store().selectedClipIds).toEqual([ids[0], ids[1]]);
}

describe('a press on empty lane space', () => {
  it('clears the WHOLE selection, not only the primary', () => {
    const { lane } = renderLane();
    selectBoth();

    press(lane);

    expect(store().selectedClipId).toBeNull();
    expect(store().selectedClipIds).toEqual([]);
  });

  it('changes nothing when the press lands on a clip — the clip stops the event', () => {
    const { clip } = renderLane();
    selectBoth();

    // A press on a clip already IN the selection commits nothing of its own
    // (that press is how a group drag starts), so anything that moved here
    // would have come from the lane handler underneath.
    press(clip);

    expect(store().selectedClipIds).toEqual([ids[0], ids[1]]);
    expect(store().selectedClipId).toBe(ids[1]);
  });

  it('ignores a non-left button, so a context-menu press keeps the selection', () => {
    const { lane } = renderLane();
    selectBoth();

    press(lane, 2);

    expect(store().selectedClipIds).toEqual([ids[0], ids[1]]);
  });

  it('is a no-op on an empty selection — the same state object comes back', () => {
    const { lane } = renderLane();
    const held = useSessionStore.getState();

    press(lane);

    // The guard that keeps an empty-lane press from repainting the timeline:
    // a fresh `[]` would be a new value for every clip's subscription to see.
    expect(useSessionStore.getState()).toBe(held);
  });
});
