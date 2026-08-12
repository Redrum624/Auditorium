import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import VocalChainDialog from './VocalChainDialog';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import {
  VOCAL_CHAIN_STAGES,
  defaultStageSelection,
  runVocalChain,
  type VocalChainReport,
  type VocalChainStageResult,
} from '../../services/vocalChain';

// The STAGE TABLE stays real (requireActual): the dialog's whole contract is
// that it lists what the engine will actually run, in the engine's order, with
// the engine's own notes — a mocked stage list would let the two drift and the
// tests would still pass. Only the run itself is mocked.
jest.mock('../../services/vocalChain', () => ({
  ...jest.requireActual('../../services/vocalChain'),
  runVocalChain: jest.fn(),
}));

const mockRun = runVocalChain as jest.MockedFunction<typeof runVocalChain>;

const SR = 48000;

function seedDoc(samples = SR * 4): AudioDocument {
  const doc = createDocument({
    name: 'take.wav',
    sampleRate: SR,
    channels: [new Float32Array(samples)],
  });
  useAppStore.getState().addDocument(doc);
  return doc;
}

/** A full stage list with `results` substituted in by id — so a fixture can
 * describe one stage's outcome without hand-writing the other ten. */
function stagesWith(...results: VocalChainStageResult[]): VocalChainStageResult[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  return VOCAL_CHAIN_STAGES.map(
    (s) =>
      byId.get(s.id) ?? {
        id: s.id,
        label: s.label,
        status: s.effectId === null ? 'manual' : 'off',
        derived: [],
      }
  );
}

function makeReport(overrides: Partial<VocalChainReport> = {}): VocalChainReport {
  return {
    before: { rmsDb: -27.8, peakDb: -9.7, crestDb: 18.1, noiseFloorDb: -61.2 },
    // noiseFloorDb null on the AFTER side on purpose: noise reduction can leave
    // the tail below digital silence, and 'n/a' must survive to the screen.
    after: { rmsDb: -20.4, peakDb: -0.3, crestDb: 20.1, noiseFloorDb: null },
    stages: stagesWith(),
    sampleRate: SR,
    regionSamples: SR * 4,
    outputSamples: SR * 4,
    elapsedMs: 12300,
    applied: true,
    ...overrides,
  };
}

const APPLIED_COMPRESSOR: VocalChainStageResult = {
  id: 'compressor',
  label: 'Compressor',
  status: 'applied',
  derived: [
    {
      label: 'Threshold',
      value: '-25.3 dBFS',
      from: 'median detector level while sounding',
    },
    { label: 'Makeup', value: '+2.6 dB', from: 'the exact programme level the reduction removes' },
  ],
  delta: {
    rmsBeforeDb: -27.8,
    rmsAfterDb: -25.1,
    peakBeforeDb: -9.7,
    peakAfterDb: -7.2,
    identicalFraction: 0.0123,
    differenceRmsDb: -34.5,
  },
  elapsedMs: 2100,
};

const DECLINED_HUM: VocalChainStageResult = {
  id: 'hum',
  label: 'DeHum',
  status: 'declined',
  reason: 'no mains hum measured (50 Hz +0.4 dB, 60 Hz +0.2 dB above the surrounding spectrum)',
  derived: [],
};

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  jest.clearAllMocks();
  mockRun.mockResolvedValue(makeReport());
});

function open(): void {
  render(<VocalChainDialog onClose={() => {}} />);
}

