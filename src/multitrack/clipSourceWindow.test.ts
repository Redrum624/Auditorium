/**
 * Lot E (item 4, N14) — `clipSourceWindow`, the one exported statement of the
 * source window a clip reads.
 *
 * `readClipSlice` (mixdown.ts) converts `lengthSample` session samples into
 * document samples at `docRate / sessionRate` and reads
 * `[offsetSample, offsetSample + span)`. Two private `docSpan` copies
 * (`sessionSnapTargets`, `clipBeatTics`) restate it; this export states it
 * once for the view-entry carry. These cases pin the arithmetic (`Math.round`,
 * the matched-rate arm returning `lengthSample` verbatim), that the window is
 * UNCLAMPED (clamping is `resolveRegion`'s job), and that the matched-rate
 * answer agrees with what playback actually reads.
 */
import { createDocument } from '../audio/AudioDocument';
import { readClipSlice } from './mixdown';
import { clipSourceWindow, createClip } from './session';

describe('clipSourceWindow', () => {
  it('matched rates: the window is [offset, offset + lengthSample)', () => {
    expect(clipSourceWindow({ offsetSample: 2000, lengthSample: 3000 }, 44100, 44100)).toEqual({
      start: 2000,
      end: 5000,
    });
  });

  it('48 kHz doc in a 44.1 kHz session: 4410 session samples span 4800 doc samples', () => {
    const w = clipSourceWindow({ offsetSample: 0, lengthSample: 4410 }, 48000, 44100);
    expect(w.end - w.start).toBe(4800);
  });

  it('44.1 kHz doc in a 48 kHz session: 4800 session samples span 4410 doc samples', () => {
    const w = clipSourceWindow({ offsetSample: 0, lengthSample: 4800 }, 44100, 48000);
    expect(w.end - w.start).toBe(4410);
  });

  it('22.05 kHz doc in a 44.1 kHz session: 1000 session samples span 500 doc samples', () => {
    const w = clipSourceWindow({ offsetSample: 0, lengthSample: 1000 }, 22050, 44100);
    expect(w.end - w.start).toBe(500);
  });

  it('is unclamped: a clip trimmed past its source ends beyond the document', () => {
    // A 10 000-sample document is implied; the helper never sees it.
    expect(clipSourceWindow({ offsetSample: 9000, lengthSample: 3000 }, 44100, 44100).end).toBe(
      12000
    );
  });

  it('agrees with readClipSlice at a matched rate', () => {
    const docB = createDocument({
      name: 'B',
      sampleRate: 44100,
      channels: [new Float32Array(10000)],
    });
    const clip = createClip({
      documentId: docB.id,
      startSample: 0,
      offsetSample: 2000,
      lengthSample: 3000,
    });
    const { start, end } = clipSourceWindow(clip, docB.sampleRate, 44100);
    expect(readClipSlice(docB, clip, 44100)[0].length).toBe(end - start);
  });
});
