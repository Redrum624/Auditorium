import { act, render, screen } from '@testing-library/react';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { decodeArrayBuffer } from '../../audio/decodeAudio';
import { dropFilesOnTrack } from '../../multitrack/laneDrop';
import { useSessionStore } from '../../multitrack/sessionStore';
import { setSessionLaneWidth } from '../../multitrack/sessionViewport';
import {
  SESSION_UNDO_KEY,
  _resetSessionUndo,
  undoSession,
} from '../../multitrack/sessionUndo';
import { _resetPendingOpens } from '../../services/openProgress';
import { _resetSnapPreference, setSnapEnabled } from '../../services/snapPreference';
import { getHistory } from '../../services/undoHistory';
import { makeInitialState, useAppStore } from '../../stores/appStore';
import MultitrackView from './MultitrackView';

/**
 * Task F11-4, the Explorer half — a file dragged out of the OS and dropped on
 * a lane.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS ACTUALLY PROVING
 * ---------------------------------------------------------------------------
 * That the drop is not a second importer. The only thing mocked below is the
 * DECODE (`decodeArrayBuffer`, as `fileService.test.ts` mocks it — jsdom has
 * no OfflineAudioContext) and the Electron bridge. `fileService.openFilePath`
 * itself runs for real, which is what makes the rollback assertions meaningful:
 * when the decode throws, the document that open had already added is taken
 * back out BY THE OPEN PATH, not by anything this feature wrote.
 *
 * The drag events are hand-built MouseEvents carrying a stub `dataTransfer` —
 * jsdom implements neither `DragEvent` nor `DataTransfer`. See the long note in
 * `TrackLane.drop.test.tsx`; the stub here additionally carries `files`, the
 * only part of an OS drag that matters.
 *
 * ---------------------------------------------------------------------------
 * WHAT jsdom CANNOT PROVE
 * ---------------------------------------------------------------------------
 * That a real Explorer drag produces a File whose path `webUtils.getPathForFile`
 * can resolve. That call lives in the preload (`pathForFile`), needs a genuine
 * OS drag to have happened, and is stubbed here. Everything downstream of "the
 * path is known" is real; the bridge itself is smoke-test territory.
 */

jest.mock('../../audio/decodeAudio', () => ({ decodeArrayBuffer: jest.fn() }));
const mockDecode = decodeArrayBuffer as jest.MockedFunction<typeof decodeArrayBuffer>;

// MT1-1: 512 was the session store's hardcoded default mtZoom; it is now the
// scale this file PINS via the lane measurement in beforeEach (an EMPTY session
// fits the 60 s placeholder timeline, so the lane width that makes that fit
// exactly 512 samples/px is 60 * rate / 512). Every pixel number below is
// therefore unchanged.
const SPP = 512;
const SESSION_RATE = 44_100;
/** 4 samples per decoded file (see `decoded()`), at the session rate. */
const FILE_LENGTH = 4;

interface StubDataTransfer {
  readonly types: string[];
  files: File[];
  dropEffect: string;
  effectAllowed: string;
  getData(type: string): string;
}

function filesDataTransfer(files: File[]): StubDataTransfer {
  return {
    types: ['Files'],
    files,
    dropEffect: 'none',
    effectAllowed: 'all',
    getData: () => '',
  };
}

function fireDrag(
  element: Element,
  type: 'dragenter' | 'dragover' | 'drop',
  dt: StubDataTransfer,
  init: { clientX?: number } = {}
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: 0,
  });
  Object.defineProperty(event, 'dataTransfer', { value: dt });
  act(() => {
    element.dispatchEvent(event);
  });
}

interface MockApi {
  readFile: jest.Mock;
  showMessageBox: jest.Mock;
  pathForFile: jest.Mock;
  pathBasename: (p: string) => string;
}

let api: MockApi;
/** Maps the stub File objects to the paths a real drag would resolve to. */
let paths: Map<File, string>;

function dropped(name: string, path = `D:\\audio\\${name}`): File {
  const file = new File([], name);
  paths.set(file, path);
  return file;
}

