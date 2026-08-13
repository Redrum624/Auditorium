import { createClip, type Clip } from './session';
import { applySessionZoom, publishSessionLaneWidth, useSessionStore } from './sessionStore';
import {
  MT_MIN_SPP,
  defaultSessionZoom,
  fitSessionSamplesPerPixel,
  sessionEndSample,
} from './sessionZoom';
import {
  FALLBACK_SESSION_LANE_WIDTH,
  MT_HEADER_W,
  _resetSessionLaneWidth,
} from './sessionViewport';
import { SESSION_UNDO_KEY, _resetSessionUndo, withSessionGesture } from './sessionUndo';
import { getHistory } from '../services/undoHistory';

/**
 * MT1-1 — the session store's side of the single-resolution zoom: the ONE
 * writer (`applySessionZoom`), the fit on load, the fit on the first clip, and
 * the lane-width republish. The user report this pins is "the tracks should
 * appear Fit on the longest one" — a 2:58 session that opened showing 18
 * seconds of itself, because four unrelated modules wrote 512 samples/px by
 * hand and none of them had measured anything.
 */
const SR = 44_100;

const store = () => useSessionStore.getState();
const zoom = () => useSessionStore.getState().mtZoom;

function clipOf(startSample: number, lengthSample: number): Clip {
  return createClip({ documentId: 'doc-1', startSample, offsetSample: 0, lengthSample });
}

beforeEach(() => {
  _resetSessionLaneWidth();
  store().newSession(SR);
  _resetSessionUndo();
});

describe('the session opens fitted', () => {
  it('newSession lays the (empty) timeline across the lane instead of guessing 512', () => {
    expect(zoom()).toEqual(defaultSessionZoom(store().session));
    expect(zoom().samplesPerPixel).toBe((60 * SR) / FALLBACK_SESSION_LANE_WIDTH);
    expect(zoom().scrollSample).toBe(0);
  });
});

describe('applySessionZoom — the ONE writer', () => {
  it('resolves the request against the live session rather than committing it raw', () => {
    const trackId = store().session.tracks[0].id;
    store().addClip(trackId, clipOf(0, 100 * SR));

    applySessionZoom({ samplesPerPixel: 1e9, scrollSample: 0 });
    expect(zoom().samplesPerPixel).toBe(fitSessionSamplesPerPixel(store().session));

    applySessionZoom({ samplesPerPixel: 0, scrollSample: 0 });
    expect(zoom().samplesPerPixel).toBe(MT_MIN_SPP);

    applySessionZoom({ samplesPerPixel: MT_MIN_SPP, scrollSample: -1000 });
    expect(zoom().scrollSample).toBe(0);
  });

  it('keeps the SAME zoom object when the resolved request changes nothing', () => {
    // Load-bearing rather than an optimisation: a fresh-but-equal object is a
    // new store snapshot, and every lane, the ruler and the clip bitmaps
    // repaint on it. At the limit, "nothing moves" has to be observable.
    const before = zoom();
    applySessionZoom({ samplesPerPixel: Number.POSITIVE_INFINITY, scrollSample: 0 });
    expect(zoom()).toBe(before);
  });

  it('feeds the resolved samplesPerPixel to a functional scroll request', () => {
    const trackId = store().session.tracks[0].id;
    store().addClip(trackId, clipOf(0, 100 * SR));
    const seen: number[] = [];
    applySessionZoom({
      samplesPerPixel: 1e9,
      scrollSample: (spp) => {
        seen.push(spp);
        return 0;
      },
    });
    expect(seen).toEqual([fitSessionSamplesPerPixel(store().session)]);
  });
});

