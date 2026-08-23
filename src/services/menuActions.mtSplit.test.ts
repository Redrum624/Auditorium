import { isCommandEnabled, runCommand } from './menuActions';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { createDocument, docLength } from '../audio/AudioDocument';
import { createClip, createTrack, type Clip, type Session } from '../multitrack/session';
import { useSessionStore } from '../multitrack/sessionStore';
import { SESSION_UNDO_KEY, _resetSessionUndo } from '../multitrack/sessionUndo';
import { getHistory } from './undoHistory';
import { getClipboard, setClipboard } from './clipboard';
import * as snapPreference from './snapPreference';

/**
 * Item 10 (M1/M2/N1-N5) — `edit.split`'s MULTITRACK arm. The editor arm and
 * the command's registration are item 8's and are not re-tested here; what
 * this file pins is the routing: in the multitrack view the command reads the
 * SESSION (the clip selection, the clips, `mtCursorSample`) and writes clips,
 * and the four region verbs beside it stay refused (M7) while the hidden
 * active document is not touched at all.
 */

const store = () => useSessionStore.getState();
const doneLabels = () => getHistory(SESSION_UNDO_KEY).done;

/** Installs a session from a per-track list of `[start, length]` spans, with
 * every clip pointing at `documentId`. */
function seed(
  tracks: [number, number][][],
  documentId = 'doc-1'
): { session: Session; ids: string[][] } {
  const built = tracks.map((spans, i) => {
    const t = createTrack(`Track ${i + 1}`);
    t.clips = spans.map(([startSample, lengthSample]) =>
      createClip({ documentId, startSample, offsetSample: 0, lengthSample })
    );
    return t;
  });
  const session: Session = { name: 'Split Fixture', sampleRate: 44100, tracks: built };
  useSessionStore.setState({
    session,
    selectedClipId: null,
    selectedClipIds: [],
    mtCursorSample: 0,
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
  });
  return { session, ids: built.map((t) => t.clips.map((c) => c.id)) };
}

const clipsOn = (i: number): Clip[] => store().session.tracks[i].clips;

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetSessionUndo();
  useAppStore.getState().setView('multitrack');
});

describe('edit.split in the Multitrack view — enablement (M2)', () => {
  it('3a is refused with a clip under the cursor but NOTHING selected', () => {
    seed([[[1000, 3000]]]);
    store().setMtCursor(2000);
    expect(isCommandEnabled('edit.split')).toBe(false);
  });

  it('3b lights once that clip is selected', () => {
    const { ids } = seed([[[1000, 3000]]]);
    store().setMtCursor(2000);
    store().setSelectedClip(ids[0][0]);
    expect(isCommandEnabled('edit.split')).toBe(true);
  });

  it('3b is TRACK-scoped: a selected clip lights its track-mate under the cursor', () => {
    const { ids } = seed([[[1000, 3000], [5000, 1000]]]);
    store().setMtCursor(2000); // inside the UNselected first clip
    store().setSelectedClip(ids[0][1]);
    expect(isCommandEnabled('edit.split')).toBe(true);
  });

  it('3b is refused at either edge, inside the 32-sample margin, and inside an overlap', () => {
    const { ids } = seed([[[1000, 3000]]]); // 1000..4000
    store().setSelectedClip(ids[0][0]);
    for (const sample of [1000, 1031, 3969, 4000]) {
      store().setMtCursor(sample);
      expect(isCommandEnabled('edit.split')).toBe(false);
    }

    const overlapped = seed([[[1000, 3000], [3500, 2000]]]); // overlap 3500..4000
    store().setSelectedClip(overlapped.ids[0][0]);
    store().setMtCursor(3700);
    expect(isCommandEnabled('edit.split')).toBe(false);
  });

  it('3b is refused when the only selected clip is on ANOTHER track', () => {
    const { ids } = seed([[[1000, 3000]], [[8000, 3000]]]);
    store().setMtCursor(2000); // inside track 1's clip
    store().setSelectedClip(ids[1][0]); // but track 2 owns the selection
    expect(isCommandEnabled('edit.split')).toBe(false);
  });
});

