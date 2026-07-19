import { create } from 'zustand';
import type { AudioDocument } from '../audio/AudioDocument';
import { docLength } from '../audio/AudioDocument';

// Single per-prefix counter registry shared with createDocument's 'doc' ids,
// so nextId('doc') can never collide with an id assigned by createDocument.
export { nextId } from '../audio/AudioDocument';

export type EditorView = 'waveform' | 'spectral' | 'multitrack';
export interface SelectionRange {
  start: number;
  end: number;
} // samples, [start,end)
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

function defaultZoom(doc: AudioDocument): { samplesPerPixel: number; scrollSample: number } {
  return { samplesPerPixel: Math.max(1, Math.ceil(docLength(doc) / 1600)), scrollSample: 0 };
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
    set({ selection: sel });
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
      return { markers: { ...s.markers, [docId]: list } };
    });
  },

  removeMarker(docId, markerId) {
    set((s) => {
      const existing = s.markers[docId];
      if (!existing) return s;
      const list = existing.filter((m) => m.id !== markerId);
      return { markers: { ...s.markers, [docId]: list } };
    });
  },

  renameMarker(docId, markerId, name) {
    set((s) => {
      const existing = s.markers[docId];
      if (!existing) return s;
      const list = existing.map((m) => (m.id === markerId ? { ...m, name } : m));
      return { markers: { ...s.markers, [docId]: list } };
    });
  },

  setMarkersForDoc(docId, markers) {
    set((s) => {
      const list = [...markers].sort((a, b) => a.positionSample - b.positionSample);
      return { markers: { ...s.markers, [docId]: list } };
    });
  },
}));
