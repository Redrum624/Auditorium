import type { AudioDocument } from '../audio/AudioDocument';
import {
  cloneRegion,
  deleteRegion,
  replaceRegion,
  insertAt,
  docLength,
  nextId,
} from '../audio/AudioDocument';
import type { Marker, SelectionRange } from '../stores/appStore';
import { useAppStore } from '../stores/appStore';
import { pushUndo } from './undoHistory';
import { getClipboard, setClipboard } from './clipboard';
import { resolveRegion } from './selectionRegion';
import { cursorSegment } from './segments';
import { resampleChannel } from '../dsp/resample';

interface AfterState {
  selection?: SelectionRange | null;
  cursorSample?: number;
}

/** Sum of a document's channel byteLengths — the estimated memory an
 * `applyEdit` undo entry retains for ONE of its two snapshots (Task M9 / F15;
 * see `UndoEntry.bytes` in undoHistory.ts). */
function docBytes(doc: AudioDocument): number {
  let total = 0;
  for (const channel of doc.channels) total += channel.byteLength;
  return total;
}

/**
 * Declarative description of how a length/timeline-changing edit moves marker
 * positions (Task M3 / F4), derived by each editOps call site from the same
 * region args it passes to the AudioDocument mutator. `applyEdit` turns this
 * into a full before/after marker-list remap that rides inside the SAME undo
 * entry as the document swap. Omit entirely for equal-length transforms
 * (effects, reverse, in-place silence, delete, cut, ...) — markers stay
 * untouched and no marker snapshot is taken.
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
 * - cuts (F2, Remove Silence): `cuts` is a sorted, non-overlapping list of
 *   deleted [start,end) spans. Before the first cut keep; at/after a cut's
 *   end shift left by the total length of every cut at or before it; INSIDE
 *   a cut, snap to the cut's join point (cut.start minus the removal before
 *   it) rather than drop. Deliberate divergence from 'delete': there the
 *   USER deleted that region, content and cues included; here the effect
 *   removed samples it classified as silence, and a marker inside a silent
 *   gap is typically a cue placed IN the pause (podcast chapter markers live
 *   exactly there) — dropping it would be the data-loss-class failure the
 *   marker remap exists to prevent, while the join point is exactly where
 *   that pause survives in the output. Every branch is monotonic in pos, so
 *   relative marker order is preserved. Boundary equivalences, argued not
 *   assumed: at pos === cut.start the snap equals the keep-side formula, and
 *   at pos === cut.end the snap equals the shift-side formula (both reduce
 *   to cut.start - removedBefore), so the rule is seamless at both edges.
 * - compose (F7, Vocal Chain): apply `steps` LEFT TO RIGHT, each in the
 *   coordinates the previous one produced; a step that drops a marker ends
 *   the chain for that marker (null propagates). It exists because the chain
 *   is a composition of edits committed as ONE undo entry, so its marker rule
 *   has to be the composition of its stages' rules — Remove Silence's 'cuts'
 *   followed by the 'insert' of a Reverb tail is the shipped case. An empty
 *   `steps` is the identity, which is what a chain of equal-length stages
 *   correctly produces.
 */
