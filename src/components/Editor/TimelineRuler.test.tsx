import { act, render, screen } from '@testing-library/react';
import TimelineRuler from './TimelineRuler';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { makeInitialState, useAppStore } from '../../stores/appStore';
import { _resetSnapPreference } from '../../services/snapPreference';
import * as beatGridService from '../../services/beatGrid';
import type { BeatGrid } from '../../services/beatGrid';

/**
 * F11-2 — "clicking on a time on the timeline at the top should bring this
 * line there", plus the scrub that falls out of the same handler.
 *
 * The ruler already seeked on `click`. What is pinned here is what it did NOT
 * do: seek on the press rather than the release, follow the pointer while held,
 * obey the editor's magnet, and stop at the end of the track.
 */

const SPP = 100;
const BEAT = 22_050; // -> x = 220.5 at SPP = 100
const LENGTH = 441_000; // -> x = 4410

function firePointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { clientX: number; pointerId?: number; altKey?: boolean }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: 5,
    altKey: init.altKey ?? false,
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
    analyzedEndSample: LENGTH,
    truncated: false,
    origin: 'own',
    originDocId: 'doc-1',
    originOpen: true,
  };
}

let gridSpy: jest.SpyInstance;
let doc: AudioDocument;

function mountRuler(props: Partial<React.ComponentProps<typeof TimelineRuler>> = {}) {
  render(<TimelineRuler sampleRate={44_100} length={LENGTH} {...props} />);
  return screen.getByTestId('timeline-ruler');
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetSnapPreference();
  doc = createDocument({
    name: 'ruler.wav',
    sampleRate: 44_100,
    channels: [new Float32Array(LENGTH)],
  });
  useAppStore.getState().addDocument(doc);
  useAppStore.getState().setZoom({ samplesPerPixel: SPP, scrollSample: 0 });
  gridSpy = jest
    .spyOn(beatGridService, 'getBeatGrid')
    .mockReturnValue(makeGrid([0, BEAT, 2 * BEAT]));
});

afterEach(() => {
  gridSpy.mockRestore();
  _resetSnapPreference();
});

describe('the ruler seeks (F11-2)', () => {
  it('moves the position line on the PRESS, not on the release', () => {
    const ruler = mountRuler();

    firePointer(ruler, 'pointerdown', { clientX: 500 });

    // Already there — no pointerup has happened yet.
    expect(useAppStore.getState().cursorSample).toBe(500 * SPP);
  });

  it('honours the scroll offset, so a seek lands where the label says', () => {
    act(() => {
      useAppStore.getState().setZoom({ samplesPerPixel: SPP, scrollSample: 100_000 });
    });
    const ruler = mountRuler();

    firePointer(ruler, 'pointerdown', { clientX: 300 });

    expect(useAppStore.getState().cursorSample).toBe(100_000 + 300 * SPP);
  });

  it('scrubs live while the button is held, and stops when it is released', () => {
    const ruler = mountRuler();

    firePointer(ruler, 'pointerdown', { clientX: 100 });
    firePointer(ruler, 'pointermove', { clientX: 400 });
    expect(useAppStore.getState().cursorSample).toBe(400 * SPP);

    firePointer(ruler, 'pointermove', { clientX: 900 });
    expect(useAppStore.getState().cursorSample).toBe(900 * SPP);

    firePointer(ruler, 'pointerup', { clientX: 900 });
    firePointer(ruler, 'pointermove', { clientX: 1200 });
    expect(useAppStore.getState().cursorSample).toBe(900 * SPP);
  });

  it('does nothing on a bare hover — a pointer crossing the ruler is not a seek', () => {
    const ruler = mountRuler();

    firePointer(ruler, 'pointermove', { clientX: 700 });

    expect(useAppStore.getState().cursorSample).toBe(0);
  });

  it('obeys the SAME magnet as the lane: 224px is pulled onto the beat at 220.5px', () => {
    const ruler = mountRuler();

    firePointer(ruler, 'pointerdown', { clientX: 224 });

    expect(useAppStore.getState().cursorSample).toBe(BEAT);
  });

  it('snaps the scrub too, not only the press', () => {
    const ruler = mountRuler();

    firePointer(ruler, 'pointerdown', { clientX: 10 });
    firePointer(ruler, 'pointermove', { clientX: 224 });

    expect(useAppStore.getState().cursorSample).toBe(BEAT);
  });

  it('Alt suspends the magnet, exactly as it does in the lane', () => {
    const ruler = mountRuler();

    firePointer(ruler, 'pointerdown', { clientX: 224, altKey: true });

    expect(useAppStore.getState().cursorSample).toBe(224 * SPP);
  });

  it('clamps to the track: past the end lands on the end, before zero lands on zero', () => {
    const ruler = mountRuler();

    firePointer(ruler, 'pointerdown', { clientX: 9_000 });
    expect(useAppStore.getState().cursorSample).toBe(LENGTH);

    firePointer(ruler, 'pointerdown', { clientX: -50 });
    expect(useAppStore.getState().cursorSample).toBe(0);
  });

  it('freezes the magnet’s targets for the whole scrub — an analysis landing mid-drag does not move the pointer', () => {
    const ruler = mountRuler();

    firePointer(ruler, 'pointerdown', { clientX: 10 });
    // A brand-new grid arrives, with a beat right where the pointer is heading.
    gridSpy.mockReturnValue(makeGrid([0, 60_000]));
    firePointer(ruler, 'pointermove', { clientX: 601 });

    // 601px = 60 100 samples, 1px from the NEW beat — and untouched, because
    // the targets this gesture uses were read once, at the press.
    expect(useAppStore.getState().cursorSample).toBe(601 * SPP);
  });

  it('routes through a caller’s own seek and zoom (the multitrack ruler)', () => {
    const seen: number[] = [];
    const ruler = mountRuler({
      zoom: { samplesPerPixel: 10, scrollSample: 0 },
      onSeek: (s) => seen.push(s),
      snapTargets: () => [],
      length: undefined,
    });

    firePointer(ruler, 'pointerdown', { clientX: 250 });

    expect(seen).toEqual([2_500]);
    // The app store's cursor is NOT the multitrack cursor.
    expect(useAppStore.getState().cursorSample).toBe(0);
  });

  it('leaves playback alone — seeking mid-play moves the cursor and nothing else', () => {
    act(() => {
      useAppStore.getState().setPlayback({ state: 'playing', positionSample: 12_345 });
    });
    const ruler = mountRuler();

    firePointer(ruler, 'pointerdown', { clientX: 500 });

    expect(useAppStore.getState().cursorSample).toBe(500 * SPP);
    expect(useAppStore.getState().playback).toEqual({
      state: 'playing',
      positionSample: 12_345,
      loop: false,
    });
  });
});
