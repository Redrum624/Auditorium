import { act, render } from '@testing-library/react';
import ClipView from './ClipView';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import type { Clip } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { _resetSnapPreference } from '../../services/snapPreference';
import { makeInitialState, useAppStore } from '../../stores/appStore';
import { formatTime } from '../../utils/timeFormat';

/**
 * X4 — the clip fade UI, driven with REAL pointer events through the corner
 * handles' own drag handlers (the same discipline as ClipView.snap.test.tsx:
 * gestures are exercised, not state-poked).
 *
 * What this file exists to prove:
 *  - the corner fade handles are their OWN gesture: they never fall through
 *    to the X-only trim hit-test (T27/T28), never move or trim the clip, and
 *    commit through setClipFade — the single clamp boundary (C4);
 *  - the fade ramp and crossfade indicator are drawn from the renderer's own
 *    resolver on an SVG overlay — no third canvas (T29), and what is drawn is
 *    what SOUNDS (rule 3 / rule 4 gating included);
 *  - the overlap drop hint surfaces X5's semantics (drop = crossfade, Ctrl =
 *    push clear) exactly while the previewed span overlaps.
 *
 * Every comparison boundary introduced by X4 has a fixture ON the equality:
 * the 4 px drag threshold, the handle-position clamp at both ends, the
 * fades-may-meet clamp, the overlap `> 0` tests (tint and hint), and rule 3's
 * exact-width gate (one sample off).
 */

const SPP = 100; // 1 CSS px == 100 samples
const SESSION_RATE = 44_100;
const LANE_H = 96; // MultitrackView's LANE_H; clip box height = 88

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

function fireCtrlKey(type: 'keydown' | 'keyup', ctrlKey: boolean): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent(type, { key: 'Control', ctrlKey, bubbles: true }));
  });
}

let doc: AudioDocument;

function clipOf(id: string, startSample: number, lengthSample: number): Clip {
  return { id, documentId: doc.id, startSample, offsetSample: 0, lengthSample, gainDb: 0 };
}

/** Seeds the session (skipping clips that are already there, so a test can
 * pre-seed and then mount by id without duplicating), then renders the named
 * clip exactly as its lane would. */
function mountClip(
  clips: { trackIdx: number; clip: Clip }[],
  renderedId: string,
  selected = true
): HTMLElement {
  for (const { trackIdx, clip } of clips) {
    const s = useSessionStore.getState();
    const exists = s.session.tracks.some((t) => t.clips.some((c) => c.id === clip.id));
    if (!exists) s.addClip(s.session.tracks[trackIdx].id, clip);
  }

  const entry = clips.find((c) => c.clip.id === renderedId);
  if (!entry) throw new Error('rendered clip not seeded');
  const trackId = useSessionStore.getState().session.tracks[entry.trackIdx].id;

  const { container } = render(
    <ClipView
      clip={entry.clip}
      doc={doc}
      trackId={trackId}
      zoom={{ samplesPerPixel: SPP, scrollSample: 0 }}
      sessionRate={SESSION_RATE}
      laneHeight={LANE_H}
      selected={selected}
      resolveTrackAt={() => null}
      onDragOverTrack={() => {}}
    />
  );
  return container.querySelector('[data-testid="clip"]') as HTMLElement;
}

function clipById(clipId: string): Clip {
  for (const t of useSessionStore.getState().session.tracks) {
    const c = t.clips.find((x) => x.id === clipId);
    if (c) return c;
  }
  throw new Error(`clip ${clipId} not found`);
}

function byTestId(root: Element, id: string): HTMLElement | null {
  return root.querySelector(`[data-testid="${id}"]`);
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(SESSION_RATE);
  _resetSnapPreference();
  const channel = new Float32Array(400_000);
  doc = createDocument({ name: 'fade.wav', sampleRate: SESSION_RATE, channels: [channel] });
  useAppStore.getState().addDocument(doc);
  // Park the multitrack cursor far away so it never competes as a snap target.
  useSessionStore.getState().setMtCursor(9_000_000);
});

