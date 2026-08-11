import { render, screen, fireEvent, act, within } from '@testing-library/react';
import RemixPanel from './RemixPanel';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import {
  MAX_LOCKED_JOINS,
  clearAllRemix,
  getRemixSession,
  nudgeJoin,
  reRollRemix,
  rejectJoin,
  resetRemix,
  toggleLockJoin,
  updateRemixSession,
  type RemixSession,
} from '../../services/remixService';
import { DEFAULT_REMIX_WEIGHTS, type JoinCostTerms } from '../../dsp/remixCost';
import type { RemixJoin } from '../../dsp/remixPlan';
import type { RemixPlan } from '../../dsp/remixRender';
import type { RemixAnalysis } from '../../services/tempoAnalysis';

// The MarkersPanel.test.tsx / RemixDialog.test.tsx pattern: everything pure
// stays REAL via requireActual — crucially `useRemixVersion` and the module's
// own version counter, because the panel's reactivity IS the thing under test
// (acceptance 11). Only the session read and the six adjustment entry points
// are swapped for controllable mocks.
jest.mock('../../services/remixService', () => ({
  ...jest.requireActual('../../services/remixService'),
  getRemixSession: jest.fn(),
  rejectJoin: jest.fn(),
  nudgeJoin: jest.fn(),
  reRollRemix: jest.fn(),
  resetRemix: jest.fn(),
  updateRemixSession: jest.fn(),
  toggleLockJoin: jest.fn(),
}));

const mockGetSession = getRemixSession as jest.MockedFunction<typeof getRemixSession>;
const mockRejectJoin = rejectJoin as jest.MockedFunction<typeof rejectJoin>;
const mockNudgeJoin = nudgeJoin as jest.MockedFunction<typeof nudgeJoin>;
const mockReRoll = reRollRemix as jest.MockedFunction<typeof reRollRemix>;
const mockReset = resetRemix as jest.MockedFunction<typeof resetRemix>;
const mockUpdate = updateRemixSession as jest.MockedFunction<typeof updateRemixSession>;
const mockToggleLock = toggleLockJoin as jest.MockedFunction<typeof toggleLockJoin>;

const SR = 44100;

/** Distinct per-term values so a tooltip assertion cannot pass by accident. */
function terms(total: number): JoinCostTerms {
  return {
    timbre: 0.11,
    chroma: 0.22,
    loudness: 0.33,
    rhythm: 0.44,
    struct: 0.55,
    phrase: 0.66,
    total,
  };
}

function makeJoin(fromBar: number, toBar: number, total = 0.31): RemixJoin {
  return { fromBar, toBar, cost: terms(total) };
}

function makePlan(joins: RemixJoin[]): RemixPlan {
  return {
    ok: true,
    segments: [],
    joins,
    outputSample: 152 * SR, // 2:32
    targetSample: 150 * SR, // 2:30
    totalCost: 1.5,
    minOutputSample: 60 * SR,
    maxOutputSample: 300 * SR,
    maxBarUse: 1,
    canReroll: joins.length > 0,
  };
}

/** Only the fields the panel reads — building a real 64-bar analysis here would
 * test `remixFeatures`, not this component. `beatSamples` IS one of them: the
 * crossfade readout derives the renderer's quarter-beat cap from it, so it has
 * to be a real grid at `bpm` rather than a placeholder. */
function makeAnalysis(bpm = 124): RemixAnalysis {
  const period = Math.round((60 / bpm) * SR);
  return {
    bpm,
    beatsPerBar: 4,
    numBars: 64,
    beatSamples: Int32Array.from({ length: 64 }, (_, i) => i * period),
  } as unknown as RemixAnalysis;
}

