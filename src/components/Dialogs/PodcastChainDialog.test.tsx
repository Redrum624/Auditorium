import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import PodcastChainDialog from './PodcastChainDialog';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import {
  PODCAST_CHAIN_STAGES,
  PODCAST_CHANNEL_REFUSAL,
  PODCAST_TARGET_LUFS_MONO,
  PODCAST_TARGET_LUFS_STEREO,
  defaultPodcastStageSelection,
  runPodcastChain,
  type PodcastChainReport,
  type PodcastChainStageProgress,
  type PodcastChainStageResult,
} from '../../services/podcastChain';
import { STAGE_MEASURING_DETAIL } from '../../services/vocalChain';

// The STAGE TABLE stays real (requireActual): this dialog's whole contract is
// that it lists what the engine will actually run, in the engine's order, with
// the engine's own notes — a mocked stage list would let the two drift and
// these tests would still pass. Only the run itself is mocked.
jest.mock('../../services/podcastChain', () => ({
  ...jest.requireActual('../../services/podcastChain'),
  runPodcastChain: jest.fn(),
}));

const mockRun = runPodcastChain as jest.MockedFunction<typeof runPodcastChain>;

const SR = 44100;

function seedDoc(channels = 2, samples = SR * 10): AudioDocument {
  const doc = createDocument({
    name: 'episode-014.wav',
    sampleRate: SR,
    channels: Array.from({ length: channels }, () => new Float32Array(samples)),
  });
  useAppStore.getState().addDocument(doc);
  return doc;
}

/** A full stage list with `results` substituted in by id — so a fixture can
 * describe one stage's outcome without hand-writing the other nine. */
function stagesWith(...results: PodcastChainStageResult[]): PodcastChainStageResult[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  return PODCAST_CHAIN_STAGES.map(
    (s) => byId.get(s.id) ?? { id: s.id, label: s.label, status: 'off', derived: [] }
  );
}

/** The measured numbers from the service's own fixture run, so the dialog is
 * tested against figures the engine actually produces. Deliberately off every
 * identity: before and after differ in all four measures. */
function makeReport(overrides: Partial<PodcastChainReport> = {}): PodcastChainReport {
  return {
    before: { rmsDb: -30.5, peakDb: -19.9, crestDb: 10.6, lufs: -29.8 },
    after: { rmsDb: -21.5, peakDb: -1.0, crestDb: 20.5, lufs: -16.0 },
    stages: stagesWith(),
    sampleRate: SR,
    regionSamples: SR * 10,
    outputSamples: SR * 6.52,
    elapsedMs: 13400,
    applied: true,
    refusal: null,
    ...overrides,
  };
}

const APPLIED_LOUDNESS: PodcastChainStageResult = {
  id: 'loudness',
  label: 'Loudness',
  status: 'applied',
  derived: [
    {
      label: 'Gain',
      value: '+13.8 dB',
      from: 'measured -29.8 LUFS against the -16.0 LUFS stereo podcast target',
    },
  ],
  loudness: { beforeLufs: -29.8, afterLufs: -16.0, targetLufs: -16.0, gainDb: 13.8 },
  delta: {
    rmsBeforeDb: -35.3,
    rmsAfterDb: -21.5,
    peakBeforeDb: -13.2,
    peakAfterDb: 0.6,
    identicalFraction: 0.037,
    differenceRmsDb: -20.9,
  },
  elapsedMs: 180,
};

/** The same stage on a MONO document: the target it aimed at is -19.0, the
 * figure `PODCAST_TARGET_LUFS_MONO` names and the only one a 1-channel run can
 * report. Its gain differs from the stereo fixture's for the same reason. */
