import { useEffect, useRef, useState } from 'react';
import { playbackEngine, type PlaybackEngine } from '../../audio/PlaybackEngine';

const MIN_DB = -60;
const METER_WIDTH = 160;
const PEAK_HOLD_MS = 1000;

/** Map a dB value in [-60, 0] to a 0..100 percentage across the meter. */
function dbToPercent(db: number): number {
  const clamped = Math.min(0, Math.max(MIN_DB, db));
  return ((clamped - MIN_DB) / -MIN_DB) * 100;
}

// Fixed gradient anchored to the meter width so a colour always maps to the
// same dB: green up to ~-18, yellow at -12, red at -3 and above.
const GRADIENT =
  'linear-gradient(to right, #4caf50 0%, #4caf50 70%, #ffd54f 80%, #ef5350 95%, #ef5350 100%)';

interface Hold {
  db: number;
  t: number;
}

/**
 * Horizontal peak meter, one 8px bar per channel (1 for mono, 2 for stereo),
 * driven by `engine.onLevel`. Each bar shows the instantaneous peak as a
 * gradient fill plus a peak-hold marker that decays after 1s. In jsdom (no
 * audio) no callbacks arrive, so the bars render empty.
 */
export default function LevelMeter({
  channels,
  engine = playbackEngine,
}: {
  channels: number;
  engine?: PlaybackEngine;
}) {
  const [levels, setLevels] = useState<number[]>(() => Array(channels).fill(MIN_DB));
  const holdsRef = useRef<Hold[]>([]);
  const [holds, setHolds] = useState<number[]>(() => Array(channels).fill(MIN_DB));

  useEffect(() => {
    setLevels(Array(channels).fill(MIN_DB));
    holdsRef.current = Array.from({ length: channels }, () => ({ db: MIN_DB, t: 0 }));
    setHolds(Array(channels).fill(MIN_DB));
  }, [channels]);

  useEffect(() => {
    return engine.onLevel((peaks) => {
      setLevels(peaks.slice(0, channels));
      const now = Date.now();
      const next = holdsRef.current.map((hold, i) => {
        const cur = peaks[i] ?? MIN_DB;
        if (cur >= hold.db || now - hold.t > PEAK_HOLD_MS) return { db: cur, t: now };
        return hold;
      });
      holdsRef.current = next;
      setHolds(next.map((h) => h.db));
    });
  }, [engine, channels]);

  return (
    <div data-testid="level-meter" className="flex flex-col gap-[3px]" style={{ width: METER_WIDTH }}>
      {Array.from({ length: channels }, (_, i) => (
        <div
          key={i}
          className="relative h-2 overflow-hidden rounded-[1px] bg-[#1a1a1e]"
          style={{ width: METER_WIDTH }}
        >
          <div
            className="absolute inset-y-0 left-0"
            style={{
              width: `${dbToPercent(levels[i] ?? MIN_DB)}%`,
              background: GRADIENT,
              backgroundSize: `${METER_WIDTH}px 100%`,
            }}
          />
          <div
            className="absolute inset-y-0 w-[2px] bg-white/80"
            style={{ left: `${dbToPercent(holds[i] ?? MIN_DB)}%` }}
          />
        </div>
      ))}
    </div>
  );
}
