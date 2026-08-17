/**
 * Task R7 — `tempoMap.ts`.
 *
 * The headline assertions here are ABSOLUTE beat-position errors in
 * milliseconds against fixtures whose beat positions are exact by construction
 * (`__fixtures__/tempoFixtures.ts`), not correlations against a re-detected
 * grid — re-detecting would measure the detector, which is the thing R7's
 * Ruling 1 refuses to trust.
 *
 * Two traps this suite is written specifically to avoid:
 *
 *  1. **A map that is built, threaded through and then not used.** That is the
 *     defect F7 shipped with 3999/3999 green. So the placement tests measure
 *     where the OUTPUT AUDIO's beats actually are, and a companion test asserts
 *     the constant path and the variable path produce genuinely different audio
 *     on varying material — if `applyTempoMap` ignored its map, the equality
 *     test below would still pass and that one would fail.
 *  2. **A loop pinned only on its first element.** A tempo map that is right at
 *     bar 0 and wrong everywhere after is the EXPECTED failure mode, so every
 *     accelerando assertion pins the error at the LAST beat by name, in
 *     addition to the aggregate.
 */

import {
  accelerandoBeats,
  burstTrain,
  energyCentroid,
  meterChangeBeats,
  rubatoBeats,
  stepTempoBeats,
} from './__fixtures__/tempoFixtures';
import { detectPitch } from './pitchDetect';
import { applyTempoMap, buildTempoMap, type TempoMap } from './tempoMap';
import { analysisPosAt, synthesisPosAt, warpRatios } from './timingWarp';
import { MAX_RATIO, MIN_RATIO, timeStretchLinked } from './wsola';

const SR = 48000;

/** `60/bpm` in samples — the spacing `buildTempoMap` is asked to produce. */
function spacing(bpm: number, sr = SR): number {
  return (60 / bpm) * sr;
}

function msOf(samples: number, sr = SR): number {
  return (samples / sr) * 1000;
}

/** Deterministic LCG noise — never Math.random (project rule). */
function noise(n: number, seed: number): Float32Array {
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s / 0x7fffffff - 0.5;
  }
  return out;
}

/**
 * Measured position of each beat in `out`, by energy centroid inside a window
 * centred on where the map SAYS the beat is. The window is half a target beat
 * wide, so a beat displaced by more than that would latch onto its neighbour —
 * which is fine here precisely because these assertions are that the error is
 * SMALL; the constant-ratio comparison below, where the error is large, uses
 * exact arithmetic instead and never a window.
 */
function measuredBeatErrorsMs(out: Float32Array, expected: ArrayLike<number>, halfWindow: number): number[] {
  const errs: number[] = [];
  for (let i = 0; i < expected.length; i++) {
    const c = energyCentroid(out, expected[i] - halfWindow, expected[i] + halfWindow);
    errs.push(c === null ? Number.NaN : msOf(c - expected[i]));
  }
  return errs;
}

function absStats(values: readonly number[]): { median: number; max: number; n: number } {
  const a = values.filter((v) => Number.isFinite(v)).map(Math.abs).sort((x, y) => x - y);
  return { median: a[Math.floor(a.length / 2)], max: a[a.length - 1], n: a.length };
}

