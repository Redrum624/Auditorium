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
  journeyStageById,
  runCoverJourney,
  type CoverJourneyReport,
  type CoverJourneyStageId,
  type CoverJourneyStageResult,
  type RunCoverJourneyOptions,
} from '../../services/coverJourney';
import {
  APPLY_GUESS_LABEL,
  APPLY_GUESS_UNDO_LABEL,
  applyMeasuredOffset,
} from '../../services/coverPlacement';

// The STAGE TABLE stays real (requireActual): the dialog's whole contract is
// that it lists what the engine will actually run, in the engine's order, with
// the engine's own notes — a mocked stage list would let the two drift and the
// tests would still pass. Only the run itself is mocked.
jest.mock('../../services/coverJourney', () => ({
  ...jest.requireActual('../../services/coverJourney'),
  runCoverJourney: jest.fn(),
}));

// CC3: same ruling as the stage table above — the refusal COPY stays real
// (requireActual), because the dialog's contract is that the button it shows
// is the one the engine's own sentence tells the user to press. Only the store
// write is mocked; its arithmetic is proven in `coverPlacement.test.ts`.
jest.mock('../../services/coverPlacement', () => ({
  ...jest.requireActual('../../services/coverPlacement'),
  applyMeasuredOffset: jest.fn(),
}));

const mockRun = runCoverJourney as jest.MockedFunction<typeof runCoverJourney>;
const mockApply = applyMeasuredOffset as jest.MockedFunction<typeof applyMeasuredOffset>;

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
  mockApply.mockReturnValue({
    applied: true,
    sessionRate: SR,
    takeStartSample: 0,
    instrumentalStartSample: 0,
    shiftedSamples: 0,
    fadeInSample: 1200,
    fadeOutSample: 1200,
    cursorSample: 0,
  });
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

// ── CP1 fix-round: pins restored from the 825-line suite this file replaced ──
//
// The rewrite dropped 31 review-hardened assertions and wrote 21 new ones. The
// audit against `git show d414196:src/components/Dialogs/CoverChainDialog.test.tsx`
// found 10 properties already covered, 8 genuinely gone with the UI that carried
// them (per-stage toggles, the Reference picker, the EQ table, the before/after
// summary table), and 13 that still hold in the new dialog but had nothing
// asserting them. Those 13 are below, each naming the old pin it restores.

/** Every `data-testid` inside the dialog, in DOM order. The old suite's order
 * pins were built on exactly this, and "above the button" is a claim about
 * ORDER that a substring probe cannot make. */
function testIdOrder(): string[] {
  const root = screen.getByTestId('cover-chain-dialog');
  return [...root.querySelectorAll('[data-testid]')].map(
    (el) => el.getAttribute('data-testid') as string
  );
}

describe('CoverChainDialog — restored: four distinct caveats, each stated once', () => {
  /** The old suite's classifier: which caveat KIND a piece of text states. A
   * block that states two kinds, or none, is the defect this catches. */
  const KINDS: { kind: string; text: string }[] = [
    { kind: 'residual', text: COVER_CHAIN_RESIDUAL_SENTENCE },
    { kind: 'shaping', text: COVER_CHAIN_SHAPING_SENTENCE },
    { kind: 'goodTake', text: COVER_CHAIN_GOOD_TAKE_SENTENCE },
    { kind: 'confirm', text: COVER_CHAIN_CONFIRM_SENTENCE },
  ];
  const classify = (text: string): string[] =>
    KINDS.filter((k) => text.includes(k.text)).map((k) => k.kind);

  // OLD #9
  it('enumerates four kinds, each a distinct sentence', () => {
    expect(new Set(KINDS.map((k) => k.text)).size).toBe(4);
  });

  // OLD #10 — the EXCLUSIVE classifier, not a substring probe
  it('states each caveat exactly once in the block above the button', () => {
    open();
    const carriers: Record<string, string> = {
      'cover-chain-limitation': 'residual',
      'cover-chain-shaping': 'shaping',
      'cover-chain-good-take': 'goodTake',
      'cover-journey-placement-note': 'confirm',
    };
    const seen: string[] = [];
    for (const [testid, expected] of Object.entries(carriers)) {
      expect(classify(screen.getByTestId(testid).textContent ?? '')).toEqual([expected]);
      seen.push(expected);
    }
    expect(seen.slice().sort()).toEqual(KINDS.map((k) => k.kind).sort());
  });

  // OLD #11 — a stage note may repeat ONE caveat, never two, and which stages
  // carry which is pinned, so a note that starts or stops stating one shows up
  it('classifies every stage note that carries a caveat', () => {
    open();
    const carried: Record<string, string[]> = {};
    for (const stage of COVER_JOURNEY_STAGES) {
      const kinds = classify(screen.getByTestId(`cover-journey-note-${stage.id}`).textContent ?? '');
      expect(kinds.length).toBeLessThanOrEqual(1);
      if (kinds.length) carried[stage.id] = kinds;
    }
    expect(carried).toEqual({ separate: ['residual'] });
  });

  // OLD #12 — DOM ORDER. The existing test is NAMED "above the button"; this is
  // what actually checks it.
  it('puts every caveat above the run button, not below it', () => {
    open();
    const order = testIdOrder();
    const apply = order.indexOf('cover-chain-apply');
    expect(apply).toBeGreaterThan(0);
    for (const id of [
      'cover-chain-limitation',
      'cover-chain-shaping',
      'cover-chain-good-take',
      'cover-journey-placement-note',
    ]) {
      expect(order.indexOf(id)).toBeGreaterThanOrEqual(0);
      expect(apply).toBeGreaterThan(order.indexOf(id));
    }
  });
});

