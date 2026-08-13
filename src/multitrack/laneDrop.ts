import { type AudioDocument } from '../audio/AudioDocument';
import { useAppStore } from '../stores/appStore';
import { createClip, documentClipLength } from './session';
import { useSessionStore } from './sessionStore';
import { withSessionGesture } from './sessionUndo';

/**
 * Task F11-4 — dropping audio onto a track lane, from either of the two places
 * a user can drag audio FROM.
 *
 * ---------------------------------------------------------------------------
 * A row in the Files panel is a document the app already holds; a file dragged
 * out of Explorer is one it does not. The difference is entirely in HOW the
 * document comes to exist, so the OS path does exactly one extra thing — it
 * runs `openFilePath`, the SAME function the Open dialog runs, rollback and
 * all — and then joins the panel path at `placeDocumentClips`. There is no
 * second import pipeline here: nothing in this module reads a file, decodes
 * one, or builds a document. A drop that fails to open leaves the app exactly
 * as `openFilePath` left it (its `rollbackOpen` already undid the half-open),
 * and no clip is placed.
 *
 * ---------------------------------------------------------------------------
 * THE DRAG RECORD (`beginDocumentDrag`)
 * ---------------------------------------------------------------------------
 * `dataTransfer.getData` is deliberately unreadable during `dragover` in every
 * browser — the payload is only released on `drop` — but the GHOST needs the
 * dragged document's length while the drag is still in flight, because a clip
 * snaps on either edge (`snapClipStart` takes a span, not a point). So a
 * Files-panel drag also records itself in this module on `dragstart`. The
 * payload in `dataTransfer` stays authoritative at the drop; this record only
 * answers "how long is the thing currently under the pointer", and its absence
 * degrades to a zero-length span — a head-only snap — rather than to a guess.
 *
 * ---------------------------------------------------------------------------
 * THE HISTORY LABEL
 * ---------------------------------------------------------------------------
 * A drop IS an `addClip`, so it carries `addClip`'s own label, 'Add clip' —
 * the same entry the "Insert Active File" command produces, because it is the
 * same act by a different gesture. A multi-file drop follows the recording
 * precedent (`multitrackRecord`'s 'Record clip'/'Record clips'): N clips from
 * one user act fold into ONE entry, 'Add clips', so a single Ctrl+Z lifts the
 * whole drop rather than peeling files off one at a time. The bracket also
 * lets the entry's snapshot carry the resulting SELECTION, which a bare
 * `addClip` + `setSelectedClip` pair would leave out of the redo.
 */

/** The drag type a Files-panel row publishes. A private MIME (not text/plain)
 * so the lane can tell "a document from this app" from "some text" by TYPE
 * alone — which is all `dragover` is allowed to see. */
export const DOC_DRAG_MIME = 'application/x-auditorium-document-id';

/** What a lane is willing to accept. */
export type DropKind = 'document';

/** The Files-panel drag currently in flight — see the module header. */
let panelDragDocId: string | null = null;

export function beginDocumentDrag(docId: string): void {
  panelDragDocId = docId;
}

export function endDocumentDrag(): void {
  panelDragDocId = null;
}

export function draggedDocumentId(): string | null {
  return panelDragDocId;
}

/**
 * Classifies a drag by its advertised types — the only thing readable during
 * `dragover`. Anything else (a text selection, a link, a drag from another
 * app's list) is NOT a drop this surface accepts, and returning null is what
 * makes the lane withhold its `preventDefault`: no acceptance, no highlight,
 * no action.
 */
export function dropPayloadKind(types: ArrayLike<string> | undefined): DropKind | null {
  if (!types) return null;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === DOC_DRAG_MIME) return 'document';
  }
  return null;
}

/** How long the clip a drop would land is, in session samples — 0 when the
 * drag carries no document yet (the Explorer case: the file has not been read,
 * so its length is genuinely unknown and only the head edge can snap). */
export function draggedClipLength(sessionRate: number): number {
  if (panelDragDocId === null) return 0;
  const doc = findDocument(panelDragDocId);
  return doc ? documentClipLength(doc, sessionRate) : 0;
}

function findDocument(docId: string): AudioDocument | undefined {
  return useAppStore.getState().documents.find((d) => d.id === docId);
}

/**
 * Places one clip per document, laid end to end from `startSample`, and
 * selects the last of them. One undo entry for the whole drop (see the header).
 * Returns the clip ids placed, newest last.
 *
 * Clips land VERBATIM at the requested position: overlap is first-class since
 * X5, and a programmatic placement writes no fade keys — the same contract
 * `insertActiveDocAsClip` and the recorder's punch-in follow.
 */
export function placeDocumentClips(
  docIds: readonly string[],
  trackId: string,
  startSample: number
): string[] {
  const session = useSessionStore.getState().session;
  if (!session.tracks.some((t) => t.id === trackId)) return [];

  const placed: { clipId: string; trackId: string; clip: ReturnType<typeof createClip> }[] = [];
  let next = Math.max(0, Math.round(startSample));
  for (const docId of docIds) {
    const doc = findDocument(docId);
    if (!doc) continue; // closed between dragstart and drop — nothing to place
    const lengthSample = documentClipLength(doc, session.sampleRate);
    const clip = createClip({ documentId: doc.id, startSample: next, offsetSample: 0, lengthSample });
    placed.push({ clipId: clip.id, trackId, clip });
    next += lengthSample;
  }
  if (placed.length === 0) return [];

  const store = useSessionStore.getState();
  withSessionGesture(placed.length === 1 ? 'Add clip' : 'Add clips', () => {
    for (const p of placed) store.addClip(p.trackId, p.clip);
    store.setSelectedClip(placed[placed.length - 1].clipId);
  });
  return placed.map((p) => p.clipId);
}

/** The one document a Files-panel drop carries, placed at the drop position. */
export function dropDocumentOnTrack(docId: string, trackId: string, startSample: number): string[] {
  return placeDocumentClips([docId], trackId, startSample);
}
