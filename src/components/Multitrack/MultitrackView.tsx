import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { FileDown, FilePlus2, Plus } from 'lucide-react';
import { GlassButton } from '../UI/glass';
import { runCommand } from '../../services/menuActions';
import { useAppStore } from '../../stores/appStore';
import { publishSessionLaneWidth, useSessionStore } from '../../multitrack/sessionStore';
import { sessionLaneWidth } from '../../multitrack/sessionViewport';
import { snapSample } from '../../services/snap';
import TimelineRuler from '../Editor/TimelineRuler';
import {
  CURSOR_HANDLE,
  CURSOR_HANDLE_H,
  CURSOR_HANDLE_HALF_W,
  CURSOR_HANDLE_HIT_H,
  CURSOR_HANDLE_HIT_PX,
  pixelToSample,
  sampleToPixel,
} from '../Editor/waveformRender';
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

/** T7: the same Alt escape hatch every drag surface in this app keeps
 * (`useEditorGestures`, `ClipView`, `EnvelopeLane`) — re-read per event, so
 * pressing or releasing Alt mid-drag takes effect on the next move. */
function snapSuspended(e: { altKey: boolean }): boolean {
  return e.altKey;
}

/** T7: above EnvelopeLane's `z-10` capture surface — the only positive z under
 * the overlay wrapper — so the handle both paints over and wins the press
 * against everything in the lanes. */