describe('the fixtures themselves vary as advertised', () => {
  // A measurement is only as good as the signal it was made on. The accelerando
  // and rubato assertions below all say "the error is SMALL", which is equally
  // true of a fixture that does not vary at all — so mutations flattening
  // `rubatoBeats` and `stepTempoBeats` into even grids survived the entire
  // suite. Each generator's own defining property is now pinned here, before
  // anything is measured against it.
  function intervals(beats: readonly number[]): number[] {
    const out: number[] = [];
    for (let i = 1; i < beats.length; i++) out.push(beats[i] - beats[i - 1]);
    return out;
  }

  it('accelerandoBeats ramps from bpmStart to bpmEnd', () => {
    const iv = intervals(accelerandoBeats(100, 120, 24, SR));
    // 100 BPM = 0.6 s, 120 BPM = 0.5 s at the ends.
    expect(iv[0] / SR).toBeCloseTo(0.6, 2);
    expect(iv[iv.length - 1] / SR).toBeCloseTo(0.5, 2);
    // Monotonically shortening — an accelerando, not a wobble.
    for (let i = 1; i < iv.length; i++) expect(iv[i]).toBeLessThanOrEqual(iv[i - 1]);
  });

  it('rubatoBeats really oscillates by its stated amplitude', () => {
    const iv = intervals(rubatoBeats(110, 0.08, 6, 24, SR));
    const base = (60 / 110) * SR;
    const min = Math.min(...iv);
    const max = Math.max(...iv);
    // ±8 % in BPM is 1/1.08 .. 1/0.92 in period.
    expect(min / base).toBeLessThan(0.94);
    expect(max / base).toBeGreaterThan(1.06);
    // And it comes BACK — a ramp would not revisit the base period.
    const returns = iv.filter((v) => Math.abs(v / base - 1) < 0.01).length;
    expect(returns).toBeGreaterThan(3);
  });

  it('stepTempoBeats actually switches, once, at the stated time', () => {
    const beats = stepTempoBeats(100, 125, 12, 24, SR);
    const iv = intervals(beats);
    const before = iv.filter((_, i) => beats[i] < 11 * SR);
    const after = iv.filter((_, i) => beats[i] > 13 * SR);
    expect(before.length).toBeGreaterThan(5);
    expect(after.length).toBeGreaterThan(5);
    const meanBefore = before.reduce((a, b) => a + b, 0) / before.length;
    const meanAfter = after.reduce((a, b) => a + b, 0) / after.length;
    expect(meanBefore / SR).toBeCloseTo(0.6, 2); // 100 BPM
    expect(meanAfter / SR).toBeCloseTo(0.48, 2); // 125 BPM
    expect(meanBefore / meanAfter).toBeCloseTo(1.25, 2);
  });

  it('meterChangeBeats places its downbeats where the sections say', () => {
    const { beats, downbeats, beatsPerBarOfBar } = meterChangeBeats(120, [[4, 2], [3, 2], [4, 2]], SR);
    expect(beats).toHaveLength(4 * 2 + 3 * 2 + 4 * 2);
    expect(downbeats).toHaveLength(6);
    expect(beatsPerBarOfBar).toEqual([4, 4, 3, 3, 4, 4]);
    const period = (60 / 120) * SR;
    // Bars start at beats 0, 4, 8, 11, 14, 18.
    expect(downbeats.map((d) => Math.round(d / period))).toEqual([0, 4, 8, 11, 14, 18]);
  });

  it('burstTrain centres each burst on its beat, and energyCentroid recovers it', () => {
    const beats = [5000, 15000, 25000];
    const sig = burstTrain(beats, 30000, SR);
    for (const b of beats) {
      const c = energyCentroid(sig, b - 4000, b + 4000);
      expect(c).not.toBeNull();
      expect(Math.abs((c as number) - b)).toBeLessThan(2);
    }
  });
});

