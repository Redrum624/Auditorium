/**
 * D3 — DELETE CLOSES THE SELECTED GAP. The user's ask was "silences should be
 * deletable, like a localized ripple delete", so the two delete verbs are the
 * ones that grew: with a gap selected, Delete and Ripple Delete both close it,
 * and they agree exactly — closing a gap IS the ripple's second half, so there
 * is nothing for the two to disagree about, and making them differ would have
 * meant inventing a second meaning for a span that is already empty.
 *
 * Everything here is MULTITRACK routing. The waveform/spectral arms of these
 * commands are untouched, and pinned untouched.
 */
import { isCommandEnabled, runCommand } from './menuActions';
import { makeInitialState, useAppStore } from '../stores/appStore';
import { createClip, createTrack, type Session } from '../multitrack/session';
import { gapAt } from '../multitrack/gaps';
import { useSessionStore } from '../multitrack/sessionStore';
import { SESSION_UNDO_KEY, _resetSessionUndo } from '../multitrack/sessionUndo';
import { getHistory } from './undoHistory';

const mt = () => useSessionStore.getState();
const doneLabels = () => getHistory(SESSION_UNDO_KEY).done;

/** Track 1: A(1000..1500) · B(2000..2500) · C(2600..2900) — the gap is
 * [1500, 2000). Track 2 carries one clip that must never move. */
function seed(): { a: string; b: string; c: string; d: string } {
  const t1 = createTrack('Track 1');
  const t2 = createTrack('Track 2');
  t1.clips = [
    createClip({ documentId: 'doc-1', startSample: 1000, offsetSample: 128, lengthSample: 500, gainDb: -3 }),
    createClip({ documentId: 'doc-1', startSample: 2000, offsetSample: 256, lengthSample: 500, gainDb: 2 }),
    createClip({ documentId: 'doc-2', startSample: 2600, offsetSample: 64, lengthSample: 300, gainDb: -1 }),
  ];
  t2.clips = [
    createClip({ documentId: 'doc-2', startSample: 2200, offsetSample: 32, lengthSample: 700, gainDb: 4 }),
  ];
  const session: Session = { name: 'Gap Command Fixture', sampleRate: 44100, tracks: [t1, t2] };
  useSessionStore.setState({
    session,
    selectedClipId: null,
    selectedClipIds: [],
    selectedGap: null,
    mtCursorSample: 0,
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
  });
  return { a: t1.clips[0].id, b: t1.clips[1].id, c: t1.clips[2].id, d: t2.clips[0].id };
}

let fx: ReturnType<typeof seed>;

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetSessionUndo();
  fx = seed();
  useAppStore.setState({ view: 'multitrack' });
});

const enabled = (id: string) => isCommandEnabled(id);

/** The gap [1500, 2000) on track 1, resolved through the shipped resolver. */
function selectTheGap(): void {
  mt().setSelectedGap(gapAt(mt().session.tracks[0], 1700)!);
}

const startsOf = (trackIdx: number) =>
  useSessionStore
    .getState()
    .session.tracks[trackIdx].clips.map((c) => c.startSample)
    .sort((x, y) => x - y);

describe('the delete verbs are armed by a gap as well as by a clip', () => {
  it('both are dark with neither a gap nor a clip selected', () => {
    expect(enabled('edit.delete')).toBe(false);
    expect(enabled('edit.rippleDelete')).toBe(false);
  });

  it('both light up for a selected GAP', () => {
    selectTheGap();
    expect(enabled('edit.delete')).toBe(true);
    expect(enabled('edit.rippleDelete')).toBe(true);
  });

  it('both still light up for a selected CLIP, unchanged', () => {
    mt().setSelectedClip(fx.a);
    expect(enabled('edit.delete')).toBe(true);
    expect(enabled('edit.rippleDelete')).toBe(true);
  });
});

describe('running either verb closes the gap', () => {
  it('Delete moves the clips after the gap and nothing else', async () => {
    selectTheGap();

    await runCommand('edit.delete');

    expect(startsOf(0)).toEqual([1000, 1500, 2100]);
    expect(startsOf(1)).toEqual([2200]); // the other track never moves
    expect(doneLabels()).toEqual(['Close gap']);
    expect(mt().selectedGap).toBeNull();
  });

  it('Ripple Delete lands the SAME session — one act with two doors', async () => {
    selectTheGap();
    await runCommand('edit.delete');
    const afterDelete = mt().session;

    // Same fixture again, this time through Shift+Del.
    _resetSessionUndo();
    fx = seed();
    selectTheGap();
    await runCommand('edit.rippleDelete');

    expect(mt().session.tracks.map((t) => t.clips.map((c) => c.startSample))).toEqual(
      afterDelete.tracks.map((t) => t.clips.map((c) => c.startSample))
    );
    expect(doneLabels()).toEqual(['Close gap']);
  });

  it('deletes no CLIP while a gap is selected — the gap wins, and it removes nothing', async () => {
    selectTheGap();
    const before = mt().session.tracks[0].clips.length;

    await runCommand('edit.delete');

    expect(mt().session.tracks[0].clips).toHaveLength(before);
  });

  it('with a CLIP selected instead, Delete still removes it', async () => {
    mt().setSelectedClip(fx.b);

    await runCommand('edit.delete');

    expect(mt().session.tracks[0].clips.map((c) => c.id)).toEqual([fx.a, fx.c]);
    expect(doneLabels()).toEqual(['Remove clip']);
  });
});

describe('Escape clears the gap', () => {
  it('edit.deselect is enabled by a gap alone, and clears it', async () => {
    selectTheGap();
    expect(enabled('edit.deselect')).toBe(true);

    await runCommand('edit.deselect');

    expect(mt().selectedGap).toBeNull();
  });

  it('is still dark with nothing selected at all', () => {
    expect(enabled('edit.deselect')).toBe(false);
  });
});

describe('the editor views never feel any of it', () => {
  it('a selected gap arms nothing in the waveform view', () => {
    selectTheGap();
    useAppStore.setState({ view: 'waveform' });

    expect(enabled('edit.delete')).toBe(false);
    expect(enabled('edit.rippleDelete')).toBe(false);
    expect(enabled('edit.deselect')).toBe(false);
  });
});

describe('a stale gap is refused', () => {
  it('Delete with a gap the track no longer has records nothing', async () => {
    selectTheGap();
    // The space fills in under the standing selection, unrecorded (a load).
    const tracks = mt().session.tracks.map((t) => ({ ...t, clips: [...t.clips] }));
    tracks[0].clips.push(
      createClip({ documentId: 'doc-1', startSample: 1500, offsetSample: 0, lengthSample: 500 })
    );
    useSessionStore.setState({ session: { ...mt().session, tracks } });
    // The reconcile subscriber has already cleared it; re-arm it by hand to
    // prove the verb itself refuses rather than relying on the reconcile.
    mt().setSelectedGap({ trackId: tracks[0].id, startSample: 1500, endSample: 2000 });
    const before = mt().session;

    await runCommand('edit.delete');

    expect(mt().session).toBe(before);
    expect(doneLabels()).toEqual([]);
  });
});
