import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import PropertiesPanel from './PropertiesPanel';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { createClip } from '../../multitrack/session';
import { clearSessionHistory, SESSION_UNDO_KEY } from '../../multitrack/sessionUndo';
import { getHistory } from '../../services/undoHistory';
import { formatTime } from '../../utils/timeFormat';
import {
  getTempo,
  isTempoRunning,
  getTempoProgress,
  runTempoAnalysis,
  regridTempo,
  useTempoVersion,
} from '../../services/tempoAnalysis';
import type { TempoEntry } from '../../services/tempoAnalysis';

jest.mock('../../services/tempoAnalysis', () => ({
  getTempo: jest.fn(() => null),
  isTempoRunning: jest.fn(() => false),
  getTempoProgress: jest.fn(() => null),
  runTempoAnalysis: jest.fn(async () => null),
  regridTempo: jest.fn(async () => null),
  useTempoVersion: jest.fn(() => 0),
}));

const mockGetTempo = getTempo as jest.MockedFunction<typeof getTempo>;
const mockIsTempoRunning = isTempoRunning as jest.MockedFunction<typeof isTempoRunning>;
const mockGetTempoProgress = getTempoProgress as jest.MockedFunction<typeof getTempoProgress>;
const mockRunTempoAnalysis = runTempoAnalysis as jest.MockedFunction<typeof runTempoAnalysis>;
const mockRegridTempo = regridTempo as jest.MockedFunction<typeof regridTempo>;
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
    analyzedEndSample: 20 * 44100, // 20s of analysed audio by default
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

function addDoc(
  opts?: Partial<{ channels: number; filePath: string | null; sourceBitDepth: number }>
): AudioDocument {
  const channelCount = opts?.channels ?? 1;
  const channels = Array.from({ length: channelCount }, () => new Float32Array(44100)); // 1s @ 44100Hz
  const doc = createDocument({
    name: 'clip.wav',
    sampleRate: 44100,
    channels,
    filePath: opts?.filePath,
    sourceBitDepth: opts?.sourceBitDepth,
  });
  useAppStore.getState().addDocument(doc);
  return doc;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(44100);
  mockGetTempo.mockReset().mockReturnValue(null);
  mockIsTempoRunning.mockReset().mockReturnValue(false);
  mockGetTempoProgress.mockReset().mockReturnValue(null);
  mockRunTempoAnalysis.mockReset().mockResolvedValue(null);
  mockRegridTempo.mockReset().mockResolvedValue(null);
});

/** The value shown in a Properties Row identified by its unique label — used
 * to disambiguate rows that share a value string (Dirty vs Never saved both
 * read Yes/No). */
function rowValue(label: string): string {
  const row = screen.getByText(label).parentElement!;
  return (row.querySelector('span:last-child')?.textContent ?? '').trim();
}

