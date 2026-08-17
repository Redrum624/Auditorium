/**
 * voiceService.ts (F3) — the renderer half of the voice changer: THE CONSENT
 * GATE, profile store round-trips, run lifetime, chunk assembly, staleness
 * and the new-document landing.
 *
 * The consent pin is the load-bearing suite here: the brief's RULING requires
 * conversion to be refused without the affirmation, pinned so removing the
 * gate turns these tests red (mutation-checked: gate removed -> red).
 */
import {
  convertDocumentVoice,
  createVoiceProfile,
  deleteVoiceProfile,
  ensureVoiceProfilesLoaded,
  getVoiceProfiles,
  getVoiceProfilesLoadError,
  getVoiceModelState,
  ensureVoiceModels,
  cancelVoiceRun,
  isVoiceRunning,
  getVoiceBusyCount,
  getVoiceProgress,
  estimateConversionSeconds,
  _resetVoiceStateForTest,
  _setVoiceStaleWatchForTest,
  VC_SAMPLE_RATE,
  MIN_MODEL_SAMPLES,
  MAX_MODEL_SAMPLES,
  MAX_REFERENCE_MODEL_SAMPLES,
  VC_SEGMENT_SAMPLES,
  VC_STRIDE_SAMPLES,
  VOICE_MODEL_BYTES,
  TONE_EMBEDDING_SIZE,
  MEASURED_REALTIME_FACTOR,
  type VoiceProgress,
} from './voiceService';
import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { resampleChannel } from '../dsp/resample';
import { monoMix } from './transcribeService';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
}

function makeSignal(length: number, seed: number): Float32Array {
  const rand = makeLcg(seed);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = 0.35 * rand() + 0.4 * Math.sin((2 * Math.PI * 220 * i) / 48000);
  }
  return out;
}

function seedDoc(
  opts: { channelCount?: 1 | 2; sampleRate?: number; length?: number; name?: string } = {}
): AudioDocument {
  const channelCount = opts.channelCount ?? 2;
  const sampleRate = opts.sampleRate ?? 48000;
  const length = opts.length ?? 24000;
  const channels: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) channels.push(makeSignal(length, 977 + c * 13));
  const doc = createDocument({
    name: opts.name ?? 'Take 7.wav',
    sampleRate,
    channels,
    filePath: 'D:\\Take 7.wav',
  });
  useAppStore.getState().addDocument(doc);
  return doc;
}

// ---------------------------------------------------------------------------
// The voice IPC mock — a faithful stand-in for voiceManager.cjs's renderer
// contract: one run at a time, 'voice:*' events while in flight, invokes that
// NEVER reject unless the channel itself dies.
// ---------------------------------------------------------------------------

type ConvertResult =
  | { ok: true; chunkCount: number; sanitisedSamples: number }
  | { ok: false; cancelled: true }
  | { ok: false; error: string };

type EmbedResult =
  | { ok: true; vector: ArrayBuffer }
  | { ok: false; cancelled: true }
  | { ok: false; error: string };

interface Backend {
  lastConvert: { sampleRate: number; samples: ArrayBuffer; target: ArrayBuffer; consent: boolean } | null;
  lastEmbed: { sampleRate: number; samples: ArrayBuffer; consent: boolean } | null;
  convertCalls: number;
  embedCalls: number;
  cancelCalls: number;
  liveListeners: number;
  modelState: { downloaded: boolean; bytes: number | null; expectedBytes: number };
  profilesOnDisk: unknown[];
  loadResult: { ok: true; profiles: unknown[] } | { ok: false; error: string } | null;
  saves: unknown[][];
  saveResult: { ok: true } | { ok: false; error: string };
  emitProgress(p: { stage: 'embed' | 'convert'; done: number; total: number }): void;
  emitChunk(c: { offset: number; samples: number; data: ArrayBuffer }): void;
  settleConvert(r: ConvertResult): void;
  settleEmbed(r: EmbedResult): void;
  autoEmbedVector: Float32Array | null;
  showMessageBox: jest.Mock;
}

