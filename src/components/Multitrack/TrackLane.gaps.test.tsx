/**
 * D3 — DOUBLE-CLICK EMPTY LANE SPACE SELECTS THE GAP, and the band draws over
 * exactly the span that will close.
 *
 * The gesture is the only way into `selectedGap` from the UI, so this is where
 * BOTH pixel↔sample conversions are pinned: `clientX − rect.left` through the
 * lane's scroll on the way in, and `sampleToPixel` on the way out. A band drawn
 * anywhere but over the span `closeGap` will actually remove would be a lie the
 * user acts on. Double-clicking a CLIP must select nothing — the native
 * `dblclick` bubbles out of the clip to the lane, so the lane has to refuse a
 * target that is not itself.
 *
 * MEASURED OFF THE IDENTITY (final review, C5). Every case here used to run at
 * `scrollSample: 0` with jsdom's all-zero `getBoundingClientRect`, where both
 * conversions collapse to `x * spp` and `sample / spp`: dropping the scroll term
 * from either direction, or forgetting `rect.left` altogether, could not fail a
 * single assertion. The lane is therefore scrolled to sample 30 000 and its box
 * starts at x = 213, so each expected number carries all three terms.
 */
import { act, render } from '@testing-library/react';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { createClip, createTrack, type Session, type Track } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import TrackLane from './TrackLane';

const SR = 44_100;
const SPP = 100;
/** The lane is scrolled: the sample at its left edge is 30 000, not 0. */
const SCROLL = 30_000;
/** ...and its border box does not start at the window's left edge either — the
 * track headers are to its left. jsdom reports 0 for every rect, so the lanes
 * these tests render are given one. */
const RECT_LEFT = 213;

const store = () => useSessionStore.getState();

