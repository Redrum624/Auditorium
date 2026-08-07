// Pure waveform drawing. The canvas context is injected so this is fully
// testable with a recording stub. All coordinates are CSS pixels; the caller
// is responsible for devicePixelRatio scaling (ctx.setTransform).

import { getPeaksForRange, type PeakPyramid } from '../../audio/peaks';
import type { SelectionRange } from '../../stores/appStore';

export interface RenderOpts {
  width: number;
  height: number;
  channels: Float32Array[];
  pyramids: PeakPyramid[];
  scrollSample: number;
  samplesPerPixel: number;
  selection: SelectionRange | null;
  cursorSample: number;
  playheadSample: number | null;
  /** Optional marker overlay (Task 7: dashed line; Task 23: + flag + label).
   * `name` is optional so callers that only have positions still typecheck;
   * omitting it just suppresses that marker's label. Default: none. */
  markers?: { positionSample: number; name?: string }[];
}

/**
 * G6: the canvas colours route through the v1.6 glass tokens. A 2D canvas
 * cannot consume `var(--x)` in fillStyle/strokeStyle, so `cssToken` resolves
 * the custom property from the live stylesheet once (cached — the tokens are
 * static for the app's lifetime and the playhead repaints every frame) and
 * falls back to the token's authored value where no stylesheet is present
 * (jsdom, recording-stub tests, workers).
 */
const tokenCache = new Map<string, string>();
export function cssToken(name: string, fallback: string): string {
  let v = tokenCache.get(name);
  if (v === undefined) {
    v = '';
    try {
      if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      }
    } catch {
      // No DOM (worker) — use the fallback.
    }
    if (!v) v = fallback;
    tokenCache.set(name, v);
  }
  return v;
}

// The lane container (.glass-lane) owns the background since G6 — the canvas
// stays transparent so the floating-lane fill shows through (BG removed).
const AXIS = 'rgba(255,255,255,0.12)'; // mockup lane centre line
const BODY = 'rgba(38,198,218,0.7)'; // --accent @ 70% (no token at this alpha)
const CENTER_FALLBACK = '#26c6da'; // --accent
const SELECTION_FILL_FALLBACK = 'rgba(38,198,218,0.14)'; // --accent-soft
const SELECTION_EDGE_FALLBACK = 'rgba(38,198,218,0.35)'; // --accent-ring
const CURSOR = '#ffffff';
const PLAYHEAD_FALLBACK = '#26c6da'; // --accent (was yellow pre-G6)
const PLAYHEAD_GLOW_FALLBACK = 'rgba(38,198,218,0.35)'; // --accent-ring
const MARKER = '#ff8a65';

/** Fraction of a half-lane a full-scale (|v|=1) sample occupies (leaves margin). */
const VSCALE = 0.9;

/** Convert a pixel x within the canvas to an absolute sample index. */
export function pixelToSample(x: number, scrollSample: number, samplesPerPixel: number): number {
  return scrollSample + x * samplesPerPixel;
}

/** Convert an absolute sample index to a pixel x within the canvas. */
export function sampleToPixel(s: number, scrollSample: number, samplesPerPixel: number): number {
  return (s - scrollSample) / samplesPerPixel;
}

function verticalLine(ctx: CanvasRenderingContext2D, x: number, height: number): void {
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
}

export function renderWaveform(ctx: CanvasRenderingContext2D, opts: RenderOpts): void {
  const {
    width,
    height,
    channels,
    pyramids,
    scrollSample,
    samplesPerPixel,
    selection,
    cursorSample,
    playheadSample,
    markers = [],
  } = opts;

  // G6: no opaque background fill — the floating lane container paints the
  // translucent fill; clear so a caller that reuses a canvas gets no ghosting.
  ctx.clearRect(0, 0, width, height);

  if (width <= 0 || height <= 0 || channels.length === 0) return;

  const laneH = height / channels.length;
  const startSample = scrollSample;
  const endSample = scrollSample + width * samplesPerPixel;

  for (let ch = 0; ch < channels.length; ch++) {
    const channel = channels[ch];
    const laneTop = ch * laneH;
    const center = laneTop + laneH / 2;
    const amp = (laneH / 2) * VSCALE;

    // Zero-axis reference line.
    ctx.strokeStyle = AXIS;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, center);
    ctx.lineTo(width, center);
    ctx.stroke();

    if (samplesPerPixel >= 1) {
      drawBuckets(ctx, channel, pyramids[ch], width, startSample, endSample, center, amp);
    } else {
      drawSamples(ctx, channel, width, scrollSample, samplesPerPixel, center, amp);
    }
  }

  drawSelection(ctx, selection, height, scrollSample, samplesPerPixel, width);
  drawMarkers(ctx, markers, height, scrollSample, samplesPerPixel, width);

  // Cursor (white) and playhead (accent + soft glow, G6) overlays.
  const cx = sampleToPixel(cursorSample, scrollSample, samplesPerPixel);
  if (cx >= 0 && cx <= width) {
    ctx.strokeStyle = CURSOR;
    verticalLine(ctx, cx, height);
  }
  if (playheadSample != null) {
    const px = sampleToPixel(playheadSample, scrollSample, samplesPerPixel);
    if (px >= 0 && px <= width) {
      ctx.strokeStyle = cssToken('--accent', PLAYHEAD_FALLBACK);
      ctx.shadowColor = cssToken('--accent-ring', PLAYHEAD_GLOW_FALLBACK);
      ctx.shadowBlur = 8;
      verticalLine(ctx, px, height);
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
    }
  }
}

