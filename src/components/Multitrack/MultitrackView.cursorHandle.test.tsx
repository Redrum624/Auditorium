/**
 * T7 — the multitrack session cursor gets the SAME draggable red triangle the
 * waveform and spectral views have carried since F11-1.
 *
 * The editor's handle is canvas paint hit-tested by `isOnCursorHandle`; the
 * multitrack overlay is DOM, so here the hit band IS the element's own box and
 * the triangle a CSS-border child — both sized from the `waveformRender`
 * constants, never re-derived, so the three views cannot drift apart. The drag
 * semantics mirror `useEditorGestures`' playhead arm (and are pinned the way
 * `WaveformView.playhead.test.tsx` pins them): grabbing moves nothing, motion
 * updates live through the session magnet, Alt is re-read per event, positions
 * are whole samples clamped at 0, and release never touches the transport —
 * the cursor is where the NEXT play starts (`transportService`).
 */
import { act, render, screen } from '@testing-library/react';
import MultitrackView from './MultitrackView';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { createClip } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { _resetSessionUndo } from '../../multitrack/sessionUndo';
import {
  MT_HEADER_W,
  _resetSessionLaneWidth,
  sessionLaneWidth,
} from '../../multitrack/sessionViewport';
import { multitrackPlayer } from '../../multitrack/MultitrackPlayer';
import { _resetSnapPreference, setSnapEnabled } from '../../services/snapPreference';
import { makeInitialState, useAppStore } from '../../stores/appStore';
import {
  CURSOR_HANDLE,
  CURSOR_HANDLE_H,
  CURSOR_HANDLE_HALF_W,
  CURSOR_HANDLE_HIT_H,
  CURSOR_HANDLE_HIT_PX,
} from '../Editor/waveformRender';

const SR = 44_100;
const SPP = 100; // samples per pixel
/** A clip edge at lane x = 220.5 — off any whole pixel, so a snap onto it is
 * unmistakably the magnet and never the pointer's own arithmetic. */
const EDGE = 22_050;

const store = () => useSessionStore.getState();

/** jsdom has no window.PointerEvent, so a real MouseEvent (which carries
 * clientX/Y) stands in, with pointerId attached — the same technique as
 * `WaveformView.playhead.test.tsx` and the drop-target suite here. */
function firePointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { clientX: number; clientY?: number; altKey?: boolean }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY ?? 3,
    altKey: init.altKey ?? false,
    button: 0,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

/** The wrapper's rect is all zeros in jsdom, so a lane-relative x maps to
 * clientX by the same header offset the component adds to `cursorX`. */
const atLaneX = (x: number): number => MT_HEADER_W + x;

let doc: AudioDocument;

/** One clip on track 1, its start at EDGE — a tier-0 magnet target. Any clip
 * mutation re-resolves the session zoom against the fit ceiling (MT1 I2) and
 * this short session's fit is far below SPP, so the test zoom is re-pinned
 * AFTER the mutation. */
function addEdgeClip(startSample = EDGE, lengthSample = 20_000): void {
  const clip = createClip({ documentId: doc.id, startSample, offsetSample: 0, lengthSample });
  store().addClip(store().session.tracks[0].id, clip);
  useSessionStore.setState({ mtZoom: { samplesPerPixel: SPP, scrollSample: 0 } });
}

function mountHandle(): HTMLElement {
  render(<MultitrackView />);
  return screen.getByTestId('mt-cursor-handle');
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  store().newSession(SR);
  _resetSessionUndo();
  _resetSnapPreference();
  _resetSessionLaneWidth();
  useSessionStore.setState({ mtZoom: { samplesPerPixel: SPP, scrollSample: 0 } });
  doc = createDocument({ name: 'src.wav', sampleRate: SR, channels: [new Float32Array(400_000)] });
  useAppStore.getState().addDocument(doc);
});

afterEach(() => {
  _resetSnapPreference();
});