function makeSession(
  remixDocId: string,
  joins: RemixJoin[],
  over: Partial<RemixSession> = {}
): RemixSession {
  return {
    remixDocId,
    sourceDocId: 'doc-source',
    sourceName: 'Song.wav',
    options: {
      targetSample: 150 * SR,
      phraseBars: 8,
      strict: true,
      allowRepeats: true,
      crossfadeMs: 25,
      exactLength: false,
      markEditPoints: true,
      weights: DEFAULT_REMIX_WEIGHTS,
      maxRepeatFactor: 3,
    },
    analysis: makeAnalysis(),
    plan: makePlan(joins),
    // Ascending by construction — `renderRemix` emits join centres in output
    // order — and 10 s apart so every row's time readout is distinct.
    joinSamples: joins.map((_, i) => (i + 1) * 10 * SR),
    nudgeSamples: joins.map(() => 0),
    rhos: joins.map(() => 0.5),
    shapes: joins.map(() => 'centred' as const),
    rejectedJoins: [],
    lockedJoins: [],
    lockedJoinsDropped: [],
    pinReport: null,
    rollIndex: 0,
    manual: false,
    plansInWorker: false,
    stale: false,
    ...over,
  };
}

function addRemixDoc(name = 'Remix 1'): AudioDocument {
  const doc = createDocument({
    name,
    sampleRate: SR,
    channels: [new Float32Array(1000)],
  });
  useAppStore.getState().addDocument(doc);
  return doc;
}

/** The six joins used by most tests: `#1` is `16>24`. */
const SIX_JOINS = [
  makeJoin(16, 24),
  makeJoin(32, 40),
  makeJoin(48, 8),
  makeJoin(56, 64),
  makeJoin(72, 80),
  makeJoin(88, 96),
];

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  jest.clearAllMocks();
  mockGetSession.mockReturnValue(null);
  mockRejectJoin.mockResolvedValue(null);
  mockNudgeJoin.mockResolvedValue(null);
  mockReRoll.mockResolvedValue(null);
  mockReset.mockResolvedValue(null);
  mockUpdate.mockResolvedValue(null);
  mockToggleLock.mockReturnValue({ ok: true, locked: true, lockedJoins: [] });
});

afterEach(() => {
  // The real version counter is shared module state; leave it advanced but
  // drop any listener bookkeeping the panel installed.
  act(() => clearAllRemix());
});

describe('RemixPanel — empty state (acceptance 1)', () => {
  it('shows the empty-state text and no rows when there is no session', () => {
    addRemixDoc();
    render(<RemixPanel />);

    expect(screen.getByText(/no remix for this document/i)).toBeInTheDocument();
    expect(screen.queryAllByTestId('remix-item')).toHaveLength(0);
    expect(screen.queryByTestId('remix-list')).not.toBeInTheDocument();
  });

  it('shows the empty-state text when no document is open at all', () => {
    render(<RemixPanel />);
    expect(screen.getByText(/no remix for this document/i)).toBeInTheDocument();
  });
});

describe('RemixPanel — rows (acceptance 2)', () => {
  it('renders exactly one row per join, in ascending atSample order', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS));

    render(<RemixPanel />);

    const rows = screen.getAllByTestId('remix-item');
    expect(rows).toHaveLength(6);

    // The Go-To button carries each join's own output time; reading them in
    // DOM order proves the rows are in ascending atSample order.
    const times = rows.map((row) => within(row).getByRole('button', { name: /go to edit/i }).textContent);
    expect(times).toEqual(['0:10', '0:20', '0:30', '0:40', '0:50', '1:00']);
  });

  it('renders the identity line for a join: index, bar span, bar delta and cost', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, [makeJoin(16, 24, 0.31)]));

    render(<RemixPanel />);

    const row = screen.getByTestId('remix-item');
    expect(row).toHaveTextContent('#1');
    expect(row).toHaveTextContent('bar 16 → 24');
    expect(row).toHaveTextContent('−8 bars'); // jumping forward removes 8 bars
    expect(row).toHaveTextContent('0.31');
  });

  it('reports a backwards join (a repeat) as adding bars', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, [makeJoin(48, 8)]));

    render(<RemixPanel />);
    expect(screen.getByTestId('remix-item')).toHaveTextContent('+40 bars');
  });

  it('renders the header summary from the session', () => {
    const doc = addRemixDoc('Remix 1');
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS));

    render(<RemixPanel />);

    const header = screen.getByTestId('remix-header');
    expect(header).toHaveTextContent('Remix 1 · 2:32 (target 2:30)');
    expect(header).toHaveTextContent('124 BPM · 4/4 · 6 edits · from Song.wav');
  });

  it('keeps the "from" name after the source document is gone', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS, { stale: true }));

    render(<RemixPanel />);
    expect(screen.getByTestId('remix-header')).toHaveTextContent('from Song.wav');
  });

  it('renders a zero-join arrangement with no rows, "0 edits" and Re-roll disabled', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, []));

    render(<RemixPanel />);

    expect(screen.queryAllByTestId('remix-item')).toHaveLength(0);
    expect(screen.getByTestId('remix-header')).toHaveTextContent('0 edits');
    expect(screen.getByRole('button', { name: /re-roll/i })).toBeDisabled();
    // Revert to auto still means something: it clears rejections and rolls.
    expect(screen.getByRole('button', { name: /revert to auto/i })).toBeEnabled();
  });
});

