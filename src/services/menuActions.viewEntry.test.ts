/**
 * Lot E (item 4, N14) — leaving the MULTITRACK view for Waveform/Spectral with
 * a clip selected shows that clip's source span.
 *
 * Every Multitrack → editor entry was a raw `setView`, so the editor showed
 * whichever document was active before the multitrack, with its old selection,
 * cursor and zoom. `showEditorView` bridges the session's PRIMARY
 * `selectedClipId` to the app store: activate the clip's source document
 * first (the activation reset runs there), then select the clamped source
 * window, park the cursor at its start and fit the zoom to it. Everything
 * else — no selection, an orphan or dangling primary, an entry that is not a
 * multitrack leaver — is exactly the raw `setView` it was.
 *
 * Every case drives the real commands (`view.waveform` / `view.spectral`)
 * through `runCommand`, the path the View menu takes.
 */
import { isCommandEnabled, runCommand } from './menuActions';
import { FALLBACK_EDITOR_LANE_WIDTH, _resetEditorLaneWidth } from './editorViewport';
import { makeInitialState, useAppStore } from '../stores/appStore';
import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { createClip, createTrack, type Clip, type Session } from '../multitrack/session';
import { useSessionStore } from '../multitrack/sessionStore';
import { _resetSessionUndo } from '../multitrack/sessionUndo';

const SR = 44100;

/** Doc A: 5 000 samples. Doc B: 10 000 samples. Both 44.1 kHz unless told. */
function makeDoc(name: string, samples: number, sampleRate = SR): AudioDocument {
  return createDocument({ name, sampleRate, channels: [new Float32Array(samples)] });
}

/** A 44.1 kHz session holding `clips` on one track, with the given selection
 * seated directly (the raw shape the nav tests use). */
function seedSession(clips: Clip[], selectedClipId: string | null = null): Session {
  const track = createTrack('Track 1');
  track.clips = clips;
  const session: Session = { name: 'View Entry', sampleRate: SR, tracks: [track] };
  useSessionStore.setState({
    session,
    selectedClipId,
    selectedClipIds: selectedClipId === null ? [] : [selectedClipId],
    mtCursorSample: 0,
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
  });
  return session;
}

let A: AudioDocument;
let B: AudioDocument;

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetSessionUndo();
  // The lane width is module state published by the live views; unmeasured it
  // is the fallback, which is what the fit arithmetic below is stated in.
  _resetEditorLaneWidth();
  A = makeDoc('A', 5000);
  B = makeDoc('B', 10000);
  useAppStore.getState().addDocument(A);
  useAppStore.getState().addDocument(B);
  useAppStore.getState().setActiveDocument(A.id);
});

