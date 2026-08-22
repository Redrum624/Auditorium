import { render, screen, act } from '@testing-library/react';
import StatusBar, { formatSpp } from './StatusBar';
import LevelMeter from './LevelMeter';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import { _resetSessionUndo, markSessionSavePoint } from '../../multitrack/sessionUndo';
import { createClip } from '../../multitrack/session';
import { markSavePoint } from '../../services/undoHistory';
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
  // Lot A: the project chip reads the session store, its history and its
  // path — all module-global.
  useSessionStore.getState().newSession(44100);
  useSessionStore.getState().setProjectPath(null);
  _resetSessionUndo();
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

    it('keeps the cursor / selection / spp readouts', () => {
      addDoc();
      render(<StatusBar />);

      expect(screen.getByText(/^cursor /)).toBeInTheDocument();
      expect(screen.getByText('sel —')).toBeInTheDocument();
      expect(screen.getByText(/^spp: /)).toBeInTheDocument();
    });
  });

  // U1 (layout E2, element 1 + 3): the retired top-left chip's identity
  // readout lives here now, carrying the chip's own `file-chip` testid — the
  // surface moved, the contract did not. It REPLACES the old
  // `44100 Hz · 2ch · N smp` segment, which said rate and channels twice over
  // and spent the rest on a raw sample count.
  describe('U1 — the file identity folded in from the retired chip', () => {
    it('shows name · duration · rate · channels, compactly', () => {
      addDoc();
      render(<StatusBar />);

      const chip = screen.getByTestId('file-chip');
      expect(chip).toHaveTextContent('a.wav');
      expect(chip).toHaveTextContent('0:01.000');
      expect(chip).toHaveTextContent('44.1k');
      expect(chip).toHaveTextContent('mono');
    });

    it('labels a stereo document "stereo" and a 6-channel one "6ch"', () => {
      useAppStore.getState().addDocument(
        createDocument({
          name: 's.wav',
          sampleRate: 48000,
          channels: [new Float32Array(48000), new Float32Array(48000)],
        })
      );
      const { unmount } = render(<StatusBar />);
      expect(screen.getByTestId('file-chip')).toHaveTextContent('48.0k · stereo');
      unmount();

      useAppStore.setState(makeInitialState());
      useAppStore.getState().addDocument(
        createDocument({
          name: 'six.wav',
          sampleRate: 44100,
          channels: Array.from({ length: 6 }, () => new Float32Array(44100)),
        })
      );
      render(<StatusBar />);
      expect(screen.getByTestId('file-chip')).toHaveTextContent('6ch');
    });

    it('says "no document" in the empty app, and drops the retired sample-count segment', () => {
      render(<StatusBar />);
      expect(screen.getByTestId('file-chip')).toHaveTextContent('no document');
      expect(screen.queryByText(/smp$/)).not.toBeInTheDocument();
    });

    it('is the pill itself — App owns the band, so the edit pill can share its axis', () => {
      addDoc();
      render(<StatusBar />);
      const pill = screen.getByTestId('status-pill');
      // No positioning wrapper of its own: the pill is the component's root.
      expect(pill.parentElement?.tagName).toBe('DIV');
      expect(pill.parentElement?.className).not.toContain('absolute');
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

// F11 fix round (minor): the readout used to print raw `samplesPerPixel`, which
// was always an integer while the zoom was `ceil(length / 1600)`. Fit-on-open
// made it `docLength / laneWidth`, so a freshly opened file showed
// `spp: 7812.222320637732`.
describe('formatSpp (F11)', () => {
  it('drops the noise on a fractional zoom, which is now the ordinary case', () => {
    expect(formatSpp(7812.222320637732)).toBe('7812');
  });

  it('keeps two decimals when zoomed in far enough for them to mean something', () => {
    expect(formatSpp(0.03125)).toBe('0.03');
    expect(formatSpp(12.5)).toBe('12.5');
  });

  it('does not add a trailing .00 to a value that really is round', () => {
    expect(formatSpp(4)).toBe('4');
    expect(formatSpp(512)).toBe('512');
  });

  it('passes a non-finite value through rather than printing NaN arithmetic', () => {
    expect(formatSpp(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });
});

// ---------------------------------------------------------------------------
// Lot A (N13) — the project chip: "<project> *" at the head of the pill, in
// every view.
// ---------------------------------------------------------------------------
describe('StatusBar — the project chip (lot A, acceptance 16)', () => {
  function addClipToTrack0(docId: string) {
    const trackId = useSessionStore.getState().session.tracks[0].id;
    useSessionStore
      .getState()
      .addClip(trackId, createClip({ documentId: docId, startSample: 0, offsetSample: 0, lengthSample: 10 }));
  }

  it('renders the project name with no star for an empty untitled project', () => {
    render(<StatusBar />);
    const chip = screen.getByTestId('project-chip');
    expect(chip).toHaveTextContent(/^Untitled Session$/);
    expect(chip).toHaveAttribute('title', 'Project not saved yet');
  });

  it('sits FIRST in the pill, ahead of the file chip', () => {
    render(<StatusBar />);
    const pill = screen.getByTestId('status-pill');
    const children = Array.from(pill.children);
    const project = children.indexOf(screen.getByTestId('project-chip'));
    const file = children.indexOf(screen.getByTestId('file-chip'));
    expect(project).toBe(0);
    expect(file).toBeGreaterThan(project);
  });

  it('gains the star once a document is added to a never-written project', () => {
    render(<StatusBar />);
    act(() => {
      addDoc();
    });
    expect(screen.getByTestId('project-chip')).toHaveTextContent(/^Untitled Session \*$/);
  });

  it('shows the new name without a star after a Save As (path + rename + save points), and the star returns after a session edit', () => {
    const doc = addDoc();
    render(<StatusBar />);
    expect(screen.getByTestId('project-chip')).toHaveTextContent(/^Untitled Session \*$/);

    act(() => {
      // What writeProject does on success, in order.
      useSessionStore.getState().renameSession('mix v2');
      markSessionSavePoint();
      useAppStore.getState().updateDocument({ ...doc, dirty: false, neverSaved: false });
      markSavePoint(doc.id);
      useSessionStore.getState().setProjectPath('D:\\out\\mix v2.audm');
    });
    const chip = screen.getByTestId('project-chip');
    expect(chip).toHaveTextContent(/^mix v2$/);
    expect(chip).toHaveAttribute('title', 'D:\\out\\mix v2.audm');

    act(() => addClipToTrack0(doc.id)); // a session edit — no appStore change
    expect(screen.getByTestId('project-chip')).toHaveTextContent(/^mix v2 \*$/);
  });

  it('is rendered in the waveform and the multitrack view alike', () => {
    addDoc();
    const { rerender } = render(<StatusBar />);
    expect(screen.getByTestId('project-chip')).toBeInTheDocument();

    act(() => useAppStore.getState().setView('multitrack'));
    rerender(<StatusBar />);
    expect(screen.getByTestId('project-chip')).toHaveTextContent(/^Untitled Session \*$/);
  });
});