describe('CoverChainDialog — restored: order, scope and locking', () => {
  // OLD #2 — membership AND order; the existing stage-list test checks neither
  it("renders the stage cards in the engine's registry ORDER", () => {
    open();
    const rendered = testIdOrder()
      .filter((id) => /^cover-journey-stage-[a-z]+$/.test(id))
      .map((id) => id.replace('cover-journey-stage-', ''));
    expect(rendered).toEqual(COVER_JOURNEY_STAGES.map((s) => s.id));
  });

  // OLD #5 — the scope line's DURATIONS, both rendered and both unasserted
  it('says the duration of the take and of the song it will run against', () => {
    open();
    choose();
    const scope = screen.getByTestId('cover-journey-scope');
    expect(scope).toHaveTextContent('4.00 s');
    expect(scope).toHaveTextContent('against 4.00 s of song');
  });

  // OLD #25 — the pickers lock while the pass runs AND once it has landed
  it('locks both pickers while the pass runs and after it lands', async () => {
    let settle: (r: CoverJourneyReport) => void = () => {};
    mockRun.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    open();
    choose();
    expect(screen.getByTestId('cover-journey-song')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('cover-chain-apply'));
    await waitFor(() => expect(mockRun).toHaveBeenCalled());
    expect(screen.getByTestId('cover-journey-song')).toBeDisabled();
    expect(screen.getByTestId('cover-journey-take')).toBeDisabled();
    await act(async () => {
      settle(report());
    });
    expect(screen.getByTestId('cover-journey-song')).toBeDisabled();
    expect(screen.getByTestId('cover-journey-take')).toBeDisabled();
  });
});

