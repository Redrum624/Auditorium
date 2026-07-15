import { render, screen, fireEvent } from '@testing-library/react';
import PropertiesPanel from './PropertiesPanel';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { createClip } from '../../multitrack/session';

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
});

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
    expect(screen.getByText('No')).toBeInTheDocument(); // dirty: false on a fresh doc
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
    const doc = addDoc();
    useAppStore.getState().updateDocument({ ...doc, dirty: true });
    render(<PropertiesPanel />);
    expect(screen.getByText('Yes')).toBeInTheDocument();
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
    expect(screen.getByText('0:00.100')).toBeInTheDocument(); // start
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
});
