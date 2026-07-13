import { useCallback, useRef, useState } from 'react';
import { FileDown, FilePlus2, Plus } from 'lucide-react';
import { runCommand } from '../../services/menuActions';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import TimelineRuler from '../Editor/TimelineRuler';
import { sampleToPixel } from '../Editor/waveformRender';
import TrackHeader from './TrackHeader';
import TrackLane from './TrackLane';
import { useMultitrackZoom } from './useMultitrackZoom';

const HEADER_W = 224; // Tailwind w-56 (14rem)
const LANE_H = 96; // Tailwind h-24

/**
 * The multitrack editor. Left column of TrackHeaders aligned with a right lane
 * area sharing the session store's own zoom (`mtZoom`); a TimelineRuler on top
 * seeks the multitrack cursor; a playhead line tracks realtime playback. Works
 * with no open document (an empty session shows a hint). Vertical track scroll
 * is a single scroller with the header + lane in each row; horizontal zoom/scroll
 * is Ctrl/Shift-wheel over the lanes (see useMultitrackZoom).
 */
export default function MultitrackView() {
  const session = useSessionStore((s) => s.session);
  const mtZoom = useSessionStore((s) => s.mtZoom);
  const selectedClipId = useSessionStore((s) => s.selectedClipId);
  const mtCursorSample = useSessionStore((s) => s.mtCursorSample);
  const mtPlayState = useSessionStore((s) => s.mtPlayState);
  const mtPlayheadSample = useSessionStore((s) => s.mtPlayheadSample);
  const setMtCursor = useSessionStore((s) => s.setMtCursor);
  const addTrack = useSessionStore((s) => s.addTrack);

  const documents = useAppStore((s) => s.documents);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useMultitrackZoom(scrollRef);

  const [dragTargetTrackId, setDragTargetTrackId] = useState<string | null>(null);

  const docs = new Map(documents.map((d) => [d.id, d]));
  const hasClips = session.tracks.some((t) => t.clips.length > 0);
  const hasActiveDoc = activeDocumentId !== null;

  const resolveTrackAt = useCallback((clientX: number, clientY: number): string | null => {
    const el = document.elementFromPoint(clientX, clientY);
    const lane = el instanceof Element ? el.closest('[data-track-id]') : null;
    return lane?.getAttribute('data-track-id') ?? null;
  }, []);

  const cursorX = HEADER_W + sampleToPixel(mtCursorSample, mtZoom.scrollSample, mtZoom.samplesPerPixel);
  const playheadX =
    HEADER_W + sampleToPixel(mtPlayheadSample, mtZoom.scrollSample, mtZoom.samplesPerPixel);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#1a1a1e]" data-testid="multitrack-view">
      {/* Toolbar strip */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[#3a3a42] bg-[#232328] px-2">
        <button
          type="button"
          disabled={!hasActiveDoc}
          onClick={() => void runCommand('multitrack.insertDoc')}
          className="flex items-center gap-1 rounded border border-[#3a3a42] bg-[#2e2e34] px-2 py-1 text-xs text-[#d4d4d8] transition-colors enabled:hover:bg-[#3a3a42] disabled:opacity-40"
        >
          <FilePlus2 size={13} /> Insert Active File
        </button>
        <button
          type="button"
          disabled={!hasClips}
          onClick={() => void runCommand('multitrack.mixdown')}
          className="flex items-center gap-1 rounded border border-[#3a3a42] bg-[#2e2e34] px-2 py-1 text-xs text-[#d4d4d8] transition-colors enabled:hover:bg-[#3a3a42] disabled:opacity-40"
        >
          <FileDown size={13} /> Mix Down
        </button>
        <span className="ml-auto text-[10px] text-[#8b8b92]">
          {(session.sampleRate / 1000).toFixed(1)} kHz · Ctrl+wheel zoom · Shift+wheel scroll
        </span>
      </div>

      {/* Ruler row (spacer over the header column, ruler over the lanes) */}
      <div className="flex shrink-0">
        <div className="w-56 shrink-0 border-r border-[#3a3a42] bg-[#232328]" />
        <div className="min-w-0 flex-1">
          <TimelineRuler sampleRate={session.sampleRate} zoom={mtZoom} onSeek={setMtCursor} />
        </div>
      </div>

      {/* Lanes + headers (relative wrapper carries the playhead/cursor overlays) */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={scrollRef} className="h-full overflow-y-auto overflow-x-hidden">
          {session.tracks.map((track) => (
            <div key={track.id} className="flex" style={{ height: LANE_H }}>
              <TrackHeader track={track} />
              <TrackLane
                track={track}
                docs={docs}
                zoom={mtZoom}
                sessionRate={session.sampleRate}
                laneHeight={LANE_H}
                selectedClipId={selectedClipId}
                isDragTarget={dragTargetTrackId === track.id}
                resolveTrackAt={resolveTrackAt}
                onDragOverTrack={setDragTargetTrackId}
              />
            </div>
          ))}

          <button
            type="button"
            onClick={() => addTrack()}
            className="m-2 flex items-center gap-1 rounded border border-dashed border-[#3a3a42] px-3 py-1.5 text-xs text-[#8b8b92] transition-colors hover:border-[#26c6da] hover:text-[#d4d4d8]"
          >
            <Plus size={13} /> Add Track
          </button>

          {!hasClips && (
            <div className="pointer-events-none px-4 py-6 text-center text-xs text-[#8b8b92]">
              Empty session. Open an audio file, then use “Insert Active File” to place it on a track.
            </div>
          )}
        </div>

        {/* Multitrack cursor (white) — where playback will start. */}
        <div
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-[#d4d4d8]/70"
          style={{ left: cursorX }}
        />
        {/* Playhead (yellow) while playing. */}
        {mtPlayState === 'playing' && (
          <div
            data-testid="mt-playhead"
            className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-[#ffd54f]"
            style={{ left: playheadX }}
          />
        )}
      </div>
    </div>
  );
}
