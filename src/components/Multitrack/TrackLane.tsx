import { useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { AudioDocument } from '../../audio/AudioDocument';
import {
  DOC_DRAG_MIME,
  draggedClipLength,
  draggedDocumentId,
  dropDocumentOnTrack,
  dropPayloadKind,
  type DropKind,
} from '../../multitrack/laneDrop';
import type { Track } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { sampleToPixel } from '../Editor/waveformRender';
import ClipView from './ClipView';
import { laneRawStart, snapClipStart } from './clipDropPosition';
import EnvelopeLane from './EnvelopeLane';
import { sessionSnapTargets } from './sessionSnapTargets';

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
  // is the snapped position the drop will actually commit, in lane pixels.
  const dropTargetsRef = useRef<number[] | null>(null);
  const [ghostPx, setGhostPx] = useState<number | null>(null);

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
  const dropStartSample = (e: ReactDragEvent<HTMLDivElement>): number =>
    snapClipStart(
      laneRawStart(e.clientX, e.currentTarget.getBoundingClientRect().left, zoom),
      draggedClipLength(sessionRate),
      dropTargetsRef.current ?? [],
      zoom.samplesPerPixel,
      e.altKey
    );

  const endDrag = () => {
    dropTargetsRef.current = null;
    setGhostPx(null);
    onDragOverTrack(null);
  };

  const onDragEnter = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!kindOf(e)) return;
    e.preventDefault();
    // Captured at the start of the gesture, exactly as a clip drag captures
    // its set at pointerdown: the targets a drag uses must not change under
    // the user's hand mid-gesture.
    dropTargetsRef.current = sessionSnapTargets(null);
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
    if (dropTargetsRef.current === null) dropTargetsRef.current = sessionSnapTargets(null);
    onDragOverTrack(track.id);
    setGhostPx(sampleToPixel(dropStartSample(e), zoom.scrollSample, zoom.samplesPerPixel));
  };

  const onDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    // dragleave also fires when the pointer crosses onto a CHILD of the lane
    // (a clip, the envelope overlay): the native event targets the element
    // being left and bubbles up to here. Only a leave that really exits the
    // lane ends the drag — otherwise the highlight would strobe every time
    // the pointer passed over a clip.
    const to = e.relatedTarget;
    if (to instanceof Node && e.currentTarget.contains(to)) return;
    endDrag();
  };

  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!kindOf(e)) return; // not ours — and no preventDefault, so nothing happened
    e.preventDefault();
    const startSample = dropStartSample(e);
    const dt = e.dataTransfer;
    endDrag();

    // The payload is authoritative now that the drop released it; the drag
    // record is the fallback for a dataTransfer that carried only the type.
    const docId = dt?.getData(DOC_DRAG_MIME) || draggedDocumentId();
    if (docId) dropDocumentOnTrack(docId, track.id, startSample);
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
      className="relative min-w-0 flex-1"
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
          never eat the dragover it exists to describe. */}
      {ghostPx !== null && (
        <div
          data-testid="clip-drop-ghost"
          className="pointer-events-none absolute top-0 bottom-0 w-0.5"
          style={{
            left: ghostPx,
            backgroundColor: 'var(--accent)',
            boxShadow: '0 0 8px var(--accent-ring)',
          }}
        />
      )}
    </div>
  );
}