describe('buildTempoMap — the ratio bound (RULING 3)', () => {
  it('defaults to the ENGINE band, pinned equal to wsola.ts so the two cannot drift', () => {
    // F9 bounds its warp by the TRANSPARENCY band because it stretches sung
    // vowels. Match Tempo is the opposite case: the user asked for a tempo
    // change of whatever size they typed, and `checkTempoChange` already
    // refuses anything outside [MIN_RATIO, MAX_RATIO] for the constant path.
    // Bounding the LOCAL ratio by the same pair is what makes the variable path
    // unable to ask WSOLA for something the constant path would have refused.
    expect(MIN_RATIO).toBe(0.25);
    expect(MAX_RATIO).toBe(4);

    // One beat interval of 1000 samples asked to become 10 000 (ratio 10, far
    // past MAX_RATIO) is clamped to exactly 1000 * MAX_RATIO.
    const map = buildTempoMap([0, 1000, 2000], 3000, 10000);
    const ratios = Array.from(warpRatios(map));
    expect(Math.max(...ratios)).toBeCloseTo(MAX_RATIO, 12);

    // And symmetrically at the floor.
    const slow = buildTempoMap([0, 1000, 2000], 3000, 1);
    expect(Math.min(...Array.from(warpRatios(slow)))).toBeCloseTo(MIN_RATIO, 12);
  });

  it.each([
    ['below the ceiling', 1000, 3999, 3999 / 1000, false],
    ['exactly on the ceiling', 1000, 4000, MAX_RATIO, false],
    ['above the ceiling', 1000, 4001, MAX_RATIO, true],
  ])('clamps at the ceiling: %s', (_label, interval, target, expectedRatio, expectClamped) => {
    const map = buildTempoMap([0, interval, 2 * interval], 3 * interval, target);
    const ratios = Array.from(warpRatios(map));
    expect(Math.max(...ratios)).toBeCloseTo(expectedRatio, 9);
    expect(map.clampedIndices.length > 0).toBe(expectClamped);
  });

  it.each([
    ['above the floor', 1000, 251, 251 / 1000, false],
    ['exactly on the floor', 1000, 250, MIN_RATIO, false],
    ['below the floor', 1000, 249, MIN_RATIO, true],
  ])('clamps at the floor: %s', (_label, interval, target, expectedRatio, expectClamped) => {
    const map = buildTempoMap([0, interval, 2 * interval], 3 * interval, target);
    const ratios = Array.from(warpRatios(map));
    expect(Math.min(...ratios)).toBeCloseTo(expectedRatio, 9);
    expect(map.clampedIndices.length > 0).toBe(expectClamped);
  });

  it('names the clamped beat by the CALLER’s index, and only the clamped one', () => {
    // Three intervals; only the middle one (200 samples) is too short to reach
    // the 1000-sample target inside the band (needs ratio 5 > 4).
    const beats = [0, 1000, 1200, 2200];
    const map = buildTempoMap(beats, 3200, 1000);
    // Beat 2 (value 1200) closes the offending interval.
    expect(map.clampedIndices).toEqual([2]);
    expect(map.acceptedIndices).toEqual([0, 1, 2, 3]);
  });

  it('names it by the CALLER’s index even when an earlier beat was DROPPED', () => {
    // The fixture above accepts every beat, so `acceptedIndices[j] === j` and
    // `clampedIndices.push(acceptedIndices[j])` -> `push(j)` survived it. Here
    // the leading beat is refused (non-finite), so the two disagree by one and
    // only the caller-index form can be right: the caller looks these numbers up
    // in the array IT passed, which still contains the dropped beat.
    const beats = [Number.NaN, 0, 1000, 1200, 2200];
    const map = buildTempoMap(beats, 3200, 1000);
    expect(map.acceptedIndices).toEqual([1, 2, 3, 4]);
    // The 200-sample interval is closed by the beat at index 3 of the CALLER's
    // array (index 2 among the accepted ones).
    expect(map.clampedIndices).toEqual([3]);
    expect(beats[map.clampedIndices[0]]).toBe(1200);
  });

  it('a clamped interval SHIFTS every beat after it — the honest consequence', () => {
    const target = 1000;
    const beats = [0, 1000, 1200, 2200];
    const map = buildTempoMap(beats, 3200, target);
    // Beat 1 gets its full 1000. Beat 2's interval clamps to 200*4 = 800, so
    // beat 2 lands at 1800, not at 2000; beat 3 then gets its full 1000 from
    // there and lands at 2800, not 3000. Every later beat carries the deficit.
    expect(Array.from(map.placed)).toEqual([0, 1000, 1800, 2800]);
    // Which is exactly why `placed` exists rather than re-deriving the grid
    // from the target BPM: `first + i*spacing` would say [0,1000,2000,3000].
    expect(map.placed[3]).not.toBeCloseTo(3000, 6);
  });

  it('holds a caller-supplied band inside the engine limits and forces it to contain 1', () => {
    const beats = [0, 1000, 2000];
    // A band that excludes 1 would make the identity placement infeasible.
    const wide = buildTempoMap(beats, 3000, 10000, { minRatio: 1.2, maxRatio: 1.5 });
    expect(Math.max(...Array.from(warpRatios(wide)))).toBeCloseTo(1.5, 9);
    const narrowed = buildTempoMap(beats, 3000, 1, { minRatio: 1.2, maxRatio: 1.5 });
    // minRatio 1.2 is forced down to 1, not honoured as a floor above unity.
    expect(Math.min(...Array.from(warpRatios(narrowed)))).toBeCloseTo(1, 9);
    // ... and symmetrically: a CEILING below 1 is forced up to 1, so the
    // identity placement stays feasible. Without the force, this map's
    // intervals — which want exactly ratio 1 — would be clamped to 0.5.
    const cappedBelowUnity = buildTempoMap(beats, 3000, 1000, { maxRatio: 0.5 });
    expect(Math.max(...Array.from(warpRatios(cappedBelowUnity)))).toBeCloseTo(1, 9);
    expect(cappedBelowUnity.clampedIndices).toEqual([]);
    expect(cappedBelowUnity.identity).toBe(true);
    // And a band wider than the engine's is narrowed to the engine's.
    const beyond = buildTempoMap(beats, 3000, 100000, { maxRatio: 99 });
    expect(Math.max(...Array.from(warpRatios(beyond)))).toBeCloseTo(MAX_RATIO, 9);
    const beneath = buildTempoMap(beats, 3000, 1, { minRatio: 0.001 });
    expect(Math.min(...Array.from(warpRatios(beneath)))).toBeCloseTo(MIN_RATIO, 9);
  });

  it('reports the realised local-ratio EXTREMES, not the average', () => {
    // Intervals 1000 and 500 asked for 750 each: ratios 0.75 and 1.5.
    const map = buildTempoMap([0, 1000, 1500], 2000, 750);
    expect(map.minLocalRatio).toBeCloseTo(0.75, 12);
    expect(map.maxLocalRatio).toBeCloseTo(1.5, 12);
  });
});

