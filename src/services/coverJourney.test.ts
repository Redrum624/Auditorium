/**
 * CP1 — the orchestrator's own tests.
 *
 * Deliberately SPY-LEVEL over the six sub-services. Every one of them
 * (separation, the vocal chain, the cover chain, the alignment DSP) has its own
 * suite proving what it does to audio; what has never been tested is that they
 * are called ONCE EACH, IN ORDER, WITH THE RIGHT INPUTS, that Cancel is honoured
 * between every pair of them, and that the arithmetic between them — the
 * placement offset above all — is right. Re-running their DSP here would be a
 * slower way of testing them again and no way at all of testing this.
 */

import { createDocument, docLength } from '../audio/AudioDocument';
import { makeInitialState, useAppStore } from '../stores/appStore';
import { useSessionStore } from '../multitrack/sessionStore';
import { createClip, createTrack, type Session, type Track } from '../multitrack/session';
import { parseSessionFileBytes, serializeSessionV3 } from '../multitrack/sessionFile';
import { PEAK_BLOCK_SAMPLES, mixdownSession, mixdownSessionPeak } from '../multitrack/mixdown';
import { defaultSessionZoom } from '../multitrack/sessionZoom';
import * as coverAlign from '../dsp/coverAlign';
import * as stemService from './stemService';
import * as vocalChain from './vocalChain';
import * as coverChain from './coverChain';
import * as coverPlacement from './coverPlacement';
import {
  COVER_JOURNEY_STAGES,
  JOURNEY_FADE_MS,
  // V4: the level target the trim aims at, and the label its one session entry
  // carries — both read from the module rather than re-typed here, so a change
  // to either is a change to these tests too.
  JOURNEY_PEAK_TARGET_DB,
  JOURNEY_TRIM_UNDO_LABEL,
  coverSessionName,
  findExistingSeparation,
  journeyStageById,
  priorJourneyPasses,
  runCoverJourney,
  sumInstrumental,
  // T3 (V4 MIN-5): the invariant the trim's shared clamp rests on.
  trimBlockedBy,
  type CoverJourneyStageId,
  type CoverJourneyStageProgress,
  type CoverJourneyStageResult,
} from './coverJourney';
// V4: the session stack the trim lands on — a DIFFERENT stack from the take's
// document history the rest of this suite reads through `getHistory(takeId)`.
import { SESSION_UNDO_KEY, canUndoSession, isSessionDirty, undoSession } from '../multitrack/sessionUndo';
import { MONO_PAN_COMPENSATION_DB, STEM_TRACK_LABELS } from './stemLanding';
import { clearHistory, getHistory, pushUndo, redo, undo } from './undoHistory';
import { applyEdit, pushMarkerUndo } from './editOps';
import { VOCAL_CHAIN_UNDO_LABEL } from './vocalChain';
import { COVER_CHAIN_UNDO_LABEL } from './coverChain';

jest.mock('./stemService', () => ({
  ...jest.requireActual('./stemService'),
  separateStems: jest.fn(),
  cancelStemSeparation: jest.fn(async () => true),
}));
// CC4 (CJ-1): `stemLanding` is NOT mocked. It used to be — `landStems: jest.fn()`
// — and that mock is precisely what hid the defect this suite now pins: the real
// landing installs a session and clears the session history, and the journey's
// fresh arm called it at stage 1 while the header, the cancel copy and the dialog
// all promised no session existed before stage 5. A stub that lands nothing
// cannot disagree with a contract. The real split (`createStemDocuments` /
// `buildStemSession`) runs here, on real (tiny) separation output.
jest.mock('./vocalChain', () => ({
  ...jest.requireActual('./vocalChain'),
  runVocalChain: jest.fn(),
}));
jest.mock('./coverChain', () => ({
  ...jest.requireActual('./coverChain'),
  runCoverChain: jest.fn(),
}));
jest.mock('../dsp/coverAlign', () => ({
  ...jest.requireActual('../dsp/coverAlign'),
  alignTakeToReference: jest.fn(),
}));
// CC3 fix round 1 (I2): the shift arithmetic is SHARED with the apply-the-guess
// arm, not copied into both. Spied (delegating to the real one by default) so a
// test can prove the session is built from what the shared function returned —
// which is what stops a future edit to this stage from forking the rule while
// the offered guess keeps the old one.
jest.mock('./coverPlacement', () => {
  const actual = jest.requireActual('./coverPlacement');
  return { ...actual, placementFor: jest.fn(actual.placementFor) };
});

const separateStems = stemService.separateStems as jest.Mock;
const cancelStemSeparation = stemService.cancelStemSeparation as jest.Mock;
const runVocalChain = vocalChain.runVocalChain as jest.Mock;
const runCoverChain = coverChain.runCoverChain as jest.Mock;
const alignTakeToReference = coverAlign.alignTakeToReference as jest.Mock;
const placementFor = coverPlacement.placementFor as jest.Mock;

const SR = 8000;
const SONG_SAMPLES = SR * 8;
const TAKE_SAMPLES = SR * 6;

function tone(n: number, hz: number, rate: number, amp = 0.4): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

let songId = '';
let takeId = '';

/** The song, the take, and (when `withStems`) the five documents a completed
 * separation of that song leaves behind. */
function seed(withStems: boolean, takeRate = SR, songSamples = SONG_SAMPLES): void {
  useAppStore.setState(makeInitialState());
  const song = createDocument({ name: 'song', sampleRate: SR, channels: [tone(songSamples, 220, SR)] });
  const take = createDocument({
    name: 'take',
    sampleRate: takeRate,
    channels: [tone(Math.round((TAKE_SAMPLES * takeRate) / SR), 330, takeRate)],
  });
  const docs = [song, take];
  if (withStems) {
    for (const label of STEM_TRACK_LABELS) {
      docs.push(
        createDocument({
          name: `song — ${label}`,
          // The reuse path matches stems by the song's rate AND length, so a
          // longer song needs longer stems or it silently takes the fresh-run
          // arm instead.
          sampleRate: SR,
          channels: [tone(songSamples, 440, SR, 0.1)],
        })
      );
    }
  }
  // CP1 fix-round (I5): a NON-NULL selection and the SONG active, so the
  // assertions that the orchestrator sets the active document and clears the
  // selection are testing something. Seeded null, both were vacuous.
  useAppStore.setState({
    documents: docs,
    activeDocumentId: song.id,
    selection: { start: 100, end: 200 },
  });
  songId = song.id;
  takeId = take.id;
}

/**
 * CC4 (CJ-1): a REAL `StemSeparationOutput` for the seeded song, so the real
 * landing runs against it. Five tiny stems at the song's rate and exact length —
 * the shape `findExistingSeparation` re-checks after the landing.
 */
function separationOutput(songSamples = SONG_SAMPLES): stemService.StemSeparationOutput {
  const stemChannels = (): Float32Array[] => [tone(songSamples, 440, SR, 0.1)];
  return {
    sourceDocId: songId,
    sourceName: 'song',
    sampleRate: SR,
    channelCount: 1,
    lengthSamples: songSamples,
    stems: stemService.STEM_LABELS.map((label) => ({ label, channels: stemChannels() })),
    residual: stemChannels(),
    sanitisedEstimateSamples: 0,
  };
}

const okVocalReport = (): vocalChain.VocalChainReport =>
  ({ applied: true, stages: [], elapsedMs: 1 }) as unknown as vocalChain.VocalChainReport;
const okCoverReport = (): coverChain.CoverChainReport =>
  ({
    applied: true,
    stages: [],
    elapsedMs: 1,
    // CC4 (CJ-3): the floor's verdict is part of every real report, so it is
    // part of this one. A stub that omits it would leave the journey reading
    // `undefined` where the contract says `number | null`.
    referenceImplausibleBelowDb: null,
  }) as unknown as coverChain.CoverChainReport;

const confidentAlignment = (offsetSeconds: number): coverAlign.AlignmentMeasurement => ({
  offsetSeconds,
  peakCorrelation: 0.81,
  rivalCorrelation: 0.3,
  prominence: 0.51,
  // CC2: the measurement gained an outcome and the piecewise/search-coverage
  // fields; `confident` is now `outcome === 'confident'` and stays the boolean
  // every consumer here already reads.
  outcome: 'confident',
  confident: true,
  windowsMeasured: 3,
  windowLagSpreadSeconds: 0.005,
  driftSecondsPerMinute: 0.01,
  coarseOffsetSeconds: offsetSeconds,
  lagsEvaluated: 900,
  lagsTotal: 900,
  unevaluatedLagSeconds: 0,
  overlapSeconds: 5,
  refined: true,
});

/**
 * A refusal of the ONE shape the contract emits for `'unrelated'`.
 *
 * Not `confidentAlignment` with the outcome swapped: that fixture's piecewise
 * fields say the windows ran AND agreed (spread 0.005 ≤ the 0.34 limit), and
 * agreement is exactly what excludes 'unrelated' — a peak this low with
 * agreeing windows classifies 'weak'. The drift pair is stricter still: the
 * emitter attaches it only on arms where the windows agreed, so an 'unrelated'
 * measurement carrying a drift figure is a state no run can produce.
 *
 * `rivalCorrelation` is derived rather than inherited for the same reason:
 * prominence IS `peakCorrelation − rivalCorrelation`.
 */
const unrelatedAlignment = (
  offsetSeconds: number,
  peakCorrelation: number,
  prominence: number
): coverAlign.AlignmentMeasurement => {
  const base = confidentAlignment(offsetSeconds);
  delete base.windowLagSpreadSeconds;
  delete base.driftSecondsPerMinute;
  return {
    ...base,
    peakCorrelation,
    rivalCorrelation: peakCorrelation - prominence,
    prominence,
    outcome: 'unrelated',
    confident: false,
    windowsMeasured: 0,
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  runVocalChain.mockResolvedValue(okVocalReport());
  runCoverChain.mockResolvedValue(okCoverReport());
  alignTakeToReference.mockReturnValue(confidentAlignment(0));
  separateStems.mockResolvedValue({ ok: false, status: 'failed', message: 'not stubbed' });
  seed(true);
  // CC4 (CJ-4): undo history is module-global and outlives the store reset, so
  // the take starts each test with the history the user's would have.
  clearHistory(takeId);
});

// ── Sequencing ──────────────────────────────────────────────────────────────

