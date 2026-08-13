import { useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Activity } from 'lucide-react';
import {
  AUTOMATION_PARAM_LABELS,
  AUTOMATION_RANGES,
  automationValueAt,
  resolveAutomation,
  type AutomationParam,
} from '../../multitrack/automation';
import { SPATIAL_NEUTRAL, spatialDistanceGain, spatialPanPosition } from '../../dsp/spatial';
import { useSessionStore } from '../../multitrack/sessionStore';
import { withSessionGesture } from '../../multitrack/sessionUndo';

/** SVG stage geometry: a 300×300 viewBox, listener at the centre, the
 * distance range (0..10, `AUTOMATION_RANGES.distance`) mapped LINEARLY onto
 * the stage radius so the drag math inverts exactly. */
const VIEW = 300;
const CX = VIEW / 2;
const CY = VIEW / 2;
const STAGE_R = 132;
const MAX_DIST = AUTOMATION_RANGES.distance.max;

const DEG = Math.PI / 180;

interface SpatialPosition {
  azimuth: number;
  elevation: number;
  distance: number;
}

/**
 * F5 — the spatial positioner: a top-down stage (front = up) where the
 * source is dragged around the listener, plus an elevation slider — the
 * user-facing surface of the STEREO PROJECTION documented in
 * `dsp/spatial.ts`. Named for what it does (ruling 3): amplitude panning
 * plus distance level — NOT binaural — and the readout shows the projected
 * stereo position/level so what reaches the audio is never a mystery.
 *
 * KEYFRAME-AWARE both ways: the shown position is the track's spatial lanes
 * EVALUATED AT THE PLAYHEAD (the shared evaluator, azimuth circular — the
 * dot follows automation during playback), and committing a gesture WRITES
 * keys at the playhead sample. Gesture discipline is F0's ruling D: preview
 * on pointermove (local state only), ONE store commit on pointerup — the XY
 * drag writes azimuth AND distance through `upsertAutomationKeys` (one
 * tracks-array replacement, one re-bake), the elevation slider previews on
 * change and commits on release. Keys land on the envelope lanes F0 built;
 * the three lane buttons open them for timeline editing.
 *
 * With NO spatial lanes the source sits at `SPATIAL_NEUTRAL` (front centre,
 * reference distance) and the first gesture writes the first keys — which
 * activates spatial placement and supersedes pan (ruling 4; the TrackHeader
 * pan slider disables with an explanation while it does).
 *
 * FROZEN-PREVIEW RULE (pinned by test): the position SHOWN during a gesture
 * is the position that lands — the whole preview freezes at pointerdown, so
 * an XY drag while the playhead moves across a MOVING elevation lane commits
 * the drag-start elevation the panel displayed, not the value the lane
 * reached meanwhile. The dot and readouts are a promise about the commit.
 */
