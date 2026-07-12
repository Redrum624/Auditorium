import type { AudioDocument } from '../audio/AudioDocument';
import {
  cloneRegion,
  deleteRegion,
  replaceRegion,
  insertAt,
  docLength,
} from '../audio/AudioDocument';
import type { SelectionRange } from '../stores/appStore';
import { useAppStore } from '../stores/appStore';
import { pushUndo } from './undoHistory';
import { getClipboard, setClipboard } from './clipboard';

interface AfterState {
  selection?: SelectionRange | null;
  cursorSample?: number;
}

/**
 * THE single write path for destructive edits (effects in later tasks reuse it).
 * Reads `docId` from the store, applies the pure `fn` to produce a new document,
 * commits it, applies any `after` selection/cursor, then records an undo entry
 * that swaps the whole pre-/post-edit document (and selection/cursor) back and
 * forth. `fn` MUST NOT mutate its input — trust the AudioDocument helpers, which
 * always allocate new channel arrays.
 */
export function applyEdit(
  label: string,
  docId: string,
  fn: (doc: AudioDocument) => AudioDocument,
  after?: AfterState
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
    },
    redo() {
      const s = useAppStore.getState();
      s.updateDocument(newDoc);
      s.setSelection(postSelection);
      s.setCursor(postCursor);
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
  applyEdit('Cut', doc.id, (d) => deleteRegion(d, start, end), {
    selection: null,
    cursorSample: start,
  });
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
 * v1 inserts raw samples even on a sample-rate mismatch (see KNOWN_LIMITATIONS).
 */
export function pasteAtCursor(): void {
  const doc = activeDoc();
  if (!doc) return;
  const clip = getClipboard();
  if (!clip) return;
  const data = clip.channels;
  const insertLength = data[0]?.length ?? 0;
  const { selection, cursorSample } = useAppStore.getState();

  if (selection) {
    const { start, end } = selection;
    applyEdit('Paste', doc.id, (d) => replaceRegion(d, start, end, data), {
      selection: null,
      cursorSample: start + insertLength,
    });
  } else {
    applyEdit('Paste', doc.id, (d) => insertAt(d, cursorSample, data), {
      selection: null,
      cursorSample: cursorSample + insertLength,
    });
  }
}

/** Removes the selection without touching the clipboard. Requires a selection. */
export function deleteSelection(): void {
  const doc = activeDoc();
  const selection = useAppStore.getState().selection;
  if (!doc || !selection) return;
  const { start, end } = selection;
  applyEdit('Delete', doc.id, (d) => deleteRegion(d, start, end), {
    selection: null,
    cursorSample: start,
  });
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
    { selection: null, cursorSample: 0 }
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