describe('the handle’s geometry (T7) — the editor’s constants, plus the header column', () => {
  it('claims exactly the F11-1 hit band, offset by the header column', () => {
    store().setMtCursor(30_000); // lane x = 300
    const handle = mountHandle();

    expect(handle.style.left).toBe(`${MT_HEADER_W + 300 - CURSOR_HANDLE_HIT_PX}px`);
    expect(handle.style.top).toBe('0px');
    expect(handle.style.width).toBe(`${CURSOR_HANDLE_HIT_PX * 2}px`);
    expect(handle.style.height).toBe(`${CURSOR_HANDLE_HIT_H}px`);
  });

  it('draws the triangle at the drawn size and colour, centred in the band', () => {
    store().setMtCursor(30_000);
    const handle = mountHandle();
    const triangle = handle.firstElementChild as HTMLElement;

    expect(triangle).not.toBeNull();
    // A CSS border triangle: 2×HALF_W wide, H deep, pointing straight down.
    expect(triangle.style.borderLeftWidth).toBe(`${CURSOR_HANDLE_HALF_W}px`);
    expect(triangle.style.borderRightWidth).toBe(`${CURSOR_HANDLE_HALF_W}px`);
    expect(triangle.style.borderTopWidth).toBe(`${CURSOR_HANDLE_H}px`);
    expect(triangle.style.left).toBe(`${CURSOR_HANDLE_HIT_PX - CURSOR_HANDLE_HALF_W}px`);
    // Same red as the canvas handle — compared through jsdom's own colour
    // normalisation so the assertion is about the colour, not its spelling.
    const probe = document.createElement('div');
    probe.style.borderTopColor = CURSOR_HANDLE;
    expect(triangle.style.borderTopColor).toBe(probe.style.borderTopColor);
  });
});

