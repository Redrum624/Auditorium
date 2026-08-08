import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { AudioDocument } from '../../audio/AudioDocument';
import { docLength } from '../../audio/AudioDocument';
import { getPeaksForRange } from '../../audio/peaks';
import { getPyramids } from '../../services/peaksCache';
import type { Clip } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { snapSample, snapSpan } from '../../services/snap';
import { drawBeatTics, sampleToPixel } from '../Editor/waveformRender';
import {
  CLIP_BEAT_TIC_PX,
  CLIP_DOWNBEAT_TIC_PX,
  CLIP_TIC_BAND_PX,
  ticWindow,
  useClipBeatTics,
  useViewportWidth,
} from './clipBeatTics';
import { getClipWaveformCanvas, zoomBucket } from './clipWaveformCache';
import { sessionSnapTargets } from './sessionSnapTargets';

const HANDLE_PX = 6;
const DRAG_THRESHOLD = 4;
const MIN_LENGTH = 32;

/** Cap (in DEVICE pixels) on the width of a clip's waveform raster — both the
 * on-screen canvas backing store and the cached offscreen bitmap (v1.5.2).
 * Uncapped, both were sized to the clip's FULL timeline pixel width (~7.6 MB
 * per clip at default zoom, ~30 MB at 4x — LRU-retained 200 deep by
 * clipWaveformCache). The peak envelope still spans the clip's whole sample
 * range; it is simply rasterised at at most this many columns and blit-scaled
 * across the clip's CSS width, so alignment is exact at every zoom/scroll and
 * only sub-column detail (invisible beyond the widest real viewport anyway)
 * is lost. */
const MAX_CLIP_WAVEFORM_DEVICE_PX = 4096;

interface Zoom {
  samplesPerPixel: number;
  scrollSample: number;
}

interface ClipViewProps {
  clip: Clip;
  doc: AudioDocument | undefined;
  trackId: string;
  zoom: Zoom;
  sessionRate: number;
  laneHeight: number;
  selected: boolean;
  /** Resolve the track id under a viewport point (for cross-lane drag). */
  resolveTrackAt: (clientX: number, clientY: number) => string | null;
  /** Report the track currently hovered during a move drag (for highlight). */
  onDragOverTrack: (trackId: string | null) => void;
}

type DragMode = 'move' | 'trim-start' | 'trim-end';

interface DragState {
  mode: DragMode;
  startClientX: number;
  origStart: number;
  origEnd: number;
  exceeded: boolean;
  /** Task B4 — the SESSION's snap targets as they stood when this drag began,
   * with this clip's own contribution excluded (trap 27). Captured once because
   * building it walks every clip in the session, and because the set a drag
   * uses must not change under the user's hand mid-gesture. */
  targets: number[];
  /** Task B4 — the last pointer x seen, so a modifier press with the pointer
   * STILL can recompute the preview from the same position. */
  lastClientX: number;
}

/** Number of source-document samples spanned by `lengthSample` session samples. */
function docSpan(lengthSample: number, docRate: number, sessionRate: number): number {
  return docRate === sessionRate ? lengthSample : Math.round((lengthSample * docRate) / sessionRate);
}

/** True while the escape-hatch modifier is held on THIS event (Task B4). Alt,
 * verified free against the BUILT app — see `useEditorGestures`'s header. */
function snapSuspended(e: { altKey: boolean }): boolean {
  return e.altKey;
}

/**
 * One clip on a track lane: a rounded rect (cyan) with the source name and a
 * cached mini waveform. Pointer interactions:
 *   - click               → select
 *   - drag body (>4px)     → move horizontally (live transform) and across
 *                            tracks (target lane highlighted), committed on release
 *   - drag a 6px edge      → trim start/end live (clamped to source bounds)
 * v1: parameter changes don't affect in-flight playback (see MultitrackPlayer).
 */
