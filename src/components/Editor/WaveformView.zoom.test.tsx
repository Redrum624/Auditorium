import { act, render, screen } from '@testing-library/react';
import WaveformView from './WaveformView';
import { createDocument, docLength, type AudioDocument } from '../../audio/AudioDocument';
import { makeInitialState, useAppStore } from '../../stores/appStore';
import { clearAllPeaks } from '../../services/peaksCache';
import * as waveformRender from './waveformRender';
import type { RenderOpts } from './waveformRender';
import * as beatGridService from '../../services/beatGrid';
import type { BeatGrid } from '../../services/beatGrid';
import { setBeatGridVisible } from '../../services/beatGridDisplay';

/**
 * F11-3 / F11-9 — the editor's zoom is ONE resolved (samplesPerPixel,
 * scrollSample) pair, clamped in one place, and the whole track fits the real
 * lane the moment it opens.
 *
 * The reported bug: "after detecting the tempo, zooming out on Waveform still
 * affects the tempo lines and the timeline even though the track has reached
 * its limit". The waveform freezes while the beat tics and the ruler keep
 * moving, because the two layers stop agreeing about what is on screen:
 *
 *  - the waveform is painted by `getPeaksForRange`, which CLAMPS its request to
 *    `[0, length]` and then spreads whatever survives over every pixel column.
 *    Once the requested window runs past the end of the document the picture is
 *    identical for every further zoom-out — the waveform is pinned;
 *  - the beat tics and the ruler both map samples through `sampleToPixel` with
 *    the raw `samplesPerPixel`, no clamp, so they carry on compressing toward
 *    the left edge.
 *
 * The invariant that makes all three layers agree is therefore one line:
 *
 *      scrollSample + laneWidth * samplesPerPixel  <=  docLength
 *
 * i.e. the visible window never runs past the end of the track, which is
 * exactly the condition under which `getPeaksForRange`'s clamp is inert. The
 * furthest zoom-out is the fit, and the fit is the furthest zoom-out.
 */

// The lane this suite pretends to have. jsdom lays everything out at 0x0, so
// the ResizeObserver would otherwise measure nothing and the render effect
// would bail before `renderWaveform` was ever called.
const LANE_W = 300;
const LANE_H = 150;

const LENGTH = 441_000; // 10 s at 44.1 kHz
const BEAT = 22_050; // every half second

function makeDoc(): AudioDocument {
  const ch = new Float32Array(LENGTH);
  for (let i = 0; i < ch.length; i++) ch[i] = Math.sin(i / 20) * 0.5;
  return createDocument({ name: 'tempo.wav', sampleRate: 44_100, channels: [ch] });
}

function makeGrid(): BeatGrid {
  const beats: number[] = [];
  for (let s = 0; s < LENGTH; s += BEAT) beats.push(s);
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

// One recording context for the waveform canvas AND the ruler canvas: the
// ruler's `fillText` calls are the ruler's realised scale, which is precisely
// the thing that used to keep moving after the waveform had stopped.
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

let getContextSpy: jest.SpyInstance;
let renderSpy: jest.SpyInstance;
let gridSpy: jest.SpyInstance;

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  clearAllPeaks();
  for (const prop of ['clientWidth', 'clientHeight'] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      value: prop === 'clientWidth' ? LANE_W : LANE_H,
    });
  }
  for (const fn of Object.values(fakeCtx)) {
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as jest.Mock).mockClear();
  }
  getContextSpy = jest
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(() => fakeCtx as unknown as CanvasRenderingContext2D);
  renderSpy = jest.spyOn(waveformRender, 'renderWaveform').mockImplementation(() => {});
  gridSpy = jest.spyOn(beatGridService, 'getBeatGrid').mockReturnValue(makeGrid());
  setBeatGridVisible(true);
});

afterEach(() => {
  getContextSpy.mockRestore();
  renderSpy.mockRestore();
  gridSpy.mockRestore();
  act(() => {
    setBeatGridVisible(true);
  });
  for (const prop of ['clientWidth', 'clientHeight'] as const) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
  }
});

/** The parameters the waveform was last painted with. */
function lastOpts(): RenderOpts {
  return renderSpy.mock.calls[renderSpy.mock.calls.length - 1][1] as RenderOpts;
}

