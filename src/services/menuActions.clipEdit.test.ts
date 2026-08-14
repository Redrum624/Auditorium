import { getMenuSections, isCommandEnabled, runCommand } from './menuActions';
import type { MenuCommand, MenuSection } from './menuActions';
import { SHORTCUT_TABLE } from './shortcuts';
import { makeInitialState, useAppStore } from '../stores/appStore';
import { createClip, createTrack, type Session } from '../multitrack/session';
import { useSessionStore } from '../multitrack/sessionStore';
import { _resetSessionUndo, undoSession } from '../multitrack/sessionUndo';

/**
 * K1 — the commands the keyboard and the Edit menu reach the new clip verbs
 * through. Every one of them is view-routed: these are MULTITRACK bindings,
 * and the waveform/spectral surface must not feel them at all.
 */

const mt = () => useSessionStore.getState();

/** Two clips on track 1 ([0,1000) and [4000,5000)), one on track 2. */
function seed(): { a: string; b: string; c: string } {
  const t1 = createTrack('Track 1');
  const t2 = createTrack('Track 2');
  t1.clips = [
    createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 1000 }),
    createClip({ documentId: 'doc-1', startSample: 4000, offsetSample: 0, lengthSample: 1000 }),
  ];
  t2.clips = [
    createClip({ documentId: 'doc-2', startSample: 2000, offsetSample: 0, lengthSample: 500 }),
  ];
  const session: Session = { name: 'Command Fixture', sampleRate: 44100, tracks: [t1, t2] };
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

let fx: ReturnType<typeof seed>;

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetSessionUndo();
  fx = seed();
});

function editRow(id: string): MenuCommand {
  const items: MenuSection['items'] = getMenuSections().find((s) => s.title === 'Edit')!.items;
  const row = items.find((i): i is MenuCommand => i !== 'separator' && i.id === id);
  expect(row).toBeDefined();
  return row!;
}

function editIds(): string[] {
  return getMenuSections()
    .find((s) => s.title === 'Edit')!
    .items.filter((i): i is MenuCommand => i !== 'separator')
    .map((i) => i.id);
}

describe('clip-edge navigation (Ctrl+Left / Ctrl+Right)', () => {
  beforeEach(() => {
    useAppStore.setState({ view: 'multitrack' });
  });

  // The boundary set for the fixture: 0, 1000, 2000, 2500, 4000, 5000.
  it('from inside a clip, goes to that clip’s start and to its end', async () => {
    useSessionStore.setState({ mtCursorSample: 4500 });
    await runCommand('multitrack.prevClipEdge');
    expect(mt().mtCursorSample).toBe(4000);

    useSessionStore.setState({ mtCursorSample: 4500 });
    await runCommand('multitrack.nextClipEdge');
    expect(mt().mtCursorSample).toBe(5000);
  });

  it('walks the union of every track’s edges, not just one lane’s', async () => {
    useSessionStore.setState({ mtCursorSample: 1000 });
    await runCommand('multitrack.nextClipEdge');
    expect(mt().mtCursorSample).toBe(2000); // the clip on track 2
    await runCommand('multitrack.nextClipEdge');
    expect(mt().mtCursorSample).toBe(2500);
  });

  it('standing on an edge moves to the next one — the key is never dead', async () => {
    useSessionStore.setState({ mtCursorSample: 2000 });
    await runCommand('multitrack.prevClipEdge');
    expect(mt().mtCursorSample).toBe(1000);
  });

  it('leaves the cursor alone past the last edge and before the first', async () => {
    useSessionStore.setState({ mtCursorSample: 9000 });
    await runCommand('multitrack.nextClipEdge');
    expect(mt().mtCursorSample).toBe(9000);

    useSessionStore.setState({ mtCursorSample: 0 });
    await runCommand('multitrack.prevClipEdge');
    expect(mt().mtCursorSample).toBe(0);
  });

  it('moves the cursor while playing WITHOUT touching the transport', async () => {
    useSessionStore.setState({
      mtCursorSample: 4500,
      mtPlayState: 'playing',
      mtPlayheadSample: 3210,
    });
    await runCommand('multitrack.prevClipEdge');
    expect(mt().mtCursorSample).toBe(4000);
    expect(mt().mtPlayState).toBe('playing');
    expect(mt().mtPlayheadSample).toBe(3210); // the running playhead is not the cursor
  });

  it('records no undo entry — the cursor is view state', async () => {
    const before = mt().session;
    useSessionStore.setState({ mtCursorSample: 4500 });
    await runCommand('multitrack.nextClipEdge');
    expect(mt().session).toBe(before);
  });

  it('is enabled only in the multitrack view, and only with a clip to navigate', () => {
    expect(isCommandEnabled('multitrack.prevClipEdge')).toBe(true);
    expect(isCommandEnabled('multitrack.nextClipEdge')).toBe(true);

    useAppStore.setState({ view: 'waveform' });
    expect(isCommandEnabled('multitrack.prevClipEdge')).toBe(false);
    expect(isCommandEnabled('multitrack.nextClipEdge')).toBe(false);

    useAppStore.setState({ view: 'multitrack' });
    mt().newSession(44100); // no clips => no edges
    expect(isCommandEnabled('multitrack.prevClipEdge')).toBe(false);
    expect(isCommandEnabled('multitrack.nextClipEdge')).toBe(false);
  });

  it('is bound to Ctrl+Left / Ctrl+Right, and the menu rows say so', () => {
    expect(SHORTCUT_TABLE).toContainEqual({
      combo: 'ctrl+arrowleft',
      commandId: 'multitrack.prevClipEdge',
    });
    expect(SHORTCUT_TABLE).toContainEqual({
      combo: 'ctrl+arrowright',
      commandId: 'multitrack.nextClipEdge',
    });
    expect(editRow('multitrack.prevClipEdge').shortcut).toBe('Ctrl+Left');
    expect(editRow('multitrack.nextClipEdge').shortcut).toBe('Ctrl+Right');
  });
});

