import { render, screen, fireEvent } from '@testing-library/react';
import TransportBar from './TransportBar';
import LevelMeter from './LevelMeter';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { registerDialogSetters } from '../../services/dialogBus';

function makeDoc(): AudioDocument {
  return createDocument({
    name: 'clip.wav',
    sampleRate: 44100,
    channels: [new Float32Array(4096), new Float32Array(4096)],
  });
}

describe('TransportBar', () => {
  beforeEach(() => {
    useAppStore.setState(makeInitialState());
  });

  it('renders the transport controls and time readout', () => {
    render(<TransportBar />);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Loop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record' })).toBeInTheDocument();
    expect(screen.getByTestId('transport-time')).toHaveTextContent('0:00.000');
  });

  it('disables playback controls when no document is open (Record stays enabled)', () => {
    render(<TransportBar />);
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    // Record is always enabled — the dialog owns device selection/errors and
    // recording creates a brand-new document, so no active doc is required.
    expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled();
  });

  it('enables play/stop/loop once a document is active', () => {
    const doc = makeDoc();
    useAppStore.getState().addDocument(doc);
    render(<TransportBar />);
    expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Loop' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled();
  });

  it('opens the Record dialog when the Record button is clicked', () => {
    const openRecord = jest.fn();
    registerDialogSetters({
      openExportDialog: () => {},
      openNewFileDialog: () => {},
      openEffectDialog: () => {},
      openConvertDialog: () => {},
      openRecordDialog: openRecord,
    });
    render(<TransportBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(openRecord).toHaveBeenCalled();
  });

  it('toggles the loop flag in the store when the loop button is clicked', () => {
    useAppStore.getState().addDocument(makeDoc());
    render(<TransportBar />);
    expect(useAppStore.getState().playback.loop).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Loop' }));
    expect(useAppStore.getState().playback.loop).toBe(true);
  });

  it('shows the cursor time while stopped', () => {
    const doc = makeDoc();
    useAppStore.getState().addDocument(doc);
    useAppStore.getState().setCursor(44100); // 1 second
    render(<TransportBar />);
    expect(screen.getByTestId('transport-time')).toHaveTextContent('0:01.000');
  });
});

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
