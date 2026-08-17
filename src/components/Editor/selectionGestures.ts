// Pure helpers for WaveformView's mouse/pointer selection gestures. Kept
// free of DOM and store access so the interaction logic is unit-testable
// without simulating pointer events.

import type { SelectionRange } from '../../stores/appStore';

/** Normalizes a drag between two sample positions into a SelectionRange.
 * Equal endpoints collapse to `null` (treated as a plain click, not a
 * selection), per the selection-minimum rule. */
export function dragToSelection(anchorSample: number, currentSample: number): SelectionRange | null {
  const start = Math.min(anchorSample, currentSample);
  const end = Math.max(anchorSample, currentSample);
  if (start === end) return null;
  return { start, end };
}

/** True once a pointer has moved at least the minimum screen-pixel threshold
 * (inclusive: a 3px move with the default threshold counts as a drag), used
 * to distinguish a click (sets cursor only) from the start of a
 * drag-selection. */
export function exceedsDragThreshold(anchorX: number, currentX: number, thresholdPx = 3): boolean {
  return Math.abs(currentX - anchorX) >= thresholdPx;
}

/** Resolves the extension anchor sample for a shift+click: the edge of an
 * existing selection farthest from the click point (so the near edge is the
 * one that moves and the larger span is kept; an exact-midpoint tie keeps
 * start as the anchor), or the current cursor position when there is no
 * selection yet. */
export function shiftClickAnchor(
  clickSample: number,
  selection: SelectionRange | null,
  cursorSample: number
): number {
  if (!selection) return cursorSample;
  const distToStart = Math.abs(clickSample - selection.start);
  const distToEnd = Math.abs(clickSample - selection.end);
  return distToEnd > distToStart ? selection.end : selection.start;
}
