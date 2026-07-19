import { useAppStore, makeInitialState, nextId } from './appStore';
import type { Marker } from './appStore';
import { createDocument, docLength } from '../audio/AudioDocument';
import type { AudioDocument } from '../audio/AudioDocument';

function makeDoc(samples: number, name = 'test'): AudioDocument {
  return createDocument({
    name,
    sampleRate: 44100,
    channels: [new Float32Array(samples)],
  });
}

beforeEach(() => {
  // Partial-merge reset: with replace=true zustand v5 would wipe the actions
  // off the store, so we merge a fresh state over the existing one instead.
  useAppStore.setState(makeInitialState());
});

describe('makeInitialState', () => {
  it('returns the documented initial state', () => {
    const s = makeInitialState();
    expect(s.documents).toEqual([]);
    expect(s.activeDocumentId).toBeNull();
    expect(s.view).toBe('waveform');
    expect(s.selection).toBeNull();
    expect(s.cursorSample).toBe(0);
    expect(s.zoom).toEqual({ samplesPerPixel: 512, scrollSample: 0 });
    expect(s.playback).toEqual({ state: 'stopped', positionSample: 0, loop: false });
    expect(s.markers).toEqual({});
  });

  it('returns a fresh object each call', () => {
    const a = makeInitialState();
    const b = makeInitialState();
    expect(a).not.toBe(b);
    expect(a.documents).not.toBe(b.documents);
    expect(a.markers).not.toBe(b.markers);
  });
});

describe('nextId', () => {
  it('produces sequential ids for the same prefix', () => {
    const a = nextId('thing');
    const b = nextId('thing');
    expect(a).toMatch(/^thing-\d+$/);
    expect(Number(b.split('-')[1])).toBe(Number(a.split('-')[1]) + 1);
  });

  it('keeps independent counters per prefix', () => {
    const t1 = nextId('track');
    const c1 = nextId('clip');
    const t2 = nextId('track');
    expect(Number(t2.split('-')[1])).toBe(Number(t1.split('-')[1]) + 1);
    expect(c1).toMatch(/^clip-\d+$/);
  });

  it('shares the doc counter with createDocument (no duplicate doc ids)', () => {
    const doc = makeDoc(10);
    const id = nextId('doc');
    expect(id).not.toBe(doc.id);
    expect(Number(id.split('-')[1])).toBe(Number(doc.id.split('-')[1]) + 1);
  });
});

describe('addDocument', () => {
  it('appends the document and makes it active', () => {
    const doc = makeDoc(100);
    useAppStore.getState().addDocument(doc);
    const s = useAppStore.getState();
    expect(s.documents).toHaveLength(1);
    expect(s.documents[0]).toBe(doc);
    expect(s.activeDocumentId).toBe(doc.id);
  });

  it('sets default zoom to Math.max(1, Math.ceil(docLength/1600)) and scrollSample 0', () => {
    const doc = makeDoc(160000);
    useAppStore.getState().addDocument(doc);
    expect(useAppStore.getState().zoom).toEqual({
      samplesPerPixel: Math.max(1, Math.ceil(docLength(doc) / 1600)),
      scrollSample: 0,
    });
    expect(useAppStore.getState().zoom.samplesPerPixel).toBe(100);
  });

  it('clamps default zoom to a minimum of 1 sample per pixel for short docs', () => {
    const doc = makeDoc(10);
    useAppStore.getState().addDocument(doc);
    expect(useAppStore.getState().zoom.samplesPerPixel).toBe(1);
  });

  it('resets selection and cursor', () => {
    useAppStore.setState({ selection: { start: 5, end: 20 }, cursorSample: 42 });
    useAppStore.getState().addDocument(makeDoc(100));
    const s = useAppStore.getState();
    expect(s.selection).toBeNull();
    expect(s.cursorSample).toBe(0);
  });
});

