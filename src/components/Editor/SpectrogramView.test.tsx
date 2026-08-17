import { act, render, screen } from '@testing-library/react';
import SpectrogramView from './SpectrogramView';
import { useAppStore, makeInitialState, fitSamplesPerPixel } from '../../stores/appStore';
import { createDocument, docLength, type AudioDocument } from '../../audio/AudioDocument';
import { _resetEditorLaneWidth } from '../../services/editorViewport';
// Jest's moduleNameMapper resolves every `createSpectrogramWorker` import to
// the mock, so importing the mock file directly reaches the SAME module
// instance the component uses — its fault injection affects the component.
import {
  _setSpectrogramWorkerError,
  _getLastComputeMessage,
  _resetSpectrogramWorkerCapture,
} from '../../__mocks__/createSpectrogramWorkerMock';
import * as waveformRender from './waveformRender';
import * as beatGridService from '../../services/beatGrid';
import type { BeatGrid } from '../../services/beatGrid';
import { setBeatGridVisible, toggleBeatGrid } from '../../services/beatGridDisplay';

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
    render(<SpectrogramView docId={doc.id} />);
    await flushCompute();
    expect(screen.queryByText('Spectrogram failed')).not.toBeInTheDocument();
  });

  it('warns and shows a "Spectrogram failed" overlay when the worker reports an error', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    _setSpectrogramWorkerError('fft exploded');
    const doc = seedDoc();

    render(<SpectrogramView docId={doc.id} />);
    await flushCompute();

    expect(screen.getByText('Spectrogram failed')).toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fft exploded'));
    warn.mockRestore();
  });

  it('clears the overlay once a later compute succeeds', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    _setSpectrogramWorkerError('boom');
    const doc = seedDoc();

    render(<SpectrogramView docId={doc.id} />);
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

describe('SpectrogramView G6 floating lane', () => {
  it('floats the canvas in a glass lane on the stage-inset root, canvas filling the lane edge-to-edge', async () => {
    const doc = seedDoc();
    render(<SpectrogramView docId={doc.id} />);
    const canvas = screen.getByTestId('spectrogram-canvas');
    expect(canvas.parentElement).toHaveClass('glass-lane');
    expect(canvas).toHaveClass('block', 'h-full', 'w-full');
    expect(screen.getByTestId('spectrogram-view')).toHaveClass('stage-inset');
    await flushCompute();
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

    render(<SpectrogramView docId={doc.id} />);
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

    render(<SpectrogramView docId={doc.id} />);
    await flushCompute();

    const msg = _getLastComputeMessage();
    expect(msg).not.toBeNull();
    expect(msg!.channel.length).toBeLessThan(doc.channels[0].length);
  });
});

describe('SpectrogramView raster caching during playback (v1.5.2)', () => {
  // The paint effect re-runs on every playback.positionSample change (the
  // playhead overlay must move), but the spectrogram raster itself must NOT
  // be rebuilt per frame: createImageData used to be re-allocated on every
  // paint (a 0.5-2 GB/s transient while playing in Spectral view). The raster
  // is now cached in a ref keyed by (mags identity, backing size) and merely
  // blitted; only new data or a resize re-rasterises.
  //
  // jsdom has no 2d backend, so a recording stub is installed for THIS
  // describe only (the other suites rely on getContext returning null).
  let counts: { createImageData: number; putImageData: number; drawImage: number; stroke: number };
  let getContextSpy: jest.SpyInstance;

  beforeEach(() => {
    counts = { createImageData: 0, putImageData: 0, drawImage: 0, stroke: 0 };
    const fakeCtx = {
      setTransform: jest.fn(),
      clearRect: jest.fn(),
      fillRect: jest.fn(),
      beginPath: jest.fn(),
      moveTo: jest.fn(),
      lineTo: jest.fn(),
      closePath: jest.fn(),
      fill: jest.fn(),
      fillText: jest.fn(),
      setLineDash: jest.fn(),
      stroke: jest.fn(() => {
        counts.stroke++;
      }),
      drawImage: jest.fn(() => {
        counts.drawImage++;
      }),
      putImageData: jest.fn(() => {
        counts.putImageData++;
      }),
      createImageData: (w: number, h: number) => {
        counts.createImageData++;
        return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      },
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textBaseline: 'top',
    };
    getContextSpy = jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(() => fakeCtx as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    getContextSpy.mockRestore();
  });

  it('does not re-rasterise (no createImageData) on playhead-only paints; the cached raster is blitted instead', async () => {
    const doc = seedDoc();
    render(<SpectrogramView docId={doc.id} />);
    await flushCompute();

    expect(counts.createImageData).toBeGreaterThanOrEqual(1); // initial rasterisation happened
    const rasterisations = counts.createImageData;
    const blitsBefore = counts.drawImage;
    const strokesBefore = counts.stroke;

    // Three playback frames: each repaints (playhead moves) ...
    act(() => {
      useAppStore.getState().setPlayback({ state: 'playing', positionSample: 1000 });
    });
    act(() => {
      useAppStore.getState().setPlayback({ positionSample: 2000 });
    });
    act(() => {
      useAppStore.getState().setPlayback({ positionSample: 3000 });
    });

    expect(counts.createImageData).toBe(rasterisations); // ... but NONE re-rasterised
    expect(counts.drawImage).toBeGreaterThanOrEqual(blitsBefore + 3); // the cached raster was blitted each paint
    expect(counts.stroke).toBeGreaterThan(strokesBefore); // and the playhead overlay was actually drawn
  });

  it('does re-rasterise when new magnitudes arrive (a zoom-triggered recompute)', async () => {
    const doc = seedDoc();
    render(<SpectrogramView docId={doc.id} />);
    await flushCompute();
    const rasterisations = counts.createImageData;

    act(() => {
      useAppStore.getState().setZoom({ samplesPerPixel: 16, scrollSample: 0 });
    });
    await flushCompute();

    expect(counts.createImageData).toBeGreaterThan(rasterisations);
  });
});

describe('SpectrogramView compute-effect narrowing (Task M9 fix round 1 / MINOR 7)', () => {
  it('does not recompute on a metadata-only doc replacement (dirty/name/...), same id/channels/sampleRate', async () => {
    const doc = seedDoc();
    render(<SpectrogramView docId={doc.id} />);
    await flushCompute();
    _resetSpectrogramWorkerCapture();

    // Exactly what every marker add/rename/delete produces via appStore's
    // markDirty (Task M1): a new doc object, same id/channels/sampleRate.
    // F11-0: pushed through the STORE now that the view resolves the document
    // itself — which is the real path this narrowing has to survive.
    const metadataOnly = { ...doc, dirty: true, name: 'renamed.wav' };
    await act(async () => {
      useAppStore.getState().updateDocument(metadataOnly);
    });
    await flushCompute();

    expect(_getLastComputeMessage()).toBeNull(); // no new compute request posted
  });

  it('does recompute when the channels array reference changes (a real audio edit)', async () => {
    const doc = seedDoc();
    render(<SpectrogramView docId={doc.id} />);
    await flushCompute();
    _resetSpectrogramWorkerCapture();

    const edited = { ...doc, channels: [doc.channels[0].slice()] };
    await act(async () => {
      useAppStore.getState().updateDocument(edited);
    });
    await flushCompute();

    expect(_getLastComputeMessage()).not.toBeNull();
  });
});

describe('SpectrogramView beat tics (Task B2)', () => {
  // The tics must be an OVERLAY on the live canvas, drawn after the cached
  // raster is blitted — never into the raster itself, which is only rebuilt
  // when the magnitudes or the backing size change and would therefore freeze
  // the tics at a stale zoom/scroll (trap 10).
  let order: string[];
  let getContextSpy: jest.SpyInstance;
  let ticSpy: jest.SpyInstance;
  let gridSpy: jest.SpyInstance;

  function grid(): BeatGrid {
    return {
      beatSamples: Int32Array.from([0, 22050, 44100]),
      sampleRate: 44100,
      beatsPerBar: null,
      downbeatPhase: null,
      barCount: 0,
      confidence: 0.9,
      stale: false,
      analyzedEndSample: 44100,
      truncated: false,
      origin: 'own',
      originDocId: 'x',
      originOpen: true,
    };
  }

  beforeEach(() => {
    order = [];
    const fakeCtx = {
      setTransform: jest.fn(),
      clearRect: jest.fn(),
      fillRect: jest.fn(),
      beginPath: jest.fn(),
      moveTo: jest.fn(),
      lineTo: jest.fn(),
      closePath: jest.fn(),
      fill: jest.fn(),
      fillText: jest.fn(),
      setLineDash: jest.fn(),
      stroke: jest.fn(),
      drawImage: jest.fn(() => {
        order.push('blit');
      }),
      putImageData: jest.fn(),
      createImageData: (w: number, h: number) => ({
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
      }),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textBaseline: 'top',
    };
    getContextSpy = jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(() => fakeCtx as unknown as CanvasRenderingContext2D);
    ticSpy = jest.spyOn(waveformRender, 'drawEditorBeatTics').mockImplementation(() => {
      order.push('tics');
      return 0;
    });
    gridSpy = jest.spyOn(beatGridService, 'getBeatGrid');
    setBeatGridVisible(true);
  });

  afterEach(() => {
    getContextSpy.mockRestore();
    ticSpy.mockRestore();
    gridSpy.mockRestore();
    // Wrapped: this describe's afterEach runs BEFORE testing-library's auto
    // cleanup, so the component is still mounted and subscribed here.
    act(() => {
      setBeatGridVisible(true);
    });
  });

  it('draws the tics on the live canvas AFTER the raster blit, never inside it', async () => {
    gridSpy.mockImplementation(() => grid());
    render(<SpectrogramView docId={seedDoc().id} />);
    await flushCompute();

    expect(order).toContain('blit');
    expect(order).toContain('tics');
    expect(order.lastIndexOf('tics')).toBeGreaterThan(order.lastIndexOf('blit'));
  });

  it('passes the same grid the waveform view gets, and null when the toggle is off', async () => {
    const g = grid();
    gridSpy.mockReturnValue(g);
    render(<SpectrogramView docId={seedDoc().id} />);
    await flushCompute();
    expect(ticSpy.mock.calls[ticSpy.mock.calls.length - 1][1].beats).toBe(g.beatSamples);

    gridSpy.mockImplementation(() => grid());
    await act(async () => {
      toggleBeatGrid();
    });
    expect(ticSpy.mock.calls[ticSpy.mock.calls.length - 1][1]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F11-3 — the spectral lane is the same stage the waveform lane is, and the two
// share the store's zoom. If only the waveform published its width, switching
// to Spectral and resizing would leave the fit measured against a lane that is
// no longer on screen.
// ---------------------------------------------------------------------------
describe('SpectrogramView publishes its lane width (F11-3)', () => {
  beforeEach(() => {
    _resetEditorLaneWidth();
  });

  it('fits the whole document across the spectral lane it actually measured', () => {
    const doc = seedDoc();
    render(<SpectrogramView docId={doc.id} />);

    const { samplesPerPixel, scrollSample } = useAppStore.getState().zoom;
    expect(scrollSample).toBe(0);
    // 300 is the lane width this suite pins on every element (see beforeAll).
    expect(scrollSample + 300 * samplesPerPixel).toBeCloseTo(docLength(doc), 6);
  });

  it('clamps the zoom-out limit to that lane too', () => {
    const doc = seedDoc();
    render(<SpectrogramView docId={doc.id} />);
    expect(fitSamplesPerPixel(doc)).toBe(docLength(doc) / 300);
  });
});
