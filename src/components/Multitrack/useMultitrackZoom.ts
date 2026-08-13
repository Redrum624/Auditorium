import { useEffect } from 'react';
import type { RefObject } from 'react';
import { pixelToSample } from '../Editor/waveformRender';
import { applySessionZoom, useSessionStore } from '../../multitrack/sessionStore';

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
 * MT1-1 — THE CLAMPS ARE NOT HERE ANY MORE. This hook used to carry its own
 * `MIN_SPP`, its own `maxSpp = max(1, end/50)` ceiling, its own scroll bound and
 * its own private copy of `sessionEndSample`, none of which knew how wide the
 * lane was and all of which disagreed with the four places that wrote a flat
 * `{ samplesPerPixel: 512 }`. A limit that lives in one consumer is a limit the
 * other consumers can disagree with — the F11-9 lesson, and the reason "the
 * tracks should appear Fit on the longest one" could be true of the Fit button
 * and false of everything else. The gesture now states a REQUEST and
 * `applySessionZoom` answers it; `sessionZoom.ts` owns every bound.
 */

const ZOOM_FACTOR = 1.25;

export function useMultitrackZoom(laneRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = laneRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // Plain wheel is native vertical scroll — don't hijack it.
      if (!e.ctrlKey && !e.shiftKey) return;
      e.preventDefault();

      const { mtZoom } = useSessionStore.getState();

      if (e.shiftKey && !e.ctrlKey) {
        applySessionZoom({
          samplesPerPixel: mtZoom.samplesPerPixel,
          scrollSample: mtZoom.scrollSample + e.deltaY * mtZoom.samplesPerPixel,
        });
        return;
      }

      // Ctrl+wheel → zoom centered on the pointer. The scroll is a FUNCTION of
      // the resolved samples-per-pixel, not of the requested one: at the
      // zoom-out limit the two differ, and computing the anchor from a request
      // that was then clamped is exactly how the sample under the cursor drifts
      // out from under it.
      const rect = el.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const anchorSample = pixelToSample(mouseX, mtZoom.scrollSample, mtZoom.samplesPerPixel);
      const factor = e.deltaY < 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR;
      applySessionZoom({
        samplesPerPixel: mtZoom.samplesPerPixel * factor,
        scrollSample: (spp) => anchorSample - mouseX * spp,
      });
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [laneRef]);
}
