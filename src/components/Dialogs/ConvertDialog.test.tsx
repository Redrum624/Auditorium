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

function seedActiveDoc(sampleRate = 44100, channelCount = 2, channelMask?: number) {
  const doc = createDocument({
    name: 'song.wav',
    sampleRate,
    channels: Array.from({ length: channelCount }, () => new Float32Array(8)),
    channelMask,
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

  describe('seeding from the active document (Task F8)', () => {
    it('seeds the rate select from the active doc sample rate', () => {
      seedActiveDoc(48000);
      render(<ConvertDialog mode="sampleRate" onClose={() => {}} />);
      expect((screen.getByTestId('convert-rate') as HTMLSelectElement).value).toBe('48000');
    });

    it('seeds the channels select from the active doc channel count', () => {
      seedActiveDoc(44100, 1);
      render(<ConvertDialog mode="channels" onClose={() => {}} />);
      expect((screen.getByTestId('convert-channels') as HTMLSelectElement).value).toBe('1');
    });

    it('falls back to 44100 when the doc rate is not an offered option', () => {
      seedActiveDoc(32000);
      render(<ConvertDialog mode="sampleRate" onClose={() => {}} />);
      expect((screen.getByTestId('convert-rate') as HTMLSelectElement).value).toBe('44100');
    });

    it('falls back to the defaults (44100/stereo) with no document open', () => {
      render(<ConvertDialog mode="sampleRate" onClose={() => {}} />);
      expect((screen.getByTestId('convert-rate') as HTMLSelectElement).value).toBe('44100');
    });
  });
});

describe('G5 glass header', () => {
  it('carries a lucide icon tile and the active doc name as subtitle', () => {
    seedActiveDoc();
    render(<ConvertDialog mode="sampleRate" onClose={() => {}} />);
    expect(screen.getByTestId('dialog-icon')).toBeInTheDocument();
    expect(screen.getByText('song.wav')).toBeInTheDocument();
  });
});

describe('R6 surround downmix law select', () => {
  const MASK_5_1 = 0x3f;

  it('is absent for mono/stereo documents (nothing to fold)', () => {
    seedActiveDoc(44100, 2);
    render(<ConvertDialog mode="channels" onClose={() => {}} />);
    expect(screen.queryByTestId('convert-downmix')).not.toBeInTheDocument();
  });

  it('appears for a >2-channel document targeting stereo, defaulting to the original fold', () => {
    seedActiveDoc(44100, 6, MASK_5_1);
    render(<ConvertDialog mode="channels" onClose={() => {}} />);
    const select = screen.getByTestId('convert-downmix') as HTMLSelectElement;
    expect(select.value).toBe('fold');
  });

  it('disappears when the target is switched to mono (mono conversion keeps the legacy path)', () => {
    seedActiveDoc(44100, 6, MASK_5_1);
    render(<ConvertDialog mode="channels" onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('convert-channels'), { target: { value: '1' } });
    expect(screen.queryByTestId('convert-downmix')).not.toBeInTheDocument();
  });

  it('applies the chosen BS.775 law when the document carries a covered layout', () => {
    const doc = seedActiveDoc(44100, 6, MASK_5_1);
    render(<ConvertDialog mode="channels" onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('convert-downmix'), { target: { value: 'bs775' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(mockChannels).toHaveBeenCalledWith(doc.id, 2, 'bs775');
  });

  it('applies the fold by default (opt-in ruling: no law change without an explicit pick)', () => {
    const doc = seedActiveDoc(44100, 6, MASK_5_1);
    render(<ConvertDialog mode="channels" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(mockChannels).toHaveBeenCalledWith(doc.id, 2, 'fold');
  });

  it('disables the BS.775 option when the document has no channel mask, and says the fold applies', () => {
    seedActiveDoc(44100, 6);
    render(<ConvertDialog mode="channels" onClose={() => {}} />);
    const option = screen.getByRole('option', { name: /BS\.775/ }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(screen.getByTestId('convert-downmix-hint').textContent).toMatch(/fold applies/);
  });

  it('disables the BS.775 option for a layout the matrix does not cover (7.1)', () => {
    seedActiveDoc(44100, 8, 0x63f);
    render(<ConvertDialog mode="channels" onClose={() => {}} />);
    const option = screen.getByRole('option', { name: /BS\.775/ }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });

  it('states the BS.775 behaviour (LFE discarded) once that law is selected', () => {
    seedActiveDoc(44100, 6, MASK_5_1);
    render(<ConvertDialog mode="channels" onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('convert-downmix'), { target: { value: 'bs775' } });
    expect(screen.getByTestId('convert-downmix-hint').textContent).toMatch(/LFE is discarded/);
  });
});
