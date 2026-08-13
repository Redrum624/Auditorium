import { act, render, screen } from '@testing-library/react';
import WaveformView from './WaveformView';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { makeInitialState, useAppStore } from '../../stores/appStore';
import { clearAllPeaks } from '../../services/peaksCache';
import { _resetSnapPreference } from '../../services/snapPreference';
import * as beatGridService from '../../services/beatGrid';
import type { BeatGrid } from '../../services/beatGrid';
import {
  CURSOR_HANDLE_HIT_H,
  CURSOR_HANDLE_HIT_PX,
  isOnCursorHandle,
} from './waveformRender';

/**
 * F11-1 — the playhead grab handle.
 *
 * The user asked for "a draggable red triangle at top of the position line
 * while on the music to put it where you want to". Three things have to be
 * true and are pinned here: the handle is grabbable, grabbing it does not by
 * itself move anything, and dragging it obeys the SAME magnet that cursor
 * placement has obeyed since B4 — the existing `snapSample` resolution, not a
 * second copy of it.
 */

const SPP = 100; // samples per pixel
const BEAT = 22_050; // -> x = 220.5 at SPP=100

// jsdom has no window.PointerEvent, so testing-library's fireEvent.pointerDown
// degrades to a bare Event that drops clientX/clientY. Dispatch a real
// MouseEvent, which carries them, with pointerId attached — all the gesture
// handlers read off the event. (Same technique as WaveformView.snap.test.tsx.)
function firePointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { clientX: number; clientY: number; pointerId?: number; altKey?: boolean; detail?: number }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
    altKey: init.altKey ?? false,
    detail: init.detail ?? 1,
  });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

function makeGrid(beats: number[]): BeatGrid {
  return {
    beatSamples: Int32Array.from(beats),
    sampleRate: 44_100,
    beatsPerBar: null,
    downbeatPhase: null,
    barCount: 0,
    confidence: 0.9,
    stale: false,
    analyzedEndSample: 441_000,
    truncated: false,
    origin: 'own',
    originDocId: 'doc-1',
    originOpen: true,
  };
}

function makeDoc(): AudioDocument {
  return createDocument({
    name: 'handle.wav',
    sampleRate: 44_100,
    channels: [new Float32Array(441_000)],
  });
}

let gridSpy: jest.SpyInstance;
let doc: AudioDocument;

function mount(): HTMLElement {
  render(<WaveformView docId={doc.id} />);
  return screen.getByTestId('waveform-canvas');
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  clearAllPeaks();
  _resetSnapPreference();
  doc = makeDoc();
  useAppStore.getState().addDocument(doc);
  useAppStore.getState().setZoom({ samplesPerPixel: SPP, scrollSample: 0 });
  gridSpy = jest
    .spyOn(beatGridService, 'getBeatGrid')
    .mockReturnValue(makeGrid([0, BEAT, 2 * BEAT, 3 * BEAT]));
});

afterEach(() => {
  gridSpy.mockRestore();
  _resetSnapPreference();
});

describe('the handle’s hit rule (F11-1)', () => {
  it('claims a band at the very top of the lane, centred on the line', () => {
    expect(isOnCursorHandle(300, 0, 300)).toBe(true);
    expect(isOnCursorHandle(300, CURSOR_HANDLE_HIT_H, 300)).toBe(true);
    expect(isOnCursorHandle(300 + CURSOR_HANDLE_HIT_PX, 4, 300)).toBe(true);
    expect(isOnCursorHandle(300 - CURSOR_HANDLE_HIT_PX, 4, 300)).toBe(true);
  });

  it('lets go one pixel outside it, in every direction', () => {
    expect(isOnCursorHandle(300, CURSOR_HANDLE_HIT_H + 1, 300)).toBe(false);
    expect(isOnCursorHandle(300, -1, 300)).toBe(false);
    expect(isOnCursorHandle(300 + CURSOR_HANDLE_HIT_PX + 1, 4, 300)).toBe(false);
    expect(isOnCursorHandle(300 - CURSOR_HANDLE_HIT_PX - 1, 4, 300)).toBe(false);
  });
});