function installApi(): Backend {
  const progressListeners = new Set<(p: { stage: 'embed' | 'convert'; done: number; total: number }) => void>();
  const chunkListeners = new Set<(c: { offset: number; samples: number; data: ArrayBuffer }) => void>();
  let pendingConvert: ((r: ConvertResult) => void) | null = null;
  let pendingEmbed: ((r: EmbedResult) => void) | null = null;

  const backend: Backend = {
    lastConvert: null,
    lastEmbed: null,
    convertCalls: 0,
    embedCalls: 0,
    cancelCalls: 0,
    liveListeners: 0,
    modelState: { downloaded: true, bytes: VOICE_MODEL_BYTES, expectedBytes: VOICE_MODEL_BYTES },
    profilesOnDisk: [],
    loadResult: null,
    saves: [],
    saveResult: { ok: true },
    autoEmbedVector: null,
    emitProgress(p) {
      for (const cb of [...progressListeners]) cb(p);
    },
    emitChunk(c) {
      for (const cb of [...chunkListeners]) cb(c);
    },
    settleConvert(r) {
      const resolve = pendingConvert;
      pendingConvert = null;
      resolve?.(r);
    },
    settleEmbed(r) {
      const resolve = pendingEmbed;
      pendingEmbed = null;
      resolve?.(r);
    },
    showMessageBox: jest.fn().mockResolvedValue(0),
  };

  const listen = <T,>(set: Set<T>, cb: T): (() => void) => {
    set.add(cb);
    backend.liveListeners++;
    return () => {
      if (set.delete(cb)) backend.liveListeners--;
    };
  };

  const api = {
    showMessageBox: backend.showMessageBox,
    voiceModelState: async () => backend.modelState,
    voiceEnsureModels: async () =>
      backend.modelState.downloaded ? ({ ok: true } as const) : ({ ok: false, error: 'offline' } as const),
    onVoiceModelProgress: () => () => {},
    voiceEmbed: (req: { sampleRate: number; samples: ArrayBuffer; consent: boolean }) => {
      backend.embedCalls++;
      backend.lastEmbed = req;
      if (backend.autoEmbedVector) {
        const v = backend.autoEmbedVector;
        return Promise.resolve({
          ok: true as const,
          vector: v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength),
        });
      }
      return new Promise<EmbedResult>((resolve) => {
        pendingEmbed = resolve;
      });
    },
    voiceConvert: (req: { sampleRate: number; samples: ArrayBuffer; target: ArrayBuffer; consent: boolean }) => {
      backend.convertCalls++;
      backend.lastConvert = req;
      return new Promise<ConvertResult>((resolve) => {
        pendingConvert = resolve;
      });
    },
    voiceCancel: async () => {
      backend.cancelCalls++;
      return { cancelled: true };
    },
    onVoiceProgress: (cb: (p: { stage: 'embed' | 'convert'; done: number; total: number }) => void) =>
      listen(progressListeners, cb),
    onVoiceChunk: (cb: (c: { offset: number; samples: number; data: ArrayBuffer }) => void) =>
      listen(chunkListeners, cb),
    voiceProfilesLoad: async () => backend.loadResult ?? { ok: true as const, profiles: backend.profilesOnDisk },
    voiceProfilesSave: async (req: { profiles: unknown[] }) => {
      backend.saves.push(req.profiles);
      return backend.saveResult;
    },
  };

  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  return backend;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function referenceChannels(seconds = 1): Float32Array[] {
  return [makeSignal(Math.round(48000 * seconds), 31337)];
}

