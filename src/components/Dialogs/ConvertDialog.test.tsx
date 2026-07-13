import { render, screen, fireEvent } from '@testing-library/react';
import ConvertDialog from './ConvertDialog';
import { convertSampleRate, convertChannels } from '../../services/documentTools';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument } from '../../audio/AudioDocument';

jest.mock('../../services/documentTools', () => ({
  convertSampleRate: jest.fn(),
  convertChannels: jest.fn(),
}));

const mockRate = convertSampleRate as jest.MockedFunction<typeof convertSampleRate>;
const mockChannels = convertChannels as jest.MockedFunction<typeof convertChannels>;

function seedActiveDoc() {
  const doc = createDocument({
    name: 'song.wav',
    sampleRate: 44100,
    channels: [new Float32Array(8), new Float32Array(8)],
  });
  useAppStore.getState().addDocument(doc);
  return doc;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  jest.clearAllMocks();
});

describe('ConvertDialog', () => {
  it('sampleRate mode shows the rate select and applies convertSampleRate', () => {
    const doc = seedActiveDoc();
    const onClose = jest.fn();
    render(<ConvertDialog mode="sampleRate" onClose={onClose} />);

    expect(screen.getByTestId('convert-rate')).toBeInTheDocument();
    expect(screen.queryByTestId('convert-channels')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('convert-rate'), { target: { value: '48000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(mockRate).toHaveBeenCalledWith(doc.id, 48000);
    expect(onClose).toHaveBeenCalled();
  });

  it('channels mode shows the channel select and applies convertChannels', () => {
    const doc = seedActiveDoc();
    const onClose = jest.fn();
    render(<ConvertDialog mode="channels" onClose={onClose} />);

    expect(screen.getByTestId('convert-channels')).toBeInTheDocument();
    expect(screen.queryByTestId('convert-rate')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('convert-channels'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(mockChannels).toHaveBeenCalledWith(doc.id, 1);
    expect(onClose).toHaveBeenCalled();
  });

  it('Apply is disabled when no document is active', () => {
    render(<ConvertDialog mode="sampleRate" onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });
});
