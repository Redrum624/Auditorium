import { act, render, screen } from '@testing-library/react';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import {
  beginDocumentDrag,
  draggedClipLength,
  endDocumentDrag,
  placeDocumentClips,
} from '../../multitrack/laneDrop';
import { useSessionStore } from '../../multitrack/sessionStore';
import { setSessionLaneWidth } from '../../multitrack/sessionViewport';
import {
  SESSION_UNDO_KEY,
  _resetSessionUndo,
  undoSession,
} from '../../multitrack/sessionUndo';
import * as beatGridService from '../../services/beatGrid';
import type { BeatGrid } from '../../services/beatGrid';
import { _resetSnapPreference } from '../../services/snapPreference';
import { getHistory } from '../../services/undoHistory';
import { makeInitialState, useAppStore } from '../../stores/appStore';
import FilesPanel from '../Panels/FilesPanel';
import MultitrackView from './MultitrackView';

/**
 * Task F11-4 — dragging a Files-panel row onto a track lane, driven through
 * the REAL components: the FilesPanel row is the drag source, MultitrackView
 * owns the highlight, TrackLane owns the drop.
 *
 * ---------------------------------------------------------------------------
 * WHY THE EVENTS ARE HAND-BUILT
 * ---------------------------------------------------------------------------
 * jsdom implements neither `DragEvent` nor `DataTransfer` (both are
 * `undefined` — measured, not assumed), so there is nothing to construct a
 * real drag with. What jsdom DOES have is `MouseEvent`, and React's event
 * system dispatches by event TYPE, not by constructor identity: a `MouseEvent`
 * of type 'dragover' with a `dataTransfer` property defined on it reaches
 * `onDragOver` with that object on `e.dataTransfer`. That is the same
 * technique the editor's pointer tests use for `pointerId`
 * (`WaveformView.playhead.test.tsx`), applied one layer up.
 *
 * The stub below is a real-DataTransfer-shaped object, and deliberately not
 * more: ONE stub is shared across dragstart -> dragover -> drop, exactly as a
 * browser hands one DataTransfer to a whole drag, so a test cannot accidentally
 * prove that the payload survives when in the real app it would not.
 *
 * jsdom also reports a zero-origin `getBoundingClientRect`, so a lane's left
 * edge is x = 0 here and `clientX` IS the lane-local x.
 */

// MT1-1: 512 was the session store's hardcoded default mtZoom. It is now the
// scale this file PINS (see the lane measurement in beforeEach) rather than one
// it inherits, so every pixel expectation below is unchanged.
const SPP = 512;
/** Where the seeded session ends: the seed clip's start + its length. The lane
 * is measured so that fitting THIS length gives exactly {@link SPP}. */
const SEEDED_SESSION_END = 200_000;
const SESSION_RATE = 44_100;

interface StubDataTransfer {
  readonly types: string[];
  files: File[];
  dropEffect: string;
  effectAllowed: string;
  setData(type: string, value: string): void;
  getData(type: string): string;
}

function stubDataTransfer(initial?: { files?: File[]; types?: string[] }): StubDataTransfer {
  const data = new Map<string, string>();
  const extra = initial?.types ?? [];
  return {
    get types() {
      return [...data.keys(), ...extra];
    },
    files: initial?.files ?? [],
    dropEffect: 'none',
    effectAllowed: 'all',
    setData(type, value) {
      data.set(type, value);
    },
    getData(type) {
      return data.get(type) ?? '';
    },
  };
}

type DragType = 'dragstart' | 'dragenter' | 'dragover' | 'dragleave' | 'drop' | 'dragend';

function fireDrag(
  element: Element,
  type: DragType,
  dt: StubDataTransfer | null,
  init: { clientX?: number; altKey?: boolean; relatedTarget?: EventTarget | null } = {}
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: 0,
    altKey: init.altKey ?? false,
    relatedTarget: (init.relatedTarget ?? null) as EventTarget | null,
  });
  Object.defineProperty(event, 'dataTransfer', { value: dt });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

