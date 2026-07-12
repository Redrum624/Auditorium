import { renderWaveform, pixelToSample, sampleToPixel, type RenderOpts } from './waveformRender';
import { buildPeaks } from '../../audio/peaks';

interface Call {
  method: string;
  args: number[];
  fillStyle?: string;
  strokeStyle?: string;
}

/** Minimal CanvasRenderingContext2D stub that records the drawing calls
 * renderWaveform makes, tagging each with the style active at call time. */
class StubCtx {
  calls: Call[] = [];
  fillStyle = '';
  strokeStyle = '';
  font = '';
  lineWidth = 1;
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
    this.calls.push({ method: 'moveTo', args, strokeStyle: String(this.strokeStyle) });
  }
  lineTo(...args: number[]) {
    this.calls.push({ method: 'lineTo', args, strokeStyle: String(this.strokeStyle) });
  }
  stroke() {
    this.calls.push({ method: 'stroke', args: [], strokeStyle: String(this.strokeStyle) });
  }
  fill() {
    this.calls.push({ method: 'fill', args: [] });
  }
  clearRect(...args: number[]) {
    this.calls.push({ method: 'clearRect', args });
  }
  setLineDash(d: number[]) {
    this.dash = d;
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

    const overlay = stub.calls.find((c) => c.method === 'fillRect' && c.fillStyle === '#26c6da22');
    expect(overlay).toBeDefined();
    expect(overlay!.args[0]).toBeCloseTo(20); // left edge
    expect(overlay!.args[2]).toBeCloseTo(30); // width = (500-200)/10
  });

  it('draws a white cursor line and a yellow playhead line when in view', () => {
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

    const cursor = stub.calls.filter((c) => c.method === 'moveTo' && c.strokeStyle === '#ffffff');
    const playhead = stub.calls.filter((c) => c.method === 'moveTo' && c.strokeStyle === '#ffd54f');
    expect(cursor.some((c) => Math.abs(c.args[0] - 30) < 1e-6)).toBe(true);
    expect(playhead.some((c) => Math.abs(c.args[0] - 60) < 1e-6)).toBe(true);
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