describe('CoverChainDialog — restored: the live view', () => {
  /** Runs up to the point the engine has been called, and leaves it open. */
  async function startRun(): Promise<{
    opts: RunCoverJourneyOptions;
    settle: (r: CoverJourneyReport | null) => void;
  }> {
    let captured: RunCoverJourneyOptions | null = null;
    let settle: (r: CoverJourneyReport | null) => void = () => {};
    mockRun.mockImplementation(
      (o) =>
        new Promise((resolve) => {
          captured = o;
          settle = resolve;
        })
    );
    open();
    choose();
    fireEvent.click(screen.getByTestId('cover-chain-apply'));
    await waitFor(() => expect(captured).not.toBeNull());
    return { opts: captured as unknown as RunCoverJourneyOptions, settle };
  }

  // OLD #26 — every stage carries a live state from the moment the run starts
  it('gives every stage a live state from the moment the run starts', async () => {
    const { opts, settle } = await startRun();
    for (const stage of COVER_JOURNEY_STAGES) {
      expect(screen.getByTestId(`cover-journey-stage-${stage.id}`)).toHaveAttribute(
        'data-state',
        'idle'
      );
    }
    act(() => {
      opts.onStageProgress?.({
        stageId: 'align',
        label: 'Align with the Original',
        phase: 'measuring',
        stageFraction: 0,
        detail: 'cross-correlating',
      });
    });
    // Exactly ONE stage is running — a stepper that highlights two is a stepper
    // that is describing a run nobody is having.
    const running = COVER_JOURNEY_STAGES.filter(
      (s) =>
        screen.getByTestId(`cover-journey-stage-${s.id}`).getAttribute('data-state') === 'running'
    );
    expect(running.map((s) => s.id)).toEqual(['align']);
    await act(async () => {
      settle(report());
    });
  });

  // OLD #29 — dimming: what has not run is dimmed, what IS running is not
  it('dims what has not run yet and does not dim what is running', async () => {
    const { opts, settle } = await startRun();
    act(() => {
      opts.onStageProgress?.({
        stageId: 'clean',
        label: 'Clean the Take (Vocal Chain)',
        phase: 'rendering',
        stageFraction: 0.5,
        detail: 'Vocal Chain',
      });
    });
    expect(screen.getByTestId('cover-journey-stage-clean')).toHaveStyle({ opacity: '1' });
    expect(screen.getByTestId('cover-journey-stage-smooth')).toHaveStyle({ opacity: '0.55' });
    await act(async () => {
      settle(report());
    });
  });

  // OLD #31 — the whole-pass caption and the overall bar; `onStageStart` and
  // `onProgress` were never fired by the rewrite at all
  it('names the running stage and shows the progress the engine reported', async () => {
    const { opts, settle } = await startRun();
    expect(screen.getByTestId('cover-journey-running')).toHaveTextContent(
      'Whole journey — starting…'
    );
    act(() => {
      opts.onStageStart?.(journeyStageById('match'));
      opts.onProgress?.(0.42);
    });
    expect(screen.getByTestId('cover-journey-running')).toHaveTextContent(
      'Whole journey — running Match to the Original Vocal…'
    );
    expect(screen.getByTestId('cover-journey-progress')).toHaveStyle({ width: '42%' });
    await act(async () => {
      settle(report());
    });
  });

  // OLD #28 — the live rows and the finished rows are THE SAME OBJECTS, so the
  // two cannot describe one stage in two ways. `onStageResult` was dead in the
  // rewrite: nothing called it, so nothing checked the contract at all.
  it("settles a finished stage to the REPORT's own words, live and after", async () => {
    const landed = report({
      stages: stagesWith({
        id: 'align',
        label: 'Align with the Original',
        status: 'done',
        derived: [{ label: 'Offset', value: '+1.250 s', from: 'the best lag of the two envelopes' }],
        warning: 'a placement, not a warp',
        undoEntries: [],
      }),
    });
    const { opts, settle } = await startRun();

    act(() => {
      for (const r of landed.stages) opts.onStageResult?.(r);
    });
    const liveDerived = screen.getByTestId('cover-journey-derived-align').textContent;
    const liveWarning = screen.getByTestId('cover-journey-warning-align').textContent;
    expect(liveDerived).toContain('+1.250 s');

    await act(async () => {
      settle(landed);
    });
    // Identical text, because they are the same objects — not a second phrasing.
    expect(screen.getByTestId('cover-journey-derived-align').textContent).toBe(liveDerived);
    expect(screen.getByTestId('cover-journey-warning-align').textContent).toBe(liveWarning);
  });

  // OLD #30 — a run that could not start shows NOTHING. This was a live
  // REGRESSION, not merely an untested property: the rewrite dropped the `busy`
  // arm, so half-run rows stayed on screen beside the error looking like an
  // outcome.
  it('shows NOTHING from a run that failed to start', async () => {
    const { opts, settle } = await startRun();
    act(() => {
      opts.onStageResult?.({
        id: 'separate',
        label: 'Separate the Original',
        status: 'done',
        derived: [{ label: 'Separated', value: 'song into 5', from: 'a model pass' }],
        undoEntries: [],
      });
    });
    expect(screen.getByTestId('cover-journey-derived-separate')).toBeInTheDocument();

    await act(async () => {
      settle(null);
    });
    expect(screen.getByTestId('cover-journey-error')).toBeInTheDocument();
    expect(screen.queryByTestId('cover-journey-derived-separate')).not.toBeInTheDocument();
    expect(screen.getByTestId('cover-journey-status-separate')).toHaveTextContent('');
  });
});

