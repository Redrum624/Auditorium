import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import CoverChainDialog from './CoverChainDialog';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import {
  COVER_CHAIN_CONFIRM_SENTENCE,
  COVER_CHAIN_GOOD_TAKE_SENTENCE,
  COVER_CHAIN_RESIDUAL_SENTENCE,
  COVER_CHAIN_SHAPING_SENTENCE,
  COVER_CHAIN_STAGES,
  runCoverChain,
  type CoverChainMetrics,
  type CoverChainReport,
  type CoverChainStageResult,
} from '../../services/coverChain';

// The STAGE TABLE stays real (requireActual): the dialog's whole contract is
// that it lists what the engine will actually run, in the engine's order, with
// the engine's own notes — a mocked stage list would let the two drift and the
// tests would still pass. Only the run itself is mocked.
jest.mock('../../services/coverChain', () => ({
  ...jest.requireActual('../../services/coverChain'),
  runCoverChain: jest.fn(),
}));

const mockRun = runCoverChain as jest.MockedFunction<typeof runCoverChain>;

const SR = 48000;

function seedDoc(name = 'take.wav', samples = SR * 4): AudioDocument {
  const doc = createDocument({ name, sampleRate: SR, channels: [new Float32Array(samples)] });
  useAppStore.getState().addDocument(doc);
  return doc;
}

function metrics(over: Partial<CoverChainMetrics> = {}): CoverChainMetrics {
  return {
    gatedLevelDb: -25.96,
    peakDb: -9.68,
    spreadDb: 13.62,
    noiseFloorDb: -50.4,
    matchDistanceDb: 2.1,
    ...over,
  };
}

/** A full stage list with `results` substituted in by id — so a fixture can
 * describe one stage's outcome without hand-writing the other eight. */
function stagesWith(...results: CoverChainStageResult[]): CoverChainStageResult[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  return COVER_CHAIN_STAGES.map(
    (s) =>
      byId.get(s.id) ?? {
        id: s.id,
        label: s.label,
        status: s.effectId === null ? 'manual' : 'off',
        derived: [],
      }
  );
}

function makeReport(overrides: Partial<CoverChainReport> = {}): CoverChainReport {
  return {
    before: metrics(),
    after: metrics({ gatedLevelDb: -16.35, peakDb: -0.3, matchDistanceDb: 0.4 }),
    reference: metrics({ gatedLevelDb: -16.35, peakDb: -1.2, matchDistanceDb: null }),
    referenceName: 'Scarlet Paintings — Vocals',
    stages: stagesWith(),
    sampleRate: SR,
    regionSamples: SR * 4,
    outputSamples: SR * 4,
    elapsedMs: 21400,
    applied: true,
    ...overrides,
  };
}

const APPLIED_EQ: CoverChainStageResult = {
  id: 'matchEq',
  label: 'Match EQ to the Original Vocal',
  status: 'applied',
  derived: [
    { label: 'Curve', value: '5 bands, -1.90 dB to +3.54 dB', from: 'the octave-band energy' },
    { label: 'Level removed', value: '+10.19 dB', from: 'the broadband difference' },
  ],
  delta: {
    rmsBeforeDb: -27.8,
    rmsAfterDb: -27.5,
    peakBeforeDb: -9.7,
    peakAfterDb: -9.4,
    identicalFraction: 0,
    differenceRmsDb: -34.2,
  },
  eq: {
    bands: [
      { centreHz: 250, status: 'below-range', targetDb: 0, realisedDb: 0.21, bandGainDb: 0, bounded: false },
      { centreHz: 500, status: 'matched', targetDb: 0.54, realisedDb: 0.54, bandGainDb: 0.31, bounded: false },
      { centreHz: 1000, status: 'matched', targetDb: -1.15, realisedDb: -1.15, bandGainDb: -1.02, bounded: false },
      { centreHz: 8000, status: 'matched', targetDb: 3.54, realisedDb: 3.54, bandGainDb: 3.29, bounded: true },
      { centreHz: 16000, status: 'above-nyquist', targetDb: 0, realisedDb: 0, bandGainDb: 0, bounded: false },
    ],
    levelDb: 10.19,
    worstErrorDb: 0.004,
    iterations: 3,
    clamped: false,
    matchedCount: 3,
  },
  elapsedMs: 8100,
};

const DECLINED_REVERB: CoverChainStageResult = {
  id: 'matchReverb',
  label: 'Match Reverb',
  status: 'declined',
  reason:
    'estimated decay 0.40 s (180 decays, quartiles 0.33–0.50 s); the shortest this reverb can produce is 0.71 s, so matching it would add more space than the original has',
  derived: [],
};

