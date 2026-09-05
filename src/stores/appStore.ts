import { create } from 'zustand';
import type { AudioDocument } from '../audio/AudioDocument';
import { docLength } from '../audio/AudioDocument';
import { editorLaneWidth, setEditorLaneWidth } from '../services/editorViewport';

// Single per-prefix counter registry shared with createDocument's 'doc' ids,
// so nextId('doc') can never collide with an id assigned by createDocument.
export { nextId } from '../audio/AudioDocument';

export type EditorView = 'waveform' | 'spectral' | 'multitrack';
/**
 * Samples, half-open `[start, end)`. **`start <= end` always** — the store's
 * `setSelection` is the one writer and it orders what it is handed (T6-2), so
 * every reader may subtract the two without checking which way the drag went.
 */
export interface SelectionRange {
  start: number;
  end: number;
}

/**
 * T6-2 — the ordering that makes {@link SelectionRange}'s invariant true.
 *
 * A selection dragged right-to-left is `start > end`. `dragToSelection` has
 * always ordered the pair it builds, so no drag produced one — but this store
 * action is public, with callers in the E2E hooks and in a rollback restore,
 * and it used to store whatever it was handed. Everything downstream then
 * inherited the inversion and split three ways on it: the audio primitives
 * THREW (`clampRange`'s `RangeError`, which reached the user through Copy,
 * Silence and every effect), a few readers guarded and degraded, and most
 * assumed. `editOps.ts` recorded the case as deferred to "this family's next
 * round"; this is that round.
 *
 * Ordered HERE, at the write, rather than at a read helper, because the readers
 * that most need it are the ones a helper cannot reach: the status bar's
 * duration, the properties panel, the transport's play-from and loop region,
 * the playback engine's loop bounds, three dialogs' region readouts. Those
 * describe the selection rather than resolve it against a document, and they
 * need no document to be right. This codebase's own precedent for the shape is
 * `applyEditorZoom` — "the ONE clamping writer", introduced after six surfaces
 * were found writing zoom raw.
 *
 * Only the ORDER is fixed here. The extent is clamped into `[0, docLength]` by
 * `selectionRegion.ts`, at the read, because that is where the document is
 * known — two invariants, each placed where its inputs are.
 *
 * An ordered pair is returned by IDENTITY, so an unchanged write is not a new
 * store snapshot repainting every subscriber.
 */
export function orderSelection(sel: SelectionRange | null): SelectionRange | null {
  if (!sel || sel.start <= sel.end) return sel;
  return { start: sel.end, end: sel.start };
}
export interface Marker {
  id: string;
  name: string;
  positionSample: number;
}
export interface AppState {
  documents: AudioDocument[];
  activeDocumentId: string | null;
  view: EditorView;
  selection: SelectionRange | null; // in the active document
  cursorSample: number;
  zoom: { samplesPerPixel: number; scrollSample: number };
  playback: { state: 'stopped' | 'playing' | 'paused'; positionSample: number; loop: boolean };
  markers: Record<string, Marker[]>; // docId -> markers sorted by position
}
export interface AppActions {
  addDocument(doc: AudioDocument): void; // also makes it active, resets zoom/selection/cursor
  closeDocument(id: string): void; // activates neighbor or null
  setActiveDocument(id: string): void; // resets selection/cursor/zoom/playback to stopped
  updateDocument(doc: AudioDocument): void; // replace by doc.id
  setSelection(sel: SelectionRange | null): void;
  setCursor(sample: number): void;
  setZoom(z: { samplesPerPixel: number; scrollSample: number }): void;
  setView(v: EditorView): void;
  setPlayback(p: Partial<AppState['playback']>): void;
  addMarker(docId: string, m: Marker): void; // keeps array sorted by positionSample
  removeMarker(docId: string, markerId: string): void;
  renameMarker(docId: string, markerId: string, name: string): void;
  setMarkersForDoc(docId: string, markers: Marker[]): void; // replaces the whole list, sorted by positionSample
}

export function makeInitialState(): AppState {
  return {
    documents: [],
    activeDocumentId: null,
    view: 'waveform',
    selection: null,
    cursorSample: 0,
    zoom: { samplesPerPixel: 512, scrollSample: 0 },
    playback: { state: 'stopped', positionSample: 0, loop: false },
    markers: {},
  };
}

