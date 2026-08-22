import type { Session } from './session';
import {
  canRedo,
  canUndo,
  clearHistory,
  invalidateSavePoint,
  isAtSavePoint,
  markSavePoint,
  pushUndo,
  redo,
  undo,
} from '../services/undoHistory';

/**
 * R3 — the multitrack session's undo timeline, layered on the SAME per-key
 * history machinery documents use (`undoHistory.ts`): the session is "another
 * document" to that module (ruling 1), so `UNDO_LIMIT`, the History panel's
 * version counter and the stack mechanics are shared, not re-implemented.
 *
 * What this module adds is what the brief calls transaction boundaries and
 * coalescing (ruling 2 / trap T13): the store is immutable, so a previous
 * state object already IS a valid undo record — but a trim or fade drag
 * commits live on every pointermove, and one entry per store write would blow
 * `UNDO_LIMIT = 50` inside a single drag, evicting the user's real history.
 * Entries are therefore created at GESTURE boundaries:
 *
 *  - a plain recorded mutation (a click, a blur commit, a programmatic call)
 *    pushes exactly one entry by itself;
 *  - `beginSessionGesture`/`endSessionGesture` bracket a multi-write gesture
 *    (pointerdown -> pointerup): writes inside the bracket push nothing, and
 *    `end` diffs the begin/end snapshots into at most ONE entry;
 *  - contiguous single-write commits that name the same `coalesceKey` (e.g.
 *    repeated arrow-key taps on the elevation slider, each committing per
 *    keyup) merge into the previous entry instead of pushing a new one — see
 *    the coalescing rule on `SESSION_COALESCE_WINDOW_MS`.
 *
 * THE RECORDING INVARIANT: every write that replaces `SessionState.session`
 * must either go through a recorded store action (`recordSessionMutation`,
 * wired inside every `sessionStore` mutation) or be followed by
 * `clearSessionHistory()` (the load-shaped flows: Open Project, stem landing).
 * An unrecorded session write would not itself be undoable AND would be
 * silently reverted by the next undo of an OLDER entry, because entries are
 * whole-state snapshots — worse than either recording or clearing.
 */

/**
 * The reserved history key for the session's stack (ruling 1). Collision with
 * a real document id is impossible BY CONSTRUCTION, not convention: every
 * document id the app can ever hold comes from `nextId(prefix)`
 * (`AudioDocument.ts:34`), which returns `` `${prefix}-${counter}` `` where
 * `prefix` is always a compile-time literal identifier ('doc') and `counter`
 * a decimal integer — no code path can put U+0000 into such a string, and
 * this key contains one. (Session `.audm` files persist track/clip ids, never
 * document ids: `sessionFile.ts` recreates embedded documents with fresh
 * `nextId('doc')` ids on open.)
 */
export const SESSION_UNDO_KEY = 'session\u0000multitrack';

/**
 * What a session undo entry restores — and, by omission, ruling 3's pin on
 * view state. `session` is the document-like structural state. Of the six
 * view-state fields, ONLY `selectedClipId` rides the snapshot: restoring the
 * selection makes the result of an undo comprehensible (undoing a clip
 * removal re-selects the clip; undoing a move keeps the moved clip selected),
 * while restoring the cursor, zoom, transport state, playhead or the open
 * envelope lane would yank the user's viewport and transport around for no
 * comprehension gain. Pinned by sessionUndo tests: an undo/redo never touches
 * `mtCursorSample`, `mtZoom`, `mtPlayState`, `mtPlayheadSample` or
 * `mtEnvelope`.
 *
 * Snapshots are plain references into the immutable store state — no cloning
 * (the preflight's R3-5 finding). They retain NO audio: `Clip.documentId` is
 * an id string, never a document or channel-array reference, so a session
 * entry's retained cost is a few KB of structural objects (measured in
 * sessionUndo.test.ts). That is why entries carry no `bytes` — the same
 * exemption `pushMarkerUndo` documents for marker-list snapshots.
 */
export interface SessionSnapshot {
  session: Session;
  selectedClipId: string | null;
}

interface SessionUndoBinding {
  /** Reads the current snapshot from the live session store. */
  capture(): SessionSnapshot;
  /** Writes a snapshot back into the live session store. */
  apply(snapshot: SessionSnapshot): void;
}

/** Bound once by `sessionStore.ts` at module init (the store imports this
 * module, so importing in the other direction would be a cycle; injection
 * keeps the dependency one-way). Calls before binding throw loudly — they
 * would mean a recorded mutation ran without the store module loaded, which
 * no real code path can do (the mutations live IN the store). */
let binding: SessionUndoBinding | null = null;

export function bindSessionUndo(b: SessionUndoBinding): void {
  binding = b;
}

function bound(): SessionUndoBinding {
  if (!binding) throw new Error('sessionUndo: not bound — sessionStore must be imported first');
  return binding;
}

