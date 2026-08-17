/**
 * Pure layout for the transcript ribbon (F4b) — which transcript segments fall
 * inside the editor viewport, and where each one sits in CSS pixels.
 *
 * Separated from the component for the same reason `editorSnapTargets.ts` and
 * `waveformRender.ts`'s converters are: the culling window and the pixel
 * mapping are made entirely of comparisons, and comparisons are what a test
 * can pin. The component below it does nothing but position a div per returned
 * entry.
 *
 * ## Why REGIONS and not markers
 *
 * The app already has a marker model (`appStore.Marker`), and a transcript
 * could in principle be dumped into it. It must not be, for four reasons:
 *
 *  1. A marker is a POINT (`positionSample` only). A transcript segment has a
 *     start AND an end, and the end is half of what a transcript is for —
 *     "where does this sentence stop" is the question a subtitle answers.
 *  2. Markers are a USER-OWNED, PERSISTED artefact: they are written into the
 *     cue chunks of every exported WAV/MP3/FLAC/OGG and into `.audm` sessions.
 *     Injecting a few hundred machine-generated cues into the user's next
 *     export is a destructive side effect nobody asked for.
 *  3. A marker carries no speaker, and speaker identity is the feature. The
 *     ribbon colours by speaker; `Marker` has no field to colour from.
 *  4. Re-clustering at a different speaker count must recolour instantly
 *     (`transcribeService.setTranscriptSpeakerCount`). Through markers that
 *     would be a wholesale rewrite of the user's marker list, with undo
 *     entries, on every twist of a picker.
 *
 * So the ribbon is a view over the transcript store, drawn in its own lane
 * between the ruler and the waveform, owning no persisted state.
 */

import type { TranscriptEntry } from '../../services/transcribeService';
import { sampleToPixel } from './waveformRender';

/**
 * Smallest width a region is allowed to occupy, in CSS pixels.
 *
 * One pixel, because one pixel is the smallest addressable unit of the layout
 * — not a tuned value. A short segment at a coarse zoom rounds to a width of
 * 0, and a zero-width div does not paint at all: the ribbon would show a GAP
 * exactly where a segment exists, which misrepresents the transcript. Clamping
 * to 1 keeps every segment visible; it is deliberately not larger, because a
 * wider floor would make adjacent short segments overlap and imply speech
 * where there is none.
 */
export const MIN_REGION_PX = 1;

export interface TranscriptRegion {
  /** Index into the source `segments` array — the React key and the click target. */
  segmentIndex: number;
  /** Left edge in CSS pixels, relative to the lane. May be negative when the
   * segment starts before the viewport; the caller clips with `overflow`. */
  x: number;
  /** Width in CSS pixels, at least {@link MIN_REGION_PX}. */
  width: number;
  speaker: number | null;
  text: string;
  startSample: number;
  endSample: number;
}

export interface TranscriptLayoutOptions {
  scrollSample: number;
  samplesPerPixel: number;
  /** Lane width in CSS pixels. */
  width: number;
}

/**
 * The segments visible in `[scrollSample, scrollSample + width*samplesPerPixel)`,
 * in input order, each with its pixel geometry.
 *
 * VISIBILITY is a half-open overlap test against a half-open viewport:
 * `endSample > viewStart && startSample < viewEnd`. Both comparisons are
 * strict, and that is deliberate on both sides — a segment that ENDS exactly
 * at the left edge occupies no visible pixel, and one that STARTS exactly at
 * the right edge is the first sample of the next screenful. Using `>=`/`<=`
 * instead would paint a sliver of a region that is not on screen and would
 * make the two edges disagree about which screenful owns a boundary sample.
 *
 * A non-positive `width` or a non-finite/non-positive `samplesPerPixel` yields
 * an empty layout rather than NaN geometry: the lane is measured by a
 * ResizeObserver and legitimately reads 0 on the first frame.
 */
export function layoutTranscriptRegions(
  segments: readonly TranscriptEntry[],
  options: TranscriptLayoutOptions
): TranscriptRegion[] {
  const { scrollSample, samplesPerPixel, width } = options;
  if (!(width > 0) || !Number.isFinite(samplesPerPixel) || !(samplesPerPixel > 0)) return [];

  const viewStart = scrollSample;
  const viewEnd = scrollSample + width * samplesPerPixel;
  const out: TranscriptRegion[] = [];

  for (const seg of segments) {
    if (!(seg.endSample > viewStart)) continue;
    if (!(seg.startSample < viewEnd)) continue;
    const left = sampleToPixel(seg.startSample, scrollSample, samplesPerPixel);
    const right = sampleToPixel(seg.endSample, scrollSample, samplesPerPixel);
    out.push({
      segmentIndex: seg.index,
      x: left,
      width: Math.max(MIN_REGION_PX, right - left),
      speaker: seg.speaker,
      text: seg.text,
      startSample: seg.startSample,
      endSample: seg.endSample,
    });
  }
  return out;
}

/**
 * Per-speaker ribbon colours.
 *
 * Six entries because {@link import('../../dsp/speakerClustering').MAX_SPEAKERS}
 * is 6 — the palette is sized to the clusterer's own candidate bound so a
 * legal speaker index can never fall off the end. Hues are the app's existing
 * accent family (the marker orange `#ff8a65` and the selection cyan `#26c6da`
 * are the first two, so a ribbon reads as part of the same editor) followed by
 * four further well-separated hues.
 */
export const SPEAKER_COLORS: readonly string[] = [
  '#26c6da',
  '#ff8a65',
  '#9ccc65',
  '#ba68c8',
  '#ffd54f',
  '#4fc3f7',
];

/** Colour for a speaker index, or the muted chrome grey for an unknown
 * speaker. Indexes past the palette wrap rather than throwing — the clusterer
 * bounds them, but a wrong colour is a better failure than a crash. */
export function speakerColor(speaker: number | null): string {
  if (speaker === null || !Number.isInteger(speaker) || speaker < 0) return '#5a5a62';
  return SPEAKER_COLORS[speaker % SPEAKER_COLORS.length];
}
