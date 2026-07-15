import {
  getClipWaveformCanvas,
  zoomBucket,
  _resetClipWaveformCache,
  _clipWaveformCacheSize,
  type ClipWaveformKey,
} from './clipWaveformCache';

// One shared channels reference: identity equality is part of the cache key,
// so hit-path tests must present the SAME array (as ClipView does while the
// document is unedited).
const SHARED_CHANNELS = [new Float32Array(4)];

function key(overrides: Partial<ClipWaveformKey> = {}): ClipWaveformKey {
  return {
    clipId: 'clip-1',
    lengthSample: 44100,
    bucket: 7,
    height: 40,
    channels: SHARED_CHANNELS,
    ...overrides,
  };
}

beforeEach(() => {
  _resetClipWaveformCache();
});

describe('zoomBucket', () => {
  it('is floor(log2(samplesPerPixel))', () => {
    expect(zoomBucket(1)).toBe(0);
    expect(zoomBucket(2)).toBe(1);
    expect(zoomBucket(3)).toBe(1);
    expect(zoomBucket(256)).toBe(8);
    expect(zoomBucket(511)).toBe(8);
    expect(zoomBucket(512)).toBe(9);
  });

  it('clamps sub-1 zoom onto bucket 0 (no negative buckets)', () => {
    expect(zoomBucket(0.25)).toBe(0);
    expect(zoomBucket(0)).toBe(0);
  });
});

describe('getClipWaveformCanvas', () => {
  it('draws once and returns the same canvas for an identical key', () => {
    const draw = jest.fn();
    const k = key();
    const first = getClipWaveformCanvas(k, 100, draw);
    const second = getClipWaveformCanvas({ ...k }, 100, draw);
    expect(second).toBe(first);
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it('redraws when the zoom bucket changes', () => {
    const draw = jest.fn();
    const k = key();
    const first = getClipWaveformCanvas(k, 100, draw);
    const second = getClipWaveformCanvas({ ...k, bucket: k.bucket + 1 }, 100, draw);
    expect(second).not.toBe(first);
    expect(draw).toHaveBeenCalledTimes(2);
  });

  it('redraws when lengthSample changes', () => {
    const draw = jest.fn();
    const k = key();
    getClipWaveformCanvas(k, 100, draw);
    getClipWaveformCanvas({ ...k, lengthSample: k.lengthSample + 1 }, 100, draw);
    expect(draw).toHaveBeenCalledTimes(2);
  });

  it('redraws when the doc channels array identity changes (edit invalidation)', () => {
    const draw = jest.fn();
    const k = key();
    getClipWaveformCanvas(k, 100, draw);
    // Same contents, different array identity — as after any editing operation
    // (all doc edits replace the channels arrays immutably).
    getClipWaveformCanvas({ ...k, channels: [new Float32Array(4)] }, 100, draw);
    expect(draw).toHaveBeenCalledTimes(2);
  });

  it('sizes a freshly drawn canvas to the requested width and key height', () => {
    const canvas = getClipWaveformCanvas(key({ height: 40 }), 123, () => {});
    expect(canvas.width).toBe(123);
    expect(canvas.height).toBe(40);
  });

  it('keeps one entry per clip id (a re-key replaces, not accumulates)', () => {
    const k = key();
    getClipWaveformCanvas(k, 100, () => {});
    getClipWaveformCanvas({ ...k, bucket: k.bucket + 1 }, 100, () => {});
    expect(_clipWaveformCacheSize()).toBe(1);
  });

  it('evicts the oldest entry beyond 200 clips', () => {
    for (let i = 0; i < 201; i++) {
      getClipWaveformCanvas(key({ clipId: `clip-${i}` }), 10, () => {});
    }
    expect(_clipWaveformCacheSize()).toBe(200);

    // clip-0 (oldest) was evicted — asking for it draws again.
    const draw = jest.fn();
    getClipWaveformCanvas(key({ clipId: 'clip-0' }), 10, draw);
    expect(draw).toHaveBeenCalledTimes(1);

    // clip-1 survived (it was the second inserted, still within the bound
    // after clip-0's eviction and clip-0's re-insert evicted clip-1... verify
    // instead with a recently-touched entry: clip-200 must still be cached.
    const drawHot = jest.fn();
    getClipWaveformCanvas(key({ clipId: 'clip-200' }), 10, drawHot);
    expect(drawHot).not.toHaveBeenCalled();
  });

  it('refreshes recency on a hit so hot entries survive eviction', () => {
    for (let i = 0; i < 200; i++) {
      getClipWaveformCanvas(key({ clipId: `clip-${i}` }), 10, () => {});
    }
    // Touch the oldest (clip-0): it becomes most-recent.
    const hit = jest.fn();
    getClipWaveformCanvas(key({ clipId: 'clip-0' }), 10, hit);
    expect(hit).not.toHaveBeenCalled();

    // Inserting one more evicts clip-1 (now the oldest), NOT clip-0.
    getClipWaveformCanvas(key({ clipId: 'clip-new' }), 10, () => {});
    const drawZero = jest.fn();
    getClipWaveformCanvas(key({ clipId: 'clip-0' }), 10, drawZero);
    expect(drawZero).not.toHaveBeenCalled();
    const drawOne = jest.fn();
    getClipWaveformCanvas(key({ clipId: 'clip-1' }), 10, drawOne);
    expect(drawOne).toHaveBeenCalledTimes(1);
  });
});
