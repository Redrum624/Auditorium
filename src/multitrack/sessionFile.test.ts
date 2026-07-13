import { createDocument, nextId, type AudioDocument } from '../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { createClip, createTrack, type Session } from './session';
import { openSessionViaDialog, parseSessionFile, saveSessionViaDialog, serializeSession } from './sessionFile';
import { useSessionStore } from './sessionStore';

interface MockApi {
  readFile: jest.Mock;
  writeFile: jest.Mock;
  showOpenDialog: jest.Mock;
  showSaveDialog: jest.Mock;
  showMessageBox: jest.Mock;
  pathBasename: (p: string) => string;
  [k: string]: unknown;
}

function installApi(overrides: Partial<MockApi> = {}): MockApi {
  const api: MockApi = {
    readFile: jest.fn(async () => new ArrayBuffer(0)),
    writeFile: jest.fn(async () => ({ ok: true })),
    showOpenDialog: jest.fn(async () => null),
    showSaveDialog: jest.fn(async () => null),
    showMessageBox: jest.fn(async () => 0),
    pathBasename: (p: string) => p.split(/[\\/]/).pop() ?? p,
    ...overrides,
  };
  (window as unknown as { electronAPI: MockApi }).electronAPI = api;
  return api;
}

function sine(n: number, freq = 440, sr = 44100, amplitude = 0.5): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

function trackJson(id: string, clips: object[] = []) {
  return { id, name: 'T', volumeDb: 0, pan: 0, muted: false, solo: false, armed: false, clips };
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(44100);
});

describe('serializeSession', () => {
  it('embeds only documents actually referenced by a clip', () => {
    const referenced = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(100)] });
    const unreferenced = createDocument({ name: 'b.wav', sampleRate: 44100, channels: [sine(100)] });
    const track = createTrack('T');
    const clip = createClip({ documentId: referenced.id, startSample: 0, offsetSample: 0, lengthSample: 100 });
    track.clips = [clip];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };

    const { json } = serializeSession(session, [referenced, unreferenced]);
    const parsed = JSON.parse(json);

    expect(parsed.formatVersion).toBe(1);
    expect(parsed.documents).toHaveLength(1);
    expect(parsed.documents[0].id).toBe(referenced.id);
    expect(parsed.documents[0].wavBase64).toEqual(expect.any(String));
  });

  it('embeds zero documents when no clip references any', () => {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [createTrack('T')] };

    const { json } = serializeSession(session, [doc]);

    expect(JSON.parse(json).documents).toHaveLength(0);
  });

  it('drops clips whose source document is not currently open and reports the count', () => {
    const openDoc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(100)] });
    const closedDoc = createDocument({ name: 'b.wav', sampleRate: 44100, channels: [sine(100)] });
    const track = createTrack('T');
    const keptClip = createClip({ documentId: openDoc.id, startSample: 0, offsetSample: 0, lengthSample: 100 });
    const orphanClip = createClip({ documentId: closedDoc.id, startSample: 200, offsetSample: 0, lengthSample: 100 });
    track.clips = [keptClip, orphanClip];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [track] };

    // closedDoc is intentionally NOT passed in docs — simulates the clip's source
    // document having been closed since the clip was added to the session.
    const { json, droppedClipCount } = serializeSession(session, [openDoc]);
    const parsed = JSON.parse(json);

    expect(droppedClipCount).toBe(1);
    expect(parsed.session.tracks[0].clips).toHaveLength(1);
    expect(parsed.session.tracks[0].clips[0].id).toBe(keptClip.id);
    expect(parsed.documents).toHaveLength(1);
    expect(parsed.documents[0].id).toBe(openDoc.id);
  });
});