describe('buildTempoMap — structure and monotonicity', () => {
  it('spans the whole region and is strictly ascending in both domains', () => {
    const beats = accelerandoBeats(100, 130, 12, SR);
    const inLen = 12 * SR;
    const map = buildTempoMap(beats, inLen, spacing(115));
    expect(map.knotsIn[0]).toBe(0);
    expect(map.knotsIn[map.knotsIn.length - 1]).toBe(inLen);
    expect(map.knotsOut[0]).toBe(0);
    for (let i = 1; i < map.knotsIn.length; i++) {
      expect(map.knotsIn[i]).toBeGreaterThan(map.knotsIn[i - 1]);
      expect(map.knotsOut[i]).toBeGreaterThan(map.knotsOut[i - 1]);
    }
    expect(map.outLen).toBe(Math.round(map.knotsOut[map.knotsOut.length - 1]));
  });

  it('omits the head knot when the first beat IS the region start, and adds it when it is not', () => {
    const withHead = buildTempoMap([100, 1100, 2100], 3100, 1000);
    // 0, 100, 1100, 2100, 3100
    expect(Array.from(withHead.knotsIn)).toEqual([0, 100, 1100, 2100, 3100]);
    const withoutHead = buildTempoMap([0, 1000, 2000], 3000, 1000);
    expect(Array.from(withoutHead.knotsIn)).toEqual([0, 1000, 2000, 3000]);
  });

  it('gives the head and the tail the ADJACENT interval’s ratio, never 1', () => {
    // Beats at 500 and 1500 (interval 1000) asked for 2000: ratio 2.
    const map = buildTempoMap([500, 1500], 3000, 2000);
    const ratios = Array.from(warpRatios(map));
    // head [0,500], beat interval [500,1500], tail [1500,3000] — all at ratio 2.
    expect(ratios).toHaveLength(3);
    for (const r of ratios) expect(r).toBeCloseTo(2, 12);
    // A ratio-1 head would leave the region's first 500 samples at the original
    // tempo, a discontinuity of exactly the amount being corrected.
    expect(map.knotsOut[1]).toBeCloseTo(1000, 9);
  });

  it('the tail follows the LAST interval, which on an accelerando is not the first', () => {
    // Intervals 1000 then 500; target 1000 -> ratios 1 then 2. The tail must
    // take 2 (the last), not 1 (the first).
    const map = buildTempoMap([0, 1000, 1500], 2500, 1000);
    const ratios = Array.from(warpRatios(map));
    expect(ratios[0]).toBeCloseTo(1, 12);
    expect(ratios[1]).toBeCloseTo(2, 12);
    expect(ratios[2]).toBeCloseTo(2, 12);
  });

  it('the HEAD follows the first interval even when the last one differs', () => {
    // The earlier head/tail test has only ONE beat interval, so first and last
    // ratio are the same number and swapping them is invisible — a mutation
    // that made the head use `lastRatio` survived the whole suite. This fixture
    // has a head knot AND two different ratios, so each provenance is pinned on
    // its own.
    //
    // beats 1000, 2000, 2200 in a 3000-sample region, target spacing 1000:
    //   interval 1000 -> 1000 (ratio 1); interval 200 -> clamped to 200*4 = 800
    //   (ratio 4). head = 1000 * 1 = 1000; tail = 800 * 4 = 3200.
    const map = buildTempoMap([1000, 2000, 2200], 3000, 1000);
    expect(Array.from(map.knotsIn)).toEqual([0, 1000, 2000, 2200, 3000]);
    expect(Array.from(map.knotsOut)).toEqual([0, 1000, 2000, 2800, 6000]);
    const ratios = Array.from(warpRatios(map));
    expect(ratios[0]).toBeCloseTo(1, 12); // head, from the FIRST interval
    expect(ratios[ratios.length - 1]).toBeCloseTo(4, 12); // tail, from the LAST

    // And `placed` skips the HEAD knot. This is the only literal `placed`
    // assertion in the suite whose region does not start on a beat, and it is
    // the one that pins the `firstBeatKnot` offset: the other literal (the
    // clamp-shift test below) uses a grid beginning at sample 0, where
    // `headKnot === false` makes the offset a no-op. Dropping it
    // (`knotsOut[firstBeatKnot + j]` -> `knotsOut[j]`) shifts EVERY beat marker
    // back one knot for any region that does not begin exactly on a beat — the
    // ordinary case — and the whole suite stayed green until this line. A
    // literal, deliberately, not `knotsOut[j + 1]`: a recomputation restates
    // the production line and cannot disagree with it.
    expect(Array.from(map.placed)).toEqual([1000, 2000, 2800]);
    expect(map.placed[0]).not.toBe(map.knotsOut[0]);
  });

  it('is NOT the identity when only the LATER knots move', () => {
    // Same fixture: knots 1 and 2 land exactly on their input positions and only
    // knot 3 moves. An identity check that inspected just the first interior
    // knot would call this map the identity, `applyTempoMap` would short-circuit
    // to a copy, and a 6000-sample result would come back 3000 samples long.
    // (A mutation shortening that loop to `j < 2` survived until this test.)
    const map = buildTempoMap([1000, 2000, 2200], 3000, 1000);
    expect(map.knotsOut[1]).toBe(map.knotsIn[1]);
    expect(map.knotsOut[2]).toBe(map.knotsIn[2]);
    expect(map.knotsOut[3]).not.toBe(map.knotsIn[3]);
    expect(map.identity).toBe(false);
    expect(map.outLen).toBe(6000);
    // And the short circuit really is skipped: the output is the map's length.
    const out = applyTempoMap([noise(3000, 11)], SR, map)[0];
    expect(out.length).toBe(6000);
  });

  it('analysisPosAt and synthesisPosAt invert each other across the whole map', () => {
    const beats = accelerandoBeats(90, 140, 10, SR);
    const inLen = 10 * SR;
    const map = buildTempoMap(beats, inLen, spacing(115));
    for (let u = 0; u <= inLen; u += Math.floor(inLen / 37)) {
      const v = synthesisPosAt(map, u);
      expect(analysisPosAt(map, v)).toBeCloseTo(u, 4);
    }
  });
});

