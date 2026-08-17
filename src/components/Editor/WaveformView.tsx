import { useEffect, useRef, useState } from 'react';
import { docLength } from '../../audio/AudioDocument';
import { publishEditorLaneWidth, useAppStore } from '../../stores/appStore';
import { getPyramids } from '../../services/peaksCache';
import { renderWaveform } from './waveformRender';
import { useBeatGridOverlay } from './useBeatGridOverlay';
import { useEditorGestures } from './useEditorGestures';
import TimelineRuler from './TimelineRuler';
import TranscriptRibbon from './TranscriptRibbon';
import type { Marker } from '../../stores/appStore';

// Stable empty-array reference: `s.markers[doc.id] ?? []` would otherwise
// allocate a NEW array on every selector call when the doc has no markers,
// which breaks useSyncExternalStore's snapshot-equality check and causes an
// infinite render loop ("Maximum update depth exceeded").
const NO_MARKERS: Marker[] = [];
/** Stable empty channel list for the frame in which `docId` resolves to
 * nothing — same reason as NO_MARKERS: it is a memo dep in
 * `useBeatGridOverlay`, so a fresh `[]` would invalidate it every render. */
const NO_CHANNELS: Float32Array[] = [];

/**
 * Core editor view: timeline ruler + waveform canvas with wheel zoom/scroll.
 *
 * F11-0 — takes the document's **id**, not the document. The whole
 * `AudioDocument` used to be the prop, which put a `Float32Array[]` of up to
 * 65 MiB into React's props object. That is a genuine design problem on its own
 * (an object graph that size defeats prop memoisation and hangs DevTools' prop
 * inspector), and in React 19's DEV react-dom it was a hard wedge: the render
 * profiler serialises CHANGED props into `performance.measure`'s `detail`, and
 * a typed array walks as ~one entry per sample. The second large-document
 * change threw `DataCloneError` out of `flushPassiveEffects` before
 * `executionContext` was restored, and the renderer never rendered again. See
 * `src/dev/userTimingGuard.ts` for the full mechanism and the dev-only
 * backstop. Resolving the document from the store here collapses the prop to a
 * string and the profiler's diff to two cheap entries.
 */
export default function WaveformView({ docId }: { docId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // The document, straight from the store. `find` returns the SAME object
  // reference until `updateDocument` replaces it, so this selector is stable
  // under zustand's Object.is snapshot check — exactly as `documents` itself is
  // in App.tsx.
  const doc = useAppStore((s) => s.documents.find((d) => d.id === docId) ?? null);
  const zoom = useAppStore((s) => s.zoom);
  const selection = useAppStore((s) => s.selection);
  const cursorSample = useAppStore((s) => s.cursorSample);
  const playback = useAppStore((s) => s.playback);
  const markers = useAppStore((s) => s.markers[docId] ?? NO_MARKERS);
  // Task B2: the beat tics. `null` (and free) whenever the toggle is off or no
  // analysis is cached — reading it never starts one.
  const beatGrid = useBeatGridOverlay(docId, doc?.channels ?? NO_CHANNELS);

  const length = doc ? docLength(doc) : 0;
  const gestures = useEditorGestures(canvasRef, length);

  // Observe the drawing area size (CSS pixels).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const width = el.clientWidth;
      setSize({ width, height: el.clientHeight });
      // F11-3: this lane IS the stage the zoom fits to. Nothing else in the app
      // knows how wide it is, so it is published here — the store's fit and its
      // zoom-out limit are both derived from it, and a document that was fitted
      // to the 1600 px fallback (opened before any lane existed) is re-fitted
      // the moment this first fires. Recordings, stems, remixes and mixdowns
      // all arrive through `addDocument`, so they are fitted by the same path.
      publishEditorLaneWidth(width);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Redraw whenever the document data, view state, or size changes.
  useEffect(() => {
    if (!doc) return;
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
    doc?.channels,
    zoom,
    selection,
    cursorSample,
    playback.positionSample,
    playback.state,
    markers,
    beatGrid,
    size,
  ]);

  // Every hook above runs unconditionally, so this bail-out never changes the
  // hook order. It only covers the frame between a document closing and App
  // swapping this view out.
  if (!doc) return null;

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
      {/* F11-2: the ruler seeks and scrubs against THIS document's length. */}
      <TimelineRuler sampleRate={doc.sampleRate} length={length} />
      <TranscriptRibbon />
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