const WARNED_LOUDNESS: CoverChainStageResult = {
  id: 'matchLoudness',
  label: 'Match Loudness',
  status: 'applied',
  derived: [{ label: 'Gain', value: '+9.61 dB', from: "the reference's sounding level" }],
  warning:
    'this puts the peak at +0.93 dBFS, above full scale, and the Limiter stage that would catch it is switched off — the file will clip when it is written or played',
  delta: {
    rmsBeforeDb: -27.8,
    rmsAfterDb: -18.2,
    peakBeforeDb: -9.7,
    peakAfterDb: 0.93,
    identicalFraction: 0,
    differenceRmsDb: -18.0,
  },
  elapsedMs: 300,
};

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  mockRun.mockReset();
  mockRun.mockResolvedValue(makeReport());
});

describe('CoverChainDialog — before the run', () => {
  it('renders nothing without an active document', () => {
    const { container } = render(<CoverChainDialog onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists every stage the engine will run, in the engine\'s order, with its own note', () => {
    seedDoc();
    render(<CoverChainDialog onClose={() => {}} />);
    const ids = COVER_CHAIN_STAGES.map((s) => s.id);
    for (const stage of COVER_CHAIN_STAGES) {
      expect(screen.getByTestId(`cover-chain-stage-${stage.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`cover-chain-note-${stage.id}`)).toHaveTextContent(
        stage.note.slice(0, 40)
      );
    }
    // ORDER, not just membership: the stage cards appear in registry order.
    const rendered = Array.from(document.querySelectorAll('[data-testid^="cover-chain-stage-"]')).map(
      (el) => el.getAttribute('data-testid')!.replace('cover-chain-stage-', '')
    );
    expect(rendered).toEqual(ids);
  });

  it('offers a checkbox for every automatic stage and none for a manual one', () => {
    seedDoc();
    render(<CoverChainDialog onClose={() => {}} />);
    let toggles = 0;
    for (const stage of COVER_CHAIN_STAGES) {
      const toggle = screen.queryByTestId(`cover-chain-toggle-${stage.id}`);
      if (stage.effectId === null) {
        expect(toggle).toBeNull();
        expect(screen.getByTestId(`cover-chain-status-${stage.id}`)).toHaveTextContent('Manual step');
      } else {
        expect(toggle).not.toBeNull();
        toggles++;
      }
    }
    expect(toggles).toBe(4);
  });

  it('opens with the engine\'s own defaults ticked', () => {
    seedDoc();
    render(<CoverChainDialog onClose={() => {}} />);
    for (const stage of COVER_CHAIN_STAGES) {
      if (stage.effectId === null) continue;
      const toggle = screen.getByTestId(`cover-chain-toggle-${stage.id}`) as HTMLInputElement;
      expect(`${stage.id}=${toggle.checked}`).toBe(`${stage.id}=${stage.defaultEnabled}`);
    }
  });

  it('says the region it will run over', () => {
    seedDoc();
    render(<CoverChainDialog onClose={() => {}} />);
    expect(screen.getByTestId('cover-chain-scope')).toHaveTextContent('Whole file — 4.00 s');
    act(() => {
      useAppStore.setState({ selection: { start: 0, end: SR } });
    });
    render(<CoverChainDialog onClose={() => {}} />);
    expect(screen.getAllByTestId('cover-chain-scope')[1]).toHaveTextContent('Selection — 1.00 s');
  });
});

describe('CoverChainDialog — the reference picker', () => {
  it('offers every OTHER open document and starts with none chosen', () => {
    const take = seedDoc('take.wav');
    const vocals = seedDoc('Scarlet Paintings — Vocals');
    const bed = seedDoc('Scarlet Paintings — Other');
    useAppStore.setState({ activeDocumentId: take.id });
    render(<CoverChainDialog onClose={() => {}} />);

    const select = screen.getByTestId('cover-chain-reference') as HTMLSelectElement;
    expect(select.value).toBe('');
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(['', vocals.id, bed.id]);
    // The take itself is never a candidate — matching a recording to itself is
    // a no-op the user would have to diagnose.
    expect(values).not.toContain(take.id);
  });

  it('warns while nothing is chosen, and stops warning once it is', () => {
    const take = seedDoc('take.wav');
    const vocals = seedDoc('Scarlet Paintings — Vocals');
    useAppStore.setState({ activeDocumentId: take.id });
    render(<CoverChainDialog onClose={() => {}} />);

    expect(screen.getByTestId('cover-chain-no-reference')).toHaveTextContent('Separate Stems');
    fireEvent.change(screen.getByTestId('cover-chain-reference'), { target: { value: vocals.id } });
    expect(screen.queryByTestId('cover-chain-no-reference')).toBeNull();
  });

  it('passes the chosen reference to the engine, and null when none is chosen', async () => {
    const take = seedDoc('take.wav');
    const vocals = seedDoc('Scarlet Paintings — Vocals');
    useAppStore.setState({ activeDocumentId: take.id });
    // `applied: false` keeps the dialog open for the second run — a landed pass
    // locks the picker on purpose, which its own test pins.
    mockRun.mockResolvedValue(makeReport({ applied: false }));
    render(<CoverChainDialog onClose={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('cover-chain-apply'));
    });
    expect(mockRun.mock.calls[0][0].referenceDocId).toBeNull();

    mockRun.mockClear();
    fireEvent.change(screen.getByTestId('cover-chain-reference'), { target: { value: vocals.id } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('cover-chain-apply'));
    });
    expect(mockRun.mock.calls[0][0].referenceDocId).toBe(vocals.id);
  });
});

describe('CoverChainDialog — the honesty block (Rulings A, D, E)', () => {
  /**
   * A TOTAL, EXCLUSIVE classifier over every text in the dialog that states one
   * of the four measured caveats. v1.21.0's review named the failure this
   * guards: a phrase-shaped probe cannot catch a sentence containing two
   * phrases, and a substring sweep passes when a caveat is stated twice or not
   * at all. Every classified text must match EXACTLY ONE kind — zero or two is
   * a failure.
   */
  const KINDS = {
    residual: COVER_CHAIN_RESIDUAL_SENTENCE,
    shaping: COVER_CHAIN_SHAPING_SENTENCE,
    goodTake: COVER_CHAIN_GOOD_TAKE_SENTENCE,
    confirm: COVER_CHAIN_CONFIRM_SENTENCE,
  } as const;
  type Kind = keyof typeof KINDS;
  const ALL_KINDS: Kind[] = ['residual', 'shaping', 'goodTake', 'confirm'];

  function classify(text: string): Kind[] {
    return ALL_KINDS.filter((kind) => text.includes(KINDS[kind]));
  }

  it('enumerates four kinds, each a distinct sentence', () => {
    expect(ALL_KINDS).toHaveLength(4);
    expect(new Set(Object.values(KINDS)).size).toBe(4);
  });

  it('states each caveat exactly once in the block above the button', () => {
    seedDoc();
    render(<CoverChainDialog onClose={() => {}} />);
    const block: [string, Kind][] = [
      ['cover-chain-limitation', 'residual'],
      ['cover-chain-shaping', 'shaping'],
      ['cover-chain-good-take', 'goodTake'],
    ];
    for (const [testid, expected] of block) {
      const matches = classify(screen.getByTestId(testid).textContent ?? '');
      // EXACTLY one — a text matching none or two fails here.
      expect(`${testid}:${matches.join('+')}`).toBe(`${testid}:${expected}`);
    }
  });

  it('classifies every stage note that carries a caveat, and each carries one kind', () => {
    seedDoc();
    render(<CoverChainDialog onClose={() => {}} />);
    const carriers: Record<string, Kind> = {};
    for (const stage of COVER_CHAIN_STAGES) {
      const matches = classify(screen.getByTestId(`cover-chain-note-${stage.id}`).textContent ?? '');
      // A note carrying two caveats has had one pasted into it — the exact
      // defect the classifier exists to catch.
      expect(`${stage.id}:${matches.length}`).not.toBe(`${stage.id}:2`);
      if (matches.length === 1) carriers[stage.id] = matches[0];
    }
    expect(carriers).toEqual({
      separate: 'residual',
      lyrics: 'goodTake',
      timing: 'confirm',
      place: 'residual',
    });
  });

  it('puts the residual limitation above the Apply button, not below it', () => {
    seedDoc();
    render(<CoverChainDialog onClose={() => {}} />);
    const dialog = screen.getByTestId('cover-chain-dialog');
    const order = Array.from(dialog.querySelectorAll('[data-testid]')).map((el) =>
      el.getAttribute('data-testid')
    );
    expect(order.indexOf('cover-chain-limitation')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('cover-chain-limitation')).toBeLessThan(order.indexOf('cover-chain-apply'));
  });
});

describe('CoverChainDialog — the run and the report', () => {
  it('sends the tick state to the engine and disables Apply when nothing is ticked', async () => {
    seedDoc();
    render(<CoverChainDialog onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('cover-chain-toggle-matchReverb'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('cover-chain-apply'));
    });
    const sent = mockRun.mock.calls[0][0].enabled;
    expect(sent.matchEq).toBe(true);
    expect(sent.matchReverb).toBe(true);
  });

  it('disables Apply once every automatic stage is off', () => {
    seedDoc();
    render(<CoverChainDialog onClose={() => {}} />);
    for (const stage of COVER_CHAIN_STAGES) {
      if (stage.effectId === null || !stage.defaultEnabled) continue;
      fireEvent.click(screen.getByTestId(`cover-chain-toggle-${stage.id}`));
    }
    expect(screen.getByTestId('cover-chain-apply')).toBeDisabled();
  });

  it('shows the realised curve alongside the requested one, per band (Ruling B)', async () => {
    seedDoc();
    mockRun.mockResolvedValue(makeReport({ stages: stagesWith(APPLIED_EQ) }));
    render(<CoverChainDialog onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('cover-chain-apply'));
    });
    await waitFor(() => expect(screen.getByTestId('cover-chain-eq-table')).toBeInTheDocument());

    // Three columns, three quantities, and the gain is NOT the response —
    // which is the whole of Ruling B. On a pre-compensated band the wanted and
    // realised figures agree (that is what the solve is for) and BOTH differ
    // from the gain the EQ was handed.
    const row500 = within(screen.getByTestId('cover-chain-eq-row-500'));
    expect(row500.getAllByText('+0.54 dB')).toHaveLength(2); // wanted AND realised
    expect(row500.getAllByText('+0.31 dB')).toHaveLength(1); // the gain the EQ got
    expect(screen.getByTestId('cover-chain-eq-row-500').textContent).toBe(
      '500 Hz+0.54 dB+0.54 dB+0.31 dB'
    );

    // A band the match may not touch shows its LEAK rather than a blank: it
    // received no gain, and the audio still moved there.
    const row250 = screen.getByTestId('cover-chain-eq-row-250');
    expect(row250.textContent).toContain('below the measured range');
    expect(row250.textContent).toContain('+0.21 dB');
    expect(row250.textContent).toContain('+0.00 dB');

    expect(screen.getByTestId('cover-chain-eq-row-16000').textContent).toContain('above Nyquist');
    expect(screen.getByTestId('cover-chain-eq-row-8000').textContent).toContain('bounded');
    expect(screen.getByTestId('cover-chain-eq-row-500').textContent).not.toContain('bounded');
  });

  it('renders a declined stage\'s measured reason, and never as if it had run', async () => {
    seedDoc();
    mockRun.mockResolvedValue(makeReport({ stages: stagesWith(DECLINED_REVERB) }));
    render(<CoverChainDialog onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('cover-chain-apply'));
    });
    await waitFor(() => expect(screen.getByTestId('cover-chain-reason-matchReverb')).toBeInTheDocument());
    expect(screen.getByTestId('cover-chain-status-matchReverb')).toHaveTextContent('Did not run');
    expect(screen.getByTestId('cover-chain-reason-matchReverb')).toHaveTextContent('0.40 s');
    expect(screen.getByTestId('cover-chain-reason-matchReverb')).toHaveTextContent('0.71 s');
    expect(screen.queryByTestId('cover-chain-delta-matchReverb')).toBeNull();
    expect(screen.queryByTestId('cover-chain-derived-matchReverb')).toBeNull();
  });

  it('renders a warning on a stage that DID run (Ruling C), distinct from a refusal', async () => {
    seedDoc();
    mockRun.mockResolvedValue(makeReport({ stages: stagesWith(WARNED_LOUDNESS) }));
    render(<CoverChainDialog onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('cover-chain-apply'));
    });
    await waitFor(() => expect(screen.getByTestId('cover-chain-warning-matchLoudness')).toBeInTheDocument());
    expect(screen.getByTestId('cover-chain-status-matchLoudness')).toHaveTextContent('Ran');
    expect(screen.getByTestId('cover-chain-warning-matchLoudness')).toHaveTextContent('+0.93 dBFS');
    // It ran, so its measurements are there too — a warning is not a refusal.
    expect(screen.getByTestId('cover-chain-delta-matchLoudness')).toBeInTheDocument();
    expect(screen.queryByTestId('cover-chain-reason-matchLoudness')).toBeNull();
  });

  it('reports loudness, spread, floor and distance for the take AND the target', async () => {
    seedDoc();
    render(<CoverChainDialog onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('cover-chain-apply'));
    });
    await waitFor(() => expect(screen.getByTestId('cover-chain-summary')).toBeInTheDocument());

    const loudness = screen.getByTestId('cover-chain-summary-gatedLevelDb');
    expect(loudness).toHaveTextContent('-26.0 dBFS'); // before
    expect(loudness).toHaveTextContent('-16.4 dBFS'); // after AND target
    expect(screen.getByTestId('cover-chain-summary-spreadDb')).toHaveTextContent('13.6 dB');
    expect(screen.getByTestId('cover-chain-summary-noiseFloorDb')).toHaveTextContent('-50.4 dBFS');
    const distance = screen.getByTestId('cover-chain-summary-matchDistanceDb');
    expect(distance).toHaveTextContent('2.1 dB');
    expect(distance).toHaveTextContent('0.4 dB');
    // A quantity that has no meaning for the reference reads 'n/a', not 0.
    expect(distance).toHaveTextContent('n/a');
    expect(screen.getByTestId('cover-chain-summary')).toHaveTextContent('Scarlet Paintings — Vocals');
  });

  it('says the spread is reported and never corrected, with the sweep that decided it', async () => {
    seedDoc();
    render(<CoverChainDialog onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('cover-chain-apply'));
    });
    await waitFor(() => expect(screen.getByTestId('cover-chain-spread-note')).toBeInTheDocument());
    const note = screen.getByTestId('cover-chain-spread-note');
    expect(note).toHaveTextContent('changes sign');
    expect(note).toHaveTextContent('−9.7 dB');
  });

  it('names the single undo entry, and the new length when a stage grew the region', async () => {
    seedDoc();
    render(<CoverChainDialog onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('cover-chain-apply'));
    });
    await waitFor(() => expect(screen.getByTestId('cover-chain-outcome')).toBeInTheDocument());
    expect(screen.getByTestId('cover-chain-outcome')).toHaveTextContent('one undo entry (“Cover Chain”)');
    expect(screen.getByTestId('cover-chain-outcome')).not.toHaveTextContent('Region length');

    mockRun.mockResolvedValue(makeReport({ outputSamples: SR * 7 }));
    render(<CoverChainDialog onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('cover-chain-apply')[0]);
    });
    await waitFor(() =>
      expect(screen.getAllByTestId('cover-chain-outcome')[1]).toHaveTextContent(
        'Region length 4.00 s → 7.00 s'
      )
    );
  });

  it('says nothing was changed when no stage ran, and keeps Apply available', async () => {
    seedDoc();
    mockRun.mockResolvedValue(makeReport({ applied: false }));
    render(<CoverChainDialog onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('cover-chain-apply'));
    });
    await waitFor(() => expect(screen.getByTestId('cover-chain-outcome')).toBeInTheDocument());
    expect(screen.getByTestId('cover-chain-outcome')).toHaveTextContent('the document was not changed');
    expect(screen.getByTestId('cover-chain-apply')).toBeInTheDocument();
    expect(screen.queryByTestId('cover-chain-close')).toBeNull();
  });

  it('surfaces a failed run without claiming anything about the document', async () => {
    seedDoc();
    mockRun.mockResolvedValue(null);
    render(<CoverChainDialog onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('cover-chain-apply'));
    });
    await waitFor(() => expect(screen.getByTestId('cover-chain-error')).toBeInTheDocument());
    expect(screen.getByTestId('cover-chain-error')).toHaveTextContent('Nothing in the document was changed');
    expect(screen.queryByTestId('cover-chain-summary')).toBeNull();
  });

  it('locks the ticks and the picker once the pass has landed', async () => {
    const take = seedDoc('take.wav');
    seedDoc('Scarlet Paintings — Vocals');
    useAppStore.setState({ activeDocumentId: take.id });
    render(<CoverChainDialog onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('cover-chain-apply'));
    });
    await waitFor(() => expect(screen.getByTestId('cover-chain-close')).toBeInTheDocument());
    expect(screen.getByTestId('cover-chain-toggle-matchEq')).toBeDisabled();
    expect(screen.getByTestId('cover-chain-reference')).toBeDisabled();
  });

  it('shows the running stage and the progress the engine reports', async () => {
    seedDoc();
    let resolveRun: (r: CoverChainReport) => void = () => {};
    mockRun.mockImplementation((opts) => {
      opts.onStageStart?.(COVER_CHAIN_STAGES.find((s) => s.id === 'matchEq')!);
      opts.onProgress?.(0.42);
      return new Promise<CoverChainReport>((resolve) => {
        resolveRun = resolve;
      });
    });
    render(<CoverChainDialog onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('cover-chain-apply'));
    });
    expect(screen.getByTestId('cover-chain-running')).toHaveTextContent(
      'Running Match EQ to the Original Vocal'
    );
    expect(screen.getByTestId('cover-chain-progress')).toHaveStyle({ width: '42%' });
    await act(async () => {
      resolveRun(makeReport());
    });
  });
});
