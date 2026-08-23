/**
 * The v1.5 test hooks must return PLAIN JSON (Task T16).
 *
 * `window.__test` is only ever read across Playwright's `page.evaluate`
 * boundary, which serialises with structured clone: a typed array that leaks
 * out of a hook does not throw — it silently arrives on the harness side as an
 * object keyed by index, and the smoke's numeric assertions then compare
 * against `undefined` or `NaN`. Nothing in the app catches that, so it is
 * pinned here instead: every hook's result must survive a JSON round trip
 * unchanged (`toStrictEqual` also fails on a class mismatch, which is exactly
 * what an escaped `Int32Array`/`Float32Array` is).
 */

import { installTestHooks, type TestApi } from './testHooks';
import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { makeInitialState, useAppStore } from '../stores/appStore';
import type { TempoEntry } from './tempoAnalysis';
import * as tempoAnalysis from './tempoAnalysis';
import * as tempoService from './tempoService';
import * as remixService from './remixService';
import * as beatGrid from './beatGrid';
import type { BeatGrid } from './beatGrid';
import { isBeatGridVisible, setBeatGridVisible } from './beatGridDisplay';
import { SNAP_TOLERANCE_PX } from './snap';
import { _resetSnapPreference, isSnapEnabled } from './snapPreference';
import { CONFIDENCE_LOW } from '../dsp/tempoCore';
import { useSessionStore } from '../multitrack/sessionStore';
import { createClip, createTrack, type Session } from '../multitrack/session';
import { serializeSession, serializeSessionV4 } from '../multitrack/sessionFile';
import { _resetSessionUndo, isSessionDirty } from '../multitrack/sessionUndo';
import { mixdownSession } from '../multitrack/mixdown';
import { decodeWav } from '../audio/wavCodec';
import { defaultSessionZoom } from '../multitrack/sessionZoom';
import {
  FALLBACK_SESSION_LANE_WIDTH,
  _resetSessionLaneWidth,
} from '../multitrack/sessionViewport';

function api(): TestApi {
  installTestHooks();
  return (window as unknown as { __test: TestApi }).__test;
}

function addDoc(name: string): AudioDocument {
  const doc = createDocument({
    name,
    sampleRate: 44100,
    channels: [new Float32Array(4410), new Float32Array(4410)],
  });
  useAppStore.getState().addDocument(doc);
  return doc;
}

/** A full `TempoEntry` — typed arrays included, which is the point: the hook
 * has to read scalars off them rather than hand them out. */
function tempoEntry(): TempoEntry {
  return {
    bpm: 120,
    confidence: 0.93,
    beatSamples: Int32Array.from([1024, 23074, 45124]),
    salience: 0.7,
    peakRatio: 2.1,
    ibiCv: 0.01,
    truncated: false,
    analyzedEndSample: 4410,
    odf: new Float32Array([0, 1, 0]),
    periodFrames: 43,
    decimationFactor: 4,
    bands: new Float32Array(0),
    numBands: 0,
    odfLow: new Float32Array(0),
    stale: false,
  };
}

/** `expect(JSON.parse(JSON.stringify(x))).toStrictEqual(x)` — the leak test. */
function expectPlainJson(value: unknown): void {
  expect(JSON.parse(JSON.stringify(value))).toStrictEqual(value);
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  jest.restoreAllMocks();
});

