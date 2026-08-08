/**
 * Task B3 — the beat tics as ClipView actually paints them.
 *
 * `clipBeatTics.test.ts` covers the arithmetic; this file covers the four
 * things only the component can be wrong about:
 *   - the tics go on a SEPARATE, unstretched overlay — not into the clip's
 *     4096-px-capped waveform raster, and not into its cached bitmap;
 *   - the band is somewhere actually on screen;
 *   - the overlay's cost is bounded no matter how wide the clip is;
 *   - the overlay rides the clip's drag transform.
 *
 * `getBeatGrid` is mocked so the grid is exact and the positions are
 * assertable to the pixel; the selector's own behaviour (inheritance, never
 * starting an analysis) belongs to `services/beatGrid.test.ts`, and the clip
 * mapping's use of it to `clipBeatTics.test.ts`.
 */
import { act, render } from '@testing-library/react';
import ClipView from './ClipView';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { _resetClipWaveformCache } from './clipWaveformCache';
import { getBeatGrid, type BeatGrid } from '../../services/beatGrid';
import { setBeatGridVisible } from '../../services/beatGridDisplay';
import { TIC_WINDOW_QUANTUM_PX, CLIP_TIC_BAND_PX } from './clipBeatTics';
import type { Clip } from '../../multitrack/session';

jest.mock('../../services/beatGrid', () => {
  const actual = jest.requireActual('../../services/beatGrid');
  return { ...actual, getBeatGrid: jest.fn() };
});
const mockGetBeatGrid = getBeatGrid as jest.MockedFunction<typeof getBeatGrid>;

// ---------------------------------------------------------------------------
// A per-canvas recording context: jsdom has no 2d backend, and the assertions
// below have to tell the waveform canvas, its cached offscreen bitmap and the
// tic overlay apart.
// ---------------------------------------------------------------------------
interface Stroke {
  x: number;
  top: number;
  bottom: number;
  style: string;
  dash: number[];
}
interface Recorder {
  strokes: Stroke[];
  drawImage: jest.Mock;
  fillRects: number;
}

let recorders: Map<HTMLCanvasElement, Recorder>;
let getContextSpy: jest.SpyInstance;

function recorderFor(canvas: HTMLCanvasElement): Recorder {
  const existing = recorders.get(canvas);
  if (existing) return existing;
  const rec: Recorder = { strokes: [], drawImage: jest.fn(), fillRects: 0 };
  recorders.set(canvas, rec);
  return rec;
}

function makeCtx(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const rec = recorderFor(canvas);
  let pending: { x: number; y: number } | null = null;
  let end: { x: number; y: number } | null = null;
  const ctx = {
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    dash: [] as number[],
    setTransform: jest.fn(),
    clearRect: jest.fn(),
    fillRect: () => {
      rec.fillRects++;
    },
    drawImage: rec.drawImage,
    setLineDash(d: number[]) {
      ctx.dash = d;
    },
    beginPath() {
      pending = null;
      end = null;
    },
    moveTo(x: number, y: number) {
      pending = { x, y };
    },
    lineTo(x: number, y: number) {
      end = { x, y };
    },
    stroke() {
      if (!pending || !end) return;
      rec.strokes.push({
        x: pending.x,
        top: pending.y,
        bottom: end.y,
        style: String(ctx.strokeStyle),
        dash: [...ctx.dash],
      });
    },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  _resetClipWaveformCache();
  recorders = new Map();
  mockGetBeatGrid.mockReset();
  setBeatGridVisible(true);
  getContextSpy = jest
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(function (this: HTMLCanvasElement) {
      return makeCtx(this);
    });
});

afterEach(() => {
  getContextSpy.mockRestore();
  setBeatGridVisible(true);
});

const SR = 44100;

function seedDoc(lengthSamples: number, sampleRate = SR): AudioDocument {
  const channel = new Float32Array(lengthSamples);
  for (let n = 0; n < channel.length; n++) channel[n] = Math.sin((2 * Math.PI * 220 * n) / sampleRate);
  return createDocument({ name: 'clip-src.wav', sampleRate, channels: [channel] });
}

function makeClip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    documentId: 'doc-1',
    startSample: 0,
    offsetSample: 0,
    lengthSample: 44100,
    gainDb: 0,
    ...over,
  };
}

