import {
  SESSION_COALESCE_WINDOW_MS,
  SESSION_UNDO_KEY,
  _resetSessionUndo,
  beginSessionGesture,
  bindSessionUndo,
  canRedoSession,
  canUndoSession,
  clearSessionHistory,
  endSessionGesture,
  invalidateSessionSavePoint,
  isSessionDirty,
  markSessionSavePoint,
  recordSessionMutation,
  sessionTimelineEpoch,
  redoSession,
  undoSession,
  withSessionGesture,
  type SessionSnapshot,
} from './sessionUndo';
import { UNDO_LIMIT, getHistory, pushUndo, undo } from '../services/undoHistory';
import { nextId } from '../audio/AudioDocument';
import type { Session } from './session';

/**
 * R3 plumbing tests — the transaction/coalescing mechanics in isolation,
 * against a FAKE binding (a tiny immutable state cell). The real-store
 * binding, per-mutation labels and UI gestures are covered by
 * sessionStore.undo.test.ts and the component suites; this file proves the
 * plumbing itself has no dependency on the real store.
 */

function makeSession(name: string): Session {
  return { name, sampleRate: 44100, tracks: [] };
}

let state: SessionSnapshot;

/** Replaces the fake state with a new immutable session named `name`. */
function writeSession(name: string): void {
  state = { ...state, session: makeSession(name) };
}

/** One recorded single-write mutation renaming the session to `name`. */
function mutate(label: string, name: string, coalesceKey?: string): void {
  recordSessionMutation(label, () => writeSession(name), coalesceKey);
}

beforeEach(() => {
  _resetSessionUndo();
  state = { session: makeSession('S0'), selectedClipId: null };
  bindSessionUndo({
    capture: () => state,
    apply: (snapshot) => {
      state = snapshot;
    },
  });
});

describe('reserved key (ruling 1)', () => {
  it('contains U+0000, which nextId-produced document ids never can', () => {
    expect(SESSION_UNDO_KEY).toContain('\u0000');
    // The generator's shape: `${prefix}-${counter}` from literal prefixes.
    expect(nextId('doc')).toMatch(/^doc-\d+$/);
  });
});

describe('recordSessionMutation', () => {
  it('pushes exactly one entry per recorded mutation, labeled', () => {
    mutate('Add track', 'S1');
    mutate('Remove track', 'S2');
    expect(getHistory(SESSION_UNDO_KEY)).toEqual({
      done: ['Add track', 'Remove track'],
      undone: [],
    });
  });

  it('undo restores the exact pre snapshot; redo the exact post (references, not copies)', () => {
    const pre = state;
    mutate('Add track', 'S1');
    const post = state;
    undoSession();
    expect(state).toBe(pre);
    redoSession();
    expect(state).toBe(post);
  });

  it('records nothing when the mutation leaves the session reference unchanged (no-op action)', () => {
    recordSessionMutation('No-op', () => {});
    expect(getHistory(SESSION_UNDO_KEY).done).toEqual([]);
    expect(canUndoSession()).toBe(false);
  });

  it('records nothing for a view-state-only write (selectedClipId without a session change)', () => {
    recordSessionMutation('Select', () => {
      state = { ...state, selectedClipId: 'clip-9' };
    });
    expect(getHistory(SESSION_UNDO_KEY).done).toEqual([]);
  });
});

