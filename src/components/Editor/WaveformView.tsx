import { useEffect, useRef, useState } from 'react';
import type { AudioDocument } from '../../audio/AudioDocument';
import { docLength } from '../../audio/AudioDocument';
import { useAppStore } from '../../stores/appStore';
import { getPyramids } from '../../services/peaksCache';
import { renderWaveform } from './waveformRender';
import { useEditorGestures } from './useEditorGestures';
import TimelineRuler from './TimelineRuler';

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
  const gestures = useEditorGestures(canvasRef, length, size.width);

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

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#1a1a1e]" data-testid="waveform-view">
      <TimelineRuler sampleRate={doc.sampleRate} />
      <div ref={containerRef} className="relative min-h-0 min-w-0 flex-1">
        <canvas
          ref={canvasRef}
          className="block h-full w-full"
          data-testid="waveform-canvas"
          onPointerDown={gestures.onPointerDown}
          onPointerMove={gestures.onPointerMove}
          onPointerUp={gestures.onPointerUp}
          onPointerCancel={gestures.onPointerUp}
        />
      </div>
    </div>
  );
}
