import { renderWaveform, pixelToSample, sampleToPixel, type RenderOpts } from './waveformRender';
import { buildPeaks } from '../../audio/peaks';

interface Call {
  method: string;
  args: number[];
  fillStyle?: string;
  strokeStyle?: string;
  text?: string;
  shadowBlur?: number;
  shadowColor?: string;
}

/** Minimal CanvasRenderingContext2D stub that records the drawing calls
 * renderWaveform makes, tagging each with the style active at call time. */
class StubCtx {
  calls: Call[] = [];
  fillStyle = '';
  strokeStyle = '';
  font = '';
  lineWidth = 1;
  shadowBlur = 0;
  shadowColor = '';
  private dash: number[] = [];

  fillRect(...args: number[]) {
    this.calls.push({ method: 'fillRect', args, fillStyle: String(this.fillStyle) });
  }
  strokeRect(...args: number[]) {
    this.calls.push({ method: 'strokeRect', args, strokeStyle: String(this.strokeStyle) });
  }
  beginPath() {
    this.calls.push({ method: 'beginPath', args: [] });
  }
  moveTo(...args: number[]) {
    this.calls.push({
      method: 'moveTo',
      args,
      strokeStyle: String(this.strokeStyle),
      fillStyle: String(this.fillStyle),
    });
  }
  lineTo(...args: number[]) {
    this.calls.push({ method: 'lineTo', args, strokeStyle: String(this.strokeStyle) });
  }
  stroke() {
    this.calls.push({
      method: 'stroke',
      args: [],
      strokeStyle: String(this.strokeStyle),
      shadowBlur: this.shadowBlur,
      shadowColor: String(this.shadowColor),
    });
  }
  fill() {
    this.calls.push({ method: 'fill', args: [] });
  }
  clearRect(...args: number[]) {
    this.calls.push({ method: 'clearRect', args });
  }
  closePath() {
    this.calls.push({ method: 'closePath', args: [] });
  }
  setLineDash(d: number[]) {
    this.dash = d;
  }
  fillText(text: string, x: number, y: number) {
    this.calls.push({ method: 'fillText', args: [x, y], text, fillStyle: String(this.fillStyle) });
  }
}

function makeCtx(): { ctx: CanvasRenderingContext2D; stub: StubCtx } {
  const stub = new StubCtx();
  return { ctx: stub as unknown as CanvasRenderingContext2D, stub };
}

function constantChannel(n: number, value: number): Float32Array {
  const ch = new Float32Array(n);
  ch.fill(value);
  return ch;
}

const BODY = 'rgba(38,198,218,0.7)';

describe('pixelToSample / sampleToPixel', () => {
  it('round-trips a pixel through sample space', () => {
    const scroll = 1000;
    const spp = 8;
    for (const x of [0, 10, 100.5, 640]) {
      expect(sampleToPixel(pixelToSample(x, scroll, spp), scroll, spp)).toBeCloseTo(x);
    }
  });

  it('maps sample 0 relative to scroll', () => {
    expect(sampleToPixel(1000, 1000, 8)).toBe(0);
    expect(pixelToSample(0, 1000, 8)).toBe(1000);
  });
});

