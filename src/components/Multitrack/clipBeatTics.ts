/**
 * Task B3 — the beat grid, mapped onto ONE multitrack clip.
 *
 * This is the half of the user's request that says *"make the tics follow each
 * track if separated"*: after a stem separation each stem's lane shows the same
 * grid, in the same places, because it **is** the same grid — B1's
 * `getBeatGrid` resolves a stem through its parent, so nothing here re-derives
 * anything per lane.
 *
 * ---------------------------------------------------------------------------
 * THE MAPPING (plan ruling 1, verified against readClipSlice)
 * ---------------------------------------------------------------------------
 * A clip's two sample fields live in DIFFERENT time bases
 * (`multitrack/session.ts:5-8`): `startSample`/`lengthSample` are positions on
 * the session timeline, at the SESSION rate, while `offsetSample` indexes the
 * SOURCE document, at the document's own rate. `readClipSlice`
 * (`mixdown.ts:83-102`) reads `round(lengthSample · docRate / sessionRate)`
 * source samples starting at `offsetSample` and resamples them up to the
 * session rate, so source sample `b` is heard at
 *
 *     sessionPos = clip.startSample + round((b − clip.offsetSample) · sessionRate / docRate)
 *
 * and that is where its tic must be drawn. On a rate-matched clip the factor is
 * 1 and the expression collapses to `startSample + (b − offsetSample)`; on a
 * mismatched one (a 48 kHz file in a 44.1 kHz session — the realistic case)
 * dropping the factor drifts the tics ~8.8 % out of the audio, which looks
 * plausible and is wrong. `clipSourceWindow` (`multitrack/session`) applies
 * the same conversion to the clip's length.
 *
 * The clip's source window is **half-open**, `[offsetSample, offsetSample +
 * span)`, exactly as `readClipSlice` reads it. A beat exactly at the end
 * therefore belongs to whatever clip follows, so two clips splitting a document
 * at a beat draw that beat once, on the later one, instead of twice at the
 * seam.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE REFUSES TO GUESS
 * ---------------------------------------------------------------------------
 * - **A clip can outlive its source document** (`ClipView`'s `doc` is
 *   legitimately `undefined` — a clip keeps playing from a closed document's
 *   id in the session model). With no document there is no `docRate`, and the
 *   conversion above is undefined. No tics, no fallback rate, no crash.
 * - **A grid expressed in a different rate from the clip's source** is refused
 *   rather than reinterpreted. B1 guarantees `grid.sampleRate ===
 *   doc.sampleRate` for every grid it produces (inheritance requires equal
 *   rates), so this is defensive; it is here because silently treating 48 kHz
 *   positions as 44.1 kHz ones is precisely the failure mode ruling 1 exists to
 *   prevent.
 * - **Nothing past `analyzedEndSample`.** On a long file the grid legitimately
 *   covers only the analysed prefix, and a clip taken from past that point
 *   correctly gets NO tics — an empty tic set is an ordinary outcome here, not
 *   a bug.
 *
 * ---------------------------------------------------------------------------
 * WHY `getBeatGrid` AND NOT `getTempo` (trap 18)
 * ---------------------------------------------------------------------------
 * The analysis cache holds four rows. Five stems plus their source is six
 * documents, so a per-clip `getTempo` would thrash the cache on exactly the
 * workflow this feature exists for — and would analyse each stem separately,
 * which is musically wrong (see `beatGrid.ts`'s header). `getBeatGrid` already
 * implements the inheritance; this module asks it one question per clip and
 * never touches the analysis layer directly.
 */
import { useMemo, useSyncExternalStore } from 'react';
import type { AudioDocument } from '../../audio/AudioDocument';
import { CONFIDENCE_LOW } from '../../dsp/tempoCore';
import type { Clip } from '../../multitrack/session';
import { laneWidthFromScrollerWidth } from '../../multitrack/sessionViewport';
import { getBeatGrid, isDownbeat, useBeatGridVersion, type BeatGrid } from '../../services/beatGrid';
import { useBeatGridVisible } from '../../services/beatGridDisplay';
import type { BeatGridOverlay } from '../Editor/waveformRender';

