import {
  openFilesViaDialog,
  openFilePath,
  saveDocument,
  exportDocument,
  newDocument,
  closeDocumentFlow,
} from './fileService';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { docLength, createDocument } from '../audio/AudioDocument';
import { decodeArrayBuffer } from '../audio/decodeAudio';
import { encodeMp3 } from '../audio/mp3Encoder';
import { encodeFlac } from '../audio/flacEncoder';
import { encodeOggOpus, OggEncoderUnavailableError } from '../audio/oggOpusEncoder';
import { decodeWav } from '../audio/wavCodec';
import { buildId3Chapters } from '../audio/id3Chapters';
import { buildChapterComments, buildVorbisCommentPayload } from '../audio/chapterTags';
import { muxOpusStream } from '../audio/oggPage';
import * as undoHistory from './undoHistory';
import * as peaksCache from './peaksCache';
import { playbackEngine } from '../audio/PlaybackEngine';
import { captureNoiseProfile, clearNoiseProfile, getNoiseProfile } from './noiseProfile';
import * as clipWaveformCache from '../components/Multitrack/clipWaveformCache';

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
  mockDecode.mockResolvedValue(decoded());
  mockEncodeMp3.mockReturnValue(new ArrayBuffer(2048));
  mockEncodeFlac.mockReturnValue(new ArrayBuffer(4096));
  mockEncodeOgg.mockResolvedValue(new Uint8Array([0x4f, 0x67, 0x67, 0x53]));
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

function seedDoc(opts: {
  filePath: string | null;
  dirty?: boolean;
  name?: string;
  sourceFormat?: ReturnType<typeof createDocument>['sourceFormat'];
  sourceBitDepth?: number;
}) {
  const doc = createDocument({
    name: opts.name ?? 'doc',
    sampleRate: 44100,
    channels: [new Float32Array(10), new Float32Array(10)],
    filePath: opts.filePath,
    sourceFormat: opts.sourceFormat,
    sourceBitDepth: opts.sourceBitDepth,
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

  it('re-encodes a 16-bit FLAC source at 16-bit (default when depth is not 24)', async () => {
    installApi();
    const doc = seedDoc({
      filePath: 'D:\\audio\\track.flac',
      name: 'track.flac',
      sourceFormat: 'flac',
      sourceBitDepth: 16,
    });

    await saveDocument(doc.id);

    expect(mockEncodeFlac).toHaveBeenCalledWith(doc.channels, 44100, 16, undefined);
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

  it('shows an error and keeps dirty when the write fails', async () => {
    const api = installApi({ writeFile: jest.fn(async () => ({ ok: false, error: 'disk full' })) });
    const doc = seedDoc({ filePath: 'D:\\audio\\song.wav', dirty: true, name: 'song.wav' });

    await saveDocument(doc.id);

    expect(api.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'disk full' })
    );
    expect(useAppStore.getState().documents[0].dirty).toBe(true);
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

  it('clears the mini-waveform cache on close (Task F9 — a closing doc may invalidate many clips)', async () => {
    installApi();
    const cacheSpy = jest.spyOn(clipWaveformCache, 'clearClipWaveformCache');
    const doc = seedDoc({ filePath: 'D:\\a.wav', dirty: false });

    await closeDocumentFlow(doc.id);

    expect(cacheSpy).toHaveBeenCalledTimes(1);
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

  it('saves then closes when the user picks Save', async () => {
    const api = installApi({ showMessageBox: jest.fn(async () => 0) }); // Save
    const doc = seedDoc({ filePath: 'D:\\a.wav', dirty: true, name: 'a.wav' });

    await closeDocumentFlow(doc.id);

    expect(api.writeFile).toHaveBeenCalledTimes(1);
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
});
