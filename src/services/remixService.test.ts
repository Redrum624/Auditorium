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
  invalidateRemix,
  clearAllRemix,
  getRemixVersion,
  useRemixVersion,
  MAX_LOCKED_JOINS,
} from './remixService';
import {
  clearAllTempo,
  clearAllRemix as clearAllRemixAnalysis,
} from './tempoAnalysis';
import { createDocument, docLength, replaceRegion, type AudioDocument } from '../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { applyEdit } from './editOps';
import { getHistory, undo, clearHistory } from './undoHistory';
import {
  _setTempoWorkerError,
  _setTempoWorkerLoadFailure,
  _getTempoWorkerTerminateCount,
  _resetTempoWorkerTestState,
} from '../__mocks__/createTempoWorkerMock';

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

function findDoc(docId: string): AudioDocument | undefined {
  return useAppStore.getState().documents.find((d) => d.id === docId);
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

/** Every created document id, so each test can drop its undo histories —
 * `clearHistory` is keyed by docId and ids are globally unique (the counters
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
  _resetTempoWorkerTestState();
  installShowMessageBox();
});

afterEach(() => {
  delete (window as { electronAPI?: unknown }).electronAPI;
});

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
    expect(remix.sampleRate).toBe(source.sampleRate);
    expect(remix.channels.length).toBe(2);
    expect(docLength(remix)).toBe(result.plan.outputSample);

    // The new document is active and the view switched (mixdownToNewFile's
    // own post-conditions, followed verbatim).
    expect(useAppStore.getState().activeDocumentId).toBe(result.remixDocId);
    expect(useAppStore.getState().view).toBe('waveform');

    // One 'Edit k' marker per join, every one inside the document.
    const markers = markersOf(result.remixDocId);
    expect(result.plan.joins.length).toBeGreaterThan(0);
    expect(markers.length).toBe(result.plan.joins.length);
    for (const m of markers) {
      expect(m.positionSample).toBeGreaterThanOrEqual(0);
      expect(m.positionSample).toBeLessThanOrEqual(docLength(remix));
    }

    // The SOURCE is untouched — reference identity on each channel.
    const liveSource = liveDoc(source.id);
    expect(liveSource.channels[0]).toBe(srcCh0);
    expect(liveSource.channels[1]).toBe(srcCh1);
    expect(liveSource.dirty).toBe(false);
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
    expect(reRollRemix(result.remixDocId)).toBeNull();
    // No re-roll happened, so no undo entry was pushed either.
    expect(getHistory(result.remixDocId).done).toEqual([]);
  }, 15000);
});

// ---------------------------------------------------------------------------
// 3-6. Adjustments
// ---------------------------------------------------------------------------

describe('adjustments (acceptance 3, 4, 5, 6)', () => {
  async function seedSession(targetSample = TARGET_1_JOIN) {
    const source = seedSource(1);
    const result = await createRemixDocument({ sourceDocId: source.id, targetSample });
    if (!result.ok) throw new Error(`seedSession: plan failed (${result.status}: ${result.message})`);
    return { source, remixDocId: result.remixDocId, plan: result.plan };
  }

  it('(3) rejectJoin never lets the rejected (from,to) come back, rewrites the document, and pushes exactly TWO entries: "Remix" then "Remix Markers"', async () => {
    const { remixDocId, plan } = await seedSession();
    const rejected = plan.joins[0];
    const key = `${rejected.fromBar}>${rejected.toBar}`;
    const channelsBefore = liveDoc(remixDocId).channels;

    const next = rejectJoin(remixDocId, key);

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
    const third = rejectJoin(remixDocId, key2);
    expect(third).not.toBeNull();
    expect(third!.ok).toBe(true);
    if (!third!.ok) return;
    const keys = third!.joins.map((j) => `${j.fromBar}>${j.toBar}`);
    expect(keys).not.toContain(key);
    expect(keys).not.toContain(key2);
  }, 15000);

  it('(4) undo() TWICE restores the previous arrangement AND its markers; undo() ONCE restores only the markers (the two-press behaviour, documented not hidden)', async () => {
    const { remixDocId, plan } = await seedSession();
    const channelsBefore = liveDoc(remixDocId).channels;
    const lengthBefore = docLength(liveDoc(remixDocId));
    const markersBefore = markersOf(remixDocId);
    expect(markersBefore.length).toBe(plan.joins.length);

    rejectJoin(remixDocId, `${plan.joins[0].fromBar}>${plan.joins[0].toBar}`);
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

    const next = nudgeJoin(remixDocId, key, +1);

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
    const back = nudgeJoin(remixDocId, `${next!.joins[0].fromBar}>${next!.joins[0].toBar}`, -1);
    expect(back).not.toBeNull();
    expect(back!.ok).toBe(true);
    if (!back!.ok) return;
    expect(back!.joins[0].fromBar).toBe(join.fromBar);
    expect(back!.joins[0].toBar).toBe(join.toBar);
    expect(back!.outputSample).toBe(plan.outputSample);
  }, 15000);

  it('(5, bound) a nudge past +/-floor(phraseBars/2) bars is refused (null) and leaves the document untouched', async () => {
    const { remixDocId, plan } = await seedSession();
    let key = `${plan.joins[0].fromBar}>${plan.joins[0].toBar}`;
    // phraseBars defaults to 8, so 4 nudges are legal and the 5th is not.
    for (let i = 0; i < 4; i++) {
      const step = nudgeJoin(remixDocId, key, +1);
      expect(step).not.toBeNull();
      const s = getRemixSession(remixDocId)!;
      key = `${s.plan.joins[0].fromBar}>${s.plan.joins[0].toBar}`;
    }
    const channelsBefore = liveDoc(remixDocId).channels;
    const historyBefore = getHistory(remixDocId).done.length;

    expect(nudgeJoin(remixDocId, key, +1)).toBeNull();

    expect(liveDoc(remixDocId).channels).toBe(channelsBefore);
    expect(getHistory(remixDocId).done.length).toBe(historyBefore);
  }, 15000);

  it('(6) reRollRemix produces a DIFFERENT joins array whose length stays inside the planner\'s own tolerance window, and is deterministic across two identically-seeded sessions', async () => {
    const a = await seedSession();
    const rolledA = reRollRemix(a.remixDocId);

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
    const rolledB = reRollRemix(b.remixDocId);
    expect(rolledB).not.toBeNull();
    expect(rolledB!.ok).toBe(true);
    if (!rolledB!.ok) return;
    expect(rolledB!.joins).toEqual(rolledA!.joins);
    expect(rolledB!.outputSample).toBe(rolledA!.outputSample);
    expect(rolledB!.segments).toEqual(rolledA!.segments);
  }, 15000);

  it('(reset) resetRemix drops rejections, locks and rolls and returns the original automatic plan', async () => {
    const { remixDocId, plan } = await seedSession();
    const key = `${plan.joins[0].fromBar}>${plan.joins[0].toBar}`;
    rejectJoin(remixDocId, key);
    reRollRemix(remixDocId);

    const reset = resetRemix(remixDocId);

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

  it('(lock) toggleLockJoin records and clears a lock, caps at MAX_LOCKED_JOINS, and never rewrites the audio on its own', async () => {
    const { remixDocId, plan } = await seedSession(TARGET_2_JOINS);
    const key = `${plan.joins[0].fromBar}>${plan.joins[0].toBar}`;
    const channelsBefore = liveDoc(remixDocId).channels;

    expect(toggleLockJoin(remixDocId, key)).toBe(true);
    expect(getRemixSession(remixDocId)!.lockedJoins).toEqual([key]);
    // A lock changes nothing about the CURRENT arrangement, so it must not
    // push an undo entry or re-render (see the task report: the plan lists
    // 'lock' among the re-render triggers, which is wrong).
    expect(liveDoc(remixDocId).channels).toBe(channelsBefore);
    expect(getHistory(remixDocId).done).toEqual([]);

    expect(toggleLockJoin(remixDocId, key)).toBe(false);
    expect(getRemixSession(remixDocId)!.lockedJoins).toEqual([]);

    // Unknown join -> refused.
    expect(toggleLockJoin(remixDocId, '999>998')).toBeNull();

    // The cap is enforced by the SERVICE, not only by the panel.
    const session = getRemixSession(remixDocId)!;
    for (let i = 0; i < MAX_LOCKED_JOINS; i++) session.lockedJoins.push(`${100 + i}>${200 + i}`);
    expect(toggleLockJoin(remixDocId, key)).toBeNull();
  }, 15000);

  it('(update) updateRemixSession re-plans on a target change and only re-renders on a crossfade change', async () => {
    const { remixDocId, plan } = await seedSession();

    const longer = updateRemixSession(remixDocId, { targetSample: TARGET_2_JOINS });
    expect(longer).not.toBeNull();
    expect(longer!.ok).toBe(true);
    if (!longer!.ok) return;
    expect(longer!.outputSample).not.toBe(plan.outputSample);
    expect(docLength(liveDoc(remixDocId))).toBe(longer!.outputSample);

    const joinsBefore = getRemixSession(remixDocId)!.plan.joins;
    const faded = updateRemixSession(remixDocId, { crossfadeMs: 60 });
    expect(faded).not.toBeNull();
    expect(faded!.ok).toBe(true);
    if (!faded!.ok) return;
    // Same arrangement, re-rendered — a crossfade is length-neutral (T12).
    expect(faded!.joins).toEqual(joinsBefore);
    expect(faded!.outputSample).toBe(longer!.outputSample);
    expect(getRemixSession(remixDocId)!.options.crossfadeMs).toBe(60);
  }, 15000);

  it('(update, atomicity) an unreachable target is refused with the reachable bounds and leaves BOTH the options and the document untouched', async () => {
    const { remixDocId, plan } = await seedSession();
    const channelsBefore = liveDoc(remixDocId).channels;
    const historyBefore = getHistory(remixDocId).done.length;

    const refused = updateRemixSession(remixDocId, { targetSample: Math.round(600 * SR) });

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
    expect(rejectJoin(remixDocId, key)).toBeNull();
    expect(nudgeJoin(remixDocId, key, +1)).toBeNull();
    expect(reRollRemix(remixDocId)).toBeNull();
    expect(resetRemix(remixDocId)).toBeNull();
    expect(toggleLockJoin(remixDocId, key)).toBeNull();
    expect(updateRemixSession(remixDocId, { crossfadeMs: 60 })).toBeNull();

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
    expect(reRollRemix(result.remixDocId)).toBeNull();
  }, 15000);
});

// ---------------------------------------------------------------------------
// 8-10. Failure paths
// ---------------------------------------------------------------------------

describe('failure paths (acceptance 8, 9, 10)', () => {
  it('(8) an in-band worker error resolves {ok:false}, surfaces ONE dialog, terminates the worker and creates NO document', async () => {
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

  it('(9) a worker LOAD failure (the onerror path) does the same', async () => {
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
// Session lifecycle + reactivity
// ---------------------------------------------------------------------------

describe('session lifecycle and reactivity', () => {
  it('invalidateRemix clears the session for the REMIX doc id AND for the SOURCE doc id', async () => {
    const s1 = seedSource(1);
    const r1 = await createRemixDocument({ sourceDocId: s1.id, targetSample: TARGET_1_JOIN });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    invalidateRemix(r1.remixDocId);
    expect(getRemixSession(r1.remixDocId)).toBeNull();

    const r2 = await createRemixDocument({ sourceDocId: s1.id, targetSample: TARGET_1_JOIN });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(getRemixSession(r2.remixDocId)).not.toBeNull();

    invalidateRemix(s1.id); // the SOURCE closing must clear it too
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
    expect(session.analysis.numBars).toBe(MEASURED_NUM_BARS);
    expect(session.joinSamples.length).toBe(session.plan.joins.length);
    for (const pos of session.joinSamples) {
      expect(pos).toBeGreaterThanOrEqual(0);
      expect(pos).toBeLessThanOrEqual(docLength(liveDoc(result.remixDocId)));
    }
    expect(getRemixSession('doc-not-a-remix')).toBeNull();
    expect(rejectJoin('doc-not-a-remix', '1>2')).toBeNull();
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
