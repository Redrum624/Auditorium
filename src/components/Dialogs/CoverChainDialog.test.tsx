import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import CoverChainDialog from './CoverChainDialog';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import {
  COVER_CHAIN_CONFIRM_SENTENCE,
  COVER_CHAIN_GOOD_TAKE_SENTENCE,
  COVER_CHAIN_RESIDUAL_SENTENCE,
  COVER_CHAIN_SHAPING_SENTENCE,
  COVER_CHAIN_SPREAD_SENTENCE,
} from '../../services/coverChain';
import {
  COVER_JOURNEY_STAGES,
  runCoverJourney,
  type CoverJourneyReport,
  type CoverJourneyStageId,
  type CoverJourneyStageResult,
  type RunCoverJourneyOptions,
} from '../../services/coverJourney';

// The STAGE TABLE stays real (requireActual): the dialog's whole contract is
// that it lists what the engine will actually run, in the engine's order, with
// the engine's own notes — a mocked stage list would let the two drift and the
// tests would still pass. Only the run itself is mocked.
jest.mock('../../services/coverJourney', () => ({
  ...jest.requireActual('../../services/coverJourney'),
  runCoverJourney: jest.fn(),
}));

const mockRun = runCoverJourney as jest.MockedFunction<typeof runCoverJourney>;

const SR = 48000;

function seedDoc(name: string, samples = SR * 4): AudioDocument {
  const doc = createDocument({ name, sampleRate: SR, channels: [new Float32Array(samples)] });
  useAppStore.getState().addDocument(doc);
  return doc;
}

/** Every stage as `pending`, with `overrides` substituted in by id — so a
 * fixture can describe one stage's outcome without hand-writing the other five. */
function stagesWith(...overrides: CoverJourneyStageResult[]): CoverJourneyStageResult[] {
  const byId = new Map(overrides.map((r) => [r.id, r]));
  return COVER_JOURNEY_STAGES.map(
    (s) =>
      byId.get(s.id) ?? {
        id: s.id,
        label: s.label,
        status: 'done' as const,
        derived: [],
        undoEntries: [],
      }
  );
}

function report(over: Partial<CoverJourneyReport> = {}): CoverJourneyReport {
  return {
    songName: 'song.wav',
    takeName: 'take.wav',
    stages: stagesWith(),
    separation: null,
    alignment: null,
    alignmentRefused: false,
    placement: {
      sessionName: 'song.wav — Cover',
      sessionRate: SR,
      instrumentalStartSample: 0,
      takeStartSample: 4800,
      shiftedSamples: 0,
      takeLengthSample: SR * 4,
    },
    smoothing: null,
    cancelledAt: null,
    undoEntries: ['Vocal Chain', 'Cover Chain'],
    elapsedMs: 12345,
    completed: true,
    ...over,
  };
}

let song: AudioDocument;
let take: AudioDocument;

beforeEach(() => {
  jest.clearAllMocks();
  useAppStore.setState(makeInitialState());
  song = seedDoc('song.wav');
  take = seedDoc('take.wav');
  // `addDocument` activates what it added last, so the take is active — which
  // is what the dialog defaults its take picker to.
  mockRun.mockResolvedValue(report());
});

function open(): void {
  render(<CoverChainDialog onClose={() => {}} />);
}

function choose(songName: string | null = 'song.wav'): void {
  if (songName) {
    fireEvent.change(screen.getByTestId('cover-journey-song'), { target: { value: song.id } });
  }
}

// ── The honesty block ───────────────────────────────────────────────────────

describe('CoverChainDialog — what it says before it runs', () => {
  it('states every limitation ABOVE the button, not in a footnote', () => {
    open();
    expect(screen.getByTestId('cover-chain-limitation')).toHaveTextContent(
      COVER_CHAIN_RESIDUAL_SENTENCE
    );
    expect(screen.getByTestId('cover-chain-shaping')).toHaveTextContent(COVER_CHAIN_SHAPING_SENTENCE);
    expect(screen.getByTestId('cover-chain-good-take')).toHaveTextContent(
      COVER_CHAIN_GOOD_TAKE_SENTENCE
    );
  });

  it('says the alignment is a placement rather than a warp, and names the manual tools', () => {
    open();
    const note = screen.getByTestId('cover-journey-placement-note');
    expect(note).toHaveTextContent('PLACEMENT, not a warp');
    expect(note).toHaveTextContent(COVER_CHAIN_CONFIRM_SENTENCE);
    expect(note).toHaveTextContent('Align Lyrics');
  });

  it('says what a cancelled run leaves behind BEFORE the run, not after', () => {
    open();
    expect(screen.getByTestId('cover-journey-cancel-note')).toHaveTextContent(
      /session is\s+built only at stage 5|session is built only at stage 5/
    );
    expect(screen.getByTestId('cover-journey-cancel-note')).toHaveTextContent('no session');
  });
});

// ── Inputs ──────────────────────────────────────────────────────────────────

