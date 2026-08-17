import { act, render } from '@testing-library/react';
import ClipView from './ClipView';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import type { Clip } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { _resetSessionUndo } from '../../multitrack/sessionUndo';
import { _resetSnapPreference, setSnapEnabled } from '../../services/snapPreference';
import { makeInitialState, useAppStore } from '../../stores/appStore';

/**
 * T5 — Shift+Click range select, driven through ClipView's REAL pointer
 * handlers (the level K1's own modifier tests live at).
 *
 * THE MODIFIER PRECEDENCE this file exists to hold. K1 ruled that Ctrl at
 * pointerdown means "toggle at pointerup", and that ruling is untouched: with
 * BOTH modifiers held, Ctrl still wins and the click is a toggle. Shift is the
 * range only when Ctrl is not down. "Composes with Ctrl+Click" is satisfied
 * anyway, and by the store rather than by the modifier: `extendSelectionToClip`
 * UNIONS the range into the standing set, so a selection built by Ctrl+Click
 * survives a Shift+Click that extends it.
 *
 * The other half is the deferral, the same one K1 wrote for Ctrl: a Shift press
 * must commit nothing at pointerDOWN, or the primary the range is measured from
 * would be replaced by the clicked clip a frame before the range was drawn.
 */

const SPP = 100; // 1 CSS px == 100 samples
const GRAB_X = 100; // clip-local x of a body grab (clips are 200 px wide)
const SESSION_RATE = 44_100;

function firePointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { clientX: number; clientY?: number; ctrlKey?: boolean; shiftKey?: boolean }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY ?? 0,
    button: 0,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

/** A press and release the pointer never carried anywhere: a click. */
function click(el: Element, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}): void {
  firePointer(el, 'pointerdown', { clientX: GRAB_X, ...mods });
  firePointer(el, 'pointerup', { clientX: GRAB_X, ...mods });
}

let doc: AudioDocument;

const store = () => useSessionStore.getState();

function select(fn: () => void): void {
  act(fn);
}

function clipOf(id: string, startSample: number): Clip {
  return { id, documentId: doc.id, startSample, offsetSample: 0, lengthSample: 20_000, gainDb: 0 };
}

/**
 * Track 0 carries a, b, c (starts 0, 40 000, 80 000) added OUT of start order
 * so the range is proved to walk start order; track 1 carries d. Renders the
 * named clip and returns its element.
 */
function mountAll(renderId: string): HTMLElement {
  const s = store();
  const t0 = s.session.tracks[0].id;
  s.addClip(t0, clipOf('c', 80_000));
  s.addClip(t0, clipOf('a', 0));
  s.addClip(t0, clipOf('b', 40_000));
  useSessionStore.getState().addTrack();
  const t1 = useSessionStore.getState().session.tracks[1].id;
  useSessionStore.getState().addClip(t1, clipOf('d', 40_000));

  const onTrack1 = renderId === 'd';
  const trackId = onTrack1 ? t1 : t0;
  const clip = clipOf(renderId, renderId === 'a' ? 0 : renderId === 'c' ? 80_000 : 40_000);
  const { container } = render(
    <ClipView
      clip={clip}
      doc={doc}
      trackId={trackId}
      zoom={{ samplesPerPixel: SPP, scrollSample: 0 }}
      sessionRate={SESSION_RATE}
      laneHeight={96}
      selected={useSessionStore.getState().selectedClipId === renderId}
      resolveTrackAt={() => trackId}
      onDragOverTrack={() => {}}
    />
  );
  _resetSessionUndo();
  return container.querySelector('[data-testid="clip"]') as HTMLElement;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(SESSION_RATE);
  _resetSnapPreference();
  setSnapEnabled(false); // deterministic drag arithmetic; the magnet is not under test
  doc = createDocument({
    name: 'src.wav',
    sampleRate: SESSION_RATE,
    channels: [new Float32Array(400_000)],
  });
  useAppStore.getState().addDocument(doc);
});

afterEach(() => {
  _resetSnapPreference();
});

describe('Shift+Click extends the selection to the clicked clip', () => {
  it('takes every clip between the primary and this one, on this track', () => {
    const el = mountAll('c');
    select(() => store().setSelectedClip('a'));
    click(el, { shiftKey: true });
    expect([...store().selectedClipIds].sort()).toEqual(['a', 'b', 'c']);
    expect(store().selectedClipId).toBe('c');
  });

  it('a Ctrl+Click set SURVIVES the range that extends it', () => {
    const el = mountAll('b');
    select(() => {
      store().toggleSelectedClip('d'); // a foreign-track member
      store().toggleSelectedClip('a'); // the primary the range measures from
    });
    click(el, { shiftKey: true });
    expect([...store().selectedClipIds].sort()).toEqual(['a', 'b', 'd']);
  });

  it('a CROSS-TRACK Shift+Click is a plain click', () => {
    const el = mountAll('d');
    select(() => store().setSelectedClip('a'));
    click(el, { shiftKey: true });
    expect(store().selectedClipIds).toEqual(['d']);
  });

  it('commits NOTHING at pointerdown — the primary survives to be measured from', () => {
    const el = mountAll('c');
    select(() => store().setSelectedClip('a'));
    firePointer(el, 'pointerdown', { clientX: GRAB_X, shiftKey: true });
    expect(store().selectedClipIds).toEqual(['a']); // still just the anchor
    firePointer(el, 'pointerup', { clientX: GRAB_X, shiftKey: true });
    expect([...store().selectedClipIds].sort()).toEqual(['a', 'b', 'c']);
  });

  it('a Shift press that becomes a DRAG was never a selection act', () => {
    const el = mountAll('c');
    select(() => store().setSelectedClip('a'));
    firePointer(el, 'pointerdown', { clientX: GRAB_X, shiftKey: true });
    firePointer(el, 'pointermove', { clientX: GRAB_X + 50, shiftKey: true });
    firePointer(el, 'pointerup', { clientX: GRAB_X + 50, shiftKey: true });
    // The drag moved the clip it grabbed, alone, and the range was never drawn.
    expect(store().selectedClipIds).toEqual(['c']);
    const c = store().session.tracks[0].clips.find((x) => x.id === 'c');
    expect(c?.startSample).toBe(80_000 + 50 * SPP);
    const a = store().session.tracks[0].clips.find((x) => x.id === 'a');
    expect(a?.startSample).toBe(0); // the anchor did not travel with it
  });

  it('CTRL WINS when both modifiers are held — the click is K1’s toggle', () => {
    const el = mountAll('c');
    select(() => store().setSelectedClip('a'));
    click(el, { ctrlKey: true, shiftKey: true });
    expect([...store().selectedClipIds].sort()).toEqual(['a', 'c']); // b was NOT taken
  });

  it('a plain click still collapses the selection to one clip (unchanged)', () => {
    const el = mountAll('c');
    select(() => store().setSelectedClip('a'));
    click(el);
    expect(store().selectedClipIds).toEqual(['c']);
  });
});
