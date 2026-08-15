import { act, render } from '@testing-library/react';
import ClipView from './ClipView';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import type { Clip } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import * as beatGridService from '../../services/beatGrid';
import type { BeatGrid } from '../../services/beatGrid';
import { _resetSnapPreference, setSnapEnabled } from '../../services/snapPreference';
import { makeInitialState, useAppStore } from '../../stores/appStore';

/**
 * Task B4 integration — the magnet on a multitrack clip, driven with REAL
 * pointer events through ClipView's own drag handlers (trap 28).
 *
 * The two things this file exists to prove:
 *   - the drag PREVIEW (a CSS transform) and the COMMIT (the store write) are
 *     the same position, so a snapped clip does not visibly jump on drop
 *     (trap 23) — since X5 this holds on EVERY default drop, overlapping or
 *     not, because `resolveOverlap` no longer relocates clips by default;
 *   - the v1.8 overlap nudge survives behind the Ctrl modifier
 *     (moveClip's opts.clearOverlap), still AFTER the snap, still
 *     forward-only — the one opted-into case where commit ≠ preview.
 */

const SPP = 100; // 1 CSS px == 100 samples -> the 8px tolerance is 800 samples
const SESSION_RATE = 44_100;

function firePointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: {
    clientX: number;
    clientY?: number;
    button?: number;
    altKey?: boolean;
    ctrlKey?: boolean;
    pointerId?: number;
  }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY ?? 0,
    button: init.button ?? 0,
    altKey: init.altKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
  });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

function fireKey(type: 'keydown' | 'keyup', altKey: boolean): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent(type, { key: 'Alt', altKey, bubbles: true }));
  });
}