describe('detectTempo', () => {
  test('flattens the analysis entry to plain JSON', async () => {
    const doc = addDoc('beat120');
    const spy = jest
      .spyOn(tempoAnalysis, 'runTempoAnalysis')
      .mockResolvedValue(tempoEntry());

    const result = await api().detectTempo();

    expect(spy).toHaveBeenCalledWith(doc);
    expect(result).toStrictEqual({
      bpm: 120,
      confidence: 0.93,
      beatCount: 3,
      firstBeatSample: 1024,
      stale: false,
    });
    expectPlainJson(result);
  });

  test('reports an empty result with no document, without calling the service', async () => {
    const spy = jest.spyOn(tempoAnalysis, 'runTempoAnalysis');
    const result = await api().detectTempo();
    expect(spy).not.toHaveBeenCalled();
    expect(result).toStrictEqual({
      bpm: null,
      confidence: 0,
      beatCount: 0,
      firstBeatSample: null,
      stale: false,
    });
    expectPlainJson(result);
  });

  test('firstBeatSample is null when nothing was tracked', async () => {
    addDoc('silence');
    jest
      .spyOn(tempoAnalysis, 'runTempoAnalysis')
      .mockResolvedValue({ ...tempoEntry(), bpm: null, beatSamples: new Int32Array(0) });
    const result = await api().detectTempo();
    expect(result.bpm).toBeNull();
    expect(result.beatCount).toBe(0);
    expect(result.firstBeatSample).toBeNull();
    expectPlainJson(result);
  });
});

describe('changeTempo', () => {
  test('forwards the BPM pair and reports the resulting length', async () => {
    addDoc('beat120');
    const spy = jest
      .spyOn(tempoService, 'applyTempoChange')
      .mockResolvedValue({ ok: true });

    const result = await api().changeTempo(120, 90);

    expect(spy).toHaveBeenCalledWith({ sourceBpm: 120, targetBpm: 90 });
    expect(result).toStrictEqual({ ok: true, length: 4410 });
    expectPlainJson(result);
  });

  test('passes a refusal through as ok:false', async () => {
    addDoc('beat120');
    jest
      .spyOn(tempoService, 'applyTempoChange')
      .mockResolvedValue({ ok: false, reason: 'out-of-range' });
    const result = await api().changeTempo(120, 10);
    expect(result).toStrictEqual({ ok: false, length: 4410 });
    expectPlainJson(result);
  });
});

describe('remixToDuration', () => {
  test('converts seconds to the source sample clock and summarises the remix', async () => {
    const source = addDoc('abab120');
    const remixDoc = createDocument({
      name: 'Remix 1',
      sampleRate: 44100,
      channels: [new Float32Array(88200), new Float32Array(88200)],
    });
    useAppStore.getState().addDocument(remixDoc);
    useAppStore.getState().setActiveDocument(source.id);

    const joins = [
      { fromBar: 8, toBar: 16, cost: { timbre: 0.1, chroma: 0.2, loudness: 0, rhythm: 0, struct: 0, phrase: 0, total: 0.3 } },
    ];
    const create = jest.spyOn(remixService, 'createRemixDocument').mockResolvedValue({
      ok: true,
      remixDocId: remixDoc.id,
      plan: { joins } as never,
    });
    jest.spyOn(remixService, 'getRemixSession').mockReturnValue({
      analysis: { bpm: 119.9998, numBars: 31 },
      plan: { joins },
      joinSamples: [44100],
    } as never);

    const result = await api().remixToDuration(2, { phraseBars: 8, strict: true });

    expect(create).toHaveBeenCalledWith({
      sourceDocId: source.id,
      targetSample: 88200,
      phraseBars: 8,
      strict: true,
    });
    expect(result).toStrictEqual({
      ok: true,
      status: 'ok',
      name: 'Remix 1',
      length: 88200,
      sampleRate: 44100,
      joins: 1,
      achievedSeconds: 2,
      targetSeconds: 2,
      bpm: 119.9998,
      bars: 31,
    });
    expectPlainJson(result);
  });

  test('passes a planner refusal through as plain JSON', async () => {
    addDoc('abab120');
    jest.spyOn(remixService, 'createRemixDocument').mockResolvedValue({
      ok: false,
      status: 'too-short',
      message: 'below the shortest reachable arrangement',
    });
    const result = await api().remixToDuration(4);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('too-short');
    expect(result.targetSeconds).toBe(4);
    expectPlainJson(result);
  });

  test('reports no-document rather than throwing when nothing is open', async () => {
    const spy = jest.spyOn(remixService, 'createRemixDocument');
    const result = await api().remixToDuration(30);
    expect(spy).not.toHaveBeenCalled();
    expect(result.status).toBe('no-document');
    expectPlainJson(result);
  });
});

