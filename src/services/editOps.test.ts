import {
  applyEdit,
  cutSelection,
  copySelection,
  pasteAtCursor,
  deleteSelection,
  rippleDeleteSelection,
  splitAtCursor,
  trimToSelection,
  silenceSelection,
  pushMarkerUndo,
} from './editOps';
import { getClipboard, setClipboard, clearClipboard } from './clipboard';
import { undo, redo, getHistory, markSavePoint } from './undoHistory';
import * as undoHistory from './undoHistory';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { createDocument, docLength, deleteRegion, type AudioDocument } from '../audio/AudioDocument';
import * as resampleModule from '../dsp/resample';

/** Count sign changes (zero crossings) in a signal, ignoring exact zeros. */
function countZeroCrossings(x: Float32Array, start = 0, end = x.length): number {
  let count = 0;
  let prevSign = 0;
  for (let i = start; i < end; i++) {
    const s = x[i] > 0 ? 1 : x[i] < 0 ? -1 : 0;
    if (s !== 0) {
      if (prevSign !== 0 && s !== prevSign) count++;
      prevSign = s;
    }
  }
  return count;
}

// A ramp of distinct non-zero values so we can pinpoint exactly which samples an
// op moved/removed/zeroed (index i -> value i + 1 + offset).
function ramp(n: number, offset = 0): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = i + 1 + offset;
  return a;
}

function addDoc(channels: Float32Array[]): AudioDocument {
  const doc = createDocument({ name: 'edit-test', sampleRate: 44100, channels });
  useAppStore.getState().addDocument(doc);
  return doc;
}

function activeDoc(): AudioDocument {
  const s = useAppStore.getState();
  return s.documents.find((d) => d.id === s.activeDocumentId)!;
}

function chan(i = 0): number[] {
  return Array.from(activeDoc().channels[i]);
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  clearClipboard();
});

describe('applyEdit', () => {
  it('is the single write path: updates the doc, records undo, restores identity on undo', () => {
    const doc = addDoc([ramp(10)]);
    const originalChannel = doc.channels[0];
    useAppStore.getState().setSelection({ start: 2, end: 5 });
    useAppStore.getState().setCursor(7);

    applyEdit('Delete region', doc.id, (d) => deleteRegion(d, 2, 5), {
      selection: null,
      cursorSample: 2,
    });

    expect(docLength(activeDoc())).toBe(7);
    expect(useAppStore.getState().selection).toBeNull();
    expect(useAppStore.getState().cursorSample).toBe(2);
    expect(getHistory(doc.id).done).toEqual(['Delete region']);

    undo(doc.id);
    // Identity restore: the exact pre-edit channel array reference comes back.
    expect(activeDoc().channels[0]).toBe(originalChannel);
    expect(useAppStore.getState().selection).toEqual({ start: 2, end: 5 });
    expect(useAppStore.getState().cursorSample).toBe(7);

    redo(doc.id);
    expect(docLength(activeDoc())).toBe(7);
    expect(useAppStore.getState().selection).toBeNull();
    expect(useAppStore.getState().cursorSample).toBe(2);
  });

  it('throws when the target document is not in the store', () => {
    expect(() => applyEdit('x', 'doc-missing', (d) => d)).toThrow();
  });
});

describe('applyEdit — undo entry bytes accounting (Task M9 fix round 1 + round 2 / MINOR 1)', () => {
  const SAMPLE_RATE = 44100;
  const CHANNEL_COUNT = 2;
  const DURATION_SECONDS = 600; // 10 minutes
  const LENGTH = SAMPLE_RATE * DURATION_SECONDS; // 26,460,000 samples/channel
  const DOC_BYTES = LENGTH * 4 * CHANNEL_COUNT; // 211,680,000 bytes (~201.9 MiB)

  // A mid-test assertion failure must not leak a spy into later tests in this
  // file (Task M9 fix round 2 / MINOR — was an inline `pushSpy.mockRestore()`).
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeDocOfLength(length: number): AudioDocument {
    const doc = createDocument({
      name: 'doc.wav',
      sampleRate: SAMPLE_RATE,
      channels: Array.from({ length: CHANNEL_COUNT }, () => new Float32Array(length)),
    });
    useAppStore.getState().addDocument(doc);
    return doc;
  }

  function makeBigDoc(): AudioDocument {
    return makeDocOfLength(LENGTH);
  }

  /** A same-length "edit": a fresh channel copy, exactly what every real
   * AudioDocument mutator allocates, so byte size stays constant across
   * repeated pushes (isolates the accounting from length-change effects). */
  function identityEdit(d: AudioDocument): AudioDocument {
    return { ...d, channels: d.channels.map((c) => c.slice()), dirty: true };
  }

  it('charges only the PRE-edit snapshot, not both sides (which double-counts the shared preDoc/newDoc chain)', () => {
    const doc = makeBigDoc();
    const pushSpy = jest.spyOn(undoHistory, 'pushUndo');

    applyEdit('Edit', doc.id, identityEdit);

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy.mock.calls[0][0].bytes).toBe(DOC_BYTES); // not 2 * DOC_BYTES
  });

  it('pins the retained undo depth for a 10-minute stereo 44.1 kHz document at 3, not the pre-round-1-fix 1', () => {
    const doc = makeBigDoc();

    // 4 same-length edits: 4 * DOC_BYTES (~808 MB) exceeds the 800 MB budget
    // by just over one document's worth, so exactly the oldest entry is
    // evicted, leaving 3. For CONSTANT-size edits, charging the pre-edit
    // snapshot (round 2) totals the exact same as charging the post-edit
    // snapshot (round 1) — this depth-3 result is unchanged by round 2. The
    // original pre+round-1-fix accounting (both sides) charged roughly 2x per
    // entry, which would have collapsed this same scenario to a depth of 1.
    for (let i = 0; i < 4; i++) {
      applyEdit(`Edit ${i}`, doc.id, identityEdit);
    }

    expect(getHistory(doc.id).done).toHaveLength(3);
  });

  it('a marker-undo entry (0 bytes) interspersed between two large audio edits does not itself evict an audio entry the corrected accounting should have kept', () => {
    const doc = makeBigDoc();

    applyEdit('Edit A', doc.id, identityEdit); // charges DOC_BYTES
    const before = useAppStore.getState().markers[doc.id] ?? [];
    useAppStore.getState().addMarker(doc.id, { id: 'm-1', name: 'Marker', positionSample: 0 });
    const after = useAppStore.getState().markers[doc.id];
    pushMarkerUndo('Add Marker', doc.id, before, after); // charges 0
    applyEdit('Edit B', doc.id, identityEdit); // running total: 2 * DOC_BYTES (~404 MB) <= 800 MB

    // Nothing evicted — a 0-byte marker entry sitting between two full-size
    // audio edits must not be mistaken for carrying its own doc-sized cost.
    expect(getHistory(doc.id).done).toEqual(['Edit A', 'Add Marker', 'Edit B']);
  });

  describe('size-changing edit (Trim to Selection large -> small): the regression round 1 missed (Task M9 fix round 2)', () => {
    // 40 minutes stereo 44.1 kHz: big enough that its OWN byte size alone
    // exceeds MAX_UNDO_BYTES (800 MB) — the reviewer's illustrative scenario
    // used a 60-minute (~1.27 GB) recording trimmed to 30 s; this is the same
    // shape at a lighter, still-realistic scale.
    const BIG_LENGTH = SAMPLE_RATE * 2400; // 105,840,000 samples/channel
    const BIG_BYTES = BIG_LENGTH * 4 * CHANNEL_COUNT; // 846,720,000 bytes (~807.5 MiB)

    it('sanity: the big document alone exceeds MAX_UNDO_BYTES', () => {
      expect(BIG_BYTES).toBeGreaterThan(undoHistory.MAX_UNDO_BYTES);
    });

    it('charges the large PRE-edit snapshot on a Trim-like edit, not the tiny post-edit result', () => {
      const doc = makeDocOfLength(BIG_LENGTH);
      const pushSpy = jest.spyOn(undoHistory, 'pushUndo');

      applyEdit('Trim', doc.id, (d) => ({
        ...d,
        channels: d.channels.map(() => new Float32Array(10)),
        dirty: true,
      }));

      expect(pushSpy.mock.calls[0][0].bytes).toBe(BIG_BYTES); // NOT ~80 (10 samples * 2ch * 4B)
    });

    it('evicts the Trim entry once the running total exceeds budget — RED against a newDoc charge, which would have kept it "cheap" indefinitely', () => {
      const doc = makeDocOfLength(BIG_LENGTH);

      // "Trim to Selection" down to a tiny clip: this entry's preDoc is the
      // full BIG original — that's what ACTUALLY stays pinned once it's
      // retired into undo history, since the live document becomes the tiny
      // result instead. A `docBytes(newDoc)` charge (round 1's bug) would
      // have billed this entry ~80 bytes, letting it survive up to
      // UNDO_LIMIT (50) subsequent small edits while still secretly pinning
      // the ~808 MB original — a real regression against pre-M9 behavior.
      applyEdit('Trim', doc.id, (d) => ({
        ...d,
        channels: d.channels.map(() => new Float32Array(10)),
        dirty: true,
      }));
      expect(getHistory(doc.id).done).toEqual(['Trim']); // alone: still kept (>= 1 rule)

      // Several small follow-up edits on the now-tiny document (negligible
      // bytes each). 'Trim' alone already exceeds the 800 MB budget, so it
      // must be evicted as soon as anything else is pushed on top.
      for (let i = 0; i < 3; i++) {
        applyEdit(`Small ${i}`, doc.id, (d) => ({
          ...d,
          channels: d.channels.map((c) => c.slice()),
          dirty: true,
        }));
      }

      const done = getHistory(doc.id).done;
      expect(done).not.toContain('Trim');
      expect(done).toEqual(['Small 0', 'Small 1', 'Small 2']);
    });
  });
});

