import { runCommand } from './menuActions';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { createDocument, docLength } from '../audio/AudioDocument';
import { useSessionStore } from '../multitrack/sessionStore';
import { SESSION_UNDO_KEY, _resetSessionUndo } from '../multitrack/sessionUndo';
import { getHistory } from '../services/undoHistory';

jest.mock('../multitrack/sessionFile');
jest.mock('./tempoAnalysis', () => ({
  runTempoAnalysis: jest.fn(async () => null),
}));

/**
 * R3 — ruling 1's view routing at the command layer (the ordering exists in
 * BOTH `enabled` and `run`, so both get fixtures): in the multitrack view
 * Ctrl+Z/Ctrl+Y address the SESSION history; in the waveform editor they
 * address the active document's; the two stacks never disturb each other.
 */

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetSessionUndo();
  useSessionStore.getState().newSession(44100);
  _resetSessionUndo(); // the setup newSession is not user history
});

function openDoc() {
  const doc = createDocument({ name: 'a', sampleRate: 44100, channels: [new Float32Array(1000)] });
  useAppStore.getState().addDocument(doc);
  return doc;
}

const sessionRef = () => useSessionStore.getState().session;
const sessionDone = () => getHistory(SESSION_UNDO_KEY).done;

describe('edit.undo / edit.redo view routing (ruling 1)', () => {
  it('multitrack view: Ctrl+Z undoes the SESSION edit and leaves the document edit alone', async () => {
    const doc = openDoc();
    // A document edit (doc history) ...
    useAppStore.getState().setSelection({ start: 0, end: 10 });
    await runCommand('edit.rippleDelete'); // waveform view -> removes the selection (item 7: plain Delete is equal-length)
    expect(docLength(useAppStore.getState().documents[0])).toBe(990);
    // ... then a session edit (session history).
    const preSession = sessionRef();
    useSessionStore.getState().addTrack();
    expect(sessionDone()).toEqual(['Add track']);

    useAppStore.getState().setView('multitrack');
    await runCommand('edit.undo');

    expect(sessionRef()).toBe(preSession); // session edit undone
    expect(docLength(useAppStore.getState().documents[0])).toBe(990); // doc edit untouched
    expect(getHistory(doc.id).done).toHaveLength(1);

    await runCommand('edit.redo');
    expect(sessionRef().tracks).toHaveLength(5); // session redo re-adds the track
    expect(docLength(useAppStore.getState().documents[0])).toBe(990);
  });

  it('waveform view: Ctrl+Z undoes the DOCUMENT edit and leaves the session edit alone', async () => {
    openDoc();
    useAppStore.getState().setSelection({ start: 0, end: 10 });
    await runCommand('edit.rippleDelete');
    useSessionStore.getState().addTrack();
    const postSession = sessionRef();

    // view is 'waveform' (the default)
    await runCommand('edit.undo');

    expect(docLength(useAppStore.getState().documents[0])).toBe(1000); // doc restored
    expect(sessionRef()).toBe(postSession); // session untouched
    expect(sessionDone()).toEqual(['Add track']);
  });

  it('multitrack view with an empty session history: edit.undo is disabled even when a doc could undo', async () => {
    openDoc();
    useAppStore.getState().setSelection({ start: 0, end: 10 });
    await runCommand('edit.rippleDelete'); // doc history now has one entry
    useAppStore.getState().setView('multitrack');

    await runCommand('edit.undo'); // enabled() is false for the session -> skipped

    expect(docLength(useAppStore.getState().documents[0])).toBe(990); // doc NOT undone
    expect(sessionDone()).toEqual([]);
  });

  it('multitrack view works with NO document open at all (the common multitrack state)', async () => {
    expect(useAppStore.getState().activeDocumentId).toBeNull();
    const pre = sessionRef();
    useSessionStore.getState().addTrack();
    useAppStore.getState().setView('multitrack');

    await runCommand('edit.undo');
    expect(sessionRef()).toBe(pre);

    await runCommand('edit.redo');
    expect(sessionRef().tracks).toHaveLength(5);
  });

  it('edit.delete in the multitrack view (remove selected clip) is itself undoable', async () => {
    const doc = openDoc();
    const clip = {
      id: 'clip-del',
      documentId: doc.id,
      startSample: 0,
      offsetSample: 0,
      lengthSample: 500,
      gainDb: 0,
    };
    useSessionStore.getState().addClip(sessionRef().tracks[0].id, clip);
    useSessionStore.getState().setSelectedClip('clip-del');
    _resetSessionUndo(); // setup is not user history
    const pre = sessionRef();

    useAppStore.getState().setView('multitrack');
    await runCommand('edit.delete');
    expect(sessionRef().tracks[0].clips).toHaveLength(0);
    expect(sessionDone()).toEqual(['Remove clip']);

    await runCommand('edit.undo');
    expect(sessionRef()).toBe(pre);
    expect(useSessionStore.getState().selectedClipId).toBe('clip-del'); // ruling 3: selection restored
  });
});
