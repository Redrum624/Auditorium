import { act, render, screen } from '@testing-library/react';
import SpectrogramView from './SpectrogramView';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
// Jest's moduleNameMapper resolves every `createSpectrogramWorker` import to
// the mock, so importing the mock file directly reaches the SAME module
// instance the component uses — its fault injection affects the component.
import {
  _setSpectrogramWorkerError,
  _getLastComputeMessage,
  _resetSpectrogramWorkerCapture,
} from '../../__mocks__/createSpectrogramWorkerMock';

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
  _resetSpectrogramWorkerCapture();
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

describe('SpectrogramView viewport slicing (Task M9 / F17)', () => {
  it('mixes down only the padded visible range, not the whole document, and re-bases the offsets to the slice', async () => {
    const doc = seedDoc(); // 8192-sample doc
    act(() => {
      // cssWidth is stubbed to 300 (beforeAll); with samplesPerPixel=4 the
      // visible range is [5000, 6200). Chosen so BOTH slice edges land inside
      // the document (sliceStart > 0, sliceEnd < length), proving the offsets
      // sent to the worker are re-based rather than left absolute.
      useAppStore.getState().setZoom({ samplesPerPixel: 4, scrollSample: 5000 });
    });

    render(<SpectrogramView doc={doc} />);
    await flushCompute();

    const msg = _getLastComputeMessage();
    expect(msg).not.toBeNull();
    // visible: start=5000, end=min(8192, ceil(5000+300*4))=6200
    // slice: [max(0,5000-2048), min(8192,6200+2048)] = [2952, 8192]
    expect(msg!.channel.length).toBe(8192 - 2952); // 5240 — well under the full 8192-sample doc
    expect(msg!.startSample).toBe(5000 - 2952); // 2048 — re-based, not the absolute 5000
    expect(msg!.endSample).toBe(6200 - 2952); // 3248 — re-based, not the absolute 6200
  });

  it('never posts a channel as long as the full document once the document is much larger than the viewport', async () => {
    const channel = new Float32Array(200_000); // far larger than any single viewport slice
    for (let n = 0; n < channel.length; n++) channel[n] = Math.sin((2 * Math.PI * 440 * n) / 44100);
    const doc = createDocument({ name: 'big.wav', sampleRate: 44100, channels: [channel] });
    useAppStore.getState().addDocument(doc);
    act(() => {
      useAppStore.getState().setZoom({ samplesPerPixel: 4, scrollSample: 50_000 });
    });

    render(<SpectrogramView doc={doc} />);
    await flushCompute();

    const msg = _getLastComputeMessage();
    expect(msg).not.toBeNull();
    expect(msg!.channel.length).toBeLessThan(doc.channels[0].length);
  });
});
