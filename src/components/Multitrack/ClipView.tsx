import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { AudioDocument } from '../../audio/AudioDocument';
import { docLength } from '../../audio/AudioDocument';
import { getPyramids } from '../../services/peaksCache';
import { crossfadeGains, fadeInShape, fadeOutShape } from '../../dsp/fades';
import type { Clip } from '../../multitrack/session';
import { CROSSFADE_RHO, resolveClipFadeSpecs } from '../../multitrack/mixdown';
import { useSessionStore } from '../../multitrack/sessionStore';
import { beginSessionGesture, endSessionGesture } from '../../multitrack/sessionUndo';
import { snapSample } from '../../services/snap';
import { formatTime } from '../../utils/timeFormat';
import { drawBeatTics, drawWaveformLane, sampleToPixel } from '../Editor/waveformRender';
import {
  CLIP_BEAT_TIC_PX,
  CLIP_DOWNBEAT_TIC_PX,
  CLIP_TIC_BAND_PX,
  ticWindow,
  useClipBeatTics,
  useLaneWidthBound,
} from './clipBeatTics';
import { snapClipStart } from './clipDropPosition';
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

/**
 * MT1-2 — WHERE THE 4096-PX RASTER CAP WENT.
 *
 * v1.5.2 added `MAX_CLIP_WAVEFORM_DEVICE_PX = 4096`: the waveform raster (both
 * the on-screen backing store and the cached offscreen bitmap) had been sized
 * to the clip's FULL timeline pixel width — ~7.6 MB per clip at default zoom,
 * ~30 MB at 4x, LRU-retained 200 deep — so it was capped at 4096 device px and
 * blit-STRETCHED across the clip's CSS width.
 *
 * That fixed the memory and broke the picture. A three-minute clip is tens of
 * thousands of CSS px wide at any working zoom, so the ~1–2 kpx actually on
 * screen were being magnified out of a few hundred of those 4096 columns: a
 * coarse solid blob where the editor showed detail, and a thin sparse line
 * wherever the magnified columns happened to fall between transients. That is
 * the visual-quality complaint MT1-2 exists to answer.
 *
 * The cap is DELETED rather than raised, and deliberately not replaced by a
 * bigger one, because the fix removes the thing it was protecting against: the
 * raster now covers only the on-screen band (`ticWindow`, at most the viewport
 * plus two 256-px quanta) instead of the whole clip, so it is bounded by the
 * WINDOW rather than by the content. A cap on top of a viewport-bounded raster
 * would be a second bound on an already-bounded number, i.e. dead code that
 * reads like a live safeguard.
 *
 * Stated in the right units, because an earlier draft of this paragraph claimed
 * "strictly smaller than the 4096-px cap at every zoom" and that is FALSE: it
 * compared a CSS-pixel band against a DEVICE-pixel cap. The band is ~2.5 k CSS
 * px on a 2 k-wide window, and the backing store is `(band) · dpr` — 4864 device
 * px at dpr 2, which is LARGER than 4096. The real win is not a smaller single
 * raster; it is that the raster no longer scales with clip length (a 3-minute
 * clip cost ~7.6 MB at default zoom and ~30 MB at 4x) and that the LRU-200
 * cache retaining up to two hundred of them is gone entirely. Peak memory falls
 * by orders of magnitude; the per-clip raster is merely bounded instead of
 * unbounded.
 *
 * The one thing that must never come back is the full-clip-width canvas: clips
 * are never viewport-culled, so a clip-width raster is unbounded by
 * construction (and past the browser's maximum canvas dimension on a long clip,
 * where it silently goes blank). Both bands here are viewport-derived, which is
 * the invariant `ClipView.test.tsx` and `ClipView.beatTics.test.tsx` pin.
 */

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

/** True while the escape-hatch modifier is held on THIS event (Task B4). Alt,
 * verified free against the BUILT app — see `useEditorGestures`'s header. */
function snapSuspended(e: { altKey: boolean }): boolean {
  return e.altKey;
}

