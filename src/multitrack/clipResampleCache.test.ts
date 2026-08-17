/**
 * MT2-2 — the sinc resample leaves the Play handler.
 *
 * A genuinely mixed-rate session is still legal (insert a 44.1 kHz file into a
 * session that already holds a 48 kHz clip), and for those clips
 * `readClipSlice` still has to resample. What it must not do is resample INSIDE
 * `play()`, every time, for the whole clip: that is the 22-second stall, and
 * the clip's samples have not changed since the last time it was computed.
 *
 * So the result is computed once per (document audio, session rate, clip
 * window), warmed off the play path at insert time, and shared by the realtime
 * player and the offline mixdown — both of which read it through the same
 * `readClipSlice`.
 *
 * The two properties that make a cache safe rather than a bug factory are
 * tested here as hard as the speed: an EDIT to the document must miss (a stale
 * play after an edit would be worse than a slow one), and the cache must be
 * bounded, because the entries are megabytes each.
 */
import { createDocument, replaceRegion, type AudioDocument } from '../audio/AudioDocument';
import * as resample from '../dsp/resample';
import { readClipSlice, warmClipResample } from './mixdown';
import { _clipResampleCacheStats, _resetClipResampleCache } from './clipResampleCache';
import { createClip, type Clip } from './session';

const DOC_RATE = 44_100;
const SESSION_RATE = 48_000;

function rampDoc(length: number, channels = 2, sampleRate = DOC_RATE): AudioDocument {
  return createDocument({
    name: 'ramp',
    sampleRate,
    channels: Array.from({ length: channels }, (_, c) =>
      Float32Array.from({ length }, (_, i) => Math.sin((i + c) / 7) * 0.5)
    ),
  });
}

function clipOf(offsetSample: number, lengthSample: number): Clip {
  return createClip({ documentId: 'doc-1', startSample: 0, offsetSample, lengthSample });
}

beforeEach(() => {
  _resetClipResampleCache();
  jest.restoreAllMocks();
});

