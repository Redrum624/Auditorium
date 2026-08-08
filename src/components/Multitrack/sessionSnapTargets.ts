/**
 * Task B4 — WHAT a dragged clip's magnet snaps to, in SESSION samples.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DRAGGED CLIP IS EXCLUDED (trap 27)
 * ---------------------------------------------------------------------------
 * A clip carries its beat grid with it: every one of its own tics sits at a
 * fixed offset from its own start, so "snap the clip's start to one of the
 * clip's own tics" is satisfied at *every* position and moves nothing. Snapping
 * a dragged clip to its own mapped grid is a no-op by construction. The target
 * set is therefore the SESSION's: the other clips' mapped grids, their source
 * markers, and the multitrack cursor.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY *NOT* A TARGET
 * ---------------------------------------------------------------------------
 * **Clip edges.** Butt-joining two clips is the other classic multitrack
 * magnet, but the plan's target set is "beats, bar lines (when measured), and
 * markers" and trap 27's is "other clips' grids, the session cursor, markers" —
 * neither includes an edge, and v1.8 task X5 is about to make same-track clip
 * boundaries first-class *crossfade joins*. Snapping to a boundary that is
 * about to change meaning belongs to that feature, not to this one. Note that a
 * clip's first beat usually coincides with its start anyway (`offsetSample` 0),
 * so head-to-head alignment mostly works already, via the grid.
 *
 * ---------------------------------------------------------------------------
 * THE MAPPING
 * ---------------------------------------------------------------------------
 * Plan ruling 1, the same conversion B3 draws the tics with — `mapBeatsToClip`
 * is reused verbatim for beats so the magnet can never disagree with the tic it
 * is pulling towards, and `mapClipSourceSample` below applies the identical
 * arithmetic to a marker.
 */
import type { AudioDocument } from '../../audio/AudioDocument';
import type { Clip } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { getBeatGrid, type BeatGrid } from '../../services/beatGrid';
import { mergeTargets } from '../../services/snap';
import { isSnapEnabled } from '../../services/snapPreference';
import { useAppStore } from '../../stores/appStore';
import { mapBeatsToClip, type ClipSpan } from './clipBeatTics';

/** Source samples spanned by `lengthSample` session samples — `readClipSlice`'s
 * own conversion, kept identical on purpose (also in `ClipView` and
 * `clipBeatTics`). */
function docSpan(lengthSample: number, docRate: number, sessionRate: number): number {
  return docRate === sessionRate ? lengthSample : Math.round((lengthSample * docRate) / sessionRate);
}

/**
 * Where a SOURCE-document sample is heard on the SESSION timeline for `clip`,
 * or `null` when it falls outside the clip's half-open source window
 * `[offsetSample, offsetSample + span)` — exactly the window `readClipSlice`
 * reads, so a position at the far edge belongs to whatever clip follows rather
 * than being drawn twice at a seam.
 *
 * Never invents a rate: a missing or non-positive rate on either side yields
 * `null` rather than a guessed conversion.
 */
export function mapClipSourceSample(
  sourceSample: number,
  clip: ClipSpan,
  docRate: number,
  sessionRate: number
): number | null {
  if (!Number.isFinite(sourceSample)) return null;
  if (!Number.isFinite(docRate) || docRate <= 0) return null;
  if (!Number.isFinite(sessionRate) || sessionRate <= 0) return null;

  const docStart = clip.offsetSample;
  const docEnd = docStart + docSpan(clip.lengthSample, docRate, sessionRate);
  if (sourceSample < docStart || sourceSample >= docEnd) return null;

  return docRate === sessionRate
    ? clip.startSample + (sourceSample - docStart)
    : clip.startSample + Math.round(((sourceSample - docStart) * sessionRate) / docRate);
}

/** One clip's contribution to the session target set, already resolved from the
 * stores so the builder below stays pure. */
export interface ClipSnapSource {
  clipId: string;
  clip: ClipSpan;
  /** The source document's sample rate, or `null` when the clip has outlived
   * its source (a clip legitimately keeps a closed document's id). */
  docRate: number | null;
  grid: BeatGrid | null;
  /** The source document's marker positions, in SOURCE samples. */
  markers: readonly number[];
}

/**
 * The pure half: an ascending, duplicate-free set of session-sample targets.
 *
 * @param excludeClipId the clip being dragged — see the trap-27 note above.
 * @param extra positions already in session samples (the multitrack cursor).
 */
export function buildSessionSnapTargets(
  sources: readonly ClipSnapSource[],
  sessionRate: number,
  excludeClipId: string | null,
  extra: ArrayLike<number> = []
): number[] {
  const lists: number[][] = [];

  for (const s of sources) {
    if (s.clipId === excludeClipId) continue;
    const docRate = s.docRate;
    if (docRate === null) continue; // no rate, no conversion, no guess

    if (s.grid && s.grid.sampleRate === docRate) {
      // Reused verbatim from B3 so the magnet and the drawn tic are the same
      // position by construction. `beatSamples` is only indexed in there.
      lists.push(mapBeatsToClip(s.grid, s.clip, docRate, sessionRate).beats);
    }

    if (s.markers.length > 0) {
      const mapped: number[] = [];
      for (const m of s.markers) {
        const pos = mapClipSourceSample(m, s.clip, docRate, sessionRate);
        if (pos !== null) mapped.push(pos);
      }
      if (mapped.length > 0) lists.push(mapped);
    }
  }

  return mergeTargets(...lists, extra);
}

/**
 * The session's snap targets, resolved from the stores. Empty — with no work
 * done at all — whenever the magnet is off.
 *
 * `getBeatGrid` is asked ONCE per distinct source document rather than once per
 * clip: the workflow this feature exists for is five stems of one source, and
 * the analysis cache holds four rows, so repeating the lookup per clip is
 * exactly the pressure B1's inheritance was built to relieve (trap 18).
 *
 * Deliberately a plain function, not a hook — see the note in
 * `editorSnapTargets.ts`. It is called once at pointerdown; the set a drag uses
 * is the set as it stood when the drag began.
 */
export function sessionSnapTargets(excludeClipId: string | null): number[] {
  if (!isSnapEnabled()) return [];

  const { session, mtCursorSample } = useSessionStore.getState();
  const { documents, markers } = useAppStore.getState();

  const docsById = new Map<string, AudioDocument>(documents.map((d) => [d.id, d]));
  const gridCache = new Map<string, BeatGrid | null>();
  const gridFor = (docId: string): BeatGrid | null => {
    if (!gridCache.has(docId)) gridCache.set(docId, getBeatGrid(docId));
    return gridCache.get(docId) ?? null;
  };

  const sources: ClipSnapSource[] = [];
  for (const track of session.tracks) {
    for (const clip of track.clips) {
      const doc = docsById.get(clip.documentId);
      sources.push({
        clipId: clip.id,
        clip: clipSpan(clip),
        docRate: doc ? doc.sampleRate : null,
        grid: doc ? gridFor(clip.documentId) : null,
        markers: (markers[clip.documentId] ?? []).map((m) => m.positionSample),
      });
    }
  }

  return buildSessionSnapTargets(sources, session.sampleRate, excludeClipId, [mtCursorSample]);
}

function clipSpan(clip: Clip): ClipSpan {
  return {
    startSample: clip.startSample,
    offsetSample: clip.offsetSample,
    lengthSample: clip.lengthSample,
  };
}