/**
 * One clip on a track lane: a rounded rect (cyan) with the source name and,
 * over the slice of it that is on screen, the editor's own waveform drawn at
 * the current zoom (MT1-2). Pointer interactions:
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
  const laneBoundPx = useLaneWidthBound();
  // Only the on-screen slice of the clip is rasterised — see ticWindow. The
  // drag translation is included so the band still covers the lane while a clip
  // is being dragged, and the window is quantised so that costs a canvas resize
  // once per 256 px of movement rather than once per pointer event.
  //
  // MT1-2 — ONE band, shared by the waveform and the tics. B3 computed this for
  // the tic overlay alone because the waveform was a stretched full-clip raster;
  // now that both are position-accurate 1:1 rasters they want the identical
  // window, and sharing it means they cannot disagree about which part of the
  // clip is on screen (a half-pixel disagreement would show as tics sliding
  // against the audio they describe). It also means the quantum buys BOTH
  // canvases their "resize once per 256 px of travel" instead of one.
  // V1 — bounded by the widest a LANE can be, not by the whole window: every
  // row spends MT_HEADER_W on its header before the lane starts, so the raw
  // window width over-sized every raster by a header column. The bound is
  // rounded OUT to a whole number of quanta (`laneWidthBound`), which is what
  // keeps `ticWindow`'s two edges stepping together — without that, the band
  // moves twice per 256 px of travel and each move costs both canvases below a
  // full re-raster.
  const band = ticWindow(-(left + moveDx), widthPx, laneBoundPx);
  const showTics = beatTics !== null && band.width > 0;
  // Hoisted so the waveform effect can depend on the document's channel-array
  // identity and rate, not merely on the document object: an audio EDIT
  // replaces `doc.channels` (that identity is what `peaksCache` rebuilds on),
  // and the raster must follow it. Same reasoning as `useClipBeatTics`'s deps.
  const docChannels = doc?.channels;
  const docRate = doc?.sampleRate;

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

  // --- MT1-2, the waveform ------------------------------------------------
  //
  // The clip's waveform is the EDITOR's waveform: same envelope, same centre
  // trace, same axis, same vertical scale, same accent token, same bucket ↔
  // per-sample mode switch — because it is literally `drawWaveformLane`, the
  // body of `renderWaveform`'s per-channel loop, called here. Nothing about
  // "what a waveform looks like" lives in this file any more, so the two
  // surfaces cannot drift (they had already: one flat fill pass, no trace, no
  // axis, a hardcoded `rgba(38,198,218,0.85)` instead of `--accent`).
  //
  // WHAT MAKES IT SHARP. The raster covers only `band` — the on-screen slice —
  // at one column per CSS pixel times dpr, and is drawn at the CURRENT zoom.
  // The old path rasterised the clip's WHOLE timeline width into at most 4096
  // columns and blit-stretched that over the clip's CSS width, so the visible
  // part came from a few hundred magnified columns (see the note where the cap
  // used to live). Stretching is what cost the detail; not stretching is the
  // whole fix. This is also less memory than the cap it replaces, not more.
  //
  // WHY THERE IS NO OFFSCREEN CACHE ANY MORE. `clipWaveformCache` bucketed zoom
  // by `floor(log2(spp))` precisely so one bitmap could be blit-scaled across a
  // 2x zoom range — the trick that produced the blur. A resolution-correct
  // raster cannot be reused across zooms by definition, and it does not need to
  // be reused across scrolls either: the deps below are the QUANTISED band, so
  // React already skips the repaint until the band actually moves (once per
  // 256 px of travel), and the genuinely expensive part — building the peak
  // pyramid — is still cached, by `peaksCache`, per document. Measured on a
  // 3-minute source: `buildPeaks` 22 ms (cached, untouched here) versus 1.2 ms
  // for a 2432-column band from that pyramid — cheaper than the 1.95 ms
  // full-clip 4096-column raster the cache existed to avoid recomputing. A
  // cache keyed on something that changes on every zoom step, holding entries
  // that are cheaper to rebuild than to look up, is a memory leak wearing a
  // performance costume.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / no backend

    const dpr = window.devicePixelRatio || 1;
    const w = band.width;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(canvasH * dpr));
    // dpr-scaled, NOT identity: everything below is in CSS px, exactly as the
    // editor's canvas and the tic band are. The old identity transform was a
    // symptom of this canvas only ever receiving a blit.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, canvasH);
    if (w <= 0) return; // the clip is scrolled entirely off the lane
    if (!doc || docRate === undefined || docChannels === undefined) return;
    if (docChannels.length === 0) return;

    // Clip-local CSS px → SOURCE-document samples. The clip's two sample fields
    // live in different time bases (see clipBeatTics.ts's header): `startSample`
    // /`lengthSample` are session-rate timeline positions, `offsetSample`
    // indexes the source document at ITS rate. So a pixel spans
    // `samplesPerPixel · docRate/sessionRate` source samples, and the band's
    // left edge is that many per pixel into the clip from `offsetSample`.
    // Deliberately NOT via the old `docSpan` rounding helper: rounding the band
    // origin to a whole source sample would displace the picture by up to half
    // a sample, which is invisible at spp ≥ 1 and several pixels wide in the
    // per-sample mode below. The band never runs past the clip's own source
    // window because `ticWindow` clamps it to the clip's pixel width.
    const docSpp = zoom.samplesPerPixel * (docRate === sessionRate ? 1 : docRate / sessionRate);

    // Channel 0 only, where the editor draws one lane per channel: a clip lane
    // is ~40 px tall, so two 20 px lanes would show LESS of the audio, not
    // more. The clip surface is for arrangement; the editor is where a
    // waveform is inspected. Everything else about the drawing is identical.
    drawWaveformLane(ctx, {
      channel: docChannels[0],
      pyramid: getPyramids(doc)[0],
      width: w,
      laneTop: 0,
      laneH: canvasH,
      scrollSample: clip.offsetSample + band.start * docSpp,
      samplesPerPixel: docSpp,
    });
    // `moveDx` and `clip.lengthSample` are deliberately absent: both reach this
    // effect through `band`, quantised, so a drag or a trim re-rasters when the
    // visible band actually moves and not once per pointer event.
  }, [
    doc,
    docChannels,
    docRate,
    clip.offsetSample,
    band.start,
    band.width,
    canvasH,
    sessionRate,
    zoom.samplesPerPixel,
  ]);

  // Task B3 — the beat tics, on their OWN canvas.
  //
  // B3's original reason was that the waveform raster was capped at 4096 device
  // px and blit-STRETCHED across the clip's whole CSS width — right for a
  // min/max envelope, fatal for a POSITION, since one raster column spanned
  // many CSS px and every tic would have been displaced and fattened. MT1-2
  // removed the stretch, so that reason is gone; two things keep the canvases
  // separate anyway, and they are the reasons to cite from here on:
  //
  //  - **Repaint identity.** This overlay depends on the beat grid: a toggle,
  //    an analysis completing, a x2 / /2 correction. The waveform depends on
  //    none of those (see its deps above), and must not be re-rasterised by
  //    them — `ClipView.beatTics.test.tsx` pins exactly that. One canvas would
  //    mean one effect and every grid event repainting the audio.
  //  - **Extent.** The tic band is the bottom 14 px of the CLIP element; the
  //    waveform lane is `laneHeight - 22` px of it. Merging them would force
  //    one of the two out of its documented geometry (trap 16).
  useEffect(() => {
    const canvas = ticCanvasRef.current;
    if (!canvas || !beatTics || band.width <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / no backend

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(band.width * dpr));
    canvas.height = Math.max(1, Math.round(CLIP_TIC_BAND_PX * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, band.width, CLIP_TIC_BAND_PX);

    drawBeatTics(ctx, {
      ...beatTics,
      // The overlay's left edge is `band.start` CSS px into the clip, and
      // clip-local x 0 is exactly `clip.startSample` on the session timeline.
      scrollSample: clip.startSample + band.start * zoom.samplesPerPixel,
      samplesPerPixel: zoom.samplesPerPixel,
      width: band.width,
      baseline: CLIP_TIC_BAND_PX,
      beatHeight: CLIP_BEAT_TIC_PX,
      downbeatHeight: CLIP_DOWNBEAT_TIC_PX,
    });
    // `moveDx` is deliberately absent: `band` already carries it, quantised.
  }, [beatTics, band.start, band.width, zoom.samplesPerPixel, clip.startSample]);

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
   * by the preview and the commit so the two cannot disagree (trap 23).
   *
   * F11-4: only the RAW position — a delta from the pointerdown x — is this
   * component's own. The magnet, the clamp and the rounding moved into
   * `clipDropPosition.snapClipStart`, because a Files-panel/Explorer drop
   * (`TrackLane`) asks the same question from an absolute lane x and must get
   * the same answer. */
  const moveStartFor = (drag: DragState, clientX: number, alt: boolean): number =>
    snapClipStart(
      drag.origStart + (clientX - drag.startClientX) * zoom.samplesPerPixel,
      clip.lengthSample,
      drag.targets,
      zoom.samplesPerPixel,
      alt
    );

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
      // R3 (ruling 2): the fade drag commits live per pointermove through
      // setClipFade, so the whole drag is bracketed into ONE undo entry.
      beginSessionGesture('Set fade');
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
    // R3: commit the drag's single undo entry (no-op when nothing changed —
    // a corner click that never dragged). Bound to pointercancel too.
    endSessionGesture();
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
    // R3 (ruling 2): trim drags commit live per pointermove through trimClip,
    // so both trim modes are bracketed into ONE undo entry. The move mode is
    // NOT bracketed — it already previews via CSS translate and commits once
    // on drop (moveClip records its own single 'Move clip' entry).
    if (mode !== 'move') beginSessionGesture('Trim clip');
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
    // R3: closes the trim gesture opened on pointerdown (one entry for the
    // whole drag; none for a click). No-op for move mode — nothing is open,
    // and the moveClip below records its own entry. Fires on pointercancel
    // too via the JSX binding.
    endSessionGesture();
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
        // height, the 6px trim handles) untouched.
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
      {/* MT1-2 — the waveform band, positioned exactly like the tic band below
          and for the same reason: it covers the on-screen slice of the clip,
          so it needs the slice's own left edge, not the clip's.

          This also fixes a second, older defect. As `h-full w-full` the canvas
          sat BELOW the name label in flow while claiming 100 % of the clip's
          height, so it hung ~16 px past the clip's bottom edge into the
          overflow-hidden box: the lower third of every waveform was cut off,
          and the backing store (laneHeight - 22) was being stretched over a
          taller CSS box on top of that. Anchored to the clip's bottom edge at
          its true height, the whole envelope is on screen and 1:1 vertically. */}
      <canvas
        ref={canvasRef}
        data-testid="clip-waveform"
        className="pointer-events-none absolute"
        style={{ left: band.start, bottom: 0, width: band.width, height: canvasH }}
      />
      {/* X4 — fades, crossfades and overlap regions, on an SVG overlay.
          Deliberately NOT a third canvas (two shipped tests pin the canvas
          count, T29) and NOT the waveform canvas: a ramp spans the clip's WHOLE
          width while that canvas covers only the on-screen band, and a fade
          drag would cost a re-raster per pointer event (T30/T31/C8). SVG also
          keeps the ramp resolution-free. A child of the clip element, so it
          rides the move-drag translateX for free — no moveDx compensation
          (T34). */}
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
      {/* Beat tics (B3). Pinned to the clip element's BOTTOM edge — where the
          waveform band now also ends, so the tics sit over the bottom 14 px of
          the audio they describe rather than below a canvas whose own bottom
          strip was clipped away (trap 16, fixed at the source by MT1-2). Being
          a child of the clip, the band rides the move-drag transform, so the
          tics travel with the audio instead of lagging on the lane until the
          drop. */}
      {showTics && (
        <canvas
          ref={ticCanvasRef}
          data-testid="clip-beat-tics"
          className="pointer-events-none absolute"
          style={{
            left: band.start,
            bottom: 0,
            width: band.width,
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
