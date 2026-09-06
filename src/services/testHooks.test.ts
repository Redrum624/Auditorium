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

import {
  installTestHooks,
  peakOutsideSpans,
  syntheticSpeakerEvidence,
  HOOK_TURN_FRAMES,
  type TestApi,
} from './testHooks';
import { registerAllEffects } from '../effects/registerAll';
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
import { SESSION_UNDO_KEY, _resetSessionUndo, isSessionDirty } from '../multitrack/sessionUndo';
import { closeGap } from '../multitrack/sessionStore'; // D3
import { getHistory } from './undoHistory';
import { mixdownSession } from '../multitrack/mixdown';
import { decodeWav } from '../audio/wavCodec';
import { defaultSessionZoom } from '../multitrack/sessionZoom';
import {
  FALLBACK_SESSION_LANE_WIDTH,
  _resetSessionLaneWidth,
} from '../multitrack/sessionViewport';
import {
  assembleDiarization,
  segmentsToDocSamples,
  FRAME_SHIFT,
  MIN_CLUSTER_SIZE,
  MIN_EMBED_FRAMES,
  SEG_FRAMES,
  SEG_SHIFT,
  SEG_WINDOW,
} from '../dsp/diarization';
import * as spanMask from '../dsp/spanMask';
import { cancelDiarization } from './diarizeService';
import {
  classWindow,
  installDiarizeBackend,
  speakerVector,
  uninstallDiarizeBackend,
  WIRE_MODEL_BYTES,
  WIRE_WINDOW_FRAMES,
  type DiarizeBackend,
} from '../__mocks__/diarizeBackend';

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

  it('getMtZoom reports the multitrack viewport, as a COPY', () => {
    // D1 — the pair the smoke computes the bar's on-screen x from. Non-default
    // values on purpose: a hook that answered `defaultSessionZoom` regardless
    // would pass against the store's own initial state.
    const t = api();
    seedClips();
    useSessionStore.setState({ mtZoom: { samplesPerPixel: 64, scrollSample: 12800 } });

    const zoom = t.getMtZoom();

    expect(zoom).toEqual({ samplesPerPixel: 64, scrollSample: 12800 });
    expectPlainJson(zoom);

    zoom.scrollSample = -1;
    expect(useSessionStore.getState().mtZoom.scrollSample).toBe(12800);
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

describe('merge clips hooks', () => {
  /** The lot D fixture — one track carrying `[0, 1000)` and `[2000, 1000)` —
   * pointed at a REAL document, so the merge has audio to bake rather than the
   * silence a dangling `documentId` would contribute. The second clip reads
   * from a non-zero offset, so a merge that ignored `offsetSample` would not
   * quietly produce the same bytes. */
  function seedClips(): { ids: string[]; doc: AudioDocument } {
    const doc = createDocument({
      name: 'ramp.wav',
      sampleRate: 44100,
      channels: [Float32Array.from({ length: 4410 }, (_, i) => (i % 71) / 71 + 0.05)],
    });
    useAppStore.getState().addDocument(doc);
    const t = createTrack('Track 1');
    t.clips = [
      createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 1000 }),
      createClip({ documentId: doc.id, startSample: 2000, offsetSample: 700, lengthSample: 1000 }),
    ];
    useSessionStore.setState({
      session: { name: 'Merge Hook Fixture', sampleRate: 44100, tracks: [t] },
      selectedClipId: null,
      selectedClipIds: [],
      mtCursorSample: 0,
    });
    return { ids: t.clips.map((c) => c.id), doc };
  }

  it('mergeSelectedClips joins the selected pair into one clip and mints one document', () => {
    const t = api();
    const { ids } = seedClips();
    t.selectClips(ids);
    const before = useAppStore.getState().documents.length;

    const result = t.mergeSelectedClips();

    expect(result.clipIds).toHaveLength(1);
    expect(result.docCount).toBe(before + 1);
    expectPlainJson(result);

    const clips = useSessionStore.getState().session.tracks[0].clips;
    expect(clips).toHaveLength(1);
    expect(clips[0].id).toBe(result.clipIds[0]);
    expect(clips[0].startSample).toBe(0);
    expect(clips[0].lengthSample).toBe(3000); // [0, 1000) + [2000, 3000)

    const merged = useAppStore.getState().documents[before];
    expect(clips[0].documentId).toBe(merged.id);
    expect(merged.name).toMatch(/^Merge \d+$/);
    expect(merged.sampleRate).toBe(44100);
    expect(merged.channels[0]).toHaveLength(3000);
    // The gap between the members is silence; the members themselves are not.
    expect(merged.channels[0].slice(0, 1000).some((v) => v !== 0)).toBe(true);
    expect(merged.channels[0].slice(1000, 2000).every((v) => v === 0)).toBe(true);
    expect(merged.channels[0].slice(2000, 3000).some((v) => v !== 0)).toBe(true);
  });

  it('mergeSelectedClips is a no-op with a single clip selected — nothing merges, nothing is minted', () => {
    const t = api();
    const { ids } = seedClips();
    t.selectClips([ids[0]]);
    const before = useAppStore.getState().documents.length;

    expect(t.mergeSelectedClips()).toEqual({ clipIds: [], docCount: before });
    expect(useSessionStore.getState().session.tracks[0].clips).toHaveLength(2);
  });
});

