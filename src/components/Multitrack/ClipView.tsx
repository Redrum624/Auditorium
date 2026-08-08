import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { AudioDocument } from '../../audio/AudioDocument';
import { docLength } from '../../audio/AudioDocument';
import { getPeaksForRange } from '../../audio/peaks';
import { getPyramids } from '../../services/peaksCache';
import type { Clip } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
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
}

/** Number of source-document samples spanned by `lengthSample` session samples. */
function docSpan(lengthSample: number, docRate: number, sessionRate: number): number {
  return docRate === sessionRate ? lengthSample : Math.round((lengthSample * docRate) / sessionRate);
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

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelectedClip(clip.id);

    const rect = e.currentTarget.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    dragRef.current = {
      mode: modeForX(localX),
      startClientX: e.clientX,
      origStart: clip.startSample,
      origEnd: clip.startSample + clip.lengthSample,
      exceeded: false,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dxPx = e.clientX - drag.startClientX;
    if (!drag.exceeded) {
      if (Math.abs(dxPx) < DRAG_THRESHOLD) return;
      drag.exceeded = true;
    }
    const dxSamples = dxPx * zoom.samplesPerPixel;

    if (drag.mode === 'move') {
      setMoveDx(dxPx);
      onDragOverTrack(resolveTrackAt(e.clientX, e.clientY));
    } else if (drag.mode === 'trim-start') {
      trimClip(clip.id, 'start', Math.round(drag.origStart + dxSamples));
    } else {
      const target = Math.min(maxTrimEnd(), drag.origEnd + dxSamples);
      trimClip(clip.id, 'end', Math.round(Math.max(drag.origStart + MIN_LENGTH, target)));
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (drag && drag.mode === 'move' && drag.exceeded) {
      const dxSamples = (e.clientX - drag.startClientX) * zoom.samplesPerPixel;
      const target = resolveTrackAt(e.clientX, e.clientY) ?? trackId;
      moveClip(clip.id, target, Math.round(drag.origStart + dxSamples));
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
