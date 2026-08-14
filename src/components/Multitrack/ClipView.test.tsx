import { render } from '@testing-library/react';
import ClipView from './ClipView';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { laneWidthBound, TIC_WINDOW_QUANTUM_PX } from './clipBeatTics';
import type { Clip } from '../../multitrack/session';

// jsdom has no 2d backend (getContext returns null, which makes ClipView's
// draw effect bail before sizing the canvas), so install a minimal recording
// stub. ONE shared object serves every canvas in the tree -- fine here, since
// the assertions below are about the on-screen waveform canvas's geometry and
// the drawing calls that land on it.
//
// MT1-2: the stub grew `beginPath`/`moveTo`/`lineTo`/`stroke` + `strokeStyle`/
// `lineWidth`, because the clip now draws through the editor's own
// `drawWaveformLane`, which puts a zero-axis line under the envelope. A stub
// missing any method the draw path uses THROWS (see waveformRender.ts's note),
// so this list has to track that function's needs, not the clip's old
// fill-only loop.
interface RecordedFill {
  args: number[];
  fillStyle: string;
}
interface RecordedStroke {
  from: [number, number];
  to: [number, number];
  strokeStyle: string;
}
let drawImage: jest.Mock;
let fills: RecordedFill[];
let strokes: RecordedStroke[];
let getContextSpy: jest.SpyInstance;

beforeEach(() => {
  drawImage = jest.fn();
  fills = [];
  strokes = [];
  let pending: [number, number] = [0, 0];
  let end: [number, number] = [0, 0];
  const fakeCtx = {
    setTransform: jest.fn(),
    clearRect: jest.fn(),
    fillRect: (...args: number[]) => {
      fills.push({ args, fillStyle: String(fakeCtx.fillStyle) });
    },
    drawImage,
    beginPath: () => {},
    moveTo: (x: number, y: number) => {
      pending = [x, y];
    },
    lineTo: (x: number, y: number) => {
      end = [x, y];
    },
    stroke: () => {
      strokes.push({ from: pending, to: end, strokeStyle: String(fakeCtx.strokeStyle) });
    },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
  };
  getContextSpy = jest
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(() => fakeCtx as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  getContextSpy.mockRestore();
});

function seedDoc(lengthSamples: number): AudioDocument {
  const channel = new Float32Array(lengthSamples);
  for (let n = 0; n < channel.length; n++) channel[n] = Math.sin((2 * Math.PI * 220 * n) / 44100);
  return createDocument({ name: 'clip-src.wav', sampleRate: 44100, channels: [channel] });
}

function makeClip(lengthSample: number): Clip {
  return { id: 'clip-1', documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample, gainDb: 0 };
}

function renderClip(
  doc: AudioDocument,
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
      sessionRate={44100}
      laneHeight={64}
      selected={false}
      resolveTrackAt={() => null}
      onDragOverTrack={() => {}}
    />
  );
}

function waveformOf(container: HTMLElement): HTMLCanvasElement {
  return container.querySelector('[data-testid="clip-waveform"]') as HTMLCanvasElement;
}

/** The editor's own two bucket-mode passes (waveformRender.ts): a translucent
 * body at --accent @ 70 %, then a 1 px centre trace at --accent itself. In
 * jsdom no stylesheet defines the token, so `cssToken` returns its fallback. */
const BODY = 'rgba(38,198,218,0.7)';
const CENTER = '#26c6da';
const AXIS = 'rgba(255,255,255,0.12)';