describe('gap hooks', () => {
  /**
   * D3 — the two hooks Task 7's smoke drives the gap gesture through. The
   * harness cannot double-click a lane through `page.evaluate`, so
   * `selectGapAt` states the gesture's OUTCOME through the shipped resolver
   * and the shipped setter: what it selects is what a double-click at that
   * sample would have selected, refusals included.
   */
  function seedGapTrack(): { trackId: string; ids: string[] } {
    const t = createTrack('Track 1');
    t.clips = [
      createClip({ documentId: 'doc-1', startSample: 1000, offsetSample: 128, lengthSample: 500 }),
      createClip({ documentId: 'doc-1', startSample: 2000, offsetSample: 256, lengthSample: 500 }),
    ];
    useSessionStore.setState({
      session: { name: 'Gap Hook Fixture', sampleRate: 44100, tracks: [t] },
      selectedClipId: null,
      selectedClipIds: [],
      selectedGap: null,
      mtCursorSample: 0,
    });
    return { trackId: t.id, ids: t.clips.map((c) => c.id) };
  }

  it('selectGapAt names the gap under the sample and reads back through getSelectedGap', () => {
    const t = api();
    const { trackId } = seedGapTrack();

    const gap = t.selectGapAt(0, 1700);

    expect(gap).toEqual({ trackId, startSample: 1500, endSample: 2000 });
    expectPlainJson(gap);
    expect(t.getSelectedGap()).toEqual(gap);
    expectPlainJson(t.getSelectedGap());
  });

  it('a ONE-SAMPLE gap selected through the hook still closes', () => {
    // Review round 1, I1. `gapAt` refuses both edges, so only a FRACTIONAL
    // sample is strictly inside a one-sample span — which the hook allows and
    // the lane (which rounds) does not. The floored probe used to land on the
    // start edge here, so `closeGap` refused its own selection and Delete did
    // nothing at all.
    const t = api();
    const track = createTrack('Tight');
    track.clips = [
      createClip({ documentId: 'doc-1', startSample: 100, offsetSample: 16, lengthSample: 400 }),
      createClip({ documentId: 'doc-1', startSample: 501, offsetSample: 32, lengthSample: 400 }),
    ];
    useSessionStore.setState({
      session: { name: 'One Sample Gap', sampleRate: 44100, tracks: [track] },
      selectedClipId: null,
      selectedClipIds: [],
      selectedGap: null,
      mtCursorSample: 0,
    });
    _resetSessionUndo();

    const gap = t.selectGapAt(0, 500.5);
    expect(gap).toEqual({ trackId: track.id, startSample: 500, endSample: 501 });

    closeGap(gap!);

    const clips = useSessionStore.getState().session.tracks[0].clips;
    expect(clips.map((c) => c.startSample).sort((a, b) => a - b)).toEqual([100, 500]);
    expect(getHistory(SESSION_UNDO_KEY).done).toEqual(['Close gap']);
    expect(t.getSelectedGap()).toBeNull();
  });

  it('selectGapAt hands out a COPY too', () => {
    const t = api();
    seedGapTrack();

    const gap = t.selectGapAt(0, 1700)!;
    gap.endSample = -1;

    expect(useSessionStore.getState().selectedGap!.endSample).toBe(2000);
  });

  it('getSelectedGap hands out a COPY — a harness-side mutation cannot reach the store', () => {
    const t = api();
    seedGapTrack();
    t.selectGapAt(0, 1700);

    const read = t.getSelectedGap()!;
    read.startSample = -1;

    expect(useSessionStore.getState().selectedGap!.startSample).toBe(1500);
  });

  it('selects nothing over a clip, past the last clip, or on a track that is not there', () => {
    const t = api();
    seedGapTrack();

    expect(t.selectGapAt(0, 1200)).toBeNull(); // inside a clip
    expect(t.selectGapAt(0, 9000)).toBeNull(); // the open end
    expect(t.selectGapAt(7, 1700)).toBeNull(); // no such track
    expect(t.getSelectedGap()).toBeNull();
  });

  it('clears a standing gap when the next call refuses — the harness sees one truth', () => {
    const t = api();
    seedGapTrack();
    expect(t.selectGapAt(0, 1700)).not.toBeNull();

    expect(t.selectGapAt(0, 1200)).toBeNull();

    expect(t.getSelectedGap()).toBeNull();
  });

  it('the gap and the clip selection are mutually exclusive, through the hooks', () => {
    const t = api();
    const { ids } = seedGapTrack();
    t.selectClips([ids[0]]);

    expect(t.selectGapAt(0, 1700)).not.toBeNull();
    expect(useSessionStore.getState().selectedClipIds).toEqual([]);

    t.selectClips([ids[1]]);
    expect(t.getSelectedGap()).toBeNull();
  });
});

/**
 * D4 — `separateVoiceLand`, the Separate Voice landing WITHOUT the model.
 *
 * The smoke cannot run HT-Demucs (166 MB, minutes of CPU) just to see two
 * tracks land, and it must not have to: the model is `separateStems`' business
 * and is already exercised by its own hook. So this one synthesises the output
 * the model would have produced — four distinct stems plus the float32
 * complement residual, an exact partition of the ACTIVE document — and hands it
 * to the shipped `landVoice`. What the smoke asserts is therefore the landing,
 * which is the part D4 added.
 */
describe('separateVoiceLand (D4)', () => {
  /** Distinct, non-trivial content per channel — a landing measured on silence
   *  would pass with every stem index swapped. */
  function addVoiceDoc(name = 'song.wav', channelCount = 2): AudioDocument {
    const channels: Float32Array[] = [];
    for (let c = 0; c < channelCount; c++) {
      const ch = new Float32Array(2048);
      for (let i = 0; i < ch.length; i++) {
        ch[i] = 0.4 * Math.sin((2 * Math.PI * (110 + 70 * c) * i) / 44100) + (c === 0 ? 0.05 : -0.03);
      }
      channels.push(ch);
    }
    const doc = createDocument({ name, sampleRate: 44100, channels });
    useAppStore.getState().addDocument(doc);
    return doc;
  }

  it('lands two named documents and a two-track session, with no model run', () => {
    const t = api();
    addVoiceDoc('song.wav');

    const summary = t.separateVoiceLand();

    expect(summary.ok).toBe(true);
    expect(summary.documentNames).toEqual(['song.wav — Voice', 'song.wav — Backing']);
    expect(summary.trackNames).toEqual(['Voice', 'Backing']);
    expect(summary.sessionName).toBe('song.wav — Voice + Backing');
    expect(summary.sampleRate).toBe(44100);
    expect(summary.lengthSamples).toBe(2048);
    expect(useSessionStore.getState().session.tracks).toHaveLength(2);
    expect(useAppStore.getState().view).toBe('multitrack');
  });

  it('reports the measured Voice + Backing error against the source it started from', () => {
    const t = api();
    addVoiceDoc();

    const summary = t.separateVoiceLand();

    // The synthetic stems are an exact partition, so the two tracks add back up
    // to within float32 re-association — the same claim `landVoice` makes.
    expect(summary.worstAbsError).not.toBeNull();
    expect(summary.worstAbsError!).toBeLessThan(1e-6);
  });

  it('routes a MONO source as dual-mono, and says so', () => {
    const t = api();
    addVoiceDoc('mono.wav', 1);

    const summary = t.separateVoiceLand();

    expect(summary.monoRoutedAsDualMono).toBe(true);
    expect(summary.channelCounts).toEqual([2, 2]);
  });

  it('refuses an empty document and a bare app, landing nothing', () => {
    const t = api();
    expect(t.separateVoiceLand().ok).toBe(false);

    const empty = createDocument({ name: 'empty.wav', sampleRate: 44100, channels: [new Float32Array(0)] });
    useAppStore.getState().addDocument(empty);
    const summary = t.separateVoiceLand();

    expect(summary.ok).toBe(false);
    expect(summary.documentNames).toEqual([]);
    expect(useAppStore.getState().documents).toHaveLength(1);
  });

  it('hands back plain JSON (T16)', () => {
    const t = api();
    addVoiceDoc();
    const summary = t.separateVoiceLand();
    expect(JSON.parse(JSON.stringify(summary))).toStrictEqual(summary);
  });
});

