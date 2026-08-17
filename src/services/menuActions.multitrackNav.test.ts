import { getMenuSections, isCommandEnabled, runCommand } from './menuActions';
import type { MenuCommand } from './menuActions';
import { SHORTCUT_TABLE } from './shortcuts';
import { makeInitialState, useAppStore } from '../stores/appStore';
import { createDocument } from '../audio/AudioDocument';
import { createClip, createTrack, type Session } from '../multitrack/session';
import { useSessionStore } from '../multitrack/sessionStore';
import { _resetSessionUndo } from '../multitrack/sessionUndo';
import {
  FALLBACK_SESSION_LANE_WIDTH,
  _resetSessionLaneWidth,
} from '../multitrack/sessionViewport';

/**
 * T5 — the three commands that existed but were inert in the multitrack view.
 *
 * `edit.selectAll`, `transport.goToStart` and `transport.goToEnd` were all
 * gated on an active DOCUMENT and wrote the editor's own state, so in the
 * multitrack view Ctrl+A / Home / End reached a disabled command and did
 * nothing (K1 noticed the pair while auditing the keymap and left them out of
 * scope). Each is view-routed here in the `edit.delete` / `edit.deselect`
 * shape: a multitrack arm beside the editor arm, and the editor arm untouched.
 */

const mt = () => useSessionStore.getState();

/** Two clips on track 1 ([0,1000) and [4000,5000)), one on track 2 that ends
 * LAST ([8000,10000)) — so "the end of the last clip" is a claim about the
 * session and not about one lane. */
function seed(): { a: string; b: string; c: string } {
  const t1 = createTrack('Track 1');
  const t2 = createTrack('Track 2');
  t1.clips = [
    createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 1000 }),
    createClip({ documentId: 'doc-1', startSample: 4000, offsetSample: 0, lengthSample: 1000 }),
  ];
  t2.clips = [
    createClip({ documentId: 'doc-2', startSample: 8000, offsetSample: 0, lengthSample: 2000 }),
  ];
  const session: Session = { name: 'Nav Fixture', sampleRate: 44100, tracks: [t1, t2] };
  useSessionStore.setState({
    session,
    selectedClipId: null,
    selectedClipIds: [],
    mtCursorSample: 0,
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
  });
  return { a: t1.clips[0].id, b: t1.clips[1].id, c: t2.clips[0].id };
}

/** A 5 000-sample document, made active — the editor arm of every routed
 * command below needs one to stay enabled. */
function seedDoc(): void {
  const doc = createDocument({
    name: 'Doc',
    sampleRate: 44100,
    channels: [new Float32Array(5000)],
  });
  useAppStore.getState().addDocument(doc);
}

let fx: ReturnType<typeof seed>;

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetSessionUndo();
  // The lane width is module state published by the live scroller; unmeasured
  // it is the fallback, which is what the scroll arithmetic below is stated in.
  _resetSessionLaneWidth();
  fx = seed();
});

describe('Ctrl+A in the multitrack view selects every clip', () => {
  beforeEach(() => {
    useAppStore.setState({ view: 'multitrack' });
  });

  it('takes every clip on every track', async () => {
    await runCommand('edit.selectAll');
    expect([...mt().selectedClipIds].sort()).toEqual([fx.a, fx.b, fx.c].sort());
  });

  it('keeps the standing primary, so the Properties panel does not jump', async () => {
    mt().setSelectedClip(fx.b);
    await runCommand('edit.selectAll');
    expect(mt().selectedClipId).toBe(fx.b);
    expect(mt().selectedClipIds).toHaveLength(3);
  });

  it('does not touch the document region behind the view', async () => {
    seedDoc();
    useAppStore.setState({ view: 'multitrack', selection: null });
    await runCommand('edit.selectAll');
    expect(useAppStore.getState().selection).toBeNull();
  });

  it('is enabled with clips and disabled without them', () => {
    expect(isCommandEnabled('edit.selectAll')).toBe(true);
    mt().newSession(44100);
    expect(isCommandEnabled('edit.selectAll')).toBe(false);
  });

  it('records no undo entry — a selection is view state', async () => {
    const before = mt().session;
    await runCommand('edit.selectAll');
    expect(mt().session).toBe(before);
  });

  it('still selects the whole DOCUMENT in the editor views (unchanged)', async () => {
    seedDoc();
    useAppStore.setState({ view: 'waveform' });
    expect(isCommandEnabled('edit.selectAll')).toBe(true);
    await runCommand('edit.selectAll');
    expect(useAppStore.getState().selection).toEqual({ start: 0, end: 5000 });
    expect(mt().selectedClipIds).toEqual([]); // the clip selection is not touched
  });

  it('is disabled in the editor views with no document (unchanged)', () => {
    useAppStore.setState({ view: 'waveform' });
    expect(isCommandEnabled('edit.selectAll')).toBe(false);
  });
});