describe('view.waveform / view.spectral from the multitrack with a clip selected', () => {
  it('2a. activates the clip source, selects its window, parks the cursor and fits the zoom', async () => {
    const clip = createClip({ documentId: B.id, startSample: 0, offsetSample: 2000, lengthSample: 3000 });
    seedSession([clip]);
    useSessionStore.getState().setSelectedClip(clip.id);
    useAppStore.setState({ view: 'multitrack' });

    await runCommand('view.waveform');

    const s = useAppStore.getState();
    expect(s.activeDocumentId).toBe(B.id);
    expect(s.selection).toEqual({ start: 2000, end: 5000 });
    expect(s.cursorSample).toBe(2000);
    expect(s.view).toBe('waveform');
    expect(s.zoom.scrollSample).toBe(2000);
    expect(s.zoom.samplesPerPixel).toBe(3000 / FALLBACK_EDITOR_LANE_WIDTH);
  });

  it('2b. the same through view.spectral', async () => {
    const clip = createClip({ documentId: B.id, startSample: 0, offsetSample: 2000, lengthSample: 3000 });
    seedSession([clip]);
    useSessionStore.getState().setSelectedClip(clip.id);
    useAppStore.setState({ view: 'multitrack' });

    await runCommand('view.spectral');

    const s = useAppStore.getState();
    expect(s.view).toBe('spectral');
    expect(s.activeDocumentId).toBe(B.id);
    expect(s.selection).toEqual({ start: 2000, end: 5000 });
    expect(s.cursorSample).toBe(2000);
    expect(s.zoom.scrollSample).toBe(2000);
    expect(s.zoom.samplesPerPixel).toBe(3000 / FALLBACK_EDITOR_LANE_WIDTH);
  });

  it('2c. mixed rate: a 48 kHz source in a 44.1 kHz session spans readClipSlice’s window', async () => {
    const B48 = makeDoc('B48', 10000, 48000);
    useAppStore.getState().addDocument(B48);
    useAppStore.getState().setActiveDocument(A.id);
    const clip = createClip({ documentId: B48.id, startSample: 0, offsetSample: 2000, lengthSample: 4410 });
    seedSession([clip]);
    useSessionStore.getState().setSelectedClip(clip.id);
    useAppStore.setState({ view: 'multitrack' });

    await runCommand('view.waveform');

    const s = useAppStore.getState();
    expect(s.activeDocumentId).toBe(B48.id);
    expect(s.selection).toEqual({ start: 2000, end: 6800 });
    expect(s.zoom.samplesPerPixel).toBe(4800 / FALLBACK_EDITOR_LANE_WIDTH);
  });

  it('2d. a clip trimmed past its source selects the clamped window', async () => {
    const clip = createClip({ documentId: B.id, startSample: 0, offsetSample: 9000, lengthSample: 3000 });
    seedSession([clip]);
    useSessionStore.getState().setSelectedClip(clip.id);
    useAppStore.setState({ view: 'multitrack' });

    await runCommand('view.waveform');

    const s = useAppStore.getState();
    expect(s.selection).toEqual({ start: 9000, end: 10000 });
    expect(s.zoom.scrollSample).toBe(9000);
    expect(s.zoom.samplesPerPixel).toBe(1000 / FALLBACK_EDITOR_LANE_WIDTH);
  });

  it('2e. a window clamped to nothing selects nothing (no zero-width selection)', async () => {
    const clip = createClip({ documentId: B.id, startSample: 0, offsetSample: 10000, lengthSample: 3000 });
    seedSession([clip]);
    useSessionStore.getState().setSelectedClip(clip.id);
    useAppStore.setState({ view: 'multitrack' });

    await runCommand('view.waveform');

    const s = useAppStore.getState();
    expect(s.activeDocumentId).toBe(B.id);
    expect(s.selection).toBeNull();
    expect(s.cursorSample).toBe(10000);
  });

  it('2f. no clip selected: the document you left is shown with its selection intact', async () => {
    seedSession([]);
    useAppStore.getState().setSelection({ start: 100, end: 400 });
    useAppStore.setState({ view: 'multitrack' });

    await runCommand('view.waveform');

    const s = useAppStore.getState();
    expect(s.activeDocumentId).toBe(A.id);
    expect(s.selection).toEqual({ start: 100, end: 400 });
    expect(s.view).toBe('waveform');
  });

  // A guard, not a fail-first case: N14 makes the orphan path exactly the raw
  // `setView` it was, so this is green against the pre-lot code by design.
  // It goes red the moment the helper substitutes another document for the
  // missing source (e.g. `?? app.documents[0]`) — that is what it pins.
  it('2g. an orphan clip (source closed) falls through to a plain setView', async () => {
    const clip = createClip({ documentId: 'doc-gone', startSample: 0, offsetSample: 0, lengthSample: 1000 });
    seedSession([clip]);
    useSessionStore.getState().setSelectedClip(clip.id);
    useAppStore.getState().setSelection({ start: 100, end: 400 });
    useAppStore.setState({ view: 'multitrack' });

    await expect(runCommand('view.waveform')).resolves.toBeUndefined();

    const s = useAppStore.getState();
    expect(s.activeDocumentId).toBe(A.id);
    expect(s.selection).toEqual({ start: 100, end: 400 });
    expect(s.view).toBe('waveform');
  });

  it('2h. a clip of the already-active document selects its window without an activation reset', async () => {
    const clip = createClip({ documentId: A.id, startSample: 0, offsetSample: 1000, lengthSample: 2000 });
    seedSession([clip]);
    useSessionStore.getState().setSelectedClip(clip.id);
    const playback = { state: 'paused' as const, positionSample: 777, loop: false };
    useAppStore.setState({ view: 'multitrack', playback });

    await runCommand('view.waveform');

    const s = useAppStore.getState();
    expect(s.activeDocumentId).toBe(A.id);
    expect(s.selection).toEqual({ start: 1000, end: 3000 });
    expect(s.playback).toEqual(playback);
  });

  it('2i. multi-select: the PRIMARY (the last member) decides the document', async () => {
    const b1 = createClip({ documentId: B.id, startSample: 0, offsetSample: 0, lengthSample: 1000 });
    const a1 = createClip({ documentId: A.id, startSample: 2000, offsetSample: 500, lengthSample: 1500 });
    seedSession([b1, a1]);
    useAppStore.getState().setActiveDocument(B.id);
    useSessionStore.getState().setSelectedClips([b1.id, a1.id]);
    expect(useSessionStore.getState().selectedClipId).toBe(a1.id);
    useAppStore.setState({ view: 'multitrack' });

    await runCommand('view.waveform');

    const s = useAppStore.getState();
    expect(s.activeDocumentId).toBe(A.id);
    expect(s.selection).toEqual({ start: 500, end: 2000 });
  });

  it('2j. not a multitrack leaver: editor-to-editor switches touch nothing', async () => {
    const clip = createClip({ documentId: B.id, startSample: 0, offsetSample: 2000, lengthSample: 3000 });
    seedSession([clip]);
    useSessionStore.getState().setSelectedClip(clip.id);
    useAppStore.setState({ view: 'waveform' });

    await runCommand('view.spectral');

    const s = useAppStore.getState();
    expect(s.activeDocumentId).toBe(A.id);
    expect(s.selection).toBeNull();
    expect(s.view).toBe('spectral');
  });

  it('2k. a dangling primary (no clip carries the id) does not throw', async () => {
    seedSession([]);
    useSessionStore.setState({ selectedClipId: 'clip-none', selectedClipIds: ['clip-none'] });
    useAppStore.setState({ view: 'multitrack' });

    await expect(runCommand('view.waveform')).resolves.toBeUndefined();

    const s = useAppStore.getState();
    expect(s.view).toBe('waveform');
    expect(s.activeDocumentId).toBe(A.id);
  });

  it('2l. the enabled predicates are untouched', () => {
    useAppStore.setState(makeInitialState());
    expect(isCommandEnabled('view.waveform')).toBe(false);

    useAppStore.getState().addDocument(makeDoc('A', 5000));
    useAppStore.setState({ view: 'waveform' });
    expect(isCommandEnabled('view.waveform')).toBe(false);
    expect(isCommandEnabled('view.spectral')).toBe(true);
  });
});
