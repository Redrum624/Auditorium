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
