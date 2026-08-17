import { buildEditorSnapTargets, editorSnapTargets } from './editorSnapTargets';
import * as beatGridService from '../../services/beatGrid';
import type { BeatGrid } from '../../services/beatGrid';
import { _resetSnapPreference, setSnapEnabled } from '../../services/snapPreference';
import { makeInitialState, useAppStore, type Marker } from '../../stores/appStore';

function makeGrid(patch: Partial<BeatGrid> = {}): BeatGrid {
  return {
    beatSamples: Int32Array.from([0, 22_050, 44_100, 66_150]),
    sampleRate: 44_100,
    beatsPerBar: null,
    downbeatPhase: null,
    barCount: 0,
    confidence: 0.9,
    stale: false,
    analyzedEndSample: 1_000_000,
    truncated: false,
    origin: 'own',
    originDocId: 'doc-1',
    originOpen: true,
    ...patch,
  };
}

function marker(positionSample: number, name = 'm'): Marker {
  return { id: `mk-${positionSample}`, name, positionSample };
}

describe('buildEditorSnapTargets (pure)', () => {
  it('returns the beats when there are no markers', () => {
    expect(buildEditorSnapTargets(makeGrid(), undefined)).toEqual([0, 22_050, 44_100, 66_150]);
  });

  it('returns the markers when there is no grid', () => {
    expect(buildEditorSnapTargets(null, [marker(500), marker(100)])).toEqual([100, 500]);
  });

  it('merges beats and markers into one ascending, duplicate-free set', () => {
    // 22 050 is BOTH a beat and a marker — it must appear once.
    const out = buildEditorSnapTargets(makeGrid(), [marker(22_050), marker(30_000)]);
    expect(out).toEqual([0, 22_050, 30_000, 44_100, 66_150]);
  });

  it('adds NO extra entries for bar lines — a bar line IS one of the beats', () => {
    // AMENDED RULING 1: barBoundary is exactly the subsequence
    // beatSamples[downbeatPhase + m*beatsPerBar], so downbeats are already in
    // the beat list. A separate bar-line pass would only produce duplicates.
    const plain = buildEditorSnapTargets(makeGrid(), undefined);
    const measured = buildEditorSnapTargets(
      makeGrid({ beatsPerBar: 2, downbeatPhase: 0, barCount: 2 }),
      undefined
    );
    expect(measured).toEqual(plain);
  });

  it('never extrapolates past analyzedEndSample', () => {
    const out = buildEditorSnapTargets(makeGrid({ analyzedEndSample: 44_100 }), undefined);
    expect(out).toEqual([0, 22_050, 44_100]);
  });

  it('does not mutate the grid’s shared beatSamples array', () => {
    const grid = makeGrid({ beatSamples: Int32Array.from([66_150, 0, 22_050]) });
    const before = Array.from(grid.beatSamples);
    buildEditorSnapTargets(grid, undefined);
    expect(Array.from(grid.beatSamples)).toEqual(before);
  });

  it('is empty when there is neither a grid nor a marker', () => {
    expect(buildEditorSnapTargets(null, undefined)).toEqual([]);
    expect(buildEditorSnapTargets(null, [])).toEqual([]);
  });
});

describe('editorSnapTargets (store-resolving)', () => {
  let gridSpy: jest.SpyInstance;

  beforeEach(() => {
    useAppStore.setState(makeInitialState());
    _resetSnapPreference();
    gridSpy = jest.spyOn(beatGridService, 'getBeatGrid').mockReturnValue(makeGrid());
  });

  afterEach(() => {
    gridSpy.mockRestore();
    _resetSnapPreference();
  });

  it('resolves the active document’s grid and markers', () => {
    useAppStore.setState({ markers: { 'doc-1': [marker(1_000)] } });
    expect(editorSnapTargets('doc-1')).toEqual([0, 1_000, 22_050, 44_100, 66_150]);
    expect(gridSpy).toHaveBeenCalledWith('doc-1');
  });

  it('is EMPTY when the magnet is switched off — the single choke point', () => {
    setSnapEnabled(false);
    expect(editorSnapTargets('doc-1')).toEqual([]);
    // and it does not even ask for a grid
    expect(gridSpy).not.toHaveBeenCalled();
  });

  it('is empty for a null document id, and asks for no grid', () => {
    expect(editorSnapTargets(null)).toEqual([]);
    expect(gridSpy).not.toHaveBeenCalled();
  });

  it('uses only the requested document’s markers', () => {
    useAppStore.setState({ markers: { 'doc-1': [marker(1_000)], 'doc-2': [marker(2_000)] } });
    expect(editorSnapTargets('doc-1')).toContain(1_000);
    expect(editorSnapTargets('doc-1')).not.toContain(2_000);
  });

  it('follows the beat grid even when the tics are HIDDEN', async () => {
    const { setBeatGridVisible } = await import('../../services/beatGridDisplay');
    setBeatGridVisible(false);
    expect(editorSnapTargets('doc-1')).toContain(22_050);
    setBeatGridVisible(true);
  });
});
