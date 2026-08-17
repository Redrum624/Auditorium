/**
 * MT2-5 — the three things about a clip's waveform that nothing asserted.
 *
 * MT1-2 gave the clip the editor's own `drawWaveformLane`, and
 * `ClipView.beatTics.test.tsx` pins that the waveform lands on its own canvas
 * and that the tics do not. What no test read was WHAT the waveform draws:
 * a mutation to the y mapping's sign or scale, to the `offsetSample` the window
 * starts at, or to the doc-rate/session-rate ratio the window advances by, all
 * survived the suite. Each of the three is a picture that is silently of the
 * wrong audio — the class of defect a screenshot would catch and a green suite
 * would not.
 *
 * Every fixture here is asymmetric on purpose (`+0.9` against `-0.3`, a burst
 * against silence): a symmetric one cannot tell a sign flip from the truth.
 */
import { render } from '@testing-library/react';
import ClipView from './ClipView';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { getBeatGrid } from '../../services/beatGrid';
import type { Clip } from '../../multitrack/session';

jest.mock('../../services/beatGrid', () => {
  const actual = jest.requireActual('../../services/beatGrid');
  return { ...actual, getBeatGrid: jest.fn(() => null) };
});
const mockGetBeatGrid = getBeatGrid as jest.MockedFunction<typeof getBeatGrid>;

// ---------------------------------------------------------------------------
// A recording 2d context that keeps the FILLS, which is where a waveform is.
// ---------------------------------------------------------------------------
interface Fill {
  x: number;
  y: number;
  w: number;
  h: number;
  style: string;
}
interface Recorder {
  fills: Fill[];
  strokes: { y0: number; y1: number; style: string }[];
}

let recorders: Map<HTMLCanvasElement, Recorder>;
let getContextSpy: jest.SpyInstance;

function makeCtx(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const rec: Recorder = { fills: [], strokes: [] };
  recorders.set(canvas, rec);
  let from: { x: number; y: number } | null = null;
  let to: { x: number; y: number } | null = null;
  const ctx = {
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    setTransform: jest.fn(),
    clearRect: jest.fn(),
    setLineDash: jest.fn(),
    drawImage: jest.fn(),
    fillRect(x: number, y: number, w: number, h: number) {
      rec.fills.push({ x, y, w, h, style: String(ctx.fillStyle) });
    },
    beginPath() {
      from = null;
      to = null;
    },
    moveTo(x: number, y: number) {
      from = { x, y };
    },
    lineTo(x: number, y: number) {
      to = { x, y };
    },
    stroke() {
      if (from && to) rec.strokes.push({ y0: from.y, y1: to.y, style: String(ctx.strokeStyle) });
    },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  recorders = new Map();
  mockGetBeatGrid.mockReturnValue(null);
  getContextSpy = jest
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(function (this: HTMLCanvasElement) {
      return makeCtx(this);
    });
});

afterEach(() => getContextSpy.mockRestore());

// --- the geometry the component and the render module agree on --------------
const SR = 44_100;
const LANE_H = 96;
/** `ClipView`: `canvasH = laneHeight - 22`. */
const CANVAS_H = LANE_H - 22;
const CENTER = CANVAS_H / 2;
/** `waveformRender`: `amp = (laneH / 2) * VSCALE`, VSCALE = 0.9. */
const AMP = (CANVAS_H / 2) * 0.9;
const BODY = 'rgba(38,198,218,0.7)';
const ACCENT = '#26c6da';
const AXIS = 'rgba(255,255,255,0.12)';

/** The peak of the asymmetric fixture, and its trough. Asymmetric so a sign
 * flip is a different number rather than the same one mirrored. */
const PEAK = 0.9;
const TROUGH = -0.3;
/** The peaks arrive as `Float32Array` entries, so the expected y is computed
 * from the float32 round-trip of each constant rather than from the literal —
 * a 1e-7 slack would otherwise have to be spent on the storage format instead
 * of on the arithmetic under test. */
