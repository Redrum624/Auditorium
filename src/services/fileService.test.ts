import {
  openFilesViaDialog,
  openFilePath,
  saveDocument,
  exportDocument,
  newDocument,
  closeDocumentFlow,
  getInFlightSaveCount,
  projectDirtyCount,
  projectHasContent,
  projectHasUnsavedWork,
  exportSessionMixdown,
} from './fileService';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { useSessionStore } from '../multitrack/sessionStore';
import { _resetSessionUndo } from '../multitrack/sessionUndo';
import { createClip } from '../multitrack/session';
import { mixdownSession } from '../multitrack/mixdown';
import * as wavCodec from '../audio/wavCodec';
import { docLength, createDocument } from '../audio/AudioDocument';
import { decodeArrayBuffer, type DecodedAudio } from '../audio/decodeAudio';
import { encodeMp3 } from '../audio/mp3Encoder';
import { encodeFlac } from '../audio/flacEncoder';
import { encodeOggOpus, OggEncoderUnavailableError } from '../audio/oggOpusEncoder';
import { decodeWav } from '../audio/wavCodec';
import { buildId3Chapters } from '../audio/id3Chapters';
import { buildChapterComments, buildVorbisCommentPayload } from '../audio/chapterTags';
import { muxOpusStream } from '../audio/oggPage';
import * as undoHistory from './undoHistory';
import { setEditorLaneWidth, _resetEditorLaneWidth } from './editorViewport';
import { _resetPendingOpens, getPendingOpens } from './openProgress';
import { pushMarkerUndo, deleteSelection, rippleDeleteSelection } from './editOps';
import * as peaksCache from './peaksCache';
import { playbackEngine } from '../audio/PlaybackEngine';
import { captureNoiseProfile, clearNoiseProfile, getNoiseProfile } from './noiseProfile';
import * as tempoAnalysis from './tempoAnalysis';
import { runTempoAnalysis, getTempo, clearAllTempo } from './tempoAnalysis';
import { createRemixDocument, getRemixSession, clearAllRemix as clearAllRemixSessions } from './remixService';

// Decode is mocked so file-service tests never touch OfflineAudioContext/lamejs.
// The MP3/FLAC encoders are mocked to spy on the format-faithful save routing
// without exercising the (separately-tested) encoders on every routing case.
jest.mock('../audio/decodeAudio', () => ({ decodeArrayBuffer: jest.fn() }));
jest.mock('../audio/mp3Encoder', () => ({ encodeMp3: jest.fn(() => new ArrayBuffer(2048)) }));
jest.mock('../audio/flacEncoder', () => ({ encodeFlac: jest.fn(() => new ArrayBuffer(4096)) }));
// The Opus encoder needs WebCodecs (absent under jsdom); mock it to spy on the
// save/export routing while keeping a REAL typed error class so the fallback
// path's `instanceof OggEncoderUnavailableError` check resolves correctly.
jest.mock('../audio/oggOpusEncoder', () => {
  class OggEncoderUnavailableError extends Error {
    constructor(message = 'unavailable') {
      super(message);
      this.name = 'OggEncoderUnavailableError';
    }
  }
  return {
    encodeOggOpus: jest.fn(async () => new Uint8Array([0x4f, 0x67, 0x67, 0x53])), // 'OggS'
    OggEncoderUnavailableError,
  };
});

const mockDecode = decodeArrayBuffer as jest.MockedFunction<typeof decodeArrayBuffer>;
const mockEncodeMp3 = encodeMp3 as jest.MockedFunction<typeof encodeMp3>;
const mockEncodeFlac = encodeFlac as jest.MockedFunction<typeof encodeFlac>;
const mockEncodeOgg = encodeOggOpus as jest.MockedFunction<typeof encodeOggOpus>;

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
    readFile: jest.fn(async () => new ArrayBuffer(8)),
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

function decoded(sampleRate = 44100, channelCount = 2, length = 4) {
  return {
    channels: Array.from({ length: channelCount }, () => new Float32Array(length)),
    sampleRate,
  };
}

/** Build a minimal (but structurally valid) fake `.flac` buffer: 'fLaC' magic
 * + a dummy 34-byte STREAMINFO block + a VORBIS_COMMENT block carrying
 * `markers` (via the real, unmocked `chapterTags.ts`). Decode is mocked in
 * this file, so the STREAMINFO payload's actual contents are never read for
 * audio — only `readFlacVorbisComment`/`parseChapterComments` (also real and
 * unmocked) walk this buffer, exactly as `openFilePath` does for a real file. */
function buildFakeFlacWithMarkers(markers: { positionSample: number; name: string }[], sampleRate: number): ArrayBuffer {
  const comments = buildChapterComments(markers, sampleRate);
  const payload = buildVorbisCommentPayload('audition_app', comments);
  const streamInfo = new Uint8Array(34);
  const vcHeader = new Uint8Array([0x84, (payload.length >> 16) & 0xff, (payload.length >> 8) & 0xff, payload.length & 0xff]);
  const out = new Uint8Array(4 + 4 + streamInfo.length + vcHeader.length + payload.length);
  let offset = 0;
  out.set([0x66, 0x4c, 0x61, 0x43], offset); // 'fLaC'
  offset += 4;
  out.set([0x00, 0x00, 0x00, 0x22], offset); // STREAMINFO header: not-last, type 0, len 34
  offset += 4;
  out.set(streamInfo, offset);
  offset += streamInfo.length;
  out.set(vcHeader, offset);
  offset += vcHeader.length;
  out.set(payload, offset);
  return out.buffer;
}

/** Build a minimal but real Ogg Opus bitstream (via the real, unmocked
 * `oggPage.ts` `muxOpusStream` — only `oggOpusEncoder.ts` is mocked in this
 * file) carrying `markers` as an OpusTags block (Task K5). No audio packets
 * are needed since decode is mocked; `openFilePath` only reads the tags via
 * `readOpusTags`/`parseChapterComments` (also real and unmocked). */
function buildFakeOggWithMarkers(markers: { positionSample: number; name: string }[], fileSampleRate: number): ArrayBuffer {
  const comments = buildChapterComments(markers, fileSampleRate);
  const stream = muxOpusStream({
    serial: 1,
    channelCount: 2,
    preSkip: 312,
    inputSampleRate: fileSampleRate,
    packets: [],
    vendor: 'audition_app',
    comments,
  });
  return stream.buffer.slice(stream.byteOffset, stream.byteOffset + stream.byteLength) as ArrayBuffer;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  jest.clearAllMocks();
  // Lot A: the project (session store + its history + its path) is module-
  // global too; Save is a project save now, so every test starts from an
  // empty, never-written, clean project.
  useSessionStore.getState().newSession(44100);
  useSessionStore.getState().setProjectPath(null);
  _resetSessionUndo();
  // Module-level state: a test that resizes the lane must not leave it resized
  // for the next one, whose zoom expectations are written for the 1600 px
  // fallback.
  _resetEditorLaneWidth();
  mockDecode.mockResolvedValue(decoded());
  mockEncodeMp3.mockReturnValue(new ArrayBuffer(2048));
  mockEncodeFlac.mockReturnValue(new ArrayBuffer(4096));
  mockEncodeOgg.mockResolvedValue(new Uint8Array([0x4f, 0x67, 0x67, 0x53]));
});

afterAll(() => {
  _resetEditorLaneWidth();
});

describe('openFilePath', () => {
  it('reads, decodes, and adds a doc — .wav keeps its filePath', async () => {
    const api = installApi();
    await openFilePath('D:\\audio\\song.wav');
    const state = useAppStore.getState();
    expect(api.readFile).toHaveBeenCalledWith('D:\\audio\\song.wav');
    expect(state.documents).toHaveLength(1);
    expect(state.documents[0].name).toBe('song.wav');
    expect(state.documents[0].filePath).toBe('D:\\audio\\song.wav');
    expect(state.activeDocumentId).toBe(state.documents[0].id);
  });

  it('R6 wiring: a decoded channelMask lands on the document; an absent one stays absent', async () => {
    installApi();
    mockDecode.mockResolvedValueOnce({ ...decoded(44100, 6), channelMask: 0x3f });
    await openFilePath('D:\\audio\\surround.wav');
    mockDecode.mockResolvedValueOnce(decoded(44100, 6));
    await openFilePath('D:\\audio\\unmasked.wav');
    const [masked, unmasked] = useAppStore.getState().documents;
    expect(masked.channelMask).toBe(0x3f);
    expect(unmasked.channelMask).toBeUndefined();
  });

  it('keeps the filePath and tags sourceFormat for round-trippable mp3/flac sources', async () => {
    installApi();
    await openFilePath('D:\\audio\\clip.mp3');
    await openFilePath('D:\\audio\\track.flac');
    const [mp3, flac] = useAppStore.getState().documents;
    expect(mp3.filePath).toBe('D:\\audio\\clip.mp3');
    expect(mp3.sourceFormat).toBe('mp3');
    expect(flac.filePath).toBe('D:\\audio\\track.flac');
    expect(flac.sourceFormat).toBe('flac');
  });

  it('keeps the filePath for .ogg sources (in-place Opus re-encode) and tags sourceFormat', async () => {
    installApi();
    await openFilePath('D:\\audio\\voice.ogg');
    const [ogg] = useAppStore.getState().documents;
    expect(ogg.filePath).toBe('D:\\audio\\voice.ogg');
    expect(ogg.sourceFormat).toBe('ogg');
  });

  it('gives other/exotic sources a null filePath (Save falls back to save-as WAV)', async () => {
    installApi();
    await openFilePath('D:\\audio\\clip.m4a');
    const [other] = useAppStore.getState().documents;
    expect(other.filePath).toBeNull();
    expect(other.sourceFormat).toBe('other');
  });

  it('records the source bit depth from a decoded WAV', async () => {
    installApi();
    mockDecode.mockResolvedValueOnce({ ...decoded(), sourceBitDepth: 24 });
    await openFilePath('D:\\audio\\song.wav');
    expect(useAppStore.getState().documents[0].sourceBitDepth).toBe(24);
  });

  it('seeds appStore markers from a decoded WAV, with fresh marker ids', async () => {
    installApi();
    mockDecode.mockResolvedValueOnce({
      ...decoded(44100, 2, 10000),
      markers: [
        { name: 'Verse', positionSample: 500 },
        { name: 'Intro', positionSample: 10 },
      ],
    });
    await openFilePath('D:\\audio\\song.wav');
    const docId = useAppStore.getState().documents[0].id;
    const markers = useAppStore.getState().markers[docId];
    expect(markers).toHaveLength(2);
    expect(markers.map((m) => m.positionSample)).toEqual([10, 500]); // kept sorted
    expect(markers.map((m) => m.name)).toEqual(['Intro', 'Verse']);
    for (const m of markers) {
      expect(m.id).toMatch(/^marker-\d+$/);
    }
    expect(new Set(markers.map((m) => m.id)).size).toBe(2); // distinct ids
  });

  it('does not create a markers entry when the decoded WAV has none', async () => {
    installApi();
    mockDecode.mockResolvedValueOnce({ ...decoded(), markers: [] });
    await openFilePath('D:\\audio\\song.wav');
    const docId = useAppStore.getState().documents[0].id;
    expect(useAppStore.getState().markers[docId]).toBeUndefined();
  });

  it('clamps WAV cue marker positions parsed from an out-of-range cue point to [0, docLength]', async () => {
    installApi();
    mockDecode.mockResolvedValueOnce({
      ...decoded(44100, 2, 100), // doc length = 100 samples
      markers: [{ name: 'TooFar', positionSample: 999_999 }],
    });

    await openFilePath('D:\\audio\\song.wav');

    const docId = useAppStore.getState().documents[0].id;
    const markers = useAppStore.getState().markers[docId];
    expect(markers).toHaveLength(1);
    expect(markers[0].positionSample).toBe(100); // clamped to docLength
  });

  it('seeds appStore markers from an MP3\'s ID3v2 chapter tag (K3), with fresh marker ids', async () => {
    const tag = buildId3Chapters(
      [
        { positionSample: 500, name: 'Verse' },
        { positionSample: 10, name: 'Intro' },
      ],
      44100
    );
    const fileBytes = new Uint8Array(tag.length);
    fileBytes.set(tag, 0);
    installApi({ readFile: jest.fn(async () => fileBytes.buffer) });
    mockDecode.mockResolvedValueOnce(decoded(44100, 2, 10000));

    await openFilePath('D:\\audio\\song.mp3');

    const docId = useAppStore.getState().documents[0].id;
    const markers = useAppStore.getState().markers[docId];
    expect(markers).toHaveLength(2);
    expect(markers.map((m) => m.positionSample)).toEqual([10, 500]); // kept sorted
    expect(markers.map((m) => m.name)).toEqual(['Intro', 'Verse']);
    for (const m of markers) {
      expect(m.id).toMatch(/^marker-\d+$/);
    }
    expect(new Set(markers.map((m) => m.id)).size).toBe(2);
  });

  it('does not create a markers entry for an MP3 with no ID3 chapter tag', async () => {
    installApi({ readFile: jest.fn(async () => new ArrayBuffer(8)) });
    mockDecode.mockResolvedValueOnce(decoded());

    await openFilePath('D:\\audio\\song.mp3');

    const docId = useAppStore.getState().documents[0].id;
    expect(useAppStore.getState().markers[docId]).toBeUndefined();
  });

  it('clamps MP3 marker positions parsed from a corrupt/out-of-range tag to [0, docLength]', async () => {
    // Round-trip a legit tag but exercise the clamp path via an out-of-range
    // exact sample (larger than the decoded doc's length).
    const tag = buildId3Chapters([{ positionSample: 999_999, name: 'TooFar' }], 44100);
    const fileBytes = new Uint8Array(tag.length);
    fileBytes.set(tag, 0);
    installApi({ readFile: jest.fn(async () => fileBytes.buffer) });
    mockDecode.mockResolvedValueOnce(decoded(44100, 2, 100)); // doc length = 100 samples

    await openFilePath('D:\\audio\\song.mp3');

    const docId = useAppStore.getState().documents[0].id;
    const markers = useAppStore.getState().markers[docId];
    expect(markers).toHaveLength(1);
    expect(markers[0].positionSample).toBe(100); // clamped to docLength
  });

  it("seeds appStore markers from a FLAC's VORBIS_COMMENT tag (K4), with fresh marker ids", async () => {
    const fileBytes = buildFakeFlacWithMarkers(
      [
        { positionSample: 500, name: 'Verse' },
        { positionSample: 10, name: 'Intro' },
      ],
      44100
    );
    installApi({ readFile: jest.fn(async () => fileBytes) });
    mockDecode.mockResolvedValueOnce(decoded(44100, 2, 10000));

    await openFilePath('D:\\audio\\track.flac');

    const docId = useAppStore.getState().documents[0].id;
    const markers = useAppStore.getState().markers[docId];
    expect(markers).toHaveLength(2);
    expect(markers.map((m) => m.positionSample)).toEqual([10, 500]); // kept sorted
    expect(markers.map((m) => m.name)).toEqual(['Intro', 'Verse']);
    for (const m of markers) {
      expect(m.id).toMatch(/^marker-\d+$/);
    }
    expect(new Set(markers.map((m) => m.id)).size).toBe(2);
  });

  it('does not create a markers entry for a FLAC with no VORBIS_COMMENT tag', async () => {
    installApi({ readFile: jest.fn(async () => new ArrayBuffer(8)) });
    mockDecode.mockResolvedValueOnce(decoded());

    await openFilePath('D:\\audio\\track.flac');

    const docId = useAppStore.getState().documents[0].id;
    expect(useAppStore.getState().markers[docId]).toBeUndefined();
  });

  it('clamps FLAC marker positions parsed from an out-of-range tag to [0, docLength]', async () => {
    const fileBytes = buildFakeFlacWithMarkers([{ positionSample: 999_999, name: 'TooFar' }], 44100);
    installApi({ readFile: jest.fn(async () => fileBytes) });
    mockDecode.mockResolvedValueOnce(decoded(44100, 2, 100)); // doc length = 100 samples

    await openFilePath('D:\\audio\\track.flac');

    const docId = useAppStore.getState().documents[0].id;
    const markers = useAppStore.getState().markers[docId];
    expect(markers).toHaveLength(1);
    expect(markers[0].positionSample).toBe(100); // clamped to docLength
  });

  it("seeds appStore markers from an OGG's OpusTags tag (K5), with fresh marker ids", async () => {
    const fileBytes = buildFakeOggWithMarkers(
      [
        { positionSample: 500, name: 'Verse' },
        { positionSample: 10, name: 'Intro' },
      ],
      48000
    );
    installApi({ readFile: jest.fn(async () => fileBytes) });
    // Real Ogg Opus opens always decode at 48 kHz.
    mockDecode.mockResolvedValueOnce(decoded(48000, 2, 10000));

    await openFilePath('D:\\audio\\voice.ogg');

    const docId = useAppStore.getState().documents[0].id;
    const markers = useAppStore.getState().markers[docId];
    expect(markers).toHaveLength(2);
    expect(markers.map((m) => m.positionSample)).toEqual([10, 500]); // kept sorted
    expect(markers.map((m) => m.name)).toEqual(['Intro', 'Verse']);
    for (const m of markers) {
      expect(m.id).toMatch(/^marker-\d+$/);
    }
    expect(new Set(markers.map((m) => m.id)).size).toBe(2);
  });

  it('does not create a markers entry for an OGG with no OpusTags comments', async () => {
    installApi({ readFile: jest.fn(async () => new ArrayBuffer(8)) });
    mockDecode.mockResolvedValueOnce(decoded(48000, 2, 10000));

    await openFilePath('D:\\audio\\voice.ogg');

    const docId = useAppStore.getState().documents[0].id;
    expect(useAppStore.getState().markers[docId]).toBeUndefined();
  });

  it('clamps OGG marker positions parsed from an out-of-range tag to [0, docLength]', async () => {
    const fileBytes = buildFakeOggWithMarkers([{ positionSample: 999_999, name: 'TooFar' }], 48000);
    installApi({ readFile: jest.fn(async () => fileBytes) });
    mockDecode.mockResolvedValueOnce(decoded(48000, 2, 100)); // doc length = 100 samples

    await openFilePath('D:\\audio\\voice.ogg');

    const docId = useAppStore.getState().documents[0].id;
    const markers = useAppStore.getState().markers[docId];
    expect(markers).toHaveLength(1);
    expect(markers[0].positionSample).toBe(100); // clamped to docLength
  });
});