/**
 * D6 — the Podcast Chain hook.
 *
 * Task 7's packaged smoke calls this on the generated tone and asserts the undo
 * label, a finite `afterLufs` near the target for the document's channel count,
 * and a sample peak at or under the ceiling. What the smoke cannot see from
 * outside is the plumbing: whether the hook drove the REAL chain with the
 * shipped stage map, whether it reports the document's own peak, and whether
 * every field survives the structured-clone boundary. That is what is here.
 */
describe('podcast chain hooks (D6)', () => {
  // The chain reads each effect's OWN declared defaults through
  // `defaultParamsFor`, on the main thread, before the worker sees anything —
  // so the registry has to be filled here. Nothing else in this file needs it,
  // which is why it is scoped to this block rather than to the file.
  beforeAll(() => {
    registerAllEffects();
  });

  /** Speech-shaped and deliberately off every identity: two DIFFERENT channels,
   * bursts of two tones over a real floor, and pauses long enough for the chain
   * to have something to measure and something to shorten. Three seconds, which
   * is the shortest take that still gives every stage real work. */
  function addSpeechDoc(channelCount = 2): AudioDocument {
    const SR = 44100;
    const pause = Math.round(0.8 * SR);
    const burst = Math.round(0.7 * SR);
    const total = 2 * pause + 2 * burst;
    const channels: Float32Array[] = [];
    for (let c = 0; c < channelCount; c++) {
      const ch = new Float32Array(total);
      let seed = (11 + 18 * c) >>> 0;
      const rnd = (): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return (seed / 0xffffffff) * 2 - 1;
      };
      // A -60 dBFS floor everywhere, so a noise print and a pause threshold
      // both exist to be measured.
      for (let i = 0; i < total; i++) ch[i] = rnd() * Math.pow(10, -60 / 20) * Math.sqrt(3);
      const amplitude = 0.1 - 0.01 * c;
      for (let b = 0; b < 2; b++) {
        const at = (b + 1) * pause + b * burst;
        for (let i = 0; i < burst; i++) {
          const t = (at + i) / SR;
          ch[at + i] +=
            (amplitude / 2) *
            (Math.sin(2 * Math.PI * 200 * t) + Math.sin(2 * Math.PI * 2000 * t));
        }
      }
      channels.push(ch);
    }
    const doc = createDocument({ name: 'episode.wav', sampleRate: SR, channels });
    useAppStore.getState().addDocument(doc);
    return doc;
  }

  it(
    'runs the REAL chain on the active document and reports the landing',
    async () => {
      const t = api();
      const doc = addSpeechDoc(2);
      const depthBefore = getHistory(doc.id).done.length;

      const result = await t.podcastChainRun();

      // One undo entry, under the chain's own label — the claim the whole
      // design rests on, asserted as a DELTA rather than as a depth.
      expect(getHistory(doc.id).done.length).toBe(depthBefore + 1);
      expect(result.undoLabel).toBe('Podcast Chain');
      expect(result.refusal).toBeNull();

      // It measured a loudness going in and coming out, and the second one is
      // the stereo target. Tolerance is the service suite's own.
      expect(result.beforeLufs).not.toBeNull();
      expect(result.afterLufs).not.toBeNull();
      expect(Number.isFinite(result.afterLufs as number)).toBe(true);
      expect(Math.abs((result.afterLufs as number) - -16)).toBeLessThan(0.5);
      // ...and it MOVED the level rather than reporting the same number twice.
      expect(result.afterLufs).not.toBe(result.beforeLufs);

      // SAMPLE peak, at or under the ceiling.
      expect(result.peakDb).not.toBeNull();
      expect(result.peakDb as number).toBeLessThanOrEqual(-1);

      expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result);
    },
    120_000
  );

  it(
    'targets -19 LUFS on a MONO document — the target follows the channel count',
    async () => {
      const t = api();
      addSpeechDoc(1);

      const result = await t.podcastChainRun();

      expect(result.refusal).toBeNull();
      expect(Math.abs((result.afterLufs as number) - -19)).toBeLessThan(0.5);
      expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result);
    },
    120_000
  );

  it('reports the refusal, and NO undo label, on a document with more than two channels', async () => {
    const t = api();
    const doc = addSpeechDoc(3);
    const depthBefore = getHistory(doc.id).done.length;

    const result = await t.podcastChainRun();

    // The refusal returns before a single stage runs, so this costs nothing.
    expect(result.refusal).not.toBeNull();
    expect(result.refusal).toContain('Convert Channels');
    // Nothing was applied, so nothing may be reported as an undo entry — not
    // even whatever was already on top of this document's history.
    expect(getHistory(doc.id).done.length).toBe(depthBefore);
    expect(result.undoLabel).toBeNull();
    // And no loudness was measured, because measuring one here is the very
    // thing being refused.
    expect(result.beforeLufs).toBeNull();
    expect(result.afterLufs).toBeNull();

    expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result);
  });

  it('answers with nulls rather than a fake peak when no document is open', async () => {
    const t = api();

    const result = await t.podcastChainRun();

    expect(result).toEqual({
      undoLabel: null,
      beforeLufs: null,
      afterLufs: null,
      // `-Infinity` here would arrive across the Playwright boundary as `null`
      // anyway — undeclared. Declared, it survives the round trip below.
      peakDb: null,
      refusal: null,
    });
    expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result);
  });
});

describe('getPlaybackState (D2)', () => {
  /**
   * D2 — the one read the packaged smoke checks "Play starts at the bar"
   * against. It is deliberately a READ ONLY: the smoke presses Space, so the
   * shipped `transport.playPause` is what writes these fields, and a hook that
   * drove the transport itself would be pinning its own arithmetic.
   */
  it('reports the engine state, the position the transport wrote, and the bar together', () => {
    const t = api();
    addDoc('Tone');
    // Values nothing defaults to, and three DIFFERENT ones, so a hook reading
    // the wrong field or aliasing two of them is visible.
    useAppStore.getState().setCursor(44100);
    useAppStore.getState().setPlayback({ state: 'paused', positionSample: 22050 });

    const state = t.getPlaybackState();

    expect(state).toEqual({ state: 'paused', positionSample: 22050, cursorSample: 44100 });
    expectPlainJson(state);
  });

  it('reads the stopped default before anything has played', () => {
    const t = api();
    addDoc('Tone');

    expect(t.getPlaybackState()).toEqual({
      state: 'stopped',
      positionSample: 0,
      cursorSample: 0,
    });
  });
});

