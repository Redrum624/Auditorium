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
import { _resetSnapPreference, setSnapEnabled } from '../../services/snapPreference';
import { SNAP_TOLERANCE_PX } from '../../services/snap';

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
    // F11-1: the DEFAULT press lands in the lane BODY, not at y=0. The top
    // 15 px of the lane is the playhead handle's grab strip now, and jsdom
    // reports a zero-origin rect, so an unspecified clientY used to mean
    // "on the handle" — which is a different gesture. Every test below is
    // about placing the cursor / dragging a selection in the waveform itself,
    // which is what pressing in the body has always meant.
    clientY: init.clientY ?? 40,
    shiftKey: init.shiftKey ?? false,
    detail: init.detail ?? 1,
  });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

// F11-0: the view takes a docId and resolves the document from the store, so
// every render site has to put it there first. Inserted DIRECTLY rather than
// through `addDocument`, which would also reset the zoom to `defaultZoom(doc)`
// and silently move every `clientX -> sample` expectation below.
function renderView(doc: AudioDocument) {
  useAppStore.setState((s) =>
    s.documents.some((d) => d.id === doc.id) ? s : { documents: [...s.documents, doc] }
  );
  return render(<WaveformView docId={doc.id} />);
}

describe('WaveformView', () => {
  beforeEach(() => {
    useAppStore.setState(makeInitialState());
    clearAllPeaks();
  });

  it('mounts with a document and renders the waveform canvas and ruler', () => {
    const doc = makeDoc();
    renderView(doc);
    expect(screen.getByTestId('waveform-view')).toBeInTheDocument();
    expect(screen.getByTestId('waveform-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-ruler')).toBeInTheDocument();
  });

  it('floats the canvas in a glass lane on the stage-inset root (G6), canvas filling the lane edge-to-edge', () => {
    const doc = makeDoc();
    renderView(doc);
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
      renderView(doc);
      const canvas = screen.getByTestId('waveform-canvas');
      const spp = useAppStore.getState().zoom.samplesPerPixel;

      firePointer(canvas, 'pointerdown', { clientX: 2, pointerId: 1 });
      expect(useAppStore.getState().cursorSample).toBe(2 * spp);

      firePointer(canvas, 'pointerup', { clientX: 2, pointerId: 1 });
      expect(useAppStore.getState().selection).toBeNull();
    });

    it('dragging past the 3px threshold creates a live selection', () => {
      const doc = makeDoc();
      renderView(doc);
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
      renderView(doc);
      const canvas = screen.getByTestId('waveform-canvas');

      firePointer(canvas, 'pointerdown', { clientX: 5, pointerId: 1, detail: 2 });

      expect(useAppStore.getState().selection).toEqual({ start: 0, end: docLength(doc) });
    });

    // Item 8 (M3/N9): markers are segment boundaries, and a double-click
    // selects the segment under the pointer rather than the whole document.
    describe('double-click on a document with a marker at 1000', () => {
      afterEach(() => _resetSnapPreference());

      // Active, the way the app always renders it: the gesture reads the
      // markers (and the snap targets) of the ACTIVE document.
      function withMarker(): AudioDocument {
        const doc = makeDoc();
        useAppStore.setState({
          activeDocumentId: doc.id,
          markers: { [doc.id]: [{ id: 'm1', name: 'M1', positionSample: 1000 }] },
        });
        return doc;
      }

      it('selects the segment under the pointer', () => {
        setSnapEnabled(false);
        const doc = withMarker();
        renderView(doc);
        const canvas = screen.getByTestId('waveform-canvas');
        const spp = useAppStore.getState().zoom.samplesPerPixel;
        expect(1 * spp).toBeLessThan(1000); // the premise: the pointer lands before the marker

        firePointer(canvas, 'pointerdown', { clientX: 1, pointerId: 1, detail: 2 });

        expect(useAppStore.getState().selection).toEqual({ start: 0, end: 1000 });
      });

      it('picks the segment from the RAW pointer, not the snapped cursor', () => {
        setSnapEnabled(true);
        const doc = withMarker();
        renderView(doc);
        const canvas = screen.getByTestId('waveform-canvas');
        const spp = useAppStore.getState().zoom.samplesPerPixel;
        // One pixel in: the raw sample sits BEFORE the marker, and the magnet
        // pulls the cursor FORWARD onto 1000. The two readings now name
        // different segments -- raw -> {0,1000}, snapped -> {1000,length} --
        // which is the only construction that can tell
        // `segmentAt(..., Math.round(raw))` from `segmentAt(..., sample)`. A
        // pointer just AFTER the marker cannot: raw (past 1000) and snapped
        // (1000) both fall in the same half-open span [1000, length).
        const clientX = 1;
        expect(clientX * spp).toBeLessThan(1000);
        expect(1000 - clientX * spp).toBeLessThanOrEqual(SNAP_TOLERANCE_PX * spp); // the magnet reaches it

        firePointer(canvas, 'pointerdown', { clientX, pointerId: 1, detail: 2 });

        // The cursor DID snap onto the marker; the selection did NOT follow it.
        expect(useAppStore.getState().cursorSample).toBe(1000);
        expect(useAppStore.getState().selection).toEqual({ start: 0, end: 1000 });
      });

      it('pointer just AFTER the marker: the cursor snaps back onto it, the segment is the one past it', () => {
        setSnapEnabled(true);
        const doc = withMarker();
        renderView(doc);
        const canvas = screen.getByTestId('waveform-canvas');
        const spp = useAppStore.getState().zoom.samplesPerPixel;
        // A few pixels AFTER the marker: the raw sample is past 1000, but the
        // magnet (8 px tolerance) pulls the cursor back onto the marker. Raw
        // and snapped land in the same segment here (see the test above for
        // the one that tells them apart); this pins the half-open boundary.
        const clientX = Math.ceil(1000 / spp) + 1;
        expect(clientX * spp).toBeGreaterThan(1000);

        firePointer(canvas, 'pointerdown', { clientX, pointerId: 1, detail: 2 });

        expect(useAppStore.getState().cursorSample).toBe(1000);
        expect(useAppStore.getState().selection).toEqual({ start: 1000, end: docLength(doc) });
      });
    });

    it('shift+click extends the selection from the cursor when there is none yet', () => {
      const doc = makeDoc();
      useAppStore.setState({ cursorSample: 100 });
      renderView(doc);
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
    renderView(makeDoc());
    expect(lastOpts().beatGrid!.beats).toBe(g.beatSamples);
    expect(lastOpts().beatGrid!.endSample).toBe(44100);
  });

  it('passes null when the document has no cached grid — and never triggers an analysis', () => {
    gridSpy.mockReturnValue(null);
    renderView(makeDoc());
    expect(lastOpts().beatGrid).toBeNull();
  });

  it('the View toggle hides the tics: renderWaveform is re-run with no grid', () => {
    gridSpy.mockImplementation(() => grid());
    renderView(makeDoc());
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

// ---------------------------------------------------------------------------
// F11-0 — the view resolves its document from the store, and its prop is a
// string. Not cosmetic: the whole `AudioDocument` as a prop put a
// `Float32Array[]` into React's props object, which React 19's DEV profiler
// serialises into `performance.measure`, and which wedged the renderer
// permanently on the second large-document change. See
// src/dev/userTimingGuard.ts for the full mechanism.
// ---------------------------------------------------------------------------
describe('WaveformView takes a docId, not a document (F11-0)', () => {
  let getContextSpy: jest.SpyInstance;
  let renderSpy: jest.SpyInstance;

  const fakeCtx = {
    setTransform() {},
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fillRect() {},
    fillText() {},
    setLineDash() {},
    closePath() {},
    fill() {},
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    font: '',
    textBaseline: '',
    shadowColor: '',
    shadowBlur: 0,
  };

  function drawnOpts(): RenderOpts {
    return renderSpy.mock.calls[renderSpy.mock.calls.length - 1][1] as RenderOpts;
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
  });

  afterEach(() => {
    getContextSpy.mockRestore();
    renderSpy.mockRestore();
    for (const prop of ['clientWidth', 'clientHeight'] as const) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
  });

  it('draws the channels of the document the id names, having been handed no document', () => {
    const doc = makeDoc();
    useAppStore.getState().addDocument(doc);

    render(<WaveformView docId={doc.id} />);

    expect(drawnOpts().channels).toBe(doc.channels);
  });

  it('repaints from the STORE when the document is replaced under the same id (an edit)', () => {
    const doc = makeDoc();
    useAppStore.getState().addDocument(doc);
    render(<WaveformView docId={doc.id} />);
    expect(drawnOpts().channels).toBe(doc.channels);

    // What every effect run produces: a new document object under the same id.
    const edited = { ...doc, channels: [doc.channels[0].slice()] };
    act(() => {
      useAppStore.getState().updateDocument(edited);
    });

    expect(drawnOpts().channels).toBe(edited.channels);
  });

  it('follows a switch of the id to another open document', () => {
    const a = makeDoc();
    const b = makeDoc();
    useAppStore.getState().addDocument(a);
    useAppStore.getState().addDocument(b);

    const { rerender } = render(<WaveformView docId={a.id} />);
    expect(drawnOpts().channels).toBe(a.channels);

    rerender(<WaveformView docId={b.id} />);
    expect(drawnOpts().channels).toBe(b.channels);
  });

  it('renders nothing, rather than throwing, for an id no document answers to', () => {
    render(<WaveformView docId="doc-that-was-closed" />);

    expect(screen.queryByTestId('waveform-view')).toBeNull();
    expect(renderSpy).not.toHaveBeenCalled();
  });
});
