import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ExportDialog from './ExportDialog';
import { exportDocument } from '../../services/fileService';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument } from '../../audio/AudioDocument';

jest.mock('../../services/fileService', () => ({
  exportDocument: jest.fn(async () => 'D:\\out\\track.wav'),
}));

const mockExport = exportDocument as jest.MockedFunction<typeof exportDocument>;

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
  jest.clearAllMocks();
  mockExport.mockResolvedValue('D:\\out\\track.wav');
});

describe('ExportDialog', () => {
  it('defaults to WAV and shows the bit-depth select (not kbps)', () => {
    seedActiveDoc();
    render(<ExportDialog onClose={() => {}} />);
    expect(screen.getByTestId('export-bitdepth')).toBeInTheDocument();
    expect(screen.queryByTestId('export-kbps')).not.toBeInTheDocument();
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