describe('RemixPanel — quality dot (acceptance 3 and 4)', () => {
  it('colours the dot by cost, at the exact thresholds', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(
      makeSession(doc.id, [
        makeJoin(8, 16, 0.59),
        makeJoin(24, 32, 0.6),
        makeJoin(40, 48, 1.19),
        makeJoin(56, 64, 1.2),
      ])
    );

    render(<RemixPanel />);

    const dots = screen.getAllByTestId('remix-quality');
    expect(dots).toHaveLength(4);
    expect(dots[0]).toHaveClass('bg-[#66bb6a]'); // 0.59 -> green
    expect(dots[1]).toHaveClass('bg-[#ffa726]'); // 0.60 -> amber
    expect(dots[2]).toHaveClass('bg-[#ffa726]'); // 1.19 -> amber
    expect(dots[3]).toHaveClass('bg-[#ef5350]'); // 1.20 -> red
  });

  it('breaks the cost into all six terms in the dot tooltip', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, [makeJoin(16, 24, 0.31)]));

    render(<RemixPanel />);

    const tooltip = screen.getByTestId('remix-quality').getAttribute('title') ?? '';
    for (const [label, value] of [
      ['timbre', '0.11'],
      ['chroma', '0.22'],
      ['level', '0.33'],
      ['rhythm', '0.44'],
      ['structure', '0.55'],
      ['phrase', '0.66'],
    ]) {
      expect(tooltip).toContain(label);
      expect(tooltip).toContain(value);
    }
    expect(tooltip).toContain('0.31'); // the total, too
  });
});

describe('RemixPanel — Go To (acceptance 5)', () => {
  it('sets the cursor to the join sample and re-centres the viewport', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS));
    useAppStore.setState({ zoom: { samplesPerPixel: 20, scrollSample: 0 } });

    render(<RemixPanel />);
    fireEvent.click(screen.getAllByRole('button', { name: /go to edit/i })[0]);

    const state = useAppStore.getState();
    expect(state.cursorSample).toBe(10 * SR);
    expect(state.zoom.scrollSample).toBe(10 * SR - 20 * 400);
    expect(state.zoom.samplesPerPixel).toBe(20);
  });

  it('ALSO leaves multitrack view, so Go To is never a silent no-op', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS));
    useAppStore.setState({ view: 'multitrack' });

    render(<RemixPanel />);
    fireEvent.click(screen.getAllByRole('button', { name: /go to edit/i })[1]);

    const state = useAppStore.getState();
    expect(state.view).toBe('waveform');
    expect(state.cursorSample).toBe(20 * SR);
  });

  it('clamps the scroll position at the start of the document', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(
      makeSession(doc.id, [makeJoin(16, 24)], { joinSamples: [100] })
    );
    useAppStore.setState({ zoom: { samplesPerPixel: 20, scrollSample: 5000 } });

    render(<RemixPanel />);
    fireEvent.click(screen.getByRole('button', { name: /go to edit/i }));

    expect(useAppStore.getState().zoom.scrollSample).toBe(0);
  });
});