function makeGrid(): BeatGrid {
  return {
    // 0, 22 050, 44 100, 66 150, 88 200 — 120 BPM at 44.1 kHz.
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

function clipOf(id: string, startSample: number, lengthSample: number): Clip {
  return { id, documentId: doc.id, startSample, offsetSample: 0, lengthSample, gainDb: 0 };
}

/** Seeds the session with the clips, then renders the one named by `draggedId`
 * exactly as its lane would. Returns the clip element. */
function mountDragged(clips: { trackIdx: number; clip: Clip }[], draggedId: string): HTMLElement {
  const s = useSessionStore.getState();
  for (const { trackIdx, clip } of clips) s.addClip(s.session.tracks[trackIdx].id, clip);

  const entry = clips.find((c) => c.clip.id === draggedId);
  if (!entry) throw new Error('dragged clip not seeded');
  const trackId = useSessionStore.getState().session.tracks[entry.trackIdx].id;

  const { container } = render(
    <ClipView
      clip={entry.clip}
      doc={doc}
      trackId={trackId}
      zoom={{ samplesPerPixel: SPP, scrollSample: 0 }}
      sessionRate={SESSION_RATE}
      laneHeight={96}
      selected={false}
      resolveTrackAt={() => null}
      onDragOverTrack={() => {}}
    />
  );
  return container.querySelector('[data-testid="clip"]') as HTMLElement;
}

function startOf(clipId: string): number {
  for (const t of useSessionStore.getState().session.tracks) {
    const c = t.clips.find((x) => x.id === clipId);
    if (c) return c.startSample;
  }
  throw new Error(`clip ${clipId} not found`);
}

function clipById(clipId: string): Clip {
  for (const t of useSessionStore.getState().session.tracks) {
    const c = t.clips.find((x) => x.id === clipId);
    if (c) return c;
  }
  throw new Error(`clip ${clipId} not found`);
}

/** A pointerdown x safely inside the clip body: the outer HANDLE_PX (6) at each
 * edge is a trim affordance, so grabbing at x=0 would start a trim, not a move.
 * jsdom reports a zero-origin rect, so clip-local x IS clientX here. */
function grabX(lengthSample: number, spp: number = SPP): number {
  return lengthSample / spp / 2;
}

/** The preview offset, in CSS px, read off the element's transform. */
function previewDx(el: HTMLElement): number {
  const t = el.style.transform;
  if (!t) return 0;
  const m = /translateX\((-?[\d.]+)px\)/.exec(t);
  return m ? Number(m[1]) : 0;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(SESSION_RATE);
  _resetSnapPreference();
  const channel = new Float32Array(400_000);
  doc = createDocument({ name: 'beat.wav', sampleRate: SESSION_RATE, channels: [channel] });
  useAppStore.getState().addDocument(doc);
  // Park the multitrack cursor far away so it never competes as a target.
  useSessionStore.getState().setMtCursor(9_000_000);
  gridSpy = jest.spyOn(beatGridService, 'getBeatGrid').mockReturnValue(makeGrid());
});

afterEach(() => {
  gridSpy.mockRestore();
  _resetSnapPreference();
});

describe('clip move — preview and commit agree', () => {
  // "other" sits on track 1 at 100 000, so its mapped beats are
  // 100 000 / 122 050 / 144 100 / ... "dragged" is a short clip on track 0.
  const seed = () => [
    { trackIdx: 0, clip: clipOf('dragged', 0, 20_000) },
    { trackIdx: 1, clip: clipOf('other', 100_000, 100_000) },
  ];

  it('previews the SNAPPED position, not the raw pointer delta', () => {
    const el = mountDragged(seed(), 'dragged');
    const grab = grabX(20_000);
    firePointer(el, 'pointerdown', { clientX: grab });
    // +1003 px -> raw start 100 300, 3px past the beat at 100 000.
    firePointer(el, 'pointermove', { clientX: grab + 1003 });
    // The magnet's whole point: the clip shows itself ON the tic while dragging.
    expect(previewDx(el)).toBe(1000);
  });

  it('commits exactly the position it previewed', () => {
    const el = mountDragged(seed(), 'dragged');
    const grab = grabX(20_000);
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: grab + 1003 });
    const shownStart = previewDx(el) * SPP;
    firePointer(el, 'pointerup', { clientX: grab + 1003 });

    expect(startOf('dragged')).toBe(100_000);
    expect(startOf('dragged')).toBe(shownStart);
  });

  it('leaves the preview on the raw delta when nothing is within tolerance', () => {
    const el = mountDragged(seed(), 'dragged');
    const grab = grabX(20_000);
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: grab + 1050 }); // raw 105 000, 50px away
    expect(previewDx(el)).toBe(1050);
    firePointer(el, 'pointerup', { clientX: grab + 1050 });
    expect(startOf('dragged')).toBe(105_000);
  });

  it('snaps the clip’s TAIL when that is the closer edge', () => {
    const el = mountDragged(seed(), 'dragged');
    const grab = grabX(20_000);
    firePointer(el, 'pointerdown', { clientX: grab });
    // raw start 102 100 -> raw end 122 100, 0.5px from the beat at 122 050;
    // the start edge is 21px from 100 000, far outside tolerance.
    firePointer(el, 'pointermove', { clientX: grab + 1021 });
    expect(previewDx(el)).toBe(1020.5);
    firePointer(el, 'pointerup', { clientX: grab + 1021 });
    expect(startOf('dragged')).toBe(102_050); // end lands exactly on 122 050
  });

  it('does NOT snap a clip to its OWN grid (trap 27)', () => {
    // The only clip in the session is the dragged one, so its own tics are the
    // only candidates — and they travel with it, which is why they are excluded.
    const el = mountDragged([{ trackIdx: 0, clip: clipOf('dragged', 300_000, 100_000) }], 'dragged');
    const grab = grabX(100_000);
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: grab + 5 });
    expect(previewDx(el)).toBe(5);
    firePointer(el, 'pointerup', { clientX: grab + 5 });
    expect(startOf('dragged')).toBe(300_500);
  });

  it('never moves a clip the user did not drag', () => {
    const el = mountDragged(seed(), 'dragged');
    const grab = grabX(20_000);
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: grab + 1003 });
    firePointer(el, 'pointerup', { clientX: grab + 1003 });
    expect(startOf('other')).toBe(100_000);
  });
});

