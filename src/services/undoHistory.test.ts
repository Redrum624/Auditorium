import { renderHook, act } from '@testing-library/react';
import {
  pushUndo,
  undo,
  redo,
  canUndo,
  canRedo,
  getHistory,
  clearHistory,
  markSavePoint,
  invalidateSavePoint,
  useHistoryVersion,
  UNDO_LIMIT,
  MAX_UNDO_BYTES,
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

/** Like `makeEntry` but with a declared `bytes` size — `bytes` is a plain
 * number, not a real allocation, so these can exercise the REAL, fixed
 * MAX_UNDO_BYTES (800 MB) budget with fabricated sizes instead of actually
 * allocating hundreds of megabytes per entry (Task M9 / F15). */
function makeSizedEntry(docId: string, label: string, bytes: number, log: string[]): UndoEntry {
  return {
    label,
    docId,
    bytes,
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

describe('MAX_UNDO_BYTES eviction (Task M9 / F15)', () => {
  it('is 800 MB', () => {
    expect(MAX_UNDO_BYTES).toBe(800 * 1024 * 1024);
  });

  it('evicts the oldest entry once the running total exceeds the budget, keeping the newest', () => {
    const docId = freshDocId();
    const log: string[] = [];
    // 300 MB * 3 = 900 MB > 800 MB budget: pushing C must evict A (the oldest).
    pushUndo(makeSizedEntry(docId, 'A', 300 * 1024 * 1024, log));
    pushUndo(makeSizedEntry(docId, 'B', 300 * 1024 * 1024, log));
    pushUndo(makeSizedEntry(docId, 'C', 300 * 1024 * 1024, log));

    expect(getHistory(docId).done).toEqual(['B', 'C']);

    undo(docId);
    undo(docId);
    expect(log).toEqual(['undo:C', 'undo:B']);
    expect(canUndo(docId)).toBe(false); // 'A' was evicted — cannot undo past 'B'
  });

  it('always keeps at least one entry even when it alone exceeds the budget', () => {
    const docId = freshDocId();
    const log: string[] = [];
    pushUndo(makeSizedEntry(docId, 'Huge', 2 * 1024 * 1024 * 1024, log)); // 2 GB alone
    expect(getHistory(docId).done).toEqual(['Huge']);
    expect(canUndo(docId)).toBe(true);
  });

  it('entries with no declared bytes (e.g. marker-only undo entries) do not count toward the budget', () => {
    const docId = freshDocId();
    const log: string[] = [];
    for (let i = 0; i < 5; i++) {
      pushUndo({
        label: String(i),
        docId,
        undo: () => log.push(`undo:${i}`),
        redo: () => log.push(`redo:${i}`),
      });
    }
    expect(getHistory(docId).done).toEqual(['0', '1', '2', '3', '4']); // none evicted
  });

  it('a mix of sized and unsized entries only counts the sized ones toward the budget', () => {
    const docId = freshDocId();
    const log: string[] = [];
    pushUndo(makeSizedEntry(docId, 'A', 500 * 1024 * 1024, log));
    pushUndo({ label: 'marker-op', docId, undo: () => {}, redo: () => {} }); // 0 bytes
    pushUndo(makeSizedEntry(docId, 'B', 500 * 1024 * 1024, log)); // total 1000MB > 800MB -> evict 'A'

    expect(getHistory(docId).done).toEqual(['marker-op', 'B']);
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

  it('never touches neverSaved — undoing PAST the creation point leaves the provenance flag intact (Task S4: the reason dirty could not carry it)', () => {
    const doc = createDocument({ name: 'Remix 1', sampleRate: 44100, channels: [new Float32Array(4)] });
    useAppStore.getState().addDocument(doc);
    const docId = doc.id;
    const log: string[] = [];
    const live = () => useAppStore.getState().documents.find((d) => d.id === docId)!;
    expect(live().neverSaved).toBe(true);

    pushUndo(makeEntry(docId, 'Edit', log)); // position 0 -> 1
    undo(docId); // position back to 0 — the derived dirty goes clean here
    expect(liveDirty(docId)).toBe(false); // exactly the case that would clear a stamped dirty
    expect(live().neverSaved).toBe(true); // ... but never the provenance flag

    redo(docId);
    expect(live().neverSaved).toBe(true);

    // And the converse: undo/redo never RESURRECT the flag on a saved document.
    const saved = createDocument({
      name: 'song.wav',
      sampleRate: 44100,
      channels: [new Float32Array(4)],
      filePath: 'C:/song.wav',
    });
    useAppStore.getState().addDocument(saved);
    pushUndo(makeEntry(saved.id, 'Edit', log));
    undo(saved.id);
    redo(saved.id);
    expect(useAppStore.getState().documents.find((d) => d.id === saved.id)!.neverSaved).toBe(false);
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

  it('a byte-budget eviction that discards a DIFFERENT (older) entry still lets undo derive clean at a savePoint that remains reachable (Task M9 / F15)', () => {
    const docId = seedStoreDoc();
    const log: string[] = [];

    pushUndo(makeSizedEntry(docId, 'A', 500 * 1024 * 1024, log)); // position 1
    markSavePoint(docId); // savePoint = 1 (the state right after A)
    expect(liveDirty(docId)).toBe(false);

    // A + B = 1000 MB > 800 MB budget: pushing B evicts A's entry, but B's OWN
    // undo closure still independently captured A's post-edit doc as ITS
    // pre-edit snapshot — evicting A's array entry doesn't touch that closure.
    pushUndo(makeSizedEntry(docId, 'B', 500 * 1024 * 1024, log)); // position 2
    expect(getHistory(docId).done).toEqual(['B']);

    undo(docId); // pops B — restores exactly the byte state that was saved
    expect(liveDirty(docId)).toBe(false); // position(1) === savePoint(1): still correct
    expect(canUndo(docId)).toBe(false); // A's entry is gone — cannot undo further back
  });

  it('a savePoint recorded before an eviction that discards ITS OWN entry becomes permanently unreachable — dirty forever, never falsely clean (Task M9 / F15)', () => {
    const docId = seedStoreDoc();
    const log: string[] = [];

    pushUndo(makeSizedEntry(docId, 'A', 100 * 1024 * 1024, log)); // position 1
    markSavePoint(docId); // savePoint = 1 (the state right after A)
    expect(liveDirty(docId)).toBe(false);

    pushUndo(makeSizedEntry(docId, 'B', 100 * 1024 * 1024, log)); // position 2
    // A + B + C = 1200 MB > 800 MB, and evicting only 'A' would still leave
    // B+C = 1100 MB over budget, so BOTH 'A' and 'B' are evicted here — taking
    // the savePoint's own entry (A) down with it.
    pushUndo(makeSizedEntry(docId, 'C', 1000 * 1024 * 1024, log)); // position 3
    expect(getHistory(docId).done).toEqual(['C']);

    undo(docId); // pops C — the only entry left; restores the state after B
    expect(canUndo(docId)).toBe(false); // A and B are both gone

    // The live document is now the state after B, NOT the state saved at
    // position 1 (after A) — that A-state can never be reconstructed again
    // since its undo closure was evicted, so dirty must stay true forever
    // relative to this savePoint instead of silently reporting clean.
    expect(liveDirty(docId)).toBe(true);
  });

  it('a save resolving AFTER the doc was closed does not resurrect its history entry (markSavePoint on a cleared docId)', () => {
    // The race: fileService's async save awaits the disk write, and the user
    // closes the document (clearHistory) before it resolves. The save's
    // markSavePoint then lands on a docId with no stacks — it must be a no-op,
    // not a getStacks that re-creates an entry nothing will ever delete again.
    const docId = freshDocId();
    const log: string[] = [];
    pushUndo(makeEntry(docId, 'A', log));
    clearHistory(docId); // the close wins the race

    markSavePoint(docId); // the save resolves late, on the closed doc

    // clearHistory bumps the shared version counter ONLY when an entry
    // actually existed to delete — so a second clear observes whether the
    // late markSavePoint resurrected one.
    const { result } = renderHook(() => useHistoryVersion());
    const before = result.current;
    act(() => clearHistory(docId));
    expect(result.current).toBe(before);
  });

  it('a STALE save resolving after the close does not resurrect the entry either, nor poison a document that later reuses the id (invalidateSavePoint on a cleared docId)', () => {
    const docId = seedStoreDoc();
    const log: string[] = [];
    pushUndo(makeEntry(docId, 'A', log));
    clearHistory(docId); // the close wins the race

    invalidateSavePoint(docId); // the save's staleness-rejected branch, late

    // No entry may have been re-created...
    const { result } = renderHook(() => useHistoryVersion());
    const before = result.current;
    act(() => clearHistory(docId));
    expect(result.current).toBe(before);

    // ...and a fresh history under the same id must start pristine: its first
    // edit's undo derives clean (position 0 === savePoint 0). A resurrected
    // savePoint of -1 parked on the closed id would derive dirty forever.
    pushUndo(makeEntry(docId, 'X', log));
    undo(docId);
    expect(liveDirty(docId)).toBe(false);
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