describe('renderWaveform bucket mode', () => {
  it('draws constant +0.5 bars within each channel lane, above lane center', () => {
    const width = 100;
    const height = 200;
    const ch = constantChannel(width * 10, 0.5); // spp = 10 -> bucket mode
    const py = buildPeaks(ch);
    const { ctx, stub } = makeCtx();
    const opts: RenderOpts = {
      width,
      height,
      channels: [ch, ch],
      pyramids: [py, py],
      scrollSample: 0,
      samplesPerPixel: 10,
      selection: null,
      cursorSample: 0,
      playheadSample: null,
    };
    renderWaveform(ctx, opts);

    const body = stub.calls.filter((c) => c.method === 'fillRect' && c.fillStyle === BODY);
    // one body bar per pixel column per lane
    expect(body.length).toBe(width * 2);

    const laneH = height / 2; // 100
    const lane0 = body.filter((c) => c.args[1] < laneH);
    const lane1 = body.filter((c) => c.args[1] >= laneH);
    expect(lane0.length).toBe(width);
    expect(lane1.length).toBe(width);

    // +0.5 is a positive signal: the bar top must sit above each lane's center axis.
    for (const c of lane0) expect(c.args[1]).toBeLessThan(laneH / 2); // < 50
    for (const c of lane1) expect(c.args[1]).toBeLessThan(laneH + laneH / 2); // < 150
  });

  it('draws the translucent selection overlay at the selection x-range', () => {
    const width = 100;
    const height = 100;
    const ch = constantChannel(1000, 0); // spp = 10
    const py = buildPeaks(ch);
    const { ctx, stub } = makeCtx();
    renderWaveform(ctx, {
      width,
      height,
      channels: [ch],
      pyramids: [py],
      scrollSample: 0,
      samplesPerPixel: 10,
      selection: { start: 200, end: 500 }, // x: 20 .. 50
      cursorSample: 0,
      playheadSample: null,
    });

    // G6 (styling assertion updated per ruling 4): the selection fill is the
    // --accent-soft token (was the ad-hoc '#26c6da22') and its edges are the
    // --accent-ring token (was solid '#26c6da').
    const overlay = stub.calls.find(
      (c) => c.method === 'fillRect' && c.fillStyle === 'rgba(38,198,218,0.14)'
    );
    expect(overlay).toBeDefined();
    expect(overlay!.args[0]).toBeCloseTo(20); // left edge
    expect(overlay!.args[2]).toBeCloseTo(30); // width = (500-200)/10

    const edges = stub.calls.filter(
      (c) => c.method === 'moveTo' && c.strokeStyle === 'rgba(38,198,218,0.35)'
    );
    expect(edges.some((c) => Math.abs(c.args[0] - 20) < 1e-6)).toBe(true);
    expect(edges.some((c) => Math.abs(c.args[0] - 50) < 1e-6)).toBe(true);
  });

  it('draws a white cursor line and an accent playhead line when in view', () => {
    const width = 100;
    const height = 100;
    const ch = constantChannel(1000, 0);
    const py = buildPeaks(ch);
    const { ctx, stub } = makeCtx();
    renderWaveform(ctx, {
      width,
      height,
      channels: [ch],
      pyramids: [py],
      scrollSample: 0,
      samplesPerPixel: 10,
      selection: null,
      cursorSample: 300, // x = 30
      playheadSample: 600, // x = 60
    });

    // G6 (styling assertion updated per ruling 4): the playhead is the
    // --accent token (was the yellow '#ffd54f').
    const cursor = stub.calls.filter((c) => c.method === 'moveTo' && c.strokeStyle === '#ffffff');
    const playhead = stub.calls.filter((c) => c.method === 'moveTo' && c.strokeStyle === '#26c6da');
    expect(cursor.some((c) => Math.abs(c.args[0] - 30) < 1e-6)).toBe(true);
    expect(playhead.some((c) => Math.abs(c.args[0] - 60) < 1e-6)).toBe(true);
  });

  it('strokes the playhead with a soft accent glow and resets the shadow afterwards (G6)', () => {
    const width = 100;
    const height = 100;
    const ch = constantChannel(1000, 0);
    const py = buildPeaks(ch);
    const { ctx, stub } = makeCtx();
    renderWaveform(ctx, {
      width,
      height,
      channels: [ch],
      pyramids: [py],
      scrollSample: 0,
      samplesPerPixel: 10,
      selection: null,
      cursorSample: 300,
      playheadSample: 600,
    });

    const playheadStroke = stub.calls.find(
      (c) => c.method === 'stroke' && c.strokeStyle === '#26c6da' && (c.shadowBlur ?? 0) > 0
    );
    expect(playheadStroke).toBeDefined();
    expect(playheadStroke!.shadowColor).toBe('rgba(38,198,218,0.35)');
    // The glow must not leak onto later draws (markers etc.).
    expect(stub.shadowBlur).toBe(0);

    // No other stroke carries the glow (the cursor stays a plain white line).
    const glowing = stub.calls.filter((c) => c.method === 'stroke' && (c.shadowBlur ?? 0) > 0);
    expect(glowing).toHaveLength(1);
  });
});

