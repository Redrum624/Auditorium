import { anchoredZoom } from './zoomAnchor';

/**
 * D1 — the zoom anchor is the BAR, on every path and both surfaces.
 *
 * The reported symptom: "when zooming in on a track, focus on where the line
 * was put." Ctrl+wheel anchored on the POINTER on both surfaces while the
 * toolbar's −/+ anchored on the edit cursor, so the same document zoomed to two
 * different places depending on which control the user reached for. This module
 * is the single rule; these are its properties.
 *
 * Two of them are the ones an implementation can get wrong:
 *
 *  - **the scroll is a FUNCTION of the RESOLVED samples-per-pixel.** At the
 *    zoom-out limit `resolveZoom`/`resolveSessionZoom` clamp the request, so the
 *    spp the view commits is not the spp that was asked for. Computing the
 *    scroll from the REQUEST and letting the store clamp it separately is
 *    exactly how an anchor drifts out from under the bar — hence the clamped-spp
 *    cases below, which pass an spp the caller never requested.
 *  - **the on-screen test is inclusive at BOTH edges.** A bar sitting exactly on
 *    the left or right edge of the lane is on screen and must hold its x; one
 *    pixel further out is not and must centre. The boundary cases are spelled
 *    out because `<` for `<=` is invisible to a fixture that sits in the middle.
 */

// A deliberately off-identity viewport: a non-zero scroll, an spp that is not 1,
// a lane width that is not a round multiple of anything, and an anchor that is
// neither the scroll nor the centre. Nothing here reads the same by accident.
const ZOOM = { samplesPerPixel: 100, scrollSample: 10_000 };
const LANE = 800;
const ANCHOR = 30_000; // x = (30 000 − 10 000) / 100 = 200 px
const X = 200;

/** Where the anchor lands, in lane-local px, once `spp` has been committed. */
function anchorX(scroll: number, spp: number): number {
  return (ANCHOR - scroll) / spp;
}

describe('anchoredZoom — an on-screen bar keeps its x', () => {
  // Three DISTINCT doubles. `1 / 1.25` and `0.8` are the same number, so listing
  // both would have bought a third case that tests nothing; `2` and `0.5` are a
  // coarser pair than one wheel notch, which is where a factor applied twice or
  // inverted shows up most clearly.
  it.each([
    ['in one notch', 1 / 1.25],
    ['out one notch', 1.25],
    ['out hard', 2],
    ['in hard', 0.5],
  ])('zooming %s scales spp by the factor and holds the bar at x = 200', (_label, factor) => {
    const req = anchoredZoom({ zoom: ZOOM, laneWidth: LANE, anchorSample: ANCHOR, factor });

    expect(req.samplesPerPixel).toBeCloseTo(100 * factor, 9);
    // The literal rule, not a restatement of the implementation: the new scroll
    // is the anchor minus the 200 px it must stay to the right of.
    const spp = req.samplesPerPixel;
    expect(req.scrollSample(spp)).toBeCloseTo(ANCHOR - X * spp, 9);
    expect(anchorX(req.scrollSample(spp), spp)).toBeCloseTo(X, 9);
  });

  it('holds the bar at the x the RESOLVED spp implies, not the requested one', () => {
    // The zoom-out limit: the caller asked for 125 samples/px, the store could
    // only give 137. Computing the scroll from 125 would put the bar at
    // (30 000 − 5 000) / 137 = 182 px — 18 px of drift on one wheel notch.
    const req = anchoredZoom({ zoom: ZOOM, laneWidth: LANE, anchorSample: ANCHOR, factor: 1.25 });
    expect(req.samplesPerPixel).toBeCloseTo(125, 9);

    const clamped = 137;
    expect(clamped).not.toBeCloseTo(req.samplesPerPixel, 3);
    expect(req.scrollSample(clamped)).toBeCloseTo(ANCHOR - X * clamped, 9);
    expect(anchorX(req.scrollSample(clamped), clamped)).toBeCloseTo(X, 9);
  });

  it('holds a bar sitting exactly on the left edge (x = 0) and on the right edge (x = lane)', () => {
    // The inclusive boundary. `x >= 0` mutated to `x > 0`, or `x <= lane` to
    // `x < lane`, teleports a bar the user has just scrolled hard against an
    // edge into the middle of the lane.
    const left = anchoredZoom({
      zoom: ZOOM,
      laneWidth: LANE,
      anchorSample: ZOOM.scrollSample, // x = 0
      factor: 1.25,
    });
    expect(left.scrollSample(left.samplesPerPixel)).toBeCloseTo(ZOOM.scrollSample, 9);

    const rightAnchor = ZOOM.scrollSample + LANE * ZOOM.samplesPerPixel; // x = 800
    const right = anchoredZoom({
      zoom: ZOOM,
      laneWidth: LANE,
      anchorSample: rightAnchor,
      factor: 1.25,
    });
    const spp = right.samplesPerPixel;
    expect(right.scrollSample(spp)).toBeCloseTo(rightAnchor - LANE * spp, 9);
  });
});

