import type { PointerEvent as ReactPointerEvent } from 'react';
import type { AudioDocument } from '../../audio/AudioDocument';
import type { Track } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import ClipView from './ClipView';

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
 * dragged onto. */
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

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Only a click on empty lane space (not a clip) reaches here — clips call
    // stopPropagation — so clear the selection.
    if (e.button === 0) setSelectedClip(null);
  };

  return (
    <div
      data-track-id={track.id}
      data-testid="track-lane"
      onPointerDown={onPointerDown}
      className="relative min-w-0 flex-1 border-b border-[#3a3a42]"
      style={{
        height: laneHeight,
        backgroundColor: isDragTarget ? '#26c6da14' : '#1a1a1e',
        boxShadow: isDragTarget ? 'inset 0 0 0 1px #26c6da' : undefined,
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
    </div>
  );
}