/**
 * Height of the tic band on a clip, in CSS px, measured UP from the clip
 * element's bottom edge.
 *
 * **Not the bottom of the clip's waveform canvas** (trap 16): that canvas is
 * `h-full` *below* the clip's name label inside an `overflow-hidden` box, so
 * its bottom ~16 px are cut off and anything drawn there is invisible. The band
 * is pinned to the bottom of the clip element itself, which is the lowest strip
 * of the clip that is actually on screen.
 */
export const CLIP_TIC_BAND_PX = 14;
/** Tic length for an ordinary beat, CSS px (the editor's 9 px, scaled to a lane). */
export const CLIP_BEAT_TIC_PX = 8;
/** Tic length for a MEASURED downbeat — never used unless `beatsPerBar` is real. */
export const CLIP_DOWNBEAT_TIC_PX = 13;

/**
 * Granularity of the tic overlay's window, in CSS px.
 *
 * The window is snapped OUT to a multiple of this, so panning, zooming or
 * dragging only resizes the overlay canvas once every `TIC_WINDOW_QUANTUM_PX`
 * of movement instead of on every pointer event — a canvas resize reallocates
 * its backing store and is the one genuinely expensive thing in this path.
 * The cost is at most two extra quanta of width.
 */
export const TIC_WINDOW_QUANTUM_PX = 256;

/**
 * The slice of a clip the tic overlay actually covers, in clip-local CSS px.
 *
 * **Why not simply the whole clip (trap: v1.5.2's regression).** Clips are
 * never viewport-culled, and at a working zoom a five-minute clip is millions
 * of CSS px wide. Sizing an overlay to that would allocate a canvas past the
 * browser's maximum dimension (where it silently goes blank) and reintroduce
 * exactly the unbounded per-clip raster the 4096-px waveform cap was added to
 * fix. Capping-and-stretching — what the waveform canvas does — is not
 * available here: stretching is fine for a min/max envelope and **fatal for a
 * position**, since one raster column would span many CSS px and every tic
 * would be both displaced and fattened.
 *
 * So the overlay covers only the part of the clip that can be on screen. The
 * clip does not know the lane's width, but it knows an upper bound on it: the
 * lane cannot be wider than the window less the header column every row spends
 * before the lane starts — see {@link laneWidthBound} and
 * {@link useLaneWidthBound}. A clip entirely outside that band gets width 0 and
 * no canvas at all.
 *
 * @param laneOriginLocal clip-local x of the lane's left edge, i.e. `-left`
 *   (plus any in-flight drag translation).
 */
export function ticWindow(
  laneOriginLocal: number,
  clipWidthPx: number,
  viewportPx: number
): { start: number; width: number } {
  if (!Number.isFinite(laneOriginLocal) || !(clipWidthPx > 0) || !(viewportPx > 0)) {
    return { start: 0, width: 0 };
  }
  const q = TIC_WINDOW_QUANTUM_PX;
  const start = Math.max(0, Math.floor(laneOriginLocal / q) * q);
  const end = Math.min(clipWidthPx, Math.ceil((laneOriginLocal + viewportPx) / q) * q);
  return { start, width: Math.max(0, end - start) };
}

function subscribeViewport(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
}

function viewportSnapshot(): number {
  return typeof window === 'undefined' ? 0 : window.innerWidth;
}

