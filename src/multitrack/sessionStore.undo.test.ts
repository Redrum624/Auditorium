import { createClip, createTrack, type Session } from './session';
import { useSessionStore } from './sessionStore';
import {
  SESSION_UNDO_KEY,
  _resetSessionUndo,
  beginSessionGesture,
  endSessionGesture,
  redoSession,
  undoSession,
} from './sessionUndo';
import { getHistory } from '../services/undoHistory';

/**
 * R3 — the REAL store's recording wiring: every listed mutation records
 * exactly one labeled entry, undo restores the exact prior state object,
 * redo the exact post state object (the store is immutable, so reference
 * identity is the strongest possible assertion — stronger than deep
 * equality), view-state actions record nothing, and a session undo entry
 * retains no audio (measured).
 */

/** Fresh 3-track session with two clips on track 1 (adjacent) and one on
 * track 2. Installed via raw setState (unrecorded — test setup is a load). */
function seedSession(): Session {
  const t1 = createTrack('Track 1');
  const t2 = createTrack('Track 2');
  const t3 = createTrack('Track 3');
  t1.clips = [
    createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 1000 }),
    createClip({ documentId: 'doc-1', startSample: 1000, offsetSample: 0, lengthSample: 1000 }),
  ];
  t2.clips = [
    createClip({ documentId: 'doc-2', startSample: 500, offsetSample: 0, lengthSample: 2000 }),
  ];
  const session: Session = { name: 'Undo Fixture', sampleRate: 44100, tracks: [t1, t2, t3] };
  useSessionStore.setState({
    session,
    selectedClipId: null,
    mtCursorSample: 0,
    mtZoom: { samplesPerPixel: 512, scrollSample: 0 },
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
  });
  return session;
}

const store = () => useSessionStore.getState();
const sessionRef = () => useSessionStore.getState().session;
const doneLabels = () => getHistory(SESSION_UNDO_KEY).done;

let seeded: Session;

beforeEach(() => {
  _resetSessionUndo();
  seeded = seedSession();
});

/** Performs `mutate`, asserts exactly one entry labeled `label`, then the
 * full undo->exact-pre / redo->exact-post cycle. */
function expectRecordedCycle(label: string, mutate: () => void): void {
  const pre = sessionRef();
  mutate();
  const post = sessionRef();
  expect(post).not.toBe(pre); // the mutation really happened
  expect(doneLabels()).toEqual([label]);

  undoSession();
  expect(sessionRef()).toBe(pre);
  redoSession();
  expect(sessionRef()).toBe(post);
  expect(getHistory(SESSION_UNDO_KEY)).toEqual({ done: [label], undone: [] });
}

