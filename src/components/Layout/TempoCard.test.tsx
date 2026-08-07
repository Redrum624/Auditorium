import { act, render, screen, fireEvent } from '@testing-library/react';
import TempoCard from './TempoCard';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import {
  getTempo,
  getRemixAnalysis,
  regridTempo,
  isTempoRunning,
  runTempoAnalysis,
  useTempoVersion,
  type TempoEntry,
  type RemixAnalysis,
} from '../../services/tempoAnalysis';
import { runCommand } from '../../services/menuActions';

jest.mock('../../services/tempoAnalysis', () => ({
  getTempo: jest.fn(() => null),
  getRemixAnalysis: jest.fn(() => null),
  regridTempo: jest.fn(async () => null),
  isTempoRunning: jest.fn(() => false),
  runTempoAnalysis: jest.fn(async () => null),
  useTempoVersion: jest.fn(() => 0),
}));

jest.mock('../../services/menuActions', () => ({
  runCommand: jest.fn(async () => {}),
}));

const mockGetTempo = getTempo as jest.MockedFunction<typeof getTempo>;
const mockGetRemixAnalysis = getRemixAnalysis as jest.MockedFunction<typeof getRemixAnalysis>;
const mockRegridTempo = regridTempo as jest.MockedFunction<typeof regridTempo>;
const mockIsTempoRunning = isTempoRunning as jest.MockedFunction<typeof isTempoRunning>;
const mockRunTempoAnalysis = runTempoAnalysis as jest.MockedFunction<typeof runTempoAnalysis>;
const mockRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;
void useTempoVersion; // imported only so the mock factory's shape stays type-checked

function makeTempoEntry(overrides: Partial<TempoEntry> = {}): TempoEntry {
  return {
    bpm: 128.4,
    confidence: 0.72,
    beatSamples: new Int32Array(642),
    salience: 1,
    peakRatio: 1,
    ibiCv: 0.02,
    truncated: false,
    analyzedEndSample: 20 * 44100,
    odf: new Float32Array(0),
    periodFrames: 200,
    decimationFactor: 4,
    bands: new Float32Array(0),
    numBands: 0,
    odfLow: new Float32Array(0),
    stale: false,
    ...overrides,
  };
}

/** Only the fields the card and `structureRuns` read — the full RemixAnalysis
 * carries a dozen descriptor arrays irrelevant here. */
function makeRemix(overrides: Partial<RemixAnalysis> = {}): RemixAnalysis {
  return {
    ...makeTempoEntry(),
    beatsPerBar: 4,
    numBars: 2,
    barBoundary: new Int32Array([0, 44100, 88200]),
    cluster: new Int32Array([0, 1, 1]),
    tempoConfirmed: false,
    ...overrides,
  } as unknown as RemixAnalysis;
}

function addDoc(): AudioDocument {
  const doc = createDocument({
    name: 'a.wav',
    sampleRate: 44100,
    channels: [new Float32Array(44100)],
  });
  useAppStore.getState().addDocument(doc);
  return doc;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  mockGetTempo.mockReset().mockReturnValue(null);
  mockGetRemixAnalysis.mockReset().mockReturnValue(null);
  mockRegridTempo.mockReset().mockResolvedValue(null);
  mockIsTempoRunning.mockReset().mockReturnValue(false);
  mockRunTempoAnalysis.mockReset().mockResolvedValue(null);
  mockRunCommand.mockReset().mockResolvedValue(undefined);
});

