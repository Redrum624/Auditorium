import {
  SPATIAL_NEUTRAL,
  SPATIAL_REF_DISTANCE,
  spatialDistanceGain,
  spatialPanPosition,
} from './spatial';

// ---------------------------------------------------------------------------
// F5 — the spatial projection law, pinned against INDEPENDENTLY computed
// expectations: every expected value below is written out from the law's
// definition (sin/cos/ratios inline), never by calling the implementation —
// so an identically-wrong pair still fails. Comparisons are probed per
// operand role, below / on / above each boundary.
// ---------------------------------------------------------------------------

describe('F5 spatialPanPosition — the interaural-axis projection sin(az)·cos(el)', () => {
  it('cardinal azimuths at ear level (el 0): front/back centre, ±90 hard sides', () => {
    expect(spatialPanPosition(0, 0)).toBe(0); // dead ahead → centre
    expect(spatialPanPosition(90, 0)).toBeCloseTo(1, 12); // hard right
    expect(spatialPanPosition(-90, 0)).toBeCloseTo(-1, 12); // hard left
    expect(spatialPanPosition(180, 0)).toBeCloseTo(0, 12); // directly behind → centre
    expect(spatialPanPosition(-180, 0)).toBeCloseTo(0, 12); // same direction as +180
  });

  it('intermediate azimuths follow sin(az) exactly (written from the formula)', () => {
    expect(spatialPanPosition(30, 0)).toBeCloseTo(Math.sin(Math.PI / 6), 12); // 0.5
    expect(spatialPanPosition(45, 0)).toBeCloseTo(Math.SQRT1_2, 12);
    expect(spatialPanPosition(-45, 0)).toBeCloseTo(-Math.SQRT1_2, 12);
    // Just below / above the hard-side boundary: |sin| < 1 on BOTH sides of 90°
    expect(spatialPanPosition(89, 0)).toBeLessThan(1);
    expect(spatialPanPosition(91, 0)).toBeLessThan(1);
    expect(spatialPanPosition(91, 0)).toBeCloseTo(spatialPanPosition(89, 0), 12);
  });

  it('a rear source mirrors its front image (sin symmetry — the documented fold)', () => {
    expect(spatialPanPosition(150, 0)).toBeCloseTo(Math.sin(Math.PI / 6), 12); // = 30°
    expect(spatialPanPosition(-135, 0)).toBeCloseTo(-Math.SQRT1_2, 12); // = −45°
  });

  it('elevation narrows the image by cos(el): probes below / on / above ear level', () => {
    // az 90 (hard right at el 0), elevation sweeping:
    expect(spatialPanPosition(90, -45)).toBeCloseTo(Math.cos(Math.PI / 4), 12); // below
    expect(spatialPanPosition(90, 0)).toBeCloseTo(1, 12); // on
    expect(spatialPanPosition(90, 45)).toBeCloseTo(Math.cos(Math.PI / 4), 12); // above
    // Zenith and nadir collapse to centre REGARDLESS of azimuth:
    expect(spatialPanPosition(90, 90)).toBeCloseTo(0, 12);
    expect(spatialPanPosition(-137, -90)).toBeCloseTo(0, 12);
    // Combined: az 45, el 60 → sin(45°)·cos(60°) = 0.7071·0.5
    expect(spatialPanPosition(45, 60)).toBeCloseTo(Math.SQRT1_2 * 0.5, 12);
  });

  it('stays within [-1, 1] over the whole legal grid (feeds the pan laws unclamped)', () => {
    for (let az = -180; az <= 180; az += 15) {
      for (let el = -90; el <= 90; el += 15) {
        const p = spatialPanPosition(az, el);
        expect(p).toBeGreaterThanOrEqual(-1);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('F5 spatialDistanceGain — inverse law 1/max(1, d), unity inside the reference', () => {
  it('probes below / on / above the reference distance', () => {
    expect(spatialDistanceGain(0)).toBe(1); // at the listener: clamped, no boost
    expect(spatialDistanceGain(0.5)).toBe(1); // inside the reference: unity
    expect(spatialDistanceGain(1)).toBe(1); // ON the reference
    expect(spatialDistanceGain(1.5)).toBeCloseTo(1 / 1.5, 12); // just outside: attenuating
    expect(spatialDistanceGain(2)).toBe(0.5); // −6.02 dB, written from 1/d
    expect(spatialDistanceGain(10)).toBe(0.1); // range max: −20 dB
  });

  it('is monotonically non-increasing across the boundary', () => {
    let prev = Infinity;
    for (const d of [0, 0.25, 0.5, 0.99, 1, 1.01, 2, 5, 10]) {
      const g = spatialDistanceGain(d);
      expect(g).toBeLessThanOrEqual(prev);
      prev = g;
    }
  });

  it('matches the dB expectation of the inverse law at named depths', () => {
    // 20·log10(1/d): d=2 → −6.0206 dB, d=10 → −20 dB (independent arithmetic).
    expect(20 * Math.log10(spatialDistanceGain(2))).toBeCloseTo(-6.0206, 3);
    expect(20 * Math.log10(spatialDistanceGain(10))).toBeCloseTo(-20, 12);
  });
});

describe('F5 SPATIAL_NEUTRAL — the no-lane position is exactly neutral', () => {
  it('projects to exact centre at exactly unity gain', () => {
    expect(SPATIAL_NEUTRAL).toEqual({ azimuth: 0, elevation: 0, distance: 1 });
    expect(SPATIAL_REF_DISTANCE).toBe(1);
    expect(spatialPanPosition(SPATIAL_NEUTRAL.azimuth, SPATIAL_NEUTRAL.elevation)).toBe(0);
    expect(spatialDistanceGain(SPATIAL_NEUTRAL.distance)).toBe(1);
  });
});
