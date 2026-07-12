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
import { decodeWav } from '../audio/wavCodec';
import * as undoHistory from './undoHistory';
import * as peaksCache from './peaksCache';
import { playbackEngine } from '../audio/PlaybackEngine';

// Decode is mocked so file-service tests never touch OfflineAudioContext/lamejs.
jest.mock('../audio/decodeAudio', () => ({ decodeArrayBuffer: jest.fn() }));
jest.mock('../audio/mp3Encoder', () => ({ encodeMp3: jest.fn(() => new ArrayBuffer(2048)) }));

const mockDecode = decodeArrayBuffer as jest.MockedFunction<typeof decodeArrayBuffer>;
const mockEncodeMp3 = encodeMp3 as jest.MockedFunction<typeof encodeMp3>;

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

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  jest.clearAllMocks();
  mockDecode.mockResolvedValue(decoded());
  mockEncodeMp3.mockReturnValue(new ArrayBuffer(2048));
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

  it('gives non-wav sources a null filePath (Save falls back to save-as WAV)', async () => {
    installApi();
    await openFilePath('D:\\audio\\clip.mp3');
    const doc = useAppStore.getState().documents[0];
    expect(doc.name).toBe('clip.mp3');
    expect(doc.filePath).toBeNull();
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

function seedDoc(opts: { filePath: string | null; dirty?: boolean; name?: string }) {
  const doc = createDocument({
    name: opts.name ?? 'doc',
    sampleRate: 44100,
    channels: [new Float32Array(10), new Float32Array(10)],
    filePath: opts.filePath,
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

describe('exportDocument', () => {
  it('encodes MP3 via encodeMp3 and writes it, leaving the doc unchanged', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\track.mp3') });
    const doc = seedDoc({ filePath: 'D:\\audio\\song.wav', name: 'song.wav' });

    const result = await exportDocument(doc.id, { format: 'mp3', wavBitDepth: 16, mp3Kbps: 192 });

    expect(mockEncodeMp3).toHaveBeenCalledWith(doc.channels, 44100, 192);
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

  it('writes a WAV at the requested bit depth', async () => {
    const api = installApi({ showSaveDialog: jest.fn(async () => 'D:\\out\\track.wav') });
    const doc = seedDoc({ filePath: null, name: 'doc' });

    const result = await exportDocument(doc.id, { format: 'wav', wavBitDepth: 24, mp3Kbps: 128 });

    expect(result).toBe('D:\\out\\track.wav');
    const [, data] = api.writeFile.mock.calls[0];
    expect(decodeWav(data as ArrayBuffer).bitDepth).toBe(24);
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
});