describe('dragging the playhead handle (F11-1)', () => {
  it('moves the cursor live while dragging', () => {
    useAppStore.getState().setCursor(0);
    const canvas = mount();

    // Grab at the line's top (cursor is at sample 0 -> x = 0).
    firePointer(canvas, 'pointerdown', { clientX: 2, clientY: 3 });
    // Drag out to x = 500, well away from any beat.
    firePointer(canvas, 'pointermove', { clientX: 500, clientY: 3 });

    expect(useAppStore.getState().cursorSample).toBe(500 * SPP);
  });

  it('does NOT move the cursor merely by being grabbed', () => {
    // Parked at x = 300, far from every beat (0 / 220.5 / 441 px), so the
    // "unchanged" this asserts cannot be a snap landing on the same value.
    useAppStore.getState().setCursor(300 * SPP);
    const canvas = mount();

    // 8 px right of the line — off-centre, but still on the handle.
    firePointer(canvas, 'pointerdown', { clientX: 308, clientY: 3 });

    // A press on the lane body would have jumped the cursor to 30 800.
    // Grabbing a handle must not move the thing being grabbed.
    expect(useAppStore.getState().cursorSample).toBe(300 * SPP);
  });

  it('never touches the selection — dragging the playhead across one leaves it whole', () => {
    useAppStore.getState().setCursor(0);
    useAppStore.setState({ selection: { start: 1_000, end: 50_000 } });
    const canvas = mount();

    firePointer(canvas, 'pointerdown', { clientX: 0, clientY: 3 });
    firePointer(canvas, 'pointermove', { clientX: 300, clientY: 3 });
    firePointer(canvas, 'pointerup', { clientX: 300, clientY: 3 });

    expect(useAppStore.getState().selection).toEqual({ start: 1_000, end: 50_000 });
    expect(useAppStore.getState().cursorSample).toBe(300 * SPP);
  });

  it('obeys the SAME magnet as cursor placement — the beat at 220.5px pulls a drag to 224px', () => {
    useAppStore.getState().setCursor(0);
    const canvas = mount();

    firePointer(canvas, 'pointerdown', { clientX: 0, clientY: 3 });
    firePointer(canvas, 'pointermove', { clientX: 224, clientY: 3 });

    expect(useAppStore.getState().cursorSample).toBe(BEAT);
  });

  it('Alt suspends the magnet mid-drag, exactly as it does for a selection', () => {
    useAppStore.getState().setCursor(0);
    const canvas = mount();

    firePointer(canvas, 'pointerdown', { clientX: 0, clientY: 3 });
    firePointer(canvas, 'pointermove', { clientX: 224, clientY: 3, altKey: true });

    expect(useAppStore.getState().cursorSample).toBe(224 * SPP);
  });

  // PW1. Found by the packaged navigation walker, which dragged the handle with
  // Alt held on a document opened FITTED — and a fitted zoom is
  // `docLength / laneWidth`, which is almost never a whole number of samples per
  // pixel. The cursor came to rest at 121308.03126517865.
  //
  // Why that is a defect rather than a rounding curiosity: `marker.add` writes
  // `positionSample: cursorSample` verbatim, so the fraction becomes marker
  // DATA and travels into the cue chunk of every export written from it. And
  // the ruler — the other surface that writes this exact field — has always
  // rounded its own seek, so the two disagreed about whether `cursorSample` is
  // an integer at all.
  //
  // The zoom here is deliberately fractional for the same reason a fitted
  // document's is: at the integer SPP the rest of this file uses, every
  // arithmetic path lands on a whole sample by luck and the bug is invisible.
  it('lands on a WHOLE sample even at a fractional zoom, with the magnet suspended', () => {
    useAppStore.getState().setZoom({ samplesPerPixel: 182.3821339950372, scrollSample: 0 });
    useAppStore.getState().setCursor(0);
    const canvas = mount();

    firePointer(canvas, 'pointerdown', { clientX: 0, clientY: 3 });
    firePointer(canvas, 'pointermove', { clientX: 224, clientY: 3, altKey: true });

    const cursor = useAppStore.getState().cursorSample;
    expect(cursor).toBe(Math.round(224 * 182.3821339950372));
    expect(Number.isInteger(cursor)).toBe(true);
  });

  it('rounds a dragged SELECTION to whole samples too — same resolver, same field kind', () => {
    // `snapped()` feeds `dragToSelection` as well as `setCursor`, so a
    // fractional zoom used to produce a selection whose bounds sat between two
    // samples. The press is below the handle band, which is what makes this
    // gesture a selection drag rather than a playhead drag.
    useAppStore.getState().setZoom({ samplesPerPixel: 182.3821339950372, scrollSample: 0 });
    const canvas = mount();

    firePointer(canvas, 'pointerdown', {
      clientX: 10,
      clientY: CURSOR_HANDLE_HIT_H + 1,
      altKey: true,
    });
    firePointer(canvas, 'pointermove', {
      clientX: 300,
      clientY: CURSOR_HANDLE_HIT_H + 1,
      altKey: true,
    });

    const sel = useAppStore.getState().selection;
    expect(sel).not.toBeNull();
    expect(Number.isInteger(sel!.start)).toBe(true);
    expect(Number.isInteger(sel!.end)).toBe(true);
  });

  it('does not select-all on a double press, the way the lane body does', () => {
    useAppStore.getState().setCursor(0);
    const canvas = mount();

    firePointer(canvas, 'pointerdown', { clientX: 2, clientY: 3, detail: 2 });

    expect(useAppStore.getState().selection).toBeNull();
  });

  it('leaves a press BELOW the handle strip as the ordinary cursor placement it has always been', () => {
    // Same geometry as the grab test above — inside the handle's HORIZONTAL
    // reach, one pixel under its vertical band. Only the y differs, so this
    // isolates the boundary rather than the distance.
    useAppStore.getState().setCursor(300 * SPP);
    const canvas = mount();

    firePointer(canvas, 'pointerdown', { clientX: 308, clientY: CURSOR_HANDLE_HIT_H + 1 });

    expect(useAppStore.getState().cursorSample).toBe(308 * SPP);
  });

  it('shows grab / grabbing / nothing, so the affordance is visible before it is used', () => {
    useAppStore.getState().setCursor(0);
    const canvas = mount() as HTMLCanvasElement;

    expect(canvas.style.cursor).toBe('');

    firePointer(canvas, 'pointermove', { clientX: 4, clientY: 3 });
    expect(canvas.style.cursor).toBe('grab');

    firePointer(canvas, 'pointermove', { clientX: 400, clientY: 3 });
    expect(canvas.style.cursor).toBe('');

    firePointer(canvas, 'pointerdown', { clientX: 4, clientY: 3 });
    expect(canvas.style.cursor).toBe('grabbing');

    firePointer(canvas, 'pointerup', { clientX: 400, clientY: 3 });
    expect(canvas.style.cursor).toBe('');
  });

  it('is not undoable — the cursor is view state, and F11-1 keeps it that way', () => {
    useAppStore.getState().setCursor(0);
    const canvas = mount();
    const before = useAppStore.getState().documents.map((d) => d.dirty);

    firePointer(canvas, 'pointerdown', { clientX: 0, clientY: 3 });
    firePointer(canvas, 'pointermove', { clientX: 300, clientY: 3 });
    firePointer(canvas, 'pointerup', { clientX: 300, clientY: 3 });

    expect(useAppStore.getState().documents.map((d) => d.dirty)).toEqual(before);
  });
});