async function seedProfile(backend: Backend, name = 'Alice'): Promise<string> {
  const vector = new Float32Array(TONE_EMBEDDING_SIZE);
  for (let i = 0; i < vector.length; i++) vector[i] = (i - 12) / 500;
  backend.autoEmbedVector = vector;
  const result = await createVoiceProfile({
    name,
    channels: referenceChannels(),
    sampleRate: 48000,
    sourceName: 'ref.wav',
    consentAffirmed: true,
  });
  backend.autoEmbedVector = null;
  if (!result.ok) throw new Error(`seedProfile failed: ${result.message}`);
  return result.profile.id;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetVoiceStateForTest();
  _setVoiceStaleWatchForTest(true);
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

// ---------------------------------------------------------------------------
// THE CONSENT PIN
// ---------------------------------------------------------------------------

describe('the consent gate — the F3 ruling, pinned', () => {
  test('conversion is REFUSED without the affirmation, before any IPC or audio work', async () => {
    const backend = installApi();
    const doc = seedDoc();
    await ensureVoiceProfilesLoaded();

    for (const consentAffirmed of [false, undefined, null, 1, 'true']) {
      const result = await convertDocumentVoice({
        docId: doc.id,
        profileId: 'voice-1',
        consentAffirmed: consentAffirmed as unknown as boolean,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe('consent-required');
        expect(result.message).toMatch(/right to use this voice/);
      }
    }
    // The refusal happened BEFORE the trust boundary: no invoke, no
    // listeners, no busy state.
    expect(backend.convertCalls).toBe(0);
    expect(backend.liveListeners).toBe(0);
    expect(isVoiceRunning()).toBe(false);
  });

  test('profile creation (the reference-clip path) is refused the same way', async () => {
    const backend = installApi();
    const result = await createVoiceProfile({
      name: 'Someone famous',
      channels: referenceChannels(),
      sampleRate: 48000,
      sourceName: 'clip.wav',
      consentAffirmed: false,
    });
    expect(result).toMatchObject({ ok: false, status: 'consent-required' });
    expect(backend.embedCalls).toBe(0);
    expect(getVoiceProfiles()).toHaveLength(0);
  });

  test('with the affirmation, the flag crosses the IPC boundary as literally true', async () => {
    const backend = installApi();
    const doc = seedDoc();
    const profileId = await seedProfile(backend);
    expect(backend.lastEmbed?.consent).toBe(true);

    const promise = convertDocumentVoice({ docId: doc.id, profileId, consentAffirmed: true });
    await flush();
    expect(backend.convertCalls).toBe(1);
    expect(backend.lastConvert?.consent).toBe(true);
    backend.settleConvert({ ok: false, cancelled: true });
    await promise;
  });
});

// ---------------------------------------------------------------------------
// Conversion lifecycle
// ---------------------------------------------------------------------------

describe('convertDocumentVoice', () => {
  async function startRun(backend: Backend, progress?: VoiceProgress[]) {
    const doc = seedDoc();
    const profileId = await seedProfile(backend);
    const promise = convertDocumentVoice({
      docId: doc.id,
      profileId,
      consentAffirmed: true,
      onProgress: progress ? (p) => progress.push(p) : undefined,
    });
    await flush();
    const modelLength = (backend.lastConvert?.samples.byteLength ?? 0) / 4;
    return { doc, profileId, promise, modelLength };
  }

  test('happy path: chunks assemble into ONE new 22050 Hz mono document, remix-style landing', async () => {
    const backend = installApi();
    const progress: VoiceProgress[] = [];
    const { doc, promise, modelLength } = await startRun(backend, progress);

    // The request carries the resampled mono mix and the profile embedding.
    const expected = resampleChannel(monoMix(doc.channels, doc.channels[0].length), 48000, VC_SAMPLE_RATE);
    expect(modelLength).toBe(expected.length);
    expect(new Float32Array(backend.lastConvert!.target).length).toBe(TONE_EMBEDDING_SIZE);

    backend.emitProgress({ stage: 'embed', done: 1, total: 1 });
    backend.emitProgress({ stage: 'convert', done: 1, total: 1 });

    const half = Math.floor(modelLength / 2);
    const a = new Float32Array(half).fill(0.25);
    const b = new Float32Array(modelLength - half).fill(-0.5);
    backend.emitChunk({ offset: 0, samples: half, data: a.buffer.slice(0) });
    backend.emitChunk({ offset: half, samples: modelLength - half, data: b.buffer.slice(0) });
    backend.settleConvert({ ok: true, chunkCount: 2, sanitisedSamples: 0 });

    const result = await promise;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = useAppStore.getState();
    const landed = state.documents.find((d) => d.id === result.docId);
    expect(landed).toBeDefined();
    expect(landed!.sampleRate).toBe(VC_SAMPLE_RATE);
    expect(landed!.channels).toHaveLength(1);
    expect(landed!.channels[0].length).toBe(modelLength);
    expect(landed!.channels[0][0]).toBe(0.25);
    expect(landed!.channels[0][modelLength - 1]).toBe(-0.5);
    expect(landed!.name).toBe('Take 7 — Alice voice');
    expect(state.activeDocumentId).toBe(result.docId);
    expect(state.view).toBe('waveform');

    // Progress narrated both phases, and the run wound down cleanly.
    expect(progress.some((p) => p.phase === 'embedding')).toBe(true);
    expect(progress.some((p) => p.phase === 'converting' && p.fraction === 1)).toBe(true);
    expect(backend.liveListeners).toBe(0);
    expect(getVoiceBusyCount()).toBe(0);
    expect(getVoiceProgress()).toBeNull();
  });

  test('refusals: no document, empty document, too short, too long, missing profile, model missing', async () => {
    const backend = installApi();
    await ensureVoiceProfilesLoaded();

    expect(await convertDocumentVoice({ docId: 'nope', profileId: 'p', consentAffirmed: true })).toMatchObject({
      ok: false,
      status: 'no-document',
    });

    const empty = createDocument({ name: 'Empty.wav', sampleRate: 48000, channels: [new Float32Array(0)] });
    useAppStore.getState().addDocument(empty);
    expect(
      await convertDocumentVoice({ docId: empty.id, profileId: 'p', consentAffirmed: true })
    ).toMatchObject({ ok: false, status: 'empty-document' });

    const short = seedDoc({ length: 10, name: 'Blip.wav' });
    expect(
      await convertDocumentVoice({ docId: short.id, profileId: 'p', consentAffirmed: true })
    ).toMatchObject({ ok: false, status: 'too-short' });

    // 30-min cap probed with a LOW sample rate so the fixture stays small:
    // at 800 Hz, model length is docLength * 22050/800 ≈ 27.6x.
    const longLen = Math.ceil(((MAX_MODEL_SAMPLES + 1) * 800) / VC_SAMPLE_RATE) + 1;
    const long = seedDoc({ sampleRate: 800, length: longLen, channelCount: 1, name: 'Long.wav' });
    expect(
      await convertDocumentVoice({ docId: long.id, profileId: 'p', consentAffirmed: true })
    ).toMatchObject({ ok: false, status: 'too-long' });

    const doc = seedDoc();
    expect(
      await convertDocumentVoice({ docId: doc.id, profileId: 'missing', consentAffirmed: true })
    ).toMatchObject({ ok: false, status: 'no-profile' });

    const profileId = await seedProfile(backend);
    backend.modelState = { downloaded: false, bytes: null, expectedBytes: VOICE_MODEL_BYTES };
    const noModel = await convertDocumentVoice({ docId: doc.id, profileId, consentAffirmed: true });
    expect(noModel).toMatchObject({ ok: false, status: 'model-missing' });
    expect(backend.convertCalls).toBe(0);
    expect(backend.liveListeners).toBe(0);
  });

  test('busy: a second convert AND a profile creation refuse while one runs', async () => {
    const backend = installApi();
    const { doc, profileId, promise } = await startRun(backend);
    expect(getVoiceBusyCount()).toBe(1);
    expect(
      await convertDocumentVoice({ docId: doc.id, profileId, consentAffirmed: true })
    ).toMatchObject({ ok: false, status: 'busy' });
    expect(
      await createVoiceProfile({
        name: 'X',
        channels: referenceChannels(),
        sampleRate: 48000,
        sourceName: 's',
        consentAffirmed: true,
      })
    ).toMatchObject({ ok: false, status: 'busy' });
    backend.settleConvert({ ok: false, cancelled: true });
    await promise;
    expect(getVoiceBusyCount()).toBe(0);
  });

  test('cancel invokes the manager kill and resolves cancelled; nothing lands', async () => {
    const backend = installApi();
    const { promise } = await startRun(backend);
    const docCountBefore = useAppStore.getState().documents.length;
    expect(await cancelVoiceRun()).toBe(true);
    expect(backend.cancelCalls).toBe(1);
    backend.settleConvert({ ok: false, cancelled: true });
    const result = await promise;
    expect(result).toMatchObject({ ok: false, status: 'cancelled' });
    expect(useAppStore.getState().documents.length).toBe(docCountBefore);
    expect(backend.liveListeners).toBe(0);
  });

  test('an edit mid-run aborts EARLY (store subscription) and settles stale', async () => {
    const backend = installApi();
    const { doc, promise } = await startRun(backend);
    useAppStore.setState({
      documents: useAppStore
        .getState()
        .documents.map((d) => (d.id === doc.id ? { ...d, channels: [makeSignal(100, 1)] } : d)),
    });
    expect(backend.cancelCalls).toBe(1); // the early abort fired
    backend.settleConvert({ ok: false, cancelled: true });
    expect(await promise).toMatchObject({ ok: false, status: 'stale' });
  });

  test('DELIVERY-TIME staleness: a run that finishes after a close never lands', async () => {
    const backend = installApi();
    _setVoiceStaleWatchForTest(false); // isolate the delivery-time gate
    const { doc, promise, modelLength } = await startRun(backend);
    const data = new Float32Array(modelLength);
    backend.emitChunk({ offset: 0, samples: modelLength, data: data.buffer.slice(0) });
    useAppStore.setState({
      documents: useAppStore.getState().documents.filter((d) => d.id !== doc.id),
    });
    backend.settleConvert({ ok: true, chunkCount: 1, sanitisedSamples: 0 });
    expect(await promise).toMatchObject({ ok: false, status: 'source-closed' });
  });

  test('a non-contiguous chunk or a shortfall is an HONEST failure, never a truncated document', async () => {
    const backend = installApi();
    const gap = await startRun(backend);
    const chunk = new Float32Array(100);
    backend.emitChunk({ offset: 50, samples: 100, data: chunk.buffer.slice(0) }); // gap at 0
    backend.settleConvert({ ok: true, chunkCount: 1, sanitisedSamples: 0 });
    const gapResult = await gap.promise;
    expect(gapResult).toMatchObject({ ok: false, status: 'failed' });
    if (!gapResult.ok) expect(gapResult.message).toMatch(/misdelivered/);

    _resetVoiceStateForTest();
    useAppStore.setState(makeInitialState());
    const backend2 = installApi();
    const shortfall = await startRun(backend2);
    const half = Math.floor(shortfall.modelLength / 2);
    backend2.emitChunk({ offset: 0, samples: half, data: new Float32Array(half).buffer });
    backend2.settleConvert({ ok: true, chunkCount: 1, sanitisedSamples: 0 });
    const shortResult = await shortfall.promise;
    expect(shortResult).toMatchObject({ ok: false, status: 'failed' });
    if (!shortResult.ok) expect(shortResult.message).toMatch(/delivered \d+ of \d+/);
  });

  test('a host error resolves failed and raises the one native failure box', async () => {
    const backend = installApi();
    const { promise } = await startRun(backend);
    backend.settleConvert({ ok: false, error: 'arena exploded' });
    const result = await promise;
    expect(result).toMatchObject({ ok: false, status: 'failed', message: 'arena exploded' });
    expect(backend.showMessageBox).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

describe('voice profiles', () => {
  test('load sanitises row by row, ids continue after the highest voice-N, and creation persists', async () => {
    const goodEmbedding = Array.from({ length: TONE_EMBEDDING_SIZE }, (_, i) => i / 1000);
    const backend = installApi();
    backend.profilesOnDisk = [
      { id: 'voice-3', name: 'Bob', embedding: goodEmbedding, createdAt: 5, sourceName: 'b.wav' },
      { id: 'voice-9', name: 'Cara', embedding: goodEmbedding, createdAt: 6, sourceName: 'c.wav' },
      { id: 'bad', name: 'Broken', embedding: goodEmbedding.slice(0, 255), createdAt: 7 },
      'not even an object',
    ];
    await ensureVoiceProfilesLoaded();
    expect(getVoiceProfiles().map((p) => p.id)).toEqual(['voice-3', 'voice-9']);
    expect(getVoiceProfilesLoadError()).toBeNull();

    const id = await seedProfile(backend, 'Dora');
    expect(id).toBe('voice-10'); // sequential, never reused
    expect(backend.saves).toHaveLength(1);
    const saved = backend.saves[0] as { id: string; embedding: number[] }[];
    expect(saved.map((p) => p.id)).toEqual(['voice-3', 'voice-9', 'voice-10']);
    expect(saved[2].embedding).toHaveLength(TONE_EMBEDDING_SIZE);
  });

  test('reference-clip bounds: empty, too short and over-350 s clips are refused before IPC', async () => {
    const backend = installApi();
    const base = { name: 'X', sampleRate: 48000, sourceName: 's', consentAffirmed: true as const };
    expect(await createVoiceProfile({ ...base, channels: [] })).toMatchObject({
      ok: false,
      status: 'bad-reference',
    });
    // 300 samples at 48k resample to ~138 at 22050 — under the 385 floor.
    expect(await createVoiceProfile({ ...base, channels: [makeSignal(300, 1)] })).toMatchObject({
      ok: false,
      status: 'bad-reference',
    });
    // Over the cap, probed at LOW rate to keep the fixture small: 2200
    // samples at 2 Hz resample to far beyond 350 s of 22050.
    const overLong = await createVoiceProfile({ ...base, channels: [makeSignal(2200, 2)], sampleRate: 2 });
    expect(overLong).toMatchObject({ ok: false, status: 'bad-reference' });
    expect(MAX_REFERENCE_MODEL_SAMPLES).toBe(VC_SAMPLE_RATE * 350);
    expect(backend.embedCalls).toBe(0);

    expect(await createVoiceProfile({ ...base, name: '   ', channels: referenceChannels() })).toMatchObject({
      ok: false,
      status: 'bad-reference',
    });
  });

  test('a save failure keeps the profile usable this session and reports the persist error', async () => {
    const backend = installApi();
    backend.saveResult = { ok: false, error: 'disk full' };
    const vector = new Float32Array(TONE_EMBEDDING_SIZE).fill(0.5);
    backend.autoEmbedVector = vector;
    const result = await createVoiceProfile({
      name: 'Eve',
      channels: referenceChannels(),
      sampleRate: 48000,
      sourceName: 'e.wav',
      consentAffirmed: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.persistError).toBe('disk full');
    expect(getVoiceProfiles()).toHaveLength(1);
  });

  test('delete removes and persists; deleting a ghost is a no-op', async () => {
    const backend = installApi();
    const id = await seedProfile(backend);
    expect((await deleteVoiceProfile(id)).ok).toBe(true);
    expect(getVoiceProfiles()).toHaveLength(0);
    expect(backend.saves).toHaveLength(2); // create + delete
    expect((await deleteVoiceProfile('ghost')).ok).toBe(false);
  });

  test('a failed load reads as an empty library with the error surfaced', async () => {
    const backend = installApi();
    backend.loadResult = { ok: false, error: 'profiles file unreadable' };
    await ensureVoiceProfilesLoaded();
    expect(getVoiceProfiles()).toHaveLength(0);
    expect(getVoiceProfilesLoadError()).toBe('profiles file unreadable');
  });
});

// ---------------------------------------------------------------------------
// Constants and estimates
// ---------------------------------------------------------------------------

describe('mirrored constants and the estimate', () => {
  test('every mirrored constant restates its main-process derivation', () => {
    expect(VC_SAMPLE_RATE).toBe(22050);
    expect(MIN_MODEL_SAMPLES).toBe(385);
    expect(MAX_MODEL_SAMPLES).toBe(22050 * 1800);
    expect(MAX_REFERENCE_MODEL_SAMPLES).toBe(22050 * 350);
    expect(VOICE_MODEL_BYTES).toBe(157196170 + 3364792);
    expect(VC_SEGMENT_SAMPLES).toBe(661504);
    expect(VC_STRIDE_SAMPLES).toBe(661504 - 33536); // SEGMENT − OVERLAP
    expect(TONE_EMBEDDING_SIZE).toBe(256);
    expect(MEASURED_REALTIME_FACTOR).toBe(3.86);
  });

  test('the chunk-plan mirror EQUALS the main process, loaded — not restated', () => {
    // These four numbers exist twice: once in voiceChunking.cjs, which owns
    // the real plan, and once here in the renderer, which cannot require a
    // .cjs at runtime and so keeps a copy for the time estimate. Restating a
    // copy's value proves nothing about the original — and they HAD drifted,
    // twice, before this test existed (the renderer still carried a stride
    // from two seam designs ago). So load the real module and compare.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const chunking = require('../../electron/voiceChunking.cjs');
    expect(VC_SEGMENT_SAMPLES).toBe(chunking.SEGMENT_SAMPLES);
    expect(VC_STRIDE_SAMPLES).toBe(chunking.STRIDE_SAMPLES);
    expect(VC_SAMPLE_RATE).toBe(chunking.VC_SAMPLE_RATE);
    expect(MIN_MODEL_SAMPLES).toBe(chunking.MIN_INPUT_SAMPLES);
    // And the estimate's premise: multi-chunk runs really do re-process the
    // overlap, so the ratio it charges is the geometry's, not a guess.
    expect(VC_SEGMENT_SAMPLES / VC_STRIDE_SAMPLES).toBeCloseTo(1.0534, 4);
  });

  test('the estimate charges the overlap re-processing for multi-chunk runs only', () => {
    const single = VC_STRIDE_SAMPLES; // one chunk exactly
    expect(estimateConversionSeconds(single)).toBeCloseTo(single / VC_SAMPLE_RATE / 3.86, 10);
    // Two chunks: SEGMENT + tail — more work than the samples alone.
    const total = VC_STRIDE_SAMPLES + 50000;
    const work = Math.min(VC_SEGMENT_SAMPLES, total) + (total - VC_STRIDE_SAMPLES);
    expect(estimateConversionSeconds(total)).toBeCloseTo(work / VC_SAMPLE_RATE / 3.86, 10);
    expect(estimateConversionSeconds(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Model state plumbing
// ---------------------------------------------------------------------------

describe('model state', () => {
  test('a missing preload reads as not-downloaded with the derived fallback size', async () => {
    expect(await getVoiceModelState()).toEqual({
      downloaded: false,
      bytes: null,
      expectedBytes: VOICE_MODEL_BYTES,
    });
    expect(await ensureVoiceModels()).toMatchObject({ ok: false });
  });

  test('ensure resolves the bridge answer and never rejects', async () => {
    const backend = installApi();
    expect(await ensureVoiceModels()).toEqual({ ok: true });
    backend.modelState = { downloaded: false, bytes: null, expectedBytes: VOICE_MODEL_BYTES };
    expect(await ensureVoiceModels()).toEqual({ ok: false, error: 'offline' });
  });
});