export type MarkerRemap =
  | { type: 'delete'; start: number; end: number }
  | { type: 'insert'; start: number; length: number }
  | { type: 'replace'; start: number; end: number; length: number }
  | { type: 'trim'; start: number; end: number }
  | { type: 'rescale'; fromRate: number; toRate: number }
  | { type: 'stretch'; start: number; end: number; length: number }
  | { type: 'cuts'; cuts: { start: number; end: number }[] }
  | { type: 'compose'; steps: MarkerRemap[] };

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
    case 'cuts': {
      let removedBefore = 0;
      for (const cut of remap.cuts) {
        if (pos < cut.start) break;
        if (pos < cut.end) return cut.start - removedBefore; // inside: snap to the join
        removedBefore += cut.end - cut.start;
      }
      return pos - removedBefore;
    }
    case 'compose': {
      let p: number | null = pos;
      for (const step of remap.steps) {
        if (p === null) return null;
        p = remapPosition(p, step);
      }
      return p;
    }
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
    // Charge only the PRE-edit snapshot (Task M9 fix round 2 / MINOR 1 —
    // round 1 charged `newDoc`, which is the wrong end of the pair).
    // `preDoc` is not independent memory: it IS the previous entry's `newDoc`
    // object (the store doc `applyEdit` read at the top of this call) — the
    // whole chain of edits shares one doc reference per step, each entry's
    // `preDoc` being the prior entry's `newDoc`. Charging BOTH sides
    // double-counted every entry in the middle of the chain (round 1's bug).
    // But charging only `newDoc` (round 1's fix) charges the WRONG side:
    // evicting the oldest entry E_i frees its `preDoc` (D_{i-1}) — the NEXT
    // entry still holds a reference to `newDoc` (D_i) as ITS OWN `preDoc`, so
    // D_i stays alive regardless of E_i's eviction. `docBytes(preDoc)` is the
    // exactly-correct marginal charge: evicting the oldest k entries frees
    // precisely the sum of their `preDoc` bytes, no more and no less — for
    // constant-size edits this coincides with a `newDoc` charge (same number
    // either way), but for a size-CHANGING edit (e.g. Trim to Selection on a
    // large document down to a small one) `docBytes(newDoc)` would have
    // billed the entry as nearly free while it single-handedly keeps the full
    // large original pinned via its `preDoc` reference — letting it survive
    // far more subsequent edits than its actual retained cost should allow.
    bytes: docBytes(preDoc),
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
 * which never touches `dirty` itself. That's intentional for the RESTORE path —
 * undoHistory re-derives `dirty` from position vs. save point after applying
 * this entry, so restoration must not independently dirty or clean the doc.
 *
 * THE FORWARD path is dirtied HERE, and this is the layer that can do it. The
 * per-marker store actions (`addMarker`/`renameMarker`/`removeMarker`) dirty on
 * the way in, but every BULK writer — `suggestSyllableMarkers`, the beat-grid
 * writes, `Align Markers`, `Remix Markers` — goes through `setMarkersForDoc`,
 * which deliberately does not (the load paths in `fileService`/`sessionFile`
 * use it too, and opening a file with cues must not report it edited). Pushing
 * an entry only advances `position`, so before this the document stayed CLEAN
 * with changed markers — and markers are persisted by save (WAV cues, ID3
 * chapters, vorbis/Opus tags) while `hasUnsavedWork` is `dirty || neverSaved`,
 * so a file opened from disk closed with no prompt and lost them. `dirty: true`
 * is exactly what `position !== savePoint` derives immediately after a push
 * (`pushUndo` either advances past the save point or invalidates it), so the
 * stamp cannot disagree with the derivation on the next undo. It also replaces
 * the doc OBJECT, which is what makes a marker-only edit visible to
 * fileService's reference-identity staleness check (Task M2 finding 1).
 *
 * No `bytes` is attached (Task M9 / F15): `before`/`after` are plain marker
 * lists, never a channel array, so their retained cost is negligible next to
 * `MAX_UNDO_BYTES` and isn't counted toward the per-doc budget.
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
  const store = useAppStore.getState();
  const doc = store.documents.find((d) => d.id === docId);
  if (doc) store.updateDocument({ ...doc, dirty: true });
}

function activeDoc(): AudioDocument | null {
  const s = useAppStore.getState();
  return s.documents.find((d) => d.id === s.activeDocumentId) ?? null;
}

/**
 * The region ONE edit operation acts on: the live selection clamped into
 * `[0, docLength]` **exactly as `clampRange` clamps it** (`AudioDocument.ts`),
 * so the region the audio mutator uses and the region every other consumer
 * describes cannot differ.
 *
 * Fifth application of one ruling (R7's `VariableTempoPlan.regionStart`, L1's
 * `resolveRegion` in `tempoService.ts`, L9's `runEffectOnSelection`, and the
 * chain/align readers): **resolve once, do not clamp twice and hope the two
 * agree.** The operations below pair a mutator that clamps internally
 * (`deleteRegion`/`replaceRegion`/`cloneRegion`) with three consumers that do
 * not — the {@link MarkerRemap} descriptor, the post-edit `cursorSample`, and
 * Silence's zeros allocation — so reading the raw selection here gave the
 * markers, the cursor and the allocation a different region from the one the
 * audio used. Two verified consequences on a 4000-sample document:
 * Cut with `{-5000, 100}` removed `[0,100)` but emitted a `delete` remap over
 * `[-5000,100)`, shifting a marker at 500 by 5100 into `remapMarkers`' floor at
 * 0 instead of 400, and left the cursor at −5000; Silence with `{2000, 9000}`
 * allocated 7000 zeros while `replaceRegion` removed only the 2000 samples that
 * exist, GROWING the document 4000 → 9000 — the one operation documented as
 * leaving length unchanged. No UI route builds such a selection (the editor
 * gestures clamp, select-all uses `docLength`), so both were latent; the store
 * API is public and `setSelection`/`setCursor` store whatever they are handed.
 *
 * T6-1: the two expressions this used to hold are `selectionRegion.ts`, which
 * six modules had each written out for themselves. The paragraph above stays
 * because it records the two verified consequences that earned the ruling; the
 * arithmetic does not, because a ruling six modules re-type is a ruling one edit
 * can break in five of them.
 *
 * Inverted selections (`start > end` after clamping) were deliberately NOT
 * handled here, deferred to this family's next round: T6-2 is that round, and it
 * closed the case at the store's `setSelection` rather than here. This still
 * resolves rather than assumes, because the selection arrives as a PARAMETER —
 * see `resolveRegion`'s own note on why it stays total.
 */
function resolveSelection(doc: AudioDocument, selection: SelectionRange): { start: number; end: number } {
  return resolveRegion(doc, selection);
}

/** Zero-fills [start, end) in place — length unchanged, no marker remap. N7:
 * Delete, Cut and Silence all go through here so they cannot drift. */