describe('CoverChainDialog — the two inputs', () => {
  it('defaults the take to the active document and asks for the song', () => {
    open();
    expect(screen.getByTestId('cover-journey-take')).toHaveValue(take.id);
    expect(screen.getByTestId('cover-journey-song')).toHaveValue('');
    expect(screen.getByTestId('cover-journey-not-ready')).toBeInTheDocument();
    expect(screen.getByTestId('cover-chain-apply')).toBeDisabled();
  });

  it('enables the run once two different documents are chosen', () => {
    open();
    choose();
    expect(screen.queryByTestId('cover-journey-not-ready')).not.toBeInTheDocument();
    expect(screen.getByTestId('cover-chain-apply')).not.toBeDisabled();
  });

  it('never offers the same document as both song and take', () => {
    open();
    choose();
    const takeOptions = Array.from(
      screen.getByTestId('cover-journey-take').querySelectorAll('option')
    ).map((o) => (o as HTMLOptionElement).value);
    expect(takeOptions).not.toContain(song.id);
  });

  it('says the whole take runs, not a selection', () => {
    open();
    choose();
    expect(screen.getByTestId('cover-journey-scope')).toHaveTextContent('The whole take runs, not a selection');
  });
});

// ── The stage table ─────────────────────────────────────────────────────────