afterEach(() => {
  _resetSnapPreference();
});

describe('corner fade handles — rendering and geometry', () => {
  it('renders both handles on the SELECTED clip only', () => {
    const el = mountClip([{ trackIdx: 0, clip: clipOf('c', 0, 20_000) }], 'c', true);
    expect(byTestId(el, 'fade-handle-in')).not.toBeNull();
    expect(byTestId(el, 'fade-handle-out')).not.toBeNull();
  });

  it('renders no handles on an unselected clip', () => {
    const el = mountClip([{ trackIdx: 0, clip: clipOf('c', 0, 20_000) }], 'c', false);
    expect(byTestId(el, 'fade-handle-in')).toBeNull();
    expect(byTestId(el, 'fade-handle-out')).toBeNull();
  });

  it('sits exactly IN the top corners at fade 0 — clamped inside the clip rect, not hanging out (T33)', () => {
    // 20 000 samples at 100 spp = 200 px wide; the handle is 10 px.
    const el = mountClip([{ trackIdx: 0, clip: clipOf('c', 0, 20_000) }], 'c', true);
    expect(byTestId(el, 'fade-handle-in')!.style.left).toBe('0px');
    expect(byTestId(el, 'fade-handle-out')!.style.left).toBe('190px');
  });

  it('clamps at the FAR end too: a full-length fade parks the handle at the last inside position', () => {
    const el = mountClip([{ trackIdx: 0, clip: clipOf('c', 0, 20_000) }], 'c', true);
    act(() => {
      useSessionStore.getState().setClipFade('c', 'in', { lengthSample: 20_000 });
    });
    // Boundary fixture ON the clamp: ideal left = 200 - 5 = 195, clamped 190.
    expect(byTestId(el, 'fade-handle-in')!.style.left).toBe('190px');
  });
});