function zeroFillRegion(doc: AudioDocument, start: number, end: number): AudioDocument {
  const zeros = doc.channels.map(() => new Float32Array(end - start));
  return replaceRegion(doc, start, end, zeros);
}

/**
 * Copies the selection — or, with none, the SEGMENT the cursor is in (item 8 /
 * M3: the span between the two nearest markers, 0 and the document end
 * counting as boundaries; `cursorSegment`) — to the clipboard, then leaves
 * that span EMPTY at the same length (item 7 / M1): the document never
 * ripples, so markers inside and after the span stay where they are and no
 * remap is passed. The selection collapses to a cursor at the span's start.
 * A no-op with neither a selection nor an interior marker (N9).
 */
export function cutSelection(): void {
  const doc = activeDoc();
  if (!doc) return;
  const s = useAppStore.getState();
  const region = s.selection ? resolveSelection(doc, s.selection) : cursorSegment(s);
  if (!region) return;
  const { start, end } = region;
  setClipboard({ channels: cloneRegion(doc, start, end), sampleRate: doc.sampleRate });
  applyEdit('Cut', doc.id, (d) => zeroFillRegion(d, start, end), {
    selection: null,
    cursorSample: start,
  });
}

/**
 * Split at Cursor (item 8 / M1): drops a marker at the cursor — or one at each
 * edge of the selection — named `Split N` (N9, the `marker.add` naming scheme),
 * as ONE History entry. Positions are consumed verbatim, never snapped (N1);
 * the resolved selection edges are used, not the raw pair. A position at 0 or
 * at the document end is implicit (M3) and a position that already carries a
 * marker is skipped; when nothing is left nothing is recorded. Selection and
 * cursor are not touched.
 */
export function splitAtCursor(): void {
  const doc = activeDoc();
  if (!doc) return;
  const s = useAppStore.getState();
  const length = docLength(doc);
  let positions: number[];
  if (s.selection) {
    const { start, end } = resolveSelection(doc, s.selection);
    positions = [start, end];
  } else {
    positions = [Math.min(Math.max(s.cursorSample, 0), length)];
  }
  const before = s.markers[doc.id] ?? [];
  const taken = new Set(before.map((m) => m.positionSample));
  const fresh = [...new Set(positions)].filter((p) => p !== 0 && p !== length && !taken.has(p));
  if (fresh.length === 0) return;
  for (const positionSample of fresh) {
    const id = nextId('marker');
    s.addMarker(doc.id, { id, name: `Split ${id.split('-')[1]}`, positionSample });
  }
  const after = useAppStore.getState().markers[doc.id] ?? [];
  pushMarkerUndo('Split', doc.id, before, after);
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
    const { start, end } = resolveSelection(doc, selection);
    applyEdit(
      'Paste',
      doc.id,
      (d) => replaceRegion(d, start, end, data),
      { selection: null, cursorSample: start + insertLength },
      { type: 'replace', start, end, length: insertLength }
    );
  } else {
    // The insert arm's single coordinate gets the same treatment for the same
    // reason: `insertAt` clamps the position into `[0, docLength]` internally,
    // while the 'insert' remap and the post-edit cursor read it raw — a cursor
    // past the end inserted the material AT the end but told the remap the
    // insertion happened beyond it, so a marker sitting exactly at the old
    // length stayed put instead of riding the insert, and the cursor landed
    // outside the document.
    const insertPos = Math.min(Math.max(cursorSample, 0), docLength(doc));
    applyEdit(
      'Paste',
      doc.id,
      (d) => insertAt(d, insertPos, data),
      { selection: null, cursorSample: insertPos + insertLength },
      { type: 'insert', start: insertPos, length: insertLength }
    );
  }
}

/**
 * Silences the selection in place at the same length and collapses it to a
 * cursor at its start, without touching the clipboard (item 7 / N6). No remap:
 * the timeline did not move, so every marker — including one inside the span —
 * stays exactly where it was. Requires a selection.
 */
export function deleteSelection(): void {
  const doc = activeDoc();
  const selection = useAppStore.getState().selection;
  if (!doc || !selection) return;
  const { start, end } = resolveSelection(doc, selection);
  applyEdit('Delete', doc.id, (d) => zeroFillRegion(d, start, end), {
    selection: null,
    cursorSample: start,
  });
}

/**
 * The pre-item-7 Delete, verbatim (N8): removes the selection and closes the
 * gap, shortening the document, with the 'delete' marker remap riding in the
 * same undo entry. Behind Shift+Del in the editor views. Requires a selection.
 */
export function rippleDeleteSelection(): void {
  const doc = activeDoc();
  const selection = useAppStore.getState().selection;
  if (!doc || !selection) return;
  const { start, end } = resolveSelection(doc, selection);
  applyEdit(
    'Ripple Delete',
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
  const { start, end } = resolveSelection(doc, selection);
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
  const { start, end } = resolveSelection(doc, selection);
  // No `after`: leaving selection/cursor as-is preserves them (and redo restores them).
  applyEdit('Silence', doc.id, (d) => zeroFillRegion(d, start, end));
}