/**
 * D6 — `separateSpeakersLand`, the Separate Speakers landing WITHOUT either
 * model.
 *
 * Same bargain as `separateVoiceLand` above, one stage further along: the smoke
 * cannot run HT-Demucs AND the two diarization models (198 MB, minutes of CPU)
 * to watch three tracks land. So the hook synthesises BOTH halves — the exact
 * four-stem partition of the active document, and the evidence a diarization
 * host would have produced for two speakers taking strict turns across it — and
 * hands them to the shipped `assembleDiarization` -> `segmentsToDocSamples` ->
 * `landSpeakers` chain. What is asserted here is therefore that chain, which is
 * the part D4 added, plus the hook's own JSON contract.
 */
describe('separateSpeakersLand (D4/D6)', () => {
  /** 16 kHz samples a document of `seconds` at 44.1 kHz resamples to — the rate
   *  pair divides exactly (44100 / 16000 = 2.75625), so no rounding argument is
   *  needed to say which windows the fixture produces. */
  const docSamplesForWindows = (windows: number): number =>
    ((SEG_WINDOW + (windows - 1) * SEG_SHIFT) * 44100) / 16000;

  /** The worst |sample| over a document's channels. The expected peaks below
   *  are derived from the FIXTURE through this rather than written down: the
   *  source's own peak, times the stem weight the landing carries. */
  const peakOf = (channels: readonly Float32Array[]): number => {
    let peak = 0;
    for (const ch of channels) {
      for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]) > peak) peak = Math.abs(ch[i]);
    }
    return peak;
  };

  /** `syntheticSeparation`'s Vocals weight (`testHooks.ts`), the one stem a
   *  speaker document is made of. Written out HERE on purpose rather than
   *  imported: pinning the number the fixture is supposed to use is what makes
   *  a permutation of those four weights — the wrong-stem landing the fixture's
   *  docblock names — fail instead of landing quietly. */
  const VOCALS_WEIGHT = 0.19;

  /** Distinct, non-trivial content per channel, as `addVoiceDoc` above: a
   *  landing measured on silence would pass with the mask inverted.
   *
   *  Channel 1 is the LOUDER side on purpose (a bigger amplitude AND the
   *  offset that adds to its own troughs): both measurements the summary
   *  reports — `channelsPeak` and `peakOutsideSpans` — take a max over EVERY
   *  channel, and on a fixture where channel 0 dominates, a loop that never
   *  left channel 0 would produce the same numbers. With the peak living on
   *  channel 1, every expectation below is derived from a sample the
   *  measurement can only reach by scanning both. */
  function addSpeakerDoc(name = 'talk.wav', samples = 2 * 44100, channelCount = 2): AudioDocument {
    const channels: Float32Array[] = [];
    for (let c = 0; c < channelCount; c++) {
      const ch = new Float32Array(samples);
      for (let i = 0; i < ch.length; i++) {
        ch[i] =
          (0.4 + 0.06 * c) * Math.sin((2 * Math.PI * (110 + 70 * c) * i) / 44100) +
          (c === 0 ? 0.05 : -0.03);
      }
      channels.push(ch);
    }
    const doc = createDocument({ name, sampleRate: 44100, channels });
    useAppStore.getState().addDocument(doc);
    return doc;
  }

  it('lands Speaker 1, Speaker 2 and Backing at a forced count of two', () => {
    const t = api();
    addSpeakerDoc('talk.wav');

    const summary = t.separateSpeakersLand(2);

    expect(summary.ok).toBe(true);
    expect(summary.speakerCount).toBe(2);
    expect(summary.requestedSpeakerCount).toBe(2);
    expect(summary.documentNames).toEqual([
      'talk.wav — Speaker 1',
      'talk.wav — Speaker 2',
      'talk.wav — Backing',
    ]);
    expect(summary.trackNames).toEqual(['Speaker 1', 'Speaker 2', 'Backing']);
    expect(summary.sessionName).toBe('talk.wav — Speakers');
    expect(summary.sampleRate).toBe(44100);
    expect(summary.lengthSamples).toBe(2 * 44100);
    expect(useSessionStore.getState().session.tracks).toHaveLength(3);
    expect(useAppStore.getState().view).toBe('multitrack');
    // D4: a speaker split is not a partition of the source, so the landing
    // makes no exact-sum claim in either direction.
    expect(summary.exactSumHolds).toBeNull();
  });

  it('a forced count of ONE is the Voice + Backing landing, not a one-speaker mask', () => {
    const t = api();
    addSpeakerDoc('talk.wav');

    const summary = t.separateSpeakersLand(1);

    expect(summary.speakerCount).toBe(1);
    expect(summary.documentNames).toEqual(['talk.wav — Voice', 'talk.wav — Backing']);
    expect(summary.trackNames).toEqual(['Voice', 'Backing']);
    expect(summary.sessionName).toBe('talk.wav — Voice + Backing');
    // Nothing was masked, so there is no "outside the spans" to measure — and
    // `landVoice`'s own exact-sum verdict is a real one, not D4's "no claim".
    expect(summary.outsideSpansPeak).toBeNull();
    expect(summary.speakerPeaks).toEqual([]);
    // The one field that DIFFERS between the two landings, so the count-of-two
    // `toBeNull()` above is a contrast and not the seed value: `landVoice`
    // reports the real peak-derived verdict (`createLandingDocuments`:
    // `sourcePeak <= 1`), and the synthetic separation is an exact partition of
    // a source that peaks near 0.45.
    expect(summary.exactSumHolds).toBe(true);
  });

  it('every speaker document is silent outside that speakers turns and carries audio inside them', () => {
    const t = api();
    const source = addSpeakerDoc('talk.wav');

    const summary = t.separateSpeakersLand(2);

    // The two halves of the mask, and both are needed: a landing that zeroed
    // the WHOLE document would also report 0 outside the spans.
    //
    // Inside the turns it is the VALUE that is pinned, not the sign. A speaker
    // document is the Vocals stem of an exact partition of the source, so its
    // peak is that weight times the source's own — measured off the fixture
    // here. "> 0" passes on any constant at all, and it passes on a landing
    // that took the wrong stem (0.37x, 0.23x or 0.11x).
    const stemPeak = Math.fround(VOCALS_WEIGHT * peakOf(source.channels));
    // That peak lives on channel 1 (see `addSpeakerDoc`), pinned here because
    // it is what makes every expectation in this describe a number the
    // measurement can only reach by scanning BOTH channels: hand the peak back
    // to channel 0 and a `channelsPeak` that stopped after the first channel
    // would report the same value again.
    expect(peakOf([source.channels[1]])).toBeGreaterThan(peakOf([source.channels[0]]));
    expect(summary.outsideSpansPeak).toBe(0);
    expect(summary.speakerPeaks).toHaveLength(2);
    for (const peak of summary.speakerPeaks) expect(peak).toBeCloseTo(stemPeak, 6);
    // Turns, not one span each: the fixture alternates, so the first speaker
    // gets two turns and the second one.
    expect(summary.segmentCounts).toEqual([2, 1]);
    expect(summary.speechSeconds).toHaveLength(2);
    for (const s of summary.speechSeconds) expect(s).toBeGreaterThan(0);
  });

  it('measures what is outside the turns rather than reporting a zero of its own', () => {
    const t = api();
    const source = addSpeakerDoc('talk.wav');
    const length = source.channels[0].length;

    const summary = t.separateSpeakersLand(2);

    // 0 is also the value the field would carry if the measurement had never
    // run, so the measurement is put on BOTH sides of that identity: the same
    // landed channels, with the spans moved off the audio. Speaker 1's document
    // against speaker 2's turns holds every one of its samples OUTSIDE the
    // spans and has to report its whole peak; against its own turns it has to
    // report silence. The spans come from the shipped chain the hook itself
    // runs, not from a hand-written list.
    const spans = segmentsToDocSamples(
      assembleDiarization(syntheticSpeakerEvidence(length, 44100), { speakerCount: 2 }),
      44100,
      length
    );
    const speaker1 = useAppStore
      .getState()
      .documents.find((d) => d.name === 'talk.wav — Speaker 1');
    expect(speaker1).toBeDefined();
    const stemPeak = Math.fround(VOCALS_WEIGHT * peakOf(source.channels));
    expect(peakOutsideSpans(speaker1!.channels, spans[1])).toBeCloseTo(stemPeak, 6);
    expect(peakOutsideSpans(speaker1!.channels, spans[0])).toBe(0);
    expect(summary.outsideSpansPeak).toBe(0);
  });

  it('reads the head, the gaps between the spans and the tail, each on its own', () => {
    const t = api();
    const source = addSpeakerDoc('talk.wav');
    const length = source.channels[0].length;

    t.separateSpeakersLand(2);

    // Three regions lie outside a span set — the head, the gaps and the tail —
    // and the shipped hook leans on the GAPS: it measures speaker k against
    // speaker k's OWN turns, where the gaps between those turns are the only
    // place the reported 0 proves anything. Handed one span set they are
    // interchangeable (this fixture reaches the same peak in each), so each is
    // isolated here by a span set that leaves only that one region uncovered.
    // A measurement that dropped two of the three would still answer the test
    // above; it cannot answer all four of these.
    const spans = segmentsToDocSamples(
      assembleDiarization(syntheticSpeakerEvidence(length, 44100), { speakerCount: 2 }),
      44100,
      length
    );
    expect(spans[0]).toHaveLength(2);
    const [firstTurn, secondTurn] = spans[0];
    const speaker1 = useAppStore
      .getState()
      .documents.find((d) => d.name === 'talk.wav — Speaker 1');
    expect(speaker1).toBeDefined();
    const stemPeak = Math.fround(VOCALS_WEIGHT * peakOf(source.channels));

    // HEAD alone: one span from the end of the first turn to the end of the
    // document — no gap, an empty tail, and the first turn's audio entirely
    // before it.
    expect(
      peakOutsideSpans(speaker1!.channels, [
        { startSample: firstTurn.endSample, endSample: length },
      ])
    ).toBeCloseTo(stemPeak, 6);

    // GAP alone: two spans that reach the document's own ends, so head and tail
    // are empty by construction and the first turn lies between them.
    expect(
      peakOutsideSpans(speaker1!.channels, [
        { startSample: 0, endSample: firstTurn.startSample },
        { startSample: firstTurn.endSample, endSample: length },
      ])
    ).toBeCloseTo(stemPeak, 6);

    // TAIL alone: one span from 0 to the start of the second turn, which is
    // then the only audio left uncovered.
    expect(
      peakOutsideSpans(speaker1!.channels, [
        { startSample: 0, endSample: secondTurn.startSample },
      ])
    ).toBeCloseTo(stemPeak, 6);

    // And 0 when the whole document is covered — the contrast that makes the
    // three numbers above region measurements rather than the document's peak.
    expect(
      peakOutsideSpans(speaker1!.channels, [{ startSample: 0, endSample: length }])
    ).toBe(0);
  });

  it('reports the audio a mask leaves behind, which is what makes that 0 evidence', () => {
    const t = api();
    const source = addSpeakerDoc('talk.wav');
    // The shipped mask always silences the gaps, so through this hook the field
    // can only ever read 0 — and a summary that hard-coded the 0 would look the
    // same. So the mask is TAKEN AWAY (`keepSpans` becomes a pass-through: the
    // one thing D4's landing does to the stem) and the hook has to report the
    // stem it was handed, outside the turns and all.
    const spy = jest
      .spyOn(spanMask, 'keepSpans')
      .mockImplementation((channels) => channels.map((ch) => Float32Array.from(ch)));

    const summary = t.separateSpeakersLand(2);

    expect(spy).toHaveBeenCalled();
    expect(summary.outsideSpansPeak).toBeCloseTo(
      Math.fround(VOCALS_WEIGHT * peakOf(source.channels)),
      6
    );
  });

  it.each([0, 1])(
    'aggregates over every speaker document, not one of them — speaker %i unmasked',
    (unmasked) => {
      const t = api();
      const source = addSpeakerDoc('talk.wav');
      // `outsideSpansPeak` is the worst sample over EVERY speaker document and
      // `speakerPeaks` is one entry per document, and on this fixture the two
      // landed documents are identical — so a loop that measured a single k
      // would report exactly the same summary. One speaker's mask is therefore
      // replaced by a HALF-GAIN pass-through (nothing silenced, and the turns
      // themselves at half level): that document is then the only one carrying
      // audio outside its turns AND the only one whose peak is not the stem's,
      // so both fields can only be right if the run visited the k it landed at.
      const real = spanMask.keepSpans;
      let call = 0;
      jest
        .spyOn(spanMask, 'keepSpans')
        .mockImplementation((channels, spans, sampleRate) =>
          call++ === unmasked
            ? channels.map((ch) => Float32Array.from(ch, (v) => v * 0.5))
            : real(channels, spans, sampleRate)
        );

      const summary = t.separateSpeakersLand(2);

      const stemPeak = Math.fround(VOCALS_WEIGHT * peakOf(source.channels));
      expect(summary.speakerPeaks).toHaveLength(2);
      expect(summary.speakerPeaks[unmasked]).toBeCloseTo(stemPeak / 2, 6);
      expect(summary.speakerPeaks[1 - unmasked]).toBeCloseTo(stemPeak, 6);
      expect(summary.outsideSpansPeak).toBeCloseTo(stemPeak / 2, 6);
    }
  );

  it('routes a MONO source as dual-mono across every landed track, and says so', () => {
    const t = api();
    addSpeakerDoc('mono.wav', 2 * 44100, 1);

    const summary = t.separateSpeakersLand(2);

    expect(summary.monoRoutedAsDualMono).toBe(true);
    expect(summary.channelCounts).toEqual([2, 2, 2]);
  });

  it('the auto policy keeps both voices once each has MIN_CLUSTER_SIZE fragments', () => {
    const t = api();
    // Four windows -> four fragments per voice, exactly MIN_CLUSTER_SIZE: the
    // boundary value itself, which `foldSmallClusters` keeps.
    addSpeakerDoc('long.wav', docSamplesForWindows(MIN_CLUSTER_SIZE));

    const summary = t.separateSpeakersLand();

    expect(summary.requestedSpeakerCount).toBeNull();
    expect(summary.speakerCount).toBe(2);
    expect(summary.trackNames).toEqual(['Speaker 1', 'Speaker 2', 'Backing']);
  });

  it('...and folds them into one below it, which lands as Voice + Backing', () => {
    const t = api();
    // One step past the boundary: three windows, three fragments per voice.
    // Every cluster is then small, so the measured fold (D3, MIN_CLUSTER_SIZE
    // fixed at 4) collapses them into the largest — the honest auto answer on
    // this much audio, not a fixture accident.
    addSpeakerDoc('short.wav', docSamplesForWindows(MIN_CLUSTER_SIZE - 1));

    const summary = t.separateSpeakersLand();

    expect(summary.speakerCount).toBe(1);
    expect(summary.trackNames).toEqual(['Voice', 'Backing']);
  });

  it('refuses an empty document and a bare app, landing nothing', () => {
    const t = api();
    expect(t.separateSpeakersLand(2).ok).toBe(false);

    const empty = createDocument({ name: 'empty.wav', sampleRate: 44100, channels: [new Float32Array(0)] });
    useAppStore.getState().addDocument(empty);
    const summary = t.separateSpeakersLand(2);

    expect(summary.ok).toBe(false);
    expect(summary.documentNames).toEqual([]);
    expect(summary.trackNames).toEqual([]);
    expect(useAppStore.getState().documents).toHaveLength(1);
  });

  it('hands back plain JSON (T16)', () => {
    const t = api();
    addSpeakerDoc('talk.wav');
    expectPlainJson(t.separateSpeakersLand(2));
    expectPlainJson(t.separateSpeakersLand(1));
  });
});