describe('VocalChainDialog — every stage is listed and switchable', () => {
  it('lists every stage the engine declares, in the engine order', () => {
    seedDoc();
    open();
    const rows = screen.getAllByTestId(/^vocal-chain-stage-/);
    expect(rows).toHaveLength(VOCAL_CHAIN_STAGES.length);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(
      VOCAL_CHAIN_STAGES.map((s) => `vocal-chain-stage-${s.id}`)
    );
  });

  it('shows each stage note verbatim, so the ordering can be reasoned about', () => {
    seedDoc();
    open();
    for (const stage of VOCAL_CHAIN_STAGES) {
      expect(screen.getByTestId(`vocal-chain-note-${stage.id}`).textContent).toBe(stage.note);
    }
  });

  it('gives every runnable stage its own checkbox and every manual stage none', () => {
    seedDoc();
    open();
    const manual = VOCAL_CHAIN_STAGES.filter((s) => s.effectId === null);
    // Asserted over ALL of them, not over a named one: a second manual stage
    // that DID render a checkbox would offer the user a switch the run loop
    // ignores, and a test pinned to `manual[0]` would never see it.
    expect(manual.length).toBeGreaterThan(0);

    for (const stage of VOCAL_CHAIN_STAGES) {
      const row = screen.getByTestId(`vocal-chain-stage-${stage.id}`);
      expect(within(row).queryAllByRole('checkbox')).toHaveLength(stage.effectId === null ? 0 : 1);
    }
    for (const stage of manual) {
      expect(screen.queryByTestId(`vocal-chain-toggle-${stage.id}`)).toBeNull();
      // …and it says what it is instead of silently offering nothing.
      expect(screen.getByTestId(`vocal-chain-status-${stage.id}`)).toHaveTextContent('Manual step');
    }
  });

  it('opens with each checkbox on the stage default', () => {
    seedDoc();
    open();
    for (const stage of VOCAL_CHAIN_STAGES) {
      if (stage.effectId === null) continue;
      const box = screen.getByTestId(`vocal-chain-toggle-${stage.id}`);
      if (stage.defaultEnabled) expect(box).toBeChecked();
      else expect(box).not.toBeChecked();
    }
  });
});

describe('VocalChainDialog — the switches reach the engine', () => {
  it('runs the defaults untouched when nothing is toggled', async () => {
    seedDoc();
    open();
    fireEvent.click(screen.getByTestId('vocal-chain-apply'));
    await waitFor(() => expect(mockRun).toHaveBeenCalledTimes(1));
    expect(mockRun.mock.calls[0][0].enabled).toEqual(defaultStageSelection());
  });

  it('passes the exact enabled map after a toggle on and a toggle off', async () => {
    seedDoc();
    open();
    // reverb is off by default, pitch is on: flip one of each.
    fireEvent.click(screen.getByTestId('vocal-chain-toggle-reverb'));
    fireEvent.click(screen.getByTestId('vocal-chain-toggle-pitch'));
    expect(screen.getByTestId('vocal-chain-toggle-reverb')).toBeChecked();
    expect(screen.getByTestId('vocal-chain-toggle-pitch')).not.toBeChecked();

    fireEvent.click(screen.getByTestId('vocal-chain-apply'));
    await waitFor(() => expect(mockRun).toHaveBeenCalledTimes(1));
    expect(mockRun.mock.calls[0][0].enabled).toEqual({
      ...defaultStageSelection(),
      reverb: true,
      pitch: false,
    });
  });

  it('cannot apply with every runnable stage switched off', () => {
    seedDoc();
    open();
    for (const stage of VOCAL_CHAIN_STAGES) {
      if (stage.effectId === null) continue;
      const box = screen.getByTestId(`vocal-chain-toggle-${stage.id}`) as HTMLInputElement;
      if (box.checked) fireEvent.click(box);
    }
    expect(screen.getByTestId('vocal-chain-apply')).toBeDisabled();
  });
});

