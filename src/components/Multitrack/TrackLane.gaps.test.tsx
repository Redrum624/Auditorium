/**
 * D3 — DOUBLE-CLICK EMPTY LANE SPACE SELECTS THE GAP, and the band draws over
 * exactly the span that will close.
 *
 * The gesture is the only way into `selectedGap` from the UI, so this is where
 * the pixel→sample conversion is pinned: the lane's own left edge is x = 0 (the
 * clips are positioned from the same origin), and a band drawn anywhere but
 * over the span `closeGap` will actually remove would be a lie the user acts
 * on. Double-clicking a CLIP must select nothing — the native `dblclick`
 * bubbles out of the clip to the lane, so the lane has to refuse a target that
 * is not itself.
 */
import { act, render } from '@testing-library/react';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { createClip, createTrack, type Session, type Track } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import TrackLane from './TrackLane';

const SR = 44_100;
const SPP = 100;

const store = () => useSessionStore.getState();

function fire(element: Element, type: 'pointerdown' | 'dblclick', clientX: number): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 10 });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

let doc: AudioDocument;
let track: Track;
let ids: [string, string];

/**
 * A(20 000..40 000) · B(60 000..80 000) — at 100 samples/px that is 200..400 px
 * and 600..800 px, so the LEADING gap is 0..200 px, the inner gap 400..600 px,
 * and everything past 800 px is the open end. Non-zero offsets on purpose.
 */
beforeEach(() => {
  doc = createDocument({ name: 'src.wav', sampleRate: SR, channels: [new Float32Array(200_000)] });
  const t = createTrack('Track 1');
  t.clips = [
    createClip({ documentId: doc.id, startSample: 20_000, offsetSample: 512, lengthSample: 20_000 }),
    createClip({ documentId: doc.id, startSample: 60_000, offsetSample: 768, lengthSample: 20_000 }),
  ];
  const session: Session = { name: 'Gap Lane Fixture', sampleRate: SR, tracks: [t] };
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
  track = t;
  ids = [t.clips[0].id, t.clips[1].id];
});

function renderLane(): { lane: HTMLElement; clip: HTMLElement; band: () => HTMLElement | null } {
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
    band: () => container.querySelector('[data-testid="gap-selection"]') as HTMLElement | null,
  };
}

describe('double-clicking empty lane space', () => {
  it('selects the gap it landed in and draws the band over that span', () => {
    const { lane, band } = renderLane();

    fire(lane, 'dblclick', 500); // sample 50 000 — inside [40 000, 60 000)

    expect(store().selectedGap).toEqual({
      trackId: track.id,
      startSample: 40_000,
      endSample: 60_000,
    });
    const el = band()!;
    expect(el).not.toBeNull();
    expect(el.style.left).toBe('400px');
    expect(el.style.width).toBe('200px');
  });

  it('selects the LEADING gap, from sample 0 to the first clip', () => {
    const { lane, band } = renderLane();

    fire(lane, 'dblclick', 100); // sample 10 000 — inside [0, 20 000)

    expect(store().selectedGap).toEqual({ trackId: track.id, startSample: 0, endSample: 20_000 });
    expect(band()!.style.left).toBe('0px');
    expect(band()!.style.width).toBe('200px');
  });

  it('selects nothing past the last clip — the open end is not a gap', () => {
    const { lane, band } = renderLane();

    fire(lane, 'dblclick', 900); // sample 90 000

    expect(store().selectedGap).toBeNull();
    expect(band()).toBeNull();
  });

  it('selects nothing when the double-click lands on a CLIP', () => {
    const { clip, band } = renderLane();

    fire(clip, 'dblclick', 300); // the native event bubbles up to the lane

    expect(store().selectedGap).toBeNull();
    expect(band()).toBeNull();
  });

  it('draws no band for a gap selected on ANOTHER track', () => {
    const { lane, band } = renderLane();
    act(() => {
      store().setSelectedGap({ trackId: 'track-elsewhere', startSample: 0, endSample: 100 });
    });

    expect(band()).toBeNull();
    // ...and this lane can still claim the selection for itself.
    fire(lane, 'dblclick', 500);
    expect(store().selectedGap!.trackId).toBe(track.id);
  });

  it('replaces a standing clip selection — one selection on screen at a time', () => {
    const { lane } = renderLane();
    act(() => {
      store().setSelectedClip(ids[0]);
      store().toggleSelectedClip(ids[1]);
    });

    fire(lane, 'dblclick', 500);

    expect(store().selectedGap).not.toBeNull();
    expect(store().selectedClipId).toBeNull();
    expect(store().selectedClipIds).toEqual([]);
  });
});

describe('the single-click gesture is unchanged', () => {
  it('a press on empty lane space still clears the clip selection', () => {
    const { lane } = renderLane();
    act(() => {
      store().setSelectedClip(ids[0]);
    });

    fire(lane, 'pointerdown', 500);

    expect(store().selectedClipId).toBeNull();
    expect(store().selectedClipIds).toEqual([]);
  });

  it('a press does NOT clear a selected gap — the two presses of a double-click come first', () => {
    const { lane, band } = renderLane();

    fire(lane, 'pointerdown', 500);
    fire(lane, 'pointerdown', 500);
    fire(lane, 'dblclick', 500);

    expect(store().selectedGap).not.toBeNull();
    expect(band()).not.toBeNull();
  });
});
