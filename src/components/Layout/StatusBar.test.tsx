import { render, screen } from '@testing-library/react';
import StatusBar from './StatusBar';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { getTempo, runTempoAnalysis, useTempoVersion } from '../../services/tempoAnalysis';
import type { TempoEntry } from '../../services/tempoAnalysis';

jest.mock('../../services/tempoAnalysis', () => ({
  getTempo: jest.fn(() => null),
  runTempoAnalysis: jest.fn(async () => null),
  useTempoVersion: jest.fn(() => 0),
}));

const mockGetTempo = getTempo as jest.MockedFunction<typeof getTempo>;
const mockRunTempoAnalysis = runTempoAnalysis as jest.MockedFunction<typeof runTempoAnalysis>;
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
    stale: false,
    ...overrides,
  };
}

function addDoc(): AudioDocument {
  const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [new Float32Array(44100)] });
  useAppStore.getState().addDocument(doc);
  return doc;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  mockGetTempo.mockReset().mockReturnValue(null);
  mockRunTempoAnalysis.mockReset().mockResolvedValue(null);
});

describe('StatusBar — tempo readout (Task T5)', () => {
  it('renders "♩ 128.4" for a fresh entry', () => {
    addDoc();
    mockGetTempo.mockReturnValue(makeTempoEntry({ bpm: 128.4, stale: false }));
    render(<StatusBar />);

    expect(screen.getByText('♩ 128.4')).toBeInTheDocument();
  });

  it('renders "♩ 128.4*" for a stale entry', () => {
    addDoc();
    mockGetTempo.mockReturnValue(makeTempoEntry({ bpm: 128.4, stale: true }));
    render(<StatusBar />);

    expect(screen.getByText('♩ 128.4*')).toBeInTheDocument();
  });

  it('renders "♩ —" when there is no cached result', () => {
    addDoc();
    mockGetTempo.mockReturnValue(null);
    render(<StatusBar />);

    expect(screen.getByText('♩ —')).toBeInTheDocument();
  });

  it('renders "♩ —" with no document open', () => {
    render(<StatusBar />);
    expect(screen.getByText('♩ —')).toBeInTheDocument();
  });

  it('never triggers analysis (runTempoAnalysis is not called during render)', () => {
    addDoc();
    mockGetTempo.mockReturnValue(null);
    render(<StatusBar />);

    expect(mockRunTempoAnalysis).not.toHaveBeenCalled();
  });
});