/**
 * D6 — the three fidelity rules `syntheticSpeakerEvidence` builds its host
 * output from, pinned on the EVIDENCE rather than on the landing.
 *
 * They have to be pinned here because none of them is visible downstream: slots
 * handed out by first appearance, slots fixed per voice, and an emission that
 * ignores the MIN_EMBED_FRAMES gate all land the same session with the same
 * documents, so every assertion in `separateSpeakersLand`'s describe above
 * stays green when one of the three is removed. What they protect is the claim
 * the hook's docblock makes — that this is the evidence a real host WOULD have
 * produced (D1/D2) — and a fixture that quietly stopped being that would take
 * the smoke's speaker coverage with it.
 */
describe('syntheticSpeakerEvidence (D6 fixture fidelity)', () => {
  /** Document samples at 44.1 kHz whose 16 kHz length assembles to exactly
   *  `frames` frames in ONE zero-padded window: `assembledFrameCount` cuts a
   *  padded run at `trunc(totalSamples16k / FRAME_SHIFT)`, so the shortest
   *  16 kHz length reaching `frames` is `frames * FRAME_SHIFT`, and the exact
   *  rate ratio 44100/16000 = 441/160 turns that into document samples. */
  const docSamplesForFrames = (frames: number): number =>
    Math.ceil((frames * FRAME_SHIFT * 441) / 160);

  /** Document samples that resample to exactly `windows` segmentation windows,
   *  as the two describes around this one compute them. */
  const docSamplesForWindows = (windows: number): number =>
    ((SEG_WINDOW + (windows - 1) * SEG_SHIFT) * 44100) / 16000;

  /** The GLOBAL voice a fragment carries. `unitVector` puts a whole unit on
   *  its axis and a ±0.01 wobble everywhere else, so the largest component is
   *  the voice index the fixture built the vector for — which is what lets a
   *  slot be read back to the voice that held it. */
  function voiceOf(vector: Float32Array): number {
    let best = 0;
    for (let i = 1; i < vector.length; i++) if (vector[i] > vector[best]) best = i;
    return best;
  }

  it('hands local slots out by first appearance, so one voice changes slot between windows', () => {
    // Window 1 starts at global frame 59 (`windowStartFrame(1)`), which falls
    // inside the SECOND voice's first turn (frames 48..95 at HOOK_TURN_FRAMES
    // = 48). That voice therefore appears first in window 1 and takes slot 0 —
    // the slot the FIRST voice held in window 0. A fixture with slots fixed
    // per voice is what a real host never produces, and clustering across a
    // swap is the whole reason the assembly needs vectors at all.
    const evidence = syntheticSpeakerEvidence(docSamplesForWindows(2), 44100);
    expect(evidence.windows).toHaveLength(2);
    expect(HOOK_TURN_FRAMES).toBeLessThan(59);

    const slotZero = (windowIndex: number): Float32Array => {
      const e = evidence.embeddings.find((x) => x.windowIndex === windowIndex && x.localSpeaker === 0);
      if (!e) throw new Error(`window ${windowIndex} emitted no slot-0 fragment`);
      return e.vector;
    };
    expect(voiceOf(slotZero(0))).toBe(0);
    expect(voiceOf(slotZero(1))).toBe(1);

    // The class bytes say it too: frame 0 of BOTH windows is the singleton
    // class of slot 0 (POWERSET index 1 = [0]), even though the two frames
    // belong to different voices.
    expect(evidence.windows[0][0]).toBe(1);
    expect(evidence.windows[1][0]).toBe(1);
  });

  it('emits a fragment only once a voice holds MIN_EMBED_FRAMES of the window, and none below it', () => {
    // D1's emission rule verbatim: at least 10 active frames. One padded
    // window cut one frame BELOW the gate — the first voice holds a whole turn
    // and the second holds the MIN_EMBED_FRAMES − 1 frames that are left, so
    // the host would emit one fragment for that window and so does the fixture.
    const below = syntheticSpeakerEvidence(
      docSamplesForFrames(HOOK_TURN_FRAMES + MIN_EMBED_FRAMES - 1),
      44100
    );
    expect(below.windows).toHaveLength(1);
    expect(below.embeddings).toHaveLength(1);
    expect(below.embeddings[0].localSpeaker).toBe(0);
    expect(below.embeddings[0].activeFrames).toBe(HOOK_TURN_FRAMES);

    // One frame of audio more and the second voice sits exactly ON the gate,
    // which D1 keeps (`activeFrames < MIN_EMBED_FRAMES` is what it drops).
    const atGate = syntheticSpeakerEvidence(
      docSamplesForFrames(HOOK_TURN_FRAMES + MIN_EMBED_FRAMES),
      44100
    );
    expect(atGate.embeddings).toHaveLength(2);
    expect(atGate.embeddings[1].localSpeaker).toBe(1);
    expect(atGate.embeddings[1].activeFrames).toBe(MIN_EMBED_FRAMES);
    expect(voiceOf(atGate.embeddings[1].vector)).toBe(1);
  });

  it('leaves every frame past the assembled cut silent, as a zero-padded tail window would', () => {
    const frames = HOOK_TURN_FRAMES + MIN_EMBED_FRAMES;
    const evidence = syntheticSpeakerEvidence(docSamplesForFrames(frames), 44100);
    const window = evidence.windows[0];

    // The window is a FULL 589-byte one on the wire, whatever the audio ends:
    // the padding is silence, not a short array.
    expect(window).toHaveLength(SEG_FRAMES);
    expect(window[frames - 1]).toBeGreaterThan(0);
    expect(window.slice(frames)).toEqual(new Uint8Array(SEG_FRAMES - frames));
  });
});