describe('runCoverJourney — sequencing', () => {
  it('calls every sub-service once, in order, with the right inputs', async () => {
    const order: string[] = [];
    runVocalChain.mockImplementation(async () => {
      order.push('vocal');
      return okVocalReport();
    });
    alignTakeToReference.mockImplementation(() => {
      order.push('align');
      return confidentAlignment(0.5);
    });
    runCoverChain.mockImplementation(async () => {
      order.push('cover');
      return okCoverReport();
    });

    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });

    expect(report).not.toBeNull();
    expect(report!.completed).toBe(true);
    // The separation was REUSED, so the model was never asked to run.
    expect(separateStems).not.toHaveBeenCalled();
    expect(order).toEqual(['vocal', 'align', 'cover']);
    expect(runVocalChain).toHaveBeenCalledTimes(1);
    expect(runCoverChain).toHaveBeenCalledTimes(1);
    expect(alignTakeToReference).toHaveBeenCalledTimes(1);

    // The cover chain matches against the SEPARATED VOCAL, never the song.
    const vocalsDoc = useAppStore
      .getState()
      .documents.find((d) => d.name === 'song — Vocals')!;
    expect(runCoverChain.mock.calls[0][0].referenceDocId).toBe(vocalsDoc.id);

    // Both chains run on the TAKE, over the WHOLE take — the orchestrator sets
    // the active document and clears any selection, because both chains read
    // those from the store rather than taking them as arguments.
    expect(useAppStore.getState().activeDocumentId).toBe(takeId);
    expect(useAppStore.getState().selection).toBeNull();

    // Every stage reported exactly once, in registry order.
    expect(report!.stages.map((s) => s.id)).toEqual(COVER_JOURNEY_STAGES.map((s) => s.id));
  });

  /**
   * CC2 (ALIGN-5). This test previously asserted the OPPOSITE — that alignment
   * sees what the Vocal Chain left behind — and that was the defect.
   *
   * The aligner correlates ONSET envelopes, pure spectral flux, so every
   * amplitude discontinuity the chain introduces IS an onset to it and every one
   * it removes is an onset taken away: a gate writes an attack at each open and
   * close, and deletes real breath and consonant onsets. Measuring the take the
   * singer actually recorded is the only version of the measurement that is
   * about the singer. The document is still where the RATE comes from — only the
   * samples come from before the chain.
   */
  it('aligns the PRE-CLEAN take against the separated vocal, not what the chain left', async () => {
    runVocalChain.mockImplementation(async () => {
      const state = useAppStore.getState();
      useAppStore.setState({
        documents: state.documents.map((d) =>
          d.id === takeId ? { ...d, channels: [tone(TAKE_SAMPLES, 111, SR, 0.9)] } : d
        ),
      });
      return okVocalReport();
    });
    await runCoverJourney({ songDocId: songId, takeDocId: takeId });

    const [refChannels, refRate, takeChannels, takeRate] = alignTakeToReference.mock.calls[0];
    expect(refRate).toBe(SR);
    expect(refChannels[0].length).toBe(SONG_SAMPLES);
    expect(takeRate).toBe(SR);
    // 0.4 is the amplitude the take was SEEDED with; 0.9 is what the chain
    // replaced it by. The aligner must be holding the first of those.
    expect(Math.max(...Array.from(takeChannels[0] as Float32Array))).toBeLessThan(0.5);
    expect(takeChannels[0].length).toBe(TAKE_SAMPLES);
  });

  it('runs the separation when no existing one is open, and lands its documents', async () => {
    seed(false);
    separateStems.mockImplementation(async () => ({ ok: true, output: separationOutput() }));

    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });

    expect(separateStems).toHaveBeenCalledTimes(1);
    expect(separateStems.mock.calls[0][0].sourceDocId).toBe(songId);
    expect(report!.separation!.reused).toBe(false);
    expect(report!.stages[0].status).toBe('done');
    // The real landing put five documents on screen, by name.
    const names = useAppStore.getState().documents.map((d) => d.name);
    for (const label of STEM_TRACK_LABELS) expect(names).toContain(`song — ${label}`);
  });

  it('says so when it reuses a separation rather than re-running the model', async () => {
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(report!.separation!.reused).toBe(true);
    expect(report!.stages[0].status).toBe('reused');
    expect(report!.stages[0].derived[0].value).toMatch(/already open/);
  });

  it('refuses to start without both documents, or with one document twice', async () => {
    expect(await runCoverJourney({ songDocId: 'nope', takeDocId: takeId })).toBeNull();
    expect(await runCoverJourney({ songDocId: songId, takeDocId: 'nope' })).toBeNull();
    expect(await runCoverJourney({ songDocId: songId, takeDocId: songId })).toBeNull();
  });
});

// ── Running it twice ────────────────────────────────────────────────────────

/**
 * CC4 (CJ-4). The reuse arm exists so a second pass is seconds rather than
 * minutes, and the product's own smoke exercises it — so a second pass is a
 * SUPPORTED flow, not an edge case. It left a second full-length
 * `<song> — Instrumental` open beside the first on every run (~85 MB apiece for
 * a four-minute stereo song), with an identical name, and re-ran both chains
 * over the already-processed take with nothing said about either.
 */