/** Bucket mode: one translucent min/max bar per pixel column plus a solid
 * center trace. Used when each pixel spans >= 1 sample. */
function drawBuckets(
  ctx: CanvasRenderingContext2D,
  channel: Float32Array,
  pyramid: PeakPyramid,
  width: number,
  startSample: number,
  endSample: number,
  center: number,
  amp: number
): void {
  const cols = Math.max(1, Math.floor(width));
  const { min, max } = getPeaksForRange(pyramid, channel, startSample, endSample, cols);

  // Translucent envelope body.
  ctx.fillStyle = BODY;
  for (let x = 0; x < cols; x++) {
    const yTop = center - max[x] * amp;
    const yBot = center - min[x] * amp;
    ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
  }

  // Solid center trace (midpoint of each column) for a brighter core.
  ctx.fillStyle = cssToken('--accent', CENTER_FALLBACK);
  for (let x = 0; x < cols; x++) {
    const mid = (min[x] + max[x]) / 2;
    ctx.fillRect(x, center - mid * amp, 1, 1);
  }
}

/** Per-sample mode: connected polyline through individual samples, with small
 * square dots when zoomed in far enough. Used when a pixel spans < 1 sample. */
function drawSamples(
  ctx: CanvasRenderingContext2D,
  channel: Float32Array,
  width: number,
  scrollSample: number,
  samplesPerPixel: number,
  center: number,
  amp: number
): void {
  const endSample = scrollSample + width * samplesPerPixel;
  const first = Math.max(0, Math.floor(scrollSample));
  const last = Math.min(channel.length - 1, Math.ceil(endSample));
  if (last < first) return;

  ctx.strokeStyle = cssToken('--accent', CENTER_FALLBACK);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let s = first; s <= last; s++) {
    const x = sampleToPixel(s, scrollSample, samplesPerPixel);
    const y = center - channel[s] * amp;
    if (s === first) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  if (samplesPerPixel < 1 / 8) {
    ctx.fillStyle = cssToken('--accent', CENTER_FALLBACK);
    for (let s = first; s <= last; s++) {
      const x = sampleToPixel(s, scrollSample, samplesPerPixel);
      const y = center - channel[s] * amp;
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
  }
}

function drawSelection(
  ctx: CanvasRenderingContext2D,
  selection: SelectionRange | null,
  height: number,
  scrollSample: number,
  samplesPerPixel: number,
  width: number
): void {
  if (!selection || selection.end <= selection.start) return;
  const x0 = sampleToPixel(selection.start, scrollSample, samplesPerPixel);
  const x1 = sampleToPixel(selection.end, scrollSample, samplesPerPixel);
  const left = Math.max(0, Math.min(x0, x1));
  const right = Math.min(width, Math.max(x0, x1));
  if (right <= left) return;

  // G6: --accent-soft fill with --accent-ring edges (mockup `.sel`).
  ctx.fillStyle = cssToken('--accent-soft', SELECTION_FILL_FALLBACK);
  ctx.fillRect(left, 0, right - left, height);

  ctx.strokeStyle = cssToken('--accent-ring', SELECTION_EDGE_FALLBACK);
  ctx.lineWidth = 1;
  if (x0 >= 0 && x0 <= width) verticalLine(ctx, x0, height);
  if (x1 >= 0 && x1 <= width) verticalLine(ctx, x1, height);
}

/** Triangle flag half-size in px (Task 23): the flag spans FLAG_SIZE px wide
 * and 2*FLAG_SIZE px tall, pointing down-right from the marker's dashed line. */
const FLAG_SIZE = 5;
/** Minimum horizontal gap (px) between two marker labels before the later one
 * is skipped — a simple, cheap overlap-avoidance heuristic (no text-width
 * measurement): compares marker x positions, not label pixel extents. */
const LABEL_MIN_GAP = 40;

/** Draws the dashed marker lines (Task 7) plus a small triangle flag and an
 * optional name label at the top of each in-view marker (Task 23). Exported
 * so SpectrogramView (which paints its own overlays rather than going through
 * renderWaveform) can reuse the exact same marker visuals. */
export function drawMarkers(
  ctx: CanvasRenderingContext2D,
  markers: { positionSample: number; name?: string }[],
  height: number,
  scrollSample: number,
  samplesPerPixel: number,
  width: number
): void {
  if (markers.length === 0) return;

  ctx.strokeStyle = MARKER;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  for (const m of markers) {
    const mx = sampleToPixel(m.positionSample, scrollSample, samplesPerPixel);
    if (mx >= 0 && mx <= width) verticalLine(ctx, mx, height);
  }
  ctx.setLineDash([]);

  ctx.fillStyle = MARKER;
  ctx.font = '10px sans-serif';
  ctx.textBaseline = 'top';
  let lastLabelX = -Infinity;
  for (const m of markers) {
    const mx = sampleToPixel(m.positionSample, scrollSample, samplesPerPixel);
    if (mx < -FLAG_SIZE || mx > width + FLAG_SIZE) continue;

    ctx.beginPath();
    ctx.moveTo(mx, 0);
    ctx.lineTo(mx + FLAG_SIZE, 0);
    ctx.lineTo(mx, FLAG_SIZE * 2);
    ctx.closePath();
    ctx.fill();

    if (m.name && mx - lastLabelX >= LABEL_MIN_GAP) {
      ctx.fillText(m.name, mx + FLAG_SIZE + 2, 0);
      lastLabelX = mx;
    }
  }
}