describe('CoverChainDialog — restored: the status vocabulary', () => {
  // OLD #17 — every status word, so a new status cannot ship unworded and an
  // existing one cannot silently change what it says.
  const JOURNEY_WORDS: [CoverJourneyStageResult['status'], string][] = [
    ['done', '✓ Done'],
    ['declined', 'Did not run'],
    ['reused', '✓ Reused'],
    ['cancelled', 'Cancelled'],
    ['failed', 'Failed'],
    ['pending', 'Waiting'],
  ];

  async function runWith(stages: CoverJourneyStageResult[]): Promise<void> {
    mockRun.mockResolvedValue(report({ completed: false, stages }));
    open();
    choose();
    fireEvent.click(screen.getByTestId('cover-chain-apply'));
    await waitFor(() => expect(screen.getByTestId('cover-journey-outcome')).toBeInTheDocument());
  }

  it('gives each journey status its own words', async () => {
    // Six stages, six statuses — the union is covered exhaustively.
    expect(JOURNEY_WORDS.length).toBe(COVER_JOURNEY_STAGES.length);
    await runWith(
      COVER_JOURNEY_STAGES.map((s, i) => ({
        id: s.id,
        label: s.label,
        status: JOURNEY_WORDS[i][0],
        derived: [],
        undoEntries: [],
      }))
    );
    COVER_JOURNEY_STAGES.forEach((s, i) => {
      expect(screen.getByTestId(`cover-journey-status-${s.id}`)).toHaveTextContent(
        JOURNEY_WORDS[i][1]
      );
    });
  });

  it('gives each NESTED chain status its own words', async () => {
    await runWith(
      stagesWith({
        id: 'clean',
        label: 'Clean the Take (Vocal Chain)',
        status: 'done',
        derived: [],
        undoEntries: [],
        vocalChain: {
          stages: [
            { id: 'a', label: 'Applied one', status: 'applied', derived: [] },
            {
              id: 'b',
              label: 'Declined one',
              status: 'declined',
              reason: 'nothing found',
              derived: [],
            },
            { id: 'c', label: 'Off one', status: 'off', derived: [] },
            { id: 'd', label: 'Manual one', status: 'manual', derived: [] },
          ],
        },
      } as unknown as CoverJourneyStageResult)
    );
    const words: [string, string][] = [
      ['a', 'Ran'],
      ['b', 'Did not run'],
      ['c', 'Switched off'],
      ['d', 'Manual step'],
    ];
    for (const [id, word] of words) {
      expect(screen.getByTestId(`cover-journey-nested-clean-${id}`)).toHaveTextContent(word);
    }
  });
});

// ── CC3: the refused guess, one click away ──────────────────────────────────

/**
 * The refusal arm's affordance. `applyMeasuredOffset` is spied on rather than
 * run: what belongs to the dialog is WHICH offset it offers, what numbers ride
 * the offer, and what it says afterwards — the placement arithmetic has its own
 * suite in `coverPlacement.test.ts`, on the negative case that produced this.
 */
