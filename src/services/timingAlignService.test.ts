/**
 * Task F9 — the anchors-from-markers service and the effect it drives.
 *
 * Every fixture goes through the REAL analysis path (the tempo worker mock runs
 * `analyzeTempo` on the main thread) and the REAL effect path (the dsp worker
 * mock runs `process`), so a grid here is measured and a warp here is the warp
 * that ships. Nothing is hand-stubbed except the message box.
 */
import {
  alignRegion,
  applyTimingAlignment,
  buildAlignPlan,
  suggestSyllableMarkers,
  MAX_SUGGEST_SECONDS,
  MAX_SYLLABLE_MARKERS,
} from './timingAlignService';
import { alignTimingEffect, ALIGN_TIMING_EFFECT_ID, type AlignTimingExtra } from '../effects/time/AlignTimingEffect';
import { MATCH_TEMPO_VARIABLE_EFFECT_ID } from '../effects/time/MatchTempoVariableEffect';
import { getVisibleEffects, getAllEffects } from '../effects/EffectRegistry';
import { registerAllEffects } from '../effects/registerAll';
import { runTempoAnalysis, clearAllTempo } from './tempoAnalysis';
import { getBeatGrid, clearBeatGridLinks } from './beatGrid';
import * as beatGridModule from './beatGrid';
import * as effectRunnerModule from './effectRunner';
import { synthesisPosAt, buildWarpMap } from '../dsp/timingWarp';
import { _setDspWorkerLoadFailure } from '../__mocks__/createDspWorkerMock';
import { getHistory, undo } from './undoHistory';
import { createDocument, docLength, type AudioDocument } from '../audio/AudioDocument';
import { useAppStore, makeInitialState, type Marker } from '../stores/appStore';
import { DEFAULT_STRENGTH } from '../dsp/timingWarp';
import { _resetDspWorkerTestState } from '../__mocks__/createDspWorkerMock';
import { _resetTempoWorkerTestState } from '../__mocks__/createTempoWorkerMock';

registerAllEffects();

const SR = 44100;

/** A click train — the repo's per-file fixture convention. */
function clickTrain(bpm: number, seconds: number, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const interval = Math.round((60 / bpm) * sr);
  for (let i = 0; i < n; i += interval) out[i] = 1;
  return out;
}

function seedDoc(channels: Float32Array[], sampleRate = SR, name = 'take.wav'): AudioDocument {
  const doc = createDocument({ name, sampleRate, channels });
  useAppStore.getState().addDocument(doc);
  return doc;
}

function setMarkers(docId: string, positions: number[]): void {
  const list: Marker[] = positions.map((positionSample, i) => ({
    id: `m${i}`,
    name: `Syllable ${i + 1}`,
    positionSample,
  }));
  useAppStore.getState().setMarkersForDoc(docId, list);
}

async function seedAnalysedDoc(bpm = 120, seconds = 12): Promise<AudioDocument> {
  const doc = seedDoc([clickTrain(bpm, seconds)]);
  await runTempoAnalysis(doc);
  const grid = getBeatGrid(doc.id);
  if (!grid) throw new Error('fixture did not produce a beat grid');
  return doc;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  clearAllTempo();
  clearBeatGridLinks();
  _resetDspWorkerTestState();
  _resetTempoWorkerTestState();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    showMessageBox: jest.fn(async () => 0),
  };
});

// ---------------------------------------------------------------------------
// The effect's registration and its refusal
// ---------------------------------------------------------------------------