describe('dragging the multitrack cursor handle (T7)', () => {
  it('does NOT move the cursor merely by being grabbed', () => {
    // Parked at lane x = 300. The cursor's OWN position is always a tier-0
    // magnet target (`sessionSnapTiers` passes `[mtCursorSample]` as `extra`),
    // so the press must sit BEYOND its 8 px snap radius or a buggy pointerdown
    // that commits the snapped position would snap straight back to 30 000 and
    // pass anyway (T7 review F1 — proven by mutation).
    store().setMtCursor(30_000);
    const handle = mountHandle();

    // 12 px right — the hit band's far edge, beyond the 8 px snap radius, so
    // neither a raw nor a snapped pointerdown commit can land back on 30 000.
    firePointer(handle, 'pointerdown', { clientX: atLaneX(312) });

    expect(store().mtCursorSample).toBe(30_000);
  });

  it('moves the cursor live while dragging', () => {
    setSnapEnabled(false); // the magnet is not what is under test
    store().setMtCursor(0);
    const handle = mountHandle();

    firePointer(handle, 'pointerdown', { clientX: atLaneX(0) });
    firePointer(handle, 'pointermove', { clientX: atLaneX(500) });

    expect(store().mtCursorSample).toBe(500 * SPP);
  });

  it('obeys the session magnet — a clip edge at 220.5px pulls a drag at 224px onto it', () => {
    addEdgeClip();
    store().setMtCursor(0);
    const handle = mountHandle();

    firePointer(handle, 'pointerdown', { clientX: atLaneX(0) });
    firePointer(handle, 'pointermove', { clientX: atLaneX(224) });

    expect(store().mtCursorSample).toBe(EDGE);
  });

  it('Alt suspends the magnet mid-drag, re-read on each event', () => {
    addEdgeClip();
    store().setMtCursor(0);
    const handle = mountHandle();

    firePointer(handle, 'pointerdown', { clientX: atLaneX(0) });
    firePointer(handle, 'pointermove', { clientX: atLaneX(224) });
    expect(store().mtCursorSample).toBe(EDGE); // magnet on: pulled to the edge
    firePointer(handle, 'pointermove', { clientX: atLaneX(224), altKey: true });

    expect(store().mtCursorSample).toBe(224 * SPP); // same pointer, Alt: raw
  });

  it('lands on a WHOLE sample even at a fractional zoom, with the magnet suspended', () => {
    // The editor's PW1: a fitted zoom is almost never a whole number of
    // samples per pixel, and the session's fit has the same shape.
    const spp = 182.3821339950372;
    useSessionStore.setState({ mtZoom: { samplesPerPixel: spp, scrollSample: 0 } });
    store().setMtCursor(0);
    const handle = mountHandle();

    firePointer(handle, 'pointerdown', { clientX: atLaneX(0) });
    firePointer(handle, 'pointermove', { clientX: atLaneX(224), altKey: true });

    const cursor = store().mtCursorSample;
    expect(cursor).toBe(Math.round(224 * spp));
    expect(Number.isInteger(cursor)).toBe(true);
  });

  it('clamps at 0 — a drag off the left edge cannot park the cursor before the session', () => {
    store().setMtCursor(30_000);
    const handle = mountHandle();

    firePointer(handle, 'pointerdown', { clientX: atLaneX(300) });
    // clientX 0 is 224 px LEFT of the lane origin: raw sample −22 400.
    firePointer(handle, 'pointermove', { clientX: 0, altKey: true });

    expect(store().mtCursorSample).toBe(0);
  });

  it('snaps the RAW position, then clamps — the editor’s order (T7 review F2)', () => {
    // A clip edge 3 px inside the origin. The editor's `snapped()` snaps the
    // raw value and clamps after; clamp-first would move a far-off-left raw
    // (−22 400) to 0 and hand it to the magnet, which would pull it onto the
    // 300-sample edge. Same drag as the clamp test above, magnet ON.
    addEdgeClip(300, 200_000);
    store().setMtCursor(30_000);
    const handle = mountHandle();

    firePointer(handle, 'pointerdown', { clientX: atLaneX(300) });
    firePointer(handle, 'pointermove', { clientX: 0 });

    expect(store().mtCursorSample).toBe(0);
  });

  it('makes NO transport call on release — the cursor is where the NEXT play starts', () => {
    const play = jest.spyOn(multitrackPlayer, 'play').mockImplementation(() => {});
    const stop = jest.spyOn(multitrackPlayer, 'stop').mockImplementation(() => {});
    setSnapEnabled(false);
    store().setMtCursor(0);
    const handle = mountHandle();

    firePointer(handle, 'pointerdown', { clientX: atLaneX(0) });
    firePointer(handle, 'pointermove', { clientX: atLaneX(300) });
    firePointer(handle, 'pointerup', { clientX: atLaneX(300) });

    expect(play).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(store().mtPlayState).toBe('stopped');
    play.mockRestore();
    stop.mockRestore();
  });

  it('shows grab, then grabbing, then grab again once released', () => {
    store().setMtCursor(0);
    const handle = mountHandle();

    expect(handle.style.cursor).toBe('grab');
    firePointer(handle, 'pointerdown', { clientX: atLaneX(0) });
    expect(handle.style.cursor).toBe('grabbing');
    firePointer(handle, 'pointerup', { clientX: atLaneX(0) });
    expect(handle.style.cursor).toBe('grab');
  });
});