function grid(over: Partial<BeatGrid> = {}): BeatGrid {
  return {
    beatSamples: Int32Array.from([0, 22050, 44100, 66150]),
    sampleRate: SR,
    beatsPerBar: null,
    downbeatPhase: null,
    barCount: 0,
    confidence: 0.9,
    stale: false,
    analyzedEndSample: 1_000_000,
    truncated: false,
    origin: 'own',
    originDocId: 'doc-1',
    originOpen: true,
    ...over,
  };
}

function renderClip(
  doc: AudioDocument | undefined,
  clip: Clip,
  samplesPerPixel: number,
  scrollSample = 0
) {
  return render(
    <ClipView
      clip={clip}
      doc={doc}
      trackId="track-1"
      zoom={{ samplesPerPixel, scrollSample }}
      sessionRate={SR}
      laneHeight={96}
      selected={false}
      resolveTrackAt={() => null}
      onDragOverTrack={() => {}}
    />
  );
}

function overlayOf(container: HTMLElement): HTMLCanvasElement | null {
  return container.querySelector('[data-testid="clip-beat-tics"]');
}

function ticsOn(canvas: HTMLCanvasElement): Stroke[] {
  return recorders.get(canvas)?.strokes ?? [];
}

// ---------------------------------------------------------------------------
// 1. A separate, unstretched overlay (traps 14 and 15)
// ---------------------------------------------------------------------------

