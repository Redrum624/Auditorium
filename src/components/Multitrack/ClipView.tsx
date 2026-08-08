import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { AudioDocument } from '../../audio/AudioDocument';
import { docLength } from '../../audio/AudioDocument';
import { getPeaksForRange } from '../../audio/peaks';
import { getPyramids } from '../../services/peaksCache';
import { crossfadeGains, fadeInShape, fadeOutShape } from '../../dsp/fades';
import type { Clip } from '../../multitrack/session';
import { CROSSFADE_RHO, resolveClipFadeSpecs } from '../../multitrack/mixdown';
import { useSessionStore } from '../../multitrack/sessionStore';
import { snapSample, snapSpan } from '../../services/snap';
import { formatTime } from '../../utils/timeFormat';
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

/** X4 — side of the square corner fade handles. Larger than the 6 px trim
 * band so the fade grab reads as its own affordance, and the handle sits at
 * the clip TOP (the Audition/Reaper corner position) with its OWN pointer
 * handlers that stopPropagation() — `modeForX` hit-tests on X alone (no Y
 * term), so without that the trim zones would silently swallow any handle
 * inside the outer 6 px (trap T27). Never rendered outside the clip rect:
 * the root is overflow-hidden, so an overhanging tab would be clipped away
 * visually AND for hit-testing (T33). */
const FADE_HANDLE_PX = 10;

/** X4 — segments per fade/crossfade gain polyline in the SVG overlay. */
const FADE_RAMP_POINTS = 32;

/** X4 — a corner fade-handle drag in flight. Entirely separate from the root
 * drag state: the handles never hand their events to the root (T27/T28), and
 * the root's move/trim machinery is untouched (coupling C7). */
interface FadeDragState {
  edge: 'in' | 'out';
  startClientX: number;
  /** The stored fade length (samples, 0 = none) when the drag began. */
  origFade: number;
  exceeded: boolean;
}