function installApi(): void {
  api = {
    readFile: jest.fn(async () => new ArrayBuffer(8)),
    showMessageBox: jest.fn(async () => 0),
    // F11 fix round (C1): ASYNC, because the real one is — the preload now
    // registers the dropped path as read-approved in main and only then
    // resolves. A synchronous stub would let a drop that never awaits the
    // approval pass this suite while every real drop is refused by the
    // `file:read` gate, which is exactly the bug that shipped.
    pathForFile: jest.fn(async (f: File) => paths.get(f) ?? null),
    pathBasename: (p: string) => p.split(/[\\/]/).pop() ?? p,
  };
  (window as unknown as { electronAPI: MockApi }).electronAPI = api;
}

const docs = () => useAppStore.getState().documents;
const clips = () => useSessionStore.getState().session.tracks.flatMap((t) => t.clips);
const doneLabels = () => getHistory(SESSION_UNDO_KEY).done;
const trackId = (i: number) => useSessionStore.getState().session.tracks[i].id;
const refusals = () => api.showMessageBox.mock.calls.map((c) => c[0] as { message: string });

/** A document already open and active, with a cursor a failed open must not
 * disturb — the view state `rollbackOpen` is responsible for restoring. */
function openExisting(): AudioDocument {
  const existing = createDocument({
    name: 'already-open.wav',
    sampleRate: SESSION_RATE,
    channels: [new Float32Array(1_000)],
  });
  useAppStore.getState().addDocument(existing);
  useAppStore.getState().setCursor(777);
  return existing;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  setSessionLaneWidth((60 * SESSION_RATE) / SPP);
  useSessionStore.getState().newSession(SESSION_RATE);
  _resetPendingOpens();
  _resetSnapPreference();
  setSnapEnabled(false); // the magnet has its own tests; this file is about importing
  jest.clearAllMocks();
  paths = new Map();
  installApi();
  mockDecode.mockResolvedValue({
    channels: [new Float32Array(FILE_LENGTH), new Float32Array(FILE_LENGTH)],
    sampleRate: SESSION_RATE,
  });
  _resetSessionUndo();
});

afterEach(() => {
  _resetSnapPreference();
});

describe('an audio file dropped on a lane', () => {
  it('is imported through the REAL open path and placed at the drop position', async () => {
    await act(async () => {
      await dropFilesOnTrack([dropped('song.wav')], trackId(1), 50_000);
    });

    // The open pipeline ran: it read the file and decoded it.
    expect(api.readFile).toHaveBeenCalledWith('D:\\audio\\song.wav');
    expect(mockDecode).toHaveBeenCalledTimes(1);
    expect(docs()).toHaveLength(1);
    expect(docs()[0].name).toBe('song.wav');
    expect(docs()[0].filePath).toBe('D:\\audio\\song.wav'); // .wav keeps its path

    const placed = clips();
    expect(placed).toHaveLength(1);
    expect(placed[0].documentId).toBe(docs()[0].id);
    expect(placed[0].startSample).toBe(50_000);
    expect(placed[0].lengthSample).toBe(FILE_LENGTH);
    expect(useSessionStore.getState().session.tracks[1].clips).toHaveLength(1);
    expect(doneLabels()).toEqual(['Add clip']);
    expect(refusals()).toHaveLength(0);
  });

  it('lands on the lane the drop actually hit, through the lane s own handlers', async () => {
    render(<MultitrackView />);
    const lane = screen.getAllByTestId('track-lane')[2];
    const dt = filesDataTransfer([dropped('song.wav')]);

    fireDrag(lane, 'dragenter', dt);
    fireDrag(lane, 'dragover', dt, { clientX: 100 });
    expect(dt.dropEffect).toBe('copy'); // the lane accepted an OS file drag
    expect(lane.style.backgroundColor).not.toBe('transparent');

    fireDrag(lane, 'drop', dt, { clientX: 100 });
    // The import is async; let the open promise settle.
    await act(async () => {
      await Promise.resolve();
    });

    const tracks = useSessionStore.getState().session.tracks;
    expect(tracks.map((t) => t.clips.length)).toEqual([0, 0, 1, 0]);
    expect(tracks[2].clips[0].startSample).toBe(100 * SPP);
  });

  it('lays several dropped files end to end as ONE undoable edit', async () => {
    await act(async () => {
      await dropFilesOnTrack([dropped('a.wav'), dropped('b.wav')], trackId(0), 1_000);
    });

    expect(docs()).toHaveLength(2);
    expect(clips().map((c) => c.startSample)).toEqual([1_000, 1_000 + FILE_LENGTH]);
    expect(doneLabels()).toEqual(['Add clips']);

    act(() => undoSession());
    expect(clips()).toHaveLength(0); // one Ctrl+Z lifts the whole drop
  });
});

