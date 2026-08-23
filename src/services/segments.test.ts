import { cursorSegment, segmentAt } from './segments';
import { createDocument } from '../audio/AudioDocument';
import { makeInitialState, type AppState } from '../stores/appStore';

/**
 * Item 8 / M3: a segment is the span between two neighbouring boundaries,
 * where the boundaries are {0} ∪ every interior marker ∪ {length}. No new
 * marker kind: every marker counts.
 */
describe('segmentAt', () => {
  it('returns null when there is no INTERIOR boundary (the whole document is one segment)', () => {
    expect(segmentAt([], 4000, 10)).toBeNull();
  });

  it('returns the half-open span [b_i, b_{i+1}) containing the sample', () => {
    expect(segmentAt([1000], 4000, 0)).toEqual({ start: 0, end: 1000 });
    expect(segmentAt([1000], 4000, 999)).toEqual({ start: 0, end: 1000 });
    expect(segmentAt([1000], 4000, 1000)).toEqual({ start: 1000, end: 4000 });
  });

  it('sample === length resolves to the LAST span', () => {
    expect(segmentAt([1000], 4000, 4000)).toEqual({ start: 1000, end: 4000 });
  });

  it('ignores markers at 0 and at length, and duplicates', () => {
    expect(segmentAt([0, 1000, 4000, 1000], 4000, 500)).toEqual({ start: 0, end: 1000 });
  });

  it('tolerates unsorted input', () => {
    expect(segmentAt([3000, 1000], 4000, 2000)).toEqual({ start: 1000, end: 3000 });
  });

  it('clamps the sample into [0, length]', () => {
    expect(segmentAt([1000], 4000, -5)).toEqual({ start: 0, end: 1000 });
    expect(segmentAt([1000], 4000, 9999)).toEqual({ start: 1000, end: 4000 });
  });

  it('returns null for an empty document', () => {
    expect(segmentAt([10], 0, 0)).toBeNull();
  });
});

describe('cursorSegment', () => {
  function stateWith(markerPositions: number[], cursorSample: number): AppState {
    const doc = createDocument({ name: 'seg', sampleRate: 44100, channels: [new Float32Array(10)] });
    return {
      ...makeInitialState(),
      documents: [doc],
      activeDocumentId: doc.id,
      markers: {
        [doc.id]: markerPositions.map((p, i) => ({ id: `m${i}`, name: `M${i}`, positionSample: p })),
      },
      cursorSample,
    };
  }

  it('is null with no active document', () => {
    expect(cursorSegment(makeInitialState())).toBeNull();
  });

  it('reads the segment under the cursor from the state it is handed', () => {
    expect(cursorSegment(stateWith([5], 7))).toEqual({ start: 5, end: 10 });
    expect(cursorSegment(stateWith([5], 2))).toEqual({ start: 0, end: 5 });
  });

  it('is null when the only markers sit at 0 and at the document end', () => {
    expect(cursorSegment(stateWith([0, 10], 4))).toBeNull();
  });
});
