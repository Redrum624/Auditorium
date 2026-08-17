// Time formatting for the editor: samples <-> 'm:ss.mmm' display strings.
// Samples are the canonical unit; seconds only appear here for the UI.

/** Format a sample count as `m:ss.mmm` (minutes never roll into hours). */
export function formatTime(samples: number, sampleRate: number): string {
  const totalMs = Math.round((samples / sampleRate) * 1000);
  const safeMs = Number.isFinite(totalMs) ? Math.max(0, totalMs) : 0;
  const minutes = Math.floor(safeMs / 60000);
  const remMs = safeMs - minutes * 60000;
  const seconds = Math.floor(remMs / 1000);
  const millis = remMs - seconds * 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/**
 * Parse a time string into a sample count. Accepts `m:ss.mmm`, `m:ss`, or plain
 * seconds (`90.5`). Returns null on garbage or negative input.
 */
export function parseTime(text: string, sampleRate: number): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  let seconds: number;
  if (trimmed.includes(':')) {
    const match = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(trimmed);
    if (!match) return null;
    const minutes = parseInt(match[1], 10);
    const secs = parseFloat(match[2]);
    if (secs >= 60) return null; // seconds field must be < 60
    seconds = minutes * 60 + secs;
  } else {
    if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
    seconds = parseFloat(trimmed);
  }

  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * sampleRate);
}