function makeGrid(): BeatGrid {
  return {
    // 120 BPM at 44.1 kHz: a beat every 22 050 samples.
    beatSamples: Int32Array.from([0, 22_050, 44_100, 66_150, 88_200, 110_250]),
    sampleRate: SESSION_RATE,
    beatsPerBar: null,
    downbeatPhase: null,
    barCount: 0,
    confidence: 0.9,
    stale: false,
    analyzedEndSample: 1_000_000,
    truncated: false,
    origin: 'own',
    originDocId: 'doc-1',
    originOpen: true,
  };
}

let doc: AudioDocument;
let gridSpy: jest.SpyInstance;

/** Track 3 carries one clip through every test below, because it is the ONLY
 * reason there is anything to snap to: `sessionSnapTargets` builds its set out
 * of the OTHER clips' mapped beat grids, their source markers and the
 * multitrack cursor — an empty session offers a drop no magnet at all, by that
 * module's design (see its header). This clip starts at 100 000, so its mapped
 * beats are 100 000, 122 050, 144 100, … */
const SNAP_CLIP_START = 100_000;
const SEEDED_CLIPS = 1;

const lanes = () => screen.getAllByTestId('track-lane');
const clips = () => useSessionStore.getState().session.tracks.flatMap((t) => t.clips);
const droppedClips = () => clips().filter((c) => c.id !== 'seed-clip');
const doneLabels = () => getHistory(SESSION_UNDO_KEY).done;
const ghost = () => document.querySelector('[data-testid="clip-drop-ghost"]') as HTMLElement | null;
const isHighlighted = (lane: HTMLElement) => lane.style.backgroundColor !== 'transparent';

/** Renders the two surfaces of the gesture and starts a drag from the row of
 * the open document, returning the drag's DataTransfer. */
function startPanelDrag(): StubDataTransfer {
  render(
    <>
      <FilesPanel />
      <MultitrackView />
    </>
  );
  const dt = stubDataTransfer();
  fireDrag(screen.getByTestId('files-item'), 'dragstart', dt);
  return dt;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  // MT1-1: the session zoom is no longer the constant 512 this file's pixel
  // arithmetic was written against — it is the fit of the longest track across
  // the MEASURED lane, and because `fit` is also the zoom-out ceiling a coarser
  // zoom can no longer simply be asserted into the store. Rather than rewrite
  // every number below, the lane is measured at the width that makes the fit
  // exactly SPP for the session seeded at the end of this hook
  // (SEEDED_SESSION_END / SPP px), so the seed's re-fit lands on SPP and every
  // pixel expectation in this file means what it always meant. jsdom reports a
  // zero-width lane and `setSessionLaneWidth` rejects non-positive widths, so
  // mounting MultitrackView below cannot overwrite this.
  setSessionLaneWidth(SEEDED_SESSION_END / SPP);
  useSessionStore.getState().newSession(SESSION_RATE);
  _resetSnapPreference();
  endDocumentDrag();
  // 200 000 samples long, so the clip is far longer than any drop offset used
  // below and its TAIL never lands on a beat by accident.
  doc = createDocument({
    name: 'beat.wav',
    sampleRate: SESSION_RATE,
    channels: [new Float32Array(200_000)],
  });
  useAppStore.getState().addDocument(doc);
  // Park the multitrack cursor far away so it never competes as a target.
  useSessionStore.getState().setMtCursor(9_000_000);
  gridSpy = jest.spyOn(beatGridService, 'getBeatGrid').mockReturnValue(makeGrid());
  const trackIds = useSessionStore.getState().session.tracks.map((t) => t.id);
  useSessionStore.getState().addClip(trackIds[3], {
    id: 'seed-clip',
    documentId: doc.id,
    startSample: SNAP_CLIP_START,
    offsetSample: 0,
    lengthSample: 100_000,
    gainDb: 0,
  });
  _resetSessionUndo(); // the seeding above must not count as user history
});