// The incident: a decode died part-way through opening the second of two large
// files, and the app was left with a document that was added, selected, and
// undrawable, and a window that answered nothing. An open that cannot finish
// has to leave the app exactly as it found it.
describe('openFilePath — a failed open leaves nothing behind (O1-1)', () => {
  afterEach(() => {
    _resetPendingOpens();
  });

  it('adds no document when the DECODE throws', async () => {
    installApi();
    mockDecode.mockRejectedValueOnce(new Error('out of memory'));

    await expect(openFilePath('D:\\audio\\huge.wav')).rejects.toThrow('out of memory');

    expect(useAppStore.getState().documents).toEqual([]);
    expect(useAppStore.getState().activeDocumentId).toBeNull();
  });

  it('adds no document when the READ throws', async () => {
    installApi({ readFile: jest.fn(async () => { throw new Error('EACCES'); }) });

    await expect(openFilePath('D:\\audio\\locked.wav')).rejects.toThrow('EACCES');

    expect(useAppStore.getState().documents).toEqual([]);
  });

  /** A decoded result whose marker seeding throws — the marker pass runs AFTER
   * `addDocument`, so this is the shape that can leave a half-added document.
   * The throw is planted on the marker list itself rather than on a store
   * action: zustand copies state objects field by field, so a spy installed on
   * a store action survives `mockRestore` into every later state object and
   * poisons the rest of the file. */
  function decodedWithFailingMarkers(message: string) {
    return {
      ...decoded(),
      markers: {
        length: 1,
        map() {
          throw new Error(message);
        },
      } as unknown as NonNullable<DecodedAudio['markers']>,
    };
  }

  it('rolls the document back out when a failure lands AFTER it was added', async () => {
    installApi();
    mockDecode.mockResolvedValueOnce(decodedWithFailingMarkers('marker seeding exploded'));

    await expect(openFilePath('D:\\audio\\song.wav')).rejects.toThrow('marker seeding exploded');

    expect(useAppStore.getState().documents).toEqual([]);
    expect(useAppStore.getState().activeDocumentId).toBeNull();
  });

  it('leaves an ALREADY-OPEN document untouched and active when the next open fails', async () => {
    // The real shape of the incident: one file open and fine, the second one
    // dies. The survivor must still be there, still active, still drawable.
    installApi();
    await openFilePath('D:\\audio\\first.wav');
    const firstId = useAppStore.getState().documents[0].id;

    mockDecode.mockRejectedValueOnce(new Error('out of memory'));
    await expect(openFilePath('D:\\audio\\second.wav')).rejects.toThrow('out of memory');

    const state = useAppStore.getState();
    expect(state.documents).toHaveLength(1);
    expect(state.documents[0].id).toBe(firstId);
    expect(state.activeDocumentId).toBe(firstId);
    expect(state.documents[0].channels[0].length).toBeGreaterThan(0);
  });

  it('restores the document that WAS active, not whichever one is last (R1)', async () => {
    // `closeDocument` re-activates `documents[min(index, len-1)]` — the last
    // survivor, which is only coincidentally the one that was active. Three
    // documents with the FIRST one active is the arrangement where the two
    // answers differ; a single prior document cannot tell them apart.
    installApi();
    await openFilePath('D:\\audio\\a.wav');
    await openFilePath('D:\\audio\\b.wav');
    await openFilePath('D:\\audio\\c.wav');
    const [a, b, c] = useAppStore.getState().documents;
    useAppStore.getState().setActiveDocument(a.id);
    expect(useAppStore.getState().activeDocumentId).toBe(a.id);

    // The failure has to land AFTER `addDocument` — that is the only path that
    // reaches the rollback at all.
    mockDecode.mockResolvedValueOnce(decodedWithFailingMarkers('marker seeding exploded'));
    await expect(openFilePath('D:\\audio\\d.wav')).rejects.toThrow('marker seeding exploded');

    const state = useAppStore.getState();
    expect(state.documents.map((d) => d.id)).toEqual([a.id, b.id, c.id]);
    expect(state.activeDocumentId).toBe(a.id);
  });

  it('restores the selection, cursor and zoom the failed open reset (R1)', async () => {
    // `addDocument` clears all three on its way in, so "the documents already
    // open are untouched" is only true if they come back. The zoom seeded here
    // is LEGAL for `a` at the fallback 1600 px lane (10 000 samples at 4 spp
    // shows 6 400, so scroll may run to 3 600), which is what makes this a test
    // of the restore rather than of the clamp — the clamp has its own below.
    installApi();
    mockDecode.mockResolvedValueOnce(decoded(44100, 2, 10_000));
    await openFilePath('D:\\audio\\a.wav');
    await openFilePath('D:\\audio\\b.wav');
    const [a] = useAppStore.getState().documents;
    useAppStore.getState().setActiveDocument(a.id);
    useAppStore.getState().setSelection({ start: 10, end: 40 });
    useAppStore.getState().setCursor(25);
    useAppStore.getState().setZoom({ samplesPerPixel: 4, scrollSample: 8 });

    mockDecode.mockResolvedValueOnce(decodedWithFailingMarkers('marker seeding exploded'));
    await expect(openFilePath('D:\\audio\\c.wav')).rejects.toThrow();

    const state = useAppStore.getState();
    expect(state.activeDocumentId).toBe(a.id);
    expect(state.selection).toEqual({ start: 10, end: 40 });
    expect(state.cursorSample).toBe(25);
    expect(state.zoom).toEqual({ samplesPerPixel: 4, scrollSample: 8 });
  });

  it('CLAMPS the restored zoom against the lane the user is looking at now (M3)', async () => {
    // The seventh door onto the F11-9 symptom. `rollbackOpen` restored the
    // snapshot with a raw `setZoom`, which is the one writer that skips
    // `resolveZoom` — so a scroll that was legal when the snapshot was taken
    // came back unchecked however the world had moved underneath it.
    //
    // The move that does it is a lane RESIZE during the decode, which is a
    // realistic several-hundred-millisecond window: a panel card opening or the
    // window being dragged wider both change `editorLaneWidth`. A WIDER lane
    // shows more of the document, so `maxScroll` SHRINKS — the snapshot's
    // scroll is now past an end the waveform cannot follow, and the beat tics
    // and the ruler slide off it.
    //
    // Kills the mutation `applyEditorZoom(before.zoom)` -> `setZoom(before.zoom)`.
    installApi();
    mockDecode.mockResolvedValueOnce(decoded(44100, 2, 10_000));
    await openFilePath('D:\\audio\\a.wav');
    const [a] = useAppStore.getState().documents;
    useAppStore.getState().setActiveDocument(a.id);
    // Legal at 1600 px: maxScroll = 10 000 - 1600*4 = 3 600, exactly the end.
    useAppStore.getState().setZoom({ samplesPerPixel: 4, scrollSample: 3_600 });

    mockDecode.mockImplementationOnce(async () => {
      // The editor lane gets wider while the decode is in flight. At 2400 px
      // the same 4 spp shows 9 600 samples, so maxScroll drops to 400.
      setEditorLaneWidth(2_400);
      return decodedWithFailingMarkers('marker seeding exploded');
    });
    await expect(openFilePath('D:\\audio\\b.wav')).rejects.toThrow();

    const state = useAppStore.getState();
    expect(state.activeDocumentId).toBe(a.id);
    expect(state.zoom.samplesPerPixel).toBe(4); // the zoom LEVEL is carried through
    expect(state.zoom.scrollSample).toBe(400); // not the snapshot's 3 600
  });

  it('leaves the store alone when the previously-active document is gone', async () => {
    // Nothing in the app closes a document mid-open today, but the restore
    // must not resurrect an id that no longer exists or strand a selection on
    // nothing.
    installApi();
    await openFilePath('D:\\audio\\a.wav');
    const [a] = useAppStore.getState().documents;

    mockDecode.mockImplementationOnce(async () => {
      // Closed after the snapshot was taken, before the rollback needs it.
      useAppStore.getState().closeDocument(a.id);
      return decodedWithFailingMarkers('marker seeding exploded');
    });
    await expect(openFilePath('D:\\audio\\b.wav')).rejects.toThrow();

    const state = useAppStore.getState();
    expect(state.documents).toEqual([]);
    expect(state.activeDocumentId).toBeNull();
  });

  it('releases the history and peak caches of the rolled-back document', async () => {
    installApi();
    const clearHistorySpy = jest.spyOn(undoHistory, 'clearHistory');
    const invalidatePeaksSpy = jest.spyOn(peaksCache, 'invalidatePeaks');
    mockDecode.mockResolvedValueOnce(decodedWithFailingMarkers('marker seeding exploded'));

    await expect(openFilePath('D:\\audio\\song.wav')).rejects.toThrow();

    expect(clearHistorySpy).toHaveBeenCalled();
    expect(invalidatePeaksSpy).toHaveBeenCalled();
    clearHistorySpy.mockRestore();
    invalidatePeaksSpy.mockRestore();
  });

  it('reports the failing file by name, once, and keeps opening the rest', async () => {
    // openFilesViaDialog's per-file catch is what turns the throw above into
    // the one dialog the user sees.
    const api = installApi({
      showOpenDialog: jest.fn(async () => ['D:\\audio\\bad.wav', 'D:\\audio\\good.wav']),
    });
    mockDecode.mockRejectedValueOnce(new Error('out of memory'));

    await openFilesViaDialog();

    expect(api.showMessageBox).toHaveBeenCalledTimes(1);
    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        title: 'Open failed',
        message: expect.stringContaining('D:\\audio\\bad.wav'),
      })
    );
    const state = useAppStore.getState();
    expect(state.documents).toHaveLength(1);
    expect(state.documents[0].name).toBe('good.wav');
  });
});