describe('VocalChainDialog — the report says what each stage did', () => {
  it('shows an applied stage its derived settings, what they came from, and its measured delta', async () => {
    seedDoc();
    mockRun.mockResolvedValue(makeReport({ stages: stagesWith(APPLIED_COMPRESSOR) }));
    open();
    fireEvent.click(screen.getByTestId('vocal-chain-apply'));

    await waitFor(() => expect(screen.getByTestId('vocal-chain-status-compressor')).toHaveTextContent('Ran'));

    const derived = screen.getAllByTestId('vocal-chain-derived-compressor');
    expect(derived).toHaveLength(2);
    expect(derived[0]).toHaveTextContent('Threshold: -25.3 dBFS');
    expect(derived[0]).toHaveTextContent('median detector level while sounding');
    expect(derived[1]).toHaveTextContent('Makeup: +2.6 dB');

    const delta = screen.getByTestId('vocal-chain-delta-compressor');
    expect(delta).toHaveTextContent('RMS -27.8 dBFS → -25.1 dBFS');
    expect(delta).toHaveTextContent('peak -9.7 dBFS → -7.2 dBFS');
    expect(delta).toHaveTextContent('1.2% of samples unchanged');
  });

  it('omits the sample-identity figures for a length-changing stage instead of printing 0 %', async () => {
    seedDoc();
    mockRun.mockResolvedValue(
      makeReport({
        stages: stagesWith({
          ...APPLIED_COMPRESSOR,
          id: 'silence',
          label: 'Remove Silence',
          detail: 'removed 4.74 s over 12 gaps',
          delta: {
            rmsBeforeDb: -27.8,
            rmsAfterDb: -26.0,
            peakBeforeDb: -9.7,
            peakAfterDb: -9.7,
            identicalFraction: null,
            differenceRmsDb: null,
          },
        }),
      })
    );
    open();
    fireEvent.click(screen.getByTestId('vocal-chain-apply'));

    await waitFor(() => expect(screen.getByTestId('vocal-chain-delta-silence')).toBeInTheDocument());
    const delta = screen.getByTestId('vocal-chain-delta-silence');
    expect(delta).toHaveTextContent('RMS -27.8 dBFS → -26.0 dBFS');
    expect(delta).not.toHaveTextContent('unchanged');
    expect(screen.getByTestId('vocal-chain-detail-silence')).toHaveTextContent('removed 4.74 s over 12 gaps');
  });

  it('states a declined stage did not run, with the reason, and shows no delta for it', async () => {
    seedDoc();
    mockRun.mockResolvedValue(makeReport({ stages: stagesWith(DECLINED_HUM, APPLIED_COMPRESSOR) }));
    open();
    fireEvent.click(screen.getByTestId('vocal-chain-apply'));

    await waitFor(() => expect(screen.getByTestId('vocal-chain-reason-hum')).toBeInTheDocument());
    expect(screen.getByTestId('vocal-chain-reason-hum')).toHaveTextContent(DECLINED_HUM.reason!);
    expect(screen.getByTestId('vocal-chain-status-hum')).toHaveTextContent('Did not run');
    expect(screen.queryByTestId('vocal-chain-delta-hum')).toBeNull();
    expect(screen.queryByTestId('vocal-chain-derived-hum')).toBeNull();
  });

  it('marks a stage that was switched off as switched off, not as having run', async () => {
    seedDoc();
    mockRun.mockResolvedValue(makeReport({ stages: stagesWith(APPLIED_COMPRESSOR) }));
    open();
    fireEvent.click(screen.getByTestId('vocal-chain-apply'));

    await waitFor(() => expect(screen.getByTestId('vocal-chain-status-reverb')).toHaveTextContent('Switched off'));
    expect(screen.queryByTestId('vocal-chain-delta-reverb')).toBeNull();
  });

  it('shows the before/after summary, with a missing noise floor as n/a', async () => {
    seedDoc();
    open();
    fireEvent.click(screen.getByTestId('vocal-chain-apply'));

    await waitFor(() => expect(screen.getByTestId('vocal-chain-summary')).toBeInTheDocument());

    // BY POSITION. `toHaveTextContent` on the row is position-blind: swapping
    // the Before and After cells leaves every one of these substrings present in
    // its row, so a chain that LOWERED the level would be read as having raised
    // it and this suite would call the table correct. Which column a figure lands
    // in is the entire content of a before/after table.
    const cellsOf = (key: string): HTMLElement[] =>
      within(screen.getByTestId(`vocal-chain-summary-${key}`)).getAllByRole('cell');

    const rms = cellsOf('rmsDb');
    expect(rms).toHaveLength(3); // measure · before · after
    expect(rms[0]).toHaveTextContent('RMS');
    expect(rms[1]).toHaveTextContent('-27.8 dBFS');
    expect(rms[2]).toHaveTextContent('-20.4 dBFS');

    const peak = cellsOf('peakDb');
    expect(peak[1]).toHaveTextContent('-9.7 dBFS');
    expect(peak[2]).toHaveTextContent('-0.3 dBFS');

    const crest = cellsOf('crestDb');
    expect(crest[1]).toHaveTextContent('18.1 dB');
    expect(crest[2]).toHaveTextContent('20.1 dB');

    // The floor that could not be measured reads 'n/a' in the AFTER column
    // specifically — the before side still carries a real number.
    const floor = cellsOf('noiseFloorDb');
    expect(floor[1]).toHaveTextContent('-61.2 dBFS');
    expect(floor[2]).toHaveTextContent('n/a');
  });

  it('reports a run that changed nothing as such, and one that failed as an error with no summary', async () => {
    seedDoc();
    mockRun.mockResolvedValue(makeReport({ applied: false }));
    const nothing = render(<VocalChainDialog onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('vocal-chain-apply'));
    await waitFor(() =>
      expect(screen.getByTestId('vocal-chain-outcome')).toHaveTextContent('No stage ran')
    );
    // …and it does NOT lock: `done` is `report.applied`, not merely "a report
    // came back", so a pass that changed nothing stays re-runnable.
    expect(screen.getByTestId('vocal-chain-apply')).toBeInTheDocument();
    expect(screen.queryByTestId('vocal-chain-close')).toBeNull();
    nothing.unmount();

    mockRun.mockResolvedValue(null);
    render(<VocalChainDialog onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('vocal-chain-apply'));
    await waitFor(() => expect(screen.getByTestId('vocal-chain-error')).toBeInTheDocument());
    expect(screen.getByTestId('vocal-chain-error')).toHaveTextContent('Nothing in the document was changed');
    expect(screen.queryByTestId('vocal-chain-summary')).toBeNull();
  });
});