/**
 * D6 — the two hooks that face the REAL diarization host: the model probe the
 * smoke gates on, and the run itself.
 *
 * Driven here through `src/__mocks__/diarizeBackend`, the shared double for the
 * `diarize:*` preload surface, so what is exercised is the whole renderer path
 * — `diarizeChannels` resampling the ACTIVE document, accumulating the host's
 * windows and fragments, and assembling them — with only the utility process
 * replaced. The hook's own job is the last step of that: flattening a result
 * carrying `Uint8Array` windows and `Float32Array` vectors into scalars that
 * survive Playwright's structured-clone boundary (T16).
 */
describe('getDiarizeModelState / diarizeActive (D6)', () => {
  let backend: DiarizeBackend;

  beforeEach(() => {
    backend = installDiarizeBackend();
  });

  afterEach(async () => {
    // Never leave a run reserved for the next test.
    await cancelDiarization();
    uninstallDiarizeBackend();
  });

  /** Spins the microtask queue until `pred` holds (or the budget runs out), so
   *  a test can wait for the invoke without guessing a tick count. */
  async function flushUntil(pred: () => boolean, ticks = 200): Promise<void> {
    for (let i = 0; i < ticks && !pred(); i++) await Promise.resolve();
  }

  /** Document samples at 44.1 kHz that resample to exactly `windows`
   *  segmentation windows — the rate pair divides exactly (44100 / 16000 =
   *  2.75625), so the fixture needs no rounding argument. */
  const docSamplesForWindows = (windows: number): number =>
    ((SEG_WINDOW + (windows - 1) * SEG_SHIFT) * 44100) / 16000;

  function addStemDoc(name: string, samples: number): AudioDocument {
    const channels = [0, 1].map((c) => {
      const ch = new Float32Array(samples);
      for (let i = 0; i < ch.length; i++) {
        ch[i] = 0.4 * Math.sin((2 * Math.PI * (140 + 60 * c) * i) / 44100) + (c === 0 ? 0.04 : -0.02);
      }
      return ch;
    });
    const doc = createDocument({ name, sampleRate: 44100, channels });
    useAppStore.getState().addDocument(doc);
    return doc;
  }

  /** One window with the three local slots on three frame ranges — the
   *  overlap-free shape `diarizeService.test.ts` derives its segments from. */
  function fixtureWindow(): Uint8Array {
    return classWindow([
      { from: 0, to: 200, class: 1 },
      { from: 200, to: 400, class: 2 },
      { from: 400, to: WIRE_WINDOW_FRAMES, class: 3 },
    ]);
  }

  /** One window with slots 0 and 1 active over EVERY frame: powerset class 4
   *  is `[0, 1]` (D3's POWERSET), the two-slot class the host sends when two
   *  voices talk at once — so `speakerCountPerFrame` reads 2 and the assembly
   *  keeps both clusters active on the same frames. */
  function crosstalkWindow(): Uint8Array {
    return classWindow([{ from: 0, to: WIRE_WINDOW_FRAMES, class: 4 }]);
  }

  /** Voice A holds slot 0 in every window plus slot 2 of window 0 (four
   *  fragments); voice B holds slot 1 everywhere plus slot 2 of windows 1 and 2
   *  (five). Both at or above MIN_CLUSTER_SIZE, which is what stops the auto
   *  fold collapsing them into one. */
  const AXES: { windowIndex: number; localSpeaker: number; axis: number }[] = [
    { windowIndex: 0, localSpeaker: 0, axis: 0 },
    { windowIndex: 0, localSpeaker: 1, axis: 1 },
    { windowIndex: 0, localSpeaker: 2, axis: 0 },
    { windowIndex: 1, localSpeaker: 0, axis: 0 },
    { windowIndex: 1, localSpeaker: 1, axis: 1 },
    { windowIndex: 1, localSpeaker: 2, axis: 1 },
    { windowIndex: 2, localSpeaker: 0, axis: 0 },
    { windowIndex: 2, localSpeaker: 1, axis: 1 },
    { windowIndex: 2, localSpeaker: 2, axis: 1 },
  ];
  const ACTIVE_FRAMES = [200, 200, WIRE_WINDOW_FRAMES - 400];

  /** Streams `windowCount` windows and the fragments belonging to them, with
   *  the host's own progress for both stages, then settles the invoke. */
  function streamFixture(windowCount: number): void {
    for (let i = 0; i < windowCount; i++) {
      backend.emit.progress({ stage: 'segment', done: i + 1, total: windowCount });
      backend.emit.window({ index: i, labels: fixtureWindow() });
    }
    const fragments = AXES.filter((f) => f.windowIndex < windowCount);
    fragments.forEach((f, k) => {
      backend.emit.progress({ stage: 'embed', done: k + 1, total: fragments.length });
      backend.emit.embedding({
        windowIndex: f.windowIndex,
        localSpeaker: f.localSpeaker,
        activeFrames: ACTIVE_FRAMES[f.localSpeaker],
        vector: speakerVector(f.axis, 4000 + k * 37),
      });
    });
    backend.settle({ ok: true, windowCount });
  }

  it('reports the two-file model set the diarizer needs', async () => {
    const t = api();
    backend.modelState = { downloaded: false, bytes: 1024, expectedBytes: WIRE_MODEL_BYTES };

    const state = await t.getDiarizeModelState();

    expect(state).toEqual({ downloaded: false, bytes: 1024, expectedBytes: WIRE_MODEL_BYTES });
    expect(backend.modelStateCalls).toBe(1);
    expectPlainJson(state);
  });

  it('runs the real host on the active document and flattens the evidence to scalars', async () => {
    const t = api();
    addStemDoc('stem.wav', docSamplesForWindows(3));

    const promise = t.diarizeActive();
    await flushUntil(() => backend.isPending());
    streamFixture(3);
    const summary = await promise;

    expect(summary.ok).toBe(true);
    expect(summary.status).toBe('ok');
    expect(summary.message).toBeNull();
    // The document the hook handed over: its own rate and length, resampled
    // once to the model's 16 kHz.
    expect(backend.lastRequest?.sampleRate).toBe(16000);
    expect(backend.lastRequest?.samples.byteLength).toBe((SEG_WINDOW + 2 * SEG_SHIFT) * 4);
    expect(summary.sampleRate).toBe(44100);
    expect(summary.lengthSamples).toBe(docSamplesForWindows(3));
    expect(summary.totalSamples16k).toBe(SEG_WINDOW + 2 * SEG_SHIFT);
    expect(summary.windowCount).toBe(3);
    expect(summary.embeddingCount).toBe(AXES.length);
    // Two voices, neither folded and neither under the share floor.
    expect(summary.speakerCount).toBe(2);
    expect(summary.preFoldClusterCount).toBe(2);
    expect(summary.rawClusterCount).toBe(2);
    expect(summary.segmentCount).toBe(2);
    expect(summary.overlapCount).toBe(0);
    expect(summary.speechSeconds).toHaveLength(2);
    for (const s of summary.speechSeconds) expect(s).toBeGreaterThan(0);
    // The host really streamed, and the service really walked its phases.
    expect(summary.progressEvents).toBeGreaterThan(0);
    expect(summary.phasesSeen).toEqual(['resampling', 'segmenting', 'embedding', 'clustering']);
    expect(summary.maxFraction).toBe(1);
    expectPlainJson(summary);
  });

  it('reports the fold and the output count as the three DIFFERENT numbers they are', async () => {
    const t = api();
    // One window, three one-fragment voices: every cluster is below
    // MIN_CLUSTER_SIZE, so the measured fold (D3) collapses all three into the
    // largest and one speaker comes out of three raw clusters.
    addStemDoc('trio.wav', docSamplesForWindows(1));

    const promise = t.diarizeActive();
    await flushUntil(() => backend.isPending());
    backend.emit.window({ index: 0, labels: fixtureWindow() });
    [0, 1, 2].forEach((local) => {
      backend.emit.embedding({
        windowIndex: 0,
        localSpeaker: local,
        activeFrames: ACTIVE_FRAMES[local],
        vector: speakerVector(local, 7000 + local * 53),
      });
    });
    backend.settle({ ok: true, windowCount: 1 });
    const summary = await promise;

    expect(summary.preFoldClusterCount).toBe(3);
    expect(summary.rawClusterCount).toBe(1);
    expect(summary.speakerCount).toBe(1);
    expectPlainJson(summary);
  });

  it('reports the assemblys overlap runs, which a two-slot window really produces', async () => {
    const t = api();
    // MIN_CLUSTER_SIZE windows -> MIN_CLUSTER_SIZE fragments per voice, the
    // boundary the auto fold keeps (D3), and every frame of every window
    // carries BOTH slots. The two voices are then active over the same span,
    // which is exactly what `finalize`'s sweep line calls overlap.
    addStemDoc('crosstalk.wav', docSamplesForWindows(MIN_CLUSTER_SIZE));

    const promise = t.diarizeActive();
    await flushUntil(() => backend.isPending());
    for (let i = 0; i < MIN_CLUSTER_SIZE; i++) {
      backend.emit.window({ index: i, labels: crosstalkWindow() });
      [0, 1].forEach((local) => {
        backend.emit.embedding({
          windowIndex: i,
          localSpeaker: local,
          activeFrames: WIRE_WINDOW_FRAMES,
          vector: speakerVector(local, 9000 + i * 31 + local),
        });
      });
    }
    backend.settle({ ok: true, windowCount: MIN_CLUSTER_SIZE });
    const summary = await promise;

    expect(summary.speakerCount).toBe(2);
    expect(summary.segmentCount).toBe(2);
    // The field the overlap-free fixture above pins at 0 — measured here
    // against a timeline that really has an overlap run, so the two together
    // say the hook reports the assembly rather than a constant.
    expect(summary.overlapCount).toBe(1);
    expectPlainJson(summary);
  });

  it('reports the elapsed wall clock of the run, not the seed zero', async () => {
    const t = api();
    addStemDoc('stem.wav', docSamplesForWindows(1));
    // `Date.now` is the hook's only clock, and a real run here finishes inside
    // one millisecond — so the elapsed figure would read 0, which is also the
    // value the unwired seed carries. The stub advances 250 ms PER READ, which
    // turns the figure into a count of the clock reads the run takes between
    // the hook's own two.
    let clock = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => (clock += 250));

    const promise = t.diarizeActive();
    await flushUntil(() => backend.isPending());
    streamFixture(1);
    const summary = await promise;

    expect(summary.ok).toBe(true);
    // The measured figure, not a floor: ">= 250" is also satisfied by a hook
    // that reported an absolute clock read (~1,000,750 under this stub) and by
    // one whose two reads sat back to back around no work at all (250). 3,250
    // is the span of the whole run: 250 ms times the thirteen reads that
    // separate the hook's two, twelve of which the run itself takes. A change
    // in it is a real change in what the reported window covers, to be
    // re-measured rather than re-tuned.
    expect(summary.elapsedMs).toBe(3250);
  });

  it('reports a missing model set without spawning anything', async () => {
    const t = api();
    addStemDoc('stem.wav', docSamplesForWindows(1));
    backend.modelState = { downloaded: false, bytes: null, expectedBytes: WIRE_MODEL_BYTES };

    const summary = await t.diarizeActive();

    expect(summary.ok).toBe(false);
    expect(summary.status).toBe('model-missing');
    expect(summary.message).toContain('32.5 MB');
    expect(backend.runCalls).toBe(0);
    expect(summary.speakerCount).toBe(0);
    expectPlainJson(summary);
  });

  it('reports a host failure as a status and a message, never a rejection', async () => {
    const t = api();
    addStemDoc('stem.wav', docSamplesForWindows(1));

    const promise = t.diarizeActive();
    await flushUntil(() => backend.isPending());
    backend.settle({ ok: false, error: 'the diarization host died' });
    const summary = await promise;

    expect(summary.ok).toBe(false);
    expect(summary.status).toBe('failed');
    expect(summary.message).toBe('the diarization host died');
    expectPlainJson(summary);
  });

  it('answers no-document without calling the host at all', async () => {
    const t = api();

    const summary = await t.diarizeActive();

    expect(summary.ok).toBe(false);
    expect(summary.status).toBe('no-document');
    expect(backend.runCalls).toBe(0);
    expect(backend.modelStateCalls).toBe(0);
    expect(summary.windowCount).toBe(0);
    expectPlainJson(summary);
  });
});