// `decodeArrayBuffer` CONSUMES the bytes it is given — transferred into the
// decode worker, or detached by `decodeAudioData` — so every container-metadata
// read in openFilePath has to happen BEFORE it. That ordering is load-bearing
// and invisible: a decode double that merely resolves leaves the buffer
// readable, so moving any of those reads back below the decode passes the whole
// suite and then throws TypeError on the first real FLAC/MP3/OGG open.
//
// These tests give the decode mock the real contract — it detaches what it is
// handed, the way the worker mock now does — so the ordering is checked rather
// than assumed.
describe('openFilePath — container metadata is read BEFORE the decode consumes the bytes (R3)', () => {
  // M1: every test below is only a test of the ORDERING while the environment
  // can really detach an ArrayBuffer. `consumingDecodeOnce` tries
  // `ArrayBuffer.prototype.transfer` and falls back to `structuredClone`; on a
  // toolchain carrying NEITHER, both branches are skipped, the buffer stays
  // fully readable, and all five tests below pass while measuring nothing —
  // metadata reads could migrate back under the decode and this suite would
  // still be green, which is the exact regression it exists to catch.
  //
  // So the detach is recorded and asserted per test. A defanged toolchain now
  // fails here, loudly and by name, instead of quietly turning this block into
  // decoration.
  let detachedByDecode: boolean | null = null;

  beforeEach(() => {
    detachedByDecode = null;
  });

  afterEach(() => {
    expect(detachedByDecode).toBe(true);
  });

  /** Detach `buf` the way a transfer does, then resolve `value`. */
  function consumingDecodeOnce(value: DecodedAudio) {
    mockDecode.mockImplementationOnce(async (buf: ArrayBuffer) => {
      const withTransfer = buf as ArrayBuffer & { transfer?: () => ArrayBuffer };
      if (typeof withTransfer.transfer === 'function') withTransfer.transfer();
      else if (typeof structuredClone === 'function') structuredClone(buf, { transfer: [buf] });
      // Recorded, not asserted inline: `openFilePath` rolls back and rethrows
      // whatever the decode throws, so an `expect` raised in here would reach
      // the test as an open failure rather than as this assertion.
      detachedByDecode = buf.byteLength === 0;
      return value;
    });
  }

  it('the environment can actually detach a buffer — the premise of this block', () => {
    // The canary. If this is the only red test in the block, the toolchain lost
    // its detach primitive and the other four are no longer measuring ordering.
    const probe = new ArrayBuffer(8);
    const withTransfer = probe as ArrayBuffer & { transfer?: () => ArrayBuffer };
    expect(
      typeof withTransfer.transfer === 'function' || typeof structuredClone === 'function'
    ).toBe(true);

    if (typeof withTransfer.transfer === 'function') withTransfer.transfer();
    else structuredClone(probe, { transfer: [probe] });

    expect(probe.byteLength).toBe(0);
    detachedByDecode = true; // this test detaches its own probe, not a decode
  });

  it('a WAV opens when the decode detaches the bytes', async () => {
    installApi();
    consumingDecodeOnce(decoded());

    await openFilePath('D:\\audio\\song.wav');

    expect(useAppStore.getState().documents).toHaveLength(1);
  });

  /** The shared FLAC fixture carries an all-zero STREAMINFO, which
   * `readFlacStreamInfo` correctly rejects (a zero sample rate is not a rate).
   * Fill in the four bytes it actually reads — file offsets 18-21, i.e.
   * STREAMINFO's packed 20-bit rate / 3-bit channel count / 5-bit
   * bits-per-sample-minus-one — so a REAL depth comes back and the assertion
   * below can only pass if the read happened while the bytes were still there.
   */
  function flacWithStreamInfo(sampleRate: number, channels: number, bitDepth: number): ArrayBuffer {
    const buf = buildFakeFlacWithMarkers([], sampleRate);
    const b = new Uint8Array(buf);
    const bps = bitDepth - 1;
    b[18] = sampleRate >> 12;
    b[19] = (sampleRate >> 4) & 0xff;
    b[20] = ((sampleRate & 0x0f) << 4) | ((channels - 1) << 1) | (bps >> 4);
    b[21] = (bps & 0x0f) << 4;
    return buf;
  }

  it('a FLAC still gets its source bit depth (readFlacStreamInfo)', async () => {
    // Read from the file's STREAMINFO block, which only exists while the bytes
    // do.
    const fileBytes = flacWithStreamInfo(44100, 2, 24);
    installApi({ readFile: jest.fn(async () => fileBytes) });
    consumingDecodeOnce(decoded());

    await openFilePath('D:\\audio\\track.flac');

    const doc = useAppStore.getState().documents[0];
    expect(doc.sourceFormat).toBe('flac');
    expect(doc.sourceBitDepth).toBe(24);
  });

  it('a FLAC still gets its chapter markers (readFlacVorbisComment)', async () => {
    const fileBytes = buildFakeFlacWithMarkers(
      [{ positionSample: 10, name: 'Intro' }, { positionSample: 500, name: 'Verse' }],
      44100
    );
    installApi({ readFile: jest.fn(async () => fileBytes) });
    consumingDecodeOnce(decoded(44100, 2, 10000));

    await openFilePath('D:\\audio\\track.flac');

    const docId = useAppStore.getState().documents[0].id;
    expect(useAppStore.getState().markers[docId].map((m) => m.name)).toEqual(['Intro', 'Verse']);
  });

  it('an MP3 still gets its ID3 chapters (parseId3Chapters)', async () => {
    const tag = buildId3Chapters([{ positionSample: 4410, name: 'Hook' }], 44100);
    const fileBytes = new Uint8Array(tag.length);
    fileBytes.set(tag, 0);
    installApi({ readFile: jest.fn(async () => fileBytes.buffer) });
    consumingDecodeOnce(decoded(44100, 2, 44100));

    await openFilePath('D:\\audio\\clip.mp3');

    const docId = useAppStore.getState().documents[0].id;
    expect(useAppStore.getState().markers[docId].map((m) => m.name)).toEqual(['Hook']);
  });

  it('an OGG still gets its Opus tag chapters (readOpusTags)', async () => {
    const fileBytes = buildFakeOggWithMarkers([{ positionSample: 48, name: 'Drop' }], 48000);
    installApi({ readFile: jest.fn(async () => fileBytes) });
    consumingDecodeOnce(decoded(48000, 2, 48000));

    await openFilePath('D:\\audio\\voice.ogg');

    const docId = useAppStore.getState().documents[0].id;
    expect(useAppStore.getState().markers[docId].map((m) => m.name)).toEqual(['Drop']);
  });
});

describe('openFilePath — the Files panel is told an open is in flight (O1-1)', () => {
  afterEach(() => {
    _resetPendingOpens();
  });

  it('lists the file while it decodes and drops it when the document lands', async () => {
    let releaseDecode!: () => void;
    installApi();
    mockDecode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDecode = () => resolve(decoded());
        })
    );

    const opening = openFilePath('D:\\audio\\song.wav');
    await Promise.resolve(); // let the read settle and the decode start

    expect(getPendingOpens().map((p) => p.name)).toEqual(['song.wav']);
    expect(getPendingOpens()[0].path).toBe('D:\\audio\\song.wav');
    // Still no document — the row is the ONLY thing telling the user anything
    // is happening.
    expect(useAppStore.getState().documents).toEqual([]);

    releaseDecode();
    await opening;

    expect(getPendingOpens()).toEqual([]);
    expect(useAppStore.getState().documents).toHaveLength(1);
  });

  it('drops the entry when the open FAILS, so no row is left spinning forever', async () => {
    installApi();
    mockDecode.mockRejectedValueOnce(new Error('out of memory'));

    await expect(openFilePath('D:\\audio\\huge.wav')).rejects.toThrow();

    expect(getPendingOpens()).toEqual([]);
  });

  it('tracks two concurrent opens independently', async () => {
    installApi();
    let releaseFirst!: () => void;
    mockDecode.mockImplementationOnce(
      () => new Promise((resolve) => { releaseFirst = () => resolve(decoded()); })
    );
    const first = openFilePath('D:\\audio\\one.wav');
    await Promise.resolve();
    const second = openFilePath('D:\\audio\\two.wav');
    await Promise.resolve();

    expect(getPendingOpens().map((p) => p.name).sort()).toEqual(['one.wav', 'two.wav']);

    await second;
    expect(getPendingOpens().map((p) => p.name)).toEqual(['one.wav']);

    releaseFirst();
    await first;
    expect(getPendingOpens()).toEqual([]);
  });
});

describe('openFilesViaDialog', () => {
  it('opens every picked file and activates the last', async () => {
    installApi({ showOpenDialog: jest.fn(async () => ['D:\\a.wav', 'D:\\b.wav']) });
    await openFilesViaDialog();
    const state = useAppStore.getState();
    expect(state.documents.map((d) => d.name)).toEqual(['a.wav', 'b.wav']);
    expect(state.activeDocumentId).toBe(state.documents[1].id);
  });

  it('is a no-op when the dialog is cancelled', async () => {
    const api = installApi({ showOpenDialog: jest.fn(async () => null) });
    await openFilesViaDialog();
    expect(useAppStore.getState().documents).toHaveLength(0);
    expect(api.readFile).not.toHaveBeenCalled();
  });

  it('reports a decode failure and continues with the other files', async () => {
    const api = installApi({ showOpenDialog: jest.fn(async () => ['D:\\bad.wav', 'D:\\good.wav']) });
    mockDecode
      .mockRejectedValueOnce(new Error('corrupt'))
      .mockResolvedValueOnce(decoded());
    await openFilesViaDialog();
    expect(useAppStore.getState().documents.map((d) => d.name)).toEqual(['good.wav']);
    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' })
    );
  });
});

// ---------------------------------------------------------------------------
// The abab fixture (Task T13) — recipe copied verbatim from
// `remixFeatures.test.ts`, this repo's convention being that local generators
// are re-declared per test file. Only the two remix-session close tests use
// it, and it is memoised because generating 64 s of audio is not free.
// ---------------------------------------------------------------------------

let ababCache: Float32Array | null = null;
function abab(): Float32Array {
  if (ababCache) return ababCache;
  const SR = 44100;
  const BEAT = Math.round((60 / 120) * SR); // 22050
  const BAR = BEAT * 4; // 88200
  const SECTION_LEN = BAR * 8;
  const structure: ('A' | 'B')[] = ['A', 'B', 'A', 'B'];
  const preRollLen = BAR;
  const totalLen = preRollLen + structure.length * SECTION_LEN;
  const out = new Float32Array(totalLen);
  const freqA = [220, 330];
  const freqB = [440, 554.365];
  for (let i = 0; i < preRollLen; i++) {
    const t = i / SR;
    let v = 0;
    for (const f of freqA) v += Math.sin(2 * Math.PI * f * t);
    out[i] += 0.25 * v;
  }
  structure.forEach((label, si) => {
    const start = preRollLen + si * SECTION_LEN;
    const freqs = label === 'A' ? freqA : freqB;
    for (let i = 0; i < SECTION_LEN; i++) {
      const t = i / SR;
      let v = 0;
      for (const f of freqs) v += Math.sin(2 * Math.PI * f * t);
      out[start + i] += 0.25 * v;
    }
  });
  let s0 = 12345;
  const rand = () => {
    s0 = (s0 * 1103515245 + 12345) & 0x7fffffff;
    return s0 / 0x7fffffff - 0.5;
  };
  const clickLen = Math.round(0.005 * SR);
  const clickWin = new Float32Array(clickLen);
  for (let i = 0; i < clickLen; i++) {
    clickWin[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, clickLen - 1)));
  }
  let beatIdx = -4;
  for (let s = 0; s < totalLen; s += BEAT, beatIdx++) {
    const gain = ((beatIdx % 4) + 4) % 4 === 0 ? 2 : 1;
    for (let i = 0; i < clickLen && s + i < totalLen; i++) out[s + i] += gain * clickWin[i] * rand();
  }
  ababCache = out;
  return out;
}

function seedDoc(opts: {
  filePath: string | null;
  dirty?: boolean;
  name?: string;
  sourceFormat?: ReturnType<typeof createDocument>['sourceFormat'];
  sourceBitDepth?: number;
  /** Task S4 — defaults (as createDocument does) to "true when there is no
   * filePath". Set explicitly to model a path-less document whose audio IS on
   * disk (an exotic source, a .audm-embedded document). */
  neverSaved?: boolean;
}) {
  const doc = createDocument({
    name: opts.name ?? 'doc',
    sampleRate: 44100,
    channels: [new Float32Array(10), new Float32Array(10)],
    filePath: opts.filePath,
    sourceFormat: opts.sourceFormat,
    sourceBitDepth: opts.sourceBitDepth,
    neverSaved: opts.neverSaved,
  });
  useAppStore.getState().addDocument(doc);
  if (opts.dirty) useAppStore.getState().updateDocument({ ...doc, dirty: true });
  return useAppStore.getState().documents[0];
}