describe('runCoverJourney — a second pass on the same song', () => {
  it('reuses the instrumental it made last time instead of stacking another', async () => {
    const first = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    const afterFirst = useAppStore.getState().documents.length;

    const second = await runCoverJourney({ songDocId: songId, takeDocId: takeId });

    expect(useAppStore.getState().documents.length).toBe(afterFirst);
    expect(
      useAppStore.getState().documents.filter((d) => d.name === 'song — Instrumental')
    ).toHaveLength(1);
    expect(second!.separation!.instrumentalDocId).toBe(first!.separation!.instrumentalDocId);
    expect(second!.stages[0].derived[1].from).toMatch(/already holds/i);
  });

  /**
   * H1 (CC4 fix-round-2 re-review, Nit 1) — "adoption writes nothing" made
   * falsifiable.
   *
   * Every other assertion about the adopt arm passes just as happily under an
   * implementation that WRITES the identical channels back: `holdsExactly` has
   * already proved the content equal, so an `updateDocument({ ...previous,
   * channels: instrumentalChannels })` changes no sample anyone can read, and
   * even the redo case survives it (`redo` replays a closure-captured snapshot
   * rather than whatever the store now holds). The claim the code and the
   * report both make in bold — that the adopt arm performs no store write at
   * all — was therefore pinned by nothing.
   *
   * The assertion is on OBJECT IDENTITY, which is the strongest form available
   * here and needs no spy: the store replaces documents by id with a new
   * object, so the very same object surviving the pass is proof that no write
   * of any content happened — a rewrite with identical channels still mints a
   * new one. `dirty` is the second half, because the flag is the one
   * user-visible difference between "already holds this" and "rewritten with
   * the same bytes": it is what puts a ` *` in the Files panel and what makes
   * closing the document ask about unsaved work.
   */
  it('writes nothing at all to the document it adopts', async () => {
    const first = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    const theirs = first!.separation!.instrumentalDocId;
    const before = useAppStore.getState().documents.find((d) => d.id === theirs)!;

    const second = await runCoverJourney({ songDocId: songId, takeDocId: takeId });

    expect(second!.separation!.instrumentalDocId).toBe(theirs);
    const after = useAppStore.getState().documents.find((d) => d.id === theirs)!;
    expect(after).toBe(before);
    expect(after.dirty).toBe(false);
  });

  it('never adopts a copy whose samples are not this pass\'s own sum', async () => {
    const first = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    // A stem changes between the passes — same name, same rate, same length, so
    // the separation is still reused and the old instrumental still passes the
    // name/rate/length precondition. Its SAMPLES are now stale, though, so it is
    // not this pass's instrumental and is not written over either.
    useAppStore.setState({
      documents: useAppStore.getState().documents.map((d) =>
        d.name === 'song — Drums' ? { ...d, channels: [tone(SONG_SAMPLES, 440, SR, 0.9)] } : d
      ),
    });
    const second = await runCoverJourney({ songDocId: songId, takeDocId: takeId });

    expect(second!.separation!.instrumentalDocId).not.toBe(first!.separation!.instrumentalDocId);
    const instrumental = useAppStore
      .getState()
      .documents.find((d) => d.id === second!.separation!.instrumentalDocId)!;
    let peak = 0;
    for (let i = 0; i < instrumental.channels[0].length; i++) {
      peak = Math.max(peak, Math.abs(instrumental.channels[0][i]));
    }
    expect(peak).toBeGreaterThan(0.8);
  });

  /**
   * CC4 fix-round 2 (N3). Markers do not change samples, and adoption does not
   * touch markers, so nothing of the user's is at risk — the content test says
   * so without having to be told.
   */
  it('adopts one the user has only marked up — markers are not samples', async () => {
    const first = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    const id = first!.separation!.instrumentalDocId;
    pushMarkerUndo('Add Marker', id, [], [{ id: 'm1', name: 'verse', positionSample: 100 }]);

    const second = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(second!.separation!.instrumentalDocId).toBe(id);
    expect(
      useAppStore.getState().documents.filter((d) => d.name === 'song — Instrumental')
    ).toHaveLength(1);
  });

  /**
   * CC4 fix-round 1 (I1), re-pinned in round 2 against the content test.
   *
   * Adoption used to rewrite a document's channels in place, and a
   * length-preserving edit — EQ, amplify, noise reduction, a same-length paste —
   * leaves the name/rate/length precondition true. So the pass could silently
   * destroy work the user had done on the instrumental between two runs, with no
   * undo path back to it.
   *
   * The rule now: a document is adopted only when it ALREADY holds exactly the
   * sum this pass computed, which makes adoption a provable no-op. Anything else
   * — theirs, stale, or another song's — is left alone and this pass creates its
   * own beside it.
   */
  it('leaves an instrumental the user has edited alone, and creates its own beside it', async () => {
    const first = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    const theirs = first!.separation!.instrumentalDocId;

    // A length-preserving edit through the app's own write path, so it carries a
    // real undo entry exactly as any effect would.
    applyEdit('Amplify', theirs, (doc) => ({
      ...doc,
      channels: doc.channels.map((ch) => ch.map((v) => v * 0.5) as Float32Array),
    }));
    const mine = useAppStore.getState().documents.find((d) => d.id === theirs)!;
    const sample = mine.channels[0][1000];

    const second = await runCoverJourney({ songDocId: songId, takeDocId: takeId });

    // Their document is not this pass's instrumental, and not one sample of it
    // was touched.
    expect(second!.separation!.instrumentalDocId).not.toBe(theirs);
    const after = useAppStore.getState().documents.find((d) => d.id === theirs)!;
    expect(after.channels[0][1000]).toBe(sample);
    // …and their undo entry still means what it meant.
    expect(getHistory(theirs).done).toEqual(['Amplify']);
    // The row says which of the two happened rather than leaving it to be found
    // in the files panel.
    expect(second!.stages[0].derived[1].from).toMatch(/your own edits|left alone/i);
  });

  /**
   * CC4 fix-round 2. An UNDONE edit puts the samples back to this pass's own
   * sum, so the content test adopts — and because adoption writes nothing, the
   * user's redo is still theirs to press and still does exactly what it says.
   * Round 1's history predicate refused this case; refusing it was safe but
   * unnecessary, and it cost a full-length document.
   */
  it('adopts one whose edit was undone, and leaves the redo intact', async () => {
    const first = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    const theirs = first!.separation!.instrumentalDocId;
    applyEdit('Amplify', theirs, (doc) => ({
      ...doc,
      channels: doc.channels.map((ch) => ch.map((v) => v * 0.5) as Float32Array),
    }));
    const edited = useAppStore.getState().documents.find((d) => d.id === theirs)!.channels[0][1000];
    undo(theirs);
    const restored = useAppStore.getState().documents.find((d) => d.id === theirs)!.channels[0][1000];

    const second = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(second!.separation!.instrumentalDocId).toBe(theirs);
    // Nothing was written, so their redo still restores their own edit.
    expect(useAppStore.getState().documents.find((d) => d.id === theirs)!.channels[0][1000]).toBe(
      restored
    );
    redo(theirs);
    expect(useAppStore.getState().documents.find((d) => d.id === theirs)!.channels[0][1000]).toBe(
      edited
    );
  });

  /**
   * CC4 fix-round 2 (N2). `find` always re-landed on the pass-1 document, so a
   * user who edited it once paid a fresh ~85 MB document on EVERY later pass,
   * unbounded. Every name-matching candidate is considered now, so the pass
   * adopts the pristine copy a later pass created.
   */
  it('stops accumulating after the one document the edited copy costs', async () => {
    const first = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    const theirs = first!.separation!.instrumentalDocId;
    applyEdit('Amplify', theirs, (doc) => ({
      ...doc,
      channels: doc.channels.map((ch) => ch.map((v) => v * 0.5) as Float32Array),
    }));

    const second = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    const afterSecond = useAppStore.getState().documents.length;
    expect(second!.separation!.instrumentalDocId).not.toBe(theirs);

    const third = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    // The pass-2 document is adopted rather than a third being stacked on.
    expect(third!.separation!.instrumentalDocId).toBe(second!.separation!.instrumentalDocId);
    expect(useAppStore.getState().documents.length).toBe(afterSecond);
    expect(
      useAppStore.getState().documents.filter((d) => d.name === 'song — Instrumental')
    ).toHaveLength(2);
    // H1 (round-2 re-review, Nit 2): this pass BOTH adopts a pristine copy and
    // leaves the user's edited one open, and the row used to say only the first
    // half — `foreignCopies` was `previous === null && …`, so the pass that
    // adopts went quiet about the second document. Two same-named full-length
    // documents in the Files panel is exactly what the row exists to explain.
    expect(third!.stages[0].derived[1].from).toMatch(/already holds/i);
    expect(third!.stages[0].derived[1].from).toMatch(/another document of this name/i);
    // The copy left beside really was edited, so the row may say so.
    expect(third!.stages[0].derived[1].from).toMatch(/your own edits/i);
  });

  /**
   * H1 fix-round 1 (I1). TWO copies that both hold the sum — reachable through
   * exactly the case Note 3 documents: the user edits pass 1's copy, pass 2
   * leaves it alone and creates a pristine one beside it, and then the user
   * presses Ctrl+Z. Undo puts the samples back to this pass's own sum, so pass
   * 3 sees two candidates that BOTH hold it.
   *
   * `previous` is `find`'s answer — the FIRST content match — so the other one
   * is pristine too, and describing it as "your own edits to it, or an earlier
   * separation" is a statement about the user's document that is not true. The
   * pre-H1 code said nothing on this pass; the row must not buy its new
   * completeness with a falsehood.
   */
  it('does not accuse the copy it left beside when that copy holds the sum too', async () => {
    const first = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    const theirs = first!.separation!.instrumentalDocId;
    applyEdit('Amplify', theirs, (doc) => ({
      ...doc,
      channels: doc.channels.map((ch) => ch.map((v) => v * 0.5) as Float32Array),
    }));
    const second = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(second!.separation!.instrumentalDocId).not.toBe(theirs);
    // The edit is undone, so BOTH documents now hold this pass's own sum.
    undo(theirs);

    const third = await runCoverJourney({ songDocId: songId, takeDocId: takeId });

    // The first content match is adopted — and it is the one whose edit was
    // undone, which is what puts a pristine copy on the other side.
    expect(third!.separation!.instrumentalDocId).toBe(theirs);
    expect(
      useAppStore.getState().documents.filter((d) => d.name === 'song — Instrumental')
    ).toHaveLength(2);
    const row = third!.stages[0].derived[1].from;
    // Still told about the second document…
    expect(row).toMatch(/already holds/i);
    expect(row).toMatch(/another document of this name/i);
    // …but not accused of an edit that is not in it.
    expect(row).not.toMatch(/your own edits/i);
    expect(row).not.toMatch(/NOT this sum/i);
  });

  /**
   * CC4 fix-round 2 (N1) — THE case an in-process signal cannot see.
   *
   * `.audm` persists documents and NOT their undo history, and reopening re-adds
   * them fresh, so an instrumental the user edited, saved and reopened reads
   * pristine to any history test while carrying their edit in its samples. This
   * round-trips the REAL serializer and the REAL parser; only the file dialog is
   * bypassed.
   */
  it('survives a save and reopen — the edit is in the samples, not in a stack', async () => {
    const first = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    const theirs = first!.separation!.instrumentalDocId;
    applyEdit('Amplify', theirs, (doc) => ({
      ...doc,
      channels: doc.channels.map((ch) => ch.map((v) => v * 0.5) as Float32Array),
    }));
    const mine = useAppStore.getState().documents.find((d) => d.id === theirs)!.channels[0][1000];

    // Save the project: the real writer, over the session the journey just built.
    const { bytes } = serializeSessionV3(
      useSessionStore.getState().session,
      useAppStore.getState().documents
    );

    // Quit and reopen. A new process has no undo stacks at all, and `histories`
    // is a module-level Map that outlives a store reset — so clearing them is
    // what makes this simulation faithful rather than accidentally easy.
    const beforeReopen = useAppStore.getState().documents.map((d) => d.id);
    useAppStore.setState(makeInitialState());
    for (const id of beforeReopen) clearHistory(id);

    // The song and its stems were never on a track, so the file does not carry
    // them: the user reopens them from their own files, under the same names.
    const song = createDocument({
      name: 'song',
      sampleRate: SR,
      channels: [tone(SONG_SAMPLES, 220, SR)],
    });
    const stems = STEM_TRACK_LABELS.map((label) =>
      createDocument({
        name: `song — ${label}`,
        sampleRate: SR,
        channels: [tone(SONG_SAMPLES, 440, SR, 0.1)],
      })
    );
    for (const d of [song, ...stems]) useAppStore.getState().addDocument(d);

    // Open Project: the real parser, applied the way `openSessionViaDialog` does.
    const parsed = parseSessionFileBytes(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    );
    for (const doc of parsed.documents) {
      useAppStore.getState().addDocument(doc);
      clearHistory(doc.id); // a freshly opened document has no history
    }
    useSessionStore.setState({ session: parsed.session });

    const restored = useAppStore
      .getState()
      .documents.find((d) => d.name === 'song — Instrumental')!;
    const restoredTake = useAppStore.getState().documents.find((d) => d.name === 'take')!;
    expect(restored.channels[0][1000]).toBe(mine); // their edit really did survive the file
    expect(getHistory(restored.id).done).toEqual([]); // …and its history really is gone

    const second = await runCoverJourney({ songDocId: song.id, takeDocId: restoredTake.id });

    // Their reopened document is not this pass's instrumental, and not one
    // sample of it was touched.
    expect(second!.separation!.instrumentalDocId).not.toBe(restored.id);
    expect(
      useAppStore.getState().documents.find((d) => d.id === restored.id)!.channels[0][1000]
    ).toBe(mine);
  });

  it('creates a fresh one when the old copy no longer describes the song', async () => {
    const first = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    // The stale copy the created-not-reused comment was written against: same
    // name, wrong length. It must not be adopted.
    useAppStore.setState({
      documents: useAppStore.getState().documents.map((d) =>
        d.id === first!.separation!.instrumentalDocId
          ? { ...d, channels: [tone(64, 100, SR)] }
          : d
      ),
    });
    const second = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(second!.separation!.instrumentalDocId).not.toBe(first!.separation!.instrumentalDocId);
  });
});

describe('priorJourneyPasses', () => {
  it('names the passes this take has already been through, oldest first', () => {
    pushUndo({ label: 'Amplify', docId: takeId, undo() {}, redo() {} });
    pushUndo({ label: VOCAL_CHAIN_UNDO_LABEL, docId: takeId, undo() {}, redo() {} });
    pushUndo({ label: COVER_CHAIN_UNDO_LABEL, docId: takeId, undo() {}, redo() {} });
    expect(priorJourneyPasses(takeId)).toEqual([VOCAL_CHAIN_UNDO_LABEL, COVER_CHAIN_UNDO_LABEL]);
  });

  it('is empty for a take nothing has run on, and for a document that is not there', () => {
    expect(priorJourneyPasses(takeId)).toEqual([]);
    expect(priorJourneyPasses('nope')).toEqual([]);
    pushUndo({ label: 'Normalize', docId: takeId, undo() {}, redo() {} });
    expect(priorJourneyPasses(takeId)).toEqual([]);
  });
});

// ── The stepper ─────────────────────────────────────────────────────────────