/**
 * The coalescing rule (ruling 2, keyboard-repeat clause), exactly: a new
 * single-write commit MERGES into the previous entry instead of pushing its
 * own iff (a) both name the same `coalesceKey`, (b) nothing else touched the
 * session history in between — no other entry pushed, no undo/redo, no
 * clear — and (c) it lands within this many milliseconds of the previous
 * commit (a ROLLING window: each merged commit restarts it, so a held-down
 * arrow key coalesces indefinitely while separated adjustments split).
 * Pointer gestures never name a coalesceKey — each drag is its own entry —
 * so only keyboard/incremental commits ever merge.
 *
 * 1000 ms is a UX judgment, not a derived constant: it EQUALS Windows'
 * slowest keyboard initial-repeat setting (~1 s) — only the inclusive `<=`
 * makes that exactly-on-boundary case merge — and exceeds every faster
 * setting, so a repeat stream never splits mid-hold, while adjustments more
 * than a second apart read as separate intents deserving separate undo
 * steps. The below/on/above boundary is pinned by tests; change either the
 * constant or the inclusivity deliberately or not at all.
 */
export const SESSION_COALESCE_WINDOW_MS = 1000;

/** Merge memory for the coalescing rule: the last entry pushed WITH a
 * coalesceKey, its key, its clock time, and the mutable post-snapshot ref its
 * `redo()` closure reads (merging = overwriting `post.current`, so the entry
 * object already sitting in the `done` stack needs no replacement). Any
 * non-mergeable push, undo, redo, clear or save-point move (mark /
 * invalidate) resets this to null — that is clause (b) of the rule. */
let lastCoalescible: {
  key: string;
  at: number;
  post: { current: SessionSnapshot };
} | null = null;

/** The open gesture, if any (ruling 2): between begin and end, recorded
 * mutations write the store but push nothing; `end` diffs `pre` against the
 * state at end time into at most one entry. */
let openGesture: { label: string; coalesceKey?: string; pre: SessionSnapshot } | null = null;

function pushSessionEntry(
  label: string,
  pre: SessionSnapshot,
  post: SessionSnapshot,
  coalesceKey?: string
): void {
  const now = Date.now();
  if (
    coalesceKey !== undefined &&
    lastCoalescible !== null &&
    lastCoalescible.key === coalesceKey &&
    now - lastCoalescible.at <= SESSION_COALESCE_WINDOW_MS
  ) {
    // Merge: the standing entry keeps its own `pre` (the state before the
    // FIRST commit of the run) and its redo now lands on the newest `post`.
    lastCoalescible.post.current = post;
    lastCoalescible.at = now;
    return;
  }

  const postRef = { current: post };
  pushUndo({
    label,
    docId: SESSION_UNDO_KEY,
    // No `bytes`: structural snapshot, never a channel array — see
    // SessionSnapshot above and pushMarkerUndo's identical exemption.
    undo() {
      bound().apply(pre);
    },
    redo() {
      bound().apply(postRef.current);
    },
  });
  lastCoalescible = coalesceKey !== undefined ? { key: coalesceKey, at: now, post: postRef } : null;
}

/**
 * Records one session mutation: captures the snapshot before and after
 * `run()`, and pushes one entry iff the mutation actually replaced `session`
 * (the store's immutability makes that a reference comparison — a no-op
 * action returns the same state object and records nothing). Inside an open
 * gesture this pushes NOTHING — the gesture's `end` owns the single entry.
 * Wired inside every `sessionStore` mutation; UI code never calls it.
 */
export function recordSessionMutation(label: string, run: () => void, coalesceKey?: string): void {
  if (openGesture) {
    run();
    return;
  }
  const b = bound();
  const pre = b.capture();
  run();
  const post = b.capture();
  if (post.session === pre.session) return;
  pushSessionEntry(label, pre, post, coalesceKey);
}

/**
 * Opens a gesture transaction (ruling 2): every recorded mutation until
 * `endSessionGesture` folds into at most one entry labeled `label`. A begin
 * while a gesture is already open commits the stale one first — a leaked
 * gesture (a missed pointerup) must cost at most one mislabeled entry, never
 * swallow history forever.
 */
export function beginSessionGesture(label: string, opts?: { coalesceKey?: string }): void {
  if (openGesture) endSessionGesture();
  openGesture = { label, coalesceKey: opts?.coalesceKey, pre: bound().capture() };
}

/** Commits the open gesture: at most one entry, and none when the gesture
 * changed nothing (a click that never dragged). No-op when no gesture is
 * open, so callers may bind it unconditionally to pointerup AND
 * pointercancel. */
export function endSessionGesture(): void {
  if (!openGesture) return;
  const g = openGesture;
  openGesture = null;
  const post = bound().capture();
  if (post.session === g.pre.session) return;
  pushSessionEntry(g.label, g.pre, post, g.coalesceKey);
}