describe('renderWaveform per-sample mode', () => {
  it('draws a cyan polyline through sample points when samplesPerPixel < 1', () => {
    const ch = Float32Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5));
    const py = buildPeaks(ch);
    const { ctx, stub } = makeCtx();
    renderWaveform(ctx, {
      width: 80,
      height: 100,
      channels: [ch],
      pyramids: [py],
      scrollSample: 0,
      samplesPerPixel: 0.5, // < 1 -> per-sample mode
      selection: null,
      cursorSample: 0,
      playheadSample: null,
    });
    const line = stub.calls.filter((c) => c.method === 'lineTo' && c.strokeStyle === '#26c6da');
    expect(line.length).toBeGreaterThan(0);
  });
});

const MARKER_COLOR = '#ff8a65';

describe('renderWaveform markers (Task 23)', () => {
  function baseOpts(width: number, height: number): RenderOpts {
    const ch = constantChannel(1000, 0); // spp = 10
    const py = buildPeaks(ch);
    return {
      width,
      height,
      channels: [ch],
      pyramids: [py],
      scrollSample: 0,
      samplesPerPixel: 10,
      selection: null,
      cursorSample: 0,
      playheadSample: null,
    };
  }

  it('draws nothing marker-related when markers is omitted or empty', () => {
    const { ctx, stub } = makeCtx();
    renderWaveform(ctx, baseOpts(100, 100));
    expect(stub.calls.some((c) => c.strokeStyle === MARKER_COLOR)).toBe(false);
    expect(stub.calls.some((c) => c.fillStyle === MARKER_COLOR)).toBe(false);
  });

  it('draws a dashed vertical line at each marker position in the marker color', () => {
    const { ctx, stub } = makeCtx();
    renderWaveform(ctx, { ...baseOpts(100, 100), markers: [{ positionSample: 300 }] }); // x = 30

    const dashedMoveTo = stub.calls.filter((c) => c.method === 'moveTo' && c.strokeStyle === MARKER_COLOR);
    expect(dashedMoveTo.some((c) => Math.abs(c.args[0] - 30) < 1e-6)).toBe(true);
  });

  it('draws a filled triangle flag at each marker position', () => {
    const { ctx, stub } = makeCtx();
    renderWaveform(ctx, { ...baseOpts(100, 100), markers: [{ positionSample: 300 }] }); // x = 30

    const fills = stub.calls.filter((c) => c.method === 'fill');
    expect(fills.length).toBeGreaterThan(0);
    // The triangle's path starts at the marker x, at the top of the canvas.
    const triangleStart = stub.calls.find(
      (c) => c.method === 'moveTo' && c.fillStyle === MARKER_COLOR && Math.abs(c.args[0] - 30) < 1e-6 && c.args[1] === 0
    );
    expect(triangleStart).toBeDefined();
  });

  it('labels a marker with its name near the flag when zoom permits', () => {
    const { ctx, stub } = makeCtx();
    renderWaveform(ctx, {
      ...baseOpts(200, 100),
      markers: [{ positionSample: 300, name: 'Verse' }], // x = 30
    });
    const label = stub.calls.find((c) => c.method === 'fillText' && c.text === 'Verse');
    expect(label).toBeDefined();
    expect(label!.args[0]).toBeGreaterThan(30); // drawn to the right of the flag
  });

  it('skips a label that would land within 40px of the previously drawn label (overlap avoidance)', () => {
    const { ctx, stub } = makeCtx();
    renderWaveform(ctx, {
      ...baseOpts(200, 100),
      markers: [
        { positionSample: 300, name: 'A' }, // x = 30
        { positionSample: 350, name: 'B' }, // x = 35 -> within 40px of A, should be skipped
        { positionSample: 900, name: 'C' }, // x = 90 -> far enough, should be drawn
      ],
    });
    const labels = stub.calls.filter((c) => c.method === 'fillText').map((c) => c.text);
    expect(labels).toEqual(['A', 'C']);
  });

  it('does not draw a label when the marker has no name', () => {
    const { ctx, stub } = makeCtx();
    renderWaveform(ctx, { ...baseOpts(100, 100), markers: [{ positionSample: 300 }] });
    expect(stub.calls.some((c) => c.method === 'fillText')).toBe(false);
  });
});