/** Rounds SVG coordinates to 1/100 px so path strings stay compact. */
function svgRound(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * X4 — an SVG path following a gain curve over `[x0, x1]`, with gain 1 at the
 * clip top (`y = 0`) and gain 0 at the clip bottom (`y = height`). The shape
 * comes from the caller-supplied `gainAt`, which the callers wire to the REAL
 * DSP expressions (`fadeInShape`/`fadeOutShape`/`crossfadeGains`), so the
 * drawn ramp is the rendered envelope, not an approximation of it.
 */
function gainLinePath(x0: number, x1: number, height: number, gainAt: (u: number) => number): string {
  const parts: string[] = [];
  for (let i = 0; i <= FADE_RAMP_POINTS; i++) {
    const u = i / FADE_RAMP_POINTS;
    const x = x0 + (x1 - x0) * u;
    const y = (1 - gainAt(u)) * height;
    parts.push(`${i === 0 ? 'M' : 'L'}${svgRound(x)} ${svgRound(y)}`);
  }
  return parts.join(' ');
}

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
 *                            tracks (target lane highlighted), committed on
 *                            release. A same-track overlap commits verbatim
 *                            and arms a crossfade (X5); hold Ctrl at the drop
 *                            to push clear of the overlap instead.
 *   - drag a 6px edge      → trim start/end live (clamped to source bounds)
 *   - drag a corner fade handle (selected clip) → set that edge's fade length
 *     live through setClipFade; the ramp/crossfade overlay redraws from the
 *     renderer's own resolver (X4)
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
  const setClipFade = useSessionStore((s) => s.setClipFade);
  // X4 — the whole track list: this clip's own track feeds the fade/overlap
  // visuals, and the track hovered during a move drag feeds the overlap hint.
  const tracks = useSessionStore((s) => s.session.tracks);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ticCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const fadeDragRef = useRef<FadeDragState | null>(null);
  const [moveDx, setMoveDx] = useState(0);
  // X4 — the track currently under a move drag (null when not over a lane),
  // and whether Ctrl is held: together they drive the overlap drop hint that
  // surfaces X5's semantics (drop = crossfade, Ctrl at the drop = nudge).
  const [dragTrackId, setDragTrackId] = useState<string | null>(null);
  const [ctrlHeld, setCtrlHeld] = useState(false);
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

  // --- X4, the fade UI -----------------------------------------------------
  //
  // Everything below reads the clip THROUGH THE STORE (`liveClip`) rather
  // than through the prop: during a handle drag, `setClipFade` commits live
  // per pointermove (exactly as trim does) and the handle/ramp must track the
  // store's clamped answer, not the prop snapshot the parent last rendered.
  const trackClips = tracks.find((t) => t.id === trackId)?.clips;
  const liveClip = trackClips?.find((c) => c.id === clip.id) ?? clip;
  const clipH = laneHeight - 8; // the root div's height (see style below)

  // The render-side truth for this track: which fades are SOLO ramps and
  // which overlaps are live crossfades (rule 3 + intrusion included). Using
  // the renderer's own resolver means the drawn envelope can never disagree
  // with the audio — an intruded pair honestly shows solo fades here because
  // that is what it SOUNDS like.
  const spec = useMemo(
    () => (trackClips ? resolveClipFadeSpecs(trackClips).get(clip.id) : undefined),
    [trackClips, clip.id]
  );
  // Hoisted as consts so the narrowing survives into the JSX render closures.
  const crossIn = spec?.crossIn ?? null;
  const crossOut = spec?.crossOut ?? null;

  // Same-track overlap segments in clip-local px, drawn by the LATER-starting
  // member of each pair (ties broken by id) — a startSample rule, never array
  // position: the sorted invariant does not hold after a start-trim (C7/T40).
  const overlapSegs = useMemo(() => {
    if (!trackClips) return [] as { x0: number; x1: number }[];
    const segs: { x0: number; x1: number }[] = [];
    for (const m of trackClips) {
      if (m.id === liveClip.id) continue;
      const later =
        liveClip.startSample > m.startSample ||
        (liveClip.startSample === m.startSample && liveClip.id > m.id);
      if (!later) continue;
      const lo = Math.max(liveClip.startSample, m.startSample);
      const hi = Math.min(
        liveClip.startSample + liveClip.lengthSample,
        m.startSample + m.lengthSample
      );
      if (hi - lo <= 0) continue; // abutting is NOT an overlap
      segs.push({
        x0: (lo - liveClip.startSample) / zoom.samplesPerPixel,
        x1: (hi - liveClip.startSample) / zoom.samplesPerPixel,
      });
    }
    return segs;
  }, [trackClips, liveClip, zoom.samplesPerPixel]);

  // Corner handle positions: the handle centre tracks the fade boundary, and
  // the whole square is clamped INSIDE the clip rect — the root div is
  // overflow-hidden, so geometry outside it is unusable, not merely ugly
  // (T33). At fade 0 the handles sit exactly in the top corners.
  const storedFadeIn = liveClip.fadeInSample ?? 0;
  const storedFadeOut = liveClip.fadeOutSample ?? 0;
  const clampHandleLeft = (ideal: number): number =>
    Math.min(Math.max(0, ideal), Math.max(0, widthPx - FADE_HANDLE_PX));
  const fadeInHandleLeft = clampHandleLeft(
    storedFadeIn / zoom.samplesPerPixel - FADE_HANDLE_PX / 2
  );
  const fadeOutHandleLeft = clampHandleLeft(
    widthPx - storedFadeOut / zoom.samplesPerPixel - FADE_HANDLE_PX / 2
  );

  // The overlap drop hint (X5's Ctrl affordance made discoverable): while a
  // move drag's PREVIEWED span overlaps any clip on the hovered target track,
  // say what the drop will do. `moveDx !== 0` doubles as "the drag exceeded
  // the threshold and actually moved" — a plain click never shows it.
  const overlapUnderPreview = (() => {
    if (!moveDragging || moveDx === 0) return false;
    const targetClips = tracks.find((t) => t.id === (dragTrackId ?? trackId))?.clips;
    if (!targetClips) return false;
    const previewStart = clip.startSample + moveDx * zoom.samplesPerPixel;
    const previewEnd = previewStart + clip.lengthSample;
    return targetClips.some(
      (m) =>
        m.id !== clip.id &&
        Math.min(previewEnd, m.startSample + m.lengthSample) -
          Math.max(previewStart, m.startSample) >
          0
    );
  })();

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

  // X4 — the overlap drop hint must flip between "crossfades" and "pushes
  // clear" the moment Ctrl changes, pointer moving or not — the same
  // stillness argument as the Alt listener above. Alive only while a move
  // drag is, like that listener.
  useEffect(() => {
    if (!moveDragging) return;
    const onCtrlChange = (e: KeyboardEvent) => {
      if (e.key !== 'Control') return;
      setCtrlHeld(e.ctrlKey);
    };
    window.addEventListener('keydown', onCtrlChange);
    window.addEventListener('keyup', onCtrlChange);
    return () => {
      window.removeEventListener('keydown', onCtrlChange);
      window.removeEventListener('keyup', onCtrlChange);
    };
  }, [moveDragging]);

  // --- X4, the corner fade-handle gesture ----------------------------------
  //
  // The handles own their whole pointer lifecycle and stopPropagation() on
  // every event: `modeForX` has no Y term, so a corner pointerdown that
  // reached the root would become a TRIM no matter how high up it landed
  // (T27). The root's gesture machinery — snap, preview/commit agreement,
  // the Ctrl nudge — is untouched (C7). Like trim, a fade drag commits live
  // per pointermove; `setClipFade` is the single clamp boundary (C4), so the
  // requested length is handed over raw and the store's clamped answer flows
  // back through `liveClip` into the handle position and the ramp.
  const onFadePointerDown =
    (edge: 'in' | 'out') =>
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      setSelectedClip(clip.id);
      fadeDragRef.current = {
        edge,
        startClientX: e.clientX,
        origFade: (edge === 'in' ? liveClip.fadeInSample : liveClip.fadeOutSample) ?? 0,
        exceeded: false,
      };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    };

  const onFadePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = fadeDragRef.current;
    if (!drag) return;
    e.stopPropagation();
    const dxPx = e.clientX - drag.startClientX;
    if (!drag.exceeded) {
      // Same click-vs-drag threshold as the root gesture, measured on RAW
      // pointer travel: a corner click must not nudge the fade by a pixel's
      // worth of samples.
      if (Math.abs(dxPx) < DRAG_THRESHOLD) return;
      drag.exceeded = true;
    }
    const dSamples = dxPx * zoom.samplesPerPixel;
    // Dragging INTO the clip lengthens the fade on either edge: rightward for
    // the fade-in, leftward for the fade-out.
    const requested = drag.edge === 'in' ? drag.origFade + dSamples : drag.origFade - dSamples;
    setClipFade(clip.id, drag.edge, { lengthSample: requested });
  };

  const onFadePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!fadeDragRef.current) return;
    e.stopPropagation();
    fadeDragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

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
      // X4 — the hovered track and the Ctrl state feed the overlap drop hint;
      // the commit itself still reads e.ctrlKey at the drop, exactly as X5
      // wired it (nothing here changes what pointerUp does).
      const hover = resolveTrackAt(e.clientX, e.clientY);
      setDragTrackId(hover);
      setCtrlHeld(e.ctrlKey);
      onDragOverTrack(hover);
    } else if (drag.mode === 'trim-start') {
      trimClip(clip.id, 'start', Math.round(snapBoundary(drag.origStart + dxSamples, drag, alt)));
    } else {
      // Snap FIRST, then clamp: the source-length and min-length clamps are
      // hard validity limits and must survive the magnet — intent first,
      // validity second (the ordering v1.8 established; see pointerUp).
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
      // SNAP-ONLY BY DEFAULT (v1.9 X5) — v1.8's snap-then-nudge ordering
      // degraded exactly as its ordering note predicted: the magnet still
      // expresses user intent in SCREEN space here (only this layer has the
      // zoom and the tolerance), but `resolveOverlap` no longer relocates a
      // clip by default, so the committed start IS the snapped start and the
      // preview cannot disagree with the commit. A same-track overlap is
      // intentional now: the store arms the pair's facing fades so the
      // overlap renders as a crossfade (see sessionStore's overlap contract).
      //
      // Holding CTRL at the drop re-enables the v1.8 validity nudge
      // (opts.clearOverlap): snap first (intent), then the store pushes the
      // clip forward clear of any overlap (validity) — the one remaining
      // case where the commit deliberately diverges from the preview, pinned
      // by ClipView.snap.test.tsx. Ctrl, because Alt is the snap suspend
      // (snapSuspended above) and Shift is this app's selection-extension
      // modifier in the editor surface — neither may silently collide.
      moveClip(clip.id, target, moveStartFor(drag, e.clientX, snapSuspended(e)), {
        clearOverlap: e.ctrlKey,
      });
    }
    setMoveDx(0);
    setDragTrackId(null);
    setCtrlHeld(false);
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
      {/* X4 — fades, crossfades and overlap regions, on an SVG overlay.
          Deliberately NOT a third canvas (two shipped tests pin the canvas
          count, T29), NOT the waveform canvas (capped + blit-stretched — a
          ramp's breakpoint is a position and would be displaced like a tic,
          T31), and NOT the cached offscreen bitmap (its key carries no fade
          identity, and joining it would cost a re-raster per drag frame,
          T30/C8). A child of the clip element, so it rides the move-drag
          translateX for free — no moveDx compensation (T34). */}
      {(spec !== undefined || overlapSegs.length > 0) && (
        <svg
          data-testid="fade-overlay"
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox={`0 0 ${widthPx} ${clipH}`}
          preserveAspectRatio="none"
        >
          {overlapSegs.map((seg, i) => (
            <rect
              key={i}
              data-testid="overlap-region"
              x={svgRound(seg.x0)}
              y={0}
              width={svgRound(seg.x1 - seg.x0)}
              height={clipH}
              fill="rgba(255,255,255,0.07)"
            />
          ))}
          {spec !== undefined &&
            spec.fadeIn > 0 &&
            (() => {
              const px = spec.fadeIn / zoom.samplesPerPixel;
              const line = gainLinePath(0, px, clipH, (u) => fadeInShape(u, spec.fadeInCurve));
              return (
                <g data-testid="fade-ramp-in">
                  <path d={`${line} L0 0 Z`} fill="rgba(0,0,0,0.32)" />
                  <path d={line} fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth={1} />
                </g>
              );
            })()}
          {spec !== undefined &&
            spec.fadeOut > 0 &&
            (() => {
              const x0 = widthPx - spec.fadeOut / zoom.samplesPerPixel;
              const line = gainLinePath(x0, widthPx, clipH, (u) => fadeOutShape(u, spec.fadeOutCurve));
              return (
                <g data-testid="fade-ramp-out">
                  <path d={`${line} L${svgRound(widthPx)} 0 Z`} fill="rgba(0,0,0,0.32)" />
                  <path d={line} fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth={1} />
                </g>
              );
            })()}
          {/* An armed crossfade draws each member's OWN gain line — the
              incoming rise here, the outgoing fall on the partner — so the
              X shape is complete regardless of which sibling paints on top
              (paint order is array order, which is NOT time order, C7). The
              gains are crossfadeGains at the renderer's own rho, i.e. the
              audible envelope, not fadeInShape (a crossfade gain is not a
              fade curve — see dsp/fades.ts). */}
          {crossIn !== null &&
            (() => {
              const px = crossIn.lengthSample / zoom.samplesPerPixel;
              const line = gainLinePath(0, px, clipH, (u) =>
                crossfadeGains(u, CROSSFADE_RHO, crossIn.curveOut, crossIn.curveIn).gIn
              );
              return (
                <path
                  data-testid="crossfade-in-line"
                  d={line}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={1.5}
                />
              );
            })()}
          {crossOut !== null &&
            (() => {
              const x0 = widthPx - crossOut.lengthSample / zoom.samplesPerPixel;
              const line = gainLinePath(x0, widthPx, clipH, (u) =>
                crossfadeGains(u, CROSSFADE_RHO, crossOut.curveOut, crossOut.curveIn).gOut
              );
              return (
                <path
                  data-testid="crossfade-out-line"
                  d={line}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={1.5}
                />
              );
            })()}
        </svg>
      )}
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
      {/* X4 — crossfade width readout (ruling 7), on the INCOMING member so
          exactly one pill exists per pair. Inside the region, below the name
          label and well above the 14 px beat-tic band (T32). */}
      {crossIn !== null && (
        <div
          data-testid="crossfade-readout"
          className="pointer-events-none absolute whitespace-nowrap rounded px-1 text-[9px] leading-tight"
          style={{
            left: 2,
            top: 18,
            backgroundColor: 'rgba(12,12,16,0.7)',
            border: '1px solid rgba(255,255,255,0.14)',
            color: 'var(--glass-text-label)',
          }}
          title="Crossfade — the facing fades span this overlap exactly"
        >
          {formatTime(crossIn.lengthSample, sessionRate)}
        </div>
      )}
      {/* X4 — the overlap drop hint: X5 made an overlapping drop commit
          verbatim and arm a crossfade, with Ctrl at the drop restoring the
          old push-clear nudge. Nothing in the UI said so until now. */}
      {overlapUnderPreview && (
        <div
          data-testid="overlap-drag-hint"
          className="pointer-events-none absolute whitespace-nowrap rounded-full px-2 py-0.5 text-[10px]"
          style={{
            left: '50%',
            top: 18,
            transform: 'translateX(-50%)',
            backgroundColor: 'rgba(12,12,16,0.78)',
            border: '1px solid rgba(255,255,255,0.16)',
            color: 'var(--glass-text-label)',
          }}
        >
          {ctrlHeld ? 'Drop pushes clear of the overlap' : 'Drop crossfades — hold Ctrl to push clear'}
        </div>
      )}
      {/* X4 — corner fade handles, the universal DAW affordance (ruling 7).
          Selected clip only (selection is this surface's hover analogue, and
          it keeps a busy timeline clean). They own their pointer events
          outright — see onFadePointerDown — because the root's X-only trim
          hit-test would otherwise swallow the corners (T27); they are NOT
          modelled on the handler-less trim grips, whose events deliberately
          bubble to the root (T28). */}
      {selected && (
        <>
          <div
            data-testid="fade-handle-in"
            title="Fade in — drag right to lengthen"
            onPointerDown={onFadePointerDown('in')}
            onPointerMove={onFadePointerMove}
            onPointerUp={onFadePointerUp}
            onPointerCancel={onFadePointerUp}
            className="absolute rounded-sm"
            style={{
              top: 0,
              left: fadeInHandleLeft,
              width: FADE_HANDLE_PX,
              height: FADE_HANDLE_PX,
              cursor: 'ew-resize',
              backgroundColor: 'var(--accent-soft)',
              border: '1px solid var(--accent)',
              touchAction: 'none',
            }}
          />
          <div
            data-testid="fade-handle-out"
            title="Fade out — drag left to lengthen"
            onPointerDown={onFadePointerDown('out')}
            onPointerMove={onFadePointerMove}
            onPointerUp={onFadePointerUp}
            onPointerCancel={onFadePointerUp}
            className="absolute rounded-sm"
            style={{
              top: 0,
              left: fadeOutHandleLeft,
              width: FADE_HANDLE_PX,
              height: FADE_HANDLE_PX,
              cursor: 'ew-resize',
              backgroundColor: 'var(--accent-soft)',
              border: '1px solid var(--accent)',
              touchAction: 'none',
            }}
          />
        </>
      )}
    </div>
  );
}