describe('getRemixJoins', () => {
  test('flattens each join to its bars, output position and scalar cost', () => {
    const remixDoc = addDoc('Remix 1');
    const joins = [
      { fromBar: 8, toBar: 16, cost: { timbre: 0.1, chroma: 0.2, loudness: 0.05, rhythm: 0.02, struct: 0, phrase: 0, total: 0.31 } },
      { fromBar: 24, toBar: 4, cost: { timbre: 0.4, chroma: 0.3, loudness: 0.1, rhythm: 0.2, struct: 0.5, phrase: 0, total: 1.24 } },
    ];
    jest.spyOn(remixService, 'getRemixSession').mockReturnValue({
      plan: { joins },
      joinSamples: [352800, 705600],
    } as never);

    const result = api().getRemixJoins();

    expect(result).toStrictEqual([
      { fromBar: 8, toBar: 16, atSample: 352800, cost: 0.31 },
      { fromBar: 24, toBar: 4, atSample: 705600, cost: 1.24 },
    ]);
    expectPlainJson(result);
  });

  test('is null for a document that is not a remix, and with nothing open', () => {
    addDoc('plain');
    jest.spyOn(remixService, 'getRemixSession').mockReturnValue(null);
    expect(api().getRemixJoins()).toBeNull();

    useAppStore.setState(makeInitialState());
    expect(api().getRemixJoins()).toBeNull();
  });
});

describe('getRemixPinState (R4b)', () => {
  test('flattens the session pin state, including the planner report', () => {
    addDoc('Remix 1');
    jest.spyOn(remixService, 'getRemixSession').mockReturnValue({
      lockedJoins: ['8>16', '24>4'],
      lockedJoinsDropped: ['24>4'],
      pinReport: {
        mode: 'enforced',
        satisfied: ['8>16'],
        dropped: [{ key: '24>4', reason: 'incompatible' }],
      },
      rollIndex: 2,
      plansInWorker: true,
    } as never);

    const result = api().getRemixPinState();

    expect(result).toStrictEqual({
      lockedJoins: ['8>16', '24>4'],
      lockedJoinsDropped: ['24>4'],
      pinMode: 'enforced',
      pinSatisfied: ['8>16'],
      pinDropped: [{ key: '24>4', reason: 'incompatible' }],
      rollIndex: 2,
      plansInWorker: true,
    });
    // Crosses `page.evaluate`'s structured clone in the smoke, so it must be
    // plain JSON — no Set, no typed array, no class instance.
    expectPlainJson(result);
  });

  test('reports a session with no pins as an empty state, not as null', () => {
    addDoc('Remix 1');
    jest.spyOn(remixService, 'getRemixSession').mockReturnValue({
      lockedJoins: [],
      lockedJoinsDropped: [],
      pinReport: null,
      rollIndex: 0,
      plansInWorker: false,
    } as never);

    expect(api().getRemixPinState()).toStrictEqual({
      lockedJoins: [],
      lockedJoinsDropped: [],
      pinMode: null,
      pinSatisfied: [],
      pinDropped: [],
      rollIndex: 0,
      plansInWorker: false,
    });
  });

  test('is null for a document that is not a remix, and with nothing open', () => {
    addDoc('plain');
    jest.spyOn(remixService, 'getRemixSession').mockReturnValue(null);
    expect(api().getRemixPinState()).toBeNull();

    useAppStore.setState(makeInitialState());
    expect(api().getRemixPinState()).toBeNull();
  });

  test('copies the arrays — a caller cannot mutate the live session through them', () => {
    addDoc('Remix 1');
    const session = {
      lockedJoins: ['8>16'],
      lockedJoinsDropped: [],
      pinReport: { mode: 'enforced', satisfied: ['8>16'], dropped: [] },
      rollIndex: 0,
      plansInWorker: false,
    };
    jest.spyOn(remixService, 'getRemixSession').mockReturnValue(session as never);

    const result = api().getRemixPinState()!;
    result.lockedJoins.push('99>100');

    expect(session.lockedJoins).toEqual(['8>16']);
  });
});