const APPLIED_LOUDNESS_MONO: PodcastChainStageResult = {
  id: 'loudness',
  label: 'Loudness',
  status: 'applied',
  derived: [
    {
      label: 'Gain',
      value: '+10.8 dB',
      from: 'measured -29.8 LUFS against the -19.0 LUFS mono podcast target',
    },
  ],
  loudness: { beforeLufs: -29.8, afterLufs: -19.0, targetLufs: -19.0, gainDb: 10.8 },
  delta: {
    rmsBeforeDb: -35.3,
    rmsAfterDb: -24.5,
    peakBeforeDb: -13.2,
    peakAfterDb: -2.4,
    identicalFraction: 0.037,
    differenceRmsDb: -23.9,
  },
  elapsedMs: 180,
};

/** A Limiter that RAN — the stage the delivery sentence's claim depends on. */
const APPLIED_LIMITER: PodcastChainStageResult = {
  id: 'limiter',
  label: 'Limiter',
  status: 'applied',
  derived: [{ label: 'Ceiling', value: '-1.0 dBFS', from: 'the delivery ceiling D6 names' }],
  delta: {
    rmsBeforeDb: -21.5,
    rmsAfterDb: -21.9,
    peakBeforeDb: 0.6,
    peakAfterDb: -1.0,
    identicalFraction: 0.94,
    differenceRmsDb: -41.2,
  },
  elapsedMs: 90,
};

/**
 * The loudness stage with the Limiter switched off — a stage that RAN and still
 * needs reading.
 *
 * The text is `loudnessWarning`'s own sentence with its own measured figure
 * (+0.6 dBFS is what the service suite records on its fixture), not invented
 * copy: a paraphrase here would let the two drift and this dialog would still
 * look right. It is the one path 6a added purely for safety — with the Limiter
 * off, this amber line is the ONLY place the user learns the take is over full
 * scale.
 */
const WARNED_LOUDNESS: PodcastChainStageResult = {
  id: 'loudness',
  label: 'Loudness',
  status: 'applied',
  warning:
    'this stage set the loudness, which says nothing about the peak, and the output now peaks at +0.6 dBFS — above full scale. The Limiter, the only stage that runs after this one and the one that would have caught it, is switched off, and both the WAV writer and the MP3 encoder hard-clip anything over full scale. Switch the Limiter on, or bring the level down before you export.',
  derived: [
    {
      label: 'Gain',
      value: '+13.8 dB',
      from: 'measured -29.8 LUFS against the -16.0 LUFS stereo podcast target',
    },
  ],
  loudness: { beforeLufs: -29.8, afterLufs: -16.0, targetLufs: -16.0, gainDb: 13.8 },
  delta: {
    rmsBeforeDb: -35.3,
    rmsAfterDb: -21.5,
    peakBeforeDb: -13.2,
    peakAfterDb: 0.6,
    identicalFraction: 0.037,
    differenceRmsDb: -20.9,
  },
  elapsedMs: 180,
};

/** An applied stage with nothing to warn about — the negative half of the pin
 * below, so "renders a warning" cannot pass by rendering one everywhere. */
const APPLIED_DC: PodcastChainStageResult = {
  id: 'dc',
  label: 'Remove DC Offset',
  status: 'applied',
  derived: [],
  delta: {
    rmsBeforeDb: -30.5,
    rmsAfterDb: -30.5,
    peakBeforeDb: -19.9,
    peakAfterDb: -19.9,
    identicalFraction: 0,
    differenceRmsDb: -58.2,
  },
  elapsedMs: 20,
};

/** The engine's own decline sentence, abbreviated but not invented. */
const DECLINED_HUM: PodcastChainStageResult = {
  id: 'hum',
  label: 'DeHum',
  status: 'declined',
  reason:
    'no mains hum measured (50 Hz -3.7 dB, 60 Hz -2.3 dB above the surrounding spectrum, against a 12 dB threshold) — nothing was notched',
  derived: [],
};

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  jest.clearAllMocks();
  mockRun.mockResolvedValue(makeReport());
});

function open(onClose: () => void = () => {}): void {
  render(<PodcastChainDialog onClose={onClose} />);
}

// ── The stage list ──────────────────────────────────────────────────────────