describe('every listed mutation records one labeled, reversible entry', () => {
  it('newSession -> "New session" (undo restores the discarded session)', () => {
    expectRecordedCycle('New session', () => store().newSession(48000));
  });

  it('addTrack -> "Add track"', () => {
    expectRecordedCycle('Add track', () => store().addTrack());
  });

  it('removeTrack -> "Remove track"', () => {
    expectRecordedCycle('Remove track', () => store().removeTrack(seeded.tracks[0].id));
  });

  it('renameTrack -> "Rename track"', () => {
    expectRecordedCycle('Rename track', () => store().renameTrack(seeded.tracks[0].id, 'Lead'));
  });

  it('setTrackParam volumeDb -> "Set track volume"', () => {
    expectRecordedCycle('Set track volume', () =>
      store().setTrackParam(seeded.tracks[0].id, { volumeDb: -6 })
    );
  });

  it('setTrackParam pan -> "Set track pan"', () => {
    expectRecordedCycle('Set track pan', () => store().setTrackParam(seeded.tracks[0].id, { pan: 0.5 }));
  });

  it('setTrackParam muted -> "Mute track" / "Unmute track" by direction', () => {
    store().setTrackParam(seeded.tracks[0].id, { muted: true });
    store().setTrackParam(seeded.tracks[0].id, { muted: false });
    expect(doneLabels()).toEqual(['Mute track', 'Unmute track']);
  });

  it('setTrackParam solo/armed -> direction labels', () => {
    store().setTrackParam(seeded.tracks[0].id, { solo: true });
    store().setTrackParam(seeded.tracks[0].id, { armed: true });
    expect(doneLabels()).toEqual(['Solo track', 'Arm track']);
  });

  it('addClip -> "Add clip"', () => {
    expectRecordedCycle('Add clip', () =>
      store().addClip(
        seeded.tracks[2].id,
        createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 500 })
      )
    );
  });

  it('moveClip -> "Move clip"', () => {
    expectRecordedCycle('Move clip', () =>
      store().moveClip(seeded.tracks[0].clips[0].id, seeded.tracks[2].id, 4000)
    );
  });

  it('trimClip -> "Trim clip"', () => {
    expectRecordedCycle('Trim clip', () =>
      store().trimClip(seeded.tracks[1].clips[0].id, 'end', 2000)
    );
  });

  it('removeClip -> "Remove clip"', () => {
    expectRecordedCycle('Remove clip', () => store().removeClip(seeded.tracks[0].clips[0].id));
  });

  it('setClipGain -> "Set clip gain"', () => {
    expectRecordedCycle('Set clip gain', () => store().setClipGain(seeded.tracks[0].clips[0].id, -3));
  });

  it('setClipFade -> "Set fade"', () => {
    expectRecordedCycle('Set fade', () =>
      store().setClipFade(seeded.tracks[0].clips[0].id, 'in', { lengthSample: 100 })
    );
  });

  it('upsertAutomationKey -> "Add automation key" (no replace) / "Move automation key" (replace)', () => {
    store().upsertAutomationKey(seeded.tracks[0].id, 'volumeDb', { positionSample: 0, value: -6 });
    store().upsertAutomationKey(
      seeded.tracks[0].id,
      'volumeDb',
      { positionSample: 100, value: -6 },
      0
    );
    expect(doneLabels()).toEqual(['Add automation key', 'Move automation key']);
    undoSession();
    undoSession();
    expect(sessionRef()).toBe(seeded);
  });

  it('upsertAutomationKeys -> "Edit automation"', () => {
    expectRecordedCycle('Edit automation', () =>
      store().upsertAutomationKeys(seeded.tracks[0].id, [
        { param: 'azimuth', key: { positionSample: 0, value: 30 } },
        { param: 'distance', key: { positionSample: 0, value: 1.5 } },
      ])
    );
  });

  it('removeAutomationKey -> "Remove automation key"', () => {
    store().upsertAutomationKey(seeded.tracks[0].id, 'volumeDb', { positionSample: 0, value: -6 });
    const withKey = sessionRef();
    store().removeAutomationKey(seeded.tracks[0].id, 'volumeDb', 0);
    expect(doneLabels()).toEqual(['Add automation key', 'Remove automation key']);
    undoSession();
    expect(sessionRef()).toBe(withKey);
  });

  it('setAutomationKeyCurve -> "Set automation curve"', () => {
    store().upsertAutomationKey(seeded.tracks[0].id, 'volumeDb', { positionSample: 0, value: -6 });
    const withKey = sessionRef();
    store().setAutomationKeyCurve(seeded.tracks[0].id, 'volumeDb', 0, 'equal-gain');
    expect(doneLabels()).toEqual(['Add automation key', 'Set automation curve']);
    undoSession();
    expect(sessionRef()).toBe(withKey);
  });
});