afterEach(() => {
  gridSpy.mockRestore();
  _resetSnapPreference();
  endDocumentDrag();
});

describe('dragging a Files-panel row over a lane', () => {
  it('publishes the document id on the drag', () => {
    const dt = startPanelDrag();
    expect(dt.getData('application/x-auditorium-document-id')).toBe(doc.id);
    expect(dt.effectAllowed).toBe('copy');
  });

  it('highlights the lane under the pointer, and only that one', () => {
    const dt = startPanelDrag();
    fireDrag(lanes()[2], 'dragenter', dt);
    fireDrag(lanes()[2], 'dragover', dt, { clientX: 100 });

    expect(isHighlighted(lanes()[2])).toBe(true);
    expect(lanes().filter((l) => isHighlighted(l))).toHaveLength(1);
    expect(dt.dropEffect).toBe('copy');
  });

  it('shows a ghost line at the SNAPPED drop position, not the raw pointer x', () => {
    const dt = startPanelDrag();
    // x = 200 is raw sample 102 400 — 2 400 samples past the seeded clip's
    // first mapped beat at 100 000, and so inside the 8 px (4 096 sample)
    // magnet radius at this zoom.
    fireDrag(lanes()[0], 'dragenter', dt);
    fireDrag(lanes()[0], 'dragover', dt, { clientX: 200 });

    const line = ghost();
    expect(line).not.toBeNull();
    expect(parseFloat(line!.style.left)).toBeCloseTo(SNAP_CLIP_START / SPP, 5);
  });

  it('keeps the ghost visible when the magnet pulls the drop past the lane origin', () => {
    // V1 review, Minor 2. Scrolled so the lane origin is 1 000 samples (~2 px)
    // RIGHT of the seeded clip's first beat, a drop near the left edge snaps
    // BACKWARDS to that beat — a ghost at −1.95 px, which used to paint on the
    // header and now, with the lane clipped, painted nowhere at all: the line
    // vanished at exactly the edge where the user most needs to see the snap
    // take hold.
    const dt = startPanelDrag();
    act(() =>
      useSessionStore.setState({
        mtZoom: { samplesPerPixel: SPP, scrollSample: SNAP_CLIP_START + 1_000 },
      })
    );
    fireDrag(lanes()[0], 'dragenter', dt);
    fireDrag(lanes()[0], 'dragover', dt, { clientX: 2 });

    // The position it describes really is off the left edge — otherwise this
    // asserts nothing about the clamp.
    expect((SNAP_CLIP_START - (SNAP_CLIP_START + 1_000)) / SPP).toBeLessThan(0);
    expect(parseFloat(ghost()!.style.left)).toBe(0);

    // The line stops at the lane edge; the DROP does not. The clip commits the
    // snapped sample, and paints from the same clipped edge the ghost marked.
    fireDrag(lanes()[0], 'drop', dt, { clientX: 2 });
    expect(droppedClips()[0].startSample).toBe(SNAP_CLIP_START);
  });

  it('the ghost follows the raw pointer while Alt suspends the magnet', () => {
    const dt = startPanelDrag();
    fireDrag(lanes()[0], 'dragenter', dt);
    fireDrag(lanes()[0], 'dragover', dt, { clientX: 200, altKey: true });
    expect(parseFloat(ghost()!.style.left)).toBeCloseTo(200, 5);
  });

  it('W2: the ghost names the tier that took the drop — an edge snap looks different from a beat snap', () => {
    const dt = startPanelDrag();
    fireDrag(lanes()[0], 'dragenter', dt);

    // Near the seeded clip's TAIL edge at 200 000: the last mapped beat
    // (188 200) is 10 800 samples away — far outside the 4 096-sample radius —
    // so only the EDGE can take this drop.
    fireDrag(lanes()[0], 'dragover', dt, { clientX: 199_000 / SPP });
    expect(parseFloat(ghost()!.style.left)).toBeCloseTo(200_000 / SPP, 5);
    expect(ghost()!.dataset.snapTier).toBe('edge');
    expect(ghost()!.style.backgroundColor).toBe('var(--glass-text-title)');

    // Near a beat with no edge in reach: 122 500 → the beat at 122 050.
    fireDrag(lanes()[0], 'dragover', dt, { clientX: 122_500 / SPP });
    expect(ghost()!.dataset.snapTier).toBe('beat');
    expect(ghost()!.style.backgroundColor).toBe('var(--accent)');

    // Nothing in reach names no tier and keeps the accent line.
    fireDrag(lanes()[0], 'dragover', dt, { clientX: 160_000 / SPP });
    expect(ghost()!.dataset.snapTier).toBeUndefined();
    expect(ghost()!.style.backgroundColor).toBe('var(--accent)');
  });

  it('clears the highlight and the ghost when the drag leaves the lane', () => {
    const dt = startPanelDrag();
    fireDrag(lanes()[1], 'dragenter', dt);
    fireDrag(lanes()[1], 'dragover', dt, { clientX: 100 });
    expect(ghost()).not.toBeNull();

    fireDrag(lanes()[1], 'dragleave', dt, { relatedTarget: document.body });
    expect(ghost()).toBeNull();
    expect(lanes().filter((l) => isHighlighted(l))).toHaveLength(0);
  });

  it('keeps the highlight while the pointer crosses a child of the lane', () => {
    const dt = startPanelDrag();
    const lane = lanes()[1];
    fireDrag(lane, 'dragenter', dt);
    fireDrag(lane, 'dragover', dt, { clientX: 100 });
    // A dragleave whose relatedTarget is INSIDE the lane (a clip, the envelope
    // overlay) is the pointer moving within the lane, not out of it.
    const child = document.createElement('div');
    lane.appendChild(child);
    fireDrag(lane, 'dragleave', dt, { relatedTarget: child });
    expect(isHighlighted(lanes()[1])).toBe(true);
  });
});

