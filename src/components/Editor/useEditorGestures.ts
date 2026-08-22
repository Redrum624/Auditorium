import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { applyEditorZoom, useAppStore } from '../../stores/appStore';
import { snapSample } from '../../services/snap';
import { segmentAt } from '../../services/segments';
import { isOnCursorHandle, pixelToSample, sampleToPixel } from './waveformRender';
import { editorSnapTargets } from './editorSnapTargets';
import { dragToSelection, exceedsDragThreshold, shiftClickAnchor } from './selectionGestures';

/**
 * Shared editor pointer/wheel gestures for the waveform and spectrogram views:
 * plain/ctrl wheel zooms centered on the mouse, shift-wheel scrolls; click sets
 * the cursor, drag past 3px makes a selection, shift-click extends, double-click
 * selects the segment under the pointer (item 8 / M3: the span between the two
 * nearest markers; the whole document when there are none). All state lives in
 * the app store; the only transient (the active drag) is a ref. Reuses the pure
 * helpers in selectionGestures/waveformRender so both views behave identically.
 *
 * ---------------------------------------------------------------------------
 * TASK B4 — THE MAGNET
 * ---------------------------------------------------------------------------
 * Cursor placement and the moving edge of a selection are quantised onto the
 * nearest beat or marker within {@link SNAP_TOLERANCE_PX} SCREEN pixels
 * (`snap.ts`). Three properties are load-bearing:
 *
 *  - **The anchor never moves.** Only the position the pointer is currently at
 *    is snapped. The selection anchor is snapped once, at pointerdown (the user
 *    pointed at it), and then used verbatim for the rest of the drag; a
 *    shift+click's anchor — an existing selection edge or the existing cursor —
 *    is never touched at all. "Snap must never move something the user did not
 *    drag."
 *  - **The zoom is passed in, never looked up globally** (trap 26). This hook
 *    uses the app store's `zoom.samplesPerPixel`; the multitrack passes its own
 *    `mtZoom`. A helper that reached for "the" zoom would quantise one surface
 *    at the other's scale.
 *  - **The modifier is re-read on EVERY pointer event** (trap: latching it at
 *    pointerdown breaks the escape hatch, and there is no key listener in the
 *    renderer to fall back on). Chromium puts the live modifier state on every
 *    pointer event, so `e.altKey` gives "suspended while held" — including
 *    pressing Alt in the middle of a drag and releasing it again — with no
 *    global listener to install, leak or race with pointer capture.
 *
 * **Alt was verified free in the BUILT app**, not assumed: the Electron default
 * menu is indeed still installed (`Menu.getApplicationMenu()` returns
 * File/Edit/View/Window — it was never disabled), but the window is frameless
 * (`electron/main.cjs`, `frame: false`), so there is no menu bar for Alt to
 * toggle: `win.isMenuBarVisible()` is false before and after, focus stays in
 * the document, and a `keydown`/`pointerdown` pair while Alt is held arrives in
 * the renderer with `altKey: true` and `defaultPrevented: false`.
 *
 * The target set is captured once, at pointerdown (`editorSnapTargets`), and
 * reused for the whole drag: it is a cached read, but it must also be STABLE —
 * an analysis completing mid-drag must not move the pointer under the user's
 * hand.
 */

// Exported since G3: the toolbar's zoom −/+ buttons step by the same factor as
// the wheel gesture, so both paths agree. The LIMITS moved to the store in
// F11-9 (`MIN_SPP`, `fitSamplesPerPixel`, `resolveZoom`): a clamp that lived in
// each consumer is a clamp each consumer could state differently, and this hook
// and the toolbar did exactly that.
export const ZOOM_FACTOR = 1.25;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** The snap targets as they stood when the drag began (B4). Empty whenever
 * the magnet is off or there is nothing to snap to, which makes the whole
 * feature a single `snapSample` call that provably returns its input. */
type SnapTargets = number[];

/**
 * F11-1 made this a union. `select` is the gesture that has always been here —
 * press places the cursor, 3 px of travel turns it into a selection. `playhead`
 * is the new one: the press landed on the cursor's grab handle, so the whole
 * gesture is "move the cursor", the selection is never touched, and there is no
 * drag threshold (the user grabbed a handle; they already committed).
 */
type DragState =
  | {
      kind: 'select';
      anchorSample: number;
      anchorX: number;
      exceeded: boolean;
      targets: SnapTargets;
    }
  | { kind: 'playhead'; targets: SnapTargets };

