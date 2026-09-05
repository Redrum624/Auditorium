/**
 * D3 — THE GAP RESOLVER, on its own, with no store and no React.
 *
 * A gap is the empty span on ONE track between two consecutive clips, or
 * between sample 0 and the first clip. The open end after the last clip is not
 * a gap (there is nothing on the far side to close it against), and neither is
 * anything a clip covers — which is what makes an overlapped span a non-gap
 * without needing a separate overlap rule.
 *
 * The fixture is deliberately OUT OF START ORDER in the array: `Track.clips`
 * is insertion-ordered and `trimClip('start')` writes in place without
 * re-sorting (session.ts, trap T40), so a resolver that trusted the array
 * order would answer differently for a session the user had trimmed.
 */
import { closeGapShifts, gapAt, gapProbeSample } from './gaps';
import { createClip, createTrack, type Track } from './session';

/** A(1000..1500) · B(2000..2500) · C(2600..2900), listed B, C, A. */
function seed(): { track: Track; a: string; b: string; c: string } {
  const track = createTrack('Track 1');
  const a = createClip({ documentId: 'doc-1', startSample: 1000, offsetSample: 128, lengthSample: 500 });
  const b = createClip({ documentId: 'doc-1', startSample: 2000, offsetSample: 256, lengthSample: 500 });
  const c = createClip({ documentId: 'doc-2', startSample: 2600, offsetSample: 64, lengthSample: 300 });
  track.clips = [b, c, a];
  return { track, a: a.id, b: b.id, c: c.id };
}

describe('gapAt', () => {
  it('names the span between two consecutive clips', () => {
    const { track } = seed();
    expect(gapAt(track, 1700)).toEqual({ trackId: track.id, startSample: 1500, endSample: 2000 });
  });

  it('names the LEADING span from sample 0 to the first clip', () => {
    const { track } = seed();
    expect(gapAt(track, 500)).toEqual({ trackId: track.id, startSample: 0, endSample: 1000 });
  });

  it('names the second inner span too — the array order is not the timeline order', () => {
    const { track } = seed();
    expect(gapAt(track, 2550)).toEqual({ trackId: track.id, startSample: 2500, endSample: 2600 });
  });

  it('refuses the open end after the last clip — there is nothing to close it against', () => {
    const { track } = seed();
    expect(gapAt(track, 3000)).toBeNull();
  });

  it('refuses both EDGES: the sample must be strictly inside', () => {
    const { track } = seed();
    expect(gapAt(track, 1500)).toBeNull(); // the gap's own start
    expect(gapAt(track, 2000)).toBeNull(); // the gap's own end (B starts here)
  });

  it('refuses a sample a clip covers', () => {
    const { track } = seed();
    expect(gapAt(track, 1200)).toBeNull();
    expect(gapAt(track, 2800)).toBeNull();
  });

  it('refuses a span two clips OVERLAP — the sample is covered, so it is no gap', () => {
    const track = createTrack('Overlap');
    track.clips = [
      createClip({ documentId: 'doc-3', startSample: 0, offsetSample: 0, lengthSample: 1000 }),
      createClip({ documentId: 'doc-3', startSample: 800, offsetSample: 32, lengthSample: 1000 }),
    ];
    expect(gapAt(track, 900)).toBeNull();
  });

  it('refuses everything on an empty track — the whole lane is the open end', () => {
    expect(gapAt(createTrack('Empty'), 500)).toBeNull();
  });

  it('measures the gap from the FARTHEST end on its left, not the nearest clip', () => {
    // A long clip swallowing a short one: the empty span starts where the LONG
    // clip ends, and a resolver pairing "consecutive" clips by start order
    // would have started it at the short clip's end (700) instead.
    const track = createTrack('Nested');
    track.clips = [
      createClip({ documentId: 'doc-4', startSample: 0, offsetSample: 0, lengthSample: 1000 }),
      createClip({ documentId: 'doc-4', startSample: 500, offsetSample: 16, lengthSample: 200 }),
      createClip({ documentId: 'doc-4', startSample: 2000, offsetSample: 48, lengthSample: 500 }),
    ];
    expect(gapAt(track, 1200)).toEqual({ trackId: track.id, startSample: 1000, endSample: 2000 });
  });
});