describe('PropertiesPanel (waveform/spectral view)', () => {
  it('shows a "no document" hint when nothing is open', () => {
    render(<PropertiesPanel />);
    expect(screen.getByText(/no document/i)).toBeInTheDocument();
  });

  it('shows document facts: name, path, sample rate, channels, bit depth, duration, samples, dirty', () => {
    addDoc({ channels: 2, filePath: 'C:\\audio\\clip.wav' });
    render(<PropertiesPanel />);

    expect(screen.getByText('clip.wav')).toBeInTheDocument();
    expect(screen.getByText('C:\\audio\\clip.wav')).toBeInTheDocument();
    expect(screen.getByText('44100 Hz')).toBeInTheDocument();
    expect(screen.getByText('Stereo')).toBeInTheDocument();
    // All in-memory audio is Float32 regardless of the source file; the
    // original bit depth isn't tracked after import (KNOWN_LIMITATIONS.md).
    expect(screen.getByText('32-bit float (internal)')).toBeInTheDocument();
    expect(screen.getByText('0:01.000')).toBeInTheDocument(); // 44100 samples @ 44100Hz
    expect(screen.getByText('44,100')).toBeInTheDocument();
    expect(rowValue('Dirty')).toBe('No'); // dirty: false on a fresh doc
    // v1.9.1 item 3: an on-disk document (filePath set) is not never-saved.
    expect(rowValue('Never saved')).toBe('No');
  });

  it('shows "N-bit source → 32-bit float" when the source bit depth is known', () => {
    addDoc({ channels: 2, filePath: 'C:\\audio\\clip.wav', sourceBitDepth: 16 });
    render(<PropertiesPanel />);
    expect(screen.getByText('16-bit source → 32-bit float')).toBeInTheDocument();
    expect(screen.queryByText('32-bit float (internal)')).not.toBeInTheDocument();
  });

  it('shows a mono channel count and a "—" path placeholder when filePath is null', () => {
    addDoc({ channels: 1, filePath: null });
    render(<PropertiesPanel />);
    expect(screen.getByText('Mono')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows "Yes" once the document is dirty', () => {
    const doc = addDoc({ filePath: 'C:\\audio\\clip.wav' }); // saved -> neverSaved false
    useAppStore.getState().updateDocument({ ...doc, dirty: true });
    render(<PropertiesPanel />);
    expect(rowValue('Dirty')).toBe('Yes');
    expect(rowValue('Never saved')).toBe('No');
  });

  // v1.9.1 item 3: never-saved is a SEPARATE provenance row from Dirty. A
  // computed document (no filePath) is clean-but-never-saved from birth.
  it('shows "Never saved: Yes" for a computed (path-less) document that is not dirty', () => {
    addDoc({ filePath: null });
    render(<PropertiesPanel />);
    expect(rowValue('Never saved')).toBe('Yes');
    expect(rowValue('Dirty')).toBe('No'); // distinct from dirty
  });

  it('shows selection start/end/length when a selection exists', () => {
    addDoc();
    useAppStore.getState().setSelection({ start: 4410, end: 13230 }); // 0.1s..0.3s, length 0.2s
    render(<PropertiesPanel />);

    expect(screen.getByText('Selection')).toBeInTheDocument();
    expect(screen.getByText('0:00.100')).toBeInTheDocument(); // start
    expect(screen.getByText('0:00.300')).toBeInTheDocument(); // end
    expect(screen.getByText('0:00.200')).toBeInTheDocument(); // length
  });

  it('omits the selection section when there is no selection', () => {
    addDoc();
    render(<PropertiesPanel />);
    expect(screen.queryByText('Selection')).not.toBeInTheDocument();
  });
});

describe('PropertiesPanel (multitrack view)', () => {
  beforeEach(() => {
    useAppStore.setState({ view: 'multitrack' });
  });

  it('shows "no clip selected" when nothing is selected', () => {
    render(<PropertiesPanel />);
    expect(screen.getByText(/no clip selected/i)).toBeInTheDocument();
  });

  it('shows selected clip facts and an editable gain input', () => {
    const doc = addDoc();
    const trackId = useSessionStore.getState().session.tracks[0].id;
    const clip = createClip({
      documentId: doc.id,
      startSample: 4410, // 0.1s
      offsetSample: 8820, // 0.2s
      lengthSample: 44100, // 1.0s
      gainDb: 3,
    });
    useSessionStore.getState().addClip(trackId, clip);
    useSessionStore.getState().setSelectedClip(clip.id);

    render(<PropertiesPanel />);

    expect(screen.getByText('clip.wav')).toBeInTheDocument();
    // CC3: Start is a field now, not a readout — its value carries the same
    // number the row used to print.
    expect((screen.getByLabelText(/clip start/i) as HTMLInputElement).value).toBe('0:00.100');
    expect(screen.getByText('0:00.200')).toBeInTheDocument(); // offset
    expect(screen.getByText('0:01.000')).toBeInTheDocument(); // length

    const gainInput = screen.getByLabelText(/gain/i) as HTMLInputElement;
    expect(gainInput.value).toBe('3');
  });

  function seedSelectedClip(gainDb = 0) {
    const doc = addDoc();
    const trackId = useSessionStore.getState().session.tracks[0].id;
    const clip = createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 100, gainDb });
    useSessionStore.getState().addClip(trackId, clip);
    useSessionStore.getState().setSelectedClip(clip.id);
    return clip;
  }

  function clipGain(clipId: string): number {
    return useSessionStore
      .getState()
      .session.tracks.flatMap((t) => t.clips)
      .find((c) => c.id === clipId)!.gainDb;
  }

  it('commits the typed gain to setClipGain on blur', () => {
    const clip = seedSelectedClip();

    render(<PropertiesPanel />);
    const gainInput = screen.getByLabelText(/gain/i);
    fireEvent.change(gainInput, { target: { value: '-6' } });
    fireEvent.blur(gainInput);

    expect(clipGain(clip.id)).toBe(-6);
  });

  it('commits the typed gain on Enter', () => {
    const clip = seedSelectedClip();

    render(<PropertiesPanel />);
    const gainInput = screen.getByLabelText(/gain/i);
    fireEvent.change(gainInput, { target: { value: '4.5' } });
    fireEvent.keyDown(gainInput, { key: 'Enter' });

    expect(clipGain(clip.id)).toBe(4.5);
  });

  it('keeps an intermediate draft like "1." in the input without snapping it (commits only on blur)', () => {
    const clip = seedSelectedClip();

    render(<PropertiesPanel />);
    const gainInput = screen.getByLabelText(/gain/i) as HTMLInputElement;
    fireEvent.change(gainInput, { target: { value: '1.' } });

    // Mid-typing: the store is untouched and the draft text survives verbatim
    // (the old value={clip.gainDb} binding snapped '1.' back to '1').
    expect(clipGain(clip.id)).toBe(0);
    expect(gainInput.value).toBe('1.');

    fireEvent.change(gainInput, { target: { value: '1.5' } });
    fireEvent.blur(gainInput);
    expect(clipGain(clip.id)).toBe(1.5);
  });

  it('reverts the draft to the current gain when blurred with garbage input', () => {
    const clip = seedSelectedClip(3);

    render(<PropertiesPanel />);
    const gainInput = screen.getByLabelText(/gain/i) as HTMLInputElement;
    fireEvent.change(gainInput, { target: { value: '' } });
    fireEvent.blur(gainInput);

    expect(clipGain(clip.id)).toBe(3); // unchanged
    expect(gainInput.value).toBe('3'); // draft reverted
  });

  it('Escape reverts the draft to the committed value and blurs without committing (Task F8)', () => {
    const clip = seedSelectedClip(3);

    render(<PropertiesPanel />);
    const gainInput = screen.getByLabelText(/gain/i) as HTMLInputElement;
    gainInput.focus();
    fireEvent.change(gainInput, { target: { value: '-12' } });
    fireEvent.keyDown(gainInput, { key: 'Escape' });

    expect(clipGain(clip.id)).toBe(3); // store untouched
    expect(gainInput.value).toBe('3'); // draft reverted
    expect(document.activeElement).not.toBe(gainInput); // blurred

    // A later blur must not resurrect the abandoned draft as a commit.
    fireEvent.blur(gainInput);
    expect(clipGain(clip.id)).toBe(3);
  });

  it('shows the clamped value in the input after committing an out-of-range gain', () => {
    const clip = seedSelectedClip();

    render(<PropertiesPanel />);
    const gainInput = screen.getByLabelText(/gain/i) as HTMLInputElement;
    fireEvent.change(gainInput, { target: { value: '100' } });
    fireEvent.blur(gainInput);

    expect(clipGain(clip.id)).toBe(24); // store clamps to +24
    expect(gainInput.value).toBe('24'); // draft reflects the clamp
  });

  // ── CC3: a clip start you can TYPE ────────────────────────────────────────

  /**
   * Drag was the only way to place a clip, which made every stated offset —
   * the Cover Chain's refused guess above all — an eyeball exercise with no
   * snap target at the position it names. The field commits through the
   * store's own `moveClip`, so its clamp and its one undo entry are the
   * store's, not a second implementation of either.
   */
  describe('the clip Start field', () => {
    function seedStartedClip(startSample: number) {
      const doc = addDoc();
      const trackId = useSessionStore.getState().session.tracks[0].id;
      const clip = createClip({
        documentId: doc.id,
        startSample,
        offsetSample: 0,
        lengthSample: 44100,
      });
      useSessionStore.getState().addClip(trackId, clip);
      useSessionStore.getState().setSelectedClip(clip.id);
      clearSessionHistory();
      return clip;
    }

    const clipStart = (clipId: string): number =>
      useSessionStore
        .getState()
        .session.tracks.flatMap((t) => t.clips)
        .find((c) => c.id === clipId)!.startSample;

    it('commits a typed position on blur, as one undo entry', () => {
      const clip = seedStartedClip(0);
      render(<PropertiesPanel />);
      const field = screen.getByLabelText(/clip start/i);
      fireEvent.change(field, { target: { value: '0:08.258' } });
      fireEvent.blur(field);

      expect(clipStart(clip.id)).toBe(Math.round(8.258 * 44100));
      expect(getHistory(SESSION_UNDO_KEY).done).toEqual(['Move clip']);
    });

    it('commits on Enter, and accepts plain seconds as well as m:ss.mmm', () => {
      const clip = seedStartedClip(0);
      render(<PropertiesPanel />);
      const field = screen.getByLabelText(/clip start/i);
      fireEvent.change(field, { target: { value: '8.258' } });
      fireEvent.keyDown(field, { key: 'Enter' });

      expect(clipStart(clip.id)).toBe(Math.round(8.258 * 44100));
    });

    it('echoes the position the STORE kept, not the text that was typed', () => {
      const clip = seedStartedClip(0);
      render(<PropertiesPanel />);
      const field = screen.getByLabelText(/clip start/i) as HTMLInputElement;
      fireEvent.change(field, { target: { value: '2.5' } });
      fireEvent.blur(field);

      // Re-queried, not held: a committed move re-keys the field, so what the
      // user is looking at afterwards is the field the store's own position
      // rendered — never the string they typed.
      const after = screen.getByLabelText(/clip start/i) as HTMLInputElement;
      expect(after.value).toBe(formatTime(clipStart(clip.id), 44100));
      expect(after.value).toBe('0:02.500');
    });

    it('refuses a position before zero rather than pretending to place one there', () => {
      const clip = seedStartedClip(44100);
      render(<PropertiesPanel />);
      const field = screen.getByLabelText(/clip start/i) as HTMLInputElement;
      fireEvent.change(field, { target: { value: '-3' } });
      fireEvent.blur(field);

      // No clip can start before zero (the store clamps), so the field reverts
      // rather than silently committing a 0 the user did not ask for.
      expect(clipStart(clip.id)).toBe(44100);
      expect(field.value).toBe('0:01.000');
      expect(getHistory(SESSION_UNDO_KEY).done).toEqual([]);
    });

    it('reverts garbage to the committed position and leaves the clip alone', () => {
      const clip = seedStartedClip(44100);
      render(<PropertiesPanel />);
      const field = screen.getByLabelText(/clip start/i) as HTMLInputElement;
      fireEvent.change(field, { target: { value: 'somewhere' } });
      fireEvent.blur(field);

      expect(clipStart(clip.id)).toBe(44100);
      expect(field.value).toBe('0:01.000');
    });

    it('abandons the draft on Escape without committing it', () => {
      const clip = seedStartedClip(44100);
      render(<PropertiesPanel />);
      const field = screen.getByLabelText(/clip start/i) as HTMLInputElement;
      fireEvent.change(field, { target: { value: '5' } });
      fireEvent.keyDown(field, { key: 'Escape' });

      expect(clipStart(clip.id)).toBe(44100);
      expect(field.value).toBe('0:01.000');
      expect(document.activeElement).not.toBe(field);
      // A later blur must not resurrect the abandoned draft as a commit.
      fireEvent.blur(field);
      expect(clipStart(clip.id)).toBe(44100);
    });

    /**
     * Fix round 1 (I1). `formatTime` rounds to whole milliseconds and
     * `parseTime` re-derives samples from that string, so committing a draft
     * nobody edited would nudge any clip that does not sit on a millisecond
     * boundary — which is every dragged clip. 44101 at 44.1 kHz formats as
     * `0:01.000` and parses back as 44100: one sample of silent movement, plus
     * a `maintainFacingFades` pass and an undo entry, for a click that typed
     * nothing. Every other fixture in this file is millisecond-exact and
     * therefore blind to it.
     */
    const OFF_GRID = 44101;

    it('does not move the clip when a blur commits a draft nobody edited', () => {
      const clip = seedStartedClip(OFF_GRID);
      render(<PropertiesPanel />);
      const field = screen.getByLabelText(/clip start/i);
      fireEvent.focus(field);
      fireEvent.blur(field);

      expect(clipStart(clip.id)).toBe(OFF_GRID);
      expect(getHistory(SESSION_UNDO_KEY).done).toEqual([]);
    });

    it('does not move the clip on the blur that follows an Escape', () => {
      const clip = seedStartedClip(OFF_GRID);
      render(<PropertiesPanel />);
      const field = screen.getByLabelText(/clip start/i);
      fireEvent.change(field, { target: { value: '5' } });
      fireEvent.keyDown(field, { key: 'Escape' });
      fireEvent.blur(field);

      expect(clipStart(clip.id)).toBe(OFF_GRID);
      expect(getHistory(SESSION_UNDO_KEY).done).toEqual([]);
    });

    it('does not move the clip when the typed text is another spelling of where it is', () => {
      const clip = seedStartedClip(44100);
      render(<PropertiesPanel />);
      const field = screen.getByLabelText(/clip start/i) as HTMLInputElement;
      fireEvent.change(field, { target: { value: '1' } }); // 1 s === 0:01.000
      fireEvent.blur(field);

      expect(clipStart(clip.id)).toBe(44100);
      expect(getHistory(SESSION_UNDO_KEY).done).toEqual([]);
      expect(field.value).toBe('0:01.000'); // …and the field says so in its own words
    });

    /**
     * H1 (fix-round-1 re-review, m1). The spelling guard used to be
     * SAMPLE-exact, so it did not fire on an off-grid clip: at 44101 the field
     * reads `0:01.000`, the user types `1`, and 44100 ≠ 44101 committed a
     * one-sample move, a `maintainFacingFades` pass and an undo entry — while
     * the field read `0:01.000` before and `0:01.000` after. Typing the same
     * request as `0:01.000` was caught by the first guard and wrote nothing, so
     * two spellings of one request behaved differently and neither showed the
     * user anything.
     *
     * The guard is on what the user can SEE: input that formats to the text
     * already committed is another spelling of the position the clip already
     * holds, whatever the sub-millisecond remainder says. A move the display
     * cannot show is not a move the user asked for.
     */
    it('does not move an OFF-GRID clip when the typed text formats to what it already reads', () => {
      const clip = seedStartedClip(OFF_GRID);
      render(<PropertiesPanel />);
      const field = screen.getByLabelText(/clip start/i) as HTMLInputElement;
      expect(field.value).toBe('0:01.000');
      fireEvent.change(field, { target: { value: '1' } }); // 1 s formats to 0:01.000
      fireEvent.blur(field);

      expect(clipStart(clip.id)).toBe(OFF_GRID);
      expect(getHistory(SESSION_UNDO_KEY).done).toEqual([]);
      expect(field.value).toBe('0:01.000');
    });

    /** …and the guard is not over-broad: a request that formats DIFFERENTLY is
     * a real move, off-grid start or not, and still commits one entry. */
    it('still commits a typed position that reads differently from an off-grid one', () => {
      const clip = seedStartedClip(OFF_GRID);
      render(<PropertiesPanel />);
      const field = screen.getByLabelText(/clip start/i) as HTMLInputElement;
      fireEvent.change(field, { target: { value: '1.001' } });
      fireEvent.blur(field);

      expect(clipStart(clip.id)).toBe(Math.round(1.001 * 44100));
      expect(getHistory(SESSION_UNDO_KEY).done).toEqual(['Move clip']);
    });

    it('picks up a position that moved from elsewhere while the panel was open', () => {
      const clip = seedStartedClip(0);
      const { rerender } = render(<PropertiesPanel />);
      const trackId = useSessionStore.getState().session.tracks[0].id;
      useSessionStore.getState().moveClip(clip.id, trackId, 44100);
      rerender(<PropertiesPanel />);

      expect((screen.getByLabelText(/clip start/i) as HTMLInputElement).value).toBe('0:01.000');
    });
  });
});

