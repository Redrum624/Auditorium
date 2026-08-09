import { useEffect, useState } from 'react';
import { Activity, X } from 'lucide-react';
import { resolveAutomation, type AutomationParam } from '../../multitrack/automation';
import { multitrackRecorder } from '../../multitrack/multitrackRecord';
import type { Track } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { beginSessionGesture, endSessionGesture } from '../../multitrack/sessionUndo';

const VOL_MIN = -60;
const VOL_MAX = 12;

/** A small square toggle (Mute / Solo / arm-Record) matching the app's palette;
 * `active` fills it with the accent color. */
function Toggle({
  label,
  glyph,
  active,
  onClick,
  activeColor = '#26c6da',
  className = '',
}: {
  label: string;
  glyph: string;
  active: boolean;
  onClick: () => void;
  activeColor?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={`flex h-5 w-5 items-center justify-center rounded border text-[10px] font-semibold transition-colors ${className}`}
      style={{
        // G6: idle chrome routed through the glass tokens; the active state
        // keeps its behaviour colours (mute red / solo yellow / arm red).
        borderColor: active ? activeColor : 'var(--glass-border)',
        backgroundColor: active ? activeColor : 'rgba(255,255,255,0.05)',
        color: active ? '#101014' : 'var(--glass-text-label)',
      }}
    >
      {glyph}
    </button>
  );
}

/** Left-column controls for one track: editable name (double-click), M/S/R
 * toggles (R arms the track for punch-in recording), volume slider (−60..+12 dB)
 * and pan slider (−1..1), each with a value readout. While a multitrack take is
 * recording, the R toggle of every armed track pulses red. */