describe('CoverChainDialog — applying the refused guess', () => {
  const measurement = (offsetSeconds: number, extra: Record<string, unknown> = {}) =>
    ({
      offsetSeconds,
      peakCorrelation: 0.423,
      rivalCorrelation: 0.344,
      prominence: 0.079,
      confident: false,
      coarseOffsetSeconds: offsetSeconds,
      lagsEvaluated: 900,
      overlapSeconds: 41.2,
      refined: true,
      ...extra,
    }) as unknown as CoverJourneyReport['alignment'];

  const separation = (): CoverJourneyReport['separation'] => ({
    reused: false,
    vocalsDocId: 'doc-vocals',
    instrumentalDocId: 'doc-instrumental',
    summedFrom: [],
    sampleRate: SR,
    lengthSamples: SR * 4,
  });

  async function runRefused(over: Partial<CoverJourneyReport> = {}): Promise<void> {
    mockRun.mockResolvedValue(
      report({
        alignmentRefused: true,
        alignment: measurement(-8.258),
        separation: separation(),
        ...over,
      })
    );
    open();
    choose();
    fireEvent.click(screen.getByTestId('cover-chain-apply'));
    await waitFor(() => expect(screen.getByTestId('cover-journey-outcome')).toBeInTheDocument());
  }

  it('offers the measured offset as a button, with its sign', async () => {
    await runRefused();
    const button = screen.getByTestId('cover-journey-guess-apply');
    expect(button).toHaveTextContent(APPLY_GUESS_LABEL);
    expect(button).toHaveTextContent('−8.258 s');
  });

  it('puts the measurement\'s own numbers next to the button, so the choice is informed', async () => {
    await runRefused();
    const numbers = screen.getByTestId('cover-journey-guess-numbers');
    expect(numbers).toHaveTextContent('0.423');
    expect(numbers).toHaveTextContent('0.079');
    expect(numbers).toHaveTextContent('41.2');
    // Offered, never applied on the user's behalf — and it says so.
    expect(numbers).toHaveTextContent('may be wrong');
  });

  it('places at the measured offset when pressed, through the two documents it named', async () => {
    await runRefused();
    fireEvent.click(screen.getByTestId('cover-journey-guess-apply'));
    expect(mockApply).toHaveBeenCalledWith({
      offsetSeconds: -8.258,
      instrumentalDocId: 'doc-instrumental',
      takeDocId: take.id,
    });
  });

  it('says what it placed, and that it is one undo entry', async () => {
    mockApply.mockReturnValue({
      applied: true,
      sessionRate: SR,
      takeStartSample: 0,
      instrumentalStartSample: Math.round(8.258 * SR),
      shiftedSamples: Math.round(8.258 * SR),
      fadeInSample: 1200,
      fadeOutSample: 1200,
      cursorSample: 0,
    });
    await runRefused();
    fireEvent.click(screen.getByTestId('cover-journey-guess-apply'));
    const applied = screen.getByTestId('cover-journey-guess-applied');
    expect(applied).toHaveTextContent('8.258 s');
    expect(applied).toHaveTextContent(APPLY_GUESS_UNDO_LABEL);
  });

  it('says why nothing happened when the placement refuses', async () => {
    mockApply.mockReturnValue({ applied: false, reason: 'the take is no longer on this timeline' });
    await runRefused();
    fireEvent.click(screen.getByTestId('cover-journey-guess-apply'));
    expect(screen.getByTestId('cover-journey-guess-applied')).toHaveTextContent(
      'the take is no longer on this timeline'
    );
  });

  it('offers nothing when the alignment was BELIEVED — the take is already there', async () => {
    mockRun.mockResolvedValue(
      report({ alignmentRefused: false, alignment: measurement(1.25, { confident: true }) })
    );
    open();
    choose();
    fireEvent.click(screen.getByTestId('cover-chain-apply'));
    await waitFor(() => expect(screen.getByTestId('cover-journey-outcome')).toBeInTheDocument());
    expect(screen.queryByTestId('cover-journey-guess-apply')).not.toBeInTheDocument();
  });

  it('offers nothing when there is no session to re-place clips on', async () => {
    await runRefused({ completed: false, placement: null });
    expect(screen.queryByTestId('cover-journey-guess-apply')).not.toBeInTheDocument();
  });

  // ── The CC2 outcome contract, when it arrives ─────────────────────────────

  it('lists each candidate as its own one-click placement when the match is ambiguous', async () => {
    await runRefused({
      alignment: measurement(-8.258, {
        outcome: 'ambiguous',
        candidates: [
          { offsetSeconds: -8.258, correlation: 0.423, prominence: 0.079 },
          { offsetSeconds: 12.5, correlation: 0.41, prominence: 0.06 },
        ],
      }),
    });
    expect(screen.getByTestId('cover-journey-guess-offer')).toHaveTextContent('several places');
    expect(screen.getByTestId('cover-journey-guess-candidate-0')).toHaveTextContent('−8.258 s');
    expect(screen.getByTestId('cover-journey-guess-candidate-1')).toHaveTextContent('+12.500 s');
    // The single arm gives way to the list — one offer per place, not two ways
    // to apply the same one.
    expect(screen.queryByTestId('cover-journey-guess-apply')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('cover-journey-guess-candidate-1'));
    expect(mockApply).toHaveBeenCalledWith({
      offsetSeconds: 12.5,
      instrumentalDocId: 'doc-instrumental',
      takeDocId: take.id,
    });
  });

  it('words the offer as weak-but-plausible when the measurement says so', async () => {
    await runRefused({ alignment: measurement(-8.258, { outcome: 'weak' }) });
    expect(screen.getByTestId('cover-journey-guess-offer')).toHaveTextContent('weak but plausible');
  });

  it('words the offer as probably-wrong when the measurement found no relation', async () => {
    await runRefused({ alignment: measurement(-8.258, { outcome: 'unrelated' }) });
    expect(screen.getByTestId('cover-journey-guess-offer')).toHaveTextContent('probably wrong');
    // Still offered: the user, not the app, decides the number is useless.
    expect(screen.getByTestId('cover-journey-guess-apply')).toBeInTheDocument();
  });

  it('claims nothing about the kind of failure on today\'s measurement shape', async () => {
    await runRefused();
    const offer = screen.getByTestId('cover-journey-guess-offer');
    expect(offer).not.toHaveTextContent('weak but plausible');
    expect(offer).not.toHaveTextContent('probably wrong');
    expect(offer).not.toHaveTextContent('several places');
  });
});
