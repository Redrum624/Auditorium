import { act, render } from '@testing-library/react';
import ClipView from './ClipView';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import type { Clip } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import {
  SESSION_UNDO_KEY,
  _resetSessionUndo,
  redoSession,
  undoSession,
} from '../../multitrack/sessionUndo';
import { getHistory } from '../../services/undoHistory';
import * as beatGridService from '../../services/beatGrid';
import type { BeatGrid } from '../../services/beatGrid';
import { _resetSnapPreference, setSnapEnabled } from '../../services/snapPreference';
import { makeInitialState, useAppStore } from '../../stores/appStore';

/**
 * R3 — ruling 2 driven through ClipView's REAL pointer handlers: the
 * multi-write drags (trim, fade — both commit live per pointermove) produce
 * EXACTLY ONE undo entry each, pinned by entry count, and a click that never
 * drags produces none. The move drag was already single-commit
 * (preview-on-move); its one entry is pinned too.
 */

const SPP = 100;
const SESSION_RATE = 44_100;

function firePointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { clientX: number; clientY?: number; button?: number }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY ?? 0,
    button: init.button ?? 0,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

function makeGrid(): BeatGrid {
  return {
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
  return { id, documentId: doc.id, startSample, offsetSample: 5000, lengthSample, gainDb: 0 };
}

/** Seeds the clip, mounts it selected (fade handles need selection), resets
 * the session history (seeding recorded entries), and returns the element. */
function mountClip(clip: Clip): HTMLElement {
  const s = useSessionStore.getState();
  s.addClip(s.session.tracks[0].id, clip);
  const trackId = useSessionStore.getState().session.tracks[0].id;
  const { container } = render(
    <ClipView
      clip={clip}
      doc={doc}
      trackId={trackId}
      zoom={{ samplesPerPixel: SPP, scrollSample: 0 }}
      sessionRate={SESSION_RATE}
      laneHeight={96}
      selected={true}
      resolveTrackAt={() => null}
      onDragOverTrack={() => {}}
    />
  );
  _resetSessionUndo(); // the setup above must not count as user history
  return container.querySelector('[data-testid="clip"]') as HTMLElement;
}

const sessionRef = () => useSessionStore.getState().session;
const doneLabels = () => getHistory(SESSION_UNDO_KEY).done;

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(SESSION_RATE);
  _resetSnapPreference();
  setSnapEnabled(false); // deterministic drag arithmetic; the magnet is not under test
  doc = createDocument({ name: 'beat.wav', sampleRate: SESSION_RATE, channels: [new Float32Array(400_000)] });
  useAppStore.getState().addDocument(doc);
  gridSpy = jest.spyOn(beatGridService, 'getBeatGrid').mockReturnValue(makeGrid());
});

afterEach(() => {
  gridSpy.mockRestore();
  _resetSnapPreference();
});

describe('trim drag (live per-move commits)', () => {
  it('a 5-move trim-end drag is EXACTLY ONE "Trim clip" entry; undo restores the pointerdown state', () => {
    // Clip 20 000 samples = 200 px; x >= 194 is the trim-end handle.
    const el = mountClip(clipOf('c-trim', 0, 20_000));
    const pre = sessionRef();

    firePointer(el, 'pointerdown', { clientX: 198 });
    for (const dx of [10, 20, 30, 40, 50]) firePointer(el, 'pointermove', { clientX: 198 + dx });
    // The store really was written live during the drag (5 000 samples = 50 px).
    expect(sessionRef()).not.toBe(pre);
    firePointer(el, 'pointerup', { clientX: 248 });

    expect(doneLabels()).toEqual(['Trim clip']);
    const post = sessionRef();
    act(() => undoSession());
    expect(sessionRef()).toBe(pre);
    act(() => redoSession());
    expect(sessionRef()).toBe(post);
  });

  it('a trim-start drag is one "Trim clip" entry too', () => {
    const el = mountClip(clipOf('c-trim-start', 10_000, 20_000));
    const pre = sessionRef();
    // Element-local x < 6 is trim-start; jsdom rects are zero-origin.
    firePointer(el, 'pointerdown', { clientX: 2 });
    for (const dx of [10, 20, 30]) firePointer(el, 'pointermove', { clientX: 2 + dx });
    firePointer(el, 'pointerup', { clientX: 32 });

    expect(doneLabels()).toEqual(['Trim clip']);
    act(() => undoSession());
    expect(sessionRef()).toBe(pre);
  });

  it('a trim-zone CLICK (no movement past the threshold) records nothing', () => {
    const el = mountClip(clipOf('c-click', 0, 20_000));
    const pre = sessionRef();
    firePointer(el, 'pointerdown', { clientX: 198 });
    firePointer(el, 'pointermove', { clientX: 199 }); // under DRAG_THRESHOLD = 4
    firePointer(el, 'pointerup', { clientX: 199 });
    expect(sessionRef()).toBe(pre);
    expect(doneLabels()).toEqual([]);
  });
});

describe('fade-handle drag (live per-move commits)', () => {
  it('a 4-move fade-in drag is EXACTLY ONE "Set fade" entry; undo clears it back', () => {
    const el = mountClip(clipOf('c-fade', 0, 20_000));
    const pre = sessionRef();
    const handle = el.querySelector('[data-testid="fade-handle-in"]') as HTMLElement;
    expect(handle).not.toBeNull();

    firePointer(handle, 'pointerdown', { clientX: 100 });
    for (const dx of [10, 20, 30, 40]) firePointer(handle, 'pointermove', { clientX: 100 + dx });
    expect(sessionRef()).not.toBe(pre); // live commits happened
    firePointer(handle, 'pointerup', { clientX: 140 });

    expect(doneLabels()).toEqual(['Set fade']);
    const post = sessionRef();
    act(() => undoSession());
    expect(sessionRef()).toBe(pre);
    act(() => redoSession());
    expect(sessionRef()).toBe(post);
  });

  it('a fade-handle CLICK records nothing', () => {
    const el = mountClip(clipOf('c-fade-click', 0, 20_000));
    const pre = sessionRef();
    const handle = el.querySelector('[data-testid="fade-handle-out"]') as HTMLElement;
    firePointer(handle, 'pointerdown', { clientX: 190 });
    firePointer(handle, 'pointerup', { clientX: 190 });
    expect(sessionRef()).toBe(pre);
    expect(doneLabels()).toEqual([]);
  });
});

describe('move drag (already single-commit)', () => {
  it('a move drag is one "Move clip" entry from its single pointerup commit', () => {
    const el = mountClip(clipOf('c-move', 0, 20_000));
    const pre = sessionRef();

    firePointer(el, 'pointerdown', { clientX: 100 }); // mid-clip = move mode
    firePointer(el, 'pointermove', { clientX: 150 });
    firePointer(el, 'pointermove', { clientX: 200 });
    expect(sessionRef()).toBe(pre); // preview is CSS-only; no store writes yet
    firePointer(el, 'pointerup', { clientX: 200 });

    expect(doneLabels()).toEqual(['Move clip']);
    act(() => undoSession());
    expect(sessionRef()).toBe(pre);
  });
});