describe('serializeSession -> parseSessionFile round trip', () => {
  it('preserves track params, clip geometry, and 32-bit-float audio content exactly', () => {
    const doc = createDocument({
      name: 'song.wav',
      sampleRate: 48000,
      channels: [sine(2000, 440), sine(2000, 220)],
    });
    const track = { ...createTrack('Lead'), volumeDb: -6, pan: 0.3, muted: true, solo: false, armed: true };
    const clip = createClip({
      documentId: doc.id,
      startSample: 500,
      offsetSample: 100,
      lengthSample: 800,
      gainDb: -3,
    });
    track.clips = [clip];
    const session: Session = { name: 'My Session', sampleRate: 48000, tracks: [track] };

    const { json } = serializeSession(session, [doc]);
    const { session: restored, documents } = parseSessionFile(json);

    expect(restored.name).toBe('My Session');
    expect(restored.sampleRate).toBe(48000);

    const restoredTrack = restored.tracks[0];
    expect(restoredTrack.name).toBe('Lead');
    expect(restoredTrack.volumeDb).toBe(-6);
    expect(restoredTrack.pan).toBe(0.3);
    expect(restoredTrack.muted).toBe(true);
    expect(restoredTrack.solo).toBe(false);
    expect(restoredTrack.armed).toBe(true);

    const restoredClip = restoredTrack.clips[0];
    expect(restoredClip.startSample).toBe(500);
    expect(restoredClip.offsetSample).toBe(100);
    expect(restoredClip.lengthSample).toBe(800);
    expect(restoredClip.gainDb).toBe(-3);

    expect(documents).toHaveLength(1);
    const restoredDoc = documents.find((d) => d.id === restoredClip.documentId)!;
    expect(restoredDoc).toBeDefined();
    expect(restoredDoc.sampleRate).toBe(48000);
    expect(restoredDoc.channels).toHaveLength(2);
    // 32-bit float WAV is a lossless container for Float32 samples.
    expect(restoredDoc.channels[0]).toEqual(doc.channels[0]);
    expect(restoredDoc.channels[1]).toEqual(doc.channels[1]);
  });

  it('assigns fresh document ids and remaps every clip.documentId into the recreated doc set', () => {
    const docA = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(50)] });
    const docB = createDocument({ name: 'b.wav', sampleRate: 44100, channels: [sine(50)] });
    const trackA = createTrack('A');
    const trackB = createTrack('B');
    trackA.clips = [createClip({ documentId: docA.id, startSample: 0, offsetSample: 0, lengthSample: 50 })];
    trackB.clips = [createClip({ documentId: docB.id, startSample: 0, offsetSample: 0, lengthSample: 50 })];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [trackA, trackB] };

    const { json } = serializeSession(session, [docA, docB]);
    const { session: restored, documents } = parseSessionFile(json);

    const restoredIds = new Set(documents.map((d) => d.id));
    expect(restoredIds.size).toBe(2); // two distinct fresh ids
    for (const track of restored.tracks) {
      for (const clip of track.clips) {
        expect(restoredIds.has(clip.documentId)).toBe(true);
      }
    }
    // Fresh ids: createDocument always mints new sequential ids, never the source's.
    expect(documents.some((d) => d.id === docA.id)).toBe(false);
    expect(documents.some((d) => d.id === docB.id)).toBe(false);
  });

  it('round-trips audio content exactly across multiple 32KB base64 chunk boundaries', () => {
    // 3 channels of 200,000 samples * 4 bytes/sample = 2.4MB of WAV payload,
    // forcing the chunked btoa/atob path (32KB chunks) through many iterations
    // — this is what guards against the call-stack-overflow bug the chunking
    // exists to avoid, and against any off-by-one at a chunk boundary.
    const n = 200000;
    const doc = createDocument({
      name: 'big.wav',
      sampleRate: 44100,
      channels: [sine(n, 440), sine(n, 220), sine(n, 110)],
    });
    const track = createTrack('Big');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: n })];
    const session: Session = { name: 'Big Session', sampleRate: 44100, tracks: [track] };

    const { json } = serializeSession(session, [doc]);
    const { documents } = parseSessionFile(json);

    expect(documents[0].channels).toHaveLength(3);
    for (let ch = 0; ch < 3; ch++) {
      expect(documents[0].channels[ch]).toEqual(doc.channels[ch]);
    }
  });

  it('throws for an unsupported formatVersion', () => {
    const bad = JSON.stringify({
      formatVersion: 2,
      session: { name: 'x', sampleRate: 44100, tracks: [] },
      documents: [],
    });

    expect(() => parseSessionFile(bad)).toThrow(/formatVersion|version/i);
  });
});