describe('a drop the open path refuses', () => {
  it('refuses a non-audio file politely, without reading a byte of it', async () => {
    await act(async () => {
      await dropFilesOnTrack([dropped('notes.txt')], trackId(0), 1_000);
    });

    expect(api.readFile).not.toHaveBeenCalled();
    expect(mockDecode).not.toHaveBeenCalled();
    expect(docs()).toHaveLength(0);
    expect(clips()).toHaveLength(0);
    expect(doneLabels()).toEqual([]);
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0].message).toContain('notes.txt');
    expect(refusals()[0].message).toContain('Not an audio file');
  });

  it('adds nothing when the decode fails', async () => {
    const existing = openExisting();
    mockDecode.mockRejectedValueOnce(new Error('unsupported codec'));

    await act(async () => {
      await dropFilesOnTrack([dropped('broken.wav')], trackId(0), 1_000);
    });

    expect(api.readFile).toHaveBeenCalledWith('D:\\audio\\broken.wav');
    expect(docs().map((d: AudioDocument) => d.id)).toEqual([existing.id]);
    expect(clips()).toHaveLength(0);
    expect(doneLabels()).toEqual([]);
    expect(refusals()[0].message).toContain('unsupported codec');
  });

  it('leaves NO half state when the open dies AFTER adding — the open path s own rollback', async () => {
    // The decode failure above never reaches `addDocument`, so it does not
    // exercise `rollbackOpen` at all. This one does: the open gets far enough
    // to add the document and then dies writing its markers, which is the
    // exact shape rollbackOpen exists for — a document added, selected, and
    // then abandoned. Nothing here rolls anything back; `openFilePath` does,
    // and the drop inherits it by calling that function and no other.
    const existing = openExisting();
    mockDecode.mockResolvedValueOnce({
      channels: [new Float32Array(FILE_LENGTH)],
      sampleRate: SESSION_RATE,
      markers: [{ name: 'Cue 1', positionSample: 2 }],
    });
    useAppStore.setState({
      setMarkersForDoc: () => {
        throw new Error('marker write failed');
      },
    });

    await act(async () => {
      await dropFilesOnTrack([dropped('half.wav')], trackId(0), 1_000);
    });

    // The half-added document was taken back out, and the view it displaced
    // was put back — active document, cursor and all.
    expect(docs().map((d: AudioDocument) => d.id)).toEqual([existing.id]);
    expect(useAppStore.getState().activeDocumentId).toBe(existing.id);
    expect(useAppStore.getState().cursorSample).toBe(777);
    expect(clips()).toHaveLength(0);
    expect(doneLabels()).toEqual([]);
    expect(refusals()[0].message).toContain('marker write failed');
  });

  it('refuses a file whose path cannot be resolved', async () => {
    const orphan = new File([], 'ghost.wav'); // never registered in `paths`
    await act(async () => {
      await dropFilesOnTrack([orphan], trackId(0), 1_000);
    });

    expect(api.readFile).not.toHaveBeenCalled();
    expect(clips()).toHaveLength(0);
    expect(refusals()[0].message).toContain('ghost.wav');
  });

  it('keeps the rest of a mixed drop, exactly as the Open dialog does', async () => {
    await act(async () => {
      await dropFilesOnTrack([dropped('notes.txt'), dropped('good.wav')], trackId(0), 2_000);
    });

    expect(refusals()).toHaveLength(1);
    expect(docs().map((d: AudioDocument) => d.name)).toEqual(['good.wav']);
    expect(clips()).toHaveLength(1);
    expect(clips()[0].startSample).toBe(2_000);
    expect(doneLabels()).toEqual(['Add clip']);
  });
});
