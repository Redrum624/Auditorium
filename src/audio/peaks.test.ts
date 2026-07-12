import { buildPeaks, getPeaksForRange, PeakPyramid } from './peaks';

function ramp(n: number): Float32Array {
  const channel = new Float32Array(n);
  for (let i = 0; i < n; i++) channel[i] = i;
  return channel;
}

function constant(n: number, value: number): Float32Array {
  const channel = new Float32Array(n);
  channel.fill(value);
  return channel;
}

function alternating(n: number): Float32Array {
  const channel = new Float32Array(n);
  for (let i = 0; i < n; i++) channel[i] = i % 2 === 0 ? 1 : -1;
  return channel;
}

describe('buildPeaks', () => {
  it('produces levels for blockSizes 256, 1024, 4096, 16384', () => {
    const pyramid = buildPeaks(ramp(100_000));
    expect(pyramid.levels.map((l) => l.blockSize)).toEqual([256, 1024, 4096, 16384]);
  });

  it('has ceil(n/blockSize) blocks per level for a 100_000-sample channel', () => {
    const pyramid = buildPeaks(ramp(100_000));
    const n = 100_000;
    for (const level of pyramid.levels) {
      const expectedCount = Math.ceil(n / level.blockSize);
      expect(level.min.length).toBe(expectedCount);
      expect(level.max.length).toBe(expectedCount);
    }
  });

  it('level 256 block k has min/max equal to the ramp values at k*256 and k*256+255', () => {
    const pyramid = buildPeaks(ramp(100_000));
    const level256 = pyramid.levels[0];
    for (const k of [0, 1, 50, 389]) {
      expect(level256.min[k]).toBe(k * 256);
      expect(level256.max[k]).toBe(k * 256 + 255);
    }
  });

  it('the last (partial) block of level 256 aggregates only existing samples', () => {
    const n = 100_000;
    const pyramid = buildPeaks(ramp(n));
    const level256 = pyramid.levels[0];
    const lastBlock = level256.min.length - 1; // block 390: samples 99840..99999
    expect(lastBlock).toBe(390);
    expect(level256.min[lastBlock]).toBe(390 * 256);
    expect(level256.max[lastBlock]).toBe(n - 1);
  });

  it('returns levels with 0 blocks for an empty channel', () => {
    const pyramid = buildPeaks(new Float32Array(0));
    for (const level of pyramid.levels) {
      expect(level.min.length).toBe(0);
      expect(level.max.length).toBe(0);
    }
  });
});

describe('getPeaksForRange', () => {
  it('returns the constant value in every bucket for a constant signal (level path)', () => {
    const channel = constant(100_000, 0.5);
    const pyramid = buildPeaks(channel);
    const { min, max } = getPeaksForRange(pyramid, channel, 0, 100_000, 10);
    for (let i = 0; i < 10; i++) {
      expect(min[i]).toBeCloseTo(0.5);
      expect(max[i]).toBeCloseTo(0.5);
    }
  });

  it('returns min=-1 max=+1 in every bucket for an alternating signal, 10 buckets over full range', () => {
    const channel = alternating(100_000);
    const pyramid = buildPeaks(channel);
    const { min, max } = getPeaksForRange(pyramid, channel, 0, 100_000, 10);
    for (let i = 0; i < 10; i++) {
      expect(min[i]).toBe(-1);
      expect(max[i]).toBe(1);
    }
  });

  it('matches a direct scan when zoomed in (range smaller than 256*buckets, raw path)', () => {
    const channel = Float32Array.from({ length: 20 }, (_, i) => i);
    const pyramid = buildPeaks(channel);
    // samplesPerBucket = 20/4 = 5 < 256 -> raw scan path
    const { min, max } = getPeaksForRange(pyramid, channel, 0, 20, 4);
    expect(Array.from(min)).toEqual([0, 5, 10, 15]);
    expect(Array.from(max)).toEqual([4, 9, 14, 19]);
  });

  it('returns zero-filled buckets for an empty channel', () => {
    const channel = new Float32Array(0);
    const pyramid = buildPeaks(channel);
    const { min, max } = getPeaksForRange(pyramid, channel, 0, 0, 5);
    expect(Array.from(min)).toEqual([0, 0, 0, 0, 0]);
    expect(Array.from(max)).toEqual([0, 0, 0, 0, 0]);
  });

  it('returns zero-filled buckets when start >= end after clamping', () => {
    const channel = ramp(100);
    const pyramid = buildPeaks(channel);
    const { min, max } = getPeaksForRange(pyramid, channel, 10, 5, 3);
    expect(Array.from(min)).toEqual([0, 0, 0]);
    expect(Array.from(max)).toEqual([0, 0, 0]);
  });

  it('returns zero-filled buckets when the whole requested range is beyond the channel end', () => {
    const channel = ramp(10);
    const pyramid = buildPeaks(channel);
    const { min, max } = getPeaksForRange(pyramid, channel, 200, 300, 4);
    expect(Array.from(min)).toEqual([0, 0, 0, 0]);
    expect(Array.from(max)).toEqual([0, 0, 0, 0]);
  });

  it('clamps endSample beyond channel length and aggregates only existing data', () => {
    const channel = Float32Array.from({ length: 10 }, (_, i) => i); // 0..9
    const pyramid = buildPeaks(channel);
    // requested end=100 clamps to 10; samplesPerBucket = 10/2 = 5 < 256 -> raw path
    const { min, max } = getPeaksForRange(pyramid, channel, 0, 100, 2);
    expect(Array.from(min)).toEqual([0, 5]);
    expect(Array.from(max)).toEqual([4, 9]);
  });

  it('selects a coarser level as samplesPerBucket grows, still returning correct min/max for a constant signal', () => {
    const channel = constant(2_000_000, -0.25);
    const pyramid: PeakPyramid = buildPeaks(channel);
    // samplesPerBucket = 2_000_000 / 20 = 100_000 -> level 16384
    const { min, max } = getPeaksForRange(pyramid, channel, 0, 2_000_000, 20);
    for (let i = 0; i < 20; i++) {
      expect(min[i]).toBeCloseTo(-0.25);
      expect(max[i]).toBeCloseTo(-0.25);
    }
  });
});
