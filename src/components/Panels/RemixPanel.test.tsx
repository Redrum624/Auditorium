import { FALLBACK_EDITOR_LANE_WIDTH } from '../../services/editorViewport';
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
import { MAX_REQUIRED_JOINS, type RemixJoin } from '../../dsp/remixPlan';
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

/**
 * `samples` defaults to a token 1000 — most tests here never look at the audio,
 * and a real buffer per test would cost seconds for nothing.
 *
 * F11 fix round: the two Go-To tests pass a REAL length. `centreEditorOn`
 * clamps the scroll to what the document can actually show, so against a
 * 1000-sample document there is nothing to scroll to and "re-centres the
 * viewport" would assert 0 === 0 forever. The old inline centring never looked
 * at the document at all, which is exactly why it could scroll a 1000-sample
 * document to sample 425 000.
 */
function addRemixDoc(name = 'Remix 1', samples = 1000): AudioDocument {
  const doc = createDocument({
    name,
    sampleRate: SR,
    channels: [new Float32Array(samples)],
  });
  useAppStore.getState().addDocument(doc);
  return doc;
}

/** Long enough to contain every join the SIX_JOINS fixture advertises. */
const GOTO_DOC_SAMPLES = 30 * SR;

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
    // A document long enough to hold the joins — see addRemixDoc.
    const doc = addRemixDoc('Remix 1', GOTO_DOC_SAMPLES);
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS));
    useAppStore.setState({ zoom: { samplesPerPixel: 20, scrollSample: 0 } });

    render(<RemixPanel />);
    fireEvent.click(screen.getAllByRole('button', { name: /go to edit/i })[0]);

    const state = useAppStore.getState();
    expect(state.cursorSample).toBe(10 * SR);
    // F11 fix round: centred on the lane's MEASURED width (the documented
    // fallback here) and clamped by the store's one resolver, not the old
    // inline "~800px viewport" guess that bypassed the clamp.
    expect(state.zoom.scrollSample).toBe(10 * SR - (FALLBACK_EDITOR_LANE_WIDTH * 20) / 2);
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

  // R4b: the wording flipped with the mechanism. A pin IS a guarantee now, up
  // to `MAX_REQUIRED_JOINS`; the panel must promise that, and must stop
  // promising it in exactly the case where the planner stops delivering it.
  it('words the pin control as a GUARANTEE below the cap, and names the cap', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS));

    render(<RemixPanel />);
    const title = screen.getByRole('button', { name: /^pin edit 1$/i }).getAttribute('title') ?? '';
    expect(title).toMatch(/guaranteed/i);
    expect(title).not.toMatch(/not a guarantee/i);
    expect(title).toMatch(new RegExp(`${MAX_REQUIRED_JOINS}`));
  });

  // The over-cap tooltip is shown FROM the cap onward, so its wording has to
  // be true at exactly the cap as well as above it. Asserting only the tail of
  // the sentence is what let "you already have more than 4 pins" ship while
  // being displayed at exactly 4 — so both assertions below read the WHOLE
  // string, including the count clause.
  it('at exactly the cap, says the next pin is the one that cannot be guaranteed — not that you are already over', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(
      makeSession(doc.id, SIX_JOINS, {
        lockedJoins: SIX_JOINS.slice(0, MAX_REQUIRED_JOINS).map((j) => `${j.fromBar}>${j.toBar}`),
      })
    );

    render(<RemixPanel />);
    const title = screen.getByRole('button', { name: /^pin edit 5$/i }).getAttribute('title') ?? '';
    expect(title).toBe(
      `Pin this edit. You already have ${MAX_REQUIRED_JOINS} pins, which is all the planner can guarantee — a ${MAX_REQUIRED_JOINS + 1}th would put every pin beyond what it can enforce.`
    );
    // The claim that is false at exactly the cap must not appear at all.
    expect(title).not.toMatch(/more than/i);
    // Nor may it claim the pins ALREADY are preferences — the planner enforced
    // this plan.
    expect(title).not.toMatch(/strong preference/i);
  });

  it('above the cap on a preference plan, states the ACTUAL pin count rather than a fixed sentence', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(
      makeSession(doc.id, SIX_JOINS, {
        lockedJoins: SIX_JOINS.slice(0, MAX_REQUIRED_JOINS + 1).map((j) => `${j.fromBar}>${j.toBar}`),
        pinReport: { mode: 'preference', satisfied: [], dropped: [] },
      })
    );

    render(<RemixPanel />);
    const title = screen.getByRole('button', { name: /^pin edit 6$/i }).getAttribute('title') ?? '';
    expect(title).toBe(
      `Pin this edit. You already have ${MAX_REQUIRED_JOINS + 1} pins, more than the ${MAX_REQUIRED_JOINS} the planner can guarantee, so pins are currently strong preferences rather than guarantees.`
    );
  });

  it('above the cap but ENFORCED — triage freed the slots — the tooltip must not call the pins preferences', () => {
    // The mirror of the round-2 finding, and the one the property test caught:
    // rejected or illegal pins consume no guarantee slot, so more than
    // MAX_REQUIRED_JOINS pins can still be fully enforced. A count-only
    // tooltip told those users their pins were "currently strong preferences"
    // while the planner had enforced every one and the banner was — correctly
    // — absent.
    //
    // The fixture is now a state the SERVICE can actually produce (fix round
    // 3). `lockedJoinsDropped` was left at `makeSession`'s default `[]` while
    // `pinReport.dropped` named a key, and `remixService.test.ts`'s "always
    // name the SAME keys" test says those two move together — so this
    // certified a state that cannot occur and proved nothing about the real
    // one. With the note rendered, the round-3 contradiction is visible: the
    // tooltip may not claim every pin is enforced while the header says one
    // could not be kept.
    const doc = addRemixDoc();
    const dropped = `${SIX_JOINS[MAX_REQUIRED_JOINS].fromBar}>${SIX_JOINS[MAX_REQUIRED_JOINS].toBar}`;
    mockGetSession.mockReturnValue(
      makeSession(doc.id, SIX_JOINS, {
        lockedJoins: SIX_JOINS.slice(0, MAX_REQUIRED_JOINS + 1).map((j) => `${j.fromBar}>${j.toBar}`),
        lockedJoinsDropped: [dropped],
        pinReport: {
          mode: 'enforced',
          satisfied: SIX_JOINS.slice(0, MAX_REQUIRED_JOINS).map((j) => `${j.fromBar}>${j.toBar}`),
          dropped: [{ key: dropped, reason: 'no-candidate' }],
        },
      })
    );

    render(<RemixPanel />);
    const title = screen.getByRole('button', { name: /^pin edit 6$/i }).getAttribute('title') ?? '';
    expect(title).toMatch(new RegExp(`You already have ${MAX_REQUIRED_JOINS + 1} pins`));
    expect(title).toMatch(/do not use a slot/i);
    // It names what WAS enforced rather than claiming everything was...
    expect(title).toMatch(new RegExp(`the ${MAX_REQUIRED_JOINS} this arrangement kept are enforced`));
    expect(title).not.toMatch(/strong preference/i);
    // ...because the note directly above it says one pin could not be kept.
    expect(screen.getByTestId('remix-dropped-pins')).toHaveTextContent(/could not be kept/i);
    expect(title).not.toMatch(/all enforced/i);
    expect(screen.queryByTestId('remix-pins-not-guaranteed')).not.toBeInTheDocument();
  });

  it('above the cap with pins the planner has never seen, it promises nothing about them', () => {
    // Fix round 3. `pinReport === null` is a THIRD value, not a quieter
    // 'enforced': `toggleLockJoin` does not re-plan, so five pins on a session
    // whose plan was made with none is one click away from a fresh remix. The
    // old two-valued reading sent that state into the "triage freed the slots"
    // branch and told the user this arrangement's pins were all enforced —
    // about an arrangement the planner had never seen a pin for.
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(
      makeSession(doc.id, SIX_JOINS, {
        lockedJoins: SIX_JOINS.slice(0, MAX_REQUIRED_JOINS + 1).map((j) => `${j.fromBar}>${j.toBar}`),
        pinReport: null,
      })
    );

    render(<RemixPanel />);
    const title = screen.getByRole('button', { name: /^pin edit 6$/i }).getAttribute('title') ?? '';
    expect(title).toMatch(new RegExp(`You already have ${MAX_REQUIRED_JOINS + 1} pins`));
    expect(title).toMatch(/was not planned with all of them/i);
    expect(title).toMatch(/Re-roll to re-plan/i);
    // Neither of the two claims it is not entitled to make.
    expect(title).not.toMatch(/all enforced/i);
    expect(title).not.toMatch(/strong preference/i);
    expect(screen.queryByTestId('remix-pins-not-guaranteed')).not.toBeInTheDocument();
  });

  it('above the cap, pins added SINCE the enforced plan are not described as enforced either', () => {
    // The same hole one state along: the report is 'enforced' and honest about
    // the three keys it was given, but two more have been pinned since. Those
    // two are in the arrangement only because a pin can only be placed on a
    // join already in it — nothing enforced them.
    const doc = addRemixDoc();
    const planned = SIX_JOINS.slice(0, 3).map((j) => `${j.fromBar}>${j.toBar}`);
    mockGetSession.mockReturnValue(
      makeSession(doc.id, SIX_JOINS, {
        lockedJoins: SIX_JOINS.slice(0, MAX_REQUIRED_JOINS + 1).map((j) => `${j.fromBar}>${j.toBar}`),
        pinReport: { mode: 'enforced', satisfied: planned, dropped: [] },
      })
    );

    render(<RemixPanel />);
    const title = screen.getByRole('button', { name: /^pin edit 6$/i }).getAttribute('title') ?? '';
    expect(title).toMatch(/was not planned with all of them/i);
    expect(title).not.toMatch(/all enforced/i);
    expect(title).not.toMatch(/strong preference/i);
  });

  it('says PLAINLY when the guarantee is not in force at all', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(
      makeSession(doc.id, SIX_JOINS, {
        lockedJoins: SIX_JOINS.map((j) => `${j.fromBar}>${j.toBar}`),
        pinReport: {
          mode: 'preference',
          satisfied: [],
          dropped: SIX_JOINS.map((j) => ({ key: `${j.fromBar}>${j.toBar}`, reason: 'not-enforced' as const })),
        },
      })
    );

    render(<RemixPanel />);
    expect(screen.getByTestId('remix-pins-not-guaranteed')).toHaveTextContent(
      new RegExp(`More than ${MAX_REQUIRED_JOINS} pins`, 'i')
    );
    expect(screen.getByTestId('remix-pins-not-guaranteed')).toHaveTextContent(
      new RegExp(`Unpin down to ${MAX_REQUIRED_JOINS}`, 'i')
    );
  });

  // Fix round 2, I2. The banner became mode-aware in round 1; the pin tooltip
  // did not, so in the ONE state the new banner wording exists for — plan
  // still `mode: 'preference'`, live pin count back inside the cap — the two
  // controls stated opposite things about the same arrangement in the same
  // render. These tests read BOTH elements from ONE render, which is the only
  // way that class of contradiction is observable at all.
  const stalePreferenceSession = (docId: string, pinCount: number): RemixSession =>
    makeSession(docId, SIX_JOINS, {
      lockedJoins: SIX_JOINS.slice(0, pinCount).map((j) => `${j.fromBar}>${j.toBar}`),
      pinReport: {
        mode: 'preference',
        satisfied: [],
        dropped: SIX_JOINS.slice(0, pinCount).map((j) => ({
          key: `${j.fromBar}>${j.toBar}`,
          reason: 'not-enforced' as const,
        })),
      },
    });

  it('at exactly the cap on a preference plan, the tooltip does NOT imply the current pins are guaranteed', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(stalePreferenceSession(doc.id, MAX_REQUIRED_JOINS));

    render(<RemixPanel />);
    const title = screen.getByRole('button', { name: /^pin edit 5$/i }).getAttribute('title') ?? '';
    // It states the fact the banner states, so the two agree in this render...
    expect(title).toBe(
      `Pin this edit. This arrangement's pins are strong preferences, not guarantees — it was planned with more than ${MAX_REQUIRED_JOINS}. Re-roll to re-plan with the guarantee.`
    );
    // ...and specifically does NOT say "all the planner can guarantee", which
    // is what implied these four were guaranteed when they were not.
    expect(title).not.toMatch(/all the planner can guarantee/i);
  });

  it('below the cap on a preference plan, the tooltip says so too — the same contradiction one count further down', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(stalePreferenceSession(doc.id, 2));

    render(<RemixPanel />);
    const title = screen.getByRole('button', { name: /^pin edit 3$/i }).getAttribute('title') ?? '';
    expect(title).toMatch(/this arrangement's pins are strong preferences, not guarantees/i);
  });

  // THE property test for the banner / dropped-pins note / pin tooltip trio.
  // It exists because this trio has produced six defects across three rounds,
  // every one of them a state one field further in than the last, so it is
  // written over the FULL cross-product of every value every field the trio
  // reads can take — including `pinReport: null`, whose absence from the round-2
  // version is exactly what let round 3 find two more:
  //
  //   pinReport.mode      null | 'enforced' | 'preference'   (three-valued)
  //   pinReport.dropped   none | some       — drives `remix-dropped-pins`
  //   the report's keys   cover every live pin | do not      — pinning never
  //                                                            re-plans, so
  //                                                            drift is one
  //                                                            click away
  //   live pin count      0 | 2 | at the cap | above it
  //
  // `lockedJoinsDropped` is kept equal to `pinReport.dropped`'s keys throughout,
  // because `remixService.test.ts`'s "always name the SAME keys" test says the
  // service can produce no other combination — a fixture that separates them
  // certifies a state that cannot occur (fix round 3).
  const REASON = 'incompatible' as const;
  type PinFixtureMode = 'enforced' | 'preference' | null;

  /** Which of the pin tooltip's sentences is on screen. TOTAL and EXCLUSIVE by
   * construction: a tooltip matching none of them, or more than one, is a
   * defect on its own — that is how a "this arrangement's are all enforced"
   * hybrid gets caught rather than sliding past a `/are enforced/` probe that
   * happens not to span the word it added. */
  const TOOLTIP_KINDS = [
    ['preference-over-cap', /so pins are currently strong preferences rather than guarantees/i],
    ['preference-plan', /This arrangement's pins are strong preferences, not guarantees/i],
    ['over-cap-enforced', /this arrangement kept are enforced/i],
    ['over-cap-unplanned', /this arrangement was not planned with all of them/i],
    ['at-cap', /which is all the planner can guarantee/i],
    ['below-cap', /Every re-plan and re-roll will keep it/i],
  ] as const;

  function tooltipKind(title: string): string {
    const hits = TOOLTIP_KINDS.filter(([, re]) => re.test(title)).map(([kind]) => kind);
    if (hits.length !== 1) throw new Error(`unclassifiable pin tooltip [${hits.join()}]: ${title}`);
    return hits[0];
  }

  function pinFixture(
    mode: PinFixtureMode,
    dropCount: 0 | 1,
    coverage: 'planned' | 'unplanned',
    pinCount: number
  ): Partial<RemixSession> {
    const locked = SIX_JOINS.slice(0, pinCount).map((j) => `${j.fromBar}>${j.toBar}`);
    if (mode === null) return { lockedJoins: locked, lockedJoinsDropped: [], pinReport: null };
    // The pin set the plan ON SCREEN was made with. 'unplanned' keeps only the
    // oldest pin: the rest were added after the plan, which `toggleLockJoin` —
    // deliberately not a re-plan — makes reachable at any count.
    const planned = coverage === 'planned' ? [...locked] : locked.slice(0, 1);
    // A report with drops but no live pins is the round-2 state reached from
    // the other side: planned with pins, then unpinned without re-planning.
    if (dropCount > 0 && planned.length === 0) planned.push(`${SIX_JOINS[0].fromBar}>${SIX_JOINS[0].toBar}`);
    const dropped = planned.slice(0, dropCount).map((key) => ({ key, reason: REASON }));
    return {
      lockedJoins: locked,
      lockedJoinsDropped: dropped.map((d) => d.key),
      pinReport: { mode, satisfied: planned.slice(dropCount), dropped },
    };
  }

  it('the banner, the dropped-pins note and the pin tooltip agree in one render, over every value of every field', () => {
    let checked = 0;
    for (const mode of [null, 'enforced', 'preference'] as PinFixtureMode[]) {
      // `null` carries no keys, so its drop/coverage axes have one value each.
      for (const dropCount of (mode === null ? [0] : [0, 1]) as (0 | 1)[]) {
        for (const coverage of (mode === null ? ['planned'] : ['planned', 'unplanned']) as (
          | 'planned'
          | 'unplanned'
        )[]) {
          for (const pinCount of [0, 2, MAX_REQUIRED_JOINS, MAX_REQUIRED_JOINS + 1]) {
            const over = pinFixture(mode, dropCount, coverage, pinCount);
            const doc = addRemixDoc();
            mockGetSession.mockReturnValue(makeSession(doc.id, SIX_JOINS, over));

            const view = render(<RemixPanel />);
            const where = `mode=${mode} drops=${dropCount} coverage=${coverage} pins=${pinCount}`;
            const banner = view.container.querySelector('[data-testid="remix-pins-not-guaranteed"]');
            const note = view.container.querySelector('[data-testid="remix-dropped-pins"]');
            const title =
              view.container
                .querySelector(`button[aria-label="Pin edit ${pinCount + 1}"]`)
                ?.getAttribute('title') ?? '';

            // The row really rendered — not a vacuous pass.
            expect(`${where}: ${title}`).not.toBe(`${where}: `);

            // 1. The banner is the planner's verdict, never the pin count.
            expect(`${where}: ${banner !== null}`).toBe(`${where}: ${mode === 'preference'}`);
            // 2. Round 2: banner and tooltip give the same answer, one render.
            expect(`${where}: ${/strong preference/i.test(title)}`).toBe(
              `${where}: ${/strong preference/i.test(banner?.textContent ?? '')}`
            );
            // 3. The note is the report's own drop list.
            expect(`${where}: ${note !== null}`).toBe(`${where}: ${dropCount > 0}`);
            // 4. Round 3, both findings at once: WHICH sentence the tooltip
            //    shows, in every state, written from what is true rather than
            //    from the component's own branches. The tooltip may speak about
            //    this arrangement's enforcement ONLY when the planner enforced
            //    it AND was given every live pin; `pinReport === null` and pins
            //    added since the plan both fail that and get the sentence that
            //    promises nothing. This is the assertion the round-2 version
            //    lacked, and the two states it lacked it for.
            const expectedKind =
              mode === 'preference'
                ? pinCount > MAX_REQUIRED_JOINS
                  ? 'preference-over-cap'
                  : 'preference-plan'
                : pinCount > MAX_REQUIRED_JOINS
                  ? mode === 'enforced' && coverage === 'planned'
                    ? 'over-cap-enforced'
                    : 'over-cap-unplanned'
                  : pinCount === MAX_REQUIRED_JOINS
                    ? 'at-cap'
                    : 'below-cap';
            expect(`${where}: ${tooltipKind(title)}`).toBe(`${where}: ${expectedKind}`);
            // 5. And the enforcement claim quotes the REPORT's own count, not
            //    the pin count — the two differ by exactly the pins triage
            //    dropped, which are the ones the note above names.
            if (expectedKind === 'over-cap-enforced') {
              expect(title).toContain(
                `the ${over.pinReport?.satisfied.length} this arrangement kept are enforced`
              );
            }
            checked++;
            view.unmount();
          }
        }
      }
    }
    // 4 null + 16 enforced + 16 preference — the whole cross-product, counted
    // so a silently skipped axis cannot masquerade as a pass.
    expect(checked).toBe(36);
  });

  it('after unpinning back to the cap, the banner stops telling the user to unpin — it describes the arrangement instead', () => {
    // `toggleLockJoin` does not re-plan, so the plan on screen is still a
    // preference plan while the pin count is already back inside the cap. The
    // banner and the pin tooltip must not disagree about the same fact in the
    // same render.
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(
      makeSession(doc.id, SIX_JOINS, {
        lockedJoins: SIX_JOINS.slice(0, MAX_REQUIRED_JOINS).map((j) => `${j.fromBar}>${j.toBar}`),
        pinReport: {
          mode: 'preference',
          satisfied: [],
          dropped: SIX_JOINS.slice(0, MAX_REQUIRED_JOINS).map((j) => ({
            key: `${j.fromBar}>${j.toBar}`,
            reason: 'not-enforced' as const,
          })),
        },
      })
    );

    render(<RemixPanel />);
    const banner = screen.getByTestId('remix-pins-not-guaranteed');
    // It still warns — the audio on screen really was planned without the
    // guarantee — but it no longer asks for an unpin that already happened.
    expect(banner).toHaveTextContent(/was planned with more than 4 pins/i);
    expect(banner).toHaveTextContent(/Re-roll to re-plan with the guarantee/i);
    expect(banner).not.toHaveTextContent(new RegExp(`Unpin down to ${MAX_REQUIRED_JOINS}`, 'i'));
  });

  it('shows no not-guaranteed banner while the guarantee IS in force', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(
      makeSession(doc.id, SIX_JOINS, {
        lockedJoins: ['16>24'],
        pinReport: { mode: 'enforced', satisfied: ['16>24'], dropped: [] },
      })
    );

    render(<RemixPanel />);
    expect(screen.queryByTestId('remix-pins-not-guaranteed')).not.toBeInTheDocument();
  });

  it('names the dropped pin and WHY, per category — never a bare "some pins were dropped"', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(
      makeSession(doc.id, SIX_JOINS, {
        lockedJoins: ['16>24', '99>100'],
        lockedJoinsDropped: ['99>100'],
        pinReport: {
          mode: 'enforced',
          satisfied: ['16>24'],
          dropped: [{ key: '99>100', reason: 'incompatible' }],
        },
      })
    );

    render(<RemixPanel />);
    const note = screen.getByTestId('remix-dropped-pins');
    expect(note).toHaveTextContent(/1 pinned edit/i);
    expect(note).toHaveTextContent(/bar 99 → 100/);
    expect(note).toHaveTextContent(/cannot coexist with the other pins/i);
  });

  it('gives each drop CATEGORY its own explanation, grouped', () => {
    const doc = addRemixDoc();
    mockGetSession.mockReturnValue(
      makeSession(doc.id, SIX_JOINS, {
        lockedJoins: ['99>100', '98>99', '97>98'],
        lockedJoinsDropped: ['99>100', '98>99', '97>98'],
        pinReport: {
          mode: 'enforced',
          satisfied: [],
          dropped: [
            { key: '99>100', reason: 'forbidden' },
            { key: '98>99', reason: 'no-candidate' },
            { key: '97>98', reason: 'incompatible' },
          ],
        },
      })
    );

    render(<RemixPanel />);
    const note = screen.getByTestId('remix-dropped-pins');
    expect(note).toHaveTextContent(/you rejected this edit/i);
    expect(note).toHaveTextContent(/not a legal splice/i);
    expect(note).toHaveTextContent(/cannot coexist/i);
    expect(note).toHaveTextContent(/3 pinned edits/i);
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
    const doc = addRemixDoc('Remix 1', GOTO_DOC_SAMPLES);
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
    expect(useAppStore.getState().zoom.scrollSample).toBe(
      10 * SR - (FALLBACK_EDITOR_LANE_WIDTH * 20) / 2
    );
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