describe('toggleBeatGrid / getBeatGridState (Task B2)', () => {
  function fullGrid(over: Partial<BeatGrid> = {}): BeatGrid {
    return {
      beatSamples: Int32Array.from([0, 22050, 44100, 66150]),
      sampleRate: 44100,
      beatsPerBar: 2,
      downbeatPhase: 0,
      barCount: 1,
      confidence: 0.93,
      stale: false,
      analyzedEndSample: 88200,
      truncated: false,
      origin: 'own',
      originDocId: 'x',
      originOpen: true,
      ...over,
    };
  }

  afterEach(() => {
    setBeatGridVisible(true); // module-level preference: restore the default
  });

  test('toggleBeatGrid flips the preference and returns the new value', () => {
    const hooks = api();
    expect(hooks.toggleBeatGrid()).toBe(false);
    expect(isBeatGridVisible()).toBe(false);
    expect(hooks.toggleBeatGrid()).toBe(true);
    expect(isBeatGridVisible()).toBe(true);
  });

  test('getBeatGridState flattens the grid to plain JSON — no Int32Array escapes', () => {
    addDoc('beat120');
    jest.spyOn(beatGrid, 'getBeatGrid').mockReturnValue(fullGrid());

    const result = api().getBeatGridState();

    expect(result).toStrictEqual({
      visible: true,
      hasGrid: true,
      beatCount: 4,
      firstBeatSample: 0,
      lastBeatSample: 66150,
      downbeatCount: 2, // beats 0 and 2, with beatsPerBar 2 and barCount 1
      beatsPerBar: 2,
      provisional: false,
      stale: false,
      confidence: 0.93,
      analyzedEndSample: 88200,
      origin: 'own',
    });
    expectPlainJson(result);
  });

  test('reports no downbeats when no metre was measured', () => {
    addDoc('beat120');
    jest
      .spyOn(beatGrid, 'getBeatGrid')
      .mockReturnValue(fullGrid({ beatsPerBar: null, downbeatPhase: null, barCount: 0 }));

    const result = api().getBeatGridState();
    expect(result.downbeatCount).toBe(0);
    expect(result.beatsPerBar).toBeNull();
    expectPlainJson(result);
  });

  test('reports a stale or low-confidence grid as provisional', () => {
    addDoc('beat120');
    const spy = jest.spyOn(beatGrid, 'getBeatGrid');

    spy.mockReturnValue(fullGrid({ stale: true }));
    expect(api().getBeatGridState().provisional).toBe(true);

    spy.mockReturnValue(fullGrid({ confidence: CONFIDENCE_LOW - 0.01 }));
    expect(api().getBeatGridState().provisional).toBe(true);

    spy.mockReturnValue(fullGrid({ confidence: CONFIDENCE_LOW }));
    expect(api().getBeatGridState().provisional).toBe(false);
  });

  test('is an empty, plain-JSON report with no grid and with nothing open', () => {
    addDoc('plain');
    jest.spyOn(beatGrid, 'getBeatGrid').mockReturnValue(null);
    const noGrid = api().getBeatGridState();
    expect(noGrid.hasGrid).toBe(false);
    expect(noGrid.beatCount).toBe(0);
    expect(noGrid.firstBeatSample).toBeNull();
    expect(noGrid.origin).toBeNull();
    expectPlainJson(noGrid);

    useAppStore.setState(makeInitialState());
    const closed = api().getBeatGridState();
    expect(closed.hasGrid).toBe(false);
    expectPlainJson(closed);
  });

  test('still reports the visibility preference when there is no grid to draw', () => {
    const hooks = api();
    jest.spyOn(beatGrid, 'getBeatGrid').mockReturnValue(null);
    hooks.toggleBeatGrid();
    expect(hooks.getBeatGridState().visible).toBe(false);
  });
});
describe('toggleSnap / getSnapState (Task B4)', () => {
  afterEach(() => _resetSnapPreference());

  test('toggleSnap flips the preference and returns the new value', () => {
    const hooks = api();
    expect(hooks.toggleSnap()).toBe(false);
    expect(isSnapEnabled()).toBe(false);
    expect(hooks.toggleSnap()).toBe(true);
    expect(isSnapEnabled()).toBe(true);
  });

  test('getSnapState reports the targets as plain JSON scalars — no Int32Array escapes', () => {
    const doc = addDoc('beat120');
    jest.spyOn(beatGrid, 'getBeatGrid').mockReturnValue({
      beatSamples: Int32Array.from([0, 22050, 44100]),
      sampleRate: 44100,
      beatsPerBar: null,
      downbeatPhase: null,
      barCount: 0,
      confidence: 0.9,
      stale: false,
      analyzedEndSample: 88200,
      truncated: false,
      origin: 'own',
      originDocId: doc.id,
      originOpen: true,
    });

    const result = api().getSnapState();
    expect(result).toStrictEqual({
      enabled: true,
      tolerancePx: SNAP_TOLERANCE_PX,
      targetCount: 3,
      firstTargetSample: 0,
      lastTargetSample: 44100,
    });
    expectPlainJson(result);
  });

  test('reports an empty target set when the magnet is off, and with nothing open', () => {
    addDoc('beat120');
    const hooks = api();
    jest.spyOn(beatGrid, 'getBeatGrid').mockReturnValue(null);

    hooks.toggleSnap();
    const off = hooks.getSnapState();
    expect(off.enabled).toBe(false);
    expect(off.targetCount).toBe(0);
    expect(off.firstTargetSample).toBeNull();
    expectPlainJson(off);

    _resetSnapPreference();
    useAppStore.setState(makeInitialState());
    const closed = api().getSnapState();
    expect(closed.enabled).toBe(true);
    expect(closed.targetCount).toBe(0);
    expectPlainJson(closed);
  });

  test('there is deliberately no hook that PERFORMS a snap', () => {
    // A `snapCursorTo(x)` hook would let a smoke assertion pass without the
    // gesture layer ever running the magnet (plan trap 28). Anything asserting
    // the magnet must drive real pointer events.
    const hooks = api() as unknown as Record<string, unknown>;
    expect(hooks.snapCursorTo).toBeUndefined();
    expect(hooks.snapSample).toBeUndefined();
  });
});