describe('cutSelection', () => {
  // Item 7 (M1): Cut leaves the span EMPTY at identical length — the document
  // never ripples. What used to be `[1,2,6,7,8,9,10]` (length 7) is now the
  // same ten samples with the cut ones zeroed.
  it('with a selection: copies the region to the clipboard, zero-fills it in place, and collapses selection to the cut start', () => {
    const doc = addDoc([ramp(10)]);
    const originalChannel = doc.channels[0];
    useAppStore.getState().setSelection({ start: 2, end: 5 });

    cutSelection();

    expect(getClipboard()!.channels[0]).toEqual(new Float32Array([3, 4, 5]));
    expect(getClipboard()!.sampleRate).toBe(44100);
    expect(chan()).toEqual([1, 2, 0, 0, 0, 6, 7, 8, 9, 10]);
    expect(docLength(activeDoc())).toBe(10);
    expect(useAppStore.getState().selection).toBeNull();
    expect(useAppStore.getState().cursorSample).toBe(2);
    expect(getHistory(doc.id).done).toEqual(['Cut']);

    undo(doc.id);
    expect(activeDoc().channels[0]).toBe(originalChannel);
    expect(useAppStore.getState().selection).toEqual({ start: 2, end: 5 });
  });

  // Item 8 (M1/M3/N9): with no selection, Ctrl+X cuts the SEGMENT the cursor
  // is in — the span between the two nearest markers (0 and the document end
  // count as boundaries). Markers are never touched: the cut is equal-length.
  function setMarkers(docId: string, positions: number[]): void {
    const list = positions.map((p, i) => ({ id: `m${i}`, name: `M${i}`, positionSample: p }));
    useAppStore.getState().setMarkersForDoc(docId, list);
  }

  function markerPositions(docId: string): number[] {
    return (useAppStore.getState().markers[docId] ?? []).map((m) => m.positionSample);
  }

  it('no selection, marker at 5, cursor 7: cuts the segment [5,10)', () => {
    const doc = addDoc([ramp(10)]);
    setMarkers(doc.id, [5]);
    useAppStore.getState().setCursor(7);

    cutSelection();

    expect(getClipboard()!.channels[0].length).toBe(5);
    expect(chan()).toEqual([1, 2, 3, 4, 5, 0, 0, 0, 0, 0]);
    expect(useAppStore.getState().cursorSample).toBe(5);
    expect(markerPositions(doc.id)).toEqual([5]);
  });

  it('no selection, markers [3,6], cursor 4: cuts the segment [3,6) and leaves the markers', () => {
    const doc = addDoc([ramp(10)]);
    setMarkers(doc.id, [3, 6]);
    useAppStore.getState().setCursor(4);

    cutSelection();

    expect(getClipboard()!.channels[0]).toEqual(new Float32Array([4, 5, 6]));
    expect(chan()).toEqual([1, 2, 3, 0, 0, 0, 7, 8, 9, 10]);
    expect(markerPositions(doc.id)).toEqual([3, 6]);
    expect(useAppStore.getState().selection).toBeNull();
    expect(useAppStore.getState().cursorSample).toBe(3);
  });

  it('does nothing without a selection and without markers', () => {
    const doc = addDoc([ramp(10)]);
    useAppStore.getState().setCursor(4);
    cutSelection();
    expect(getClipboard()).toBeNull();
    expect(getHistory(doc.id).done).toEqual([]);
  });

  it('a marker inside a selection cut stays where it was', () => {
    const doc = addDoc([ramp(10)]);
    setMarkers(doc.id, [3]);
    const before = useAppStore.getState().markers[doc.id];
    useAppStore.getState().setSelection({ start: 2, end: 5 });

    cutSelection();

    expect(markerPositions(doc.id)).toEqual([3]);
    expect(useAppStore.getState().markers[doc.id]).toBe(before);
  });
});

