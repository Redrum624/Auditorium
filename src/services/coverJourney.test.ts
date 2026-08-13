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
import { defaultSessionZoom } from '../multitrack/sessionZoom';
import * as coverAlign from '../dsp/coverAlign';
import * as stemService from './stemService';
import * as stemLanding from './stemLanding';
import * as vocalChain from './vocalChain';
import * as coverChain from './coverChain';
import {
  COVER_JOURNEY_STAGES,
  JOURNEY_FADE_MS,
  coverSessionName,
  findExistingSeparation,
  journeyStageById,
  runCoverJourney,
  sumInstrumental,
  type CoverJourneyStageId,
  type CoverJourneyStageProgress,
  type CoverJourneyStageResult,
} from './coverJourney';
import { STEM_TRACK_LABELS } from './stemLanding';

jest.mock('./stemService', () => ({
  ...jest.requireActual('./stemService'),
  separateStems: jest.fn(),
  cancelStemSeparation: jest.fn(async () => true),
}));
jest.mock('./stemLanding', () => ({
  ...jest.requireActual('./stemLanding'),
  landStems: jest.fn(),
}));
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

const separateStems = stemService.separateStems as jest.Mock;
const cancelStemSeparation = stemService.cancelStemSeparation as jest.Mock;
const landStems = stemLanding.landStems as jest.Mock;
const runVocalChain = vocalChain.runVocalChain as jest.Mock;
const runCoverChain = coverChain.runCoverChain as jest.Mock;
const alignTakeToReference = coverAlign.alignTakeToReference as jest.Mock;

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

const okVocalReport = (): vocalChain.VocalChainReport =>
  ({ applied: true, stages: [], elapsedMs: 1 }) as unknown as vocalChain.VocalChainReport;
const okCoverReport = (): coverChain.CoverChainReport =>
  ({ applied: true, stages: [], elapsedMs: 1 }) as unknown as coverChain.CoverChainReport;

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
    expect(landStems).not.toHaveBeenCalled();
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

  it('runs the separation when no existing one is open, and lands it', async () => {
    seed(false);
    separateStems.mockImplementation(async () => {
      // `landStems` is what creates the five documents; the stub does the same.
      const state = useAppStore.getState();
      const song = state.documents.find((d) => d.id === songId)!;
      const stems = STEM_TRACK_LABELS.map((label) =>
        createDocument({
          name: `${song.name} — ${label}`,
          sampleRate: SR,
          channels: [tone(SONG_SAMPLES, 440, SR, 0.1)],
        })
      );
      useAppStore.setState({ documents: [...state.documents, ...stems] });
      return { ok: true, output: { sourceDocId: songId, sourceName: 'song' } };
    });

    const report = await runCoverJourney({ songDocId: songId, takeDocId: takeId });

    expect(separateStems).toHaveBeenCalledTimes(1);
    expect(separateStems.mock.calls[0][0].sourceDocId).toBe(songId);
    expect(landStems).toHaveBeenCalledTimes(1);
    expect(report!.separation!.reused).toBe(false);
    expect(report!.stages[0].status).toBe('done');
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
    expect(report!.stages.find((s) => s.id === 'align')!.status).toBe('declined');
    expect(report!.placement!.takeStartSample).toBe(0);
    expect(report!.completed).toBe(true);
  });

  // ── CC3: what the refusal TELLS the user to do ────────────────────────────

  /** A refusal at `offsetSeconds`, with whatever extra outcome fields a
   * measurement of the day carries. */
  const refusedAlignment = (offsetSeconds: number, extra: Record<string, unknown> = {}) => ({
    ...confidentAlignment(offsetSeconds),
    peakCorrelation: 0.423,
    rivalCorrelation: 0.344,
    prominence: 0.079,
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

// ── CC3: the Place row stops calling the zero fallback a measurement ────────

describe('runCoverJourney — what the Place row says it placed at', () => {
  const takeAtRow = (report: Awaited<ReturnType<typeof runCoverJourney>>) =>
    report!.stages.find((s) => s.id === 'place')!.derived.find((d) => d.label === 'Take at')!;

  it('says the alignment was REFUSED rather than claiming a measured +0.000 s', async () => {
    alignTakeToReference.mockReturnValue({
      ...confidentAlignment(-8.258),
      peakCorrelation: 0.423,
      prominence: 0.079,
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