describe('runCoverJourney — the live view', () => {
  it('walks every stage through start, progress and result', async () => {
    const started: CoverJourneyStageId[] = [];
    const results: CoverJourneyStageResult[] = [];
    const progress: number[] = [];
    const seen: CoverJourneyStageProgress[] = [];

    await runCoverJourney({
      songDocId: songId,
      takeDocId: takeId,
      onStageStart: (s) => started.push(s.id),
      onStageResult: (r) => results.push(r),
      onProgress: (f) => progress.push(f),
      onStageProgress: (p) => seen.push(p),
    });

    expect(started).toEqual(COVER_JOURNEY_STAGES.map((s) => s.id));
    // The result objects handed to the live callback ARE the report's own.
    expect(results.map((r) => r.id)).toEqual(COVER_JOURNEY_STAGES.map((s) => s.id));
    expect(progress[progress.length - 1]).toBeCloseTo(1, 5);
    expect(progress.every((f) => f >= 0 && f <= 1)).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('nests the vocal chain\'s own stages rather than flattening them', async () => {
    runVocalChain.mockImplementation(async (opts: vocalChain.RunVocalChainOptions) => {
      opts.onStageProgress?.({
        stageId: 'hum',
        label: 'De-Hum',
        phase: 'measuring',
        stageFraction: 0,
        detail: 'measuring the audio that reaches this stage',
      });
      return okVocalReport();
    });

    const nested: CoverJourneyStageProgress[] = [];
    await runCoverJourney({
      songDocId: songId,
      takeDocId: takeId,
      onStageProgress: (p) => {
        if (p.sub) nested.push(p);
      },
    });

    const clean = nested.find((p) => p.stageId === 'clean');
    expect(clean).toBeDefined();
    // The nested row keeps the sub-chain's OWN label and detail — the words the
    // Vocal Chain dialog would have shown — instead of one opaque bar.
    expect(clean!.sub!.label).toBe('De-Hum');
    expect(clean!.sub!.stageId).toBe('hum');
    expect(clean!.detail).toContain('De-Hum');
  });

  it('carries each nested chain\'s whole report on its stage', async () => {
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(report!.stages.find((s) => s.id === 'clean')!.vocalChain).toBeDefined();
    expect(report!.stages.find((s) => s.id === 'match')!.coverChain).toBeDefined();
  });
});

// ── Cancellation ────────────────────────────────────────────────────────────

describe('runCoverJourney — cancellation', () => {
  it.each(COVER_JOURNEY_STAGES.map((s, i) => [s.id, i] as const))(
    'stops cleanly when cancelled before %s',
    async (id, index) => {
      let calls = 0;
      const report = await runCoverJourney({
        songDocId: songId,
        takeDocId: takeId,
        // Fires on the (index+1)-th poll — i.e. at the head of stage `index`.
        shouldCancel: () => ++calls > index,
      });

      expect(report).not.toBeNull();
      expect(report!.completed).toBe(false);
      expect(report!.cancelledAt).toBe(id);
      // Every stage still owes the user a row, cancelled or not reached.
      expect(report!.stages.map((s) => s.id)).toEqual(COVER_JOURNEY_STAGES.map((s) => s.id));
      expect(report!.stages[index].status).toBe('cancelled');
      for (let i = index + 1; i < COVER_JOURNEY_STAGES.length; i++) {
        expect(report!.stages[i].status).toBe('pending');
      }
    }
  );

  it('leaves NO session behind when cancelled before the session is built', async () => {
    useSessionStore.setState({ session: { name: 'untouched', sampleRate: SR, tracks: [] } });
    let calls = 0;
    const report = await runCoverJourney({
      songDocId: songId,
      takeDocId: takeId,
      shouldCancel: () => ++calls > 4, // at the head of 'place'
    });
    expect(report!.cancelledAt).toBe('place');
    expect(useSessionStore.getState().session.name).toBe('untouched');
    expect(report!.placement).toBeNull();
    // …and the row SAYS that, rather than leaving the user to discover it.
    expect(report!.stages.find((s) => s.id === 'place')!.reason).toMatch(/no session/);
  });

  /**
   * CC4 (CJ-1) — THE acceptance test for the contract the whole cancellation
   * design rests on.
   *
   * The fresh-separation arm used to call `landStems`, which REPLACES the
   * session and clears its undo history, at stage 1 — four stages before the
   * header, the cancel copy and the dialog all say any session is touched. A
   * user with unsaved arrangement work who cancelled at stage 2 lost it, and
   * the report's own row told them "there is no session".
   *
   * The fixture is therefore a session the user built themselves, with a track
   * arrangement that is checkable sample by sample after the cancel.
   */
  it('leaves the user\'s own session untouched when the FRESH arm is cancelled mid-run', async () => {
    seed(false);
    separateStems.mockImplementation(async () => ({ ok: true, output: separationOutput() }));

    const mine: Session = {
      name: 'my arrangement',
      sampleRate: SR,
      tracks: [
        {
          ...createTrack('Vox'),
          clips: [
            createClip({ documentId: takeId, startSample: 4321, offsetSample: 0, lengthSample: 999 }),
          ],
        },
      ],
    };
    useSessionStore.setState({ session: mine, mtCursorSample: 777 });

    let calls = 0;
    const report = await runCoverJourney({
      songDocId: songId,
      takeDocId: takeId,
      shouldCancel: () => ++calls > 1, // at the head of 'clean' — the separation ran
    });

    expect(report!.cancelledAt).toBe('clean');
    // The separation DID happen: its five documents are on screen.
    const names = useAppStore.getState().documents.map((d) => d.name);
    for (const label of STEM_TRACK_LABELS) expect(names).toContain(`song — ${label}`);

    // …and the user's session is exactly the one they had, arrangement intact.
    const after = useSessionStore.getState();
    expect(after.session.name).toBe('my arrangement');
    expect(after.session.tracks).toHaveLength(1);
    expect(after.session.tracks[0].name).toBe('Vox');
    expect(after.session.tracks[0].clips[0].startSample).toBe(4321);
    expect(after.session.tracks[0].clips[0].lengthSample).toBe(999);
    expect(after.mtCursorSample).toBe(777);
    // The row that says so is now true rather than aspirational.
    const reason = report!.stages.find((s) => s.id === 'clean')!.reason!;
    expect(reason).toMatch(/no session/);
    expect(reason).toMatch(/untouched/);
  });

  it('tells the truth about the session when cancelled at the LAST stage', async () => {
    // CP1 fix-round (I1). Stage 5 has already run by the time stage 6 is
    // cancelled, so the session IS on screen. The copy used to say "there is no
    // session" — the one sentence a user could check against their own screen
    // and find false.
    let calls = 0;
    const report = await runCoverJourney({
      songDocId: songId,
      takeDocId: takeId,
      shouldCancel: () => ++calls > 5, // at the head of 'smooth'
    });
    expect(report!.cancelledAt).toBe('smooth');
    expect(report!.placement).not.toBeNull();
    expect(useSessionStore.getState().session.tracks).toHaveLength(2);

    const reason = report!.stages.find((s) => s.id === 'smooth')!.reason!;
    expect(reason).toContain('after the session was built');
    expect(reason).toContain(report!.placement!.sessionName);
    expect(reason).toMatch(/NOT faded/);
    expect(reason).not.toMatch(/there is no session/);
    expect(report!.smoothing).toBeNull();
  });

  it('forwards the cancel to the separation model rather than waiting it out', async () => {
    seed(false);
    separateStems.mockImplementation(
      async (req: { onProgress?: (p: stemService.StemSeparationProgress) => void }) => {
        req.onProgress?.({
          phase: 'inference',
          segment: 1,
          totalSegments: 10,
          fraction: 0.1,
          elapsedMs: 10,
          estimatedRemainingMs: 90,
        });
        return { ok: false, status: 'cancelled', message: 'cancelled' };
      }
    );
    const report = await runCoverJourney({
      songDocId: songId,
      takeDocId: takeId,
      shouldCancel: () => separateStems.mock.calls.length > 0,
    });
    expect(cancelStemSeparation).toHaveBeenCalled();
    expect(report!.cancelledAt).toBe('separate');
  });
});

// ── Alignment and placement ─────────────────────────────────────────────────

describe('runCoverJourney — alignment and placement arithmetic', () => {
  it('places the take at the measured offset', async () => {
    alignTakeToReference.mockReturnValue(confidentAlignment(1.25));
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(report!.placement!.takeStartSample).toBe(Math.round(1.25 * SR));
    expect(report!.placement!.instrumentalStartSample).toBe(0);
    expect(report!.placement!.shiftedSamples).toBe(0);

    const session = useSessionStore.getState().session;
    expect(session.tracks).toHaveLength(2);
    expect(session.tracks[1].clips[0].startSample).toBe(Math.round(1.25 * SR));
  });

  // M4 (train): the journey's stage 5 is a FIFTH load-shaped session apply, and
  // it was written while MT1 was fixing the other four in parallel — so it
  // shipped the hardcoded `{ samplesPerPixel: 512 }` those four had just lost.
  // A cover session is a whole song plus a take, i.e. exactly the minutes-long
  // material the reported bug was filed against: 512 samples/px is ~16 s of
  // timeline whatever is on it. The rule is the one MT1 established — every
  // load-shaped apply commits the session's RESOLVED zoom.
  it('opens the placed session fitted, not at the hardcoded 512', async () => {
    // A LONG song, and that length is the whole point of the fixture. 512
    // samples/px is only wrong when it is a REACHABLE zoom — i.e. when the
    // session's fit ceiling is coarser than 512. The rest of this suite runs an
    // 8 s song, whose fit is ~46 samples/px, so a hardcoded 512 exceeds the
    // zoom-out ceiling and `resolveSessionZoom` clamps it back to the fit: the
    // bug is invisible there, and a test written on that fixture passes against
    // the broken code. At 120 s the fit is ~698 samples/px, 512 sits inside the
    // range and stands — which is the reported case (a 2:58 session fitting at
    // 5704.8 opened at 512, i.e. 16 s visible at ~1114%). A cover session is a
    // whole song plus a take, so it is ALWAYS this end of the scale.
    seed(true, SR, SR * 120);
    // Start from NO session — the state a user actually runs the journey from.
    // MT1's subscription re-resolves only when the timeline gets SHORTER, so a
    // session grown from empty is exactly the case nothing downstream rescues.
    useSessionStore.setState({ session: { name: 'none', sampleRate: SR, tracks: [] } });
    alignTakeToReference.mockReturnValue(confidentAlignment(1.25));
    await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    const session = useSessionStore.getState().session;
    const fit = defaultSessionZoom(session);
    // The fixture must actually be able to express the bug, or this test is
    // green against broken code.
    expect(fit.samplesPerPixel).toBeGreaterThan(512);
    expect(useSessionStore.getState().mtZoom).toEqual(fit);
  });

  it('shifts BOTH tracks rather than clamping a negative offset to zero', async () => {
    alignTakeToReference.mockReturnValue(confidentAlignment(-0.75));
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    const shift = Math.round(0.75 * SR);
    expect(report!.placement!.shiftedSamples).toBe(shift);
    expect(report!.placement!.takeStartSample).toBe(0);
    expect(report!.placement!.instrumentalStartSample).toBe(shift);
    // The measured interval between the two survives the shift exactly.
    expect(
      report!.placement!.takeStartSample - report!.placement!.instrumentalStartSample
    ).toBe(-shift);
  });

  it('converts the offset into SESSION samples when the take has another rate', async () => {
    seed(true, 16000);
    alignTakeToReference.mockReturnValue(confidentAlignment(0.5));
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    // The session runs at the instrumental's rate, not the take's.
    expect(report!.placement!.sessionRate).toBe(SR);
    expect(report!.placement!.takeStartSample).toBe(Math.round(0.5 * SR));
    // …and the clip's LENGTH is converted too, or the take would play at the
    // wrong length on the timeline.
    const take = useAppStore.getState().documents.find((d) => d.id === takeId)!;
    expect(report!.placement!.takeLengthSample).toBe(
      Math.round((docLength(take) * SR) / 16000)
    );
  });

  it('places at zero and states the numbers when the alignment is not believed', async () => {
    // CC2's contract: a 0.31 peak is below every floor and every unrelated
    // band, and with no window agreement to speak against it that is
    // 'unrelated' — the one outcome whose `confident` is false and whose
    // piecewise fields are absent.
    alignTakeToReference.mockReturnValue(unrelatedAlignment(3.5, 0.31, 0.02));
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });

    expect(report!.alignmentRefused).toBe(true);
    expect(report!.placement!.takeStartSample).toBe(0);
    const stage = report!.stages.find((s) => s.id === 'align')!;
    expect(stage.status).toBe('declined');
    // The refusal quotes what it measured AND what it was measured against.
    expect(stage.reason).toContain('0.310');
    expect(stage.reason).toContain(String(coverAlign.ALIGN_MIN_CORRELATION));
    expect(stage.reason).toContain(String(coverAlign.ALIGN_MIN_PROMINENCE));
    // …and the run goes on. A refusal is not a failure.
    expect(report!.completed).toBe(true);
  });

  it('declines without a placement guess when there is nothing to measure', async () => {
    alignTakeToReference.mockReturnValue(null);
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(report!.alignment).toBeNull();
    const stage = report!.stages.find((s) => s.id === 'align')!;
    expect(stage.status).toBe('declined');
    // The measurement claim belongs ONLY to a genuine null measurement.
    expect(stage.reason).toMatch(/no attack anywhere/);
    expect(report!.placement!.takeStartSample).toBe(0);
    expect(report!.completed).toBe(true);
  });

  // CC4 (CJ-5): the same null branch fired when a DOCUMENT went missing, and
  // claimed a measurement that never ran. Stage 5 has accurate wording for
  // exactly this case; stage 3 now shares it instead of guessing.
  it('says the document was closed, not that nothing had an attack, when one disappears', async () => {
    runVocalChain.mockImplementation(async () => {
      // The vocals stem is closed while the (minutes-long) clean stage runs.
      useAppStore.setState({
        documents: useAppStore.getState().documents.filter((d) => d.name !== 'song — Vocals'),
      });
      return okVocalReport();
    });

    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });

    const stage = report!.stages.find((s) => s.id === 'align')!;
    expect(stage.status).toBe('declined');
    expect(stage.reason).toMatch(/closed while the pass was running/);
    expect(stage.reason).not.toMatch(/no attack anywhere/);
    // Nothing was measured, so nothing may be reported as measured.
    expect(alignTakeToReference).not.toHaveBeenCalled();
    expect(report!.alignment).toBeNull();
  });

  // ── CC3: what the refusal TELLS the user to do ────────────────────────────

  /** A refusal at `offsetSeconds`, with whatever extra outcome fields a
   * measurement of the day carries. The base is UNCLASSIFIED — `outcome` is
   * stripped, not inherited from `confidentAlignment`, because a measurement
   * with `outcome: 'confident'` and `confident: false` violates CC2's invariant
   * (`confident === (outcome === 'confident')`) and can never be produced.
   * Tests that want a classified refusal pass the outcome via `extra`. */
  const refusedAlignment = (offsetSeconds: number, extra: Record<string, unknown> = {}) => ({
    ...confidentAlignment(offsetSeconds),
    peakCorrelation: 0.423,
    rivalCorrelation: 0.344,
    prominence: 0.079,
    outcome: undefined,
    confident: false,
    ...extra,
  });

  /**
   * H1 (seam-fix re-review, triage). The two OFFER outcomes, in shapes the
   * emitter can actually produce — `refusedAlignment` with an outcome word set
   * on it is not one, and three tests below were using exactly that.
   *
   * Its 0.423 peak cannot be `'ambiguous'`: ambiguity means "several lags match
   * EQUALLY WELL", which the emitter only asks about once the peak has CLEARED
   * the acceptance floor (`coverAlign.ts` — `peakClears && prominence <
   * ALIGN_MIN_PROMINENCE`). And neither offer outcome can be candidate-LESS:
   * the list rides every `'ambiguous'` and every `'weak'` measurement, and its
   * first entry restates the measurement's own lag, correlation and prominence
   * because the emitter builds it from the winning lag. Nothing here changes
   * what any test asserts; these are the same two arms in states a run can
   * reach.
   */
  const ambiguousAlignment = (offsetSeconds: number): coverAlign.AlignmentMeasurement => ({
    // The repeated-section regime: a high peak that means nothing, because
    // three other lags match about as well. The base's agreeing windows are
    // legal here — the drift pair rides any arm whose windows ran and agreed.
    ...confidentAlignment(offsetSeconds),
    peakCorrelation: 0.95,
    rivalCorrelation: 0.93,
    prominence: 0.02,
    outcome: 'ambiguous',
    confident: false,
    candidates: [
      { offsetSeconds, correlation: 0.95, prominence: 0.02 },
      { offsetSeconds: offsetSeconds + 12.5, correlation: 0.93, prominence: 0.01 },
    ],
  });

  /**
   * `'weak'` in the gap-zone shape: a peak above every unrelated pair the sweep
   * can build but below the acceptance floor, on a take too short for the
   * piecewise arm to have an opinion — so `windowsMeasured: 0`, no spread, and
   * no drift, because a slope needs windows that ran and agreed before it is a
   * drift at all.
   */
  const weakAlignment = (offsetSeconds: number): coverAlign.AlignmentMeasurement => {
    const base = confidentAlignment(offsetSeconds);
    delete base.windowLagSpreadSeconds;
    delete base.driftSecondsPerMinute;
    return {
      ...base,
      peakCorrelation: 0.71,
      rivalCorrelation: 0.631,
      prominence: 0.079,
      outcome: 'weak',
      confident: false,
      windowsMeasured: 0,
      candidates: [
        { offsetSeconds, correlation: 0.71, prominence: 0.079 },
        { offsetSeconds: offsetSeconds + 12.5, correlation: 0.7, prominence: 0.05 },
      ],
    };
  };

  /**
   * The align row's own copy, whichever field carries it.
   *
   * V3 split the arm in two: a measurement that is PLACED says so in the row's
   * `warning` (the row is `done`), and one placed at zero says so in its
   * `reason` (the row is `declined`). The invariant these tests are about — the
   * copy names the control the dialog renders — is about the copy the user
   * reads, not about which field it arrived in, so this reads both.
   */
  const alignReason = async (measurement: unknown): Promise<string> => {
    alignTakeToReference.mockReturnValue(measurement);
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    const stage = report!.stages.find((s) => s.id === 'align')!;
    return [stage.reason, stage.warning].filter(Boolean).join(' ');
  };

  it('sends a NEGATIVE refused guess to the instrumental, not to the take', async () => {
    const reason = await alignReason(refusedAlignment(-8.258));
    // The reported case, verbatim: only the instrumental can realise it.
    expect(reason).toContain('Instrumental');
    expect(reason).toContain('8.258 s');
    expect(reason).toContain('cannot start before zero');
    expect(reason).not.toMatch(/drag (it|your take) on the timeline/i);
  });

  it('sends a POSITIVE refused guess to the take', async () => {
    const reason = await alignReason(refusedAlignment(8.258));
    expect(reason).toContain('drag your take to about 8.258 s');
    expect(reason).not.toContain('Instrumental');
  });

  it('stops recommending Align Vocal Timing, which cannot move a clip at all', async () => {
    for (const offset of [-8.258, 8.258]) {
      expect(await alignReason(refusedAlignment(offset))).not.toContain('Align Vocal Timing');
    }
  });

  it('still names Align Vocal Timing in the BELIEVED arm, where it is the right tool', async () => {
    alignTakeToReference.mockReturnValue(confidentAlignment(1.25));
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(report!.stages.find((s) => s.id === 'align')!.warning).toContain('Align Vocal Timing');
  });

  it('asserts no kind of failure when the measurement did not classify itself', async () => {
    const reason = await alignReason(refusedAlignment(-8.258));
    expect(reason).not.toContain('weak but plausible');
    expect(reason).not.toContain('probably wrong');
    expect(reason).not.toContain('several places');
  });

  it('carries the measurement\'s own outcome word when it has one', async () => {
    expect(await alignReason(unrelatedAlignment(-8.258, 0.423, 0.079))).toContain(
      'probably wrong'
    );
    expect(await alignReason(weakAlignment(-8.258))).toContain('weak but plausible');
    expect(await alignReason(ambiguousAlignment(-8.258))).toContain('several places');
  });

  // The reason is the PRIMARY instruction of a refusal, and it is read next to
  // the offer it describes. The dialog swaps the single button for one row per
  // candidate whenever the measurement lists any, so on the two outcomes that
  // always list them the button sentence sent the user looking for a control
  // that is not on screen.
  it('points a candidate-bearing refusal at the rows, not at the button they replace', async () => {
    for (const measurement of [ambiguousAlignment(-8.258), weakAlignment(-8.258)]) {
      const reason = await alignReason(measurement);
      expect(reason).toContain(coverPlacement.CANDIDATE_PLACEMENT_LABEL);
      expect(reason).not.toContain(coverPlacement.APPLY_GUESS_LABEL);
    }
  });

  it('keeps the button sentence where the button is what renders', async () => {
    // 'unrelated' has no guess worth listing and today's outcome-less shape
    // lists nothing either, so both render the single apply button. H1: the
    // 'unrelated' half is the emitter's own shape now — windows that ran and
    // AGREED are what excludes 'unrelated', so the fixture cannot inherit them.
    for (const measurement of [unrelatedAlignment(-8.258, 0.423, 0.079), refusedAlignment(-8.258)]) {
      const reason = await alignReason(measurement);
      expect(reason).toContain(coverPlacement.APPLY_GUESS_LABEL);
      expect(reason).not.toContain(coverPlacement.CANDIDATE_PLACEMENT_LABEL);
    }
  });

  // ── V3: the pass places the tracks itself ────────────────────────────────
  //
  // "it should place the tracks by itself!" — the user, after clicking the
  // first of three offered candidates and finding it right. CC3 built the offer
  // because a refusal that threw its number away was worse than useless; V3
  // goes the rest of the way for the two outcomes that carry a usable guess,
  // and keeps the alternatives one click away for when the guess is wrong.

  it('PLACES a weak guess at its own lag rather than at the start of the original', async () => {
    const report = await (async () => {
      alignTakeToReference.mockReturnValue(weakAlignment(-0.75));
      return runCoverJourney({ songDocId: songId, takeDocId: takeId });
    })();
    // The same both-track arithmetic the believed arm uses: nothing is clamped.
    const shift = Math.round(0.75 * SR);
    expect(report!.placement!.takeStartSample).toBe(0);
    expect(report!.placement!.instrumentalStartSample).toBe(shift);
    expect(report!.placement!.shiftedSamples).toBe(shift);
    // It is not a refusal any more, and the report says which of the two it is.
    expect(report!.alignmentRefused).toBe(false);
    expect(report!.alignmentAutoPlaced).toBe(true);
    const stage = report!.stages.find((s) => s.id === 'align')!;
    expect(stage.status).toBe('done');
    expect(stage.reason).toBeUndefined();
    // …and it says so where a `done` row says things, with the measurement in
    // it and the alternatives named.
    expect(stage.warning).toContain('0.750 s');
    expect(stage.warning).toContain('weak but plausible');
    expect(stage.warning).toContain(coverPlacement.CANDIDATE_PLACEMENT_LABEL);
    // The measurement is stated in the row, not only in the sentence.
    expect(stage.derived.map((d) => d.label)).toContain('Offset');
    expect(stage.derived.map((d) => d.label)).toContain('Confidence');
    expect(report!.completed).toBe(true);
  });

  it('PLACES an ambiguous guess at its best candidate, with the rivals still offered', async () => {
    const measurement = ambiguousAlignment(1.5);
    alignTakeToReference.mockReturnValue(measurement);
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    // `candidates[0].offsetSeconds === offsetSeconds` is the DSP's contract, so
    // placing the reported offset IS placing the best candidate.
    expect(measurement.candidates![0].offsetSeconds).toBe(measurement.offsetSeconds);
    expect(report!.placement!.takeStartSample).toBe(Math.round(1.5 * SR));
    expect(report!.alignmentAutoPlaced).toBe(true);
    const stage = report!.stages.find((s) => s.id === 'align')!;
    expect(stage.status).toBe('done');
    expect(stage.warning).toContain('several places');
    expect(stage.warning).toContain(coverPlacement.CANDIDATE_PLACEMENT_LABEL);
  });

  it('does NOT place an unrelated guess — that one still goes to zero', async () => {
    alignTakeToReference.mockReturnValue(unrelatedAlignment(-8.258, 0.423, 0.079));
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(report!.placement!.takeStartSample).toBe(0);
    expect(report!.placement!.shiftedSamples).toBe(0);
    expect(report!.alignmentRefused).toBe(true);
    expect(report!.alignmentAutoPlaced).toBe(false);
    expect(report!.stages.find((s) => s.id === 'align')!.status).toBe('declined');
  });

  it('does NOT place a measurement that classified itself not at all', async () => {
    alignTakeToReference.mockReturnValue(refusedAlignment(-8.258));
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(report!.placement!.takeStartSample).toBe(0);
    expect(report!.alignmentAutoPlaced).toBe(false);
    expect(report!.alignmentRefused).toBe(true);
  });

  it('places an auto-placed guess through the SHARED placement function', async () => {
    alignTakeToReference.mockReturnValue(weakAlignment(-0.75));
    // Values no arithmetic would produce from −0.75 s: if the auto-place arm
    // ever grows its own copy of the shift rule, the session stops matching
    // what the shared function said and this fails.
    placementFor.mockReturnValueOnce({
      rawTakeStartSample: -7,
      shiftedSamples: 3,
      takeStartSample: 10,
      instrumentalStartSample: 3,
    });
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(report!.placement!.takeStartSample).toBe(10);
    expect(report!.placement!.instrumentalStartSample).toBe(3);
  });

});