describe('no-op mutations record nothing (reference-stable guards)', () => {
  it('unknown ids: every guarded action leaves state AND history untouched', () => {
    const pre = sessionRef();
    store().removeTrack('track-none');
    store().renameTrack('track-none', 'X');
    store().setTrackParam('track-none', { volumeDb: -6 });
    store().addClip(
      'track-none',
      createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 100 })
    );
    store().moveClip('clip-none', seeded.tracks[0].id, 0);
    store().trimClip('clip-none', 'end', 100);
    store().removeClip('clip-none');
    store().setClipGain('clip-none', -3);
    store().setClipFade('clip-none', 'in', { lengthSample: 10 });
    store().upsertAutomationKey('track-none', 'volumeDb', { positionSample: 0, value: 0 });
    store().upsertAutomationKeys('track-none', [
      { param: 'volumeDb', key: { positionSample: 0, value: 0 } },
    ]);
    store().removeAutomationKey('track-none', 'volumeDb', 0);
    store().setAutomationKeyCurve('track-none', 'volumeDb', 0, 'equal-gain');
    expect(sessionRef()).toBe(pre);
    expect(doneLabels()).toEqual([]);
  });

  it('re-committing unchanged values (blur without edit) records nothing', () => {
    const t1 = seeded.tracks[0];
    const c1 = t1.clips[0];
    store().setClipGain(c1.id, -3); // real edit first
    const after = sessionRef();
    store().setClipGain(c1.id, -3); // unchanged re-commit
    store().renameTrack(t1.id, 'Track 1'); // unchanged name
    store().setTrackParam(t1.id, { volumeDb: 0 }); // unchanged param
    store().setClipFade(c1.id, 'in', { lengthSample: 0 }); // no fade -> still no fade
    expect(sessionRef()).toBe(after);
    expect(doneLabels()).toEqual(['Set clip gain']);
  });

  /**
   * H1 (CC3 review I1's deferred half). `setClipFade` carries the R3 no-op
   * guard and states it; `moveClip` did not, so every caller committing the
   * position a clip already holds rebuilt the tracks array, minted a
   * `Move clip` entry against `UNDO_LIMIT`, and re-ran `maintainFacingFades`
   * over a move that never happened — which can re-arm or reshape a crossfade
   * the user never touched. The Properties panel's Start field needed a field
   * of its own to work around it; every OTHER caller had nothing.
   *
   * 44101 is deliberately OFF the millisecond grid. Every fixture in the suite
   * this defect was reported from was millisecond-exact, which is precisely
   * what hid it: at a whole-millisecond position the re-commit round-trips
   * through `formatTime`/`parseTime` unchanged, so the phantom move lands back
   * on the same sample and only the wasted history entry shows. A dragged clip
   * — i.e. every clip a user has actually placed — sits between two
   * milliseconds, and there the guard has to be sample-exact.
   *
   * The reference assertion is the strong one: an identical `session` object
   * means no rebuilt tracks array, so `maintainFacingFades` demonstrably did
   * not run either.
   */
  it('re-committing the position a clip already holds records nothing', () => {
    const track = seeded.tracks[0];
    const clip = track.clips[0];
    store().moveClip(clip.id, track.id, 44101);
    const after = sessionRef();
    expect(doneLabels()).toEqual(['Move clip']);

    store().moveClip(clip.id, track.id, 44101);

    expect(sessionRef()).toBe(after);
    expect(doneLabels()).toEqual(['Move clip']);
  });

  /** The guard is on the position the store RESOLVES, not the one it was
   * handed: a negative request against a clip already at zero is the clamp
   * asking for the position it is already at. */
  it('a request the clamp resolves to where the clip already is records nothing', () => {
    const track = seeded.tracks[0];
    const clip = track.clips[0]; // seeded at 0
    const pre = sessionRef();

    store().moveClip(clip.id, track.id, -5);

    expect(sessionRef()).toBe(pre);
    expect(doneLabels()).toEqual([]);
  });

  /** …and it is not over-broad: the same start sample on a DIFFERENT track is
   * a real move, and still records one. */
  it('the same start sample on another track is still a move', () => {
    const clip = seeded.tracks[0].clips[0];

    store().moveClip(clip.id, seeded.tracks[2].id, clip.startSample);

    expect(doneLabels()).toEqual(['Move clip']);
    expect(sessionRef().tracks[2].clips).toHaveLength(1);
  });
});

describe('view-state actions record nothing (ruling 3)', () => {
  it('all six view setters leave the history empty', () => {
    store().setSelectedClip(seeded.tracks[0].clips[0].id);
    store().setMtCursor(4321);
    store().setMtZoom({ samplesPerPixel: 256, scrollSample: 100 });
    store().setMtPlayState('playing');
    store().setMtPlayheadSample(999);
    store().setMtEnvelope({ trackId: seeded.tracks[0].id, param: 'volumeDb' });
    expect(doneLabels()).toEqual([]);
  });

  it('undo restores the selection but never cursor/zoom/transport/playhead/envelope', () => {
    const clipId = seeded.tracks[0].clips[0].id;
    store().setSelectedClip(clipId);
    store().removeClip(clipId); // clears the selection as part of the mutation
    expect(store().selectedClipId).toBeNull();

    // View state moves on AFTER the edit...
    store().setMtCursor(7777);
    store().setMtZoom({ samplesPerPixel: 64, scrollSample: 42 });
    store().setMtPlayState('playing');
    store().setMtPlayheadSample(1234);
    const envelope = { trackId: seeded.tracks[1].id, param: 'pan' as const };
    store().setMtEnvelope(envelope);

    undoSession();
    // ...the undo restores the removed clip AND its selection (comprehension)
    expect(sessionRef()).toBe(seeded);
    expect(store().selectedClipId).toBe(clipId);
    // ...but none of the other view state (ruling 3 pin).
    expect(store().mtCursorSample).toBe(7777);
    expect(store().mtZoom).toEqual({ samplesPerPixel: 64, scrollSample: 42 });
    expect(store().mtPlayState).toBe('playing');
    expect(store().mtPlayheadSample).toBe(1234);
    expect(store().mtEnvelope).toBe(envelope);
  });
});

