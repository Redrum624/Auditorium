import { detectPitch } from './pitchDetect';
import { ONSET_FFT, ONSET_HOP } from './tempoCore';
import {
  analysisPosAt,
  applyTimingWarp,
  buildWarpMap,
  detectVocalOnsets,
  pickOnsetFrames,
  subdivideBeats,
  synthesisPosAt,
  warpRatios,
  DEFAULT_ONSET_THRESHOLD,
  DEFAULT_STRENGTH,
  MAX_LOCAL_RATIO,
  MEAN_RADIUS,
  MIN_LOCAL_RATIO,
  ONSET_MIN_SPACING_SEC,
  PEAK_RADIUS,
  type TimingAnchor,
  type WarpMap,
} from './timingWarp';
import { MAX_RATIO, MIN_RATIO } from './wsola';
import {
  QUALITY_TRANSPARENT_MAX_RATIO,
  QUALITY_TRANSPARENT_MIN_RATIO,
} from '../services/tempoService';

const SR = 48000;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

function sine(freq: number, secs: number, rate = SR, amp = 0.5): Float32Array {
  const n = Math.round(secs * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/** Deterministic LCG — never Math.random (fixture convention, tempoFixtures.ts). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Tone bursts with hard attacks at `positions` (samples): the synthetic
 * equivalent of syllables, with an onset the flux detector and an energy
 * measurement can both find unambiguously.
 */
function burstTrain(positions: number[], totalSamples: number, rate = SR): Float32Array {
  const out = new Float32Array(totalSamples);
  const burst = Math.round(0.08 * rate);
  const rnd = lcg(20260807);
  for (const p of positions) {
    for (let i = 0; i < burst && p + i < totalSamples; i++) {
      // Decaying broadband attack + a tone body: broadband so spectral flux
      // sees it, tonal so the body is trackable after a warp.
      const env = Math.exp(-i / (0.02 * rate));
      out[p + i] =
        0.6 * env * (rnd() * 2 - 1) + 0.35 * Math.sin((2 * Math.PI * 220 * i) / rate) * Math.exp(-i / (0.05 * rate));
    }
  }
  return out;
}

/** Centre of energy of the burst nearest `near`, within `+/- windowSamples`. */
function burstCentroid(x: Float32Array, near: number, windowSamples: number): number {
  const lo = Math.max(0, Math.round(near - windowSamples));
  const hi = Math.min(x.length, Math.round(near + windowSamples));
  let num = 0;
  let den = 0;
  for (let i = lo; i < hi; i++) {
    const e = x[i] * x[i];
    num += e * i;
    den += e;
  }
  return den > 0 ? num / den : NaN;
}

/**
 * How far a burst's energy centroid sits from a reference position.
 *
 * A decaying burst's centroid is ~14 ms AFTER its attack by construction, so
 * comparing an absolute centroid to a target measures the fixture's envelope
 * shape, not the warp. Every placement assertion below therefore compares the
 * centroid's OFFSET before the warp with its offset after — the envelope bias
 * is identical in both and cancels, leaving only the warp's own error. Measured
 * that way the engine places a burst within 2.7 ms of its target for moves from
 * 5 ms to 60 ms in either direction; {@link PLACEMENT_TOL_MS} is that measured
 * figure with headroom, not a guess.
 */
function burstOffset(x: Float32Array, ref: number, windowSamples: number): number {
  return burstCentroid(x, ref, windowSamples) - ref;
}

const PLACEMENT_TOL_MS = 4;
const CENTROID_WIN = 0.06 * SR;

function medianF0(x: Float32Array, rate = SR): number {
  const track = detectPitch(x, rate);
  const voiced = track.frames.map((f) => f.f0Hz).filter((f): f is number => f !== null);
  voiced.sort((a, b) => a - b);
  return voiced.length ? voiced[Math.floor(voiced.length / 2)] : NaN;
}

const cents = (a: number, b: number): number => 1200 * Math.log2(a / b);

/** A map's knot ratios, as the property to assert rather than a sample of it. */
function allRatiosWithin(map: WarpMap, lo: number, hi: number): boolean {
  const r = warpRatios(map);
  for (let i = 0; i < r.length; i++) {
    if (r[i] < lo - 1e-9 || r[i] > hi + 1e-9) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Derived constants — pinned against the sources they were derived FROM, so a
// drift in either is a failure here rather than a silent divergence.
// ---------------------------------------------------------------------------

describe('timingWarp constants', () => {
  it('bounds the local ratio to the repo\'s own transparent band, not the engine limits', () => {
    expect(MIN_LOCAL_RATIO).toBe(QUALITY_TRANSPARENT_MIN_RATIO);
    expect(MAX_LOCAL_RATIO).toBe(QUALITY_TRANSPARENT_MAX_RATIO);
    // And that band is strictly INSIDE the engine's limits — the point of the
    // exercise. Asserting the inequality, not just the equality above, is what
    // catches someone "fixing" the band by widening it to MIN_RATIO/MAX_RATIO.
    expect(MIN_LOCAL_RATIO).toBeGreaterThan(MIN_RATIO);
    expect(MAX_LOCAL_RATIO).toBeLessThan(MAX_RATIO);
  });

  it('defaults strength well below 100%', () => {
    expect(DEFAULT_STRENGTH).toBeGreaterThan(0);
    expect(DEFAULT_STRENGTH).toBeLessThan(0.5);
  });

  it('spaces onsets below the shortest measured syllable gap (211 ms) and above the analysis hop', () => {
    expect(ONSET_MIN_SPACING_SEC).toBeLessThan(0.211);
    expect(ONSET_MIN_SPACING_SEC).toBeGreaterThan(ONSET_HOP / SR);
  });

  it('pins the peak-picker geometry the reported precision/recall belongs to', () => {
    // LITERALS on purpose. Every other picker test is written in terms of
    // PEAK_RADIUS/MEAN_RADIUS so it probes the boundary wherever it is — which
    // means those tests move WITH a change to these constants and cannot
    // detect one (a mutation sweep confirmed: 3 -> 1, 3 -> 4, 10 -> 2 and
    // 10 -> 11 all survived the whole audio-level suite). The precision and
    // recall figures in the module header were measured at these exact values;
    // changing them invalidates those numbers, so the numbers are what this
    // pins.
    expect(PEAK_RADIUS).toBe(3);
    expect(MEAN_RADIUS).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// subdivideBeats
// ---------------------------------------------------------------------------

describe('subdivideBeats', () => {
  it('returns the beats unchanged for division 1', () => {
    const beats = [1000, 2000, 3000];
    expect(Array.from(subdivideBeats(beats, 1))).toEqual(beats);
  });

  it('refuses non-integer and sub-1 divisions, normalising them to the beats themselves', () => {
    const beats = [0, 1000, 2000];
    expect(Array.from(subdivideBeats(beats, 1.5))).toEqual(beats);
    expect(Array.from(subdivideBeats(beats, 0))).toEqual(beats);
    expect(Array.from(subdivideBeats(beats, -2))).toEqual(beats);
    expect(Array.from(subdivideBeats(beats, NaN))).toEqual(beats);
    // 1.5 must NOT be honoured as two-thirds of a beat — which is what
    // `d < 1.5` would emit if the integer check were dropped.
    expect(Array.from(subdivideBeats([0, 300], 1.5))).toEqual([0, 300]);
  });

  it('normalises a non-integer division to 1 rather than to its floor', () => {
    // floor(2.5) = 2 would give [0, 500, 1000]; normalising to 1 gives the
    // beats. The two differ, so this pins WHICH normalisation happens.
    expect(Array.from(subdivideBeats([0, 1000], 2.5))).toEqual([0, 1000]);
    expect(Array.from(subdivideBeats([0, 1000], 2))).toEqual([0, 500, 1000]);
  });

  it('is empty for no beats and a copy for one beat', () => {
    expect(subdivideBeats([], 4)).toHaveLength(0);
    expect(Array.from(subdivideBeats([500], 4))).toEqual([500]);
  });

  it('subdivides EVERY gap, not just the first, and ends on the last beat', () => {
    // Three gaps of different widths: a loop pinned on gap 0 alone would pass
    // while ignoring gaps 1 and 2.
    const beats = [0, 400, 1000, 1200];
    const got = Array.from(subdivideBeats(beats, 2));
    expect(got).toEqual([0, 200, 400, 700, 1000, 1100, 1200]);
  });

  it('follows drifting beats instead of laying a rigid grid', () => {
    // Gap 0 is 400 wide, gap 1 is 800: a rigid grid would put the same spacing
    // in both. The interpolated points must differ.
    const got = Array.from(subdivideBeats([0, 400, 1200], 4));
    expect(got).toEqual([0, 100, 200, 300, 400, 600, 800, 1000, 1200]);
  });

  it('never extrapolates past the last tracked beat', () => {
    const beats = [0, 500, 1000];
    const got = subdivideBeats(beats, 4);
    expect(got[got.length - 1]).toBe(1000);
  });

  it('de-duplicates when a subdivision rounds onto its neighbour', () => {
    // Gap of 2 samples split 4 ways: rounding collapses several points.
    const got = Array.from(subdivideBeats([0, 2, 4], 4));
    for (let i = 1; i < got.length; i++) expect(got[i]).toBeGreaterThan(got[i - 1]);
    expect(got[got.length - 1]).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// buildWarpMap — acceptance
// ---------------------------------------------------------------------------

describe('buildWarpMap anchor acceptance', () => {
  const N = 100000;
  const opts = { strength: 1 };

  it('accepts an anchor strictly inside the region and rejects one at either pinned end', () => {
    // source > 0 boundary: 0 rejected, 1 accepted.
    expect(buildWarpMap([{ source: 0, target: 10 }], N, opts).acceptedIndices).toEqual([]);
    expect(buildWarpMap([{ source: 1, target: 10 }], N, opts).acceptedIndices).toEqual([0]);
    // source < inLen boundary: N rejected, N-1 accepted.
    expect(buildWarpMap([{ source: N, target: 10 }], N, opts).acceptedIndices).toEqual([]);
    expect(buildWarpMap([{ source: N - 1, target: N - 100 }], N, opts).acceptedIndices).toEqual([0]);
  });

  it('rejects an anchor that is not strictly after the previous one, on both sides of the boundary', () => {
    const base = 5000;
    const eq = buildWarpMap(
      [
        { source: base, target: base },
        { source: base, target: base + 10 },
      ],
      N,
      opts
    );
    expect(eq.acceptedIndices).toEqual([0]);

    const before = buildWarpMap(
      [
        { source: base, target: base },
        { source: base - 1, target: base },
      ],
      N,
      opts
    );
    expect(before.acceptedIndices).toEqual([0]);

    const after = buildWarpMap(
      [
        { source: base, target: base },
        { source: base + 1, target: base + 1 },
      ],
      N,
      opts
    );
    expect(after.acceptedIndices).toEqual([0, 1]);
  });

  it('rejects non-finite coordinates in either operand role', () => {
    expect(buildWarpMap([{ source: NaN, target: 10 }], N, opts).acceptedIndices).toEqual([]);
    expect(buildWarpMap([{ source: 10, target: NaN }], N, opts).acceptedIndices).toEqual([]);
    expect(buildWarpMap([{ source: Infinity, target: 10 }], N, opts).acceptedIndices).toEqual([]);
    expect(buildWarpMap([{ source: 10, target: Infinity }], N, opts).acceptedIndices).toEqual([]);
  });

  it('keeps accepting after a rejection instead of stopping at the first bad anchor', () => {
    const map = buildWarpMap(
      [
        { source: 1000, target: 1100 },
        { source: 900, target: 1000 }, // out of order -> dropped
        { source: 2000, target: 2100 },
        { source: 3000, target: 3100 },
      ],
      N,
      opts
    );
    expect(map.acceptedIndices).toEqual([0, 2, 3]);
  });

  it('is the identity for an empty anchor list, a zero-length region, or strength 0', () => {
    expect(buildWarpMap([], N, opts).identity).toBe(true);
    expect(buildWarpMap([{ source: 100, target: 500 }], 0, opts).identity).toBe(true);
    expect(buildWarpMap([{ source: 100, target: 500 }], N, { strength: 0 }).identity).toBe(true);
  });

  it('is NOT the identity at the smallest strength above 0', () => {
    const map = buildWarpMap([{ source: 50000, target: 51000 }], N, { strength: 1e-6 });
    expect(map.identity).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildWarpMap — geometry, monotonicity, the bound
// ---------------------------------------------------------------------------

describe('buildWarpMap geometry', () => {
  const N = 480000; // 10 s

  it('pins both ends and never changes the region length', () => {
    const map = buildWarpMap(
      [
        { source: 100000, target: 120000 },
        { source: 300000, target: 280000 },
      ],
      N,
      { strength: 1 }
    );
    expect(map.outLen).toBe(N);
    expect(map.knotsIn[0]).toBe(0);
    expect(map.knotsOut[0]).toBe(0);
    expect(map.knotsIn[map.knotsIn.length - 1]).toBe(N);
    expect(map.knotsOut[map.knotsOut.length - 1]).toBe(N);
  });

  it('is strictly increasing in BOTH domains at every knot, not just the first', () => {
    const anchors: TimingAnchor[] = [];
    const rnd = lcg(4242);
    for (let s = 20000; s < N - 20000; s += 9000) {
      anchors.push({ source: s, target: s + Math.round((rnd() - 0.5) * 6000) });
    }
    expect(anchors.length).toBeGreaterThan(45);
    const map = buildWarpMap(anchors, N, { strength: 1 });
    expect(map.acceptedIndices).toHaveLength(anchors.length);
    for (let i = 1; i < map.knotsIn.length; i++) {
      expect(map.knotsIn[i]).toBeGreaterThan(map.knotsIn[i - 1]);
      expect(map.knotsOut[i]).toBeGreaterThan(map.knotsOut[i - 1]);
    }
  });

  it('applies exactly `strength` of each requested move when the bound is slack', () => {
    // Spans of 200 000 samples, moves of 1000: ratio excursion 0.5 %, far
    // inside the band, so nothing is clamped and the arithmetic is visible.
    const map = buildWarpMap(
      [
        { source: 200000, target: 201000 },
        { source: 400000, target: 396000 },
      ],
      N,
      { strength: 0.25 }
    );
    expect(map.clampedIndices).toEqual([]);
    expect(map.placed[0]).toBeCloseTo(200250, 6);
    expect(map.placed[1]).toBeCloseTo(399000, 6);
  });

  it('scales the move linearly with strength across the whole range', () => {
    const at = (s: number): number =>
      buildWarpMap([{ source: 200000, target: 210000 }], N, { strength: s }).placed[0];
    expect(at(0.25)).toBeCloseTo(202500, 6);
    expect(at(0.5)).toBeCloseTo(205000, 6);
    expect(at(1)).toBeCloseTo(210000, 6);
    // Out-of-range strengths clamp rather than extrapolate.
    expect(at(1.5)).toBeCloseTo(210000, 6);
    expect(buildWarpMap([{ source: 200000, target: 210000 }], N, { strength: -1 }).identity).toBe(true);
  });
});

describe('buildWarpMap ratio bound', () => {
  const N = 480000;

  // One anchor at `src` asked to move by `move`; the preceding span is `src`
  // wide, so the requested ratio on it is exactly 1 + move/src.
  const requestRatio = (src: number, ratio: number): WarpMap =>
    buildWarpMap([{ source: src, target: src + Math.round(src * (ratio - 1)) }], N, { strength: 1 });

  it('leaves a move BELOW the ceiling untouched, holds one ABOVE it at the ceiling', () => {
    const src = 100000;

    const below = requestRatio(src, 1.1);
    expect(below.clampedIndices).toEqual([]);
    expect(below.placed[0]).toBeCloseTo(110000, 6);

    const on = requestRatio(src, MAX_LOCAL_RATIO);
    expect(on.clampedIndices).toEqual([]);
    expect(on.placed[0]).toBeCloseTo(src * MAX_LOCAL_RATIO, 3);

    const above = requestRatio(src, 1.3);
    expect(above.clampedIndices).toEqual([0]);
    expect(above.placed[0]).toBeCloseTo(src * MAX_LOCAL_RATIO, 3);
    expect(above.placed[0]).toBeLessThan(src * 1.3);
  });

  it('leaves a move ABOVE the floor untouched, holds one BELOW it at the floor', () => {
    const src = 100000;

    const inside = requestRatio(src, 0.95);
    expect(inside.clampedIndices).toEqual([]);
    expect(inside.placed[0]).toBeCloseTo(95000, 6);

    const on = requestRatio(src, MIN_LOCAL_RATIO);
    expect(on.clampedIndices).toEqual([]);
    expect(on.placed[0]).toBeCloseTo(src * MIN_LOCAL_RATIO, 3);

    const below = requestRatio(src, 0.6);
    expect(below.clampedIndices).toEqual([0]);
    expect(below.placed[0]).toBeCloseTo(src * MIN_LOCAL_RATIO, 3);
    expect(below.placed[0]).toBeGreaterThan(src * 0.6);
  });

  it('holds EVERY segment inside the band, however extreme the request', () => {
    const anchors: TimingAnchor[] = [];
    const rnd = lcg(99);
    for (let s = 10000; s < N - 10000; s += 7000) {
      // Requests of up to +/- 20 000 samples across 7000-sample spans: a
      // ratio of 3.8 if it were honoured.
      anchors.push({ source: s, target: s + Math.round((rnd() - 0.5) * 40000) });
    }
    expect(anchors.length).toBeGreaterThan(60);
    const map = buildWarpMap(anchors, N, { strength: 1 });
    expect(allRatiosWithin(map, MIN_LOCAL_RATIO, MAX_LOCAL_RATIO)).toBe(true);
    // ... and the bound actually bit, so the assertion above is not vacuous.
    expect(map.clampedIndices.length).toBeGreaterThan(30);
  });

  it('reports a clamp for the anchor that was held, and not for the ones that were not', () => {
    const map = buildWarpMap(
      [
        { source: 100000, target: 100500 }, // slack
        { source: 200000, target: 260000 }, // far past the ceiling
        { source: 400000, target: 400500 }, // slack, and far enough not to be dragged
      ],
      N,
      { strength: 1 }
    );
    expect(map.clampedIndices).toEqual([1]);
  });

  it('propagates a clamp to a neighbour too close to absorb it, and reports that too', () => {
    // The same request with the third anchor 100 000 samples away instead of
    // 300 000: anchor 1 is held 45 500 samples late, and anchor 2 cannot get
    // back to its own target across the remaining span without a ratio below
    // the floor. The map stays continuous and monotone, so the drag is not
    // optional — but it IS reported, which is the whole point of
    // `clampedIndices`.
    const map = buildWarpMap(
      [
        { source: 100000, target: 100500 },
        { source: 200000, target: 260000 },
        { source: 300000, target: 300500 },
      ],
      N,
      { strength: 1 }
    );
    expect(map.clampedIndices).toEqual([1, 2]);
    expect(map.placed[2]).toBeGreaterThan(300500);
    expect(allRatiosWithin(map, MIN_LOCAL_RATIO, MAX_LOCAL_RATIO)).toBe(true);
  });

  it('never reports the pinned end as a clamped anchor', () => {
    // A last anchor near the end asking for a move the short tail cannot absorb:
    // the anchor is clamped, but index k-1 (the pin) must not appear.
    const map = buildWarpMap([{ source: N - 1000, target: N - 20000 }], N, { strength: 1 });
    expect(map.clampedIndices).toEqual([0]);
    expect(map.clampedIndices.every((i) => i < 1)).toBe(true);
    expect(map.knotsOut[map.knotsOut.length - 1]).toBe(N);
  });

  it('honours the BACKWARD CEILING: a late move the tail cannot compress into is limited by the tail', () => {
    // Mirror of the test below. Span before the anchor: 470 000 (its ceiling
    // would allow a move to 535 800). Span after: 10 000, which cannot compress
    // below 0.88 of itself, so the anchor cannot pass N - 10 000*0.88.
    const src = N - 10000;
    const map = buildWarpMap([{ source: src, target: src + 8000 }], N, { strength: 1 });
    expect(map.placed[0]).toBeCloseTo(N - 10000 * MIN_LOCAL_RATIO, 6);
    expect(map.clampedIndices).toEqual([0]);
    expect(allRatiosWithin(map, MIN_LOCAL_RATIO, MAX_LOCAL_RATIO)).toBe(true);
  });

  it('honours the BACKWARD FLOOR: a move the tail cannot absorb is limited by the tail, not by the head', () => {
    // Span before the anchor: 470 000 (could absorb a huge move).
    // Span after it: 10 000 (cannot). The ceiling on the forward span alone
    // would allow target 535 800; the tail restricts it to N - 10 000*0.88.
    const src = N - 10000;
    const map = buildWarpMap([{ source: src, target: src - 50000 }], N, { strength: 1 });
    const tailMax = N - 10000 * MIN_LOCAL_RATIO;
    const tailMin = N - 10000 * MAX_LOCAL_RATIO;
    expect(map.placed[0]).toBeGreaterThanOrEqual(tailMin - 1e-6);
    expect(map.placed[0]).toBeLessThanOrEqual(tailMax + 1e-6);
    expect(map.clampedIndices).toEqual([0]);
    expect(allRatiosWithin(map, MIN_LOCAL_RATIO, MAX_LOCAL_RATIO)).toBe(true);
  });

  it('respects a caller-supplied bound', () => {
    const tight = buildWarpMap([{ source: 100000, target: 110000 }], N, {
      strength: 1,
      minRatio: 0.99,
      maxRatio: 1.01,
    });
    expect(tight.placed[0]).toBeCloseTo(101000, 3);
    expect(tight.clampedIndices).toEqual([0]);
  });

  it('never loosens a caller bound past the engine limits, in either direction', () => {
    // A near-start anchor with a huge span after it, so the FORWARD ceiling is
    // the binding constraint and the backward pass cannot mask a missing clamp.
    const ceiling = buildWarpMap([{ source: 10000, target: 60000 }], N, {
      strength: 1,
      maxRatio: 1000,
    });
    expect(warpRatios(ceiling)[0]).toBeLessThanOrEqual(MAX_RATIO + 1e-9);
    expect(ceiling.placed[0]).toBeCloseTo(10000 * MAX_RATIO, 3);

    // Both ends of the caller band have to be loosened for the FLOOR to be the
    // binding constraint: with the default ceiling still at 1.14 the tail's
    // backward reachability bounds the anchor long before the floor does.
    const floor = buildWarpMap([{ source: 200000, target: 1000 }], N, {
      strength: 1,
      minRatio: 0.0001,
      maxRatio: 1000,
    });
    expect(warpRatios(floor)[0]).toBeGreaterThanOrEqual(MIN_RATIO - 1e-9);
    expect(floor.placed[0]).toBeCloseTo(200000 * MIN_RATIO, 3);
  });

  it('forces a caller band to contain 1, from EITHER side, so the pinned end stays reachable', () => {
    // A band entirely above 1 ([1.2, 1.5]) or entirely below it ([0.5, 0.8])
    // cannot hold both pinned ends at the same length: the map has to average
    // ratio 1 across the region. The band is widened to include 1 rather than
    // producing an unreachable pin and a silently broken map.
    const above = buildWarpMap([{ source: 200000, target: 200000 }], N, {
      strength: 1,
      minRatio: 1.2,
      maxRatio: 1.5,
    });
    expect(above.knotsOut[above.knotsOut.length - 1]).toBe(N);
    expect(allRatiosWithin(above, 1, 1.5)).toBe(true);
    expect(above.clampedIndices).toEqual([]);

    const below = buildWarpMap([{ source: 200000, target: 200000 }], N, {
      strength: 1,
      minRatio: 0.5,
      maxRatio: 0.8,
    });
    expect(below.knotsOut[below.knotsOut.length - 1]).toBe(N);
    expect(allRatiosWithin(below, 0.5, 1)).toBe(true);
    expect(below.clampedIndices).toEqual([]);
    // Both are exact identities — an anchor asking for no move gets no move,
    // whatever the caller's band.
    expect(above.placed[0]).toBeCloseTo(200000, 6);
    expect(below.placed[0]).toBeCloseTo(200000, 6);
  });
});

// ---------------------------------------------------------------------------
// analysisPosAt
// ---------------------------------------------------------------------------

describe('analysisPosAt', () => {
  const N = 480000;

  it('is the identity for an identity map', () => {
    const map = buildWarpMap([], N, { strength: 1 });
    for (const v of [0, 1, 12345, N / 2, N - 1, N]) expect(analysisPosAt(map, v)).toBeCloseTo(v, 6);
  });

  it('maps each knot output position back to its own input position — every knot, not the first', () => {
    const anchors: TimingAnchor[] = [];
    const rnd = lcg(7);
    for (let s = 20000; s < N - 20000; s += 11000) {
      anchors.push({ source: s, target: s + Math.round((rnd() - 0.5) * 5000) });
    }
    const map = buildWarpMap(anchors, N, { strength: 1 });
    expect(map.knotsIn.length).toBeGreaterThan(40);
    for (let j = 0; j < map.knotsIn.length; j++) {
      expect(analysisPosAt(map, map.knotsOut[j])).toBeCloseTo(map.knotsIn[j], 4);
    }
  });

  it('is monotone non-decreasing over the WHOLE output range, and stays in [0, inLen]', () => {
    const anchors: TimingAnchor[] = [];
    const rnd = lcg(31337);
    for (let s = 5000; s < N - 5000; s += 6000) {
      anchors.push({ source: s, target: s + Math.round((rnd() - 0.5) * 30000) });
    }
    const map = buildWarpMap(anchors, N, { strength: 1 });
    let prev = -1;
    for (let v = 0; v <= N; v += 97) {
      const p = analysisPosAt(map, v);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(N);
      prev = p;
    }
  });

  it('clamps outside the output range at both ends', () => {
    const map = buildWarpMap([{ source: 200000, target: 210000 }], N, { strength: 1 });
    expect(analysisPosAt(map, -5000)).toBe(0);
    expect(analysisPosAt(map, N + 5000)).toBe(N);
  });

  it('interpolates linearly inside a segment', () => {
    const map = buildWarpMap([{ source: 100000, target: 110000 }], N, { strength: 1 });
    // Output 0..110000 corresponds to input 0..100000, so the midpoint maps
    // proportionally.
    expect(analysisPosAt(map, 55000)).toBeCloseTo(50000, 3);
    expect(analysisPosAt(map, 110000)).toBeCloseTo(100000, 3);
  });
});

describe('synthesisPosAt', () => {
  const N = 480000;

  it('is the identity for an identity map', () => {
    const map = buildWarpMap([], N, { strength: 1 });
    for (const u of [0, 1, 12345, N / 2, N - 1, N]) expect(synthesisPosAt(map, u)).toBeCloseTo(u, 6);
  });

  it('sends every knot input position to its own output position — every knot, not the first', () => {
    const anchors: TimingAnchor[] = [];
    const rnd = lcg(555);
    for (let s = 20000; s < N - 20000; s += 11000) {
      anchors.push({ source: s, target: s + Math.round((rnd() - 0.5) * 5000) });
    }
    const map = buildWarpMap(anchors, N, { strength: 1 });
    expect(map.knotsIn.length).toBeGreaterThan(40);
    for (let j = 0; j < map.knotsIn.length; j++) {
      expect(synthesisPosAt(map, map.knotsIn[j])).toBeCloseTo(map.knotsOut[j], 4);
    }
  });

  it('round-trips with analysisPosAt across the whole range', () => {
    const anchors: TimingAnchor[] = [];
    const rnd = lcg(8080);
    for (let s = 10000; s < N - 10000; s += 9000) {
      anchors.push({ source: s, target: s + Math.round((rnd() - 0.5) * 8000) });
    }
    const map = buildWarpMap(anchors, N, { strength: 1 });
    for (let u = 0; u <= N; u += 313) {
      expect(analysisPosAt(map, synthesisPosAt(map, u))).toBeCloseTo(u, 3);
    }
  });

  it('is monotone non-decreasing and stays in [0, outLen], including outside the range', () => {
    const anchors: TimingAnchor[] = [];
    const rnd = lcg(1234);
    for (let s = 5000; s < N - 5000; s += 6000) {
      anchors.push({ source: s, target: s + Math.round((rnd() - 0.5) * 30000) });
    }
    const map = buildWarpMap(anchors, N, { strength: 1 });
    let prev = -1;
    for (let u = -5000; u <= N + 5000; u += 101) {
      const p = synthesisPosAt(map, u);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(map.outLen);
      prev = p;
    }
  });

  it('is NOT the proportional remap — which is the identity here, and wrong', () => {
    // `effectRunner`'s 'stretch' rule maps u -> u * outLen / inLen. The warp
    // preserves the region length, so that rule is the identity: it would leave
    // every marker exactly where it was. This is the discriminator — a test
    // that only checked "the marker is inside the region" could not tell the
    // two apart.
    const map = buildWarpMap([{ source: 200000, target: 220000 }], N, { strength: 1 });
    expect(map.outLen).toBe(N); // so proportional == identity, exactly
    const proportional = (u: number): number => (u * map.outLen) / map.inLen;

    for (const u of [50000, 150000, 200000, 300000, 400000]) {
      expect(proportional(u)).toBeCloseTo(u, 9);
      expect(Math.abs(synthesisPosAt(map, u) - u)).toBeGreaterThan(1000);
    }
    // The anchor itself lands on its target, not on itself.
    expect(synthesisPosAt(map, 200000)).toBeCloseTo(220000, 3);
  });
});

// ---------------------------------------------------------------------------
// detectVocalOnsets
// ---------------------------------------------------------------------------

describe('pickOnsetFrames', () => {
  /** A flat ODF with a single spike, long enough that the mean neighbourhood is
   * fully interior at the spike. */
  function flatWithSpike(n: number, at: number, height: number, floor = 0): Float64Array {
    const odf = new Float64Array(n).fill(floor);
    odf[at] = height;
    return odf;
  }
  const ALL = 1_000_000;
  const base = { peakRadius: PEAK_RADIUS, meanRadius: MEAN_RADIUS, threshold: 1, minSpacingFrames: 1 };

  it('rejects a candidate with a strictly greater neighbour AT the radius, on EITHER side', () => {
    for (const side of [-1, 1]) {
      const odf = new Float64Array(80);
      odf[40] = 10;
      odf[40 + side * PEAK_RADIUS] = 10.001;
      const { frames } = pickOnsetFrames(odf, 0, ALL, base);
      expect(frames).not.toContain(40);
      // The greater one is itself picked, so the picker is not simply silent.
      expect(frames).toContain(40 + side * PEAK_RADIUS);
    }
  });

  it('accepts a candidate whose greater neighbour is one frame BEYOND the radius, on either side', () => {
    for (const side of [-1, 1]) {
      const odf = new Float64Array(80);
      odf[40] = 10;
      odf[40 + side * (PEAK_RADIUS + 1)] = 10.001;
      const { frames } = pickOnsetFrames(odf, 0, ALL, { ...base, minSpacingFrames: 1 });
      expect(frames).toContain(40);
    }
  });

  it('treats a tie as a peak — a flat maximum is not silently discarded', () => {
    const odf = new Float64Array(80);
    odf[40] = 10;
    odf[41] = 10;
    // Only a STRICTLY greater neighbour rejects, so both tied frames pass the
    // peak test; the minimum spacing is what reduces them to one. A `>=` test
    // would reject BOTH and report no onset at all where the audio has one.
    expect(pickOnsetFrames(odf, 0, ALL, { ...base, minSpacingFrames: 1 }).frames).toEqual([40, 41]);
    expect(pickOnsetFrames(odf, 0, ALL, { ...base, minSpacingFrames: 2 }).frames).toEqual([40]);
  });

  it('applies the threshold to the excess over the local mean, below / on / above', () => {
    // Spike height h over a floor of 0 across 2*MEAN_RADIUS+1 frames:
    // excess = h - h/(2*MEAN_RADIUS+1) = h * 2*MEAN_RADIUS/(2*MEAN_RADIUS+1).
    const width = 2 * MEAN_RADIUS + 1;
    const h = 10;
    const excess = h - h / width;
    const odf = flatWithSpike(80, 40, h);
    expect(pickOnsetFrames(odf, 0, ALL, { ...base, threshold: excess - 1e-6 }).frames).toContain(40);
    expect(pickOnsetFrames(odf, 0, ALL, { ...base, threshold: excess }).frames).toContain(40);
    expect(pickOnsetFrames(odf, 0, ALL, { ...base, threshold: excess + 1e-6 }).frames).not.toContain(40);
  });

  it('measures the mean over exactly +/- meanRadius — a value just outside it does not count', () => {
    const odf = new Float64Array(120);
    odf[60] = 10;
    // Raise the frames at exactly +/-MEAN_RADIUS: they enter the mean, so the
    // excess drops. The same values one frame further out must not.
    const inside = new Float64Array(odf);
    inside[60 - MEAN_RADIUS] = 5;
    inside[60 + MEAN_RADIUS] = 5;
    const outside = new Float64Array(odf);
    outside[60 - MEAN_RADIUS - 1] = 5;
    outside[60 + MEAN_RADIUS - 1 + 2] = 5;

    const strengthOf = (o: Float64Array): number =>
      pickOnsetFrames(o, 0, ALL, { ...base, threshold: -1e9 }).strengths[
        pickOnsetFrames(o, 0, ALL, { ...base, threshold: -1e9 }).frames.indexOf(60)
      ];
    expect(strengthOf(inside)).toBeLessThan(strengthOf(odf));
    expect(strengthOf(outside)).toBeCloseTo(strengthOf(odf), 12);
  });

  it('enforces the minimum spacing at the boundary, in both directions', () => {
    const odf = new Float64Array(200);
    for (const at of [40, 60]) odf[at] = 10;
    // Gap of 20 frames. Spacing 20 admits both; 21 admits only the first.
    expect(pickOnsetFrames(odf, 0, ALL, { ...base, minSpacingFrames: 20 }).frames).toEqual([40, 60]);
    expect(pickOnsetFrames(odf, 0, ALL, { ...base, minSpacingFrames: 21 }).frames).toEqual([40]);
  });

  it('measures spacing from the last ACCEPTED frame, not the last candidate', () => {
    const odf = new Float64Array(200);
    for (const at of [40, 55, 70]) odf[at] = 10;
    // With spacing 20: 40 accepted, 55 rejected (15 < 20), 70 accepted
    // (70-40 = 30 >= 20). Measuring from the rejected 55 would reject 70 too.
    expect(pickOnsetFrames(odf, 0, ALL, { ...base, minSpacingFrames: 20 }).frames).toEqual([40, 70]);
  });

  it('honours the frame window at both ends, on and off the boundary', () => {
    const odf = new Float64Array(200);
    for (const at of [30, 100, 170]) odf[at] = 10;
    expect(pickOnsetFrames(odf, 30, 170, base).frames).toEqual([30, 100, 170]);
    expect(pickOnsetFrames(odf, 31, 169, base).frames).toEqual([100]);
  });

  it('reports a strength per frame, parallel and in order', () => {
    const odf = new Float64Array(200);
    odf[40] = 10;
    odf[100] = 20;
    const { frames, strengths } = pickOnsetFrames(odf, 0, ALL, base);
    expect(frames).toEqual([40, 100]);
    expect(strengths).toHaveLength(2);
    expect(strengths[1]).toBeGreaterThan(strengths[0]);
  });

  it('finds nothing in a flat function, however high its level', () => {
    expect(pickOnsetFrames(new Float64Array(200).fill(7), 0, ALL, base).frames).toEqual([]);
  });

  it('uses a peak neighbourhood of exactly 3 frames and a mean window of exactly 10', () => {
    // The same boundaries as above, written with LITERALS so the assertion does
    // not travel with the constant it is meant to protect.
    const peak = (distance: number): number[] => {
      const odf = new Float64Array(120);
      odf[60] = 10;
      odf[60 + distance] = 10.001;
      return pickOnsetFrames(odf, 0, ALL, { ...base, peakRadius: PEAK_RADIUS }).frames;
    };
    expect(peak(3)).not.toContain(60);
    expect(peak(4)).toContain(60);

    const strengthAt = (distance: number): number => {
      const odf = new Float64Array(160);
      odf[80] = 10;
      odf[80 + distance] = 5;
      const r = pickOnsetFrames(odf, 0, ALL, { ...base, meanRadius: MEAN_RADIUS, threshold: -1e9 });
      return r.strengths[r.frames.indexOf(80)];
    };
    const clean = (): number => {
      const odf = new Float64Array(160);
      odf[80] = 10;
      const r = pickOnsetFrames(odf, 0, ALL, { ...base, meanRadius: MEAN_RADIUS, threshold: -1e9 });
      return r.strengths[r.frames.indexOf(80)];
    };
    expect(strengthAt(10)).toBeLessThan(clean());
    expect(strengthAt(11)).toBeCloseTo(clean(), 12);
  });
});

describe('detectVocalOnsets', () => {
  it('returns nothing for input shorter than one analysis frame, and works at exactly one', () => {
    expect(detectVocalOnsets(new Float32Array(ONSET_FFT - 1), SR).samples).toHaveLength(0);
    // Exactly one frame is analysable (no crash, no invented onset).
    expect(() => detectVocalOnsets(new Float32Array(ONSET_FFT), SR)).not.toThrow();
    expect(detectVocalOnsets(new Float32Array(ONSET_FFT), SR).samples).toHaveLength(0);
  });

  it('reports the analysis rate it actually used', () => {
    expect(detectVocalOnsets(new Float32Array(0), SR).odfRate).toBeCloseTo(SR / ONSET_HOP, 9);
    expect(detectVocalOnsets(new Float32Array(0), 44100).odfRate).toBeCloseTo(44100 / ONSET_HOP, 9);
  });

  it('finds EVERY burst of a train, not just the first, and localises each within one hop', () => {
    const positions = [24000, 60000, 96000, 150000, 200000, 240000];
    const x = burstTrain(positions, 288000);
    const { samples } = detectVocalOnsets(x, SR);
    // Each ground-truth burst has a detection within +/- 2 hops (10.7 ms).
    const tol = 2 * ONSET_HOP;
    for (const p of positions) {
      const hit = Array.from(samples).some((s) => Math.abs(s - p) <= tol);
      expect({ p, hit, samples: Array.from(samples) }).toMatchObject({ hit: true });
    }
    // ... and it is not simply reporting everything.
    expect(samples.length).toBeLessThanOrEqual(positions.length + 2);
  });

  it('finds no onsets in silence or in a steady tone', () => {
    expect(detectVocalOnsets(new Float32Array(SR), SR).samples).toHaveLength(0);
    expect(detectVocalOnsets(sine(220, 2), SR).samples).toHaveLength(0);
  });

  it('applies the sensitivity threshold monotonically, in both directions from the default', () => {
    const positions = [24000, 60000, 96000, 150000, 200000, 240000];
    const x = burstTrain(positions, 288000);
    const loose = detectVocalOnsets(x, SR, { sensitivity: 0.05 }).samples.length;
    const mid = detectVocalOnsets(x, SR, { sensitivity: DEFAULT_ONSET_THRESHOLD }).samples.length;
    const tight = detectVocalOnsets(x, SR, { sensitivity: 1e6 }).samples.length;
    expect(loose).toBeGreaterThanOrEqual(mid);
    expect(mid).toBeGreaterThan(0);
    expect(tight).toBe(0);
  });

  it('reports a strength for every onset, at or above the threshold that admitted it', () => {
    const positions = [24000, 60000, 96000, 150000, 200000, 240000];
    const x = burstTrain(positions, 288000);
    const { samples, strengths } = detectVocalOnsets(x, SR, { sensitivity: 1.0 });
    expect(strengths).toHaveLength(samples.length);
    expect(samples.length).toBeGreaterThan(3);
    for (let i = 0; i < strengths.length; i++) expect(strengths[i]).toBeGreaterThanOrEqual(1.0);
  });

  it('enforces the minimum spacing on EVERY adjacent pair', () => {
    // Bursts 60 ms apart — closer than any real syllable pair.
    const positions = [24000, 26880, 29760, 60000, 62880, 100000];
    const x = burstTrain(positions, 144000);
    const spacing = 0.15;
    const { samples } = detectVocalOnsets(x, SR, { sensitivity: 0.05, minSpacingSec: spacing });
    expect(samples.length).toBeGreaterThan(1);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i] - samples[i - 1]).toBeGreaterThanOrEqual(Math.round(spacing * SR) - ONSET_HOP);
    }
  });

  it('never reports an onset inside the leading half-window, where the frame is zero-padded', () => {
    // An attack at sample 0: without the leading edge guard the picker reports
    // it at sample 512 (measured), which is the window filling with signal, not
    // an attack the audio contains at that time.
    const x = burstTrain([0, 60000], 120000);
    const { samples } = detectVocalOnsets(x, SR, { sensitivity: 0.05 });
    expect(samples.length).toBeGreaterThan(0);
    const firstPossible = (Math.ceil(ONSET_FFT / 2 / ONSET_HOP) + 1) * ONSET_HOP;
    for (const s of samples) expect(s).toBeGreaterThanOrEqual(firstPossible);
  });

  it('never reports a position past the end of the signal', () => {
    // A burst right at the tail: the final frame's window runs past the end.
    const n = 96000;
    const x = burstTrain([n - 3000], n);
    const { samples } = detectVocalOnsets(x, SR, { sensitivity: 0.05 });
    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(n);
    }
  });

  it('does not mutate its input', () => {
    const x = burstTrain([24000, 60000], 96000);
    const before = Float32Array.from(x);
    detectVocalOnsets(x, SR);
    expect(Array.from(x)).toEqual(Array.from(before));
  });
});

// ---------------------------------------------------------------------------
// applyTimingWarp
// ---------------------------------------------------------------------------

describe('applyTimingWarp', () => {
  // Every pass-through fixture below is NON-ZERO at sample 0. WSOLA's first
  // synthesis window has weight 0 there, so `olaWithOffsets` writes 0 into
  // out[0] — meaning a ratio-1 WSOLA pass IS byte-identical for any signal that
  // happens to start at zero, and a "byte-identical pass-through" test built on
  // a fixture like `burstTrain` (silent until its first burst) passes whether
  // the short circuit exists or not. Measured: with a 0.4 DC offset exactly one
  // sample differs, and that one sample is the whole test.
  const dcTone = (freq: number, secs: number): Float32Array => {
    const n = Math.round(secs * SR);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.4 + 0.2 * Math.sin((2 * Math.PI * freq * i) / SR);
    return out;
  };

  it('is a byte-identical pass-through at strength 0', () => {
    const l = dcTone(300, 3);
    const r = dcTone(330, 3);
    const anchors: TimingAnchor[] = [
      { source: 24000, target: 30000 },
      { source: 60000, target: 66000 },
    ];
    const { channels } = applyTimingWarp([l, r], SR, anchors, { strength: 0 });
    expect(channels).toHaveLength(2);
    expect(Array.from(channels[0])).toEqual(Array.from(l));
    expect(Array.from(channels[1])).toEqual(Array.from(r));
    // A COPY, not the same object — the effect contract forbids aliasing the
    // input into the result.
    expect(channels[0]).not.toBe(l);
    expect(channels[1]).not.toBe(r);
  });

  it('is a byte-identical pass-through when no anchor asks for a move', () => {
    const l = dcTone(300, 2);
    const { channels, map } = applyTimingWarp([l], SR, [{ source: 48000, target: 48000 }], {
      strength: 1,
    });
    expect(map.identity).toBe(true);
    expect(Array.from(channels[0])).toEqual(Array.from(l));
  });

  it('the pass-through fixture can actually detect a stray WSOLA pass', () => {
    // Guards the two tests above from going vacuous again: a ratio-1 warp of
    // this fixture, forced through the engine, is NOT byte-identical.
    const l = dcTone(300, 2);
    const forced = applyTimingWarp([l], SR, [{ source: 48000, target: 48001 }], { strength: 1 });
    expect(forced.map.identity).toBe(false);
    expect(Array.from(forced.channels[0])).not.toEqual(Array.from(l));
  });

  it('is NOT a pass-through at the smallest strength that moves anything', () => {
    const l = burstTrain([24000, 60000, 96000], 144000);
    const { channels } = applyTimingWarp([l], SR, [{ source: 60000, target: 66000 }], {
      strength: 1,
    });
    expect(Array.from(channels[0])).not.toEqual(Array.from(l));
  });

  it('keeps the region length exactly', () => {
    const l = burstTrain([24000, 60000, 96000], 144000);
    const r = burstTrain([24000, 60000, 96000], 144000);
    const { channels } = applyTimingWarp([l, r], SR, [{ source: 60000, target: 68000 }], {
      strength: 1,
    });
    expect(channels[0]).toHaveLength(144000);
    expect(channels[1]).toHaveLength(144000);
  });

  it('lands EVERY moved burst on its target, not just the first', () => {
    // 5 bursts, each asked to move by a different amount in a different
    // direction. Spans are 48 000 samples and the largest DIFFERENTIAL between
    // neighbouring moves is 3500 samples (ratio 1.073), so nothing clamps and
    // the placement is the only thing under test.
    const sources = [48000, 96000, 144000, 192000, 240000];
    const moves = [2000, -1500, 2000, -1500, 1000];
    const n = 288000;
    const x = burstTrain(sources, n);
    const anchors = sources.map((s, i) => ({ source: s, target: s + moves[i] }));
    const { channels, map } = applyTimingWarp([x], SR, anchors, { strength: 1 });
    expect(map.clampedIndices).toEqual([]);

    for (let i = 0; i < sources.length; i++) {
      const wantAt = sources[i] + moves[i];
      const drift =
        burstOffset(channels[0], wantAt, CENTROID_WIN) - burstOffset(x, sources[i], CENTROID_WIN);
      expect(Math.abs(drift)).toBeLessThan((PLACEMENT_TOL_MS / 1000) * SR);
      // ... and it genuinely MOVED. Without this the assertion above would
      // also pass if the warp did nothing at all and the burst simply stayed
      // where the tolerance window found it.
      const moved = burstCentroid(channels[0], wantAt, CENTROID_WIN) - burstCentroid(x, sources[i], CENTROID_WIN);
      expect(Math.abs(moved - moves[i])).toBeLessThan((PLACEMENT_TOL_MS / 1000) * SR);
      expect(Math.abs(moved)).toBeGreaterThan(Math.abs(moves[i]) * 0.5);
    }
  });

  it('preserves pitch — verified with F1\'s detector, not assumed from WSOLA', () => {
    const tone = sine(220, 4);
    const anchors: TimingAnchor[] = [
      { source: 48000, target: 52000 },
      { source: 96000, target: 92000 },
      { source: 144000, target: 149000 },
    ];
    const before = medianF0(tone);
    const { channels } = applyTimingWarp([tone], SR, anchors, { strength: 1 });
    const after = medianF0(channels[0]);
    expect(before).toBeCloseTo(220, 0);
    expect(Math.abs(cents(after, before))).toBeLessThan(5);
  });

  it('keeps the two channels phase-locked (one shared similarity search)', () => {
    // Identical content in both channels must stay identical after the warp —
    // if each channel picked its own offsets the stereo image would drift.
    const a = burstTrain([48000, 96000, 144000], 192000);
    const b = Float32Array.from(a);
    const { channels } = applyTimingWarp([a, b], SR, [{ source: 96000, target: 104000 }], {
      strength: 1,
    });
    expect(Array.from(channels[0])).toEqual(Array.from(channels[1]));
    // And the shared path is the one that ran: a mono-only guard would make
    // this vacuous, so assert the output actually differs from the input.
    expect(Array.from(channels[0])).not.toEqual(Array.from(a));
  });

  it('the ONE search reads the channel MEAN — a per-channel search is a different answer', () => {
    // The test above cannot see the difference it is named for. Its two channels
    // are byte-identical, so the mean IS each channel and a per-channel search
    // returns bit-identical offsets: the mutation
    // `channels.map(c => timeStretchVariableLinked([c], …))` — every channel
    // searching itself, the exact stereo-drift bug — passed the whole suite.
    //
    // The discriminator is a pair whose mean is NEITHER channel. Then the same
    // left channel, warped once beside a DIFFERENT right and once beside a copy
    // of itself, must come back differently, because only the search signal
    // changed between the two runs. A per-channel search cannot tell the two
    // runs apart: in both it is handed nothing but the left channel.
    // Broadband noise, not the burst train: bursts leave long silences where
    // every candidate offset scores the same, and the two runs then agree by
    // accident. Continuous content makes the similarity search sensitive
    // everywhere, which is the condition under which "which signal was
    // searched" is observable at all.
    const anchors: TimingAnchor[] = [{ source: 96000, target: 104000 }];
    const noise = (seed: number, n = 192000): Float32Array => {
      const rnd = lcg(seed);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = rnd() * 2 - 1;
      return out;
    };
    const l = noise(20260812);
    const r = noise(77778888);

    const beside = applyTimingWarp([l, r], SR, anchors, { strength: 1 }).channels;
    const alone = applyTimingWarp([l, Float32Array.from(l)], SR, anchors, { strength: 1 }).channels;

    // Same channel counts, same map, same anchors — only the mid signal differs.
    expect(beside[0]).toHaveLength(alone[0].length);
    expect(Array.from(beside[0])).not.toEqual(Array.from(alone[0]));
    // Symmetrically for the right channel, so this is a property of the search
    // rather than of which slot a channel happens to occupy.
    const rAlone = applyTimingWarp([r, Float32Array.from(r)], SR, anchors, { strength: 1 }).channels;
    expect(Array.from(beside[1])).not.toEqual(Array.from(rAlone[0]));
    // And the pair stays locked to EACH OTHER: both channels were displaced by
    // the same offsets, so a known relation between them survives the warp.
    // `-l` is the relation that is exact under a linear operator: the mid is
    // silent, and both channels still move together.
    const negated = applyTimingWarp([l, l.map((v) => -v)], SR, anchors, { strength: 1 }).channels;
    let broken = 0;
    for (let i = 0; i < negated[0].length; i++) if (negated[1][i] !== -negated[0][i]) broken++;
    expect(broken).toBe(0);
    expect(negated[0].some((v) => v !== 0)).toBe(true);
  });

  it('does not mutate its input channels', () => {
    const l = burstTrain([48000, 96000], 144000);
    const r = sine(440, 3);
    const lc = Float32Array.from(l);
    const rc = Float32Array.from(r);
    applyTimingWarp([l, r], SR, [{ source: 96000, target: 100000 }], { strength: 1 });
    expect(Array.from(l)).toEqual(Array.from(lc));
    expect(Array.from(r)).toEqual(Array.from(rc));
  });

  it('handles an empty channel list and a zero-length channel', () => {
    expect(applyTimingWarp([], SR, [{ source: 1, target: 2 }], { strength: 1 }).channels).toEqual([]);
    const empty = applyTimingWarp([new Float32Array(0)], SR, [{ source: 1, target: 2 }], {
      strength: 1,
    });
    expect(empty.channels[0]).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// End to end on the synthetic fixture the brief asks for
// ---------------------------------------------------------------------------

describe('alignment end to end', () => {
  it('pulls detected onsets onto a known grid — every one of them, from detection to placement', () => {
    // A 6 s "performance": bursts placed off a 0.5 s grid by known amounts. The
    // largest differential between neighbouring errors is 45 ms across a
    // 500 ms span (ratio 1.09), inside the band, so the bound never bites and
    // the test measures alignment rather than clamping.
    const rate = SR;
    const grid: number[] = [];
    for (let i = 1; i <= 10; i++) grid.push(i * 0.5 * rate);
    const errorMs = [25, -20, 15, -25, 20, -15, 25, -20, 18, -22];
    const sources = grid.map((g, i) => Math.round(g + (errorMs[i] / 1000) * rate));
    const n = 6 * rate;
    const x = burstTrain(sources, n);

    const detected = detectVocalOnsets(x, rate);
    // The detector must find them all — this is a synthetic fixture with hard
    // attacks, the case it is genuinely good at (a real vocal is not; see the
    // module header).
    expect(detected.samples.length).toBe(sources.length);

    const anchors: TimingAnchor[] = Array.from(detected.samples).map((s) => {
      let best = grid[0];
      for (const g of grid) if (Math.abs(g - s) < Math.abs(best - s)) best = g;
      return { source: s, target: best };
    });

    const { channels, map } = applyTimingWarp([x], rate, anchors, { strength: 1 });
    expect(map.clampedIndices).toEqual([]);

    const tolSamples = (PLACEMENT_TOL_MS / 1000) * rate;
    for (let i = 0; i < grid.length; i++) {
      // The claim is that the burst MOVED BY the error, i.e. its centroid
      // travelled from `source + bias` to `grid + bias`. Comparing |offset from
      // grid| before and after would not test that: the fixture's ~14 ms
      // envelope bias partly cancels a negative error, so a correctly aligned
      // burst can read as "further from the grid" than it started. Measure the
      // travel, which the bias cannot touch.
      const travelled =
        burstCentroid(channels[0], grid[i], CENTROID_WIN) - burstCentroid(x, sources[i], CENTROID_WIN);
      const wanted = grid[i] - sources[i];
      expect(Math.abs(travelled - wanted)).toBeLessThan(tolSamples);
      // Non-vacuous: there really was an error to remove, bigger than the
      // tolerance the assertion above allows.
      expect(Math.abs(wanted)).toBeGreaterThan(tolSamples);
    }
  });

  it('at DEFAULT_STRENGTH removes a quarter of the error, not all of it', () => {
    const rate = SR;
    const grid = [1, 2, 3, 4].map((i) => i * 0.5 * rate);
    // A uniform error across the phrase: every anchor moves by the same amount,
    // so the differential between neighbours is zero and only the two pinned
    // ends absorb any ratio change. That isolates strength from the bound.
    const errSamples = Math.round(0.06 * rate);
    const sources = grid.map((g) => g + errSamples);
    const x = burstTrain(sources, 3 * rate);
    const anchors = sources.map((s, i) => ({ source: s, target: grid[i] }));

    const { channels, map } = applyTimingWarp([x], rate, anchors, { strength: DEFAULT_STRENGTH });
    expect(map.clampedIndices).toEqual([]);
    for (let i = 0; i < grid.length; i++) {
      const want = grid[i] + errSamples * (1 - DEFAULT_STRENGTH);
      const drift = burstOffset(channels[0], want, CENTROID_WIN) - burstOffset(x, sources[i], CENTROID_WIN);
      expect(Math.abs(drift)).toBeLessThan((PLACEMENT_TOL_MS / 1000) * rate);
    }
    // And a full-strength run on the same material lands somewhere measurably
    // different — otherwise "strength scales the move" would be untested at the
    // audio level, only in the map.
    const full = applyTimingWarp([x], rate, anchors, { strength: 1 });
    const fullDrift =
      burstOffset(full.channels[0], grid[1], CENTROID_WIN) - burstOffset(x, sources[1], CENTROID_WIN);
    expect(Math.abs(fullDrift)).toBeLessThan((PLACEMENT_TOL_MS / 1000) * rate);
    expect(
      Math.abs(burstCentroid(full.channels[0], grid[1], CENTROID_WIN) -
        burstCentroid(channels[0], grid[1] + errSamples * (1 - DEFAULT_STRENGTH), CENTROID_WIN))
    ).toBeGreaterThan(errSamples * DEFAULT_STRENGTH);
  });
});
