import { useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { AudioDocument } from '../../audio/AudioDocument';
import {
  DOC_DRAG_MIME,
  draggedClipLength,
  draggedDocumentId,
  dropDocumentOnTrack,
  dropFilesOnTrack,
  dropPayloadKind,
  type DropKind,
} from '../../multitrack/laneDrop';
import type { Track } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { sampleToPixel } from '../Editor/waveformRender';
import ClipView from './ClipView';
import { laneRawStart, snapClipStart, type ClipStartSnap } from './clipDropPosition';
import EnvelopeLane from './EnvelopeLane';
import { SNAP_TIER_EDGE, sessionSnapTiers, type SessionSnapTiers } from './sessionSnapTargets';

interface Zoom {
  samplesPerPixel: number;
  scrollSample: number;
}

interface TrackLaneProps {
  track: Track;
  docs: Map<string, AudioDocument>;
  zoom: Zoom;
  sessionRate: number;
  laneHeight: number;
  selectedClipId: string | null;
  isDragTarget: boolean;
  resolveTrackAt: (clientX: number, clientY: number) => string | null;
  onDragOverTrack: (trackId: string | null) => void;
}

/** The timeline lane for one track: a relatively-positioned strip holding its
 * clips (absolutely positioned by sample→pixel). Clicking empty lane space
 * clears the clip selection; `isDragTarget` highlights the lane a clip is being
 * dragged onto — by a clip's own pointer drag, or (F11-4) by an HTML5 drag
 * carrying a Files-panel row or a file from Explorer.
 *
 * V1 — WHY THIS ELEMENT IS `overflow-clip`, AND WHY IT HAS TO BE THIS ONE.
 * A clip's `left` is `(startSample − scrollSample) / spp`, so every clip whose
 * start has been scrolled past has a NEGATIVE left: its box legitimately
 * extends thousands of px to the left of the lane's origin, and its waveform
 * raster starts up to 255 px left of that origin as well, because the band is
 * quantised OUT to 256 px so a scroll within a quantum costs no re-raster
 * (`ticWindow`). The header column is 224 px — narrower than that worst case —
 * and it is a STATIC flex sibling, so a positioned clip paints over it, name,
 * M/S/R/X and all (the reported defect, seen at 381 % zoom).
 *
 * This lane is the only element that can bound it. `.glass-track-row`'s own
 * `overflow: hidden` clips at the ROW box, which contains the header, so it
 * arrives 224 px too late; clamping `band.start` to the lane origin would fix
 * the raster (and only the raster — not the clip's own fill, border, fade
 * overlay or label) at the cost of the quantum, i.e. a re-raster per scrolled
 * pixel. Clipping here bounds every clip child at once, and it works precisely
 * because this element is `relative`: an absolutely-positioned descendant is
 * only clipped by an ancestor that is its containing block. The two classes are
 * one mechanism — `TrackLane.clipping.test.tsx` pins both.
 *
 * `clip`, NOT `hidden`. Both clip painting and hit-testing identically, but
 * `hidden` also makes the lane a SCROLL CONTAINER, and a clip really does
 * extend millions of px past the lane's right edge at a working zoom, so there
 * would be genuine scrollable overflow to scroll. Nothing here ever resets
 * `scrollLeft`, and every pointer→sample mapping in this subtree reads the
 * border-box left with no `scrollLeft` term (`laneRawStart` below,
 * `pixelToSample(clientX − rectLeft, …)` in `EnvelopeLane`): one stray
 * `scrollIntoView`, or the first focusable control anyone adds to a lane, would
 * leave clips painted shifted by −`scrollLeft` while drops, envelope keys and
 * the drag ghost landed at the unshifted sample. `overflow: clip` cannot be
 * scrolled at all, so that is ruled out by the CSS instead of by an invariant
 * nothing enforces. (Chromium 90+; the app ships on Electron.)
 *
 * The two drag mechanisms stay strictly apart: a clip move is a POINTER
 * gesture with capture (it must track a pointer that has left the element),
 * while a drop from outside the window can only be an HTML5 drag, because the
 * OS gives a page nothing else. They meet only at `snapClipStart` — the same
 * magnet, the same clamp — and at `isDragTarget`, the same highlight. */
export default function TrackLane({
  track,
  docs,
  zoom,
  sessionRate,
  laneHeight,
  selectedClipId,
  isDragTarget,
  resolveTrackAt,
  onDragOverTrack,
}: TrackLaneProps) {
  const setSelectedClip = useSessionStore((s) => s.setSelectedClip);
  const mtEnvelope = useSessionStore((s) => s.mtEnvelope);

  // F11-4 — the drop in flight over THIS lane. The snap targets are captured
  // once when the drag enters (walking every clip in the session on each of
  // the many dragover events would be the trap-18 cost again), and the ghost
  // is the snapped position the drop will actually commit, in lane pixels —
  // W2: plus the TIER that took it, so an edge snap looks different from a
  // beat snap while the user can still see both.
  const dropTargetsRef = useRef<SessionSnapTiers | null>(null);
  const [ghost, setGhost] = useState<{ px: number; tier: number | null } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Only a click on empty lane space (not a clip) reaches here — clips call
    // stopPropagation — so clear the selection.
    if (e.button === 0) setSelectedClip(null);
  };

  /** What this drag is, or null for anything the lane does not accept. Read
   * from the TYPES, the only part of a dataTransfer a dragover may look at. */
  const kindOf = (e: ReactDragEvent<HTMLDivElement>): DropKind | null =>
    dropPayloadKind(e.dataTransfer?.types);

  /** Where the drop would land — the same arithmetic a clip move drag uses
   * (`snapClipStart`), from an absolute lane x instead of a pointer delta, and
   * with the same Alt escape hatch. */
  const dropStartSample = (e: ReactDragEvent<HTMLDivElement>): ClipStartSnap =>
    snapClipStart(
      laneRawStart(e.clientX, e.currentTarget.getBoundingClientRect().left, zoom),
      draggedClipLength(sessionRate),
      dropTargetsRef.current ?? [],
      zoom.samplesPerPixel,
      e.altKey
    );

  const endDrag = () => {
    dropTargetsRef.current = null;
    setGhost(null);
    onDragOverTrack(null);
  };

  const onDragEnter = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!kindOf(e)) return;
    e.preventDefault();
    // Captured at the start of the gesture, exactly as a clip drag captures
    // its set at pointerdown: the targets a drag uses must not change under
    // the user's hand mid-gesture.
    dropTargetsRef.current = sessionSnapTiers([]);
    onDragOverTrack(track.id);
  };

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!kindOf(e)) return;
    // THE acceptance signal: without preventDefault on dragover the browser
    // refuses the drop outright, and no drop event ever arrives.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    // A dragenter can be missed (a drag that begins already inside the lane);
    // the targets are still captured once, not per move.
    if (dropTargetsRef.current === null) dropTargetsRef.current = sessionSnapTiers([]);
    onDragOverTrack(track.id);
    const snap = dropStartSample(e);
    setGhost({
      px: sampleToPixel(snap.start, zoom.scrollSample, zoom.samplesPerPixel),
      tier: snap.tier,
    });
  };

  const onDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    // dragleave also fires when the pointer crosses onto a CHILD of the lane
    // (a clip, the envelope overlay): the native event targets the element
    // being left and bubbles up to here. Only a leave that really exits the
    // lane ends the drag — otherwise the highlight would strobe every time
    // the pointer passed over a clip.
    const to = e.relatedTarget;
    if (to instanceof Node && e.currentTarget.contains(to)) return;
    // This lane's own transient state always goes.
    dropTargetsRef.current = null;
    setGhost(null);
    // F11: but the SHARED highlight is only relinquished if this lane still
    // holds it. Crossing into a neighbouring lane fires that lane's `dragenter`
    // BEFORE this lane's `dragleave`, so clearing unconditionally would blank
    // the highlight the new lane had just claimed — one frame of no target at
    // every lane boundary.
    if (isDragTarget) onDragOverTrack(null);
  };

  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    const kind = kindOf(e);
    if (!kind) return; // not ours — and no preventDefault, so nothing happened
    e.preventDefault();
    const startSample = dropStartSample(e).start;
    const dt = e.dataTransfer;
    endDrag();

    if (kind === 'document') {
      // The payload is authoritative now that the drop released it; the drag
      // record is the fallback for a dataTransfer that carried only the type.
      const docId = dt?.getData(DOC_DRAG_MIME) || draggedDocumentId();
      if (docId) dropDocumentOnTrack(docId, track.id, startSample);
      return;
    }
    const files = dt?.files ? Array.from(dt.files) : [];
    if (files.length > 0) void dropFilesOnTrack(files, track.id, startSample);
  };

  return (
    <div
      data-track-id={track.id}
      data-testid="track-lane"
      onPointerDown={onPointerDown}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="relative min-w-0 flex-1 overflow-clip"
      style={{
        height: laneHeight,
        // G6: the floating .glass-track-row card paints the lane fill; the
        // drag-target highlight keeps its accent wash + inset ring, routed
        // through the tokens.
        backgroundColor: isDragTarget ? 'var(--accent-soft)' : 'transparent',
        boxShadow: isDragTarget ? 'inset 0 0 0 1px var(--accent)' : undefined,
      }}
    >
      {track.clips.map((clip) => (
        <ClipView
          key={clip.id}
          clip={clip}
          doc={docs.get(clip.documentId)}
          trackId={track.id}
          zoom={zoom}
          sessionRate={sessionRate}
          laneHeight={laneHeight}
          selected={clip.id === selectedClipId}
          resolveTrackAt={resolveTrackAt}
          onDragOverTrack={onDragOverTrack}
        />
      ))}
      {/* F0 — the envelope editing overlay, a TrackLane child (T23/T29: it
          belongs to the TRACK's timeline, resolves for cross-lane drops via
          the data-track-id ancestor, and never rides a clip's drag
          translate, T27). Rendered after the clips so it paints — and
          receives pointer events — above them while open. */}
      {mtEnvelope !== null && mtEnvelope.trackId === track.id && (
        <EnvelopeLane track={track} param={mtEnvelope.param} zoom={zoom} laneHeight={laneHeight} />
      )}
      {/* F11-4 — the drop ghost: where the clip's START edge will land, AFTER
          the magnet. Not the raw pointer x: the whole point of showing a line
          is that the user can see the snap take hold before letting go. Last
          child so it paints over the clips, and pointer-events-none so it can
          never eat the dragover it exists to describe.

          V1 review, Minor 2 — HELD AT THE LANE EDGE. `ghostPx` can be a few px
          negative when the magnet pulls the drop to a target just left of the
          lane origin (the drop sample itself is clamped at 0 by
          `snapClipStart`, but the SCROLLED origin is not 0). That sliver used
          to paint on the header — a symptom of the defect V1 fixed — and once
          the lane was clipped it painted nowhere, so the line disappeared at
          exactly the edge where a user most needs to see the snap take hold.
          Clamping the LINE is honest rather than a white lie: a clip landing at
          that sample is itself drawn with a negative left and clipped by the
          same edge, so the lane origin is precisely where its start will
          appear. The committed sample is untouched — only the drawing. */}
      {ghost !== null && (
        <div
          data-testid="clip-drop-ghost"
          /* W2 — the line names the tier that took the drop, and an
             EDGE/CURSOR snap paints near-white instead of accent: hard
             geometry the user placed reads differently from a derived beat,
             so a butt join is visibly a butt join before letting go. */
          data-snap-tier={
            ghost.tier === null ? undefined : (['edge', 'marker', 'beat'] as const)[ghost.tier]
          }
          className="pointer-events-none absolute top-0 bottom-0 w-0.5"
          style={{
            left: Math.max(0, ghost.px),
            backgroundColor:
              ghost.tier === SNAP_TIER_EDGE ? 'var(--glass-text-title)' : 'var(--accent)',
            // The halo follows the line: --glass-text-title (#f0f0f2) at the
            // same 35% alpha --accent-ring applies to --accent, so the white
            // edge line does not wear a cyan glow (review W2, nit 4).
            boxShadow:
              ghost.tier === SNAP_TIER_EDGE
                ? '0 0 8px rgba(240, 240, 242, 0.35)'
                : '0 0 8px var(--accent-ring)',
          }}
        />
      )}
    </div>
  );
}
