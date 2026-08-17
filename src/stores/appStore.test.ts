import {
  applyEditorZoom,
  centreEditorOn,
  defaultZoom,
  fitSamplesPerPixel,
  makeInitialState,
  MIN_SPP,
  nextId,
  publishEditorLaneWidth,
  resolveZoom,
  useAppStore,
} from './appStore';
import type { Marker } from './appStore';
import { createDocument, docLength } from '../audio/AudioDocument';
import type { AudioDocument } from '../audio/AudioDocument';
import {
  FALLBACK_EDITOR_LANE_WIDTH,
  _resetEditorLaneWidth,
} from '../services/editorViewport';

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
  // F11-3: the lane width is module state in `editorViewport`, so it outlives
  // a store reset. Forgetting it keeps every zoom expectation below anchored
  // on the documented fallback.
  _resetEditorLaneWidth();
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

  it('fits the whole document across the editor lane and starts at scroll 0', () => {
    const doc = makeDoc(160000);
    useAppStore.getState().addDocument(doc);
    // Nothing has measured a lane in this suite, so the fit is taken against
    // the 1600 px fallback — the nominal viewport `defaultZoom` used
    // unconditionally before F11-3.
    expect(useAppStore.getState().zoom).toEqual({
      samplesPerPixel: docLength(doc) / FALLBACK_EDITOR_LANE_WIDTH,
      scrollSample: 0,
    });
    expect(useAppStore.getState().zoom.samplesPerPixel).toBe(100);
  });

  // F11-3 replaced an arbitrary floor of 1 spp with the app's real zoom-in
  // limit. A document this short cannot fill the lane without zooming in
  // further than the editor goes, so it fits as far as the range allows.
  it('fits a document shorter than the lane as far as MIN_SPP allows', () => {
    const doc = makeDoc(10);
    useAppStore.getState().addDocument(doc);
    expect(useAppStore.getState().zoom.samplesPerPixel).toBe(MIN_SPP);
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

  describe('dirty tracking (Task M1)', () => {
    it('addMarker sets the owning document dirty and replaces its object', () => {
      const doc = makeDoc(1000);
      useAppStore.getState().addDocument(doc);
      expect(useAppStore.getState().documents[0].dirty).toBe(false);

      useAppStore.getState().addMarker(doc.id, m('m-1', 500));

      const updated = useAppStore.getState().documents[0];
      expect(updated.dirty).toBe(true);
      expect(updated).not.toBe(doc);
    });

    it('removeMarker sets the owning document dirty and replaces its object', () => {
      const doc = makeDoc(1000);
      useAppStore.getState().addDocument(doc);
      useAppStore.getState().addMarker(doc.id, m('m-1', 500));
      const afterAdd = useAppStore.getState().documents[0];
      useAppStore.getState().updateDocument({ ...afterAdd, dirty: false }); // simulate a save clearing dirty

      useAppStore.getState().removeMarker(doc.id, 'm-1');

      const updated = useAppStore.getState().documents[0];
      expect(updated.dirty).toBe(true);
      expect(updated).not.toBe(afterAdd);
      expect(useAppStore.getState().markers[doc.id]).toEqual([]);
    });

    it('renameMarker sets the owning document dirty and replaces its object', () => {
      const doc = makeDoc(1000);
      useAppStore.getState().addDocument(doc);
      useAppStore.getState().addMarker(doc.id, m('m-1', 500, 'old'));
      const afterAdd = useAppStore.getState().documents[0];
      useAppStore.getState().updateDocument({ ...afterAdd, dirty: false }); // simulate a save clearing dirty

      useAppStore.getState().renameMarker(doc.id, 'm-1', 'new name');

      const updated = useAppStore.getState().documents[0];
      expect(updated.dirty).toBe(true);
      expect(updated).not.toBe(afterAdd);
    });

    it('removeMarker is a no-op (no dirty) for a marker id that does not exist', () => {
      const doc = makeDoc(1000);
      useAppStore.getState().addDocument(doc);
      useAppStore.getState().addMarker(doc.id, m('m-1', 500));
      useAppStore.getState().updateDocument({ ...useAppStore.getState().documents[0], dirty: false });
      const before = useAppStore.getState().documents[0];

      useAppStore.getState().removeMarker(doc.id, 'nonexistent');

      const after = useAppStore.getState().documents[0];
      expect(after).toBe(before);
      expect(after.dirty).toBe(false);
    });

    it('removeMarker is a no-op (no dirty) for a document with no markers entry at all', () => {
      const doc = makeDoc(1000);
      useAppStore.getState().addDocument(doc);
      const before = useAppStore.getState().documents[0];

      useAppStore.getState().removeMarker(doc.id, 'nonexistent');

      const after = useAppStore.getState().documents[0];
      expect(after).toBe(before);
      expect(after.dirty).toBe(false);
    });

    it('renameMarker is a no-op (no dirty) for a marker id that does not exist', () => {
      const doc = makeDoc(1000);
      useAppStore.getState().addDocument(doc);
      useAppStore.getState().addMarker(doc.id, m('m-1', 500, 'old'));
      useAppStore.getState().updateDocument({ ...useAppStore.getState().documents[0], dirty: false });
      const before = useAppStore.getState().documents[0];

      useAppStore.getState().renameMarker(doc.id, 'nonexistent', 'new name');

      const after = useAppStore.getState().documents[0];
      expect(after).toBe(before);
      expect(after.dirty).toBe(false);
    });

    it('setMarkersForDoc (bulk seeding) does not dirty or replace the document object', () => {
      const doc = makeDoc(1000);
      useAppStore.getState().addDocument(doc);
      const before = useAppStore.getState().documents[0];

      useAppStore.getState().setMarkersForDoc(doc.id, [m('m-1', 100), m('m-2', 200)]);

      const after = useAppStore.getState().documents[0];
      expect(after).toBe(before);
      expect(after.dirty).toBe(false);
    });
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

// ---------------------------------------------------------------------------
// F11-3 / F11-9 — one clamped zoom resolution, and the fit that shares its
// limit. The bug these pin: past the fit, `getPeaksForRange` clamps its request
// to the document and re-spreads it over every column, so the waveform freezes
// while the beat tics and the ruler — which map through `sampleToPixel` with
// the raw spp — keep compressing. The invariant that keeps the three layers on
// the same picture is `scrollSample + laneWidth * spp <= docLength`.
// ---------------------------------------------------------------------------
describe('resolveZoom (F11-9)', () => {
  const LANE = 800;

  it('clamps zoom-out at the fit — the whole document, and not one pixel more', () => {
    const doc = makeDoc(160_000);
    const fit = fitSamplesPerPixel(doc, LANE);
    expect(fit).toBe(200);

    const out = resolveZoom(doc, { samplesPerPixel: fit * 50, scrollSample: 0 }, LANE);
    expect(out.samplesPerPixel).toBe(fit);
    expect(out.scrollSample + LANE * out.samplesPerPixel).toBe(docLength(doc));
  });

  it('never lets the visible window run past the end of the document', () => {
    const doc = makeDoc(160_000);
    for (const spp of [0.01, 1, 37, 199, 200, 201, 1000, 1e9]) {
      for (const scrollSample of [-500, 0, 12_345, 160_000, 1e9]) {
        const out = resolveZoom(doc, { samplesPerPixel: spp, scrollSample }, LANE);
        expect(out.scrollSample).toBeGreaterThanOrEqual(0);
        expect(out.scrollSample + LANE * out.samplesPerPixel).toBeLessThanOrEqual(
          docLength(doc) + 1e-9
        );
      }
    }
  });

  it('floors samplesPerPixel at MIN_SPP', () => {
    const doc = makeDoc(160_000);
    expect(resolveZoom(doc, { samplesPerPixel: 0, scrollSample: 0 }, LANE).samplesPerPixel).toBe(
      MIN_SPP
    );
  });

  it('hands the RESOLVED samplesPerPixel to a scroll thunk, so an anchor survives the clamp', () => {
    const doc = makeDoc(160_000);
    const seen: number[] = [];
    resolveZoom(
      doc,
      {
        samplesPerPixel: 1e6, // will be clamped to the fit, 200
        scrollSample: (spp) => {
          seen.push(spp);
          return 0;
        },
      },
      LANE
    );
    expect(seen).toEqual([200]);
  });

  it('resolves a non-finite scroll request to the start rather than poisoning the store', () => {
    const doc = makeDoc(160_000);
    expect(resolveZoom(doc, { samplesPerPixel: 100, scrollSample: NaN }, LANE).scrollSample).toBe(
      0
    );
  });

  it('defaultZoom IS the zoom-out limit — Fit and the − button cannot disagree', () => {
    const doc = makeDoc(160_000);
    expect(defaultZoom(doc)).toEqual({
      samplesPerPixel: fitSamplesPerPixel(doc),
      scrollSample: 0,
    });
    expect(fitSamplesPerPixel(doc)).toBe(docLength(doc) / FALLBACK_EDITOR_LANE_WIDTH);
  });
});

describe('applyEditorZoom (F11-9)', () => {
  it('writes nothing at all when the request resolves to the zoom already in place', () => {
    const doc = makeDoc(160_000);
    useAppStore.getState().addDocument(doc);
    const before = useAppStore.getState().zoom;

    applyEditorZoom({ samplesPerPixel: before.samplesPerPixel * 4, scrollSample: 0 });

    // Same OBJECT: no new store snapshot, so nothing repaints.
    expect(useAppStore.getState().zoom).toBe(before);
  });

  it('commits a zoom-in and keeps the window inside the document', () => {
    const doc = makeDoc(160_000);
    useAppStore.getState().addDocument(doc);

    applyEditorZoom({ samplesPerPixel: 25, scrollSample: 1e9 });

    const z = useAppStore.getState().zoom;
    expect(z.samplesPerPixel).toBe(25);
    expect(z.scrollSample).toBe(160_000 - FALLBACK_EDITOR_LANE_WIDTH * 25);
  });

  it('does nothing without an active document', () => {
    const before = useAppStore.getState().zoom;
    applyEditorZoom({ samplesPerPixel: 1, scrollSample: 0 });
    expect(useAppStore.getState().zoom).toBe(before);
  });
});

describe('publishEditorLaneWidth (F11-3)', () => {
  it('re-fits a fitted document to the lane that finally measured itself', () => {
    const doc = makeDoc(160_000);
    useAppStore.getState().addDocument(doc); // fitted to the 1600 fallback
    expect(useAppStore.getState().zoom.samplesPerPixel).toBe(100);

    publishEditorLaneWidth(400);

    const z = useAppStore.getState().zoom;
    expect(z.samplesPerPixel).toBe(400);
    expect(z.scrollSample + 400 * z.samplesPerPixel).toBe(docLength(doc));
  });

  it('leaves a zoomed-in view where the user put it, only re-clamping its scroll', () => {
    const doc = makeDoc(160_000);
    useAppStore.getState().addDocument(doc);
    // Zoomed in near the end of the track, on the 1600 px fallback lane.
    useAppStore.getState().setZoom({ samplesPerPixel: 10, scrollSample: 143_000 });

    // The lane turns out to be WIDER, so the same zoom now shows more samples
    // and the old scroll would push the window past the end.
    publishEditorLaneWidth(2000);

    const z = useAppStore.getState().zoom;
    expect(z.samplesPerPixel).toBe(10); // not re-fitted — the user chose this zoom
    expect(z.scrollSample).toBe(160_000 - 2000 * 10); // pulled back to the last full window
  });

  it('ignores a zero measurement, so a hidden lane never redefines the fit', () => {
    const doc = makeDoc(160_000);
    useAppStore.getState().addDocument(doc);
    const before = useAppStore.getState().zoom;

    publishEditorLaneWidth(0);

    expect(useAppStore.getState().zoom).toBe(before);
    expect(fitSamplesPerPixel(doc)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// F11 fix round (I2) — `centreEditorOn`, the writer every "go to this sample"
// surface uses.
//
// Five of them (Markers, Remix, Transcript, Go to Start, Go to End) wrote
// `setZoom` directly with a scroll approximated for "a ~800 px viewport",
// bypassing the clamp entirely. Since fit-on-open, EVERY freshly opened
// document sits at the zoom-out limit, where `maxScroll` is 0 — so one click on
// a marker wrote a positive `scrollSample`, and the tics and the ruler slid off
// the end of a waveform that could not follow. That is the F11-9 symptom
// arriving through a different door, on the surfaces F11-8 had just
// emphasised.
// ---------------------------------------------------------------------------
describe('centreEditorOn (F11 fix round)', () => {
  beforeEach(() => {
    useAppStore.setState(makeInitialState());
    _resetEditorLaneWidth();
  });

  afterEach(() => {
    _resetEditorLaneWidth();
  });

  it('does not scroll at all when the whole track already fits — the F11-9 symptom', () => {
    const doc = makeDoc(160_000);
    publishEditorLaneWidth(800);
    useAppStore.getState().addDocument(doc); // opens fitted
    const atFit = useAppStore.getState().zoom;
    expect(atFit.scrollSample).toBe(0);

    centreEditorOn(docLength(doc) - 1);

    // Nothing to scroll to: the document is already entirely on screen.
    expect(useAppStore.getState().zoom.scrollSample).toBe(0);
    // ...and the object identity is unchanged, so nothing repaints either.
    expect(useAppStore.getState().zoom).toBe(atFit);
  });

  it('centres the sample on the MEASURED lane, not on an assumed 800px one', () => {
    const doc = makeDoc(1_000_000);
    publishEditorLaneWidth(1000);
    useAppStore.getState().addDocument(doc);
    // Zoom in so there is room to scroll: 100 samples/px over 1000 px shows
    // 100 000 samples of a 1 000 000-sample document.
    applyEditorZoom({ samplesPerPixel: 100, scrollSample: 0 });

    centreEditorOn(500_000);

    // Half a lane back from the target: 500 000 - (1000 * 100) / 2.
    expect(useAppStore.getState().zoom.scrollSample).toBe(450_000);
  });

  it('clamps at both ends rather than over-scrolling', () => {
    const doc = makeDoc(1_000_000);
    publishEditorLaneWidth(1000);
    useAppStore.getState().addDocument(doc);
    applyEditorZoom({ samplesPerPixel: 100, scrollSample: 0 });

    centreEditorOn(0);
    expect(useAppStore.getState().zoom.scrollSample).toBe(0);

    centreEditorOn(1_000_000);
    // maxScroll = 1 000 000 - 1000 * 100.
    expect(useAppStore.getState().zoom.scrollSample).toBe(900_000);
  });

  it('never changes the zoom level — centring is a scroll, not a zoom', () => {
    const doc = makeDoc(1_000_000);
    publishEditorLaneWidth(1000);
    useAppStore.getState().addDocument(doc);
    applyEditorZoom({ samplesPerPixel: 100, scrollSample: 0 });

    centreEditorOn(500_000);

    expect(useAppStore.getState().zoom.samplesPerPixel).toBe(100);
  });

  it('is a no-op with no active document', () => {
    const before = useAppStore.getState().zoom;
    centreEditorOn(1234);
    expect(useAppStore.getState().zoom).toBe(before);
  });
});