/** Every x the ruler has printed a time label at, in order — its realised
 * scale, read off the canvas rather than recomputed from the store. */
function rulerLabelXs(): number[] {
  return fakeCtx.fillText.mock.calls.map((c) => c[1] as number);
}

function wheel(canvas: Element, deltaY: number): void {
  act(() => {
    canvas.dispatchEvent(
      new WheelEvent('wheel', { deltaY, clientX: 0, bubbles: true, cancelable: true })
    );
  });
}

function mount(doc: AudioDocument): Element {
  useAppStore.getState().addDocument(doc);
  render(<WaveformView docId={doc.id} />);
  return screen.getByTestId('waveform-canvas');
}

describe('F11-3 — opening a document fits it to the real lane', () => {
  it('lays the whole track across the measured lane exactly, not a nominal 1600px one', () => {
    const doc = makeDoc();
    mount(doc);

    const { samplesPerPixel, scrollSample } = useAppStore.getState().zoom;
    expect(scrollSample).toBe(0);
    expect(scrollSample + LANE_W * samplesPerPixel).toBeCloseTo(docLength(doc), 6);
  });

  it('paints the waveform with that same pair — the store zoom IS the draw param', () => {
    const doc = makeDoc();
    mount(doc);

    const zoom = useAppStore.getState().zoom;
    expect(lastOpts().samplesPerPixel).toBe(zoom.samplesPerPixel);
    expect(lastOpts().scrollSample).toBe(zoom.scrollSample);
  });
});

describe('F11-9 — at the zoom-out limit nothing moves', () => {
  it('a zoom-out wheel at the fit level leaves the store zoom untouched', () => {
    const doc = makeDoc();
    const canvas = mount(doc);
    // Sit the view exactly at the fit — the whole track across the lane.
    act(() => {
      useAppStore
        .getState()
        .setZoom({ samplesPerPixel: LENGTH / LANE_W, scrollSample: 0 });
    });
    const before = useAppStore.getState().zoom;

    wheel(canvas, 120); // zoom out

    // Not merely equal: the SAME object. Nothing was written, so nothing
    // downstream re-rendered or repainted either.
    expect(useAppStore.getState().zoom).toBe(before);
  });

  it('leaves the waveform, the beat tics and the ruler on the same numbers', () => {
    const doc = makeDoc();
    const canvas = mount(doc);
    act(() => {
      useAppStore
        .getState()
        .setZoom({ samplesPerPixel: LENGTH / LANE_W, scrollSample: 0 });
    });
    const beforeOpts = lastOpts();
    const beforeSpp = beforeOpts.samplesPerPixel;
    const beforeScroll = beforeOpts.scrollSample;
    fakeCtx.fillText.mockClear();

    wheel(canvas, 120);
    wheel(canvas, 120);
    wheel(canvas, 120);

    // The waveform's draw params (which the tic layer shares — the tics are
    // drawn from `opts.scrollSample`/`opts.samplesPerPixel` inside
    // renderWaveform) are untouched...
    expect(lastOpts().samplesPerPixel).toBe(beforeSpp);
    expect(lastOpts().scrollSample).toBe(beforeScroll);
    expect(lastOpts().beatGrid).not.toBeNull();
    // ...and the ruler never repainted at all, so its labels cannot have moved.
    expect(rulerLabelXs()).toEqual([]);
  });

  it('never lets the visible window run past the end of the track, however hard you zoom out', () => {
    const doc = makeDoc();
    const canvas = mount(doc);
    for (let i = 0; i < 30; i++) wheel(canvas, 120);

    const { samplesPerPixel, scrollSample } = useAppStore.getState().zoom;
    // THE invariant: past this line `getPeaksForRange` starts clamping and the
    // waveform freezes while the tics and the ruler carry on.
    expect(scrollSample + LANE_W * samplesPerPixel).toBeLessThanOrEqual(docLength(doc) + 1e-6);
  });

  it('zooming back in still works from the limit', () => {
    const doc = makeDoc();
    const canvas = mount(doc);
    const atLimit = useAppStore.getState().zoom.samplesPerPixel;

    wheel(canvas, -120); // zoom in

    expect(useAppStore.getState().zoom.samplesPerPixel).toBeLessThan(atLimit);
  });
});