describe('saveDocument', () => {
  it('writes a valid 32-bit-float WAV straight to an existing .wav path and clears dirty', async () => {
    const api = installApi();
    const doc = seedDoc({ filePath: 'D:\\audio\\song.wav', dirty: true, name: 'song.wav' });

    await saveDocument(doc.id);

    expect(api.showSaveDialog).not.toHaveBeenCalled();
    expect(api.writeFile).toHaveBeenCalledTimes(1);
    const [path, data] = api.writeFile.mock.calls[0];
    expect(path).toBe('D:\\audio\\song.wav');
    // The bytes must be a real WAV round-tripping to the original rate.
    const decodedBack = decodeWav(data as ArrayBuffer);
    expect(decodedBack.sampleRate).toBe(44100);
    expect(decodedBack.bitDepth).toBe(32);
    expect(useAppStore.getState().documents[0].dirty).toBe(false);
  });

  it('prompts save-as when there is no filePath and updates name/filePath', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\new.wav') });
    const doc = seedDoc({ filePath: null, dirty: true, name: 'Untitled 1' });

    await saveDocument(doc.id);

    expect(api.showSaveDialog).toHaveBeenCalledTimes(1);
    expect(api.writeFile).toHaveBeenCalledWith('D:\\out\\new.wav', expect.any(ArrayBuffer));
    const saved = useAppStore.getState().documents[0];
    expect(saved.filePath).toBe('D:\\out\\new.wav');
    expect(saved.name).toBe('new.wav');
    expect(saved.dirty).toBe(false);
  });

  it('re-encodes an MP3 source in place at 192 kbps (no save-as dialog)', async () => {
    const api = installApi();
    const doc = seedDoc({
      filePath: 'D:\\audio\\clip.mp3',
      dirty: true,
      name: 'clip.mp3',
      sourceFormat: 'mp3',
    });

    await saveDocument(doc.id);

    expect(api.showSaveDialog).not.toHaveBeenCalled();
    expect(mockEncodeMp3).toHaveBeenCalledWith(doc.channels, 44100, 192, undefined);
    expect(mockEncodeFlac).not.toHaveBeenCalled();
    expect(api.writeFile).toHaveBeenCalledWith('D:\\audio\\clip.mp3', expect.any(ArrayBuffer));
    expect(useAppStore.getState().documents[0].dirty).toBe(false);
  });

  it('passes the active doc markers into encodeMp3 when saving an MP3 in place (K3)', async () => {
    installApi();
    const doc = seedDoc({
      filePath: 'D:\\audio\\clip.mp3',
      dirty: true,
      name: 'clip.mp3',
      sourceFormat: 'mp3',
    });
    useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Chorus', positionSample: 3 });

    await saveDocument(doc.id);

    expect(mockEncodeMp3).toHaveBeenCalledWith(doc.channels, 44100, 192, [
      { id: 'marker-1', name: 'Chorus', positionSample: 3 },
    ]);
  });

  it('re-encodes a FLAC source in place at the source bit depth', async () => {
    const api = installApi();
    const doc = seedDoc({
      filePath: 'D:\\audio\\track.flac',
      dirty: true,
      name: 'track.flac',
      sourceFormat: 'flac',
      sourceBitDepth: 24,
    });

    await saveDocument(doc.id);

    expect(api.showSaveDialog).not.toHaveBeenCalled();
    expect(mockEncodeFlac).toHaveBeenCalledWith(doc.channels, 44100, 24, undefined);
    expect(api.writeFile).toHaveBeenCalledWith('D:\\audio\\track.flac', expect.any(ArrayBuffer));
  });

  it('re-encodes a 16-bit FLAC source at 16-bit (default when depth is not above 16)', async () => {
    installApi();
    const doc = seedDoc({
      filePath: 'D:\\audio\\track.flac',
      // O1-2: a plain Save on a clean saved document is a no-op now, so this
      // test states the edit its subject (the in-place encode routing)
      // presupposes. Its sibling above already did.
      dirty: true,
      name: 'track.flac',
      sourceFormat: 'flac',
      sourceBitDepth: 16,
    });

    await saveDocument(doc.id);

    expect(mockEncodeFlac).toHaveBeenCalledWith(doc.channels, 44100, 16, undefined);
  });

  it('rounds a 20-bit FLAC source UP to 24-bit instead of truncating to 16 (F20)', async () => {
    installApi();
    const doc = seedDoc({
      filePath: 'D:\\audio\\track.flac',
      dirty: true, // see the sibling above (O1-2)
      name: 'track.flac',
      sourceFormat: 'flac',
      sourceBitDepth: 20,
    });

    await saveDocument(doc.id);

    expect(mockEncodeFlac).toHaveBeenCalledWith(doc.channels, 44100, 24, undefined);
  });

  it('passes the active doc markers into encodeFlac when saving a FLAC in place (K4)', async () => {
    installApi();
    const doc = seedDoc({
      filePath: 'D:\\audio\\track.flac',
      dirty: true,
      name: 'track.flac',
      sourceFormat: 'flac',
      sourceBitDepth: 24,
    });
    useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Hook', positionSample: 9 });

    await saveDocument(doc.id);

    expect(mockEncodeFlac).toHaveBeenCalledWith(doc.channels, 44100, 24, [
      { id: 'marker-1', name: 'Hook', positionSample: 9 },
    ]);
  });

  it('re-encodes an OGG source in place via encodeOggOpus (no save-as dialog)', async () => {
    const api = installApi();
    const doc = seedDoc({
      filePath: 'D:\\audio\\voice.ogg',
      dirty: true,
      name: 'voice.ogg',
      sourceFormat: 'ogg',
    });

    await saveDocument(doc.id);

    expect(api.showSaveDialog).not.toHaveBeenCalled();
    expect(mockEncodeOgg).toHaveBeenCalledWith(doc.channels, 44100, undefined, undefined);
    expect(api.writeFile).toHaveBeenCalledWith('D:\\audio\\voice.ogg', expect.any(ArrayBuffer));
    expect(useAppStore.getState().documents[0].dirty).toBe(false);
  });

  it('passes the active doc markers into encodeOggOpus when saving an OGG in place (K5)', async () => {
    installApi();
    const doc = seedDoc({
      filePath: 'D:\\audio\\voice.ogg',
      dirty: true,
      name: 'voice.ogg',
      sourceFormat: 'ogg',
    });
    useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Hook', positionSample: 9 });

    await saveDocument(doc.id);

    expect(mockEncodeOgg).toHaveBeenCalledWith(doc.channels, 44100, undefined, [
      { id: 'marker-1', name: 'Hook', positionSample: 9 },
    ]);
  });

  it('falls back to save-as WAV when the Opus encoder is unavailable', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\voice.wav') });
    mockEncodeOgg.mockRejectedValueOnce(new OggEncoderUnavailableError());
    const doc = seedDoc({
      filePath: 'D:\\audio\\voice.ogg',
      dirty: true,
      name: 'voice.ogg',
      sourceFormat: 'ogg',
    });

    await saveDocument(doc.id);

    expect(api.showSaveDialog).toHaveBeenCalledTimes(1);
    // The .ogg was NOT written; a real 32-bit WAV went to the picked path.
    const [path, data] = api.writeFile.mock.calls[0];
    expect(path).toBe('D:\\out\\voice.wav');
    expect(decodeWav(data as ArrayBuffer).bitDepth).toBe(32);
    const saved = useAppStore.getState().documents[0];
    expect(saved.filePath).toBe('D:\\out\\voice.wav');
    expect(saved.sourceFormat).toBe('wav'); // retagged so a later Save writes WAV
    expect(saved.dirty).toBe(false);
  });

  it('forces save-as when as=true even with an existing .wav path', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\copy.wav') });
    const doc = seedDoc({ filePath: 'D:\\audio\\song.wav', dirty: true, name: 'song.wav' });

    await saveDocument(doc.id, true);

    expect(api.showSaveDialog).toHaveBeenCalledTimes(1);
    expect(api.writeFile).toHaveBeenCalledWith('D:\\out\\copy.wav', expect.any(ArrayBuffer));
  });

  it('is a no-op when the save-as dialog is cancelled', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => null) });
    const doc = seedDoc({ filePath: null, dirty: true });

    await saveDocument(doc.id);

    expect(api.writeFile).not.toHaveBeenCalled();
    expect(useAppStore.getState().documents[0].dirty).toBe(true);
  });

  it('includes the active doc markers when saving in place to WAV', async () => {
    const api = installApi();
    const doc = seedDoc({ filePath: 'D:\\audio\\song.wav', dirty: true, name: 'song.wav' });
    useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Chorus', positionSample: 3 });

    await saveDocument(doc.id);

    const [, data] = api.writeFile.mock.calls[0];
    const decodedBack = decodeWav(data as ArrayBuffer);
    expect(decodedBack.markers).toEqual([{ name: 'Chorus', positionSample: 3 }]);
  });

  it('includes the active doc markers when saving-as to WAV', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\new.wav') });
    const doc = seedDoc({ filePath: null, dirty: true, name: 'Untitled 1' });
    useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Hook', positionSample: 7 });

    await saveDocument(doc.id);

    const [, data] = api.writeFile.mock.calls[0];
    const decodedBack = decodeWav(data as ArrayBuffer);
    expect(decodedBack.markers).toEqual([{ name: 'Hook', positionSample: 7 }]);
  });

  it('writes remapped marker positions after a destructive edit (Task M3 / F4)', async () => {
    const api = installApi();
    const doc = seedDoc({ filePath: 'D:\\audio\\song.wav', dirty: true, name: 'song.wav' });
    useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Chorus', positionSample: 8 });
    useAppStore.getState().setSelection({ start: 2, end: 5 }); // delete 3 samples

    rippleDeleteSelection(); // marker at 8 (>= e=5) shifts left by (e-s)=3 -> 5

    await saveDocument(doc.id);

    const [, data] = api.writeFile.mock.calls[0];
    const decodedBack = decodeWav(data as ArrayBuffer);
    expect(decodedBack.markers).toEqual([{ name: 'Chorus', positionSample: 5 }]);
  });

  it('writes the cue where it was after an equal-length Delete (item 7 / N6)', async () => {
    const api = installApi();
    const doc = seedDoc({ filePath: 'D:\\audio\\song.wav', dirty: true, name: 'song.wav' });
    useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Chorus', positionSample: 8 });
    useAppStore.getState().setSelection({ start: 2, end: 5 });

    deleteSelection(); // zero-fills [2,5) in place: the timeline did not move

    await saveDocument(doc.id);

    const [, data] = api.writeFile.mock.calls[0];
    const decodedBack = decodeWav(data as ArrayBuffer);
    expect(decodedBack.markers).toEqual([{ name: 'Chorus', positionSample: 8 }]);
  });

  it('retags sourceBitDepth to 32 after an in-place WAV save of a 16-bit source (F14)', async () => {
    installApi();
    const doc = seedDoc({
      filePath: 'D:\\audio\\song.wav',
      dirty: true,
      name: 'song.wav',
      sourceFormat: 'wav',
      sourceBitDepth: 16,
    });

    await saveDocument(doc.id);

    const saved = useAppStore.getState().documents[0];
    expect(saved.sourceBitDepth).toBe(32);
    expect(saved.sourceFormat).toBe('wav');
    expect(saved.dirty).toBe(false);
  });

  it('retags an undefined-provenance WAV in-place save to sourceFormat wav / bitDepth 32 (F14)', async () => {
    installApi();
    // Mirrors the pre-existing "writes a valid 32-bit-float WAV..." test above:
    // seedDoc with no sourceFormat/sourceBitDepth still routes through the
    // encodeInPlace default (WAV) branch, so it must retag the same way.
    const doc = seedDoc({ filePath: 'D:\\audio\\song.wav', dirty: true, name: 'song.wav' });

    await saveDocument(doc.id);

    const saved = useAppStore.getState().documents[0];
    expect(saved.sourceBitDepth).toBe(32);
    expect(saved.sourceFormat).toBe('wav');
  });

  it('does not retag sourceBitDepth for an in-place MP3 save (F14 scope)', async () => {
    installApi();
    const doc = seedDoc({
      filePath: 'D:\\audio\\clip.mp3',
      dirty: true,
      name: 'clip.mp3',
      sourceFormat: 'mp3',
    });

    await saveDocument(doc.id);

    const saved = useAppStore.getState().documents[0];
    expect(saved.sourceFormat).toBe('mp3');
    expect(saved.sourceBitDepth).toBeUndefined();
  });

  it('defaults the save-as filename by replacing the extension, not appending (F21)', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => null) }); // cancel; just inspect defaultPath
    const doc = seedDoc({ filePath: null, dirty: true, name: 'song.mp3' });

    await saveDocument(doc.id);

    expect(api.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'song.wav' })
    );
  });

  it('appends .wav to a non-wav path returned by the save-as dialog and retags provenance (F21)', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\take.flac') });
    const doc = seedDoc({ filePath: null, dirty: true, name: 'take' });

    await saveDocument(doc.id);

    expect(api.writeFile).toHaveBeenCalledWith('D:\\out\\take.flac.wav', expect.any(ArrayBuffer));
    const saved = useAppStore.getState().documents[0];
    expect(saved.filePath).toBe('D:\\out\\take.flac.wav');
    expect(saved.name).toBe('take.flac.wav');
    expect(saved.sourceFormat).toBe('wav');
  });

  it('shows an error and keeps dirty when the write fails', async () => {
    const api = installApi({
      writeFile: jest.fn(async () => ({ ok: false, error: 'disk full' })),
      showMessageBox: jest.fn(async () => 1), // Cancel the Save As offer
    });
    const doc = seedDoc({ filePath: 'D:\\audio\\song.wav', dirty: true, name: 'song.wav' });

    await saveDocument(doc.id);

    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'disk full' })
    );
    expect(useAppStore.getState().documents[0].dirty).toBe(true);
  });
});

// `file.save` on a document with nothing to save is not a cheap no-op: it
// re-encodes every sample and overwrites the source file, and for a 16/24-bit
// WAV it retags the document as 32-bit float on the way. The incident's first
// run did exactly that to a CLEAN document, from a gesture the user never
// aimed at Save. Two gates: the command's `enabled` (menuActions) and this
// one, for any caller that reaches past the registry.
describe('saveDocument — a clean document is a no-op (O1-2)', () => {
  function live(docId: string) {
    return useAppStore.getState().documents.find((d) => d.id === docId);
  }

  it('does not encode, write, or prompt for a CLEAN saved document', async () => {
    const api = installApi();
    const doc = seedDoc({ filePath: 'D:\\audio\\song.wav', dirty: false, name: 'song.wav' });

    await saveDocument(doc.id);

    expect(api.writeFile).not.toHaveBeenCalled();
    expect(api.showSaveDialog).not.toHaveBeenCalled();
    expect(api.showMessageBox).not.toHaveBeenCalled();
  });

  it('leaves a clean 24-bit WAV document tagged as 24-bit', async () => {
    // The retag is the quiet half of the damage: an in-place Save writes a
    // 32-bit-float WAV whatever the source depth was, and updates the document
    // to say so. On a document nobody edited, Properties would start reporting
    // a different file than the one that was opened.
    installApi();
    const doc = seedDoc({
      filePath: 'D:\\audio\\song.wav',
      dirty: false,
      name: 'song.wav',
      sourceFormat: 'wav',
      sourceBitDepth: 24,
    });

    await saveDocument(doc.id);

    expect(live(doc.id)!.sourceBitDepth).toBe(24);
    expect(live(doc.id)!.sourceFormat).toBe('wav');
  });

  it('still saves a DIRTY document', async () => {
    const api = installApi();
    const doc = seedDoc({ filePath: 'D:\\audio\\song.wav', dirty: true, name: 'song.wav' });

    await saveDocument(doc.id);

    expect(api.writeFile).toHaveBeenCalledWith('D:\\audio\\song.wav', expect.any(ArrayBuffer));
    expect(live(doc.id)!.dirty).toBe(false);
  });

  it('still saves a clean NEVER-SAVED document (a computed document has no file yet)', async () => {
    // Mix Down / Remix N / a recording / a stem: created with no undo entry, so
    // CLEAN from the moment it exists, and yet the whole thing exists nowhere
    // on disk. `hasUnsavedWork` covers both, which is why the gate uses it
    // rather than `dirty`.
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\Remix 1.wav') });
    const doc = seedDoc({ filePath: null, dirty: false, name: 'Remix 1' });
    expect(doc.neverSaved).toBe(true);

    await saveDocument(doc.id);

    expect(api.writeFile).toHaveBeenCalledWith('D:\\out\\Remix 1.wav', expect.any(ArrayBuffer));
    expect(live(doc.id)!.neverSaved).toBe(false);
  });

  it('SAVE AS on a clean document still writes — it is an explicit gesture', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\copy.wav') });
    const doc = seedDoc({ filePath: 'D:\\audio\\song.wav', dirty: false, name: 'song.wav' });

    await saveDocument(doc.id, true);

    expect(api.showSaveDialog).toHaveBeenCalledTimes(1);
    expect(api.writeFile).toHaveBeenCalledWith('D:\\out\\copy.wav', expect.any(ArrayBuffer));
    expect(live(doc.id)!.filePath).toBe('D:\\out\\copy.wav');
  });
});