describe('getEditorViewState (Task B5)', () => {
  test('reports the cursor, selection and pixel↔sample mapping as plain JSON', () => {
    addDoc('beat120');
    const store = useAppStore.getState();
    store.setZoom({ samplesPerPixel: 221, scrollSample: 4410 });
    store.setCursor(22051);
    store.setSelection({ start: 1000, end: 2000 });

    const result = api().getEditorViewState();
    expect(result).toStrictEqual({
      cursorSample: 22051,
      selectionStart: 1000,
      selectionEnd: 2000,
      samplesPerPixel: 221,
      scrollSample: 4410,
    });
    expectPlainJson(result);
  });

  test('reports nulls for the selection when there is none, and observes without mutating', () => {
    addDoc('beat120');
    const hooks = api();
    useAppStore.getState().setSelection(null);
    const before = useAppStore.getState();

    const result = hooks.getEditorViewState();
    expect(result.selectionStart).toBeNull();
    expect(result.selectionEnd).toBeNull();
    expectPlainJson(result);

    // A pure observer: reading it changes nothing the gesture layer depends on.
    const after = useAppStore.getState();
    expect(after.cursorSample).toBe(before.cursorSample);
    expect(after.selection).toBe(before.selection);
    expect(after.zoom).toBe(before.zoom);
  });
});

// ---------------------------------------------------------------------------
// MT1 fix round (C1) — the harness's own session-open path opens FITTED
// ---------------------------------------------------------------------------
/*
 * `openSessionFrom` is the fourth of the four session-load paths the MT1-1
 * changelog claimed routed through the resolved zoom, and the third that did
 * not: it wrote `{ samplesPerPixel: 512 }` by hand through `setState`,
 * bypassing `applySessionZoom`.
 *
 * This one matters beyond tidiness. It is the hook the Playwright smoke and the
 * navigation walker use to open a session, so every rig assertion ever made
 * about what the multitrack looks like was made against a zoom no user would
 * ever see. A rig that cannot reproduce the user's view cannot catch the user's
 * bug — and did not.
 */