describe('corner fade handles — the drag gesture', () => {
  it('dragging the fade-in handle right sets the fade length through the store', () => {
    const el = mountClip([{ trackIdx: 0, clip: clipOf('c', 0, 20_000) }], 'c', true);
    const handle = byTestId(el, 'fade-handle-in')!;
    firePointer(handle, 'pointerdown', { clientX: 100 });
    firePointer(handle, 'pointermove', { clientX: 150 }); // +50 px = 5 000 samples
    firePointer(handle, 'pointerup', { clientX: 150 });
    expect(clipById('c').fadeInSample).toBe(5_000);
  });

  it('dragging the fade-out handle LEFT lengthens the fade-out', () => {
    const el = mountClip([{ trackIdx: 0, clip: clipOf('c', 0, 20_000) }], 'c', true);
    const handle = byTestId(el, 'fade-handle-out')!;
    firePointer(handle, 'pointerdown', { clientX: 190 });
    firePointer(handle, 'pointermove', { clientX: 140 }); // -50 px = 5 000 samples
    firePointer(handle, 'pointerup', { clientX: 140 });
    expect(clipById('c').fadeOutSample).toBe(5_000);
  });

  it('a 3 px jiggle is a click, 4 px exactly is a drag (the threshold boundary, both sides)', () => {
    const el = mountClip([{ trackIdx: 0, clip: clipOf('c', 0, 20_000) }], 'c', true);
    const handle = byTestId(el, 'fade-handle-in')!;
    firePointer(handle, 'pointerdown', { clientX: 100 });
    firePointer(handle, 'pointermove', { clientX: 103 }); // 3 px < threshold
    expect(clipById('c').fadeInSample).toBeUndefined();
    firePointer(handle, 'pointermove', { clientX: 104 }); // exactly 4 px — a drag
    expect(clipById('c').fadeInSample).toBe(400);
    firePointer(handle, 'pointerup', { clientX: 104 });
  });

  it('never moves or trims the clip, and never starts the root drag preview (T27/T28)', () => {
    const el = mountClip([{ trackIdx: 0, clip: clipOf('c', 1_000, 20_000) }], 'c', true);
    const handle = byTestId(el, 'fade-handle-in')!;
    firePointer(handle, 'pointerdown', { clientX: 100 });
    firePointer(handle, 'pointermove', { clientX: 150 });
    firePointer(handle, 'pointerup', { clientX: 150 });
    expect(clipById('c').startSample).toBe(1_000); // not moved
    expect(clipById('c').lengthSample).toBe(20_000); // not trimmed
    expect(el.style.transform).toBe(''); // no move preview ever engaged
  });

  it('trim from the clip BODY edge still works — the fade handles did not eat the root gesture', () => {
    const el = mountClip([{ trackIdx: 0, clip: clipOf('c', 0, 20_000) }], 'c', true);
    firePointer(el, 'pointerdown', { clientX: 2 }); // inside the 6 px trim band, on the ROOT
    firePointer(el, 'pointermove', { clientX: 52 }); // +50 px = 5 000 samples
    firePointer(el, 'pointerup', { clientX: 52 });
    expect(clipById('c').startSample).toBe(5_000);
    expect(clipById('c').lengthSample).toBe(15_000);
  });

  it('fades may MEET exactly (the clamp boundary), and one pixel past yields nothing more', () => {
    const el = mountClip([{ trackIdx: 0, clip: clipOf('c', 0, 20_000) }], 'c', true);
    act(() => {
      useSessionStore.getState().setClipFade('c', 'out', { lengthSample: 15_000 });
    });
    const handle = byTestId(el, 'fade-handle-in')!;
    firePointer(handle, 'pointerdown', { clientX: 100 });
    firePointer(handle, 'pointermove', { clientX: 150 }); // request 5 000: meets 15 000 exactly
    expect(clipById('c').fadeInSample).toBe(5_000);
    expect(clipById('c').fadeOutSample).toBe(15_000); // the standing fade never yields
    firePointer(handle, 'pointermove', { clientX: 151 }); // request 5 100 — over the meet
    expect(clipById('c').fadeInSample).toBe(5_000);
    firePointer(handle, 'pointerup', { clientX: 151 });
  });

  it('dragging back past zero clears the fade (0 normalises to "no fade")', () => {
    const el = mountClip([{ trackIdx: 0, clip: clipOf('c', 0, 20_000) }], 'c', true);
    act(() => {
      useSessionStore.getState().setClipFade('c', 'in', { lengthSample: 5_000 });
    });
    const handle = byTestId(el, 'fade-handle-in')!;
    firePointer(handle, 'pointerdown', { clientX: 100 });
    firePointer(handle, 'pointermove', { clientX: 20 }); // -80 px = -8 000 → below 0
    firePointer(handle, 'pointerup', { clientX: 20 });
    expect(clipById('c').fadeInSample).toBeUndefined();
  });
});