describe('gestures (ruling 2 — one gesture, one entry)', () => {
  it('folds many recorded writes between begin and end into exactly ONE entry', () => {
    const pre = state;
    beginSessionGesture('Trim clip');
    for (let i = 1; i <= 40; i++) mutate('ignored-inner-label', `S${i}`);
    endSessionGesture();
    const post = state;

    expect(getHistory(SESSION_UNDO_KEY)).toEqual({ done: ['Trim clip'], undone: [] });
    undoSession();
    expect(state).toBe(pre);
    redoSession();
    expect(state).toBe(post);
  });

  it('a gesture that changed nothing (a click that never dragged) pushes no entry', () => {
    beginSessionGesture('Trim clip');
    endSessionGesture();
    expect(getHistory(SESSION_UNDO_KEY).done).toEqual([]);
  });

  it('endSessionGesture with no open gesture is a safe no-op (pointercancel binding)', () => {
    expect(() => endSessionGesture()).not.toThrow();
    expect(getHistory(SESSION_UNDO_KEY).done).toEqual([]);
  });

  it('a begin over a stale open gesture commits the stale one first (leak costs one entry, not the history)', () => {
    beginSessionGesture('Leaked drag');
    writeSession('S1');
    beginSessionGesture('Next drag');
    writeSession('S2');
    endSessionGesture();
    expect(getHistory(SESSION_UNDO_KEY).done).toEqual(['Leaked drag', 'Next drag']);
  });

  it('withSessionGesture brackets and commits one entry even when fn throws', () => {
    expect(() =>
      withSessionGesture('Arm crossfade', () => {
        writeSession('S1');
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(getHistory(SESSION_UNDO_KEY).done).toEqual(['Arm crossfade']);
  });
});

describe('the transaction-open condition (undo/redo vs an open gesture)', () => {
  it('undoSession and redoSession are no-ops while a gesture is open, and work after end', () => {
    mutate('Add track', 'S1');
    undoSession();
    redoSession(); // history: done=[Add track], state=S1

    beginSessionGesture('Trim clip');
    writeSession('S2');
    const midDrag = state;
    undoSession(); // must NOT apply the 'Add track' entry mid-drag
    expect(state).toBe(midDrag);
    expect(getHistory(SESSION_UNDO_KEY)).toEqual({ done: ['Add track'], undone: [] });
    redoSession();
    expect(state).toBe(midDrag);
    endSessionGesture();

    expect(getHistory(SESSION_UNDO_KEY).done).toEqual(['Add track', 'Trim clip']);
    undoSession();
    expect(state.session.name).toBe('S1');
  });
});

describe('coalescing (ruling 2 — keyboard-repeat clause)', () => {
  let now: jest.SpyInstance<number, []>;
  beforeEach(() => {
    now = jest.spyOn(Date, 'now').mockReturnValue(100_000);
  });
  afterEach(() => {
    now.mockRestore();
  });

  it('merges two same-key commits BELOW the window into one entry (first label, first pre, last post)', () => {
    const pre = state;
    mutate('Set elevation', 'S1', 'elev:track-1');
    now.mockReturnValue(100_000 + SESSION_COALESCE_WINDOW_MS - 1);
    mutate('Set elevation later', 'S2', 'elev:track-1');
    const post = state;

    expect(getHistory(SESSION_UNDO_KEY).done).toEqual(['Set elevation']);
    undoSession();
    expect(state).toBe(pre);
    redoSession();
    expect(state).toBe(post);
  });

  it('merges exactly ON the window boundary (<=)', () => {
    mutate('Set elevation', 'S1', 'elev:track-1');
    now.mockReturnValue(100_000 + SESSION_COALESCE_WINDOW_MS);
    mutate('Set elevation', 'S2', 'elev:track-1');
    expect(getHistory(SESSION_UNDO_KEY).done).toEqual(['Set elevation']);
  });

  it('splits ABOVE the window boundary', () => {
    mutate('Set elevation', 'S1', 'elev:track-1');
    now.mockReturnValue(100_000 + SESSION_COALESCE_WINDOW_MS + 1);
    mutate('Set elevation', 'S2', 'elev:track-1');
    expect(getHistory(SESSION_UNDO_KEY).done).toEqual(['Set elevation', 'Set elevation']);
  });

  it('the window ROLLS: each merged commit restarts it', () => {
    mutate('Set elevation', 'S1', 'elev:track-1');
    now.mockReturnValue(100_000 + SESSION_COALESCE_WINDOW_MS);
    mutate('Set elevation', 'S2', 'elev:track-1'); // merges, restarts window
    now.mockReturnValue(100_000 + 2 * SESSION_COALESCE_WINDOW_MS);
    mutate('Set elevation', 'S3', 'elev:track-1'); // within window of the S2 commit
    expect(getHistory(SESSION_UNDO_KEY).done).toEqual(['Set elevation']);
    undoSession();
    expect(state.session.name).toBe('S0');
  });

  it('different keys never merge; a keyless commit neither merges nor is merged into', () => {
    mutate('Set elevation', 'S1', 'elev:track-1');
    mutate('Set track volume', 'S2', 'trackParam:track-1:volumeDb');
    mutate('Move clip', 'S3'); // no key
    mutate('Move clip', 'S4'); // no key — still no merge
    mutate('Set elevation', 'S5', 'elev:track-1'); // memory was reset by the keyless pushes
    expect(getHistory(SESSION_UNDO_KEY).done).toEqual([
      'Set elevation',
      'Set track volume',
      'Move clip',
      'Move clip',
      'Set elevation',
    ]);
  });

  it('an intervening entry breaks contiguity even within the window', () => {
    mutate('Set elevation', 'S1', 'elev:track-1');
    mutate('Add track', 'S2');
    mutate('Set elevation', 'S3', 'elev:track-1');
    expect(getHistory(SESSION_UNDO_KEY).done).toEqual(['Set elevation', 'Add track', 'Set elevation']);
  });

  it('undo resets the merge memory: a post-undo commit is a NEW entry with the undone state as pre', () => {
    mutate('Set elevation', 'S1', 'elev:track-1');
    undoSession();
    const preAfterUndo = state; // back to S0
    mutate('Set elevation', 'S2', 'elev:track-1');
    expect(getHistory(SESSION_UNDO_KEY)).toEqual({ done: ['Set elevation'], undone: [] });
    undoSession();
    expect(state).toBe(preAfterUndo);
  });

  it('a project save breaks the run (lot A, fix round 1): the first same-key commit after markSessionSavePoint is a NEW entry, so the project reads dirty again', () => {
    // The scenario: nudge a fader (coalescible), Save, nudge the same fader
    // again within the window. Before the fix the second nudge MERGED into
    // the pre-save entry — position unchanged, still === savePoint — and
    // `isSessionDirty()` read false while the live session differed from the
    // file on disk. A save is clause (b) of the rule: something touched the
    // history.
    mutate('Set track volume', 'S1', 'trackParam:track-1:volumeDb');
    markSessionSavePoint(); // the write landed on S1
    expect(isSessionDirty()).toBe(false);

    now.mockReturnValue(100_000 + SESSION_COALESCE_WINDOW_MS - 1);
    mutate('Set track volume', 'S2', 'trackParam:track-1:volumeDb');

    expect(getHistory(SESSION_UNDO_KEY).done).toEqual(['Set track volume', 'Set track volume']);
    expect(isSessionDirty()).toBe(true);
    undoSession();
    expect(state.session.name).toBe('S1'); // exactly what the file holds
    expect(isSessionDirty()).toBe(false);
  });

  it('invalidateSessionSavePoint resets the merge memory the same way (a stale save is still a save)', () => {
    mutate('Set track volume', 'S1', 'trackParam:track-1:volumeDb');
    invalidateSessionSavePoint();
    now.mockReturnValue(100_000 + SESSION_COALESCE_WINDOW_MS - 1);
    mutate('Set track volume', 'S2', 'trackParam:track-1:volumeDb');

    expect(getHistory(SESSION_UNDO_KEY).done).toEqual(['Set track volume', 'Set track volume']);
    expect(isSessionDirty()).toBe(true);
    undoSession();
    expect(state.session.name).toBe('S1');
    expect(isSessionDirty()).toBe(true); // the mark is gone for good; only a new save cleans it
  });

  it('a gesture-committed entry can carry a coalesceKey (elevation keyups merge across gestures)', () => {
    const pre = state;
    withSessionGesture('Set elevation', () => writeSession('S1'), { coalesceKey: 'elev:track-1' });
    withSessionGesture('Set elevation', () => writeSession('S2'), { coalesceKey: 'elev:track-1' });
    const post = state;
    expect(getHistory(SESSION_UNDO_KEY).done).toEqual(['Set elevation']);
    undoSession();
    expect(state).toBe(pre);
    redoSession();
    expect(state).toBe(post);
  });
});

describe('eviction (shared UNDO_LIMIT wiring)', () => {
  it('retains exactly UNDO_LIMIT entries and evicts the oldest on the one-past push', () => {
    for (let i = 1; i <= UNDO_LIMIT; i++) mutate(`Edit ${i}`, `S${i}`);
    expect(getHistory(SESSION_UNDO_KEY).done).toHaveLength(UNDO_LIMIT);
    expect(getHistory(SESSION_UNDO_KEY).done[0]).toBe('Edit 1');

    mutate(`Edit ${UNDO_LIMIT + 1}`, 'S-over');
    const done = getHistory(SESSION_UNDO_KEY).done;
    expect(done).toHaveLength(UNDO_LIMIT);
    expect(done[0]).toBe('Edit 2'); // oldest evicted, order intact
    expect(done[done.length - 1]).toBe(`Edit ${UNDO_LIMIT + 1}`);
  });

  it('a coalesced run counts as ONE entry against the limit', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    for (let i = 1; i <= UNDO_LIMIT + 20; i++) mutate('Set elevation', `S${i}`, 'elev:track-1');
    expect(getHistory(SESSION_UNDO_KEY).done).toEqual(['Set elevation']);
    now.mockRestore();
  });
});

describe('independence from document stacks (ruling 1)', () => {
  it('session undo/redo never touches a document stack, and vice versa', () => {
    let docState = 'doc-original';
    pushUndo({
      label: 'Doc edit',
      docId: 'doc-1',
      undo: () => {
        docState = 'doc-original';
      },
      redo: () => {
        docState = 'doc-edited';
      },
    });
    docState = 'doc-edited';
    mutate('Add track', 'S1');

    undoSession();
    expect(docState).toBe('doc-edited'); // doc untouched
    expect(getHistory('doc-1').done).toEqual(['Doc edit']);

    undo('doc-1');
    expect(docState).toBe('doc-original');
    expect(state.session.name).toBe('S0'); // session state untouched by the doc undo
    expect(getHistory(SESSION_UNDO_KEY)).toEqual({ done: [], undone: ['Add track'] });
  });
});

describe('canUndoSession / canRedoSession / clearSessionHistory', () => {
  it('tracks stack availability through the undo/redo cycle', () => {
    expect(canUndoSession()).toBe(false);
    expect(canRedoSession()).toBe(false);
    mutate('Add track', 'S1');
    expect(canUndoSession()).toBe(true);
    expect(canRedoSession()).toBe(false);
    undoSession();
    expect(canUndoSession()).toBe(false);
    expect(canRedoSession()).toBe(true);
  });

  it('clearSessionHistory drops both stacks AND the merge memory (a post-clear commit cannot merge into a ghost)', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    mutate('Set elevation', 'S1', 'elev:track-1');
    clearSessionHistory();
    expect(canUndoSession()).toBe(false);
    mutate('Set elevation', 'S2', 'elev:track-1');
    expect(getHistory(SESSION_UNDO_KEY)).toEqual({ done: ['Set elevation'], undone: [] });
    undoSession();
    expect(state.session.name).toBe('S1'); // pre of the post-clear entry, NOT S0
    now.mockRestore();
  });

  it('clearSessionHistory also drops an open gesture (load during a drag cannot commit a cross-load entry)', () => {
    beginSessionGesture('Trim clip');
    writeSession('S1');
    clearSessionHistory();
    endSessionGesture();
    expect(getHistory(SESSION_UNDO_KEY).done).toEqual([]);
  });
});

describe('the timeline epoch (lot A, fix round 1)', () => {
  it('advances on clearSessionHistory and on nothing else — edits, gestures, undo and both save-point verbs leave it alone', () => {
    // `sessionFile.writeProjectCore` uses this to tell "the session was edited
    // while the bytes were in flight" (path still remembered) from "another
    // project took over" (path must NOT be re-bound to this save's target).
    const start = sessionTimelineEpoch();

    mutate('Add track', 'S1');
    withSessionGesture('Trim clip', () => writeSession('S2'));
    undoSession();
    markSessionSavePoint();
    invalidateSessionSavePoint();
    expect(sessionTimelineEpoch()).toBe(start);

    clearSessionHistory(); // the one call every load-shaped replacement makes
    expect(sessionTimelineEpoch()).toBe(start + 1);

    clearSessionHistory();
    expect(sessionTimelineEpoch()).toBe(start + 2);
  });
});

// ---------------------------------------------------------------------------
// Lot A (M4) — the session's own save point, the half of "project dirty" that
// no document flag can carry.
// ---------------------------------------------------------------------------
describe('session save point (lot A)', () => {
  it('isSessionDirty follows the stack: clean fresh, dirty after a mutation, clean at the mark, dirty again, clean after undo to the mark, dirty after invalidate, clean after clear', () => {
    expect(isSessionDirty()).toBe(false);

    mutate('Add clip', 'S1');
    expect(isSessionDirty()).toBe(true);

    markSessionSavePoint();
    expect(isSessionDirty()).toBe(false);

    mutate('Move clip', 'S2');
    expect(isSessionDirty()).toBe(true);

    undoSession();
    expect(isSessionDirty()).toBe(false);

    invalidateSessionSavePoint();
    expect(isSessionDirty()).toBe(true);

    clearSessionHistory();
    expect(isSessionDirty()).toBe(false);
  });
});