describe('Home / End in the multitrack view move the session cursor', () => {
  beforeEach(() => {
    useAppStore.setState({ view: 'multitrack' });
  });

  it('Home puts the cursor at the session start', async () => {
    useSessionStore.setState({ mtCursorSample: 4500 });
    await runCommand('transport.goToStart');
    expect(mt().mtCursorSample).toBe(0);
  });

  it('Home scrolls the timeline back to the start too', async () => {
    useSessionStore.setState({ mtCursorSample: 4500, mtZoom: { samplesPerPixel: 4, scrollSample: 3000 } });
    await runCommand('transport.goToStart');
    expect(mt().mtZoom.scrollSample).toBe(0);
    expect(mt().mtZoom.samplesPerPixel).toBe(4); // the zoom LEVEL is not changed
  });

  it('End puts the cursor at the end of the LAST clip, across tracks', async () => {
    await runCommand('transport.goToEnd');
    expect(mt().mtCursorSample).toBe(10000); // track 2's clip ends last
  });

  // "Go to End" that leaves the destination off screen is the defect the
  // editor's own End key was fixed for (F11 fix round I2). The session's
  // scrollable extent runs a MT_TIMELINE_TAIL_SEC minute past the last clip, so
  // asking for `scrollSample: end` here would NOT clamp the way it does in the
  // editor — it would park the session end at the LEFT edge with a minute of
  // emptiness beside it. The request is therefore "the end at the RIGHT edge",
  // and the one clamp in `resolveSessionZoom` still floors it at 0.
  it('End scrolls the session end to the right edge of the lane', async () => {
    useSessionStore.setState({ mtZoom: { samplesPerPixel: 4, scrollSample: 0 } });
    await runCommand('transport.goToEnd');
    expect(mt().mtZoom.samplesPerPixel).toBe(4); // the zoom LEVEL is not changed
    expect(mt().mtZoom.scrollSample).toBe(10000 - FALLBACK_SESSION_LANE_WIDTH * 4);
  });

  it('End at the fit zoom, where the whole session is already on screen, scrolls to 0', async () => {
    // The fit lays the whole session across the lane, so "the end at the right
    // edge" resolves to a scroll of exactly 0 — and any zoom further out is
    // clamped BACK to the fit, so this is the floor arm rather than a middle
    // case: `end − laneWidth × spp` can never be positive here and
    // `resolveSessionZoom`'s own `[0, maxScroll]` clamp is what catches it.
    useSessionStore.setState({
      mtZoom: { samplesPerPixel: 10000 / FALLBACK_SESSION_LANE_WIDTH, scrollSample: 5000 },
    });
    await runCommand('transport.goToEnd');
    expect(mt().mtZoom.scrollSample).toBe(0);
  });

  it('Home is enabled with no clips; End is not', () => {
    mt().newSession(44100);
    expect(isCommandEnabled('transport.goToStart')).toBe(true);
    expect(isCommandEnabled('transport.goToEnd')).toBe(false);
  });

  it('neither records an undo entry — the cursor is view state', async () => {
    const before = mt().session;
    await runCommand('transport.goToEnd');
    await runCommand('transport.goToStart');
    expect(mt().session).toBe(before);
  });

  it('neither touches the document cursor behind the view', async () => {
    seedDoc();
    useAppStore.setState({ view: 'multitrack' });
    useAppStore.setState({ cursorSample: 1234 });
    await runCommand('transport.goToEnd');
    expect(useAppStore.getState().cursorSample).toBe(1234);
  });

  it('still moves the DOCUMENT cursor in the editor views (unchanged)', async () => {
    seedDoc();
    useAppStore.setState({ view: 'waveform', cursorSample: 100 });
    await runCommand('transport.goToEnd');
    expect(useAppStore.getState().cursorSample).toBe(5000);
    await runCommand('transport.goToStart');
    expect(useAppStore.getState().cursorSample).toBe(0);
    expect(mt().mtCursorSample).toBe(0); // untouched throughout
  });
});