describe('buildTempoMap — which beats are used, and what is refused', () => {
  it.each([
    ['non-finite', [0, Number.NaN, 1000, 2000], [0, 2, 3]],
    ['negative', [-5, 0, 1000, 2000], [1, 2, 3]],
    ['at the region end', [0, 1000, 2000, 3000], [0, 1, 2]],
    ['past the region end', [0, 1000, 2000, 5000], [0, 1, 2]],
    ['out of order', [0, 1000, 900, 2000], [0, 1, 3]],
    ['duplicated', [0, 1000, 1000, 2000], [0, 1, 3]],
  ])('drops %s beats and reports the caller indices it kept', (_label, beats, expected) => {
    const map = buildTempoMap(beats, 3000, 1000);
    expect(map.acceptedIndices).toEqual(expected);
  });

  it('keeps a beat one sample inside the region end and drops it one sample later', () => {
    expect(buildTempoMap([0, 1000, 2999], 3000, 1000).acceptedIndices).toEqual([0, 1, 2]);
    expect(buildTempoMap([0, 1000, 3000], 3000, 1000).acceptedIndices).toEqual([0, 1]);
  });

  it('drops a FRACTIONAL negative, which the ordering guard alone would admit', () => {
    // The range guard and the ordering guard must not overlap: a `prev` seeded
    // at -1 would reject -5 for being out of ORDER and never exercise `b < 0`
    // at all, leaving that guard unpinned (a mutation deleting it survived the
    // whole suite until this case existed). -0.5 is greater than -1, so only a
    // real range check can reject it.
    expect(buildTempoMap([-0.5, 1000, 2000], 3000, 1000).acceptedIndices).toEqual([1, 2]);
    // And the knot map still starts at the region start, not at -0.5.
    expect(buildTempoMap([-0.5, 1000, 2000], 3000, 1000).knotsIn[0]).toBe(0);
    // A beat AT 0 is kept — the boundary on the other side.
    expect(buildTempoMap([0, 1000, 2000], 3000, 1000).acceptedIndices).toEqual([0, 1, 2]);
  });

  it.each([
    ['one beat', [1000], 3000, 1000, 'not-enough-beats'],
    ['no beats', [], 3000, 1000, 'not-enough-beats'],
    ['every beat out of range', [5000, 6000], 3000, 1000, 'not-enough-beats'],
    ['an empty region', [0, 1000], 0, 1000, 'empty-region'],
    ['a zero target spacing', [0, 1000], 3000, 0, 'invalid-spacing'],
    ['a negative target spacing', [0, 1000], 3000, -10, 'invalid-spacing'],
    ['a non-finite target spacing', [0, 1000], 3000, Number.NaN, 'invalid-spacing'],
  ])('refuses %s with an identity map', (_label, beats, inLen, target, reason) => {
    const map = buildTempoMap(beats, inLen, target);
    expect(map.identity).toBe(true);
    expect(map.refusal).toBe(reason);
    expect(map.outLen).toBe(map.inLen);
  });

  it('TWO beats is enough (one measured interval) and one is not — the boundary', () => {
    expect(buildTempoMap([0, 1000], 3000, 500).refusal).toBeNull();
    expect(buildTempoMap([0], 3000, 500).refusal).toBe('not-enough-beats');
  });

  it('a grid already at the target is the identity, but is NOT a refusal', () => {
    const map = buildTempoMap([0, 1000, 2000], 3000, 1000);
    expect(map.identity).toBe(true);
    expect(map.refusal).toBeNull();
  });
});