describe('ClipView waveform is rasterised at VISIBLE resolution (MT1-2)', () => {
  // Until MT1-2 the clip rasterised its whole timeline width, capped that
  // raster at 4096 device px, and blit-STRETCHED it across the clip's CSS
  // width. On a clip far wider than the screen the visible slice was therefore
  // drawn from a small fraction of those 4096 columns and magnified -- the
  // "coarse blob" the user reported. The raster now covers only the on-screen
  // band, at one column per CSS pixel, which is both sharper AND less memory
  // than the cap it replaces (so the cap is gone, not merely raised).
  it('sizes the raster to the on-screen band, 1:1, for a clip far wider than any viewport', () => {
    const doc = seedDoc(20000);
    // samplesPerPixel=1 -> the clip spans 20 000 timeline pixels.
    const { container } = renderClip(doc, makeClip(20000), 1);

    const canvas = waveformOf(container);
    // V1: the bound is the widest a LANE can be — the window less the header
    // column — rounded out to a whole number of quanta so `ticWindow`'s two
    // edges step together. In jsdom that is 1024 - 224 = 800, rounded out to
    // 1024, and a clip starting at the lane origin gets exactly that.
    const band = laneWidthBound(window.innerWidth);
    expect(band).toBe(1024);
    expect(canvas.style.width).toBe(`${band}px`);
    expect(canvas.width).toBe(band); // dpr 1 -> one backing-store column per CSS px
    expect(canvas.height).toBe(42); // laneHeight - 22, dpr 1 -- unchanged
    expect(canvas.style.height).toBe('42px'); // ...and 1:1 vertically too

    // Nothing is blit-scaled any more: there is no offscreen bitmap at all.
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('bounds the raster by the LANE, not by the clip, however wide the clip is', () => {
    const doc = seedDoc(20000);
    const { container } = renderClip(doc, makeClip(20000), 0.5); // 40 000 px wide
    const canvas = waveformOf(container);
    // V1: the lane bound, not the raw window width — equal on a window that is
    // a whole number of quanta (jsdom's 1024), tighter on one that is not.
    const bound = laneWidthBound(window.innerWidth) + 2 * TIC_WINDOW_QUANTUM_PX;
    expect(parseFloat(canvas.style.width)).toBeLessThanOrEqual(bound);
    expect(canvas.width).toBeLessThanOrEqual(Math.round(bound * (window.devicePixelRatio || 1)));
  });

  it('draws the editor\'s two passes -- one envelope column per CSS px, plus the centre trace', () => {
    const doc = seedDoc(20000);
    const { container } = renderClip(doc, makeClip(20000), 1);
    const cols = waveformOf(container).width;

    const body = fills.filter((f) => f.fillStyle === BODY);
    const center = fills.filter((f) => f.fillStyle === CENTER);
    expect(body).toHaveLength(cols);
    expect(center).toHaveLength(cols);
    // The centre trace is the editor's 1 px midpoint bar, not a second envelope.
    for (const c of center) expect(c.args[3]).toBe(1);
    // Every column is one CSS pixel wide and inside the band.
    for (const b of body) {
      expect(b.args[2]).toBe(1);
      expect(b.args[0]).toBeGreaterThanOrEqual(0);
      expect(b.args[0]).toBeLessThan(cols);
    }
  });

  it('draws the same zero-axis line the editor does, at the lane centre', () => {
    const doc = seedDoc(20000);
    const { container } = renderClip(doc, makeClip(20000), 1);
    const canvas = waveformOf(container);

    const axis = strokes.filter((s) => s.strokeStyle === AXIS);
    expect(axis).toHaveLength(1);
    expect(axis[0].from).toEqual([0, 21]); // canvasH / 2
    expect(axis[0].to).toEqual([parseFloat(canvas.style.width), 21]);
  });

  it('follows the scroll: the band tracks the visible slice of the clip', () => {
    const doc = seedDoc(20000);
    // Scrolled 5 000 px into a 20 000 px clip. The band starts at 4864 (5000
    // floored to the quantum) and ends at 6144 (5000 + the 1024 px lane bound,
    // ceiled) — 1280 px wide. The bound is a whole number of quanta, so the
    // width here is the SAME 1280 the unscrolled clip would get one quantum
    // further right: that invariance IS the edge lockstep the band relies on.
    const { container } = renderClip(doc, makeClip(20000), 1, 5000);

    const canvas = waveformOf(container);
    expect(canvas.style.left).toBe('4864px');
    expect(canvas.width).toBe(1280);
    // Positioned inside the clip element, so it rides the move-drag transform.
    expect(canvas.style.bottom).toBe('0px');
  });

  it('leaves clips narrower than the viewport at their exact pixel width', () => {
    const doc = seedDoc(4410);
    // samplesPerPixel=44.1 -> 100 timeline pixels.
    const { container } = renderClip(doc, makeClip(4410), 44.1);

    const canvas = waveformOf(container);
    expect(canvas.width).toBe(100);
    expect(canvas.style.left).toBe('0px');
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('switches to the editor\'s per-sample polyline when a pixel spans < 1 sample', () => {
    const doc = seedDoc(4410);
    // 0.5 samples/px: 8820 px wide, and every column is a drawn SAMPLE, not a
    // bucket -- exactly the mode switch renderWaveform makes at the same point.
    const { container } = renderClip(doc, makeClip(4410), 0.5);
    expect(waveformOf(container)).toBeTruthy();

    expect(fills.filter((f) => f.fillStyle === BODY)).toHaveLength(0);
    const poly = strokes.filter((s) => s.strokeStyle === CENTER);
    expect(poly).toHaveLength(1); // one polyline stroke
    // ...and the 3x3 dots, drawn below 1/8 sample per px, are NOT drawn here.
    expect(fills.filter((f) => f.args[2] === 3)).toHaveLength(0);
  });
});

describe('ClipView G6 glass chrome', () => {
  it('draws the clip container with token-driven accent chrome (idle = ring border)', () => {
    const doc = seedDoc(4410);
    const { getByTestId } = renderClip(doc, makeClip(4410), 44.1);
    const clip = getByTestId('clip');
    expect(clip.style.backgroundColor).toBe('var(--accent-soft)');
    expect(clip.style.borderColor).toBe('var(--accent-ring)');
  });
});
