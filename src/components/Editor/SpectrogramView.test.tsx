import { act, render, screen } from '@testing-library/react';
import SpectrogramView from './SpectrogramView';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
// Jest's moduleNameMapper resolves every `createSpectrogramWorker` import to
// the mock, so importing the mock file directly reaches the SAME module
// instance the component uses — its fault injection affects the component.
import { _setSpectrogramWorkerError } from '../../__mocks__/createSpectrogramWorkerMock';

// jsdom reports 0 for clientWidth/clientHeight; the compute effect bails on a
// zero-sized container, so give every element a fixed fake size.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    value: 300,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    value: 150,
  });
});

function seedDoc(): AudioDocument {
  const channel = new Float32Array(8192);
  for (let n = 0; n < channel.length; n++) channel[n] = Math.sin((2 * Math.PI * 440 * n) / 44100);
  const doc = createDocument({ name: 's.wav', sampleRate: 44100, channels: [channel] });
  useAppStore.getState().addDocument(doc);
  return doc;
}

/** Let the 150ms compute debounce elapse, then flush the mock's microtask. */
async function flushCompute() {
  await act(async () => {
    jest.advanceTimersByTime(200);
  });
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
});

afterEach(() => {
  _setSpectrogramWorkerError(null);
  jest.useRealTimers();
});

describe('SpectrogramView error branch (Task F8)', () => {
  it('shows no failure overlay on a successful compute', async () => {
    const doc = seedDoc();
    render(<SpectrogramView doc={doc} />);
    await flushCompute();
    expect(screen.queryByText('Spectrogram failed')).not.toBeInTheDocument();
  });

  it('warns and shows a "Spectrogram failed" overlay when the worker reports an error', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    _setSpectrogramWorkerError('fft exploded');
    const doc = seedDoc();

    render(<SpectrogramView doc={doc} />);
    await flushCompute();

    expect(screen.getByText('Spectrogram failed')).toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fft exploded'));
    warn.mockRestore();
  });

  it('clears the overlay once a later compute succeeds', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    _setSpectrogramWorkerError('boom');
    const doc = seedDoc();

    render(<SpectrogramView doc={doc} />);
    await flushCompute();
    expect(screen.getByText('Spectrogram failed')).toBeInTheDocument();

    _setSpectrogramWorkerError(null);
    act(() => {
      useAppStore.getState().setZoom({ samplesPerPixel: 16, scrollSample: 0 });
    });
    await flushCompute();

    expect(screen.queryByText('Spectrogram failed')).not.toBeInTheDocument();
    warn.mockRestore();
  });
});
