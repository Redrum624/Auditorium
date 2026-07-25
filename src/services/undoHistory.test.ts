import {
  pushUndo,
  undo,
  redo,
  canUndo,
  canRedo,
  getHistory,
  clearHistory,
  markSavePoint,
  UNDO_LIMIT,
  type UndoEntry,
} from './undoHistory';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { createDocument } from '../audio/AudioDocument';

// The history stacks are module-level and keyed by docId, so every test uses a
// fresh, unique docId to stay isolated from the others.
let docCounter = 0;
function freshDocId(): string {
  docCounter++;
  return `hist-doc-${docCounter}`;
}

function makeEntry(docId: string, label: string, log: string[]): UndoEntry {
  return {
    label,
    docId,
    undo: () => log.push(`undo:${label}`),
    redo: () => log.push(`redo:${label}`),
  };
}

describe('pushUndo / undo / redo', () => {
  it('undo replays entries newest-first, redo replays them oldest-first', () => {
    const docId = freshDocId();
    const log: string[] = [];
    pushUndo(makeEntry(docId, 'A', log));
    pushUndo(makeEntry(docId, 'B', log));
    pushUndo(makeEntry(docId, 'C', log));

    undo(docId); // undoes C
    undo(docId); // undoes B
    expect(log).toEqual(['undo:C', 'undo:B']);

    redo(docId); // redoes B
    redo(docId); // redoes C
    expect(log).toEqual(['undo:C', 'undo:B', 'redo:B', 'redo:C']);
  });

  it('undo/redo on an empty stack is a no-op', () => {
    const docId = freshDocId();
    expect(() => undo(docId)).not.toThrow();
    expect(() => redo(docId)).not.toThrow();
    expect(canUndo(docId)).toBe(false);
    expect(canRedo(docId)).toBe(false);
  });

  it('tracks canUndo / canRedo across push/undo/redo', () => {
    const docId = freshDocId();
    const log: string[] = [];
    expect(canUndo(docId)).toBe(false);

    pushUndo(makeEntry(docId, 'A', log));
    expect(canUndo(docId)).toBe(true);
    expect(canRedo(docId)).toBe(false);

    undo(docId);
    expect(canUndo(docId)).toBe(false);
    expect(canRedo(docId)).toBe(true);

    redo(docId);
    expect(canUndo(docId)).toBe(true);
    expect(canRedo(docId)).toBe(false);
  });
});

describe('redo stack clearing', () => {
  it('a new push after an undo clears the redo stack', () => {
    const docId = freshDocId();
    const log: string[] = [];
    pushUndo(makeEntry(docId, 'A', log));
    pushUndo(makeEntry(docId, 'B', log));

    undo(docId); // B is now redoable
    expect(canRedo(docId)).toBe(true);

    pushUndo(makeEntry(docId, 'C', log)); // clears redo of B
    expect(canRedo(docId)).toBe(false);
    expect(getHistory(docId)).toEqual({ done: ['A', 'C'], undone: [] });
  });
});

describe('UNDO_LIMIT eviction', () => {
  it('keeps only the newest UNDO_LIMIT entries, dropping the oldest', () => {
    const docId = freshDocId();
    const log: string[] = [];
    // Push one more than the limit; the very first entry must be evicted.
    for (let i = 0; i <= UNDO_LIMIT; i++) {
      pushUndo(makeEntry(docId, String(i), log));
    }
    const { done } = getHistory(docId);
    expect(done).toHaveLength(UNDO_LIMIT);
    expect(done[0]).toBe('1'); // '0' was evicted
    expect(done[done.length - 1]).toBe(String(UNDO_LIMIT));

    // Undoing everything reaches back only to entry '1', never '0'.
    for (let i = 0; i < UNDO_LIMIT; i++) undo(docId);
    expect(canUndo(docId)).toBe(false);
    expect(log[0]).toBe(`undo:${UNDO_LIMIT}`);
    expect(log[log.length - 1]).toBe('undo:1');
    expect(log).not.toContain('undo:0');
  });
});