describe('splitAtCursor', () => {
  function setMarkers(docId: string, positions: number[]): void {
    const list = positions.map((p, i) => ({ id: `m${i}`, name: `M${i}`, positionSample: p }));
    useAppStore.getState().setMarkersForDoc(docId, list);
  }

  function markers(docId: string) {
    return useAppStore.getState().markers[docId] ?? [];
  }

  it('with no selection: one marker at the cursor, named "Split N", one History entry, doc dirty; undo removes it', () => {
    const doc = addDoc([ramp(10)]);
    useAppStore.getState().setCursor(4);

    splitAtCursor();

    expect(markers(doc.id).map((m) => m.positionSample)).toEqual([4]);
    expect(markers(doc.id)[0].name).toMatch(/^Split \d+$/);
    expect(getHistory(doc.id).done).toEqual(['Split']);
    expect(activeDoc().dirty).toBe(true);
    // The cursor and the (absent) selection are not touched.
    expect(useAppStore.getState().cursorSample).toBe(4);
    expect(useAppStore.getState().selection).toBeNull();

    undo(doc.id);
    expect(markers(doc.id)).toEqual([]);
  });

  it('with a selection: a marker at each edge, in ONE History entry', () => {
    const doc = addDoc([ramp(10)]);
    useAppStore.getState().setSelection({ start: 2, end: 7 });

    splitAtCursor();

    expect(markers(doc.id).map((m) => m.positionSample)).toEqual([2, 7]);
    expect(getHistory(doc.id).done).toEqual(['Split']);
    expect(useAppStore.getState().selection).toEqual({ start: 2, end: 7 });

    undo(doc.id);
    expect(markers(doc.id)).toEqual([]);
  });

  it('adds nothing at 0, at the document end, or on an existing marker — and records no undo entry', () => {
    const doc = addDoc([ramp(10)]);

    useAppStore.getState().setCursor(0);
    splitAtCursor();
    expect(markers(doc.id)).toEqual([]);

    useAppStore.getState().setCursor(10);
    splitAtCursor();
    expect(markers(doc.id)).toEqual([]);

    setMarkers(doc.id, [4]);
    const before = markers(doc.id);
    useAppStore.getState().setCursor(4);
    splitAtCursor();
    expect(markers(doc.id)).toBe(before);

    expect(getHistory(doc.id).done).toEqual([]);
  });

  it('a whole-document selection adds nothing', () => {
    const doc = addDoc([ramp(10)]);
    useAppStore.getState().setSelection({ start: 0, end: 10 });

    splitAtCursor();

    expect(markers(doc.id)).toEqual([]);
    expect(getHistory(doc.id).done).toEqual([]);
  });

  it('a selection starting below zero splits at the RESOLVED edge only', () => {
    const doc = addDoc([ramp(10)]);
    useAppStore.getState().setSelection({ start: -5, end: 3 });

    splitAtCursor();

    expect(markers(doc.id).map((m) => m.positionSample)).toEqual([3]);
  });

  it('skips an edge that already has a marker and adds the other', () => {
    const doc = addDoc([ramp(10)]);
    setMarkers(doc.id, [2]);
    useAppStore.getState().setSelection({ start: 2, end: 7 });

    splitAtCursor();

    expect(markers(doc.id).map((m) => m.positionSample)).toEqual([2, 7]);
    expect(markers(doc.id).filter((m) => m.positionSample === 2)).toHaveLength(1);
    expect(getHistory(doc.id).done).toEqual(['Split']);
  });
});

describe('copySelection', () => {
  it('fills the clipboard and leaves the document (and its channel refs) untouched', () => {
    const doc = addDoc([ramp(10)]);
    const originalChannel = doc.channels[0];
    useAppStore.getState().setSelection({ start: 2, end: 5 });

    copySelection();

    expect(getClipboard()!.channels[0]).toEqual(new Float32Array([3, 4, 5]));
    expect(activeDoc().channels[0]).toBe(originalChannel); // no new doc
    expect(getHistory(doc.id).done).toEqual([]); // no undo entry
  });

  it('stores a defensive copy so later doc edits do not mutate the clipboard', () => {
    addDoc([ramp(10)]);
    useAppStore.getState().setSelection({ start: 0, end: 3 });
    copySelection();
    const clip = getClipboard()!.channels[0];
    // Mutating the live doc channel must not bleed into the clipboard copy.
    activeDoc().channels[0][0] = 999;
    expect(clip[0]).toBe(1);
  });
});