// A denied write is the dead end the incident ended in: "Write denied
// (protected directory)" with one button, on a save the user never asked for.
// The error text is the right text — it names the real reason — but a modal
// that states a policy and offers nothing is not a way out. The way out of a
// refused location is a different location.
describe('saveDocument — a denied write offers Save As (O1-3)', () => {
  function live(docId: string) {
    return useAppStore.getState().documents.find((d) => d.id === docId);
  }

  it('offers Save As alongside Cancel when the IN-PLACE write is denied', async () => {
    const api = installApi({
      writeFile: jest.fn(async () => ({ ok: false, error: 'Write denied (protected directory)' })),
      showMessageBox: jest.fn(async () => 1),
    });
    const doc = seedDoc({ filePath: 'D:\\protected\\song.wav', dirty: true, name: 'song.wav' });

    await saveDocument(doc.id);

    expect(api.showMessageBox).toHaveBeenCalledWith({
      type: 'error',
      title: 'Save failed',
      // The write layer's own reason, unchanged.
      message: 'Write denied (protected directory)',
      buttons: ['Save As…', 'Cancel'],
      // Enter must not start a save-as flow on a box the user did not ask for.
      defaultId: 1,
    });
  });

  it('IN-PLACE + "Save As…" runs the save-as flow and lands the file elsewhere', async () => {
    const api = installApi({
      // The document's own path is refused; anything else succeeds.
      writeFile: jest.fn(async (p: string) =>
        p === 'D:\\protected\\song.wav'
          ? { ok: false, error: 'Write denied (protected directory)' }
          : { ok: true }
      ),
      showSaveDialog: jest.fn(async () => 'D:\\music\\song.wav'),
      showMessageBox: jest.fn(async () => 0), // Save As…
    });
    const doc = seedDoc({ filePath: 'D:\\protected\\song.wav', dirty: true, name: 'song.wav' });

    await saveDocument(doc.id);

    expect(api.showSaveDialog).toHaveBeenCalledTimes(1);
    expect(api.writeFile).toHaveBeenLastCalledWith('D:\\music\\song.wav', expect.any(ArrayBuffer));
    const saved = live(doc.id)!;
    expect(saved.filePath).toBe('D:\\music\\song.wav');
    expect(saved.dirty).toBe(false);
  });

  it('IN-PLACE + "Cancel" leaves the document exactly as it was', async () => {
    const api = installApi({
      writeFile: jest.fn(async () => ({ ok: false, error: 'Write denied (protected directory)' })),
      showSaveDialog: jest.fn(async () => 'D:\\music\\song.wav'),
      showMessageBox: jest.fn(async () => 1), // Cancel
    });
    const doc = seedDoc({ filePath: 'D:\\protected\\song.wav', dirty: true, name: 'song.wav' });

    await saveDocument(doc.id);

    expect(api.showSaveDialog).not.toHaveBeenCalled();
    const after = live(doc.id)!;
    expect(after.filePath).toBe('D:\\protected\\song.wav');
    expect(after.dirty).toBe(true);
  });

  it('offers Save As alongside Cancel when the SAVE-AS write is denied', async () => {
    const api = installApi({
      showSaveDialog: jest.fn(async () => 'D:\\protected\\Remix 1.wav'),
      writeFile: jest.fn(async () => ({ ok: false, error: 'EACCES' })),
      showMessageBox: jest.fn(async () => 1),
    });
    const doc = seedDoc({ filePath: null, dirty: true, name: 'Remix 1' });

    await saveDocument(doc.id);

    expect(api.showMessageBox).toHaveBeenCalledWith({
      type: 'error',
      title: 'Save failed',
      message: 'EACCES',
      buttons: ['Save As…', 'Cancel'],
      // Enter must not start a save-as flow on a box the user did not ask for.
      defaultId: 1,
    });
  });

  it('SAVE-AS + "Save As…" re-prompts, and the second location sticks', async () => {
    // The second turn of the loop: the user picks a directory that is also
    // refused, then one that is not. Nothing recursed — the stack is flat
    // however many locations they try.
    const api = installApi({
      showSaveDialog: jest
        .fn()
        .mockResolvedValueOnce('D:\\protected\\Remix 1.wav')
        .mockResolvedValueOnce('D:\\music\\Remix 1.wav'),
      writeFile: jest.fn(async (p: string) =>
        p.startsWith('D:\\protected\\') ? { ok: false, error: 'EACCES' } : { ok: true }
      ),
      showMessageBox: jest.fn(async () => 0), // Save As…
    });
    const doc = seedDoc({ filePath: null, dirty: true, name: 'Remix 1' });

    await saveDocument(doc.id);

    expect(api.showSaveDialog).toHaveBeenCalledTimes(2);
    expect(api.showMessageBox).toHaveBeenCalledTimes(1);
    const saved = live(doc.id)!;
    expect(saved.filePath).toBe('D:\\music\\Remix 1.wav');
    expect(saved.dirty).toBe(false);
    expect(saved.neverSaved).toBe(false);
  });

  it('SAVE-AS + "Cancel" stops after one attempt', async () => {
    const api = installApi({
      showSaveDialog: jest.fn(async () => 'D:\\protected\\Remix 1.wav'),
      writeFile: jest.fn(async () => ({ ok: false, error: 'EACCES' })),
      showMessageBox: jest.fn(async () => 1), // Cancel
    });
    const doc = seedDoc({ filePath: null, dirty: true, name: 'Remix 1' });

    await saveDocument(doc.id);

    expect(api.showSaveDialog).toHaveBeenCalledTimes(1);
    expect(api.writeFile).toHaveBeenCalledTimes(1);
    const after = live(doc.id)!;
    expect(after.filePath).toBeNull();
    expect(after.dirty).toBe(true);
  });
});

describe('saveDocument — markSavePoint wiring (Task M2 / F9)', () => {
  it('marks the save point after a successful in-place save', async () => {
    installApi();
    const doc = seedDoc({ filePath: 'D:\\audio\\song.wav', dirty: true, name: 'song.wav' });
    const spy = jest.spyOn(undoHistory, 'markSavePoint');

    await saveDocument(doc.id);

    expect(spy).toHaveBeenCalledWith(doc.id);
  });

  it('marks the save point after a successful save-as', async () => {
    installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\new.wav') });
    const doc = seedDoc({ filePath: null, dirty: true, name: 'Untitled 1' });
    const spy = jest.spyOn(undoHistory, 'markSavePoint');

    await saveDocument(doc.id);

    expect(spy).toHaveBeenCalledWith(doc.id);
  });

  it('does not mark the save point when the write fails', async () => {
    installApi({ writeFile: jest.fn(async () => ({ ok: false, error: 'disk full' })) });
    const doc = seedDoc({ filePath: 'D:\\audio\\song.wav', dirty: true, name: 'song.wav' });
    const spy = jest.spyOn(undoHistory, 'markSavePoint');

    await saveDocument(doc.id);

    expect(spy).not.toHaveBeenCalled();
  });

  it('does not mark the save point when the save-as dialog is cancelled', async () => {
    installApi({ showSaveDialog: jest.fn(async () => null) });
    const doc = seedDoc({ filePath: null, dirty: true });
    const spy = jest.spyOn(undoHistory, 'markSavePoint');

    await saveDocument(doc.id);

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('saveDocument — async in-place save races (Task H1)', () => {
  function controllableEncode(): { resolve: (bytes: Uint8Array) => void; reject: (err: unknown) => void } {
    let resolveFn!: (bytes: Uint8Array) => void;
    let rejectFn!: (err: unknown) => void;
    mockEncodeOgg.mockImplementationOnce(
      () =>
        new Promise<Uint8Array>((res, rej) => {
          resolveFn = res;
          rejectFn = rej;
        })
    );
    // Wrap in closures so callers can hold the returned object before
    // mockEncodeOgg has actually been invoked (resolveFn/rejectFn are only
    // assigned once the Promise executor runs, at call time).
    return {
      resolve: (bytes) => resolveFn(bytes),
      reject: (err) => rejectFn(err),
    };
  }

  it('keeps a mid-save edit\'s newer channels and dirty flag; the file still receives the pre-edit snapshot bytes', async () => {
    const api = installApi();
    const doc = seedDoc({
      filePath: 'D:\\audio\\voice.ogg',
      dirty: true,
      name: 'voice.ogg',
      sourceFormat: 'ogg',
    });
    const { resolve } = controllableEncode();

    const savePromise = saveDocument(doc.id);

    // Simulate an edit landing while the encode is in flight: every edit
    // replaces the store's doc object with a fresh one (AudioDocument.ts).
    const editedChannels = [new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6])];
    const edited = { ...useAppStore.getState().documents[0], channels: editedChannels, dirty: true };
    useAppStore.getState().updateDocument(edited);

    resolve(new Uint8Array([0x4f, 0x67, 0x67, 0x53]));
    await savePromise;

    const live = useAppStore.getState().documents[0];
    expect(live.channels).toBe(editedChannels); // newer channels preserved, not clobbered
    expect(live.dirty).toBe(true); // stays dirty — disk holds an older snapshot
    expect(api.writeFile).toHaveBeenCalledTimes(1);
  });

  it('does not mark the save point when a mid-save edit fails the staleness check (Task M2)', async () => {
    const doc = seedDoc({
      filePath: 'D:\\audio\\voice.ogg',
      dirty: true,
      name: 'voice.ogg',
      sourceFormat: 'ogg',
    });
    const spy = jest.spyOn(undoHistory, 'markSavePoint');
    const { resolve } = controllableEncode();

    const savePromise = saveDocument(doc.id);
    const edited = { ...useAppStore.getState().documents[0], channels: [new Float32Array(3)], dirty: true };
    useAppStore.getState().updateDocument(edited);

    resolve(new Uint8Array([0x4f, 0x67, 0x67, 0x53]));
    await savePromise;

    expect(spy).not.toHaveBeenCalled();
  });

  it('undoing back to an old save point after a staleness-rejected save still derives dirty (Task M2 finding 2)', async () => {
    installApi();
    const doc = seedDoc({
      filePath: 'D:\\audio\\voice.ogg',
      dirty: true,
      name: 'voice.ogg',
      sourceFormat: 'ogg',
    });

    undoHistory.pushUndo({ label: 'Edit A', docId: doc.id, undo() {}, redo() {} }); // position 1
    undoHistory.markSavePoint(doc.id); // savePoint = 1 — an earlier, real save
    undoHistory.pushUndo({ label: 'Edit B', docId: doc.id, undo() {}, redo() {} }); // position 2, dirty again

    const { resolve } = controllableEncode();
    const savePromise = saveDocument(doc.id);

    // A further edit lands mid-encode, so the staleness check rejects this
    // save attempt — but the write to disk already happened.
    const edited = { ...useAppStore.getState().documents[0], channels: [new Float32Array(3)], dirty: true };
    useAppStore.getState().updateDocument(edited);

    resolve(new Uint8Array([0x4f, 0x67, 0x67, 0x53]));
    await savePromise;

    // Undo back down to position 1 — the OLD save point. It must NOT derive
    // clean: disk now holds bytes from the just-written (rejected) save
    // attempt, which don't match what existed at the old save point.
    undoHistory.undo(doc.id);
    expect(useAppStore.getState().documents[0].dirty).toBe(true);
  });

  it('keeps a marker undo mid-save dirty and does not mark the save point (Task M2 finding 1)', async () => {
    const api = installApi();
    const doc = seedDoc({
      filePath: 'D:\\audio\\voice.ogg',
      dirty: true,
      name: 'voice.ogg',
      sourceFormat: 'ogg',
    });

    // Simulate a prior unsaved audio edit (position advances past the
    // never-marked save point), then add a marker on top of it — the
    // common shape during an in-flight save: the doc is already dirty both
    // before and after the marker op is undone.
    undoHistory.pushUndo({ label: 'Prior Edit', docId: doc.id, undo() {}, redo() {} }); // position 1

    const before = useAppStore.getState().markers[doc.id] ?? [];
    useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Chorus', positionSample: 3 });
    const after = useAppStore.getState().markers[doc.id];
    pushMarkerUndo('Add Marker', doc.id, before, after); // position 2

    const markSpy = jest.spyOn(undoHistory, 'markSavePoint');
    const { resolve } = controllableEncode();
    const savePromise = saveDocument(doc.id);

    // Undo the marker add while the encode is still in flight.
    undoHistory.undo(doc.id);

    resolve(new Uint8Array([0x4f, 0x67, 0x67, 0x53]));
    await savePromise;

    expect(useAppStore.getState().documents[0].dirty).toBe(true);
    expect(useAppStore.getState().markers[doc.id]).toEqual([]);
    expect(markSpy).not.toHaveBeenCalled();
    expect(api.writeFile).toHaveBeenCalledTimes(1);
  });

  it('keeps a mid-save marker add\'s dirty flag and the new marker in the store (Task M1)', async () => {
    const api = installApi();
    const doc = seedDoc({
      filePath: 'D:\\audio\\voice.ogg',
      dirty: true,
      name: 'voice.ogg',
      sourceFormat: 'ogg',
    });
    const { resolve } = controllableEncode();

    const savePromise = saveDocument(doc.id);

    // A marker edit lands while the encode is in flight: addMarker now
    // replaces the store's doc object too (Task M1), so the H1 staleness
    // check picks it up the same way an audio edit would.
    useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Chorus', positionSample: 3 });

    resolve(new Uint8Array([0x4f, 0x67, 0x67, 0x53]));
    await savePromise;

    expect(useAppStore.getState().documents[0].dirty).toBe(true); // stays dirty
    expect(useAppStore.getState().markers[doc.id]).toEqual([
      { id: 'marker-1', name: 'Chorus', positionSample: 3 },
    ]);
    expect(api.writeFile).toHaveBeenCalledTimes(1);
  });

  it('clears dirty normally when nothing edits the doc during the async encode', async () => {
    const api = installApi();
    const doc = seedDoc({
      filePath: 'D:\\audio\\voice.ogg',
      dirty: true,
      name: 'voice.ogg',
      sourceFormat: 'ogg',
    });

    await saveDocument(doc.id);

    expect(useAppStore.getState().documents[0].dirty).toBe(false);
    expect(api.writeFile).toHaveBeenCalledTimes(1);
  });

  it('serializes a concurrent second save for the same doc: single write, "save in progress" surfaced', async () => {
    const api = installApi();
    const doc = seedDoc({
      filePath: 'D:\\audio\\voice.ogg',
      dirty: true,
      name: 'voice.ogg',
      sourceFormat: 'ogg',
    });
    const { resolve } = controllableEncode();

    const first = saveDocument(doc.id);
    const second = saveDocument(doc.id); // fires while the first is still mid-encode

    resolve(new Uint8Array([0x4f, 0x67, 0x67, 0x53]));
    await Promise.all([first, second]);

    expect(api.writeFile).toHaveBeenCalledTimes(1);
    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Save in progress' })
    );
    expect(useAppStore.getState().documents[0].dirty).toBe(false);
  });

  it('getInFlightSaveCount reflects a save mid-encode/write and drops back to 0 once it settles (Task M4/F7)', async () => {
    installApi();
    const doc = seedDoc({
      filePath: 'D:\\audio\\voice.ogg',
      dirty: true,
      name: 'voice.ogg',
      sourceFormat: 'ogg',
    });
    const { resolve } = controllableEncode();

    expect(getInFlightSaveCount()).toBe(0);
    const savePromise = saveDocument(doc.id);
    expect(getInFlightSaveCount()).toBe(1);

    resolve(new Uint8Array([0x4f, 0x67, 0x67, 0x53]));
    await savePromise;

    expect(getInFlightSaveCount()).toBe(0);
  });

  it('allows a save after a prior save for the same doc has completed', async () => {
    const api = installApi();
    const doc = seedDoc({
      filePath: 'D:\\audio\\voice.ogg',
      dirty: true,
      name: 'voice.ogg',
      sourceFormat: 'ogg',
    });

    await saveDocument(doc.id);
    useAppStore.getState().updateDocument({ ...useAppStore.getState().documents[0], dirty: true });
    await saveDocument(doc.id);

    expect(api.writeFile).toHaveBeenCalledTimes(2);
    expect(api.showMessageBox).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Save in progress' })
    );
  });

  it('surfaces a generic encoder rejection as a user-facing error and keeps the doc dirty (no unhandled rejection)', async () => {
    const api = installApi();
    mockEncodeOgg.mockRejectedValueOnce(new Error('WebCodecs internal failure'));
    const doc = seedDoc({
      filePath: 'D:\\audio\\voice.ogg',
      dirty: true,
      name: 'voice.ogg',
      sourceFormat: 'ogg',
    });

    await saveDocument(doc.id);

    expect(api.writeFile).not.toHaveBeenCalled();
    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        title: 'Save failed',
        message: 'WebCodecs internal failure',
      })
    );
    expect(useAppStore.getState().documents[0].dirty).toBe(true);
  });

  it('keeps a mid-save-as edit\'s newer channels and dirty flag; the filePath is not retagged', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\new.wav') });
    const doc = seedDoc({ filePath: null, dirty: true, name: 'Untitled 1' });
    let resolveWrite!: (r: { ok: true } | { ok: false; error: string }) => void;
    api.writeFile.mockImplementationOnce(
      () => new Promise((resolve) => { resolveWrite = resolve; })
    );

    const savePromise = saveDocument(doc.id);
    // Let the save-as dialog + doc re-fetch happen before editing.
    await Promise.resolve();
    await Promise.resolve();

    const editedChannels = [new Float32Array([9, 9]), new Float32Array([9, 9])];
    const edited = { ...useAppStore.getState().documents[0], channels: editedChannels, dirty: true };
    useAppStore.getState().updateDocument(edited);

    resolveWrite({ ok: true });
    await savePromise;

    const live = useAppStore.getState().documents[0];
    expect(live.channels).toBe(editedChannels);
    expect(live.dirty).toBe(true);
    expect(live.filePath).toBeNull(); // not retagged to the just-written path
  });
});