describe('closeGapShifts', () => {
  it('shifts every clip at or after the gap end left by the gap length, LEFTMOST FIRST', () => {
    const fx = seed();
    const gap = gapAt(fx.track, 1700)!;

    expect(closeGapShifts(fx.track, gap)).toEqual([
      { clipId: fx.b, toSample: 1500 },
      { clipId: fx.c, toSample: 2100 },
    ]);
  });

  it('leaves the clips BEFORE the gap alone — the shift list never names them', () => {
    const fx = seed();
    const gap = gapAt(fx.track, 1700)!;

    expect(closeGapShifts(fx.track, gap).some((s) => s.clipId === fx.a)).toBe(false);
  });

  it('a leading gap moves every clip on the track', () => {
    const fx = seed();
    const gap = gapAt(fx.track, 500)!;

    expect(closeGapShifts(fx.track, gap)).toEqual([
      { clipId: fx.a, toSample: 0 },
      { clipId: fx.b, toSample: 1000 },
      { clipId: fx.c, toSample: 1600 },
    ]);
  });
});

describe('gapProbeSample', () => {
  it('lands strictly inside every gap the resolver can name', () => {
    const { track } = seed();
    for (const probe of [500, 1700, 2550]) {
      const gap = gapAt(track, probe)!;
      expect(gapAt(track, gapProbeSample(gap))).toEqual(gap);
    }
  });

  it('is strictly inside a TWO-sample gap', () => {
    const track = createTrack('Tight');
    track.clips = [
      createClip({ documentId: 'doc-5', startSample: 100, offsetSample: 8, lengthSample: 400 }),
      createClip({ documentId: 'doc-5', startSample: 502, offsetSample: 8, lengthSample: 400 }),
    ];
    const gap = gapAt(track, 501)!;
    expect(gap).toEqual({ trackId: track.id, startSample: 500, endSample: 502 });
    expect(gapProbeSample(gap)).toBe(501);
    expect(gapAt(track, gapProbeSample(gap))).toEqual(gap);
  });

  it('is strictly inside a ONE-sample gap too — the probe is not floored', () => {
    // Review round 1, I1. `gapAt` refuses both edges, so the only samples
    // strictly inside a one-sample span are FRACTIONAL — and a caller can hand
    // one in (`selectGapAt`, and the lane could too before its own rounding).
    // A floored midpoint landed on the start edge, `gapAt` refused it, and
    // `closeGap` became a silent no-op.
    const track = createTrack('Tighter');
    track.clips = [
      createClip({ documentId: 'doc-5', startSample: 100, offsetSample: 8, lengthSample: 400 }),
      createClip({ documentId: 'doc-5', startSample: 501, offsetSample: 8, lengthSample: 400 }),
    ];
    const gap = gapAt(track, 500.5)!;
    expect(gap).toEqual({ trackId: track.id, startSample: 500, endSample: 501 });
    expect(gapProbeSample(gap)).toBe(500.5);
    expect(gapAt(track, gapProbeSample(gap))).toEqual(gap);
    // No INTEGER sample is strictly inside it, which is why the lane rounds:
    // a one-sample gap is unreachable by double-click, by construction.
    expect(gapAt(track, 500)).toBeNull();
    expect(gapAt(track, 501)).toBeNull();
  });

  it('is strictly inside every span, whatever its width', () => {
    for (const [start, end] of [
      [0, 1],
      [500, 501],
      [500, 502],
      [0, 44_100],
      [1, 1_000_001],
    ] as const) {
      const probe = gapProbeSample({ trackId: 't', startSample: start, endSample: end });
      expect(probe).toBeGreaterThan(start);
      expect(probe).toBeLessThan(end);
    }
  });
});
