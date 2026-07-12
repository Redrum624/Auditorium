import { getPyramids, invalidatePeaks, clearAllPeaks } from './peaksCache';
import { createDocument, type AudioDocument } from '../audio/AudioDocument';

function ramp(n: number): Float32Array {
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = i / n;
  return ch;
}

function makeDoc(): AudioDocument {
  return createDocument({ name: 'x', sampleRate: 44100, channels: [ramp(2048), ramp(2048)] });
}

describe('peaksCache', () => {
  beforeEach(() => clearAllPeaks());

  it('returns the same pyramid array instance for the same doc object', () => {
    const doc = makeDoc();
    const a = getPyramids(doc);
    const b = getPyramids(doc);
    expect(b).toBe(a);
    expect(b[0]).toBe(a[0]);
    expect(b[1]).toBe(a[1]);
    expect(a.length).toBe(2);
  });

  it('rebuilds when a channel array identity changes (same doc id)', () => {
    const doc = makeDoc();
    const a = getPyramids(doc);
    // Simulate an edit: same id, new channel arrays (as mutators produce).
    const edited: AudioDocument = { ...doc, channels: [ramp(2048), doc.channels[1]] };
    const b = getPyramids(edited);
    expect(b).not.toBe(a);
    expect(b[0]).not.toBe(a[0]); // channel 0 replaced -> new pyramid
  });

  it('rebuilds after invalidatePeaks even when channel refs are unchanged', () => {
    const doc = makeDoc();
    const a = getPyramids(doc);
    invalidatePeaks(doc.id);
    const b = getPyramids(doc);
    expect(b).not.toBe(a);
  });

  it('keeps separate cache entries per doc id', () => {
    const d1 = makeDoc();
    const d2 = makeDoc();
    const p1 = getPyramids(d1);
    const p2 = getPyramids(d2);
    expect(p1).not.toBe(p2);
    expect(getPyramids(d1)).toBe(p1);
  });
});
