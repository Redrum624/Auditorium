/**
 * MT2-1 — an EMPTY session adopts the rate of the first document inserted into
 * it, through EVERY insert path.
 *
 * The reported defect: "it takes a while to start the play with 2 tracks". The
 * session's rate was chosen once (`makeSession(44100)` at store init) and never
 * adapted, so two 48 kHz files inserted into a default session were converted
 * — every sample of them, through a 64-tap sinc, synchronously inside the Play
 * handler. Measured at 22 039 ms median process-cold (MT1's rig,
 * `docs/bench/mt1-play-latency-44100.json`) against 223 ms for the same build
 * and the same files in a 48 kHz session.
 *
 * The fix is not a faster resample: it is not resampling. A session with no
 * clips has nothing denominated in its own rate that the user chose, so it can
 * take the document's rate instead and place the clip at ratio 1.
 *
 * These tests are the RED for that, one per insert path, plus the boundary the
 * fix must NOT cross: a session that already holds a clip keeps its rate and
 * still converts, because two documents at two rates cannot both be native.
 */
import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { makeInitialState, useAppStore } from '../stores/appStore';
import * as resample from '../dsp/resample';
import { installTestHooks, type TestApi } from '../services/testHooks';
import { runCommand } from '../services/menuActions';
import { _resetClipResampleCache } from './clipResampleCache';
import { placeDocumentClips } from './laneDrop';
import { readClipSlice } from './mixdown';
import { parseSessionFileBytes, serializeSessionV3 } from './sessionFile';
import { createClip, createTrack, type Session } from './session';
import { adoptSessionRate, applySessionZoom, useSessionStore } from './sessionStore';
import { _resetSessionUndo, redoSession, undoSession } from './sessionUndo';
import { _resetSessionLaneWidth, FALLBACK_SESSION_LANE_WIDTH } from './sessionViewport';
import {
  defaultSessionZoom,
  fitSessionSamplesPerPixel,
  MT_EMPTY_TIMELINE_SEC,
  resolveSessionZoom,
} from './sessionZoom';

const DOC_RATE = 48_000;
const SESSION_RATE = 44_100;
/** Two seconds at 48 kHz — short enough for a unit test, long enough that a
 * conversion to 44 100 rounds to a DIFFERENT number (88 200 vs 96 000), so an
 * assertion on `lengthSample` cannot pass by identity. */
const DOC_LEN = 2 * DOC_RATE;

const store = () => useSessionStore.getState();

function api(): TestApi {
  installTestHooks();
  return (window as unknown as { __test: TestApi }).__test;
}

function addDoc(rate = DOC_RATE, length = DOC_LEN): AudioDocument {
  const doc = createDocument({
    name: `song-${rate}`,
    sampleRate: rate,
    channels: [new Float32Array(length), new Float32Array(length)],
  });
  useAppStore.getState().addDocument(doc);
  return doc;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetSessionLaneWidth();
  store().newSession(SESSION_RATE);
  _resetSessionUndo();
});

describe('an empty session adopts the inserted document rate — all three insert paths', () => {
  it('Insert Active File (menuActions) adopts, and the clip lands at ratio 1', async () => {
    useAppStore.getState().setView('multitrack');
    addDoc();
    expect(store().session.sampleRate).toBe(SESSION_RATE);

    await runCommand('multitrack.insertDoc');

    expect(store().session.sampleRate).toBe(DOC_RATE);
    const clips = store().session.tracks.flatMap((t) => t.clips);
    expect(clips).toHaveLength(1);
    expect(clips[0].lengthSample).toBe(DOC_LEN);
  });

  it('a lane drop (laneDrop) adopts, and the clip lands at ratio 1', () => {
    const doc = addDoc();
    const trackId = store().session.tracks[0].id;

    const placed = placeDocumentClips([doc.id], trackId, 0);

    expect(placed).toHaveLength(1);
    expect(store().session.sampleRate).toBe(DOC_RATE);
    expect(store().session.tracks[0].clips[0].lengthSample).toBe(DOC_LEN);
  });

  it('the insertActiveDocAsClip test hook adopts, and the clip lands at ratio 1', () => {
    addDoc();

    const result = api().insertActiveDocAsClip(0, 0);

    expect(result).not.toBeNull();
    expect(store().session.sampleRate).toBe(DOC_RATE);
    expect(result?.lengthSample).toBe(DOC_LEN);
    expect(store().session.tracks[0].clips[0].lengthSample).toBe(DOC_LEN);
  });

  it('reports the SESSION rate to the latency rig, not the rate it was created with', () => {
    // The rig used to compare the rate it passed to `newSession` against the
    // active DOCUMENT's and call the pair "mismatched — resample branch live".
    // After adoption that inference is simply false, so the session's own rate
    // is reported and the rig reads it instead of deducing it.
    addDoc();
    const hooks = api();
    expect(hooks.getStateSummary().sessionSampleRate).toBe(SESSION_RATE);

    hooks.insertActiveDocAsClip(0, 0);

    expect(hooks.getStateSummary().sessionSampleRate).toBe(DOC_RATE);
    expect(hooks.getStateSummary().sampleRate).toBe(DOC_RATE); // the DOC's, which agrees now
  });
});