describe('MT1 C1: openSessionFrom opens the session fitted', () => {
  it('lays the longest track across the lane instead of the hardcoded 512', async () => {
    _resetSessionLaneWidth();
    const LEN = Math.round(178 * 44100); // 2:58, the reported session's length
    const doc = createDocument({
      name: 'song.wav',
      sampleRate: 44100,
      channels: [new Float32Array(64)],
    });
    const track = createTrack('Long Track');
    track.clips = [
      createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: LEN }),
    ];
    const session: Session = { name: 'Long Session', sampleRate: 44100, tracks: [track] };
    const { json } = serializeSession(session, [doc]);
    const bytes = new TextEncoder().encode(json);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      readFile: async () => bytes.buffer,
    };

    await api().openSessionFrom('session.audm');

    const loaded = useSessionStore.getState();
    expect(loaded.mtZoom).toEqual(defaultSessionZoom(loaded.session));
    expect(loaded.mtZoom.samplesPerPixel).toBe(LEN / FALLBACK_SESSION_LANE_WIDTH);
    expect(loaded.mtZoom.scrollSample).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Lot A — the project hooks the smoke drives headlessly. `saveSessionAs` IS
// Save As (v4 bytes, path, save points, rename); `openSessionFrom` IS Open
// Project. Lots C, D and E append their own describes below; never edit
// another lot's.
// ---------------------------------------------------------------------------
describe('lot A project hooks', () => {
  function installProjectApi(overrides: Record<string, unknown> = {}) {
    const electronAPI = {
      readFile: jest.fn(async () => new ArrayBuffer(0)),
      writeFile: jest.fn(async () => ({ ok: true })),
      showMessageBox: jest.fn(async () => 0),
      pathBasename: (p: string) => p.split(/[\\/]/).pop() ?? p,
      ...overrides,
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = electronAPI;
    return electronAPI;
  }

  beforeEach(() => {
    useSessionStore.getState().newSession(44100);
    useSessionStore.getState().setProjectPath(null);
    _resetSessionUndo();
  });

  it('saveSessionAs writes AUDM4 bytes, remembers the path, renames the project to the basename and leaves it clean', async () => {
    const electronAPI = installProjectApi();
    addDoc('a.wav');

    const ok = await api().saveSessionAs('D:\\out\\take 3.audm');

    expect(ok).toBe(true);
    const [path, data] = electronAPI.writeFile.mock.calls[0] as unknown as [string, ArrayBuffer];
    expect(path).toBe('D:\\out\\take 3.audm');
    expect(new TextDecoder().decode(new Uint8Array(data).subarray(0, 6))).toBe('AUDM4\n');
    expect(useSessionStore.getState().projectPath).toBe('D:\\out\\take 3.audm');
    expect(useSessionStore.getState().session.name).toBe('take 3');
    expect(isSessionDirty()).toBe(false);
    expect(useAppStore.getState().documents[0].neverSaved).toBe(false);
    expect(electronAPI.showMessageBox).not.toHaveBeenCalled();
  });

  it('openSessionFrom restores a v4 project, sets projectPath and returns the same summary shape', async () => {
    const doc = createDocument({ name: 'song.wav', sampleRate: 44100, channels: [new Float32Array(64)] });
    const track = createTrack('T');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 64 })];
    const session: Session = { name: 'Proj', sampleRate: 44100, tracks: [track] };
    const { bytes } = serializeSessionV4(session, [doc]);
    installProjectApi({ readFile: jest.fn(async () => bytes.buffer) });

    const summary = await api().openSessionFrom('D:\\in\\proj.audm');

    expectPlainJson(summary);
    expect(summary).toEqual({ docCount: 1, trackCount: 1, droppedClipCount: 0 });
    expect(useSessionStore.getState().projectPath).toBe('D:\\in\\proj.audm');
    expect(useSessionStore.getState().session.name).toBe('Proj');
    expect(useSessionStore.getState().mtZoom).toEqual(defaultSessionZoom(useSessionStore.getState().session));
    expect(isSessionDirty()).toBe(false);
    expect(useAppStore.getState().view).toBe('multitrack');
  });

  // `getStateSummary` is how the navigate walk reads project state back
  // (`scripts/e2e-navigate.cjs:2807` asserts the Save As cancel left the path
  // null). It is the one field of the summary no unit test covered, so a
  // dropped line there would only ever surface in lot F's packaged run.
  it('getStateSummary reports projectPath — null while the project was never written, the path after a save and after an open', async () => {
    installProjectApi();
    addDoc('a.wav');

    expect(api().getStateSummary().projectPath).toBeNull();
    expectPlainJson(api().getStateSummary());

    await api().saveSessionAs('D:\\out\\take 3.audm');
    expect(api().getStateSummary().projectPath).toBe('D:\\out\\take 3.audm');

    const doc = createDocument({ name: 'song.wav', sampleRate: 44100, channels: [new Float32Array(64)] });
    const session: Session = { name: 'Proj', sampleRate: 44100, tracks: [createTrack('T')] };
    const { bytes } = serializeSessionV4(session, [doc]);
    installProjectApi({ readFile: jest.fn(async () => bytes.buffer) });
    await api().openSessionFrom('D:\\in\\proj.audm');

    expect(api().getStateSummary().projectPath).toBe('D:\\in\\proj.audm');
  });

  it('exportSession writes bytes whose decoded channels equal mixdownSession, and returns false with an info box on an all-muted session', async () => {
    const electronAPI = installProjectApi();
    const doc = addDoc('a.wav');
    doc.channels[0].set(Float32Array.from({ length: 4410 }, (_, i) => Math.sin(i / 7) * 0.5));
    const s = useSessionStore.getState();
    const [tA, tB] = s.session.tracks;
    const clip = createClip({ documentId: doc.id, startSample: 10, offsetSample: 0, lengthSample: 4000 });
    s.addClip(tA.id, clip);
    s.setClipFade(clip.id, 'out', { lengthSample: 100 });
    s.setTrackParam(tB.id, { muted: true });
    const expected = mixdownSession(
      useSessionStore.getState().session,
      new Map(useAppStore.getState().documents.map((d) => [d.id, d] as const))
    );

    const ok = await api().exportSession({ format: 'wav', wavBitDepth: 32, mp3Kbps: 192 }, 'D:\\out\\mix.wav');

    expect(ok).toBe(true);
    const [path, data] = electronAPI.writeFile.mock.calls[0] as unknown as [string, ArrayBuffer];
    expect(path).toBe('D:\\out\\mix.wav');
    const decoded = decodeWav(data);
    expect(decoded.sampleRate).toBe(44100);
    expect(decoded.channels[0]).toEqual(expected.channels[0]);
    expect(decoded.channels[1]).toEqual(expected.channels[1]);
    expect(decoded.channels[0].length).toBe(4010);

    useSessionStore.getState().setTrackParam(tA.id, { muted: true });
    const silent = await api().exportSession({ format: 'wav', wavBitDepth: 32, mp3Kbps: 192 }, 'D:\\out\\none.wav');

    expect(silent).toBe(false);
    expect(electronAPI.writeFile).toHaveBeenCalledTimes(1);
    expect(electronAPI.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', message: 'Nothing audible to export.' })
    );
  });
});

