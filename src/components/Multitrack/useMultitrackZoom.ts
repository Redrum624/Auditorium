import { useEffect } from 'react';
import type { RefObject } from 'react';
import { applySessionZoom, useSessionStore } from '../../multitrack/sessionStore';
import { sessionLaneWidth } from '../../multitrack/sessionViewport';
import { anchoredZoom } from '../../services/zoomAnchor';

/**
 * Wheel zoom/scroll for the multitrack lanes, driven by the session store's
 * `mtZoom` (its own zoom source, independent of the single-document editor's
 * app-store zoom). Deliberately NOT the waveform's `useEditorGestures`: that
 * hook is bound to the app store and to selection-drag semantics that the lanes
 * don't have. Since D1 it shares the pure `anchoredZoom` helper instead.
 *
 * Bindings (the timeline is open-ended, and plain wheel is left for native
 * vertical track scrolling):
 *   - Ctrl + wheel  → horizontal zoom anchored on the multitrack cursor (D1)
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

      const { mtZoom, mtCursorSample } = useSessionStore.getState();

      if (e.shiftKey && !e.ctrlKey) {
        applySessionZoom({
          samplesPerPixel: mtZoom.samplesPerPixel,
          scrollSample: mtZoom.scrollSample + e.deltaY * mtZoom.samplesPerPixel,
        });
        return;
      }

      // D1 — Ctrl+wheel zooms toward the BAR, not toward the pointer. It used
      // to read `e.clientX` off the lane rect; the user asked for "focus on
      // where the line was put", and one rule on every zoom path means this
      // gesture and the toolbar's −/+ can no longer land in different places.
      // `anchoredZoom` also owns the resolved-spp contract (see its docblock).
      applySessionZoom(
        anchoredZoom({
          zoom: mtZoom,
          laneWidth: sessionLaneWidth(),
          anchorSample: mtCursorSample,
          factor: e.deltaY < 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR,
        })
      );
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [laneRef]);
}
