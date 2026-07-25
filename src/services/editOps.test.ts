import {
  applyEdit,
  cutSelection,
  copySelection,
  pasteAtCursor,
  deleteSelection,
  trimToSelection,
  silenceSelection,
  pushMarkerUndo,
} from './editOps';
import { getClipboard, setClipboard, clearClipboard } from './clipboard';
import { undo, redo, getHistory, markSavePoint } from './undoHistory';
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

describe('cutSelection', () => {
  it('copies the region to the clipboard, removes it, and collapses selection to the cut start', () => {
    const doc = addDoc([ramp(10)]);
    const originalChannel = doc.channels[0];
    useAppStore.getState().setSelection({ start: 2, end: 5 });

    cutSelection();

    expect(getClipboard()!.channels[0]).toEqual(new Float32Array([3, 4, 5]));
    expect(getClipboard()!.sampleRate).toBe(44100);
    expect(chan()).toEqual([1, 2, 6, 7, 8, 9, 10]);
    expect(useAppStore.getState().selection).toBeNull();
    expect(useAppStore.getState().cursorSample).toBe(2);

    undo(doc.id);
    expect(activeDoc().channels[0]).toBe(originalChannel);
    expect(useAppStore.getState().selection).toEqual({ start: 2, end: 5 });
  });

  it('does nothing without a selection', () => {
    const doc = addDoc([ramp(10)]);
    cutSelection();
    expect(getClipboard()).toBeNull();
    expect(getHistory(doc.id).done).toEqual([]);
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
  it('removes the selection like cut but leaves the clipboard alone', () => {
    const doc = addDoc([ramp(10)]);
    const originalChannel = doc.channels[0];
    useAppStore.getState().setSelection({ start: 2, end: 5 });

    deleteSelection();

    expect(chan()).toEqual([1, 2, 6, 7, 8, 9, 10]);
    expect(getClipboard()).toBeNull();
    expect(useAppStore.getState().selection).toBeNull();
    expect(useAppStore.getState().cursorSample).toBe(2);

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

    deleteSelection();

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

  it('trim to [s,e): outside drop, inside shift left by s', () => {
    const doc = addDoc([ramp(10)]);
    setMarkers(doc.id, [0, 2, 3, 4, 5, 8]);
    const before = useAppStore.getState().markers[doc.id];
    useAppStore.getState().setSelection({ start: 2, end: 5 });

    trimToSelection();

    // 0 dropped (<s); 2,3,4 kept shifted by -2 -> 0,1,2; 5,8 dropped (>=e).
    expect(markerPositions(doc.id)).toEqual([0, 1, 2]);

    undo(doc.id);
    expect(useAppStore.getState().markers[doc.id]).toEqual(before);
  });

  it('clamps a marker sitting exactly at the old docLength so it lands exactly at newLength, never beyond', () => {
    const doc = addDoc([ramp(10)]);
    setMarkers(doc.id, [10]); // edge marker at docLength (e.g. from a clamped-on-read import)
    useAppStore.getState().setSelection({ start: 2, end: 5 }); // delete 3 samples -> newLength 7

    deleteSelection();

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