// ── CC3 fix round 1: one shift arithmetic, shared with the apply arm ────────

describe('runCoverJourney — where the two clip starts come from', () => {
  it('builds the session from the SHARED placement function, not its own copy', async () => {
    alignTakeToReference.mockReturnValue(confidentAlignment(-0.75));
    // Values no arithmetic would produce from -0.75 s: if this stage ever
    // computes the shift itself again, the session stops matching what the
    // shared function said and this fails.
    placementFor.mockReturnValueOnce({
      rawTakeStartSample: -7,
      shiftedSamples: 3,
      takeStartSample: 10,
      instrumentalStartSample: 3,
    });
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });

    expect(placementFor).toHaveBeenCalledWith(-0.75, SR);
    expect(report!.placement!.takeStartSample).toBe(10);
    expect(report!.placement!.instrumentalStartSample).toBe(3);
    expect(report!.placement!.shiftedSamples).toBe(3);
    // …and the CLIPS carry it, not only the report.
    const tracks = useSessionStore.getState().session.tracks;
    expect(tracks[0].clips[0].startSample).toBe(3);
    expect(tracks[1].clips[0].startSample).toBe(10);
  });

  it('agrees with the apply-the-guess arm for every sign, by construction', async () => {
    for (const offset of [-8.258, -0.75, 0, 1.25]) {
      alignTakeToReference.mockReturnValue(confidentAlignment(offset));
      const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
      const shared = jest.requireActual('./coverPlacement').placementFor(offset, SR);
      expect(report!.placement!.takeStartSample).toBe(shared.takeStartSample);
      expect(report!.placement!.instrumentalStartSample).toBe(shared.instrumentalStartSample);
      expect(report!.placement!.shiftedSamples).toBe(shared.shiftedSamples);
    }
  });
});