describe('PodcastChainDialog — every stage is listed and switchable', () => {
  it('lists every stage the engine declares, in D6’s order', () => {
    seedDoc();
    open();
    const rows = screen.getAllByTestId(/^podcast-chain-stage-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(
      PODCAST_CHAIN_STAGES.map((s) => `podcast-chain-stage-${s.id}`)
    );
    // Spelled out, so a reordering of the engine table cannot quietly take this
    // assertion with it.
    expect(PODCAST_CHAIN_STAGES.map((s) => s.id)).toEqual([
      'dc',
      'noise',
      'hum',
      'silence',
      'gate',
      'compressor',
      'deEsser',
      'eq',
      'loudness',
      'limiter',
    ]);
  });

  it('shows each stage note verbatim, so the ordering can be reasoned about', () => {
    seedDoc();
    open();
    for (const stage of PODCAST_CHAIN_STAGES) {
      expect(screen.getByTestId(`podcast-chain-note-${stage.id}`).textContent).toBe(stage.note);
    }
  });

  it('gives EVERY stage a checkbox — this chain has no manual step, including the one with no effect id', () => {
    seedDoc();
    open();
    // The adaptation that matters: `effectId === null` means "manual, never
    // runs" in the vocal and cover chains, and means "the chain applies this
    // one itself" here. Keying the checkbox off it — as a copy of
    // VocalChainDialog would — would leave the Loudness stage unswitchable.
    const chainApplied = PODCAST_CHAIN_STAGES.filter((s) => s.effectId === null);
    expect(chainApplied.map((s) => s.id)).toEqual(['loudness']);

    for (const stage of PODCAST_CHAIN_STAGES) {
      const row = screen.getByTestId(`podcast-chain-stage-${stage.id}`);
      expect(within(row).queryAllByTestId(`podcast-chain-toggle-${stage.id}`)).toHaveLength(1);
    }
  });

  it('opens with each checkbox on the D6 default', () => {
    seedDoc();
    open();
    for (const stage of PODCAST_CHAIN_STAGES) {
      const box = screen.getByTestId(`podcast-chain-toggle-${stage.id}`);
      if (stage.defaultEnabled) expect(box).toBeChecked();
      else expect(box).not.toBeChecked();
    }
    // And the defaults are the engine's, not a second table in the view.
    const defaults = defaultPodcastStageSelection();
    for (const stage of PODCAST_CHAIN_STAGES) {
      expect(defaults[stage.id]).toBe(stage.defaultEnabled);
    }
  });
});

// ── The switches reach the engine ───────────────────────────────────────────

describe('PodcastChainDialog — the switches reach the engine', () => {
  it('runs the defaults untouched when nothing is toggled', async () => {
    seedDoc();
    open();
    fireEvent.click(screen.getByTestId('podcast-chain-apply'));
    await waitFor(() => expect(mockRun).toHaveBeenCalledTimes(1));
    expect(mockRun.mock.calls[0][0].enabled).toEqual(defaultPodcastStageSelection());
  });

  it('passes the exact enabled map after two stages are switched off', async () => {
    seedDoc();
    open();
    // Both on by default; switching the loudness stage off is the interesting
    // one, since it is the stage with no effect id.
    fireEvent.click(screen.getByTestId('podcast-chain-toggle-loudness'));
    fireEvent.click(screen.getByTestId('podcast-chain-toggle-silence'));
    expect(screen.getByTestId('podcast-chain-toggle-loudness')).not.toBeChecked();
    expect(screen.getByTestId('podcast-chain-toggle-silence')).not.toBeChecked();

    fireEvent.click(screen.getByTestId('podcast-chain-apply'));
    await waitFor(() => expect(mockRun).toHaveBeenCalledTimes(1));
    expect(mockRun.mock.calls[0][0].enabled).toEqual({
      ...defaultPodcastStageSelection(),
      loudness: false,
      silence: false,
    });
  });

  it('cannot apply with every stage switched off', () => {
    seedDoc();
    open();
    for (const stage of PODCAST_CHAIN_STAGES) {
      const box = screen.getByTestId(`podcast-chain-toggle-${stage.id}`) as HTMLInputElement;
      if (box.checked) fireEvent.click(box);
    }
    expect(screen.getByTestId('podcast-chain-apply')).toBeDisabled();
  });
});

// ── The live view ───────────────────────────────────────────────────────────

describe('PodcastChainDialog — the live measuring line', () => {
  async function startRun(): Promise<{
    resolve: (r: PodcastChainReport | null) => void;
    onStageProgress?: (p: PodcastChainStageProgress) => void;
    onStageResult?: (r: PodcastChainStageResult) => void;
    onProgress?: (f: number) => void;
  }> {
    const captured: {
      resolve: (r: PodcastChainReport | null) => void;
      onStageProgress?: (p: PodcastChainStageProgress) => void;
      onStageResult?: (r: PodcastChainStageResult) => void;
      onProgress?: (f: number) => void;
    } = { resolve: () => {} };
    mockRun.mockImplementation(
      (opts) =>
        new Promise<PodcastChainReport | null>((resolve) => {
          captured.resolve = resolve;
          captured.onStageProgress = opts.onStageProgress;
          captured.onStageResult = opts.onStageResult;
          captured.onProgress = opts.onProgress;
        })
    );
    open();
    fireEvent.click(screen.getByTestId('podcast-chain-apply'));
    await waitFor(() => expect(captured.onStageProgress).toBeDefined());
    return captured;
  }

  it('names the running stage and says it is MEASURING, in the engine’s own words', async () => {
    seedDoc();
    const run = await startRun();

    act(() => {
      run.onStageProgress!({
        stageId: 'noise',
        label: 'Noise Reduction',
        phase: 'measuring',
        stageFraction: 0,
        detail: STAGE_MEASURING_DETAIL,
      });
    });

    const line = screen.getByTestId('podcast-chain-activity-noise');
    expect(line).toHaveTextContent('Measuring');
    // The engine's sentence verbatim — no second phrasing in the view.
    expect(line).toHaveTextContent(STAGE_MEASURING_DETAIL);
    expect(screen.getByTestId('podcast-chain-step-noise')).toHaveAttribute('data-state', 'running');

    act(() => {
      run.onStageProgress!({
        stageId: 'noise',
        label: 'Noise Reduction',
        phase: 'rendering',
        stageFraction: 0.5,
        detail: 'Noise print 3.2 s, -60.0 dBFS',
      });
    });
    expect(screen.getByTestId('podcast-chain-activity-noise')).toHaveTextContent('Rendering');
    expect(screen.getByTestId('podcast-chain-activity-noise')).toHaveTextContent(
      'Noise print 3.2 s, -60.0 dBFS'
    );

    await act(async () => {
      run.resolve(makeReport());
    });
  });

  it('disables Apply, Cancel and every switch until the run resolves, then locks the finished pass', async () => {
    seedDoc();
    let resolveRun: (value: PodcastChainReport | null) => void = () => {};
    mockRun.mockImplementation(
      () =>
        new Promise<PodcastChainReport | null>((resolve) => {
          resolveRun = resolve;
        })
    );
    open();

    const apply = screen.getByTestId('podcast-chain-apply');
    expect(apply).not.toBeDisabled();
    fireEvent.click(apply);

    await waitFor(() => expect(apply).toBeDisabled());
    expect(screen.getByTestId('podcast-chain-cancel')).toBeDisabled();
    // Every stage, not a named one: `locked` is passed to all ten checkboxes,
    // and a pin on one would not see nine of them left live.
    for (const stage of PODCAST_CHAIN_STAGES) {
      expect(screen.getByTestId(`podcast-chain-toggle-${stage.id}`)).toBeDisabled();
    }

    await act(async () => {
      resolveRun(makeReport());
    });

    // ...and an APPLIED pass stays locked. Without that, a second click re-runs
    // a destructive chain over audio the first run already changed — the run
    // whose whole design is that it lands as ONE undo entry.
    expect(screen.getByTestId('podcast-chain-close')).toBeInTheDocument();
    expect(screen.queryByTestId('podcast-chain-apply')).toBeNull();
    for (const stage of PODCAST_CHAIN_STAGES) {
      expect(screen.getByTestId(`podcast-chain-toggle-${stage.id}`)).toBeDisabled();
    }
  });

  it('moves the whole-pass bar from the engine’s own fraction', async () => {
    seedDoc();
    const run = await startRun();
    act(() => run.onProgress!(0.42));
    expect(screen.getByTestId('podcast-chain-progress')).toHaveStyle({ width: '42%' });
    await act(async () => {
      run.resolve(makeReport());
    });
  });
});

// ── The report ──────────────────────────────────────────────────────────────

describe('PodcastChainDialog — the report', () => {
  async function apply(report: PodcastChainReport | null): Promise<void> {
    mockRun.mockResolvedValue(report);
    open();
    fireEvent.click(screen.getByTestId('podcast-chain-apply'));
    await waitFor(() => expect(mockRun).toHaveBeenCalledTimes(1));
  }

  it('shows the LUFS before → after row with the report’s own numbers', async () => {
    seedDoc();
    await apply(makeReport());

    const row = await screen.findByTestId('podcast-chain-summary-lufs');
    expect(row).toHaveTextContent('-29.8 LUFS');
    expect(row).toHaveTextContent('-16.0 LUFS');
    // The row is a LOUDNESS row, not another dBFS one.
    expect(row).toHaveTextContent(/loudness/i);
  });

  it('renders n/a rather than a zero when the loudness could not be measured', async () => {
    seedDoc();
    await apply(
      makeReport({
        before: { rmsDb: -70.0, peakDb: -60.0, crestDb: 10.0, lufs: null },
        after: { rmsDb: -70.0, peakDb: -60.0, crestDb: 10.0, lufs: null },
      })
    );

    const row = await screen.findByTestId('podcast-chain-summary-lufs');
    expect(row).toHaveTextContent('n/a');
    expect(row).not.toHaveTextContent('0.0 LUFS');
  });

  it('states the target that applies to THIS document — stereo', async () => {
    seedDoc(2);
    await apply(makeReport({ stages: stagesWith(APPLIED_LOUDNESS) }));
    const target = await screen.findByTestId('podcast-chain-target');
    expect(target).toHaveTextContent(`${PODCAST_TARGET_LUFS_STEREO.toFixed(1)} LUFS`);
    expect(target).toHaveTextContent(/stereo/i);
  });

  it('states the target that applies to THIS document — mono', async () => {
    seedDoc(1);
    // The loudness stage's own report has to be the MONO one (minor M6): seeding
    // a 1-channel document and then feeding a report whose loudness stage says
    // it aimed at -16.0 described a run that cannot happen, and the line under
    // test would have read the same with the fixture disagreeing.
    await apply(makeReport({ stages: stagesWith(APPLIED_LOUDNESS_MONO, APPLIED_LIMITER) }));
    const target = await screen.findByTestId('podcast-chain-target');
    expect(target).toHaveTextContent(`${PODCAST_TARGET_LUFS_MONO.toFixed(1)} LUFS`);
    expect(target).toHaveTextContent(/mono/i);
    expect(target).toHaveTextContent(/limiter holding the sample peak/i);
  });

  /**
   * C10 — the delivery sentence may only claim the limiter held the peak when
   * the Limiter actually RAN. Every stage has a checkbox, and with that one off
   * the loudness gain leaves the peak wherever it lands — the amber warning a
   * few lines above says exactly that, and the two must not contradict each
   * other on one screen.
   */
  it('does NOT claim the limiter held the peak when the Limiter did not run', async () => {
    seedDoc(2);
    await apply(makeReport({ stages: stagesWith(WARNED_LOUDNESS) })); // limiter: 'off'
    const target = await screen.findByTestId('podcast-chain-target');
    expect(target).toHaveTextContent(`${PODCAST_TARGET_LUFS_STEREO.toFixed(1)} LUFS`);
    expect(target).not.toHaveTextContent(/limiter holding/i);
    expect(target).toHaveTextContent(/Limiter did not run/i);
  });

  it('claims it again as soon as the Limiter reports applied', async () => {
    seedDoc(2);
    await apply(makeReport({ stages: stagesWith(APPLIED_LOUDNESS, APPLIED_LIMITER) }));
    expect(await screen.findByTestId('podcast-chain-target')).toHaveTextContent(
      /limiter holding the sample peak/i
    );
  });

  it('shows a declined stage as “Did not run”, with the measurement that decided it', async () => {
    seedDoc();
    await apply(makeReport({ stages: stagesWith(DECLINED_HUM) }));

    expect(await screen.findByTestId('podcast-chain-status-hum')).toHaveTextContent('Did not run');
    expect(screen.getByTestId('podcast-chain-reason-hum')).toHaveTextContent(DECLINED_HUM.reason!);
  });

  it('shows the loudness stage’s derived gain and its measured before/after', async () => {
    seedDoc();
    await apply(makeReport({ stages: stagesWith(APPLIED_LOUDNESS) }));

    expect(await screen.findByTestId('podcast-chain-status-loudness')).toHaveTextContent('Ran');
    expect(screen.getByTestId('podcast-chain-derived-loudness')).toHaveTextContent('+13.8 dB');
    // Both readings are MEASURED — the engine re-reads the result rather than
    // asserting the target it asked for — so the row shows them separately from
    // the target instead of printing the target twice.
    const line = screen.getByTestId('podcast-chain-loudness-loudness');
    expect(line).toHaveTextContent('-29.8 LUFS');
    expect(line).toHaveTextContent('-16.0 LUFS');
    expect(line).toHaveTextContent(/target/i);
  });

  it('renders n/a on the stage row when the after-loudness could not be measured', async () => {
    seedDoc();
    await apply(
      makeReport({
        stages: stagesWith({
          ...APPLIED_LOUDNESS,
          loudness: { beforeLufs: -29.8, afterLufs: null, targetLufs: -16.0, gainDb: 13.8 },
        }),
      })
    );
    const line = await screen.findByTestId('podcast-chain-loudness-loudness');
    expect(line).toHaveTextContent('n/a');
  });

  it('says the document was not changed when the engine resolves null after a failure', async () => {
    seedDoc();
    await apply(null);
    // No report, so no stage verdicts are left on screen looking like the
    // outcome of a pass that in fact rolled back.
    expect(await screen.findByTestId('podcast-chain-error')).toHaveTextContent(
      /nothing in the document was changed/i
    );
    expect(screen.queryByTestId('podcast-chain-summary')).toBeNull();
    expect(screen.queryByTestId('podcast-chain-progress')).toBeNull();
    // Recoverable: the run failed, so Apply is still there to try again.
    expect(screen.getByTestId('podcast-chain-apply')).toBeInTheDocument();
  });

  it('renders a warning on a stage that DID run, distinct from a refusal and from a blank', async () => {
    seedDoc();
    await apply(makeReport({ stages: stagesWith(APPLIED_DC, WARNED_LOUDNESS) }));

    const warning = await screen.findByTestId('podcast-chain-warning-loudness');
    // The number and the consequence, both — this line exists to say the take
    // is over full scale, and either half alone does not say it.
    expect(warning).toHaveTextContent('+0.6 dBFS');
    expect(warning).toHaveTextContent('above full scale');
    expect(warning).toHaveTextContent('Limiter');

    // A warning is NOT a refusal: the stage ran, and it does not replace what
    // the stage reported.
    expect(screen.getByTestId('podcast-chain-status-loudness')).toHaveTextContent('Ran');
    expect(screen.getByTestId('podcast-chain-delta-loudness')).toBeInTheDocument();
    expect(screen.getByTestId('podcast-chain-derived-loudness')).toBeInTheDocument();
    expect(screen.getByTestId('podcast-chain-loudness-loudness')).toBeInTheDocument();
    expect(screen.queryByTestId('podcast-chain-reason-loudness')).toBeNull();

    // ...and it is rendered for THAT stage only. An applied stage with nothing
    // to warn about renders no warning line at all.
    expect(screen.queryByTestId('podcast-chain-warning-dc')).toBeNull();
    expect(screen.getByTestId('podcast-chain-status-dc')).toHaveTextContent('Ran');
    expect(screen.getAllByTestId(/^podcast-chain-warning-/)).toHaveLength(1);
  });

  it('renders no warning line anywhere when no stage carries one', async () => {
    seedDoc();
    await apply(makeReport({ stages: stagesWith(APPLIED_DC, APPLIED_LOUDNESS) }));

    expect(await screen.findByTestId('podcast-chain-status-loudness')).toHaveTextContent('Ran');
    expect(screen.queryAllByTestId(/^podcast-chain-warning-/)).toHaveLength(0);
  });

  it('replaces Apply with Close once the run has landed', async () => {
    seedDoc();
    await apply(makeReport());
    expect(await screen.findByTestId('podcast-chain-close')).toBeInTheDocument();
    expect(screen.queryByTestId('podcast-chain-apply')).toBeNull();
  });

  it('says the run changed nothing when no stage ran, and does not lock', async () => {
    seedDoc();
    await apply(makeReport({ stages: stagesWith(), applied: false }));
    expect(await screen.findByTestId('podcast-chain-outcome')).toHaveTextContent(
      /was not changed/i
    );
  });
});

// ── The refusal ─────────────────────────────────────────────────────────────

describe('PodcastChainDialog — the >2-channel refusal', () => {
  /**
   * C2 — the refusal is stated BEFORE Apply, not after it. The pre-run sentence
   * used to call a 6-channel document "stereo" and promise it -16.0 LUFS, with
   * Apply enabled, for a document `runPodcastChain` refuses outright: a false
   * description of the file and a target it would never be held to, on the one
   * path D6 exists for.
   */
  it('names the refusal pre-run and disables Apply for a document over two channels', () => {
    seedDoc(3);
    open();

    const refusal = screen.getByTestId('podcast-chain-channel-refusal');
    expect(refusal).toHaveTextContent('This document has 3 channels');
    // The engine's own sentence, so the instruction lives in exactly one place.
    expect(refusal).toHaveTextContent(PODCAST_CHANNEL_REFUSAL);
    expect(refusal).toHaveTextContent('Convert Channels');
    // ...and none of the copy that only makes sense for a document it will run.
    // (The refusal itself says "Convert to stereo first", which is the fix, not
    // a description of this file.)
    expect(refusal).not.toHaveTextContent(/This document is stereo/i);
    expect(screen.queryByText(/so the pass targets/i)).toBeNull();

    expect(screen.getByTestId('podcast-chain-apply')).toBeDisabled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('says "stereo" only for a document with exactly two channels', () => {
    seedDoc(2);
    open();
    expect(screen.getByText(/This document is stereo/i)).toBeInTheDocument();
    expect(screen.queryByTestId('podcast-chain-channel-refusal')).toBeNull();
    expect(screen.getByTestId('podcast-chain-apply')).not.toBeDisabled();
  });

  /**
   * The ENGINE is the authority on this rule; the guard above is a copy of it
   * that keeps the shipped path from reaching a refusal at all. This pins what
   * the user sees if the engine ever refuses a document the dialog let through
   * — the terminal render, driven by a refusal report the way the engine
   * delivers one. Seeded at two channels deliberately: the guard would
   * otherwise disable the Apply this test has to click.
   */
  it('renders the refusal text, leaves no progress bar behind, and offers only Close', async () => {
    seedDoc(2);
    mockRun.mockResolvedValue(
      makeReport({
        before: { rmsDb: -30.5, peakDb: -19.9, crestDb: 10.6, lufs: null },
        after: { rmsDb: -30.5, peakDb: -19.9, crestDb: 10.6, lufs: null },
        stages: [],
        outputSamples: SR * 10,
        applied: false,
        refusal: PODCAST_CHANNEL_REFUSAL,
      })
    );
    open();
    fireEvent.click(screen.getByTestId('podcast-chain-apply'));

    const refusal = await screen.findByTestId('podcast-chain-refusal');
    // The engine's sentence verbatim: it names the fix, and a paraphrase here
    // would be a second place for that instruction to go wrong.
    expect(refusal).toHaveTextContent(PODCAST_CHANNEL_REFUSAL);
    expect(refusal).toHaveTextContent('Convert Channels');

    // Nothing is still spinning. The refusal path calls NO callback at all —
    // `onProgress` never fires — so a view that waited for the bar to reach 1
    // would wait forever; promise resolution is the completion signal.
    expect(screen.queryByTestId('podcast-chain-progress')).toBeNull();
    expect(screen.queryByTestId('podcast-chain-running')).toBeNull();
    expect(mockRun.mock.calls[0][0].onProgress).toBeDefined();

    // A refused document cannot be run, so Apply is gone rather than inviting a
    // second refusal.
    expect(screen.getByTestId('podcast-chain-close')).toBeInTheDocument();
    expect(screen.queryByTestId('podcast-chain-apply')).toBeNull();
    // And there is no empty stage table pretending something was decided.
    expect(screen.queryByTestId('podcast-chain-summary')).toBeNull();
  });
});

// ── Dismissal and honest copy ───────────────────────────────────────────────

describe('PodcastChainDialog — dismissal', () => {
  it('closes on Escape', () => {
    seedDoc();
    const onClose = jest.fn();
    open(onClose);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Cancel before a run, and on Close after one', async () => {
    seedDoc();
    const onClose = jest.fn();
    open(onClose);
    fireEvent.click(screen.getByTestId('podcast-chain-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('podcast-chain-apply'));
    await waitFor(() => expect(screen.queryByTestId('podcast-chain-close')).not.toBeNull());
    fireEvent.click(screen.getByTestId('podcast-chain-close'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('will not dismiss while a run is in flight', async () => {
    seedDoc();
    const onClose = jest.fn();
    let settle: (r: PodcastChainReport | null) => void = () => {};
    mockRun.mockImplementation(
      () => new Promise<PodcastChainReport | null>((r) => (settle = r))
    );
    open(onClose);
    fireEvent.click(screen.getByTestId('podcast-chain-apply'));
    await waitFor(() => expect(screen.getByTestId('podcast-chain-cancel')).toBeDisabled());

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      settle(makeReport());
    });
  });
});

describe('PodcastChainDialog — honest copy', () => {
  it('says SAMPLE peak, and never labels anything a true peak', async () => {
    seedDoc();
    mockRun.mockResolvedValue(makeReport({ stages: stagesWith(APPLIED_LOUDNESS) }));
    open();
    fireEvent.click(screen.getByTestId('podcast-chain-apply'));
    await screen.findByTestId('podcast-chain-summary');

    const text = screen.getByTestId('podcast-chain-dialog').textContent ?? '';
    expect(text).toMatch(/sample peak/i);
    // The limiter is not oversampled, so "true peak"/"dBTP" is a claim the DSP
    // cannot support. Mentioning it to DENY it is the disclosure the rule wants,
    // so the pin is on the claim: every occurrence must sit beside a negation.
    const re = /dBTP|true[- ]peak/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const context = text.slice(Math.max(0, match.index - 140), match.index + 140);
      expect(context).toMatch(/\b(not|never|nothing|no)\b/i);
    }
  });

  it('states both delivery targets where the user chooses the stages', () => {
    seedDoc();
    open();
    const text = screen.getByTestId('podcast-chain-dialog').textContent ?? '';
    expect(text).toContain(`${PODCAST_TARGET_LUFS_STEREO.toFixed(1)} LUFS`);
    expect(text).toContain(`${PODCAST_TARGET_LUFS_MONO.toFixed(1)} LUFS`);
  });
});