describe('dropping a Files-panel row on a lane', () => {
  it('places a clip of that document at the snapped position, on that track', () => {
    const dt = startPanelDrag();
    const lane = lanes()[2];
    fireDrag(lane, 'dragenter', dt);
    fireDrag(lane, 'dragover', dt, { clientX: 200 });
    fireDrag(lane, 'drop', dt, { clientX: 200 });

    const tracks = useSessionStore.getState().session.tracks;
    expect(tracks.map((t) => t.clips.length)).toEqual([0, 0, 1, 1]);
    const clip = tracks[2].clips[0];
    expect(clip.documentId).toBe(doc.id);
    expect(clip.startSample).toBe(SNAP_CLIP_START); // snapped to the mapped beat
    expect(clip.offsetSample).toBe(0);
    expect(clip.lengthSample).toBe(200_000); // the whole document
    expect(useSessionStore.getState().selectedClipId).toBe(clip.id);
  });

  it('drops where the pointer is when Alt suspends the magnet', () => {
    const dt = startPanelDrag();
    const lane = lanes()[0];
    fireDrag(lane, 'dragenter', dt);
    fireDrag(lane, 'drop', dt, { clientX: 200, altKey: true });
    expect(droppedClips()[0].startSample).toBe(200 * SPP);
  });

  it('is ONE undoable session edit labelled "Add clip"', () => {
    const dt = startPanelDrag();
    const pre = useSessionStore.getState().session;
    const lane = lanes()[1];
    fireDrag(lane, 'dragenter', dt);
    fireDrag(lane, 'drop', dt, { clientX: 200 });

    expect(doneLabels()).toEqual(['Add clip']);
    act(() => undoSession());
    expect(useSessionStore.getState().session).toBe(pre);
    expect(clips()).toHaveLength(SEEDED_CLIPS);
  });

  it('clears the highlight and the ghost on drop', () => {
    const dt = startPanelDrag();
    fireDrag(lanes()[0], 'dragenter', dt);
    fireDrag(lanes()[0], 'dragover', dt, { clientX: 200 });
    fireDrag(lanes()[0], 'drop', dt, { clientX: 200 });
    expect(ghost()).toBeNull();
    expect(lanes().filter((l) => isHighlighted(l))).toHaveLength(0);
  });

  it('places nothing when the document was closed mid-drag', () => {
    const dt = startPanelDrag();
    act(() => useAppStore.getState().closeDocument(doc.id));
    fireDrag(lanes()[0], 'dragenter', dt);
    fireDrag(lanes()[0], 'drop', dt, { clientX: 200 });
    expect(droppedClips()).toHaveLength(0);
    expect(doneLabels()).toEqual([]);
  });
});