describe('the constant-tempo case is byte-identical to today', () => {
  // The cheapest proof the new path cannot disturb the old one. Every existing
  // tempo golden depends on the constant path being untouched.
  it.each([
    ['120 -> 110', 120, 110],
    ['120 -> 60 (dyadic)', 120, 60],
    ['100 -> 133.333', 100, 133.333],
    ['128 -> 192', 128, 192],
    ['97.3 -> 111.7', 97.3, 111.7],
  ])('a perfectly even grid reproduces timeStretchLinked: %s', (_label, srcBpm, tgtBpm) => {
    const inLen = 8 * SR;
    const beatSpacing = spacing(srcBpm);
    // Built from the EXACT even grid, not a rounded one: rounding each beat to
    // an integer sample would make the intervals differ by up to a sample,
    // which is a real (tiny) tempo variation and would make this a test of the
    // tolerance rather than of the equivalence.
    const exact: number[] = [];
    for (let i = 0; i * beatSpacing < inLen; i++) exact.push(i * beatSpacing);

    const r = spacing(tgtBpm) / beatSpacing;
    const sig = noise(inLen, 4242);
    const constant = timeStretchLinked([sig], SR, r)[0];
    const map = buildTempoMap(exact, inLen, spacing(tgtBpm));
    const variable = applyTempoMap([sig], SR, map)[0];

    expect(variable.length).toBe(constant.length);
    let differing = 0;
    for (let i = 0; i < constant.length; i++) if (variable[i] !== constant[i]) differing++;
    expect(differing).toBe(0);
  });

  it('and the fixture CAN detect a difference — the same comparison on a varying grid', () => {
    // Without this companion, the equality above would pass just as well if
    // `applyTempoMap` ignored its map and called `timeStretchLinked` itself.
    const inLen = 8 * SR;
    const beats = accelerandoBeats(100, 130, 8, SR);
    const map = buildTempoMap(beats, inLen, spacing(115));
    const sig = noise(inLen, 4242);
    const variable = applyTempoMap([sig], SR, map)[0];
    const constant = timeStretchLinked([sig], SR, map.outLen / inLen)[0];

    let differing = 0;
    const n = Math.min(variable.length, constant.length);
    for (let i = 0; i < n; i++) if (variable[i] !== constant[i]) differing++;
    // The two agree near the start (same local rate) and diverge after; the
    // point is only that this comparison is capable of coming back non-zero.
    expect(differing).toBeGreaterThan(n / 4);
  });

  it('an identity map returns copies byte for byte and does NOT run WSOLA', () => {
    // A DC-offset fixture, per F9's finding: WSOLA at ratio 1 is byte-identical
    // for any signal that starts at zero (the first synthesis window has weight
    // 0, so only out[0] differs and it is already 0), so a fixture that starts
    // silent passes whether or not the short circuit exists.
    const n = 4 * SR;
    const dc = new Float32Array(n).fill(0.5);
    const map = buildTempoMap([0, 1000], 0, 1000);
    expect(map.identity).toBe(true);
    const out = applyTempoMap([dc], SR, map)[0];
    expect(out.length).toBe(n);
    for (let i = 0; i < n; i++) expect(out[i]).toBe(dc[i]);
    expect(out).not.toBe(dc);
  });

  it('and THAT fixture can detect a stray WSOLA pass', () => {
    const n = 4 * SR;
    const dc = new Float32Array(n).fill(0.5);
    const stretched = timeStretchLinked([dc], SR, 1)[0];
    let differing = 0;
    for (let i = 0; i < n; i++) if (stretched[i] !== dc[i]) differing++;
    expect(differing).toBeGreaterThan(0);
  });
});