describe('PropertiesPanel — Tempo section (Task T5)', () => {
  it('has a properties-tempo container', () => {
    addDoc();
    render(<PropertiesPanel />);
    expect(screen.getByTestId('properties-tempo')).toBeInTheDocument();
  });

  it('empty state: renders tempo-analyze-button; clicking it calls runTempoAnalysis with the active doc', () => {
    const doc = addDoc();
    render(<PropertiesPanel />);

    const button = screen.getByTestId('tempo-analyze-button');
    expect(button).toBeInTheDocument();
    fireEvent.click(button);

    expect(mockRunTempoAnalysis).toHaveBeenCalledWith(doc);
  });

  it('a seeded entry renders BPM, confidence and beat count', () => {
    addDoc();
    mockGetTempo.mockReturnValue(makeTempoEntry({ bpm: 128.4, confidence: 0.72, beatSamples: new Int32Array(642) }));
    render(<PropertiesPanel />);

    expect(screen.getByText('128.4 BPM')).toBeInTheDocument();
    expect(screen.getByText('72%')).toBeInTheDocument();
    expect(screen.getByText('642')).toBeInTheDocument();
  });

  it('confidence below CONFIDENCE_LOW (0.35) renders "18% · low" in the muted class', () => {
    addDoc();
    mockGetTempo.mockReturnValue(makeTempoEntry({ confidence: 0.18 }));
    render(<PropertiesPanel />);

    const confidenceValue = screen.getByText('18% · low');
    expect(confidenceValue).toBeInTheDocument();
    expect(confidenceValue.className).toContain('text-[#8b8b92]');
  });

  it('a stale entry appends "(stale)" to the tempo value and shows a Re-analyze button', () => {
    const doc = addDoc();
    mockGetTempo.mockReturnValue(makeTempoEntry({ stale: true }));
    render(<PropertiesPanel />);

    expect(screen.getByText(/\(stale\)/)).toBeInTheDocument();
    const reanalyze = screen.getByTestId('tempo-reanalyze-button');
    expect(reanalyze).toBeInTheDocument();

    fireEvent.click(reanalyze);
    expect(mockRunTempoAnalysis).toHaveBeenCalledWith(doc);
  });

  it('bpm null with 2s analysed renders "—" and "too short"', () => {
    addDoc();
    mockGetTempo.mockReturnValue(
      makeTempoEntry({ bpm: null, analyzedEndSample: 2 * 44100, beatSamples: new Int32Array(0) })
    );
    render(<PropertiesPanel />);

    const tempoSection = within(screen.getByTestId('properties-tempo'));
    expect(tempoSection.getByText(/—/)).toBeInTheDocument();
    expect(tempoSection.getByText(/too short/)).toBeInTheDocument();
  });

  it('bpm null with 20s analysed renders "—" and "no rhythm detected"', () => {
    addDoc();
    mockGetTempo.mockReturnValue(
      makeTempoEntry({ bpm: null, analyzedEndSample: 20 * 44100, beatSamples: new Int32Array(0) })
    );
    render(<PropertiesPanel />);

    const tempoSection = within(screen.getByTestId('properties-tempo'));
    expect(tempoSection.getByText(/—/)).toBeInTheDocument();
    expect(tempoSection.getByText(/no rhythm detected/)).toBeInTheDocument();
  });

  it('truncated:true appends "(first 10 min)"', () => {
    addDoc();
    mockGetTempo.mockReturnValue(makeTempoEntry({ truncated: true }));
    render(<PropertiesPanel />);

    expect(screen.getByText(/\(first 10 min\)/)).toBeInTheDocument();
  });

  it('isTempoRunning true renders tempo-progress with the expected width and no analyze button', () => {
    addDoc();
    mockIsTempoRunning.mockReturnValue(true);
    mockGetTempoProgress.mockReturnValue(0.4);
    render(<PropertiesPanel />);

    const bar = screen.getByTestId('tempo-progress');
    expect(bar).toHaveStyle({ width: '40%' });
    expect(screen.queryByTestId('tempo-analyze-button')).not.toBeInTheDocument();
  });

  describe('octave correction control (x2 / /2)', () => {
    it('renders x2 and /2 buttons beside a valid BPM result', () => {
      addDoc();
      mockGetTempo.mockReturnValue(makeTempoEntry({ periodFrames: 200 }));
      render(<PropertiesPanel />);

      expect(screen.getByTestId('tempo-double-button')).toBeInTheDocument();
      expect(screen.getByTestId('tempo-halve-button')).toBeInTheDocument();
    });

    it('does NOT render x2//2 buttons when bpm is null (nothing to correct)', () => {
      addDoc();
      mockGetTempo.mockReturnValue(makeTempoEntry({ bpm: null, beatSamples: new Int32Array(0) }));
      render(<PropertiesPanel />);

      expect(screen.queryByTestId('tempo-double-button')).not.toBeInTheDocument();
      expect(screen.queryByTestId('tempo-halve-button')).not.toBeInTheDocument();
    });

    it('x2 calls regridTempo with HALF the current periodFrames (re-tracks, does not relabel)', async () => {
      const doc = addDoc();
      mockGetTempo.mockReturnValue(makeTempoEntry({ periodFrames: 200 }));
      render(<PropertiesPanel />);

      fireEvent.click(screen.getByTestId('tempo-double-button'));

      await waitFor(() => expect(mockRegridTempo).toHaveBeenCalledWith(doc.id, 100));
    });

    it('/2 calls regridTempo with DOUBLE the current periodFrames (re-tracks, does not relabel)', async () => {
      const doc = addDoc();
      mockGetTempo.mockReturnValue(makeTempoEntry({ periodFrames: 200 }));
      render(<PropertiesPanel />);

      fireEvent.click(screen.getByTestId('tempo-halve-button'));

      await waitFor(() => expect(mockRegridTempo).toHaveBeenCalledWith(doc.id, 400));
    });

    it('a successful correction shows the NEWLY re-tracked beat count, not just a relabeled BPM', async () => {
      const doc = addDoc();
      const before = makeTempoEntry({ bpm: 64.2, periodFrames: 400, beatSamples: new Int32Array(320) });
      const after = makeTempoEntry({ bpm: 128.4, periodFrames: 200, beatSamples: new Int32Array(640) });
      mockGetTempo.mockReturnValue(before);
      mockRegridTempo.mockImplementation(async () => {
        // Simulate the real cache being overwritten by the worker's 'done'
        // reply before this promise resolves — genuine re-tracking, not a
        // display-only relabel of `before`.
        mockGetTempo.mockReturnValue(after);
        return after;
      });

      render(<PropertiesPanel />);
      expect(screen.getByText('320')).toBeInTheDocument(); // pre-correction beat count

      fireEvent.click(screen.getByTestId('tempo-double-button'));

      await waitFor(() => expect(screen.getByText('640')).toBeInTheDocument());
      expect(screen.getByText('128.4 BPM')).toBeInTheDocument();
      expect(screen.queryByText('320')).not.toBeInTheDocument();
    });

    it('a degenerate (null) correction result is surfaced and the previous grid is left showing', async () => {
      const doc = addDoc();
      const entry = makeTempoEntry({ periodFrames: 200, beatSamples: new Int32Array(642) });
      mockGetTempo.mockReturnValue(entry);
      mockRegridTempo.mockResolvedValue(null); // the entry is unchanged in the cache

      render(<PropertiesPanel />);
      fireEvent.click(screen.getByTestId('tempo-double-button'));

      expect(mockRegridTempo).toHaveBeenCalledWith(doc.id, 100);
      await waitFor(() => expect(screen.getByTestId('tempo-correction-failed')).toBeInTheDocument());
      // The previous, still-good grid keeps showing — never blanked or relabeled.
      expect(screen.getByText('642')).toBeInTheDocument();
      expect(screen.getByText('128.4 BPM')).toBeInTheDocument();
    });
  });
});
