/**
 * Task F11-4 — the clip-position arithmetic a MOVE DRAG and a DROP must share.
 *
 * `snapClipStart` is lifted verbatim out of `ClipView`'s `moveStartFor`, where
 * it was the private half of a component. Two callers now need the same answer:
 *
 *  - the in-lane move drag (`ClipView`), which builds its raw position from a
 *    pointer DELTA (`origStart + dx · samplesPerPixel`), and
 *  - a drop from the Files panel or from Explorer (`TrackLane`), which builds
 *    its raw position from an ABSOLUTE lane x (`laneRawStart` below).
 *
 * Only the raw position differs; the magnet, the clamp and the rounding must
 * not. Copying those three lines into the drop handler would have created a
 * second definition of "where a clip lands", free to drift from the one the
 * drag uses — and trap 23 (preview and commit disagreeing) is exactly what
 * happens when one position is computed twice. So there is one function, and
 * both surfaces call it.
 *
 * Everything here is pure: no store, no DOM, no React. The zoom arrives as an
 * argument (trap 26 — the app has two independent zooms, and this surface's is
 * the session store's `mtZoom`), and the target set arrives as an argument too
 * (`sessionSnapTargets` decides WHO the targets are; this module only decides
 * where the clip lands among them).
 */
import { snapSpanTiered, type SnapTierList } from '../../services/snap';
import { pixelToSample } from '../Editor/waveformRender';

/** The lane's horizontal mapping — the session store's `mtZoom`. */
export interface LaneZoom {
  samplesPerPixel: number;
  scrollSample: number;
}

/**
 * The session sample under a viewport x on a lane, unsnapped.
 *
 * `laneLeft` is the lane element's own `getBoundingClientRect().left`, so the
 * 224 px header column never enters the arithmetic (trap 25: the lane's pixel
 * origin is NOT the window's). The conversion itself is `pixelToSample`, the
 * same one the ruler and the waveform use — a drop must not invent its own
 * pixel→sample map.
 */
export function laneRawStart(clientX: number, laneLeft: number, zoom: LaneZoom): number {
  return pixelToSample(clientX - laneLeft, zoom.scrollSample, zoom.samplesPerPixel);
}

/** What `snapClipStart` resolved: the start to commit, and the tier of the
 * winning target (`sessionSnapTiers`'s indices — 0 edge/cursor, 1 marker,
 * 2 beat) or `null` when nothing snapped, so a preview can show WHAT kind of
 * target took the clip without recomputing anything. */
export interface ClipStartSnap {
  start: number;
  tier: number | null;
}

/**
 * The clip start a gesture is asking for, snapped unless suspended.
 *
 * Shared by a preview and its commit so the two cannot disagree (trap 23).
 * Both edges of the span may catch a target — aligning a clip's tail to a beat
 * is as ordinary as aligning its head — which is `snapSpanTiered`'s job, and
 * since W2 the targets arrive as PRIORITY TIERS: an edge or the cursor
 * outranks a marker outranks a beat (see `sessionSnapTargets`'s header). The
 * clamp mirrors `moveClip`'s own `Math.max(0, …)`, and the rounding makes the
 * result a whole sample, as every clip position is.
 *
 * @param suspended Alt held on the event that produced `rawStart` — the
 *   escape hatch. With the magnet suspended (or with no targets at all) the
 *   raw position survives, clamped and rounded and nothing else.
 */
export function snapClipStart(
  rawStart: number,
  lengthSample: number,
  tiers: SnapTierList,
  samplesPerPixel: number,
  suspended: boolean
): ClipStartSnap {
  if (suspended) return { start: Math.max(0, Math.round(rawStart)), tier: null };
  const s = snapSpanTiered(rawStart, lengthSample, tiers, samplesPerPixel);
  const start = Math.max(0, Math.round(s.sample));
  // A snapped result is a whole sample (targets are integral, and so is a
  // clip's length), so the clamp is the only thing that can move `start` off
  // `s.sample` — and when it does, the commit no longer lands on the winning
  // target, so no tier label survives to make a preview claim otherwise.
  return { start, tier: start === s.sample ? s.tier : null };
}
