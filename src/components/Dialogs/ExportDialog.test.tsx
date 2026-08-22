import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ExportDialog from './ExportDialog';
import { exportDocument, exportSessionMixdown } from '../../services/fileService';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import { createDocument } from '../../audio/AudioDocument';

jest.mock('../../services/fileService', () => ({
  exportDocument: jest.fn(async () => 'D:\\out\\track.wav'),
  exportSessionMixdown: jest.fn(async () => 'D:\\out\\mix.wav'),
}));

const mockExport = exportDocument as jest.MockedFunction<typeof exportDocument>;
const mockExportSession = exportSessionMixdown as jest.MockedFunction<typeof exportSessionMixdown>;

function seedActiveDoc() {
  const doc = createDocument({
    name: 'song.wav',
    sampleRate: 44100,
    channels: [new Float32Array(4), new Float32Array(4)],
  });
  useAppStore.getState().addDocument(doc);
  return doc;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(44100);
  jest.clearAllMocks();
  mockExport.mockResolvedValue('D:\\out\\track.wav');
  mockExportSession.mockResolvedValue('D:\\out\\mix.wav');
});

describe('ExportDialog', () => {
  it('defaults to WAV and shows the bit-depth select (not kbps)', () => {
    seedActiveDoc();
    render(<ExportDialog onClose={() => {}} />);
    expect(screen.getByTestId('export-bitdepth')).toBeInTheDocument();
    expect(screen.queryByTestId('export-kbps')).not.toBeInTheDocument();
  });

  it('the controls that are ALWAYS present carry testids too', () => {
    // T4. The three quality selects have had testids since they were written;
    // the root, the format select and the two buttons had none, and those are
    // exactly the controls a walker leg needs — the quality select it can find
    // is the one that changes identity with the format. So `e2e-navigate` was
    // left querying this dialog by visible text.
    seedActiveDoc();
    render(<ExportDialog onClose={() => {}} />);
    for (const id of ['export-dialog', 'export-format', 'export-cancel', 'export-confirm']) {
      expect([id, screen.queryByTestId(id) !== null]).toEqual([id, true]);
    }
    expect(screen.getByTestId('export-format')).toBe(screen.getByLabelText('Format'));
    expect(screen.getByTestId('export-confirm')).toBe(
      screen.getByRole('button', { name: 'Export' })
    );
    expect(screen.getByTestId('export-cancel')).toBe(
      screen.getByRole('button', { name: 'Cancel' })
    );
  });

  it('swaps bit-depth for kbps when the format is set to MP3', () => {
    seedActiveDoc();
    render(<ExportDialog onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'mp3' } });
    expect(screen.getByTestId('export-kbps')).toBeInTheDocument();
    expect(screen.queryByTestId('export-bitdepth')).not.toBeInTheDocument();
  });

  it('exports the active doc with the chosen WAV bit depth and closes on success', async () => {
    const doc = seedActiveDoc();
    const onClose = jest.fn();
    render(<ExportDialog onClose={onClose} />);

    fireEvent.change(screen.getByTestId('export-bitdepth'), { target: { value: '32' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(mockExport).toHaveBeenCalled());
    expect(mockExport).toHaveBeenCalledWith(doc.id, {
      format: 'wav',
      wavBitDepth: 32,
      mp3Kbps: 192,
      oggBitrate: 128_000,
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('exports MP3 at the chosen bit rate', async () => {
    const doc = seedActiveDoc();
    render(<ExportDialog onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'mp3' } });
    fireEvent.change(screen.getByTestId('export-kbps'), { target: { value: '320' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(mockExport).toHaveBeenCalled());
    expect(mockExport).toHaveBeenCalledWith(doc.id, {
      format: 'mp3',
      wavBitDepth: 24,
      mp3Kbps: 320,
      oggBitrate: 128_000,
    });
  });

  it('swaps to an OGG bit-rate select and exports Opus at the chosen bitrate', async () => {
    const doc = seedActiveDoc();
    render(<ExportDialog onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'ogg' } });
    expect(screen.getByTestId('export-ogg-bitrate')).toBeInTheDocument();
    expect(screen.queryByTestId('export-bitdepth')).not.toBeInTheDocument();
    expect(screen.queryByTestId('export-kbps')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('export-ogg-bitrate'), { target: { value: '192000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(mockExport).toHaveBeenCalled());
    expect(mockExport).toHaveBeenCalledWith(doc.id, {
      format: 'ogg',
      wavBitDepth: 24,
      mp3Kbps: 192,
      oggBitrate: 192_000,
    });
  });

  it('exports FLAC (16-bit) with no quality select shown', async () => {
    const doc = seedActiveDoc();
    render(<ExportDialog onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'flac' } });
    // FLAC has no quality control: neither the bit-depth nor the kbps select.
    expect(screen.queryByTestId('export-bitdepth')).not.toBeInTheDocument();
    expect(screen.queryByTestId('export-kbps')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(mockExport).toHaveBeenCalled());
    expect(mockExport).toHaveBeenCalledWith(doc.id, {
      format: 'flac',
      wavBitDepth: 24,
      mp3Kbps: 192,
      oggBitrate: 128_000,
    });
  });

  it('stays open when export is cancelled (returns null)', async () => {
    seedActiveDoc();
    mockExport.mockResolvedValue(null);
    const onClose = jest.fn();
    render(<ExportDialog onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(mockExport).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('G5 glass header', () => {
  it('carries a lucide icon tile and the active doc name as subtitle', () => {
    seedActiveDoc();
    render(<ExportDialog onClose={() => {}} />);
    expect(screen.getByTestId('dialog-icon')).toBeInTheDocument();
    expect(screen.getByText('song.wav')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Lot A (M5) — in the multitrack view the dialog exports the session mixdown.
// ---------------------------------------------------------------------------
describe('ExportDialog in the multitrack view (lot A — acceptance 21)', () => {
  it('clicking Export calls exportSessionMixdown with the chosen options, not exportDocument, and closes on success', async () => {
    seedActiveDoc(); // a document IS open — and is still not what gets exported
    useAppStore.setState({ view: 'multitrack' });
    const onClose = jest.fn();
    render(<ExportDialog onClose={onClose} />);

    fireEvent.change(screen.getByTestId('export-bitdepth'), { target: { value: '32' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(mockExportSession).toHaveBeenCalled());
    expect(mockExportSession).toHaveBeenCalledWith({
      format: 'wav',
      wavBitDepth: 32,
      mp3Kbps: 192,
      oggBitrate: 128_000,
    });
    expect(mockExport).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('exports with NO active document at all', async () => {
    useAppStore.setState({ view: 'multitrack' });
    expect(useAppStore.getState().activeDocumentId).toBeNull();
    render(<ExportDialog onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(mockExportSession).toHaveBeenCalledTimes(1));
    expect(mockExport).not.toHaveBeenCalled();
  });

  it('shows the session name as the subtitle', () => {
    seedActiveDoc();
    useSessionStore.getState().renameSession('Night Take');
    useAppStore.setState({ view: 'multitrack' });
    render(<ExportDialog onClose={() => {}} />);

    expect(screen.getByText('Night Take')).toBeInTheDocument();
    expect(screen.queryByText('song.wav')).not.toBeInTheDocument();
  });

  it('stays open when the session export returns null', async () => {
    useAppStore.setState({ view: 'multitrack' });
    mockExportSession.mockResolvedValue(null);
    const onClose = jest.fn();
    render(<ExportDialog onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(mockExportSession).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('the waveform view still exports the active document', async () => {
    const doc = seedActiveDoc();
    render(<ExportDialog onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(mockExport).toHaveBeenCalled());
    expect(mockExport.mock.calls[0][0]).toBe(doc.id);
    expect(mockExportSession).not.toHaveBeenCalled();
  });
});
