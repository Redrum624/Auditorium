import { act, render, screen } from '@testing-library/react';
import WaveformView from './WaveformView';
import { createDocument, docLength, type AudioDocument } from '../../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { clearAllPeaks } from '../../services/peaksCache';
import * as waveformRender from './waveformRender';
import type { RenderOpts } from './waveformRender';
import * as beatGridService from '../../services/beatGrid';
import type { BeatGrid } from '../../services/beatGrid';
import { setBeatGridVisible, toggleBeatGrid } from '../../services/beatGridDisplay';

function makeDoc(): AudioDocument {
  const ch = new Float32Array(4096);
  for (let i = 0; i < ch.length; i++) ch[i] = Math.sin(i / 20) * 0.5;
  return createDocument({ name: 'clip.wav', sampleRate: 44100, channels: [ch, ch.slice()] });
}

// jsdom has no window.PointerEvent, so @testing-library's fireEvent.pointerDown
// falls back to a bare `Event` that silently drops clientX/shiftKey/detail
// (the Event constructor only reads bubbles/cancelable/composed from init).
// Dispatch a real MouseEvent instead -- it carries those UIEvent/MouseEvent
// fields correctly -- and attach pointerId as a plain extra property, which
// is all WaveformView's handlers read off the event.
function firePointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { clientX: number; clientY?: number; pointerId?: number; shiftKey?: boolean; detail?: number }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY ?? 0,
    shiftKey: init.shiftKey ?? false,
    detail: init.detail ?? 1,
  });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

describe('WaveformView', () => {
  beforeEach(() => {
    useAppStore.setState(makeInitialState());
    clearAllPeaks();
  });

  it('mounts with a document and renders the waveform canvas and ruler', () => {
    const doc = makeDoc();
    render(<WaveformView doc={doc} />);
    expect(screen.getByTestId('waveform-view')).toBeInTheDocument();
    expect(screen.getByTestId('waveform-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-ruler')).toBeInTheDocument();
  });

  it('floats the canvas in a glass lane on the stage-inset root (G6), canvas filling the lane edge-to-edge', () => {
    const doc = makeDoc();
    render(<WaveformView doc={doc} />);
    const canvas = screen.getByTestId('waveform-canvas');
    // The rounded clip container WRAPS the canvas; the canvas itself keeps its
    // full-bleed classes so the clientX→sample mapping geometry is untouched.
    expect(canvas.parentElement).toHaveClass('glass-lane');
    expect(canvas).toHaveClass('block', 'h-full', 'w-full');
    // The stage insets (clearance for the floating chrome) live on the view
    // root, never inside the lane.
    expect(screen.getByTestId('waveform-view')).toHaveClass('stage-inset');
  });

  describe('mouse selection', () => {
    it('pointerdown sets the cursor to the clicked sample and clears any existing selection', () => {
      const doc = makeDoc();
      useAppStore.setState({ selection: { start: 10, end: 20 } });
      render(<WaveformView doc={doc} />);
      const canvas = screen.getByTestId('waveform-canvas');
      const spp = useAppStore.getState().zoom.samplesPerPixel;

      firePointer(canvas, 'pointerdown', { clientX: 2, pointerId: 1 });
      expect(useAppStore.getState().cursorSample).toBe(2 * spp);

      firePointer(canvas, 'pointerup', { clientX: 2, pointerId: 1 });
      expect(useAppStore.getState().selection).toBeNull();
    });

    it('dragging past the 3px threshold creates a live selection', () => {
      const doc = makeDoc();
      render(<WaveformView doc={doc} />);
      const canvas = screen.getByTestId('waveform-canvas');

      firePointer(canvas, 'pointerdown', { clientX: 0, pointerId: 1 });
      firePointer(canvas, 'pointermove', { clientX: 2, pointerId: 1 });
      expect(useAppStore.getState().selection).toBeNull(); // within threshold

      firePointer(canvas, 'pointermove', { clientX: 10, pointerId: 1 });
      const sel = useAppStore.getState().selection;
      expect(sel).not.toBeNull();
      expect(sel!.start).toBe(0);
      expect(sel!.end).toBeGreaterThan(0);

      firePointer(canvas, 'pointerup', { clientX: 10, pointerId: 1 });
      // Selection made during the drag survives pointerup.
      expect(useAppStore.getState().selection).toEqual(sel);
    });

    it('double-click selects the entire document', () => {
      const doc = makeDoc();
      render(<WaveformView doc={doc} />);
      const canvas = screen.getByTestId('waveform-canvas');

      firePointer(canvas, 'pointerdown', { clientX: 5, pointerId: 1, detail: 2 });

      expect(useAppStore.getState().selection).toEqual({ start: 0, end: docLength(doc) });
    });

    it('shift+click extends the selection from the cursor when there is none yet', () => {
      const doc = makeDoc();
      useAppStore.setState({ cursorSample: 100 });
      render(<WaveformView doc={doc} />);
      const canvas = screen.getByTestId('waveform-canvas');
      const spp = useAppStore.getState().zoom.samplesPerPixel;

      firePointer(canvas, 'pointerdown', { clientX: 5, pointerId: 1, shiftKey: true });

      expect(useAppStore.getState().selection).toEqual({ start: 100, end: 5 * spp });
    });
  });
});

