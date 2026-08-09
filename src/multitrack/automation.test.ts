import { fadeInShape, FADE_CURVES, type FadeCurve } from '../dsp/fades';
import {
  AUTOMATION_PARAMS,
  DEFAULT_AUTOMATION_CURVE,
  automationValueAt,
  clampAutomationValue,
  resolveAutomation,
  sanitizeAutomationLanes,
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
    expect(automationValueAt(keys, 0)).toBe(-6);
    expect(automationValueAt(keys, 99)).toBe(-6); // one below the boundary
    expect(automationValueAt(keys, 100)).toBe(-6); // exactly ON the first key
    // one above: the segment has begun — equal-gain from -6 toward 3
    expect(automationValueAt(keys, 101)).toBeCloseTo(-6 + 9 * (1 / 400), 12);
    expect(automationValueAt(keys, 101)).not.toBe(-6);
  });

  it('holds the LAST key value from the exact last-key sample onward', () => {
    // one below: still interpolating (not yet the held value)
    expect(automationValueAt(keys, 499)).toBeCloseTo(-6 + 9 * (399 / 400), 12);
    expect(automationValueAt(keys, 499)).not.toBe(3);
    expect(automationValueAt(keys, 500)).toBe(3); // exactly ON the last key
    expect(automationValueAt(keys, 501)).toBe(3); // one above
    expect(automationValueAt(keys, 1_000_000)).toBe(3); // far past — held, never extrapolated
  });

  it('a one-key lane holds its value over the whole timeline', () => {
    const one = [key(300, -12.5)];
    expect(automationValueAt(one, 0)).toBe(-12.5);
    expect(automationValueAt(one, 299)).toBe(-12.5);
    expect(automationValueAt(one, 300)).toBe(-12.5);
    expect(automationValueAt(one, 301)).toBe(-12.5);
    expect(automationValueAt(one, 10_000_000)).toBe(-12.5);
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
    expect(automationValueAt(keys, 0)).toBe(-6.1);
    expect(automationValueAt(keys, 200)).toBe(3.3);
    expect(automationValueAt(keys, 600)).toBe(0.7);
    expect(automationValueAt(keys, 900)).toBe(0.1);
  });
});

describe('automationValueAt — segment selection at key boundaries', () => {
  // Three keys, three DIFFERENT curves and non-collinear values: evaluating
  // the sample just below / just above a middle key with the wrong segment
  // (wrong endpoints AND wrong curve) moves the output.
  const keys = [key(0, 0, 'equal-gain'), key(400, 10, 'exponential'), key(800, -20, 'smooth')];

  it('one below the middle key: segment 0 (equal-gain 0 -> 10)', () => {
    expect(automationValueAt(keys, 399)).toBeCloseTo(0 + 10 * fadeInShape(399 / 400, 'equal-gain'), 12);
  });

  it('exactly on the middle key: the key value', () => {
    expect(automationValueAt(keys, 400)).toBe(10);
  });

  it('one above the middle key: segment 1 (exponential 10 -> -20)', () => {
    expect(automationValueAt(keys, 401)).toBeCloseTo(10 + -30 * fadeInShape(1 / 400, 'exponential'), 12);
    // sanity: the two candidate segments genuinely disagree here
    expect(automationValueAt(keys, 401)).not.toBeCloseTo(0 + 10 * fadeInShape(401 / 400, 'equal-gain'), 6);
  });
});

describe('automationValueAt — every curve interpolates as the shared fades.ts family says', () => {
  it.each(FADE_CURVES.map((c) => [c] as [FadeCurve]))('%s', (curve) => {
    const keys = [key(1000, -24, curve), key(2000, 6)];
    // quarter / mid / three-quarter probes, plus off-grid
    for (const s of [1250, 1500, 1750, 1333]) {
      const u = (s - 1000) / 1000;
      expect(automationValueAt(keys, s)).toBe(-24 + 30 * fadeInShape(u, curve));
    }
  });

  it('an absent curve means DEFAULT_AUTOMATION_CURVE (equal-gain: the straight segment)', () => {
    const keys = [key(0, 0), key(100, 1)];
    expect(DEFAULT_AUTOMATION_CURVE).toBe('equal-gain');
    expect(automationValueAt(keys, 25)).toBe(0 + 1 * fadeInShape(0.25, 'equal-gain'));
    expect(automationValueAt(keys, 25)).toBeCloseTo(0.25, 12);
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

  it('AUTOMATION_PARAMS is the runtime allow-list (volumeDb and pan only, F0 scope)', () => {
    expect(AUTOMATION_PARAMS).toEqual(['volumeDb', 'pan']);
  });
});