export default function SpatialPanel() {
  const session = useSessionStore((s) => s.session);
  const selectedClipId = useSessionStore((s) => s.selectedClipId);
  const playhead = useSessionStore((s) =>
    s.mtPlayState === 'playing' ? s.mtPlayheadSample : s.mtCursorSample
  );
  const mtEnvelope = useSessionStore((s) => s.mtEnvelope);
  const setMtEnvelope = useSessionStore((s) => s.setMtEnvelope);
  const upsertAutomationKeys = useSessionStore((s) => s.upsertAutomationKeys);
  const upsertAutomationKey = useSessionStore((s) => s.upsertAutomationKey);

  const [chosenTrackId, setChosenTrackId] = useState<string | null>(null);
  const [preview, setPreview] = useState<SpatialPosition | null>(null);
  const [dragging, setDragging] = useState(false);

  // The governed track: the explicit choice if it still exists, else the
  // selected clip's track, else the first track.
  const tracks = session.tracks;
  const track =
    tracks.find((t) => t.id === chosenTrackId) ??
    tracks.find((t) => t.clips.some((c) => c.id === selectedClipId)) ??
    tracks[0] ??
    null;

  const spatial = track ? resolveAutomation(track.automation)?.spatial ?? null : null;

  /** The lanes' answer at the playhead — SPATIAL_NEUTRAL members where no
   * lane exists, exactly like the audio engines' `autoSpatialGainsAt`. */
  const evaluated: SpatialPosition = {
    azimuth: spatial?.azimuth
      ? automationValueAt(spatial.azimuth, playhead, 'azimuth')
      : SPATIAL_NEUTRAL.azimuth,
    elevation: spatial?.elevation
      ? automationValueAt(spatial.elevation, playhead, 'elevation')
      : SPATIAL_NEUTRAL.elevation,
    distance: spatial?.distance
      ? automationValueAt(spatial.distance, playhead, 'distance')
      : SPATIAL_NEUTRAL.distance,
  };
  const shown = preview ?? evaluated;

  // The projection the AUDIO applies — shown so the stereo consequence of a
  // 3D position is never a mystery (the honesty surface).
  const pos = spatialPanPosition(shown.azimuth, shown.elevation);
  const level = spatialDistanceGain(shown.distance);
  const levelDb = 20 * Math.log10(level);
  const posLabel =
    Math.round(Math.abs(pos) * 100) === 0 ? 'C' : `${pos < 0 ? 'L' : 'R'}${Math.round(Math.abs(pos) * 100)}`;

  /** Pointer → stage position. Front = up: x = sin(az)·r, y = −cos(az)·r. */
  const positionFor = (e: ReactPointerEvent<SVGSVGElement>): { azimuth: number; distance: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = rect.width > 0 ? VIEW / rect.width : 1;
    const scaleY = rect.height > 0 ? VIEW / rect.height : 1;
    const dx = ((e.clientX - rect.left) * scaleX - CX) / STAGE_R;
    const dy = (CY - (e.clientY - rect.top) * scaleY) / STAGE_R;
    const distance = Math.min(MAX_DIST, MAX_DIST * Math.hypot(dx, dy));
    // atan2(right-component, forward-component): 0 = front, positive = right,
    // ±180 = behind — the azimuth convention. atan2(0, 0) = 0 (centre-safe).
    const azimuth = Math.atan2(dx, dy) / DEG;
    return { azimuth, distance };
  };

  const onStagePointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !track) return;
    setDragging(true);
    const p = positionFor(e);
    setPreview({ ...shown, ...p });
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onStagePointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragging || !track) return;
    const p = positionFor(e);
    setPreview((prev) => ({ ...(prev ?? shown), ...p }));
  };

  const onStagePointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragging || !track) return;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const p = positionFor(e);
    // A pending elevation preview (slider adjusted without release) must not
    // be silently discarded by the stage commit — the panel shows one
    // position, so one position lands (review round 1 minor).
    const pendingElevation =
      preview !== null && preview.elevation !== evaluated.elevation ? preview.elevation : null;
    setPreview(null);
    // ONE commit (ruling D): azimuth + distance (+ any pending elevation)
    // land together at the playhead sample read at COMMIT time (during
    // playback it has moved since pointerdown — the key belongs where the
    // transport is now).
    const st = useSessionStore.getState();
    const sample = Math.round(st.mtPlayState === 'playing' ? st.mtPlayheadSample : st.mtCursorSample);
    const writes: {
      param: AutomationParam;
      key: { positionSample: number; value: number };
    }[] = [
      { param: 'azimuth', key: { positionSample: sample, value: p.azimuth } },
      { param: 'distance', key: { positionSample: sample, value: p.distance } },
    ];
    if (pendingElevation !== null) {
      writes.push({ param: 'elevation', key: { positionSample: sample, value: pendingElevation } });
    }
    // R3: the drop is one user act — one entry, labeled by INTENT (the store's
    // own label for the batch is the generic 'Edit automation').
    withSessionGesture('Set spatial position', () => upsertAutomationKeys(track.id, writes));
  };

  /** Commits the elevation preview as one undo entry. `source` decides
   * coalescing (R3 ruling 2, keyboard-repeat clause): keyboard commits fire
   * once per keyup, so contiguous arrow taps on the SAME track's elevation
   * merge into one entry; pointer commits are one-per-drag already and never
   * merge — two deliberate drags are two undo steps. */
  const commitElevation = (source: 'pointer' | 'key') => {
    if (!track || preview === null) return;
    const el = preview.elevation;
    setPreview(null);
    const st = useSessionStore.getState();
    const sample = Math.round(st.mtPlayState === 'playing' ? st.mtPlayheadSample : st.mtCursorSample);
    withSessionGesture(
      'Set elevation',
      () => upsertAutomationKey(track.id, 'elevation', { positionSample: sample, value: el }),
      source === 'key' ? { coalesceKey: `elevation:${track.id}` } : undefined
    );
  };

  const laneButton = (param: AutomationParam) => {
    if (!track) return null;
    const open =
      mtEnvelope !== null && mtEnvelope.trackId === track.id && mtEnvelope.param === param;
    const hasKeys = (track.automation ?? []).some((l) => l.param === param && l.keys.length > 0);
    const label = `${AUTOMATION_PARAM_LABELS[param]} envelope`;
    return (
      <button
        type="button"
        data-testid={`spatial-lane-toggle-${param}`}
        aria-label={label}
        aria-pressed={open}
        title={hasKeys ? `${label} — lane has keys` : label}
        onClick={() => setMtEnvelope(open ? null : { trackId: track.id, param })}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors"
        style={{
          borderColor: open || hasKeys ? 'var(--accent)' : 'var(--glass-border)',
          backgroundColor: open ? 'var(--accent)' : 'rgba(255,255,255,0.05)',
          color: open ? '#101014' : hasKeys ? 'var(--accent)' : 'var(--glass-text-muted)',
        }}
      >
        <Activity size={10} />
      </button>
    );
  };

  if (!track) {
    return (
      <div data-testid="spatial-panel" className="p-3 text-xs" style={{ color: '#8b8b92' }}>
        No tracks in the session.
      </div>
    );
  }

  const srcX = CX + Math.sin(shown.azimuth * DEG) * (shown.distance / MAX_DIST) * STAGE_R;
  const srcY = CY - Math.cos(shown.azimuth * DEG) * (shown.distance / MAX_DIST) * STAGE_R;
  const fmtDeg = (v: number) => `${v.toFixed(0)}°`;

  const readoutRow = (param: AutomationParam, value: string) => (
    <div className="flex items-center gap-1.5 px-2 py-1 text-xs">
      <span className="w-16 shrink-0" style={{ color: '#8b8b92' }}>
        {AUTOMATION_PARAM_LABELS[param]}
      </span>
      <span className="flex-1 text-right tabular-nums" style={{ color: '#d4d4d8' }}>
        {value}
      </span>
      {laneButton(param)}
    </div>
  );

  return (
    <div data-testid="spatial-panel" className="flex flex-col p-3 text-sm">
      {/* Honest naming (ruling 3): the projection is stated, not implied away. */}
      <div className="px-2 pb-2 text-[10px] leading-snug" style={{ color: '#8b8b92' }}>
        Stereo projection — amplitude pan + distance level, not binaural. Rear and elevated
        positions fold into the stereo image; the playhead position is shown, and dragging
        writes keys at the playhead.
      </div>

      <div className="px-2 pb-2">
        <select
          data-testid="spatial-track-select"
          aria-label="Track"
          value={track.id}
          onChange={(e) => setChosenTrackId(e.target.value)}
          className="w-full rounded border px-1.5 py-1 text-xs outline-none"
          style={{
            borderColor: 'var(--glass-border)',
            // MT1-4: opaque — a select's native popup is painted with this
            // background off the glass surface (see src/index.css).
            background: 'var(--glass-field-bg)',
            color: 'var(--glass-text-label)',
          }}
        >
          {tracks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>

      <svg
        data-testid="spatial-stage"
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        className="w-full select-none"
        style={{ cursor: 'crosshair', touchAction: 'none' }}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
      >
        {/* Distance rings: the reference circle (1×) and the range bound. */}
        {[1, 5, MAX_DIST].map((d) => (
          <circle
            key={d}
            cx={CX}
            cy={CY}
            r={(d / MAX_DIST) * STAGE_R}
            fill="none"
            stroke="var(--glass-border)"
            strokeWidth={1}
            strokeDasharray={d === 1 ? undefined : '3 4'}
          />
        ))}
        <text x={CX + STAGE_R + 4} y={CY + 3} fontSize={9} fill="#8b8b92">
          10×
        </text>
        <text x={CX + 4} y={22} fontSize={9} fill="#8b8b92">
          front
        </text>
        <text x={CX + 4} y={VIEW - 14} fontSize={9} fill="#8b8b92">
          behind
        </text>
        {/* The listener: head + nose wedge pointing at the front. */}
        <circle cx={CX} cy={CY} r={7} fill="rgba(255,255,255,0.18)" stroke="#8b8b92" strokeWidth={1} />
        <path
          d={`M ${CX - 3} ${CY - 6} L ${CX} ${CY - 11} L ${CX + 3} ${CY - 6} Z`}
          fill="#8b8b92"
        />
        {/* The source at the shown (evaluated-or-preview) position. */}
        <line x1={CX} y1={CY} x2={srcX} y2={srcY} stroke="var(--accent-ring)" strokeWidth={1} />
        <circle
          data-testid="spatial-source"
          cx={srcX}
          cy={srcY}
          r={6}
          fill="var(--accent)"
          stroke="rgba(10, 10, 13, 0.9)"
          strokeWidth={1.5}
        />
      </svg>

      <label
        className="flex items-center gap-1.5 px-2 pt-2 text-[10px]"
        style={{ color: '#8b8b92' }}
      >
        <span className="w-16 shrink-0">Elevation</span>
        <input
          data-testid="spatial-elevation"
          type="range"
          min={AUTOMATION_RANGES.elevation.min}
          max={AUTOMATION_RANGES.elevation.max}
          step={1}
          value={Math.round(shown.elevation)}
          aria-label="Elevation (degrees)"
          onChange={(e) => setPreview({ ...shown, elevation: Number(e.target.value) })}
          onPointerUp={() => commitElevation('pointer')}
          onKeyUp={() => commitElevation('key')}
          className="slider min-w-0 flex-1"
        />
        <span className="w-9 shrink-0 text-right tabular-nums" style={{ color: '#d4d4d8' }}>
          {fmtDeg(shown.elevation)}
        </span>
      </label>

      <div className="mt-2 border-t pt-1" style={{ borderColor: '#3a3a42' }}>
        {readoutRow('azimuth', fmtDeg(shown.azimuth))}
        {readoutRow('elevation', fmtDeg(shown.elevation))}
        {readoutRow('distance', `${shown.distance.toFixed(2)}×`)}
      </div>

      {/* What the audio actually does with it — the projected stereo image. */}
      <div
        data-testid="spatial-readout"
        className="mx-2 mt-1 rounded px-2 py-1 text-[10px] tabular-nums"
        style={{
          background: 'var(--glass-bg)',
          border: '1px solid var(--glass-border)',
          color: 'var(--glass-text-label)',
        }}
      >
        Stereo: {posLabel} · {levelDb <= -0.05 ? levelDb.toFixed(1) : '0.0'} dB
      </div>
    </div>
  );
}
