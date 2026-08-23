import { docLength } from '../audio/AudioDocument';
import type { AppState } from '../stores/appStore';

/**
 * Item 8 / M3 — the segment model. A document's segments are the spans
 * between its markers, with 0 and the document end as implicit boundaries:
 * every marker counts, and there is no new marker kind. Two readers share
 * this one definition — the double-click gesture (select the segment under
 * the pointer) and `cutSelection` / the `edit.cut` predicate (Ctrl+X with no
 * selection cuts the cursor's segment) — so they cannot disagree about where
 * a segment starts.
 *
 * N1: nothing here snaps. Positions are consumed verbatim; this module never
 * imports `snap.ts` / `snapPreference.ts`, and `appStore` is imported as a
 * TYPE only, so it cannot take part in a cycle.
 */

export interface Segment {
  start: number;
  end: number;
}

/** M3: boundaries = {0} ∪ interior marker positions ∪ {length}, deduped and
 * sorted. Returns the half-open span [b_i, b_{i+1}) containing `sample`
 * (clamped into [0, length]; sample === length → the last span), or null when
 * there is no INTERIOR boundary (the whole document is one segment) or
 * length <= 0. Pure; tolerates unsorted / duplicated / out-of-range input. */
export function segmentAt(
  markerPositions: readonly number[],
  length: number,
  sample: number
): Segment | null {
  if (!(length > 0)) return null;
  const interior = new Set<number>();
  for (const p of markerPositions) {
    if (p > 0 && p < length) interior.add(p);
  }
  if (interior.size === 0) return null;
  const bounds = [0, ...interior, length].sort((a, b) => a - b);
  const x = Math.min(Math.max(sample, 0), length);
  // The last boundary at or before `x`, capped at the penultimate one so that
  // `x === length` lands in the last span rather than past it.
  let i = 0;
  while (i + 1 < bounds.length - 1 && bounds[i + 1] <= x) i++;
  return { start: bounds[i], end: bounds[i + 1] };
}

/** The segment under the active document's cursor, or null (no document, no
 * interior markers). Reads `activeDocumentId`, `documents`, `markers`,
 * `cursorSample` from the state it is handed — never the live store — so the
 * menu predicates and editOps share one reading. */
export function cursorSegment(s: AppState): Segment | null {
  const doc = s.documents.find((d) => d.id === s.activeDocumentId);
  if (!doc) return null;
  const positions = (s.markers[doc.id] ?? []).map((m) => m.positionSample);
  return segmentAt(positions, docLength(doc), s.cursorSample);
}
