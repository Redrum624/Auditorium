import {
  createDocument,
  docLength,
  docDuration,
  cloneRegion,
  replaceRegion,
  deleteRegion,
  insertAt,
  coerceChannels,
  mixDown,
} from './AudioDocument';

function mono(values: number[]): Float32Array[] {
  return [Float32Array.from(values)];
}

function stereo(left: number[], right: number[]): Float32Array[] {
  return [Float32Array.from(left), Float32Array.from(right)];
}

describe('createDocument', () => {
  it('creates a document with the given fields and dirty=false', () => {
    const channels = mono([1, 2, 3]);
    const doc = createDocument({ name: 'Untitled 1', sampleRate: 44100, channels });
    expect(doc.name).toBe('Untitled 1');
    expect(doc.sampleRate).toBe(44100);
    expect(doc.channels).toHaveLength(1);
    expect(Array.from(doc.channels[0])).toEqual([1, 2, 3]);
    expect(doc.filePath).toBeNull();
    expect(doc.dirty).toBe(false);
    expect(typeof doc.id).toBe('string');
  });

  it('accepts an explicit filePath', () => {
    const doc = createDocument({ name: 'foo.wav', sampleRate: 48000, channels: mono([0]), filePath: 'C:/tmp/foo.wav' });
    expect(doc.filePath).toBe('C:/tmp/foo.wav');
  });

  it('assigns sequential distinct ids across calls', () => {
    const a = createDocument({ name: 'a', sampleRate: 44100, channels: mono([0]) });
    const b = createDocument({ name: 'b', sampleRate: 44100, channels: mono([0]) });
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^doc-\d+$/);
    expect(b.id).toMatch(/^doc-\d+$/);
    const aNum = Number(a.id.split('-')[1]);
    const bNum = Number(b.id.split('-')[1]);
    expect(bNum).toBe(aNum + 1);
  });
});

describe('neverSaved provenance (Task S4)', () => {
  it('defaults to TRUE for a document created with no file on disk (Mix Down, Remix N, recordings, New File, stems)', () => {
    const doc = createDocument({ name: 'Remix 1', sampleRate: 44100, channels: mono([1, 2, 3]) });
    expect(doc.neverSaved).toBe(true);
    // ... and it is NOT expressed as dirty: dirty is derived from the undo
    // position by undoHistory, so it cannot carry provenance (see the
    // KNOWN_LIMITATIONS entry).
    expect(doc.dirty).toBe(false);
  });

  it('defaults to FALSE for a document created with a filePath (opened from disk)', () => {
    const doc = createDocument({
      name: 'foo.wav',
      sampleRate: 44100,
      channels: mono([0]),
      filePath: 'C:/tmp/foo.wav',
    });
    expect(doc.neverSaved).toBe(false);
  });

  it('accepts an explicit neverSaved:false for path-less audio that IS on disk (an exotic source, a .audm-embedded document)', () => {
    const doc = createDocument({
      name: 'take.m4a',
      sampleRate: 44100,
      channels: mono([0]),
      filePath: null,
      neverSaved: false,
    });
    expect(doc.filePath).toBeNull();
    expect(doc.neverSaved).toBe(false);
  });

  it('survives every whole-document edit (replaceRegion/deleteRegion/insertAt) — editing does not put audio on disk', () => {
    const doc = createDocument({ name: 'Mixdown 1', sampleRate: 44100, channels: mono([1, 2, 3, 4]) });
    expect(replaceRegion(doc, 0, 1, mono([9])).neverSaved).toBe(true);
    expect(deleteRegion(doc, 0, 2).neverSaved).toBe(true);
    expect(insertAt(doc, 1, mono([7])).neverSaved).toBe(true);
    // The converse also holds: an edit never RESURRECTS the flag on a saved doc.
    const saved = createDocument({
      name: 'song.wav',
      sampleRate: 44100,
      channels: mono([1, 2, 3, 4]),
      filePath: 'C:/tmp/song.wav',
    });
    expect(deleteRegion(saved, 0, 2).neverSaved).toBe(false);
  });
});

