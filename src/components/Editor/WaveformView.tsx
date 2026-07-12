import { useEffect, useRef, useState } from 'react';
import type { AudioDocument } from '../../audio/AudioDocument';
import { docLength } from '../../audio/AudioDocument';
import { useAppStore } from '../../stores/appStore';
import { getPyramids } from '../../services/peaksCache';
import { pixelToSample, renderWaveform } from './waveformRender';
import TimelineRuler from './TimelineRuler';

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

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#1a1a1e]" data-testid="waveform-view">
      <TimelineRuler sampleRate={doc.sampleRate} />
      <div ref={containerRef} className="relative min-h-0 min-w-0 flex-1">
        <canvas ref={canvasRef} className="block h-full w-full" data-testid="waveform-canvas" />
      </div>
    </div>
  );
}
