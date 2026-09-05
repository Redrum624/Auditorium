import { useRef } from 'react';
import { act, render } from '@testing-library/react';
import { useEditorGestures } from './useEditorGestures';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { makeInitialState, useAppStore } from '../../stores/appStore';
import { _resetEditorLaneWidth, setEditorLaneWidth } from '../../services/editorViewport';

/**
 * D1 — the editor's wheel zoom anchors on the BAR, not on the pointer.
 *
 * The twin of `useMultitrackZoom.test.tsx`, for the other surface. The reported
 * symptom — "when zooming in on a track, focus on where the line was put" — was
 * true of both wheel handlers, and this hook is the one the waveform and the
 * spectrogram share, so the pin belongs on the hook rather than on either view.
 *
 * The pointer is placed deliberately AWAY from the cursor in every case below:
 * a handler that still anchored on `e.clientX` would hold the pointer's x and
 * fail, and one that holds both (they coincide) would pass for free.
 */

const SR = 44_100;
const LENGTH = 178 * SR;
const LANE = 1000;

/* No `getBoundingClientRect` stub here, deliberately. The wheel handler read one
 * to turn `e.clientX` into a lane x; under D1 it reads no rect at all, so a stub
 * would only be scenery. Leaving jsdom's zero rect in place also keeps these
 * cases sharp: a regression to pointer anchoring would compute `mouseX =
 * clientX - 0`, i.e. exactly the `clientX` each case passes, and every
 * assertion below would still catch it. */

function makeDoc(): AudioDocument {
  // Off-identity: a real (if quiet) signal rather than a silent buffer, and a
  // length that is not a round multiple of the lane.
  const ch = new Float32Array(LENGTH);
  for (let i = 0; i < ch.length; i += 1024) ch[i] = 0.25;
  return createDocument({ name: 'take.wav', sampleRate: SR, channels: [ch] });
}

/**
 * `useRef`, NOT `createRef` — and the distinction is what makes the "reads the
 * cursor LIVE" case below able to fail at all.
 *
 * `createRef()` called in a render body mints a NEW ref object on every render.
 * The wheel effect's dependency list is `[canvasRef]`, so a fresh ref would tear
 * the listener down and re-install it after every render — and since the hook
 * subscribes to `cursorSample`, moving the cursor re-renders this harness and
 * would hand even a closed-over implementation the current value. The guard
 * would pass against the bug it exists to catch.
 *
 * A stable ref is also what the real callers hold (`WaveformView.tsx:40`,
 * `SpectrogramView.tsx:137`), so this harness now models them rather than a
 * shape no view has.
 */
function Harness() {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEditorGestures(ref, LENGTH);
  return <canvas ref={ref} data-testid="lane" />;
}

const zoom = () => useAppStore.getState().zoom;

function mount(): HTMLElement {
  _resetEditorLaneWidth();
  setEditorLaneWidth(LANE);
  useAppStore.setState(makeInitialState());
  useAppStore.getState().addDocument(makeDoc());
  const { getByTestId } = render(<Harness />);
  return getByTestId('lane');
}

function wheel(
  el: HTMLElement,
  init: { deltaY: number; shiftKey?: boolean; clientX?: number }
): void {
  act(() => {
    el.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: init.deltaY,
        shiftKey: init.shiftKey ?? false,
        clientX: init.clientX ?? 0,
      })
    );
  });
}

afterEach(() => {
  _resetEditorLaneWidth();
});

describe('useEditorGestures wheel zoom — D1', () => {
  it('keeps the CURSOR at its x, and lets the pointer sample move', () => {
    const canvas = mount();
    act(() => useAppStore.getState().setZoom({ samplesPerPixel: 200, scrollSample: 100_000 }));
    const CURSOR_X = 200;
    const POINTER_X = 600;
    const cursor = 100_000 + CURSOR_X * 200; // 140 000
    const underPointer = 100_000 + POINTER_X * 200; // 220 000
    act(() => useAppStore.getState().setCursor(cursor));

    wheel(canvas, { deltaY: -100, clientX: POINTER_X });

    expect(zoom().samplesPerPixel).toBeCloseTo(200 / 1.25, 6);
    expect((cursor - zoom().scrollSample) / zoom().samplesPerPixel).toBeCloseTo(CURSOR_X, 3);
    expect((underPointer - zoom().scrollSample) / zoom().samplesPerPixel).not.toBeCloseTo(
      POINTER_X,
      3
    );
  });

  it('holds the bar across a zoom out and back in — the pair round-trips', () => {
    const canvas = mount();
    act(() => useAppStore.getState().setZoom({ samplesPerPixel: 200, scrollSample: 100_000 }));
    const cursor = 100_000 + 200 * 200;
    act(() => useAppStore.getState().setCursor(cursor));

    wheel(canvas, { deltaY: 100, clientX: 900 }); // out
    expect((cursor - zoom().scrollSample) / zoom().samplesPerPixel).toBeCloseTo(200, 3);

    wheel(canvas, { deltaY: -100, clientX: 50 }); // back in, pointer elsewhere again
    expect(zoom().samplesPerPixel).toBeCloseTo(200, 6);
    expect(zoom().scrollSample).toBeCloseTo(100_000, 3);
  });

  it('centres a cursor that is off screen', () => {
    const canvas = mount();
    act(() => useAppStore.getState().setZoom({ samplesPerPixel: 200, scrollSample: 500_000 }));
    const cursor = 500_000 - 200 * 200; // x = −200
    act(() => useAppStore.getState().setCursor(cursor));

    wheel(canvas, { deltaY: -100, clientX: 600 });

    expect(zoom().samplesPerPixel).toBeCloseTo(200 / 1.25, 6);
    expect((cursor - zoom().scrollSample) / zoom().samplesPerPixel).toBeCloseTo(LANE / 2, 3);
  });

  it('reads the cursor LIVE, not the value the effect closed over', () => {
    // The effect depends only on `canvasRef`, so it is installed once and never
    // re-runs when the cursor moves. Anchoring on the hook's rendered
    // `cursorSample` would pin the bar to wherever it was at mount — which for
    // a freshly opened document is sample 0, i.e. every zoom would drag the
    // view back to the start.
    const canvas = mount();
    act(() => useAppStore.getState().setZoom({ samplesPerPixel: 200, scrollSample: 100_000 }));
    act(() => useAppStore.getState().setCursor(140_000));

    wheel(canvas, { deltaY: -100, clientX: 0 });

    expect((140_000 - zoom().scrollSample) / zoom().samplesPerPixel).toBeCloseTo(200, 3);
  });

  it('leaves Shift+wheel as a pure scroll — no anchoring, no zoom change', () => {
    const canvas = mount();
    act(() => useAppStore.getState().setZoom({ samplesPerPixel: 200, scrollSample: 100_000 }));
    act(() => useAppStore.getState().setCursor(140_000));

    wheel(canvas, { deltaY: 10, shiftKey: true, clientX: 600 });

    expect(zoom().samplesPerPixel).toBe(200);
    expect(zoom().scrollSample).toBe(100_000 + 10 * 200);
  });
});
