import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { AudioDocument } from '../../audio/AudioDocument';
import { docLength } from '../../audio/AudioDocument';
import { getPeaksForRange } from '../../audio/peaks';
import { getPyramids } from '../../services/peaksCache';
import type { Clip } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { sampleToPixel } from '../Editor/waveformRender';
import { getClipWaveformCanvas, zoomBucket } from './clipWaveformCache';

const HANDLE_PX = 6;
const DRAG_THRESHOLD = 4;
const MIN_LENGTH = 32;

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
  const dragRef = useRef<DragState | null>(null);
  const [moveDx, setMoveDx] = useState(0);

  const left = sampleToPixel(clip.startSample, zoom.scrollSample, zoom.samplesPerPixel);
  const widthPx = Math.max(2, clip.lengthSample / zoom.samplesPerPixel);
  const canvasH = Math.max(1, laneHeight - 22);

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
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(canvasH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, canvasH);
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
      w,
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
    ctx.drawImage(off, 0, 0, off.width, off.height, 0, 0, w, canvasH);
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
      className="absolute top-1 overflow-hidden rounded"
      style={{
        left,
        width: widthPx,
        height: laneHeight - 8,
        transform: moveDx ? `translateX(${moveDx}px)` : undefined,
        backgroundColor: '#26c6da26',
        border: `1px solid ${selected ? '#7fe3f0' : '#26c6da'}`,
        boxShadow: selected ? '0 0 0 1px #7fe3f0' : undefined,
        cursor: 'grab',
        touchAction: 'none',
      }}
    >
      <div className="pointer-events-none truncate px-1 py-0.5 text-[10px] leading-tight text-[#d4d4d8]">
        {doc?.name ?? clip.documentId}
      </div>
      <canvas ref={canvasRef} className="pointer-events-none block h-full w-full" />
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