describe('alignTimingEffect registration', () => {
  it('is registered so the worker can run it', () => {
    expect(getAllEffects().map((e) => e.id)).toContain(ALIGN_TIMING_EFFECT_ID);
    expect(alignTimingEffect.category).toBe('Time & Pitch');
  });

  it('is HIDDEN from every user-facing list', () => {
    expect(alignTimingEffect.hidden).toBe(true);
    expect(getVisibleEffects().map((e) => e.id)).not.toContain(ALIGN_TIMING_EFFECT_ID);
    // The hidden roster, named. `- 1` used to stand here and it encoded "there
    // is exactly one hidden effect" — a fact, not a property, and R7's hidden
    // `match-tempo-variable` falsified it. Deriving the count from `!e.hidden`
    // instead would mirror `getVisibleEffects` line for line and could never
    // fail, so the roster is asserted by ID: a third hidden effect has to be
    // added here deliberately rather than sliding a count along.
    const hiddenIds = getAllEffects()
      .filter((e) => e.hidden)
      .map((e) => e.id)
      .sort();
    expect(hiddenIds).toEqual([ALIGN_TIMING_EFFECT_ID, MATCH_TEMPO_VARIABLE_EFFECT_ID].sort());
    // The filter is a filter, not a truncation: everything else survives it.
    expect(getVisibleEffects()).toHaveLength(getAllEffects().length - hiddenIds.length);
    expect(getVisibleEffects().map((e) => e.id)).toContain('pitch-correct');
    expect(getVisibleEffects().map((e) => e.id)).toContain('amplify');
  });

  it('defaults its strength to DEFAULT_STRENGTH, as a percentage', () => {
    const param = alignTimingEffect.params.find((p) => p.id === 'strengthPercent');
    expect(param?.default).toBe(Math.round(DEFAULT_STRENGTH * 100));
    expect(param?.min).toBe(0);
    expect(param?.max).toBe(100);
  });

  it('refuses loudly with no anchors rather than silently returning the input', () => {
    delete (globalThis as { __effectExtra?: unknown }).__effectExtra;
    const x = new Float32Array(4096);
    expect(() => alignTimingEffect.process([x], SR, { strengthPercent: 25 })).toThrow(/anchors/i);

    (globalThis as { __effectExtra?: AlignTimingExtra }).__effectExtra = { anchors: [] };
    expect(() => alignTimingEffect.process([x], SR, { strengthPercent: 25 })).toThrow(/anchors/i);
    delete (globalThis as { __effectExtra?: unknown }).__effectExtra;
  });

  it('warps through the side channel and keeps the region length', () => {
    const x = new Float32Array(44100);
    for (let i = 0; i < x.length; i++) x[i] = 0.4 + 0.2 * Math.sin((2 * Math.PI * 300 * i) / SR);
    (globalThis as { __effectExtra?: AlignTimingExtra }).__effectExtra = {
      anchors: [{ source: 22050, target: 23050 }],
    };
    try {
      const out = alignTimingEffect.process([x], SR, { strengthPercent: 100 });
      expect(out.channels[0]).toHaveLength(x.length);
      expect(Array.from(out.channels[0])).not.toEqual(Array.from(x));
      expect(out.removedSpans).toBeUndefined();

      // strengthPercent 0 is the byte-identical pass-through, through the
      // effect's own param plumbing — not just through the DSP function.
      const zero = alignTimingEffect.process([x], SR, { strengthPercent: 0 });
      expect(Array.from(zero.channels[0])).toEqual(Array.from(x));
    } finally {
      delete (globalThis as { __effectExtra?: unknown }).__effectExtra;
    }
  });
});

// ---------------------------------------------------------------------------
// buildAlignPlan
// ---------------------------------------------------------------------------

