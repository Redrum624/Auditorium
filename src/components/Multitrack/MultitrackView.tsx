import { useCallback, useEffect, useRef, useState } from 'react';
import { FileDown, FilePlus2, Plus } from 'lucide-react';
import { GlassButton } from '../UI/glass';
import { runCommand } from '../../services/menuActions';
import { useAppStore } from '../../stores/appStore';
import { publishSessionLaneWidth, useSessionStore } from '../../multitrack/sessionStore';
import TimelineRuler from '../Editor/TimelineRuler';
import { sampleToPixel } from '../Editor/waveformRender';
import { sessionSnapTargets } from './sessionSnapTargets';
import TrackHeader from './TrackHeader';
import TrackLane from './TrackLane';
import { useMultitrackZoom } from './useMultitrackZoom';

const HEADER_W = 224; // Tailwind w-56 (14rem)
const LANE_H = 96; // Tailwind h-24

/** F11-2: the ruler's magnet targets for THIS surface — every clip edge, bar
 * and beat in the session. Nothing is excluded: a ruler seek is not a clip
 * drag, so there is no clip whose own edges must be left out. */
function mtSnapTargets(): number[] {
  return sessionSnapTargets(null);
}

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

  // MT1-1: this scroller IS the stage the session zoom fits to, and nothing else
  // in the app knows how wide it is — the same fact `WaveformView` publishes for
  // the editor, published here for the session. `publishSessionLaneWidth` takes
  // the SCROLLER's width and subtracts the header column itself, so the 224 px
  // constant stays a layout fact of this file and a zoom fact of exactly one
  // module. A session opened before any lane existed was fitted to the FALLBACK
  // width, so the first real measurement re-fits it — but only because those
  // load paths now commit a fitted zoom (C1). While they wrote a hardcoded 512
  // this effect rescued nothing: `publishSessionLaneWidth` only re-fits a view
  // already AT its fit, and 512 is far zoomed in of it for any real session.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => publishSessionLaneWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  // G6: the view sits on the radial stage (stage-inset root) with each track
  // row floating as a glass card. The horizontal geometry inside the relative
  // wrapper is untouched — rows still start at x=0 with the lane at exactly
  // HEADER_W, so the cursor/playhead overlay math and the wheel-zoom anchor
  // (useMultitrackZoom reads the scroller's own rect) hold unchanged; the
  // stage padding lives OUTSIDE the wrapper, shifting ruler and lanes
  // together. Rows are separated by vertical gaps only (x-neutral).
  return (
    <div
      className="stage-inset flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="multitrack-view"
      // F11-4 — outside a lane, a FILE drop does nothing, visibly. A lane that
      // accepts a drag has already called preventDefault by the time the event
      // bubbles here, so this only speaks for the parts of the surface that are
      // not a lane: it refuses the drop (dropEffect 'none' is the OS's "no"
      // cursor) and swallows it.
      //
      // Honestly, about the swallowing (M3, matching `App.tsx`'s window guard).
      // `navigateOnDragDrop` — the webPreferences flag that would make Chromium
      // navigate to a dropped file, replacing the app with a file viewer — has
      // defaulted to FALSE since Electron 3, and `electron/main.cjs` never sets
      // it, so the catastrophe this once cited is not currently reachable. The
      // refusal stays as config-drift insurance: it costs one condition and the
      // failure it covers is total.
      //
      // The `Files` gate is not optional. Without it this refused EVERY
      // unclaimed drag, and the default action being suppressed for a text drag
      // is the one that inserts the text into a text control — which this view
      // owns: the track-rename input in `TrackHeader`. That is the exact
      // regression `0ddcb68` fixed at the window level, which had a second copy
      // here. A text drag carries `text/plain`, a clip drag carries our own
      // MIME, and neither carries `Files`.
      //
      // `dragover` gets the same condition as `drop`, because a `drop` whose
      // `dragover` was not prevented never fires at all.
      onDragOver={(e) => {
        if (e.defaultPrevented) return; // a lane took it
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'none';
      }}
      onDrop={(e) => {
        if (e.defaultPrevented) return;
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
      }}
    >
      {/* Session strip: glass buttons on the bare stage (no band chrome). */}
      <div className="flex shrink-0 items-center gap-2 pb-2">
        <GlassButton
          disabled={!hasActiveDoc}
          onClick={() => void runCommand('multitrack.insertDoc')}
          className="disabled:opacity-40"
          style={{ padding: '5px 12px', fontSize: 12, gap: 6 }}
        >
          <FilePlus2 size={13} /> Insert Active File
        </GlassButton>
        <GlassButton
          disabled={!hasClips}
          onClick={() => void runCommand('multitrack.mixdown')}
          className="disabled:opacity-40"
          style={{ padding: '5px 12px', fontSize: 12, gap: 6 }}
        >
          <FileDown size={13} /> Mix Down
        </GlassButton>
        <span className="ml-auto text-[10px]" style={{ color: 'var(--glass-text-muted)' }}>
          {(session.sampleRate / 1000).toFixed(1)} kHz · Ctrl+wheel zoom · Shift+wheel scroll
        </span>
      </div>

      {/* Ruler row (transparent spacer over the header column, ruler over the lanes) */}
      <div className="flex shrink-0">
        <div className="w-56 shrink-0" />
        <div className="min-w-0 flex-1">
          {/* F11-2: the session's own snap targets, at the session's own zoom —
              the editor's would quantise this surface at the wrong scale. */}
          <TimelineRuler
            sampleRate={session.sampleRate}
            zoom={mtZoom}
            onSeek={setMtCursor}
            snapTargets={mtSnapTargets}
          />
        </div>
      </div>

      {/* Lanes + headers (relative wrapper carries the playhead/cursor overlays) */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={scrollRef} className="h-full overflow-y-auto overflow-x-hidden">
          {session.tracks.map((track) => (
            <div
              key={track.id}
              className="glass-track-row flex"
              style={{ height: LANE_H, marginBottom: 10 }}
            >
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
            className="m-2 flex items-center gap-1 rounded-lg border border-dashed border-white/20 px-3 py-1.5 text-xs text-[#8a8a92] transition-colors hover:border-[#26c6da] hover:text-[#d8d8de]"
          >
            <Plus size={13} /> Add Track
          </button>

          {!hasClips && (
            <div
              className="pointer-events-none px-4 py-6 text-center text-xs"
              style={{ color: 'var(--glass-text-muted)' }}
            >
              Empty session. Open an audio file, then use “Insert Active File” to place it on a track.
            </div>
          )}
        </div>

        {/* Multitrack cursor (white) — where playback will start. */}
        <div
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-[#d4d4d8]/70"
          style={{ left: cursorX }}
        />
        {/* Playhead (accent + soft glow, G6) while playing. */}
        {mtPlayState === 'playing' && (
          <div
            data-testid="mt-playhead"
            className="pointer-events-none absolute top-0 bottom-0 w-0.5"
            style={{
              left: playheadX,
              backgroundColor: 'var(--accent)',
              boxShadow: '0 0 8px var(--accent-ring)',
            }}
          />
        )}
      </div>
    </div>
  );
}
