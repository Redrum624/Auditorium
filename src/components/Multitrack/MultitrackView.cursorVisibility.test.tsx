/**
 * Task 8 — "when zooming in, the bar goes over and off the track instead of
 * disappearing." The multitrack cursor line and the playhead are DOM overlays
 * positioned at `left: x` inside a wrapper that clips on the right but NOT on
 * the left of the lane (the 224 px header column sits INSIDE it): an x below
 * HEADER_W painted the line across the track headers, and nothing hid a line
 * whose sample had scrolled past the right edge.
 *
 * This pins the fix: an exact-edge cull (`laneVisible`) applied to the line
 * and the playhead, the same rule `renderWaveform` already applies to the
 * editor's own canvas cursor/playhead lines (`cx >= 0 && cx <= width` in
 * `waveformRender.ts`). Review round 1: the handle shares this SAME rule
 * (`handleGrabbed || laneVisible(cursorX)`) rather than the canvas's own
 * wider, tolerant `cursorHandleVisible` — "no handle without a line" is a
 * real constraint for this DOM overlay, so the handle's exact-edge boundary
 * is pinned here too (the 3px-band tests below); the wider canvas boundary
 * itself is untouched and stays pinned in `MultitrackView.cursorHandle.test.tsx`.
 */
import { act, render, screen } from '@testing-library/react';
import MultitrackView from './MultitrackView';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { useSessionStore } from '../../multitrack/sessionStore';
import { _resetSessionUndo } from '../../multitrack/sessionUndo';
import { MT_HEADER_W, _resetSessionLaneWidth, sessionLaneWidth } from '../../multitrack/sessionViewport';
import { _resetSnapPreference, setSnapEnabled } from '../../services/snapPreference';
import { makeInitialState, useAppStore } from '../../stores/appStore';

const SR = 44_100;
const SPP = 100; // samples per pixel — whole-number so px<->sample math is exact

const store = () => useSessionStore.getState();

/** jsdom has no window.PointerEvent, so a real MouseEvent (carrying
 * clientX/Y) stands in, with pointerId attached — the same technique as
 * `MultitrackView.cursorHandle.test.tsx`. */
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

describe('the cursor line hides off-lane (Task 8)', () => {
  it('hides the line and the handle when the cursor is 50px left of the lane start', () => {
    // scrollSample worth 50px puts sample 0 at lane x = -50 (left of HEADER_W).
    useSessionStore.setState({ mtZoom: { samplesPerPixel: SPP, scrollSample: 50 * SPP } });
    store().setMtCursor(0);
    render(<MultitrackView />);

    expect(screen.queryByTestId('mt-cursor-line')).toBeNull();
    expect(screen.queryByTestId('mt-cursor-handle')).toBeNull();
  });

  it('hides the line and the handle when the cursor is 10px past the right edge', () => {
    const laneW = sessionLaneWidth();
    store().setMtCursor((laneW + 10) * SPP);
    render(<MultitrackView />);

    expect(screen.queryByTestId('mt-cursor-line')).toBeNull();
    expect(screen.queryByTestId('mt-cursor-handle')).toBeNull();
  });

  it('hides BOTH the line and the handle 3px left of HEADER_W (Task 8 review round 1)', () => {
    // Inside what used to be the handle's OWN ±CURSOR_HANDLE_HALF_W (6px)
    // tolerance band — before the fix a lone triangle drew here with no line
    // under it. The handle now shares the line's exact-edge `laneVisible`
    // rule, so this band is empty on both.
    useSessionStore.setState({ mtZoom: { samplesPerPixel: SPP, scrollSample: 3 * SPP } });
    store().setMtCursor(0);
    render(<MultitrackView />);

    expect(screen.queryByTestId('mt-cursor-line')).toBeNull();
    expect(screen.queryByTestId('mt-cursor-handle')).toBeNull();
  });

  it('hides BOTH the line and the handle 3px past the right edge (Task 8 review round 1)', () => {
    // The mirror band on the right — also inside the old ±6px handle
    // tolerance, also empty now.
    const laneW = sessionLaneWidth();
    store().setMtCursor((laneW + 3) * SPP);
    render(<MultitrackView />);

    expect(screen.queryByTestId('mt-cursor-line')).toBeNull();
    expect(screen.queryByTestId('mt-cursor-handle')).toBeNull();
  });

  it('shows the line at exactly the lane start (HEADER_W)', () => {
    store().setMtCursor(0);
    render(<MultitrackView />);

    expect(screen.getByTestId('mt-cursor-line').style.left).toBe(`${MT_HEADER_W}px`);
  });

  it('shows the line at exactly the right edge of the lane', () => {
    const laneW = sessionLaneWidth();
    store().setMtCursor(laneW * SPP);
    render(<MultitrackView />);

    expect(screen.getByTestId('mt-cursor-line').style.left).toBe(`${MT_HEADER_W + laneW}px`);
  });
});