describe('RemixPanel — reject (acceptance 6)', () => {
  it('calls rejectJoin with the row key exactly once', async () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS));

    render(<RemixPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reject edit 1/i }));
    });

    expect(mockRejectJoin).toHaveBeenCalledTimes(1);
    expect(mockRejectJoin).toHaveBeenCalledWith(doc.id, '16>24');
  });

  it('rejects the row that was clicked, not the first row', async () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS));

    render(<RemixPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reject edit 3/i }));
    });

    expect(mockRejectJoin).toHaveBeenCalledWith(doc.id, '48>8');
  });
});

describe('RemixPanel — nudge (acceptance 7)', () => {
  it('calls nudgeJoin with -1 and +1 for the row key', async () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS));

    render(<RemixPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /nudge edit 2 earlier/i }));
    });
    expect(mockNudgeJoin).toHaveBeenCalledWith(doc.id, '32>40', -1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /nudge edit 2 later/i }));
    });
    expect(mockNudgeJoin).toHaveBeenCalledWith(doc.id, '32>40', 1);
    expect(mockNudgeJoin).toHaveBeenCalledTimes(2);
  });
});

describe('RemixPanel — pin (acceptance 8)', () => {
  it('calls toggleLockJoin with the row key', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS));

    render(<RemixPanel />);
    fireEvent.click(screen.getByRole('button', { name: /^pin edit 1$/i }));

    expect(mockToggleLock).toHaveBeenCalledTimes(1);
    expect(mockToggleLock).toHaveBeenCalledWith(doc.id, '16>24');
  });

  it('labels an already-pinned join as Unpin and leaves it enabled at the cap', () => {
    const doc = addRemixDoc();
    const locked = ['16>24', 'a>b', 'c>d', 'e>f', 'g>h', 'i>j', 'k>l', 'm>n'];
    expect(locked).toHaveLength(MAX_LOCKED_JOINS);
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS, { lockedJoins: locked }));

    render(<RemixPanel />);

    // Un-pinning must always be possible — that is how the user gets back
    // under the cap.
    expect(screen.getByRole('button', { name: /unpin edit 1/i })).toBeEnabled();
  });

  it('disables the pin button with an explanatory tooltip once the cap is reached', () => {
    const doc = addRemixDoc();
    const locked = ['a>b', 'c>d', 'e>f', 'g>h', 'i>j', 'k>l', 'm>n', 'o>p'];
    expect(locked).toHaveLength(MAX_LOCKED_JOINS);
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS, { lockedJoins: locked }));

    render(<RemixPanel />);

    const pin = screen.getByRole('button', { name: /^pin edit 1$/i });
    expect(pin).toBeDisabled();
    expect(pin.getAttribute('title') ?? '').toMatch(new RegExp(`${MAX_LOCKED_JOINS}`));
    expect(pin.getAttribute('title') ?? '').toMatch(/pin/i);
  });

  it('surfaces a limit-reached refusal from the service rather than failing silently', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS));
    mockToggleLock.mockReturnValue({ ok: false, reason: 'limit-reached' });

    render(<RemixPanel />);
    fireEvent.click(screen.getByRole('button', { name: /^pin edit 1$/i }));

    expect(screen.getByTestId('remix-lock-note')).toHaveTextContent(
      new RegExp(`${MAX_LOCKED_JOINS}`)
    );
  });

  it('words the pin control as a preference, never as a guarantee', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS));

    render(<RemixPanel />);
    const title = screen.getByRole('button', { name: /^pin edit 1$/i }).getAttribute('title') ?? '';
    expect(title).toMatch(/preference/i);
    expect(title).toMatch(/not a guarantee/i);
  });

  it('says so when the planner could not keep a pin', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(
      makeSession(doc.id, SIX_JOINS, { lockedJoins: ['16>24', '99>100'], lockedJoinsDropped: ['99>100'] })
    );

    render(<RemixPanel />);
    expect(screen.getByTestId('remix-dropped-pins')).toHaveTextContent(/1 pinned edit/i);
  });

  it('shows no dropped-pin note when every pin was kept', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS, { lockedJoins: ['16>24'] }));

    render(<RemixPanel />);
    expect(screen.queryByTestId('remix-dropped-pins')).not.toBeInTheDocument();
  });
});

