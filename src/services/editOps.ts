import type { AudioDocument } from '../audio/AudioDocument';
import {
  cloneRegion,
  deleteRegion,
  replaceRegion,
  insertAt,
  docLength,
} from '../audio/AudioDocument';
import type { Marker, SelectionRange } from '../stores/appStore';
import { useAppStore } from '../stores/appStore';
import { pushUndo } from './undoHistory';
import { getClipboard, setClipboard } from './clipboard';
import { resampleChannel } from '../dsp/resample';

interface AfterState {
  selection?: SelectionRange | null;
  cursorSample?: number;
}

/**
 * Declarative description of how a length/timeline-changing edit moves marker
 * positions (Task M3 / F4), derived by each editOps call site from the same
 * region args it passes to the AudioDocument mutator. `applyEdit` turns this
 * into a full before/after marker-list remap that rides inside the SAME undo
 * entry as the document swap. Omit entirely for equal-length transforms
 * (effects, reverse, in-place silence, ...) — markers stay untouched and no
 * marker snapshot is taken.
 *
 * Rules (all in PRE-edit sample coordinates, region args are [start, end)):
 * - delete [s,e): < s keep; in [s,e) drop; >= e shift left by (e-s).
 * - insert at `start` of `length` L: < start keep; >= start shift right by L.
 * - replace [s,e) with length L: < s keep; in [s,e) drop; >= e shift by L-(e-s).
 * - trim to [s,e]: END-INCLUSIVE — outside [s,e] drops; inside (including a
 *   marker sitting exactly at `e`) shifts left by s, so a marker at exactly the
 *   old docLength survives a select-all trim landing at the new length exactly.
 *   [Amended 2026-07-25, M3 review: the original half-open [s,e) reading
 *   silently dropped end-of-file markers on trim.]
 * - rescale (sample-rate conversion): round(pos * toRate/fromRate).
 * - stretch region [s,e) to length L (length-changing effects — Time Stretch,
 *   Pitch Shift): < s keep; in [s,e) map PROPORTIONALLY,
 *   s + round((pos-s) * L/(e-s)) — the audio inside is TRANSFORMED, not
 *   replaced with unrelated content, so interior markers ride the stretch
 *   instead of dropping; >= e shift by L-(e-s). Degenerate e===s (empty
 *   region) falls through to the >= e shift for every pos, since no pos can
 *   satisfy `s <= pos < e` when e===s. [Amended 2026-07-25 (fix round 2):
 *   effectRunner originally used 'replace' here, which drops every interior
 *   marker — including all of them on a whole-file Time Stretch. Reviewed and
 *   ruled proportional.]
 */
export type MarkerRemap =
  | { type: 'delete'; start: number; end: number }
  | { type: 'insert'; start: number; length: number }
  | { type: 'replace'; start: number; end: number; length: number }
  | { type: 'trim'; start: number; end: number }
  | { type: 'rescale'; fromRate: number; toRate: number }
  | { type: 'stretch'; start: number; end: number; length: number };

/** Maps a single marker position per `remap`'s rule; `null` means "drop". */
function remapPosition(pos: number, remap: MarkerRemap): number | null {
  switch (remap.type) {
    case 'delete':
      if (pos < remap.start) return pos;
      if (pos < remap.end) return null;
      return pos - (remap.end - remap.start);
    case 'insert':
      return pos < remap.start ? pos : pos + remap.length;
    case 'replace':
      if (pos < remap.start) return pos;
      if (pos < remap.end) return null;
      return pos + (remap.length - (remap.end - remap.start));
    case 'trim':
      // End-inclusive by plan ruling (2026-07-25): a marker at exactly `end`
      // survives, landing at exactly the new length (end - start).
      if (pos < remap.start || pos > remap.end) return null;
      return pos - remap.start;
    case 'rescale':
      return Math.round(pos * (remap.toRate / remap.fromRate));
    case 'stretch':
      if (pos < remap.start) return pos;
      if (pos < remap.end) {
        return remap.start + Math.round((pos - remap.start) * (remap.length / (remap.end - remap.start)));
      }
      return pos + (remap.length - (remap.end - remap.start));
  }
}

