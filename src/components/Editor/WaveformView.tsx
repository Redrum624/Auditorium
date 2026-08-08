import { useEffect, useRef, useState } from 'react';
import type { AudioDocument } from '../../audio/AudioDocument';
import { docLength } from '../../audio/AudioDocument';
import { useAppStore } from '../../stores/appStore';
import { getPyramids } from '../../services/peaksCache';
import { renderWaveform } from './waveformRender';
import { useBeatGridOverlay } from './useBeatGridOverlay';
import { useEditorGestures } from './useEditorGestures';
import TimelineRuler from './TimelineRuler';
import type { Marker } from '../../stores/appStore';

// Stable empty-array reference: `s.markers[doc.id] ?? []` would otherwise
// allocate a NEW array on every selector call when the doc has no markers,
// which breaks useSyncExternalStore's snapshot-equality check and causes an
// infinite render loop ("Maximum update depth exceeded").
const NO_MARKERS: Marker[] = [];

/** Core editor view: timeline ruler + waveform canvas with wheel zoom/scroll. */
export default function WaveformView({ doc }: { doc: AudioDocument }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const zoom = useAppStore((s) => s.zoom);
  const selection = useAppStore((s) => s.selection);
  const cursorSample = useAppStore((s) => s.cursorSample);
  const playback = useAppStore((s) => s.playback);
  const markers = useAppStore((s) => s.markers[doc.id] ?? NO_MARKERS);
  // Task B2: the beat tics. `null` (and free) whenever the toggle is off or no
  // analysis is cached — reading it never starts one.
  const beatGrid = useBeatGridOverlay(doc.id, doc.channels);

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
      markers,
      beatGrid,
    });
    // doc.channels identity, zoom, selection, cursor, playhead, markers, beat
    // grid, size drive redraws. `beatGrid` is memoised by useBeatGridOverlay,
    // so it only changes when the grid or the toggle actually does.
  }, [
    doc,
    doc.channels,
    zoom,
    selection,
    cursorSample,
    playback.positionSample,
    playback.state,
    markers,
    beatGrid,
    size,
  ]);

  // G6: the view sits on the radial stage — the root carries the stage insets
  // (clearance for the floating chrome) and the canvas floats in a rounded
  // glass lane. The lane has NO padding/border (see .glass-lane): the canvas
  // rect IS the lane content box, so the clientX→sample gesture math in
  // useEditorGestures is untouched.
  return (
    <div
      className="stage-inset flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="waveform-view"
    >
      <TimelineRuler sampleRate={doc.sampleRate} />
      <div ref={containerRef} className="glass-lane relative min-h-0 min-w-0 flex-1">
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