describe('saveSessionViaDialog', () => {
  it('writes the serialized session (only referenced docs) to the picked .audm path', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\session.audm') });
    const doc: AudioDocument = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    useAppStore.getState().addDocument(doc);
    const trackId = useSessionStore.getState().session.tracks[0].id;
    const clip = createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 10 });
    useSessionStore.getState().addClip(trackId, clip);

    await saveSessionViaDialog();

    expect(api.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ name: 'Auditorium Session', extensions: ['audm'] }] })
    );
    expect(api.writeFile).toHaveBeenCalledTimes(1);
    const [path, data] = api.writeFile.mock.calls[0];
    expect(path).toBe('D:\\out\\session.audm');
    const text = new TextDecoder().decode(data as ArrayBuffer);
    const parsed = JSON.parse(text);
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.documents).toHaveLength(1);
    expect(parsed.session.tracks[0].clips[0].lengthSample).toBe(10);
  });

  it('is a no-op when the save dialog is cancelled', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => null) });

    await saveSessionViaDialog();

    expect(api.writeFile).not.toHaveBeenCalled();
  });

  it('shows an error message box when the write fails', async () => {
    const api = installApi({
      showSaveDialog: jest.fn(async () => 'D:\\out\\session.audm'),
      writeFile: jest.fn(async () => ({ ok: false, error: 'disk full' })),
    });

    await saveSessionViaDialog();

    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'disk full' })
    );
  });

  it('warns via an info message box when saved clips referenced closed source files', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\session.audm') });
    const openDoc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    const closedDoc = createDocument({ name: 'b.wav', sampleRate: 44100, channels: [sine(10)] });
    useAppStore.getState().addDocument(openDoc);
    useAppStore.getState().addDocument(closedDoc);
    useAppStore.getState().closeDocument(closedDoc.id);

    const trackId = useSessionStore.getState().session.tracks[0].id;
    useSessionStore
      .getState()
      .addClip(trackId, createClip({ documentId: openDoc.id, startSample: 0, offsetSample: 0, lengthSample: 10 }));
    useSessionStore
      .getState()
      .addClip(trackId, createClip({ documentId: closedDoc.id, startSample: 100, offsetSample: 0, lengthSample: 10 }));

    await saveSessionViaDialog();

    expect(api.writeFile).toHaveBeenCalledTimes(1);
    const [, data] = api.writeFile.mock.calls[0];
    const text = new TextDecoder().decode(data as ArrayBuffer);
    const parsed = JSON.parse(text);
    expect(parsed.session.tracks[0].clips).toHaveLength(1);

    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', message: '1 clip(s) referenced closed files and were not saved.' })
    );
  });

  it('does not show a message box when no clips were dropped', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\session.audm') });
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    useAppStore.getState().addDocument(doc);
    const trackId = useSessionStore.getState().session.tracks[0].id;
    useSessionStore
      .getState()
      .addClip(trackId, createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 10 }));

    await saveSessionViaDialog();

    expect(api.showMessageBox).not.toHaveBeenCalled();
  });
});

describe('openSessionViaDialog', () => {
  it('recreates docs, remaps clip documentIds, replaces the session, and switches to multitrack view', async () => {
    const doc = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [sine(10)] });
    const track = createTrack('Loaded Track');
    track.clips = [createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 10 })];
    const session: Session = { name: 'Loaded Session', sampleRate: 44100, tracks: [track] };
    const { json } = serializeSession(session, [doc]);
    const bytes = new TextEncoder().encode(json);

    const api = installApi({
      showOpenDialog: jest.fn(async () => ['D:\\in\\session.audm']),
      readFile: jest.fn(async () => bytes.buffer),
    });

    await openSessionViaDialog();

    expect(api.readFile).toHaveBeenCalledWith('D:\\in\\session.audm');
    const sessionState = useSessionStore.getState();
    expect(sessionState.session.name).toBe('Loaded Session');
    expect(sessionState.selectedClipId).toBeNull();

    const appState = useAppStore.getState();
    expect(appState.view).toBe('multitrack');
    const restoredClip = sessionState.session.tracks[0].clips[0];
    expect(appState.documents.some((d) => d.id === restoredClip.documentId)).toBe(true);
  });

  it('is a no-op when the open dialog is cancelled', async () => {
    const api = installApi({ showOpenDialog: jest.fn(async () => null) });
    const before = useSessionStore.getState().session;

    await openSessionViaDialog();

    expect(api.readFile).not.toHaveBeenCalled();
    expect(useSessionStore.getState().session).toBe(before);
  });

  it('shows an error message box and leaves the current session untouched on a bad formatVersion', async () => {
    const bad = JSON.stringify({
      formatVersion: 99,
      session: { name: 'x', sampleRate: 44100, tracks: [] },
      documents: [],
    });
    const bytes = new TextEncoder().encode(bad);
    const api = installApi({
      showOpenDialog: jest.fn(async () => ['D:\\in\\bad.audm']),
      readFile: jest.fn(async () => bytes.buffer),
    });
    const before = useSessionStore.getState().session;

    await openSessionViaDialog();

    expect(api.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(useSessionStore.getState().session).toBe(before);
    expect(useAppStore.getState().view).not.toBe('multitrack');
  });

  it('shows an error message box and leaves the current session untouched when readFile fails', async () => {
    const api = installApi({
      showOpenDialog: jest.fn(async () => ['D:\\in\\denied.audm']),
      readFile: jest.fn(async () => {
        throw new Error('EACCES: permission denied');
      }),
    });
    const before = useSessionStore.getState().session;

    await openSessionViaDialog();

    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: expect.stringContaining('EACCES') })
    );
    expect(useSessionStore.getState().session).toBe(before);
    expect(useAppStore.getState().view).not.toBe('multitrack');
  });

  it('shows an info message box and drops clips when opened clips reference no embedded document', async () => {
    const json = JSON.stringify({
      formatVersion: 1,
      session: {
        name: 'Stale',
        sampleRate: 44100,
        tracks: [
          trackJson('track-1', [
            { id: 'clip-1', documentId: 'doc-77', startSample: 0, offsetSample: 0, lengthSample: 100, gainDb: 0 },
          ]),
        ],
      },
      documents: [],
    });
    const bytes = new TextEncoder().encode(json);
    const api = installApi({
      showOpenDialog: jest.fn(async () => ['D:\\in\\stale.audm']),
      readFile: jest.fn(async () => bytes.buffer),
    });

    await openSessionViaDialog();

    expect(useSessionStore.getState().session.tracks[0].clips).toHaveLength(0);
    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', message: '1 clip(s) referenced missing audio and were removed.' })
    );
  });
});