// ── CC3: the Place row stops calling the zero fallback a measurement ────────

describe('runCoverJourney — what the Place row says it placed at', () => {
  const takeAtRow = (report: Awaited<ReturnType<typeof runCoverJourney>>) =>
    report!.stages.find((s) => s.id === 'place')!.derived.find((d) => d.label === 'Take at')!;

  it('says the alignment was REFUSED rather than claiming a measured +0.000 s', async () => {
    // The reported case's numbers, in the shape the contract emits for them.
    alignTakeToReference.mockReturnValue(unrelatedAlignment(-8.258, 0.423, 0.079));
    const row = takeAtRow(await runCoverJourney({ songDocId: songId, takeDocId: takeId }));
    expect(row.value).toBe('0.000 s');
    expect(row.from).toContain('refused');
    expect(row.from).not.toContain('the measured offset +0.000 s');
  });

  it('says the alignment could not be MEASURED when there was nothing to measure', async () => {
    alignTakeToReference.mockReturnValue(null);
    const row = takeAtRow(await runCoverJourney({ songDocId: songId, takeDocId: takeId }));
    expect(row.from).toContain('could not be measured');
    expect(row.from).not.toContain('the measured offset +0.000 s');
  });

  it('still cites the measured offset when the alignment WAS believed', async () => {
    alignTakeToReference.mockReturnValue(confidentAlignment(1.25));
    const row = takeAtRow(await runCoverJourney({ songDocId: songId, takeDocId: takeId }));
    expect(row.from).toContain('the measured offset +1.250 s');
  });

  it('still cites the measured offset for a believed offset of exactly zero', async () => {
    alignTakeToReference.mockReturnValue(confidentAlignment(0));
    const row = takeAtRow(await runCoverJourney({ songDocId: songId, takeDocId: takeId }));
    expect(row.from).toContain('the measured offset +0.000 s');
  });
});

// ── The reference the match trusts ──────────────────────────────────────────

/**
 * CC4 (CJ-3). The match stages' floor is checkable only against the song the
 * reference was separated FROM, and this pass is the one caller that always
 * knows it. What is asserted here is the WIRING and the row the user reads; the
 * floor's own arithmetic is derived and pinned in `coverChain.test.ts`.
 */
describe('runCoverJourney — the separated vocal has to be plausible', () => {
  it('tells the Cover Chain which mix the reference came out of', async () => {
    await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(runCoverChain.mock.calls[0][0].mixDocId).toBe(songId);
  });

  it('warns on the match row, with the number, when the floor refused the reference', async () => {
    runCoverChain.mockResolvedValue({
      ...okCoverReport(),
      referenceImplausibleBelowDb: 41.29,
    });
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });

    const match = report!.stages.find((s) => s.id === 'match')!;
    expect(match.warning).toContain('41.29');
    expect(match.warning).toMatch(/separat/i);
    // The run still finishes and still places the take — the take was left
    // unmatched, not destroyed, which is the entire point of declining.
    expect(report!.completed).toBe(true);
    expect(report!.placement).not.toBeNull();
  });

  it('says nothing when the reference was believable', async () => {
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(report!.stages.find((s) => s.id === 'match')!.warning).toBeUndefined();
  });
});

// ── The placed take's level ─────────────────────────────────────────────────

/**
 * CC4 (CJ-2). Match Loudness calibrates the take in DOCUMENT space, against the
 * separated original vocal. The session then renders it — and `mixdownSession`
 * picks its pan law from the clip source's channel count, so a MONO take (the
 * normal case for a mic recording) took the constant-power law at 0.7071/side
 * while the always-stereo instrumental took the unity balance law. The take
 * sounded 3.01 dB under the level that had just been calibrated for it, and
 * nothing said so.
 *
 * These assertions are made on the RENDER, never on a gain field: a test that
 * echoed the compensation back would pass against a compensation applied to the
 * wrong object entirely.
 */
describe('runCoverJourney — the placed take renders at its calibrated level', () => {
  /** The take track alone, rendered through the real mixdown. */
  function renderTakeTrack(): { peak: number; docPeak: number } {
    const session = useSessionStore.getState().session;
    const docs = new Map(useAppStore.getState().documents.map((d) => [d.id, d] as const));
    const takeTrack = session.tracks.find((t) => t.name === 'Cover Vocal')!;
    const mixed = mixdownSession({ ...session, tracks: [takeTrack] }, docs);
    let peak = 0;
    for (const ch of mixed.channels) {
      for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
    }
    const doc = docs.get(takeId)!;
    let docPeak = 0;
    for (const ch of doc.channels) {
      for (let i = 0; i < ch.length; i++) docPeak = Math.max(docPeak, Math.abs(ch[i]));
    }
    return { peak, docPeak };
  }

  it('renders a MONO take at the level Match Loudness set, not 3.01 dB under it', async () => {
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(useAppStore.getState().documents.find((d) => d.id === takeId)!.channels).toHaveLength(1);

    const { peak, docPeak } = renderTakeTrack();
    // The number that matters, in the unit the defect was stated in.
    expect(20 * Math.log10(peak / docPeak)).toBeCloseTo(0, 3);
    // …and the fixture can actually express the bug: without compensation the
    // very same render would have peaked at 0.7071 × the document.
    expect(docPeak * Math.SQRT1_2).toBeLessThan(peak * 0.99);
    expect(report!.placement!.takeGainDb).toBeCloseTo(MONO_PAN_COMPENSATION_DB, 12);
  });

  it('leaves a STEREO take at unity — the balance law needs no help', async () => {
    useAppStore.setState({
      documents: useAppStore.getState().documents.map((d) =>
        d.id === takeId
          ? { ...d, channels: [tone(TAKE_SAMPLES, 330, SR), tone(TAKE_SAMPLES, 330, SR)] }
          : d
      ),
    });
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });

    const { peak, docPeak } = renderTakeTrack();
    expect(20 * Math.log10(peak / docPeak)).toBeCloseTo(0, 3);
    expect(report!.placement!.takeGainDb).toBe(0);
    expect(useSessionStore.getState().session.tracks[1].clips[0].gainDb).toBe(0);
  });

  it('says what it did rather than moving the level silently', async () => {
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    const place = report!.stages.find((s) => s.id === 'place')!;
    const row = place.derived.find((d) => d.label === 'Take routing')!;
    expect(row.value).toContain('+3.01 dB');
    expect(row.from).toMatch(/mono/i);
  });
});

// ── Smoothing ───────────────────────────────────────────────────────────────