describe('pasteAtCursor', () => {
  it('inserts clipboard data at the cursor when there is no selection', () => {
    const doc = addDoc([ramp(10)]);
    setClipboard({ channels: [new Float32Array([100, 200])], sampleRate: 44100 });
    useAppStore.getState().setCursor(3);

    pasteAtCursor();

    expect(chan()).toEqual([1, 2, 3, 100, 200, 4, 5, 6, 7, 8, 9, 10]);
    expect(useAppStore.getState().cursorSample).toBe(5); // 3 + 2
    expect(useAppStore.getState().selection).toBeNull();
    expect(getHistory(doc.id).done).toEqual(['Paste']);
  });

  it('replaces the selection when one is present', () => {
    addDoc([ramp(10)]);
    setClipboard({ channels: [new Float32Array([100, 200])], sampleRate: 44100 });
    useAppStore.getState().setSelection({ start: 2, end: 5 });

    pasteAtCursor();

    expect(chan()).toEqual([1, 2, 100, 200, 6, 7, 8, 9, 10]);
    expect(useAppStore.getState().cursorSample).toBe(4); // start(2) + 2
    expect(useAppStore.getState().selection).toBeNull();
  });

  it('does nothing when the clipboard is empty', () => {
    const doc = addDoc([ramp(10)]);
    useAppStore.getState().setCursor(3);
    pasteAtCursor();
    expect(chan()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(getHistory(doc.id).done).toEqual([]);
  });

  it('does not resample when clipboard and document sample rates match', () => {
    const doc = addDoc([ramp(10)]);
    const spy = jest.spyOn(resampleModule, 'resampleChannel');
    setClipboard({ channels: [new Float32Array([100, 200])], sampleRate: 44100 });
    useAppStore.getState().setCursor(3);

    pasteAtCursor();

    expect(spy).not.toHaveBeenCalled();
    expect(chan()).toEqual([1, 2, 3, 100, 200, 4, 5, 6, 7, 8, 9, 10]);
    expect(useAppStore.getState().cursorSample).toBe(5);
    expect(getHistory(doc.id).done).toEqual(['Paste']);
    spy.mockRestore();
  });

  it('resamples the clipboard to the document rate on a rate mismatch, preserving pitch', () => {
    const doc = addDoc([new Float32Array(1000)]); // silence, mono, 44100 Hz doc
    const clipRate = 22050;
    const clipLen = Math.round(clipRate * 0.1); // 0.1s @ 22050 = 2205 samples
    const clipData = new Float32Array(clipLen);
    for (let i = 0; i < clipLen; i++) {
      clipData[i] = Math.sin((2 * Math.PI * 440 * i) / clipRate);
    }
    const spy = jest.spyOn(resampleModule, 'resampleChannel');
    setClipboard({ channels: [clipData], sampleRate: clipRate });
    useAppStore.getState().setCursor(0);

    pasteAtCursor();

    expect(spy).toHaveBeenCalledWith(clipData, clipRate, doc.sampleRate);

    const insertedLength = docLength(activeDoc()) - 1000;
    const expectedLength = Math.round(clipLen * (doc.sampleRate / clipRate));
    expect(Math.abs(insertedLength - expectedLength)).toBeLessThanOrEqual(1);
    expect(useAppStore.getState().cursorSample).toBe(insertedLength);

    // Zero-crossing rate over an interior window (margin excludes kernel edge taper).
    const inserted = activeDoc().channels[0];
    const margin = 200;
    const windowStart = margin;
    const windowEnd = insertedLength - margin;
    const crossings = countZeroCrossings(inserted, windowStart, windowEnd);
    const windowDuration = (windowEnd - windowStart) / doc.sampleRate;
    const estimatedFreq = crossings / (2 * windowDuration);
    expect(Math.abs(estimatedFreq - 440) / 440).toBeLessThan(0.05);

    spy.mockRestore();
  });

  it('undo restores the pre-paste document exactly after a resampled paste', () => {
    const doc = addDoc([ramp(10)]);
    const originalChannel = doc.channels[0];
    setClipboard({ channels: [new Float32Array([0.1, 0.2, 0.3])], sampleRate: 22050 });
    useAppStore.getState().setCursor(3);

    pasteAtCursor();
    expect(activeDoc().channels[0]).not.toBe(originalChannel);

    undo(doc.id);
    expect(activeDoc().channels[0]).toBe(originalChannel);
    expect(docLength(activeDoc())).toBe(10);
    expect(chan()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('deleteSelection', () => {
  // Item 7 (N6): Delete zero-fills the span in place — the length never
  // changes — and collapses the selection to a cursor at the span's start.
  // The clipboard is not touched (that is what separates it from Cut).
  it('zero-fills the span in place', () => {
    const doc = addDoc([ramp(10), ramp(10, 10)]);
    const originalChannel = doc.channels[0];
    useAppStore.getState().setSelection({ start: 2, end: 5 });

    deleteSelection();

    expect(chan(0)).toEqual([1, 2, 0, 0, 0, 6, 7, 8, 9, 10]);
    expect(chan(1)).toEqual([11, 12, 0, 0, 0, 16, 17, 18, 19, 20]);
    expect(docLength(activeDoc())).toBe(10);
    expect(getClipboard()).toBeNull();
    expect(useAppStore.getState().selection).toBeNull();
    expect(useAppStore.getState().cursorSample).toBe(2);
    expect(getHistory(doc.id).done).toEqual(['Delete']);

    undo(doc.id);
    expect(activeDoc().channels[0]).toBe(originalChannel);
    expect(useAppStore.getState().selection).toEqual({ start: 2, end: 5 });

    redo(doc.id);
    expect(chan(0)).toEqual([1, 2, 0, 0, 0, 6, 7, 8, 9, 10]);
  });
});

describe('rippleDeleteSelection', () => {
  // N8: the pre-item-7 Delete, verbatim, behind Shift+Del — the ONLY editor
  // verb besides Trim that shortens the document.
  it('removes the selection like the old Delete did, leaves the clipboard alone, labelled Ripple Delete', () => {
    const doc = addDoc([ramp(10)]);
    const originalChannel = doc.channels[0];
    useAppStore.getState().setSelection({ start: 2, end: 5 });

    rippleDeleteSelection();

    expect(chan()).toEqual([1, 2, 6, 7, 8, 9, 10]);
    expect(getClipboard()).toBeNull();
    expect(useAppStore.getState().selection).toBeNull();
    expect(useAppStore.getState().cursorSample).toBe(2);
    expect(getHistory(doc.id).done).toEqual(['Ripple Delete']);

    undo(doc.id);
    expect(activeDoc().channels[0]).toBe(originalChannel);
  });
});

describe('trimToSelection', () => {
  it('keeps only the selected region, resets cursor to 0 and clears selection', () => {
    const doc = addDoc([ramp(10)]);
    const originalChannel = doc.channels[0];
    useAppStore.getState().setSelection({ start: 2, end: 5 });

    trimToSelection();

    expect(chan()).toEqual([3, 4, 5]);
    expect(docLength(activeDoc())).toBe(3);
    expect(useAppStore.getState().cursorSample).toBe(0);
    expect(useAppStore.getState().selection).toBeNull();

    undo(doc.id);
    expect(activeDoc().channels[0]).toBe(originalChannel);
  });
});

describe('pushMarkerUndo (Task M2 / F5)', () => {
  it('records an undo entry whose undo/redo restore the captured marker snapshots via setMarkersForDoc', () => {
    const doc = addDoc([ramp(5)]);
    useAppStore.getState().setMarkersForDoc(doc.id, [{ id: 'm1', name: 'A', positionSample: 1 }]);
    const before = useAppStore.getState().markers[doc.id];
    const after = [...before, { id: 'm2', name: 'B', positionSample: 2 }];
    useAppStore.getState().setMarkersForDoc(doc.id, after);

    pushMarkerUndo('Add Marker', doc.id, before, after);
    expect(getHistory(doc.id).done).toEqual(['Add Marker']);

    undo(doc.id);
    expect(useAppStore.getState().markers[doc.id]).toEqual(before);

    redo(doc.id);
    expect(useAppStore.getState().markers[doc.id]).toEqual(after);
  });

  it('dirties the document, so a bulk marker write that never went through addMarker still prompts on close', () => {
    // The `setMarkersForDoc` + `pushMarkerUndo` shape every bulk marker writer
    // uses (`suggestSyllableMarkers`, `addBeatMarkers`, `Align Markers`,
    // `Remix Markers`). `setMarkersForDoc` deliberately does not dirty — the
    // load paths use it too — and `pushUndo` only advances the counter, so
    // before this fix the doc stayed CLEAN with changed markers. Markers are
    // persisted by save (cue chunks / chapters / tags), and `hasUnsavedWork`
    // is `dirty || neverSaved`, so a file opened from disk closed silently and
    // took the markers with it.
    const doc = addDoc([ramp(5)]);
    expect(useAppStore.getState().documents[0].dirty).toBe(false);

    const before = useAppStore.getState().markers[doc.id] ?? [];
    const after = [{ id: 'm1', name: 'Syllable 1', positionSample: 2 }];
    useAppStore.getState().setMarkersForDoc(doc.id, after);
    expect(useAppStore.getState().documents[0].dirty).toBe(false); // the write itself never dirties

    pushMarkerUndo('Suggest Syllable Markers', doc.id, before, after);
    expect(useAppStore.getState().documents[0].dirty).toBe(true);
  });

  it('leaves the derived dirty flag in charge: undo back to the save point reports clean', () => {
    const doc = addDoc([ramp(5)]);
    const before = useAppStore.getState().markers[doc.id] ?? [];
    const after = [{ id: 'm1', name: 'A', positionSample: 1 }];
    useAppStore.getState().setMarkersForDoc(doc.id, after);
    pushMarkerUndo('Add Marker', doc.id, before, after);
    expect(useAppStore.getState().documents[0].dirty).toBe(true);

    // The dirty stamped at push time is the same value `position !== savePoint`
    // derives, so undoing back to the save point still clears it.
    undo(doc.id);
    expect(useAppStore.getState().documents[0].dirty).toBe(false);
  });
});

describe('save-point-derived dirty (Task M2 / F9)', () => {
  it('undo after a save leaves the doc dirty; redo returns to clean exactly at the save point', () => {
    const doc = addDoc([ramp(10)]);
    expect(doc.dirty).toBe(false);

    applyEdit('Delete', doc.id, (d) => deleteRegion(d, 0, 2)); // length 10 -> 8
    expect(useAppStore.getState().documents[0].dirty).toBe(true);

    // Simulate what fileService does on a successful save: mark the save
    // point and clear dirty directly (the same two things it does together).
    markSavePoint(doc.id);
    useAppStore.getState().updateDocument({ ...useAppStore.getState().documents[0], dirty: false });

    undo(doc.id);
    expect(useAppStore.getState().documents[0].dirty).toBe(true); // waveform now differs from disk
    expect(docLength(useAppStore.getState().documents[0])).toBe(10);

    redo(doc.id);
    expect(useAppStore.getState().documents[0].dirty).toBe(false); // back at the save point, clean
    expect(docLength(useAppStore.getState().documents[0])).toBe(8);
  });

  it('edit -> undo -> new edit -> save -> undo lands on a pre-edit state that is not the save point: dirty', () => {
    const doc = addDoc([ramp(10)]);

    applyEdit('Delete1', doc.id, (d) => deleteRegion(d, 0, 1)); // length 9
    undo(doc.id); // back to the pristine length-10 doc
    expect(docLength(useAppStore.getState().documents[0])).toBe(10);
    expect(useAppStore.getState().documents[0].dirty).toBe(false);

    applyEdit('Delete2', doc.id, (d) => deleteRegion(d, 0, 2)); // length 8; truncates Delete1's redo
    markSavePoint(doc.id);
    useAppStore.getState().updateDocument({ ...useAppStore.getState().documents[0], dirty: false });

    undo(doc.id); // back to the pre-Delete2 (pristine) state, which is NOT the save point
    expect(docLength(useAppStore.getState().documents[0])).toBe(10);
    expect(useAppStore.getState().documents[0].dirty).toBe(true);
  });
});

describe('marker remap on destructive edits (Task M3 / F4)', () => {
  function setMarkers(docId: string, positions: number[]): void {
    const list = positions.map((p, i) => ({ id: `m${i}`, name: `M${i}`, positionSample: p }));
    useAppStore.getState().setMarkersForDoc(docId, list);
  }

  function markerPositions(docId: string): number[] {
    return (useAppStore.getState().markers[docId] ?? []).map((m) => m.positionSample);
  }

  it('delete [s,e): before keep, inside [s,e) drop, at/after e shift left by (e-s)', () => {
    const doc = addDoc([ramp(10)]);
    setMarkers(doc.id, [0, 1, 2, 4, 5, 8]);
    const before = useAppStore.getState().markers[doc.id];
    useAppStore.getState().setSelection({ start: 2, end: 5 });

    rippleDeleteSelection(); // item 7: the 'delete' remap now rides the ripple verb

    // 0,1 kept as-is; 2,4 dropped (inside [2,5)); 5->2 and 8->5 (>= e shift by -3).
    expect(markerPositions(doc.id)).toEqual([0, 1, 2, 5]);

    undo(doc.id);
    expect(useAppStore.getState().markers[doc.id]).toEqual(before);

    redo(doc.id);
    expect(markerPositions(doc.id)).toEqual([0, 1, 2, 5]);
  });

  it('insert at p, length L: markers >= p shift right by L', () => {
    const doc = addDoc([ramp(10)]);
    setMarkers(doc.id, [0, 2, 3, 7]);
    const before = useAppStore.getState().markers[doc.id];
    setClipboard({ channels: [new Float32Array([100, 200])], sampleRate: 44100 }); // L=2
    useAppStore.getState().setCursor(3);

    pasteAtCursor();

    // 0,2 < p(3) kept; 3,7 >= p shift by +2.
    expect(markerPositions(doc.id)).toEqual([0, 2, 5, 9]);

    undo(doc.id);
    expect(useAppStore.getState().markers[doc.id]).toEqual(before);

    redo(doc.id);
    expect(markerPositions(doc.id)).toEqual([0, 2, 5, 9]);
  });

  it('replace [s,e) with length L: before keep, inside drop, at/after e shift by L-(e-s)', () => {
    const doc = addDoc([ramp(10)]);
    setMarkers(doc.id, [0, 1, 2, 4, 5, 8]);
    const before = useAppStore.getState().markers[doc.id];
    setClipboard({ channels: [new Float32Array([100, 200])], sampleRate: 44100 }); // L=2
    useAppStore.getState().setSelection({ start: 2, end: 5 }); // e-s=3, shift = 2-3=-1

    pasteAtCursor();

    expect(markerPositions(doc.id)).toEqual([0, 1, 4, 7]);

    undo(doc.id);
    expect(useAppStore.getState().markers[doc.id]).toEqual(before);
  });

  it('replace [s,e) with length L === e-s (net-zero shift): before keep, inside STILL drops, after unaffected', () => {
    const doc = addDoc([ramp(10)]);
    setMarkers(doc.id, [0, 1, 3, 5, 8]);
    const before = useAppStore.getState().markers[doc.id];
    setClipboard({ channels: [new Float32Array([100, 200, 300])], sampleRate: 44100 }); // L=3
    useAppStore.getState().setSelection({ start: 2, end: 5 }); // e-s=3 === L: shift is 0

    pasteAtCursor();

    // 0,1 kept; 3 dropped (inside [2,5) even though the shift would be zero);
    // 5,8 shift by L-(e-s)=0, i.e. unchanged.
    expect(markerPositions(doc.id)).toEqual([0, 1, 5, 8]);

    undo(doc.id);
    expect(useAppStore.getState().markers[doc.id]).toEqual(before);
  });

  it('paste with a clipboard sample-rate mismatch shifts markers by the RESAMPLED length, not the original clip length', () => {
    const doc = addDoc([new Float32Array(1000)]); // 44100 Hz doc
    setMarkers(doc.id, [3]); // sits before the cursor
    const clipRate = 22050;
    const clipLen = Math.round(clipRate * 0.1); // 0.1s @ 22050 = 2205 samples
    setClipboard({ channels: [new Float32Array(clipLen)], sampleRate: clipRate });
    useAppStore.getState().setCursor(3); // marker sits exactly at p: shifts too ('>= p')

    pasteAtCursor();

    const insertedLength = docLength(activeDoc()) - 1000;
    // Sanity: the resample really changed the length (upsampled to the 44100 doc rate).
    expect(insertedLength).not.toBe(clipLen);
    expect(markerPositions(doc.id)).toEqual([3 + insertedLength]);
  });

  it('trim to [s,e] (END-INCLUSIVE): outside drops, inside (incl. a marker at exactly e) shifts left by s', () => {
    const doc = addDoc([ramp(10)]);
    setMarkers(doc.id, [0, 2, 3, 4, 5, 8]);
    const before = useAppStore.getState().markers[doc.id];
    useAppStore.getState().setSelection({ start: 2, end: 5 });

    trimToSelection();

    // 0 dropped (<s); 2,3,4,5 kept shifted by -2 -> 0,1,2,3 (5===e survives per the
    // amended end-inclusive rule); 8 dropped (>e).
    expect(markerPositions(doc.id)).toEqual([0, 1, 2, 3]);

    undo(doc.id);
    expect(useAppStore.getState().markers[doc.id]).toEqual(before);

    redo(doc.id);
    expect(markerPositions(doc.id)).toEqual([0, 1, 2, 3]);
  });

  it('trim: a marker sitting exactly at e survives, landing at exactly the new length', () => {
    const doc = addDoc([ramp(10)]);
    setMarkers(doc.id, [5]);
    useAppStore.getState().setSelection({ start: 2, end: 5 }); // newLength = 5-2 = 3

    trimToSelection();

    expect(markerPositions(doc.id)).toEqual([3]); // 5 - 2 = 3 = newLength exactly
  });

  it('select-all trim (selection spans the whole document) is a marker no-op', () => {
    const doc = addDoc([ramp(10)]);
    setMarkers(doc.id, [0, 5, 10]); // includes an edge marker at exactly docLength
    useAppStore.getState().setSelection({ start: 0, end: docLength(doc) });

    trimToSelection();

    // Trimming to the whole document changes nothing: start=0 (no shift) and
    // every marker (even the one at docLength, the inclusive end) survives.
    expect(markerPositions(doc.id)).toEqual([0, 5, 10]);
  });

  it('does not touch the markers store entry for a marker-less doc (no churn, Minor 1)', () => {
    const doc = addDoc([ramp(10)]);
    expect(useAppStore.getState().markers[doc.id]).toBeUndefined();
    useAppStore.getState().setSelection({ start: 2, end: 5 });

    deleteSelection(); // item 7: equal-length and remap-less, so this must still hold

    expect(useAppStore.getState().markers[doc.id]).toBeUndefined();

    undo(doc.id);
    expect(useAppStore.getState().markers[doc.id]).toBeUndefined();

    redo(doc.id);
    expect(useAppStore.getState().markers[doc.id]).toBeUndefined();
  });

  it('clamps a marker sitting exactly at the old docLength so it lands exactly at newLength, never beyond', () => {
    const doc = addDoc([ramp(10)]);
    setMarkers(doc.id, [10]); // edge marker at docLength (e.g. from a clamped-on-read import)
    useAppStore.getState().setSelection({ start: 2, end: 5 }); // delete 3 samples -> newLength 7

    rippleDeleteSelection();

    expect(markerPositions(doc.id)).toEqual([7]); // 10 - 3 = 7 = newLength exactly
  });

  it('equal-length transforms (silence) leave markers completely untouched', () => {
    const doc = addDoc([ramp(10)]);
    setMarkers(doc.id, [1, 4, 8]);
    const before = useAppStore.getState().markers[doc.id];
    useAppStore.getState().setSelection({ start: 2, end: 5 });

    silenceSelection();

    expect(useAppStore.getState().markers[doc.id]).toEqual(before);

    undo(doc.id);
    expect(useAppStore.getState().markers[doc.id]).toEqual(before);
  });

  it('stretch [s,e) to length L (Task M3 fix round 2): before keeps, inside maps proportionally, at/after e shifts', () => {
    const doc = addDoc([ramp(10)]);
    // start=2, end=6 (regionLen=4), length=8 (ratio=2).
    setMarkers(doc.id, [1, 2, 5, 6, 9]);
    const before = useAppStore.getState().markers[doc.id];

    applyEdit(
      'Stretch',
      doc.id,
      (d) => ({ ...d, channels: d.channels.map(() => new Float32Array(14)) }), // 10-4+8=14
      undefined,
      { type: 'stretch', start: 2, end: 6, length: 8 }
    );

    // 1 < start(2): kept as-is.
    // 2 === start: maps to exactly `start` (2 + round(0*2) = 2).
    // 5 === end-1: maps INSIDE the stretched region (2 + round((5-2)*2) = 8).
    // 6 === end: shifts by L-(e-s)=8-4=4 -> 10.
    // 9 > end: shifts by 4 -> 13.
    expect(markerPositions(doc.id)).toEqual([1, 2, 8, 10, 13]);

    undo(doc.id);
    expect(useAppStore.getState().markers[doc.id]).toEqual(before);

    redo(doc.id);
    expect(markerPositions(doc.id)).toEqual([1, 2, 8, 10, 13]);
  });

  it('cuts (F2): before the first cut keeps, inside a cut SNAPS to the join (never drops), at/after the end shifts by the removal', () => {
    const doc = addDoc([ramp(100)]);
    // Boundary probes per operand role on cut [10, 50): 9 = start-1 (keep),
    // 10 = start (first removed sample: snap), 49 = end-1 (snap), 50 = end
    // (shift — input[50] lands exactly at the seam too), 95 well after.
    setMarkers(doc.id, [9, 10, 49, 50, 95]);
    const before = useAppStore.getState().markers[doc.id];

    applyEdit(
      'Remove Silence',
      doc.id,
      (d) => ({ ...d, channels: d.channels.map(() => new Float32Array(60)) }), // 100 - 40
      undefined,
      { type: 'cuts', cuts: [{ start: 10, end: 50 }] }
    );

    // A marker inside the cut is a cue in the removed pause: it SURVIVES at
    // the join (10), unlike 'delete' which drops it — the ruling-3 decision.
    expect(markerPositions(doc.id)).toEqual([9, 10, 10, 10, 55]);

    undo(doc.id);
    expect(useAppStore.getState().markers[doc.id]).toEqual(before);

    redo(doc.id);
    expect(markerPositions(doc.id)).toEqual([9, 10, 10, 10, 55]);
  });

  it('cuts: a second cut repeats every boundary on its own object, and removals accumulate', () => {
    const doc = addDoc([ramp(100)]);
    // cuts [10,20) and [40,70): 15 inside cut 1 -> its join 10; 25 between
    // cuts -> shifts by cut 1 only (15); 39/40/69/70 probe cut 2's start and
    // end boundaries with 10 already removed before it; 95 after everything.
    setMarkers(doc.id, [15, 25, 39, 40, 69, 70, 95]);

    applyEdit(
      'Remove Silence',
      doc.id,
      (d) => ({ ...d, channels: d.channels.map(() => new Float32Array(60)) }), // 100 - 10 - 30
      undefined,
      { type: 'cuts', cuts: [{ start: 10, end: 20 }, { start: 40, end: 70 }] }
    );

    expect(markerPositions(doc.id)).toEqual([10, 15, 29, 30, 30, 30, 55]);
  });

  it('cuts: an empty cut list is a marker no-op', () => {
    const doc = addDoc([ramp(10)]);
    setMarkers(doc.id, [2, 7]);
    const before = useAppStore.getState().markers[doc.id];

    applyEdit(
      'Remove Silence',
      doc.id,
      (d) => ({ ...d, channels: d.channels.map((c) => Float32Array.from(c)) }),
      undefined,
      { type: 'cuts', cuts: [] }
    );

    expect(useAppStore.getState().markers[doc.id]).toEqual(before);
  });

  it('Delete is equal-length: markers inside and after the span stay (item 7 / N6)', () => {
    const doc = addDoc([ramp(10)]);
    setMarkers(doc.id, [1, 4, 8]);
    const before = useAppStore.getState().markers[doc.id];
    useAppStore.getState().setSelection({ start: 2, end: 5 });

    deleteSelection();

    expect(markerPositions(doc.id)).toEqual([1, 4, 8]);
    // No remap, no marker snapshot, no store write: the SAME array reference.
    expect(useAppStore.getState().markers[doc.id]).toBe(before);

    undo(doc.id);
    expect(useAppStore.getState().markers[doc.id]).toBe(before);
    redo(doc.id);
    expect(useAppStore.getState().markers[doc.id]).toBe(before);
  });

  it('a delete that drops ALL markers still writes the empty list (and undo restores it) — pins the OR guard, not AND (Minor 1 pin)', () => {
    const doc = addDoc([ramp(10)]);
    setMarkers(doc.id, [2, 3, 4]); // all inside the region about to be deleted
    const before = useAppStore.getState().markers[doc.id];
    useAppStore.getState().setSelection({ start: 0, end: 10 }); // whole doc: every marker drops

    rippleDeleteSelection();

    // pre non-empty, post empty: the guard (currentMarkers.length>0 || remapped.length>0)
    // must still fire on the `currentMarkers` side alone, so the empty result is
    // actually written (not skipped, which would break the undo below).
    expect(useAppStore.getState().markers[doc.id]).toEqual([]);

    undo(doc.id);
    expect(useAppStore.getState().markers[doc.id]).toEqual(before);
  });
});

describe("marker remap 'compose' (F7 Vocal Chain)", () => {
  function setMarkers(docId: string, positions: number[]): void {
    useAppStore
      .getState()
      .setMarkersForDoc(
        docId,
        positions.map((p, i) => ({ id: `c${i}`, name: `C${i}`, positionSample: p }))
      );
  }
  function markerPositions(docId: string): number[] {
    return (useAppStore.getState().markers[docId] ?? []).map((m) => m.positionSample);
  }

  it('an EMPTY step list is the identity — a chain of equal-length stages moves nothing', () => {
    const doc = addDoc([ramp(10)]);
    setMarkers(doc.id, [0, 3, 7, 9]);
    applyEdit('noop', doc.id, (d) => d, undefined, { type: 'compose', steps: [] });
    expect(markerPositions(doc.id)).toEqual([0, 3, 7, 9]);
  });

  it('a single step behaves exactly as that step alone would', () => {
    const a = addDoc([ramp(10)]);
    setMarkers(a.id, [0, 2, 6, 9]);
    applyEdit('alone', a.id, (d) => d, undefined, { type: 'insert', start: 4, length: 3 });
    const direct = markerPositions(a.id);

    const b = addDoc([ramp(10)]);
    setMarkers(b.id, [0, 2, 6, 9]);
    applyEdit('composed', b.id, (d) => d, undefined, {
      type: 'compose',
      steps: [{ type: 'insert', start: 4, length: 3 }],
    });
    expect(markerPositions(b.id)).toEqual(direct);
  });

  it('applies the steps LEFT TO RIGHT, each in the coordinates the previous produced', () => {
    const doc = addDoc([ramp(20)]);
    setMarkers(doc.id, [12]);
    // Cut [2,6) moves 12 -> 8; then inserting 5 at 7 (post-cut coords) moves 8 -> 13.
    applyEdit('chain', doc.id, (d) => d, undefined, {
      type: 'compose',
      steps: [
        { type: 'cuts', cuts: [{ start: 2, end: 6 }] },
        { type: 'insert', start: 7, length: 5 },
      ],
    });
    expect(markerPositions(doc.id)).toEqual([13]);
  });

  it('is ORDER-DEPENDENT — swapping the steps gives a different answer, so order is really honoured', () => {
    const doc = addDoc([ramp(20)]);
    setMarkers(doc.id, [12]);
    // Insert first (12 -> 17), then cut [2,6) (17 -> 13)... same here, so use a
    // step pair whose composition genuinely differs: an insert INSIDE the cut.
    applyEdit('swapped', doc.id, (d) => d, undefined, {
      type: 'compose',
      steps: [
        { type: 'insert', start: 3, length: 5 },
        { type: 'cuts', cuts: [{ start: 2, end: 6 }] },
      ],
    });
    // 12 -> 17 (insert before it) -> 13 (cut of 4 before it).
    expect(markerPositions(doc.id)).toEqual([13]);

    const other = addDoc([ramp(20)]);
    setMarkers(other.id, [4]);
    applyEdit('a', other.id, (d) => d, undefined, {
      type: 'compose',
      steps: [
        { type: 'insert', start: 3, length: 5 },
        { type: 'cuts', cuts: [{ start: 2, end: 6 }] },
      ],
    });
    // 4 -> 9 (after the insert point) -> 5.
    expect(markerPositions(other.id)).toEqual([5]);

    const reversed = addDoc([ramp(20)]);
    setMarkers(reversed.id, [4]);
    applyEdit('b', reversed.id, (d) => d, undefined, {
      type: 'compose',
      steps: [
        { type: 'cuts', cuts: [{ start: 2, end: 6 }] },
        { type: 'insert', start: 3, length: 5 },
      ],
    });
    // 4 -> 2 (inside the cut, snaps to the join) -> 2 (before the insert point).
    expect(markerPositions(reversed.id)).toEqual([2]);
  });

  it('a drop in ANY step is final — a later step cannot resurrect the marker', () => {
    const doc = addDoc([ramp(20)]);
    setMarkers(doc.id, [3, 12]);
    applyEdit('drop', doc.id, (d) => d, undefined, {
      type: 'compose',
      steps: [
        { type: 'delete', start: 2, end: 6 },
        { type: 'insert', start: 0, length: 4 },
      ],
    });
    // 3 was inside the delete and is gone; 12 -> 8 -> 12.
    expect(markerPositions(doc.id)).toEqual([12]);
  });

  it('runs every step, not just the first', () => {
    const doc = addDoc([ramp(30)]);
    setMarkers(doc.id, [20]);
    applyEdit('three', doc.id, (d) => d, undefined, {
      type: 'compose',
      steps: [
        { type: 'insert', start: 0, length: 1 },
        { type: 'insert', start: 0, length: 2 },
        { type: 'insert', start: 0, length: 4 },
      ],
    });
    // Only the first step -> 21; only the first two -> 23; all three -> 27.
    expect(markerPositions(doc.id)).toEqual([27]);
  });
});

/**
 * The clamp family's EIGHTH member (W1-1). Every operation below pairs a
 * mutator that clamps into `[0, docLength]` internally with consumers that do
 * not — the marker remap, the post-edit cursor, and Silence's zeros allocation.
 * The fixtures are the review's verified reproductions, on a 4000-sample
 * document, and each one is sized so that BOTH the resolved answer and the
 * raw-selection answer are non-zero, in range, and different: a fixture whose
 * wrong answer collapses onto 0 (or onto the document end) cannot tell a fixed
 * clamp from a floor that happens to catch it.
 */
describe('out-of-bounds selections resolve ONCE (clamp family, fifth application)', () => {
  const LEN = 4000;

  function setMarkers(docId: string, positions: number[]): void {
    const list = positions.map((p, i) => ({ id: `m${i}`, name: `M${i}`, positionSample: p }));
    useAppStore.getState().setMarkersForDoc(docId, list);
  }

  function markerPositions(docId: string): number[] {
    return (useAppStore.getState().markers[docId] ?? []).map((m) => m.positionSample);
  }

  it('Silence with an end past the document leaves the length unchanged (it grew 4000 -> 9000)', () => {
    const doc = addDoc([ramp(LEN)]);
    useAppStore.getState().setSelection({ start: 2000, end: 9000 });

    silenceSelection();

    // The zeros allocation used to be `end - start` = 7000 while `replaceRegion`
    // removed only the 2000 samples that exist: 4000 - 2000 + 7000 = 9000.
    expect(docLength(activeDoc())).toBe(LEN);
    const out = activeDoc().channels[0];
    expect(out[1999]).toBe(2000); // outside the region, untouched
    expect(out[2000]).toBe(0);
    expect(out[LEN - 1]).toBe(0); // zeroed to the true end of the document
  });

  it('Cut with a start below zero keeps the length and places the cursor from the resolved start', () => {
    const doc = addDoc([ramp(LEN)]);
    setMarkers(doc.id, [500]);
    useAppStore.getState().setSelection({ start: -5000, end: 100 });

    cutSelection();

    // Item 7: the audio zeroes [0,100) in place — nothing moves, so the marker
    // at 500 stays at 500; the cursor and the clipboard still read the RESOLVED
    // region, not the raw pair.
    expect(docLength(activeDoc())).toBe(LEN);
    expect(markerPositions(doc.id)).toEqual([500]);
    expect(useAppStore.getState().cursorSample).toBe(0); // not -5000
    expect(getClipboard()!.channels[0].length).toBe(100);
    const out = activeDoc().channels[0];
    for (let i = 0; i < 100; i++) expect(out[i]).toBe(0);
    expect(out[100]).toBe(101);
  });

  it('Delete with a start below zero keeps the length', () => {
    const doc = addDoc([ramp(LEN)]);
    setMarkers(doc.id, [1000]);
    useAppStore.getState().setSelection({ start: -100, end: 200 });

    deleteSelection();

    // Item 7: zeroes [0,200) in place; the marker at 1000 does not move.
    expect(docLength(activeDoc())).toBe(LEN);
    const out = activeDoc().channels[0];
    for (let i = 0; i < 200; i++) expect(out[i]).toBe(0);
    expect(out[200]).toBe(201);
    expect(markerPositions(doc.id)).toEqual([1000]);
    expect(useAppStore.getState().cursorSample).toBe(0); // not -100
  });

  it('Delete with an end past the document keeps the length', () => {
    const doc = addDoc([ramp(LEN)]);
    setMarkers(doc.id, [500]);
    useAppStore.getState().setSelection({ start: 1000, end: 9000 });

    deleteSelection();

    // The mirror of the Silence case above: the zeros allocation must be sized
    // by the RESOLVED region, or the document would grow 4000 -> 12000.
    expect(docLength(activeDoc())).toBe(LEN);
    const out = activeDoc().channels[0];
    expect(out[999]).toBe(1000);
    expect(out[1000]).toBe(0);
    expect(out[LEN - 1]).toBe(0);
    expect(markerPositions(doc.id)).toEqual([500]);
    expect(useAppStore.getState().cursorSample).toBe(1000);
  });

  it('Trim with a start below zero shifts markers by the kept region start, not by the raw one', () => {
    const doc = addDoc([ramp(LEN)]);
    setMarkers(doc.id, [500]);
    useAppStore.getState().setSelection({ start: -1000, end: 3000 });

    trimToSelection();

    // Keeps [0,3000): the marker at 500 stays at 500. The raw 'trim' start of
    // -1000 shifted it right by 1000 instead.
    expect(docLength(activeDoc())).toBe(3000);
    expect(markerPositions(doc.id)).toEqual([500]);
  });

  it('Paste over a selection starting below zero remaps and places the cursor from the resolved start', () => {
    const doc = addDoc([ramp(LEN)]);
    setMarkers(doc.id, [2000]);
    setClipboard({ channels: [ramp(10, 1000)], sampleRate: 44100 });
    useAppStore.getState().setSelection({ start: -500, end: 1000 });

    pasteAtCursor();

    // Replaced [0,1000) with 10 samples: 2000 shifts by (10 - 1000) to 1010,
    // and the cursor lands at 0 + 10. The raw pair gave 510 and -490.
    expect(docLength(activeDoc())).toBe(LEN - 1000 + 10);
    expect(markerPositions(doc.id)).toEqual([1010]);
    expect(useAppStore.getState().cursorSample).toBe(10);
  });

  it('Paste at a cursor past the document inserts at the end and says so to the remap and the cursor', () => {
    const doc = addDoc([ramp(LEN)]);
    setMarkers(doc.id, [1000, LEN]);
    setClipboard({ channels: [ramp(10, 1000)], sampleRate: 44100 });
    useAppStore.getState().setCursor(9000);

    pasteAtCursor();

    // `insertAt` clamps to 4000, so the marker sitting exactly at the old end
    // rides the insert to 4010; the raw start of 9000 left it behind at 4000.
    expect(docLength(activeDoc())).toBe(LEN + 10);
    expect(markerPositions(doc.id)).toEqual([1000, LEN + 10]);
    expect(useAppStore.getState().cursorSample).toBe(LEN + 10); // not 9010
  });
});

describe('silenceSelection', () => {
  it('zeroes the region in place, preserving length, outside data and the selection', () => {
    const doc = addDoc([ramp(10), ramp(10, 10)]);
    const originalLeft = doc.channels[0];
    useAppStore.getState().setSelection({ start: 2, end: 5 });

    silenceSelection();

    // Region [2,5) zeroed on both channels; everything else intact.
    expect(chan(0)).toEqual([1, 2, 0, 0, 0, 6, 7, 8, 9, 10]);
    expect(chan(1)).toEqual([11, 12, 0, 0, 0, 16, 17, 18, 19, 20]);
    expect(docLength(activeDoc())).toBe(10); // length unchanged
    expect(useAppStore.getState().selection).toEqual({ start: 2, end: 5 }); // preserved

    undo(doc.id);
    expect(activeDoc().channels[0]).toBe(originalLeft);
    redo(doc.id);
    expect(chan(0)).toEqual([1, 2, 0, 0, 0, 6, 7, 8, 9, 10]);
  });
});