describe('RemixPanel — header actions (acceptance 9)', () => {
  it('Re-roll calls reRollRemix and Revert to auto calls resetRemix', async () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS));

    render(<RemixPanel />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /re-roll/i }));
    });
    expect(mockReRoll).toHaveBeenCalledWith(doc.id);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /revert to auto/i }));
    });
    expect(mockReset).toHaveBeenCalledWith(doc.id);
  });

  it('disables Re-roll when every join is pinned (the service would refuse)', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(
      makeSession(doc.id, SIX_JOINS, { lockedJoins: SIX_JOINS.map((j) => `${j.fromBar}>${j.toBar}`) })
    );

    render(<RemixPanel />);
    expect(screen.getByRole('button', { name: /re-roll/i })).toBeDisabled();
  });

  it('states the History cost of an adjustment instead of hiding it', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS));

    render(<RemixPanel />);
    const hint = screen.getByTestId('remix-undo-hint').getAttribute('title') ?? '';
    expect(hint).toMatch(/remix markers/i);
    expect(hint).toMatch(/ctrl\+z/i);
  });

  it('commits the crossfade slider on release only — never on every drag tick', async () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS));

    render(<RemixPanel />);
    const slider = screen.getByTestId('remix-crossfade');

    fireEvent.change(slider, { target: { value: '60' } });
    expect(mockUpdate).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.mouseUp(slider);
    });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(doc.id, { crossfadeMs: 60 });
  });

  // Defect 4a: `renderRemix` clamps the requested width to a quarter of the
  // median beat period, so above ~125 BPM the top of this 5-120 ms slider is
  // silently clipped. The readout must say so.
  it('shows the width actually applied when the quarter-beat cap bites (150 BPM, 120 ms requested -> 100 ms)', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(
      makeSession(doc.id, SIX_JOINS, {
        analysis: makeAnalysis(150),
        options: { ...makeSession(doc.id, SIX_JOINS).options, crossfadeMs: 120 },
      })
    );

    render(<RemixPanel />);
    expect(screen.getByTestId('remix-crossfade-readout')).toHaveTextContent('120 → 100 ms');
    expect(screen.getByTestId('remix-crossfade-capped')).toHaveTextContent(/100 ms/);
  });

  it('does NOT cry wolf when the request fits under the cap', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS)); // 124 BPM, 25 ms

    render(<RemixPanel />);
    expect(screen.getByTestId('remix-crossfade-readout')).toHaveTextContent('25 ms');
    expect(screen.queryByTestId('remix-crossfade-capped')).toBeNull();
  });

  it('updates the effective readout live while dragging, before the release commits', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS, { analysis: makeAnalysis(150) }));

    render(<RemixPanel />);
    fireEvent.change(screen.getByTestId('remix-crossfade'), { target: { value: '120' } });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(screen.getByTestId('remix-crossfade-readout')).toHaveTextContent('120 → 100 ms');
  });
});