describe('WaveformView beat tics (Task B2)', () => {
  // jsdom reports 0 for clientWidth/clientHeight and has no 2d backend, so the
  // render effect bails before it ever calls renderWaveform. Both are stubbed
  // for THIS describe only — the gesture suites above depend on the real
  // (zero-sized, null-context) behaviour.
  let getContextSpy: jest.SpyInstance;
  let renderSpy: jest.SpyInstance;
  let gridSpy: jest.SpyInstance;

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
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textBaseline: 'top',
  };

  function grid(over: Partial<BeatGrid> = {}): BeatGrid {
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
      ...over,
    };
  }

  beforeEach(() => {
    useAppStore.setState(makeInitialState());
    clearAllPeaks();
    for (const prop of ['clientWidth', 'clientHeight'] as const) {
      Object.defineProperty(HTMLElement.prototype, prop, {
        configurable: true,
        value: prop === 'clientWidth' ? 300 : 150,
      });
    }
    getContextSpy = jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(() => fakeCtx as unknown as CanvasRenderingContext2D);
    renderSpy = jest.spyOn(waveformRender, 'renderWaveform').mockImplementation(() => {});
    gridSpy = jest.spyOn(beatGridService, 'getBeatGrid');
    setBeatGridVisible(true);
  });

  afterEach(() => {
    getContextSpy.mockRestore();
    renderSpy.mockRestore();
    gridSpy.mockRestore();
    // Wrapped: this describe's afterEach runs BEFORE testing-library's auto
    // cleanup, so the component is still mounted and subscribed here.
    act(() => {
      setBeatGridVisible(true);
    });
    for (const prop of ['clientWidth', 'clientHeight'] as const) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
  });

  function lastOpts(): RenderOpts {
    return renderSpy.mock.calls[renderSpy.mock.calls.length - 1][1] as RenderOpts;
  }

  it('hands the cached grid to renderWaveform', () => {
    const g = grid();
    gridSpy.mockReturnValue(g);
    render(<WaveformView doc={makeDoc()} />);
    expect(lastOpts().beatGrid!.beats).toBe(g.beatSamples);
    expect(lastOpts().beatGrid!.endSample).toBe(44100);
  });

  it('passes null when the document has no cached grid — and never triggers an analysis', () => {
    gridSpy.mockReturnValue(null);
    render(<WaveformView doc={makeDoc()} />);
    expect(lastOpts().beatGrid).toBeNull();
  });

  it('the View toggle hides the tics: renderWaveform is re-run with no grid', () => {
    gridSpy.mockImplementation(() => grid());
    render(<WaveformView doc={makeDoc()} />);
    expect(lastOpts().beatGrid).not.toBeNull();

    act(() => {
      toggleBeatGrid();
    });
    expect(lastOpts().beatGrid).toBeNull();

    act(() => {
      toggleBeatGrid();
    });
    expect(lastOpts().beatGrid).not.toBeNull();
  });
});
