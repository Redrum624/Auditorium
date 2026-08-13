import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useAppStore } from '../../stores/appStore';
import { formatTime } from '../../utils/timeFormat';
import { snapSample } from '../../services/snap';
import { editorSnapTargets } from './editorSnapTargets';
import { cssToken, pixelToSample, sampleToPixel } from './waveformRender';

/** F11-2 — the editor's own targets, read fresh at each pointerdown. Module
 * scope so the default prop value is a stable reference. */
function defaultSnapTargets(): number[] {
  return editorSnapTargets(useAppStore.getState().activeDocumentId);
}

const RULER_H = 24;
const MIN_TICK_PX = 80;
// Candidate tick spacings in seconds (ascending).
const TICK_STEPS = [0.001, 0.01, 0.1, 0.5, 1, 5, 10, 30, 60, 300];

interface Zoom {
  samplesPerPixel: number;
  scrollSample: number;
}

interface TimelineRulerProps {
  sampleRate: number;
  /** External zoom source (multitrack lanes). Defaults to the app store's zoom
   * (single-document editor) when omitted. */
  zoom?: Zoom;
  /** Seek handler for a ruler click. Defaults to the app store's setCursor. */
  onSeek?: (sample: number) => void;
  /**
   * F11-2 — the magnet's targets for a ruler seek, resolved once per gesture.
   * A THUNK, not an array: it is read at pointerdown and then frozen for the
   * whole scrub (an analysis completing mid-drag must not move the pointer
   * under the user's hand — the same rule `useEditorGestures` keeps), and a
   * prop-shaped array would be rebuilt on every render of every parent.
   *
   * Defaults to the editor's own targets. The multitrack passes its session
   * targets, because the two surfaces have different zooms AND different
   * targets, and a helper that reached for "the" set would quantise one at the
   * other's scale (snap.ts, trap 26).
   */
  snapTargets?: () => number[];
  /** F11-2 — the seekable length in samples; a seek is clamped to it. Omitted
   * means "clamp at zero only", which is what the ruler has always done. */
  length?: number;
}

/**
 * 24px time ruler. Shares a zoom source (app store by default, or the passed
 * multitrack zoom). Ticks are chosen so labels stay >= 80px apart.
 *
 * F11-2 — "clicking on a time on the timeline at the top should bring this
 * line there". It did already, on `click`. Three things were missing and are
 * here now: the seek happens on POINTERDOWN (a click fires after the button
 * comes back up, so the line lagged the press); holding and moving SCRUBS the
 * cursor live, which falls straight out of the same handler; and the position
 * is quantised by the same B4 magnet that the lane's own cursor placement uses,
 * with the same Alt escape hatch — a ruler that ignored the magnet would put
 * the cursor somewhere the lane could not.
 *
 * Playback is deliberately untouched. Moving the cursor has never re-seeked a
 * running `PlaybackEngine` (nothing in `transportService` watches
 * `cursorSample`; the cursor is where the NEXT play starts), and inventing that
 * semantic here would be a new transport behaviour hidden inside a ruler.
 */
export default function TimelineRuler({
  sampleRate,
  zoom: zoomProp,
  onSeek,
  snapTargets,
  length,
}: TimelineRulerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(0);

  const storeZoom = useAppStore((s) => s.zoom);
  const storeSetCursor = useAppStore((s) => s.setCursor);
  const zoom = zoomProp ?? storeZoom;
  const seek = onSeek ?? storeSetCursor;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / no backend
    if (width <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(RULER_H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // G6: transparent over the radial stage (the ruler is muted chrome text
    // above the lane, mockup `.timeline`); resizing above already cleared.
    ctx.clearRect(0, 0, width, RULER_H);

    const { samplesPerPixel, scrollSample } = zoom;
    const secPerPixel = samplesPerPixel / sampleRate;
    let stepSec = TICK_STEPS[TICK_STEPS.length - 1];
    for (const s of TICK_STEPS) {
      if (s / secPerPixel >= MIN_TICK_PX) {
        stepSec = s;
        break;
      }
    }

    const stepSamples = stepSec * sampleRate;
    const endSample = scrollSample + width * samplesPerPixel;
    const firstTick = Math.ceil(scrollSample / stepSamples) * stepSamples;

    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.fillStyle = cssToken('--glass-text-muted', '#7a7a82');
    ctx.font = '10px monospace';
    ctx.lineWidth = 1;
    for (let s = firstTick; s <= endSample; s += stepSamples) {
      const x = sampleToPixel(s, scrollSample, samplesPerPixel);
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 6);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      ctx.fillText(formatTime(Math.round(s), sampleRate), x + 3, 12);
    }
  }, [zoom, width, sampleRate]);

  // F11-2 — the live scrub. The targets frozen at pointerdown; `null` means no
  // scrub is in progress. A ref, not state: a scrub must not re-render the
  // ruler on every pointermove (the canvas repaint is driven by zoom/width).
  const scrubTargets = useRef<number[] | null>(null);

  /** Where a pointer at `clientX` lands, after the magnet and the clamps. */
  function sampleAt(el: HTMLElement, clientX: number, targets: number[], alt: boolean): number {
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    const clampToTrack = (s: number) =>
      Math.min(Math.max(s, 0), length === undefined ? Number.POSITIVE_INFINITY : length);

    const raw = clampToTrack(pixelToSample(x, zoom.scrollSample, zoom.samplesPerPixel));
    // Alt suspends, exactly as it does in the lane; an empty target set makes
    // this a `snapSample` call that provably returns its input, so the branch
    // is about intent rather than about cost.
    const snapped =
      alt || targets.length === 0
        ? raw
        : clampToTrack(snapSample(raw, targets, zoom.samplesPerPixel).sample);
    // Rounded, as the ruler's seek has always been. Every snap target is
    // integral already, so this only ever rounds an UNSNAPPED position.
    return Math.round(snapped);
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const targets = (snapTargets ?? defaultSnapTargets)();
    scrubTargets.current = targets;
    if (typeof el.setPointerCapture === 'function') el.setPointerCapture(e.pointerId);
    seek(sampleAt(el, e.clientX, targets, e.altKey));
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const targets = scrubTargets.current;
    if (!targets) return; // hovering, not scrubbing
    seek(sampleAt(e.currentTarget, e.clientX, targets, e.altKey));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    scrubTargets.current = null;
    const el = e.currentTarget;
    if (typeof el.releasePointerCapture === 'function') {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // Capture may already have been released (lost on blur); ignore.
      }
    }
  };

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      // F11-2: it is a scrub surface now, not a text-ish strip.
      className="mb-1 h-6 shrink-0 cursor-ew-resize"
      data-testid="timeline-ruler"
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