describe('the playhead follows the same cull (Task 8)', () => {
  it('hides when 50px left of the lane start', () => {
    useSessionStore.setState({
      mtZoom: { samplesPerPixel: SPP, scrollSample: 50 * SPP },
      mtPlayState: 'playing',
      mtPlayheadSample: 0,
    });
    render(<MultitrackView />);

    expect(screen.queryByTestId('mt-playhead')).toBeNull();
  });

  it('hides when 10px past the right edge', () => {
    const laneW = sessionLaneWidth();
    useSessionStore.setState({
      mtPlayState: 'playing',
      mtPlayheadSample: (laneW + 10) * SPP,
    });
    render(<MultitrackView />);

    expect(screen.queryByTestId('mt-playhead')).toBeNull();
  });

  it('shows at exactly the lane start and the right edge', () => {
    const laneW = sessionLaneWidth();
    useSessionStore.setState({ mtPlayState: 'playing', mtPlayheadSample: 0 });
    const { unmount } = render(<MultitrackView />);
    expect(screen.getByTestId('mt-playhead').style.left).toBe(`${MT_HEADER_W}px`);
    unmount();

    useSessionStore.setState({ mtPlayState: 'playing', mtPlayheadSample: laneW * SPP });
    render(<MultitrackView />);
    expect(screen.getByTestId('mt-playhead').style.left).toBe(`${MT_HEADER_W + laneW}px`);
  });

  it('stays hidden off-lane even while playing (not just gated on mtPlayState)', () => {
    // Regression guard: the ORIGINAL bug gated the playhead on mtPlayState
    // alone, with no position check at all.
    useSessionStore.setState({ mtPlayState: 'playing', mtPlayheadSample: -50 * SPP });
    render(<MultitrackView />);

    expect(screen.queryByTestId('mt-playhead')).toBeNull();
  });
});

describe('a handle drag that leaves the lane (Task 8)', () => {
  it('keeps updating mtCursorSample past the right edge; the line reappears once the sample is back in view', () => {
    setSnapEnabled(false); // the magnet is not what is under test
    const laneW = sessionLaneWidth();
    store().setMtCursor(0);
    render(<MultitrackView />);
    const handle = screen.getByTestId('mt-cursor-handle');

    firePointer(handle, 'pointerdown', { clientX: atLaneX(0) });

    // Off-lane, past the right edge: the line is hidden, but the drag must
    // still be live — pointer capture on the (still-mounted) handle keeps it
    // that way even though nothing paints there.
    firePointer(handle, 'pointermove', { clientX: atLaneX(laneW + 50) });
    expect(store().mtCursorSample).toBe((laneW + 50) * SPP);
    expect(screen.queryByTestId('mt-cursor-line')).toBeNull();

    // A second off-lane move to a DIFFERENT sample proves the drag keeps
    // updating live, not merely holding the value from the first move.
    firePointer(handle, 'pointermove', { clientX: atLaneX(laneW + 100) });
    expect(store().mtCursorSample).toBe((laneW + 100) * SPP);
    expect(screen.queryByTestId('mt-cursor-line')).toBeNull();

    // Back on-lane: the line reappears at the new sample.
    firePointer(handle, 'pointermove', { clientX: atLaneX(300) });
    expect(store().mtCursorSample).toBe(300 * SPP);
    expect(screen.getByTestId('mt-cursor-line').style.left).toBe(`${MT_HEADER_W + 300}px`);
  });
});