const PEAK32 = new Float32Array([PEAK])[0];
const TROUGH32 = new Float32Array([TROUGH])[0];

function makeClip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    documentId: 'doc-1',
    startSample: 0,
    offsetSample: 0,
    lengthSample: 200_000,
    gainDb: 0,
    ...over,
  };
}

function renderClip(doc: AudioDocument, clip: Clip, samplesPerPixel: number, sessionRate = SR) {
  return render(
    <ClipView
      clip={clip}
      doc={doc}
      trackId="track-1"
      zoom={{ samplesPerPixel, scrollSample: 0 }}
      sessionRate={sessionRate}
      laneHeight={LANE_H}
      selected={false}
      resolveTrackAt={() => null}
      onDragOverTrack={() => {}}
    />
  );
}

function waveformCanvas(container: HTMLElement): HTMLCanvasElement {
  const canvases = Array.from(container.querySelectorAll('canvas'));
  const wave = canvases.find((c) => c.dataset.testid !== 'clip-beat-tics');
  if (!wave) throw new Error('no waveform canvas rendered');
  return wave;
}

function envelopeFills(container: HTMLElement): Fill[] {
  return (recorders.get(waveformCanvas(container))?.fills ?? []).filter((f) => f.style === BODY);
}

function traceFills(container: HTMLElement): Fill[] {
  return (recorders.get(waveformCanvas(container))?.fills ?? []).filter((f) => f.style === ACCENT);
}

/** Column indices whose envelope is not the flat 1 px stub a silent bucket
 * draws — i.e. where the audio actually is. */
function loudColumns(container: HTMLElement): number[] {
  return envelopeFills(container)
    .filter((f) => f.h > 1)
    .map((f) => f.x);
}

/** `docLength` samples of `[PEAK, TROUGH, PEAK, TROUGH, …]` — every bucket
 * spanning two or more samples therefore has exactly min=TROUGH, max=PEAK. */
function toneAt(target: Float32Array, from: number, count: number): void {
  for (let i = 0; i < count; i++) target[from + i] = i % 2 === 0 ? PEAK : TROUGH;
}

function docOf(channel: Float32Array, sampleRate = SR): AudioDocument {
  return createDocument({ name: 'clip-src.wav', sampleRate, channels: [channel] });
}

// ---------------------------------------------------------------------------
// 1. The y mapping — `center - v · amp`
// ---------------------------------------------------------------------------
describe('the waveform maps a sample value to a y the same way the editor does', () => {
  it('puts the peak ABOVE the centre and the trough below it, scaled by VSCALE', () => {
    const channel = new Float32Array(300_000);
    toneAt(channel, 0, channel.length);
    const { container } = renderClip(docOf(channel), makeClip(), 100);

    const body = envelopeFills(container);
    expect(body.length).toBeGreaterThan(100);
    for (const f of body) {
      // `yTop = center - max·amp`, `height = (center - min·amp) - yTop`.
      // A sign flip puts y at `center + 0.3·amp` (below the centre) and
      // collapses the height to the 1 px minimum; a changed VSCALE moves both.
      expect(f.y).toBeCloseTo(CENTER - PEAK32 * AMP, 6);
      expect(f.h).toBeCloseTo((PEAK32 - TROUGH32) * AMP, 6);
      expect(f.w).toBe(1);
    }
    // The peak is genuinely above the centre line and the trough below it —
    // stated as an inequality too, so a mutation that keeps the arithmetic but
    // swaps the roles of min and max is caught by more than a float compare.
    expect(body[0].y).toBeLessThan(CENTER);
    expect(body[0].y + body[0].h).toBeGreaterThan(CENTER);
  });

  it('draws the centre trace at the column MIDPOINT, on the same scale', () => {
    const channel = new Float32Array(300_000);
    toneAt(channel, 0, channel.length);
    const { container } = renderClip(docOf(channel), makeClip(), 100);

    const trace = traceFills(container);
    expect(trace.length).toBeGreaterThan(100);
    const mid = (PEAK32 + TROUGH32) / 2; // 0.3 — a THIRD value on the same mapping
    for (const f of trace) {
      expect(f.y).toBeCloseTo(CENTER - mid * AMP, 6);
      expect(f.h).toBe(1);
    }
  });

  it('rules the zero axis exactly at the lane centre', () => {
    const channel = new Float32Array(300_000);
    toneAt(channel, 0, channel.length);
    const { container } = renderClip(docOf(channel), makeClip(), 100);

    const axis = (recorders.get(waveformCanvas(container))?.strokes ?? []).filter(
      (s) => s.style === AXIS
    );
    expect(axis).toHaveLength(1);
    expect(axis[0].y0).toBe(CENTER);
    expect(axis[0].y1).toBe(CENTER);
  });
});

