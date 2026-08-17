import { renderHook, act } from '@testing-library/react';
import {
  createRemixDocument,
  getRemixSession,
  updateRemixSession,
  rejectJoin,
  toggleLockJoin,
  nudgeJoin,
  reRollRemix,
  resetRemix,
  invalidateRemixSession,
  clearAllRemix,
  getRemixVersion,
  useRemixVersion,
  MAX_LOCKED_JOINS,
  _setPlanWorkerThresholdForTest,
} from './remixService';
import { clearAllTempo, clearAllRemix as clearAllRemixAnalysis } from './tempoAnalysis';
import { getBeatGrid, clearBeatGridLinks, _getBeatGridLinkForTest } from './beatGrid';
import { createDocument, docLength, replaceRegion, type AudioDocument } from '../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { applyEdit } from './editOps';
import { getHistory, undo, clearHistory } from './undoHistory';
import { planRemix, MAX_REQUIRED_JOINS } from '../dsp/remixPlan';
import { buildCandidateLists } from '../dsp/remixCost';
import * as remixRenderModule from '../dsp/remixRender';
import {
  _setTempoWorkerError,
  _setTempoWorkerLoadFailure,
  _getTempoWorkerTerminateCount,
  _resetTempoWorkerTestState,
} from '../__mocks__/createTempoWorkerMock';
import {
  _setRemixPlanWorkerError,
  _setRemixPlanWorkerLoadFailure,
  _getLastRemixPlanMessage,
  _getRemixPlanWorkerCreateCount,
  _getRemixPlanWorkerTerminateCount,
  _getRemixPlanRequestCount,
  _resetRemixPlanWorkerTestState,
} from '../__mocks__/createRemixPlanWorkerMock';

// ---------------------------------------------------------------------------
// THE abab FIXTURE — copied verbatim (recipe, constants and all) from
// `remixFeatures.test.ts` / `remixCost.test.ts`, which is this repo's
// convention: local generators are re-declared per test file rather than
// shared (`tempoCore.test.ts`, `fft.test.ts`, `resample.test.ts`). Memoised at
// module scope because EVERY test seeds it and generating it is ~100 ms —
// memoising the SIGNAL is safe (it is never mutated: `analyzeRemix` and
// `renderRemix` are both documented pure over their input, and acceptance 1
// asserts exactly that with `toBe` on the live document's channel arrays).
// ---------------------------------------------------------------------------

const SR = 44100;
const BPM = 120;
const BEAT = Math.round((60 / BPM) * SR); // 22050
const BAR = BEAT * 4; // 88200
const BARS_PER_SECTION = 8;
const SECTION_LEN = BAR * BARS_PER_SECTION;
const PRE_ROLL_BARS = 1;

function makeLcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
}

function buildAbab(): Float32Array {
  const structure: ('A' | 'B')[] = ['A', 'B', 'A', 'B'];
  const preRollLen = PRE_ROLL_BARS * BAR;
  const totalLen = preRollLen + structure.length * SECTION_LEN;
  const out = new Float32Array(totalLen);
  const freqA = [220, 330];
  const freqB = [440, 554.365];
  const toneAmp = 0.25;
  const clickAmp = 1.0;

  for (let i = 0; i < preRollLen; i++) {
    const t = i / SR;
    let v = 0;
    for (const f of freqA) v += Math.sin(2 * Math.PI * f * t);
    out[i] += toneAmp * v;
  }
  structure.forEach((label, si) => {
    const start = preRollLen + si * SECTION_LEN;
    const freqs = label === 'A' ? freqA : freqB;
    for (let i = 0; i < SECTION_LEN; i++) {
      const t = i / SR;
      let v = 0;
      for (const f of freqs) v += Math.sin(2 * Math.PI * f * t);
      out[start + i] += toneAmp * v;
    }
  });

  const rand = makeLcg(12345);
  const clickLen = Math.round(0.005 * SR);
  const clickWin = new Float32Array(clickLen);
  for (let i = 0; i < clickLen; i++) {
    clickWin[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, clickLen - 1)));
  }
  let beatIdx = -PRE_ROLL_BARS * 4;
  for (let s = 0; s < totalLen; s += BEAT, beatIdx++) {
    const phase = ((beatIdx % 4) + 4) % 4;
    const gain = (phase === 0 ? 2 : 1) * clickAmp;
    for (let i = 0; i < clickLen && s + i < totalLen; i++) {
      out[s + i] += gain * clickWin[i] * rand();
    }
  }
  return out;
}

let ababCache: Float32Array | null = null;
function abab(): Float32Array {
  if (!ababCache) ababCache = buildAbab();
  return ababCache;
}

/** MEASURED on this fixture (probe run, T13): `numBars === 32`,
 * `bpm === 119.998`, `confidence === 0.982`, bar lengths 87864-88304 samples
 * (21 distinct values — the grid is drift-following, NOT isochronous), head
 * 88128, tail 419. Reachable arrangements: 34.00 s (minimum) .. 194.00 s. */
const MEASURED_MAX_BAR_LEN = 88304;
const MEASURED_MIN_BAR_LEN = 87864;
const MEASURED_NUM_BARS = 32;
/** `tolBars = ceil(phraseBars/2)` in strict mode (`remixPlan.ts`). */
const TOL_BARS = 4;

/** 1 join on this fixture (measured: `6 -> 22`, output 34.00 s). */
const TARGET_1_JOIN = Math.round(32 * SR);
/** 2 joins on this fixture (measured: `24 -> 16`, `31 -> 15`, output 114.00 s). */
const TARGET_2_JOINS = Math.round(120 * SR);
/** 0 joins — the straight-through play (measured: output 66.00 s). */
const TARGET_0_JOINS = Math.round(66 * SR);

function seedSource(channelCount: 1 | 2 = 2): AudioDocument {
  const sig = abab();
  const channels: Float32Array[] = [sig];
  if (channelCount === 2) channels.push(sig.slice());
  const doc = createDocument({ name: 'Song.wav', sampleRate: SR, channels });
  useAppStore.getState().addDocument(doc);
  return doc;
}

function liveDoc(docId: string): AudioDocument {
  const doc = useAppStore.getState().documents.find((d) => d.id === docId);
  if (!doc) throw new Error(`liveDoc: not found: ${docId}`);
  return doc;
}

function markersOf(docId: string) {
  return useAppStore.getState().markers[docId] ?? [];
}

function installShowMessageBox(): jest.Mock {
  const showMessageBox = jest.fn(async () => 0);
  (window as unknown as { electronAPI: { showMessageBox: typeof showMessageBox } }).electronAPI = {
    showMessageBox,
  };
  return showMessageBox;
}

/** `clearHistory` is keyed by docId and ids are globally unique (the counters
 * never reset), so this is belt-and-braces isolation, not a correctness
 * requirement. */
function clearAllHistories(): void {
  for (const doc of useAppStore.getState().documents) clearHistory(doc.id);
}

beforeEach(() => {
  clearAllHistories();
  useAppStore.setState(makeInitialState());
  clearAllTempo();
  clearAllRemixAnalysis();
  clearAllRemix();
  clearBeatGridLinks();
  _resetTempoWorkerTestState();
  _resetRemixPlanWorkerTestState();
  _setPlanWorkerThresholdForTest(null);
  installShowMessageBox();
});

afterEach(() => {
  _setPlanWorkerThresholdForTest(null);
  delete (window as { electronAPI?: unknown }).electronAPI;
});

async function seedSession(targetSample = TARGET_1_JOIN, channelCount: 1 | 2 = 1) {
  const source = seedSource(channelCount);
  const result = await createRemixDocument({ sourceDocId: source.id, targetSample });
  if (!result.ok) throw new Error(`seedSession: plan failed (${result.status}: ${result.message})`);
  return { source, remixDocId: result.remixDocId, plan: result.plan };
}

// ---------------------------------------------------------------------------
// 1-2. Creation
// ---------------------------------------------------------------------------