describe('fade ramps — SVG overlay, canvas count untouched (T29)', () => {
  it('draws the fade-in ramp from silence (bottom) to full level (top), with exactly one canvas', () => {
    const el = mountClip([{ trackIdx: 0, clip: clipOf('c', 0, 20_000) }], 'c', false);
    act(() => {
      useSessionStore.getState().setClipFade('c', 'in', { lengthSample: 5_000 });
    });
    expect(el.querySelectorAll('canvas')).toHaveLength(1); // no third canvas, ever
    const ramp = byTestId(el, 'fade-ramp-in')!;
    const stroke = ramp.querySelectorAll('path')[1].getAttribute('d')!;
    // Clip box is 88 px tall; the ramp spans [0, 50] px. Gain 0 at the start
    // (y = 88, the bottom), gain 1 at the fade end (y = 0, the top).
    expect(stroke.startsWith('M0 88 ')).toBe(true);
    expect(stroke.endsWith('L50 0')).toBe(true);
  });

  it('draws the fade-out ramp mirrored: full level at its start, silence at the clip end', () => {
    const el = mountClip([{ trackIdx: 0, clip: clipOf('c', 0, 20_000) }], 'c', false);
    act(() => {
      useSessionStore.getState().setClipFade('c', 'out', { lengthSample: 5_000 });
    });
    const ramp = byTestId(el, 'fade-ramp-out')!;
    const stroke = ramp.querySelectorAll('path')[1].getAttribute('d')!;
    expect(stroke.startsWith('M150 0 ')).toBe(true);
    expect(stroke.endsWith('L200 88')).toBe(true);
  });

  it('renders no overlay at all for a fade-less, overlap-less clip', () => {
    const el = mountClip([{ trackIdx: 0, clip: clipOf('c', 0, 20_000) }], 'c', false);
    expect(byTestId(el, 'fade-overlay')).toBeNull();
  });
});

describe('crossfade indicator — the renderer decides, the UI shows', () => {
  /** A [0,100 000) and B [80 000,180 000) on track 0: width 20 000. */
  function seedPair(): void {
    const s = useSessionStore.getState();
    s.addClip(s.session.tracks[0].id, clipOf('a', 0, 100_000));
    s.addClip(s.session.tracks[0].id, clipOf('b', 80_000, 100_000));
  }
  function arm(): void {
    act(() => {
      useSessionStore.getState().setClipFade('a', 'out', { lengthSample: 20_000 });
      useSessionStore.getState().setClipFade('b', 'in', { lengthSample: 20_000 });
    });
  }

  it('the incoming clip draws the rising crossfade line and the width readout', () => {
    seedPair();
    const el = mountClip([{ trackIdx: 0, clip: clipById('b') }], 'b', false);
    arm();
    const line = byTestId(el, 'crossfade-in-line')!;
    // The line spans exactly the overlap: silence at the clip start, unity at
    // the overlap end (200 px at 100 spp).
    const d = line.getAttribute('d')!;
    expect(d.startsWith('M0 88 ')).toBe(true);
    expect(d.endsWith('L200 0')).toBe(true);
    // Superseded: no solo ramp competes with the crossfade drawing.
    expect(byTestId(el, 'fade-ramp-in')).toBeNull();
    // The readout pill names the width (ruling 7).
    expect(byTestId(el, 'crossfade-readout')!.textContent).toBe(
      formatTime(20_000, SESSION_RATE)
    );
  });

  it('the outgoing clip draws its own falling line (the X is complete in any paint order, C7)', () => {
    seedPair();
    const el = mountClip([{ trackIdx: 0, clip: clipById('a') }], 'a', false);
    arm();
    const d = byTestId(el, 'crossfade-out-line')!.getAttribute('d')!;
    // Over A's last 200 px: unity before the overlap, silence at the clip end.
    expect(d.startsWith('M800 0 ')).toBe(true);
    expect(d.endsWith('L1000 88')).toBe(true);
    expect(byTestId(el, 'fade-ramp-out')).toBeNull();
    expect(byTestId(el, 'crossfade-readout')).toBeNull(); // the incoming side owns the pill
  });

  it('ONE SAMPLE off the exact width dissolves the indicator into an honest solo ramp (rule 3 boundary)', () => {
    seedPair();
    const el = mountClip([{ trackIdx: 0, clip: clipById('b') }], 'b', false);
    arm();
    act(() => {
      useSessionStore.getState().setClipFade('b', 'in', { lengthSample: 19_999 });
    });
    expect(byTestId(el, 'crossfade-in-line')).toBeNull();
    expect(byTestId(el, 'crossfade-readout')).toBeNull();
    expect(byTestId(el, 'fade-ramp-in')).not.toBeNull(); // what it sounds like now
  });

  it('an intruder in the overlap silences the indicator (rule 4), matching the audio', () => {
    seedPair();
    const el = mountClip([{ trackIdx: 0, clip: clipById('b') }], 'b', false);
    arm();
    act(() => {
      useSessionStore
        .getState()
        .addClip(useSessionStore.getState().session.tracks[0].id, clipOf('c', 85_000, 5_000));
    });
    expect(byTestId(el, 'crossfade-in-line')).toBeNull();
    expect(byTestId(el, 'fade-ramp-in')).not.toBeNull();
  });
});