function fire(
  element: Element,
  type: 'pointerdown' | 'dblclick',
  clientX: number,
  button = 0
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
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

/**
 * A(20 000..40 000) · B(60 000..80 000). At 100 samples/px, scrolled to 30 000
 * and offset by RECT_LEFT, a sample S sits at `clientX = (S − 30 000) / 100 +
 * 213`: the LEADING gap [0, 20 000) is at x ∈ (−87, 13], the inner gap
 * [40 000, 60 000) at x ∈ [313, 413) and the open end past 80 000 at x > 713.
 * Non-zero offsets on purpose.
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
      zoom={{ samplesPerPixel: SPP, scrollSample: SCROLL }}
      sessionRate={SR}
      laneHeight={96}
      selectedClipId={store().selectedClipId}
      isDragTarget={false}
      resolveTrackAt={() => track.id}
      onDragOverTrack={() => {}}
    />
  );
  const lane = container.querySelector('[data-testid="track-lane"]') as HTMLElement;
  placeLane(lane);
  return {
    lane,
    clip: container.querySelector('[data-testid="clip"]') as HTMLElement,
    band: () => container.querySelector('[data-testid="gap-selection"]') as HTMLElement | null,
  };
}

/** Gives ONE lane element a real border box: jsdom's own
 * `getBoundingClientRect` answers 0 for everything, which is exactly the
 * identity C5 flagged — the handler reads `clientX − rect.left`. */
function placeLane(lane: HTMLElement): void {
  lane.getBoundingClientRect = () =>
    ({
      left: RECT_LEFT,
      x: RECT_LEFT,
      right: RECT_LEFT + 1200,
      top: 0,
      y: 0,
      bottom: 96,
      width: 1200,
      height: 96,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** A SECOND lane, for another track in the same session — the press rule has
 * to answer for a gap that belongs to a lane other than the one pressed. */
function renderOtherLane(): HTMLElement {
  const other = createTrack('Track 2');
  useSessionStore.setState({
    session: { ...store().session, tracks: [...store().session.tracks, other] },
  });
  const { container } = render(
    <TrackLane
      track={other}
      docs={new Map([[doc.id, doc]])}
      zoom={{ samplesPerPixel: SPP, scrollSample: SCROLL }}
      sessionRate={SR}
      laneHeight={96}
      selectedClipId={null}
      isDragTarget={false}
      resolveTrackAt={() => other.id}
      onDragOverTrack={() => {}}
    />
  );
  const lane = container.querySelector('[data-testid="track-lane"]') as HTMLElement;
  placeLane(lane);
  return lane;
}

describe('double-clicking empty lane space', () => {
  it('selects the gap it landed in and draws the band over that span', () => {
    const { lane, band } = renderLane();

    fire(lane, 'dblclick', 333); // (42 000 − 30 000) / 100 + 213 — inside [40 000, 60 000)

    expect(store().selectedGap).toEqual({
      trackId: track.id,
      startSample: 40_000,
      endSample: 60_000,
    });
    const el = band()!;
    expect(el).not.toBeNull();
    expect(el.style.left).toBe('100px'); // (40 000 − 30 000) / 100 — NOT 400
    expect(el.style.width).toBe('200px'); // a width is a difference: no scroll term
  });

  it('selects the LEADING gap, from sample 0 to the first clip', () => {
    const { lane, band } = renderLane();

    fire(lane, 'dblclick', 13); // (10 000 − 30 000) / 100 + 213 — inside [0, 20 000)

    expect(store().selectedGap).toEqual({ trackId: track.id, startSample: 0, endSample: 20_000 });
    // Sample 0 is 300 px LEFT of the scrolled lane's edge, and the band says so
    // (the lane clips it); the identity fixture read 0px here.
    expect(band()!.style.left).toBe('-300px');
    expect(band()!.style.width).toBe('200px');
  });

  it('selects nothing past the last clip — the open end is not a gap', () => {
    const { lane, band } = renderLane();

    fire(lane, 'dblclick', 813); // (90 000 − 30 000) / 100 + 213 — past the last clip

    expect(store().selectedGap).toBeNull();
    expect(band()).toBeNull();
  });

  it('selects nothing when the double-click lands on a CLIP', () => {
    const { clip, band } = renderLane();

    fire(clip, 'dblclick', 263); // sample 35 000, inside clip A — and it bubbles to the lane

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
    fire(lane, 'dblclick', 333);
    expect(store().selectedGap!.trackId).toBe(track.id);
  });

  it('replaces a standing clip selection — one selection on screen at a time', () => {
    const { lane } = renderLane();
    act(() => {
      store().setSelectedClip(ids[0]);
      store().toggleSelectedClip(ids[1]);
    });

    fire(lane, 'dblclick', 333);

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

    fire(lane, 'pointerdown', 333);

    expect(store().selectedClipId).toBeNull();
    expect(store().selectedClipIds).toEqual([]);
  });

  /**
   * Controller ruling (review round 1, I3): a plain press on empty lane space
   * PUTS THE BAND AWAY — except a press inside the standing band's own span on
   * its own lane, which is the first half of the double-click that would
   * re-select it and must not make it flicker.
   *
   * Each arm fires ONE lone `pointerdown`, deliberately: the earlier version of
   * this test fired two presses and then a dblclick, and since the dblclick
   * runs LAST it re-selected the gap whatever the press handler did — the test
   * could not fail.
   */
  it('a lone press INSIDE the standing gap, on its own lane, leaves it up', () => {
    const { lane, band } = renderLane();
    fire(lane, 'dblclick', 333);
    expect(store().selectedGap).not.toBeNull();

    fire(lane, 'pointerdown', 328); // (41 500 − 30 000) / 100 + 213 — inside [40 000, 60 000)

    expect(store().selectedGap).not.toBeNull();
    expect(band()).not.toBeNull();
  });

  it('a lone press OUTSIDE the standing gap clears it', () => {
    const { lane, band } = renderLane();
    fire(lane, 'dblclick', 333);
    expect(store().selectedGap).not.toBeNull();

    fire(lane, 'pointerdown', 813); // sample 90 000 — past the last clip

    expect(store().selectedGap).toBeNull();
    expect(band()).toBeNull();
  });

  it('a lone press on ANOTHER lane clears it, even at the same x', () => {
    const { lane } = renderLane();
    fire(lane, 'dblclick', 333);
    expect(store().selectedGap).not.toBeNull();

    fire(renderOtherLane(), 'pointerdown', 333);

    expect(store().selectedGap).toBeNull();
  });

  it('a non-left press leaves the gap alone — a context-menu press is not a deselect', () => {
    const { lane } = renderLane();
    fire(lane, 'dblclick', 333);

    fire(lane, 'pointerdown', 813, 2);

    expect(store().selectedGap).not.toBeNull();
  });
});