describe('gesture wiring against the real store (ruling 2)', () => {
  it('a 60-write trim drag inside a gesture is exactly ONE entry, and undo restores the pointerdown state', () => {
    const clipId = seeded.tracks[1].clips[0].id;
    beginSessionGesture('Trim clip');
    for (let end = 2500; end < 2560; end++) store().trimClip(clipId, 'end', end);
    endSessionGesture();

    expect(doneLabels()).toEqual(['Trim clip']);
    const post = sessionRef();
    undoSession();
    expect(sessionRef()).toBe(seeded);
    redoSession();
    expect(sessionRef()).toBe(post);
  });

  it('keyboard ticks on DIFFERENT tracks never merge — the track-id operand of the coalesce key', () => {
    // Review round 1: `trackParam:${id}:${param}` survived a mutant that
    // dropped the id — nudge track A's fader, focus track B's, nudge within
    // the window, and both merged into one entry that a single Ctrl+Z
    // reverted TOGETHER. This fixture pins the id operand.
    const now = jest.spyOn(Date, 'now').mockReturnValue(50_000);
    const a = seeded.tracks[0].id;
    const b = seeded.tracks[1].id;
    store().setTrackParam(a, { volumeDb: -1 });
    store().setTrackParam(b, { volumeDb: -2 }); // same param, other track, in-window
    expect(doneLabels()).toEqual(['Set track volume', 'Set track volume']);

    undoSession(); // must revert ONLY track B
    const tracks = sessionRef().tracks;
    expect(tracks.find((t) => t.id === a)?.volumeDb).toBe(-1);
    expect(tracks.find((t) => t.id === b)?.volumeDb).toBe(0);
    now.mockRestore();
  });

  it('keyboard slider ticks coalesce per (track, param); pointer-style single commits on another param do not', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(50_000);
    const t1 = seeded.tracks[0].id;
    store().setTrackParam(t1, { volumeDb: -1 });
    store().setTrackParam(t1, { volumeDb: -2 }); // coalesces
    store().setTrackParam(t1, { pan: 0.1 }); // different param -> new entry
    store().setTrackParam(t1, { muted: true }); // toggle -> never coalesces
    store().setTrackParam(t1, { muted: false }); // toggle -> never coalesces
    expect(doneLabels()).toEqual(['Set track volume', 'Set track pan', 'Mute track', 'Unmute track']);

    undoSession(); // un-unmute
    undoSession(); // un-mute
    undoSession(); // un-pan
    undoSession(); // the coalesced volume run undoes as ONE step, to -0 (the seed)
    expect(sessionRef()).toBe(seeded);
    now.mockRestore();
  });
});

describe('F9 cache discipline across undo/redo', () => {
});

describe('a session snapshot retains no audio (the byte-bound question)', () => {
  /** Recursively asserts no ArrayBuffer / TypedArray / DataView is reachable
   * from `value`. Snapshots are references into store state, so walking the
   * live session graph IS walking every entry's retained graph. */
  function assertNoAudioReachable(value: unknown, path: string, seen: Set<object>): void {
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      throw new Error(`audio-bearing object reachable at ${path}`);
    }
    for (const [k, v] of Object.entries(value)) assertNoAudioReachable(v, `${path}.${k}`, seen);
  }

  it('a realistic edited session graph holds only structural data, and its JSON size is a few KB', () => {
    // Build a realistic session THROUGH the store: 8 tracks, 5 clips each
    // with gains and fades, automation on three tracks.
    store().newSession(44100);
    for (let i = 0; i < 4; i++) store().addTrack();
    const tracks = sessionRef().tracks;
    expect(tracks).toHaveLength(8);
    for (const [ti, t] of tracks.entries()) {
      for (let i = 0; i < 5; i++) {
        store().addClip(
          t.id,
          createClip({
            documentId: `doc-${ti}`,
            startSample: i * 50_000,
            offsetSample: 0,
            lengthSample: 48_000,
          })
        );
      }
      const clip = sessionRef().tracks[ti].clips[0];
      store().setClipGain(clip.id, -3);
      store().setClipFade(clip.id, 'in', { lengthSample: 2000, curve: 'equal-gain' });
      store().setClipFade(clip.id, 'out', { lengthSample: 1500 });
    }
    for (const t of sessionRef().tracks.slice(0, 3)) {
      for (let k = 0; k < 12; k++) {
        store().upsertAutomationKey(t.id, 'volumeDb', { positionSample: k * 10_000, value: -k });
        store().upsertAutomationKey(t.id, 'pan', { positionSample: k * 10_000, value: 0 });
      }
    }

    const snapshotGraph = { session: sessionRef(), selectedClipId: store().selectedClipId };
    assertNoAudioReachable(snapshotGraph, 'snapshot', new Set());

    // The measured retained size of one realistic snapshot (structure only;
    // logged for the R3 report). JSON understates per-object overhead by a
    // small constant factor, but the ORDER is what matters next to
    // MAX_UNDO_BYTES = 800 MB: KBs, not MBs — which is why session entries
    // carry no `bytes` (the pushMarkerUndo precedent).
    const jsonBytes = Buffer.byteLength(JSON.stringify(snapshotGraph.session));
    console.info(`R3 measurement: realistic session snapshot JSON = ${jsonBytes} bytes`);
    expect(jsonBytes).toBeGreaterThan(1000); // the fixture is genuinely populated
    expect(jsonBytes).toBeLessThan(64 * 1024); // and structurally tiny vs the byte budget
  });
});