/** Brackets `fn` in a gesture — the one-call form for commits that are a
 * single user act spanning several store writes (Arm crossfade writes two
 * fades; a recording stop adds one clip per armed track) or that batch several
 * params behind one intent label the store cannot know (the spatial drop writes
 * azimuth and distance, plus elevation when one is pending, under 'Set spatial
 * position'; 'Set elevation' relabels a single key write). */
export function withSessionGesture(
  label: string,
  fn: () => void,
  opts?: { coalesceKey?: string }
): void {
  beginSessionGesture(label, opts);
  try {
    fn();
  } finally {
    endSessionGesture();
  }
}

/**
 * Undo/redo for the session stack. Both are NO-OPS while a gesture is open
 * (the transaction-open condition): applying an entry mid-drag would fight
 * the pointer's live writes, and the entry the gesture is still accumulating
 * does not exist yet. Both also reset the coalescing memory — after an undo,
 * a new commit on the same parameter must be a NEW entry whose `pre` is the
 * undone state, never a merge into an entry that now sits on the redo stack.
 */
export function undoSession(): void {
  if (openGesture) return;
  lastCoalescible = null;
  undo(SESSION_UNDO_KEY);
}

export function redoSession(): void {
  if (openGesture) return;
  lastCoalescible = null;
  redo(SESSION_UNDO_KEY);
}

export function canUndoSession(): boolean {
  return canUndo(SESSION_UNDO_KEY);
}

export function canRedoSession(): boolean {
  return canRedo(SESSION_UNDO_KEY);
}

/**
 * Lot A (M4) — the session's save point, the same three verbs `fileService`
 * applies to a document's history after a write: mark on a successful save
 * that passed the staleness check, invalidate when the session was edited
 * while the bytes were in flight, and read back whether the live session
 * matches what the last project save wrote. `clearSessionHistory` (a load)
 * drops the stacks, which `isAtSavePoint` reads as clean — a freshly opened
 * project is not dirty.
 *
 * Both verbs also reset the coalescing memory — a save is clause (b) of the
 * rule above, something that touched the history. Without that, a keyboard
 * nudge landing within the window of the nudge that preceded the save would
 * MERGE into the entry the file already holds: the stack position would not
 * move off the mark, and `isSessionDirty()` would read false while the live
 * session differed from disk (Save pill grey, chip unstarred, close guard
 * silent).
 */
export function markSessionSavePoint(): void {
  lastCoalescible = null;
  markSavePoint(SESSION_UNDO_KEY);
}

export function invalidateSessionSavePoint(): void {
  lastCoalescible = null;
  invalidateSavePoint(SESSION_UNDO_KEY);
}

export function isSessionDirty(): boolean {
  return !isAtSavePoint(SESSION_UNDO_KEY);
}

/**
 * Lot A (fix round 1) — how many times the project's editing timeline has been
 * REPLACED, as opposed to edited. Every load-shaped flow (Open Project, a stem
 * landing, a cover session) swaps `SessionState.session` wholesale, rewrites
 * `projectPath` and calls `clearSessionHistory()`; the recording invariant
 * above is what makes that call the one thing they all share. A recorded
 * in-place edit never touches it.
 *
 * `sessionFile`'s `writeProjectCore` reads this either side of its `writeFile`
 * await: a save that finishes AFTER such a replacement must not stamp its
 * target path onto the project that took over. The bytes on disk belong to the
 * project that was serialized, so re-binding would point the next plain Ctrl+S
 * at that file with the new session's content and no dialog in front of it.
 *
 * Neither cheaper test can see it: comparing `projectPath` before and after
 * misses a landing that writes the same `null` a never-saved project started
 * from, and comparing session identity flags an ordinary mid-write clip edit,
 * which must still remember the path (`sessionFile.test.ts` — "a clip edit
 * during the write ... while the path is still remembered").
 */
let timelineEpoch = 0;

export function sessionTimelineEpoch(): number {
  return timelineEpoch;
}

/**
 * Drops the session's stacks and this module's gesture/coalescing state.
 * Called by the load-shaped session replacements (Open Project, stem
 * landing): a load starts a new editing timeline, exactly as opening a
 * document starts that document's history fresh — undo must not reach across
 * a load back into content that came from somewhere else. (`newSession`, by
 * contrast, is a store MUTATION of the current timeline and IS undoable.)
 */
export function clearSessionHistory(): void {
  lastCoalescible = null;
  openGesture = null;
  timelineEpoch += 1; // a new editing timeline — see `sessionTimelineEpoch`
  clearHistory(SESSION_UNDO_KEY);
}

/** Test-only: resets module state AND the session stack, so suites that
 * share the module-global history start clean (same convention as
 * `_resetClipWaveformCache`). */
export function _resetSessionUndo(): void {
  clearSessionHistory();
}