describe('overlap region tint', () => {
  it('the LATER-starting member draws the tint over exactly the overlap span', () => {
    const s = useSessionStore.getState();
    s.addClip(s.session.tracks[0].id, clipOf('a', 0, 100_000));
    s.addClip(s.session.tracks[0].id, clipOf('b', 80_000, 100_000));
    const el = mountClip([{ trackIdx: 0, clip: clipById('b') }], 'b', false);
    const rect = byTestId(el, 'overlap-region')!;
    expect(rect.getAttribute('x')).toBe('0');
    expect(rect.getAttribute('width')).toBe('200'); // [80 000,100 000) at 100 spp
  });

  it('the earlier member draws none — one tint per pair, never derived from array order', () => {
    const s = useSessionStore.getState();
    s.addClip(s.session.tracks[0].id, clipOf('a', 0, 100_000));
    s.addClip(s.session.tracks[0].id, clipOf('b', 80_000, 100_000));
    const el = mountClip([{ trackIdx: 0, clip: clipById('a') }], 'a', false);
    expect(byTestId(el, 'overlap-region')).toBeNull();
  });

  it('abutting clips draw NO tint (the > 0 boundary)', () => {
    const s = useSessionStore.getState();
    s.addClip(s.session.tracks[0].id, clipOf('a', 0, 100_000));
    s.addClip(s.session.tracks[0].id, clipOf('b', 100_000, 100_000)); // exact abut
    const el = mountClip([{ trackIdx: 0, clip: clipById('b') }], 'b', false);
    expect(byTestId(el, 'overlap-region')).toBeNull();
  });

  it('equal starts tie-break by id, so exactly one member draws', () => {
    const s = useSessionStore.getState();
    s.addClip(s.session.tracks[0].id, clipOf('aa', 0, 100_000));
    s.addClip(s.session.tracks[0].id, clipOf('zz', 0, 50_000));
    const elZ = mountClip([{ trackIdx: 0, clip: clipById('zz') }], 'zz', false);
    expect(byTestId(elZ, 'overlap-region')).not.toBeNull();
    const elA = mountClip([{ trackIdx: 0, clip: clipById('aa') }], 'aa', false);
    expect(byTestId(elA, 'overlap-region')).toBeNull();
  });
});

