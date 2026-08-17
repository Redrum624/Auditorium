import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import RecordDialog from './RecordDialog';
import type { RecordingEngine } from '../../audio/RecordingEngine';
import { useAppStore, makeInitialState } from '../../stores/appStore';

// A hand-rolled RecordingEngine stand-in exposing just the surface the dialog
// touches, so we never construct a real Web Audio graph in jsdom.
class FakeEngine {
  isRecording = false;
  levelCb: ((db: number) => void) | null = null;
  listInputs = jest.fn(async () => [{ deviceId: 'mic-a', label: 'Mic A' }]);
  onLevel = jest.fn((cb: (db: number) => void) => {
    this.levelCb = cb;
    return () => {
      this.levelCb = null;
    };
  });
  start = jest.fn(async () => {
    this.isRecording = true;
  });
  stop = jest.fn(async () => {
    this.isRecording = false;
    return { channels: [new Float32Array(88200)], sampleRate: 44100 };
  });
}

function asEngine(fake: FakeEngine): RecordingEngine {
  return fake as unknown as RecordingEngine;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  jest.clearAllMocks();
  (window as unknown as { electronAPI: { showMessageBox: jest.Mock } }).electronAPI = {
    showMessageBox: jest.fn(async () => 0),
  };
});

describe('RecordDialog', () => {
  it('lists input devices on open and offers channel/rate selects', async () => {
    const fake = new FakeEngine();
    render(<RecordDialog onClose={() => {}} engine={asEngine(fake)} />);
    await waitFor(() => expect(fake.listInputs).toHaveBeenCalled());
    expect(await screen.findByRole('option', { name: 'Mic A' })).toBeInTheDocument();
    expect(screen.getByTestId('record-channels')).toBeInTheDocument();
    expect(screen.getByTestId('record-rate')).toBeInTheDocument();
  });

  it('starts recording with the chosen channels/rate and toggles to Stop', async () => {
    const fake = new FakeEngine();
    render(<RecordDialog onClose={() => {}} engine={asEngine(fake)} />);

    fireEvent.change(screen.getByTestId('record-channels'), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('record-rate'), { target: { value: '48000' } });
    fireEvent.click(screen.getByTestId('record-toggle'));

    await waitFor(() => expect(fake.start).toHaveBeenCalled());
    expect(fake.start).toHaveBeenCalledWith({
      deviceId: undefined,
      channels: 2,
      sampleRate: 48000,
    });
    expect(await screen.findByRole('button', { name: 'Stop recording' })).toBeInTheDocument();
  });

  it('creates a Recording document and closes on Stop', async () => {
    const fake = new FakeEngine();
    const onClose = jest.fn();
    render(<RecordDialog onClose={onClose} engine={asEngine(fake)} />);

    fireEvent.click(screen.getByTestId('record-toggle')); // start
    await screen.findByRole('button', { name: 'Stop recording' });
    fireEvent.click(screen.getByTestId('record-toggle')); // stop

    await waitFor(() => expect(fake.stop).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const docs = useAppStore.getState().documents;
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toMatch(/^Recording \d+$/);
    expect(docs[0].sampleRate).toBe(44100);
    expect(docs[0].channels[0]).toHaveLength(88200);
    // Task S4: a take exists only in memory until it is saved, so it carries
    // the neverSaved provenance flag and prompts on close.
    expect(docs[0].neverSaved).toBe(true);
  });

  it('shows an error box and stays open when start() rejects', async () => {
    const fake = new FakeEngine();
    fake.start = jest.fn(async () => {
      throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    });
    const onClose = jest.fn();
    const showMessageBox = (window as unknown as { electronAPI: { showMessageBox: jest.Mock } })
      .electronAPI.showMessageBox;

    render(<RecordDialog onClose={onClose} engine={asEngine(fake)} />);
    fireEvent.click(screen.getByTestId('record-toggle'));

    await waitFor(() => expect(showMessageBox).toHaveBeenCalled());
    expect(showMessageBox.mock.calls[0][0]).toMatchObject({ type: 'error' });
    expect(onClose).not.toHaveBeenCalled();
    // Still showing the Record (not Stop) button.
    expect(screen.getByRole('button', { name: 'Start recording' })).toBeInTheDocument();
  });

  describe('dismissal veto while recording (Task M7/F12)', () => {
    it('Escape does not dismiss or discard the take while recording', async () => {
      const fake = new FakeEngine();
      const onClose = jest.fn();
      render(<RecordDialog onClose={onClose} engine={asEngine(fake)} />);
      fireEvent.click(screen.getByTestId('record-toggle')); // start
      await screen.findByRole('button', { name: 'Stop recording' });

      fireEvent.keyDown(document, { key: 'Escape' });

      expect(onClose).not.toHaveBeenCalled();
      expect(fake.stop).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Stop recording' })).toBeInTheDocument();
    });

    it('a backdrop mousedown does not dismiss or discard the take while recording', async () => {
      const fake = new FakeEngine();
      const onClose = jest.fn();
      render(<RecordDialog onClose={onClose} engine={asEngine(fake)} />);
      fireEvent.click(screen.getByTestId('record-toggle')); // start
      await screen.findByRole('button', { name: 'Stop recording' });

      fireEvent.mouseDown(screen.getByTestId('dialog-overlay'));

      expect(onClose).not.toHaveBeenCalled();
      expect(fake.stop).not.toHaveBeenCalled();
    });

    it('the explicit Stop button still commits the take after a vetoed Escape', async () => {
      const fake = new FakeEngine();
      const onClose = jest.fn();
      render(<RecordDialog onClose={onClose} engine={asEngine(fake)} />);
      fireEvent.click(screen.getByTestId('record-toggle')); // start
      await screen.findByRole('button', { name: 'Stop recording' });
      fireEvent.keyDown(document, { key: 'Escape' }); // vetoed, no-op

      fireEvent.click(screen.getByTestId('record-toggle')); // stop

      await waitFor(() => expect(fake.stop).toHaveBeenCalled());
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(useAppStore.getState().documents).toHaveLength(1);
    });

    it('Escape dismisses normally while not recording (veto is scoped to active recording only)', () => {
      const fake = new FakeEngine();
      const onClose = jest.fn();
      render(<RecordDialog onClose={onClose} engine={asEngine(fake)} />);

      fireEvent.keyDown(document, { key: 'Escape' });

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('updates the live level bar from engine.onLevel', async () => {
    const fake = new FakeEngine();
    render(<RecordDialog onClose={() => {}} engine={asEngine(fake)} />);
    await waitFor(() => expect(fake.onLevel).toHaveBeenCalled());

    const bar = () => screen.getByTestId('record-level').firstChild as HTMLElement;
    expect(bar().style.width).toBe('0%'); // -60 dB -> 0%
    // Push a -6 dB level; the bar should widen to ~90%.
    act(() => fake.levelCb?.(-6));
    await waitFor(() => expect(bar().style.width).toBe('90%'));
  });
});

describe('G5 glass header', () => {
  it('carries a lucide icon tile in the shell header', () => {
    const fake = new FakeEngine();
    render(<RecordDialog onClose={() => {}} engine={asEngine(fake)} />);
    expect(screen.getByTestId('dialog-icon')).toBeInTheDocument();
  });
});