describe('createRemixDocument — document creation (acceptance 1, 2)', () => {
  // FIRST test in the file on purpose: `nextId('remix')` counts from 1 for the
  // whole module registry and is never reset (AudioDocument.ts), so 'Remix 1'
  // is only assertable for the first remix this file creates.
  it('(1) creates exactly ONE new document named "Remix 1" whose length is EXACTLY plan.outputSample, seeds one marker per join, and never touches the source channels', async () => {
    const source = seedSource(2);
    const srcCh0 = source.channels[0];
    const srcCh1 = source.channels[1];
    const before = useAppStore.getState().documents.length;

    const result = await createRemixDocument({ sourceDocId: source.id, targetSample: TARGET_2_JOINS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(useAppStore.getState().documents.length).toBe(before + 1);

    const remix = liveDoc(result.remixDocId);
    expect(remix.name).toBe('Remix 1');
    // Task S4: the rendered arrangement has never been on disk, so it carries
    // the neverSaved provenance flag and prompts on close even though it is
    // clean (no undo entry was pushed for its creation).
    expect(remix.neverSaved).toBe(true);
    expect(remix.dirty).toBe(false);
    expect(remix.sampleRate).toBe(source.sampleRate);
    expect(remix.channels.length).toBe(2);
    expect(docLength(remix)).toBe(result.plan.outputSample);

    // The new document is active and the view switched (mixdownToNewFile's
    // own post-conditions, followed verbatim).
    expect(useAppStore.getState().activeDocumentId).toBe(result.remixDocId);
    expect(useAppStore.getState().view).toBe('waveform');

    // One 'Edit k' marker per join, each AT the splice it names. `0 <= pos <=
    // docLength` — the assertion this replaces — only restated
    // `makeJoinMarkers`' own clamp (`remixService.ts:566`), so seeding the
    // markers from `render.nudgeSamples` (the +/-441-sample micro-alignment
    // lags) instead of `render.joinSamples` passed it, with every marker piled
    // up near sample 0 (L3-1).
    //
    // The invariant that actually locates them: `renderRemix` writes the head,
    // then each segment in turn, so join k's crossfade centre lands at
    // `headLen + sum(spans[0..k])` — exactly, for the centred and butt-splice
    // shapes (the fade straddles the bar line, or there is no fade), and up to
    // `ceil(X/2)` EARLIER for the pre-roll shape, which puts the whole fade
    // before it. Never later, under any shape.
    const markers = markersOf(result.remixDocId);
    const segments = result.plan.segments;
    expect(result.plan.joins.length).toBeGreaterThan(0);
    expect(segments.length).toBe(result.plan.joins.length + 1);
    expect(markers.length).toBe(result.plan.joins.length);

    const headLen = getRemixSession(result.remixDocId)!.analysis.barBoundary[0];
    // `crossfadeMs` defaults to 25 ms and `renderRemix` only ever clamps X
    // DOWN from there (`crossfadeBaseSample`), so this is a true upper bound.
    const maxHalfFade = Math.ceil(Math.round((25 / 1000) * SR) / 2);
    let cumulative = headLen;
    let previous = -1;
    for (let k = 0; k < markers.length; k++) {
      cumulative += segments[k].end - segments[k].start;
      // BY NAME, not by index: the store sorts markers by position, so index
      // order would silently stop being join order the moment positions did.
      const marker = markers.find((m) => m.name === `Edit ${k + 1}`);
      expect(marker).toBeDefined();
      const pos = marker!.positionSample;
      expect(cumulative - pos).toBeGreaterThanOrEqual(0);
      expect(cumulative - pos).toBeLessThanOrEqual(maxHalfFade);
      // Still inside the document, and strictly ordered.
      expect(pos).toBeGreaterThan(previous);
      expect(pos).toBeLessThanOrEqual(docLength(remix));
      previous = pos;
    }

    // The SOURCE is untouched — reference identity on each channel.
    const liveSource = liveDoc(source.id);
    expect(liveSource.channels[0]).toBe(srcCh0);
    expect(liveSource.channels[1]).toBe(srcCh1);
    expect(liveSource.dirty).toBe(false);

    // 32 bars is far below MAX_DP_CELLS, so this session plans on the main
    // thread and no worker was ever created.
    expect(getRemixSession(result.remixDocId)!.plansInWorker).toBe(false);
    expect(_getRemixPlanWorkerCreateCount()).toBe(0);
  }, 15000);

  it('(2) pushes NO undo entry for the creation — the remix doc has an empty history and the source history is unchanged', async () => {
    const source = seedSource(2);
    const sourceBefore = getHistory(source.id).done.length;

    const result = await createRemixDocument({ sourceDocId: source.id, targetSample: TARGET_1_JOIN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(getHistory(result.remixDocId).done).toEqual([]);
    expect(getHistory(result.remixDocId).undone).toEqual([]);
    expect(getHistory(source.id).done.length).toBe(sourceBefore);
    // Matches Mix Down: a brand-new document has no history and is not dirty.
    expect(liveDoc(result.remixDocId).dirty).toBe(false);
  }, 15000);

  it('(B1) the remix document does NOT inherit the source\'s beat grid — its samples are a REARRANGEMENT, not a partition', async () => {
    const source = seedSource(2);

    const result = await createRemixDocument({ sourceDocId: source.id, targetSample: TARGET_1_JOIN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The source necessarily has a remix-level analysis by now, so it HAS a
    // grid — the remix document still gets none, because the parent's beat
    // positions do not describe the rearranged timeline. Inheriting them would
    // draw tics where the remix has no measured beat.
    expect(getBeatGrid(source.id)).not.toBeNull();
    expect(_getBeatGridLinkForTest(result.remixDocId)).toBeUndefined();
    expect(getBeatGrid(result.remixDocId)).toBeNull();
  }, 15000);

  it('(12) a MONO source produces a MONO remix document', async () => {
    const source = seedSource(1);

    const result = await createRemixDocument({ sourceDocId: source.id, targetSample: TARGET_1_JOIN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const remix = liveDoc(result.remixDocId);
    expect(remix.channels.length).toBe(1);
    expect(docLength(remix)).toBe(result.plan.outputSample);
  }, 15000);

  it('(corner) a target that is exactly the whole track plans ZERO joins: no markers, canReroll false, and re-roll is a no-op', async () => {
    const source = seedSource(1);

    const result = await createRemixDocument({ sourceDocId: source.id, targetSample: TARGET_0_JOINS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.joins).toEqual([]);
    expect(result.plan.canReroll).toBe(false);
    expect(markersOf(result.remixDocId)).toEqual([]);
    expect(await reRollRemix(result.remixDocId)).toBeNull();
    // No re-roll happened, so no undo entry was pushed either.
    expect(getHistory(result.remixDocId).done).toEqual([]);
  }, 15000);
});

// ---------------------------------------------------------------------------
// 3-6. Adjustments
// ---------------------------------------------------------------------------

describe('adjustments (acceptance 3, 4, 5, 6)', () => {
  it('(3) rejectJoin never lets the rejected (from,to) come back, rewrites the document, and pushes exactly TWO entries: "Remix" then "Remix Markers"', async () => {
    const { remixDocId, plan } = await seedSession();
    const rejected = plan.joins[0];
    const key = `${rejected.fromBar}>${rejected.toBar}`;
    const channelsBefore = liveDoc(remixDocId).channels;

    const next = await rejectJoin(remixDocId, key);

    expect(next).not.toBeNull();
    expect(next!.ok).toBe(true);
    if (!next!.ok) return;
    expect(next!.joins.map((j) => `${j.fromBar}>${j.toBar}`)).not.toContain(key);
    expect(getRemixSession(remixDocId)!.rejectedJoins).toContain(key);

    // The document really was rewritten (a genuine edit always allocates
    // fresh channel arrays — AudioDocument.replaceRegion).
    expect(liveDoc(remixDocId).channels).not.toBe(channelsBefore);
    expect(docLength(liveDoc(remixDocId))).toBe(next!.outputSample);

    expect(getHistory(remixDocId).done).toEqual(['Remix', 'Remix Markers']);

    // A second rejection also holds — BOTH keys stay gone.
    const second = next!.joins[0];
    const key2 = `${second.fromBar}>${second.toBar}`;
    const third = await rejectJoin(remixDocId, key2);
    expect(third).not.toBeNull();
    expect(third!.ok).toBe(true);
    if (!third!.ok) return;
    const keys = third!.joins.map((j) => `${j.fromBar}>${j.toBar}`);
    expect(keys).not.toContain(key);
    expect(keys).not.toContain(key2);
  }, 15000);

  it('(3, corner) the two-entry count is CONDITIONAL: with markEditPoints:false an adjustment pushes exactly ONE entry', async () => {
    const source = seedSource(1);
    const result = await createRemixDocument({
      sourceDocId: source.id,
      targetSample: TARGET_1_JOIN,
      markEditPoints: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(markersOf(result.remixDocId)).toEqual([]);

    const key = `${result.plan.joins[0].fromBar}>${result.plan.joins[0].toBar}`;
    await rejectJoin(result.remixDocId, key);

    expect(getHistory(result.remixDocId).done).toEqual(['Remix']);
  }, 15000);

  it('(4) undo() TWICE restores the previous arrangement AND its markers; undo() ONCE restores only the markers (the two-press behaviour, documented not hidden)', async () => {
    const { remixDocId, plan } = await seedSession();
    const channelsBefore = liveDoc(remixDocId).channels;
    const lengthBefore = docLength(liveDoc(remixDocId));
    const markersBefore = markersOf(remixDocId);
    expect(markersBefore.length).toBe(plan.joins.length);

    await rejectJoin(remixDocId, `${plan.joins[0].fromBar}>${plan.joins[0].toBar}`);
    const markersAfter = markersOf(remixDocId);

    // ONE press: only the 'Remix Markers' entry comes off. The audio is still
    // the NEW arrangement; the markers fall back to the empty list applyEdit's
    // 'replace' remap left behind (every old join marker described a splice
    // that no longer exists).
    undo(remixDocId);
    expect(liveDoc(remixDocId).channels).not.toBe(channelsBefore);
    expect(markersOf(remixDocId)).toEqual([]);
    expect(markersOf(remixDocId)).not.toEqual(markersAfter);

    // TWO presses: the arrangement AND the original markers are both back.
    undo(remixDocId);
    expect(liveDoc(remixDocId).channels).toBe(channelsBefore);
    expect(docLength(liveDoc(remixDocId))).toBe(lengthBefore);
    expect(markersOf(remixDocId)).toEqual(markersBefore);
  }, 15000);

  it('(5) nudgeJoin(+1) shifts fromBar AND toBar together, so the emitted BAR COUNT is exactly unchanged and the duration moves only by the drift between the two bars', async () => {
    const { remixDocId, plan } = await seedSession();
    const join = plan.joins[0];
    const key = `${join.fromBar}>${join.toBar}`;
    const barsBefore = emittedBars(plan.segments, getRemixSession(remixDocId)!.analysis.barBoundary);

    const next = await nudgeJoin(remixDocId, key, +1);

    expect(next).not.toBeNull();
    expect(next!.ok).toBe(true);
    if (!next!.ok) return;
    expect(next!.joins.length).toBe(plan.joins.length);
    expect(next!.joins[0].fromBar).toBe(join.fromBar + 1);
    expect(next!.joins[0].toBar).toBe(join.toBar + 1);

    // THE invariant that genuinely holds: the number of emitted bars is
    // identical, so the arrangement's musical length is unchanged.
    const session = getRemixSession(remixDocId)!;
    expect(emittedBars(next!.segments, session.analysis.barBoundary)).toBe(barsBefore);

    // SPEC PROBLEM, reported not silently weakened (see the task report):
    // the brief's acceptance 5 asks for `outputSample` UNCHANGED with EXACT
    // equality. That is unachievable by construction — `barBoundary` holds
    // REAL tracked, drift-following beat samples (remixPlan.ts's own doc
    // comment: "bar lengths vary by a few ms because the grid is
    // drift-following"), so shifting `fromBar` by +1 adds barLen(fromBar)
    // samples and shifting `toBar` by +1 removes barLen(toBar), and those two
    // bars are different lengths. MEASURED on this fixture: barLen(6) = 88200
    // vs barLen(22) = 88199, i.e. a ONE-sample difference; the fixture's full
    // bar-length spread is 87864-88304 (21 distinct values). So this asserts
    // the EXACT identity that IS true rather than a tolerance: the duration
    // moves by precisely the difference between the two bars that were
    // traded, and by nothing else.
    const bb = session.analysis.barBoundary;
    const gainedBar = bb[join.fromBar + 1] - bb[join.fromBar];
    const lostBar = bb[join.toBar + 1] - bb[join.toBar];
    expect(next!.outputSample - plan.outputSample).toBe(gainedBar - lostBar);
    expect(Math.abs(gainedBar - lostBar)).toBeLessThanOrEqual(MEASURED_MAX_BAR_LEN - MEASURED_MIN_BAR_LEN);
    expect(docLength(liveDoc(remixDocId))).toBe(next!.outputSample);

    // -1 walks it straight back to where it started.
    const back = await nudgeJoin(remixDocId, `${next!.joins[0].fromBar}>${next!.joins[0].toBar}`, -1);
    expect(back).not.toBeNull();
    expect(back!.ok).toBe(true);
    if (!back!.ok) return;
    expect(back!.joins[0].fromBar).toBe(join.fromBar);
    expect(back!.joins[0].toBar).toBe(join.toBar);
    expect(back!.outputSample).toBe(plan.outputSample);
  }, 15000);

  // BOTH directions, in one loop: the bound is `Math.abs(nextTotal) > limit`
  // and a `+1`-only walk cannot tell it apart from `nextTotal > limit`, under
  // which a join could be nudged BACKWARDS without end (L3-5). Two independent
  // sessions rather than one walked back through zero, so each direction gets
  // a clean `nudgeBars` of 0 to start from.
  it.each([[+1], [-1]])(
    '(5, bound) a nudge past +/-floor(phraseBars/2) bars is refused (null) and leaves the document untouched — direction %i',
    async (dir) => {
      const { remixDocId, plan } = await seedSession();
      let key = `${plan.joins[0].fromBar}>${plan.joins[0].toBar}`;
      // phraseBars defaults to 8, so 4 nudges are legal and the 5th is not.
      for (let i = 0; i < 4; i++) {
        const step = await nudgeJoin(remixDocId, key, dir);
        expect(step).not.toBeNull();
        const s = getRemixSession(remixDocId)!;
        key = `${s.plan.joins[0].fromBar}>${s.plan.joins[0].toBar}`;
      }
      const channelsBefore = liveDoc(remixDocId).channels;
      const historyBefore = getHistory(remixDocId).done.length;

      expect(await nudgeJoin(remixDocId, key, dir)).toBeNull();

      expect(liveDoc(remixDocId).channels).toBe(channelsBefore);
      expect(getHistory(remixDocId).done.length).toBe(historyBefore);

      // What was refused is the BOUND, not the join: stepping back the other
      // way from exactly the position the refusal left behind is still
      // accepted. Without this, a `return null` bolted to the front of
      // `nudgeJoin` would satisfy everything above.
      expect(await nudgeJoin(remixDocId, key, -dir)).not.toBeNull();
    },
    20000
  );

  it("(6) reRollRemix produces a DIFFERENT joins array whose length stays inside the planner's own tolerance window, and is deterministic across two identically-seeded sessions", async () => {
    const a = await seedSession();
    const rolledA = await reRollRemix(a.remixDocId);

    expect(rolledA).not.toBeNull();
    expect(rolledA!.ok).toBe(true);
    if (!rolledA!.ok) return;
    const keysBefore = a.plan.joins.map((j) => `${j.fromBar}>${j.toBar}`);
    const keysAfter = rolledA!.joins.map((j) => `${j.fromBar}>${j.toBar}`);
    expect(keysAfter).not.toEqual(keysBefore);

    // "inside the tolerance window" = the planner's OWN window, `tolBars =
    // ceil(phraseBars/2)` bars around the target, expressed in samples via
    // this fixture's measured longest bar. Deliberately NOT tightened.
    expect(Math.abs(rolledA!.outputSample - TARGET_1_JOIN)).toBeLessThanOrEqual(TOL_BARS * MEASURED_MAX_BAR_LEN);
    expect(docLength(liveDoc(a.remixDocId))).toBe(rolledA!.outputSample);

    // DETERMINISM: a second, independently-created session over the same
    // audio and options re-rolls to a byte-identical plan.
    const b = await seedSession();
    const rolledB = await reRollRemix(b.remixDocId);
    expect(rolledB).not.toBeNull();
    expect(rolledB!.ok).toBe(true);
    if (!rolledB!.ok) return;
    expect(rolledB!.joins).toEqual(rolledA!.joins);
    expect(rolledB!.outputSample).toBe(rolledA!.outputSample);
    expect(rolledB!.segments).toEqual(rolledA!.segments);
  }, 15000);

  it('(6, roll index) the session records the roll index the plan came from, and replaying planRemix at that index reproduces it exactly', async () => {
    const { remixDocId, plan } = await seedSession(TARGET_2_JOINS);
    const session = getRemixSession(remixDocId)!;
    expect(plan.joins.length).toBeGreaterThan(1);

    const first = await reRollRemix(remixDocId);
    expect(first).not.toBeNull();
    expect(first!.ok).toBe(true);
    if (!first!.ok) return;
    const usedFirst = session.rollIndex;
    expect(usedFirst).toBe(1);

    const replay = planRemix(session.analysis, {
      targetSample: session.options.targetSample,
      weights: session.options.weights,
      phraseBars: session.options.phraseBars,
      strict: session.options.strict,
      allowRepeats: session.options.allowRepeats,
      maxRepeatFactor: session.options.maxRepeatFactor,
      exactLength: session.options.exactLength,
      forbiddenJoins: session.rejectedJoins,
      lockedJoins: session.lockedJoins,
      rollIndex: usedFirst,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.joins).toEqual(first!.joins);

    const second = await reRollRemix(remixDocId);
    expect(second).not.toBeNull();
    expect(session.rollIndex).toBe(usedFirst + 1);
  }, 15000);

  // FIX ROUND 2 — the headline. Before the planner exempted pinned keys from
  // its own re-roll penalty, this was measured at 0/27 on this very fixture
  // (0/106 across three scales): a join was penalised +2.0 at roll k+1
  // PRECISELY because it was in roll k's plan, so a pin could never survive.
  it('(lock, headline) a PINNED join survives a Re-roll — and the same join is dropped when it is not pinned', async () => {
    const a = await seedSession(TARGET_2_JOINS);
    const pin = `${a.plan.joins[0].fromBar}>${a.plan.joins[0].toBar}`;

    // Control: WITHOUT the pin, this join is gone after one Re-roll.
    const unpinned = await reRollRemix(a.remixDocId);
    expect(unpinned).not.toBeNull();
    expect(unpinned!.ok).toBe(true);
    if (!unpinned!.ok) return;
    expect(unpinned!.joins.map((j) => `${j.fromBar}>${j.toBar}`)).not.toContain(pin);

    // Same fixture, same options, same press — but pinned first.
    const b = await seedSession(TARGET_2_JOINS);
    expect(`${b.plan.joins[0].fromBar}>${b.plan.joins[0].toBar}`).toBe(pin);
    expect(toggleLockJoin(b.remixDocId, pin).ok).toBe(true);

    const pinned = await reRollRemix(b.remixDocId);
    expect(pinned).not.toBeNull();
    expect(pinned!.ok).toBe(true);
    if (!pinned!.ok) return;
    expect(pinned!.joins.map((j) => `${j.fromBar}>${j.toBar}`)).toContain(pin);
    // It is a genuinely DIFFERENT arrangement, not "the re-roll did nothing".
    expect(pinned!.joins).not.toEqual(b.plan.joins);
    expect(getRemixSession(b.remixDocId)!.lockedJoinsDropped).toEqual([]);
  }, 20000);

  it('(lock) a dropped pin is REPORTED rather than silently forgotten — a pin is a preference, not a guarantee', async () => {
    const { remixDocId, plan } = await seedSession(TARGET_2_JOINS);
    const session = getRemixSession(remixDocId)!;
    const pin = `${plan.joins[0].fromBar}>${plan.joins[0].toBar}`;
    toggleLockJoin(remixDocId, pin);
    expect(session.lockedJoinsDropped).toEqual([]);

    // Changing the target re-plans against a different duration, which the
    // pin has no power to override — the session must say so.
    await updateRemixSession(remixDocId, { targetSample: TARGET_1_JOIN });

    const dropped = session.lockedJoinsDropped;
    const present = session.plan.joins.map((j) => `${j.fromBar}>${j.toBar}`);
    // Whichever way it went, the report and the plan agree exactly.
    expect(dropped.includes(pin)).toBe(!present.includes(pin));
  }, 20000);

  it('(lock) re-roll refuses when EVERY join is pinned — the penalty map would be empty, so the plan is provably identical', async () => {
    const { remixDocId, plan } = await seedSession(TARGET_2_JOINS);
    for (const j of plan.joins) toggleLockJoin(remixDocId, `${j.fromBar}>${j.toBar}`);
    const channelsBefore = liveDoc(remixDocId).channels;
    const historyBefore = getHistory(remixDocId).done.length;

    expect(await reRollRemix(remixDocId)).toBeNull();

    expect(liveDoc(remixDocId).channels).toBe(channelsBefore);
    expect(getHistory(remixDocId).done.length).toBe(historyBefore);
  }, 15000);

  it('(reset) resetRemix drops rejections, locks and rolls and returns the original automatic plan', async () => {
    const { remixDocId, plan } = await seedSession();
    const key = `${plan.joins[0].fromBar}>${plan.joins[0].toBar}`;
    await rejectJoin(remixDocId, key);
    await reRollRemix(remixDocId);

    const reset = await resetRemix(remixDocId);

    expect(reset).not.toBeNull();
    expect(reset!.ok).toBe(true);
    if (!reset!.ok) return;
    expect(reset!.joins).toEqual(plan.joins);
    expect(reset!.outputSample).toBe(plan.outputSample);
    const session = getRemixSession(remixDocId)!;
    expect(session.rejectedJoins).toEqual([]);
    expect(session.lockedJoins).toEqual([]);
    expect(session.rollIndex).toBe(0);
  }, 15000);

  it('(lock) toggleLockJoin returns a DISCRIMINATED result, caps at MAX_LOCKED_JOINS, and never rewrites the audio on its own', async () => {
    const { remixDocId, plan } = await seedSession(TARGET_2_JOINS);
    const key = `${plan.joins[0].fromBar}>${plan.joins[0].toBar}`;
    const channelsBefore = liveDoc(remixDocId).channels;

    expect(toggleLockJoin(remixDocId, key)).toEqual({ ok: true, locked: true, lockedJoins: [key] });
    expect(getRemixSession(remixDocId)!.lockedJoins).toEqual([key]);
    // A lock changes nothing about the CURRENT arrangement, so it must not
    // push an undo entry or re-render (see the task report: the plan lists
    // 'lock' among the re-render triggers, which is wrong).
    expect(liveDoc(remixDocId).channels).toBe(channelsBefore);
    expect(getHistory(remixDocId).done).toEqual([]);

    expect(toggleLockJoin(remixDocId, key)).toEqual({ ok: true, locked: false, lockedJoins: [] });
    expect(getRemixSession(remixDocId)!.lockedJoins).toEqual([]);

    // Each refusal is distinguishable — the panel must be able to say "you
    // already have 8 pins" rather than failing silently.
    expect(toggleLockJoin(remixDocId, '999>998')).toEqual({ ok: false, reason: 'unknown-join' });
    expect(toggleLockJoin('doc-not-a-remix', key)).toEqual({ ok: false, reason: 'no-session' });

    const session = getRemixSession(remixDocId)!;
    for (let i = 0; i < MAX_LOCKED_JOINS; i++) session.lockedJoins.push(`${100 + i}>${200 + i}`);
    expect(toggleLockJoin(remixDocId, key)).toEqual({ ok: false, reason: 'limit-reached' });
  }, 15000);

  it('(update) updateRemixSession re-plans on a target change and only re-renders on a crossfade change', async () => {
    const { remixDocId, plan } = await seedSession();

    const longer = await updateRemixSession(remixDocId, { targetSample: TARGET_2_JOINS });
    expect(longer).not.toBeNull();
    expect(longer!.ok).toBe(true);
    if (!longer!.ok) return;
    expect(longer!.outputSample).not.toBe(plan.outputSample);
    expect(docLength(liveDoc(remixDocId))).toBe(longer!.outputSample);

    const joinsBefore = getRemixSession(remixDocId)!.plan.joins;
    // The AUDIO before the crossfade change, and where the first splice sits.
    // Everything below this line exists because `joins`/`outputSample`/
    // `options.crossfadeMs` all still match when the `!needsReplan` arm returns
    // the cached plan without re-rendering — i.e. with the slider permanently
    // inert (L3-2). Only the samples can tell.
    const ch0Before = liveDoc(remixDocId).channels[0];
    const joinSample = getRemixSession(remixDocId)!.joinSamples[0];
    const headBefore = ch0Before.slice(0, 1000);

    const faded = await updateRemixSession(remixDocId, { crossfadeMs: 60 });
    expect(faded).not.toBeNull();
    expect(faded!.ok).toBe(true);
    if (!faded!.ok) return;
    // Same arrangement, re-rendered — a crossfade is length-neutral (T12).
    expect(faded!.joins).toEqual(joinsBefore);
    expect(faded!.outputSample).toBe(longer!.outputSample);
    expect(getRemixSession(remixDocId)!.options.crossfadeMs).toBe(60);

    // RE-RENDERED: `replaceRegion` installs fresh channel arrays, so a render
    // that happened is visible as a reference change...
    const ch0After = liveDoc(remixDocId).channels[0];
    expect(ch0After).not.toBe(ch0Before);
    expect(ch0After.length).toBe(ch0Before.length);

    // ...and the samples around the first splice genuinely moved. 25 ms -> 60 ms
    // widens X from ~1102 to ~2646 samples, so the band between the two
    // half-widths flips from a plain read of the incoming side to a blend.
    // The window is the WIDER fade's full span, because the centred shape's
    // exact centre is `t = 0.5` under BOTH widths and is therefore very nearly
    // unchanged — a single-sample probe at `joinSample` would be the one place
    // this cannot be seen.
    const half = Math.ceil((60 / 1000) * SR);
    const lo = Math.max(0, joinSample - half);
    const hi = Math.min(ch0After.length, joinSample + half);
    let moved = 0;
    for (let i = lo; i < hi; i++) if (Math.abs(ch0After[i] - ch0Before[i]) > 1e-7) moved++;
    expect(moved).toBeGreaterThan(100);

    // ...while the head — which no crossfade touches — is byte-identical, so
    // the assertion above is measuring a WIDER FADE and not merely "the whole
    // buffer was rewritten with something else".
    expect(Array.from(ch0After.slice(0, 1000))).toEqual(Array.from(headBefore));
  }, 20000);

  it("(update, weights identity) a VALUE-IDENTICAL weights object must NOT force a re-plan — it would silently discard the user's nudges", async () => {
    const { remixDocId, plan } = await seedSession();
    const key = `${plan.joins[0].fromBar}>${plan.joins[0].toBar}`;
    const nudged = await nudgeJoin(remixDocId, key, +1);
    expect(nudged).not.toBeNull();
    expect(getRemixSession(remixDocId)!.manual).toBe(true);
    const manualJoins = getRemixSession(remixDocId)!.plan.joins;

    // Exactly what a React render produces: a fresh object carrying the same
    // seven numbers. Reference-comparing it (Object.is) would re-plan.
    const copied = { ...getRemixSession(remixDocId)!.options.weights };
    const after = await updateRemixSession(remixDocId, { crossfadeMs: 40, weights: copied });

    expect(after).not.toBeNull();
    expect(after!.ok).toBe(true);
    if (!after!.ok) return;
    expect(getRemixSession(remixDocId)!.manual).toBe(true);
    expect(after!.joins).toEqual(manualJoins);

    // A genuinely DIFFERENT weights object still re-plans.
    const changed = { ...copied, chroma: copied.chroma + 1 };
    const replanned = await updateRemixSession(remixDocId, { weights: changed });
    expect(replanned).not.toBeNull();
    expect(getRemixSession(remixDocId)!.manual).toBe(false);
  }, 15000);

  it('(update, atomicity) an unreachable target is refused with the reachable bounds and leaves BOTH the options and the document untouched', async () => {
    const { remixDocId, plan } = await seedSession();
    const channelsBefore = liveDoc(remixDocId).channels;
    const historyBefore = getHistory(remixDocId).done.length;

    const refused = await updateRemixSession(remixDocId, { targetSample: Math.round(600 * SR) });

    expect(refused).not.toBeNull();
    expect(refused!.ok).toBe(false);
    if (refused!.ok) return;
    expect(refused!.reason).toBe('too-long');
    // The dialog clamps its slider from these, so they must be populated even
    // on the failure arm.
    expect(refused!.maxOutputSample).toBeGreaterThan(0);
    expect(getRemixSession(remixDocId)!.options.targetSample).toBe(plan.targetSample);
    expect(liveDoc(remixDocId).channels).toBe(channelsBefore);
    expect(getHistory(remixDocId).done.length).toBe(historyBefore);
  }, 15000);
});

// ---------------------------------------------------------------------------
// 7. Staleness
// ---------------------------------------------------------------------------

describe('session staleness (acceptance 7)', () => {
  it('(7) an edit to the SOURCE marks the session stale, disables every adjustment, and leaves the remix audio untouched', async () => {
    const source = seedSource(1);
    const result = await createRemixDocument({ sourceDocId: source.id, targetSample: TARGET_1_JOIN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { remixDocId, plan } = result;
    const key = `${plan.joins[0].fromBar}>${plan.joins[0].toBar}`;

    expect(getRemixSession(remixDocId)!.stale).toBe(false);

    const channelsBefore = liveDoc(remixDocId).channels;
    applyEdit('Silence', source.id, (d) => replaceRegion(d, 100, 200, [new Float32Array(100)]));

    expect(getRemixSession(remixDocId)!.stale).toBe(true);
    expect(await rejectJoin(remixDocId, key)).toBeNull();
    expect(await nudgeJoin(remixDocId, key, +1)).toBeNull();
    expect(await reRollRemix(remixDocId)).toBeNull();
    expect(await resetRemix(remixDocId)).toBeNull();
    expect(toggleLockJoin(remixDocId, key)).toEqual({ ok: false, reason: 'stale' });
    expect(await updateRemixSession(remixDocId, { crossfadeMs: 60 })).toBeNull();

    // The remix audio is unaffected — we never silently re-render from
    // different audio.
    expect(liveDoc(remixDocId).channels).toBe(channelsBefore);
    expect(getHistory(remixDocId).done).toEqual([]);
  }, 15000);

  it('(7, closed source) closing the source document alone also makes the session stale', async () => {
    const source = seedSource(1);
    const result = await createRemixDocument({ sourceDocId: source.id, targetSample: TARGET_1_JOIN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    useAppStore.getState().closeDocument(source.id);

    expect(getRemixSession(result.remixDocId)!.stale).toBe(true);
    expect(await reRollRemix(result.remixDocId)).toBeNull();
  }, 15000);

  it('(7, race) a source edit that lands WHILE a worker plan is in flight is caught at COMMIT time — the remix audio never changes', async () => {
    _setPlanWorkerThresholdForTest(0); // force the worker route
    const { source, remixDocId, plan } = await seedSession();
    expect(plan.joins.length).toBeGreaterThan(0);
    const channelsBefore = liveDoc(remixDocId).channels;
    const historyBefore = getHistory(remixDocId).done.length;

    // Start the re-plan, THEN edit the source before the reply is delivered.
    const pending = reRollRemix(remixDocId);
    applyEdit('Silence', source.id, (d) => replaceRegion(d, 100, 200, [new Float32Array(100)]));
    const result = await pending;

    // The plan itself may well have succeeded — the point is that the audio
    // was never rewritten against a source that no longer matches.
    expect(result === null || result.ok === true).toBe(true);
    expect(liveDoc(remixDocId).channels).toBe(channelsBefore);
    expect(getHistory(remixDocId).done.length).toBe(historyBefore);
    expect(getRemixSession(remixDocId)!.stale).toBe(true);
  }, 15000);

  it('(hardening item 2) going stale TERMINATES the session plan worker instead of leaving it resident forever', async () => {
    _setPlanWorkerThresholdForTest(0); // force the worker route
    const { source, remixDocId } = await seedSession();
    expect(_getRemixPlanWorkerCreateCount()).toBe(1);
    expect(_getRemixPlanWorkerTerminateCount()).toBe(0);

    applyEdit('Silence', source.id, (d) => replaceRegion(d, 100, 200, [new Float32Array(100)]));

    // Reading the session is what OBSERVES the transition — the panel does
    // this on every render.
    expect(getRemixSession(remixDocId)!.stale).toBe(true);
    expect(_getRemixPlanWorkerTerminateCount()).toBe(1);

    // Idempotent: a second observation must not try to kill it again.
    expect(getRemixSession(remixDocId)!.stale).toBe(true);
    expect(_getRemixPlanWorkerTerminateCount()).toBe(1);
    // The session itself survives — it is read-only, not dropped.
    expect(getRemixSession(remixDocId)!.sourceName).toBe('Song.wav');
  }, 15000);

  it('(hardening item 2) undoing the source edit un-stales the session and RESPAWNS the plan worker from the retained analysis', async () => {
    _setPlanWorkerThresholdForTest(0); // force the worker route
    const { source, remixDocId } = await seedSession();

    applyEdit('Silence', source.id, (d) => replaceRegion(d, 100, 200, [new Float32Array(100)]));
    expect(getRemixSession(remixDocId)!.stale).toBe(true);
    expect(_getRemixPlanWorkerTerminateCount()).toBe(1);

    // Undo restores the very same channel arrays, so the identity test passes
    // again and the session is live once more.
    undo(source.id);
    expect(getRemixSession(remixDocId)!.stale).toBe(false);

    const result = await reRollRemix(remixDocId);

    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    expect(_getRemixPlanWorkerCreateCount()).toBe(2); // respawned, not resurrected
    // The respawn re-posts the RETAINED analysis, so the worker is usable.
    expect(_getLastRemixPlanMessage()!.type).toBe('plan');
  }, 20000);
});

// ---------------------------------------------------------------------------
// 8-10. Failure paths
// ---------------------------------------------------------------------------

describe('failure paths (acceptance 8, 9, 10)', () => {
  it('(8) an in-band ANALYSIS worker error resolves {ok:false}, surfaces ONE dialog, terminates the worker and creates NO document', async () => {
    const showMessageBox = installShowMessageBox();
    _setTempoWorkerError('boom');
    const source = seedSource(1);
    const before = useAppStore.getState().documents.length;

    const result = await createRemixDocument({ sourceDocId: source.id, targetSample: TARGET_1_JOIN });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('analysis-failed');
    expect(result.message.length).toBeGreaterThan(0);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Tempo analysis failed', message: 'boom' })
    );
    expect(_getTempoWorkerTerminateCount()).toBe(1);
    expect(useAppStore.getState().documents.length).toBe(before);
  }, 15000);

  it('(9) an ANALYSIS worker LOAD failure (the onerror path) does the same', async () => {
    const showMessageBox = installShowMessageBox();
    _setTempoWorkerLoadFailure('nope');
    const source = seedSource(1);
    const before = useAppStore.getState().documents.length;

    const result = await createRemixDocument({ sourceDocId: source.id, targetSample: TARGET_1_JOIN });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('analysis-failed');
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Tempo analysis failed', message: 'nope' })
    );
    expect(_getTempoWorkerTerminateCount()).toBe(1);
    expect(useAppStore.getState().documents.length).toBe(before);
  }, 15000);

  it('(10) a too-short target returns {ok:false, status:"too-short"} with a message and creates NO document', async () => {
    const source = seedSource(1);
    const before = useAppStore.getState().documents.length;

    const result = await createRemixDocument({ sourceDocId: source.id, targetSample: 1000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('too-short');
    expect(result.message).toContain('shortest reachable');
    expect(useAppStore.getState().documents.length).toBe(before);
    expect(getRemixSession('doc-nonexistent')).toBeNull();
  }, 15000);

  it('(10, corner) a too-LONG target refuses with the reachable maximum, and an unknown source id refuses without running anything', async () => {
    const source = seedSource(1);

    const tooLong = await createRemixDocument({ sourceDocId: source.id, targetSample: Math.round(600 * SR) });
    expect(tooLong.ok).toBe(false);
    if (tooLong.ok) return;
    expect(tooLong.status).toBe('too-long');

    const missing = await createRemixDocument({ sourceDocId: 'doc-does-not-exist', targetSample: TARGET_1_JOIN });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.status).toBe('no-document');
  }, 15000);
});

// ---------------------------------------------------------------------------
// The session-scoped plan worker (fix round 1)
// ---------------------------------------------------------------------------

describe('session-scoped plan worker', () => {
  it('routes planning to ONE worker above the MAX_DP_CELLS threshold, posts the analysis exactly once, and sends only small plan requests afterwards', async () => {
    _setPlanWorkerThresholdForTest(0);
    const { remixDocId, plan } = await seedSession();

    expect(getRemixSession(remixDocId)!.plansInWorker).toBe(true);
    expect(_getRemixPlanWorkerCreateCount()).toBe(1);
    expect(_getRemixPlanRequestCount()).toBe(1);

    await rejectJoin(remixDocId, `${plan.joins[0].fromBar}>${plan.joins[0].toBar}`);
    await reRollRemix(remixDocId);

    // Still ONE worker, and every adjustment was a SMALL message — the
    // ~1.7 MB analysis clone was paid once, at session creation.
    expect(_getRemixPlanWorkerCreateCount()).toBe(1);
    const last = _getLastRemixPlanMessage();
    expect(last).not.toBeNull();
    expect(last!.type).toBe('plan');
    if (last!.type !== 'plan') return;
    expect(Object.keys(last!.options)).not.toContain('analysis');
    expect(_getRemixPlanRequestCount()).toBeGreaterThan(1);
  }, 15000);

  it('stays on the MAIN THREAD below the threshold — no worker is ever created', async () => {
    const { remixDocId, plan } = await seedSession();

    expect(getRemixSession(remixDocId)!.plansInWorker).toBe(false);
    await reRollRemix(remixDocId);
    await rejectJoin(remixDocId, `${plan.joins[0].fromBar}>${plan.joins[0].toBar}`);

    expect(_getRemixPlanWorkerCreateCount()).toBe(0);
    expect(_getRemixPlanRequestCount()).toBe(0);
  }, 15000);

  it('terminates the worker on invalidateRemixSession and on clearAllRemix', async () => {
    _setPlanWorkerThresholdForTest(0);
    const a = await seedSession();
    expect(_getRemixPlanWorkerTerminateCount()).toBe(0);

    invalidateRemixSession(a.remixDocId);
    expect(_getRemixPlanWorkerTerminateCount()).toBe(1);
    expect(getRemixSession(a.remixDocId)).toBeNull();

    const b = await seedSession();
    clearAllRemix();
    expect(_getRemixPlanWorkerTerminateCount()).toBe(2);
    expect(getRemixSession(b.remixDocId)).toBeNull();
  }, 20000);

  it('terminates the worker when the SOURCE document is invalidated, not just the remix document', async () => {
    _setPlanWorkerThresholdForTest(0);
    const { source, remixDocId } = await seedSession();

    invalidateRemixSession(source.id);

    expect(_getRemixPlanWorkerTerminateCount()).toBe(1);
    expect(getRemixSession(remixDocId)).toBeNull();
  }, 15000);

  it('an in-band plan-worker error at CREATION resolves {ok:false, status:"plan-failed"}, shows a dialog, terminates the worker and creates NO document', async () => {
    _setPlanWorkerThresholdForTest(0);
    const showMessageBox = installShowMessageBox();
    _setRemixPlanWorkerError('kaput');
    const source = seedSource(1);
    const before = useAppStore.getState().documents.length;

    const result = await createRemixDocument({ sourceDocId: source.id, targetSample: TARGET_1_JOIN });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('plan-failed');
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Remix planning failed', message: 'kaput' })
    );
    expect(_getRemixPlanWorkerTerminateCount()).toBe(1);
    expect(useAppStore.getState().documents.length).toBe(before);
  }, 15000);

  it('a plan-worker LOAD failure (onerror) resolves too — the promise never hangs', async () => {
    _setPlanWorkerThresholdForTest(0);
    const showMessageBox = installShowMessageBox();
    _setRemixPlanWorkerLoadFailure('chunk missing');
    const source = seedSource(1);
    const before = useAppStore.getState().documents.length;

    const result = await createRemixDocument({ sourceDocId: source.id, targetSample: TARGET_1_JOIN });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('plan-failed');
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Remix planning failed', message: 'chunk missing' })
    );
    expect(_getRemixPlanWorkerTerminateCount()).toBe(1);
    expect(useAppStore.getState().documents.length).toBe(before);
  }, 15000);

  it('a plan-worker failure DURING an adjustment resolves null and leaves the document untouched — no fall-back freeze', async () => {
    _setPlanWorkerThresholdForTest(0);
    const { remixDocId } = await seedSession();
    const channelsBefore = liveDoc(remixDocId).channels;
    const historyBefore = getHistory(remixDocId).done.length;
    const showMessageBox = installShowMessageBox();
    _setRemixPlanWorkerError('later');

    const result = await reRollRemix(remixDocId);

    expect(result).toBeNull();
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Remix planning failed', message: 'later' })
    );
    expect(liveDoc(remixDocId).channels).toBe(channelsBefore);
    expect(getHistory(remixDocId).done.length).toBe(historyBefore);
  }, 15000);

  it("drops the reply to a SUPERSEDED request rather than committing an out-of-date arrangement, and the loser never clobbers the winner's options", async () => {
    _setPlanWorkerThresholdForTest(0);
    const { remixDocId } = await seedSession();

    const first = updateRemixSession(remixDocId, { targetSample: TARGET_2_JOINS });
    const second = updateRemixSession(remixDocId, { targetSample: TARGET_0_JOINS });
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1).toBeNull(); // superseded — never committed
    expect(r2).not.toBeNull();
    expect(r2!.ok).toBe(true);
    if (!r2!.ok) return;
    expect(getRemixSession(remixDocId)!.options.targetSample).toBe(TARGET_0_JOINS);
    expect(docLength(liveDoc(remixDocId))).toBe(r2!.outputSample);
  }, 20000);

  it('memoises rolls within one option/rejection signature, so a repeated plan never reaches the worker again', async () => {
    _setPlanWorkerThresholdForTest(0);
    const { remixDocId } = await seedSession();
    expect(_getRemixPlanRequestCount()).toBe(1); // rollIndex 0, at creation

    // rollIndex 0 again — served entirely from the memo.
    await resetRemix(remixDocId);
    expect(_getRemixPlanRequestCount()).toBe(1);

    await reRollRemix(remixDocId); // rollIndex 1 — a genuine miss
    const afterRoll = _getRemixPlanRequestCount();
    expect(afterRoll).toBeGreaterThan(1);

    await resetRemix(remixDocId); // back to rollIndex 0 — memo hit
    expect(_getRemixPlanRequestCount()).toBe(afterRoll);
    await reRollRemix(remixDocId); // rollIndex 1 again — memo hit
    expect(_getRemixPlanRequestCount()).toBe(afterRoll);

    // A different signature (new target) invalidates the memo, as it must.
    await updateRemixSession(remixDocId, { targetSample: TARGET_2_JOINS });
    expect(_getRemixPlanRequestCount()).toBeGreaterThan(afterRoll);
  }, 20000);

  it('keys the memo on the PINNED set too — pins change the plan, so a no-pin result must never be re-served for a pinned request', async () => {
    _setPlanWorkerThresholdForTest(0);
    const { remixDocId, plan } = await seedSession(TARGET_2_JOINS);
    await reRollRemix(remixDocId); // roll 1, unpinned — now memoised
    const afterUnpinned = _getRemixPlanRequestCount();
    await resetRemix(remixDocId); // back to roll 0

    toggleLockJoin(remixDocId, `${plan.joins[0].fromBar}>${plan.joins[0].toBar}`);
    await reRollRemix(remixDocId); // roll 1 again, but PINNED this time

    // Must have gone to the worker again rather than re-serving the unpinned
    // roll-1 entry (which, by construction, does not honour the pin).
    expect(_getRemixPlanRequestCount()).toBeGreaterThan(afterUnpinned);
  }, 20000);
});

// ---------------------------------------------------------------------------
// Session lifecycle + reactivity
// ---------------------------------------------------------------------------

describe('session lifecycle and reactivity', () => {
  it('invalidateRemixSession clears the session for the REMIX doc id AND for the SOURCE doc id', async () => {
    const s1 = seedSource(1);
    const r1 = await createRemixDocument({ sourceDocId: s1.id, targetSample: TARGET_1_JOIN });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    invalidateRemixSession(r1.remixDocId);
    expect(getRemixSession(r1.remixDocId)).toBeNull();

    const r2 = await createRemixDocument({ sourceDocId: s1.id, targetSample: TARGET_1_JOIN });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(getRemixSession(r2.remixDocId)).not.toBeNull();

    invalidateRemixSession(s1.id); // the SOURCE closing must clear it too
    expect(getRemixSession(r2.remixDocId)).toBeNull();
  }, 15000);

  it('clearAllRemix empties every session and bumps the version', async () => {
    const source = seedSource(1);
    const result = await createRemixDocument({ sourceDocId: source.id, targetSample: TARGET_1_JOIN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const before = getRemixVersion();
    clearAllRemix();

    expect(getRemixSession(result.remixDocId)).toBeNull();
    expect(getRemixVersion()).toBeGreaterThan(before);
  }, 15000);

  it('useRemixVersion re-renders on an adjustment with no zustand change of its own', async () => {
    const source = seedSource(1);
    const result = await createRemixDocument({ sourceDocId: source.id, targetSample: TARGET_1_JOIN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { result: hook } = renderHook(() => useRemixVersion());
    const before = hook.current;

    act(() => {
      toggleLockJoin(result.remixDocId, `${result.plan.joins[0].fromBar}>${result.plan.joins[0].toBar}`);
    });

    expect(hook.current).toBeGreaterThan(before);
  }, 15000);

  it('the session exposes the analysis the panel needs and one join sample per join', async () => {
    const source = seedSource(1);
    const result = await createRemixDocument({ sourceDocId: source.id, targetSample: TARGET_2_JOINS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const session = getRemixSession(result.remixDocId)!;
    expect(session.sourceDocId).toBe(source.id);
    expect(session.remixDocId).toBe(result.remixDocId);
    expect(session.sourceName).toBe('Song.wav');
    expect(session.analysis.numBars).toBe(MEASURED_NUM_BARS);
    // Same positional invariant the marker test pins (L3-1) — asserted here on
    // the SESSION's copy, which is what the panel draws from. `0 <= pos <=
    // docLength` alone was satisfied by `nudgeSamples` (the micro-alignment
    // lags), so a swap of the two fields on the way into the session would
    // have been invisible.
    expect(session.joinSamples.length).toBe(session.plan.joins.length);
    expect(session.plan.segments.length).toBe(session.plan.joins.length + 1);
    const maxHalfFade = Math.ceil(Math.round((25 / 1000) * SR) / 2);
    let cumulative = session.analysis.barBoundary[0];
    let previous = -1;
    for (let k = 0; k < session.joinSamples.length; k++) {
      cumulative += session.plan.segments[k].end - session.plan.segments[k].start;
      const pos = session.joinSamples[k];
      expect(cumulative - pos).toBeGreaterThanOrEqual(0);
      expect(cumulative - pos).toBeLessThanOrEqual(maxHalfFade);
      expect(pos).toBeGreaterThan(previous);
      expect(pos).toBeLessThanOrEqual(docLength(liveDoc(result.remixDocId)));
      previous = pos;
    }
    expect(getRemixSession('doc-not-a-remix')).toBeNull();
    expect(await rejectJoin('doc-not-a-remix', '1>2')).toBeNull();
  }, 15000);
});

// ---------------------------------------------------------------------------
// v1.5.0 hardening — the plan worker must not outlive a post-guard throw
// ---------------------------------------------------------------------------

describe('createRemixDocument — a throw after the last guard (hardening item 4)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('terminates the session plan worker before the throw propagates, so a retry cannot pile up threads', async () => {
    _setPlanWorkerThresholdForTest(0); // force the worker route
    const source = seedSource(1);
    // `renderRemix` genuinely throws on its own entry-side identity check
    // (remixRender.ts:566, :776) — and it runs after the last killPlanWorker
    // guard and before `sessions.set`, so nothing could reach the worker.
    jest.spyOn(remixRenderModule, 'renderRemix').mockImplementation(() => {
      throw new Error('render exploded');
    });

    await expect(
      createRemixDocument({ sourceDocId: source.id, targetSample: TARGET_1_JOIN })
    ).rejects.toThrow('render exploded');

    expect(_getRemixPlanWorkerCreateCount()).toBe(1);
    expect(_getRemixPlanWorkerTerminateCount()).toBe(1);
    // No half-built session was left behind either.
    expect(getRemixSession(`${source.id}`)).toBeNull();
  }, 15000);
});

/** Total bars emitted by `segments`, recovered from the sample positions via
 * `barBoundary` — the plan reports segments in SAMPLES, but the invariant
 * `nudgeJoin` preserves is expressed in BARS. */
function emittedBars(segments: { start: number; end: number }[], barBoundary: Int32Array): number {
  const barOf = (sample: number): number => {
    for (let b = 0; b < barBoundary.length; b++) if (barBoundary[b] === sample) return b;
    throw new Error(`emittedBars: ${sample} is not a bar boundary`);
  };
  let total = 0;
  for (const seg of segments) total += barOf(seg.end) - barOf(seg.start);
  return total;
}

// ---------------------------------------------------------------------------
// R4b — a pin is a hard constraint, and the worker routing must know it
// ---------------------------------------------------------------------------

const keysOf = (joins: readonly { fromBar: number; toBar: number }[]): string[] =>
  joins.map((j) => `${j.fromBar}>${j.toBar}`);

/** `(M+1)*(Nmax+1)` for a live session — the K = 0 table `remixPlan.ts`
 * allocates. Derived from the session rather than hardcoded, so the boundary
 * probes below stay meaningful if the fixture's bar count ever changes. */
function baseCellsOf(remixDocId: string): number {
  const session = getRemixSession(remixDocId)!;
  const M = session.analysis.numBars;
  const Nmax = Math.max(0, Math.round(M * session.options.maxRepeatFactor));
  return (M + 1) * (Nmax + 1);
}

/** Legal `${from}>${to}` keys for this session that the planner would accept
 * as candidates — used to build a pin set larger than `MAX_REQUIRED_JOINS`
 * without needing a fixture whose plan happens to have that many joins. */
function candidateKeysOf(remixDocId: string, count: number): string[] {
  const session = getRemixSession(remixDocId)!;
  const lists = buildCandidateLists(session.analysis, {
    weights: session.options.weights,
    phraseBars: session.options.phraseBars,
    minRunBars: session.options.strict ? session.options.phraseBars : 4,
    strict: session.options.strict,
    allowRepeats: session.options.allowRepeats,
  });
  const keys: string[] = [];
  for (let from = 0; from < lists.length && keys.length < count; from++) {
    const cand = lists[from];
    if (!cand) continue;
    for (let i = 0; i < cand.length && keys.length < count; i++) keys.push(`${from}>${cand[i]}`);
  }
  return keys;
}

describe('R4b — worker routing accounts for the 2^K subset axis', () => {
  it('routes BELOW / ON / ABOVE the threshold as the pin count doubles the table', async () => {
    // Created with the real threshold, so the session starts on the main
    // thread — which is the whole problem: the creation-time decision is a
    // K = 0 decision, and pins arrive afterwards.
    const { remixDocId, plan } = await seedSession(TARGET_2_JOINS);
    expect(getRemixSession(remixDocId)!.plansInWorker).toBe(false);
    expect(_getRemixPlanWorkerCreateCount()).toBe(0);

    const cells = baseCellsOf(remixDocId);
    _setPlanWorkerThresholdForTest(cells * 2);
    // A re-plan trigger that works with EVERY join pinned (`reRollRemix`
    // refuses then, by design) and that does not change the table shape:
    // `targetSample` moves the feasibility window, never `M` or `Nmax`.
    const replan = (seconds: number): Promise<unknown> =>
      updateRemixSession(remixDocId, { targetSample: Math.round(seconds * SR) });

    // BELOW: no pins, one table.
    await replan(118);
    expect(_getRemixPlanWorkerCreateCount()).toBe(0);
    expect(getRemixSession(remixDocId)!.plansInWorker).toBe(false);

    // ON: one pin doubles it to exactly the threshold, and the comparison is
    // strict `>`, so this must still stay on the main thread.
    const first = keysOf(getRemixSession(remixDocId)!.plan.joins)[0];
    expect(toggleLockJoin(remixDocId, first)).toMatchObject({ ok: true, locked: true });
    await replan(119);
    expect(_getRemixPlanWorkerCreateCount()).toBe(0);
    expect(getRemixSession(remixDocId)!.plansInWorker).toBe(false);

    // ABOVE: a second pin is 4x the base table, past the threshold, so the
    // session is promoted to a worker mid-life — which the creation-time
    // decision could never have made, because the session was created with
    // no pins at all.
    getRemixSession(remixDocId)!.lockedJoins.push(candidateKeysOf(remixDocId, 8).find((k) => k !== first)!);
    await replan(120);
    expect(_getRemixPlanWorkerCreateCount()).toBe(1);
    expect(getRemixSession(remixDocId)!.plansInWorker).toBe(true);
  }, 30000);

  it('clamps K at MAX_REQUIRED_JOINS — an over-cap pin set never routes a table that will not be allocated', async () => {
    const { remixDocId } = await seedSession(TARGET_2_JOINS);
    const cells = baseCellsOf(remixDocId);
    // Exactly the K = MAX_REQUIRED_JOINS table. Anything at or below it stays
    // on the main thread; only a LARGER table may promote.
    _setPlanWorkerThresholdForTest(cells * 2 ** MAX_REQUIRED_JOINS);

    const session = getRemixSession(remixDocId)!;
    const keys = candidateKeysOf(remixDocId, MAX_REQUIRED_JOINS + 1);
    expect(keys.length).toBe(MAX_REQUIRED_JOINS + 1);

    // Four pins: 16x the base table, exactly the threshold, main thread.
    session.lockedJoins.splice(0, session.lockedJoins.length, ...keys.slice(0, MAX_REQUIRED_JOINS));
    await reRollRemix(remixDocId);
    expect(_getRemixPlanWorkerCreateCount()).toBe(0);

    // FIVE pins: the planner clamps to 16x too (above the cap it allocates no
    // subset axis at all), so the routing must not see 32x and promote.
    session.lockedJoins.push(keys[MAX_REQUIRED_JOINS]);
    await reRollRemix(remixDocId);
    expect(_getRemixPlanWorkerCreateCount()).toBe(0);
    expect(getRemixSession(remixDocId)!.plansInWorker).toBe(false);
  }, 30000);

  it('promotes at exactly 16x with four pins — the factor is pinned from BELOW as well as above', async () => {
    // The MIRROR of the clamp probe above, and the reason the pair exists.
    // Every other probe in this describe is one-sided: they constrain
    // `f(1) <= 2`, `f(2) > 2` and `f(4) <= 16`, and BOTH `K+1` (5) and `2*K`
    // (8) satisfy all three. A linear factor promotes a 4-pin session only
    // from M ~ 129 bars (~4.3 min at 120 BPM) instead of M ~ 72 (~2.4 min),
    // so every song in that band would run the 13.2x-slower 4-pin DP on the
    // renderer thread with no progress and no cancel — the exact freeze the
    // routing exists to prevent. `f(4) >= 16` is what rules those out, and
    // only this direction can state it.
    const { remixDocId } = await seedSession(TARGET_2_JOINS);
    const cells = baseCellsOf(remixDocId);
    // ONE CELL below the K = MAX_REQUIRED_JOINS table. The K = 0 estimate
    // (`cells`) is still far under it, so nothing is promoted by the seeding
    // itself; only the pins can cross this line.
    _setPlanWorkerThresholdForTest(cells * 2 ** MAX_REQUIRED_JOINS - 1);
    expect(getRemixSession(remixDocId)!.plansInWorker).toBe(false);
    expect(_getRemixPlanWorkerCreateCount()).toBe(0);

    const session = getRemixSession(remixDocId)!;
    const keys = candidateKeysOf(remixDocId, MAX_REQUIRED_JOINS);
    expect(keys.length).toBe(MAX_REQUIRED_JOINS);
    session.lockedJoins.splice(0, session.lockedJoins.length, ...keys);
    await reRollRemix(remixDocId);

    expect(_getRemixPlanWorkerCreateCount()).toBe(1);
    expect(getRemixSession(remixDocId)!.plansInWorker).toBe(true);
  }, 30000);

  it('sends pins to the planner as requiredJoins, never as lockedJoins — the wiring, not just the option', async () => {
    _setPlanWorkerThresholdForTest(0);
    const { remixDocId } = await seedSession(TARGET_2_JOINS);
    const key = keysOf(getRemixSession(remixDocId)!.plan.joins)[0];
    toggleLockJoin(remixDocId, key);
    await reRollRemix(remixDocId);

    const last = _getLastRemixPlanMessage();
    expect(last).not.toBeNull();
    if (last!.type !== 'plan') throw new Error('expected a plan message');
    expect(last!.options.requiredJoins).toEqual([key]);
    // A pin that also arrived as `lockedJoins` would silently re-acquire
    // LOCK_BONUS and turn the guarantee back into a preference-plus-bonus.
    expect(last!.options.lockedJoins).toBeUndefined();
  }, 30000);
});

describe('R4b — the guarantee, end to end through the session', () => {
  it('the panel cap is STRICTLY above the planner cap, so the degradation is reachable at all', () => {
    // The cross-module relationship both constants' doc comments are about,
    // asserted where both are in scope (fix round 3 — nothing asserted it
    // anywhere). Lowering MAX_LOCKED_JOINS to 4 would make the guarantee
    // unconditional and silently delete every test below that exercises the
    // preference mode through the session; raising MAX_REQUIRED_JOINS to 8
    // would allocate a 256x DP table. The gap between them IS the feature.
    expect(MAX_REQUIRED_JOINS).toBeLessThan(MAX_LOCKED_JOINS);
  });

  it('keeps a pinned join across a re-roll and reports it satisfied', async () => {
    const { remixDocId } = await seedSession(TARGET_2_JOINS);
    const key = keysOf(getRemixSession(remixDocId)!.plan.joins)[0];
    expect(toggleLockJoin(remixDocId, key)).toMatchObject({ ok: true, locked: true });

    let presses = 0;
    for (let i = 0; i < 3; i++) {
      const result = await reRollRemix(remixDocId);
      if (!result || !result.ok) break;
      presses++;
      const session = getRemixSession(remixDocId)!;
      expect(keysOf(session.plan.joins)).toContain(key);
      expect(session.lockedJoinsDropped).toEqual([]);
      expect(session.pinReport).toEqual({ mode: 'enforced', satisfied: [key], dropped: [] });
    }
    expect(presses).toBe(3);
  }, 30000);

  it('lockedJoinsDropped and pinReport.dropped always name the SAME keys', async () => {
    const { remixDocId } = await seedSession(TARGET_2_JOINS);
    const session = getRemixSession(remixDocId)!;
    // A key that is legal for the planner but cannot coexist with the plan's
    // own length — pinned directly, the way an over-cap set is built above.
    const keys = candidateKeysOf(remixDocId, 3);
    session.lockedJoins.splice(0, session.lockedJoins.length, ...keys);
    await reRollRemix(remixDocId);

    const after = getRemixSession(remixDocId)!;
    expect(after.pinReport).not.toBeNull();
    const reported = after.pinReport!.dropped.map((d) => d.key).sort();
    // Not vacuous: this pin set really cannot all be honoured, so there IS
    // something for the two to agree about.
    expect(reported.length).toBeGreaterThan(0);
    expect([...after.lockedJoinsDropped].sort()).toEqual(reported);
    // And every drop carries a REASON, not a bare key.
    for (const drop of after.pinReport!.dropped) {
      expect(['forbidden', 'no-candidate', 'incompatible', 'not-enforced']).toContain(drop.reason);
    }
  }, 30000);

  it('above MAX_REQUIRED_JOINS the session says the guarantee is NOT in force', async () => {
    const { remixDocId } = await seedSession(TARGET_2_JOINS);
    const session = getRemixSession(remixDocId)!;
    const keys = candidateKeysOf(remixDocId, MAX_REQUIRED_JOINS + 1);
    session.lockedJoins.splice(0, session.lockedJoins.length, ...keys);
    await reRollRemix(remixDocId);

    expect(getRemixSession(remixDocId)!.pinReport?.mode).toBe('preference');
  }, 30000);

  it('Revert to auto CLEARS a preference-mode report — the panel must not warn about pins on a remix with none', async () => {
    // Fix round 1, C1. `replanAndCommit` assigns `session.lockedJoins` only
    // AFTER `commitPlan` returns, so a `pinReport` guard reading the session
    // instead of the plan's own pin set sees the PRE-reset five pins, keeps
    // the stale `mode: 'preference'` report, and the panel renders "More than
    // 4 pins… unpin down to 4" on an arrangement with zero pins. That is the
    // task's own defect pointing the other way: a loudly downgraded guarantee
    // that is not actually downgraded.
    const { remixDocId } = await seedSession(TARGET_2_JOINS);
    const session = getRemixSession(remixDocId)!;
    session.lockedJoins.splice(
      0,
      session.lockedJoins.length,
      ...candidateKeysOf(remixDocId, MAX_REQUIRED_JOINS + 1)
    );
    await reRollRemix(remixDocId);
    // The precondition really holds: this IS a preference-mode plan.
    expect(getRemixSession(remixDocId)!.pinReport?.mode).toBe('preference');

    await resetRemix(remixDocId);

    const after = getRemixSession(remixDocId)!;
    expect(after.lockedJoins).toEqual([]);
    expect(after.lockedJoinsDropped).toEqual([]);
    expect(after.pinReport).toBeNull();
  }, 30000);

  it('rejecting the last remaining pin clears the report too — the same stale path, reached differently', async () => {
    const { remixDocId } = await seedSession(TARGET_2_JOINS);
    const key = keysOf(getRemixSession(remixDocId)!.plan.joins)[0];
    expect(toggleLockJoin(remixDocId, key)).toMatchObject({ ok: true, locked: true });
    await reRollRemix(remixDocId);
    expect(getRemixSession(remixDocId)!.pinReport).not.toBeNull();

    // `rejectJoin` drops any lock on the same key in the same step, so this
    // re-plans with an EMPTY pin set while the session still holds the old one.
    await rejectJoin(remixDocId, key);

    const after = getRemixSession(remixDocId)!;
    expect(after.lockedJoins).toEqual([]);
    expect(after.pinReport).toBeNull();
  }, 30000);

  it('a fresh session reports no pin state at all — null is not the same as "nothing dropped"', async () => {
    const { remixDocId } = await seedSession(TARGET_2_JOINS);
    expect(getRemixSession(remixDocId)!.pinReport).toBeNull();
    expect(getRemixSession(remixDocId)!.lockedJoinsDropped).toEqual([]);
  }, 30000);
});
