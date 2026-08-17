import { fadeInShape, FADE_CURVES, type FadeCurve } from '../dsp/fades';
import {
  AUTOMATION_PARAMS,
  DEFAULT_AUTOMATION_CURVE,
  automationValueAt,
  clampAutomationValue,
  resolveAutomation,
  sanitizeAutomationLanes,
  wrapAzimuth,
  wrapAzimuthDelta,
  type AutomationKey,
  type AutomationLane,
} from './automation';

// ---------------------------------------------------------------------------
// F0 — the shared evaluator. These fixtures follow the boundary-probe
// discipline: every comparison is probed per operand role, below / on / above
// the boundary, with key values chosen so that picking the wrong segment (or
// the wrong hold) MOVES the output — a fixture the boundary cannot move is
// blind to an off-by-one.
// ---------------------------------------------------------------------------

function key(positionSample: number, value: number, curve?: FadeCurve): AutomationKey {
  return curve === undefined ? { positionSample, value } : { positionSample, value, curve };
}

describe('automationValueAt — hold regions', () => {
  // Distinct first/last values so holding the WRONG end is visible.
  const keys = [key(100, -6), key(500, 3)];

  it('holds the FIRST key value before the first key, up to the exact boundary sample', () => {
    expect(automationValueAt(keys, 0, 'volumeDb')).toBe(-6);
    expect(automationValueAt(keys, 99, 'volumeDb')).toBe(-6); // one below the boundary
    expect(automationValueAt(keys, 100, 'volumeDb')).toBe(-6); // exactly ON the first key
    // one above: the segment has begun — equal-gain from -6 toward 3
    expect(automationValueAt(keys, 101, 'volumeDb')).toBeCloseTo(-6 + 9 * (1 / 400), 12);
    expect(automationValueAt(keys, 101, 'volumeDb')).not.toBe(-6);
  });

  it('holds the LAST key value from the exact last-key sample onward', () => {
    // one below: still interpolating (not yet the held value)
    expect(automationValueAt(keys, 499, 'volumeDb')).toBeCloseTo(-6 + 9 * (399 / 400), 12);
    expect(automationValueAt(keys, 499, 'volumeDb')).not.toBe(3);
    expect(automationValueAt(keys, 500, 'volumeDb')).toBe(3); // exactly ON the last key
    expect(automationValueAt(keys, 501, 'volumeDb')).toBe(3); // one above
    expect(automationValueAt(keys, 1_000_000, 'volumeDb')).toBe(3); // far past — held, never extrapolated
  });

  it('a one-key lane holds its value over the whole timeline', () => {
    const one = [key(300, -12.5)];
    expect(automationValueAt(one, 0, 'volumeDb')).toBe(-12.5);
    expect(automationValueAt(one, 299, 'volumeDb')).toBe(-12.5);
    expect(automationValueAt(one, 300, 'volumeDb')).toBe(-12.5);
    expect(automationValueAt(one, 301, 'volumeDb')).toBe(-12.5);
    expect(automationValueAt(one, 10_000_000, 'volumeDb')).toBe(-12.5);
  });
});

describe('automationValueAt — a sample exactly ON a key returns that key value EXACTLY', () => {
  it('for a middle key whose neighbours would produce a different value', () => {
    // −6.1 → 3.3 → 0.7 → 0.1: every adjacent pair satisfies
    // `v0 + (v1 − v0) !== v1` in doubles (verified numerically), so an
    // implementation that evaluates an on-key sample as the END of the
    // previous segment (u = 1) instead of the START of its own (u = 0) is
    // caught by EXACT equality — `v0 + (v1 − v0)·1` lands an ulp off the key
    // value, while `v1 + (…)·0` cannot move it.
    const keys = [key(0, -6.1), key(200, 3.3), key(600, 0.7), key(900, 0.1)];
    expect(automationValueAt(keys, 0, 'volumeDb')).toBe(-6.1);
    expect(automationValueAt(keys, 200, 'volumeDb')).toBe(3.3);
    expect(automationValueAt(keys, 600, 'volumeDb')).toBe(0.7);
    expect(automationValueAt(keys, 900, 'volumeDb')).toBe(0.1);
  });
});

