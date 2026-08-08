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
  /** Optional beat-tic overlay (Task B2). OPTIONAL by design, exactly like
   * `markers`: a required field would break every existing caller and the whole
   * unit suite at compile time. Omitted / `null` / empty draws nothing at all
   * and costs nothing — which is also what "no cached analysis" resolves to
   * (plan ruling 6: never trigger an analysis just to draw). */
  beatGrid?: BeatGridOverlay | null;
}

/**
 * What the render layer needs in order to draw a beat grid — and nothing that
 * would couple this pure drawing module to the store. Deliberately NOT the
 * service's `BeatGrid`: `beatGrid.ts` imports `useAppStore` and React, and this
 * module has to stay importable from a worker and testable against a recording
 * stub. `useBeatGridOverlay` is the adapter between the two.
 */
export interface BeatGridOverlay {
  /**
   * Ascending beat positions expressed in the SAME time base as the
   * `scrollSample`/`samplesPerPixel` they are drawn with. Read-only: the
   * service's `beatSamples` is a SHARED `Int32Array` handed to every consumer,
   * so nothing here may sort or mutate it (trap 20). `ArrayLike` rather than
   * `Int32Array` so B3 can pass a mapped `number[]` for a clip without copying
   * into a typed array first.
   */
  beats: ArrayLike<number>;
  /**
   * Whether beat `index` starts a bar. **Omitted means no downbeats are drawn
   * at all** — AMENDED RULING 1: bar data exists only on a genuinely measured
   * `level:'remix'` analysis, and a grid without it must degrade to beats-only
   * rather than assume 4/4.
   */
  isDownbeat?: (index: number) => boolean;
  /** The analysis's `analyzedEndSample`: no tic is ever drawn past it, because
   * on a long file the grid legitimately covers only the analysed prefix and
   * extrapolating would invent beats the DSP never measured (trap 11). */
  endSample?: number;
  /** True when the grid is stale or below `CONFIDENCE_LOW` — draw it as
   * provisional (dimmer + dashed) so a doubtful grid is never presented as
   * fact. The visual analogue of the status bar's `*` / `?` (plan ruling 6). */
  provisional?: boolean;
}

/** {@link BeatGridOverlay} plus the geometry to draw it with. All primitives —
 * no editor zoom/scroll object — so the multitrack clips (B3) can call it with
 * their own lane origin, their own zoom and their own visible band. */
export interface BeatTicOpts extends BeatGridOverlay {
  scrollSample: number;
  samplesPerPixel: number;
  /** Width of the drawable window in CSS px; tics outside it are culled. */
  width: number;
  /** y of the tic baseline in CSS px. Tics grow UPWARD from here. */
  baseline: number;
  /** Tic length for an ordinary beat, in CSS px. */
  beatHeight: number;
  /** Tic length for a downbeat. Defaults to {@link beatHeight}, i.e. no visual
   * distinction — which is the correct default when nothing was measured. */
  downbeatHeight?: number;
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

// --- Beat grid (Task B2) ---------------------------------------------------
// Amber: the four colours already on this canvas are cyan (waveform, playhead,
// selection), orange (markers), white (cursor) and the faint white axis. Amber
// is the one hue left that reads as "reference grid" against all of them, and
// it is the pre-G6 playhead colour so it is already in the app's palette.
/** Confident, fresh grid. */
const BEAT_TIC = 'rgba(255,213,79,0.55)';
const DOWNBEAT_TIC = 'rgba(255,213,79,0.95)';
/** Stale or low-confidence: the drawn analogue of the status bar's `*` / `?`. */
const BEAT_TIC_PROVISIONAL = 'rgba(255,213,79,0.22)';
const DOWNBEAT_TIC_PROVISIONAL = 'rgba(255,213,79,0.4)';
/** ...and dashed, so the difference survives a colour-blind or dimmed display
 * (the marker lines' own `[4,3]` precedent, tightened for a ~9 px tic). */
const PROVISIONAL_DASH = [2, 2];

/**
 * THE THINNING RULE (trap 8): at most one tic per 3 CSS px.
 *
 * At maximum zoom-out a whole document collapses into ~50 CSS px, which for a
 * 5-minute track at 120 BPM is ~600 beats — 0.08 px apart. Drawn faithfully
 * that is a solid amber block that says nothing. Skipping any tic closer than
 * `MIN_TIC_GAP_PX` to the previously DRAWN one turns it back into a legible
 * ~17-tic ruler, and at any normal zoom (>= 3 px between beats, i.e. anything
 * closer in than about 15x zoomed-out on a typical track) the rule never fires
 * so nothing is lost. It is a pixel rule, not a beat rule, so it degrades
 * smoothly instead of switching modes. Same shape as `LABEL_MIN_GAP` below.
 */
const MIN_TIC_GAP_PX = 3;

/** The editor band: tics hang off the BOTTOM of the canvas, ~9 px for a beat
 * and ~16 px for a measured downbeat. */
const BEAT_TIC_PX = 9;
const DOWNBEAT_TIC_PX = 16;

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
    beatGrid,
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

