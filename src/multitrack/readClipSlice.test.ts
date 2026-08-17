/**
 * MT2-3 — the residual cost of a MATCHED-rate play.
 *
 * With the session at the files' own rate (which MT2-1 now arranges for the
 * reported flow), `play()` still took 222.8 ms median process-cold for two
 * 3-minute stereo clips. There is no resample left to blame: what remains is
 * `readClipSlice` copying every sample of every clip through a JavaScript loop
 * — about 34.6 million iterations and ~138 MB allocated — to produce an array
 * that `AudioBuffer.copyToChannel` immediately copies AGAIN.
 *
 * A read that lies entirely inside its document is a WINDOW onto that
 * document's samples, so it is returned as one: `copyToChannel` then makes the
 * one copy the audio graph actually needs. The zero-fill only exists for reads
 * that run off an edge, and it is a `set()` of the overlapping part rather than
 * a per-sample conditional.
 *
 * These tests pin BOTH halves — the no-copy property (which is the fix) and the
 * exact sample semantics the two audio engines already depend on (which the fix
 * must not move by a single float).
 */
import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { readClipSlice } from './mixdown';
import { createClip, type Clip } from './session';
import { resampleChannel } from '../dsp/resample';

const SR = 48_000;

/** A document whose samples are their own index — so a wrong offset, a wrong
 * length or a dropped channel is visible in the VALUES, not just in a length. */
function rampDoc(length: number, channels = 2, sampleRate = SR): AudioDocument {
  return createDocument({
    name: 'ramp',
    sampleRate,
    channels: Array.from({ length: channels }, (_, c) =>
      Float32Array.from({ length }, (_, i) => (i + 1) / 1e6 + c)
    ),
  });
}

function clipOf(offsetSample: number, lengthSample: number): Clip {
  return createClip({ documentId: 'doc-1', startSample: 0, offsetSample, lengthSample });
}

describe('a fully in-range, rate-matched read costs no copy at all', () => {
  it('returns a WINDOW onto the document channel rather than a fresh array', () => {
    const doc = rampDoc(1000);
    const slice = readClipSlice(doc, clipOf(100, 400), SR);

    expect(slice).toHaveLength(2);
    for (let c = 0; c < 2; c++) {
      // Same underlying memory, positioned at the offset: the read allocated
      // nothing and copied nothing. A `slice()`/loop implementation fails both.
      // Compared as a boolean — jest cannot diff-print an ArrayBuffer.
      expect(slice[c].buffer === doc.channels[c].buffer).toBe(true);
      expect(slice[c].byteOffset).toBe(doc.channels[c].byteOffset + 100 * 4);
      expect(slice[c].length).toBe(400);
    }
  });

  it('still reads exactly the region the clip names', () => {
    const doc = rampDoc(1000);
    const slice = readClipSlice(doc, clipOf(100, 400), SR);

    expect(slice[0][0]).toBe(doc.channels[0][100]);
    expect(slice[0][399]).toBe(doc.channels[0][499]);
    expect(slice[1][0]).toBe(doc.channels[1][100]);
    expect(Array.from(slice[0])).toEqual(Array.from(doc.channels[0].subarray(100, 500)));
  });

  it('reads a whole document without an offset', () => {
    const doc = rampDoc(256);
    const slice = readClipSlice(doc, clipOf(0, 256), SR);

    expect(slice[0].length).toBe(256);
    expect(Array.from(slice[0])).toEqual(Array.from(doc.channels[0]));
  });
});

describe('an out-of-range read is still zero-filled, sample for sample', () => {
  it('zero-fills the head when the offset is negative', () => {
    const doc = rampDoc(100);
    const slice = readClipSlice(doc, clipOf(-10, 30), SR);

    expect(slice[0].length).toBe(30);
    expect(Array.from(slice[0].subarray(0, 10))).toEqual(new Array(10).fill(0));
    expect(Array.from(slice[0].subarray(10))).toEqual(Array.from(doc.channels[0].subarray(0, 20)));
  });

  it('zero-fills the tail when the clip outruns the document', () => {
    const doc = rampDoc(100);
    const slice = readClipSlice(doc, clipOf(90, 30), SR);

    expect(slice[0].length).toBe(30);
    expect(Array.from(slice[0].subarray(0, 10))).toEqual(Array.from(doc.channels[0].subarray(90)));
    expect(Array.from(slice[0].subarray(10))).toEqual(new Array(20).fill(0));
  });

  it('is all zeros when the window misses the document entirely', () => {
    const doc = rampDoc(100);
    const slice = readClipSlice(doc, clipOf(500, 20), SR);

    expect(slice[0].length).toBe(20);
    expect(Array.from(slice[0])).toEqual(new Array(20).fill(0));
    // And it is NOT a window onto the document — nothing may alias here.
    expect(slice[0].buffer === doc.channels[0].buffer).toBe(false);
  });

  it('zero-fills both edges when the clip is longer than the whole document', () => {
    const doc = rampDoc(10);
    const slice = readClipSlice(doc, clipOf(-5, 30), SR);

    expect(Array.from(slice[0].subarray(0, 5))).toEqual(new Array(5).fill(0));
    expect(Array.from(slice[0].subarray(5, 15))).toEqual(Array.from(doc.channels[0]));
    expect(Array.from(slice[0].subarray(15))).toEqual(new Array(15).fill(0));
  });
});

describe('the rate-mismatched read is unchanged, arithmetic included', () => {
  it('resamples the same zero-filled window it always did, to the same samples', () => {
    const doc = rampDoc(1000, 2, 44_100);
    const clip = clipOf(100, 400);
    const slice = readClipSlice(doc, clip, SR);

    // The source window `readClipSlice` reads is round(lengthSample · docRate /
    // sessionRate) samples from `offsetSample`, resampled up. Reproduced here
    // literally, so a change to either rounding or to the window fails.
    const docSliceLen = Math.round((400 * 44_100) / SR);
    const expected = resampleChannel(doc.channels[0].subarray(100, 100 + docSliceLen), 44_100, SR);
    expect(Array.from(slice[0])).toEqual(Array.from(expected));
  });

  it('keeps the twice-rounded length contract: the slice may miss lengthSample', () => {
    const doc = rampDoc(1000, 1, 44_100);
    const slice = readClipSlice(doc, clipOf(0, 401), SR);
    const docSliceLen = Math.round((401 * 44_100) / SR);
    expect(slice[0].length).toBe(Math.round((docSliceLen * SR) / 44_100));
  });

  it('never hands back a window onto the document when it resampled', () => {
    const doc = rampDoc(1000, 2, 44_100);
    const slice = readClipSlice(doc, clipOf(0, 400), SR);
    expect(slice[0].buffer === doc.channels[0].buffer).toBe(false);
  });
});

describe('the empty answers', () => {
  it('returns [] for a non-positive length', () => {
    expect(readClipSlice(rampDoc(100), clipOf(0, 0), SR)).toEqual([]);
  });

  it('returns [] for a channel-less document', () => {
    const doc = createDocument({ name: 'silent', sampleRate: SR, channels: [] });
    expect(readClipSlice(doc, clipOf(0, 100), SR)).toEqual([]);
  });
});