export default function TrackHeader({ track }: { track: Track }) {
  const renameTrack = useSessionStore((s) => s.renameTrack);
  const setTrackParam = useSessionStore((s) => s.setTrackParam);
  const removeTrack = useSessionStore((s) => s.removeTrack);
  const mtEnvelope = useSessionStore((s) => s.mtEnvelope);
  const setMtEnvelope = useSessionStore((s) => s.setMtEnvelope);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(track.name);
  const [recording, setRecording] = useState(() => multitrackRecorder.isRecording());
  useEffect(() => multitrackRecorder.onChange(setRecording), []);

  // F0 — which params have an ACTIVE lane (>= 1 key): that lane GOVERNS the
  // parameter (ruling B), so the static slider is disabled while it does —
  // the honest surface for "the fader is overridden, edit the envelope".
  // F5 — an active SPATIAL group supersedes pan entirely (lane and static,
  // ruling 4), so it disables the pan slider too, with its own explanation.
  const auto = resolveAutomation(track.automation);
  const volGoverned = auto?.volume != null;
  const spatialGoverns = auto?.spatial != null;
  const panGoverned = auto?.pan != null || spatialGoverns;
  const panGovernedTitle = spatialGoverns
    ? 'Overridden by the spatial position (Spatial panel)'
    : 'Overridden by the pan envelope (lane has keys)';

  const envOpen = (param: AutomationParam): boolean =>
    mtEnvelope !== null && mtEnvelope.trackId === track.id && mtEnvelope.param === param;
  const toggleEnvelope = (param: AutomationParam) =>
    setMtEnvelope(envOpen(param) ? null : { trackId: track.id, param });

  /** The per-row envelope toggle: opens/closes this track's lane overlay.
   * Accent-filled while open; accent-outlined while a lane is active (has
   * keys) but closed, so an overriding envelope is visible at a glance. */
  const envToggle = (param: AutomationParam, label: string, governed: boolean) => (
    <button
      type="button"
      aria-label={label}
      aria-pressed={envOpen(param)}
      title={governed ? `${label} — automation active (overrides the slider)` : label}
      onClick={() => toggleEnvelope(param)}
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors"
      style={{
        borderColor: envOpen(param) || governed ? 'var(--accent)' : 'var(--glass-border)',
        backgroundColor: envOpen(param) ? 'var(--accent)' : 'rgba(255,255,255,0.05)',
        color: envOpen(param) ? '#101014' : governed ? 'var(--accent)' : 'var(--glass-text-muted)',
      }}
    >
      <Activity size={10} />
    </button>
  );

  const commitName = () => {
    const name = draft.trim();
    if (name) renameTrack(track.id, name);
    else setDraft(track.name);
    setEditing(false);
  };

  const panLabel =
    track.pan === 0 ? 'C' : `${track.pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(track.pan) * 100)}`;

  return (
    <div
      className="flex h-24 w-56 shrink-0 flex-col gap-1 px-2 py-1.5"
      style={{
        // G6: the darkened header band inside the floating track card (the
        // panel-card header anatomy), hairlined off the lane. Width stays
        // w-56 = HEADER_W — the lane x-origin the overlay math relies on.
        background: 'rgba(0,0,0,0.3)',
        borderRight: '1px solid var(--glass-border)',
      }}
      data-testid="track-header"
    >
      <div className="flex items-center gap-1">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName();
              else if (e.key === 'Escape') {
                setDraft(track.name);
                setEditing(false);
              }
            }}
            className="min-w-0 flex-1 rounded border px-1 py-0.5 text-xs outline-none"
            style={{
              borderColor: 'var(--accent)',
              background: 'rgba(255,255,255,0.06)',
              color: 'var(--glass-text-label)',
            }}
          />
        ) : (
          <span
            onDoubleClick={() => {
              setDraft(track.name);
              setEditing(true);
            }}
            title="Double-click to rename"
            className="min-w-0 flex-1 cursor-text truncate text-xs font-medium"
            style={{ color: 'var(--glass-text-label)' }}
          >
            {track.name}
          </span>
        )}
        <div className="flex items-center gap-0.5">
          <Toggle
            label="Mute"
            glyph="M"
            active={track.muted}
            activeColor="#ef5350"
            onClick={() => setTrackParam(track.id, { muted: !track.muted })}
          />
          <Toggle
            label="Solo"
            glyph="S"
            active={track.solo}
            activeColor="#ffd54f"
            onClick={() => setTrackParam(track.id, { solo: !track.solo })}
          />
          <Toggle
            label="Arm for record"
            glyph="R"
            active={track.armed}
            activeColor="#ef5350"
            className={recording && track.armed ? 'animate-pulse' : ''}
            onClick={() => setTrackParam(track.id, { armed: !track.armed })}
          />
          <button
            type="button"
            aria-label="Remove track"
            title="Remove track"
            onClick={() => removeTrack(track.id)}
            className="flex h-5 w-5 items-center justify-center rounded border border-white/10 bg-white/5 text-[#8a8a92] transition-colors hover:text-[#ef5350]"
          >
            <X size={11} />
          </button>
        </div>
      </div>

      {/* G6: the volume/pan ranges ride Vitrine's ported `.slider` primitive
          (index.css) — same inputs, same aria contracts, glass anatomy. */}
      <label
        className="flex items-center gap-1.5 text-[10px]"
        style={{ color: 'var(--glass-text-muted)' }}
      >
        <span className="w-6 shrink-0">Vol</span>
        <input
          type="range"
          min={VOL_MIN}
          max={VOL_MAX}
          step={0.5}
          value={track.volumeDb}
          disabled={volGoverned}
          title={volGoverned ? 'Overridden by the volume envelope (lane has keys)' : undefined}
          onChange={(e) => setTrackParam(track.id, { volumeDb: Number(e.target.value) })}
          // R3 (ruling 2): a pointer drag on the range fires onChange per
          // tick; the bracket folds them into ONE undo entry. Keyboard
          // arrows fire onChange with no pointer events — those single
          // commits coalesce in the store via the per-(track,param) key.
          // Capture is taken EXPLICITLY (review round 1): without it a
          // pointerup outside the input could be lost, leaving the gesture
          // open and session undo silently no-op until the next commit —
          // Chromium's implicit range-input capture usually saves this, but
          // the bracket must not depend on it. jsdom lacks the API (`?.`).
          onPointerDown={(e) => {
            beginSessionGesture('Set track volume');
            e.currentTarget.setPointerCapture?.(e.pointerId);
          }}
          onPointerUp={endSessionGesture}
          onPointerCancel={endSessionGesture}
          className="slider min-w-0 flex-1"
          style={volGoverned ? { opacity: 0.35 } : undefined}
          aria-label="Volume (dB)"
        />
        <span
          className="w-10 shrink-0 text-right tabular-nums"
          style={{ color: 'var(--glass-text-label)', opacity: volGoverned ? 0.5 : undefined }}
        >
          {track.volumeDb > 0 ? '+' : ''}
          {track.volumeDb.toFixed(1)}
        </span>
        {envToggle('volumeDb', 'Volume envelope', volGoverned)}
      </label>

      <label
        className="flex items-center gap-1.5 text-[10px]"
        style={{ color: 'var(--glass-text-muted)' }}
      >
        <span className="w-6 shrink-0">Pan</span>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={track.pan}
          disabled={panGoverned}
          title={panGoverned ? panGovernedTitle : undefined}
          onChange={(e) => setTrackParam(track.id, { pan: Number(e.target.value) })}
          // R3: same bracket + explicit capture as the volume slider above.
          onPointerDown={(e) => {
            beginSessionGesture('Set track pan');
            e.currentTarget.setPointerCapture?.(e.pointerId);
          }}
          onPointerUp={endSessionGesture}
          onPointerCancel={endSessionGesture}
          className="slider min-w-0 flex-1"
          style={panGoverned ? { opacity: 0.35 } : undefined}
          aria-label="Pan"
        />
        <span
          className="w-10 shrink-0 text-right tabular-nums"
          style={{ color: 'var(--glass-text-label)', opacity: panGoverned ? 0.5 : undefined }}
        >
          {panLabel}
        </span>
        {/* The toggle reflects the pan LANE itself (keys exist), not the
            spatial supersession — a spatially-governed track with no pan
            keys shows a plain toggle, and the disabled slider's title says
            who actually governs. */}
        {envToggle('pan', 'Pan envelope', auto?.pan != null)}
      </label>
    </div>
  );
}
