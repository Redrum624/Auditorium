import { SNAP_TOLERANCE_PX, mergeTargets, snapSample, snapSpan } from './snap';

// The snap engine is a PURE function of (position, targets, samplesPerPixel,
// tolerancePx) — plan ruling: "Snap must never move something the user did not
// drag, and must be a pure function of (position, targets, tolerance) so it is
// testable without the DOM". Nothing below touches the DOM, a store or a clock.

describe('snapSample — nearest target', () => {
  const spp = 100; // 1 CSS px == 100 samples, so the 8px tolerance is 800 samples

  it('pulls a position onto the single target inside the tolerance', () => {
    const r = snapSample(10_300, [10_000], spp);
    expect(r.snapped).toBe(true);
    expect(r.sample).toBe(10_000);
    expect(r.target).toBe(10_000);
  });

  it('picks the NEAREST target when several are inside the tolerance', () => {
    // 9800 is 2px away, 10 000 is 0.5px away, 10 400 is 3.5px away.
    const r = snapSample(10_050, [9_800, 10_000, 10_400], spp);
    expect(r.sample).toBe(10_000);
  });

  it('picks the nearest target when it is BEHIND the position', () => {
    const r = snapSample(10_450, [10_000, 10_400, 11_500], spp);
    expect(r.sample).toBe(10_400);
  });

  it('leaves the position untouched when the nearest target is outside the tolerance', () => {
    // 900 samples == 9px at spp 100, past the 8px tolerance.
    const r = snapSample(10_900, [10_000], spp);
    expect(r.snapped).toBe(false);
    expect(r.sample).toBe(10_900);
    expect(r.target).toBeNull();
  });

  it('never returns a position that is not one of the targets when it snaps', () => {
    const targets = [0, 22_050, 44_100, 66_150];
    for (let p = 0; p <= 70_000; p += 137) {
      const r = snapSample(p, targets, spp);
      if (r.snapped) expect(targets).toContain(r.sample);
      else expect(r.sample).toBe(p);
    }
  });
});

describe('snapSample — tie-break', () => {
  it('prefers the EARLIER target when two are exactly equidistant', () => {
    // 10 000 and 10 200 are both 100 samples (1px) from 10 100.
    const r = snapSample(10_100, [10_000, 10_200], 100);
    expect(r.sample).toBe(10_000);
  });

  it('is deterministic regardless of how many equidistant pairs precede it', () => {
    const targets = [0, 200, 400, 600];
    expect(snapSample(100, targets, 100).sample).toBe(0);
    expect(snapSample(300, targets, 100).sample).toBe(200);
    expect(snapSample(500, targets, 100).sample).toBe(400);
  });
});

describe('snapSample — tolerance boundary', () => {
  const spp = 100;

  it('snaps at EXACTLY the tolerance distance (inclusive, like exceedsDragThreshold)', () => {
    const exact = SNAP_TOLERANCE_PX * spp; // 800 samples == 8px
    const r = snapSample(10_000 + exact, [10_000], spp);
    expect(r.snapped).toBe(true);
    expect(r.sample).toBe(10_000);
  });

  it('does NOT snap one sample past the tolerance', () => {
    const exact = SNAP_TOLERANCE_PX * spp;
    const r = snapSample(10_000 + exact + 1, [10_000], spp);
    expect(r.snapped).toBe(false);
  });

  it('honours an explicit tolerance argument over the default', () => {
    expect(snapSample(10_500, [10_000], 100, 4).snapped).toBe(false); // 5px > 4px
    expect(snapSample(10_500, [10_000], 100, 6).snapped).toBe(true); // 5px <= 6px
  });

  it('a zero or negative tolerance disables snapping entirely', () => {
    expect(snapSample(10_000, [10_000], 100, 0).snapped).toBe(false);
    expect(snapSample(10_001, [10_000], 100, -5).snapped).toBe(false);
  });
});

describe('snapSample — the tolerance is in PIXELS, not samples', () => {
  // THE mutation check the brief calls out: replacing `tolerancePx *
  // samplesPerPixel` with a fixed sample tolerance looks right at one zoom and
  // is wrong at every other one. Both cases below use the SAME sample distance
  // and differ only in zoom.
  const target = 44_100;
  const distanceSamples = 2_000;

  it('snaps a 2000-sample gap when zoomed OUT (2000 samples == 4px at spp 500)', () => {
    const r = snapSample(target + distanceSamples, [target], 500);
    expect(r.snapped).toBe(true);
    expect(r.sample).toBe(target);
  });

  it('does NOT snap the same 2000-sample gap when zoomed IN (2000 samples == 40px at spp 50)', () => {
    const r = snapSample(target + distanceSamples, [target], 50);
    expect(r.snapped).toBe(false);
    expect(r.sample).toBe(target + distanceSamples);
  });

  it('the sample distance that snaps scales linearly with samplesPerPixel', () => {
    for (const spp of [1, 8, 64, 512, 4096]) {
      const tol = SNAP_TOLERANCE_PX * spp;
      expect(snapSample(target + tol, [target], spp).snapped).toBe(true);
      expect(snapSample(target + tol + 1, [target], spp).snapped).toBe(false);
    }
  });
});