describe('id-counter seeding after parse', () => {
  it('parseSessionFile seeds track/clip counters past the max suffix in the loaded session', () => {
    const json = JSON.stringify({
      formatVersion: 1,
      session: {
        name: 'S',
        sampleRate: 44100,
        tracks: [
          trackJson('track-9000', [
            { id: 'clip-90000', documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 100, gainDb: 0 },
          ]),
          trackJson('track-8999'),
        ],
      },
      documents: [],
    });

    parseSessionFile(json);

    const track = createTrack('after-load');
    const clip = createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 32 });
    expect(Number(track.id.split('-')[1])).toBeGreaterThan(9000);
    expect(Number(clip.id.split('-')[1])).toBeGreaterThan(90000);
  });

  it('after opening a session, addTrack()/addClip() never mint ids colliding with loaded ones', async () => {
    const json = JSON.stringify({
      formatVersion: 1,
      session: {
        name: 'Loaded',
        sampleRate: 44100,
        tracks: [
          trackJson('track-9500', [
            { id: 'clip-95000', documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 100, gainDb: 0 },
          ]),
        ],
      },
      documents: [],
    });
    const bytes = new TextEncoder().encode(json);
    installApi({
      showOpenDialog: jest.fn(async () => ['D:\\in\\old.audm']),
      readFile: jest.fn(async () => bytes.buffer),
    });

    await openSessionViaDialog();
    useSessionStore.getState().addTrack();

    const tracks = useSessionStore.getState().session.tracks;
    const trackIds = tracks.map((t) => t.id);
    expect(new Set(trackIds).size).toBe(trackIds.length); // no duplicates
    const newTrack = tracks[tracks.length - 1];
    expect(Number(newTrack.id.split('-')[1])).toBeGreaterThan(9500);

    const newClip = createClip({ documentId: 'doc-1', startSample: 200, offsetSample: 0, lengthSample: 32 });
    expect(Number(newClip.id.split('-')[1])).toBeGreaterThan(95000);
  });

  it('seeds the doc counter past a stale documentId retained in the file, even with no embedded documents', () => {
    // Hand-built file: a clip references 'doc-77' but no document with that id
    // is embedded (e.g. the source was closed before save, pre-fix, or the
    // file was hand-edited). Loading must drop the orphaned clip AND seed the
    // 'doc' counter past 77 so a freshly minted document can never collide
    // with the stale retained id.
    const json = JSON.stringify({
      formatVersion: 1,
      session: {
        name: 'S',
        sampleRate: 44100,
        tracks: [
          trackJson('track-1', [
            { id: 'clip-1', documentId: 'doc-77', startSample: 0, offsetSample: 0, lengthSample: 100, gainDb: 0 },
          ]),
        ],
      },
      documents: [],
    });

    const { session, documents, droppedClipCount } = parseSessionFile(json);

    expect(documents).toHaveLength(0);
    expect(session.tracks[0].clips).toHaveLength(0);
    expect(droppedClipCount).toBe(1);

    const freshId = nextId('doc');
    expect(Number(freshId.split('-')[1])).toBeGreaterThan(77);
  });
});