describe('lot C editor hooks', () => {
  function openRamp(): AudioDocument {
    const doc = createDocument({
      name: 'lot-c.wav',
      sampleRate: 44100,
      channels: [Float32Array.from({ length: 1000 }, (_, i) => i + 1)],
    });
    useAppStore.getState().addDocument(doc);
    return doc;
  }

  it('setCursor / getCursor address the document cursor', () => {
    const t = api();
    openRamp();
    expect(t.setCursor(123)).toBe(123);
    expect(t.getCursor()).toBe(123);
    expect(useAppStore.getState().cursorSample).toBe(123);
  });

  it("editOp('split') with a selection drops a marker at each edge", () => {
    const t = api();
    openRamp();
    t.setSelection(200, 300);
    t.editOp('split');
    expect(t.getActiveMarkers().map((m) => m.positionSample)).toEqual([200, 300]);
  });

  it("editOp('rippleDelete') shortens the document", () => {
    const t = api();
    openRamp();
    t.setSelection(0, 10);
    t.editOp('rippleDelete');
    expect(t.getStateSummary().length).toBe(990);
  });
});

/**
 * Lot E (item 4, N14) — `__test.setView` stays the RAW setter. The navigate
 * walk calls it right after a real click selected a clip; routing it through
 * `showEditorView` would activate that clip's document mid-walk.
 */