/**
 * The widest a track lane can be inside a window `viewportPx` CSS px wide,
 * rounded OUT to a whole number of {@link TIC_WINDOW_QUANTUM_PX}.
 *
 * Every track row is `[TrackHeader | TrackLane]`, so the lane starts one header
 * column in and no lane, in any layout, can be wider than the window minus that
 * column. V1 — `ticWindow` used to be handed the raw window width, one header
 * column looser than that. The subtraction itself is
 * {@link laneWidthFromScrollerWidth}, borrowed rather than repeated (V1 review,
 * Minor 1): its argument is any outer box a row lies inside, which the window
 * is, and one arithmetic cannot drift from itself.
 *
 * WHY THE ROUNDING, AND WHY OUT (V1 fix round 1). `ticWindow` snaps `start`
 * DOWN and `end` UP to the same grid, so the two edges step at the same scroll
 * positions only when the span between them is a whole number of quanta. Handed
 * a bare `viewportPx − 224` they fall out of phase — `end` steps at
 * `origin ≡ 224 (mod 256)`, `start` at `≡ 0` — and every visible clip
 * reallocates and repaints BOTH its canvases twice per 256 px of travel instead
 * of once, which is the promise {@link TIC_WINDOW_QUANTUM_PX} makes in so many
 * words. Measured at 2.00 transitions per quantum against 1.00; the
 * distinct-window pin could not see it, so `clipBeatTics.test.ts`'s lockstep
 * suite counts TRANSITIONS.
 *
 * Rounding OUT rather than in, because the result must stay an upper bound: a
 * bound short of the real lane width leaves an unrastered strip down the right
 * of every wide clip — a visible hole, where an over-wide band only costs
 * columns. The slack is under one quantum, and the result is never worse than
 * the window width it replaced: equal on a window that is a whole number of
 * quanta, tighter on every other (1792 rather than 1920, say).
 *
 * Deliberately a BOUND derived from the window rather than
 * `sessionViewport.sessionLaneWidth()`, which is the real measurement: that
 * value publishes no change notification of its own, so a ClipView reading it
 * could hold a stale, too-SMALL width and leave exactly that hole. The band's
 * job is to be an upper bound, not a best guess.
 */
export function laneWidthBound(viewportPx: number): number {
  const lane = Math.max(0, laneWidthFromScrollerWidth(viewportPx));
  return Math.ceil(lane / TIC_WINDOW_QUANTUM_PX) * TIC_WINDOW_QUANTUM_PX;
}

/**
 * {@link laneWidthBound} of the window's CSS width, re-read on resize.
 * `ticWindow` needs an upper bound on the lane width and nothing in the
 * multitrack tree re-renders on a resize, so without this subscription a window
 * widened past the last-known bound would leave the right-hand part of a wide
 * clip without tics until the next zoom/scroll.
 */
export function useLaneWidthBound(): number {
  const viewportPx = useSyncExternalStore(subscribeViewport, viewportSnapshot, viewportSnapshot);
  return laneWidthBound(viewportPx);
}

/** The only three clip fields the mapping reads. Narrowed from `Clip` so the
 * pure half stays callable with a plain literal (and so the memo below cannot
 * close over a stale clip object it does not depend on). */
export type ClipSpan = Pick<Clip, 'startSample' | 'offsetSample' | 'lengthSample'>;

/** The mapped positions plus, for each, the index it had in the SOURCE grid —
 * which is what `isDownbeat` has to be asked about, since a clip usually starts
 * partway into the grid. */
export interface MappedBeats {
  /** Ascending session-timeline sample positions, inside the clip's extent. */
  beats: number[];
  /** `beatIndex[i]` is the index of `beats[i]` in `grid.beatSamples`. */
  beatIndex: number[];
}

/** Index of the first beat at or after `value`, by binary search. The grid is
 * ascending by construction, and this keeps a clip's cost O(log n + its own
 * beats) rather than O(document length) — a session can hold many clips and
 * none of them are viewport-culled. */