describe('snapSample — degenerate inputs', () => {
  it('an EMPTY target set is a no-op', () => {
    const r = snapSample(1234.5, [], 100);
    expect(r.snapped).toBe(false);
    expect(r.sample).toBe(1234.5);
    expect(r.target).toBeNull();
  });

  it('refuses to invent a scale: a non-positive or non-finite samplesPerPixel is a no-op', () => {
    for (const spp of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = snapSample(10_050, [10_000], spp);
      expect(r.snapped).toBe(false);
      expect(r.sample).toBe(10_050);
    }
  });

  it('a non-finite position is returned untouched', () => {
    expect(snapSample(Number.NaN, [10_000], 100).snapped).toBe(false);
  });

  it('targets far OUTSIDE the visible window never win — distance is all that matters', () => {
    // A viewport showing [0, 100 000): a target at 5 000 000 is 49 900 px away.
    const r = snapSample(50_000, [5_000_000], 100);
    expect(r.snapped).toBe(false);
    expect(r.sample).toBe(50_000);
  });

  it('scrolling the view does not change the answer (the engine has no view)', () => {
    // Same position/target pair, evaluated as if the window had scrolled: the
    // engine only ever sees absolute samples, so the result cannot depend on it.
    expect(snapSample(10_050, [10_000], 100)).toEqual(snapSample(10_050, [10_000], 100));
  });

  it('does not mutate the target array it is given', () => {
    const targets = Int32Array.from([10_000, 9_000, 11_000]);
    const before = Array.from(targets);
    snapSample(9_950, targets, 100);
    expect(Array.from(targets)).toEqual(before);
  });
});

describe('snapSample — an unsnapped position keeps its FLOAT value', () => {
  // Trap 21: cursorSample/selection are floats today and two existing tests pin
  // exact float equality. The engine therefore rounds NOTHING — it either
  // returns a target (an integer, because every target source is integral) or
  // the caller's own value, bit for bit.
  it('returns the exact input value, decimals included, when nothing is near', () => {
    const r = snapSample(1024.5, [50_000], 512);
    expect(r.sample).toBe(1024.5);
  });

  it('returns the exact input value when the target set is empty', () => {
    const r = snapSample(2 * 512, [], 512);
    expect(r.sample).toBe(1024);
  });
});

describe('snapSample — cost on a long grid', () => {
  it('reads only a handful of targets (binary search, not a scan)', () => {
    const n = 100_000;
    const raw = new Int32Array(n);
    for (let i = 0; i < n; i++) raw[i] = i * 1000;
    let reads = 0;
    const counting = new Proxy(raw, {
      // No `receiver` — a typed array's own getters reject a Proxy receiver.
      get(t, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) reads++;
        return Reflect.get(t, prop);
      },
    }) as unknown as ArrayLike<number>;

    const r = snapSample(50_000_400, counting, 100);
    expect(r.sample).toBe(50_000_000);
    expect(reads).toBeLessThan(40); // a linear scan reads 100 000
  });
});

describe('snapSpan — which EDGE of a dragged span snaps', () => {
  const spp = 100;
  const length = 10_000;

  it('snaps the START edge when it is the closer of the two', () => {
    const r = snapSpan(10_100, length, [10_000, 25_000], spp);
    expect(r.snapped).toBe(true);
    expect(r.sample).toBe(10_000);
    expect(r.target).toBe(10_000);
  });

  it('snaps the END edge, returning the START that puts the end on the target', () => {
    // start 10 100 -> end 20 100; only 20 000 is near, 1px away.
    const r = snapSpan(10_100, length, [20_000], spp);
    expect(r.snapped).toBe(true);
    expect(r.sample).toBe(10_000); // 20 000 - length
    expect(r.target).toBe(20_000);
  });

  it('prefers the edge with the SMALLER correction when both are in range', () => {
    // start 10_100: start edge is 100 samples (1px) from 10 000;
    // end 20_100: end edge is 500 samples (5px) from 20 600.
    const r = snapSpan(10_100, length, [10_000, 20_600], spp);
    expect(r.sample).toBe(10_000);

    // Now make the end edge the closer one.
    const r2 = snapSpan(10_600, length, [10_000, 20_650], spp);
    expect(r2.sample).toBe(10_650); // end 20 650 -> start 10 650, a 50-sample pull
  });

  it('prefers the START edge on an exact tie', () => {
    // start 10 100 is 100 samples from 10 000; end 20 100 is 100 samples from 20 200.
    const r = snapSpan(10_100, length, [10_000, 20_200], spp);
    expect(r.sample).toBe(10_000);
  });

  it('is a no-op when neither edge is in range', () => {
    const r = snapSpan(10_100, length, [50_000], spp);
    expect(r.snapped).toBe(false);
    expect(r.sample).toBe(10_100);
  });

  it('is a no-op with an empty target set', () => {
    const r = snapSpan(10_100.25, length, [], spp);
    expect(r.snapped).toBe(false);
    expect(r.sample).toBe(10_100.25);
  });
});

describe('mergeTargets', () => {
  it('merges, sorts ascending and de-duplicates', () => {
    expect(mergeTargets([30, 10], [20, 10], Int32Array.from([40]))).toEqual([10, 20, 30, 40]);
  });

  it('drops non-finite entries rather than letting them poison a comparison', () => {
    expect(mergeTargets([10, Number.NaN, 20, Number.POSITIVE_INFINITY])).toEqual([10, 20]);
  });

  it('returns an empty array for no lists / all-empty lists', () => {
    expect(mergeTargets()).toEqual([]);
    expect(mergeTargets([], new Int32Array(0))).toEqual([]);
  });

  it('does not mutate its inputs', () => {
    const a = [30, 10];
    mergeTargets(a);
    expect(a).toEqual([30, 10]);
  });
});