describe('VocalChainDialog — while it runs', () => {
  it('disables Apply and every switch until the run resolves, then locks the finished pass', async () => {
    seedDoc();
    let resolveRun: (value: VocalChainReport | null) => void = () => {};
    let report: ((fraction: number) => void) | undefined;
    mockRun.mockImplementation(
      (opts) =>
        new Promise<VocalChainReport | null>((resolve) => {
          report = opts.onProgress;
          resolveRun = resolve;
        })
    );
    open();

    const apply = screen.getByTestId('vocal-chain-apply');
    expect(apply).not.toBeDisabled();
    fireEvent.click(apply);

    await waitFor(() => expect(apply).toBeDisabled());
    expect(screen.getByTestId('vocal-chain-cancel')).toBeDisabled();
    expect(screen.getByTestId('vocal-chain-toggle-pitch')).toBeDisabled();

    // The bar is WIRED, not merely present. `toBeInTheDocument()` holds at any
    // width, and no test ever invoked the engine's `onProgress` — so dropping
    // that callback from the `runVocalChain` call left the bar pinned at 0 % for
    // the whole of a pass whose slowest stage alone takes a minute, with this
    // suite green.
    expect(screen.getByTestId('vocal-chain-progress')).toHaveStyle({ width: '0%' });
    expect(report).toBeDefined();
    act(() => report!(0.42));
    expect(screen.getByTestId('vocal-chain-progress')).toHaveStyle({ width: '42%' });

    await act(async () => {
      resolveRun(makeReport());
    });
    expect(screen.getByTestId('vocal-chain-summary')).toBeInTheDocument();

    // …and an APPLIED pass locks. Nothing asserted the post-run state: with
    // `done` forced false the dialog kept Apply live, and a second click re-runs
    // a destructive chain over audio the first run already changed — the run
    // whose whole design is that it lands as ONE undo entry.
    expect(screen.getByTestId('vocal-chain-close')).toBeInTheDocument();
    expect(screen.queryByTestId('vocal-chain-apply')).toBeNull();
    expect(screen.queryByTestId('vocal-chain-cancel')).toBeNull();
    for (const stage of VOCAL_CHAIN_STAGES) {
      if (stage.effectId === null) continue;
      expect(screen.getByTestId(`vocal-chain-toggle-${stage.id}`)).toBeDisabled();
    }
  });

  it('names the stage currently running', async () => {
    seedDoc();
    let started: ((stage: (typeof VOCAL_CHAIN_STAGES)[number]) => void) | undefined;
    mockRun.mockImplementation(
      (opts) =>
        new Promise<VocalChainReport | null>(() => {
          started = opts.onStageStart;
        })
    );
    open();
    fireEvent.click(screen.getByTestId('vocal-chain-apply'));
    await waitFor(() => expect(started).toBeDefined());

    act(() => {
      started!(VOCAL_CHAIN_STAGES[0]);
    });
    expect(screen.getByTestId('vocal-chain-running')).toHaveTextContent(
      `Running ${VOCAL_CHAIN_STAGES[0].label}`
    );
  });
});
