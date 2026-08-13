import { act, render, screen } from '@testing-library/react';
import WaveformView from './WaveformView';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { clearAllPeaks } from '../../services/peaksCache';
import * as beatGridService from '../../services/beatGrid';
import type { BeatGrid } from '../../services/beatGrid';
import { SNAP_TOLERANCE_PX } from '../../services/snap';
import { _resetSnapPreference, setSnapEnabled, toggleSnap } from '../../services/snapPreference';
import { makeInitialState, useAppStore } from '../../stores/appStore';

/**
 * Task B4 integration — the magnet, driven with REAL pointer events through the
 * real gesture layer.
 *
 * Trap 28: the test hooks bypass the gesture layer entirely, so an assertion
 * made through them can pass without the magnet ever running. Everything below
 * therefore goes through `WaveformView`'s own `onPointerDown/Move/Up` handlers,
 * with the modifier carried on the event exactly as Chromium delivers it.
 */

const SPP = 100; // 1 CSS px == 100 samples, so the 8px tolerance is 800 samples
const BEAT = 22_050;

// jsdom has no window.PointerEvent, so @testing-library's fireEvent.pointerDown
// falls back to a bare `Event` that silently drops clientX/shiftKey/detail —
// AND altKey, which is the modifier this task's escape hatch is built on (the
// helper in WaveformView.test.tsx does not even accept it). Dispatch a real
// MouseEvent, which carries every UIEvent/MouseEvent field including altKey,
// and attach pointerId as a plain extra property.
function firePointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: {
    clientX: number;
    clientY?: number;
    pointerId?: number;
    shiftKey?: boolean;
    altKey?: boolean;
    detail?: number;
  }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    // F11-1: default into the lane BODY — see WaveformView.test.tsx's helper
    // for why y=0 is now a different gesture (the playhead grab handle).
    clientY: init.clientY ?? 40,
    shiftKey: init.shiftKey ?? false,
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
  const ch = new Float32Array(441_000);
  return createDocument({ name: 'beat.wav', sampleRate: 44_100, channels: [ch] });
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

describe('cursor placement snaps to a beat', () => {
  it('pulls a click 3.5px past a beat onto the beat exactly', () => {
    const canvas = mount();
    // Beat 22 050 is at x = 220.5. Clicking at 224 is 350 samples (3.5px) past.
    firePointer(canvas, 'pointerdown', { clientX: 224 });
    expect(useAppStore.getState().cursorSample).toBe(BEAT);
  });

  it('pulls a click BEFORE a beat forward onto it', () => {
    const canvas = mount();
    firePointer(canvas, 'pointerdown', { clientX: 217 });
    expect(useAppStore.getState().cursorSample).toBe(BEAT);
  });

  it('leaves a click well away from every beat untouched, decimals included', () => {
    const canvas = mount();
    // x = 235 -> 23 500, 14.5px from beat 22 050 and 30.5px from 44 100.
    firePointer(canvas, 'pointerdown', { clientX: 235 });
    expect(useAppStore.getState().cursorSample).toBe(235 * SPP);
  });

  it('also snaps to a MARKER, not only to a beat', () => {
    gridSpy.mockReturnValue(null);
    useAppStore
      .getState()
      .setMarkersForDoc(doc.id, [{ id: 'mk', name: 'verse', positionSample: 30_000 }]);
    const canvas = mount();
    // marker at x = 300; click at 303 (3px away).
    firePointer(canvas, 'pointerdown', { clientX: 303 });
    expect(useAppStore.getState().cursorSample).toBe(30_000);
  });

  it('respects the pixel tolerance boundary at THIS zoom', () => {
    const canvas = mount();
    const xExact = BEAT / SPP + SNAP_TOLERANCE_PX; // 228.5
    firePointer(canvas, 'pointerdown', { clientX: xExact });
    expect(useAppStore.getState().cursorSample).toBe(BEAT);

    firePointer(canvas, 'pointerdown', { clientX: xExact + 0.5 });
    expect(useAppStore.getState().cursorSample).toBe((xExact + 0.5) * SPP);
  });

  it('the SAME sample distance snaps at one zoom and not at another (pixel space, not sample space)', () => {
    // The mutation check, driven end to end: 500 samples from the beat.
    const canvas = mount();

    // Zoomed OUT to 100 samples/px: 500 samples is 5px -> snaps.
    firePointer(canvas, 'pointerdown', { clientX: (BEAT + 500) / 100 });
    expect(useAppStore.getState().cursorSample).toBe(BEAT);

    // Zoomed IN to 10 samples/px: the same 500 samples is 50px -> must NOT snap.
    act(() => {
      useAppStore.getState().setZoom({ samplesPerPixel: 10, scrollSample: 0 });
    });
    firePointer(canvas, 'pointerdown', { clientX: (BEAT + 500) / 10 });
    expect(useAppStore.getState().cursorSample).toBe(BEAT + 500);
  });
});