describe('absolute beat-position error on varying material', () => {
  /** Runs one fixture end to end through the real engine. */
  function place(beats: number[], seconds: number, targetBpm: number) {
    const inLen = Math.round(seconds * SR);
    const sig = burstTrain(beats, inLen, SR);
    const map = buildTempoMap(beats, inLen, spacing(targetBpm));
    const out = applyTempoMap([sig], SR, map)[0];
    const errs = measuredBeatErrorsMs(out, map.placed, spacing(targetBpm) / 2);
    return { map, out, errs, inLen };
  }

  it.each([
    // label, bpmStart, bpmEnd, seconds, targetBpm, maxMedianMs, maxWorstMs
    ['accelerando 108->112 (slope 0.17 BPM/s)', 108, 112, 24, 110, 2, 6],
    ['accelerando 100->120 (slope 0.83 BPM/s)', 100, 120, 24, 110, 3, 6],
    ['ritardando 130->100 (slope -1.25 BPM/s)', 130, 100, 24, 115, 4, 12],
    ['accelerando 90->140 (slope 2.08 BPM/s)', 90, 140, 24, 115, 6, 12],
  ])('%s lands every beat on the target grid', (_l, a, b, secs, target, maxMedian, maxWorst) => {
    const { errs, map } = place(accelerandoBeats(a, b, secs, SR), secs, target);
    const stats = absStats(errs);
    expect(stats.n).toBe(map.placed.length);
    expect(stats.median).toBeLessThan(maxMedian);
    expect(stats.max).toBeLessThan(maxWorst);

    // A map correct at beat 0 and wrong everywhere after is the EXPECTED
    // failure mode, so the END of the accelerando is pinned by name.
    const last = Math.abs(errs[errs.length - 1]);
    expect(Number.isFinite(last)).toBe(true);
    expect(last).toBeLessThan(maxWorst);
    // And so is the far half as a whole, so a single lucky last beat cannot
    // carry the assertion.
    const farHalf = absStats(errs.slice(Math.floor(errs.length / 2)));
    expect(farHalf.median).toBeLessThan(maxMedian);
  });

  it('a step tempo change is corrected on BOTH sides of the step', () => {
    const secs = 24;
    const beats = stepTempoBeats(100, 125, 12, secs, SR);
    const { errs, map } = place(beats, secs, 112);
    // Same guard the accelerando cases carry: a beat that landed nowhere near
    // where the map says gives a null centroid, which becomes NaN and is
    // silently dropped by `absStats` — so without this line the two maxima below
    // would measure only the beats that DID land and partial breakage would read
    // as success.
    expect(absStats(errs).n).toBe(map.placed.length);
    const before = absStats(errs.slice(0, Math.floor(errs.length / 2) - 1));
    const after = absStats(errs.slice(Math.floor(errs.length / 2) + 1));
    expect(before.max).toBeLessThan(12);
    expect(after.max).toBeLessThan(12);
  });

  it('rubato of known amplitude is flattened', () => {
    const secs = 24;
    const beats = rubatoBeats(110, 0.08, 6, secs, SR);
    const { errs, map } = place(beats, secs, 110);
    const stats = absStats(errs);
    // Every beat was measured — see the step-tempo case above.
    expect(stats.n).toBe(map.placed.length);
    expect(stats.median).toBeLessThan(3);
    expect(stats.max).toBeLessThan(12);
  });

  it('and ONE ratio on the same accelerando is off by most of a beat — measured exactly', () => {
    // The comparison that gives the numbers above their meaning. Exact
    // arithmetic, no measurement window: the single-ratio error exceeds half a
    // beat, so a centroid window would silently latch onto the neighbouring
    // beat and report a truncated error (it did, in the first draft of R7's
    // measurement harness).
    const secs = 24;
    const beats = accelerandoBeats(100, 120, secs, SR);
    const targetSpacing = spacing(110);
    // The most FAVOURABLE single ratio there is: the one matching the region's
    // total duration, which pins the first and last beat exactly.
    const meanBpm = (60 * (beats.length - 1)) / ((beats[beats.length - 1] - beats[0]) / SR);
    const r = meanBpm / 110;
    let worst = 0;
    for (let k = 0; k < beats.length; k++) {
      worst = Math.max(worst, Math.abs(msOf(beats[k] * r - (beats[0] * r + k * targetSpacing))));
    }
    // 525.8 ms measured — 0.96 of a 545 ms beat.
    expect(worst).toBeGreaterThan(500);
    // And the whole point: the map's worst is two orders of magnitude smaller.
    const { errs } = place(beats, secs, 110);
    expect(absStats(errs).max).toBeLessThan(worst / 50);
  });

  it('the steady CONTROL is where one ratio is already right', () => {
    const secs = 24;
    const beats: number[] = [];
    for (let i = 0; i * spacing(120) < secs * SR; i++) beats.push(i * spacing(120));
    const targetSpacing = spacing(110);
    let worst = 0;
    for (let k = 0; k < beats.length; k++) {
      const single = beats[k] * (targetSpacing / spacing(120));
      worst = Math.max(worst, Math.abs(msOf(single - k * targetSpacing)));
    }
    expect(worst).toBeLessThan(1e-6);
  });
});

