/**
 * Task B1 — the beat-grid selector and derived-document inheritance.
 *
 * Every fixture here goes through the REAL analysis path (the tempo worker
 * mock runs `analyzeTempo`/`deriveRemixFeatures` on the main thread), so bar
 * data in these tests is measured, never hand-written — the same rule the
 * production module obeys (AMENDED RULING 1: never manufacture bar data).
 */
import { renderHook, act } from '@testing-library/react';
import {
  getBeatGrid,
  isDownbeat,
  linkDerivedDocument,
  releaseBeatGrid,
  clearBeatGridLinks,
  useBeatGridVersion,
  _getBeatGridLinkForTest,
} from './beatGrid';
import {
  getRemixAnalysis,
  getTempo,
  runRemixAnalysis,
  runTempoAnalysis,
  clearAllTempo,
  invalidateTempo,
  _promoteToRemixLevelForTest,
  _getCachedChannelRefsForTest,
} from './tempoAnalysis';
import { closeDocumentFlow } from './fileService';
import { createDocument, replaceRegion, type AudioDocument } from '../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { applyEdit } from './editOps';
import * as createTempoWorkerModule from '../workers/createTempoWorker';
import { _resetTempoWorkerTestState } from '../__mocks__/createTempoWorkerMock';

const SR = 44100;

/** A unit-impulse click train — the same local generator `tempoAnalysis.test.ts`
 * declares (this repo re-declares fixtures per file rather than sharing one). */
function clickTrain(bpm: number, seconds: number, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const interval = Math.round((60 / bpm) * sr);
  for (let i = 0; i < n; i += interval) out[i] = 1;
  return out;
}

function seedDoc(channels: Float32Array[], sampleRate = SR, name = 'test.wav'): AudioDocument {
  const doc = createDocument({ name, sampleRate, channels });
  useAppStore.getState().addDocument(doc);
  return doc;
}

function liveDoc(docId: string): AudioDocument {
  const doc = useAppStore.getState().documents.find((d) => d.id === docId);
  if (!doc) throw new Error(`liveDoc: not found: ${docId}`);
  return doc;
}

/** A second document that is byte-for-byte a partition of `parent` — the shape
 * `landStems` produces (same rate, same length, independent arrays). */
function seedDerived(parent: AudioDocument, name: string): AudioDocument {
  return seedDoc(
    parent.channels.map((c) => Float32Array.from(c)),
    parent.sampleRate,
    name
  );
}

/** Answers every dialog with button index 1 — which for `closeDocumentFlow`'s
 * unsaved-work prompt is "Don't Save", so a fixture document (created in
 * memory, hence `neverSaved`) closes without a save dialog. */
function installShowMessageBox(): jest.Mock {
  const showMessageBox = jest.fn(async () => 1);
  (window as unknown as { electronAPI: { showMessageBox: typeof showMessageBox } }).electronAPI = {
    showMessageBox,
  };
  return showMessageBox;
}

/** Armed around every read-only assertion: the selector must NEVER start an
 * analysis, and `createTempoWorker` is the single entry point to one. */
let workerSpy: jest.SpyInstance;

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  clearAllTempo();
  clearBeatGridLinks();
  _resetTempoWorkerTestState();
  installShowMessageBox();
  workerSpy = jest.spyOn(createTempoWorkerModule, 'createTempoWorker');
});