/** Applies `remapPosition` to every marker, dropping `null` results and
 * clamping surviving positions to `[0, newLength]` so a saved file can never
 * carry a cue point past the (possibly shorter) data length. Relative order is
 * preserved by construction (every branch above is monotonic in `pos`), and
 * `setMarkersForDoc` re-sorts regardless. */
function remapMarkers(markers: Marker[], remap: MarkerRemap, newLength: number): Marker[] {
  const result: Marker[] = [];
  for (const m of markers) {
    const mapped = remapPosition(m.positionSample, remap);
    if (mapped === null) continue;
    result.push({ ...m, positionSample: Math.max(0, Math.min(newLength, mapped)) });
  }
  return result;
}

/**
 * THE single write path for destructive edits (effects in later tasks reuse it).
 * Reads `docId` from the store, applies the pure `fn` to produce a new document,
 * commits it, applies any `after` selection/cursor, then records an undo entry
 * that swaps the whole pre-/post-edit document (and selection/cursor) back and
 * forth. `fn` MUST NOT mutate its input — trust the AudioDocument helpers, which
 * always allocate new channel arrays.
 *
 * `remap`, when given, additionally recomputes the doc's marker list (Task M3 /
 * F4) and folds it into the SAME undo entry: pre/post marker-list snapshots are
 * captured here in the closure and restored via `setMarkersForDoc` on undo/redo,
 * exactly like the document/selection/cursor swap above.
 */
export function applyEdit(
  label: string,
  docId: string,
  fn: (doc: AudioDocument) => AudioDocument,
  after?: AfterState,
  remap?: MarkerRemap
): void {
  const store = useAppStore.getState();
  const preDoc = store.documents.find((d) => d.id === docId);
  if (!preDoc) throw new Error(`applyEdit: document not found: ${docId}`);
  const preSelection = store.selection;
  const preCursor = store.cursorSample;

  const newDoc = fn(preDoc);
  store.updateDocument(newDoc);
  if (after) {
    if ('selection' in after) store.setSelection(after.selection ?? null);
    if (after.cursorSample !== undefined) store.setCursor(after.cursorSample);
  }

  let preMarkers: Marker[] | undefined;
  let postMarkers: Marker[] | undefined;
  if (remap) {
    const currentMarkers = useAppStore.getState().markers[docId] ?? [];
    const remapped = remapMarkers(currentMarkers, remap, docLength(newDoc));
    // Skip the store write (and the undo/redo marker restore below) when the
    // doc has no markers at all: remapMarkers can only drop/shift existing
    // entries, never invent one, so an empty `currentMarkers` always yields an
    // empty `remapped` too. Without this guard, every destructive edit of a
    // marker-less doc would still call setMarkersForDoc(docId, []), seeding a
    // brand-new `markers` object (and an explicit empty-array entry where none
    // existed) on every edit — pure churn (Task M3 fix round 1, Minor 1).
    if (currentMarkers.length > 0 || remapped.length > 0) {
      preMarkers = currentMarkers;
      postMarkers = remapped;
      useAppStore.getState().setMarkersForDoc(docId, remapped);
    }
  }

  // Snapshot the resulting UI state so redo restores it exactly.
  const postSelection = useAppStore.getState().selection;
  const postCursor = useAppStore.getState().cursorSample;

  pushUndo({
    label,
    docId,
    undo() {
      const s = useAppStore.getState();
      s.updateDocument(preDoc);
      s.setSelection(preSelection);
      s.setCursor(preCursor);
      if (preMarkers) s.setMarkersForDoc(docId, preMarkers);
    },
    redo() {
      const s = useAppStore.getState();
      s.updateDocument(newDoc);
      s.setSelection(postSelection);
      s.setCursor(postCursor);
      if (postMarkers) s.setMarkersForDoc(docId, postMarkers);
    },
  });
}

/**
 * Records an undo entry for a marker-list mutation (add/rename/delete —
 * Task M2 / F5): the undo/redo closures replace the WHOLE marker list for
 * `docId` with the captured `before`/`after` snapshots via `setMarkersForDoc`,
 * which never touches `dirty` itself. That's intentional: the marker action
 * that produced `after` already dirtied the doc on the way in (`markDirty` in
 * appStore), and undoHistory re-derives `dirty` from position vs. save point
 * after applying this entry — restoration must not independently dirty or
 * clean the document.
 */