describe('ClipView beat tics — where they are drawn', () => {
  it('draws them on a SEPARATE overlay canvas, never into the waveform raster', () => {
    mockGetBeatGrid.mockReturnValue(grid());
    const { container } = renderClip(seedDoc(44100), makeClip(), 441);

    const canvases = Array.from(container.querySelectorAll('canvas'));
    expect(canvases).toHaveLength(2);
    const overlay = overlayOf(container)!;
    const waveform = canvases.find((c) => c !== overlay)!;

    expect(ticsOn(overlay).length).toBeGreaterThan(0);
    expect(ticsOn(waveform)).toHaveLength(0);
    // ...and the waveform canvas is still the one that gets the blit.
    expect(recorders.get(waveform)!.drawImage).toHaveBeenCalled();
  });

  it('never draws into the CACHED offscreen bitmap, whose key has no grid identity', () => {
    mockGetBeatGrid.mockReturnValue(grid());
    const { container } = renderClip(seedDoc(44100), makeClip(), 441);

    const overlay = overlayOf(container)!;
    const waveform = Array.from(container.querySelectorAll('canvas')).find((c) => c !== overlay)!;
    const cached = recorders.get(waveform)!.drawImage.mock.calls[0][0] as HTMLCanvasElement;

    expect(cached).not.toBe(overlay);
    expect(ticsOn(cached)).toHaveLength(0);
    expect(recorders.get(cached)!.fillRects).toBeGreaterThan(0); // it holds the envelope
  });

  it('leaves the cached waveform bitmap untouched across a beat-grid toggle', () => {
    mockGetBeatGrid.mockReturnValue(grid());
    const { container } = renderClip(seedDoc(44100), makeClip(), 441);
    const waveform = Array.from(container.querySelectorAll('canvas')).find(
      (c) => c !== overlayOf(container)
    )!;
    const before = recorders.get(waveform)!.drawImage.mock.calls[0][0];

    act(() => setBeatGridVisible(false));
    act(() => setBeatGridVisible(true));

    const calls = recorders.get(waveform)!.drawImage.mock.calls;
    expect(calls[calls.length - 1][0]).toBe(before); // same bitmap, not rebuilt
  });

  it('sizes the overlay backing store 1:1 with its CSS width — the raster is NOT stretched', () => {
    mockGetBeatGrid.mockReturnValue(grid());
    const { container } = renderClip(seedDoc(44100), makeClip(), 441);

    const overlay = overlayOf(container)!;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = parseFloat(overlay.style.width);
    expect(cssWidth).toBeGreaterThan(0);
    expect(overlay.width).toBe(Math.round(cssWidth * dpr));
    expect(overlay.height).toBe(Math.round(CLIP_TIC_BAND_PX * dpr));
  });

  it('puts the band on the clip element\'s BOTTOM edge, which is on screen', () => {
    // The clip's waveform canvas is `h-full` BELOW the name label inside an
    // overflow-hidden box, so the canvas's own bottom is clipped away; the band
    // is pinned to the clip element instead.
    mockGetBeatGrid.mockReturnValue(grid());
    const { container, getByTestId } = renderClip(seedDoc(44100), makeClip(), 441);
    const overlay = overlayOf(container)!;

    expect(overlay.parentElement).toBe(getByTestId('clip'));
    expect(parseFloat(overlay.style.bottom)).toBe(0);
    expect(overlay.style.height).toBe(`${CLIP_TIC_BAND_PX}px`);
    // Tics grow UP from the band's bottom, so they stay inside it.
    for (const s of ticsOn(overlay)) {
      expect(s.bottom).toBe(CLIP_TIC_BAND_PX);
      expect(s.top).toBeGreaterThanOrEqual(0);
      expect(s.top).toBeLessThan(CLIP_TIC_BAND_PX);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Positions (the mapping, seen through the component)
// ---------------------------------------------------------------------------

describe('ClipView beat tics — session-space positions', () => {
  it('places tics at the right pixels on a rate-MATCHED clip', () => {
    mockGetBeatGrid.mockReturnValue(grid());
    // 1 s clip at 441 samples/px = 100 px wide; beats every half second.
    const { container } = renderClip(seedDoc(88200), makeClip({ lengthSample: 44100 }), 441);
    expect(ticsOn(overlayOf(container)!).map((s) => s.x)).toEqual([0, 50]);
  });

  it('places tics at the SAME pixels on a rate-MISMATCHED clip (48k doc, 44.1k session)', () => {
    // The same musical grid expressed at 48 kHz: half a second is 24 000 source
    // samples, and must still land at the middle of a one-second clip. Dropping
    // the sessionRate/docRate factor puts it at x = 54.4 instead of 50.
    mockGetBeatGrid.mockReturnValue(
      grid({ beatSamples: Int32Array.from([0, 24000, 48000]), sampleRate: 48000 })
    );
    const { container } = renderClip(seedDoc(96000, 48000), makeClip({ lengthSample: 44100 }), 441);
    expect(ticsOn(overlayOf(container)!).map((s) => s.x)).toEqual([0, 50]);
  });

  it('places tics relative to the clip, not the lane, when the clip starts late', () => {
    mockGetBeatGrid.mockReturnValue(grid());
    const { container } = renderClip(
      seedDoc(88200),
      makeClip({ startSample: 22050, offsetSample: 0, lengthSample: 44100 }),
      441
    );
    // The overlay is a child of the clip, so x is measured from the clip's own
    // left edge: source beats 0 and 22050 -> clip-local 0 px and 50 px.
    expect(ticsOn(overlayOf(container)!).map((s) => s.x)).toEqual([0, 50]);
  });

  it('draws nothing outside the clip, even when the grid runs past it', () => {
    mockGetBeatGrid.mockReturnValue(
      grid({ beatSamples: Int32Array.from([0, 22050, 44100, 66150, 88200]) })
    );
    const { container } = renderClip(seedDoc(88200), makeClip({ lengthSample: 44100 }), 441);
    const overlay = overlayOf(container)!;
    const widthPx = parseFloat(overlay.style.width);
    for (const s of ticsOn(overlay)) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThanOrEqual(widthPx);
    }
    expect(ticsOn(overlay)).toHaveLength(2);
  });

  it('draws a provisional grid dashed', () => {
    mockGetBeatGrid.mockReturnValue(grid({ stale: true }));
    const { container } = renderClip(seedDoc(44100), makeClip(), 441);
    for (const s of ticsOn(overlayOf(container)!)) expect(s.dash).toEqual([2, 2]);
  });
});

// ---------------------------------------------------------------------------
// 3. The cases where nothing is drawn
// ---------------------------------------------------------------------------

describe('ClipView beat tics — nothing to draw', () => {
  it('renders no overlay at all when the source has no cached analysis', () => {
    mockGetBeatGrid.mockReturnValue(null);
    const { container } = renderClip(seedDoc(44100), makeClip(), 441);
    expect(container.querySelectorAll('canvas')).toHaveLength(1);
    expect(overlayOf(container)).toBeNull();
  });

  it('renders no overlay when the clip has outlived its source document', () => {
    mockGetBeatGrid.mockReturnValue(grid());
    const { container } = renderClip(undefined, makeClip(), 441);
    expect(overlayOf(container)).toBeNull();
    expect(container.querySelectorAll('canvas')).toHaveLength(1);
  });

  it('renders no overlay when the clip sits past the analysed prefix', () => {
    mockGetBeatGrid.mockReturnValue(grid({ analyzedEndSample: 10000 }));
    const { container } = renderClip(
      seedDoc(200000),
      makeClip({ offsetSample: 100000, lengthSample: 44100 }),
      441
    );
    expect(overlayOf(container)).toBeNull();
  });

  it('the toggle hides them, and showing it again brings them back', () => {
    mockGetBeatGrid.mockReturnValue(grid());
    const { container } = renderClip(seedDoc(44100), makeClip(), 441);
    expect(overlayOf(container)).not.toBeNull();

    act(() => setBeatGridVisible(false));
    expect(overlayOf(container)).toBeNull();

    act(() => setBeatGridVisible(true));
    expect(overlayOf(container)).not.toBeNull();
    expect(ticsOn(overlayOf(container)!).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Bounded cost (clips are never viewport-culled)
// ---------------------------------------------------------------------------

describe('ClipView beat tics — bounded cost', () => {
  it('keeps the overlay bounded by the VIEWPORT on a clip far wider than any screen', () => {
    // 20 000 beats over ~2 000 000 px of timeline. A clip-width overlay would be
    // a 2 000 000 px canvas — past the browser's max dimension, and the very
    // regression the 4096-px waveform cap fixed.
    const beats = Int32Array.from({ length: 20000 }, (_, i) => i * 4410);
    mockGetBeatGrid.mockReturnValue(
      grid({ beatSamples: beats, analyzedEndSample: 20000 * 4410 })
    );
    const { container } = renderClip(
      seedDoc(20000 * 4410),
      makeClip({ lengthSample: 20000 * 4410 }),
      44.1
    );

    const overlay = overlayOf(container)!;
    const bound = window.innerWidth + 2 * TIC_WINDOW_QUANTUM_PX;
    expect(parseFloat(overlay.style.width)).toBeLessThanOrEqual(bound);
    expect(overlay.width).toBeLessThanOrEqual(Math.round(bound * (window.devicePixelRatio || 1)));
    // And the tic count is bounded by the band, not by the clip's beat count.
    expect(ticsOn(overlay).length).toBeLessThanOrEqual(bound);
    expect(ticsOn(overlay).length).toBeGreaterThan(0);
  });

  it('draws no overlay for a clip scrolled entirely off the right of the lane', () => {
    mockGetBeatGrid.mockReturnValue(grid());
    // startSample puts the clip 100 000 px right of the lane origin.
    const { container } = renderClip(
      seedDoc(88200),
      makeClip({ startSample: 44_100_000, lengthSample: 44100 }),
      441
    );
    expect(overlayOf(container)).toBeNull();
  });

  it('follows the scroll: a clip scrolled off to the LEFT shows its visible part', () => {
    const beats = Int32Array.from({ length: 2000 }, (_, i) => i * 4410);
    mockGetBeatGrid.mockReturnValue(grid({ beatSamples: beats, analyzedEndSample: 2000 * 4410 }));
    const { container } = renderClip(
      seedDoc(2000 * 4410),
      makeClip({ lengthSample: 2000 * 4410 }),
      441,
      2000 * 4410 / 2 // scrolled to the clip's midpoint
    );
    const overlay = overlayOf(container)!;
    expect(parseFloat(overlay.style.left)).toBeGreaterThan(0);
    expect(ticsOn(overlay).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. The drag
// ---------------------------------------------------------------------------

describe('ClipView beat tics — during a move drag', () => {
  function firePointer(el: Element, type: string, clientX: number): void {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 0 });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    act(() => {
      el.dispatchEvent(event);
    });
  }

  it('rides the clip\'s CSS transform, so the tics move WITH the audio', () => {
    mockGetBeatGrid.mockReturnValue(grid());
    const { container, getByTestId } = renderClip(seedDoc(44100), makeClip(), 441);
    const clipEl = getByTestId('clip');
    const overlay = overlayOf(container)!;

    // The overlay is INSIDE the element that carries the move transform, so a
    // drag translates the tics and the waveform together; an overlay on the
    // lane would leave the tics behind until the drop.
    expect(clipEl.contains(overlay)).toBe(true);

    firePointer(clipEl, 'pointerdown', 10);
    firePointer(clipEl, 'pointermove', 90);

    expect(clipEl.style.transform).toBe('translateX(80px)');
    expect(overlayOf(container)).toBe(overlay); // not re-created mid-drag
    expect(clipEl.contains(overlay)).toBe(true);
  });
});
