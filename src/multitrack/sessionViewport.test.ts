import {
  FALLBACK_SESSION_LANE_WIDTH,
  MT_HEADER_W,
  laneWidthFromScrollerWidth,
  sessionLaneWidth,
  setSessionLaneWidth,
  _resetSessionLaneWidth,
} from './sessionViewport';

/**
 * MT1-1 — the measured multitrack lane width, the session's twin of
 * `editorViewport`. Same two load-bearing properties (never 0, reports whether
 * the EFFECTIVE width changed) plus one this side owns alone: the multitrack
 * scroller is NOT the lane. Each track row is `[TrackHeader | TrackLane]`, both
 * inside the scroller, so the width the ResizeObserver reads is 224 px wider
 * than the surface the clips are drawn on. Fitting to the scroller width would
 * make "the whole session fits" overshoot by exactly one header column, and the
 * further out the zoom the more of the last clip that hides.
 */
beforeEach(() => {
  _resetSessionLaneWidth();
});

describe('sessionLaneWidth', () => {
  it('falls back to the nominal 1600 px window minus the header column', () => {
    expect(sessionLaneWidth()).toBe(FALLBACK_SESSION_LANE_WIDTH);
    expect(MT_HEADER_W).toBe(224);
    expect(FALLBACK_SESSION_LANE_WIDTH).toBe(1600 - MT_HEADER_W);
  });

  it('reports the last measurement once a lane has reported one', () => {
    setSessionLaneWidth(942);
    expect(sessionLaneWidth()).toBe(942);
    setSessionLaneWidth(431.5);
    expect(sessionLaneWidth()).toBe(431.5);
  });
});

describe('laneWidthFromScrollerWidth', () => {
  it('subtracts the header column that lives INSIDE every track row', () => {
    expect(laneWidthFromScrollerWidth(1000)).toBe(1000 - MT_HEADER_W);
    expect(laneWidthFromScrollerWidth(1600)).toBe(FALLBACK_SESSION_LANE_WIDTH);
  });

  it('yields a non-positive width for a scroller no wider than the header', () => {
    // Which `setSessionLaneWidth` then REJECTS — a window dragged narrower than
    // the header column must leave the last good lane width standing rather
    // than fit the session across zero or negative pixels.
    expect(laneWidthFromScrollerWidth(MT_HEADER_W)).toBe(0);
    expect(setSessionLaneWidth(laneWidthFromScrollerWidth(MT_HEADER_W))).toBe(false);
    expect(sessionLaneWidth()).toBe(FALLBACK_SESSION_LANE_WIDTH);
  });
});

describe('setSessionLaneWidth', () => {
  it('returns true only when the effective width changed', () => {
    expect(setSessionLaneWidth(900)).toBe(true);
    expect(setSessionLaneWidth(900)).toBe(false);
    expect(setSessionLaneWidth(901)).toBe(true);
  });

  it('reports no change when the first measurement happens to equal the fallback', () => {
    expect(setSessionLaneWidth(FALLBACK_SESSION_LANE_WIDTH)).toBe(false);
    expect(sessionLaneWidth()).toBe(FALLBACK_SESSION_LANE_WIDTH);
  });

  it('rejects the widths a hidden or unlaid-out lane reports', () => {
    setSessionLaneWidth(900);
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(setSessionLaneWidth(bad)).toBe(false);
      expect(sessionLaneWidth()).toBe(900);
    }
  });
});