describe('clip move — Alt suspends the magnet while held', () => {
  const seed = () => [
    { trackIdx: 0, clip: clipOf('dragged', 0, 20_000) },
    { trackIdx: 1, clip: clipOf('other', 100_000, 100_000) },
  ];

  it('a drag with Alt held previews and commits the raw position', () => {
    const el = mountDragged(seed(), 'dragged');
    const grab = grabX(20_000);
    firePointer(el, 'pointerdown', { clientX: grab, altKey: true });
    firePointer(el, 'pointermove', { clientX: grab + 1003, altKey: true });
    expect(previewDx(el)).toBe(1003);
    firePointer(el, 'pointerup', { clientX: grab + 1003, altKey: true });
    expect(startOf('dragged')).toBe(100_300);
  });

  it('pressing Alt MID-DRAG releases the clip from the tic without moving the pointer', () => {
    const el = mountDragged(seed(), 'dragged');
    const grab = grabX(20_000);
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: grab + 1003 });
    expect(previewDx(el)).toBe(1000); // snapped

    // No pointer movement at all — only the key. Without a key listener the
    // preview would stay stuck on the tic and then jump on drop.
    fireKey('keydown', true);
    expect(previewDx(el)).toBe(1003);

    fireKey('keyup', false);
    expect(previewDx(el)).toBe(1000); // resumes on release
  });

  it('the drop honours the modifier state at the moment of the drop', () => {
    const el = mountDragged(seed(), 'dragged');
    const grab = grabX(20_000);
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: grab + 1003, altKey: true });
    expect(previewDx(el)).toBe(1003);
    firePointer(el, 'pointerup', { clientX: grab + 1003, altKey: true });
    expect(startOf('dragged')).toBe(100_300);
  });

  it('stops listening for the modifier once the drag is over', () => {
    const el = mountDragged(seed(), 'dragged');
    const grab = grabX(20_000);
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: grab + 1003 });
    firePointer(el, 'pointerup', { clientX: grab + 1003 });
    expect(previewDx(el)).toBe(0); // preview cleared on drop

    fireKey('keydown', true);
    expect(previewDx(el)).toBe(0); // and the key no longer resurrects it
  });
});

describe('clip move — the toggle disables the magnet entirely', () => {
  it('switching it off leaves the preview and the commit on the raw delta', () => {
    const el = mountDragged(
      [
        { trackIdx: 0, clip: clipOf('dragged', 0, 20_000) },
        { trackIdx: 1, clip: clipOf('other', 100_000, 100_000) },
      ],
      'dragged'
    );
    const grab = grabX(20_000);
    act(() => {
      setSnapEnabled(false);
    });
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: grab + 1003 });
    expect(previewDx(el)).toBe(1003);
    firePointer(el, 'pointerup', { clientX: grab + 1003 });
    expect(startOf('dragged')).toBe(100_300);
  });
});