describe('adoption asks the session what it holds, never where it came from', () => {
  it('a session OPENED from a .audm with no clips adopts on the next insert', () => {
    // T1 (MT2 review, Minor 4) — a REAL v3 round trip, not a hand-built shape.
    // This used to `setState` the object the loader was believed to commit,
    // which inherits the claim "a pre-task v3 file loads identically" instead
    // of pinning it: `formatVersion` is untouched by MT2, but only the actual
    // writer and reader can say that the file still comes back empty, at its
    // own rate, under its own name.
    const onDisk: Session = {
      name: 'From disk',
      sampleRate: SESSION_RATE,
      tracks: [createTrack('Track 1')],
    };
    const { bytes } = serializeSessionV3(onDisk, []);
    const parsed = parseSessionFileBytes(bytes.buffer);
    expect(parsed.session.sampleRate).toBe(SESSION_RATE);
    expect(parsed.session.tracks.flatMap((t) => t.clips)).toHaveLength(0);
    expect(parsed.documents).toHaveLength(0);

    // The rest is exactly what `openSessionViaDialog` commits for the parsed
    // result: the session, its zoom fitted, everything else reset.
    useSessionStore.setState({
      session: parsed.session,
      selectedClipId: null,
      mtCursorSample: 0,
      mtZoom: defaultSessionZoom(parsed.session),
      mtPlayState: 'stopped',
      mtPlayheadSample: 0,
      mtEnvelope: null,
    });

    const doc = addDoc();
    placeDocumentClips([doc.id], store().session.tracks[0].id, 0);

    expect(store().session.name).toBe('From disk');
    expect(store().session.sampleRate).toBe(DOC_RATE);
    expect(store().session.tracks[0].clips[0].lengthSample).toBe(DOC_LEN);
  });
});

describe('a session that already holds a clip never changes rate', () => {
  it('keeps its rate and converts the new clip, so the two clips stay aligned in TIME', () => {
    const trackId = store().session.tracks[0].id;
    // A standing clip, so the session is not empty. One second at the SESSION
    // rate — a length the conversion below cannot coincidentally produce.
    store().addClip(
      trackId,
      createClip({
        documentId: 'doc-standing',
        startSample: 0,
        offsetSample: 0,
        lengthSample: SESSION_RATE,
      })
    );

    const doc = addDoc();
    const placed = placeDocumentClips([doc.id], store().session.tracks[1].id, 0);

    expect(placed).toHaveLength(1);
    expect(store().session.sampleRate).toBe(SESSION_RATE);
    // 96 000 doc samples at 48 kHz == 2 s == 88 200 session samples at 44.1 kHz.
    expect(store().session.tracks[1].clips[0].lengthSample).toBe(
      Math.round((DOC_LEN * SESSION_RATE) / DOC_RATE)
    );
  });
});