// ---------------------------------------------------------------------------
// F11-3 / F11-9 — ONE clamped zoom resolution
// ---------------------------------------------------------------------------
/**
 * The furthest the editor zooms IN, in samples per pixel. Lived in
 * `useEditorGestures` until F11-9; it moved here because the clamp did — a
 * limit that lives in one of the consumers is a limit the other consumers can
 * disagree with, which is the whole shape of the bug below.
 */
export const MIN_SPP = 1 / 32;

export interface Zoom {
  samplesPerPixel: number;
  scrollSample: number;
}

/**
 * **The zoom-out limit AND the fit — deliberately the same number.**
 *
 * Before F11-9 they were unrelated: the fit was `docLength / 1600` (a nominal
 * viewport, not the real one) and the zoom-out ceiling was `docLength / 50`,
 * i.e. 32x further out than the fit. Everything between those two is a state
 * the editor cannot draw coherently, because past the fit the layers stop
 * agreeing about what is on screen:
 *
 *  - the waveform comes from `getPeaksForRange`, which CLAMPS its request to
 *    `[0, docLength]` and spreads what survives over every pixel column, so
 *    once the window runs past the end of the track the picture is identical
 *    for every further zoom-out — the waveform is pinned;
 *  - the beat tics (`drawBeatTics`) and the ruler (`TimelineRuler`) map samples
 *    through `sampleToPixel` with the raw `samplesPerPixel` and no clamp, so
 *    they carry on compressing toward the left edge.
 *
 * That is exactly the reported symptom: "zooming out still affects the tempo
 * lines and the timeline even though the track has reached its limit". Making
 * the ceiling the fit makes the incoherent range unreachable, and gives Fit,
 * the − button, the wheel, the tics and the ruler a single limit to share.
 *
 * Floored at {@link MIN_SPP}: a track shorter than `laneWidth * MIN_SPP` (~50
 * samples on a 1600 px lane) cannot fill the lane without exceeding the app's
 * maximum zoom-in, so it fits as far as the zoom range allows and no further.
 */
export function fitSamplesPerPixel(doc: AudioDocument, laneWidth = editorLaneWidth()): number {
  return Math.max(MIN_SPP, docLength(doc) / laneWidth);
}