describe('runCoverJourney — smoothing and the level check', () => {
  /** V4: a session whose two tracks sum well past full scale — the shape the
   * user's run produced, and the only shape the trim has anything to do. Two
   * full-scale sources: the loudest stem the instrumental is summed from, and
   * the take. The clamped mixdown could never show the overshoot, which is the
   * whole reason the pre-clamp peak exists. */
  function overCeilingFixture(): void {
    useAppStore.setState({
      documents: useAppStore.getState().documents.map((d) =>
        d.name === 'song — Drums' || d.id === takeId
          ? { ...d, channels: [tone(docLength(d), 300, d.sampleRate, 1)] }
          : d
      ),
    });
  }

  it('fades both edges of the placed take with the v1.9 curve', async () => {
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    const expected = Math.round((JOURNEY_FADE_MS / 1000) * SR);
    expect(report!.smoothing!.fadeInSample).toBe(expected);
    expect(report!.smoothing!.fadeOutSample).toBe(expected);
    expect(report!.smoothing!.curve).toBe('equal-power');

    const clip = useSessionStore.getState().session.tracks[1].clips[0];
    expect(clip.fadeInSample).toBe(expected);
    expect(clip.fadeOutSample).toBe(expected);
    expect(clip.fadeInCurve).toBe('equal-power');
  });

  it('shortens the pair rather than letting the two fades cross on a short take', async () => {
    useAppStore.setState({
      documents: useAppStore.getState().documents.map((d) =>
        d.id === takeId ? { ...d, channels: [tone(120, 300, SR)] } : d
      ),
    });
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    const s = report!.smoothing!;
    expect(s.fadeInSample + s.fadeOutSample).toBeLessThanOrEqual(
      report!.placement!.takeLengthSample
    );
  });

  it('measures the summed peak before the clamp and warns when it passes full scale', async () => {
    // Two full-scale tracks sum well over 0 dBFS; the clamped mixdown could
    // never show that, which is the whole reason the pre-clamp peak exists.
    overCeilingFixture();
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(report!.smoothing!.overCeiling).toBe(true);
    expect(report!.smoothing!.summedPeakDb).toBeGreaterThan(0);
    const stage = report!.stages.find((s) => s.id === 'smooth')!;
    expect(stage.warning).toContain('above full scale');
    // V4: this assertion used to read "nothing was normalised on the user's
    // behalf — the fix is named, not done", and the run in the user's report is
    // what retired it: the journey built the overshoot, so naming it and
    // walking away made the journey's own arithmetic the user's problem. The
    // faders are still what the sentence is about, but now because the pass
    // moved them and says by how much.
    expect(stage.warning).toMatch(/fader/);
    expect(stage.warning).toContain(report!.smoothing!.trimDb.toFixed(2));
  });

  // V4 — R1: the trim itself.

  it('trims both faders by the overshoot rather than handing over a clipping session', async () => {
    overCeilingFixture();
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    const s = report!.smoothing!;
    expect(s.overCeiling).toBe(true);
    // The overshoot, plus the stated headroom — one number, both faders.
    expect(s.trimDb).toBeCloseTo(s.summedPeakDb - JOURNEY_PEAK_TARGET_DB, 6);

    const tracks = useSessionStore.getState().session.tracks;
    expect(tracks.map((t) => t.name)).toEqual(['Instrumental', 'Cover Vocal']);
    for (const t of tracks) expect(t.volumeDb).toBeCloseTo(-s.trimDb, 6);

    // …and the session really does peak at the target now — measured HERE, from
    // the store the user is left looking at, not read back out of the report.
    const docs = new Map(useAppStore.getState().documents.map((d) => [d.id, d] as const));
    const peak = mixdownSessionPeak(useSessionStore.getState().session, docs);
    expect(20 * Math.log10(peak)).toBeLessThanOrEqual(JOURNEY_PEAK_TARGET_DB + 1e-6);
    expect(peak).toBeLessThan(1);
    expect(s.trimmedPeakDb!).toBeCloseTo(20 * Math.log10(peak), 6);
  });

  it('trims BOTH tracks equally, so the balance Match Loudness set survives it', async () => {
    overCeilingFixture();
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    const [inst, take] = useSessionStore.getState().session.tracks;
    // Equal trim on faders that both started at 0 — the difference between the
    // two tracks, which is the whole of what Match Loudness set, is untouched.
    expect(take.volumeDb - inst.volumeDb).toBe(0);
    expect(inst.volumeDb).toBeLessThan(0);
    // The take clip's mono pan compensation is a routing correction, not a
    // level choice, and the trim does not touch it either.
    expect(take.clips[0].gainDb).toBeCloseTo(MONO_PAN_COMPENSATION_DB, 6);
    expect(report!.placement!.takeGainDb).toBeCloseTo(MONO_PAN_COMPENSATION_DB, 6);
  });

  it('states the trim in the row, with the number', async () => {
    overCeilingFixture();
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    const s = report!.smoothing!;
    const stage = report!.stages.find((st) => st.id === 'smooth')!;
    const row = stage.derived.find((d) => d.label === 'Level trim')!;
    expect(row).toBeDefined();
    expect(row.value).toContain(s.trimDb.toFixed(2));
    expect(row.value).toMatch(/both tracks/i);
    // The row cites the measured post-trim peak, not an arithmetic promise.
    expect(row.from).toContain(s.trimmedPeakDb!.toFixed(2));
    expect(row.from).toContain(JOURNEY_TRIM_UNDO_LABEL);
    // The peak the sum reached is still reported, unchanged, beside it.
    expect(stage.derived.find((d) => d.label === 'Summed peak')!.value).toContain(
      s.summedPeakDb.toFixed(2)
    );
  });

  it('leaves the trim as ONE undoable session entry, and undoing it restores the clipping level', async () => {
    overCeilingFixture();
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    // Exactly one entry: stage 5 cleared the session stack, and the two fader
    // writes are one act, not two.
    expect(getHistory(SESSION_UNDO_KEY)).toEqual({
      done: [JOURNEY_TRIM_UNDO_LABEL],
      undone: [],
    });
    expect(canUndoSession()).toBe(true);

    undoSession();
    const tracks = useSessionStore.getState().session.tracks;
    for (const t of tracks) expect(t.volumeDb).toBe(0);
    // …and the undo restores the FADERS only. The edge fades stage 6 wrote
    // before the trim are not on the entry, so they survive it.
    const clip = tracks[1].clips[0];
    expect(clip.fadeInSample).toBe(report!.smoothing!.fadeInSample);
    expect(clip.fadeOutSample).toBe(report!.smoothing!.fadeOutSample);

    // The trim is a SESSION entry; the pass still claims only the two document
    // entries its chains left, because the dialog's list is about the take.
    expect(report!.undoEntries).toEqual([VOCAL_CHAIN_UNDO_LABEL, COVER_CHAIN_UNDO_LABEL]);
    expect(report!.stages.find((s) => s.id === 'smooth')!.undoEntries).toEqual([]);
  });

  // T3 (V4 MIN-5) — the invariant the trim's arithmetic rests on, stated.
  //
  // The clamp is applied ONCE, to the shared delta, against an implicit start of
  // 0: `clampAutomationValue('volumeDb', -wanted)` and then `t.volumeDb +
  // faderDb` per track. That is correct only while every fader IS 0 and no track
  // carries a volume automation lane — `setTrackParam` stores its patch verbatim
  // with no clamp of its own, so a nonzero start writes a level past the floor
  // the mixer can show, and a volume lane overrides the static fader outright
  // (F0's override-not-offset ruling), which would make the trim inert while the
  // stage's warning went on blaming the fader floor.
  //
  // It held by construction and by nothing else. Stated here, checked in the
  // trim path, and proved to hold on the session the journey actually builds.
  describe('the trim states the invariant its arithmetic rests on', () => {
    const clean = (): Track[] => [
      { ...createTrack('a'), volumeDb: 0 },
      { ...createTrack('b'), volumeDb: 0 },
    ];

    it('passes the session stage 5 builds', () => {
      expect(trimBlockedBy(clean())).toBeNull();
    });

    it('names a fader that did not start at 0, because the shared clamp assumed it did', () => {
      const tracks = clean();
      tracks[1] = { ...tracks[1], volumeDb: -55 };
      const blocked = trimBlockedBy(tracks);
      expect(blocked).not.toBeNull();
      expect(blocked).toMatch(/fader/i);
      // The reason has to carry WHICH track, or it sends the reader to look at
      // both of them.
      expect(blocked).toContain(tracks[1].id);
    });

    it('names a volume lane, which would override the trim rather than take it', () => {
      const tracks = clean();
      tracks[0] = {
        ...tracks[0],
        automation: [{ param: 'volumeDb', keys: [{ positionSample: 0, value: -3, curve: 'equal-gain' }] }],
      };
      const blocked = trimBlockedBy(tracks);
      expect(blocked).not.toBeNull();
      expect(blocked).toMatch(/automation|lane/i);
      expect(blocked).toContain(tracks[0].id);
    });

    it('ignores a lane with no keys and a lane on another parameter', () => {
      // An empty lane is indistinguishable from no lane by the module's own
      // rule, and a pan lane does not touch the quantity being trimmed —
      // refusing on either would be this check inventing a problem.
      const tracks = clean();
      tracks[0] = {
        ...tracks[0],
        automation: [
          { param: 'volumeDb', keys: [] },
          { param: 'pan', keys: [{ positionSample: 0, value: 0.5, curve: 'equal-gain' }] },
        ],
      };
      expect(trimBlockedBy(tracks)).toBeNull();
    });

    it('holds on the session the journey really builds, at the moment the trim would read it', async () => {
      // The run that does NOT trim: the faders are therefore still exactly as
      // stage 5 left them, which is the state stage 6's arithmetic assumes. A
      // build that started to set a fader, or to lay a volume lane, fails here.
      const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
      expect(report!.smoothing!.overCeiling).toBe(false);
      expect(trimBlockedBy(useSessionStore.getState().session.tracks)).toBeNull();
    });
  });

  it('does not spend a second summation, a fader write or a history entry when the sum fits', async () => {
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    const s = report!.smoothing!;
    expect(s.overCeiling).toBe(false);
    expect(s.trimDb).toBe(0);
    // Null, not "the same number again": the second summation only runs when
    // there is a trim to verify.
    expect(s.trimmedPeakDb).toBeNull();
    for (const t of useSessionStore.getState().session.tracks) expect(t.volumeDb).toBe(0);
    expect(canUndoSession()).toBe(false);
    expect(
      report!.stages.find((st) => st.id === 'smooth')!.derived.map((d) => d.label)
    ).not.toContain('Level trim');
  });

  it('never runs the journey\'s progress backwards to pay for the second summation', async () => {
    // V4: the trim arm sums the session TWICE, and the stage's fraction feeds
    // the journey's single overall bar. Two 0→1 sweeps inside one stage would
    // walk that bar backwards in front of the user — the one visible cost the
    // second measurement could have had.
    // Long enough that a summation spans SEVERAL peak blocks — a session that
    // fits in one block reports one fraction per pass and could not show the
    // bar moving at all, let alone moving backwards.
    seed(true, SR, SR * 20);
    expect(SR * 20).toBeGreaterThan(PEAK_BLOCK_SAMPLES);
    overCeilingFixture();
    const progress: number[] = [];
    const report = await runCoverJourney({
      songDocId: songId,
      takeDocId: takeId,
      onProgress: (f) => progress.push(f),
    });
    expect(report!.smoothing!.trimDb).toBeGreaterThan(0); // the arm really ran
    expect(progress.length).toBeGreaterThan(2);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
    }
    expect(progress[progress.length - 1]).toBeCloseTo(1, 5);
  });

  it('stops at the fader floor rather than writing a level the mixer cannot show, and says so', async () => {
    // An overshoot deeper than the fader's own −60 dB floor. Nothing musical
    // produces this; the point is that the clamp is REPORTED rather than
    // quietly turning the trim into a promise the session does not keep.
    useAppStore.setState({
      documents: useAppStore.getState().documents.map((d) =>
        d.name === 'song — Drums' || d.id === takeId
          ? { ...d, channels: [tone(docLength(d), 300, d.sampleRate, 5000)] }
          : d
      ),
    });
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    const s = report!.smoothing!;
    expect(s.summedPeakDb).toBeGreaterThan(60);
    expect(s.trimDb).toBe(60); // the floor, not summedPeakDb − target
    for (const t of useSessionStore.getState().session.tracks) expect(t.volumeDb).toBe(-60);
    // Still over full scale after the deepest trim the faders allow — so the
    // copy goes back to naming what the user has to do.
    expect(s.trimmedPeakDb!).toBeGreaterThan(0);
    const warning = report!.stages.find((st) => st.id === 'smooth')!.warning!;
    expect(warning).toContain('-60.00 dB');
    expect(warning).toContain(s.trimmedPeakDb!.toFixed(2));
    expect(warning).toMatch(/still/i);
  });

  // CC4 (CJ-6): the stage needs ONE number and was allocating two session-length
  // Float32Arrays to read it — ~346 MB for the 15-minute session the separation
  // cap admits, on the renderer thread, at the run's peak-memory moment.
  it('reads the summed peak without allocating the render it throws away', async () => {
    // Long enough that the session exceeds one peak block, or the block-sized
    // buffer and the session-length one are the same size and this passes
    // against the old code.
    seed(true, SR, SR * 20);
    expect(SR * 20).toBeGreaterThan(PEAK_BLOCK_SAMPLES);

    const Real = globalThis.Float32Array;
    let counting = false;
    let largest = 0;
    class Counting extends Real {
      constructor(arg?: unknown) {
        super(arg as number);
        if (counting && typeof arg === 'number' && arg > largest) largest = arg;
      }
    }
    (globalThis as { Float32Array: unknown }).Float32Array = Counting;
    let report: Awaited<ReturnType<typeof runCoverJourney>>;
    try {
      report = await runCoverJourney({
        songDocId: songId,
        takeDocId: takeId,
        // Stage 6 is last, so this scopes the count to it and to nothing else —
        // stage 1's instrumental sum is a song-length allocation and is not
        // what this measures.
        onStageStart: (s) => {
          counting = s.id === 'smooth';
        },
      });
    } finally {
      (globalThis as { Float32Array: unknown }).Float32Array = Real;
    }

    expect(report!.completed).toBe(true);
    expect(largest).toBeGreaterThan(0); // it really did sum something
    expect(largest).toBeLessThanOrEqual(PEAK_BLOCK_SAMPLES);
    // …and the number it reports is still the pre-clamp peak, unchanged.
    expect(Number.isFinite(report!.smoothing!.summedPeakDb)).toBe(true);
  });

  it('says nothing about the level when there is nothing to say', async () => {
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(report!.smoothing!.overCeiling).toBe(false);
    expect(report!.stages.find((s) => s.id === 'smooth')!.warning).toBeUndefined();
  });
});