/**
 * T5 item 6, in the shape the code forced. The brief asked for ripple delete of
 * a TIME RANGE across every track; the multitrack view has no time selection to
 * name one with. The store's state is `{session, selectedClipId,
 * selectedClipIds, mtCursorSample, mtZoom, mtPlayState, mtPlayheadSample,
 * mtEnvelope}` — a cursor, no range — the shared `TimelineRuler` seeks rather
 * than drag-selects, `.audm` persists no range, and `appStore.selection` is the
 * DOCUMENT's region, which `edit.deselect` already documents as not being on
 * screen in this view. `sessionStore.ts`'s rate-adoption invariant says the
 * same thing in code: "there is no multitrack selection or loop range to carry
 * (only the cursor exists)".
 *
 * So the brief's own fallback applies: the row exists, greyed, and the reason
 * lives in the comment beside it and in the USER_GUIDE. What it must NOT do is
 * pretend — hence the arms below.
 */
function editRow(id: string): MenuCommand {
  const items = getMenuSections().find((s) => s.title === 'Edit')!.items;
  const row = items.find((i): i is MenuCommand => i !== 'separator' && i.id === id);
  expect(row).toBeDefined();
  return row!;
}

describe('Ripple Delete Time Selection — listed, and honestly unavailable', () => {
  it('sits directly under Ripple Delete in the Edit menu', () => {
    const ids = getMenuSections()
      .find((s) => s.title === 'Edit')!
      .items.filter((i): i is MenuCommand => i !== 'separator')
      .map((i) => i.id);
    expect(ids.indexOf('edit.rippleDeleteTime')).toBe(ids.indexOf('edit.rippleDelete') + 1);
    expect(editRow('edit.rippleDeleteTime').label).toBe('Ripple Delete Time Selection');
  });

  it('is disabled in EVERY view and under every selection there is', () => {
    seedDoc();
    for (const view of ['multitrack', 'waveform', 'spectral'] as const) {
      useAppStore.setState({ view, selection: { start: 0, end: 5000 } });
      expect(isCommandEnabled('edit.rippleDeleteTime')).toBe(false);
    }
    useAppStore.setState({ view: 'multitrack' });
    mt().setSelectedClips([fx.a, fx.b]); // a CLIP selection is not a time one
    expect(isCommandEnabled('edit.rippleDeleteTime')).toBe(false);
  });

  it('carries no accelerator, because a key on it would only be swallowed', () => {
    // `installShortcuts` claims a matched combo before consulting `enabled`, so
    // binding this row would take a key away from the platform in every view
    // and give nothing back.
    expect(editRow('edit.rippleDeleteTime').shortcut).toBeUndefined();
    expect(SHORTCUT_TABLE.filter((s) => s.commandId === 'edit.rippleDeleteTime')).toEqual([]);
  });

  it('changes nothing if it is run anyway', async () => {
    useAppStore.setState({ view: 'multitrack' });
    const before = mt().session;
    await runCommand('edit.rippleDeleteTime');
    expect(mt().session).toBe(before);
  });
});