describe('adoption converts the session-sample state that exists at adoption time', () => {
  it('moves the multitrack cursor to the same INSTANT in the new rate', () => {
    // One second in, expressed in the old rate. After adoption the same instant
    // is 48 000 — a cursor left at 44 100 would name 0.919 s, and the clip the
    // very next Insert Active File places would land 81 ms early.
    store().setMtCursor(SESSION_RATE);
    const doc = addDoc();

    placeDocumentClips([doc.id], store().session.tracks[0].id, 0);

    expect(store().mtCursorSample).toBe(DOC_RATE);
  });

  it('places the drop position at the same INSTANT it was dropped at', () => {
    // The drop x was resolved to a session sample against the PRE-adoption rate
    // (the lane's pixel mapping at the moment of the drop). Adoption rescales
    // the lane under it, so a start committed verbatim would put the clip
    // 8.8% early — visibly not where it was let go.
    const doc = addDoc();

    placeDocumentClips([doc.id], store().session.tracks[0].id, SESSION_RATE);

    expect(store().session.tracks[0].clips[0].startSample).toBe(DOC_RATE);
  });

  it('the session ends up fitted at the ADOPTED rate after the insert', () => {
    const doc = addDoc();

    placeDocumentClips([doc.id], store().session.tracks[0].id, 0);

    const session = store().session;
    expect(store().mtZoom).toEqual(defaultSessionZoom(session));
    expect(store().mtZoom.samplesPerPixel).toBe(DOC_LEN / FALLBACK_SESSION_LANE_WIDTH);
  });
});

/**
 * `addClip` re-fits after any insert into an empty session, so an insert can
 * never show a stale zoom whatever adoption does with it — which would make an
 * end-to-end zoom assertion vacuous. The conversion is tested where it lives
 * instead: adoption leaves NO session-sample number denominated in the old rate,
 * because the next reader of any of them has no way to know one was left behind.
 */
describe('adoptSessionRate — the conversion itself', () => {
  it('rescales a zoom the user chose so the visible DURATION survives', () => {
    const spp = fitSessionSamplesPerPixel(store().session, FALLBACK_SESSION_LANE_WIDTH) / 10;
    useSessionStore.setState({ mtZoom: { samplesPerPixel: spp, scrollSample: SESSION_RATE } });

    expect(adoptSessionRate(DOC_RATE)).toBe(DOC_RATE / SESSION_RATE);

    expect(store().session.sampleRate).toBe(DOC_RATE);
    expect(store().mtZoom.samplesPerPixel).toBeCloseTo((spp * DOC_RATE) / SESSION_RATE, 6);
    expect(store().mtZoom.scrollSample).toBe(DOC_RATE);
    // And the empty timeline is still MT_EMPTY_TIMELINE_SEC seconds long — in
    // the NEW rate, which is what keeps the rescaled samples/px inside the clamp.
    expect(fitSessionSamplesPerPixel(store().session, FALLBACK_SESSION_LANE_WIDTH)).toBe(
      (MT_EMPTY_TIMELINE_SEC * DOC_RATE) / FALLBACK_SESSION_LANE_WIDTH
    );
  });

  it('moves the live playhead with the cursor', () => {
    useSessionStore.setState({ mtCursorSample: SESSION_RATE, mtPlayheadSample: SESSION_RATE / 2 });

    adoptSessionRate(DOC_RATE);

    expect(store().mtCursorSample).toBe(DOC_RATE);
    expect(store().mtPlayheadSample).toBe(DOC_RATE / 2);
  });

  it('refuses a session that holds a clip, and reports ratio 1', () => {
    const trackId = store().session.tracks[0].id;
    store().addClip(
      trackId,
      createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 1000 })
    );
    store().setMtCursor(SESSION_RATE);

    expect(adoptSessionRate(DOC_RATE)).toBe(1);

    expect(store().session.sampleRate).toBe(SESSION_RATE);
    expect(store().mtCursorSample).toBe(SESSION_RATE);
  });

  it('is a no-op — same session object — when the rates already agree', () => {
    const before = store().session;
    expect(adoptSessionRate(SESSION_RATE)).toBe(1);
    expect(store().session).toBe(before);
  });
});

