import { createClip, createTrack, type Session } from './session';
import { clipBoundaries, nextClipEdge } from './clipEdges';

/**
 * K1 R1 — the arithmetic behind Ctrl+Left / Ctrl+Right, tested without a store
 * or a DOM. The commands in `menuActions` are a two-line adapter over these
 * two functions, so everything worth pinning about edge navigation is here.
 */

function sessionOf(...tracks: { start: number; length: number }[][]): Session {
  return {
    name: 'Edges',
    sampleRate: 44100,
    tracks: tracks.map((clips, i) => {
      const t = createTrack(`Track ${i + 1}`);
      t.clips = clips.map((c) =>
        createClip({
          documentId: 'doc-1',
          startSample: c.start,
          offsetSample: 0,
          lengthSample: c.length,
        })
      );
      return t;
    }),
  };
}

describe('clipBoundaries', () => {
  it('is every clip start and end, ascending', () => {
    const session = sessionOf([{ start: 100, length: 400 }, { start: 900, length: 100 }]);
    expect(clipBoundaries(session)).toEqual([100, 500, 900, 1000]);
  });

  it('unions across tracks and interleaves them in time, not in track order', () => {
    const session = sessionOf(
      [{ start: 1000, length: 500 }],
      [{ start: 200, length: 100 }]
    );
    expect(clipBoundaries(session)).toEqual([200, 300, 1000, 1500]);
  });

  it('de-duplicates a boundary two clips share (a butt join, or two tracks aligned)', () => {
    const session = sessionOf(
      [{ start: 0, length: 500 }, { start: 500, length: 500 }],
      [{ start: 500, length: 200 }]
    );
    expect(clipBoundaries(session)).toEqual([0, 500, 700, 1000]);
  });

  it('is empty for a session with no clips', () => {
    expect(clipBoundaries(sessionOf([], []))).toEqual([]);
  });
});

describe('nextClipEdge', () => {
  const edges = [100, 500, 900, 1000];

  it('inside a clip, prev is that clip start and next is that clip end', () => {
    // The user's exact ask: cursor at 300, inside the clip spanning [100, 500).
    expect(nextClipEdge(edges, 300, 'prev')).toBe(100);
    expect(nextClipEdge(edges, 300, 'next')).toBe(500);
  });

  it('standing ON a boundary moves to the NEXT one in that direction — never a dead keypress', () => {
    expect(nextClipEdge(edges, 500, 'prev')).toBe(100);
    expect(nextClipEdge(edges, 500, 'next')).toBe(900);
  });

  it('walks the union of edges step by step, in either direction', () => {
    expect(nextClipEdge(edges, 0, 'next')).toBe(100);
    expect(nextClipEdge(edges, 100, 'next')).toBe(500);
    expect(nextClipEdge(edges, 900, 'next')).toBe(1000);
    expect(nextClipEdge(edges, 1000, 'prev')).toBe(900);
  });

  it('returns null past the last edge and before the first — the extremes are no-ops', () => {
    expect(nextClipEdge(edges, 1000, 'next')).toBeNull();
    expect(nextClipEdge(edges, 5000, 'next')).toBeNull();
    expect(nextClipEdge(edges, 100, 'prev')).toBeNull();
    expect(nextClipEdge(edges, 0, 'prev')).toBeNull();
  });

  it('returns null for an empty edge set in both directions', () => {
    expect(nextClipEdge([], 42, 'prev')).toBeNull();
    expect(nextClipEdge([], 42, 'next')).toBeNull();
  });

  it('answers from a cursor sitting between two clips', () => {
    expect(nextClipEdge(edges, 700, 'prev')).toBe(500);
    expect(nextClipEdge(edges, 700, 'next')).toBe(900);
  });

  it('is exclusive at the cursor even for a fractional cursor between edges', () => {
    expect(nextClipEdge(edges, 499.5, 'next')).toBe(500);
    expect(nextClipEdge(edges, 500.5, 'prev')).toBe(500);
  });
});