describe('the resample happens once, not once per play', () => {
  it('serves a second read of the same clip from the cache, resampling nothing', () => {
    const doc = rampDoc(2000);
    const clip = clipOf(0, 400);
    const spy = jest.spyOn(resample, 'resampleChannel');

    const first = readClipSlice(doc, clip, SESSION_RATE);
    expect(spy).toHaveBeenCalledTimes(2); // one per channel

    spy.mockClear();
    const second = readClipSlice(doc, clip, SESSION_RATE);

    expect(spy).not.toHaveBeenCalled();
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it('warms the cache off the play path, so the first play resamples nothing', () => {
    jest.useFakeTimers();
    try {
      const doc = rampDoc(2000);
      const clip = clipOf(0, 400);
      const spy = jest.spyOn(resample, 'resampleChannel');

      warmClipResample(doc, clip, SESSION_RATE);
      expect(spy).not.toHaveBeenCalled(); // deferred, not done inline

      jest.runOnlyPendingTimers();
      expect(spy).toHaveBeenCalledTimes(2);

      spy.mockClear();
      readClipSlice(doc, clip, SESSION_RATE); // this is what play() calls
      expect(spy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not warm anything when the rates already agree', () => {
    jest.useFakeTimers();
    try {
      const doc = rampDoc(2000, 2, SESSION_RATE);
      const spy = jest.spyOn(resample, 'resampleChannel');
      warmClipResample(doc, clipOf(0, 400), SESSION_RATE);
      jest.runOnlyPendingTimers();
      expect(spy).not.toHaveBeenCalled();
      expect(_clipResampleCacheStats(doc)).toEqual({ entries: 0, samples: 0 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keys on the session rate, so the same clip in two sessions is two entries', () => {
    const doc = rampDoc(2000);
    const clip = clipOf(0, 400);
    readClipSlice(doc, clip, SESSION_RATE);
    readClipSlice(doc, clip, 96_000);
    expect(_clipResampleCacheStats(doc).entries).toBe(2);
  });

  it('keys on the clip window, so a trimmed clip is not served the old samples', () => {
    const doc = rampDoc(2000);
    const whole = readClipSlice(doc, clipOf(0, 400), SESSION_RATE);
    const trimmed = readClipSlice(doc, clipOf(100, 400), SESSION_RATE);
    expect(trimmed[0]).not.toBe(whole[0]);
    expect(Array.from(trimmed[0])).not.toEqual(Array.from(whole[0]));
  });
});

describe('an edited document is a cache MISS — a stale play would be worse than a slow one', () => {
  it('misses after a destructive edit replaces the channel arrays', () => {
    const doc = rampDoc(2000, 1);
    const clip = clipOf(0, 400);
    const before = readClipSlice(doc, clip, SESSION_RATE);

    // The real edit path: `applyEdit` calls helpers like this one, which
    // allocate fresh channel arrays and leave the document id alone. A cache
    // keyed on the id — or on nothing but the geometry — would serve `before`.
    const edited = replaceRegion(doc, 0, 200, [new Float32Array(200).fill(0.9)]);
    const spy = jest.spyOn(resample, 'resampleChannel');
    const after = readClipSlice(edited, clip, SESSION_RATE);

    expect(spy).toHaveBeenCalled();
    expect(Array.from(after[0])).not.toEqual(Array.from(before[0]));
  });

  it('misses when the channel arrays are swapped under the same channels array', () => {
    const doc = rampDoc(2000, 1);
    const clip = clipOf(0, 400);
    const before = readClipSlice(doc, clip, SESSION_RATE);

    doc.channels[0] = new Float32Array(2000).fill(0.25);
    const after = readClipSlice(doc, clip, SESSION_RATE);

    expect(Array.from(after[0])).not.toEqual(Array.from(before[0]));
    expect(after[0].every((v) => Math.abs(v - 0.25) < 1e-6)).toBe(true);
  });
});

describe('the cache is bounded — the entries are megabytes each', () => {
  it('holds at most one document-sized set of slices per document', () => {
    const doc = rampDoc(2000, 2);
    const budget = 2000 * 2;

    // Six different windows, each 400 session samples across two channels.
    for (let i = 0; i < 6; i++) readClipSlice(doc, clipOf(i * 10, 400), SESSION_RATE);

    const stats = _clipResampleCacheStats(doc);
    expect(stats.samples).toBeLessThanOrEqual(budget);
    expect(stats.entries).toBeGreaterThan(0);
  });

  it('evicts the LEAST RECENTLY USED window, keeping the one still being played', () => {
    const doc = rampDoc(400, 1);
    // Budget is 400 samples; each entry here is ~436 session samples, so only
    // the newest survives — which must be the one just READ, not the oldest.
    const a = clipOf(0, 400);
    const b = clipOf(1, 400);
    readClipSlice(doc, a, SESSION_RATE);
    readClipSlice(doc, b, SESSION_RATE);

    const spy = jest.spyOn(resample, 'resampleChannel');
    readClipSlice(doc, b, SESSION_RATE);
    expect(spy).not.toHaveBeenCalled();
  });

  it('lets the document take its cache with it — the key is the audio, not an id', () => {
    // A WeakMap on the channel arrays: nothing in this module outlives the
    // document, so a session that opens and closes a hundred files leaks none
    // of them. Observable here only as "a fresh document starts empty".
    const doc = rampDoc(2000, 1);
    readClipSlice(doc, clipOf(0, 400), SESSION_RATE);
    expect(_clipResampleCacheStats(doc).entries).toBe(1);
    expect(_clipResampleCacheStats(rampDoc(2000, 1))).toEqual({ entries: 0, samples: 0 });
  });
});

describe('a rate-matched read is never cached', () => {
  it('stays the zero-copy window and enters nothing into the cache', () => {
    const doc = rampDoc(2000, 2, SESSION_RATE);
    const slice = readClipSlice(doc, clipOf(0, 400), SESSION_RATE);
    expect(slice[0].buffer === doc.channels[0].buffer).toBe(true);
    expect(_clipResampleCacheStats(doc)).toEqual({ entries: 0, samples: 0 });
  });
});