describe('automationValueAt — segment selection at key boundaries', () => {
  // Three keys, three DIFFERENT curves and non-collinear values: evaluating
  // the sample just below / just above a middle key with the wrong segment
  // (wrong endpoints AND wrong curve) moves the output.
  const keys = [key(0, 0, 'equal-gain'), key(400, 10, 'exponential'), key(800, -20, 'smooth')];

  it('one below the middle key: segment 0 (equal-gain 0 -> 10)', () => {
    expect(automationValueAt(keys, 399, 'volumeDb')).toBeCloseTo(0 + 10 * fadeInShape(399 / 400, 'equal-gain'), 12);
  });

  it('exactly on the middle key: the key value', () => {
    expect(automationValueAt(keys, 400, 'volumeDb')).toBe(10);
  });

  it('one above the middle key: segment 1 (exponential 10 -> -20)', () => {
    expect(automationValueAt(keys, 401, 'volumeDb')).toBeCloseTo(10 + -30 * fadeInShape(1 / 400, 'exponential'), 12);
    // sanity: the two candidate segments genuinely disagree here
    expect(automationValueAt(keys, 401, 'volumeDb')).not.toBeCloseTo(0 + 10 * fadeInShape(401 / 400, 'equal-gain'), 6);
  });
});

describe('automationValueAt — every curve interpolates as the shared fades.ts family says', () => {
  it.each(FADE_CURVES.map((c) => [c] as [FadeCurve]))('%s', (curve) => {
    const keys = [key(1000, -24, curve), key(2000, 6)];
    // quarter / mid / three-quarter probes, plus off-grid
    for (const s of [1250, 1500, 1750, 1333]) {
      const u = (s - 1000) / 1000;
      expect(automationValueAt(keys, s, 'volumeDb')).toBe(-24 + 30 * fadeInShape(u, curve));
    }
  });

  it('an absent curve means DEFAULT_AUTOMATION_CURVE (equal-gain: the straight segment)', () => {
    const keys = [key(0, 0), key(100, 1)];
    expect(DEFAULT_AUTOMATION_CURVE).toBe('equal-gain');
    expect(automationValueAt(keys, 25, 'volumeDb')).toBe(0 + 1 * fadeInShape(0.25, 'equal-gain'));
    expect(automationValueAt(keys, 25, 'volumeDb')).toBeCloseTo(0.25, 12);
  });
});

describe('clampAutomationValue — per-param range boundaries (below / on / above)', () => {
  it('volumeDb clamps to [-60, 12]', () => {
    expect(clampAutomationValue('volumeDb', -60.001)).toBe(-60);
    expect(clampAutomationValue('volumeDb', -60)).toBe(-60);
    expect(clampAutomationValue('volumeDb', -59.999)).toBe(-59.999);
    expect(clampAutomationValue('volumeDb', 11.999)).toBe(11.999);
    expect(clampAutomationValue('volumeDb', 12)).toBe(12);
    expect(clampAutomationValue('volumeDb', 12.001)).toBe(12);
  });

  it('pan clamps to [-1, 1]', () => {
    expect(clampAutomationValue('pan', -1.001)).toBe(-1);
    expect(clampAutomationValue('pan', -1)).toBe(-1);
    expect(clampAutomationValue('pan', -0.999)).toBe(-0.999);
    expect(clampAutomationValue('pan', 0.999)).toBe(0.999);
    expect(clampAutomationValue('pan', 1)).toBe(1);
    expect(clampAutomationValue('pan', 1.001)).toBe(1);
  });

  it('F5 — azimuth clamps to [-180, 180] (a CLAMP, not a wrap: only the evaluator wraps)', () => {
    expect(clampAutomationValue('azimuth', -180.001)).toBe(-180);
    expect(clampAutomationValue('azimuth', -180)).toBe(-180);
    expect(clampAutomationValue('azimuth', -179.999)).toBe(-179.999);
    expect(clampAutomationValue('azimuth', 179.999)).toBe(179.999);
    expect(clampAutomationValue('azimuth', 180)).toBe(180);
    expect(clampAutomationValue('azimuth', 180.001)).toBe(180);
  });

  it('F5 — elevation clamps to [-90, 90]', () => {
    expect(clampAutomationValue('elevation', -90.001)).toBe(-90);
    expect(clampAutomationValue('elevation', -90)).toBe(-90);
    expect(clampAutomationValue('elevation', -89.999)).toBe(-89.999);
    expect(clampAutomationValue('elevation', 89.999)).toBe(89.999);
    expect(clampAutomationValue('elevation', 90)).toBe(90);
    expect(clampAutomationValue('elevation', 90.001)).toBe(90);
  });

  it('F5 — distance clamps to [0, 10]', () => {
    expect(clampAutomationValue('distance', -0.001)).toBe(0);
    expect(clampAutomationValue('distance', 0)).toBe(0);
    expect(clampAutomationValue('distance', 0.001)).toBe(0.001);
    expect(clampAutomationValue('distance', 9.999)).toBe(9.999);
    expect(clampAutomationValue('distance', 10)).toBe(10);
    expect(clampAutomationValue('distance', 10.001)).toBe(10);
  });
});