export default function ClipView({
  clip,
  doc,
  trackId,
  zoom,
  sessionRate,
  laneHeight,
  selected,
  resolveTrackAt,
  onDragOverTrack,
}: ClipViewProps) {
  const moveClip = useSessionStore((s) => s.moveClip);
  const trimClip = useSessionStore((s) => s.trimClip);
  const setSelectedClip = useSessionStore((s) => s.setSelectedClip);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ticCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [moveDx, setMoveDx] = useState(0);
  // Task B4 — true only while a MOVE drag is in flight, so the modifier
  // listener below exists for exactly as long as there is a preview to keep
  // honest and not one render longer.
  const [moveDragging, setMoveDragging] = useState(false);

  const left = sampleToPixel(clip.startSample, zoom.scrollSample, zoom.samplesPerPixel);
  const widthPx = Math.max(2, clip.lengthSample / zoom.samplesPerPixel);
  const canvasH = Math.max(1, laneHeight - 22);

  // Task B3 — the beat grid mapped onto THIS clip, in session samples. `null`
  // whenever there is nothing to draw: no cached analysis, the toggle off, the
  // source document closed, or a clip taken from past the analysed prefix.
  const beatTics = useClipBeatTics(clip, doc, sessionRate);
  const viewportPx = useViewportWidth();
  // Only the on-screen slice of the clip is rasterised — see ticWindow. The
  // drag translation is included so the band still covers the lane while a clip
  // is being dragged, and the window is quantised so that costs a canvas resize
  // once per 256 px of movement rather than once per pointer event.
  const ticBand = ticWindow(-(left + moveDx), widthPx, viewportPx);
  const showTics = beatTics !== null && ticBand.width > 0;

  // Mini waveform (Task F8): the peak envelope is drawn ONCE into an offscreen
  // canvas cached by (clipId, lengthSample, zoom bucket, channels identity,
  // height) — see clipWaveformCache.ts — and merely BLITTED here on every
  // render. Within a zoom bucket (a 2x samplesPerPixel range) the cached bitmap
  // is blit-scaled to the current width; an edit to the source document
  // replaces doc.channels (identity change), which invalidates the entry.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / no backend

    const w = Math.max(1, Math.round(widthPx));
    const dpr = window.devicePixelRatio || 1;
    // v1.5.2: rasterise at most MAX_CLIP_WAVEFORM_DEVICE_PX device pixels (see
    // the constant's comment). The canvas element's CSS size is unchanged
    // (`h-full w-full` stretches the backing store across the whole clip), so
    // the capped raster maps 1:1 onto the clip's full extent.
    const drawW = Math.min(w, Math.max(1, Math.floor(MAX_CLIP_WAVEFORM_DEVICE_PX / dpr)));
    canvas.width = Math.round(drawW * dpr);
    canvas.height = Math.round(canvasH * dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!doc || doc.channels.length === 0) return;

    const off = getClipWaveformCanvas(
      {
        clipId: clip.id,
        lengthSample: clip.lengthSample,
        bucket: zoomBucket(zoom.samplesPerPixel),
        height: canvasH,
        offsetSample: clip.offsetSample,
        channels: doc.channels,
      },
      drawW,
      (offCanvas) => {
        const octx = offCanvas.getContext('2d');
        if (!octx) return; // jsdom / no backend
        const ow = offCanvas.width;
        const oh = offCanvas.height;
        const channel = doc.channels[0];
        const pyramid = getPyramids(doc)[0];
        const docStart = clip.offsetSample;
        const docEnd = docStart + docSpan(clip.lengthSample, doc.sampleRate, sessionRate);
        const { min, max } = getPeaksForRange(pyramid, channel, docStart, docEnd, ow);

        octx.fillStyle = 'rgba(38,198,218,0.85)';
        const mid = oh / 2;
        const amp = (oh / 2) * 0.9;
        for (let x = 0; x < ow; x++) {
          const yTop = mid - max[x] * amp;
          const yBot = mid - min[x] * amp;
          octx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
        }
      }
    );
    ctx.drawImage(off, 0, 0, off.width, off.height, 0, 0, canvas.width, canvas.height);
  }, [
    doc,
    clip.id,
    clip.offsetSample,
    clip.lengthSample,
    widthPx,
    canvasH,
    sessionRate,
    zoom.samplesPerPixel,
  ]);

  // Task B3 — the beat tics, on their OWN canvas.
  //
  // Deliberately not the waveform canvas above: that raster is capped at 4096
  // device px and blit-STRETCHED across the clip's whole CSS width, which is
  // right for a min/max envelope and wrong for a position — one raster column
  // can span many CSS px, so every tic would be displaced and fattened. This
  // canvas is sized in CSS px at 1:1 (times dpr) over the visible slice, so a
  // tic lands on the pixel the mapping computed. It is also not the CACHED
  // offscreen bitmap: that cache's key carries no beat-grid or toggle identity,
  // so tics baked into it would persist or vanish stale across a toggle, an
  // analysis completing, or a x2 / /2 correction.
  useEffect(() => {
    const canvas = ticCanvasRef.current;
    if (!canvas || !beatTics || ticBand.width <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / no backend

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(ticBand.width * dpr));
    canvas.height = Math.max(1, Math.round(CLIP_TIC_BAND_PX * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, ticBand.width, CLIP_TIC_BAND_PX);

    drawBeatTics(ctx, {
      ...beatTics,
      // The overlay's left edge is `ticBand.start` CSS px into the clip, and
      // clip-local x 0 is exactly `clip.startSample` on the session timeline.
      scrollSample: clip.startSample + ticBand.start * zoom.samplesPerPixel,
      samplesPerPixel: zoom.samplesPerPixel,
      width: ticBand.width,
      baseline: CLIP_TIC_BAND_PX,
      beatHeight: CLIP_BEAT_TIC_PX,
      downbeatHeight: CLIP_DOWNBEAT_TIC_PX,
    });
    // `moveDx` is deliberately absent: ticBand already carries it, quantised.
  }, [beatTics, ticBand.start, ticBand.width, zoom.samplesPerPixel, clip.startSample]);

  const maxTrimEnd = (): number => {
    if (!doc) return Number.POSITIVE_INFINITY;
    const availDoc = docLength(doc) - clip.offsetSample; // source samples left
    const availSession =
      doc.sampleRate === sessionRate
        ? availDoc
        : Math.round((availDoc * sessionRate) / doc.sampleRate);
    return clip.startSample + availSession;
  };

  const modeForX = (localX: number): DragMode => {
    if (localX <= HANDLE_PX) return 'trim-start';
    if (localX >= widthPx - HANDLE_PX) return 'trim-end';
    return 'move';
  };

  // --- Task B4, the magnet -------------------------------------------------
  //
  // Everything below works in DELTAS from the pointerdown x, so the multitrack
  // lane's pixel origin never enters the arithmetic — which is why trap 25 (the
  // lane is offset by the 224 px header column, and the wheel-zoom code gets
  // that wrong) cannot bite here. The zoom used is the `zoom` PROP, i.e. the
  // session store's `mtZoom`, never the editor's app-store zoom (trap 26).

  /** The clip start this drag is asking for, snapped unless suspended. Shared
   * by the preview and the commit so the two cannot disagree (trap 23). The
   * clamp mirrors `moveClip`'s own `Math.max(0, …)`. */
  const moveStartFor = (drag: DragState, clientX: number, alt: boolean): number => {
    const raw = drag.origStart + (clientX - drag.startClientX) * zoom.samplesPerPixel;
    if (alt || drag.targets.length === 0) return Math.max(0, Math.round(raw));
    // Either edge of the clip may catch a target — aligning a clip's tail to a
    // beat is as ordinary as aligning its head.
    const s = snapSpan(raw, clip.lengthSample, drag.targets, zoom.samplesPerPixel);
    return Math.max(0, Math.round(s.sample));
  };

  /** A single trim boundary, snapped unless suspended. */
  const snapBoundary = (raw: number, drag: DragState, alt: boolean): number => {
    if (alt || drag.targets.length === 0) return raw;
    return snapSample(raw, drag.targets, zoom.samplesPerPixel).sample;
  };

  // Task B4 — the ONE case a per-pointer-event modifier read cannot cover.
  //
  // Reading `e.altKey` off every pointer event gives "suspended while held"
  // without any global listener, and that is how both surfaces do it. But a
  // clip move has a *persistent* preview: press or release Alt with the pointer
  // perfectly still and the preview would keep showing the previous decision
  // until the next mouse move — and then the drop, which reads the modifier at
  // that instant, would land somewhere else. That is trap 23 again, reached by
  // the keyboard instead of by the store. So while (and only while) a move drag
  // is live, a modifier change recomputes the preview from the last pointer x.
  useEffect(() => {
    if (!moveDragging) return;
    const onAltChange = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return;
      const drag = dragRef.current;
      if (!drag || drag.mode !== 'move' || !drag.exceeded) return;
      setMoveDx(
        (moveStartFor(drag, drag.lastClientX, e.altKey) - drag.origStart) / zoom.samplesPerPixel
      );
    };
    window.addEventListener('keydown', onAltChange);
    window.addEventListener('keyup', onAltChange);
    return () => {
      window.removeEventListener('keydown', onAltChange);
      window.removeEventListener('keyup', onAltChange);
    };
    // `moveStartFor` is re-created every render; the deps below are everything
    // it actually reads, so the listener is rebound exactly when its answer
    // could change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveDragging, zoom.samplesPerPixel, clip.lengthSample]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelectedClip(clip.id);

    const rect = e.currentTarget.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const mode = modeForX(localX);
    dragRef.current = {
      mode,
      startClientX: e.clientX,
      origStart: clip.startSample,
      origEnd: clip.startSample + clip.lengthSample,
      exceeded: false,
      targets: sessionSnapTargets(clip.id),
      lastClientX: e.clientX,
    };
    if (mode === 'move') setMoveDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dxPx = e.clientX - drag.startClientX;
    if (!drag.exceeded) {
      // The threshold is measured on the RAW pointer travel: the magnet's own
      // pull must not by itself promote a click into a drag.
      if (Math.abs(dxPx) < DRAG_THRESHOLD) return;
      drag.exceeded = true;
    }
    drag.lastClientX = e.clientX;
    const alt = snapSuspended(e);
    const dxSamples = dxPx * zoom.samplesPerPixel;

    if (drag.mode === 'move') {
      // The preview is a CSS translate of the clip element, and the clip's
      // `left` still reflects `origStart` (the store is only written on drop),
      // so translating by exactly (snappedStart − origStart) puts the element
      // on the position the drop will commit.
      setMoveDx((moveStartFor(drag, e.clientX, alt) - drag.origStart) / zoom.samplesPerPixel);
      onDragOverTrack(resolveTrackAt(e.clientX, e.clientY));
    } else if (drag.mode === 'trim-start') {
      trimClip(clip.id, 'start', Math.round(snapBoundary(drag.origStart + dxSamples, drag, alt)));
    } else {
      // Snap FIRST, then clamp: the source-length and min-length clamps are
      // hard validity limits and must survive the magnet, exactly as the
      // overlap nudge does on a move (see the ordering note on pointerUp).
      const snappedEnd = snapBoundary(drag.origEnd + dxSamples, drag, alt);
      const target = Math.min(maxTrimEnd(), snappedEnd);
      trimClip(clip.id, 'end', Math.round(Math.max(drag.origStart + MIN_LENGTH, target)));
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setMoveDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (drag && drag.mode === 'move' && drag.exceeded) {
      const target = resolveTrackAt(e.clientX, e.clientY) ?? trackId;
      // SNAP-THEN-NUDGE. The magnet is a user-intent transform expressed in
      // SCREEN space, and only this layer has the zoom and the tolerance to
      // compute it; `moveClip`'s `resolveOverlap` is a validity transform in
      // SAMPLE space that only the store can compute, since only it knows the
      // target track's other clips. Intent first, validity second, is the only
      // order that cannot produce an invalid result: nudging first and snapping
      // afterwards could pull the clip straight back into the overlap it had
      // just been moved clear of.
      //
      // The consequence is deliberate and pinned by tests: when the nudge
      // fires, the committed start is NOT a snap target — the overlap rule
      // overrides the magnet, silently and forward-only, exactly as it already
      // does for every other caller. That is also why this ordering does not
      // entrench anything against v1.9 task X5 (same-track overlap becoming
      // first-class and crossfaded): when `resolveOverlap` stops relocating
      // clips, snap-then-nudge simply degrades to snap-only and nothing here
      // changes. The reverse order would leave a snap computed against a
      // position the user never pointed at.
      moveClip(clip.id, target, moveStartFor(drag, e.clientX, snapSuspended(e)));
    }
    setMoveDx(0);
    onDragOverTrack(null);
  };

  return (
    <div
      data-testid="clip"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="absolute top-1 overflow-hidden rounded-lg"
      style={{
        left,
        width: widthPx,
        height: laneHeight - 8,
        transform: moveDx ? `translateX(${moveDx}px)` : undefined,
        // G6 clip chrome, token-routed (mockup accent-soft / accent-ring):
        // idle = soft accent wash inside a ring-alpha border; selected = full
        // accent border with a ring halo + lift shadow. Geometry (left/width/
        // height, the 6px trim handles, the 4096px raster cap) untouched.
        backgroundColor: 'var(--accent-soft)',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: selected ? 'var(--accent)' : 'var(--accent-ring)',
        boxShadow: selected
          ? '0 0 0 1px var(--accent-ring), 0 8px 24px rgba(0,0,0,0.45)'
          : '0 6px 18px rgba(0,0,0,0.35)',
        cursor: 'grab',
        touchAction: 'none',
      }}
    >
      <div
        className="pointer-events-none truncate px-1 py-0.5 text-[10px] leading-tight"
        style={{ color: 'var(--glass-text-label)' }}
      >
        {doc?.name ?? clip.documentId}
      </div>
      <canvas ref={canvasRef} className="pointer-events-none block h-full w-full" />
      {/* Beat tics (B3). Pinned to the clip element's BOTTOM edge, not the
          waveform canvas's: that canvas is `h-full` below the name label inside
          an overflow-hidden box, so its own bottom strip is clipped away and
          anything drawn there would be invisible. Being a child of the clip, the
          band also rides the move-drag transform, so the tics travel with the
          audio they describe instead of lagging on the lane until the drop. */}
      {showTics && (
        <canvas
          ref={ticCanvasRef}
          data-testid="clip-beat-tics"
          className="pointer-events-none absolute"
          style={{
            left: ticBand.start,
            bottom: 0,
            width: ticBand.width,
            height: CLIP_TIC_BAND_PX,
          }}
        />
      )}
      {/* Edge trim affordances (hit-tested by pointer X; these are visual). */}
      <div
        className="absolute inset-y-0 left-0"
        style={{ width: HANDLE_PX, cursor: 'ew-resize' }}
      />
      <div
        className="absolute inset-y-0 right-0"
        style={{ width: HANDLE_PX, cursor: 'ew-resize' }}
      />
    </div>
  );
}
