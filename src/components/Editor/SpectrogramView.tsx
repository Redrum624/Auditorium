import { useEffect, useRef, useState } from 'react';
import { cloneRegion, docLength, mixDown } from '../../audio/AudioDocument';
import { publishEditorLaneWidth, useAppStore } from '../../stores/appStore';
import { createSpectrogramWorker } from '../../workers/createSpectrogramWorker';
import { useSpectralScale } from '../../services/spectralScale';
import {
  cssToken,
  drawCursorHandle,
  drawEditorBeatTics,
  drawMarkers,
  sampleToPixel,
} from './waveformRender';
import { useBeatGridOverlay } from './useBeatGridOverlay';
import { useEditorGestures } from './useEditorGestures';
import TimelineRuler from './TimelineRuler';
import type { Marker } from '../../stores/appStore';

// Stable empty-array reference — see WaveformView.tsx for why this must not
// be a fresh `[]` literal in the selector (infinite render loop otherwise).
const NO_MARKERS: Marker[] = [];
/** Stable empty channel list — see WaveformView.tsx. */
const NO_CHANNELS: Float32Array[] = [];

const FFT_SIZE = 2048;
const DB_MIN = -90;
const DB_MAX = 0;
const DEBOUNCE_MS = 150;

interface MagsData {
  mags: Float32Array;
  width: number;
  height: number;
}
interface SpectroDone {
  type: 'done';
  id: number;
  mags: Float32Array;
  width: number;
  height: number;
}
interface SpectroError {
  type: 'error';
  id: number;
  message: string;
}

/** 256-entry inferno-like colour LUT (RGB triples): black -> deep purple ->
 * magenta -> orange -> near-white, built once by interpolating control stops. */
const LUT = buildLut();

function buildLut(): Uint8ClampedArray {
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [0, 0, 0]],
    [0.13, [26, 11, 46]], // #1a0b2e
    [0.3, [74, 20, 110]],
    [0.5, [140, 41, 129]],
    [0.68, [200, 70, 74]],
    [0.83, [240, 140, 50]],
    [0.94, [250, 210, 90]],
    [1.0, [255, 255, 225]],
  ];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = stops[0];
    let b = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s][0] && t <= stops[s + 1][0]) {
        a = stops[s];
        b = stops[s + 1];
        break;
      }
    }
    const span = b[0] - a[0] || 1;
    const f = (t - a[0]) / span;
    lut[i * 3 + 0] = a[1][0] + (b[1][0] - a[1][0]) * f;
    lut[i * 3 + 1] = a[1][1] + (b[1][1] - a[1][1]) * f;
    lut[i * 3 + 2] = a[1][2] + (b[1][2] - a[1][2]) * f;
  }
  return lut;
}

function verticalLine(ctx: CanvasRenderingContext2D, x: number, height: number): void {
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
}