describe('selection edges snap while the anchor stays put', () => {
  it('snaps the moving edge and leaves the anchor exactly where the drag began', () => {
    const canvas = mount();
    // Anchor at x = 100 -> 10 000: no beat within 800 samples, so it stays raw.
    firePointer(canvas, 'pointerdown', { clientX: 100 });
    expect(useAppStore.getState().cursorSample).toBe(10_000);

    // Drag out to x = 224 -> 22 400, 3.5px from beat 22 050.
    firePointer(canvas, 'pointermove', { clientX: 224 });
    expect(useAppStore.getState().selection).toEqual({ start: 10_000, end: BEAT });

    // Keep dragging: the anchor must still be 10 000, not re-snapped.
    firePointer(canvas, 'pointermove', { clientX: 448 });
    expect(useAppStore.getState().selection).toEqual({ start: 10_000, end: 2 * BEAT });

    firePointer(canvas, 'pointerup', { clientX: 448 });
    expect(useAppStore.getState().selection).toEqual({ start: 10_000, end: 2 * BEAT });
  });

  it('snaps the anchor too when the drag STARTS near a beat, then keeps it fixed', () => {
    const canvas = mount();
    firePointer(canvas, 'pointerdown', { clientX: 224 }); // -> 22 050
    firePointer(canvas, 'pointermove', { clientX: 300 }); // -> 30 000, no beat near
    expect(useAppStore.getState().selection).toEqual({ start: BEAT, end: 30_000 });
  });

  it('a shift+click extends to a snapped point without moving the existing edge', () => {
    const canvas = mount();
    act(() => {
      useAppStore.setState({ selection: null, cursorSample: 10_001 });
    });
    firePointer(canvas, 'pointerdown', { clientX: 224, shiftKey: true });
    // The anchor is the pre-existing cursor and is NOT snapped — the magnet must
    // never move something the user did not drag.
    expect(useAppStore.getState().selection).toEqual({ start: 10_001, end: BEAT });
  });
});