describe('exportDocument', () => {
  it('encodes MP3 via encodeMp3 and writes it, leaving the doc unchanged', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\track.mp3') });
    const doc = seedDoc({ filePath: 'D:\\audio\\song.wav', name: 'song.wav' });

    const result = await exportDocument(doc.id, { format: 'mp3', wavBitDepth: 16, mp3Kbps: 192 });

    expect(mockEncodeMp3).toHaveBeenCalledWith(doc.channels, 44100, 192, undefined);
    expect(api.writeFile).toHaveBeenCalledWith('D:\\out\\track.mp3', expect.any(ArrayBuffer));
    expect(result).toBe('D:\\out\\track.mp3');
    // Export never touches filePath/dirty.
    const after = useAppStore.getState().documents[0];
    expect(after.filePath).toBe('D:\\audio\\song.wav');
    expect(after.dirty).toBe(false);
    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', message: 'Exported to D:\\out\\track.mp3' })
    );
  });

  it('includes the doc markers when exporting to MP3 (K3)', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\track.mp3') });
    const doc = seedDoc({ filePath: null, name: 'doc' });
    useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Bridge', positionSample: 9 });

    await exportDocument(doc.id, { format: 'mp3', wavBitDepth: 16, mp3Kbps: 192 });

    expect(mockEncodeMp3).toHaveBeenCalledWith(doc.channels, 44100, 192, [
      { id: 'marker-1', name: 'Bridge', positionSample: 9 },
    ]);
    expect(api.writeFile).toHaveBeenCalledWith('D:\\out\\track.mp3', expect.any(ArrayBuffer));
  });

  it('includes the doc markers when exporting to FLAC (K4)', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\track.flac') });
    const doc = seedDoc({ filePath: null, name: 'doc' });
    useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Hook', positionSample: 9 });

    await exportDocument(doc.id, { format: 'flac', wavBitDepth: 16, mp3Kbps: 192 });

    expect(mockEncodeFlac).toHaveBeenCalledWith(doc.channels, 44100, 16, [
      { id: 'marker-1', name: 'Hook', positionSample: 9 },
    ]);
    expect(api.writeFile).toHaveBeenCalledWith('D:\\out\\track.flac', expect.any(ArrayBuffer));
  });

  it('writes a WAV at the requested bit depth', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\track.wav') });
    const doc = seedDoc({ filePath: null, name: 'doc' });

    const result = await exportDocument(doc.id, { format: 'wav', wavBitDepth: 24, mp3Kbps: 128 });

    expect(result).toBe('D:\\out\\track.wav');
    const [, data] = api.writeFile.mock.calls[0];
    expect(decodeWav(data as ArrayBuffer).bitDepth).toBe(24);
  });

  it('includes the doc markers when exporting to WAV', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\track.wav') });
    const doc = seedDoc({ filePath: null, name: 'doc' });
    useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Bridge', positionSample: 9 });

    await exportDocument(doc.id, { format: 'wav', wavBitDepth: 16, mp3Kbps: 128 });

    const [, data] = api.writeFile.mock.calls[0];
    expect(decodeWav(data as ArrayBuffer).markers).toEqual([{ name: 'Bridge', positionSample: 9 }]);
  });

  it('exports OGG via encodeOggOpus with the chosen bitrate and writes .ogg', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\track.ogg') });
    const doc = seedDoc({ filePath: null, name: 'doc' });

    const result = await exportDocument(doc.id, {
      format: 'ogg',
      wavBitDepth: 16,
      mp3Kbps: 128,
      oggBitrate: 192_000,
    });

    expect(mockEncodeOgg).toHaveBeenCalledWith(doc.channels, 44100, 192_000, undefined);
    expect(api.writeFile).toHaveBeenCalledWith('D:\\out\\track.ogg', expect.any(ArrayBuffer));
    expect(result).toBe('D:\\out\\track.ogg');
  });

  it('includes the doc markers when exporting to OGG (K5)', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\track.ogg') });
    const doc = seedDoc({ filePath: null, name: 'doc' });
    useAppStore.getState().addMarker(doc.id, { id: 'marker-1', name: 'Hook', positionSample: 9 });

    await exportDocument(doc.id, { format: 'ogg', wavBitDepth: 16, mp3Kbps: 128, oggBitrate: 192_000 });

    expect(mockEncodeOgg).toHaveBeenCalledWith(doc.channels, 44100, 192_000, [
      { id: 'marker-1', name: 'Hook', positionSample: 9 },
    ]);
    expect(api.writeFile).toHaveBeenCalledWith('D:\\out\\track.ogg', expect.any(ArrayBuffer));
  });

  it('surfaces an error and writes nothing when the Opus encoder is unavailable', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\track.ogg') });
    mockEncodeOgg.mockRejectedValueOnce(new OggEncoderUnavailableError());
    const doc = seedDoc({ filePath: null, name: 'doc' });

    const result = await exportDocument(doc.id, { format: 'ogg', wavBitDepth: 16, mp3Kbps: 128 });

    expect(result).toBeNull();
    expect(api.writeFile).not.toHaveBeenCalled();
    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Export failed' })
    );
  });

  it('surfaces a generic (non-typed) encoder rejection as a user-facing error, no unhandled rejection (Task H1)', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\track.ogg') });
    mockEncodeOgg.mockRejectedValueOnce(new DOMException('encode failed', 'EncodingError'));
    const doc = seedDoc({ filePath: null, name: 'doc' });

    const result = await exportDocument(doc.id, { format: 'ogg', wavBitDepth: 16, mp3Kbps: 128 });

    expect(result).toBeNull();
    expect(api.writeFile).not.toHaveBeenCalled();
    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Export failed', message: 'encode failed' })
    );
  });

  it('appends the format extension when the picked path lacks it', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\track') });
    const doc = seedDoc({ filePath: null, name: 'doc' });

    const result = await exportDocument(doc.id, { format: 'mp3', wavBitDepth: 16, mp3Kbps: 128 });

    expect(result).toBe('D:\\out\\track.mp3');
    expect(api.writeFile).toHaveBeenCalledWith('D:\\out\\track.mp3', expect.any(ArrayBuffer));
  });

  it('returns null and writes nothing when the dialog is cancelled', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => null) });
    const doc = seedDoc({ filePath: null });

    const result = await exportDocument(doc.id, { format: 'wav', wavBitDepth: 16, mp3Kbps: 128 });

    expect(result).toBeNull();
    expect(api.writeFile).not.toHaveBeenCalled();
  });
});

describe('newDocument', () => {
  it('creates a silent doc of exactly round(rate * seconds) samples', () => {
    installApi();
    newDocument({ name: 'Untitled 1', sampleRate: 48000, channels: 2, durationSeconds: 1.5 });
    const doc = useAppStore.getState().documents[0];
    expect(doc.channels).toHaveLength(2);
    expect(docLength(doc)).toBe(72000);
    expect(doc.channels[0].every((v) => v === 0)).toBe(true);
    expect(useAppStore.getState().activeDocumentId).toBe(doc.id);
  });

  it('creates a single channel for mono', () => {
    installApi();
    newDocument({ name: 'mono', sampleRate: 44100, channels: 1, durationSeconds: 2 });
    const doc = useAppStore.getState().documents[0];
    expect(doc.channels).toHaveLength(1);
    expect(docLength(doc)).toBe(88200);
  });
});