describe('docLength / docDuration', () => {
  it('returns samples-per-channel for docLength', () => {
    const doc = createDocument({ name: 'x', sampleRate: 44100, channels: mono([1, 2, 3, 4, 5]) });
    expect(docLength(doc)).toBe(5);
  });

  it('returns 0 for a document with zero channels', () => {
    const doc = createDocument({ name: 'x', sampleRate: 44100, channels: [] });
    expect(docLength(doc)).toBe(0);
  });

  it('computes docDuration as length/sampleRate', () => {
    const doc = createDocument({ name: 'x', sampleRate: 10, channels: mono([1, 2, 3, 4, 5]) });
    expect(docDuration(doc)).toBeCloseTo(0.5);
  });
});

describe('cloneRegion', () => {
  it('returns copies of the requested range, not references', () => {
    const doc = createDocument({ name: 'x', sampleRate: 44100, channels: mono([1, 2, 3, 4, 5]) });
    const region = cloneRegion(doc, 1, 3);
    expect(region).toHaveLength(1);
    expect(Array.from(region[0])).toEqual([2, 3]);

    region[0][0] = 999;
    expect(Array.from(doc.channels[0])).toEqual([1, 2, 3, 4, 5]);
  });

  it('clamps end beyond doc length', () => {
    const doc = createDocument({ name: 'x', sampleRate: 44100, channels: mono([1, 2, 3]) });
    const region = cloneRegion(doc, 1, 100);
    expect(Array.from(region[0])).toEqual([2, 3]);
  });

  it('clamps start below 0', () => {
    const doc = createDocument({ name: 'x', sampleRate: 44100, channels: mono([1, 2, 3]) });
    const region = cloneRegion(doc, -5, 2);
    expect(Array.from(region[0])).toEqual([1, 2]);
  });

  it('throws RangeError when start > end', () => {
    const doc = createDocument({ name: 'x', sampleRate: 44100, channels: mono([1, 2, 3]) });
    expect(() => cloneRegion(doc, 2, 1)).toThrow(RangeError);
  });
});

describe('deleteRegion', () => {
  it('reduces length by (end-start) and removes the correct samples', () => {
    const doc = createDocument({ name: 'x', sampleRate: 44100, channels: mono([1, 2, 3, 4, 5]) });
    const result = deleteRegion(doc, 1, 3);
    expect(docLength(result)).toBe(docLength(doc) - (3 - 1));
    expect(Array.from(result.channels[0])).toEqual([1, 4, 5]);
  });

  it('does not mutate the original document', () => {
    const doc = createDocument({ name: 'x', sampleRate: 44100, channels: mono([1, 2, 3, 4, 5]) });
    deleteRegion(doc, 1, 3);
    expect(Array.from(doc.channels[0])).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns a new document with the same id and dirty=true', () => {
    const doc = createDocument({ name: 'x', sampleRate: 44100, channels: mono([1, 2, 3, 4, 5]) });
    const result = deleteRegion(doc, 1, 3);
    expect(result.id).toBe(doc.id);
    expect(result.dirty).toBe(true);
    expect(result).not.toBe(doc);
  });

  it('throws RangeError when start > end', () => {
    const doc = createDocument({ name: 'x', sampleRate: 44100, channels: mono([1, 2, 3]) });
    expect(() => deleteRegion(doc, 2, 1)).toThrow(RangeError);
  });
});

describe('insertAt', () => {
  it('inserts data at the given position, shifting the tail', () => {
    const doc = createDocument({ name: 'x', sampleRate: 44100, channels: mono([1, 2, 3]) });
    const result = insertAt(doc, 1, mono([9, 9]));
    expect(Array.from(result.channels[0])).toEqual([1, 9, 9, 2, 3]);
    expect(docLength(result)).toBe(docLength(doc) + 2);
  });

  it('does not mutate the original document', () => {
    const doc = createDocument({ name: 'x', sampleRate: 44100, channels: mono([1, 2, 3]) });
    insertAt(doc, 1, mono([9, 9]));
    expect(Array.from(doc.channels[0])).toEqual([1, 2, 3]);
  });
});

