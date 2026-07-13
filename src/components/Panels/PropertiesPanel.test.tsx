import { render, screen, fireEvent } from '@testing-library/react';
import PropertiesPanel from './PropertiesPanel';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { createClip } from '../../multitrack/session';

function addDoc(opts?: Partial<{ channels: number; filePath: string | null }>): AudioDocument {
  const channelCount = opts?.channels ?? 1;
  const channels = Array.from({ length: channelCount }, () => new Float32Array(44100)); // 1s @ 44100Hz
  const doc = createDocument({
    name: 'clip.wav',
    sampleRate: 44100,
    channels,
    filePath: opts?.filePath,
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

  it('shows document facts: name, path, sample rate, channels, duration, samples, dirty', () => {
    addDoc({ channels: 2, filePath: 'C:\\audio\\clip.wav' });
    render(<PropertiesPanel />);

    expect(screen.getByText('clip.wav')).toBeInTheDocument();
    expect(screen.getByText('C:\\audio\\clip.wav')).toBeInTheDocument();
    expect(screen.getByText('44100 Hz')).toBeInTheDocument();
    expect(screen.getByText('Stereo')).toBeInTheDocument();
    expect(screen.getByText('0:01.000')).toBeInTheDocument(); // 44100 samples @ 44100Hz
    expect(screen.getByText('44,100')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument(); // dirty: false on a fresh doc
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

  it('editing the gain input calls setClipGain with the clip id and the new value', () => {
    const doc = addDoc();
    const trackId = useSessionStore.getState().session.tracks[0].id;
    const clip = createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 100 });
    useSessionStore.getState().addClip(trackId, clip);
    useSessionStore.getState().setSelectedClip(clip.id);

    render(<PropertiesPanel />);
    const gainInput = screen.getByLabelText(/gain/i);
    fireEvent.change(gainInput, { target: { value: '-6' } });

    const updatedClip = useSessionStore
      .getState()
      .session.tracks.flatMap((t) => t.clips)
      .find((c) => c.id === clip.id)!;
    expect(updatedClip.gainDb).toBe(-6);
  });
});