/** True while the escape-hatch modifier is held on THIS event. Alt, verified
 * free against the built app — see the hook's header. */
function snapSuspended(e: { altKey: boolean }): boolean {
  return e.altKey;
}

export interface EditorGestureHandlers {
  onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>): void;
  onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>): void;
  onPointerUp(e: ReactPointerEvent<HTMLCanvasElement>): void;
}

/**
 * F11-9 — no `width` parameter any more. The lane width used to be threaded in
 * purely so the wheel handler could compute its own scroll ceiling; the views
 * publish it to the store instead (`publishEditorLaneWidth`), and the ceiling
 * is computed once, in `resolveZoom`.
 */
export function useEditorGestures(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  length: number
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
      // F11-9: the gesture states what it WANTS; the store resolves it. There
      // is no maxSpp and no maxScroll here any more — the wheel used to clamp
      // to `length / 50`, which let the view zoom 32x past the point where the
      // waveform stops changing while the tics and the ruler kept moving.
      const z = useAppStore.getState().zoom;

      if (e.shiftKey) {
        applyEditorZoom({
          samplesPerPixel: z.samplesPerPixel,
          scrollSample: z.scrollSample + e.deltaY * z.samplesPerPixel,
        });
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const anchorSample = pixelToSample(mouseX, z.scrollSample, z.samplesPerPixel);
      const factor = e.deltaY < 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR;
      applyEditorZoom({
        samplesPerPixel: z.samplesPerPixel * factor,
        // Anchored on the RESOLVED spp, so the sample under the pointer stays
        // under the pointer even when the request was clamped.
        scrollSample: (spp) => anchorSample - mouseX * spp,
      });
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [canvasRef]);

  const dragRef = useRef<DragState | null>(null);

  /** Raw pixel→sample for a client x, clamped to the document. No snapping —
   * the wheel gesture and the drag-threshold test both want the true pointer
   * position, and quantising the threshold would make the magnet's own pull
   * count as a drag. */
  function sampleAtClientX(clientX: number): { x: number; sample: number } {
    const canvas = canvasRef.current;
    const rect = canvas ? canvas.getBoundingClientRect() : { left: 0 };
    const x = clientX - rect.left;
    const sample = clamp(pixelToSample(x, zoom.scrollSample, zoom.samplesPerPixel), 0, length);
    return { x, sample };
  }

  /** F11-1: lane-local y for a client y. The lane's content box IS the canvas
   * rect (`.glass-lane` has no padding or border — see WaveformView's note), so
   * this needs no correction beyond the rect's own top. */
  function yAtClientY(clientY: number): number {
    const canvas = canvasRef.current;
    const rect = canvas ? canvas.getBoundingClientRect() : { top: 0 };
    return clientY - rect.top;
  }

  /** F11-1: is this pointer on the cursor's grab handle? The hit rule lives in
   * `waveformRender` beside the drawing it has to agree with. */
  function onHandle(x: number, y: number): boolean {
    return isOnCursorHandle(
      x,
      y,
      sampleToPixel(cursorSample, zoom.scrollSample, zoom.samplesPerPixel)
    );
  }

  /** F11-1: cursor feedback, written straight to the element rather than held
   * in React state — this runs on every pointermove over the lane, and a state
   * update per move would re-render (and repaint) the whole waveform to change
   * a CSS property. Cleared to '' so the element falls back to its class. */
  function setLaneCursor(value: '' | 'grab' | 'grabbing'): void {
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = value;
  }

  /** The position a gesture should COMMIT for a raw sample: the nearest target
   * within tolerance, or the raw value. The clamp is re-applied because a
   * document truncated after its analysis can leave a target past the current
   * end; with an intact document every target is already in range and the clamp
   * is a no-op.
   *
   * PW1: ROUNDED, on both arms. `raw` comes from `pixelToSample`, so it is a
   * fraction of a sample whenever the magnet is suspended (Alt) or the document
   * has no snap targets at all — and this function's result is committed
   * straight to `setCursor` and to `dragToSelection`, so both the cursor and a
   * dragged selection could sit BETWEEN two samples. That is not a display nit:
   * `marker.add` (menuActions.ts) writes `positionSample: cursorSample`
   * verbatim, so the fraction reaches marker data and the cue chunk of every
   * export written from it.
   *
   * `TimelineRuler` has always rounded its own seek (`Math.round(snapped)`) for
   * exactly this reason — so the two surfaces that write `cursorSample` were
   * disagreeing about whether the field is an integer. Rounding here settles it
   * where the value is produced. The snapping arm is unaffected in practice:
   * snap targets are integer sample positions already, so the round is a no-op
   * on that path and only the raw path moves, by less than one sample. */
  function snapped(raw: number, targets: number[], e: { altKey: boolean }): number {
    if (snapSuspended(e) || targets.length === 0) return Math.round(raw);
    return Math.round(clamp(snapSample(raw, targets, zoom.samplesPerPixel).sample, 0, length));
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x, sample: raw } = sampleAtClientX(e.clientX);
    const { setCursor, setSelection, activeDocumentId } = useAppStore.getState();

    // Captured once per gesture — see the hook header.
    const targets = editorSnapTargets(activeDocumentId);

    // F11-1: the handle wins the press. Checked BEFORE the cursor is moved and
    // before the double-click branch: the user aimed at a grab handle, so the
    // gesture is a drag of the thing they grabbed and nothing else — no
    // selection change, no select-all on a double press, and no jump of the
    // cursor to the press position (grabbing a handle must not itself move it).
    if (onHandle(x, yAtClientY(e.clientY))) {
      if (typeof canvas.setPointerCapture === 'function') {
        canvas.setPointerCapture(e.pointerId);
      }
      dragRef.current = { kind: 'playhead', targets };
      setLaneCursor('grabbing');
      return;
    }

    const sample = snapped(raw, targets, e);

    setCursor(sample);

    if (e.detail >= 2) {
      // The segment is picked from the RAW pointer sample, not the snapped one:
      // with the magnet pulling the cursor onto a marker, the segment the user
      // double-clicked is still the one under the pointer.
      const positions = (useAppStore.getState().markers[activeDocumentId ?? ''] ?? []).map(
        (m) => m.positionSample
      );
      const segment = segmentAt(positions, length, Math.round(raw));
      setSelection(segment ?? (length > 0 ? { start: 0, end: length } : null));
      dragRef.current = null;
      return;
    }

    if (typeof canvas.setPointerCapture === 'function') {
      canvas.setPointerCapture(e.pointerId);
    }

    if (e.shiftKey) {
      // The anchor is an EXISTING edge or the existing cursor: it is not being
      // dragged, so it is used exactly as it stands.
      const anchor = shiftClickAnchor(sample, selection, cursorSample);
      dragRef.current = { kind: 'select', anchorSample: anchor, anchorX: x, exceeded: true, targets };
      setSelection(dragToSelection(anchor, sample));
    } else {
      dragRef.current = { kind: 'select', anchorSample: sample, anchorX: x, exceeded: false, targets };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const { x, sample: raw } = sampleAtClientX(e.clientX);

    if (!drag) {
      // F11-1: idle hover — the only thing to do is tell the user the handle is
      // grabbable. No store read/write, no render.
      setLaneCursor(onHandle(x, yAtClientY(e.clientY)) ? 'grab' : '');
      return;
    }

    if (drag.kind === 'playhead') {
      // The same snap the cursor has always been placed with — targets frozen
      // at pointerdown, Alt re-read on THIS event (see the hook header). The
      // selection is deliberately untouched: dragging the playhead through a
      // selected region must not redefine it.
      useAppStore.getState().setCursor(snapped(raw, drag.targets, e));
      return;
    }

    if (!drag.exceeded) {
      // The threshold is measured on the RAW pointer travel: a snap can move
      // the position by up to the tolerance without the pointer having moved,
      // and that must not by itself turn a click into a selection.
      if (!exceedsDragThreshold(drag.anchorX, x)) return;
      drag.exceeded = true;
    }
    // Only the moving edge is snapped; `drag.anchorSample` is reused verbatim.
    useAppStore
      .getState()
      .setSelection(dragToSelection(drag.anchorSample, snapped(raw, drag.targets, e)));
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
    // F11-1: the grip is released; the pointer may still be over the handle, so
    // fall back to the hover state rather than clearing outright.
    if (drag?.kind === 'playhead') {
      const { x } = sampleAtClientX(e.clientX);
      setLaneCursor(onHandle(x, yAtClientY(e.clientY)) ? 'grab' : '');
      return;
    }
    if (drag && !drag.exceeded) {
      useAppStore.getState().setSelection(null);
    }
  };

  return { onPointerDown, onPointerMove, onPointerUp };
}