describe('replaceRegion', () => {
  it('replaces a region with same-length data, keeping doc length unchanged', () => {
    const doc = createDocument({ name: 'x', sampleRate: 44100, channels: mono([1, 2, 3, 4]) });
    const result = replaceRegion(doc, 1, 3, mono([8, 9]));
    expect(Array.from(result.channels[0])).toEqual([1, 8, 9, 4]);
    expect(docLength(result)).toBe(docLength(doc));
  });

  it('replaces a region with different-length data, adjusting doc length', () => {
    // length = docLength - (end-start) + data.length = 4 - 2 + 5 = 7
    const doc = createDocument({ name: 'x', sampleRate: 44100, channels: mono([1, 2, 3, 4]) });
    const result = replaceRegion(doc, 1, 3, mono([8, 9, 10, 11, 12]));
    expect(docLength(result)).toBe(7);
    expect(Array.from(result.channels[0])).toEqual([1, 8, 9, 10, 11, 12, 4]);
  });

  it('grows a length-3 doc to length 6 when replacing [1,3) with length-5 data', () => {
    // 3 - 2 + 5 = 6
    const doc = createDocument({ name: 'x', sampleRate: 44100, channels: mono([1, 2, 3]) });
    const result = replaceRegion(doc, 1, 3, mono([8, 9, 10, 11, 12]));
    expect(docLength(result)).toBe(6);
    expect(Array.from(result.channels[0])).toEqual([1, 8, 9, 10, 11, 12]);
  });

  it('does not mutate the original document', () => {
    const doc = createDocument({ name: 'x', sampleRate: 44100, channels: mono([1, 2, 3, 4]) });
    replaceRegion(doc, 1, 3, mono([8, 9, 10]));
    expect(Array.from(doc.channels[0])).toEqual([1, 2, 3, 4]);
  });

  it('clamps end beyond doc length', () => {
    const doc = createDocument({ name: 'x', sampleRate: 44100, channels: mono([1, 2, 3]) });
    const result = replaceRegion(doc, 1, 100, mono([9]));
    expect(Array.from(result.channels[0])).toEqual([1, 9]);
  });

  it('throws RangeError when start > end', () => {
    const doc = createDocument({ name: 'x', sampleRate: 44100, channels: mono([1, 2, 3]) });
    expect(() => replaceRegion(doc, 2, 1, mono([9]))).toThrow(RangeError);
  });

  it('coerces mono data into a stereo document', () => {
    const doc = createDocument({ name: 'x', sampleRate: 44100, channels: stereo([1, 2, 3, 4], [5, 6, 7, 8]) });
    const result = replaceRegion(doc, 1, 3, mono([100, 101]));
    expect(result.channels).toHaveLength(2);
    expect(Array.from(result.channels[0])).toEqual([1, 100, 101, 4]);
    expect(Array.from(result.channels[1])).toEqual([5, 100, 101, 8]);
  });
});

describe('coerceChannels', () => {
  it('duplicates a mono channel into stereo', () => {
    const result = coerceChannels(mono([1, 2, 3]), 2);
    expect(result).toHaveLength(2);
    expect(Array.from(result[0])).toEqual([1, 2, 3]);
    expect(Array.from(result[1])).toEqual([1, 2, 3]);
  });

  it('averages stereo channels into mono', () => {
    const result = coerceChannels(stereo([1, 0], [0, 1]), 1);
    expect(result).toHaveLength(1);
    expect(Array.from(result[0])).toEqual([0.5, 0.5]);
  });

  it('returns copies when the channel count already matches', () => {
    const data = mono([1, 2, 3]);
    const result = coerceChannels(data, 1);
    expect(Array.from(result[0])).toEqual([1, 2, 3]);
    result[0][0] = 999;
    expect(Array.from(data[0])).toEqual([1, 2, 3]);
  });
});

describe('mixDown', () => {
  it('averages stereo channels sample-by-sample', () => {
    const result = mixDown(stereo([1, 0], [0, 1]));
    expect(Array.from(result)).toEqual([0.5, 0.5]);
  });

  it('returns a copy for mono input', () => {
    const data = mono([1, 2, 3]);
    const result = mixDown(data);
    expect(Array.from(result)).toEqual([1, 2, 3]);
    result[0] = 999;
    expect(Array.from(data[0])).toEqual([1, 2, 3]);
  });
});
