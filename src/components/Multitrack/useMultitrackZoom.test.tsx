import { createRef } from 'react';
import { act, render } from '@testing-library/react';
import { useMultitrackZoom } from './useMultitrackZoom';
import { createClip } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import {
  MT_MIN_SPP,
  MT_TIMELINE_TAIL_SEC,
  fitSessionSamplesPerPixel,
} from '../../multitrack/sessionZoom';
import { _resetSessionLaneWidth, setSessionLaneWidth } from '../../multitrack/sessionViewport';

/**
 * MT1 fix round (I9) — the wheel gesture, which had no tests at all.
 *
 * It was REWRITTEN by MT1-1: it used to carry its own `MIN_SPP`, its own
 * `maxSpp = max(1, end/50)` ceiling, its own scroll bound and its own private
 * copy of `sessionEndSample`, and it now states a request that
 * `applySessionZoom` resolves. That is a behaviour change on an untested
 * surface — the exact shape of change that needs a test and did not have one.
 *
 * Two things are worth pinning, and they are the two the rewrite could get
 * wrong: the anchor (which is why the scroll is a FUNCTION of the resolved spp
 * rather than a number computed from the requested one), and the fact that the
 * removed private clamps are genuinely gone rather than reintroduced by the
 * store agreeing with them by coincidence.
 *
 * D1 CHANGED WHAT THE ANCHOR IS. The gesture used to hold the sample under the
 * POINTER; it holds the multitrack cursor now — at its x when the bar is on
 * screen, at the centre of the lane when it is not — through the shared
 * `services/zoomAnchor` helper the toolbar's −/+ buttons also call. The two
 * anchor cases below therefore place the pointer somewhere the bar is NOT, so a
 * handler that quietly went back to `e.clientX` fails them.
 */

const SR = 44_100;
const LANE = 1000;
/* The `getBoundingClientRect` stub that used to live here is GONE, and its
 * absence is part of the pin. It existed so `e.clientX` could be turned into a
 * lane-local x; under D1 the hook reads no rect at all. Leaving jsdom's zero
 * rect in place also keeps the anchor cases sharp — a regression to pointer
 * anchoring would read `clientX - 0`, i.e. exactly the pointer x each case
 * passes, and would still be caught. */

function Harness() {
  const ref = createRef<HTMLDivElement>();
  useMultitrackZoom(ref as React.RefObject<HTMLElement | null>);
  return <div ref={ref} data-testid="lane" style={{ width: LANE }} />;
}

const store = () => useSessionStore.getState();
const zoom = () => useSessionStore.getState().mtZoom;

function mountOverSession(lengthSample: number): HTMLElement {
  _resetSessionLaneWidth();
  setSessionLaneWidth(LANE);
  store().newSession(SR);
  store().addClip(
    store().session.tracks[0].id,
    createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample })
  );
  const { getByTestId } = render(<Harness />);
  return getByTestId('lane');
}

/** A real wheel event with the modifier keys the hook branches on. */
function wheel(el: HTMLElement, init: { deltaY: number; ctrlKey?: boolean; shiftKey?: boolean; clientX?: number }): void {
  act(() => {
    el.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: init.deltaY,
        ctrlKey: init.ctrlKey ?? false,
        shiftKey: init.shiftKey ?? false,
        clientX: init.clientX ?? 0,
      })
    );
  });
}