describe('closeDocumentFlow', () => {
  it('closes a clean doc and frees its history/peaks and stops playback', async () => {
    installApi();
    const clearSpy = jest.spyOn(undoHistory, 'clearHistory');
    const peaksSpy = jest.spyOn(peaksCache, 'invalidatePeaks');
    const stopSpy = jest.spyOn(playbackEngine, 'stop');
    const doc = seedDoc({ filePath: 'D:\\a.wav', dirty: false });

    await closeDocumentFlow(doc.id);

    expect(useAppStore.getState().documents).toHaveLength(0);
    expect(clearSpy).toHaveBeenCalledWith(doc.id);
    expect(peaksSpy).toHaveBeenCalledWith(doc.id);
    expect(stopSpy).toHaveBeenCalled();
  });


  describe('tempo/remix analysis lifetime (Task T4)', () => {
    beforeEach(() => {
      clearAllTempo();
    });

    it('calls BOTH invalidateTempo and invalidateRemix with the closed doc id (missing either would retain its channel arrays forever)', async () => {
      installApi();
      const tempoSpy = jest.spyOn(tempoAnalysis, 'invalidateTempo');
      const remixSpy = jest.spyOn(tempoAnalysis, 'invalidateRemix');
      const doc = seedDoc({ filePath: 'D:\\a.wav', dirty: false });

      await closeDocumentFlow(doc.id);

      expect(tempoSpy).toHaveBeenCalledWith(doc.id);
      expect(remixSpy).toHaveBeenCalledWith(doc.id);
    });

    it('(acceptance l) getTempo returns null for an analysed doc after closeDocumentFlow', async () => {
      installApi();
      const doc = seedDoc({ filePath: 'D:\\a.wav', dirty: false });
      const entry = await runTempoAnalysis(doc);
      expect(entry).not.toBeNull(); // sanity: analysis was actually cached before close

      await closeDocumentFlow(doc.id);

      expect(getTempo(doc)).toBeNull();
    });
  });

  describe('remix session lifetime (Task T13, acceptance 11)', () => {
    /** A live remix session over the abab fixture. Real end-to-end (analysis
     * -> plan -> render -> new document), because the whole point of these
     * two tests is that the SESSION — which retains the source's channel
     * arrays and its whole RemixAnalysis — is actually released on close, and
     * a stubbed session would not prove that. */
    async function seedRemixSession() {
      // "Don't Save": the remix document is genuinely never-saved (Task S4), so
      // closing it now asks first. These tests are about what the close RELEASES,
      // so they take the discard branch and let the close proceed.
      installApi({ showMessageBox: jest.fn(async () => 1) });
      clearAllTempo();
      clearAllRemixSessions();
      // A remix source is a song opened from disk — give it its filePath so the
      // source-close test exercises a close with no prompt of its own.
      const source = createDocument({
        name: 'Song.wav',
        sampleRate: 44100,
        channels: [abab()],
        filePath: 'D:\\Song.wav',
      });
      useAppStore.getState().addDocument(source);
      const result = await createRemixDocument({ sourceDocId: source.id, targetSample: Math.round(32 * 44100) });
      if (!result.ok) throw new Error(`seedRemixSession: ${result.status} — ${result.message}`);
      expect(getRemixSession(result.remixDocId)).not.toBeNull();
      return { sourceId: source.id, remixDocId: result.remixDocId };
    }

    it('closing the REMIX document clears its session', async () => {
      const { remixDocId } = await seedRemixSession();

      await closeDocumentFlow(remixDocId);

      expect(getRemixSession(remixDocId)).toBeNull();
    }, 20000);

    it('closing the SOURCE document clears the session too (it pins the source channels and the whole analysis)', async () => {
      const { sourceId, remixDocId } = await seedRemixSession();

      await closeDocumentFlow(sourceId);

      expect(getRemixSession(remixDocId)).toBeNull();
    }, 20000);
  });

  it('does not close when the dirty prompt is cancelled', async () => {
    const api = installApi({ showMessageBox: jest.fn(async () => 2) }); // Cancel
    const doc = seedDoc({ filePath: 'D:\\a.wav', dirty: true });

    await closeDocumentFlow(doc.id);

    expect(api.showMessageBox).toHaveBeenCalled();
    expect(useAppStore.getState().documents).toHaveLength(1);
  });

  it('discards and closes on "Don\'t Save" without writing', async () => {
    const api = installApi({ showMessageBox: jest.fn(async () => 1) }); // Don't Save
    const doc = seedDoc({ filePath: 'D:\\a.wav', dirty: true });

    await closeDocumentFlow(doc.id);

    expect(api.writeFile).not.toHaveBeenCalled();
    expect(useAppStore.getState().documents).toHaveLength(0);
  });

  it('saves the PROJECT then closes when the user picks Save (lot A, M4 — acceptance 12)', async () => {
    const api = installApi({
      showMessageBox: jest.fn(async () => 0), // Save Project
      showSaveDialog: jest.fn(async () => 'D:\\out\\p.audm'), // no project path yet => Save As
    });
    const doc = seedDoc({ filePath: 'D:\\a.wav', dirty: true, name: 'a.wav' });

    await closeDocumentFlow(doc.id);

    expect(api.writeFile).toHaveBeenCalledTimes(1);
    const [path, data] = api.writeFile.mock.calls[0];
    expect(path).toBe('D:\\out\\p.audm'); // the .audm, never the source audio file
    expect(new TextDecoder().decode(new Uint8Array(data as ArrayBuffer).subarray(0, 6))).toBe('AUDM4\n');
    expect(useAppStore.getState().documents).toHaveLength(0);
  });

  it('prompts to save for a marker-only edit, no audio change (Task M1)', async () => {
    const api = installApi({ showMessageBox: jest.fn(async () => 1) }); // Don't Save
    const doc = seedDoc({ filePath: 'D:\\a.wav', dirty: false });
    expect(useAppStore.getState().documents[0].dirty).toBe(false);

    useAppStore.getState().addMarker(doc.id, { id: 'm-1', name: 'Marker', positionSample: 3 });

    await closeDocumentFlow(doc.id);

    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Unsaved changes' })
    );
    expect(useAppStore.getState().documents).toHaveLength(0); // Don't Save still closes
  });

  it('aborts the close if the Save is cancelled', async () => {
    // Save chosen, but there is no filePath so a save-as dialog appears and is cancelled.
    const api = installApi({
      showMessageBox: jest.fn(async () => 0), // Save
      showSaveDialog: jest.fn(async () => null), // cancelled
    });
    const doc = seedDoc({ filePath: null, dirty: true });

    await closeDocumentFlow(doc.id);

    expect(api.writeFile).not.toHaveBeenCalled();
    expect(useAppStore.getState().documents).toHaveLength(1);
  });

  describe('PlaybackEngine lifecycle (Task M9 / F16)', () => {
    afterEach(() => {
      // The real playbackEngine singleton persists across this whole test
      // file; leave it in a clean state for later suites/tests.
      playbackEngine.unload();
    });

    it('calls engine.unload (not just stop) when the closed doc is the one currently loaded', async () => {
      installApi();
      const doc = seedDoc({ filePath: 'D:\\a.wav', dirty: false });
      playbackEngine.load(doc);
      const unloadSpy = jest.spyOn(playbackEngine, 'unload');
      const stopSpy = jest.spyOn(playbackEngine, 'stop');

      await closeDocumentFlow(doc.id);

      expect(unloadSpy).toHaveBeenCalledTimes(1);
      expect(stopSpy).toHaveBeenCalled(); // unload() stops internally
    });

    it('calls engine.unload when no documents remain, even if a different (or no) doc was loaded', async () => {
      installApi();
      const doc = seedDoc({ filePath: 'D:\\a.wav', dirty: false });
      // Nothing was ever loaded into the engine (loadedDocumentId is null) —
      // closing the LAST open document must still release it defensively.
      const unloadSpy = jest.spyOn(playbackEngine, 'unload');

      await closeDocumentFlow(doc.id);

      expect(unloadSpy).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().documents).toHaveLength(0);
    });

    it('calls plain stop() (not unload) when closing a background doc while a DIFFERENT doc stays loaded and open', async () => {
      installApi();
      const keep = seedDoc({ filePath: 'D:\\keep.wav', dirty: false, name: 'keep.wav' });
      const other = createDocument({
        name: 'other.wav',
        sampleRate: 44100,
        channels: [new Float32Array(10)],
        filePath: 'D:\\other.wav',
      });
      useAppStore.getState().addDocument(other);
      playbackEngine.load(keep); // the engine has `keep` loaded, not `other`
      const unloadSpy = jest.spyOn(playbackEngine, 'unload');
      const stopSpy = jest.spyOn(playbackEngine, 'stop');

      await closeDocumentFlow(other.id);

      expect(unloadSpy).not.toHaveBeenCalled();
      expect(stopSpy).toHaveBeenCalled();
      expect(useAppStore.getState().documents.map((d) => d.id)).toEqual([keep.id]);
    });
  });

  describe('noise profile lifetime (Task F8)', () => {
    afterEach(() => clearNoiseProfile());

    it('clears the noise profile when its source document closes', async () => {
      installApi();
      const doc = seedDoc({ filePath: 'D:\\a.wav', dirty: false });
      captureNoiseProfile(); // captures from the active (only) doc
      expect(getNoiseProfile()?.docId).toBe(doc.id);

      await closeDocumentFlow(doc.id);

      expect(getNoiseProfile()).toBeNull();
    });

    it('keeps the noise profile when a DIFFERENT document closes', async () => {
      installApi();
      const source = seedDoc({ filePath: 'D:\\a.wav', dirty: false });
      captureNoiseProfile();
      const other = createDocument({
        name: 'other',
        sampleRate: 44100,
        channels: [new Float32Array(10)],
        filePath: 'D:\\b.wav',
      });
      useAppStore.getState().addDocument(other);

      await closeDocumentFlow(other.id);

      expect(getNoiseProfile()?.docId).toBe(source.id);
    });
  });

  describe('never-saved documents (Task S4)', () => {
    /** The live doc, re-read from the store. */
    function live(docId: string) {
      return useAppStore.getState().documents.find((d) => d.id === docId);
    }

    it('prompts before closing a CLEAN never-saved document, with never-saved wording', async () => {
      const api = installApi({ showMessageBox: jest.fn(async () => 2) }); // Cancel
      const doc = seedDoc({ filePath: null, dirty: false, name: 'Remix 1' });
      expect(live(doc.id)!.dirty).toBe(false); // the exact state that used to close silently

      await closeDocumentFlow(doc.id);

      expect(api.showMessageBox).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'question',
          title: 'Unsaved document',
          // Lot A (M4): the offer is a PROJECT save — the document has no file
          // of its own and never will through Save.
          message: 'Remix 1 exists only in this project and the project has not been saved. Save the project before closing it?',
          buttons: ['Save Project', "Don't Save", 'Cancel'],
        })
      );
      expect(useAppStore.getState().documents).toHaveLength(1); // Cancel kept it open
    });

    it('discards and closes on "Don\'t Save" without writing', async () => {
      const api = installApi({ showMessageBox: jest.fn(async () => 1) }); // Don't Save
      const doc = seedDoc({ filePath: null, dirty: false, name: 'Mixdown 1' });

      await closeDocumentFlow(doc.id);

      expect(api.writeFile).not.toHaveBeenCalled();
      expect(useAppStore.getState().documents).toHaveLength(0);
    });

    it('saves the project then closes when the user picks Save Project', async () => {
      const api = installApi({
        showMessageBox: jest.fn(async () => 0), // Save Project
        showSaveDialog: jest.fn(async () => 'D:\\out\\p.audm'),
      });
      const doc = seedDoc({ filePath: null, dirty: false, name: 'Remix 1' });

      await closeDocumentFlow(doc.id);

      expect(api.writeFile).toHaveBeenCalledTimes(1);
      expect(api.writeFile.mock.calls[0][0]).toBe('D:\\out\\p.audm');
      expect(useAppStore.getState().documents).toHaveLength(0);
    });

    it('aborts the close when the save-as dialog is cancelled (the document is still never saved)', async () => {
      const api = installApi({
        showMessageBox: jest.fn(async () => 0), // Save
        showSaveDialog: jest.fn(async () => null), // cancelled
      });
      const doc = seedDoc({ filePath: null, dirty: false, name: 'Remix 1' });

      await closeDocumentFlow(doc.id);

      expect(api.writeFile).not.toHaveBeenCalled();
      expect(useAppStore.getState().documents).toHaveLength(1);
    });

    it('STILL prompts after an edit is UNDONE past the creation point — the trap a stamped dirty:true would fall into', async () => {
      const api = installApi({ showMessageBox: jest.fn(async () => 2) }); // Cancel
      const doc = seedDoc({ filePath: null, dirty: false, name: 'Remix 1' });

      // A real curation edit through the app's single write path, then undo it.
      useAppStore.getState().setSelection({ start: 2, end: 5 });
      deleteSelection();
      expect(live(doc.id)!.dirty).toBe(true);
      undoHistory.undo(doc.id);
      // undoHistory RE-DERIVES dirty from position vs. savePoint, so it is back
      // to false here: a `dirty: true` stamped at creation would have been
      // silently erased by exactly this call (KNOWN_LIMITATIONS / P1-0).
      expect(live(doc.id)!.dirty).toBe(false);
      expect(live(doc.id)!.neverSaved).toBe(true);

      await closeDocumentFlow(doc.id);

      expect(api.showMessageBox).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Unsaved document' })
      );
      expect(useAppStore.getState().documents).toHaveLength(1);
    });

    it('keeps the ordinary "Unsaved changes" wording for a doc that has a file on disk', async () => {
      const api = installApi({ showMessageBox: jest.fn(async () => 1) }); // Don't Save
      const doc = seedDoc({ filePath: 'D:\\a.wav', dirty: true, name: 'a.wav' });

      await closeDocumentFlow(doc.id);

      expect(api.showMessageBox).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Unsaved changes',
          message: 'a.wav has unsaved changes. Save the project before closing it?',
          buttons: ['Save Project', "Don't Save", 'Cancel'],
        })
      );
    });

    it('does NOT prompt for a clean path-less document whose audio is on disk (an exotic source)', async () => {
      const api = installApi();
      const doc = seedDoc({ filePath: null, dirty: false, neverSaved: false, name: 'take.m4a' });

      await closeDocumentFlow(doc.id);

      expect(api.showMessageBox).not.toHaveBeenCalled();
      expect(useAppStore.getState().documents).toHaveLength(0);
    });
  });
});