describe('snap / overlap ordering — snap-only by default (X5), the v1.8 nudge behind Ctrl', () => {
  // v1.8 pinned snap-then-nudge with the nudge able to override the snap.
  // X5 degraded it exactly as ClipView's ordering note predicted: by default
  // `resolveOverlap` no longer relocates, so the snapped position has the
  // last word and the preview always equals the commit — a same-track
  // overlap is intentional now. The nudge survives behind the Ctrl modifier
  // (opts.clearOverlap), still forward-only, still AFTER the snap.
  it('a snapped position that is FREE is committed exactly', () => {
    const el = mountDragged(
      [
        { trackIdx: 0, clip: clipOf('dragged', 0, 20_000) },
        { trackIdx: 1, clip: clipOf('other', 100_000, 100_000) },
      ],
      'dragged'
    );
    const grab = grabX(20_000);
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: grab + 1003 });
    firePointer(el, 'pointerup', { clientX: grab + 1003 });
    expect(startOf('dragged')).toBe(100_000);
  });

  it('a snapped position that OVERLAPS commits verbatim — preview and commit agree', () => {
    // Same track this time: "other" occupies [100 000, 200 000). Before X5
    // this drop was nudged to 200 000 and the preview deliberately disagreed
    // with the commit; the flip to agreement is the deliberate X5 change.
    const el = mountDragged(
      [
        { trackIdx: 0, clip: clipOf('dragged', 0, 20_000) },
        { trackIdx: 0, clip: clipOf('other', 100_000, 100_000) },
      ],
      'dragged'
    );
    const grab = grabX(20_000);
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: grab + 1003 });
    // The preview shows where the magnet put it...
    expect(previewDx(el)).toBe(1000);
    const shownStart = previewDx(el) * SPP;
    firePointer(el, 'pointerup', { clientX: grab + 1003 });
    // ...and the commit lands exactly there, overlap and all.
    expect(startOf('dragged')).toBe(100_000);
    expect(startOf('dragged')).toBe(shownStart);
    expect(startOf('other')).toBe(100_000); // the neighbour never moves
    // Equal starts have no handover direction (X3's rule 1), so THIS overlap
    // stays raw: the gesture writes no fade keys on either clip.
    expect(clipById('dragged').fadeInSample).toBeUndefined();
    expect(clipById('dragged').fadeOutSample).toBeUndefined();
    expect(clipById('other').fadeInSample).toBeUndefined();
    expect(clipById('other').fadeOutSample).toBeUndefined();
  });

  it('a drop overlapping a neighbour’s TAIL arms the crossfade — facing fades == overlap width', () => {
    // Both clips on track 0. "other"'s mapped beats include 188 200; dropping
    // there puts dragged at [188 200, 208 200) over other's [100 000, 200 000)
    // tail: a genuine handover, overlap width 11 800.
    const el = mountDragged(
      [
        { trackIdx: 0, clip: clipOf('dragged', 0, 20_000) },
        { trackIdx: 0, clip: clipOf('other', 100_000, 100_000) },
      ],
      'dragged'
    );
    const grab = grabX(20_000);
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: grab + 1883 }); // raw 188 300, 1px past the beat
    expect(previewDx(el)).toBe(1882); // snapped to 188 200
    firePointer(el, 'pointerup', { clientX: grab + 1883 });

    expect(startOf('dragged')).toBe(188_200); // committed == previewed
    // The gesture leaves the facing fades spanning the overlap exactly
    // (X3's canonical-pair contract, maintained by the store on commit).
    expect(clipById('other').fadeOutSample).toBe(11_800);
    expect(clipById('dragged').fadeInSample).toBe(11_800);
    // Away-side edges untouched.
    expect(clipById('other').fadeInSample).toBeUndefined();
    expect(clipById('dragged').fadeOutSample).toBeUndefined();
  });

  it('Ctrl at the drop re-enables the v1.8 nudge — forward-only, after the snap', () => {
    const el = mountDragged(
      [
        { trackIdx: 0, clip: clipOf('dragged', 0, 20_000) },
        { trackIdx: 0, clip: clipOf('other', 100_000, 100_000) },
      ],
      'dragged'
    );
    const grab = grabX(20_000);
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: grab + 1003 });
    expect(previewDx(el)).toBe(1000); // preview still shows the snapped spot…
    firePointer(el, 'pointerup', { clientX: grab + 1003, ctrlKey: true });
    // …and the opted-into nudge then pushes the clip clear, forward past the
    // neighbour — never back onto an earlier target. The committed position
    // is NOT a snap target; with Ctrl held that divergence is deliberate.
    expect(startOf('dragged')).toBe(200_000);
    // A nudged drop overlaps nothing, so nothing is armed.
    expect(clipById('dragged').fadeInSample).toBeUndefined();
    expect(clipById('other').fadeOutSample).toBeUndefined();
  });
});

