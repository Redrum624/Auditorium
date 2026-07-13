import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { useAppStore } from '../../stores/appStore';
import { pixelToSample } from './waveformRender';
import { dragToSelection, exceedsDragThreshold, shiftClickAnchor } from './selectionGestures';

/**
 * Shared editor pointer/wheel gestures for the waveform and spectrogram views:
 * plain/ctrl wheel zooms centered on the mouse, shift-wheel scrolls; click sets
 * the cursor, drag past 3px makes a selection, shift-click extends, double-click
 * selects all. All state lives in the app store; the only transient (the active
 * drag) is a ref. Reuses the pure helpers in selectionGestures/waveformRender so
 * both views behave identically.
 */

const MIN_SPP = 1 / 32;
const ZOOM_FACTOR = 1.25;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

interface DragState {
  anchorSample: number;
  anchorX: number;
  exceeded: boolean;
}

export interface EditorGestureHandlers {
  onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>): void;
  onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>): void;
  onPointerUp(e: ReactPointerEvent<HTMLCanvasElement>): void;
}

export function useEditorGestures(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  length: number,
  width: number
): EditorGestureHandlers {
  const zoom = useAppStore((s) => s.zoom);
  const selection = useAppStore((s) => s.selection);
  const cursorSample = useAppStore((s) => s.cursorSample);

  // Native (non-passive) wheel listener so preventDefault works.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

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
      const scrollSample = clamp(anchorSample - mouseX * spp, 0, maxScroll(spp));
      setZoom({ samplesPerPixel: spp, scrollSample });
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [canvasRef, width, length]);

  const dragRef = useRef<DragState | null>(null);

  function sampleAtClientX(clientX: number): { x: number; sample: number } {
    const canvas = canvasRef.current;
    const rect = canvas ? canvas.getBoundingClientRect() : { left: 0 };
    const x = clientX - rect.left;
    const sample = clamp(pixelToSample(x, zoom.scrollSample, zoom.samplesPerPixel), 0, length);
    return { x, sample };
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x, sample } = sampleAtClientX(e.clientX);
    const { setCursor, setSelection } = useAppStore.getState();

    setCursor(sample);

    if (e.detail >= 2) {
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

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { x, sample } = sampleAtClientX(e.clientX);

    if (!drag.exceeded) {
      if (!exceedsDragThreshold(drag.anchorX, x)) return;
      drag.exceeded = true;
    }
    useAppStore.getState().setSelection(dragToSelection(drag.anchorSample, sample));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
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
      useAppStore.getState().setSelection(null);
    }
  };

  return { onPointerDown, onPointerMove, onPointerUp };
}