describe('RemixPanel — staleness (acceptance 10)', () => {
  it('renders the banner and disables every ADJUSTMENT control', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS, { stale: true }));

    render(<RemixPanel />);

    expect(
      screen.getByText(/source audio changed — adjustments unavailable\. the remix audio is unaffected\./i)
    ).toBeInTheDocument();

    // Every button that would reject / pin / nudge / re-roll / revert — i.e.
    // everything except Go To, which mutates nothing (see below).
    const adjustments = screen
      .getAllByRole('button')
      .filter((b) => !/^go to edit/i.test(b.getAttribute('aria-label') ?? ''));
    expect(adjustments).toHaveLength(6 * 4 + 2); // 4 row controls x 6 joins, + Re-roll and Revert
    for (const button of adjustments) expect(button).toBeDisabled();
    expect(screen.getByTestId('remix-crossfade')).toBeDisabled();
  });

  it('KEEPS Go To enabled while stale — the session degrades to read-only, not inert', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS, { stale: true }));
    useAppStore.setState({ zoom: { samplesPerPixel: 20, scrollSample: 0 } });

    render(<RemixPanel />);

    // Asserted POSITIVELY so a future change cannot quietly re-disable it: the
    // banner says the remix audio is unaffected, and auditioning the splices
    // of the remix you already have is the one thing still worth doing here.
    const goTos = screen.getAllByRole('button', { name: /go to edit/i });
    expect(goTos).toHaveLength(6);
    for (const button of goTos) expect(button).toBeEnabled();

    fireEvent.click(goTos[0]);
    expect(useAppStore.getState().cursorSample).toBe(10 * SR);
    expect(useAppStore.getState().zoom.scrollSample).toBe(10 * SR - 20 * 400);
  });

  it('still applies the multitrack guard on the stale path', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS, { stale: true }));
    useAppStore.setState({ view: 'multitrack' });

    render(<RemixPanel />);
    fireEvent.click(screen.getAllByRole('button', { name: /go to edit/i })[1]);

    // Without the guard a stale-session Go To in multitrack view would be
    // exactly the silent no-op the guard exists to prevent.
    expect(useAppStore.getState().view).toBe('waveform');
    expect(useAppStore.getState().cursorSample).toBe(20 * SR);
  });

  it('fires no adjustment when a disabled control is clicked while stale', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS, { stale: true }));

    render(<RemixPanel />);
    fireEvent.click(screen.getByRole('button', { name: /reject edit 1/i }));
    fireEvent.click(screen.getByRole('button', { name: /^pin edit 1$/i }));
    fireEvent.click(screen.getByRole('button', { name: /re-roll/i }));

    expect(mockRejectJoin).not.toHaveBeenCalled();
    expect(mockToggleLock).not.toHaveBeenCalled();
    expect(mockReRoll).not.toHaveBeenCalled();
  });

  it('does not render the banner for a live session', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS));

    render(<RemixPanel />);
    expect(screen.queryByTestId('remix-stale')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject edit 1/i })).toBeEnabled();
  });
});

describe('RemixPanel — module-state reactivity (acceptance 11)', () => {
  it('re-renders on a remix version bump with no zustand change at all', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, [makeJoin(16, 24), makeJoin(32, 40)]));

    render(<RemixPanel />);
    expect(screen.getAllByTestId('remix-item')).toHaveLength(2);

    const zustandBefore = useAppStore.getState();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS));

    // `clearAllRemix` is the real (unmocked) implementation and its only
    // observable effect here is `bumpVersion()` — nothing in the zustand store
    // moves.
    act(() => clearAllRemix());

    expect(screen.getAllByTestId('remix-item')).toHaveLength(6);
    expect(screen.getByTestId('remix-header')).toHaveTextContent('6 edits');
    expect(useAppStore.getState()).toBe(zustandBefore);
  });

  it('unsubscribes on unmount (a later bump must not re-render a dead panel)', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS));

    const { unmount } = render(<RemixPanel />);
    unmount();

    mockGetSession.mockClear();
    act(() => clearAllRemix());
    expect(mockGetSession).not.toHaveBeenCalled();
  });
});

describe('RemixPanel — an adjustment in flight', () => {
  it('does not fire a second adjustment while one is outstanding', async () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS));

    let release: (() => void) | undefined;
    mockReRoll.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve(null);
      })
    );

    render(<RemixPanel />);
    fireEvent.click(screen.getByRole('button', { name: /re-roll/i }));

    // Every adjustment control is disabled while the plan is outstanding...
    expect(screen.getByRole('button', { name: /re-roll/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /revert to auto/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /reject edit 1/i })).toBeDisabled();

    // ...and a second press cannot slip through.
    fireEvent.click(screen.getByRole('button', { name: /re-roll/i }));
    expect(mockReRoll).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
    });

    expect(screen.getByRole('button', { name: /re-roll/i })).toBeEnabled();
  });

  it('leaves Go To usable while an adjustment is in flight', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS));
    mockReRoll.mockReturnValue(new Promise(() => {}));

    render(<RemixPanel />);
    fireEvent.click(screen.getByRole('button', { name: /re-roll/i }));

    expect(screen.getAllByRole('button', { name: /go to edit/i })[0]).toBeEnabled();
  });
});