describe('edit.split in the Multitrack view — the act', () => {
  it('3c splits only the selected tracks, in one entry, without moving the cursor', async () => {
    const { ids } = seed([[[1000, 3000]], [[1000, 3000]]]);
    store().setSelectedClip(ids[0][0]);
    store().setMtCursor(2000);

    await runCommand('edit.split');

    expect(clipsOn(0)).toHaveLength(2);
    expect(clipsOn(0).map((c) => c.startSample)).toEqual([1000, 2000]);
    expect(clipsOn(1)).toHaveLength(1);
    expect(doneLabels()).toEqual(['Split clip']);
    expect(store().mtCursorSample).toBe(2000);
  });

  it('3d advances the right half at the SOURCE document rate (N3)', async () => {
    const doc = createDocument({
      name: 'fast.wav',
      sampleRate: 48000,
      channels: [new Float32Array(48000)],
    });
    useAppStore.getState().addDocument(doc);
    useAppStore.getState().setView('multitrack');

    const { ids } = seed([[[1000, 3000]]], doc.id);
    useSessionStore.setState({
      session: {
        ...store().session,
        tracks: store().session.tracks.map((t, i) =>
          i === 0 ? { ...t, clips: [{ ...t.clips[0], offsetSample: 500 }] } : t
        ),
      },
    });
    store().setSelectedClip(ids[0][0]);
    store().setMtCursor(2000); // leftLen 1000

    await runCommand('edit.split');

    const right = clipsOn(0)[1];
    expect(right.offsetSample).toBe(500 + Math.round((1000 * 48000) / 44100));
    expect(500 + Math.round((1000 * 48000) / 44100)).toBe(1588);
  });

  it('3d falls back to the session-rate delta for a clip whose document is unknown', async () => {
    const { ids } = seed([[[1000, 3000]]], 'doc-not-open');
    store().setSelectedClip(ids[0][0]);
    store().setMtCursor(2000);

    await runCommand('edit.split');

    expect(clipsOn(0)[1].offsetSample).toBe(1000);
  });
});

describe('edit.split in the Multitrack view — what it must NOT touch (M1/M7)', () => {
  /** `menuActions.test.ts`'s trap, reused: a live document selection AND a
   * full clipboard carried into the multitrack view. Non-zero samples, so
   * "nothing ran on the hidden document" is a falsifiable claim. */
  function armedInMultitrack() {
    const doc = createDocument({
      name: 'hidden.wav',
      sampleRate: 44100,
      channels: [Float32Array.from({ length: 1000 }, (_, i) => 0.5 - (i % 7) / 10)],
    });
    useAppStore.getState().addDocument(doc);
    useAppStore.getState().setSelection({ start: 100, end: 400 });
    setClipboard({ channels: [new Float32Array(50)], sampleRate: 44100 });
    useAppStore.getState().setView('multitrack');
    return doc;
  }

  it('3e leaves the hidden document byte-identical, and the clipboard and selection alone', async () => {
    const doc = armedInMultitrack();
    const { ids } = seed([[[1000, 3000]]], 'doc-1');
    store().setSelectedClip(ids[0][0]);
    store().setMtCursor(2000);

    const before = useAppStore.getState().documents.find((d) => d.id === doc.id)!;
    const beforeLength = docLength(before);
    const beforeSamples = Array.from(before.channels[0]);
    const beforeClipboard = getClipboard();
    expect(beforeSamples.slice(100, 400).some((v) => v !== 0)).toBe(true);

    await runCommand('edit.split');

    const after = useAppStore.getState().documents.find((d) => d.id === doc.id)!;
    expect(docLength(after)).toBe(beforeLength);
    expect(Array.from(after.channels[0])).toEqual(beforeSamples);
    expect(getClipboard()).toBe(beforeClipboard);
    expect(useAppStore.getState().selection).toEqual({ start: 100, end: 400 });
    expect(clipsOn(0)).toHaveLength(2);
  });

  it('3f keeps Cut / Copy / Paste / Trim / Silence refused in that same armed state', () => {
    armedInMultitrack();
    const { ids } = seed([[[1000, 3000]]], 'doc-1');
    store().setSelectedClip(ids[0][0]);
    store().setMtCursor(2000);

    expect(isCommandEnabled('edit.split')).toBe(true);
    for (const id of ['edit.cut', 'edit.copy', 'edit.paste', 'edit.trim', 'edit.silence']) {
      expect(isCommandEnabled(id)).toBe(false);
    }
  });

  it('3g never consults the snap preference (N1)', async () => {
    const toggle = jest.spyOn(snapPreference, 'toggleSnap');
    const setEnabled = jest.spyOn(snapPreference, 'setSnapEnabled');
    const { ids } = seed([[[1000, 3000]]]);
    store().setSelectedClip(ids[0][0]);
    store().setMtCursor(2000);

    await runCommand('edit.split');

    expect(toggle).not.toHaveBeenCalled();
    expect(setEnabled).not.toHaveBeenCalled();
    expect(clipsOn(0)[1].startSample).toBe(2000); // the cursor, verbatim
    toggle.mockRestore();
    setEnabled.mockRestore();
  });

  it('3h answers the EDITOR predicate in the waveform view — the session never leaks in', () => {
    const { ids } = seed([[[1000, 3000]]]);
    store().setSelectedClip(ids[0][0]);
    store().setMtCursor(2000);
    useAppStore.getState().setView('waveform');

    // Fully armed for the multitrack arm, but no document is open, and item
    // 8's editor arm needs one.
    expect(isCommandEnabled('edit.split')).toBe(false);
  });
});