describe('addClip re-fits the session it just gave a length to', () => {
  it('fits the FIRST clip dropped into an empty session', () => {
    const trackId = store().session.tracks[0].id;
    store().addClip(trackId, clipOf(0, 178 * SR));
    expect(zoom()).toEqual(defaultSessionZoom(store().session));
    expect(zoom().samplesPerPixel).toBe((178 * SR) / FALLBACK_SESSION_LANE_WIDTH);
  });

  it('fits the LONGEST track, not the last clip inserted', () => {
    const [t1, t2] = store().session.tracks;
    store().addClip(t1.id, clipOf(0, 178 * SR));
    store().addClip(t2.id, clipOf(0, 12 * SR));
    expect(sessionEndSample(store().session)).toBe(178 * SR);
    expect(zoom().samplesPerPixel).toBe((178 * SR) / FALLBACK_SESSION_LANE_WIDTH);
  });

  it('leaves a zoom the user CHOSE alone on every later insert', () => {
    const [t1, t2] = store().session.tracks;
    store().addClip(t1.id, clipOf(0, 178 * SR));
    applySessionZoom({ samplesPerPixel: 64, scrollSample: 1000 });
    const chosen = zoom();

    store().addClip(t2.id, clipOf(0, 400 * SR));
    expect(zoom()).toBe(chosen);
  });

  it('re-fits a still-fitted view, so a multi-file drop shows every clip it landed', () => {
    // laneDrop places N clips in ONE gesture. Were the re-fit gated on "the
    // session was empty" alone, a 3-file drop would fit the FIRST clip and
    // leave the other two off the right edge — the reported bug, one file
    // later. A view sitting exactly at the fit has chosen nothing (or has
    // chosen Fit, in which case staying fitted is the choice), which is the
    // same arm `publishEditorLaneWidth` uses on a window resize.
    const [t1, t2, t3] = store().session.tracks;
    withSessionGesture('Add clips', () => {
      store().addClip(t1.id, clipOf(0, 10 * SR));
      store().addClip(t2.id, clipOf(10 * SR, 10 * SR));
      store().addClip(t3.id, clipOf(20 * SR, 10 * SR));
    });
    expect(zoom().samplesPerPixel).toBe((30 * SR) / FALLBACK_SESSION_LANE_WIDTH);
  });

  it('does not touch the zoom when the insert itself was a no-op', () => {
    const before = zoom();
    store().addClip('track-does-not-exist', clipOf(0, 178 * SR));
    expect(zoom()).toBe(before);
  });

  it('records no undo entry of its own — mtZoom stays out of the history', () => {
    const trackId = store().session.tracks[0].id;
    store().addClip(trackId, clipOf(0, 178 * SR));
    expect(getHistory(SESSION_UNDO_KEY).done).toEqual(['Add clip']);
  });
});

describe('publishSessionLaneWidth', () => {
  it('subtracts the header column that lives inside every track row', () => {
    const trackId = store().session.tracks[0].id;
    store().addClip(trackId, clipOf(0, 178 * SR));
    publishSessionLaneWidth(1000);
    expect(zoom().samplesPerPixel).toBe((178 * SR) / (1000 - MT_HEADER_W));
  });

  it('keeps a fitted session fitted across a resize', () => {
    const trackId = store().session.tracks[0].id;
    store().addClip(trackId, clipOf(0, 178 * SR));
    publishSessionLaneWidth(1000);
    publishSessionLaneWidth(700);
    expect(zoom()).toEqual(defaultSessionZoom(store().session));
    expect(zoom().samplesPerPixel).toBe((178 * SR) / (700 - MT_HEADER_W));
  });

  it('only re-resolves a zoomed-in session — it does not throw away where the user was', () => {
    const trackId = store().session.tracks[0].id;
    store().addClip(trackId, clipOf(0, 178 * SR));
    publishSessionLaneWidth(1000);
    applySessionZoom({ samplesPerPixel: 64, scrollSample: 50_000 });

    publishSessionLaneWidth(700);
    expect(zoom().samplesPerPixel).toBe(64);
    expect(zoom().scrollSample).toBe(50_000);
  });

  it('costs nothing when the observer fires at an unchanged width', () => {
    const trackId = store().session.tracks[0].id;
    store().addClip(trackId, clipOf(0, 178 * SR));
    publishSessionLaneWidth(1000);
    const settled = zoom();
    publishSessionLaneWidth(1000);
    expect(zoom()).toBe(settled);
  });

  it('ignores a scroller no wider than the header column', () => {
    const trackId = store().session.tracks[0].id;
    store().addClip(trackId, clipOf(0, 178 * SR));
    publishSessionLaneWidth(1000);
    const settled = zoom();
    publishSessionLaneWidth(MT_HEADER_W);
    publishSessionLaneWidth(0);
    expect(zoom()).toBe(settled);
  });
});