afterEach(() => {
  workerSpy.mockRestore();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

/** Calls used to SEED fixtures legitimately create workers; this resets the
 * counter so the following assertion only covers the selector's own calls. */
function armNoAnalysisAssertion(): void {
  workerSpy.mockClear();
}

function expectNoAnalysisStarted(): void {
  expect(workerSpy).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// 1. Resolution against the document's own analysis
// ---------------------------------------------------------------------------

describe('getBeatGrid — own analysis', () => {
  it('returns null for a document with no analysis, and starts nothing', () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    armNoAnalysisAssertion();

    expect(getBeatGrid(doc.id)).toBeNull();
    expect(getBeatGrid(doc.id)).toBeNull();

    expectNoAnalysisStarted();
  });

  it('returns null for a document id that is not open, and starts nothing', () => {
    armNoAnalysisAssertion();
    expect(getBeatGrid('doc-does-not-exist')).toBeNull();
    expectNoAnalysisStarted();
  });

  it('a tempo-level document returns beats and NO downbeats', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    const analysis = await runTempoAnalysis(doc);
    expect(analysis?.beatSamples.length).toBeGreaterThan(4);
    armNoAnalysisAssertion();

    const grid = getBeatGrid(doc.id);

    expect(grid).not.toBeNull();
    if (!grid) return;
    expect(grid.beatSamples).toBe(analysis?.beatSamples);
    expect(grid.sampleRate).toBe(SR);
    expect(grid.beatsPerBar).toBeNull();
    expect(grid.downbeatPhase).toBeNull();
    expect(grid.barCount).toBe(0);
    expect(grid.stale).toBe(false);
    expect(grid.confidence).toBe(analysis?.confidence);
    expect(grid.analyzedEndSample).toBe(analysis?.analyzedEndSample);
    expect(grid.truncated).toBe(false);
    expect(grid.origin).toBe('own');
    expect(grid.originDocId).toBe(doc.id);
    expect(grid.originOpen).toBe(true);

    for (let i = 0; i < grid.beatSamples.length; i++) {
      expect(isDownbeat(grid, i)).toBe(false);
    }
    expectNoAnalysisStarted();
  });

  it('a remix-level document returns beats AND downbeats, classified by phase (never by searching barBoundary)', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    const remix = await runRemixAnalysis(doc);
    expect(remix).not.toBeNull();
    expect(remix?.numBars).toBeGreaterThan(0);
    armNoAnalysisAssertion();

    const grid = getBeatGrid(doc.id);

    expect(grid).not.toBeNull();
    if (!grid || !remix) return;
    expect(grid.beatsPerBar).toBe(remix.beatsPerBar);
    expect(grid.downbeatPhase).toBe(remix.downbeatPhase);
    expect(grid.barCount).toBe(remix.numBars);

    // The classification agrees EXACTLY with the measured boundary list.
    const boundaries = new Set(Array.from(remix.barBoundary));
    let classified = 0;
    for (let i = 0; i < grid.beatSamples.length; i++) {
      const down = isDownbeat(grid, i);
      if (down) {
        classified++;
        expect(boundaries.has(grid.beatSamples[i])).toBe(true);
      }
    }
    expect(classified).toBe(remix.barBoundary.length);
    expectNoAnalysisStarted();
  });

  it('bar data present but EMPTY is "no downbeats", not an error', async () => {
    // beatsPerBar wider than the fixture has beats -> deriveRemixFeatures
    // returns emptyRemixAnalysis: beatsPerBar/downbeatPhase set, barBoundary
    // empty, numBars 0.
    const doc = seedDoc([clickTrain(120, 8)]);
    const remix = await runRemixAnalysis(doc, { beatsPerBar: 32 });
    expect(remix).not.toBeNull();
    expect(remix?.numBars).toBe(0);
    expect(remix?.barBoundary.length).toBe(0);
    armNoAnalysisAssertion();

    const grid = getBeatGrid(doc.id);

    expect(grid).not.toBeNull();
    if (!grid) return;
    expect(grid.beatSamples.length).toBeGreaterThan(4);
    expect(grid.beatsPerBar).toBeNull();
    expect(grid.downbeatPhase).toBeNull();
    expect(grid.barCount).toBe(0);
    for (let i = 0; i < grid.beatSamples.length; i++) expect(isDownbeat(grid, i)).toBe(false);
    expectNoAnalysisStarted();
  });

  it('a level:"remix" row with NO bar fields at all yields beats and no downbeats', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    await runTempoAnalysis(doc);
    // Relabels a real TempoAnalysis as level:'remix' — the row satisfies
    // getRemixAnalysis's level test while carrying no barBoundary/beatsPerBar.
    _promoteToRemixLevelForTest(doc.id);
    expect(getRemixAnalysis(liveDoc(doc.id))).not.toBeNull();
    armNoAnalysisAssertion();

    const grid = getBeatGrid(doc.id);

    expect(grid).not.toBeNull();
    if (!grid) return;
    expect(grid.beatSamples.length).toBeGreaterThan(4);
    expect(grid.beatsPerBar).toBeNull();
    expect(grid.downbeatPhase).toBeNull();
    expectNoAnalysisStarted();
  });

  it('an edit marks the grid stale and withdraws the bar data (a stale remix row is never served)', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    const remix = await runRemixAnalysis(doc);
    expect(remix?.numBars).toBeGreaterThan(0);

    applyEdit('Silence', doc.id, (d) => replaceRegion(d, 100, 200, [new Float32Array(100)]));
    armNoAnalysisAssertion();

    const grid = getBeatGrid(doc.id);

    expect(grid).not.toBeNull();
    if (!grid) return;
    expect(grid.stale).toBe(true);
    expect(grid.beatSamples.length).toBeGreaterThan(4);
    expect(grid.beatsPerBar).toBeNull();
    expect(grid.downbeatPhase).toBeNull();
    expectNoAnalysisStarted();
  });

  it('an analysis that found no beats resolves to null rather than an empty grid', async () => {
    // Under MIN_ANALYSIS_SECONDS -> analyzeTempo returns the empty analysis.
    const doc = seedDoc([new Float32Array(SR)]);
    const entry = await runTempoAnalysis(doc);
    expect(entry?.beatSamples.length).toBe(0);
    armNoAnalysisAssertion();

    expect(getBeatGrid(doc.id)).toBeNull();
    expectNoAnalysisStarted();
  });
});