describe('CoverChainDialog — the journey it lists', () => {
  it('lists the engine\'s six stages, in the engine\'s order, with the engine\'s notes', () => {
    open();
    for (const stage of COVER_JOURNEY_STAGES) {
      expect(screen.getByTestId(`cover-journey-stage-${stage.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`cover-journey-note-${stage.id}`)).toHaveTextContent(stage.note);
    }
  });
});

// ── Running ─────────────────────────────────────────────────────────────────

describe('CoverChainDialog — while it runs', () => {
  it('passes the two chosen documents to the engine', async () => {
    open();
    choose();
    fireEvent.click(screen.getByTestId('cover-chain-apply'));
    await waitFor(() => expect(mockRun).toHaveBeenCalled());
    const opts = mockRun.mock.calls[0][0];
    expect(opts.songDocId).toBe(song.id);
    expect(opts.takeDocId).toBe(take.id);
  });

  it('shows the running stage, its own bar, and the NESTED chain\'s own row', async () => {
    // The run is held OPEN deliberately: everything asserted here only exists
    // while `busy` is true, and a mock that resolves on its own timer races the
    // assertions into an empty dialog.
    let emit: RunCoverJourneyOptions['onStageProgress'];
    let settle: (r: CoverJourneyReport) => void = () => {};
    mockRun.mockImplementation(
      (opts) =>
        new Promise((resolve) => {
          emit = opts.onStageProgress;
          settle = resolve;
        })
    );
    open();
    choose();
    fireEvent.click(screen.getByTestId('cover-chain-apply'));
    await waitFor(() => expect(emit).toBeDefined());

    act(() => {
      emit!({
        stageId: 'clean',
        label: 'Clean the Take (Vocal Chain)',
        phase: 'rendering',
        stageFraction: 0.4,
        detail: 'Vocal Chain — De-Hum',
        sub: {
          stageId: 'hum',
          label: 'De-Hum',
          phase: 'measuring',
          stageFraction: 0.25,
          detail: 'measuring the audio that reaches this stage',
        },
      });
    });

    expect(screen.getByTestId('cover-journey-status-clean')).toHaveTextContent('Running · 40%');
    expect(screen.getByTestId('cover-journey-activity-clean')).toHaveTextContent('Vocal Chain — De-Hum');
    // The nested row keeps the sub-chain's own words rather than collapsing ten
    // stages behind one bar.
    const sub = screen.getByTestId('cover-journey-sub-clean');
    expect(sub).toHaveTextContent('De-Hum');
    expect(sub).toHaveTextContent('measuring the audio that reaches this stage');
    expect(sub).toHaveTextContent('25%');

    await act(async () => {
      settle(report());
    });
  });

  it('offers Cancel while running, and tells the engine when it is pressed', async () => {
    let opts: RunCoverJourneyOptions | null = null;
    let settle: (r: CoverJourneyReport) => void = () => {};
    mockRun.mockImplementation(
      (o) =>
        new Promise((resolve) => {
          opts = o;
          settle = resolve;
        })
    );
    open();
    choose();
    fireEvent.click(screen.getByTestId('cover-chain-apply'));
    await waitFor(() => expect(opts).not.toBeNull());

    // The engine POLLS this rather than being interrupted — the flag is what
    // the button sets, and the run settles on its own terms afterwards.
    expect(opts!.shouldCancel!()).toBe(false);
    fireEvent.click(screen.getByTestId('cover-journey-stop'));
    expect(opts!.shouldCancel!()).toBe(true);
    expect(screen.getByTestId('cover-journey-running')).toHaveTextContent('Stopping after this stage');
    expect(screen.getByTestId('cover-journey-stop')).toBeDisabled();

    await act(async () => {
      settle(report({ completed: false, cancelledAt: 'align' }));
    });
    expect(screen.getByTestId('cover-journey-outcome')).toHaveTextContent('Cancelled at');
  });
});

// ── Results ─────────────────────────────────────────────────────────────────

describe('CoverChainDialog — what it says afterwards', () => {
  async function run(over: Partial<CoverJourneyReport> = {}): Promise<void> {
    mockRun.mockResolvedValue(report(over));
    open();
    choose();
    fireEvent.click(screen.getByTestId('cover-chain-apply'));
    await waitFor(() => expect(screen.getByTestId('cover-journey-outcome')).toBeInTheDocument());
  }

  it('names the session it built and how long the pass took', async () => {
    await run();
    const outcome = screen.getByTestId('cover-journey-outcome');
    expect(outcome).toHaveTextContent('song.wav — Cover');
    expect(outcome).toHaveTextContent('12.3 s');
  });

  it('lists the undo entries and says why there is no single one', async () => {
    await run();
    const undo = screen.getByTestId('cover-journey-undo');
    expect(undo).toHaveTextContent('“Vocal Chain”, “Cover Chain”');
    expect(undo).toHaveTextContent('no single entry that undoes the whole journey');
  });

  it('says so when nothing changed the take', async () => {
    await run({ undoEntries: [] });
    expect(screen.getByTestId('cover-journey-undo')).toHaveTextContent('nothing to undo');
  });

  it('shows a declined stage\'s reason in amber, with its numbers', async () => {
    await run({
      alignmentRefused: true,
      stages: stagesWith({
        id: 'align',
        label: 'Align with the Original',
        status: 'declined',
        reason: 'correlation 0.310 against a floor of 0.607',
        derived: [],
        undoEntries: [],
      }),
    });
    const reason = screen.getByTestId('cover-journey-reason-align');
    expect(reason).toHaveTextContent('Did not run — correlation 0.310 against a floor of 0.607');
    expect(reason).toHaveStyle({ color: '#e0a458' });
  });

  it('shows a stage warning even when the stage ran', async () => {
    await run({
      stages: stagesWith({
        id: 'smooth',
        label: 'Smooth and Check the Level',
        status: 'done',
        warning: 'the two tracks sum to +1.20 dBFS, above full scale',
        derived: [],
        undoEntries: [],
      }),
    });
    expect(screen.getByTestId('cover-journey-warning-smooth')).toHaveTextContent('above full scale');
  });

  it('renders a stage\'s derived values with what they were derived from', async () => {
    await run({
      stages: stagesWith({
        id: 'align',
        label: 'Align with the Original',
        status: 'done',
        derived: [{ label: 'Offset', value: '+1.250 s', from: 'the best lag of the two onset envelopes' }],
        undoEntries: [],
      }),
    });
    const derived = screen.getByTestId('cover-journey-derived-align');
    expect(derived).toHaveTextContent('Offset: +1.250 s');
    expect(derived).toHaveTextContent('from the best lag of the two onset envelopes');
  });

  it('nests the vocal chain\'s own stages under its row rather than hiding them', async () => {
    await run({
      stages: stagesWith({
        id: 'clean',
        label: 'Clean the Take (Vocal Chain)',
        status: 'done',
        derived: [],
        undoEntries: ['Vocal Chain'],
        vocalChain: {
          stages: [
            { id: 'hum', label: 'De-Hum', status: 'declined', reason: 'no mains hum found', derived: [] },
            { id: 'limiter', label: 'Limiter', status: 'applied', derived: [], detail: 'caught 0.42 dB of peak' },
          ],
        },
      } as unknown as CoverJourneyStageResult),
    });
    const nested = screen.getByTestId('cover-journey-nested-clean');
    expect(nested).toHaveTextContent('De-Hum');
    expect(nested).toHaveTextContent('no mains hum found');
    expect(nested).toHaveTextContent('Limiter');
    expect(nested).toHaveTextContent('caught 0.42 dB of peak');
  });

  it('names the stage the run was cancelled at', async () => {
    await run({
      completed: false,
      cancelledAt: 'match' as CoverJourneyStageId,
      placement: null,
    });
    expect(screen.getByTestId('cover-journey-outcome')).toHaveTextContent(
      'Cancelled at “Match to the Original Vocal”'
    );
  });

  it('keeps the spread ruling on screen after the run', async () => {
    await run();
    expect(screen.getByTestId('cover-chain-spread-note')).toHaveTextContent(COVER_CHAIN_SPREAD_SENTENCE);
  });

  it('reports a pass that could not start rather than pretending it ran', async () => {
    mockRun.mockResolvedValue(null);
    open();
    choose();
    fireEvent.click(screen.getByTestId('cover-chain-apply'));
    await waitFor(() => expect(screen.getByTestId('cover-journey-error')).toBeInTheDocument());
    expect(screen.getByTestId('cover-journey-error')).toHaveTextContent('could not start');
  });
});