export interface ZoomRequest {
  samplesPerPixel: number;
  /**
   * Either an absolute scroll position, or a function of the RESOLVED
   * samples-per-pixel. The anchored paths (since D1: the wheel AND the −/+
   * buttons, both on the edit cursor) need the CLAMPED spp to keep their anchor
   * under the same x: computing the scroll from the requested spp and then
   * clamping it separately is how an anchor drifts at the limit.
   */
  scrollSample: number | ((resolvedSamplesPerPixel: number) => number);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * F11-9 — the ONLY place the editor's zoom is clamped. `samplesPerPixel` into
 * `[MIN_SPP, fit]`, `scrollSample` into `[0, docLength - laneWidth * spp]`.
 * Every consumer (wheel gesture, −/+ buttons, Fit, activation, the three
 * panels' "go to", Go to Start / Go to End, and through the store's `zoom` the
 * renderer, the tic layer and the ruler) reads what this returns; none of them
 * clamps again.
 *
 * "ONLY" is a claim about `setZoom` callers, and it was FALSE when first
 * written: five surfaces still wrote the store directly with a scroll they had
 * guessed for "a ~800 px viewport" (Markers, Remix and Transcript "go to", plus
 * both transport jumps). Since fit-on-open they were all writing past the end
 * of a document that starts entirely on screen. They route through
 * {@link centreEditorOn} / {@link applyEditorZoom} now.
 *
 * The sixth was found by review, not by symptom: `fileService.rollbackOpen`
 * restored its view-state snapshot with a raw `setZoom`, and a snapshot is only
 * known-good for the lane it was taken against — a decode is exactly the window
 * in which the lane can be re-measured (M3). It routes here too. That is the
 * lesson rather than the count: a comment claiming single-sourcing does not
 * enforce it, so grep `setZoom` before believing this paragraph.
 *
 * The two clamps are one rule stated twice: together they say the visible
 * window `[scrollSample, scrollSample + laneWidth * spp)` never runs past the
 * end of the document.
 */
export function resolveZoom(
  doc: AudioDocument,
  requested: ZoomRequest,
  laneWidth = editorLaneWidth()
): Zoom {
  const length = docLength(doc);
  const samplesPerPixel = clamp(
    requested.samplesPerPixel,
    MIN_SPP,
    fitSamplesPerPixel(doc, laneWidth)
  );
  const wanted =
    typeof requested.scrollSample === 'function'
      ? requested.scrollSample(samplesPerPixel)
      : requested.scrollSample;
  const maxScroll = Math.max(0, length - laneWidth * samplesPerPixel);
  // A NaN request (an anchor computed from a zero-width rect, say) resolves to
  // the start rather than poisoning the store.
  const scrollSample = Number.isFinite(wanted) ? clamp(wanted, 0, maxScroll) : 0;
  return { samplesPerPixel, scrollSample };
}

/** The zoom applied whenever a document is (re)activated, and what the Fit
 * button restores: the whole document laid across the measured editor lane
 * exactly. Exported since G3 — the zoom-% readout defines 100% as this level.
 * `Infinity` resolves to the ceiling, so "fit" is literally "as far out as the
 * editor goes" and cannot drift from {@link fitSamplesPerPixel}. */
export function defaultZoom(doc: AudioDocument): Zoom {
  return resolveZoom(doc, { samplesPerPixel: Number.POSITIVE_INFINITY, scrollSample: 0 });
}

/**
 * The ONE writer for every editor zoom gesture: resolve the request against the
 * active document, then commit it only if it actually differs. The no-op guard
 * is load-bearing rather than an optimisation — at the limit it is what makes
 * "nothing moves" observable, since a fresh but equal `zoom` object would still
 * be a new store snapshot and would repaint the waveform, the tics and the
 * ruler for no reason.
 */
export function applyEditorZoom(requested: ZoomRequest): void {
  const s = useAppStore.getState();
  const doc = s.documents.find((d) => d.id === s.activeDocumentId) ?? null;
  if (!doc) return;
  const next = resolveZoom(doc, requested);
  if (
    next.samplesPerPixel === s.zoom.samplesPerPixel &&
    next.scrollSample === s.zoom.scrollSample
  ) {
    return;
  }
  s.setZoom(next);
}

/**
 * F11 fix round (I2) — scroll the editor so `sample` is in the middle, at the
 * current zoom.
 *
 * Every "go to this position" surface wants exactly this: the Markers panel's
 * time button, the Remix panel's Go To, the Transcript panel's row jump, and
 * Go to Start / Go to End. All five used to write `setZoom` directly with a
 * scroll approximated for "a ~800 px viewport" — a number none of them could
 * know — which meant all five bypassed {@link resolveZoom}.
 *
 * That was survivable while a fresh document opened part-way zoomed in. Since
 * F11-3 a fresh document opens FITTED, which is the zoom-out limit, where
 * `maxScroll` is 0: one click on a marker wrote a positive `scrollSample`, and
 * the beat tics and the ruler slid off the end of a waveform that could not
 * follow them. The F11-9 symptom, through a different door, on the surfaces
 * F11-8 had just made more prominent.
 *
 * Routing through {@link applyEditorZoom} fixes the clamp AND the guess: the
 * lane's real measured width is available now, so "centred" means centred on
 * the lane the user is looking at. The zoom level is carried through untouched
 * — this is a scroll, never a zoom.
 */
export function centreEditorOn(sample: number): void {
  applyEditorZoom({
    samplesPerPixel: useAppStore.getState().zoom.samplesPerPixel,
    // A function of the RESOLVED spp, so the centring uses the zoom actually
    // committed rather than the one requested.
    scrollSample: (spp) => sample - (editorLaneWidth() * spp) / 2,
  });
}

/**
 * F11-3 — the editor lane reports how wide it actually is.
 *
 * Called from the views' resize effect, which is also the FIRST moment the real
 * width is knowable: a document opened before any lane existed was fitted to
 * the 1600 px fallback, so the mount that finally measures the lane has to
 * re-fit it or the "whole track fits" promise would hold only from the second
 * document onward. Hence the two arms:
 *
 *  - a view that was sitting at the fit stays at the fit (a fitted view stays
 *    fitted across a window resize — the only reading of Fit that survives the
 *    user dragging the window edge);
 *  - anything zoomed in is merely re-resolved, which re-clamps the scroll to
 *    the new lane without throwing away where the user was looking.
 */
export function publishEditorLaneWidth(width: number): void {
  const previous = editorLaneWidth();
  if (!setEditorLaneWidth(width)) return; // unchanged, or not a real measurement
  const s = useAppStore.getState();
  const doc = s.documents.find((d) => d.id === s.activeDocumentId) ?? null;
  if (!doc) return;
  const wasFitted = s.zoom.samplesPerPixel >= fitSamplesPerPixel(doc, previous);
  applyEditorZoom(
    wasFitted ? { samplesPerPixel: Number.POSITIVE_INFINITY, scrollSample: 0 } : s.zoom
  );
}

/** Reset applied whenever the active document changes. */
function activationReset(doc: AudioDocument | null): Pick<
  AppState,
  'selection' | 'cursorSample' | 'zoom' | 'playback'
> {
  return {
    selection: null,
    cursorSample: 0,
    zoom: doc ? defaultZoom(doc) : { samplesPerPixel: 512, scrollSample: 0 },
    playback: { state: 'stopped', positionSample: 0, loop: false },
  };
}

/** Replace the document with `docId` (if present) with a copy marked dirty —
 * the same immutable replace-by-id shape as `updateDocument`, used by the
 * marker actions so a marker-only edit is visible to every dirty consumer
 * (close prompt, quit-guard count, FilesPanel `*`) and to the H1 async-save
 * staleness check, which relies on reference equality against the doc object. */
function markDirty(documents: AudioDocument[], docId: string): AudioDocument[] {
  return documents.map((d) => (d.id === docId ? { ...d, dirty: true } : d));
}

export const useAppStore = create<AppState & AppActions>()((set) => ({
  ...makeInitialState(),

  addDocument(doc) {
    set((s) => ({
      documents: [...s.documents, doc],
      activeDocumentId: doc.id,
      selection: null,
      cursorSample: 0,
      zoom: defaultZoom(doc),
    }));
  },

  closeDocument(id) {
    set((s) => {
      const index = s.documents.findIndex((d) => d.id === id);
      if (index === -1) return s;
      const documents = s.documents.filter((d) => d.id !== id);
      const markers = { ...s.markers };
      delete markers[id];

      if (s.activeDocumentId !== id) {
        return { documents, markers };
      }
      // Closed doc was active: activate the doc now at the same index,
      // or the last one if the index is out of range; null if none remain.
      const next = documents.length === 0 ? null : documents[Math.min(index, documents.length - 1)];
      return {
        documents,
        markers,
        activeDocumentId: next ? next.id : null,
        ...activationReset(next),
      };
    });
  },

  setActiveDocument(id) {
    set((s) => {
      const doc = s.documents.find((d) => d.id === id);
      if (!doc) return s;
      return { activeDocumentId: id, ...activationReset(doc) };
    });
  },

  updateDocument(doc) {
    set((s) => ({ documents: s.documents.map((d) => (d.id === doc.id ? doc : d)) }));
  },

  setSelection(sel) {
    set({ selection: orderSelection(sel) });
  },

  setCursor(sample) {
    set({ cursorSample: sample });
  },

  setZoom(z) {
    set({ zoom: z });
  },

  setView(v) {
    set({ view: v });
  },

  setPlayback(p) {
    set((s) => ({ playback: { ...s.playback, ...p } }));
  },

  addMarker(docId, m) {
    set((s) => {
      const list = [...(s.markers[docId] ?? []), m].sort(
        (a, b) => a.positionSample - b.positionSample
      );
      return {
        markers: { ...s.markers, [docId]: list },
        documents: markDirty(s.documents, docId),
      };
    });
  },

  removeMarker(docId, markerId) {
    set((s) => {
      const existing = s.markers[docId];
      if (!existing || !existing.some((m) => m.id === markerId)) return s; // no-op
      const list = existing.filter((m) => m.id !== markerId);
      return {
        markers: { ...s.markers, [docId]: list },
        documents: markDirty(s.documents, docId),
      };
    });
  },

  renameMarker(docId, markerId, name) {
    set((s) => {
      const existing = s.markers[docId];
      if (!existing || !existing.some((m) => m.id === markerId)) return s; // no-op
      const list = existing.map((m) => (m.id === markerId ? { ...m, name } : m));
      return {
        markers: { ...s.markers, [docId]: list },
        documents: markDirty(s.documents, docId),
      };
    });
  },

  setMarkersForDoc(docId, markers) {
    set((s) => {
      const list = [...markers].sort((a, b) => a.positionSample - b.positionSample);
      return { markers: { ...s.markers, [docId]: list } };
    });
  },
}));
