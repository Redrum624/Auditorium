import { useState } from 'react';
import { X } from 'lucide-react';
import type { Track } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';

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
}: {
  label: string;
  glyph: string;
  active: boolean;
  onClick: () => void;
  activeColor?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className="flex h-5 w-5 items-center justify-center rounded border text-[10px] font-semibold transition-colors"
      style={{
        borderColor: active ? activeColor : '#3a3a42',
        backgroundColor: active ? activeColor : '#2e2e34',
        color: active ? '#101014' : '#d4d4d8',
      }}
    >
      {glyph}
    </button>
  );
}

/** Left-column controls for one track: editable name (double-click), M/S/R
 * toggles (R is arm — visual only in v1, no multitrack recording yet), volume
 * slider (−60..+12 dB) and pan slider (−1..1), each with a value readout. */
export default function TrackHeader({ track }: { track: Track }) {
  const renameTrack = useSessionStore((s) => s.renameTrack);
  const setTrackParam = useSessionStore((s) => s.setTrackParam);
  const removeTrack = useSessionStore((s) => s.removeTrack);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(track.name);

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
      className="flex h-24 w-56 shrink-0 flex-col gap-1 border-b border-r border-[#3a3a42] bg-[#232328] px-2 py-1.5"
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
            className="min-w-0 flex-1 rounded border border-[#26c6da] bg-[#1a1a1e] px-1 py-0.5 text-xs text-[#d4d4d8] outline-none"
          />
        ) : (
          <span
            onDoubleClick={() => {
              setDraft(track.name);
              setEditing(true);
            }}
            title="Double-click to rename"
            className="min-w-0 flex-1 cursor-text truncate text-xs font-medium text-[#d4d4d8]"
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
            onClick={() => setTrackParam(track.id, { armed: !track.armed })}
          />
          <button
            type="button"
            aria-label="Remove track"
            title="Remove track"
            onClick={() => removeTrack(track.id)}
            className="flex h-5 w-5 items-center justify-center rounded border border-[#3a3a42] bg-[#2e2e34] text-[#8b8b92] transition-colors hover:text-[#ef5350]"
          >
            <X size={11} />
          </button>
        </div>
      </div>

      <label className="flex items-center gap-1.5 text-[10px] text-[#8b8b92]">
        <span className="w-6 shrink-0">Vol</span>
        <input
          type="range"
          min={VOL_MIN}
          max={VOL_MAX}
          step={0.5}
          value={track.volumeDb}
          onChange={(e) => setTrackParam(track.id, { volumeDb: Number(e.target.value) })}
          className="h-1 min-w-0 flex-1 accent-[#26c6da]"
          aria-label="Volume (dB)"
        />
        <span className="w-10 shrink-0 text-right tabular-nums text-[#d4d4d8]">
          {track.volumeDb > 0 ? '+' : ''}
          {track.volumeDb.toFixed(1)}
        </span>
      </label>

      <label className="flex items-center gap-1.5 text-[10px] text-[#8b8b92]">
        <span className="w-6 shrink-0">Pan</span>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={track.pan}
          onChange={(e) => setTrackParam(track.id, { pan: Number(e.target.value) })}
          className="h-1 min-w-0 flex-1 accent-[#26c6da]"
          aria-label="Pan"
        />
        <span className="w-10 shrink-0 text-right tabular-nums text-[#d4d4d8]">{panLabel}</span>
      </label>
    </div>
  );
}