describe('closeDocument', () => {
  it('activates the document at the same index when the active one is closed', () => {
    const [a, b, c] = [makeDoc(10, 'a'), makeDoc(10, 'b'), makeDoc(10, 'c')];
    const st = useAppStore.getState();
    st.addDocument(a);
    st.addDocument(b);
    st.addDocument(c);
    useAppStore.getState().setActiveDocument(b.id);

    useAppStore.getState().closeDocument(b.id);
    const s = useAppStore.getState();
    expect(s.documents.map((d) => d.id)).toEqual([a.id, c.id]);
    expect(s.activeDocumentId).toBe(c.id); // same index (1) in remaining array
  });

  it('activates the last remaining document when the closed one was last', () => {
    const [a, b] = [makeDoc(10, 'a'), makeDoc(10, 'b')];
    const st = useAppStore.getState();
    st.addDocument(a);
    st.addDocument(b); // b active, index 1
    useAppStore.getState().closeDocument(b.id);
    expect(useAppStore.getState().activeDocumentId).toBe(a.id);
  });

  it('sets activeDocumentId to null when the only document is closed', () => {
    const a = makeDoc(10);
    useAppStore.getState().addDocument(a);
    useAppStore.getState().closeDocument(a.id);
    expect(useAppStore.getState().activeDocumentId).toBeNull();
    expect(useAppStore.getState().documents).toEqual([]);
  });

  it('keeps the current active document when a non-active one is closed', () => {
    const [a, b] = [makeDoc(10, 'a'), makeDoc(10, 'b')];
    const st = useAppStore.getState();
    st.addDocument(a);
    st.addDocument(b); // b active
    useAppStore.getState().closeDocument(a.id);
    expect(useAppStore.getState().activeDocumentId).toBe(b.id);
  });

  it('drops the markers entry of the closed document', () => {
    const [a, b] = [makeDoc(10, 'a'), makeDoc(10, 'b')];
    const st = useAppStore.getState();
    st.addDocument(a);
    st.addDocument(b);
    useAppStore.getState().addMarker(a.id, { id: 'm-1', name: 'one', positionSample: 3 });
    useAppStore.getState().addMarker(b.id, { id: 'm-2', name: 'two', positionSample: 5 });

    useAppStore.getState().closeDocument(a.id);
    const s = useAppStore.getState();
    expect(s.markers[a.id]).toBeUndefined();
    expect(s.markers[b.id]).toHaveLength(1);
  });
});

describe('setActiveDocument', () => {
  it('switches the active document and resets selection/cursor/playback', () => {
    const [a, b] = [makeDoc(10, 'a'), makeDoc(3200, 'b')];
    const st = useAppStore.getState();
    st.addDocument(a);
    st.addDocument(b); // b active
    useAppStore.setState({
      selection: { start: 1, end: 2 },
      cursorSample: 7,
      playback: { state: 'playing', positionSample: 123, loop: true },
    });

    useAppStore.getState().setActiveDocument(a.id);
    const s = useAppStore.getState();
    expect(s.activeDocumentId).toBe(a.id);
    expect(s.selection).toBeNull();
    expect(s.cursorSample).toBe(0);
    expect(s.playback.state).toBe('stopped');
    expect(s.playback.positionSample).toBe(0);
  });

  it('resets zoom to the default for the newly active document', () => {
    const [a, b] = [makeDoc(160000, 'a'), makeDoc(10, 'b')];
    const st = useAppStore.getState();
    st.addDocument(a);
    st.addDocument(b); // b active, zoom samplesPerPixel = 1
    useAppStore.getState().setActiveDocument(a.id);
    expect(useAppStore.getState().zoom).toEqual({ samplesPerPixel: 100, scrollSample: 0 });
  });
});

describe('updateDocument', () => {
  it('replaces the document with a matching id', () => {
    const a = makeDoc(10, 'a');
    useAppStore.getState().addDocument(a);
    const updated: AudioDocument = { ...a, name: 'renamed', dirty: true };
    useAppStore.getState().updateDocument(updated);
    const s = useAppStore.getState();
    expect(s.documents).toHaveLength(1);
    expect(s.documents[0].name).toBe('renamed');
    expect(s.documents[0].dirty).toBe(true);
  });

  it('leaves other documents untouched', () => {
    const [a, b] = [makeDoc(10, 'a'), makeDoc(10, 'b')];
    const st = useAppStore.getState();
    st.addDocument(a);
    st.addDocument(b);
    useAppStore.getState().updateDocument({ ...a, name: 'a2' });
    const s = useAppStore.getState();
    expect(s.documents.map((d) => d.name)).toEqual(['a2', 'b']);
  });
});