  // Beat tics sit in the BACKGROUND layer, immediately after the audio itself
  // and before every user-facing overlay: they are a reference grid, so the
  // selection tint, the markers, the cursor and the playhead must all read as
  // being ON TOP of them, never hidden behind them.
  drawEditorBeatTics(ctx, beatGrid, height, scrollSample, samplesPerPixel, width);

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

/** Index of the first beat at or after `value`. The beats are ascending by
 * construction (`tempoCore`'s tracker emits them in time order), so the visible
 * window is found in O(log n) rather than by walking the grid — see
 * {@link drawBeatTics}'s culling note. */
function firstBeatAtOrAfter(beats: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (beats[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Task B2 — the beat-tic primitive. Draws one short vertical tic per beat,
 * hanging upward off `baseline`, with measured downbeats taller and brighter.
 *
 * Standalone and primitive-taking on purpose (the {@link drawMarkers}
 * precedent): it knows nothing about the editor's zoom object, the store, or
 * which canvas it is on, so the multitrack clips (B3) can call it with a clip's
 * own lane origin, the multitrack zoom, and a band that is actually on screen
 * — none of which the editor's own numbers would give them.
 *
 * Returns the number of tics actually drawn (after culling and thinning), which
 * is what makes both of those behaviours assertable rather than merely visual.
 *
 * **Culling.** The waveform re-renders on every animation frame during playback
 * (trap 7), so a naive walk over a 5-minute grid would run ~600 iterations at
 * 60 Hz for the handful of beats actually on screen. The visible window is
 * located by binary search and the loop stops at the first beat past its right
 * edge, so the cost is O(log n + visible), independent of document length.
 *
 * **State.** Restores `strokeStyle` and `lineWidth`, and clears the dash,
 * before returning (trap 9) — this pass runs *before* the marker/cursor/
 * playhead overlays, and leaking a dash or a colour into them would corrupt
 * their visuals and break their existing tests. `save()`/`restore()` are
 * deliberately not used, and neither is `getLineDash()`: the recording stub the
 * render tests drive implements only the handful of context methods this path
 * already uses, and reaching for one it lacks throws. Clearing the dash rather
 * than restoring it is the same invariant `drawMarkers` keeps — every pass in
 * this module enters and leaves undashed.
 *
 * Never mutates or sorts `beats` — it is the analysis cache's own shared
 * `Int32Array` (trap 20).
 */
export function drawBeatTics(ctx: CanvasRenderingContext2D, opts: BeatTicOpts): number {
  const {
    beats,
    isDownbeat,
    scrollSample,
    samplesPerPixel,
    width,
    baseline,
    beatHeight,
    downbeatHeight = beatHeight,
    endSample,
    provisional = false,
  } = opts;

  const count = beats.length;
  if (count === 0 || width <= 0 || samplesPerPixel <= 0 || beatHeight <= 0) return 0;

  // The window this pass may draw in: the visible sample range, clipped to
  // where the analysis actually stops (trap 11 — never extrapolate past it).
  const firstSample = scrollSample;
  const visibleEnd = scrollSample + width * samplesPerPixel;
  const lastSample = endSample === undefined ? visibleEnd : Math.min(visibleEnd, endSample);
  if (lastSample < firstSample) return 0;

  const prevStroke = ctx.strokeStyle;
  const prevLineWidth = ctx.lineWidth;
  ctx.lineWidth = 1;
  if (provisional) ctx.setLineDash(PROVISIONAL_DASH);

  const beatColor = provisional ? BEAT_TIC_PROVISIONAL : BEAT_TIC;
  const downbeatColor = provisional ? DOWNBEAT_TIC_PROVISIONAL : DOWNBEAT_TIC;

  let drawn = 0;
  let lastX = -Infinity;
  let style = '';
  for (let i = firstBeatAtOrAfter(beats, firstSample); i < count; i++) {
    const sample = beats[i];
    if (sample > lastSample) break; // right-edge cull
    const x = sampleToPixel(sample, scrollSample, samplesPerPixel);
    if (x - lastX < MIN_TIC_GAP_PX) continue; // thinning
    lastX = x;

    const down = isDownbeat ? isDownbeat(i) : false;
    const want = down ? downbeatColor : beatColor;
    if (want !== style) {
      ctx.strokeStyle = want;
      style = want;
    }
    const top = Math.max(0, baseline - (down ? downbeatHeight : beatHeight));
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, baseline);
    ctx.stroke();
    drawn++;
  }

  if (provisional) ctx.setLineDash([]);
  ctx.strokeStyle = prevStroke;
  ctx.lineWidth = prevLineWidth;
  return drawn;
}

/**
 * The editor's beat band: ONE row of tics hanging off the bottom edge of the
 * canvas, whatever the channel count.
 *
 * *Per-lane vs once* — `renderWaveform` draws one lane per channel, so "the
 * bottom of the waveform lane" is ambiguous for stereo. Once, at the bottom of
 * the whole canvas: the grid is a property of TIME, not of a channel, so
 * repeating it per lane would draw the same information N times and, on stereo,
 * would slice a band of tics straight through the middle of the view between
 * the two lanes. One bottom band also puts the tics in exactly the same place
 * for mono and stereo, which is what makes them readable as a ruler.
 *
 * Exported so `SpectrogramView` — which paints its own overlays rather than
 * going through `renderWaveform` — gets the identical band from the identical
 * code, exactly as it already does for {@link drawMarkers}. It must be called
 * AFTER the spectrogram raster is blitted, never into the cached raster itself
 * (trap 10), or the tics would freeze at the zoom the raster was built at.
 */
export function drawEditorBeatTics(
  ctx: CanvasRenderingContext2D,
  grid: BeatGridOverlay | null | undefined,
  height: number,
  scrollSample: number,
  samplesPerPixel: number,
  width: number
): number {
  if (!grid || grid.beats.length === 0 || height <= 0) return 0;
  return drawBeatTics(ctx, {
    ...grid,
    scrollSample,
    samplesPerPixel,
    width,
    baseline: height,
    // Clamped so a very short lane gets a proportionate band instead of tics
    // drawn off the top of the canvas.
    beatHeight: Math.min(BEAT_TIC_PX, height),
    downbeatHeight: Math.min(DOWNBEAT_TIC_PX, height),
  });
}
