import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { AudioDocument } from '../../audio/AudioDocument';
import { docLength } from '../../audio/AudioDocument';
import { useAppStore } from '../../stores/appStore';
import { getPyramids } from '../../services/peaksCache';
import { pixelToSample, renderWaveform } from './waveformRender';
import { dragToSelection, exceedsDragThreshold, shiftClickAnchor } from './selectionGestures';
import TimelineRuler from './TimelineRuler';

/** Transient drag-selection state, kept in a ref (not store state) since it
 * only matters between pointerdown and pointerup. */
interface DragState {
  anchorSample: number;
  anchorX: number;
  /** Once true, a live selection is being drawn and pointerup must not clear it. */
  exceeded: boolean;
}

const MIN_SPP = 1 / 32;
const ZOOM_FACTOR = 1.25;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Core editor view: timeline ruler + waveform canvas with wheel zoom/scroll. */
export default function WaveformView({ doc }: { doc: AudioDocument }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const zoom = useAppStore((s) => s.zoom);
  const selection = useAppStore((s) => s.selection);
  const cursorSample = useAppStore((s) => s.cursorSample);
  const playback = useAppStore((s) => s.playback);

  const length = docLength(doc);

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

  // Redraw whenever the document data, view state, or size changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / no backend
    const { width, height } = size;
    if (width <= 0 || height <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const pyramids = getPyramids(doc);
    const playheadSample = playback.state === 'playing' ? playback.positionSample : null;

    renderWaveform(ctx, {
      width,
      height,
      channels: doc.channels,
      pyramids,
      scrollSample: zoom.scrollSample,
      samplesPerPixel: zoom.samplesPerPixel,
      selection,
      cursorSample,
      playheadSample,
    });
    // doc.channels identity, zoom, selection, cursor, playhead, size drive redraws.
  }, [
    doc,
    doc.channels,
    zoom,
    selection,
    cursorSample,
    playback.positionSample,
    playback.state,
    size,
  ]);

  // Native (non-passive) wheel listener so preventDefault works: plain/ctrl
  // wheel zooms centered on the mouse; shift-wheel scrolls horizontally.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = size.width;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { zoom: z, setZoom } = useAppStore.getState();
      const maxSpp = Math.max(1, length / 50);
      const maxScroll = (spp: number) => Math.max(0, length - width * spp);

      if (e.shiftKey) {
        const scrollSample = clamp(
          z.scrollSample + e.deltaY * z.samplesPerPixel,
          0,
          maxScroll(z.samplesPerPixel)
        );
        setZoom({ samplesPerPixel: z.samplesPerPixel, scrollSample });
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const anchorSample = pixelToSample(mouseX, z.scrollSample, z.samplesPerPixel);
      const factor = e.deltaY < 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR;
      const spp = clamp(z.samplesPerPixel * factor, MIN_SPP, maxSpp);
      // Keep the sample under the cursor stationary.
      const scrollSample = clamp(anchorSample - mouseX * spp, 0, maxScroll(spp));
      setZoom({ samplesPerPixel: spp, scrollSample });
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [size.width, length]);

  const dragRef = useRef<DragState | null>(null);

  function sampleAtClientX(clientX: number): { x: number; sample: number } {
    const canvas = canvasRef.current;
    const rect = canvas ? canvas.getBoundingClientRect() : { left: 0 };
    const x = clientX - rect.left;
    const sample = clamp(pixelToSample(x, zoom.scrollSample, zoom.samplesPerPixel), 0, length);
    return { x, sample };
  }

  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x, sample } = sampleAtClientX(e.clientX);
    const { setCursor, setSelection } = useAppStore.getState();

    setCursor(sample);

    if (e.detail >= 2) {
      // Double-click: select the entire document.
      setSelection(length > 0 ? { start: 0, end: length } : null);
      dragRef.current = null;
      return;
    }

    if (typeof canvas.setPointerCapture === 'function') {
      canvas.setPointerCapture(e.pointerId);
    }

    if (e.shiftKey) {
      const anchor = shiftClickAnchor(sample, selection, cursorSample);
      dragRef.current = { anchorSample: anchor, anchorX: x, exceeded: true };
      setSelection(dragToSelection(anchor, sample));
    } else {
      dragRef.current = { anchorSample: sample, anchorX: x, exceeded: false };
    }
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { x, sample } = sampleAtClientX(e.clientX);

    if (!drag.exceeded) {
      if (!exceedsDragThreshold(drag.anchorX, x)) return;
      drag.exceeded = true;
    }
    useAppStore.getState().setSelection(dragToSelection(drag.anchorSample, sample));
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (canvas && typeof canvas.releasePointerCapture === 'function') {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        // Capture may already have been released (e.g. lost on blur); ignore.
      }
    }
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && !drag.exceeded) {
      // Plain click with no movement: clears any existing selection.
      useAppStore.getState().setSelection(null);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#1a1a1e]" data-testid="waveform-view">
      <TimelineRuler sampleRate={doc.sampleRate} />
      <div ref={containerRef} className="relative min-h-0 min-w-0 flex-1">
        <canvas
          ref={canvasRef}
          className="block h-full w-full"
          data-testid="waveform-canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      </div>
    </div>
  );
}
