import { useEffect } from 'react';
import type { RefObject } from 'react';
import { pixelToSample } from '../Editor/waveformRender';
import { useSessionStore } from '../../multitrack/sessionStore';
import type { Session } from '../../multitrack/session';

/**
 * Wheel zoom/scroll for the multitrack lanes, driven by the session store's
 * `mtZoom` (its own zoom source, independent of the single-document editor's
 * app-store zoom). Deliberately NOT the waveform's `useEditorGestures`: that
 * hook is bound to the app store and to selection-drag semantics that the lanes
 * don't have. This shares only the pure `pixelToSample` helper.
 *
 * Bindings (the timeline is open-ended, and plain wheel is left for native
 * vertical track scrolling):
 *   - Ctrl + wheel  → horizontal zoom centered on the pointer
 *   - Shift + wheel → horizontal scroll
 *   - plain wheel   → native vertical scroll (not intercepted)
 *
 * Clamps (per the Task 22 spec): samplesPerPixel ∈ [1/32, max(1, end/50)] where
 * `end` is the last clip end (or 60 s worth of samples for an empty session);
 * scrollSample ∈ [0, max(0, end + 60 s)].
 */

const MIN_SPP = 1 / 32;
const ZOOM_FACTOR = 1.25;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function sessionEndSample(session: Session): number {
  let end = 0;
  for (const t of session.tracks) {
    for (const c of t.clips) end = Math.max(end, c.startSample + c.lengthSample);
  }
  return end;
}

export function useMultitrackZoom(laneRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = laneRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // Plain wheel is native vertical scroll — don't hijack it.
      if (!e.ctrlKey && !e.shiftKey) return;
      e.preventDefault();

      const { session, mtZoom, setMtZoom } = useSessionStore.getState();
      const sr = session.sampleRate;
      const end = sessionEndSample(session);
      const effectiveEnd = end > 0 ? end : 60 * sr;
      const maxSpp = Math.max(1, effectiveEnd / 50);
      const maxScroll = Math.max(0, effectiveEnd + 60 * sr);

      if (e.shiftKey && !e.ctrlKey) {
        const scrollSample = clamp(
          mtZoom.scrollSample + e.deltaY * mtZoom.samplesPerPixel,
          0,
          maxScroll
        );
        setMtZoom({ samplesPerPixel: mtZoom.samplesPerPixel, scrollSample });
        return;
      }

      // Ctrl+wheel → zoom centered on the pointer.
      const rect = el.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const anchorSample = pixelToSample(mouseX, mtZoom.scrollSample, mtZoom.samplesPerPixel);
      const factor = e.deltaY < 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR;
      const spp = clamp(mtZoom.samplesPerPixel * factor, MIN_SPP, maxSpp);
      const scrollSample = clamp(anchorSample - mouseX * spp, 0, maxScroll);
      setMtZoom({ samplesPerPixel: spp, scrollSample });
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [laneRef]);
}
