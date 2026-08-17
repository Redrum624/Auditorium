import { laneRawStart, snapClipStart } from './clipDropPosition';

/**
 * Task F11-4 — the shared position arithmetic, tested where it is now pure.
 *
 * These are the same rules `ClipView.snap.test.tsx` proves through real pointer
 * events on a drag; here they are pinned on the function ITSELF, because a
 * second caller (the lane drop) now depends on them and must not have to
 * re-prove them through a second UI.
 *
 * W2 — the targets arrive as PRIORITY TIERS (edges+cursor / markers / beats,
 * `sessionSnapTiers`'s order) and the result names the winning tier so the
 * drop ghost can show WHAT kind of target took the clip.
 */

const SPP = 100; // 1 CSS px == 100 samples -> the 8 px tolerance is 800 samples

/** Beats only — the common pre-W2 shape, tiers 0 and 1 empty. */
const beatTiers = (beats: number[]): number[][] => [[], [], beats];

describe('laneRawStart', () => {
  it('maps a viewport x to a session sample RELATIVE to the lane, not the window', () => {
    // The lane starts 224 px into the window (the header column). A pointer at
    // clientX 324 is 100 px into the lane => 10 000 samples at this zoom.
    expect(laneRawStart(324, 224, { samplesPerPixel: SPP, scrollSample: 0 })).toBe(10_000);
  });

  it('adds the lane scroll', () => {
    expect(laneRawStart(324, 224, { samplesPerPixel: SPP, scrollSample: 50_000 })).toBe(60_000);
  });

  it('goes negative left of the lane origin (clamping is snapClipStart s job)', () => {
    expect(laneRawStart(200, 224, { samplesPerPixel: SPP, scrollSample: 0 })).toBe(-2400);
  });
});

describe('snapClipStart', () => {
  const targets = beatTiers([0, 22_050, 44_100, 66_150]);

  it('pulls the HEAD onto a target within tolerance', () => {
    // 300 samples = 3 px past the beat at 22 050 -> inside the 8 px radius.
    expect(snapClipStart(22_350, 20_000, targets, SPP, false).start).toBe(22_050);
  });

  it('pulls the TAIL onto a target when that edge needs the smaller correction', () => {
    // A 20 000-sample clip whose tail sits 200 samples short of 44 100: the
    // head (at 23 900) is 1850 from the nearest target, the tail 200.
    expect(snapClipStart(23_900, 20_000, targets, SPP, false).start).toBe(24_100);
  });

  it('leaves a position alone when nothing is within the pixel tolerance', () => {
    // 33 000 is 10 950 samples (109 px) from the nearest beat.
    expect(snapClipStart(33_000, 20_000, targets, SPP, false)).toEqual({
      start: 33_000,
      tier: null,
    });
  });

  it('does not snap while suspended — the raw position survives, rounded', () => {
    expect(snapClipStart(22_350.4, 20_000, targets, SPP, true)).toEqual({
      start: 22_350,
      tier: null,
    });
  });

  it('does not snap with an empty target set', () => {
    expect(snapClipStart(22_350.4, 20_000, [], SPP, false)).toEqual({ start: 22_350, tier: null });
    expect(snapClipStart(22_350.4, 20_000, [[], [], []], SPP, false).start).toBe(22_350);
  });

  it('clamps to 0 — a tail snap may ask for a start before the timeline', () => {
    // Tail at 22 050 with a 40 000-sample clip means a start of -17 950.
    const clamped = snapClipStart(-17_800, 40_000, targets, SPP, false);
    expect(clamped.start).toBe(0);
    // The clamp moved the commit OFF the winning target, so no tier label
    // survives it — a ghost painted edge-white for a snap the drop no longer
    // makes would lie (review W2, nit 3).
    expect(clamped.tier).toBeNull();
    expect(snapClipStart(-500, 20_000, [], SPP, false).start).toBe(0);
  });

  it('returns a whole sample even when the raw position is fractional', () => {
    expect(Number.isInteger(snapClipStart(1234.567, 20_000, [], SPP, false).start)).toBe(true);
  });

  it('scales the tolerance with the zoom, never with a sample constant', () => {
    // 800 samples away: inside 8 px at 100 samples/px, far outside it at 10.
    expect(snapClipStart(22_850, 20_000, targets, 100, false).start).toBe(22_050);
    expect(snapClipStart(22_850, 20_000, targets, 10, false).start).toBe(22_850);
  });

  it('W2: lands the head SAMPLE-EXACT on another clip’s edge — the butt join', () => {
    // The predecessor ends at 179 999 (an odd number on purpose: only an exact
    // sample equality survives it — "within a millisecond" is 44 samples off).
    const r = snapClipStart(180_250, 20_000, [[179_999], [], []], SPP, false);
    expect(r).toEqual({ start: 179_999, tier: 0 });
  });

  it('W2: an EDGE outranks a strictly NEARER beat — tier priority through the shared resolver', () => {
    // Beat at 100 100 is 100 samples from the raw start; edge at 100 400 is
    // 400. Flat nearest-wins would take the beat; the tiers take the edge.
    const r = snapClipStart(100_000, 20_000, [[100_400], [], [100_100]], SPP, false);
    expect(r).toEqual({ start: 100_400, tier: 0 });
  });

  it('W2: names the winning tier for the ghost — marker 1, beat 2, unsnapped null', () => {
    expect(snapClipStart(50_100, 20_000, [[], [50_000], []], SPP, false).tier).toBe(1);
    expect(snapClipStart(22_350, 20_000, targets, SPP, false).tier).toBe(2);
    expect(snapClipStart(33_000, 20_000, targets, SPP, false).tier).toBeNull();
  });
});
