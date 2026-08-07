import { render, screen, act } from '@testing-library/react';
import StatusBar from './StatusBar';
import LevelMeter from './LevelMeter';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { getTempo, runTempoAnalysis, useTempoVersion } from '../../services/tempoAnalysis';
import type { TempoEntry } from '../../services/tempoAnalysis';
import { CONFIDENCE_LOW } from '../../dsp/tempoCore';

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
    bands: new Float32Array(0),
    numBands: 0,
    odfLow: new Float32Array(0),
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

  describe('G2 — floating bottom chrome pill', () => {
    it('renders the readouts inside a .glass-chrome pill (status-pill)', () => {
      addDoc();
      render(<StatusBar />);

      const pill = screen.getByTestId('status-pill');
      expect(pill.className).toContain('glass-chrome');
    });

    it('keeps the cursor / selection / doc-info / spp readouts', () => {
      addDoc();
      render(<StatusBar />);

      expect(screen.getByText(/^cursor /)).toBeInTheDocument();
      expect(screen.getByText('sel —')).toBeInTheDocument();
      expect(screen.getByText('44100 Hz · 1ch · 44100 smp')).toBeInTheDocument();
      expect(screen.getByText(/^spp: /)).toBeInTheDocument();
    });
  });

  describe('low-confidence uncertainty marker (Fix round 1)', () => {
    it('appends "?" and a title when confidence is below CONFIDENCE_LOW', () => {
      addDoc();
      mockGetTempo.mockReturnValue(makeTempoEntry({ bpm: 128.4, confidence: CONFIDENCE_LOW - 0.01 }));
      render(<StatusBar />);

      const readout = screen.getByText('♩ 128.4?');
      expect(readout).toBeInTheDocument();
      expect(readout.title.toLowerCase()).toContain('low confidence');
    });

    it('does NOT append "?" when confidence is at or above CONFIDENCE_LOW', () => {
      addDoc();
      mockGetTempo.mockReturnValue(makeTempoEntry({ bpm: 128.4, confidence: CONFIDENCE_LOW }));
      render(<StatusBar />);

      expect(screen.getByText('♩ 128.4')).toBeInTheDocument();
      expect(screen.queryByText('♩ 128.4?')).not.toBeInTheDocument();
    });

    it('combines with the stale marker: "♩ 128.4*?"', () => {
      addDoc();
      mockGetTempo.mockReturnValue(
        makeTempoEntry({ bpm: 128.4, stale: true, confidence: CONFIDENCE_LOW - 0.01 })
      );
      render(<StatusBar />);

      expect(screen.getByText('♩ 128.4*?')).toBeInTheDocument();
    });
  });

  // G3: the retired bottom TransportBar's prominent time readout merges into
  // this pill (testid moves WITH the control, per plan ruling 4). Same routing
  // as before: cursor while stopped, playback position while playing, and the
  // multitrack cursor/playhead when that view is active.
  describe('G3 — transport time readout merged into the status pill', () => {
    it('renders the transport-time readout at 0:00.000 with a fresh document', () => {
      addDoc();
      render(<StatusBar />);
      expect(screen.getByTestId('transport-time')).toHaveTextContent('0:00.000');
    });

    it('shows the cursor time while stopped', () => {
      addDoc();
      useAppStore.getState().setCursor(44100); // 1 second
      render(<StatusBar />);
      expect(screen.getByTestId('transport-time')).toHaveTextContent('0:01.000');
    });

    it('shows the playback position while playing', () => {
      addDoc();
      useAppStore.getState().setCursor(44100);
      render(<StatusBar />);
      act(() =>
        useAppStore.getState().setPlayback({ state: 'playing', positionSample: 22050 })
      );
      expect(screen.getByTestId('transport-time')).toHaveTextContent('0:00.500');
    });

    it('shows the multitrack cursor when the multitrack view is active', () => {
      useSessionStore.getState().newSession(44100);
      useAppStore.getState().setView('multitrack');
      useSessionStore.getState().setMtCursor(22050);
      render(<StatusBar />);
      expect(screen.getByTestId('transport-time')).toHaveTextContent('0:00.500');
      // Restore for later suites.
      act(() => {
        useSessionStore.getState().setMtCursor(0);
        useSessionStore.getState().newSession(44100);
      });
    });
  });

  describe('G3 — level meter rehomed into the status pill', () => {
    it('renders the level meter inside the pill', () => {
      addDoc();
      render(<StatusBar />);
      const pill = screen.getByTestId('status-pill');
      const meter = screen.getByTestId('level-meter');
      expect(pill.contains(meter)).toBe(true);
    });
  });
});

// Moved verbatim from TransportBar.test.tsx (G3): LevelMeter now lives in the
// status pill, so its unit tests live beside StatusBar's.
describe('LevelMeter', () => {
  it('mounts with one bar per channel', () => {
    const { container } = render(<LevelMeter channels={2} />);
    expect(screen.getByTestId('level-meter')).toBeInTheDocument();
    // Two channel rows, each an 8px (h-2) bar.
    expect(container.querySelectorAll('.h-2')).toHaveLength(2);
  });

  it('renders a single bar for mono', () => {
    const { container } = render(<LevelMeter channels={1} />);
    expect(container.querySelectorAll('.h-2')).toHaveLength(1);
  });
});
