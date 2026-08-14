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
import { createClip, createTrack, type Session } from '../multitrack/session';
import { parseSessionFileBytes, serializeSessionV3 } from '../multitrack/sessionFile';
import { PEAK_BLOCK_SAMPLES, mixdownSession } from '../multitrack/mixdown';
import { defaultSessionZoom } from '../multitrack/sessionZoom';
import * as coverAlign from '../dsp/coverAlign';
import * as stemService from './stemService';
import * as vocalChain from './vocalChain';
import * as coverChain from './coverChain';
import * as coverPlacement from './coverPlacement';
import {
  COVER_JOURNEY_STAGES,
  JOURNEY_FADE_MS,
  coverSessionName,
  findExistingSeparation,
  journeyStageById,
  priorJourneyPasses,
  runCoverJourney,
  sumInstrumental,
  type CoverJourneyStageId,
  type CoverJourneyStageProgress,
  type CoverJourneyStageResult,
} from './coverJourney';
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

    // Save Session: the real writer, over the session the journey just built.
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

    // Open Session: the real parser, applied the way `openSessionViaDialog` does.
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
    alignTakeToReference.mockReturnValue({
      ...confidentAlignment(3.5),
      peakCorrelation: 0.31,
      prominence: 0.02,
      // CC2's contract: a 0.31 peak is below every floor and every unrelated
      // band, and `confident` must equal `outcome === 'confident'`.
      outcome: 'unrelated',
      confident: false,
    });
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

  const alignReason = async (measurement: unknown): Promise<string> => {
    alignTakeToReference.mockReturnValue(measurement);
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    return report!.stages.find((s) => s.id === 'align')!.reason!;
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
    expect(await alignReason(refusedAlignment(-8.258, { outcome: 'unrelated' }))).toContain(
      'probably wrong'
    );
    expect(await alignReason(refusedAlignment(-8.258, { outcome: 'weak' }))).toContain(
      'weak but plausible'
    );
    expect(await alignReason(refusedAlignment(-8.258, { outcome: 'ambiguous' }))).toContain(
      'several places'
    );
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
    alignTakeToReference.mockReturnValue({
      ...confidentAlignment(-8.258),
      peakCorrelation: 0.423,
      prominence: 0.079,
      // CC2's contract: `confident` must equal `outcome === 'confident'`.
      outcome: 'unrelated',
      confident: false,
    });
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
    useAppStore.setState({
      documents: useAppStore.getState().documents.map((d) =>
        d.name === 'song — Drums' || d.id === takeId
          ? { ...d, channels: [tone(docLength(d), 300, d.sampleRate, 1)] }
          : d
      ),
    });
    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });
    expect(report!.smoothing!.overCeiling).toBe(true);
    expect(report!.smoothing!.summedPeakDb).toBeGreaterThan(0);
    const stage = report!.stages.find((s) => s.id === 'smooth')!;
    expect(stage.warning).toContain('above full scale');
    // Nothing was normalised on the user's behalf — the fix is named, not done.
    expect(stage.warning).toMatch(/fader/);
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