describe('resolveAutomation — the shared has-automation gate', () => {
  it('absent, empty, and zero-key lanes are all null (zero keys === no lane === no field)', () => {
    expect(resolveAutomation(undefined)).toBeNull();
    expect(resolveAutomation([])).toBeNull();
    expect(resolveAutomation([{ param: 'volumeDb', keys: [] }])).toBeNull();
    expect(
      resolveAutomation([
        { param: 'volumeDb', keys: [] },
        { param: 'pan', keys: [] },
      ])
    ).toBeNull();
  });

  it('one active lane resolves with the other param null', () => {
    const keys = [key(0, -3)];
    const spec = resolveAutomation([{ param: 'volumeDb', keys }]);
    expect(spec).not.toBeNull();
    expect(spec?.volume).toBe(keys); // the lane's own array, not a copy
    expect(spec?.pan).toBeNull();
  });

  it('both lanes resolve; a hostile duplicate param resolves to the LAST lane', () => {
    const vol1 = [key(0, -3)];
    const vol2 = [key(0, 6)];
    const pan = [key(50, 0.5)];
    const lanes: AutomationLane[] = [
      { param: 'volumeDb', keys: vol1 },
      { param: 'pan', keys: pan },
      { param: 'volumeDb', keys: vol2 },
    ];
    const spec = resolveAutomation(lanes);
    expect(spec?.volume).toBe(vol2);
    expect(spec?.pan).toBe(pan);
  });
});