// ---------------------------------------------------------------------------
// 2. Derived-document inheritance
// ---------------------------------------------------------------------------

describe('getBeatGrid — derived-document inheritance', () => {
  it('a stem resolves through its PARENT and never through an analysis of its own', async () => {
    const source = seedDoc([clickTrain(120, 8)], SR, 'Song.wav');
    const analysis = await runTempoAnalysis(source);
    const stem = seedDerived(source, 'Song — Drums');
    linkDerivedDocument(stem.id, source.id);
    armNoAnalysisAssertion();

    const grid = getBeatGrid(stem.id);

    expect(grid).not.toBeNull();
    if (!grid) return;
    // Identity copy — the SAME positions, no rate or offset conversion.
    expect(grid.beatSamples).toBe(analysis?.beatSamples);
    expect(grid.sampleRate).toBe(source.sampleRate);
    expect(grid.origin).toBe('inherited');
    expect(grid.originDocId).toBe(source.id);
    expect(grid.originOpen).toBe(true);
    expect(grid.stale).toBe(false);
    expectNoAnalysisStarted();
  });

  it('inherits the parent\'s downbeats too', async () => {
    const source = seedDoc([clickTrain(120, 8)], SR, 'Song.wav');
    const remix = await runRemixAnalysis(source);
    const stem = seedDerived(source, 'Song — Bass');
    linkDerivedDocument(stem.id, source.id);
    armNoAnalysisAssertion();

    const grid = getBeatGrid(stem.id);

    expect(grid?.beatsPerBar).toBe(remix?.beatsPerBar);
    expect(grid?.downbeatPhase).toBe(remix?.downbeatPhase);
    expect(grid?.barCount).toBe(remix?.numBars);
    expectNoAnalysisStarted();
  });

  it('a stem with its OWN analysis uses it in preference to the inherited grid', async () => {
    const source = seedDoc([clickTrain(120, 8)], SR, 'Song.wav');
    await runTempoAnalysis(source);
    const stem = seedDerived(source, 'Song — Drums');
    linkDerivedDocument(stem.id, source.id);
    const ownAnalysis = await runTempoAnalysis(liveDoc(stem.id));
    armNoAnalysisAssertion();

    const grid = getBeatGrid(stem.id);

    expect(grid?.origin).toBe('own');
    expect(grid?.originDocId).toBe(stem.id);
    expect(grid?.beatSamples).toBe(ownAnalysis?.beatSamples);
    expectNoAnalysisStarted();
  });

  it('a parent with no analysis yields no grid for the child (nothing is started to make one)', () => {
    const source = seedDoc([clickTrain(120, 8)], SR, 'Song.wav');
    const stem = seedDerived(source, 'Song — Drums');
    linkDerivedDocument(stem.id, source.id);
    armNoAnalysisAssertion();

    expect(getBeatGrid(stem.id)).toBeNull();
    expectNoAnalysisStarted();
  });

  it('a stale PARENT grid stays stale through the inheritance', async () => {
    const source = seedDoc([clickTrain(120, 8)], SR, 'Song.wav');
    await runTempoAnalysis(source);
    const stem = seedDerived(source, 'Song — Drums');
    linkDerivedDocument(stem.id, source.id);

    applyEdit('Silence', source.id, (d) => replaceRegion(d, 100, 200, [new Float32Array(100)]));
    armNoAnalysisAssertion();

    expect(getBeatGrid(stem.id)?.stale).toBe(true);
    expectNoAnalysisStarted();
  });

  it('editing the CHILD after the link marks the inherited grid stale', async () => {
    const source = seedDoc([clickTrain(120, 8)], SR, 'Song.wav');
    await runTempoAnalysis(source);
    const stem = seedDerived(source, 'Song — Drums');
    linkDerivedDocument(stem.id, source.id);
    expect(getBeatGrid(stem.id)?.stale).toBe(false);

    applyEdit('Silence', stem.id, (d) => replaceRegion(d, 100, 200, [new Float32Array(100)]));
    armNoAnalysisAssertion();

    const grid = getBeatGrid(stem.id);
    expect(grid).not.toBeNull();
    expect(grid?.stale).toBe(true);
    expectNoAnalysisStarted();
  });

  it('refuses to link a document that is not a sample-identical derivative', async () => {
    const source = seedDoc([clickTrain(120, 8)], SR, 'Song.wav');
    await runTempoAnalysis(source);

    const wrongRate = seedDoc([clickTrain(120, 8, 48000)], 48000, 'other-rate');
    const wrongLength = seedDoc([clickTrain(120, 4)], SR, 'other-length');
    linkDerivedDocument(wrongRate.id, source.id);
    linkDerivedDocument(wrongLength.id, source.id);
    armNoAnalysisAssertion();

    expect(_getBeatGridLinkForTest(wrongRate.id)).toBeUndefined();
    expect(_getBeatGridLinkForTest(wrongLength.id)).toBeUndefined();
    expect(getBeatGrid(wrongRate.id)).toBeNull();
    expect(getBeatGrid(wrongLength.id)).toBeNull();
    expectNoAnalysisStarted();
  });

  it('resolves a two-level chain and terminates on a cycle', async () => {
    const source = seedDoc([clickTrain(120, 8)], SR, 'Song.wav');
    const analysis = await runTempoAnalysis(source);
    const stem = seedDerived(source, 'Song — Drums');
    const subStem = seedDerived(source, 'Song — Drums — Drums');
    linkDerivedDocument(stem.id, source.id);
    linkDerivedDocument(subStem.id, stem.id);
    armNoAnalysisAssertion();

    expect(getBeatGrid(subStem.id)?.beatSamples).toBe(analysis?.beatSamples);
    expect(getBeatGrid(subStem.id)?.originDocId).toBe(source.id);

    // A cycle must terminate rather than recurse forever.
    const a = seedDerived(source, 'A');
    const b = seedDerived(source, 'B');
    linkDerivedDocument(a.id, b.id);
    linkDerivedDocument(b.id, a.id);
    expect(getBeatGrid(a.id)).toBeNull();
    expectNoAnalysisStarted();
  });
});

