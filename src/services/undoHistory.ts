import { useSyncExternalStore } from 'react';
import { useAppStore } from '../stores/appStore';

/** A single reversible edit. `undo`/`redo` are closures captured by `applyEdit`
 * (whole-document edits) or `pushMarkerUndo` (marker add/rename/delete) that
 * swap the whole pre-/post-edit state back into the store — the swap ITSELF is
 * O(1) (a reference assignment), but the entry is NOT O(1) in memory: each
 * whole-document entry's closures keep the pre- AND post-edit channel arrays
 * alive for as long as the entry survives in `done`/`undone`, so retaining many
 * entries of a large document costs memory proportional to the document's size
 * (Task M9 / F15 — corrects the previous, misleading claim that a swap being
 * O(1) to perform meant the entries were cheap to retain). `bytes` estimates
 * that retained cost so `MAX_UNDO_BYTES` eviction can bound it. Entries never
 * carry their own dirty bookkeeping — see `position`/`savePoint` below. */
export interface UndoEntry {
  label: string;
  docId: string;
  /** Estimated bytes this entry's eviction from `done` would actually free —
   * for a whole-document edit via `applyEdit`, the channel byteLengths of its
   * PRE-edit snapshot only (Task M9 fix round 2 / MINOR 1). The post-edit
   * snapshot is NOT this entry's own memory to free: it's either the live
   * document (held by the store regardless of undo history) or the NEXT
   * entry's own pre-edit snapshot (same object) — either way, something else
   * already keeps it alive, so charging it here would double-count it, or
   * (charging only the post-edit side, round 1's mistake) charge the wrong
   * end entirely for a size-changing edit. Omitted (treated as 0) for entries
   * that only capture small marker-list snapshots (`pushMarkerUndo`) — those
   * never hold a channel array, so they are not counted toward
   * `MAX_UNDO_BYTES` (Task M9 / F15). */
  bytes?: number;
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

/** Maximum total retained bytes (summed `UndoEntry.bytes`) per document's
 * `done` stack; the oldest entries are evicted — beyond the newest, which is
 * always kept — once this is exceeded, exactly like `UNDO_LIMIT` (Task M9 /
 * F15). Without this, 50 retained entries of a 2-hour stereo file (each
 * pinning its own pre-edit document snapshot in addition to the live
 * document) would pin roughly 127 GB of PCM — one snapshot is
 * `7200 s * 44100 * 2 ch * 4 B = 2.54 GB`, and the stack retains up to 50 of
 * them. Entry-count alone doesn't bound memory, size does. */
export const MAX_UNDO_BYTES = 800 * 1024 * 1024;

/** Sum of `bytes` (0 for entries that omit it) currently retained in `done`. */
function doneBytes(stacks: Stacks): number {
  let total = 0;
  for (const entry of stacks.done) total += entry.bytes ?? 0;
  return total;
}

/** Evicts the oldest `done` entries beyond `UNDO_LIMIT` and/or `MAX_UNDO_BYTES`,
 * always keeping at least one — the edit just applied must remain undoable
 * even if it alone exceeds the byte budget.
 *
 * Eviction never touches `position`/`savePoint`: both are pure counters, not
 * indices into `done` (see the comments above), so removing entries from the
 * front only shrinks how far back `undo()` can reach (`done.length` drops, so
 * `canUndo()` goes false sooner) — it can never make a still-REACHABLE
 * position replay the wrong bytes, because every remaining entry's undo/redo
 * closure is self-contained (captured at ITS OWN push time, independent of
 * whether a neighboring entry's object is still in the array). A savePoint
 * whose position lies before the new eviction floor (`position - done.length`)
 * simply becomes forever unreachable — `undo()` can't pop past an evicted
 * entry, so `position` can never fall back to that savePoint again — and
 * `dirty` correctly stays true rather than ever falsely reporting clean
 * (Task M9 / F15; see undoHistory.test.ts's byte-budget + save-point tests).
 *
 * This only sums `done` — entries parked in `undone` after a run of `undo()`
 * calls stay retained un-metered until the next `pushUndo` clears the redo
 * stack. That's bounded by the same peak regardless: `undone` only ever holds
 * entries that were already in `done` (and therefore already budget-approved)
 * before the user started undoing, so moving them to `undone` cannot exceed
 * memory that wasn't already accounted for (Task M9 fix round 1 / MINOR 3). */
function evictOverBudget(stacks: Stacks): void {
  while (
    stacks.done.length > 1 &&
    (stacks.done.length > UNDO_LIMIT || doneBytes(stacks) > MAX_UNDO_BYTES)
  ) {
    stacks.done.shift();
  }
}

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
 * isn't in the store (e.g. it was already closed). Always replaces the doc
 * object — even when the derived value equals the current `dirty` — so the
 * doc's identity changes on every undo/redo. That identity change is load-
 * bearing: fileService's in-flight-save staleness check compares
 * `findDoc(docId) === current` by reference, and a marker-only undo/redo
 * (whose entry only touches the separate `markers` map, never `documents`)
 * would otherwise leave the doc's reference completely untouched whenever
 * dirty-before equals dirty-after (the common case: doc already dirty from
 * an earlier edit, undo a marker op, still dirty) — masking the marker
 * change from a concurrent in-flight save (Task M2 finding 1). */
function applyDerivedDirty(docId: string, stacks: Stacks): void {
  const store = useAppStore.getState();
  const doc = store.documents.find((d) => d.id === docId);
  if (!doc) return;
  const dirty = stacks.position !== stacks.savePoint;
  store.updateDocument({ ...doc, dirty });
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
  evictOverBudget(stacks);
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
 * a stale snapshot flag (Task M2 / F9).
 *
 * No-op when the document's history no longer exists: a save whose async
 * write resolves AFTER the document was closed (clearHistory already ran)
 * must not re-create the histories entry — nothing would ever delete it
 * again, and it would sit in the map for the rest of the session. */
export function markSavePoint(docId: string): void {
  const stacks = histories.get(docId);
  if (!stacks) return;
  stacks.savePoint = stacks.position;
}

/** Makes the current save point permanently unreachable — call from the
 * staleness-REJECTED branch of a save (fileService: `findDoc(docId) !==
 * current`). The write to disk already happened using the pre-await
 * snapshot, so the old save point no longer corresponds to what's on disk;
 * without this, undoing back to that position would wrongly derive `dirty
 * = false` against bytes that were never actually written (Task M2 finding
 * 2).
 *
 * No-op when the document's history no longer exists (closed before the save
 * resolved) — same reasoning as `markSavePoint`, with one extra hazard: the
 * resurrected entry would park `savePoint = -1` on the closed id, poisoning
 * the dirty derivation of any later document that reuses it. */
export function invalidateSavePoint(docId: string): void {
  const stacks = histories.get(docId);
  if (!stacks) return;
  stacks.savePoint = -1;
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
 * — the next `getStacks` call (via `pushUndo`) starts a fresh document at
 * position 0, save point 0. Called when the document is closed. The save-point
 * functions above deliberately never re-create what this dropped. */
export function clearHistory(docId: string): void {
  if (histories.delete(docId)) bumpVersion();
}