describe('an insert that CANNOT adopt warms its conversion off the play path', () => {
  it('leaves nothing for play() to resample once the renderer has been idle', () => {
    _resetClipResampleCache();
    jest.useFakeTimers();
    try {
      // A non-empty session at 48 kHz, so the 44.1 kHz document below is a
      // genuine mismatch and adoption correctly refuses. This is the shape MT2-2
      // exists for; the reported flow never reaches it.
      store().newSession(DOC_RATE);
      const standing = addDoc(DOC_RATE, 2000);
      placeDocumentClips([standing.id], store().session.tracks[0].id, 0);

      const odd = addDoc(SESSION_RATE, 2000);
      const spy = jest.spyOn(resample, 'resampleChannel');
      const [placed] = placeDocumentClips([odd.id], store().session.tracks[1].id, 0);
      expect(placed).toBeDefined();
      expect(spy).not.toHaveBeenCalled(); // deferred, never on the insert's tick

      jest.runOnlyPendingTimers();
      expect(spy).toHaveBeenCalled();

      // What play() does, on the exact clip that was placed.
      spy.mockClear();
      const clip = store().session.tracks[1].clips[0];
      readClipSlice(odd, clip, store().session.sampleRate);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('adoption is part of the insert, not a second undo step', () => {
  it('one Ctrl+Z lifts the clip AND the rate together', () => {
    const doc = addDoc();
    placeDocumentClips([doc.id], store().session.tracks[0].id, 0);
    expect(store().session.sampleRate).toBe(DOC_RATE);

    undoSession();

    expect(store().session.sampleRate).toBe(SESSION_RATE);
    expect(store().session.tracks.flatMap((t) => t.clips)).toHaveLength(0);
  });
});

/**
 * MT2 fix round 1 — undoing an adoption must put the DENOMINATOR back too.
 *
 * Adoption is the one mutation in this store that changes what a session sample
 * MEANS, and the undo entry carried only `{session, selectedClipId}` (ruling 3's
 * view-state pin). So the rate reverted while the cursor, the playhead and the
 * zoom stayed in the adopted denomination: a cursor the user placed at 2.000 s
 * in a 44.1 kHz session read 4.35 s after Ctrl+Z of a 96 kHz insert, and the
 * stored `samplesPerPixel` sat above the reverted session's Fit ceiling — the
 * resolve-once/clamp defect family, in the store rather than in a writer.
 *
 * This is NOT ruling 3 being repealed. Ruling 3 says an undo must not restore
 * REMEMBERED view state, because yanking the viewport back buys no
 * comprehension. Keeping the cursor at the same INSTANT across a change of unit
 * is the same intent, not its opposite: it is what "never touched the cursor"
 * MEANS when the ruler underneath it is re-scaled. Same-rate undo — every other
 * entry in the app — still touches none of the three (pinned in
 * `sessionStore.undo.test.ts:241`, and again below).
 */
const HI_RATE = 96_000;
/** 60 s at 96 kHz. Long enough that the fit of the session-with-clip is far
 * COARSER than the empty 44.1 kHz session's fit (4186 vs 1923 samples/px), so a
 * zoom left unconverted is genuinely out of clamp after the undo rather than
 * accidentally legal. */
const HI_LEN = 60 * HI_RATE;

describe('undoing an adopting insert restores the denominator, not just the rate', () => {
  /** Where the cursor is, in SECONDS — the quantity the user chose and the only
   * one that has to survive a change of unit. */
  const cursorSeconds = () => store().mtCursorSample / store().session.sampleRate;

  /** The stored zoom is a FIXED POINT of the one resolver against the live
   * session: re-resolving it changes nothing. That is the precise spelling of
   * "legal, and arrived at through `resolveSessionZoom` rather than written
   * raw" — an out-of-clamp `samplesPerPixel` moves when re-resolved. */
  function expectZoomResolved(): void {
    expect(store().mtZoom).toEqual(resolveSessionZoom(store().session, store().mtZoom));
    expect(store().mtZoom.samplesPerPixel).toBeLessThanOrEqual(
      fitSessionSamplesPerPixel(store().session, FALLBACK_SESSION_LANE_WIDTH)
    );
  }

  it('puts the cursor back at the instant the user chose, in the reverted rate', () => {
    store().setMtCursor(2 * SESSION_RATE); // 88 200 — 2.000 s
    const doc = addDoc(HI_RATE, HI_LEN);

    placeDocumentClips([doc.id], store().session.tracks[0].id, 0);
    expect(store().session.sampleRate).toBe(HI_RATE);
    expect(store().mtCursorSample).toBe(2 * HI_RATE); // still 2.000 s, in 96 kHz
    expect(cursorSeconds()).toBeCloseTo(2, 9);

    undoSession();

    expect(store().session.sampleRate).toBe(SESSION_RATE);
    // The bug: 192 000 left standing under a 44 100 session reads 4.354 s.
    expect(store().mtCursorSample).toBe(2 * SESSION_RATE);
    expect(cursorSeconds()).toBeCloseTo(2, 9);
  });

  it('keeps the visible DURATION the user was looking at', () => {
    const doc = addDoc(HI_RATE, HI_LEN);
    placeDocumentClips([doc.id], store().session.tracks[0].id, 0);
    // Zoom in to a quarter of the fit AFTER the insert — the insert's own re-fit
    // would otherwise own the zoom and make this vacuous. A quarter of a 60 s
    // session is 15 s across the lane.
    applySessionZoom({ samplesPerPixel: store().mtZoom.samplesPerPixel / 4, scrollSample: 0 });
    const visibleSeconds = () =>
      (store().mtZoom.samplesPerPixel * FALLBACK_SESSION_LANE_WIDTH) / store().session.sampleRate;
    expect(visibleSeconds()).toBeCloseTo(15, 6);

    undoSession();

    // The stale samples/px is LEGAL for the reverted session (it is below its
    // Fit ceiling), so the I2 shrink-subscription below has nothing to clamp and
    // the window silently widened from 15 s to 32.7 s. Legality was never the
    // property that mattered here — the denominator was.
    expect(visibleSeconds()).toBeCloseTo(15, 6);
    expectZoomResolved();
  });

  it('leaves a zoom the reverted session can legally hold', () => {
    // The other half of the review finding — and, measured rather than assumed,
    // the half that was ALREADY defended. MT1's I2 subscription re-resolves the
    // zoom whenever the timeline SHRINKS, and an out-of-clamp zoom after a rate
    // revert implies exactly that: the stored samples/px is at most the
    // post-insert fit (== length / laneWidth), so it can only exceed the
    // reverted fit when the reverted length is smaller. There are therefore two
    // independent clamps on this now, and the mutation evidence says so —
    // disabling I2 alone leaves this green, replacing `viewStateAtRate`'s
    // `resolveSessionZoom` with a raw write alone leaves this green, and
    // removing BOTH turns it red. It is kept as the pin on that pair: whichever
    // defence a later change retires, the other has to still be there.
    const doc = addDoc(HI_RATE, HI_LEN);
    placeDocumentClips([doc.id], store().session.tracks[0].id, 0);
    // Fitted to a 60 s clip at 96 kHz — far coarser than anything the empty
    // 44.1 kHz session it is about to revert to may hold.
    expect(store().mtZoom.samplesPerPixel).toBeGreaterThan(
      fitSessionSamplesPerPixel(
        { ...store().session, sampleRate: SESSION_RATE, tracks: [] },
        FALLBACK_SESSION_LANE_WIDTH
      )
    );

    undoSession();

    expectZoomResolved();
  });

  it('carries the live playhead with the cursor, in both directions', () => {
    useSessionStore.setState({ mtPlayheadSample: SESSION_RATE }); // 1.000 s
    const doc = addDoc(HI_RATE, HI_LEN);
    placeDocumentClips([doc.id], store().session.tracks[0].id, 0);
    expect(store().mtPlayheadSample).toBe(HI_RATE);

    undoSession();

    expect(store().mtPlayheadSample).toBe(SESSION_RATE);

    // T1 (MT2 fix-round re-review, nit 3): the REDO hop was inherited from the
    // cursor's own redo assertion and from the shared `viewStateAtRate`, i.e.
    // asserted nowhere. The playhead is the one of the three that moves on its
    // own while the transport runs, so "the cursor's test covers it" is the
    // assumption most worth spending one line on.
    redoSession();

    expect(store().mtPlayheadSample).toBe(HI_RATE);
  });

  /**
   * T1 (MT2 fix-round re-review, nit 2) — THE ONE-SAMPLE FLOOR, pinned as a
   * floor rather than left unstated.
   *
   * `viewStateAtRate` rounds, so `round(round(x·r)/r)` with r < 1 can come back
   * one sample off: the down hop quantises to a coarser grid and the up hop
   * cannot recover which side of it the value came from. Only the exactly
   * round-tripping cursor (88 200 at 44.1 → 96 kHz and back) was asserted, so
   * the tests said nothing about the case that does drift.
   *
   * It is one sample — ~10 µs at 96 kHz, below any edit the surface can express
   * — and it CONVERGES rather than accumulating: the second round trip returns
   * the same pair of values as the first. Both halves are asserted, because
   * "small" and "does not grow" are different claims and only the second one
   * makes it safe to leave alone.
   */
  it('drifts at most one sample when the first hop scales DOWN, and never further', () => {
    store().newSession(HI_RATE); // 96 kHz, empty: the adoption will scale DOWN
    _resetSessionUndo();
    store().setMtCursor(3); // deliberately tiny: the drift is one sample, not one part in N
    const doc = addDoc(SESSION_RATE, SESSION_RATE);

    placeDocumentClips([doc.id], store().session.tracks[0].id, 0);
    expect(store().session.sampleRate).toBe(SESSION_RATE);
    expect(store().mtCursorSample).toBe(1); // round(3 · 44 100/96 000) = round(1.378)

    undoSession();

    // Back at 96 kHz — and at 2, not the 3 the user set: round(1 · 2.1769).
    expect(store().session.sampleRate).toBe(HI_RATE);
    expect(store().mtCursorSample).toBe(2);
    expect(Math.abs(store().mtCursorSample - 3)).toBeLessThanOrEqual(1);

    // ...and it stops there. The pair {1, 2} is a fixed cycle: every further
    // round trip returns the same two numbers, so the error is a floor and not
    // a rate.
    redoSession();
    expect(store().mtCursorSample).toBe(1);
    undoSession();
    expect(store().mtCursorSample).toBe(2);
    redoSession();
    undoSession();
    expect(store().mtCursorSample).toBe(2);
  });

  it('redo lands back in the adopted denomination, coherently', () => {
    store().setMtCursor(2 * SESSION_RATE);
    const doc = addDoc(HI_RATE, HI_LEN);
    placeDocumentClips([doc.id], store().session.tracks[0].id, 0);

    undoSession();
    redoSession();

    expect(store().session.sampleRate).toBe(HI_RATE);
    expect(store().session.tracks[0].clips).toHaveLength(1);
    expect(store().mtCursorSample).toBe(2 * HI_RATE);
    expect(cursorSeconds()).toBeCloseTo(2, 9);
    expectZoomResolved();
  });

  it('survives the round trip — undo/redo/undo returns the same instant, not a drift', () => {
    store().setMtCursor(2 * SESSION_RATE);
    const doc = addDoc(HI_RATE, HI_LEN);
    placeDocumentClips([doc.id], store().session.tracks[0].id, 0);

    undoSession();
    redoSession();
    undoSession();

    expect(store().mtCursorSample).toBe(2 * SESSION_RATE);
    expectZoomResolved();
  });

  it('a SAME-RATE undo still touches none of the three (ruling 3 stands)', () => {
    // The exception is scoped to a change of denominator, and this is the arm
    // that says so: an ordinary edit's undo leaves the viewport exactly where
    // the user left it, cursor and zoom and playhead alike.
    const doc = addDoc(SESSION_RATE, SESSION_RATE);
    placeDocumentClips([doc.id], store().session.tracks[0].id, 0);
    expect(store().session.sampleRate).toBe(SESSION_RATE); // nothing adopted

    store().setMtCursor(7777);
    store().setMtZoom({ samplesPerPixel: 64, scrollSample: 42 });
    store().setMtPlayheadSample(1234);

    undoSession();

    expect(store().mtCursorSample).toBe(7777);
    expect(store().mtZoom).toEqual({ samplesPerPixel: 64, scrollSample: 42 });
    expect(store().mtPlayheadSample).toBe(1234);
  });
});
