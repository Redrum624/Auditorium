import {
  renderWaveform,
  pixelToSample,
  sampleToPixel,
  drawBeatTics,
  drawCursorHandle,
  drawEditorBeatTics,
  drawMarkers,
  CURSOR_HANDLE_H,
  CURSOR_HANDLE_HALF_W,
  type BeatTicOpts,
  type RenderOpts,
} from './waveformRender';
import { buildPeaks } from '../../audio/peaks';

interface Call {
  method: string;
  args: number[];
  fillStyle?: string;
  strokeStyle?: string;
  text?: string;
  shadowBlur?: number;
  shadowColor?: string;
  lineWidth?: number;
  dash?: number[];
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
  /** Public (was private) so the Task B2 beat-tic tests can assert the dash
   * state was RESTORED after the beat pass — trap 9. */
  dash: number[] = [];

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
      lineWidth: this.lineWidth,
      dash: [...this.dash],
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
      lineWidth: this.lineWidth,
      dash: [...this.dash],
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

// ---------------------------------------------------------------------------
// Task B2 — beat tics
// ---------------------------------------------------------------------------

const BEAT_TIC = 'rgba(255,213,79,0.55)';
const DOWNBEAT_TIC = 'rgba(255,213,79,0.95)';
const BEAT_TIC_PROVISIONAL = 'rgba(255,213,79,0.22)';
const DOWNBEAT_TIC_PROVISIONAL = 'rgba(255,213,79,0.4)';
const TIC_PALETTE = [BEAT_TIC, DOWNBEAT_TIC, BEAT_TIC_PROVISIONAL, DOWNBEAT_TIC_PROVISIONAL];

/** Every `moveTo` the beat pass made, in draw order. The beat pass is the only
 * thing that ever strokes in the amber tic palette. */
function ticStarts(stub: StubCtx): Call[] {
  return stub.calls.filter((c) => c.method === 'moveTo' && TIC_PALETTE.includes(c.strokeStyle ?? ''));
}

function ticXs(stub: StubCtx): number[] {
  return ticStarts(stub).map((c) => c.args[0]);
}

/** An `ArrayLike<number>` that counts how many ELEMENTS the drawing code reads.
 * A culled draw reads O(log n) (the binary search) + O(visible); an unculled
 * one reads all n. Nothing about the resulting picture distinguishes the two,
 * which is exactly why the read count has to be asserted directly. */
function countingBeats(beats: Int32Array): { view: ArrayLike<number>; reads: () => number } {
  let reads = 0;
  const view = new Proxy(
    { length: beats.length },
    {
      get(_t, prop) {
        if (prop === 'length') return beats.length;
        const i = typeof prop === 'string' ? Number(prop) : NaN;
        if (Number.isInteger(i)) {
          reads++;
          return beats[i];
        }
        return undefined;
      },
    }
  ) as unknown as ArrayLike<number>;
  return { view, reads: () => reads };
}

/** Beats every `spacing` samples: at spp = 10 the default is one tic per 10 px. */
function evenBeats(count: number, spacing = 100): Int32Array {
  return Int32Array.from({ length: count }, (_, i) => i * spacing);
}

describe('drawBeatTics (Task B2 primitive)', () => {
  function base(over: Partial<BeatTicOpts> = {}): BeatTicOpts {
    return {
      beats: evenBeats(10),
      scrollSample: 0,
      samplesPerPixel: 10,
      width: 100,
      baseline: 100,
      beatHeight: 9,
      downbeatHeight: 16,
      ...over,
    };
  }

  it('strokes one tic per beat at the beat pixel, growing UP from the baseline', () => {
    const { ctx, stub } = makeCtx();
    const drawn = drawBeatTics(ctx, base());

    expect(drawn).toBe(10);
    expect(ticXs(stub)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    // Each tic runs from (baseline - beatHeight) down to baseline: 91 -> 100.
    for (const c of ticStarts(stub)) expect(c.args[1]).toBe(91);
    const ends = stub.calls.filter((c) => c.method === 'lineTo' && c.strokeStyle === BEAT_TIC);
    expect(ends).toHaveLength(10);
    for (const c of ends) expect(c.args[1]).toBe(100);
  });

  it('honours scroll and zoom rather than assuming an origin', () => {
    const { ctx, stub } = makeCtx();
    // scroll 250 @ spp 5: beat 300 -> x 10, beat 400 -> x 30, ... beat 700 -> x 90.
    drawBeatTics(ctx, base({ scrollSample: 250, samplesPerPixel: 5 }));
    expect(ticXs(stub)).toEqual([10, 30, 50, 70, 90]);
  });

  it('draws NOTHING when there are no beats', () => {
    const { ctx, stub } = makeCtx();
    expect(drawBeatTics(ctx, base({ beats: new Int32Array(0) }))).toBe(0);
    expect(stub.calls).toHaveLength(0);
  });

  it('never draws a tic past endSample (the analysis stops there — no extrapolation)', () => {
    const { ctx, stub } = makeCtx();
    const drawn = drawBeatTics(ctx, base({ endSample: 450 }));
    expect(drawn).toBe(5);
    expect(ticXs(stub)).toEqual([0, 10, 20, 30, 40]); // samples 0..400, never 500
  });

  it('draws no downbeat distinction at all when no isDownbeat predicate is supplied', () => {
    const { ctx, stub } = makeCtx();
    drawBeatTics(ctx, base());
    expect(new Set(ticStarts(stub).map((c) => c.strokeStyle))).toEqual(new Set([BEAT_TIC]));
    // One height only — no taller bar lines invented from an assumed 4/4.
    expect(new Set(ticStarts(stub).map((c) => c.args[1]))).toEqual(new Set([91]));
  });

  it('draws downbeats taller AND brighter when the predicate genuinely answers', () => {
    const { ctx, stub } = makeCtx();
    drawBeatTics(ctx, base({ isDownbeat: (i) => i % 4 === 0 }));

    const starts = ticStarts(stub);
    const downs = starts.filter((c) => c.strokeStyle === DOWNBEAT_TIC);
    const plain = starts.filter((c) => c.strokeStyle === BEAT_TIC);
    expect(downs.map((c) => c.args[0])).toEqual([0, 40, 80]);
    expect(plain).toHaveLength(7);
    for (const c of downs) expect(c.args[1]).toBe(84); // 100 - 16, taller
    for (const c of plain) expect(c.args[1]).toBe(91); // 100 - 9
  });

  it('draws a stale / low-confidence grid as PROVISIONAL — dimmer and dashed', () => {
    const { ctx: c1, stub: confident } = makeCtx();
    drawBeatTics(c1, base({ isDownbeat: (i) => i % 4 === 0 }));
    const { ctx: c2, stub: doubtful } = makeCtx();
    drawBeatTics(c2, base({ isDownbeat: (i) => i % 4 === 0, provisional: true }));

    // Same geometry...
    expect(ticXs(doubtful)).toEqual(ticXs(confident));
    // ...visibly different treatment: dimmer colours and a dashed stroke.
    expect(new Set(ticStarts(doubtful).map((c) => c.strokeStyle))).toEqual(
      new Set([BEAT_TIC_PROVISIONAL, DOWNBEAT_TIC_PROVISIONAL])
    );
    for (const c of ticStarts(doubtful)) expect(c.dash!.length).toBeGreaterThan(0);
    for (const c of ticStarts(confident)) expect(c.dash).toEqual([]);
  });

  it('restores strokeStyle and lineWidth, and clears the dash, after the pass', () => {
    const { ctx, stub } = makeCtx();
    stub.strokeStyle = '#abcdef';
    stub.lineWidth = 7;
    stub.setLineDash([9, 9]);

    drawBeatTics(ctx, base({ isDownbeat: (i) => i % 4 === 0, provisional: true }));

    expect(stub.strokeStyle).toBe('#abcdef');
    expect(stub.lineWidth).toBe(7);
    // Dash goes back to NONE, not to the caller's — the module-wide invariant
    // (`drawMarkers` does the same), because `getLineDash()` cannot be read
    // back here: the recording stub implements only the handful of methods the
    // render path uses and throws on anything else.
    expect(stub.dash).toEqual([]);
  });

  it('leaves a confident (undashed) pass with the dash untouched', () => {
    const { ctx, stub } = makeCtx();
    drawBeatTics(ctx, base());
    expect(stub.dash).toEqual([]);
  });

  it('CULLS to the visible range instead of walking the whole grid (trap 7)', () => {
    // 10 000 beats, one every 1000 samples; the viewport shows 1000 samples.
    const { view, reads } = countingBeats(evenBeats(10000, 1000));
    const { ctx, stub } = makeCtx();
    const drawn = drawBeatTics(ctx, base({ beats: view, samplesPerPixel: 1, width: 1000 }));

    expect(drawn).toBe(2); // samples 0 and 1000 only
    expect(ticXs(stub)).toEqual([0, 1000]);
    // Binary search (~14 probes) + the two visible beats + one look-ahead.
    // A linear walk would read all 10 000.
    expect(reads()).toBeLessThan(40);
  });

  it('culls from the LEFT too — a scrolled view never walks the beats behind it', () => {
    const { view, reads } = countingBeats(evenBeats(10000, 1000));
    const { ctx, stub } = makeCtx();
    const drawn = drawBeatTics(
      ctx,
      base({ beats: view, scrollSample: 5_000_000, samplesPerPixel: 1, width: 1000 })
    );
    expect(drawn).toBe(2); // 5 000 000 and 5 001 000
    expect(ticXs(stub)).toEqual([0, 1000]);
    expect(reads()).toBeLessThan(40);
  });

  it('THINS at extreme zoom-out rather than painting a solid block (trap 8)', () => {
    // The worst case: a whole document collapsed into ~50 CSS px.
    const beats = evenBeats(1000, 10_000); // 10 M samples of beats
    const { ctx, stub } = makeCtx();
    const drawn = drawBeatTics(
      ctx,
      base({ beats, samplesPerPixel: 200_000, width: 50 }) // 0.05 px between beats
    );

    // The rule: at most one tic per 3 CSS px.
    expect(drawn).toBeLessThanOrEqual(Math.ceil(50 / 3) + 1);
    expect(drawn).toBeGreaterThan(10); // still a legible grid, not one lonely tic
    const xs = ticXs(stub);
    expect(xs).toHaveLength(drawn);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(3);
  });

  it('does not thin at a normal zoom (the thinning rule is not always on)', () => {
    const { ctx, stub } = makeCtx();
    drawBeatTics(ctx, base()); // 10 px apart
    expect(ticXs(stub)).toHaveLength(10);
  });

  it("never mutates or reorders the caller's shared beat array", () => {
    const beats = evenBeats(10);
    const before = Array.from(beats);
    const { ctx } = makeCtx();
    drawBeatTics(ctx, base({ beats, isDownbeat: (i) => i % 4 === 0, provisional: true }));
    expect(Array.from(beats)).toEqual(before);
  });
});

describe('drawEditorBeatTics + renderWaveform integration (Task B2)', () => {
  function gridOpts(width: number, height: number, channels = 1): RenderOpts {
    const ch = constantChannel(1000, 0); // spp = 10
    const py = buildPeaks(ch);
    return {
      width,
      height,
      channels: Array.from({ length: channels }, () => ch),
      pyramids: Array.from({ length: channels }, () => py),
      scrollSample: 0,
      samplesPerPixel: 10,
      selection: null,
      cursorSample: 0,
      playheadSample: null,
    };
  }

  it('draws nothing beat-related when beatGrid is omitted, null, or empty', () => {
    for (const grid of [undefined, null, { beats: new Int32Array(0) }]) {
      const { ctx, stub } = makeCtx();
      renderWaveform(ctx, { ...gridOpts(100, 100), beatGrid: grid });
      expect(ticStarts(stub)).toHaveLength(0);
    }
  });

  it('draws the tics ONCE along the bottom of the canvas, not once per channel lane', () => {
    const { ctx, stub } = makeCtx();
    renderWaveform(ctx, {
      ...gridOpts(100, 200, 2), // stereo: two 100 px lanes
      beatGrid: { beats: evenBeats(10) },
    });
    const starts = ticStarts(stub);
    expect(starts).toHaveLength(10); // 10, not 20
    // All in the band at the very bottom of the canvas (below BOTH lanes).
    for (const c of starts) expect(c.args[1]).toBe(200 - 9);
    const ends = stub.calls.filter((c) => c.method === 'lineTo' && c.strokeStyle === BEAT_TIC);
    for (const c of ends) expect(c.args[1]).toBe(200);
  });

  it('puts the mono band in exactly the same place as the stereo one', () => {
    const { ctx, stub } = makeCtx();
    renderWaveform(ctx, { ...gridOpts(100, 200, 1), beatGrid: { beats: evenBeats(10) } });
    const starts = ticStarts(stub);
    expect(starts).toHaveLength(10);
    for (const c of starts) expect(c.args[1]).toBe(200 - 9);
  });

  it('leaves the marker, cursor and playhead visuals uncorrupted (state restored, trap 9)', () => {
    const { ctx, stub } = makeCtx();
    renderWaveform(ctx, {
      ...gridOpts(100, 100),
      beatGrid: { beats: evenBeats(10), provisional: true },
      markers: [{ positionSample: 300, name: 'Verse' }],
      playheadSample: 600,
    });

    // The playhead is still a SOLID glowing accent line, not a dashed one.
    const playhead = stub.calls.find(
      (c) => c.method === 'stroke' && c.strokeStyle === '#26c6da' && (c.shadowBlur ?? 0) > 0
    );
    expect(playhead).toBeDefined();
    expect(playhead!.dash).toEqual([]);
    expect(playhead!.lineWidth).toBe(1);
    // The cursor is still a solid white line.
    const cursor = stub.calls.find((c) => c.method === 'moveTo' && c.strokeStyle === '#ffffff');
    expect(cursor!.dash).toEqual([]);
    // And nothing dashed leaks out of renderWaveform.
    expect(stub.dash).toEqual([]);
  });

  it('does not dash the cursor or the playhead when NO marker pass follows to clear it', () => {
    // The marker pass ends with setLineDash([]), so a leaked dash from the beat
    // pass is invisible whenever markers happen to exist. Without them the beat
    // pass is the only thing between the waveform and the cursor/playhead, and
    // a missing restore shows up immediately.
    const { ctx, stub } = makeCtx();
    renderWaveform(ctx, {
      ...gridOpts(100, 100),
      beatGrid: { beats: evenBeats(10), provisional: true },
      cursorSample: 300,
      playheadSample: 600,
    });
    const cursor = stub.calls.find((c) => c.method === 'moveTo' && c.strokeStyle === '#ffffff');
    expect(cursor).toBeDefined();
    expect(cursor!.dash).toEqual([]);
    const playhead = stub.calls.find(
      (c) => c.method === 'stroke' && c.strokeStyle === '#26c6da' && (c.shadowBlur ?? 0) > 0
    );
    expect(playhead).toBeDefined();
    expect(playhead!.dash).toEqual([]);
    // The selection edges sit between the two and must be solid as well.
    expect(stub.dash).toEqual([]);
  });

  it('clamps the tic band to a very short canvas instead of drawing off the top', () => {
    const { ctx, stub } = makeCtx();
    renderWaveform(ctx, { ...gridOpts(100, 6), beatGrid: { beats: evenBeats(3) } });
    expect(ticStarts(stub)).toHaveLength(3);
    for (const c of ticStarts(stub)) expect(c.args[1]).toBeGreaterThanOrEqual(0);
  });

  it('drawEditorBeatTics is standalone and takes primitives (SpectrogramView / B3 reuse)', () => {
    const { ctx, stub } = makeCtx();
    const drawn = drawEditorBeatTics(ctx, { beats: evenBeats(4) }, 120, 0, 10, 100);
    expect(drawn).toBe(4);
    expect(ticXs(stub)).toEqual([0, 10, 20, 30]);
    for (const c of ticStarts(stub)) expect(c.args[1]).toBe(120 - 9);
    expect(drawEditorBeatTics(ctx, null, 120, 0, 10, 100)).toBe(0);
    expect(drawEditorBeatTics(ctx, undefined, 120, 0, 10, 100)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F11-1 — the playhead grab handle. The point of these assertions is the
// DIFFERENCE from a marker flag: the two shapes share the top few pixels of the
// same canvas, and a user must never grab one thinking it is the other.
// ---------------------------------------------------------------------------
describe('the playhead grab handle (F11-1)', () => {
  function opts(over: Partial<RenderOpts>): RenderOpts {
    const ch = constantChannel(8000, 0);
    return {
      width: 800,
      height: 100,
      channels: [ch],
      pyramids: [buildPeaks(ch)],
      scrollSample: 0,
      samplesPerPixel: 1,
      selection: null,
      cursorSample: 0,
      playheadSample: null,
      ...over,
    };
  }

  /** The moveTo/lineTo path the handle draws, in order. */
  function handlePath(stub: StubCtx): Call[] {
    const start = stub.calls.findIndex(
      (c) => (c.method === 'moveTo' || c.method === 'lineTo') && c.fillStyle === '#e5484d'
    );
    if (start === -1) return [];
    return stub.calls
      .slice(start)
      .filter((c) => c.method === 'moveTo' || c.method === 'lineTo')
      .slice(0, 3);
  }

  it('is a red triangle CENTRED on the line and pointing down into it', () => {
    const { ctx, stub } = makeCtx();
    drawCursorHandle(ctx, 300, 800);

    const path = handlePath(stub);
    expect(path.map((c) => c.args)).toEqual([
      [300 - CURSOR_HANDLE_HALF_W, 0],
      [300 + CURSOR_HANDLE_HALF_W, 0],
      [300, CURSOR_HANDLE_H],
    ]);
    // Symmetric about the line: the two top corners are equidistant from it.
    expect(300 - path[0].args[0]).toBe(path[1].args[0] - 300);
  });

  it('is a different colour and a different shape from a marker flag', () => {
    const { ctx: handleCtx, stub: handleStub } = makeCtx();
    drawCursorHandle(handleCtx, 300, 800);
    const { ctx: markerCtx, stub: markerStub } = makeCtx();
    drawMarkers(markerCtx, [{ positionSample: 300 }], 100, 0, 1, 800);

    const handle = handlePath(handleStub);
    // The FLAG pass, not the dashed-line pass that precedes it (that one sets
    // only strokeStyle, so its recorded fillStyle is still empty).
    const flagFill = markerStub.calls.find(
      (c) => c.method === 'moveTo' && c.fillStyle !== ''
    )!.fillStyle;

    expect(handle[0].fillStyle).toBe('#e5484d'); // red
    expect(flagFill).toBe('#ff8a65'); // orange
    expect(handle[0].fillStyle).not.toBe(flagFill);

    // The flag hangs to ONE side of its line (all its x are >= the line);
    // the handle straddles its own.
    const flagXs = markerStub.calls
      .filter((c) => c.method === 'moveTo' || c.method === 'lineTo')
      .map((c) => c.args[0]);
    expect(Math.min(...flagXs)).toBe(300);
    expect(Math.min(...handle.map((c) => c.args[0]))).toBeLessThan(300);
  });

  it('is culled once it is fully past either edge, and drawn while it straddles one', () => {
    const { ctx: outCtx, stub: outStub } = makeCtx();
    drawCursorHandle(outCtx, -CURSOR_HANDLE_HALF_W - 1, 800);
    drawCursorHandle(outCtx, 800 + CURSOR_HANDLE_HALF_W + 1, 800);
    expect(handlePath(outStub)).toEqual([]);

    const { ctx: edgeCtx, stub: edgeStub } = makeCtx();
    drawCursorHandle(edgeCtx, 0, 800);
    expect(handlePath(edgeStub)).toHaveLength(3);
  });

  it('renderWaveform draws it on the cursor, after the cursor line', () => {
    const { ctx, stub } = makeCtx();
    renderWaveform(ctx, opts({ cursorSample: 300 }));

    const cursorLine = stub.calls.findIndex(
      (c) => c.method === 'moveTo' && c.strokeStyle === '#ffffff' && c.args[0] === 300
    );
    const handle = stub.calls.findIndex(
      (c) => c.method === 'moveTo' && c.fillStyle === '#e5484d'
    );
    expect(cursorLine).toBeGreaterThanOrEqual(0);
    expect(handle).toBeGreaterThan(cursorLine);
  });
});