const CURSOR_HANDLE_Z = 20;

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
  // T7 review F3 — the scroller width mirrored into state PURELY as a render
  // trigger: `publishSessionLaneWidth` has a load-bearing no-op guard (a
  // resize that leaves the resolved zoom unchanged writes nothing to the
  // store), so without this mirror the handle's right-edge cull below would
  // keep judging against a stale `sessionLaneWidth()` until the next
  // unrelated store change. The value itself is never read — the cull keeps
  // reading `sessionLaneWidth()`, the one copy of the header subtraction.
  const [, setScrollerW] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      publishSessionLaneWidth(el.clientWidth); // first, so the width is fresh when the render lands
      setScrollerW(el.clientWidth);
    };
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

  // Task 8 — "the bar goes over and off the track instead of disappearing."
  // The overlay wrapper clips on the right, but the header column sits INSIDE
  // it, so nothing hid an x below HEADER_W; and nothing hid a sample scrolled
  // past the right edge either. Exact-edge cull, the DOM twin of the canvas's
  // own `cx >= 0 && cx <= width` for its cursor/playhead lines (`waveformRender`
  // renderWaveform, ~:257/266). Review round 1: the handle uses this SAME rule
  // below (not the canvas's wider `cursorHandleVisible`) — "no handle without
  // a line" is a real constraint for this DOM overlay, unlike the canvas
  // where the triangle is independently drawn and licensed to outlive the
  // line by its own half-width.
  //
  // `sessionLaneWidth()` never actually returns <= 0 (it falls back to
  // `FALLBACK_SESSION_LANE_WIDTH` before the first measurement) — the `<= 0`
  // arm is belt-and-suspenders against that contract ever changing, so the
  // cursor at sample 0 still paints at HEADER_W rather than the guard
  // collapsing to "nothing visible" on an unmeasured lane.
  const laneVisible = (x: number): boolean => {
    const laneWidth = sessionLaneWidth();
    return x >= HEADER_W && (laneWidth <= 0 || x <= HEADER_W + laneWidth);
  };

  // T7 — the session cursor's grab handle, the multitrack sibling of F11-1.
  // The editor's handle is canvas paint hit-tested by `isOnCursorHandle`; this
  // overlay is DOM, so the hit band IS the element (± CURSOR_HANDLE_HIT_PX ×
  // CURSOR_HANDLE_HIT_H) and the triangle a CSS-border child, both sized from
  // the `waveformRender` constants so three views share one geometry.
  //
  // Same gesture contract as `useEditorGestures`' playhead arm: targets frozen
  // at pointerdown (an analysis or edit completing mid-drag must not move the
  // position under the user's hand), Alt re-read per event, whole samples,
  // clamped at 0 (a session has no fixed end, so no upper clamp — the ruler's
  // own rule), and NO transport call on release: nothing in `transportService`
  // watches the cursor, it is where the NEXT play starts.
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const handleTargetsRef = useRef<number[] | null>(null);
  const [handleGrabbed, setHandleGrabbed] = useState(false);

  /** Lane-relative x for a client x — the overlay wrapper's rect minus the
   * header column, the inverse of the `cursorX` arithmetic above. */
  const laneXAtClientX = (clientX: number): number => {
    const rect = overlayRef.current?.getBoundingClientRect() ?? { left: 0 };
    return clientX - rect.left - HEADER_W;
  };

  /** The editor's `snapped()` shape with the session's pieces: snap the RAW
   * position FIRST, then clamp, then round — `useEditorGestures`' order, so a
   * drag far off the left edge lands at 0 rather than being clamped to 0 and
   * then magnet-pulled onto a target just inside it (T7 review F2). Round on
   * both arms (PW1 — a fractional session fit must not park the cursor
   * between two samples); clamp at 0 only, a session has no fixed end. */
  const snappedMt = (raw: number, targets: number[], e: { altKey: boolean }): number => {
    if (snapSuspended(e) || targets.length === 0) return Math.round(Math.max(0, raw));
    return Math.round(Math.max(0, snapSample(raw, targets, mtZoom.samplesPerPixel).sample));
  };

  const onHandlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    handleTargetsRef.current = mtSnapTargets(); // captured once per gesture
    const el = e.currentTarget;
    if (typeof el.setPointerCapture === 'function') el.setPointerCapture(e.pointerId);
    setHandleGrabbed(true);
    // Deliberately no setMtCursor: grabbing a handle must not itself move it.
  };

  const onHandlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const targets = handleTargetsRef.current;
    if (!targets) return; // hovering — the grab affordance is plain CSS here
    const raw = pixelToSample(laneXAtClientX(e.clientX), mtZoom.scrollSample, mtZoom.samplesPerPixel);
    setMtCursor(snappedMt(raw, targets, e));
  };

  const onHandlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    handleTargetsRef.current = null;
    setHandleGrabbed(false);
    const el = e.currentTarget;
    if (typeof el.releasePointerCapture === 'function') {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // Capture may already have been released (lost on blur); ignore.
      }
    }
  };

  // Task 8 review (round 1) — unified onto `laneVisible`, the SAME rule as
  // the line: "the handle's hit band follows the line (no handle without a
  // line)" is a real requirement here, not the canvas's. The canvas keeps its
  // own wider `cursorHandleVisible` (±CURSOR_HANDLE_HALF_W) because there the
  // triangle is drawn independently of the line and is allowed to outlive it
  // by half its own width; this DOM overlay has no such license — a lone
  // triangle with no line under it reads as a rendering bug, not a feature.
  // Parked out of the lane, the handle is not drawn at a clamped wrong
  // position — it is not drawn at all. A GRABBED handle stays mounted
  // regardless, because unlike the editor (where the canvas outlives its
  // culled drawing) this element IS the gesture surface, and unmounting it
  // mid-drag would drop the pointer capture.
  const handleVisible = handleGrabbed || laneVisible(cursorX);

  // G6: the view sits on the radial stage (stage-inset root) with each track
  // row floating as a glass card. The horizontal geometry inside the relative
  // wrapper is untouched — rows still start at x=0 with the lane at exactly
  // HEADER_W, so the cursor/playhead overlay math and the wheel-zoom anchor
  // (D1: `useMultitrackZoom` anchors on `mtCursorSample` through the pure
  // `anchoredZoom` helper, using `sessionLaneWidth()` for the lane width — it
  // reads no rect at all) hold unchanged; the stage padding lives OUTSIDE the
  // wrapper, shifting ruler and lanes together. Rows are separated by
  // vertical gaps only (x-neutral).
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
      <div ref={overlayRef} className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={scrollRef} className="h-full overflow-y-auto overflow-x-hidden">
          {session.tracks.map((track) => (
            <div
              key={track.id}
              // V1 review, Minor 3 — THE WHOLE ROW IS THE TRACK, header
              // included. `resolveTrackAt` walks up from the element under the
              // pointer to the nearest `[data-track-id]`; only the LANE carried
              // one, so a drag whose pointer sat over another track's header
              // resolved to nothing and `?? trackId` in ClipView committed the
              // move back on the source track — a drop the highlight never
              // offered, because nothing was highlighted either. (Before V1
              // clipped the lane, the same pointer hit that lane's overhanging
              // clip box and DID resolve to the foreign track; V1 removed the
              // overhang, and this row attribute is what puts the answer back
              // on purpose rather than by accident.)
              //
              // The lane keeps its own attribute and still wins inside it —
              // `closest` takes the nearest — so this only speaks for the 224 px
              // header column. Nothing here widens a GROUP drag: that branch
              // never consults the resolver (K1 v1 moves every member on its own
              // track), and this is the single-clip drop's answer.
              data-track-id={track.id}
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

        {/* Multitrack cursor (white) — where playback will start. The LINE
            stays inert; only the handle below is grabbable, the same split as
            the editor's hit rule. Task 8: culled by `laneVisible` — a bar off
            the lane disappears instead of painting over the header column or
            trailing off the right edge. */}
        {laneVisible(cursorX) && (
          <div
            data-testid="mt-cursor-line"
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-[#d4d4d8]/70"
            style={{ left: cursorX }}
          />
        )}
        {/* T7: the cursor's red grab handle, riding the top of the lanes area
            just as the editor's rides the canvas top. */}
        {handleVisible && (
          <div
            data-testid="mt-cursor-handle"
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerUp}
            onPointerCancel={onHandlePointerUp}
            className="absolute"
            style={{
              left: cursorX - CURSOR_HANDLE_HIT_PX,
              top: 0,
              width: CURSOR_HANDLE_HIT_PX * 2,
              height: CURSOR_HANDLE_HIT_H,
              cursor: handleGrabbed ? 'grabbing' : 'grab',
              zIndex: CURSOR_HANDLE_Z,
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: CURSOR_HANDLE_HIT_PX - CURSOR_HANDLE_HALF_W,
                top: 0,
                width: 0,
                height: 0,
                borderLeft: `${CURSOR_HANDLE_HALF_W}px solid transparent`,
                borderRight: `${CURSOR_HANDLE_HALF_W}px solid transparent`,
                borderTop: `${CURSOR_HANDLE_H}px solid ${CURSOR_HANDLE}`,
              }}
            />
          </div>
        )}
        {/* Playhead (accent + soft glow, G6) while playing. Task 8: ALSO
            culled by `laneVisible` — playing is necessary but not sufficient,
            the sweep must still be on-lane to paint. */}
        {mtPlayState === 'playing' && laneVisible(playheadX) && (
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