export function pushMarkerUndo(label: string, docId: string, before: Marker[], after: Marker[]): void {
  pushUndo({
    label,
    docId,
    undo() {
      useAppStore.getState().setMarkersForDoc(docId, before);
    },
    redo() {
      useAppStore.getState().setMarkersForDoc(docId, after);
    },
  });
}

function activeDoc(): AudioDocument | null {
  const s = useAppStore.getState();
  return s.documents.find((d) => d.id === s.activeDocumentId) ?? null;
}

/** Copies the selection to the clipboard, then removes it. Requires a selection. */
export function cutSelection(): void {
  const doc = activeDoc();
  const selection = useAppStore.getState().selection;
  if (!doc || !selection) return;
  const { start, end } = selection;
  setClipboard({ channels: cloneRegion(doc, start, end), sampleRate: doc.sampleRate });
  applyEdit(
    'Cut',
    doc.id,
    (d) => deleteRegion(d, start, end),
    { selection: null, cursorSample: start },
    { type: 'delete', start, end }
  );
}

/** Copies the selection to the clipboard without changing the document. */
export function copySelection(): void {
  const doc = activeDoc();
  const selection = useAppStore.getState().selection;
  if (!doc || !selection) return;
  const { start, end } = selection;
  setClipboard({ channels: cloneRegion(doc, start, end), sampleRate: doc.sampleRate });
}

/**
 * Pastes the clipboard: replaces the selection when one exists, otherwise
 * inserts at the cursor. The cursor lands just after the inserted material.
 * When the clipboard's sample rate differs from the destination document's,
 * each channel is resampled to the document's rate first, so cursor advance
 * and inserted length are computed on the CONVERTED data.
 */
export function pasteAtCursor(): void {
  const doc = activeDoc();
  if (!doc) return;
  const clip = getClipboard();
  if (!clip) return;
  const data =
    clip.sampleRate === doc.sampleRate
      ? clip.channels
      : clip.channels.map((channel) => resampleChannel(channel, clip.sampleRate, doc.sampleRate));
  const insertLength = data[0]?.length ?? 0;
  const { selection, cursorSample } = useAppStore.getState();

  if (selection) {
    const { start, end } = selection;
    applyEdit(
      'Paste',
      doc.id,
      (d) => replaceRegion(d, start, end, data),
      { selection: null, cursorSample: start + insertLength },
      { type: 'replace', start, end, length: insertLength }
    );
  } else {
    applyEdit(
      'Paste',
      doc.id,
      (d) => insertAt(d, cursorSample, data),
      { selection: null, cursorSample: cursorSample + insertLength },
      { type: 'insert', start: cursorSample, length: insertLength }
    );
  }
}

/** Removes the selection without touching the clipboard. Requires a selection. */
export function deleteSelection(): void {
  const doc = activeDoc();
  const selection = useAppStore.getState().selection;
  if (!doc || !selection) return;
  const { start, end } = selection;
  applyEdit(
    'Delete',
    doc.id,
    (d) => deleteRegion(d, start, end),
    { selection: null, cursorSample: start },
    { type: 'delete', start, end }
  );
}

/** Keeps only the selected region, dropping everything else. Requires a selection. */
export function trimToSelection(): void {
  const doc = activeDoc();
  const selection = useAppStore.getState().selection;
  if (!doc || !selection) return;
  const { start, end } = selection;
  applyEdit(
    'Trim',
    doc.id,
    (d) => replaceRegion(d, 0, docLength(d), cloneRegion(d, start, end)),
    { selection: null, cursorSample: 0 },
    { type: 'trim', start, end }
  );
}

/**
 * Zero-fills the selected region in place (length unchanged). The selection is
 * preserved so the effect can be re-run. Requires a selection.
 */
export function silenceSelection(): void {
  const doc = activeDoc();
  const selection = useAppStore.getState().selection;
  if (!doc || !selection) return;
  const { start, end } = selection;
  const zeros = doc.channels.map(() => new Float32Array(end - start));
  // No `after`: leaving selection/cursor as-is preserves them (and redo restores them).
  applyEdit('Silence', doc.id, (d) => replaceRegion(d, start, end, zeros));
}
