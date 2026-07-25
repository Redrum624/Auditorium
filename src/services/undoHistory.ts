import { useSyncExternalStore } from 'react';
import { useAppStore } from '../stores/appStore';

/** A single reversible edit. `undo`/`redo` are closures captured by `applyEdit`
 * (whole-document edits) or `pushMarkerUndo` (marker add/rename/delete) that
 * swap the whole pre-/post-edit state back into the store (channels are
 * immutable-by-convention, so a document swap is O(1) in memory). Entries never
 * carry their own dirty bookkeeping — see `position`/`savePoint` below. */
export interface UndoEntry {
  label: string;
  docId: string;
  undo(): void;
  redo(): void;
}

/** Per-document history. `done`/`undone` are the classic undo/redo stacks.
 * `position` is a monotonic counter (NOT capped by `UNDO_LIMIT` eviction):
 * it starts at 0 for a pristine document, +1 per `pushUndo`/`redo`, -1 per
 * `undo`. `savePoint` is the `position` value at the last successful save
 * (`markSavePoint`), or -1 once that save point has been made permanently
 * unreachable (its future was truncated by a new edit after undoing past it).
 * The live document's `dirty` flag is derived as `position !== savePoint`
 * and re-applied after every undo/redo — never trusted from the entry's own
 * snapshot, which would otherwise restore whatever `dirty` value happened to
 * be baked into that snapshot at edit time (Task M2 / F9). */
interface Stacks {
  done: UndoEntry[]; // applied, oldest -> newest
  undone: UndoEntry[]; // undone, oldest-undone -> most-recently-undone (top)
  position: number;
  savePoint: number;
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
    stacks = { done: [], undone: [], position: 0, savePoint: 0 };
    histories.set(docId, stacks);
  }
  return stacks;
}

/** Overwrites the live document's `dirty` flag (immutably) with the value
 * derived from this history's `position`/`savePoint`, replacing whatever the
 * just-applied undo/redo entry's own snapshot carried. No-op if the document
 * isn't in the store (e.g. it was already closed) or the flag already matches. */
function applyDerivedDirty(docId: string, stacks: Stacks): void {
  const store = useAppStore.getState();
  const doc = store.documents.find((d) => d.id === docId);
  if (!doc) return;
  const dirty = stacks.position !== stacks.savePoint;
  if (doc.dirty !== dirty) {
    store.updateDocument({ ...doc, dirty });
  }
}

/** Records a new applied edit and clears that document's redo stack. If the
 * savePoint lies in the future being truncated (beyond the current position),
 * it becomes permanently unreachable (-1) — that saved state no longer exists
 * on any redo path. */
export function pushUndo(entry: UndoEntry): void {
  const stacks = getStacks(entry.docId);
  if (stacks.savePoint > stacks.position) stacks.savePoint = -1;
  stacks.done.push(entry);
  stacks.undone = [];
  stacks.position += 1;
  if (stacks.done.length > UNDO_LIMIT) {
    stacks.done.splice(0, stacks.done.length - UNDO_LIMIT);
  }
  bumpVersion();
}

/** Reverts the most recent applied edit for the document, then recomputes the
 * live doc's dirty flag from position vs. savePoint. No-op if none. */
export function undo(docId: string): void {
  const stacks = histories.get(docId);
  if (!stacks || stacks.done.length === 0) return;
  const entry = stacks.done.pop()!;
  entry.undo();
  stacks.undone.push(entry);
  stacks.position -= 1;
  applyDerivedDirty(docId, stacks);
  bumpVersion();
}

/** Re-applies the most recently undone edit for the document, then recomputes
 * the live doc's dirty flag from position vs. savePoint. No-op if none. */
export function redo(docId: string): void {
  const stacks = histories.get(docId);
  if (!stacks || stacks.undone.length === 0) return;
  const entry = stacks.undone.pop()!;
  entry.redo();
  stacks.done.push(entry);
  stacks.position += 1;
  applyDerivedDirty(docId, stacks);
  bumpVersion();
}

/** Marks the document's current history position as its save point — call
 * exactly where a save clears `dirty` today (fileService, only after its
 * staleness check confirms nothing edited the doc during an async save). Any
 * later undo/redo recomputes `dirty` against this position instead of trusting
 * a stale snapshot flag (Task M2 / F9). */
export function markSavePoint(docId: string): void {
  const stacks = getStacks(docId);
  stacks.savePoint = stacks.position;
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

/** Drops both stacks for a document, and with them its `position`/`savePoint`
 * — the next `getStacks` call (via `pushUndo`/`markSavePoint`) starts a fresh
 * document at position 0, save point 0. Called when the document is closed. */
export function clearHistory(docId: string): void {
  if (histories.delete(docId)) bumpVersion();
}
