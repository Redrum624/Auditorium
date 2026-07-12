import { useSyncExternalStore } from 'react';

/** A single reversible edit. `undo`/`redo` are closures captured by `applyEdit`
 * that swap the whole pre-/post-edit AudioDocument reference back into the store
 * (channels are immutable-by-convention, so this is O(1) in memory). */
export interface UndoEntry {
  label: string;
  docId: string;
  undo(): void;
  redo(): void;
}

interface Stacks {
  done: UndoEntry[]; // applied, oldest -> newest
  undone: UndoEntry[]; // undone, oldest-undone -> most-recently-undone (top)
}

/** Per-document history. Keyed by docId so each open file has its own undo
 * timeline; `clearHistory` drops a doc's stacks when it is closed. */
const histories = new Map<string, Stacks>();

/** Maximum number of applied edits retained per document; the oldest is evicted
 * once the limit is exceeded. */
export const UNDO_LIMIT = 50;

// --- change notification (for HistoryPanel via useSyncExternalStore) ---------
// The history lives outside zustand, so components subscribe to this version
// counter to re-render whenever any stack changes.
let historyVersion = 0;
const versionListeners = new Set<() => void>();

function bumpVersion(): void {
  historyVersion++;
  for (const listener of versionListeners) listener();
}

function subscribeVersion(cb: () => void): () => void {
  versionListeners.add(cb);
  return () => {
    versionListeners.delete(cb);
  };
}

function getVersionSnapshot(): number {
  return historyVersion;
}

/** Re-renders the caller whenever the undo/redo stacks change for any document. */
export function useHistoryVersion(): number {
  return useSyncExternalStore(subscribeVersion, getVersionSnapshot, getVersionSnapshot);
}

// --- stacks ------------------------------------------------------------------
function getStacks(docId: string): Stacks {
  let stacks = histories.get(docId);
  if (!stacks) {
    stacks = { done: [], undone: [] };
    histories.set(docId, stacks);
  }
  return stacks;
}

/** Records a new applied edit and clears that document's redo stack. */
export function pushUndo(entry: UndoEntry): void {
  const stacks = getStacks(entry.docId);
  stacks.done.push(entry);
  stacks.undone = [];
  if (stacks.done.length > UNDO_LIMIT) {
    stacks.done.splice(0, stacks.done.length - UNDO_LIMIT);
  }
  bumpVersion();
}

/** Reverts the most recent applied edit for the document. No-op if none. */
export function undo(docId: string): void {
  const stacks = histories.get(docId);
  if (!stacks || stacks.done.length === 0) return;
  const entry = stacks.done.pop()!;
  entry.undo();
  stacks.undone.push(entry);
  bumpVersion();
}

/** Re-applies the most recently undone edit for the document. No-op if none. */
export function redo(docId: string): void {
  const stacks = histories.get(docId);
  if (!stacks || stacks.undone.length === 0) return;
  const entry = stacks.undone.pop()!;
  entry.redo();
  stacks.done.push(entry);
  bumpVersion();
}

export function canUndo(docId: string): boolean {
  const stacks = histories.get(docId);
  return !!stacks && stacks.done.length > 0;
}

export function canRedo(docId: string): boolean {
  const stacks = histories.get(docId);
  return !!stacks && stacks.undone.length > 0;
}

/** Labels for the HistoryPanel: `done` oldest->newest; `undone` in the order
 * redo would re-apply them (timeline continuation of `done`). */
export function getHistory(docId: string): { done: string[]; undone: string[] } {
  const stacks = histories.get(docId);
  if (!stacks) return { done: [], undone: [] };
  return {
    done: stacks.done.map((e) => e.label),
    // The undone stack has the most-recently-undone entry on top; reversing it
    // yields the order in which redo would re-apply them.
    undone: stacks.undone.map((e) => e.label).reverse(),
  };
}

/** Drops both stacks for a document (called when the document is closed). */
export function clearHistory(docId: string): void {
  if (histories.delete(docId)) bumpVersion();
}