// ---------------------------------------------------------------------------
// 3. The parent closing — decided: DETACH a small copy, keep the grid
// ---------------------------------------------------------------------------

describe('getBeatGrid — the parent closes while the child is open', () => {
  it('keeps the grid as an INDEPENDENT copy that retains no analysis payload', async () => {
    const source = seedDoc([clickTrain(120, 8)], SR, 'Song.wav');
    const remix = await runRemixAnalysis(source);
    expect(remix?.numBars).toBeGreaterThan(0); // the bar data below is real
    const stem = seedDerived(source, 'Song — Drums');
    linkDerivedDocument(stem.id, source.id);
    const before = getBeatGrid(stem.id);
    expect(before).not.toBeNull();

    await closeDocumentFlow(source.id);
    armNoAnalysisAssertion();

    expect(useAppStore.getState().documents.find((d) => d.id === source.id)).toBeUndefined();
    // The parent's cache row is gone — only the detached copy is left.
    expect(_getCachedChannelRefsForTest(source.id)).toBeUndefined();

    const after = getBeatGrid(stem.id);
    expect(after).not.toBeNull();
    if (!after || !before || !remix) return;
    expect(Array.from(after.beatSamples)).toEqual(Array.from(before.beatSamples));
    // Independent copy: not the parent analysis's own array.
    expect(after.beatSamples).not.toBe(remix.beatSamples);
    expect(after.origin).toBe('inherited');
    expect(after.originDocId).toBe(source.id);
    expect(after.originOpen).toBe(false);
    expect(after.beatsPerBar).toBe(remix.beatsPerBar);
    expect(after.downbeatPhase).toBe(remix.downbeatPhase);
    expect(after.barCount).toBe(remix.numBars);

    // Nothing heavy came across: no odf / bands / odfLow / chroma / T / C / L / R / S.
    for (const heavy of ['odf', 'odfLow', 'bands', 'chroma', 'T', 'C', 'L', 'R', 'S', 'barBoundary']) {
      expect(Object.prototype.hasOwnProperty.call(after, heavy)).toBe(false);
    }
    expectNoAnalysisStarted();
  });

  it('a detached grid still tracks the CHILD\'s own staleness', async () => {
    const source = seedDoc([clickTrain(120, 8)], SR, 'Song.wav');
    await runTempoAnalysis(source);
    const stem = seedDerived(source, 'Song — Drums');
    linkDerivedDocument(stem.id, source.id);
    await closeDocumentFlow(source.id);
    expect(getBeatGrid(stem.id)?.stale).toBe(false);

    applyEdit('Silence', stem.id, (d) => replaceRegion(d, 100, 200, [new Float32Array(100)]));
    armNoAnalysisAssertion();

    expect(getBeatGrid(stem.id)?.stale).toBe(true);
    expectNoAnalysisStarted();
  });

  it('drops the link entirely when the closing parent had no grid to hand over', async () => {
    const source = seedDoc([clickTrain(120, 8)], SR, 'Song.wav');
    const stem = seedDerived(source, 'Song — Drums');
    linkDerivedDocument(stem.id, source.id);
    expect(_getBeatGridLinkForTest(stem.id)).toBeDefined();

    await closeDocumentFlow(source.id);

    expect(_getBeatGridLinkForTest(stem.id)).toBeUndefined();
    expect(getBeatGrid(stem.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Per-document cleanup — asserted, not assumed
// ---------------------------------------------------------------------------

describe('beat-grid links — per-document cleanup', () => {
  it('closeDocumentFlow removes the closing document\'s OWN link entry', async () => {
    const source = seedDoc([clickTrain(120, 8)], SR, 'Song.wav');
    await runTempoAnalysis(source);
    const stem = seedDerived(source, 'Song — Drums');
    linkDerivedDocument(stem.id, source.id);
    expect(_getBeatGridLinkForTest(stem.id)).toEqual({ parentDocId: source.id, detached: false });

    await closeDocumentFlow(stem.id);

    expect(_getBeatGridLinkForTest(stem.id)).toBeUndefined();
  });

  it('closeDocumentFlow leaves no link entry for either side once both are closed', async () => {
    const source = seedDoc([clickTrain(120, 8)], SR, 'Song.wav');
    await runTempoAnalysis(source);
    const stem = seedDerived(source, 'Song — Drums');
    linkDerivedDocument(stem.id, source.id);

    await closeDocumentFlow(source.id);
    expect(_getBeatGridLinkForTest(stem.id)).toEqual({ parentDocId: source.id, detached: true });

    await closeDocumentFlow(stem.id);
    expect(_getBeatGridLinkForTest(stem.id)).toBeUndefined();
  });

  it('releaseBeatGrid is idempotent and safe for an unknown id', () => {
    expect(() => releaseBeatGrid('nope')).not.toThrow();
    expect(() => releaseBeatGrid('nope')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. The selector never poisons the analysis cache (trap 1)
// ---------------------------------------------------------------------------

describe('getBeatGrid — cache purity', () => {
  it('never poisons a cache row, including across metadata-only document replacements', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    await runTempoAnalysis(doc);
    const staleHandle = liveDoc(doc.id); // the pre-rename object, deliberately kept
    armNoAnalysisAssertion();

    for (let i = 0; i < 5; i++) expect(getBeatGrid(doc.id)?.stale).toBe(false);

    // Rename: a NEW document object over the SAME channel arrays. A selector
    // that captured `staleHandle` and passed it to getTempo would flip the row
    // stale permanently and release its channelRefs.
    useAppStore.getState().updateDocument({ ...staleHandle, name: 'renamed.wav' });
    for (let i = 0; i < 5; i++) expect(getBeatGrid(doc.id)?.stale).toBe(false);

    expect(_getCachedChannelRefsForTest(doc.id)).not.toBeNull();
    expect(getTempo(liveDoc(doc.id))?.stale).toBe(false);
    expectNoAnalysisStarted();
  });

  it('never poisons the PARENT row when resolving a child', async () => {
    const source = seedDoc([clickTrain(120, 8)], SR, 'Song.wav');
    await runTempoAnalysis(source);
    const stem = seedDerived(source, 'Song — Drums');
    linkDerivedDocument(stem.id, source.id);
    armNoAnalysisAssertion();

    for (let i = 0; i < 5; i++) expect(getBeatGrid(stem.id)?.stale).toBe(false);

    expect(_getCachedChannelRefsForTest(source.id)).not.toBeNull();
    expect(getTempo(liveDoc(source.id))?.stale).toBe(false);
    expectNoAnalysisStarted();
  });
});

// ---------------------------------------------------------------------------
// 6. Cache eviction is insertion-ordered, not LRU (trap 2) — pinned, not papered over
// ---------------------------------------------------------------------------

describe('getBeatGrid — the 4-row analysis cache', () => {
  it('a displayed grid VANISHES when a 5th document is analysed (insertion-ordered eviction, reading does not protect)', async () => {
    const first = seedDoc([clickTrain(120, 8)], SR, 'first.wav');
    await runTempoAnalysis(first);
    expect(getBeatGrid(first.id)).not.toBeNull();

    // Three more fill the 4-row cache; `first` survives, and is READ each time
    // — which, the point of this test, buys it nothing.
    for (let i = 0; i < 3; i++) {
      const doc = seedDoc([clickTrain(100 + i, 8)], SR, `other-${i}.wav`);
      await runTempoAnalysis(doc);
      expect(getBeatGrid(first.id)).not.toBeNull();
    }

    // The 5th evicts the OLDEST row (insertion order), not the least recently
    // read — so the grid on screen disappears with no error anywhere.
    const fifth = seedDoc([clickTrain(140, 8)], SR, 'fifth.wav');
    await runTempoAnalysis(fifth);

    expect(getBeatGrid(first.id)).toBeNull();
    expect(getBeatGrid(fifth.id)).not.toBeNull();
  });

  it('a source plus five stems occupy ONE cache row, so the stem workflow stays inside the bound', async () => {
    const source = seedDoc([clickTrain(120, 8)], SR, 'Song.wav');
    await runTempoAnalysis(source);
    const stems = ['Drums', 'Bass', 'Vocals', 'Other', 'Residual'].map((label) => {
      const stem = seedDerived(source, `Song — ${label}`);
      linkDerivedDocument(stem.id, source.id);
      return stem;
    });
    armNoAnalysisAssertion();

    for (const stem of stems) {
      expect(getBeatGrid(stem.id)?.originDocId).toBe(source.id);
    }
    expect(getBeatGrid(source.id)?.origin).toBe('own');
    expectNoAnalysisStarted();

    // One row, so invalidating the source is the only thing that can lose it.
    invalidateTempo(source.id);
    for (const stem of stems) expect(getBeatGrid(stem.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Reactivity — one subscription for B2/B3
// ---------------------------------------------------------------------------

describe('useBeatGridVersion', () => {
  it('changes when a link is added, when a link is released, and when an analysis lands', async () => {
    const source = seedDoc([clickTrain(120, 8)], SR, 'Song.wav');
    const stem = seedDerived(source, 'Song — Drums');

    const { result } = renderHook(() => useBeatGridVersion());
    const v0 = result.current;

    await act(async () => {
      await runTempoAnalysis(source);
    });
    const v1 = result.current;
    expect(v1).not.toBe(v0);

    act(() => {
      linkDerivedDocument(stem.id, source.id);
    });
    const v2 = result.current;
    expect(v2).not.toBe(v1);

    await act(async () => {
      await closeDocumentFlow(source.id);
    });
    expect(result.current).not.toBe(v2);
  });
});