describe('Delete over a multi-selection', () => {
  beforeEach(() => {
    useAppStore.setState({ view: 'multitrack' });
  });

  it('removes every selected clip, in one undo entry', async () => {
    mt().setSelectedClip(fx.a);
    mt().toggleSelectedClip(fx.c);
    const pre = mt().session;

    await runCommand('edit.delete');
    expect(mt().session.tracks[0].clips.map((c) => c.id)).toEqual([fx.b]);
    expect(mt().session.tracks[1].clips).toEqual([]);

    undoSession();
    expect(mt().session).toBe(pre);
  });

  it('still removes exactly the one selected clip when only one is selected', async () => {
    mt().setSelectedClip(fx.b);
    await runCommand('edit.delete');
    expect(mt().session.tracks[0].clips.map((c) => c.id)).toEqual([fx.a]);
  });
});

describe('Ripple Delete', () => {
  beforeEach(() => {
    useAppStore.setState({ view: 'multitrack' });
  });

  it('removes the selection and closes the gap on each affected track', async () => {
    mt().setSelectedClip(fx.a);
    await runCommand('edit.rippleDelete');

    const t1 = mt().session.tracks[0];
    expect(t1.clips.map((c) => c.id)).toEqual([fx.b]);
    expect(t1.clips[0].startSample).toBe(3000); // 4000 - the removed 1000
    expect(mt().session.tracks[1].clips[0].startSample).toBe(2000); // other track: untouched
  });

  it('needs the multitrack view and a selected clip', () => {
    expect(isCommandEnabled('edit.rippleDelete')).toBe(false); // nothing selected
    mt().setSelectedClip(fx.a);
    expect(isCommandEnabled('edit.rippleDelete')).toBe(true);

    useAppStore.setState({ view: 'waveform' });
    expect(isCommandEnabled('edit.rippleDelete')).toBe(false);
  });

  it('is bound to Shift+Delete, a combo nothing else claims', () => {
    expect(SHORTCUT_TABLE).toContainEqual({
      combo: 'shift+delete',
      commandId: 'edit.rippleDelete',
    });
    expect(SHORTCUT_TABLE.filter((s) => s.combo === 'shift+delete')).toHaveLength(1);
    expect(editRow('edit.rippleDelete').shortcut).toBe('Shift+Del');
    expect(editRow('edit.rippleDelete').label).toBe('Ripple Delete');
  });

  it('sits with Delete in the Edit menu, and the edge-nav rows sit with the multitrack group', () => {
    const ids = editIds();
    expect(ids.indexOf('edit.rippleDelete')).toBe(ids.indexOf('edit.delete') + 1);
    expect(ids.indexOf('multitrack.prevClipEdge')).toBe(ids.indexOf('multitrack.addTrack') + 1);
    expect(ids.indexOf('multitrack.nextClipEdge')).toBe(ids.indexOf('multitrack.prevClipEdge') + 1);
  });
});

describe('Escape in the multitrack view', () => {
  it('clears the clip selection', async () => {
    useAppStore.setState({ view: 'multitrack' });
    mt().setSelectedClip(fx.a);
    mt().toggleSelectedClip(fx.b);
    expect(isCommandEnabled('edit.deselect')).toBe(true);

    await runCommand('edit.deselect');
    expect(mt().selectedClipId).toBeNull();
    expect(mt().selectedClipIds).toEqual([]);
    expect(isCommandEnabled('edit.deselect')).toBe(false);
  });

  it('still clears the DOCUMENT selection in the editor views (unchanged)', async () => {
    useAppStore.setState({ view: 'waveform', selection: { start: 10, end: 20 } });
    expect(isCommandEnabled('edit.deselect')).toBe(true);
    await runCommand('edit.deselect');
    expect(useAppStore.getState().selection).toBeNull();
  });

  it('does not reach across surfaces: a clip selection does not arm it in the editor', () => {
    useAppStore.setState({ view: 'waveform', selection: null });
    mt().setSelectedClip(fx.a);
    expect(isCommandEnabled('edit.deselect')).toBe(false);
  });
});