function drawSpectrogram(ctx: CanvasRenderingContext2D, m: MagsData, width: number, height: number): void {
  const { mags, width: mw, height: mh } = m;
  if (mw <= 0 || mh <= 0) return;
  const img = ctx.createImageData(width, height);
  const data = img.data;
  const dbSpan = DB_MAX - DB_MIN;
  for (let x = 0; x < width; x++) {
    const col = Math.min(mw - 1, Math.floor((x * mw) / width));
    for (let y = 0; y < height; y++) {
      // y=0 is the top of the canvas -> high frequency; flip so low freq is at the bottom.
      const row = Math.min(mh - 1, Math.floor(((height - 1 - y) * mh) / height));
      const db = mags[col * mh + row];
      let t = (db - DB_MIN) / dbSpan;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const li = Math.round(t * 255) * 3;
      const di = (y * width + x) * 4;
      data[di] = LUT[li];
      data[di + 1] = LUT[li + 1];
      data[di + 2] = LUT[li + 2];
      data[di + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Spectral (spectrogram) editor view (Task 19; log axis + HiDPI in Task F4).
 * Mirrors WaveformView's chrome (timeline ruler, wheel zoom/scroll, click/drag
 * selection, cursor) via the shared `useEditorGestures` hook, but renders a
 * spectrogram of the mono mix — logarithmic frequency axis by default (matching
 * Audition), toggleable to linear via the `view.spectralScale` command and the
 * `spectralScale` store. Magnitudes are computed off-thread by the spectrogram
 * worker (debounced 150ms on zoom/scroll/doc/scale change) at the canvas's
 * device-pixel resolution (`devicePixelRatio`-scaled width/height, so the
 * raster is full-res on HiDPI screens), mapped through an inferno LUT over a
 * -90..0 dB range — rasterised ONCE per (magnitudes, backing size) into an
 * offscreen canvas held in a ref (v1.5.2: the paint effect re-runs on every
 * playback frame for the playhead, and re-rasterising the whole spectrogram
 * per frame via a fresh `createImageData` was a 0.5–2 GB/s allocation
 * transient) — then blitted at raw device-pixel size, with translucent
 * selection, marker, cursor, and playhead overlays on top, drawn in CSS-pixel
 * space under a `ctx.setTransform(dpr, ...)` scale (mirrors WaveformView).
 */
// F11-0 — takes the document's **id**, not the document, for exactly the
// reasons documented on `WaveformView` and in `src/dev/userTimingGuard.ts`.
export default function SpectrogramView({ docId }: { docId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [magsData, setMagsData] = useState<MagsData | null>(null);
  const [computeFailed, setComputeFailed] = useState(false);

  const doc = useAppStore((s) => s.documents.find((d) => d.id === docId) ?? null);
  const zoom = useAppStore((s) => s.zoom);
  const selection = useAppStore((s) => s.selection);
  const cursorSample = useAppStore((s) => s.cursorSample);
  const playback = useAppStore((s) => s.playback);
  const markers = useAppStore((s) => s.markers[docId] ?? NO_MARKERS);
  const scale = useSpectralScale();
  // Task B2: the same beat tics as the waveform view, from the same adapter.
  const beatGrid = useBeatGridOverlay(docId, doc?.channels ?? NO_CHANNELS);

  const length = doc ? docLength(doc) : 0;
  const gestures = useEditorGestures(canvasRef, length);

  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);

  // Rendered spectrogram raster, cached across paints (v1.5.2). Keyed by the
  // magnitudes' identity and the backing-store size: the paint effect below
  // re-runs on every playback.positionSample change (the playhead overlay has
  // to move), and re-running drawSpectrogram — a full createImageData +
  // per-pixel LUT pass — on each of those frames re-allocated the entire
  // device-resolution raster per frame. Only new data or a resize invalidates.
  const rasterRef = useRef<{
    mags: Float32Array;
    width: number;
    height: number;
    canvas: HTMLCanvasElement;
  } | null>(null);

  // Observe the drawing area size (CSS pixels).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const width = el.clientWidth;
      setSize({ width, height: el.clientHeight });
      // F11-3: the spectral lane is the same stage the waveform lane is, and it
      // shares the store's zoom, so it publishes its width from the identical
      // effect — switching views must not leave the fit measured against a lane
      // that is no longer on screen.
      publishEditorLaneWidth(width);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // One worker per mount; stale replies (older request ids) are ignored. A
  // compute failure (Task F8) is warned to the console and flagged so a small
  // overlay says so; the next successful compute clears the flag.
  useEffect(() => {
    const worker = createSpectrogramWorker();
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as SpectroDone | SpectroError;
      if (!msg || msg.id !== reqIdRef.current) return;
      if (msg.type === 'error') {
        console.warn(`Spectrogram compute failed: ${msg.message}`);
        setComputeFailed(true);
        return;
      }
      if (msg.type !== 'done') return;
      setComputeFailed(false);
      setMagsData({ mags: msg.mags, width: msg.width, height: msg.height });
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // Recompute the spectrogram (debounced) whenever the data, zoom, size, or
  // scale change. Requests are made at the DEVICE-PIXEL resolution (CSS size *
  // devicePixelRatio) so the raster the worker returns is full-res on HiDPI
  // screens; `width`/`spp` used for the sample-range math stay in CSS pixels
  // since `zoom.samplesPerPixel` is defined in CSS-pixel terms (matches the
  // gesture math in useEditorGestures).
  useEffect(() => {
    if (!doc) return;
    const cssWidth = Math.round(size.width);
    const cssHeight = Math.round(size.height);
    if (cssWidth <= 0 || cssHeight <= 0) return;
    const worker = workerRef.current;
    if (!worker) return;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(cssWidth * dpr);
    const height = Math.round(cssHeight * dpr);

    const t = setTimeout(() => {
      const { samplesPerPixel: spp, scrollSample } = zoom;
      const start = Math.max(0, Math.floor(scrollSample));
      const end = Math.min(length, Math.ceil(scrollSample + cssWidth * spp));
      if (end <= start) return;
      // Mix down only the visible range padded by one FFT window — NOT the
      // whole document. The RIGHT-side pad (`end + fftSize`) is load-bearing:
      // the last few columns' FFT windows read up to `fftSize` samples past
      // their OWN start (spectrogramCore only ever reads forward from a
      // column's start, e.g. the final column's window can extend past
      // `endSample` when the zoom is tight). The LEFT-side pad
      // (`start - fftSize`) is currently dead — no column ever reads before
      // `startSample` — kept as defensive headroom for a future centered-
      // window FFT (Task M9 / F17; comment corrected fix round 1 / MINOR 2).
      // Mixing the full doc.channels here on every debounced zoom/scroll
      // gesture allocated a fresh full-length Float32Array (1.38 GB for a
      // 2-hour stereo file) on the main thread regardless of how little was
      // visible. `startSample`/`endSample` sent to the worker are re-based to
      // the slice's own origin (0), not the document's.
      const sliceStart = Math.max(0, start - FFT_SIZE);
      const sliceEnd = Math.min(length, end + FFT_SIZE);
      const mono = mixDown(cloneRegion(doc, sliceStart, sliceEnd));
      const id = ++reqIdRef.current;
      worker.postMessage(
        {
          type: 'compute',
          id,
          channel: mono,
          sampleRate: doc.sampleRate,
          startSample: start - sliceStart,
          endSample: end - sliceStart,
          width,
          height,
          fftSize: FFT_SIZE,
          scale,
        },
        [mono.buffer]
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
    // Keyed on `doc.id`/`doc.channels`/`doc.sampleRate` rather than the whole
    // `doc` object, so a metadata-only doc replacement (dirty/name/filePath/
    // sourceBitDepth — what every marker add/rename/delete produces via
    // appStore's markDirty) doesn't re-trigger a slice + FFT recompute, same
    // narrowing as the transport Toolbar's reload effect (Task M9 / F13, here
    // fix round 1 / MINOR 7). The effect body still closes over the current
    // render's `doc`, so this can only fire the effect LESS often, never with
    // stale data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, doc?.channels, doc?.sampleRate, length, zoom, size, scale]);

  // Paint the latest magnitudes plus selection/cursor/playhead overlays.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / no backend
    const width = Math.round(size.width);
    const height = Math.round(size.height);
    if (width <= 0 || height <= 0) return;

    // HiDPI backing store: canvas.width/height are DEVICE pixels; CSS size
    // (set by the `h-full w-full` classes) is unaffected. `ctx.setTransform`
    // scales subsequent CSS-pixel-space vector drawing (background fill,
    // selection/marker/cursor/playhead overlays below) to match. `putImageData`
    // (in drawSpectrogram) is exempt from the canvas transform by spec, so it's
    // called with the raw device-pixel dimensions directly.
    const dpr = window.devicePixelRatio || 1;
    const backingWidth = Math.round(width * dpr);
    const backingHeight = Math.round(height * dpr);
    canvas.width = backingWidth;
    canvas.height = backingHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // G6: transparent until the raster lands — the floating .glass-lane
    // container paints the lane fill (the raster itself is opaque and covers
    // the whole canvas once present). The resize above already cleared.
    ctx.clearRect(0, 0, width, height);
    if (magsData) {
      let raster = rasterRef.current;
      if (
        !raster ||
        raster.mags !== magsData.mags ||
        raster.width !== backingWidth ||
        raster.height !== backingHeight
      ) {
        const offscreen = document.createElement('canvas');
        offscreen.width = backingWidth;
        offscreen.height = backingHeight;
        const octx = offscreen.getContext('2d');
        if (octx) {
          drawSpectrogram(octx, magsData, backingWidth, backingHeight);
          raster = { mags: magsData.mags, width: backingWidth, height: backingHeight, canvas: offscreen };
          rasterRef.current = raster;
        }
      }
      if (raster) {
        // Blit in raw device-pixel space (mirrors putImageData's
        // transform-exempt semantics), then restore the CSS-pixel transform
        // for the overlays below.
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(raster.canvas, 0, 0);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }

    const { samplesPerPixel: spp, scrollSample } = zoom;

    // Beat tics (Task B2) — drawn HERE, on the live canvas AFTER the raster
    // blit, and never into `rasterRef`'s offscreen canvas: that raster is
    // cached across paints and only re-rasterised when the magnitudes or the
    // backing size change, so tics baked into it would freeze at the zoom and
    // scroll they were drawn at while the audio underneath moved (trap 10).
    // Same band and same code as the waveform view (`drawEditorBeatTics`).
    drawEditorBeatTics(ctx, beatGrid, height, scrollSample, spp, width);

    // Selection: translucent fill + edges.
    if (selection && selection.end > selection.start) {
      const x0 = sampleToPixel(selection.start, scrollSample, spp);
      const x1 = sampleToPixel(selection.end, scrollSample, spp);
      const left = Math.max(0, Math.min(x0, x1));
      const right = Math.min(width, Math.max(x0, x1));
      if (right > left) {
        // G6: --accent-soft fill with --accent-ring edges (mirrors
        // drawSelection in waveformRender.ts).
        ctx.fillStyle = cssToken('--accent-soft', 'rgba(38,198,218,0.14)');
        ctx.fillRect(left, 0, right - left, height);
        ctx.lineWidth = 1;
        ctx.strokeStyle = cssToken('--accent-ring', 'rgba(38,198,218,0.35)');
        if (x0 >= 0 && x0 <= width) verticalLine(ctx, x0, height);
        if (x1 >= 0 && x1 <= width) verticalLine(ctx, x1, height);
      }
    }

    // Markers: dashed line + triangle flag + name label (Task 23), same visuals
    // as the waveform view's renderWaveform (shared drawMarkers).
    drawMarkers(ctx, markers, height, scrollSample, spp, width);

    // Cursor (white) and playhead (accent + soft glow, G6 — mirrors
    // renderWaveform's playhead treatment).
    const cx = sampleToPixel(cursorSample, scrollSample, spp);
    if (cx >= 0 && cx <= width) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#ffffff';
      verticalLine(ctx, cx, height);
    }
    // F11-1: the same grab handle as the waveform view, from the same code —
    // the `drawMarkers` precedent. Two surfaces drawing their own triangle
    // would drift the moment either was touched.
    drawCursorHandle(ctx, cx, width);
    if (playback.state === 'playing') {
      const px = sampleToPixel(playback.positionSample, scrollSample, spp);
      if (px >= 0 && px <= width) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = cssToken('--accent', '#26c6da');
        ctx.shadowColor = cssToken('--accent-ring', 'rgba(38,198,218,0.35)');
        ctx.shadowBlur = 8;
        verticalLine(ctx, px, height);
        ctx.shadowBlur = 0;
        ctx.shadowColor = 'transparent';
      }
    }
  }, [
    magsData,
    size,
    zoom,
    selection,
    cursorSample,
    playback.state,
    playback.positionSample,
    markers,
    beatGrid,
  ]);

  // Every hook above runs unconditionally — see WaveformView for why this
  // bail-out is safe and what frame it covers.
  if (!doc) return null;

  // G6: stage insets on the root, canvas floating in a glass lane — same
  // no-padding rule as WaveformView so the gesture math is untouched.
  return (
    <div
      className="stage-inset flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="spectrogram-view"
    >
      {/* F11-2: same seek/scrub as the waveform view, same length clamp. */}
      <TimelineRuler sampleRate={doc.sampleRate} length={length} />
      <div ref={containerRef} className="glass-lane relative min-h-0 min-w-0 flex-1">
        <canvas
          ref={canvasRef}
          className="block h-full w-full"
          data-testid="spectrogram-canvas"
          onPointerDown={gestures.onPointerDown}
          onPointerMove={gestures.onPointerMove}
          onPointerUp={gestures.onPointerUp}
          onPointerCancel={gestures.onPointerUp}
        />
        {computeFailed && (
          <div
            data-testid="spectrogram-error"
            className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs"
            style={{ color: 'var(--glass-text-muted)' }}
          >
            Spectrogram failed
          </div>
        )}
      </div>
    </div>
  );
}
