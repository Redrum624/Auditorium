import {
  applyEdit,
  cutSelection,
  copySelection,
  pasteAtCursor,
  deleteSelection,
  trimToSelection,
  silenceSelection,
} from './editOps';
import { getClipboard, setClipboard, clearClipboard } from './clipboard';
import { undo, redo, getHistory } from './undoHistory';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { createDocument, docLength, deleteRegion, type AudioDocument } from '../audio/AudioDocument';

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
