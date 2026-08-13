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
import { createClip, createTrack } from './session';
import { adoptSessionRate, useSessionStore } from './sessionStore';
import { _resetSessionUndo, undoSession } from './sessionUndo';
import { _resetSessionLaneWidth, FALLBACK_SESSION_LANE_WIDTH } from './sessionViewport';
import { defaultSessionZoom, fitSessionSamplesPerPixel, MT_EMPTY_TIMELINE_SEC } from './sessionZoom';

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
    // The shape `sessionFile`'s Open Session commits: the whole `Session` from
    // the file, its zoom fitted, everything else reset. `formatVersion` is
    // untouched by MT2 — a v3 file written before it loads identically — so
    // what matters is only that the loaded session is empty, and it is asked
    // rather than assumed.
    const loaded = { name: 'From disk', sampleRate: SESSION_RATE, tracks: [createTrack('Track 1')] };
    useSessionStore.setState({
      session: loaded,
      selectedClipId: null,
      mtCursorSample: 0,
      mtZoom: defaultSessionZoom(loaded),
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