describe('simple setters', () => {
  it('setSelection / setCursor / setZoom / setView update state', () => {
    const st = useAppStore.getState();
    st.setSelection({ start: 10, end: 20 });
    st.setCursor(15);
    st.setZoom({ samplesPerPixel: 64, scrollSample: 128 });
    st.setView('spectral');
    const s = useAppStore.getState();
    expect(s.selection).toEqual({ start: 10, end: 20 });
    expect(s.cursorSample).toBe(15);
    expect(s.zoom).toEqual({ samplesPerPixel: 64, scrollSample: 128 });
    expect(s.view).toBe('spectral');
  });

  it('setSelection(null) clears the selection', () => {
    useAppStore.getState().setSelection({ start: 1, end: 2 });
    useAppStore.getState().setSelection(null);
    expect(useAppStore.getState().selection).toBeNull();
  });

  it('setPlayback merges partial playback state', () => {
    useAppStore.getState().setPlayback({ state: 'playing' });
    expect(useAppStore.getState().playback).toEqual({
      state: 'playing',
      positionSample: 0,
      loop: false,
    });
    useAppStore.getState().setPlayback({ positionSample: 500, loop: true });
    expect(useAppStore.getState().playback).toEqual({
      state: 'playing',
      positionSample: 500,
      loop: true,
    });
  });
});

describe('markers', () => {
  const m = (id: string, positionSample: number, name = id): Marker => ({ id, name, positionSample });

  it('addMarker keeps the array sorted by positionSample', () => {
    const doc = makeDoc(1000);
    useAppStore.getState().addDocument(doc);
    useAppStore.getState().addMarker(doc.id, m('m-1', 500));
    useAppStore.getState().addMarker(doc.id, m('m-2', 100));
    useAppStore.getState().addMarker(doc.id, m('m-3', 300));
    const markers = useAppStore.getState().markers[doc.id];
    expect(markers.map((x) => x.positionSample)).toEqual([100, 300, 500]);
    expect(markers.map((x) => x.id)).toEqual(['m-2', 'm-3', 'm-1']);
  });

  it('removeMarker removes by marker id', () => {
    const doc = makeDoc(1000);
    useAppStore.getState().addDocument(doc);
    useAppStore.getState().addMarker(doc.id, m('m-1', 500));
    useAppStore.getState().addMarker(doc.id, m('m-2', 100));
    useAppStore.getState().removeMarker(doc.id, 'm-1');
    expect(useAppStore.getState().markers[doc.id].map((x) => x.id)).toEqual(['m-2']);
  });

  it('renameMarker renames by marker id, preserving position and order', () => {
    const doc = makeDoc(1000);
    useAppStore.getState().addDocument(doc);
    useAppStore.getState().addMarker(doc.id, m('m-1', 500, 'old'));
    useAppStore.getState().renameMarker(doc.id, 'm-1', 'new name');
    const markers = useAppStore.getState().markers[doc.id];
    expect(markers[0].name).toBe('new name');
    expect(markers[0].positionSample).toBe(500);
  });

  it('setMarkersForDoc replaces the whole list for a doc, sorted by positionSample', () => {
    const doc = makeDoc(1000);
    useAppStore.getState().addDocument(doc);
    useAppStore.getState().setMarkersForDoc(doc.id, [m('m-2', 500), m('m-1', 100)]);
    const markers = useAppStore.getState().markers[doc.id];
    expect(markers.map((x) => x.id)).toEqual(['m-1', 'm-2']);
    expect(markers.map((x) => x.positionSample)).toEqual([100, 500]);
  });

  it('setMarkersForDoc overwrites a previously-set list for the same doc', () => {
    const doc = makeDoc(1000);
    useAppStore.getState().addDocument(doc);
    useAppStore.getState().addMarker(doc.id, m('m-1', 50));
    useAppStore.getState().setMarkersForDoc(doc.id, [m('m-2', 200)]);
    expect(useAppStore.getState().markers[doc.id].map((x) => x.id)).toEqual(['m-2']);
  });

  it('setMarkersForDoc does not affect other documents', () => {
    const [a, b] = [makeDoc(1000, 'a'), makeDoc(1000, 'b')];
    useAppStore.getState().addDocument(a);
    useAppStore.getState().addDocument(b);
    useAppStore.getState().addMarker(b.id, m('m-b', 10));
    useAppStore.getState().setMarkersForDoc(a.id, [m('m-a', 20)]);
    expect(useAppStore.getState().markers[b.id].map((x) => x.id)).toEqual(['m-b']);
  });
});