describe('buildAlignPlan refusals', () => {
  it('refuses with no document', () => {
    expect(buildAlignPlan({ division: 1, strength: 1 })).toEqual({ ok: false, reason: 'no-document' });
  });

  it('refuses with no cached grid, and does NOT start an analysis to get one', async () => {
    const spy = jest.spyOn(await import('../workers/createTempoWorker'), 'createTempoWorker');
    seedDoc([clickTrain(120, 12)]);
    expect(buildAlignPlan({ division: 1, strength: 1 })).toEqual({ ok: false, reason: 'no-grid' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('refuses with a grid but no markers', async () => {
    await seedAnalysedDoc();
    expect(buildAlignPlan({ division: 1, strength: 1 })).toEqual({ ok: false, reason: 'no-anchors' });
  });

  it('refuses a one-beat grid: a single beat defines no interval to snap into', async () => {
    const doc = await seedAnalysedDoc(120, 12);
    setMarkers(doc.id, [SR * 2]);
    // Two beats is the smallest grid that can be subdivided or interpolated;
    // one beat is a position, not a grid.
    jest.spyOn(beatGridModule, 'getBeatGrid').mockReturnValue({
      ...getBeatGrid(doc.id)!,
      beatSamples: Int32Array.from([SR]),
    });
    expect(buildAlignPlan({ division: 1, strength: 1 })).toEqual({ ok: false, reason: 'no-grid' });
    jest.spyOn(beatGridModule, 'getBeatGrid').mockReturnValue({
      ...getBeatGrid(doc.id)!,
      beatSamples: Int32Array.from([SR, 2 * SR]),
    });
    expect(buildAlignPlan({ division: 1, strength: 1 }).ok).toBe(true);
    jest.restoreAllMocks();
  });

  it('refuses when the selection is degenerate', async () => {
    const doc = await seedAnalysedDoc();
    setMarkers(doc.id, [SR * 2]);
    useAppStore.getState().setSelection({ start: 1000, end: 1001 });
    expect(buildAlignPlan({ division: 1, strength: 1 })).toEqual({ ok: false, reason: 'region-too-short' });
  });
});

describe('buildAlignPlan', () => {
  it('targets the whole document with no selection, and the selection when there is one', async () => {
    const doc = await seedAnalysedDoc();
    expect(alignRegion(doc)).toEqual({ start: 0, end: docLength(doc) });
    useAppStore.getState().setSelection({ start: SR, end: 5 * SR });
    expect(alignRegion(doc)).toEqual({ start: SR, end: 5 * SR });
  });

  // ── One resolved region, every consumer (L11) ─────────────────────────────
  // `alignRegion`'s docstring claims it applies "the same fallback
  // `runEffectOnSelection` applies", and `applyTimingAlignment` really does hand
  // the plan's geometry to that runner. L9 made the runner clamp its region into
  // the document; this one still read the selection raw, so the claim was false
  // and the two disagreed on exactly the selections the store lets through —
  // `setSelection` stores whatever it is handed. Same defect family as R7's
  // `plan.regionStart`, L1's `resolveRegion` and L9's runner.

  it('clamps a selection the store accepted into the document, as runEffectOnSelection does (L11)', async () => {
    const doc = await seedAnalysedDoc();
    const length = docLength(doc);
    // A NON-ZERO start with an end past the document.
    useAppStore.getState().setSelection({ start: 2 * SR, end: length + 5 * SR });
    expect(alignRegion(doc)).toEqual({ start: 2 * SR, end: length });
    // …and a start before sample 0 with a non-zero end inside it.
    useAppStore.getState().setSelection({ start: -3 * SR, end: 4 * SR });
    expect(alignRegion(doc)).toEqual({ start: 0, end: 4 * SR });
  });

  it('builds the plan on the CLAMPED region, which is the audio the warp will receive (L11)', async () => {
    const doc = await seedAnalysedDoc(120, 12);
    const beats = Array.from(getBeatGrid(doc.id)!.beatSamples);
    const positions = [beats[3] + 1500, beats[5] - 1200];
    setMarkers(doc.id, positions);
    const length = docLength(doc);
    useAppStore.getState().setSelection({ start: -2 * SR, end: length + 3 * SR });

    const r = buildAlignPlan({ division: 1, strength: 1 });
    if (!r.ok) throw new Error('expected a plan');
    expect(r.plan.regionStart).toBe(0);
    expect(r.plan.regionEnd).toBe(length);
    // `effectAnchors` are region-RELATIVE, and `runEffectOnSelection` clamps its
    // own region into the document before slicing it. An unclamped `regionStart`
    // therefore measured every anchor from a point the audio the worker receives
    // does not begin at — two seconds of offset on a map whose whole purpose is
    // to land syllables on the sample the user saw.
    expect(r.plan.effectAnchors.map((a) => a.source)).toEqual(positions);
    // `remapRegionMarkers` reads the same pair back to move the markers through
    // the map afterwards, so the plan's region is the marker geometry too.
    expect(r.plan.anchors.map((a) => a.sourceSample)).toEqual(positions);
  });

  it('snaps EVERY marker to its own nearest grid point, not just the first', async () => {
    const doc = await seedAnalysedDoc(120, 12);
    const grid = getBeatGrid(doc.id)!;
    const beats = Array.from(grid.beatSamples);
    expect(beats.length).toBeGreaterThan(10);

    // Put a marker a known distance from four DIFFERENT beats, alternating sign.
    const offsets = [1200, -900, 1500, -1100];
    const chosen = [2, 4, 6, 8];
    setMarkers(
      doc.id,
      chosen.map((b, i) => beats[b] + offsets[i])
    );

    const r = buildAlignPlan({ division: 1, strength: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.anchors).toHaveLength(4);
    r.plan.anchors.forEach((a, i) => {
      expect(a.targetSample).toBe(beats[chosen[i]]);
      expect(a.offsetSamples).toBe(-offsets[i]);
    });
  });

  it('reports the median and the largest move over the WHOLE anchor list', async () => {
    const doc = await seedAnalysedDoc(120, 12);
    const beats = Array.from(getBeatGrid(doc.id)!.beatSamples);
    const offsets = [100, 200, 300, 4000, 500];
    setMarkers(doc.id, [2, 3, 4, 5, 6].map((b, i) => beats[b] + offsets[i]));
    const r = buildAlignPlan({ division: 1, strength: 1 });
    if (!r.ok) throw new Error('expected a plan');
    expect(r.plan.maxOffsetSamples).toBe(4000);
    expect(r.plan.medianOffsetSamples).toBe(300);
  });

  it('subdivision changes the targets, and a finer grid moves syllables less', async () => {
    const doc = await seedAnalysedDoc(120, 12);
    const beats = Array.from(getBeatGrid(doc.id)!.beatSamples);
    // Markers sitting near the MIDPOINT of each beat: on the beat grid they are
    // half a beat away; on the half-beat grid they are on it.
    const mids = [2, 4, 6].map((b) => Math.round((beats[b] + beats[b + 1]) / 2));
    setMarkers(doc.id, mids);

    const coarse = buildAlignPlan({ division: 1, strength: 1 });
    const fine = buildAlignPlan({ division: 2, strength: 1 });
    if (!coarse.ok || !fine.ok) throw new Error('expected plans');
    expect(fine.plan.medianOffsetSamples).toBeLessThan(coarse.plan.medianOffsetSamples);
    expect(fine.plan.medianOffsetSamples).toBeLessThan(50);
    expect(coarse.plan.medianOffsetSamples).toBeGreaterThan(SR * 0.2);
    // The finer grid really has more points, and the coarse one is the beats.
    expect(fine.plan.gridSamples.length).toBeGreaterThan(coarse.plan.gridSamples.length);
    expect(Array.from(coarse.plan.gridSamples)).toEqual(beats);
  });

  it('drops markers on a region edge and markers sharing a position, and counts them', async () => {
    const doc = await seedAnalysedDoc(120, 12);
    const beats = Array.from(getBeatGrid(doc.id)!.beatSamples);
    useAppStore.getState().setSelection({ start: beats[2], end: beats[8] });
    setMarkers(doc.id, [
      beats[2], // exactly on the region start -> dropped
      beats[3] + 500,
      beats[3] + 500, // duplicate -> dropped
      beats[5] + 700,
      beats[8], // exactly on the region end -> dropped
    ]);
    const r = buildAlignPlan({ division: 1, strength: 1 });
    if (!r.ok) throw new Error('expected a plan');
    expect(r.plan.anchors).toHaveLength(2);
    expect(r.plan.droppedCount).toBe(3);
  });

  it('expresses anchors REGION-RELATIVE for the effect while reporting absolute positions', async () => {
    const doc = await seedAnalysedDoc(120, 12);
    const beats = Array.from(getBeatGrid(doc.id)!.beatSamples);
    const start = beats[2];
    useAppStore.getState().setSelection({ start, end: beats[9] });
    setMarkers(doc.id, [beats[4] + 400, beats[6] - 600]);
    const r = buildAlignPlan({ division: 1, strength: 1 });
    if (!r.ok) throw new Error('expected a plan');
    expect(r.plan.regionStart).toBe(start);
    r.plan.anchors.forEach((a, i) => {
      expect(r.plan.effectAnchors[i].source).toBe(a.sourceSample - start);
      expect(r.plan.effectAnchors[i].target).toBe(a.targetSample - start);
    });
    // Not accidentally equal: the region really is offset.
    expect(start).toBeGreaterThan(0);
  });

  it('reports which moves the ratio bound will hold back, and strength changes that', async () => {
    const doc = await seedAnalysedDoc(120, 12);
    const beats = Array.from(getBeatGrid(doc.id)!.beatSamples);
    // Two adjacent markers pulled hard in opposite directions across one beat.
    const gap = beats[4] - beats[3];
    setMarkers(doc.id, [beats[3] + Math.round(gap * 0.4), beats[4] - Math.round(gap * 0.4)]);

    const full = buildAlignPlan({ division: 1, strength: 1 });
    const gentle = buildAlignPlan({ division: 1, strength: 0.02 });
    if (!full.ok || !gentle.ok) throw new Error('expected plans');
    expect(full.plan.clampedIndices.length).toBeGreaterThan(0);
    expect(gentle.plan.clampedIndices).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// suggestSyllableMarkers
// ---------------------------------------------------------------------------

describe('suggestSyllableMarkers', () => {
  it('writes proposals in as markers, in one undoable step', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    const before = useAppStore.getState().markers[doc.id] ?? [];
    expect(before).toHaveLength(0);

    const outcome = suggestSyllableMarkers({ sensitivity: 0.5 });
    expect(outcome).not.toBeNull();
    expect(outcome!.added).toBeGreaterThan(4);
    const after = useAppStore.getState().markers[doc.id] ?? [];
    expect(after).toHaveLength(outcome!.added);
    expect(after[0].name).toBe('Syllable 1');

    // ONE history entry, and undoing it removes every marker it added — not
    // just the first.
    const history = getHistory(doc.id).done;
    expect(history[history.length - 1]).toBe('Suggest Syllable Markers');
    undo(doc.id);
    expect(useAppStore.getState().markers[doc.id] ?? []).toHaveLength(0);
  });

  it('ADDS to the markers already there — it never replaces the user\'s own', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    const mine = [SR * 3 + 137, SR * 5 + 911];
    setMarkers(doc.id, mine);

    const outcome = suggestSyllableMarkers({ sensitivity: 0.5 });
    expect(outcome!.added).toBeGreaterThan(4);
    const positions = (useAppStore.getState().markers[doc.id] ?? []).map((m) => m.positionSample);
    // Both of mine survive, at their exact positions, and the total grew by
    // exactly what was added.
    for (const p of mine) expect(positions).toContain(p);
    expect(positions).toHaveLength(mine.length + outcome!.added);
  });

  it('keeps the markers ascending and inside the region', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    useAppStore.getState().setSelection({ start: SR, end: 5 * SR });
    const outcome = suggestSyllableMarkers({ sensitivity: 0.5 });
    expect(outcome!.added).toBeGreaterThan(2);
    const list = useAppStore.getState().markers[doc.id] ?? [];
    for (let i = 0; i < list.length; i++) {
      expect(list[i].positionSample).toBeGreaterThanOrEqual(SR);
      expect(list[i].positionSample).toBeLessThan(5 * SR);
      if (i > 0) expect(list[i].positionSample).toBeGreaterThan(list[i - 1].positionSample);
    }
  });

  it('reports the analysed span, and caps it', async () => {
    const doc = seedDoc([clickTrain(120, 4)]);
    // Under the cap: the whole region is analysed.
    const whole = suggestSyllableMarkers({ sensitivity: 0.5 });
    expect(whole!.analysedSeconds).toBeCloseTo(docLength(doc) / SR, 3);
    undo(doc.id);

    // Over the cap: only the capped prefix is analysed, and no marker lands
    // past it. (Exercised through the injectable cap so the assertion does not
    // need a 3-minute fixture; the shipped default is MAX_SUGGEST_SECONDS.)
    const capped = suggestSyllableMarkers({ sensitivity: 0.5, maxSeconds: 1 });
    expect(capped!.analysedSeconds).toBe(1);
    expect(capped!.added).toBeGreaterThan(0);
    for (const m of useAppStore.getState().markers[doc.id] ?? []) {
      expect(m.positionSample).toBeLessThan(SR);
    }
    expect(MAX_SUGGEST_SECONDS).toBeGreaterThan(1);
  });

  it('caps the marker count and says it truncated', async () => {
    // More detectable attacks than MAX_SYLLABLE_MARKERS, spaced above the
    // detector's own minimum so every one of them is a candidate.
    const spacing = 0.12;
    const count = MAX_SYLLABLE_MARKERS + 40;
    const n = Math.round((count + 2) * spacing * SR);
    const x = new Float32Array(n);
    let state = 7 >>> 0;
    for (let k = 1; k <= count; k++) {
      const at = Math.round(k * spacing * SR);
      for (let i = 0; i < Math.round(0.02 * SR) && at + i < n; i++) {
        state = (state * 1664525 + 1013904223) >>> 0;
        x[at + i] = Math.exp(-i / (0.004 * SR)) * (state / 2147483648 - 1);
      }
    }
    const doc = seedDoc([x]);
    const outcome = suggestSyllableMarkers({ sensitivity: 0.5, maxSeconds: 600 });
    expect(outcome!.truncated).toBe(true);
    expect(outcome!.added).toBe(MAX_SYLLABLE_MARKERS);
    expect(useAppStore.getState().markers[doc.id] ?? []).toHaveLength(MAX_SYLLABLE_MARKERS);
  });

  it('adds nothing, and pushes no history entry, when it finds nothing', async () => {
    const doc = seedDoc([new Float32Array(SR * 4)]);
    const historyBefore = getHistory(doc.id).done.length;
    const outcome = suggestSyllableMarkers();
    expect(outcome).toEqual({ added: 0, truncated: false, analysedSeconds: 4 });
    expect(useAppStore.getState().markers[doc.id] ?? []).toHaveLength(0);
    expect(getHistory(doc.id).done).toHaveLength(historyBefore);
  });

  it('analyses and places against the CLAMPED region when the selection begins before sample 0 (L11)', async () => {
    const doc = seedDoc([clickTrain(120, 8)]);
    // The region the audio actually has — `cloneRegion` clamps to this pair
    // whichever way the selection is spelled, so this run is the control.
    useAppStore.getState().setSelection({ start: 0, end: 5 * SR });
    const control = suggestSyllableMarkers({ sensitivity: 0.5 });
    expect(control!.added).toBeGreaterThan(2);
    const controlPositions = (useAppStore.getState().markers[doc.id] ?? []).map((m) => m.positionSample);
    undo(doc.id);
    expect(useAppStore.getState().markers[doc.id] ?? []).toHaveLength(0);

    // The SAME region, spelled with a start the document does not have.
    useAppStore.getState().setSelection({ start: -SR, end: 5 * SR });
    const outcome = suggestSyllableMarkers({ sensitivity: 0.5 });

    // The span reported is the span analysed: the raw start claimed a second of
    // audio nothing looked at (6 s over a 5 s region).
    expect(outcome!.analysedSeconds).toBe(5);
    expect(outcome!.added).toBe(control!.added);
    // Every proposal is written at `start + offset`, and the offsets came out of
    // a region `cloneRegion` had already clamped to [0, 5 * SR) — so the raw
    // start slid all of them a whole second early, the first ones to NEGATIVE
    // samples, positions no waveform has.
    const positions = (useAppStore.getState().markers[doc.id] ?? []).map((m) => m.positionSample);
    expect(positions[0]).toBeGreaterThanOrEqual(0);
    expect(positions).toEqual(controlPositions);
  });

  it('returns null with no document', () => {
    expect(suggestSyllableMarkers()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyTimingAlignment
// ---------------------------------------------------------------------------

describe('applyTimingAlignment', () => {
  it('edits the audio, keeps its length, and lands one undo entry', async () => {
    const doc = await seedAnalysedDoc(120, 12);
    const beats = Array.from(getBeatGrid(doc.id)!.beatSamples);
    setMarkers(doc.id, [beats[3] + 1500, beats[5] - 1200, beats[7] + 900]);
    const r = buildAlignPlan({ division: 1, strength: 1 });
    if (!r.ok) throw new Error('expected a plan');

    const lenBefore = docLength(doc);
    const historyBefore = getHistory(doc.id).done.length;
    const progress: number[] = [];
    const outcome = await applyTimingAlignment({ plan: r.plan, strength: 1 }, (f) => progress.push(f));

    expect(outcome.ok).toBe(true);
    const post = useAppStore.getState().documents.find((d) => d.id === doc.id)!;
    expect(docLength(post)).toBe(lenBefore);
    expect(post.channels[0]).not.toBe(doc.channels[0]);
    const done = getHistory(doc.id).done;
    expect(done[historyBefore]).toBe('Align Vocal Timing');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(1);
  });

  it('undo restores the original samples exactly', async () => {
    const doc = await seedAnalysedDoc(120, 12);
    const beats = Array.from(getBeatGrid(doc.id)!.beatSamples);
    setMarkers(doc.id, [beats[4] + 1500]);
    const r = buildAlignPlan({ division: 1, strength: 1 });
    if (!r.ok) throw new Error('expected a plan');
    const original = Array.from(doc.channels[0]);

    await applyTimingAlignment({ plan: r.plan, strength: 1 });
    // Two entries: the marker move, then the audio edit under it.
    undo(doc.id);
    undo(doc.id);
    const post = useAppStore.getState().documents.find((d) => d.id === doc.id)!;
    expect(Array.from(post.channels[0])).toEqual(original);
    expect((useAppStore.getState().markers[doc.id] ?? []).map((m) => m.positionSample)).toEqual([
      beats[4] + 1500,
    ]);
  });

  it('moves the markers through the SAME warp the samples went through', async () => {
    const doc = await seedAnalysedDoc(120, 12);
    const beats = Array.from(getBeatGrid(doc.id)!.beatSamples);
    // Three anchors plus one PLAIN marker between them that is not an anchor —
    // it has to ride the warp too, and its correct destination is the thing
    // that separates a real remap from the proportional rule.
    // A DUPLICATE marker position is dropped as an anchor (`buildWarpMap`
    // needs strictly increasing sources) but is still a marker, so it proves the
    // remap walks the marker list rather than the anchor list.
    const anchorPositions = [beats[3] + 1500, beats[5] - 1200, beats[7] + 900];
    setMarkers(doc.id, [...anchorPositions, beats[5] - 1200].sort((a, b) => a - b));

    const r = buildAlignPlan({ division: 1, strength: 1 });
    if (!r.ok) throw new Error('expected a plan');
    expect(r.plan.anchors).toHaveLength(3);
    expect(r.plan.droppedCount).toBe(1);
    const before = (useAppStore.getState().markers[doc.id] ?? []).map((m) => m.positionSample);
    expect(before).toHaveLength(4);

    const outcome = await applyTimingAlignment({ plan: r.plan, strength: 1 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.markersMoved).toBe(4); // the dropped duplicate rides too

    // Expected positions computed from the map itself — the same map the
    // samples went through.
    const map = buildWarpMap(r.plan.effectAnchors, r.plan.regionEnd - r.plan.regionStart, {
      strength: 1,
    });
    const after = (useAppStore.getState().markers[doc.id] ?? []).map((m) => m.positionSample);
    expect(after).toHaveLength(before.length);
    before.forEach((pos, i) => {
      const want = r.plan.regionStart + Math.round(synthesisPosAt(map, pos - r.plan.regionStart));
      expect(after[i]).toBe(want);
    });

    // Each anchor now sits on its grid point — the whole reason the remap has
    // to exist, since a second pass reads these positions as the new anchors.
    expect(r.plan.clampedIndices).toEqual([]);
    r.plan.anchors.forEach((a) => {
      const moved = after[before.indexOf(a.sourceSample)];
      expect(Math.abs(moved - a.targetSample)).toBeLessThanOrEqual(1);
    });

    // And this is NOT what the proportional rule would have produced. The warp
    // preserves the region length, so `effectRunner`'s 'stretch' remap is the
    // IDENTITY here: without a real remap every one of these markers would sit
    // exactly where it started. That is the discriminator — a test asserting
    // only "still inside the region" could not tell the two apart.
    before.forEach((pos, i) => {
      expect(after[i]).not.toBe(pos);
      expect(Math.abs(after[i] - pos)).toBeGreaterThan(800);
    });
  });

  it('remaps only markers inside the region, and lands as its own undo step', async () => {
    const doc = await seedAnalysedDoc(120, 12);
    const beats = Array.from(getBeatGrid(doc.id)!.beatSamples);
    useAppStore.getState().setSelection({ start: beats[4], end: beats[10] });
    const outside = [beats[1], beats[14]];
    setMarkers(doc.id, [outside[0], beats[6] + 1500, beats[8] - 1200, outside[1]]);

    const r = buildAlignPlan({ division: 1, strength: 1 });
    if (!r.ok) throw new Error('expected a plan');
    const before = (useAppStore.getState().markers[doc.id] ?? []).map((m) => m.positionSample);
    const historyBefore = getHistory(doc.id).done.length;

    const outcome = await applyTimingAlignment({ plan: r.plan, strength: 1 });
    expect(outcome.ok).toBe(true);

    const after = (useAppStore.getState().markers[doc.id] ?? []).map((m) => m.positionSample);
    expect(after[0]).toBe(outside[0]);
    expect(after[3]).toBe(outside[1]);
    expect(after[1]).not.toBe(beats[6] + 1500);

    // The region does NOT start at sample 0 here, so the region offset is
    // load-bearing: a remap that fed absolute positions into the map, or
    // dropped the `regionStart +`, would land these somewhere else entirely.
    expect(r.plan.regionStart).toBeGreaterThan(0);
    const map = buildWarpMap(r.plan.effectAnchors, r.plan.regionEnd - r.plan.regionStart, {
      strength: 1,
    });
    [1, 2].forEach((i) => {
      const want =
        r.plan.regionStart + Math.round(synthesisPosAt(map, before[i] - r.plan.regionStart));
      expect(after[i]).toBe(want);
      expect(want).toBeGreaterThan(r.plan.regionStart);
    });

    // Two entries: the audio edit, then the marker move — the same shape
    // `Add Beat Markers` has, and for the same reason.
    const done = getHistory(doc.id).done;
    expect(done).toHaveLength(historyBefore + 2);
    expect(done[done.length - 2]).toBe('Align Vocal Timing');
    expect(done[done.length - 1]).toBe('Align Markers');

    undo(doc.id);
    const restored = (useAppStore.getState().markers[doc.id] ?? []).map((m) => m.positionSample);
    expect(restored[1]).toBe(beats[6] + 1500);
  });

  it('writes no marker step when the warp moves no marker', async () => {
    const doc = await seedAnalysedDoc(120, 12);
    const beats = Array.from(getBeatGrid(doc.id)!.beatSamples);
    // Anchors near the very start; a marker far past the last knot is inside
    // the final segment, whose ratio the pinned end forces back toward 1.
    setMarkers(doc.id, [beats[2] + 20]);
    const r = buildAlignPlan({ division: 1, strength: 0.001 });
    if (!r.ok) throw new Error('expected a plan');
    const historyBefore = getHistory(doc.id).done.length;
    const outcome = await applyTimingAlignment({ plan: r.plan, strength: 0.001 });
    if (!outcome.ok) throw new Error('expected the warp to apply');
    // The move rounds to nothing, so no marker entry is pushed — only the audio one.
    expect(outcome.markersMoved).toBe(0);
    expect(getHistory(doc.id).done).toHaveLength(historyBefore + 1);
  });

  it('refuses at strength 0 rather than pushing an undo entry that changes nothing', async () => {
    const doc = await seedAnalysedDoc(120, 12);
    const beats = Array.from(getBeatGrid(doc.id)!.beatSamples);
    setMarkers(doc.id, [beats[4] + 1500]);
    const r = buildAlignPlan({ division: 1, strength: 1 });
    if (!r.ok) throw new Error('expected a plan');
    const historyBefore = getHistory(doc.id).done.length;

    expect(await applyTimingAlignment({ plan: r.plan, strength: 0 })).toEqual({
      ok: false,
      reason: 'no-change',
    });
    expect(getHistory(doc.id).done).toHaveLength(historyBefore);
  });

  it('only edits the selected region — the audio outside it is byte-identical', async () => {
    const doc = await seedAnalysedDoc(120, 12);
    const beats = Array.from(getBeatGrid(doc.id)!.beatSamples);
    const start = beats[4];
    const end = beats[10];
    useAppStore.getState().setSelection({ start, end });
    setMarkers(doc.id, [beats[6] + 1500, beats[8] - 1200]);
    const r = buildAlignPlan({ division: 1, strength: 1 });
    if (!r.ok) throw new Error('expected a plan');
    const original = Array.from(doc.channels[0]);

    expect((await applyTimingAlignment({ plan: r.plan, strength: 1 })).ok).toBe(true);
    const post = useAppStore.getState().documents.find((d) => d.id === doc.id)!;
    expect(post.channels[0]).toHaveLength(original.length);
    for (let i = 0; i < start; i++) expect(post.channels[0][i]).toBe(original[i]);
    for (let i = end; i < original.length; i++) expect(post.channels[0][i]).toBe(original[i]);
    // Non-vacuous: something INSIDE the region did change.
    let changed = 0;
    for (let i = start; i < end; i++) if (post.channels[0][i] !== original[i]) changed++;
    expect(changed).toBeGreaterThan(0);
  });

  it('hands the effect the strength as a PERCENTAGE, and the anchors on the side channel', async () => {
    const doc = await seedAnalysedDoc(120, 12);
    const beats = Array.from(getBeatGrid(doc.id)!.beatSamples);
    setMarkers(doc.id, [beats[3] + 1500, beats[5] - 1200]);
    const r = buildAlignPlan({ division: 1, strength: 1 });
    if (!r.ok) throw new Error('expected a plan');

    const spy = jest.spyOn(effectRunnerModule, 'runEffectOnSelection');
    await applyTimingAlignment({ plan: r.plan, strength: 0.6 });
    expect(spy).toHaveBeenCalledTimes(1);
    const [effectId, params, opts] = spy.mock.calls[0];
    expect(effectId).toBe(ALIGN_TIMING_EFFECT_ID);
    // 60, not 0.6: the effect's param is a percentage and divides by 100. A
    // fraction here would silently apply 0.6 % of every move.
    expect(params.strengthPercent).toBe(60);
    expect((opts?.extra as AlignTimingExtra).anchors).toEqual(r.plan.effectAnchors);
    spy.mockRestore();
  });

  it('reports failure — not success — when the effect run cannot start', async () => {
    const doc = await seedAnalysedDoc(120, 12);
    const beats = Array.from(getBeatGrid(doc.id)!.beatSamples);
    setMarkers(doc.id, [beats[4] + 1500]);
    const r = buildAlignPlan({ division: 1, strength: 1 });
    if (!r.ok) throw new Error('expected a plan');
    const original = Array.from(doc.channels[0]);
    const historyBefore = getHistory(doc.id).done.length;

    _setDspWorkerLoadFailure('worker unavailable');
    const outcome = await applyTimingAlignment({ plan: r.plan, strength: 1 });
    _setDspWorkerLoadFailure(null);

    expect(outcome).toEqual({ ok: false, reason: 'no-change' });
    const post = useAppStore.getState().documents.find((d) => d.id === doc.id)!;
    expect(Array.from(post.channels[0])).toEqual(original);
    expect(getHistory(doc.id).done).toHaveLength(historyBefore);
  });

  it('refuses with no document', async () => {
    const doc = await seedAnalysedDoc(120, 12);
    const beats = Array.from(getBeatGrid(doc.id)!.beatSamples);
    setMarkers(doc.id, [beats[4] + 1500]);
    const r = buildAlignPlan({ division: 1, strength: 1 });
    if (!r.ok) throw new Error('expected a plan');
    useAppStore.setState(makeInitialState());
    expect(await applyTimingAlignment({ plan: r.plan, strength: 1 })).toEqual({
      ok: false,
      reason: 'no-document',
    });
  });

  /**
   * T6-3 — a cancelled pass through the REAL runner and the REAL effect, which
   * is the only way to prove "commits nothing": this pass commits in two places
   * (the audio through `applyEdit`, the markers through `remapRegionMarkers`)
   * and the second is not visible from the first.
   */
  describe('cancellation', () => {
    it('leaves the audio, the markers and the history exactly as they were, and says cancelled', async () => {
      const doc = await seedAnalysedDoc(120, 12);
      const beats = Array.from(getBeatGrid(doc.id)!.beatSamples);
      const positions = [beats[3] + 1500, beats[5] - 1200, beats[7] + 900];
      setMarkers(doc.id, positions);
      const r = buildAlignPlan({ division: 1, strength: 1 });
      if (!r.ok) throw new Error('expected a plan');
      const historyBefore = getHistory(doc.id).done.length;

      const outcome = await applyTimingAlignment({
        plan: r.plan,
        strength: 1,
        shouldCancel: () => true,
      });

      expect(outcome).toEqual({ ok: false, reason: 'cancelled' });
      const post = useAppStore.getState().documents.find((d) => d.id === doc.id)!;
      // Identity: `replaceRegion` allocates fresh arrays on a real commit, so a
      // value comparison would pass on a commit that had happened and been
      // numerically identical.
      expect(post.channels[0]).toBe(doc.channels[0]);
      expect((useAppStore.getState().markers[doc.id] ?? []).map((m) => m.positionSample)).toEqual(
        positions
      );
      expect(getHistory(doc.id).done.length).toBe(historyBefore);
    });

    it('reports cancelled rather than no-change, which is what it used to look like', async () => {
      const doc = await seedAnalysedDoc(120, 12);
      const beats = Array.from(getBeatGrid(doc.id)!.beatSamples);
      setMarkers(doc.id, [beats[4] + 1500]);
      const r = buildAlignPlan({ division: 1, strength: 1 });
      if (!r.ok) throw new Error('expected a plan');

      const cancelled = await applyTimingAlignment({
        plan: r.plan,
        strength: 1,
        shouldCancel: () => true,
      });

      // Both leave the document untouched, so the channels-identity gate reads
      // them the same way. Only one of them is something the user chose, and
      // telling them "nothing to move at this strength" for their own walk-away
      // is the app misreading the room.
      expect(cancelled).not.toEqual({ ok: false, reason: 'no-change' });
      expect(cancelled).toEqual({ ok: false, reason: 'cancelled' });
    });

    it('commits normally when the cancel says no', async () => {
      const doc = await seedAnalysedDoc(120, 12);
      const beats = Array.from(getBeatGrid(doc.id)!.beatSamples);
      setMarkers(doc.id, [beats[4] + 1500]);
      const r = buildAlignPlan({ division: 1, strength: 1 });
      if (!r.ok) throw new Error('expected a plan');

      const outcome = await applyTimingAlignment({
        plan: r.plan,
        strength: 1,
        shouldCancel: () => false,
      });

      expect(outcome.ok).toBe(true);
      const post = useAppStore.getState().documents.find((d) => d.id === doc.id)!;
      expect(post.channels[0]).not.toBe(doc.channels[0]);
    });
  });
});