describe('lot E view entry', () => {
  test('__test.setView leaves the active document and selection alone', () => {
    const a = addDoc('A');
    const b = addDoc('B');
    useAppStore.getState().setActiveDocument(a.id);
    const clip = createClip({ documentId: b.id, startSample: 0, offsetSample: 0, lengthSample: 1000 });
    const track = createTrack('Track 1');
    track.clips = [clip];
    const session: Session = { name: 'Pin', sampleRate: 44100, tracks: [track] };
    useSessionStore.setState({
      session,
      selectedClipId: clip.id,
      selectedClipIds: [clip.id],
      mtCursorSample: 0,
      mtPlayState: 'stopped',
      mtPlayheadSample: 0,
      mtEnvelope: null,
    });
    useAppStore.setState({ view: 'multitrack' });

    api().setView('waveform');

    const s = useAppStore.getState();
    expect(s.view).toBe('waveform');
    expect(s.activeDocumentId).toBe(a.id);
    expect(s.selection).toBeNull();
  });
});

describe('lot D session hooks', () => {
  /** One track carrying `[0, 1000)` and `[2000, 1000)`, installed raw. */
  function seedClips(): string[] {
    const t = createTrack('Track 1');
    t.clips = [
      createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 1000 }),
      createClip({ documentId: 'doc-1', startSample: 2000, offsetSample: 0, lengthSample: 1000 }),
    ];
    useSessionStore.setState({
      session: { name: 'Hook Fixture', sampleRate: 44100, tracks: [t] },
      selectedClipId: null,
      selectedClipIds: [],
      mtCursorSample: 0,
    });
    return t.clips.map((c) => c.id);
  }

  it('setMtCursor / getMtCursor address the MULTITRACK edit cursor', () => {
    const t = api();
    expect(t.setMtCursor(1234)).toBe(1234);
    expect(t.getMtCursor()).toBe(1234);
    expect(useSessionStore.getState().mtCursorSample).toBe(1234);
  });

  it('selectClips names the clip selection, dropping dangling ids and duplicates', () => {
    const t = api();
    const [a] = seedClips();
    expect(t.selectClips([a, 'clip-none', a])).toEqual({
      selectedClipId: a,
      selectedClipIds: [a],
    });
    expect(useSessionStore.getState().selectedClipIds).toEqual([a]);
  });

  it('selectClips([]) clears it', () => {
    const t = api();
    const [a, b] = seedClips();
    t.selectClips([a, b]);
    expect(t.selectClips([])).toEqual({ selectedClipId: null, selectedClipIds: [] });
  });
});

describe('lot F integration hooks', () => {
  it('activateDocumentByName activates the index-th document with that exact name and counts the matches', () => {
    const a = addDoc('take.wav');
    const b = addDoc('other.wav');
    expect(useAppStore.getState().activeDocumentId).toBe(b.id);

    expect(api().activateDocumentByName('take.wav')).toBe(1);
    expect(useAppStore.getState().activeDocumentId).toBe(a.id);

    const a2 = addDoc('take.wav');
    expect(api().activateDocumentByName('take.wav', 1)).toBe(2);
    expect(useAppStore.getState().activeDocumentId).toBe(a2.id);
    expect(api().activateDocumentByName('take.wav', 5)).toBe(2);
    expect(useAppStore.getState().activeDocumentId).toBe(a2.id);

    expect(api().activateDocumentByName('missing.wav')).toBe(0);
    expect(useAppStore.getState().activeDocumentId).toBe(a2.id);
  });
});