describe('useMultitrackZoom', () => {
  it('leaves a plain wheel alone, so the lanes scroll vertically', () => {
    const lane = mountOverSession(178 * SR);
    const before = zoom();
    wheel(lane, { deltaY: 120 });
    expect(zoom()).toBe(before);
  });

  it('D1: Ctrl+wheel keeps the CURSOR at its x, and lets the pointer sample move', () => {
    // D1 — the bar is the anchor, not the pointer. The pointer is deliberately
    // somewhere else (x = 600 while the bar sits at x = 200), so a handler that
    // still anchored on `e.clientX` would hold 600 and fail both halves.
    const lane = mountOverSession(178 * SR);
    // Start zoomed IN, so there is room to move in both directions.
    act(() => store().setMtZoom({ samplesPerPixel: 200, scrollSample: 100_000 }));
    const CURSOR_X = 200;
    const POINTER_X = 600;
    const cursor = zoom().scrollSample + CURSOR_X * zoom().samplesPerPixel; // 140 000
    const underPointer = zoom().scrollSample + POINTER_X * zoom().samplesPerPixel; // 220 000
    act(() => store().setMtCursor(cursor));

    wheel(lane, { deltaY: -100, ctrlKey: true, clientX: POINTER_X });
    expect(zoom().samplesPerPixel).toBeCloseTo(200 / 1.25, 6);
    expect(zoom().scrollSample + CURSOR_X * zoom().samplesPerPixel).toBeCloseTo(cursor, 3);
    // ...and the sample that WAS under the pointer has moved out from under it.
    expect((underPointer - zoom().scrollSample) / zoom().samplesPerPixel).not.toBeCloseTo(
      POINTER_X,
      3
    );

    wheel(lane, { deltaY: 100, ctrlKey: true, clientX: POINTER_X });
    expect(zoom().samplesPerPixel).toBeCloseTo(200, 6);
    expect(zoom().scrollSample + CURSOR_X * zoom().samplesPerPixel).toBeCloseTo(cursor, 3);
  });

  it('D1: Ctrl+wheel centres a cursor that is off screen', () => {
    // The other half of D1. The bar is 200 px to the LEFT of the visible window;
    // holding its (negative) x would zoom toward a bar the user cannot see, so
    // the gesture brings it to the middle of the lane instead.
    // Scrolled well into the session, so the centred scroll this asserts is a
    // position the store can actually commit — clamped at 0 it would pass or
    // fail for a reason that has nothing to do with the anchor.
    const lane = mountOverSession(178 * SR);
    act(() => store().setMtZoom({ samplesPerPixel: 200, scrollSample: 500_000 }));
    const cursor = 500_000 - 200 * 200; // x = −200
    act(() => store().setMtCursor(cursor));

    wheel(lane, { deltaY: -100, ctrlKey: true, clientX: 600 });

    expect(zoom().samplesPerPixel).toBeCloseTo(200 / 1.25, 6);
    expect((cursor - zoom().scrollSample) / zoom().samplesPerPixel).toBeCloseTo(LANE / 2, 3);
  });

  it('Shift+wheel scrolls at the current zoom without changing it', () => {
    const lane = mountOverSession(178 * SR);
    act(() => store().setMtZoom({ samplesPerPixel: 200, scrollSample: 0 }));
    wheel(lane, { deltaY: 10, shiftKey: true });
    expect(zoom().samplesPerPixel).toBe(200);
    expect(zoom().scrollSample).toBe(10 * 200);
  });

  it('cannot zoom out past the fit — the private end/50 ceiling is gone', () => {
    // The removed clamp allowed `max(1, end/50)`, which for this session is
    // 157 080 samples/px — 32x COARSER than the fit. If the hook ever clamps
    // for itself again, this walks straight past the fit and fails.
    const lane = mountOverSession(178 * SR);
    const fit = fitSessionSamplesPerPixel(store().session, LANE);
    for (let i = 0; i < 60; i++) wheel(lane, { deltaY: 100, ctrlKey: true, clientX: 0 });
    expect(zoom().samplesPerPixel).toBe(fit);
    expect(fit).toBeLessThan((178 * SR) / 50);
  });

  it('cannot zoom in past MT_MIN_SPP', () => {
    const lane = mountOverSession(178 * SR);
    for (let i = 0; i < 200; i++) wheel(lane, { deltaY: -100, ctrlKey: true, clientX: 0 });
    expect(zoom().samplesPerPixel).toBe(MT_MIN_SPP);
  });

  it('scrolls no further than the timeline plus its open-ended tail', () => {
    const lane = mountOverSession(100_000);
    act(() => store().setMtZoom({ samplesPerPixel: 50, scrollSample: 0 }));
    const max = 100_000 + MT_TIMELINE_TAIL_SEC * SR - LANE * 50;
    // Each event advances deltaY * spp = 50 000 samples, so the loop has to be
    // long enough to REACH the ceiling before it can prove the ceiling holds —
    // a shorter loop stops short of it and passes for the wrong reason.
    const enough = Math.ceil(max / (1000 * 50)) + 5;
    for (let i = 0; i < enough; i++) wheel(lane, { deltaY: 1000, shiftKey: true });
    expect(zoom().scrollSample).toBe(max);
  });

  it('detaches its listener on unmount', () => {
    _resetSessionLaneWidth();
    setSessionLaneWidth(LANE);
    store().newSession(SR);
    store().addClip(
      store().session.tracks[0].id,
      createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 178 * SR })
    );
    const { getByTestId, unmount } = render(<Harness />);
    const lane = getByTestId('lane');
    act(() => store().setMtZoom({ samplesPerPixel: 200, scrollSample: 0 }));
    unmount();
    const after = zoom();
    wheel(lane, { deltaY: 100, ctrlKey: true, clientX: 0 });
    expect(zoom()).toBe(after);
  });
});