describe('clip trim snaps', () => {
  // The dragged clip is 100 000 samples = 1000 CSS px wide, so a pointerdown at
  // x <= 6 is a start trim and x >= 994 an end trim (ClipView's HANDLE_PX).
  const seed = () => [
    { trackIdx: 0, clip: clipOf('dragged', 0, 100_000) },
    { trackIdx: 1, clip: clipOf('other', 30_000, 100_000) },
  ];

  it('the START edge snaps to a neighbouring clip’s beat', () => {
    const el = mountDragged(seed(), 'dragged');
    firePointer(el, 'pointerdown', { clientX: 2 });
    // +303 px -> raw new start 30 300, 3px past "other"'s first beat at 30 000.
    firePointer(el, 'pointermove', { clientX: 305 });
    expect(clipById('dragged').startSample).toBe(30_000);
    expect(clipById('dragged').lengthSample).toBe(70_000);
  });

  it('the END edge snaps', () => {
    const el = mountDragged(seed(), 'dragged');
    firePointer(el, 'pointerdown', { clientX: 996 });
    // -35 px -> raw new end 96 500, 3.5px from "other"'s beat at 96 150.
    firePointer(el, 'pointermove', { clientX: 961 });
    expect(clipById('dragged').startSample).toBe(0);
    expect(clipById('dragged').lengthSample).toBe(96_150);
  });

  it('Alt suspends a trim snap', () => {
    const el = mountDragged(seed(), 'dragged');
    firePointer(el, 'pointerdown', { clientX: 2, altKey: true });
    firePointer(el, 'pointermove', { clientX: 305, altKey: true });
    expect(clipById('dragged').startSample).toBe(30_300);
  });

  it('the toggle disables a trim snap', () => {
    const el = mountDragged(seed(), 'dragged');
    act(() => {
      setSnapEnabled(false);
    });
    firePointer(el, 'pointerdown', { clientX: 2 });
    firePointer(el, 'pointermove', { clientX: 305 });
    expect(clipById('dragged').startSample).toBe(30_300);
  });

  it('a trim snap never breaks the store’s own clamps', () => {
    const el = mountDragged(seed(), 'dragged');
    // Drag the start edge far past the end: the min-length-32 clamp still wins.
    firePointer(el, 'pointerdown', { clientX: 2 });
    firePointer(el, 'pointermove', { clientX: 5_000 });
    expect(clipById('dragged').lengthSample).toBeGreaterThanOrEqual(32);
  });
});