describe('anchoredZoom — an off-screen bar is centred', () => {
  it('centres a bar off the LEFT edge', () => {
    // anchor 500 → x = (500 − 10 000) / 100 = −95 px.
    const req = anchoredZoom({ zoom: ZOOM, laneWidth: LANE, anchorSample: 500, factor: 1.25 });
    const spp = req.samplesPerPixel;
    expect(req.scrollSample(spp)).toBeCloseTo(500 - (LANE / 2) * spp, 9);
    expect((500 - req.scrollSample(spp)) / spp).toBeCloseTo(LANE / 2, 9);
  });

  it('centres a bar off the RIGHT edge', () => {
    // anchor 200 000 → x = (200 000 − 10 000) / 100 = 1900 px, past a 800 px lane.
    const req = anchoredZoom({ zoom: ZOOM, laneWidth: LANE, anchorSample: 200_000, factor: 0.8 });
    const spp = req.samplesPerPixel;
    expect(req.scrollSample(spp)).toBeCloseTo(200_000 - (LANE / 2) * spp, 9);
    expect((200_000 - req.scrollSample(spp)) / spp).toBeCloseTo(LANE / 2, 9);
  });

  it('centres one pixel outside either edge — the other half of the boundary', () => {
    const justLeft = ZOOM.scrollSample - ZOOM.samplesPerPixel; // x = −1
    const l = anchoredZoom({ zoom: ZOOM, laneWidth: LANE, anchorSample: justLeft, factor: 1.25 });
    expect(l.scrollSample(l.samplesPerPixel)).toBeCloseTo(
      justLeft - (LANE / 2) * l.samplesPerPixel,
      9
    );

    const justRight = ZOOM.scrollSample + (LANE + 1) * ZOOM.samplesPerPixel; // x = 801
    const r = anchoredZoom({ zoom: ZOOM, laneWidth: LANE, anchorSample: justRight, factor: 1.25 });
    expect(r.scrollSample(r.samplesPerPixel)).toBeCloseTo(
      justRight - (LANE / 2) * r.samplesPerPixel,
      9
    );
  });

  it('centres on the RESOLVED spp too, so a clamped zoom-out still lands centred', () => {
    const req = anchoredZoom({ zoom: ZOOM, laneWidth: LANE, anchorSample: 500, factor: 1.25 });
    const clamped = 137;
    expect(clamped).not.toBeCloseTo(req.samplesPerPixel, 3);
    expect((500 - req.scrollSample(clamped)) / clamped).toBeCloseTo(LANE / 2, 9);
  });
});

describe('anchoredZoom — an unmeasured lane', () => {
  it('treats laneWidth 0 as a centre on a zero-wide lane: scroll = anchor', () => {
    // Both viewport modules fall back to a nominal width rather than reporting
    // 0, but a caller reading a rect before layout can still hand this a 0, and
    // `anchor − (0 / 2) · spp` is the only answer that keeps the bar visible
    // (at x = 0) instead of writing a scroll derived from a NaN half-width.
    const req = anchoredZoom({ zoom: ZOOM, laneWidth: 0, anchorSample: ANCHOR, factor: 1.25 });
    expect(req.scrollSample(req.samplesPerPixel)).toBe(ANCHOR);
    expect(req.scrollSample(9_999)).toBe(ANCHOR);
  });

  it('treats a negative or non-finite lane the same way', () => {
    for (const laneWidth of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const req = anchoredZoom({ zoom: ZOOM, laneWidth, anchorSample: ANCHOR, factor: 1.25 });
      expect(req.scrollSample(req.samplesPerPixel)).toBe(ANCHOR);
    }
  });

  it('centres rather than emitting NaN when the incoming spp is 0', () => {
    // The store's `MIN_SPP` floor makes this unreachable from a committed zoom,
    // but the helper is handed a zoom rather than reading one, so the claim in
    // its docblock — an unusable x falls through to the centre arm — is pinned
    // rather than asserted. A NaN scroll would resolve to 0 and throw the view
    // back to the start of the document.
    const req = anchoredZoom({
      zoom: { samplesPerPixel: 0, scrollSample: 10_000 },
      laneWidth: LANE,
      anchorSample: ANCHOR,
      factor: 1.25,
    });
    const scroll = req.scrollSample(200);
    expect(Number.isFinite(scroll)).toBe(true);
    expect(scroll).toBeCloseTo(ANCHOR - (LANE / 2) * 200, 9);
  });
});
