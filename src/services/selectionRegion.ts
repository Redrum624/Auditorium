import { docLength, type AudioDocument } from '../audio/AudioDocument';
import { useAppStore, type SelectionRange } from '../stores/appStore';

/**
 * T6-1 — THE region a selection names, and the one place the arithmetic lives.
 *
 * ## Why this file exists
 *
 * The rule is three lines long and was written out six times: in
 * `tempoService`'s `resolveRegion` (L1), inline in `runEffectOnSelection` (L9),
 * inline in `runVocalChain` and `runCoverChain`, in `timingAlignService`'s
 * `alignRegion` (L11), and in `editOps`' `resolveSelection` — which counted
 * itself the FIFTH application of the same ruling. Each copy carried its own
 * paragraph restating that ruling, and every one of those paragraphs said the
 * same thing: **resolve once, do not clamp twice and hope the two agree.**
 *
 * Six copies obeying a ruling by inspection is the ruling's weakest possible
 * form. The family grew to fourteen members because the copies were written one
 * at a time, and each new consumer that read the selection raw — a marker remap,
 * a cursor, a zeros allocation, a `regionSamples` readout — became the next
 * member. So the ruling is now a function: a call site cannot half-apply it, and
 * a new consumer inherits it by importing rather than by remembering.
 *
 * ## The contract
 *
 * Given a document and a selection (or none), it answers the half-open pair
 * `[start, end)` that the AUDIO will actually be taken from:
 *
 * 1. **No selection is the whole document** — `[0, docLength]`. Every one of
 *    the six carried this fallback; it is what "run it on everything" means.
 * 2. **Both ends are clamped into `[0, docLength]`**, exactly as
 *    `AudioDocument`'s own `clampRange` clamps them. `setSelection` accepts
 *    whatever it is handed while `cloneRegion`/`replaceRegion` clamp what they
 *    touch, so a consumer that skipped this described a region the audio never
 *    used: an `end` past the document inflated every length measured from it,
 *    and a `start` below zero slid every offset derived from it.
 * 3. **An inverted pair is ordered, not refused** (T6-2). `start > end` is a
 *    right-to-left sweep, and the honest answer to it is the span the user
 *    swept. The store's `setSelection` already orders on the way in — that is
 *    where the invariant lives, because most readers of a selection never
 *    resolve it against a document at all — so from the store this arm is
 *    unreachable. It is here because this function also takes selections from
 *    its CALLERS (`editOps` and the lyric aligner both pass one in), and the
 *    single place has to be a total function or it is not the single place.
 *    Ordering after clamping is safe: clamping is monotone, so it cannot turn
 *    an ordered pair into an inverted one, and the two steps agree in either
 *    order.
 * 4. **A zero-length region stays zero-length.** It is never re-expanded to the
 *    whole document — the callers that must refuse an empty region (the chains'
 *    `null`, tempo's `'empty-region'`, the aligner's `'region-too-short'`) each
 *    decide that for themselves, with their own threshold, and they can only do
 *    so if this function reports the emptiness rather than hiding it.
 *
 * What it deliberately does NOT do: round. Sample positions are integers
 * everywhere this is called from, and a `Math.round` here would have been a
 * behaviour change smuggled into a refactor. `alignLyricsService.alignRegion`
 * rounds and then re-expands an empty region to the whole document; that is a
 * genuinely different contract for a genuinely different question, so it keeps
 * its own function and states the difference there.
 */
export function resolveRegion(
  doc: AudioDocument,
  selection: SelectionRange | null
): { start: number; end: number } {
  const length = docLength(doc);
  const start = Math.min(Math.max(selection ? selection.start : 0, 0), length);
  const end = Math.min(Math.max(selection ? selection.end : length, 0), length);
  return start <= end ? { start, end } : { start: end, end: start };
}

/**
 * {@link resolveRegion} against the LIVE selection — the reading the four
 * store-reading copies took, kept as its own name so those call sites say what
 * they mean rather than repeating `useAppStore.getState().selection`.
 */
export function activeRegion(doc: AudioDocument): { start: number; end: number } {
  return resolveRegion(doc, useAppStore.getState().selection);
}