describe('clip move — edge targets and priority (W2)', () => {
  // A second document with NO grid, so a clip of it contributes edges and
  // nothing else — the un-analysed clip is exactly the case the old trap-27
  // mitigation ("the first beat usually IS the start") never covered.
  let doc2: AudioDocument;

  beforeEach(() => {
    doc2 = createDocument({
      name: 'plain.wav',
      sampleRate: SESSION_RATE,
      channels: [new Float32Array(400_000)],
    });
    useAppStore.getState().addDocument(doc2);
    gridSpy.mockImplementation((docId: string) => (docId === doc.id ? makeGrid() : null));
  });

  const plainClip = (id: string, startSample: number, lengthSample: number): Clip => ({
    id,
    documentId: doc2.id,
    startSample,
    offsetSample: 0,
    lengthSample,
    gainDb: 0,
  });

  it('the HEAD lands sample-exact on a same-track predecessor’s END — the butt join', () => {
    // The predecessor ends at 199 999, an odd number on purpose: only exact
    // sample equality survives it. "Within a millisecond" is 44 samples off
    // at 44.1 kHz and would fail this expectation.
    const el = mountDragged(
      [
        { trackIdx: 0, clip: plainClip('dragged', 0, 20_000) },
        { trackIdx: 0, clip: plainClip('other', 100_000, 99_999) },
      ],
      'dragged'
    );
    const grab = grabX(20_000);
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: grab + 2002.5 }); // raw 200 250, 251 past the end
    firePointer(el, 'pointerup', { clientX: grab + 2002.5 });

    expect(startOf('dragged')).toBe(199_999);
    // end == start exactly: ZERO overlap, so the join arms NO crossfade —
    // edge snapping produces the clean butt join, not the micro-overlap the
    // superseded trap-27 note feared (crossfadableOverlap rule 1).
    expect(clipById('other').startSample + clipById('other').lengthSample).toBe(199_999);
    expect(clipById('dragged').fadeInSample).toBeUndefined();
    expect(clipById('other').fadeOutSample).toBeUndefined();
  });

  it('the TAIL lands sample-exact on a cross-track clip’s START', () => {
    const el = mountDragged(
      [
        { trackIdx: 0, clip: plainClip('dragged', 0, 20_000) },
        { trackIdx: 1, clip: plainClip('other', 50_001, 30_000) },
      ],
      'dragged'
    );
    const grab = grabX(20_000);
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: grab + 297 }); // raw 29 700 -> tail 49 700, 301 short
    firePointer(el, 'pointerup', { clientX: grab + 297 });

    expect(startOf('dragged')).toBe(50_001 - 20_000); // tail exactly on 50 001
  });

  it('an EDGE outranks a strictly NEARER beat (tier priority, H3’s hazard closed)', () => {
    // The beat at 122 050 is 150 samples from the raw start; the un-analysed
    // clip's edge at 122 500 is 300. Flat nearest-wins took the beat and the
    // butt join was silently impossible; the edge tier takes the edge.
    const el = mountDragged(
      [
        { trackIdx: 0, clip: plainClip('dragged', 0, 20_000) },
        { trackIdx: 1, clip: clipOf('beatclip', 100_000, 100_000) },
        { trackIdx: 2, clip: plainClip('edgeclip', 122_500, 50_000) },
      ],
      'dragged'
    );
    const grab = grabX(20_000);
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: grab + 1222 }); // raw 122 200
    firePointer(el, 'pointerup', { clientX: grab + 1222 });

    expect(startOf('dragged')).toBe(122_500);
  });

  it('the parked CURSOR outranks a strictly nearer beat', () => {
    useSessionStore.getState().setMtCursor(122_500);
    const el = mountDragged(
      [
        { trackIdx: 0, clip: plainClip('dragged', 0, 20_000) },
        { trackIdx: 1, clip: clipOf('beatclip', 100_000, 100_000) },
      ],
      'dragged'
    );
    const grab = grabX(20_000);
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: grab + 1222 }); // raw 122 200: beat 150 away, cursor 300
    firePointer(el, 'pointerup', { clientX: grab + 1222 });

    expect(startOf('dragged')).toBe(122_500);
  });

  it('a group drag never snaps to a co-moving member’s captured edge', () => {
    const el = mountDragged(
      [
        { trackIdx: 0, clip: plainClip('dragged', 0, 20_000) },
        { trackIdx: 0, clip: plainClip('member', 50_000, 20_000) },
      ],
      'dragged'
    );
    act(() => useSessionStore.getState().setSelectedClips(['dragged', 'member']));
    const grab = grabX(20_000);
    firePointer(el, 'pointerdown', { clientX: grab });
    // Raw 49 700: the member's captured start (50 000) is 300 away — inside
    // tolerance, and STALE: the member is moving by the same delta. Excluded,
    // so the drop commits the raw position and the group stays rigid.
    firePointer(el, 'pointermove', { clientX: grab + 497 });
    firePointer(el, 'pointerup', { clientX: grab + 497 });

    expect(startOf('dragged')).toBe(49_700);
    expect(startOf('member')).toBe(99_700); // the identical, unsnapped delta
  });

  it('a TRIM snaps to a CO-SELECTED neighbour’s edge — only a rigid MOVE excludes the group', () => {
    // Review W2 finding 2: a trim moves ONLY this clip, so a co-selected
    // member is stationary and its edges are honest targets — the staleness
    // argument holds for the rigid group move alone. The dragged clip is
    // 100 000 samples = 1000 px wide; x >= 994 is the end-trim grip.
    const el = mountDragged(
      [
        { trackIdx: 0, clip: plainClip('dragged', 0, 100_000) },
        { trackIdx: 0, clip: plainClip('member', 100_701, 50_000) },
      ],
      'dragged'
    );
    act(() => useSessionStore.getState().setSelectedClips(['dragged', 'member']));
    firePointer(el, 'pointerdown', { clientX: 996 });
    // +7 px (past the 4 px drag threshold) -> raw new end 100 700, one sample
    // short of the member's start.
    firePointer(el, 'pointermove', { clientX: 1003 });
    expect(clipById('dragged').lengthSample).toBe(100_701); // end exactly on 100 701
    expect(clipById('dragged').startSample).toBe(0);
    expect(startOf('member')).toBe(100_701); // a trim never moves the neighbour
  });

  it('Alt suspends an edge snap exactly as it suspends a beat snap', () => {
    const el = mountDragged(
      [
        { trackIdx: 0, clip: plainClip('dragged', 0, 20_000) },
        { trackIdx: 0, clip: plainClip('other', 100_000, 99_999) },
      ],
      'dragged'
    );
    const grab = grabX(20_000);
    firePointer(el, 'pointerdown', { clientX: grab, altKey: true });
    firePointer(el, 'pointermove', { clientX: grab + 2002.5, altKey: true });
    firePointer(el, 'pointerup', { clientX: grab + 2002.5, altKey: true });
    expect(startOf('dragged')).toBe(200_250);
  });
});

