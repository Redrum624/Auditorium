import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import VocalChainDialog from './VocalChainDialog';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import {
  STAGE_MEASURING_DETAIL,
  VOCAL_CHAIN_STAGES,
  defaultStageSelection,
  runVocalChain,
  type RunVocalChainOptions,
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

/** The reverb with the Limiter switched off: a stage that RAN and still needs
 * reading. The warning text is the engine's own sentence verbatim — invented
 * copy here would let the two drift and the dialog would still look right. */
const WARNED_REVERB: VocalChainStageResult = {
  id: 'reverb',
  label: 'Reverb',
  status: 'applied',
  warning:
    'this stage summed a tail on top of the audio and the output now peaks at +6.5 dBFS, above full scale. The Limiter — the only stage that runs after this one, and the one that would have caught it — is switched off, and both the WAV writer and the MP3 encoder hard-clip anything over full scale. Switch the Limiter on, or bring the level down before you export.',
  derived: [],
  delta: {
    rmsBeforeDb: -20.4,
    rmsAfterDb: -18.9,
    peakBeforeDb: -0.3,
    peakAfterDb: 6.53,
    identicalFraction: null,
    differenceRmsDb: null,
  },
  elapsedMs: 900,
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
      // The ON/OFF toggle specifically, by its own testid rather than by
      // counting checkboxes in the row: the gate row carries a SECOND tick —
      // the manual-threshold one, pinned by its own suite below — and a count
      // would read that as a duplicate switch.
      expect(within(row).queryAllByTestId(`vocal-chain-toggle-${stage.id}`)).toHaveLength(
        stage.effectId === null ? 0 : 1
      );
      // ...and no stage but the gate has any second control at all.
      expect(within(row).queryAllByRole('checkbox')).toHaveLength(
        stage.effectId === null ? 0 : stage.id === 'gate' ? 2 : 1
      );
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

/**
 * V2/R2 — the one setting in this dialog that comes from a person.
 *
 * The gate can legitimately fail to measure a threshold, and when it does the
 * user still wants their pauses silent. So the gate row carries a level they
 * can name; it is off until they ask for it, because a chain whose whole claim
 * is that nothing is set by taste must not open with a taste control armed.
 */
describe('VocalChainDialog — the gate threshold the user can set', () => {
  it('offers the box on the gate row and nowhere else, switched off', () => {
    seedDoc();
    open();
    expect(screen.getByTestId('vocal-chain-gate-manual')).not.toBeChecked();
    // No level input until it is asked for: an empty box beside a stage that
    // derives its own threshold reads as a setting the user forgot to fill in.
    expect(screen.queryByTestId('vocal-chain-gate-threshold')).toBeNull();
    for (const stage of VOCAL_CHAIN_STAGES) {
      if (stage.id === 'gate') continue;
      expect(screen.queryByTestId(`vocal-chain-${stage.id}-manual`)).toBeNull();
    }
  });

  it('sends nothing while it is off, however the rest of the dialog is used', async () => {
    seedDoc();
    open();
    fireEvent.click(screen.getByTestId('vocal-chain-toggle-reverb'));
    fireEvent.click(screen.getByTestId('vocal-chain-apply'));
    await waitFor(() => expect(mockRun).toHaveBeenCalledTimes(1));
    expect(mockRun.mock.calls[0][0].gateThresholdDb).toBeUndefined();
  });

  it('sends the level once it is switched on and typed', async () => {
    seedDoc();
    open();
    fireEvent.click(screen.getByTestId('vocal-chain-gate-manual'));
    const box = screen.getByTestId('vocal-chain-gate-threshold');
    fireEvent.change(box, { target: { value: '-42.5' } });
    fireEvent.click(screen.getByTestId('vocal-chain-apply'));
    await waitFor(() => expect(mockRun).toHaveBeenCalledTimes(1));
    expect(mockRun.mock.calls[0][0].gateThresholdDb).toBe(-42.5);
  });

  it('switching it back off drops the level rather than remembering it', async () => {
    seedDoc();
    open();
    fireEvent.click(screen.getByTestId('vocal-chain-gate-manual'));
    fireEvent.change(screen.getByTestId('vocal-chain-gate-threshold'), { target: { value: '-42.5' } });
    fireEvent.click(screen.getByTestId('vocal-chain-gate-manual'));
    fireEvent.click(screen.getByTestId('vocal-chain-apply'));
    await waitFor(() => expect(mockRun).toHaveBeenCalledTimes(1));
    expect(mockRun.mock.calls[0][0].gateThresholdDb).toBeUndefined();
  });

  it('a cleared box means NO level was named, rather than 0 dBFS', async () => {
    // `Number('')` is 0, and 0 dBFS is full scale: a box the user cleared used
    // to snap the state to a threshold that gates the entire take. Clearing is
    // how a person unsays a number, so it has to mean the number is unsaid.
    seedDoc();
    open();
    fireEvent.click(screen.getByTestId('vocal-chain-gate-manual'));
    const box = screen.getByTestId('vocal-chain-gate-threshold') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '-42.5' } });
    fireEvent.change(box, { target: { value: '' } });
    expect(box.value).toBe('');

    // ...and a level nobody named cannot be applied. The tick says the user
    // means to set the threshold themselves, so falling back to the derivation
    // would be the dialog quietly overruling them.
    expect(screen.getByTestId('vocal-chain-apply')).toBeDisabled();
    fireEvent.click(screen.getByTestId('vocal-chain-apply'));
    await act(async () => {});
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('says why Apply is unavailable while the box is empty, and takes it back when a level is typed', async () => {
    seedDoc();
    open();
    fireEvent.click(screen.getByTestId('vocal-chain-gate-manual'));
    const box = screen.getByTestId('vocal-chain-gate-threshold');
    fireEvent.change(box, { target: { value: '' } });
    expect(screen.getByTestId('vocal-chain-gate-threshold-missing')).toBeInTheDocument();

    fireEvent.change(box, { target: { value: '-38' } });
    expect(screen.queryByTestId('vocal-chain-gate-threshold-missing')).toBeNull();
    expect(screen.getByTestId('vocal-chain-apply')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('vocal-chain-apply'));
    await waitFor(() => expect(mockRun).toHaveBeenCalledTimes(1));
    expect(mockRun.mock.calls[0][0].gateThresholdDb).toBe(-38);
  });

  it('an empty box on a gate that is switched off blocks nothing', async () => {
    // The level and the stage are already untied for the disabled case; the
    // empty-box block has to follow the same rule, or a stale empty box would
    // hold the whole chain hostage over a stage that will not run.
    seedDoc();
    open();
    fireEvent.click(screen.getByTestId('vocal-chain-gate-manual'));
    fireEvent.change(screen.getByTestId('vocal-chain-gate-threshold'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('vocal-chain-toggle-gate'));
    expect(screen.getByTestId('vocal-chain-apply')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('vocal-chain-apply'));
    await waitFor(() => expect(mockRun).toHaveBeenCalledTimes(1));
    expect(mockRun.mock.calls[0][0].gateThresholdDb).toBeUndefined();
  });

  it('goes inert when the stage it belongs to is switched off', () => {
    // Otherwise the dialog offers a level for a stage that will not run, and
    // pressing Apply gates nothing while the row still shows a threshold.
    seedDoc();
    open();
    fireEvent.click(screen.getByTestId('vocal-chain-toggle-gate'));
    expect(screen.getByTestId('vocal-chain-toggle-gate')).not.toBeChecked();
    expect(screen.getByTestId('vocal-chain-gate-manual')).toBeDisabled();
  });

  it('carries the effect’s own range, so a level the gate cannot take is not offered', () => {
    seedDoc();
    open();
    fireEvent.click(screen.getByTestId('vocal-chain-gate-manual'));
    const box = screen.getByTestId('vocal-chain-gate-threshold');
    expect(box).toHaveAttribute('min', '-80');
    expect(box).toHaveAttribute('max', '0');
  });

  it('is greyed after a mixed run, which is the state the gate’s own refusal describes', async () => {
    // M4. The gate declined but the compressor applied, so `report.applied` is
    // true and the whole dialog is finished: the tick the refusal points at is
    // greyed, and the only button left is Close. This is not a bug to unlock —
    // the run landed as one undo entry and a second Apply over it would be a
    // second entry — it is the state the refusal's own text has to be true in,
    // which is why that text names the reopen. Pinned here so the two cannot
    // drift apart: if this lock is ever lifted, the copy is wrong.
    seedDoc();
    mockRun.mockResolvedValue(
      makeReport({
        applied: true,
        stages: stagesWith(APPLIED_COMPRESSOR, {
          id: 'gate',
          label: 'Noise Gate',
          status: 'declined',
          reason:
            'the quietest 500 ms carries the resonances of a vocal tract. If you can hear a gap that ought to be silent, set this stage’s threshold yourself: tick “Gate at a level I set instead” on the Vocal Chain’s Noise Gate row, type a level in dBFS and Apply — if the rest of the chain already applied, reopen Vocal Chain first. Nothing was gated',
          derived: [],
        }),
      })
    );
    open();
    fireEvent.click(screen.getByTestId('vocal-chain-apply'));
    await waitFor(() => expect(screen.getByTestId('vocal-chain-close')).toBeInTheDocument());
    expect(screen.getByTestId('vocal-chain-gate-manual')).toBeDisabled();
    expect(screen.queryByTestId('vocal-chain-apply')).toBeNull();
    expect(screen.getByTestId('vocal-chain-reason-gate')).toHaveTextContent('reopen Vocal Chain first');
  });

  it('is locked while the pass is running, like every other control here', async () => {
    seedDoc();
    let settle: (r: VocalChainReport) => void = () => {};
    mockRun.mockImplementation(() => new Promise<VocalChainReport>((r) => (settle = r)));
    open();
    fireEvent.click(screen.getByTestId('vocal-chain-gate-manual'));
    fireEvent.click(screen.getByTestId('vocal-chain-apply'));
    await waitFor(() => expect(screen.getByTestId('vocal-chain-gate-manual')).toBeDisabled());
    expect(screen.getByTestId('vocal-chain-gate-threshold')).toBeDisabled();
    await act(async () => {
      settle(makeReport());
    });
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

  it('renders a warning on a stage that DID run, distinct from a refusal and from a blank', async () => {
    seedDoc();
    mockRun.mockResolvedValue(makeReport({ stages: stagesWith(APPLIED_COMPRESSOR, WARNED_REVERB) }));
    open();
    fireEvent.click(screen.getByTestId('vocal-chain-apply'));

    await waitFor(() => expect(screen.getByTestId('vocal-chain-warning-reverb')).toBeInTheDocument());
    expect(screen.getByTestId('vocal-chain-status-reverb')).toHaveTextContent('Ran');
    expect(screen.getByTestId('vocal-chain-warning-reverb')).toHaveTextContent('+6.5 dBFS');
    expect(screen.getByTestId('vocal-chain-warning-reverb')).toHaveTextContent('above full scale');
    // It ran, so its measurements are there too — a warning is not a refusal,
    // and it does not replace what the stage reported.
    expect(screen.getByTestId('vocal-chain-delta-reverb')).toBeInTheDocument();
    expect(screen.queryByTestId('vocal-chain-reason-reverb')).toBeNull();
    // …and an applied stage with nothing to warn about renders no warning line.
    expect(screen.queryByTestId('vocal-chain-warning-compressor')).toBeNull();
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

  // ── The live stepper (P1) ─────────────────────────────────────────────────
  // "When doing a pipeline, I want to see all the steps from top to bottom and
  // what is happening in the current tool." The rows were already listed top to
  // bottom; what they had no way to say was WHICH one is running, how far
  // through it the run is, and what it is doing — the dialog knew only a single
  // overall fraction and a stage label.

  /** Everything the report block renders for one stage, tagged by test id.
   * Used to compare the LIVE rendering of a stage against the FINISHED one:
   * byte-identical is the claim, and it is a claim about the strings on screen
   * rather than about which helper produced them. */
  function resultTextOf(id: string): string[] {
    return [
      ...screen.queryAllByTestId(`vocal-chain-derived-${id}`),
      ...screen.queryAllByTestId(`vocal-chain-detail-${id}`),
      ...screen.queryAllByTestId(`vocal-chain-delta-${id}`),
      ...screen.queryAllByTestId(`vocal-chain-warning-${id}`),
      ...screen.queryAllByTestId(`vocal-chain-reason-${id}`),
    ].map((el) => `${el.getAttribute('data-testid')}=${el.textContent}`);
  }

  interface Captured {
    resolve: (value: VocalChainReport | null) => void;
    onStageProgress?: RunVocalChainOptions['onStageProgress'];
    onStageResult?: RunVocalChainOptions['onStageResult'];
  }

  /** Presses Apply against a run that will not resolve until the test says so,
   * handing back the callbacks the dialog passed in. */
  async function startRun(): Promise<Captured> {
    const captured = { resolve: () => {} } as Captured;
    mockRun.mockImplementation(
      (opts) =>
        new Promise<VocalChainReport | null>((resolve) => {
          captured.resolve = resolve;
          captured.onStageProgress = opts.onStageProgress;
          captured.onStageResult = opts.onStageResult;
        })
    );
    open();
    fireEvent.click(screen.getByTestId('vocal-chain-apply'));
    await waitFor(() => expect(captured.onStageProgress).toBeDefined());
    return captured;
  }

  it('lists EVERY stage with a live state from the moment Apply is pressed', async () => {
    seedDoc();
    await startRun();

    const steps = screen.getAllByTestId(/^vocal-chain-step-/);
    expect(steps.map((s) => s.getAttribute('data-testid'))).toEqual(
      VOCAL_CHAIN_STAGES.map((s) => `vocal-chain-step-${s.id}`)
    );
    // Before anything has reported: the manual stages say so, the stages the
    // user switched off say so, and everything else is waiting its turn. None
    // of them is blank, which is what the row said during a run until now.
    for (const stage of VOCAL_CHAIN_STAGES) {
      const step = screen.getByTestId(`vocal-chain-step-${stage.id}`);
      const expected =
        stage.effectId === null ? 'manual' : stage.defaultEnabled ? 'pending' : 'off';
      expect(step).toHaveAttribute('data-state', expected);
    }
    // …and the fixture reaches all three, so this cannot pass by listing one.
    const states = steps.map((s) => s.getAttribute('data-state'));
    expect(new Set(states)).toEqual(new Set(['manual', 'pending', 'off']));
  });

  it('highlights the stage that is running, with what it is doing and how far through it is', async () => {
    seedDoc();
    const run = await startRun();

    act(() =>
      run.onStageProgress!({
        stageId: 'noise',
        label: 'Noise Reduction',
        phase: 'measuring',
        stageFraction: 0,
        detail: STAGE_MEASURING_DETAIL,
      })
    );
    expect(screen.getByTestId('vocal-chain-step-noise')).toHaveAttribute('data-state', 'running');
    // Only one row runs at a time — the stage before it in the order has not
    // reported yet, so it must not also read as running.
    expect(screen.getByTestId('vocal-chain-step-dc')).toHaveAttribute('data-state', 'pending');
    expect(screen.getByTestId('vocal-chain-activity-noise')).toHaveTextContent(STAGE_MEASURING_DETAIL);

    act(() =>
      run.onStageProgress!({
        stageId: 'noise',
        label: 'Noise Reduction',
        phase: 'rendering',
        stageFraction: 0.42,
        detail: 'Noise print: 12.3 s, -61.2 dBFS',
      })
    );
    const step = screen.getByTestId('vocal-chain-step-noise');
    // The FRACTION is on screen, not merely in the props: a per-stage bar that
    // never moves is the defect the overall bar already had.
    expect(step).toHaveTextContent('42%');
    expect(screen.getByTestId('vocal-chain-activity-noise')).toHaveTextContent(
      'Noise print: 12.3 s, -61.2 dBFS'
    );
    expect(screen.getByTestId('vocal-chain-stage-progress-noise')).toHaveStyle({ width: '42%' });
  });

  it("settles a finished stage to done, showing the REPORT's own strings for it mid-run", async () => {
    seedDoc();
    // One report object, used for both halves of the comparison: the object fed
    // to the live callback is the object the finished report carries, exactly
    // as the engine hands it over.
    const report = makeReport({ stages: stagesWith(APPLIED_COMPRESSOR, DECLINED_HUM) });
    const run = await startRun();

    for (const id of ['compressor', 'hum'] as const) {
      act(() => run.onStageResult!(report.stages.find((s) => s.id === id)!));
    }
    expect(screen.getByTestId('vocal-chain-step-compressor')).toHaveAttribute('data-state', 'done');
    expect(screen.getByTestId('vocal-chain-step-hum')).toHaveAttribute('data-state', 'declined');

    const liveCompressor = resultTextOf('compressor');
    const liveHum = resultTextOf('hum');
    expect(liveCompressor.length).toBeGreaterThan(0);
    expect(liveHum.length).toBeGreaterThan(0);

    await act(async () => run.resolve(report));

    // BYTE-IDENTICAL to what the finished report renders. Not "contains the
    // same numbers" — a live line that rounded differently, or dropped the
    // "from" clause, or invented its own phrasing for the same measurement
    // would pass a looser assertion and would be a second set of strings to
    // keep in step with the report.
    expect(resultTextOf('compressor')).toEqual(liveCompressor);
    expect(resultTextOf('hum')).toEqual(liveHum);
    // And the live rows are gone: the finished view is the report, unchanged.
    expect(screen.queryAllByTestId(/^vocal-chain-step-/)).toHaveLength(0);
    expect(screen.getByTestId('vocal-chain-status-compressor')).toHaveTextContent('Ran');
  });

  it('dims what has not run yet and does not dim what is running', async () => {
    seedDoc();
    const run = await startRun();
    act(() =>
      run.onStageProgress!({
        stageId: 'dc',
        label: 'Remove DC Offset',
        phase: 'rendering',
        stageFraction: 0.5,
        detail: 'x',
      })
    );
    expect(screen.getByTestId('vocal-chain-stage-dc')).toHaveStyle({ opacity: '1' });
    expect(screen.getByTestId('vocal-chain-stage-pitch')).toHaveStyle({ opacity: '0.55' });
  });

  it('shows NOTHING from a run that failed — a half-reported pass is not a report', async () => {
    seedDoc();
    const report = makeReport({ stages: stagesWith(APPLIED_COMPRESSOR) });
    const run = await startRun();
    act(() => run.onStageResult!(report.stages.find((s) => s.id === 'compressor')!));
    expect(resultTextOf('compressor').length).toBeGreaterThan(0);

    // The engine resolves null when a stage fails: it rolls the document back
    // and nothing was applied. The stages that HAD reported before the failure
    // must not be left on screen looking like an outcome.
    await act(async () => run.resolve(null));
    expect(screen.getByTestId('vocal-chain-error')).toBeInTheDocument();
    expect(resultTextOf('compressor')).toEqual([]);
    expect(screen.queryAllByTestId(/^vocal-chain-step-/)).toHaveLength(0);
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

    // Before any stage has started, the foot caption already says what its bar
    // measures — the row bars do not exist yet, and neither does a stage name.
    expect(screen.getByTestId('vocal-chain-running')).toHaveTextContent('Whole pass');

    act(() => {
      started!(VOCAL_CHAIN_STAGES[0]);
    });
    // The foot bar is named as the WHOLE PASS, and that naming is load-bearing
    // rather than decorative: the highlighted row carries its own bar at its
    // own fraction, and the two legitimately disagree — a stage half way
    // through ITSELF while the pass is 41 % through the chain. With both
    // captions reading "Running <stage>…" the difference reads as a bug in one
    // of them.
    expect(screen.getByTestId('vocal-chain-running')).toHaveTextContent(
      `Whole pass — running ${VOCAL_CHAIN_STAGES[0].label}`
    );
  });
});