describe('TempoCard — visibility', () => {
  it('renders nothing with no document open', () => {
    const { container } = render(<TempoCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the document has no cached analysis, and never starts one', () => {
    addDoc();
    const { container } = render(<TempoCard />);
    expect(container).toBeEmptyDOMElement();
    expect(mockRunTempoAnalysis).not.toHaveBeenCalled();
    expect(mockRunCommand).not.toHaveBeenCalled();
  });
});

describe('TempoCard — readout', () => {
  it('shows ♩ BPM · conf without a remix analysis (no meter, no strip)', () => {
    addDoc();
    mockGetTempo.mockReturnValue(makeTempoEntry());
    render(<TempoCard />);

    expect(screen.getByTestId('tempo-card')).toBeInTheDocument();
    expect(screen.getByTestId('tempo-card-readout')).toHaveTextContent('♩ 128.4 · conf 0.72');
    expect(screen.queryByTestId('tempo-card-structure')).not.toBeInTheDocument();
  });

  it('appends the stale marker exactly like the status readout', () => {
    addDoc();
    mockGetTempo.mockReturnValue(makeTempoEntry({ stale: true }));
    render(<TempoCard />);

    expect(screen.getByTestId('tempo-card-readout')).toHaveTextContent('♩ 128.4* · conf 0.72');
  });

  it('shows ♩ — alone when the entry has no BPM', () => {
    addDoc();
    mockGetTempo.mockReturnValue(makeTempoEntry({ bpm: null }));
    render(<TempoCard />);

    expect(screen.getByTestId('tempo-card-readout')).toHaveTextContent('♩ —');
  });

  it('includes the meter when a remix analysis exists', () => {
    addDoc();
    mockGetTempo.mockReturnValue(makeTempoEntry({ bpm: 120 }));
    mockGetRemixAnalysis.mockReturnValue(makeRemix({ beatsPerBar: 4 }));
    render(<TempoCard />);

    expect(screen.getByTestId('tempo-card-readout')).toHaveTextContent('♩ 120.0 · 4/4 · conf 0.72');
  });
});

describe('TempoCard — structure strip', () => {
  it('renders one block per cluster run with proportional widths', () => {
    addDoc();
    mockGetTempo.mockReturnValue(makeTempoEntry());
    mockGetRemixAnalysis.mockReturnValue(makeRemix());
    render(<TempoCard />);

    const blocks = screen.getAllByTestId('tempo-card-block');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toHaveStyle({ width: '50%' });
    expect(blocks[1]).toHaveStyle({ width: '50%' });
  });

  it('survives a regrid-degraded remix row (no bar data) by hiding the strip', () => {
    addDoc();
    mockGetTempo.mockReturnValue(makeTempoEntry());
    // After regridTempo, a level:'remix' cache row is a deriveGrid result with
    // no barBoundary/cluster/numBars at all — the strip must hide, not throw.
    mockGetRemixAnalysis.mockReturnValue(makeTempoEntry() as unknown as RemixAnalysis);
    render(<TempoCard />);

    expect(screen.getByTestId('tempo-card')).toBeInTheDocument();
    expect(screen.queryByTestId('tempo-card-structure')).not.toBeInTheDocument();
  });

  it('shows the confirmed chip only when the analysis carries the user assertion', () => {
    addDoc();
    mockGetTempo.mockReturnValue(makeTempoEntry());
    mockGetRemixAnalysis.mockReturnValue(makeRemix({ tempoConfirmed: true }));
    render(<TempoCard />);
    expect(screen.getByTestId('tempo-card-confirmed')).toBeInTheDocument();
  });

  it('hides the confirmed chip without the assertion', () => {
    addDoc();
    mockGetTempo.mockReturnValue(makeTempoEntry());
    mockGetRemixAnalysis.mockReturnValue(makeRemix({ tempoConfirmed: false }));
    render(<TempoCard />);
    expect(screen.queryByTestId('tempo-card-confirmed')).not.toBeInTheDocument();
  });
});

describe('TempoCard — chips', () => {
  it('×2 re-tracks the grid at half the period (regridTempo, never a relabel)', async () => {
    const doc = addDoc();
    mockGetTempo.mockReturnValue(makeTempoEntry({ periodFrames: 200 }));
    mockRegridTempo.mockResolvedValue(makeTempoEntry({ bpm: 256.8, periodFrames: 100 }));
    render(<TempoCard />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Double tempo' }));
    });
    expect(mockRegridTempo).toHaveBeenCalledWith(doc.id, 100);
  });

  it('÷2 re-tracks the grid at double the period', async () => {
    const doc = addDoc();
    mockGetTempo.mockReturnValue(makeTempoEntry({ periodFrames: 200 }));
    mockRegridTempo.mockResolvedValue(makeTempoEntry({ bpm: 64.2, periodFrames: 400 }));
    render(<TempoCard />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Halve tempo' }));
    });
    expect(mockRegridTempo).toHaveBeenCalledWith(doc.id, 400);
  });

  it('surfaces a failed correction instead of failing silently', async () => {
    addDoc();
    mockGetTempo.mockReturnValue(makeTempoEntry());
    mockRegridTempo.mockResolvedValue(null);
    render(<TempoCard />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Double tempo' }));
    });
    expect(screen.getByText(/correction failed/i)).toBeInTheDocument();
  });

  it('hides ×2/÷2 when the entry is stale or has no BPM, keeping Re-detect', () => {
    addDoc();
    mockGetTempo.mockReturnValue(makeTempoEntry({ stale: true }));
    render(<TempoCard />);

    expect(screen.queryByRole('button', { name: 'Double tempo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Halve tempo' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-detect tempo' })).toBeInTheDocument();
  });

  it('Re-detect drives the existing tempo.detect command', () => {
    addDoc();
    mockGetTempo.mockReturnValue(makeTempoEntry());
    render(<TempoCard />);

    fireEvent.click(screen.getByRole('button', { name: 'Re-detect tempo' }));
    expect(mockRunCommand).toHaveBeenCalledWith('tempo.detect');
  });

  it('disables the chips while an analysis is in flight', () => {
    addDoc();
    mockGetTempo.mockReturnValue(makeTempoEntry());
    mockIsTempoRunning.mockReturnValue(true);
    render(<TempoCard />);

    expect(screen.getByRole('button', { name: 'Double tempo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Halve tempo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Re-detect tempo' })).toBeDisabled();
  });
});