describe('neverSaved provenance across open/save/export (Task S4)', () => {
  function live(docId: string) {
    return useAppStore.getState().documents.find((d) => d.id === docId);
  }

  it('a file opened from disk is neverSaved:false', async () => {
    installApi();
    await openFilePath('D:\\audio\\song.wav');
    expect(useAppStore.getState().documents[0].neverSaved).toBe(false);
  });

  it('an EXOTIC source opened from disk is neverSaved:false even though it keeps no filePath', async () => {
    installApi();
    await openFilePath('D:\\audio\\clip.m4a');
    const doc = useAppStore.getState().documents[0];
    expect(doc.filePath).toBeNull(); // m4a cannot be saved in place ...
    expect(doc.neverSaved).toBe(false); // ... but its audio IS on disk
  });

  it('File > New produces a never-saved document', () => {
    installApi();
    newDocument({ name: 'Untitled 1', sampleRate: 44100, channels: 2, durationSeconds: 1 });
    expect(useAppStore.getState().documents[0].neverSaved).toBe(true);
  });

  it('a successful Save As clears neverSaved (and gives the document its filePath)', async () => {
    installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\Remix 1.wav') });
    const doc = seedDoc({ filePath: null, dirty: true, name: 'Remix 1' });

    await saveDocument(doc.id);

    expect(live(doc.id)!.neverSaved).toBe(false);
    expect(live(doc.id)!.filePath).toBe('D:\\out\\Remix 1.wav');
  });

  it('a FAILED write leaves neverSaved set', async () => {
    installApi({
      showSaveDialog: jest.fn(async () => 'D:\\out\\Remix 1.wav'),
      writeFile: jest.fn(async () => ({ ok: false, error: 'EACCES' })),
      // Cancel the "Save As…" offer a failed write now makes — this test is
      // about the state a refused write leaves behind, not about the retry.
      showMessageBox: jest.fn(async () => 1),
    });
    const doc = seedDoc({ filePath: null, dirty: true, name: 'Remix 1' });

    await saveDocument(doc.id);

    expect(live(doc.id)!.neverSaved).toBe(true);
    expect(live(doc.id)!.dirty).toBe(true);
  });

  it('a CANCELLED save-as dialog leaves neverSaved set', async () => {
    installApi({ showSaveDialog: jest.fn(async () => null) });
    const doc = seedDoc({ filePath: null, dirty: true, name: 'Remix 1' });

    await saveDocument(doc.id);

    expect(live(doc.id)!.neverSaved).toBe(true);
  });

  it('a successful in-place Save clears neverSaved too', async () => {
    installApi();
    // A path-carrying document that has never been written by this app is not
    // reachable through the normal flows, but the in-place branch must clear
    // the flag on its own rather than relying on Save As having done it.
    const doc = seedDoc({ filePath: 'D:\\a.wav', dirty: true, neverSaved: true, name: 'a.wav' });

    await saveDocument(doc.id);

    expect(live(doc.id)!.neverSaved).toBe(false);
  });

  it('a save whose staleness check rejects does NOT clear neverSaved', async () => {
    installApi();
    // Same shape as the Task M2 staleness tests above: an OGG source suspends
    // inside encodeInPlace, so an edit can land mid-save.
    const doc = seedDoc({
      filePath: 'D:\\audio\\voice.ogg',
      dirty: true,
      name: 'voice.ogg',
      sourceFormat: 'ogg',
      neverSaved: true,
    });
    let resolveEncode!: (bytes: Uint8Array) => void;
    mockEncodeOgg.mockImplementationOnce(
      () => new Promise<Uint8Array>((res) => { resolveEncode = res; })
    );

    const savePromise = saveDocument(doc.id);
    // An edit lands mid-encode: the pre-await snapshot is stale, so the save's
    // bookkeeping must not touch the live document at all.
    useAppStore.getState().updateDocument({ ...live(doc.id)!, channels: [new Float32Array(3)], dirty: true });
    resolveEncode(new Uint8Array([0x4f, 0x67, 0x67, 0x53]));
    await savePromise;

    expect(live(doc.id)!.neverSaved).toBe(true);
  });

  it('exportDocument does NOT clear neverSaved — an export is not the document\'s own file (same rule as dirty)', async () => {
    installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\remix.wav') });
    const doc = seedDoc({ filePath: null, dirty: false, name: 'Remix 1' });

    const written = await exportDocument(doc.id, { format: 'wav', wavBitDepth: 32, mp3Kbps: 192 });

    expect(written).toBe('D:\\out\\remix.wav');
    expect(live(doc.id)!.neverSaved).toBe(true);
    expect(live(doc.id)!.filePath).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lot A (M4) — the project predicates the Save pill, the StatusBar chip and
// the close guard all read. M4 verbatim: any document dirty || session dirty
// || (never written && has content); N12's "an empty untitled project is
// clean" is the third clause only.
// ---------------------------------------------------------------------------
describe('project predicates (lot A — acceptance 11)', () => {
  function addClipToTrack0(docId: string) {
    const trackId = useSessionStore.getState().session.tracks[0].id;
    useSessionStore
      .getState()
      .addClip(trackId, createClip({ documentId: docId, startSample: 0, offsetSample: 0, lengthSample: 10 }));
  }

  it('an empty untitled project is clean (N12): no docs, no clips, no path', () => {
    expect(projectHasContent()).toBe(false);
    expect(projectHasUnsavedWork()).toBe(false);
    expect(projectDirtyCount()).toBe(0);
  });

  it('one CLEAN document and no path: never written with content => dirty, count 1', () => {
    seedDoc({ filePath: 'D:\\a.wav', dirty: false });
    expect(projectHasContent()).toBe(true);
    expect(projectHasUnsavedWork()).toBe(true);
    expect(projectDirtyCount()).toBe(1); // max(1, 0 dirty docs + 0)
  });

  it('one clean document and a path: clean, count 0', () => {
    seedDoc({ filePath: 'D:\\a.wav', dirty: false });
    useSessionStore.getState().setProjectPath('D:\\p.audm');
    expect(projectHasUnsavedWork()).toBe(false);
    expect(projectDirtyCount()).toBe(0);
  });

  it('a dirty document with a path: dirty, count 1', () => {
    const doc = seedDoc({ filePath: 'D:\\a.wav', dirty: false });
    useSessionStore.getState().setProjectPath('D:\\p.audm');
    useAppStore.getState().updateDocument({ ...doc, dirty: true });
    expect(projectHasUnsavedWork()).toBe(true);
    expect(projectDirtyCount()).toBe(1);
  });

  it('a session addClip with a path: dirty, count 1', () => {
    const doc = seedDoc({ filePath: 'D:\\a.wav', dirty: false });
    useSessionStore.getState().setProjectPath('D:\\p.audm');
    addClipToTrack0(doc.id);
    expect(projectHasUnsavedWork()).toBe(true);
    expect(projectDirtyCount()).toBe(1);
  });

  it('a dirty document AND a dirty session: count 2', () => {
    const doc = seedDoc({ filePath: 'D:\\a.wav', dirty: false });
    useSessionStore.getState().setProjectPath('D:\\p.audm');
    addClipToTrack0(doc.id);
    useAppStore.getState().updateDocument({ ...useAppStore.getState().documents[0], dirty: true });
    expect(projectHasUnsavedWork()).toBe(true);
    expect(projectDirtyCount()).toBe(2);
  });

  it('TRUE with a path, no document and no clip after addTrack — session dirty, no content (M4 verbatim)', () => {
    useSessionStore.getState().setProjectPath('D:\\p.audm');
    useSessionStore.getState().addTrack();
    expect(projectHasContent()).toBe(false);
    expect(projectHasUnsavedWork()).toBe(true);
    expect(projectDirtyCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Lot A (M5) — Export in the multitrack view IS Mix Down: byte-identical to
// `mixdownSession` (mute/solo, automation, fades honoured; length = last
// audible clip end), to the chosen format, without adding a document.
// ---------------------------------------------------------------------------
describe('exportSessionMixdown (lot A — acceptance 20)', () => {
  /** A ramp, so a wrong fade/gain/length shows up sample by sample. */
  function ramp(n: number): Float32Array {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = ((i % 50) / 50) * 0.8 - 0.4;
    return out;
  }

  /**
   * Two documents on two tracks, the `mixdown.fades.test.ts` fixture shape
   * (mono material, a fade-in on the first clip, `pan: -1` on the second so
   * its right channel is exactly 0) plus one volume lane — enough that a
   * render which skipped fades, automation or the pan law would differ from
   * `mixdownSession`. Track B starts muted.
   */
  function seedSession() {
    const a = createDocument({ name: 'a.wav', sampleRate: 44100, channels: [ramp(100)] });
    const b = createDocument({ name: 'b.wav', sampleRate: 44100, channels: [new Float32Array(100).fill(0.5)] });
    useAppStore.getState().addDocument(a);
    useAppStore.getState().addDocument(b);
    const s = useSessionStore.getState();
    const [tA, tB] = s.session.tracks;
    const clipA = createClip({ documentId: a.id, startSample: 0, offsetSample: 0, lengthSample: 100 });
    const clipB = createClip({ documentId: b.id, startSample: 50, offsetSample: 0, lengthSample: 100 });
    s.addClip(tA.id, clipA);
    s.addClip(tB.id, clipB);
    s.setClipFade(clipA.id, 'in', { lengthSample: 8 });
    s.upsertAutomationKeys(tA.id, [
      { param: 'volumeDb', key: { positionSample: 0, value: -6 } },
      { param: 'volumeDb', key: { positionSample: 100, value: 0 } },
    ]);
    s.setTrackParam(tB.id, { pan: -1, muted: true });
    return { a, b, tA, tB };
  }

  const docsMap = () => new Map(useAppStore.getState().documents.map((d) => [d.id, d] as const));
  const opts = { format: 'wav' as const, wavBitDepth: 32 as const, mp3Kbps: 192 as const };

  it('encodes exactly the mixdown — channels sample-equal to mixdownSession, the session rate, no markers — and a muted track is left out', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\mix.wav') });
    const encodeWavSpy = jest.spyOn(wavCodec, 'encodeWav');
    const { a, b } = seedSession();
    const session = useSessionStore.getState().session;
    const expected = mixdownSession(session, docsMap());
    expect(expected.channels[0].length).toBe(100); // B (muted, ending at 150) does not extend the render
    const docsBefore = useAppStore.getState().documents;

    const path = await exportSessionMixdown(opts);

    expect(path).toBe('D:\\out\\mix.wav');
    expect(api.showSaveDialog).toHaveBeenCalledWith({
      defaultPath: 'Untitled Session.wav',
      filters: [{ name: 'Waveform Audio', extensions: ['wav'] }],
    });
    expect(encodeWavSpy).toHaveBeenCalledTimes(1);
    const [channels, sampleRate, bitDepth, markers] = encodeWavSpy.mock.calls[0];
    expect(sampleRate).toBe(session.sampleRate);
    expect(bitDepth).toBe(32);
    expect(markers).toBeUndefined();
    expect(channels).toHaveLength(2);
    expect(channels[0]).toEqual(expected.channels[0]);
    expect(channels[1]).toEqual(expected.channels[1]);
    // The written bytes decode back to the same render.
    const [, data] = api.writeFile.mock.calls[0];
    const decoded = decodeWav(data as ArrayBuffer);
    expect(decoded.sampleRate).toBe(session.sampleRate);
    expect(decoded.channels[0]).toEqual(expected.channels[0]);
    expect(decoded.channels[1]).toEqual(expected.channels[1]);
    // The fixture can express a skipped fade / lane: the render is not the raw document.
    expect(expected.channels[0][0]).toBe(0); // fade-in starts in silence
    expect(expected.channels[0][60]).not.toBe(a.channels[0][60]);
    // No document side effects: nothing added, nothing retagged.
    expect(useAppStore.getState().documents).toBe(docsBefore);
    for (const id of [a.id, b.id]) {
      const live = useAppStore.getState().documents.find((d) => d.id === id)!;
      expect(live.filePath).toBeNull();
      expect(live.dirty).toBe(false);
      expect(live.neverSaved).toBe(true);
    }
    expect(api.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ title: 'Export complete' }));
    encodeWavSpy.mockRestore();
  });

  it('the mixdown.fades.test.ts fade-in fixture, rebuilt through the store, exports exactly what mixdownSession renders (fixture reuse, fix round 1)', async () => {
    // `mixdown.fades.test.ts` 'applies a fade-in with the default equal-power
    // curve, exact ramp values': a constant 0.5 mono document, one clip of
    // 100 samples with `fadeInSample: 8`, `pan: -1` so the left channel is
    // the bare envelope and the right is exactly 0. A test module cannot be
    // imported without re-registering its suites here, so the fixture is
    // rebuilt value for value through the store's own actions; its pinned
    // literals (silence at 0, the bare constant past the ramp, a silent right
    // channel) are re-checked so a drift between the two copies is visible,
    // and the export is then held to `mixdownSession` rather than to a
    // re-derived ramp.
    installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\fade.wav') });
    const encodeWavSpy = jest.spyOn(wavCodec, 'encodeWav');
    const d = createDocument({ name: 'd', sampleRate: 44100, channels: [new Float32Array(100).fill(0.5)] });
    useAppStore.getState().addDocument(d);
    const s = useSessionStore.getState();
    const t = s.session.tracks[0];
    const c = createClip({ documentId: d.id, startSample: 0, offsetSample: 0, lengthSample: 100 });
    s.addClip(t.id, c);
    s.setClipFade(c.id, 'in', { lengthSample: 8 });
    s.setTrackParam(t.id, { pan: -1 });
    const expected = mixdownSession(useSessionStore.getState().session, docsMap());
    expect(expected.channels[0][0]).toBe(0); // sin(0) = 0: the ramp starts in silence
    expect(expected.channels[0][50]).toBe(0.5); // untouched past the fade
    expect(expected.channels[1][50]).toBe(0); // pan -1

    const path = await exportSessionMixdown(opts);

    expect(path).toBe('D:\\out\\fade.wav');
    const [channels, sampleRate] = encodeWavSpy.mock.calls[0];
    expect(sampleRate).toBe(44100);
    expect(channels[0]).toEqual(expected.channels[0]);
    expect(channels[1]).toEqual(expected.channels[1]);
    encodeWavSpy.mockRestore();
  });

  it('solo on B silences A — the render is still exactly mixdownSession', async () => {
    installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\mix.wav') });
    const encodeWavSpy = jest.spyOn(wavCodec, 'encodeWav');
    const { tB } = seedSession();
    useSessionStore.getState().setTrackParam(tB.id, { muted: false, solo: true });
    const expected = mixdownSession(useSessionStore.getState().session, docsMap());
    expect(expected.channels[0].length).toBe(150); // B alone now sets the length

    await exportSessionMixdown(opts);

    const [channels] = encodeWavSpy.mock.calls[0];
    expect(channels[0]).toEqual(expected.channels[0]);
    expect(channels[1]).toEqual(expected.channels[1]);
    // A is silenced: before B starts there is nothing, and B is hard-left.
    expect(Array.from(channels[0].subarray(0, 50)).every((v) => v === 0)).toBe(true);
    expect(channels[0][60]).not.toBe(0);
    expect(Array.from(channels[1]).every((v) => v === 0)).toBe(true);
    encodeWavSpy.mockRestore();
  });

  it('nothing audible (every track muted): no dialog, an info box, null', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\mix.wav') });
    const { tA } = seedSession();
    useSessionStore.getState().setTrackParam(tA.id, { muted: true });

    const path = await exportSessionMixdown(opts);

    expect(path).toBeNull();
    expect(api.showSaveDialog).not.toHaveBeenCalled();
    expect(api.writeFile).not.toHaveBeenCalled();
    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', title: 'Export', message: 'Nothing audible to export.' })
    );
  });

  it('defaults the file name to the project name with a .audm suffix stripped', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => null) });
    seedSession();
    useSessionStore.getState().renameSession('Take.audm');

    await exportSessionMixdown(opts);

    expect(api.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: 'Take.wav' }));
  });

  it('routes MP3 through the same encoder arguments as a document export (channels, rate, kbps, no markers)', async () => {
    installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\mix.mp3') });
    seedSession();
    const expected = mixdownSession(useSessionStore.getState().session, docsMap());

    const path = await exportSessionMixdown({ format: 'mp3', wavBitDepth: 24, mp3Kbps: 320 });

    expect(path).toBe('D:\\out\\mix.mp3');
    expect(mockEncodeMp3).toHaveBeenCalledTimes(1);
    const [channels, sampleRate, kbps, markers] = mockEncodeMp3.mock.calls[0];
    expect(channels[0]).toEqual(expected.channels[0]);
    expect(sampleRate).toBe(44100);
    expect(kbps).toBe(320);
    expect(markers).toBeUndefined();
  });
});
