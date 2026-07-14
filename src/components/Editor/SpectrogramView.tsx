import { useEffect, useRef, useState } from 'react';
import type { AudioDocument } from '../../audio/AudioDocument';
import { docLength, mixDown } from '../../audio/AudioDocument';
import { useAppStore } from '../../stores/appStore';
import { createSpectrogramWorker } from '../../workers/createSpectrogramWorker';
import { useSpectralScale } from '../../services/spectralScale';
import { drawMarkers, sampleToPixel } from './waveformRender';
import { useEditorGestures } from './useEditorGestures';
import TimelineRuler from './TimelineRuler';
import type { Marker } from '../../stores/appStore';

// Stable empty-array reference — see WaveformView.tsx for why this must not
// be a fresh `[]` literal in the selector (infinite render loop otherwise).
const NO_MARKERS: Marker[] = [];

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
 * -90..0 dB range, and painted via `putImageData` (which ignores the canvas
 * transform, so it's drawn at raw device-pixel size) with translucent
 * selection, marker, cursor, and playhead overlays on top, drawn in CSS-pixel
 * space under a `ctx.setTransform(dpr, ...)` scale (mirrors WaveformView).
 */
export default function SpectrogramView({ doc }: { doc: AudioDocument }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [magsData, setMagsData] = useState<MagsData | null>(null);

  const zoom = useAppStore((s) => s.zoom);
  const selection = useAppStore((s) => s.selection);
  const cursorSample = useAppStore((s) => s.cursorSample);
  const playback = useAppStore((s) => s.playback);
  const markers = useAppStore((s) => s.markers[doc.id] ?? NO_MARKERS);
  const scale = useSpectralScale();

  const length = docLength(doc);
  const gestures = useEditorGestures(canvasRef, length, size.width);

  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);

  // Observe the drawing area size (CSS pixels).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // One worker per mount; stale replies (older request ids) are ignored.
  useEffect(() => {
    const worker = createSpectrogramWorker();
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as SpectroDone;
      if (!msg || msg.type !== 'done' || msg.id !== reqIdRef.current) return;
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
      const mono = mixDown(doc.channels);
      const id = ++reqIdRef.current;
      worker.postMessage(
        {
          type: 'compute',
          id,
          channel: mono,
          sampleRate: doc.sampleRate,
          startSample: start,
          endSample: end,
          width,
          height,
          fftSize: FFT_SIZE,
          scale,
        },
        [mono.buffer]
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [doc, doc.channels, doc.sampleRate, length, zoom, size, scale]);

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

    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, width, height);
    if (magsData) drawSpectrogram(ctx, magsData, backingWidth, backingHeight);

    const { samplesPerPixel: spp, scrollSample } = zoom;

    // Selection: translucent fill + edges.
    if (selection && selection.end > selection.start) {
      const x0 = sampleToPixel(selection.start, scrollSample, spp);
      const x1 = sampleToPixel(selection.end, scrollSample, spp);
      const left = Math.max(0, Math.min(x0, x1));
      const right = Math.min(width, Math.max(x0, x1));
      if (right > left) {
        ctx.fillStyle = 'rgba(38,198,218,0.18)';
        ctx.fillRect(left, 0, right - left, height);
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#26c6da';
        if (x0 >= 0 && x0 <= width) verticalLine(ctx, x0, height);
        if (x1 >= 0 && x1 <= width) verticalLine(ctx, x1, height);
      }
    }

    // Markers: dashed line + triangle flag + name label (Task 23), same visuals
    // as the waveform view's renderWaveform (shared drawMarkers).
    drawMarkers(ctx, markers, height, scrollSample, spp, width);

    // Cursor (white) and playhead (yellow).
    const cx = sampleToPixel(cursorSample, scrollSample, spp);
    if (cx >= 0 && cx <= width) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#ffffff';
      verticalLine(ctx, cx, height);
    }
    if (playback.state === 'playing') {
      const px = sampleToPixel(playback.positionSample, scrollSample, spp);
      if (px >= 0 && px <= width) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#ffd54f';
        verticalLine(ctx, px, height);
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
  ]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#1a1a1e]" data-testid="spectrogram-view">
      <TimelineRuler sampleRate={doc.sampleRate} />
      <div ref={containerRef} className="relative min-h-0 min-w-0 flex-1">
        <canvas
          ref={canvasRef}
          className="block h-full w-full"
          data-testid="spectrogram-canvas"
          onPointerDown={gestures.onPointerDown}
          onPointerMove={gestures.onPointerMove}
          onPointerUp={gestures.onPointerUp}
          onPointerCancel={gestures.onPointerUp}
        />
      </div>
    </div>
  );
}
