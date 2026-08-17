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

// ---------------------------------------------------------------------------
// MT1 fix round (I2) — a session that gets SHORTER re-resolves
// ---------------------------------------------------------------------------
/*
 * `fit` is the zoom-out ceiling, and `fit` is a function of the session's
 * length — so any mutation that SHORTENS the session moves the ceiling down and
 * can leave the committed zoom above it, in the state the whole single-clamp
 * design exists to make unreachable.
 *
 * Two visible consequences, both reachable by deleting one clip:
 *   - the readout drops below 100% (34% was the measured case), which the user
 *     guide says cannot happen;
 *   - `addClip`'s "was it fitted?" arm is `spp >= fit`, so an out-of-range zoom
 *     reads as FITTED and the next insert silently re-fits — throwing away a
 *     zoom the user chose, which is the one thing that arm promises not to do.
 *
 * Re-resolving is done in ONE place, on the store's own subscription, because
 * the mutations that can shorten a session are five (`removeClip`,
 * `removeTrack`, `trimClip`, `moveClip`) plus undo/redo restore, and undo does
 * not go through any of the four.
 */
describe('the empty-session arm of the first-clip re-fit', () => {
  // Mutation kill: deleting `!hasAnyClip(s.session)` from addClip's `refit`
  // left every other fixture in the suite passing, because they all insert into
  // a session sitting at its fit — where the SECOND arm (`spp >= fit`) already
  // says yes. The empty case is the one the arms disagree about, and it is the
  // reported bug: an empty session is fitted to the 60 s placeholder, so a real
  // clip arriving is far coarser than the placeholder's fit and `spp >= fit` is
  // FALSE. Without the empty arm the first insert leaves the session at the
  // placeholder zoom.
  it('re-fits the first clip even though the placeholder zoom is NOT at the new fit', () => {
    publishSessionLaneWidth(1000 + MT_HEADER_W);
    const placeholder = zoom().samplesPerPixel;
    const trackId = store().session.tracks[0].id;
    store().addClip(trackId, clipOf(0, 178 * SR));

    const fitNow = fitSessionSamplesPerPixel(store().session);
    // The precondition that makes this a real test: the second arm cannot fire.
    expect(placeholder).toBeLessThan(fitNow);
    expect(zoom().samplesPerPixel).toBe(fitNow);
    expect(zoom().samplesPerPixel).not.toBe(placeholder);
  });
});

describe('a session that gets shorter re-resolves its zoom', () => {
  /** A long clip and a short one; fitted to the long one. */
  function seedLongAndShort(): { trackId: string; longId: string } {
    const trackId = store().session.tracks[0].id;
    const long = clipOf(0, 178 * SR);
    const short = clipOf(0, 4 * SR);
    store().addClip(trackId, long);
    store().addClip(store().session.tracks[1].id, short);
    publishSessionLaneWidth(1000 + MT_HEADER_W);
    return { trackId, longId: long.id };
  }

  it('re-clamps when the longest clip is deleted', () => {
    const { longId } = seedLongAndShort();
    expect(zoom().samplesPerPixel).toBe(fitSessionSamplesPerPixel(store().session));

    store().removeClip(longId);

    const fitNow = fitSessionSamplesPerPixel(store().session);
    expect(sessionEndSample(store().session)).toBe(4 * SR);
    expect(zoom().samplesPerPixel).toBeLessThanOrEqual(fitNow);
    // Still exactly AT the fit, which is what "100%" means on this surface.
    expect(zoom().samplesPerPixel).toBe(fitNow);
  });

  it('does not let a shortened session smuggle a re-fit past the user-chose rule', () => {
    const { trackId, longId } = seedLongAndShort();
    // The user zooms IN — a deliberate choice that later inserts must respect.
    const chosen = fitSessionSamplesPerPixel(store().session) / 4;
    applySessionZoom({ samplesPerPixel: chosen, scrollSample: 0 });
    expect(zoom().samplesPerPixel).toBe(chosen);

    store().removeClip(longId);
    // Deleting the long clip leaves `chosen` ABOVE the new fit, so it is
    // re-clamped down to it — the zoom cannot survive as an unreachable state.
    const fitNow = fitSessionSamplesPerPixel(store().session);
    expect(zoom().samplesPerPixel).toBe(fitNow);

    // ...and the next insert, arriving at a genuinely fitted view, re-fits. The
    // regression this guards is the opposite: before I2 the stale zoom sat
    // ABOVE the fit, `spp >= fit` read TRUE, and the insert re-fitted a view the
    // user had chosen while believing it had not.
    store().addClip(trackId, clipOf(0, 90 * SR));
    expect(zoom().samplesPerPixel).toBe(fitSessionSamplesPerPixel(store().session));
  });

  it('leaves a zoom that is still in range exactly where the user put it', () => {
    const { trackId, longId } = seedLongAndShort();
    void trackId;
    // Zoomed in far enough that the SHORT clip's fit is still coarser than this.
    const chosen = 1;
    applySessionZoom({ samplesPerPixel: chosen, scrollSample: 0 });

    store().removeClip(longId);

    expect(zoom().samplesPerPixel).toBe(chosen);
  });
});