describe('a drop that is not ours does nothing, visibly', () => {
  it('a drag of some other payload gets no acceptance, no highlight, no ghost', () => {
    render(<MultitrackView />);
    const dt = stubDataTransfer({ types: ['text/plain'] });
    const lane = lanes()[0];

    const over = fireDrag(lane, 'dragover', dt, { clientX: 100 });
    // The lane withheld its preventDefault, and so does the view root: a text
    // drag carries no `Files`, so nothing here has an opinion about it. It is
    // left un-prevented all the way up to the window, which is what lets a
    // drag of text land in a text control (the track-rename input is one).
    expect(over.defaultPrevented).toBe(false);
    expect(dt.dropEffect).toBe('none'); // untouched — nobody claimed the drag
    expect(ghost()).toBeNull();
    expect(lanes().filter((l) => isHighlighted(l))).toHaveLength(0);

    fireDrag(lane, 'drop', dt, { clientX: 100 });
    expect(droppedClips()).toHaveLength(0);
  });

  it('a document dropped outside every lane places nothing', () => {
    const dt = startPanelDrag();
    fireDrag(screen.getByTestId('multitrack-view'), 'drop', dt, { clientX: 300 });
    expect(droppedClips()).toHaveLength(0);
    expect(doneLabels()).toEqual([]);
    expect(lanes().filter((l) => isHighlighted(l))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// M3 — the view root's FILE guard is about Files, and only Files.
//
// The same regression `0ddcb68` fixed at the window level had a second copy
// here: this root preventDefaulted EVERY unclaimed dragover and drop, with no
// `types` check. The default action it was suppressing for a text drag is the
// one that inserts the text into a text control — and this view owns one, the
// track-rename input in `TrackHeader`. Refusing its dragover means the OS draws
// the no-drop cursor over the field and the drop never arrives.
//
// Dispatched on the ROOT rather than the window, because that is the element
// whose handlers are under test; the window guard has its own suite in
// `App.test.tsx` and `App` is not rendered here at all.
// ---------------------------------------------------------------------------
describe('the view root refuses files, and nothing else (M3)', () => {
  const root = () => screen.getByTestId('multitrack-view');

  it('LEAVES A TEXT DRAG ALONE — the track-rename input can still receive one', () => {
    render(<MultitrackView />);
    const dt = stubDataTransfer({ types: ['text/plain'] });

    expect(fireDrag(root(), 'dragover', dt).defaultPrevented).toBe(false);
    expect(fireDrag(root(), 'drop', dt).defaultPrevented).toBe(false);
    expect(dt.dropEffect).toBe('none'); // never set to 'none' BY the guard
  });

  it('refuses a FILE dragover and drop that no lane claimed', () => {
    render(<MultitrackView />);
    const dt = stubDataTransfer({ types: ['Files'] });

    const over = fireDrag(root(), 'dragover', dt);
    expect(over.defaultPrevented).toBe(true);
    expect(dt.dropEffect).toBe('none'); // the OS "no" cursor
    expect(fireDrag(root(), 'drop', dt).defaultPrevented).toBe(true);
  });

  it('leaves a drag carrying nothing recognisable alone, our own clip payload included', () => {
    render(<MultitrackView />);
    expect(fireDrag(root(), 'drop', stubDataTransfer()).defaultPrevented).toBe(false);
    expect(
      fireDrag(root(), 'drop', stubDataTransfer({ types: ['application/x-auditorium-document-id'] }))
        .defaultPrevented
    ).toBe(false);
  });

  it('does not throw when an event carries no dataTransfer at all', () => {
    render(<MultitrackView />);
    expect(() => fireDrag(root(), 'drop', null)).not.toThrow();
    expect(() => fireDrag(root(), 'dragover', null)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// F11 fix round (I4) — the assertions this suite was missing.
//
// Everything above proved the drop's EFFECTS. None of it proved the two things
// a browser actually requires of a drop target, and one of them (`dragover`) is
// the single most likely real-world failure: a drop whose dragover was not
// preventDefault'd never produces a `drop` event at all. jsdom dispatches one
// regardless, so this suite could not tell the difference.
// ---------------------------------------------------------------------------
describe('what the browser requires of an accepted drop (I4)', () => {
  it('preventDefaults the accepted dragover — without it no drop event ever fires', () => {
    const dt = startPanelDrag();
    fireDrag(lanes()[1], 'dragenter', dt);

    const over = fireDrag(lanes()[1], 'dragover', dt, { clientX: 100 });

    expect(over.defaultPrevented).toBe(true);
    expect(dt.dropEffect).toBe('copy');
  });

  it('preventDefaults the accepted drop itself', () => {
    const dt = startPanelDrag();
    fireDrag(lanes()[1], 'dragenter', dt);
    fireDrag(lanes()[1], 'dragover', dt, { clientX: 100 });

    const drop = fireDrag(lanes()[1], 'drop', dt, { clientX: 100 });

    expect(drop.defaultPrevented).toBe(true);
    expect(droppedClips()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// F11 fix round (I4) — the TAIL edge, which is the drag record's whole reason
// for existing.
//
// `dataTransfer.getData` is unreadable during `dragover`, so `beginDocumentDrag`
// records the dragged document separately purely so the ghost knows how LONG
// the clip will be — and a clip snaps on either edge. Every test above drops a
// 200 000-sample document whose tail cannot reach a target, so deleting
// `beginDocumentDrag` outright left the suite green: with only the head able to
// snap, the documented head-only degradation is indistinguishable from the
// real thing.
// ---------------------------------------------------------------------------
describe('the dragged clip snaps on its TAIL as well as its head (I4)', () => {
  // Targets are the seeded clip's mapped beats: 100 000, 122 050, 144 100,
  // 166 150, 188 200. Tolerance is 8 px x 512 spp = 4 096 samples.
  const SHORT_LEN = 30_000;
  const TAIL_TARGET = 144_100;
  /** Raw start whose TAIL is 2 000 samples past a beat (inside tolerance) and
   * whose HEAD is 5 950 from the nearest one (outside it). */
  const RAW_START = TAIL_TARGET - SHORT_LEN + 2_000; // 116 100

  function dragShortDoc(): { short: AudioDocument; dt: StubDataTransfer } {
    const short = createDocument({
      name: 'short.wav',
      sampleRate: SESSION_RATE,
      channels: [new Float32Array(SHORT_LEN)],
    });
    useAppStore.getState().addDocument(short);
    render(
      <>
        <FilesPanel />
        <MultitrackView />
      </>
    );
    const row = screen
      .getAllByTestId('files-item')
      .find((li) => li.textContent?.includes('short.wav'))!;
    const dt = stubDataTransfer();
    fireDrag(row, 'dragstart', dt);
    return { short, dt };
  }

  it('moves the drop so the clip END lands on a beat, leaving the head off-grid', () => {
    const { short, dt } = dragShortDoc();

    // Sanity: the head really is outside the magnet's reach, so a head-only
    // snap would leave the raw position untouched — this cannot pass by
    // accident.
    expect(
      Math.min(Math.abs(RAW_START - 122_050), Math.abs(RAW_START - 100_000))
    ).toBeGreaterThan(8 * SPP);

    fireDrag(lanes()[1], 'dragenter', dt);
    fireDrag(lanes()[1], 'dragover', dt, { clientX: RAW_START / SPP });
    fireDrag(lanes()[1], 'drop', dt, { clientX: RAW_START / SPP });

    const placed = droppedClips().find((c) => c.documentId === short.id)!;
    expect(placed.startSample).toBe(TAIL_TARGET - SHORT_LEN);
    expect(placed.startSample + placed.lengthSample).toBe(TAIL_TARGET);
  });

  it('the ghost shows that tail-snapped position DURING the drag', () => {
    const { dt } = dragShortDoc();

    fireDrag(lanes()[1], 'dragenter', dt);
    fireDrag(lanes()[1], 'dragover', dt, { clientX: RAW_START / SPP });

    expect(parseFloat(ghost()!.style.left)).toBeCloseTo((TAIL_TARGET - SHORT_LEN) / SPP, 5);
  });
});

// ---------------------------------------------------------------------------
// F11 fix round (I4) — the degradations `laneDrop`'s header describes, asserted
// rather than described. Each returned its documented value under a mutation
// that broke nothing else in this file.
// ---------------------------------------------------------------------------
describe('laneDrop degrades the way its header says it does (I4)', () => {
  it('reports a zero-length span when no drag is in flight — a head-only snap', () => {
    endDocumentDrag();
    expect(draggedClipLength(SESSION_RATE)).toBe(0);
  });

  it('reports zero for a document that was closed mid-drag, rather than guessing', () => {
    beginDocumentDrag('doc-that-never-existed');
    expect(draggedClipLength(SESSION_RATE)).toBe(0);
  });

  it('reports the real length for a document that IS open', () => {
    beginDocumentDrag(doc.id);
    // 200 000 samples at the session's own rate — no conversion to hide a bug.
    expect(draggedClipLength(SESSION_RATE)).toBe(200_000);
  });

  it('places nothing on a track id no session track answers to', () => {
    const placed = placeDocumentClips([doc.id], 'track-that-does-not-exist', 1_000);
    expect(placed).toEqual([]);
    expect(droppedClips()).toHaveLength(0);
    expect(doneLabels()).toEqual([]);
  });

  it('places nothing for an empty document list, and writes no history entry', () => {
    const trackId = useSessionStore.getState().session.tracks[0].id;
    const placed = placeDocumentClips([], trackId, 1_000);
    expect(placed).toEqual([]);
    expect(doneLabels()).toEqual([]);
  });
});

// F11 fix round (minor): crossing from one lane to the next fires the NEW
// lane's `dragenter` before the OLD lane's `dragleave`, so a `dragleave` that
// cleared the shared target unconditionally blanked the highlight the new lane
// had just claimed — one frame of nothing highlighted at every boundary.
describe('the highlight does not blink when the drag crosses lanes (I4 minor)', () => {
  it('hands the highlight straight over, with no frame in between', () => {
    const dt = startPanelDrag();
    fireDrag(lanes()[1], 'dragenter', dt);
    fireDrag(lanes()[1], 'dragover', dt, { clientX: 100 });
    expect(isHighlighted(lanes()[1])).toBe(true);

    // The real event order for a lane-to-lane crossing.
    fireDrag(lanes()[2], 'dragenter', dt);
    fireDrag(lanes()[1], 'dragleave', dt, { relatedTarget: lanes()[2] });

    const lit = lanes().filter((l) => isHighlighted(l));
    expect(lit).toHaveLength(1);
    expect(lit[0]).toBe(lanes()[2]);
  });

  it('still clears everything when the drag leaves the lanes entirely', () => {
    const dt = startPanelDrag();
    fireDrag(lanes()[1], 'dragenter', dt);
    fireDrag(lanes()[1], 'dragover', dt, { clientX: 100 });

    fireDrag(lanes()[1], 'dragleave', dt, { relatedTarget: document.body });

    expect(lanes().filter((l) => isHighlighted(l))).toHaveLength(0);
    expect(ghost()).toBeNull();
  });
});