// ── Undo ────────────────────────────────────────────────────────────────────

describe('runCoverJourney — undo', () => {
  it('lists the per-pass undo entries the chains left, and claims no more', async () => {
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(report!.undoEntries).toEqual(['Vocal Chain', 'Cover Chain']);
    expect(report!.stages.find((s) => s.id === 'clean')!.undoEntries).toEqual(['Vocal Chain']);
    expect(report!.stages.find((s) => s.id === 'match')!.undoEntries).toEqual(['Cover Chain']);
    // Creating documents and replacing the session are not edits to a document,
    // so those stages claim nothing.
    expect(report!.stages.find((s) => s.id === 'separate')!.undoEntries).toEqual([]);
    expect(report!.stages.find((s) => s.id === 'place')!.undoEntries).toEqual([]);
  });

  it('claims no undo entry for a chain that did not change anything', async () => {
    runVocalChain.mockResolvedValue({ applied: false, stages: [], elapsedMs: 1 });
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(report!.undoEntries).toEqual(['Cover Chain']);
    expect(report!.stages.find((s) => s.id === 'clean')!.status).toBe('declined');
    expect(report!.completed).toBe(true);
  });
});

// ── Failure ─────────────────────────────────────────────────────────────────

describe('runCoverJourney — failure', () => {
  it('stops and says which stage failed when a chain refuses to run', async () => {
    runCoverChain.mockResolvedValue(null);
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(report!.completed).toBe(false);
    const stage = report!.stages.find((s) => s.id === 'match')!;
    expect(stage.status).toBe('failed');
    expect(stage.reason).toMatch(/nothing was placed/);
    expect(report!.placement).toBeNull();
  });

  it('turns a mid-journey THROW into a report rather than a rejected promise', async () => {
    // CP1 fix-round (I2). Before this the exception escaped `runCoverJourney`
    // entirely — the dialog has a `finally` but no `catch`, so the promise
    // rejected, no report was set, and the rows from the part of the run that
    // DID happen stayed on screen looking like an outcome.
    runVocalChain.mockRejectedValue(new Error('the worker died'));
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });

    expect(report).not.toBeNull();
    expect(report!.completed).toBe(false);
    const clean = report!.stages.find((s) => s.id === 'clean')!;
    expect(clean.status).toBe('failed');
    expect(clean.reason).toContain('the worker died');
    expect(report!.stages[0].status).toBe('reused');
    for (const later of ['align', 'match', 'place', 'smooth']) {
      expect(report!.stages.find((s) => s.id === later)!.status).toBe('pending');
    }
    // Exactly one row per stage — no stale remnant, no duplicate.
    expect(report!.stages.map((s) => s.id)).toEqual(COVER_JOURNEY_STAGES.map((s) => s.id));
    expect(report!.placement).toBeNull();
  });

  it('names the throwing stage even when it is the first one', async () => {
    seed(false);
    separateStems.mockRejectedValue(new Error('model file is corrupt'));
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(report!.completed).toBe(false);
    expect(report!.stages[0].status).toBe('failed');
    expect(report!.stages[0].reason).toContain('model file is corrupt');
    expect(runVocalChain).not.toHaveBeenCalled();
  });

  it('stops when the separation model fails, naming its own message', async () => {
    seed(false);
    separateStems.mockResolvedValue({ ok: false, status: 'model-missing', message: 'no model' });
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(report!.stages[0].status).toBe('failed');
    expect(report!.stages[0].reason).toBe('no model');
    expect(runVocalChain).not.toHaveBeenCalled();
  });
});

// ── The pieces, on their own ────────────────────────────────────────────────

describe('findExistingSeparation', () => {
  it('finds a complete set of five', () => {
    const state = useAppStore.getState();
    const song = state.documents.find((d) => d.id === songId)!;
    const found = findExistingSeparation(state.documents, song);
    expect(found).not.toBeNull();
    expect(found!.map((d) => d.name)).toEqual(STEM_TRACK_LABELS.map((l) => `song — ${l}`));
  });

  it('refuses an incomplete set rather than reusing part of one', () => {
    const state = useAppStore.getState();
    const song = state.documents.find((d) => d.id === songId)!;
    const without = state.documents.filter((d) => d.name !== 'song — Residual');
    expect(findExistingSeparation(without, song)).toBeNull();
  });

  it('refuses a stem whose rate or length no longer matches the song', () => {
    const state = useAppStore.getState();
    const song = state.documents.find((d) => d.id === songId)!;
    const shortened = state.documents.map((d) =>
      d.name === 'song — Bass' ? { ...d, channels: [tone(10, 200, SR)] } : d
    );
    expect(findExistingSeparation(shortened, song)).toBeNull();
    const rerated = state.documents.map((d) =>
      d.name === 'song — Bass' ? { ...d, sampleRate: SR * 2 } : d
    );
    expect(findExistingSeparation(rerated, song)).toBeNull();
  });
});

describe('sumInstrumental', () => {
  it('sums the four non-vocal stems and leaves the vocal out', () => {
    const docs = STEM_TRACK_LABELS.map((label) =>
      createDocument({
        name: label,
        sampleRate: SR,
        // Vocals is the loud one: if it leaked in, the sum would show it.
        channels: [new Float32Array(4).fill(label === 'Vocals' ? 1 : 0.25)],
      })
    );
    const summed = sumInstrumental(docs);
    expect(summed).toHaveLength(1);
    expect(Array.from(summed[0])).toEqual([1, 1, 1, 1]);
  });
});

describe('the stage table', () => {
  it('names every stage of the journey the user was promised', () => {
    expect(COVER_JOURNEY_STAGES.map((s) => s.id)).toEqual([
      'separate',
      'clean',
      'align',
      'match',
      'place',
      'smooth',
    ]);
  });

  it('gives every stage a note and a positive weight', () => {
    for (const stage of COVER_JOURNEY_STAGES) {
      expect(stage.note.length).toBeGreaterThan(40);
      expect(stage.weight).toBeGreaterThan(0);
      expect(journeyStageById(stage.id)).toBe(stage);
    }
  });

  it('throws on an id that is not a stage', () => {
    expect(() => journeyStageById('nope' as CoverJourneyStageId)).toThrow();
  });

  it('names the session after the song', () => {
    expect(coverSessionName('My Song')).toBe('My Song — Cover');
  });
});

// ── Lot A (M4): the built cover session is a new, unsaved project ───────────

describe('lot A (M4): the cover session replaces the project', () => {
  it('clears projectPath, and the load itself leaves the session history clean', async () => {
    useSessionStore.getState().setProjectPath('D:\\p.audm');
    // A recorded session edit BEFORE the journey. The landing must DROP the
    // stack (`clearSessionHistory`), not merely mark it: if this entry
    // survived, undoing the trim below would not reach a clean session.
    useSessionStore.getState().renameSession('edited before the journey');
    expect(isSessionDirty()).toBe(true);

    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });

    expect(report!.completed).toBe(true);
    expect(useSessionStore.getState().projectPath).toBeNull();
    // Stage 5 clears the session stack; the only thing that can push onto it
    // afterwards is the level trim (one entry, `JOURNEY_TRIM_UNDO_LABEL`).
    // Nothing from before the landing survives, and undoing that trim (when
    // it happened) lands exactly on the clean, just-landed session — the
    // brief's `isSessionDirty() === false`, asserted on the landing itself
    // rather than on the journey's last stage.
    const done = getHistory(SESSION_UNDO_KEY).done;
    expect(done.length).toBeLessThanOrEqual(1);
    expect(done.every((label) => label === JOURNEY_TRIM_UNDO_LABEL)).toBe(true);
    if (canUndoSession()) undoSession();
    expect(canUndoSession()).toBe(false);
    expect(isSessionDirty()).toBe(false);
  });
});