// ---------------------------------------------------------------------------
// 2. `offsetSample` — the window starts where the clip starts in the SOURCE
// ---------------------------------------------------------------------------
describe('the drawn window starts at the clip offset, not at the document start', () => {
  it('draws the audio at the offset, not the audio at sample 0', () => {
    // Silence everywhere except one column's worth of tone at sample 50 000,
    // which is exactly where the clip's offset points. Drop the offset from
    // `scrollSample` and the burst moves to column 500 (50 000 / 100 spp) — and
    // column 0 goes silent, which is the other half of the assertion.
    const OFFSET = 50_000;
    const SPP = 100;
    const channel = new Float32Array(300_000);
    toneAt(channel, OFFSET, SPP);

    const { container } = renderClip(docOf(channel), makeClip({ offsetSample: OFFSET }), SPP);

    expect(loudColumns(container)).toEqual([0]);
  });

  it('an offset past the audio draws silence rather than the audio behind it', () => {
    const channel = new Float32Array(300_000);
    toneAt(channel, 0, 20_000);

    const { container } = renderClip(docOf(channel), makeClip({ offsetSample: 200_000 }), 100);

    expect(loudColumns(container)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. `docSpp` — a 48 kHz document in a 44.1 kHz session
// ---------------------------------------------------------------------------
describe('a clip whose document rate differs from the session rate', () => {
  it('advances the window by docRate/sessionRate source samples per pixel', () => {
    // After MT2-1 an empty session adopts, so this state is only reachable in a
    // genuinely mixed-rate session — constructed explicitly here so the fix
    // cannot make the test vacuous.
    const DOC_RATE = 48_000;
    const SPP = 100;
    // docSpp = 100 · 48000/44100 = 108.8435…; bucket 100 spans source samples
    // [10884, 10993). The burst is placed to fill exactly that bucket.
    const BURST_AT = 10_884;
    const BURST_LEN = 109;
    const channel = new Float32Array(300_000);
    toneAt(channel, BURST_AT, BURST_LEN);

    const { container } = renderClip(docOf(channel, DOC_RATE), makeClip(), SPP);

    // Drop the ratio (docSpp = 100) and the burst lands at columns 108–109;
    // INVERT it (docSpp = 91.875) and it lands at 118–119. Only the correct
    // ratio puts it at 100.
    expect(loudColumns(container)).toEqual([100]);
  });

  it('is the identity when the rates agree — the same burst, a different column', () => {
    // The control: the SAME fixture in a session at the document's own rate.
    // docSpp = 100, so the burst is at columns 108–109. A "ratio" that were
    // secretly applied in both cases would show up as the same column twice.
    const SPP = 100;
    const channel = new Float32Array(300_000);
    toneAt(channel, 10_884, 109);

    const { container } = renderClip(docOf(channel, SR), makeClip(), SPP);

    expect(loudColumns(container)).toEqual([108, 109]);
  });
});