describe('per-doc isolation', () => {
  it('keeps separate stacks per docId', () => {
    const a = freshDocId();
    const b = freshDocId();
    const log: string[] = [];
    pushUndo(makeEntry(a, 'A1', log));
    pushUndo(makeEntry(b, 'B1', log));
    pushUndo(makeEntry(a, 'A2', log));

    expect(getHistory(a).done).toEqual(['A1', 'A2']);
    expect(getHistory(b).done).toEqual(['B1']);

    undo(a);
    expect(log).toEqual(['undo:A2']);
    expect(canUndo(b)).toBe(true);
  });
});

describe('getHistory labels', () => {
  it('returns done oldest->newest and undone in redo (timeline) order', () => {
    const docId = freshDocId();
    const log: string[] = [];
    pushUndo(makeEntry(docId, 'A', log));
    pushUndo(makeEntry(docId, 'B', log));
    pushUndo(makeEntry(docId, 'C', log));

    undo(docId); // C undone
    undo(docId); // B undone
    expect(getHistory(docId)).toEqual({ done: ['A'], undone: ['B', 'C'] });
  });

  it('returns empty arrays for an unknown docId', () => {
    expect(getHistory('never-touched')).toEqual({ done: [], undone: [] });
  });
});

describe('clearHistory', () => {
  it('drops both stacks for the doc', () => {
    const docId = freshDocId();
    const log: string[] = [];
    pushUndo(makeEntry(docId, 'A', log));
    undo(docId);
    expect(getHistory(docId)).toEqual({ done: [], undone: ['A'] });

    clearHistory(docId);
    expect(getHistory(docId)).toEqual({ done: [], undone: [] });
    expect(canUndo(docId)).toBe(false);
    expect(canRedo(docId)).toBe(false);
  });
});

describe('save-point-derived dirty (Task M2 / F9)', () => {
  function seedStoreDoc(): string {
    const doc = createDocument({ name: 'hist-test', sampleRate: 44100, channels: [new Float32Array(4)] });
    useAppStore.getState().addDocument(doc);
    return doc.id;
  }

  function liveDirty(docId: string): boolean {
    return useAppStore.getState().documents.find((d) => d.id === docId)!.dirty;
  }

  beforeEach(() => {
    useAppStore.setState(makeInitialState());
  });

  it('undo after markSavePoint leaves the live doc dirty; redo returns to clean at the save point', () => {
    const docId = seedStoreDoc();
    const log: string[] = [];

    pushUndo(makeEntry(docId, 'Edit', log)); // position 0 -> 1
    markSavePoint(docId); // savePoint = 1 (simulates a save right after the edit)
    expect(liveDirty(docId)).toBe(false); // freshly seeded doc starts clean

    undo(docId); // position 1 -> 0, savePoint stays 1
    expect(liveDirty(docId)).toBe(true); // position(0) !== savePoint(1): dirty

    redo(docId); // position 0 -> 1, back at the save point
    expect(liveDirty(docId)).toBe(false);
  });

  it('a pushUndo after undo invalidates a savePoint left in the truncated redo future', () => {
    const docId = seedStoreDoc();
    const log: string[] = [];

    pushUndo(makeEntry(docId, 'A', log)); // position 1
    pushUndo(makeEntry(docId, 'B', log)); // position 2
    markSavePoint(docId); // savePoint = 2

    undo(docId); // position 1; dirty because 1 !== 2
    expect(liveDirty(docId)).toBe(true);

    // A brand-new edit here destroys B's redo entry — the savePoint (2) lived
    // in that now-truncated future, so it becomes permanently unreachable.
    pushUndo(makeEntry(docId, 'C', log)); // position 2

    undo(docId); // position 1
    expect(liveDirty(docId)).toBe(true);
    redo(docId); // position 2 — can never match the invalidated savePoint again
    expect(liveDirty(docId)).toBe(true);
  });

  it('clearHistory resets position and savePoint so a later push/save starts clean again', () => {
    const docId = seedStoreDoc();
    const log: string[] = [];

    pushUndo(makeEntry(docId, 'A', log));
    markSavePoint(docId);
    clearHistory(docId);

    pushUndo(makeEntry(docId, 'X', log)); // position should restart at 1, not 2
    markSavePoint(docId); // savePoint = 1

    undo(docId); // position 0
    expect(liveDirty(docId)).toBe(true);
    redo(docId); // position 1, back at the (fresh) save point
    expect(liveDirty(docId)).toBe(false);
  });
});