describe('overlap drop hint — X5’s Ctrl affordance, surfaced', () => {
  const seed = () => [
    { trackIdx: 0, clip: clipOf('dragged', 0, 20_000) },
    { trackIdx: 0, clip: clipOf('other', 100_000, 100_000) },
  ];

  it('appears while the previewed span overlaps a same-track neighbour, and names Ctrl', () => {
    const el = mountClip(seed(), 'dragged', false);
    const grab = 100;
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: grab + 1100 }); // preview [110 000,130 000) inside other
    const hint = byTestId(el, 'overlap-drag-hint')!;
    expect(hint.textContent).toContain('Ctrl');
    expect(hint.textContent).toContain('crossfade');
    firePointer(el, 'pointerup', { clientX: grab + 1100 });
  });

  it('an exactly-abutting preview shows NO hint; one sample of overlap shows it (the > 0 boundary)', () => {
    const el = mountClip(seed(), 'dragged', false);
    const grab = 100;
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: grab + 800 }); // preview end = 100 000, exact abut
    expect(byTestId(el, 'overlap-drag-hint')).toBeNull();
    // W2 — a 1-sample overlap now needs Alt: the neighbour's start is an edge
    // target, so an unsuspended drag this close is snapped back to the exact
    // butt join (that pull-back IS the feature — micro-overlaps became opt-in).
    // The > 0 hint boundary this test protects is unchanged; Alt is simply how
    // a deliberate micro-overlap is made now.
    firePointer(el, 'pointermove', { clientX: grab + 800.01, altKey: true }); // start 80 001 → 1-sample overlap
    expect(byTestId(el, 'overlap-drag-hint')).not.toBeNull();
    firePointer(el, 'pointerup', { clientX: grab + 800.01, altKey: true });
  });

  it('flips to "pushes clear" while Ctrl is held — from the pointer or from the keyboard alone', () => {
    const el = mountClip(seed(), 'dragged', false);
    const grab = 100;
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: grab + 1100 });
    expect(byTestId(el, 'overlap-drag-hint')!.textContent).toContain('crossfade');

    // Pointer still, Ctrl pressed: the hint must not wait for the next move.
    fireCtrlKey('keydown', true);
    expect(byTestId(el, 'overlap-drag-hint')!.textContent).toContain('pushes clear');
    fireCtrlKey('keyup', false);
    expect(byTestId(el, 'overlap-drag-hint')!.textContent).toContain('crossfade');

    // And the per-move read tracks the modifier too.
    firePointer(el, 'pointermove', { clientX: grab + 1101, ctrlKey: true });
    expect(byTestId(el, 'overlap-drag-hint')!.textContent).toContain('pushes clear');
    firePointer(el, 'pointerup', { clientX: grab + 1101, ctrlKey: true });
  });

  it('disappears on the drop', () => {
    const el = mountClip(seed(), 'dragged', false);
    const grab = 100;
    firePointer(el, 'pointerdown', { clientX: grab });
    firePointer(el, 'pointermove', { clientX: grab + 1100 });
    expect(byTestId(el, 'overlap-drag-hint')).not.toBeNull();
    firePointer(el, 'pointerup', { clientX: grab + 1100 });
    expect(byTestId(el, 'overlap-drag-hint')).toBeNull();
  });

  it('a lone clip nudged within its own width shows NO hint — self-overlap is not an overlap', () => {
    // Any drag shorter than the clip's own width leaves the previewed span
    // overlapping the clip's own pre-drop position (the store still holds it
    // there until the drop). Without the identity exclusion in
    // overlapUnderPreview, this would flash a false "Drop crossfades" pill on
    // every small nudge of a clip with no neighbours at all.
    const el = mountClip([{ trackIdx: 0, clip: clipOf('solo', 0, 20_000) }], 'solo', false);
    firePointer(el, 'pointerdown', { clientX: 100 });
    firePointer(el, 'pointermove', { clientX: 150 }); // +50 px: preview [5 000, 25 000) over its own [0, 20 000)
    expect(byTestId(el, 'overlap-drag-hint')).toBeNull();
    firePointer(el, 'pointermove', { clientX: 250 }); // +150 px: still inside its own width
    expect(byTestId(el, 'overlap-drag-hint')).toBeNull();
    firePointer(el, 'pointerup', { clientX: 250 });
  });

  it('a plain click on an already-overlapped clip shows no hint (moveDx gate)', () => {
    const s = useSessionStore.getState();
    s.addClip(s.session.tracks[0].id, clipOf('under', 0, 20_000));
    s.addClip(s.session.tracks[0].id, clipOf('over', 10_000, 20_000));
    const el = mountClip([{ trackIdx: 0, clip: clipById('over') }], 'over', false);
    firePointer(el, 'pointerdown', { clientX: 150 });
    expect(byTestId(el, 'overlap-drag-hint')).toBeNull();
    firePointer(el, 'pointerup', { clientX: 150 });
  });
});