describe('clip drag — the pixel-space tolerance, at the multitrack’s OWN zoom', () => {
  // Trap 26: the multitrack has its own zoom source. A snap helper that reached
  // for the editor's `samplesPerPixel` would quantise this surface at the wrong
  // scale — so the same sample gap must behave differently at two mtZoom values
  // while the app store's zoom never changes.
  function dragAtZoom(spp: number, gapSamples: number): number {
    useSessionStore.getState().newSession(SESSION_RATE);
    useSessionStore.getState().setMtCursor(9_000_000);
    const s = useSessionStore.getState();
    s.addClip(s.session.tracks[0].id, clipOf('dragged', 0, 20_000));
    s.addClip(s.session.tracks[1].id, clipOf('other', 100_000, 100_000));
    const trackId = useSessionStore.getState().session.tracks[0].id;
    const { container, unmount } = render(
      <ClipView
        clip={clipOf('dragged', 0, 20_000)}
        doc={doc}
        trackId={trackId}
        zoom={{ samplesPerPixel: spp, scrollSample: 0 }}
        sessionRate={SESSION_RATE}
        laneHeight={96}
        selected={false}
        resolveTrackAt={() => null}
        onDragOverTrack={() => {}}
      />
    );
    const el = container.querySelector('[data-testid="clip"]') as HTMLElement;
    const grab = grabX(20_000, spp);
    const moveTo = grab + (100_000 + gapSamples) / spp;
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: moveTo });
    firePointer(el, 'pointerup', { clientX: moveTo });
    const out = startOf('dragged');
    unmount();
    return out;
  }

  it('a 500-sample gap snaps at 100 samples/px (5px) and not at 10 samples/px (50px)', () => {
    // The app store's editor zoom is left at its own (different) default
    // throughout — only the value passed to ClipView changes.
    const editorSpp = useAppStore.getState().zoom.samplesPerPixel;
    expect(editorSpp).not.toBe(100);
    expect(editorSpp).not.toBe(10);
    expect(dragAtZoom(100, 500)).toBe(100_000);
    expect(dragAtZoom(10, 500)).toBe(100_500);
  });
});