describe('the handle beside the playhead and the viewport (T7)', () => {
  it('stays parked at the cursor while the playhead sweeps during playback', () => {
    store().setMtCursor(30_000);
    useSessionStore.setState({ mtPlayState: 'playing', mtPlayheadSample: 55_500 });
    render(<MultitrackView />);

    const handle = screen.getByTestId('mt-cursor-handle');
    expect(handle.style.left).toBe(`${MT_HEADER_W + 300 - CURSOR_HANDLE_HIT_PX}px`);
    expect(screen.getByTestId('mt-playhead').style.left).toBe(`${MT_HEADER_W + 555}px`);
  });

  it('hides when the cursor is scrolled out of view, on the canvas cull’s own boundary', () => {
    // Left edge: the last visible position keeps a sliver of triangle in view.
    store().setMtCursor(0);
    useSessionStore.setState({
      mtZoom: { samplesPerPixel: SPP, scrollSample: CURSOR_HANDLE_HALF_W * SPP },
    });
    const { unmount } = render(<MultitrackView />);
    expect(screen.queryByTestId('mt-cursor-handle')).not.toBeNull();
    unmount();

    useSessionStore.setState({
      mtZoom: { samplesPerPixel: SPP, scrollSample: (CURSOR_HANDLE_HALF_W + 1) * SPP },
    });
    const second = render(<MultitrackView />);
    expect(screen.queryByTestId('mt-cursor-handle')).toBeNull();
    second.unmount();

    // Right edge: the lane width published to the store bounds the viewport.
    const laneW = sessionLaneWidth();
    useSessionStore.setState({ mtZoom: { samplesPerPixel: SPP, scrollSample: 0 } });
    store().setMtCursor((laneW + CURSOR_HANDLE_HALF_W) * SPP);
    const third = render(<MultitrackView />);
    expect(screen.queryByTestId('mt-cursor-handle')).not.toBeNull();
    third.unmount();

    store().setMtCursor((laneW + CURSOR_HANDLE_HALF_W + 1) * SPP);
    render(<MultitrackView />);
    expect(screen.queryByTestId('mt-cursor-handle')).toBeNull();
  });

  it('re-evaluates the cull when a resize changes nothing else (T7 review F3)', () => {
    // `publishSessionLaneWidth` has a load-bearing no-op guard: a resize that
    // leaves the resolved zoom unchanged writes NOTHING to the store, so only
    // the component's own width mirror can re-render the cull. The session is
    // long enough (fit ≈ 145 spp > SPP) that the resize below re-resolves the
    // zoom to exactly itself — the store stays silent on purpose.
    const OriginalRO = globalThis.ResizeObserver;
    const observers: { cb: ResizeObserverCallback; el: Element }[] = [];
    class CapturingRO {
      private readonly cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe(el: Element): void {
        observers.push({ cb: this.cb, el });
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = CapturingRO;
    try {
      addEdgeClip(0, 200_000);
      const before = sessionLaneWidth(); // the unmeasured fallback
      store().setMtCursor((before + CURSOR_HANDLE_HALF_W + 1) * SPP); // 1 px culled
      render(<MultitrackView />);
      expect(screen.queryByTestId('mt-cursor-handle')).toBeNull();

      // The window widens by 20 px: the parked cursor is back in view.
      act(() => {
        for (const { cb, el } of observers) {
          Object.defineProperty(el, 'clientWidth', { value: MT_HEADER_W + before + 20, configurable: true });
          cb([], undefined as unknown as ResizeObserver); // both observers ignore their args
        }
      });

      expect(screen.queryByTestId('mt-cursor-handle')).not.toBeNull();
    } finally {
      (globalThis as { ResizeObserver: unknown }).ResizeObserver = OriginalRO;
      _resetSessionLaneWidth();
    }
  });
});

describe('the handle wins the press; the line stays inert (T7)', () => {
  it('a clip under the handle does not receive the press', () => {
    // A clip spanning lane x 200..500 sits under a handle parked at x 300.
    addEdgeClip(20_000, 30_000);
    store().setMtCursor(30_000);
    const handle = mountHandle();

    firePointer(handle, 'pointerdown', { clientX: atLaneX(300) });
    firePointer(handle, 'pointerup', { clientX: atLaneX(300) });

    // The press stayed the handle's: no clip got selected, nothing moved.
    expect(store().selectedClipId).toBeNull();
    expect(store().mtCursorSample).toBe(30_000);
  });

  it('paints above the lane content — over the automation overlay’s own z-10', () => {
    store().setMtCursor(30_000);
    const handle = mountHandle();
    // EnvelopeLane's capture surface is `z-10`, the only positive z under the
    // overlay wrapper; the handle must beat it or the envelope eats the press.
    expect(Number(handle.style.zIndex)).toBeGreaterThan(10);
  });

  it('keeps the cursor LINE ungrabbable — only the triangle is', () => {
    store().setMtCursor(30_000);
    const handle = mountHandle();
    const line = screen.getByTestId('mt-cursor-line');

    expect(line.className).toContain('pointer-events-none');
    expect(handle.className).not.toContain('pointer-events-none');
  });
});