function firstBeatAtOrAfter(beats: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (beats[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Source samples spanned by `lengthSample` session samples — `clipSourceWindow`
 * (`multitrack/session`) and `readClipSlice`'s own conversion, kept identical on purpose. */
function docSpan(lengthSample: number, docRate: number, sessionRate: number): number {
  return docRate === sessionRate ? lengthSample : Math.round((lengthSample * docRate) / sessionRate);
}

/**
 * Maps `grid`'s beat positions onto `clip`'s span of the session timeline.
 *
 * Never mutates, sorts or copies `grid.beatSamples` — it is the analysis cache's
 * own shared `Int32Array`, handed to every other consumer as well (trap 20); it
 * is only ever indexed.
 */
export function mapBeatsToClip(
  grid: BeatGrid,
  clip: ClipSpan,
  docRate: number,
  sessionRate: number
): MappedBeats {
  const beats: number[] = [];
  const beatIndex: number[] = [];

  const source = grid.beatSamples;
  const clipEnd = clip.startSample + clip.lengthSample;
  const docStart = clip.offsetSample;
  // Half-open, exactly as readClipSlice reads it, and never past where the
  // analysis actually stopped.
  const docEnd = docStart + docSpan(clip.lengthSample, docRate, sessionRate);
  const ratio = sessionRate / docRate;

  for (let i = firstBeatAtOrAfter(source, docStart); i < source.length; i++) {
    const b = source[i];
    if (b >= docEnd || b > grid.analyzedEndSample) break;
    const pos =
      docRate === sessionRate
        ? clip.startSample + (b - docStart)
        : clip.startSample + Math.round((b - docStart) * ratio);
    // Rounding can never push a beat out of the extent, but a clip whose
    // offset/length were edited independently of each other could — a tic
    // outside its own clip is worse than a missing one.
    if (pos < clip.startSample || pos > clipEnd) continue;
    beats.push(pos);
    beatIndex.push(i);
  }

  return { beats, beatIndex };
}

/**
 * The renderer-shaped overlay for one clip, or `null` when there is nothing to
 * draw. `null` covers every legitimate "no tics" case — no grid, a grid that
 * does not cover this clip, a source document that has closed — so the caller
 * has exactly one thing to test.
 *
 * The `provisional` rule and the "`isDownbeat` only when `beatsPerBar` is real"
 * rule are copied verbatim from `useBeatGridOverlay` so the editor band and the
 * clip band can never disagree about whether a grid is trustworthy.
 */
export function buildClipTicOverlay(
  grid: BeatGrid | null,
  clip: ClipSpan,
  docRate: number,
  sessionRate: number
): BeatGridOverlay | null {
  if (!grid) return null;
  // No rate, no conversion — and never a guessed one (trap 17).
  if (!Number.isFinite(docRate) || docRate <= 0) return null;
  if (!Number.isFinite(sessionRate) || sessionRate <= 0) return null;
  // The grid's positions must be in the clip source's own time base.
  if (grid.sampleRate !== docRate) return null;

  const { beats, beatIndex } = mapBeatsToClip(grid, clip, docRate, sessionRate);
  if (beats.length === 0) return null;

  return {
    beats,
    // AMENDED RULING 1: downbeats ONLY when a metre was genuinely measured, and
    // asked about the beat's index in the SOURCE grid, not in the mapped array.
    isDownbeat:
      grid.beatsPerBar === null ? undefined : (index: number) => isDownbeat(grid, beatIndex[index]),
    endSample: clip.startSample + clip.lengthSample,
    provisional: grid.stale || grid.confidence < CONFIDENCE_LOW,
  };
}

/**
 * The beat-tic overlay for one clip, in SESSION samples.
 *
 * Memoised, because `getBeatGrid` builds a fresh object per call and the result
 * feeds a canvas-paint effect: an unmemoised read would repaint every clip on
 * every render. The deps are everything the answer can actually depend on:
 *
 *  - `useBeatGridVersion()` — analysis start / completion / invalidation *and*
 *    B1's provenance links. **Without it the tics never appear**, because
 *    nothing else in `ClipView`'s inputs changes when an analysis finishes or a
 *    ×2/÷2 correction lands (trap 19): the clip would keep its stale picture
 *    until an unrelated re-render.
 *  - `doc?.channels` — an audio EDIT replaces the channel arrays and makes the
 *    cached grid stale, and `getTempo` only flags `.stale` when it is next read,
 *    so no version counter moves at that moment (the same gap
 *    `useBeatGridOverlay` closes the same way).
 *  - the clip's own geometry and the two rates.
 */
export function useClipBeatTics(
  clip: Clip,
  doc: AudioDocument | undefined,
  sessionRate: number
): BeatGridOverlay | null {
  const visible = useBeatGridVisible();
  const version = useBeatGridVersion();
  const docRate = doc?.sampleRate;
  const channels = doc?.channels;

  const { documentId, startSample, offsetSample, lengthSample } = clip;

  return useMemo(() => {
    if (!visible) return null;
    if (docRate === undefined) return null; // the clip outlived its source
    return buildClipTicOverlay(
      getBeatGrid(documentId),
      { startSample, offsetSample, lengthSample },
      docRate,
      sessionRate
    );
    // `version` and `channels` are change tokens, not values read in the body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    documentId,
    startSample,
    offsetSample,
    lengthSample,
    docRate,
    channels,
    sessionRate,
    visible,
    version,
  ]);
}