describe('sanitizeAutomationLanes — the parse-boundary arithmetic (trap T13)', () => {
  it('non-array input (and inputs where nothing survives) return undefined — the field is removed', () => {
    expect(sanitizeAutomationLanes(undefined)).toBeUndefined();
    expect(sanitizeAutomationLanes(null)).toBeUndefined();
    expect(sanitizeAutomationLanes('lanes')).toBeUndefined();
    expect(sanitizeAutomationLanes({})).toBeUndefined();
    expect(sanitizeAutomationLanes([])).toBeUndefined();
    expect(sanitizeAutomationLanes([null, 'x', 42])).toBeUndefined();
    expect(sanitizeAutomationLanes([{ param: 'volumeDb', keys: [] }])).toBeUndefined();
    expect(sanitizeAutomationLanes([{ param: 'gainDb', keys: [key(0, 1)] }])).toBeUndefined();
    expect(sanitizeAutomationLanes([{ param: 'volumeDb', keys: 'nope' }])).toBeUndefined();
  });

  it('drops keys whose position or value is not a finite number, and non-object keys', () => {
    const lanes = sanitizeAutomationLanes([
      {
        param: 'volumeDb',
        keys: [
          key(100, -6),
          { positionSample: '200', value: 1 },
          { positionSample: 300, value: null },
          { positionSample: Infinity, value: 1 },
          { positionSample: 400, value: NaN },
          null,
          'k',
          { positionSample: 500, value: 3 },
        ],
      },
    ]);
    expect(lanes).toEqual([{ param: 'volumeDb', keys: [key(100, -6), key(500, 3)] }]);
  });

  it('rounds fractional positions, clamps negatives to 0, clamps values to the param range', () => {
    const lanes = sanitizeAutomationLanes([
      { param: 'pan', keys: [key(-50, -9), key(100.6, 9), key(200.4, 0.25)] },
    ]);
    expect(lanes).toEqual([
      { param: 'pan', keys: [key(0, -1), key(101, 1), key(200, 0.25)] },
    ]);
  });

  it('drops an unknown curve string (absent = default) and keeps a valid one', () => {
    const lanes = sanitizeAutomationLanes([
      {
        param: 'volumeDb',
        keys: [
          { positionSample: 0, value: 0, curve: 'bezier' },
          { positionSample: 10, value: 1, curve: 'smooth' },
          { positionSample: 20, value: 2, curve: 42 },
        ],
      },
    ]);
    expect(lanes).toEqual([
      { param: 'volumeDb', keys: [key(0, 0), key(10, 1, 'smooth'), key(20, 2)] },
    ]);
    expect('curve' in (lanes as AutomationLane[])[0].keys[0]).toBe(false);
  });

  it('sorts unsorted keys ascending and de-duplicates positions with the LAST occurrence winning', () => {
    const lanes = sanitizeAutomationLanes([
      { param: 'volumeDb', keys: [key(500, 5), key(100, 1), key(500, -5), key(300, 3)] },
    ]);
    expect(lanes).toEqual([
      { param: 'volumeDb', keys: [key(100, 1), key(300, 3), key(500, -5)] },
    ]);
  });

  it('rounding collisions de-duplicate too (100.4 and 99.6 both round to 100)', () => {
    const lanes = sanitizeAutomationLanes([
      { param: 'pan', keys: [key(99.6, -0.5), key(100.4, 0.5)] },
    ]);
    expect(lanes).toEqual([{ param: 'pan', keys: [key(100, 0.5)] }]);
  });

  it('duplicate lanes for one param: the LAST lane wins (matching resolveAutomation)', () => {
    const lanes = sanitizeAutomationLanes([
      { param: 'volumeDb', keys: [key(0, 1)] },
      { param: 'pan', keys: [key(0, 0.5)] },
      { param: 'volumeDb', keys: [key(0, -1)] },
    ]);
    expect(lanes).toEqual([
      { param: 'volumeDb', keys: [key(0, -1)] },
      { param: 'pan', keys: [key(0, 0.5)] },
    ]);
  });

  it('returns fresh arrays — nothing aliases the parsed input', () => {
    const rawKeys = [key(0, 1)];
    const rawLane = { param: 'volumeDb', keys: rawKeys };
    const lanes = sanitizeAutomationLanes([rawLane]);
    expect(lanes).toEqual([{ param: 'volumeDb', keys: [key(0, 1)] }]);
    expect((lanes as AutomationLane[])[0]).not.toBe(rawLane);
    expect((lanes as AutomationLane[])[0].keys).not.toBe(rawKeys);
  });

  it('AUTOMATION_PARAMS is the runtime allow-list (F0 volume/pan + F5 spatial)', () => {
    expect(AUTOMATION_PARAMS).toEqual(['volumeDb', 'pan', 'azimuth', 'elevation', 'distance']);
  });

  it('F5 — accepts the spatial params and clamps their values to the spatial ranges', () => {
    const lanes = sanitizeAutomationLanes([
      { param: 'azimuth', keys: [key(0, -181), key(100, 181), key(200, 90)] },
      { param: 'elevation', keys: [key(0, -90.5), key(100, 90.5), key(200, 45)] },
      { param: 'distance', keys: [key(0, -1), key(100, 10.5), key(200, 2.5)] },
    ]);
    expect(lanes).toEqual([
      { param: 'azimuth', keys: [key(0, -180), key(100, 180), key(200, 90)] },
      { param: 'elevation', keys: [key(0, -90), key(100, 90), key(200, 45)] },
      { param: 'distance', keys: [key(0, 0), key(100, 10), key(200, 2.5)] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// F5 — the circular azimuth domain. The ±180° wrap is the boundary most
// likely to be wrong (the brief's mandatory fixture): every comparison in
// wrapAzimuthDelta / wrapAzimuth is probed below / on / above, with values
// where taking the LONG arc — or wrapping when it should not — MOVES the
// answer.
// ---------------------------------------------------------------------------

describe('F5 wrapAzimuthDelta — short-arc segment delta', () => {
  it('in-range deltas return bit-exact (below/above zero, just inside both boundaries)', () => {
    expect(wrapAzimuthDelta(0)).toBe(0);
    expect(wrapAzimuthDelta(20.25)).toBe(20.25);
    expect(wrapAzimuthDelta(-20.25)).toBe(-20.25);
    expect(wrapAzimuthDelta(179.5)).toBe(179.5); // just below +180
    expect(wrapAzimuthDelta(-179.5)).toBe(-179.5); // just above −180
  });

  it('antipodal deltas (exactly ±180) both take the DECREASING arc: −180 (pinned tie-break)', () => {
    expect(wrapAzimuthDelta(180)).toBe(-180);
    expect(wrapAzimuthDelta(-180)).toBe(-180);
  });

  it('out-of-range deltas wrap to the short arc (just past ±180, and far out)', () => {
    expect(wrapAzimuthDelta(180.5)).toBe(-179.5); // just above +180 → short arc backwards
    expect(wrapAzimuthDelta(-180.5)).toBe(179.5); // just below −180 → short arc forwards
    expect(wrapAzimuthDelta(340)).toBe(-20); // 170 → −170 travels 20° behind, not 340°
    expect(wrapAzimuthDelta(-340)).toBe(20);
    expect(wrapAzimuthDelta(250)).toBe(-110);
  });
});

describe('F5 wrapAzimuth — value re-wrap into [−180, 180]', () => {
  it('in-range values return bit-exact, INCLUDING both endpoints (a key may hold ±180)', () => {
    expect(wrapAzimuth(0)).toBe(0);
    expect(wrapAzimuth(179.999)).toBe(179.999);
    expect(wrapAzimuth(-179.999)).toBe(-179.999);
    expect(wrapAzimuth(180)).toBe(180); // ON the boundary: NOT folded to −180
    expect(wrapAzimuth(-180)).toBe(-180);
  });

  it('out-of-range values wrap (just past each endpoint, and mid-arc)', () => {
    expect(wrapAzimuth(180.5)).toBe(-179.5);
    expect(wrapAzimuth(-180.5)).toBe(179.5);
    expect(wrapAzimuth(190)).toBe(-170);
    expect(wrapAzimuth(-190)).toBe(170);
    expect(wrapAzimuth(350)).toBe(-10);
  });
});

describe('F5 automationValueAt — azimuth interpolates along the SHORT arc across ±180', () => {
  // THE mandatory wrap fixture: 170° → −170° is a 20° pass BEHIND the
  // listener (through ±180), never a 340° sweep back through 0.
  const wrapKeys = [key(1000, 170), key(1400, -170)];

  it('travels 170 → 180 → −170 (probes below / on / above the seam sample)', () => {
    // u = 0.25 → 170 + 20·0.25 = 175 (long arc would read 170 − 340·0.25 = 85)
    expect(automationValueAt(wrapKeys, 1100, 'azimuth')).toBe(175);
    // u = 0.5 → exactly the seam value +180 (in range, not folded)
    expect(automationValueAt(wrapKeys, 1200, 'azimuth')).toBe(180);
    // u = 0.75 → 185 → wrapped to −175: the value has crossed the seam
    expect(automationValueAt(wrapKeys, 1300, 'azimuth')).toBe(-175);
  });

  it('never passes through the front (0°) — the long arc is NOT taken', () => {
    for (let s = 1000; s <= 1400; s += 25) {
      expect(Math.abs(automationValueAt(wrapKeys, s, 'azimuth'))).toBeGreaterThanOrEqual(170);
    }
  });

  it('holds and on-key samples return stored values bit-exact (including a +180 key)', () => {
    const keys = [key(100, 180), key(500, -90)];
    expect(automationValueAt(keys, 0, 'azimuth')).toBe(180); // hold before
    expect(automationValueAt(keys, 100, 'azimuth')).toBe(180); // ON the key
    expect(automationValueAt(keys, 500, 'azimuth')).toBe(-90); // ON the last
    expect(automationValueAt(keys, 900, 'azimuth')).toBe(-90); // hold after
  });

  it('a non-wrapping azimuth segment interpolates exactly like a linear param', () => {
    // Same keys through 'elevation' (a linear degree-domain param) as the
    // reference: in-range deltas must be arithmetically identical.
    const keys = [key(0, -30), key(100, 90, 'smooth')];
    for (const s of [25, 50, 75]) {
      expect(automationValueAt(keys, s, 'azimuth')).toBe(automationValueAt(keys, s, 'elevation'));
    }
  });

  it('antipodal keys (0 → 180) travel the DECREASING arc through the LEFT (pinned)', () => {
    const keys = [key(0, 0), key(400, 180)];
    expect(automationValueAt(keys, 100, 'azimuth')).toBe(-45);
    expect(automationValueAt(keys, 200, 'azimuth')).toBe(-90); // hard left, not hard right
    expect(automationValueAt(keys, 300, 'azimuth')).toBe(-135);
  });

  it('the segment curve shapes the wrapped delta (equal-power across the seam)', () => {
    const keys = [key(0, 170, 'equal-power'), key(100, -170)];
    const expected = wrapAzimuth(170 + 20 * fadeInShape(0.25, 'equal-power'));
    expect(automationValueAt(keys, 25, 'azimuth')).toBe(expected);
    // Anchor the shape independently: sin(π/8) ≈ 0.38268 → 177.653677…
    expect(expected).toBeCloseTo(170 + 20 * Math.sin((0.25 * Math.PI) / 2), 12);
  });

  it('the circular branch applies ONLY to azimuth: volume/elevation/distance stay linear', () => {
    // Independent midpoint arithmetic (v0 + (v1−v0)·0.5, equal-gain default):
    // a wrap sneaking onto a linear param would move every one of these.
    expect(automationValueAt([key(0, -60), key(100, 12)], 50, 'volumeDb')).toBe(-24);
    expect(automationValueAt([key(0, -90), key(100, 90)], 50, 'elevation')).toBe(0);
    expect(automationValueAt([key(0, 0), key(100, 10)], 50, 'distance')).toBe(5);
  });
});

describe('F5 resolveAutomation — the spatial group and ruling 4', () => {
  it('any ONE spatial lane with a key activates the group; missing members are null', () => {
    const az = [key(0, 90)];
    const spec = resolveAutomation([{ param: 'azimuth', keys: az }]);
    expect(spec).not.toBeNull();
    expect(spec?.spatial).toEqual({ azimuth: az, elevation: null, distance: null });
    expect(spec?.spatial?.azimuth).toBe(az); // the lane's own array, not a copy
    expect(spec?.volume).toBeNull();
    expect(spec?.pan).toBeNull();
  });

  it('a distance-only lane activates the group too (ruling 4: ANY spatial lane supersedes pan)', () => {
    const d = [key(0, 5)];
    const spec = resolveAutomation([{ param: 'distance', keys: d }]);
    expect(spec?.spatial).toEqual({ azimuth: null, elevation: null, distance: d });
  });

  it('zero-key spatial lanes do NOT activate the group (=== no lane)', () => {
    expect(
      resolveAutomation([
        { param: 'azimuth', keys: [] },
        { param: 'elevation', keys: [] },
        { param: 'distance', keys: [] },
      ])
    ).toBeNull();
  });

  it('spatial and pan lanes can coexist in the spec; consumers gate on spatial FIRST', () => {
    const az = [key(0, -90)];
    const pan = [key(0, 0.5)];
    const spec = resolveAutomation([
      { param: 'pan', keys: pan },
      { param: 'azimuth', keys: az },
    ]);
    expect(spec?.pan).toBe(pan);
    expect(spec?.spatial?.azimuth).toBe(az);
  });

  it('a lane-less track still resolves to null with the spatial field in the union (ruling 10)', () => {
    expect(resolveAutomation(undefined)).toBeNull();
  });
});
