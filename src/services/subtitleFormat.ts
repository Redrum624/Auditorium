/**
 * Transcript -> subtitle serialisation (F4).
 *
 * Pure string formatting: no IPC, no DOM, no file system. The caller owns the
 * save dialog and the write.
 *
 * The internal transcript shape keeps SAMPLE positions, not seconds. The
 * reference project drops timestamps at save time; the brief is explicit that
 * the timestamps are the valuable part, so they survive here and are only
 * converted to wall-clock at the moment of serialisation.
 */

export interface TranscriptSegment {
  startSample: number;
  endSample: number;
  text: string;
  /** 0-based cluster index from diarization, or null when unknown. */
  speaker: number | null;
}

export interface SubtitleOptions {
  /**
   * Include speaker labels. Defaults to true. Segments whose speaker is null
   * are never labelled regardless.
   */
  includeSpeakers?: boolean;
  /**
   * Renders a 0-based speaker index as a display name. Defaults to
   * {@link defaultSpeakerName} ("Speaker 1" for index 0).
   */
  speakerName?: (speaker: number) => string;
}

/** 0-based internal index -> 1-based human label. */
export function defaultSpeakerName(speaker: number): string {
  return `Speaker ${speaker + 1}`;
}

/**
 * `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (WebVTT).
 *
 * Hours are not capped at two digits: a long recording is still a valid
 * subtitle file, and truncating the hour would silently move a cue. Negative
 * input clamps to zero — a cue cannot start before the file does.
 */
export function formatTimestamp(seconds: number, style: 'srt' | 'vtt'): string {
  if (!Number.isFinite(seconds)) throw new Error(`formatTimestamp: non-finite seconds (${seconds})`);
  const clamped = Math.max(0, seconds);
  // Round to milliseconds FIRST, then decompose, so 59.9996 s becomes
  // 00:01:00.000 rather than 00:00:60.000.
  const totalMs = Math.round(clamped * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = (totalMs - ms) / 1000;
  const s = totalSeconds % 60;
  const totalMinutes = (totalSeconds - s) / 60;
  const m = totalMinutes % 60;
  const h = (totalMinutes - m) / 60;
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  const sep = style === 'srt' ? ',' : '.';
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}${sep}${String(ms).padStart(3, '0')}`;
}

/**
 * Collapses a segment's text to something a cue can hold: trims, drops blank
 * lines (a blank line terminates a cue in both formats, so leaving one in
 * would split one cue into two malformed ones) and normalises line endings.
 */
function cueText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** WebVTT cue payloads are parsed as markup, so these three must be escaped or
 * a stray `<` swallows the rest of the line. SRT has no such rule. */
function escapeVtt(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Segments in ascending start order, with empty ones removed and end clamped
 * to be no earlier than start.
 *
 * Sorting is defensive: both formats require ascending cues, and a player
 * given a descending pair silently drops one. The pipeline already emits in
 * order, so this is normally a no-op.
 */
function prepare(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  return segments
    .map((seg) => ({ ...seg, text: cueText(seg.text) }))
    .filter((seg) => seg.text.length > 0)
    .sort((a, b) => a.startSample - b.startSample || a.endSample - b.endSample)
    .map((seg) => ({ ...seg, endSample: Math.max(seg.startSample, seg.endSample) }));
}

function resolveOptions(options: SubtitleOptions): {
  includeSpeakers: boolean;
  speakerName: (speaker: number) => string;
} {
  return {
    includeSpeakers: options.includeSpeakers ?? true,
    speakerName: options.speakerName ?? defaultSpeakerName,
  };
}

function assertSampleRate(sampleRate: number): void {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`sampleRate must be a positive number, got ${sampleRate}`);
  }
}

/**
 * SubRip (.srt).
 *
 * Cues are numbered from 1. SRT has no speaker markup of its own, so a
 * labelled cue is prefixed `Speaker 1: ` — the long-standing convention among
 * subtitle tools, and the only thing a plain SRT player can render.
 *
 * Returns '' for an empty transcript rather than a file containing whitespace.
 */
export function formatSrt(
  segments: readonly TranscriptSegment[],
  sampleRate: number,
  options: SubtitleOptions = {}
): string {
  assertSampleRate(sampleRate);
  const { includeSpeakers, speakerName } = resolveOptions(options);
  const prepared = prepare(segments);
  if (prepared.length === 0) return '';

  const blocks = prepared.map((seg, index) => {
    const start = formatTimestamp(seg.startSample / sampleRate, 'srt');
    const end = formatTimestamp(seg.endSample / sampleRate, 'srt');
    const label = includeSpeakers && seg.speaker !== null ? `${speakerName(seg.speaker)}: ` : '';
    return `${index + 1}\n${start} --> ${end}\n${label}${seg.text}`;
  });
  return `${blocks.join('\n\n')}\n`;
}

/**
 * WebVTT (.vtt).
 *
 * Speaker labels use the spec's own voice span (`<v Speaker 1>text</v>`)
 * rather than a text prefix, so a conforming player can style or filter by
 * speaker instead of just displaying the name.
 *
 * Always emits the `WEBVTT` signature, even for an empty transcript — a .vtt
 * file without it is invalid, whereas an empty .srt is merely empty.
 */
export function formatWebVtt(
  segments: readonly TranscriptSegment[],
  sampleRate: number,
  options: SubtitleOptions = {}
): string {
  assertSampleRate(sampleRate);
  const { includeSpeakers, speakerName } = resolveOptions(options);
  const prepared = prepare(segments);
  if (prepared.length === 0) return 'WEBVTT\n';

  const blocks = prepared.map((seg) => {
    const start = formatTimestamp(seg.startSample / sampleRate, 'vtt');
    const end = formatTimestamp(seg.endSample / sampleRate, 'vtt');
    const body = escapeVtt(seg.text);
    const payload =
      includeSpeakers && seg.speaker !== null
        ? `<v ${escapeVtt(speakerName(seg.speaker))}>${body}</v>`
        : body;
    return `${start} --> ${end}\n${payload}`;
  });
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}