describe('pitch is preserved (F1’s YIN, not WSOLA’s construction)', () => {
  it('a steady 220 Hz tone stays at 220 Hz through a varying map', () => {
    // F9 established this check rather than trusting the stretcher's design.
    const secs = 12;
    const inLen = Math.round(secs * SR);
    const tone = new Float32Array(inLen);
    for (let i = 0; i < inLen; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);

    const beats = accelerandoBeats(90, 140, secs, SR);
    const map = buildTempoMap(beats, inLen, spacing(115));
    expect(map.identity).toBe(false);
    // The map really does vary — otherwise this proves nothing about the
    // VARIABLE path in particular.
    expect(map.maxLocalRatio / map.minLocalRatio).toBeGreaterThan(1.4);

    const out = applyTempoMap([tone], SR, map)[0];
    const track = detectPitch(out, SR);
    const voiced = track.frames.filter((f) => f.f0Hz !== null).map((f) => f.f0Hz as number);
    expect(voiced.length).toBeGreaterThan(track.frames.length * 0.9);
    const cents = voiced.map((f) => Math.abs(1200 * Math.log2(f / 220))).sort((a, b) => a - b);
    expect(cents[Math.floor(cents.length / 2)]).toBeLessThan(5);
    expect(cents[Math.floor(cents.length * 0.95)]).toBeLessThan(25);
  });
});

describe('applyTempoMap — the wiring, not just the evaluator', () => {
  it('is stereo-linked: both channels get the SAME offsets', () => {
    const secs = 6;
    const inLen = Math.round(secs * SR);
    const beats = accelerandoBeats(100, 130, secs, SR);
    const map = buildTempoMap(beats, inLen, spacing(115));
    const left = noise(inLen, 777);
    const right = new Float32Array(left); // identical channels
    const [outL, outR] = applyTempoMap([left, right], SR, map);
    expect(outL.length).toBe(outR.length);
    for (let i = 0; i < outL.length; i += 997) expect(outL[i]).toBe(outR[i]);
  });

  it('produces exactly the map’s outLen, for every channel', () => {
    const secs = 6;
    const inLen = Math.round(secs * SR);
    const beats = accelerandoBeats(100, 130, secs, SR);
    const map = buildTempoMap(beats, inLen, spacing(90));
    const out = applyTempoMap([noise(inLen, 5), noise(inLen, 6)], SR, map);
    expect(out[0].length).toBe(map.outLen);
    expect(out[1].length).toBe(map.outLen);
    // And that length is genuinely different from the input's — a map that was
    // built and then ignored would return `inLen`.
    expect(map.outLen).not.toBe(inLen);
  });

  it('reports progress and terminates at 1', () => {
    const inLen = 2 * SR;
    const beats = accelerandoBeats(100, 130, 2, SR);
    const map = buildTempoMap(beats, inLen, spacing(115));
    const seen: number[] = [];
    applyTempoMap([noise(inLen, 9)], SR, map, (f) => seen.push(f));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(1);
    for (const f of seen) expect(f).toBeGreaterThanOrEqual(0);
  });

  it('an identity map still reports progress', () => {
    const map: TempoMap = buildTempoMap([], 1000, 100);
    const seen: number[] = [];
    applyTempoMap([new Float32Array(1000)], SR, map, (f) => seen.push(f));
    expect(seen).toEqual([1]);
  });
});