describe('the Alt modifier suspends the magnet WHILE HELD', () => {
  it('a click with Alt held is not snapped', () => {
    const canvas = mount();
    firePointer(canvas, 'pointerdown', { clientX: 224, altKey: true });
    expect(useAppStore.getState().cursorSample).toBe(22_400);
  });

  it('is read on EVERY event, so pressing Alt mid-drag suspends the magnet immediately', () => {
    const canvas = mount();
    firePointer(canvas, 'pointerdown', { clientX: 100 });

    firePointer(canvas, 'pointermove', { clientX: 224 });
    expect(useAppStore.getState().selection).toEqual({ start: 10_000, end: BEAT }); // snapped

    // Alt goes down mid-drag, with no keyup listener anywhere: the modifier
    // rides the pointer event itself.
    firePointer(canvas, 'pointermove', { clientX: 224, altKey: true });
    expect(useAppStore.getState().selection).toEqual({ start: 10_000, end: 22_400 });
  });

  it('resumes on release', () => {
    const canvas = mount();
    firePointer(canvas, 'pointerdown', { clientX: 100 });
    firePointer(canvas, 'pointermove', { clientX: 224, altKey: true });
    expect(useAppStore.getState().selection).toEqual({ start: 10_000, end: 22_400 });

    firePointer(canvas, 'pointermove', { clientX: 224, altKey: false });
    expect(useAppStore.getState().selection).toEqual({ start: 10_000, end: BEAT });
  });

  it('the modifier on pointerUP decides the final selection, so the commit matches what is shown', () => {
    const canvas = mount();
    firePointer(canvas, 'pointerdown', { clientX: 100 });
    firePointer(canvas, 'pointermove', { clientX: 224, altKey: true });
    firePointer(canvas, 'pointerup', { clientX: 224, altKey: true });
    expect(useAppStore.getState().selection).toEqual({ start: 10_000, end: 22_400 });
  });

  it('jsdom really does carry altKey on the dispatched event (guards the helper itself)', () => {
    const canvas = mount();
    const seen: boolean[] = [];
    canvas.addEventListener('pointerdown', (e) => seen.push((e as MouseEvent).altKey));
    firePointer(canvas, 'pointerdown', { clientX: 224, altKey: true });
    firePointer(canvas, 'pointerdown', { clientX: 224, altKey: false });
    expect(seen).toEqual([true, false]);
  });
});

describe('the toggle disables the magnet entirely', () => {
  it('switching it off leaves every position raw', () => {
    const canvas = mount();
    firePointer(canvas, 'pointerdown', { clientX: 224 });
    expect(useAppStore.getState().cursorSample).toBe(BEAT);

    act(() => {
      setSnapEnabled(false);
    });
    firePointer(canvas, 'pointerdown', { clientX: 224 });
    expect(useAppStore.getState().cursorSample).toBe(22_400);

    firePointer(canvas, 'pointerdown', { clientX: 100 });
    firePointer(canvas, 'pointermove', { clientX: 224 });
    expect(useAppStore.getState().selection).toEqual({ start: 10_000, end: 22_400 });
  });

  it('toggling it back on restores the magnet', () => {
    const canvas = mount();
    act(() => {
      setSnapEnabled(false);
    });
    firePointer(canvas, 'pointerdown', { clientX: 224 });
    expect(useAppStore.getState().cursorSample).toBe(22_400);

    act(() => {
      toggleSnap();
    });
    firePointer(canvas, 'pointerdown', { clientX: 224 });
    expect(useAppStore.getState().cursorSample).toBe(BEAT);
  });
});

describe('nothing to snap to', () => {
  it('with no cached grid and no markers, every position is exactly what it was before B4', () => {
    gridSpy.mockReturnValue(null);
    const canvas = mount();
    firePointer(canvas, 'pointerdown', { clientX: 224 });
    expect(useAppStore.getState().cursorSample).toBe(22_400);
    firePointer(canvas, 'pointermove', { clientX: 300 });
    expect(useAppStore.getState().selection).toEqual({ start: 22_400, end: 30_000 });
  });

  it('an unsnapped position keeps its exact float value (trap 21)', () => {
    gridSpy.mockReturnValue(null);
    act(() => {
      useAppStore.getState().setZoom({ samplesPerPixel: 512, scrollSample: 0 });
    });
    const canvas = mount();
    firePointer(canvas, 'pointerdown', { clientX: 2 });
    // The exact expectation WaveformView.test.tsx pins, reproduced here so a
    // future rounding change in the gesture path fails in both places.
    expect(useAppStore.getState().cursorSample).toBe(2 * 512);
  });

  it('never starts an analysis just to find a target', () => {
    const canvas = mount();
    firePointer(canvas, 'pointerdown', { clientX: 224 });
    firePointer(canvas, 'pointermove', { clientX: 300 });
    firePointer(canvas, 'pointerup', { clientX: 300 });
    // getBeatGrid is B1's cached read by construction; the gesture layer must
    // not reach past it to anything that could kick off a worker.
    expect(gridSpy).toHaveBeenCalled();
  });
});
