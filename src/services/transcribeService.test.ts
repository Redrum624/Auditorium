import { renderHook, act } from '@testing-library/react';
import {
  transcribeDocument,
  cancelTranscription,
  isTranscribing,
  getTranscribeBusyCount,
  getTranscribeProgress,
  getTranscribeModelState,
  ensureTranscribeModels,
  getTranscript,
  isTranscriptStale,
  invalidateTranscript,
  setTranscriptSpeakerCount,
  exportTranscript,
  assignSpeakerLabels,
  monoMix,
  modelSampleToDoc,
  getTranscribeVersion,
  useTranscribeVersion,
  _resetTranscriptsForTest,
  _setStaleWatchForTest,
  WHISPER_SAMPLE_RATE,
  MAX_MODEL_SAMPLES,
  TRANSCRIBE_MODEL_BYTES,
  MEASURED_REALTIME_FACTOR,
  DIARIZATION_LIMITS,
  type TranscribeProgress,
  type TranscribeResult,
} from './transcribeService';
import { closeDocumentFlow } from './fileService';
import { formatSrt, formatWebVtt } from './subtitleFormat';
import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { resampleChannel } from '../dsp/resample';
import { MAX_SPEAKERS } from '../dsp/speakerClustering';

// ---------------------------------------------------------------------------
// Fixtures — the deterministic LCG this repo re-declares per test file.
// ---------------------------------------------------------------------------

const HALF_SECOND_48K = 24000;

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

function seedDoc(opts: { channelCount?: 1 | 2; sampleRate?: number; length?: number; name?: string } = {}): AudioDocument {
  const channelCount = opts.channelCount ?? 2;
  const sampleRate = opts.sampleRate ?? 48000;
  const length = opts.length ?? HALF_SECOND_48K;
  const channels: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) channels.push(makeSignal(length, 4242 + c * 13));
  const doc = createDocument({
    name: opts.name ?? 'Interview.wav',
    sampleRate,
    channels,
    filePath: 'D:\\Interview.wav',
  });
  useAppStore.getState().addDocument(doc);
  return doc;
}

/** A unit vector in `dim` dimensions pointing mostly along `axis`, with a
 * small deterministic wobble so two members of the same group are close but
 * not identical (a clusterer must not need exact duplicates). */
function voiceVector(dim: number, axis: number, wobbleSeed: number): Float32Array {
  const rand = makeLcg(wobbleSeed);
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = 0.02 * rand();
  v[axis] += 1;
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

const EMBED_DIM = 8;

// ---------------------------------------------------------------------------
// The transcription IPC mock — a faithful stand-in for transcribeManager.cjs's
// renderer contract (its module header): one run at a time, 'transcribe:*'
// events while in flight, and a `run` invoke resolving
// {ok:true,segmentCount} | {ok:false,cancelled:true} | {ok:false,error} that
// NEVER rejects unless the IPC channel itself dies.
// ---------------------------------------------------------------------------

type RunResult =
  | { ok: true; segmentCount: number }
  | { ok: false; cancelled: true }
  | { ok: false; error: string };

interface HostSegmentMsg {
  index: number;
  startSample: number;
  endSample: number;
  text: string;
  avgLogprob: number;
  noSpeechProb: number;
  compressionRatio: number;
}

interface Backend {
  lastRequest: { sampleRate: number; samples: ArrayBuffer; language: string } | null;
  runCalls: number;
  cancelCalls: number;
  ensureCalls: number;
  /** Registered event listeners — must be back to 0 after any path. */
  liveListeners: number;
  modelState: { downloaded: boolean; bytes: number | null; expectedBytes: number };
  invokeThrows: string | null;
  saveDialogPath: string | null;
  writeResult: { ok: true } | { ok: false; error: string };
  writes: { path: string; text: string }[];
  emitLanguage(p: { language: string; probability: number }): void;
  emitProgress(p: { stage: 'transcribe' | 'embed'; done: number; total: number }): void;
  emitSegment(s: HostSegmentMsg): void;
  emitEmbedding(e: { segmentIndex: number; vector: ArrayBuffer }): void;
  settle(result: RunResult): void;
  showMessageBox: jest.Mock;
  showSaveDialog: jest.Mock;
}

function installApi(): Backend {
  const languageListeners = new Set<(p: { language: string; probability: number }) => void>();
  const progressListeners = new Set<(p: { stage: 'transcribe' | 'embed'; done: number; total: number }) => void>();
  const segmentListeners = new Set<(s: HostSegmentMsg) => void>();
  const embeddingListeners = new Set<(e: { segmentIndex: number; vector: ArrayBuffer }) => void>();
  let pending: ((r: RunResult) => void) | null = null;

  const backend: Backend = {
    lastRequest: null,
    runCalls: 0,
    cancelCalls: 0,
    ensureCalls: 0,
    liveListeners: 0,
    modelState: { downloaded: true, bytes: TRANSCRIBE_MODEL_BYTES, expectedBytes: TRANSCRIBE_MODEL_BYTES },
    invokeThrows: null,
    saveDialogPath: 'D:\\out\\Interview.srt',
    writeResult: { ok: true },
    writes: [],
    emitLanguage(p) {
      for (const cb of [...languageListeners]) cb(p);
    },
    emitProgress(p) {
      for (const cb of [...progressListeners]) cb(p);
    },
    emitSegment(s) {
      for (const cb of [...segmentListeners]) cb(s);
    },
    emitEmbedding(e) {
      for (const cb of [...embeddingListeners]) cb(e);
    },
    settle(result) {
      const resolve = pending;
      pending = null;
      resolve?.(result);
    },
    showMessageBox: jest.fn().mockResolvedValue(0),
    showSaveDialog: jest.fn(),
  };

  backend.showSaveDialog.mockImplementation(async () => backend.saveDialogPath);

  const listen = <T,>(set: Set<T>, cb: T): (() => void) => {
    set.add(cb);
    backend.liveListeners++;
    return () => {
      if (set.delete(cb)) backend.liveListeners--;
    };
  };

  const api = {
    showMessageBox: backend.showMessageBox,
    showSaveDialog: backend.showSaveDialog,
    writeFile: async (path: string, data: ArrayBuffer) => {
      backend.writes.push({ path, text: new TextDecoder().decode(new Uint8Array(data)) });
      return backend.writeResult;
    },
    transcribeModelState: async () => backend.modelState,
    transcribeEnsureModels: async () => {
      backend.ensureCalls++;
      return backend.modelState.downloaded ? { ok: true as const } : { ok: false as const, error: 'offline' };
    },
    onTranscribeModelProgress: () => () => {},
    transcribeRun: (req: { sampleRate: number; samples: ArrayBuffer; language: string }) => {
      backend.runCalls++;
      backend.lastRequest = req;
      if (backend.invokeThrows) return Promise.reject(new Error(backend.invokeThrows));
      return new Promise<RunResult>((resolve) => {
        pending = resolve;
      });
    },
    transcribeCancel: async () => {
      backend.cancelCalls++;
      if (pending) {
        backend.settle({ ok: false, cancelled: true });
        return { cancelled: true };
      }
      return { cancelled: false };
    },
    onTranscribeLanguage: (cb: (p: { language: string; probability: number }) => void) =>
      listen(languageListeners, cb),
    onTranscribeProgress: (cb: (p: { stage: 'transcribe' | 'embed'; done: number; total: number }) => void) =>
      listen(progressListeners, cb),
    onTranscribeSegment: (cb: (s: HostSegmentMsg) => void) => listen(segmentListeners, cb),
    onTranscribeEmbedding: (cb: (e: { segmentIndex: number; vector: ArrayBuffer }) => void) =>
      listen(embeddingListeners, cb),
  };

  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  return backend;
}

function hostSegment(index: number, startSample: number, endSample: number, text = `line ${index}`): HostSegmentMsg {
  return { index, startSample, endSample, text, avgLogprob: -0.3, noSpeechProb: 0.02, compressionRatio: 1.4 };
}

/** Lets the microtask queue drain so an awaited invoke has actually been made. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

let backend: Backend;

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetTranscriptsForTest();
  _setStaleWatchForTest(true);
  backend = installApi();
});

afterEach(() => {
  _setStaleWatchForTest(true);
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

/**
 * Starts a run, waits for the invoke, streams `segments` + `embeddings`, then
 * settles ok. Returns the awaited result.
 */
async function runWith(
  doc: AudioDocument,
  segments: HostSegmentMsg[],
  embeddings: { segmentIndex: number; vector: Float32Array }[] = [],
  opts: { speakerCount?: number; onProgress?: (p: TranscribeProgress) => void } = {}
): Promise<TranscribeResult> {
  const promise = transcribeDocument({ docId: doc.id, ...opts });
  await flush();
  backend.emitLanguage({ language: 'en', probability: 0.99 });
  for (const s of segments) backend.emitSegment(s);
  for (const e of embeddings) {
    backend.emitEmbedding({
      segmentIndex: e.segmentIndex,
      vector: e.vector.buffer.slice(e.vector.byteOffset, e.vector.byteOffset + e.vector.byteLength) as ArrayBuffer,
    });
  }
  backend.settle({ ok: true, segmentCount: segments.length });
  return promise;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('mirrors the host rate the manager validates against', () => {
    expect(WHISPER_SAMPLE_RATE).toBe(16000);
  });

  it('mirrors the host job cap exactly (2 hours at 16 kHz)', () => {
    // transcribeHost.cjs MAX_TOTAL_SAMPLES = WHISPER_SAMPLE_RATE * 7200.
    expect(MAX_MODEL_SAMPLES).toBe(16000 * 7200);
  });

  it('states the model-set size as the sum of the six pins', () => {
    expect(TRANSCRIBE_MODEL_BYTES).toBe(82468078 + 208521528 + 2480466 + 3832 + 2243 + 29292684);
  });

  it('keeps the measured realtime factor from the F4 bench', () => {
    expect(MEASURED_REALTIME_FACTOR).toBeCloseTo(9.02, 6);
  });

  it('records diarization as reliable only up to two speakers', () => {
    expect(DIARIZATION_LIMITS.reliableUpTo).toBe(2);
    expect(DIARIZATION_LIMITS.threeSpeakerAccuracy).toBeLessThan(0.5);
    expect(DIARIZATION_LIMITS.threeSpeakerAccuracyWhenTold).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// monoMix / modelSampleToDoc — pure, boundary-probed
// ---------------------------------------------------------------------------

describe('monoMix', () => {
  it('averages two channels rather than summing them', () => {
    const a = Float32Array.from([1, 0, -1]);
    const b = Float32Array.from([0, 1, 1]);
    expect(Array.from(monoMix([a, b], 3))).toEqual([0.5, 0.5, 0]);
  });

  it('copies a single channel through unchanged (no divide by one)', () => {
    const a = Float32Array.from([0.25, -0.5]);
    expect(Array.from(monoMix([a], 2))).toEqual([0.25, -0.5]);
  });

  it('never returns the caller\'s array (doc.channels must not be aliased)', () => {
    const a = Float32Array.from([0.25, -0.5]);
    expect(monoMix([a], 2)).not.toBe(a);
  });

  it('zero-fills past a short channel rather than reading out of bounds', () => {
    const a = Float32Array.from([1, 1]);
    expect(Array.from(monoMix([a], 4))).toEqual([1, 1, 0, 0]);
  });

  it('returns silence for no channels', () => {
    expect(Array.from(monoMix([], 3))).toEqual([0, 0, 0]);
  });
});

describe('modelSampleToDoc', () => {
  // 16 kHz -> 48 kHz is exactly 3x, so the arithmetic is checkable by hand.
  it('scales by the rate ratio', () => {
    expect(modelSampleToDoc(1000, 48000, 1000000)).toBe(3000);
  });

  it('is identity at the model rate', () => {
    expect(modelSampleToDoc(1234, 16000, 1000000)).toBe(1234);
  });

  it('rounds rather than truncating', () => {
    // 1 model sample at 44100 is 2.75625 doc samples -> 3.
    expect(modelSampleToDoc(1, 44100, 1000)).toBe(3);
  });

  it('clamps one sample BELOW zero up to zero', () => {
    expect(modelSampleToDoc(-1, 48000, 1000)).toBe(0);
  });

  it('leaves zero at zero', () => {
    expect(modelSampleToDoc(0, 48000, 1000)).toBe(0);
  });

  it('leaves a position one sample ABOVE zero alone', () => {
    expect(modelSampleToDoc(1, 16000, 1000)).toBe(1);
  });

  it('leaves a position one sample BELOW the document length alone', () => {
    expect(modelSampleToDoc(999, 16000, 1000)).toBe(999);
  });

  it('leaves a position exactly AT the document length alone', () => {
    expect(modelSampleToDoc(1000, 16000, 1000)).toBe(1000);
  });

  it('clamps a position one sample ABOVE the document length back down', () => {
    expect(modelSampleToDoc(1001, 16000, 1000)).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// assignSpeakerLabels
// ---------------------------------------------------------------------------

describe('assignSpeakerLabels', () => {
  it('separates two well-separated voices and numbers them by first appearance', () => {
    const a1 = voiceVector(EMBED_DIM, 0, 1);
    const a2 = voiceVector(EMBED_DIM, 0, 2);
    const b1 = voiceVector(EMBED_DIM, 3, 3);
    const b2 = voiceVector(EMBED_DIM, 3, 4);
    const out = assignSpeakerLabels([a1, b1, a2, b2]);
    expect(out.speakerCount).toBe(2);
    expect(out.speakers[0]).toBe(0);
    expect(out.speakers[1]).toBe(1);
    expect(out.speakers[2]).toBe(0);
    expect(out.speakers[3]).toBe(1);
  });

  it('returns ONE speaker when every embedding is the same voice', () => {
    const vs = [1, 2, 3, 4].map((s) => voiceVector(EMBED_DIM, 0, s));
    const out = assignSpeakerLabels(vs);
    expect(out.speakerCount).toBe(1);
    expect(out.speakers).toEqual([0, 0, 0, 0]);
  });

  it('honours a forced speaker count over what auto-detection would say', () => {
    const vs = [1, 2, 3, 4].map((s) => voiceVector(EMBED_DIM, 0, s));
    const auto = assignSpeakerLabels(vs);
    const forced = assignSpeakerLabels(vs, { speakerCount: 3 });
    expect(auto.speakerCount).toBe(1);
    expect(forced.speakerCount).toBe(3);
    expect(new Set(forced.speakers).size).toBe(3);
  });

  it('reports no silhouette for a forced count (nothing was selected)', () => {
    const vs = [1, 2, 3, 4].map((s) => voiceVector(EMBED_DIM, 0, s));
    expect(assignSpeakerLabels(vs, { speakerCount: 2 }).silhouette).toBeNull();
  });

  it('labels nothing when no segment carries an embedding', () => {
    const out = assignSpeakerLabels([null, null, null]);
    expect(out.speakers).toEqual([null, null, null]);
    expect(out.speakerCount).toBe(0);
  });

  // --- the unanimous-neighbour rule, probed on every branch ---------------

  it('inherits when both labelled neighbours AGREE', () => {
    const a1 = voiceVector(EMBED_DIM, 0, 1);
    const a2 = voiceVector(EMBED_DIM, 0, 2);
    const out = assignSpeakerLabels([a1, null, a2]);
    expect(out.speakers[1]).toBe(0);
  });

  it('stays UNKNOWN when the two labelled neighbours DISAGREE', () => {
    const a = voiceVector(EMBED_DIM, 0, 1);
    const b = voiceVector(EMBED_DIM, 3, 2);
    const out = assignSpeakerLabels([a, null, b]);
    expect(out.speakers[0]).toBe(0);
    expect(out.speakers[2]).toBe(1);
    expect(out.speakers[1]).toBeNull();
  });

  it('inherits from the only side that exists at the START of the transcript', () => {
    const a = voiceVector(EMBED_DIM, 0, 1);
    const b = voiceVector(EMBED_DIM, 3, 2);
    const out = assignSpeakerLabels([null, a, b]);
    expect(out.speakers[0]).toBe(0);
  });

  it('inherits from the only side that exists at the END of the transcript', () => {
    const a = voiceVector(EMBED_DIM, 0, 1);
    const b = voiceVector(EMBED_DIM, 3, 2);
    const out = assignSpeakerLabels([a, b, null]);
    expect(out.speakers[2]).toBe(1);
  });

  it('does NOT chain an inherited label across a gap into a disagreement', () => {
    // [A, ?, ?, B]: both unknowns sit between A and B, which disagree, so both
    // must stay null. Resolving against already-inherited labels would let A
    // walk right and B walk left until they met.
    const a = voiceVector(EMBED_DIM, 0, 1);
    const b = voiceVector(EMBED_DIM, 3, 2);
    const out = assignSpeakerLabels([a, null, null, b]);
    expect(out.speakers[1]).toBeNull();
    expect(out.speakers[2]).toBeNull();
  });

  it('labels a gap when the speakers on both sides are the SAME person', () => {
    const a1 = voiceVector(EMBED_DIM, 0, 1);
    const a2 = voiceVector(EMBED_DIM, 0, 2);
    const out = assignSpeakerLabels([a1, null, null, a2]);
    expect(out.speakers).toEqual([0, 0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe('transcribeDocument — refusals', () => {
  it('refuses an unknown document', async () => {
    const r = await transcribeDocument({ docId: 'nope' });
    expect(r).toEqual({ ok: false, status: 'no-document', message: 'Document nope is not open.' });
    expect(backend.runCalls).toBe(0);
  });

  it('refuses an empty document', async () => {
    const doc = createDocument({ name: 'Empty.wav', sampleRate: 48000, channels: [new Float32Array(0)] });
    useAppStore.getState().addDocument(doc);
    const r = await transcribeDocument({ docId: doc.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe('empty-document');
  });

  // The length cap, probed below / on / above. 48 kHz is exactly 3x the model
  // rate, so `modelLength = docLength / 3` with no rounding slack and each
  // case differs from its neighbour by ONE model sample.
  //
  // The documents are SPARSE (`{length}` only): the length gate runs before
  // any audio is touched, and materialising 2 h of samples per case would cost
  // 1.4 GB. To keep the on/below cases from reaching the resample, the models
  // are marked absent — `model-missing` is checked immediately AFTER the
  // length gate, so "not too-long" is exactly what those cases assert.
  function sparseDocOfModelLength(modelLength: number): AudioDocument {
    const doc = createDocument({
      name: 'Marathon.wav',
      sampleRate: 48000,
      channels: [{ length: modelLength * 3 } as unknown as Float32Array],
    });
    useAppStore.getState().addDocument(doc);
    return doc;
  }

  it('accepts a job ONE model sample below the host cap', async () => {
    backend.modelState = { downloaded: false, bytes: null, expectedBytes: TRANSCRIBE_MODEL_BYTES };
    const doc = sparseDocOfModelLength(MAX_MODEL_SAMPLES - 1);
    const r = await transcribeDocument({ docId: doc.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe('model-missing');
  });

  it('accepts a job EXACTLY at the host cap (the boundary is inclusive)', async () => {
    backend.modelState = { downloaded: false, bytes: null, expectedBytes: TRANSCRIBE_MODEL_BYTES };
    const doc = sparseDocOfModelLength(MAX_MODEL_SAMPLES);
    const r = await transcribeDocument({ docId: doc.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe('model-missing');
  });

  it('refuses a job ONE model sample above the host cap, before anything else', async () => {
    // Models present, so `too-long` cannot be confused with `model-missing`.
    const doc = sparseDocOfModelLength(MAX_MODEL_SAMPLES + 1);
    const r = await transcribeDocument({ docId: doc.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe('too-long');
    expect(backend.runCalls).toBe(0);
  });

  it('refuses a second run while one is in flight', async () => {
    const doc = seedDoc();
    const first = transcribeDocument({ docId: doc.id });
    await flush();
    const second = await transcribeDocument({ docId: doc.id });
    expect(second).toEqual({ ok: false, status: 'busy', message: 'A transcription is already running.' });
    backend.settle({ ok: true, segmentCount: 0 });
    await first;
  });

  it('refuses when the models are not downloaded, without spawning a run', async () => {
    backend.modelState = { downloaded: false, bytes: null, expectedBytes: TRANSCRIBE_MODEL_BYTES };
    const doc = seedDoc();
    const r = await transcribeDocument({ docId: doc.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe('model-missing');
    expect(backend.runCalls).toBe(0);
  });

  it('refuses when the preload has no transcription bridge at all', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    const doc = seedDoc();
    const r = await transcribeDocument({ docId: doc.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/unavailable in this build/);
  });
});

// ---------------------------------------------------------------------------
// The outgoing payload
// ---------------------------------------------------------------------------

describe('transcribeDocument — the outgoing payload', () => {
  it('sends mono 16 kHz audio produced by the app\'s own windowed-sinc, bit for bit', async () => {
    const doc = seedDoc({ channelCount: 2 });
    await runWith(doc, []);
    const req = backend.lastRequest;
    expect(req).not.toBeNull();
    expect(req?.sampleRate).toBe(WHISPER_SAMPLE_RATE);
    expect(req?.language).toBe('auto');

    const expected = resampleChannel(monoMix(doc.channels, HALF_SECOND_48K), 48000, WHISPER_SAMPLE_RATE);
    const sent = new Float32Array(req!.samples);
    expect(sent.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(sent[i]).toBe(expected[i]);
    }
  });

  it('never hands the document\'s own channel arrays to IPC', async () => {
    const doc = seedDoc({ channelCount: 1, sampleRate: WHISPER_SAMPLE_RATE, length: 8000 });
    await runWith(doc, []);
    expect(backend.lastRequest?.samples).not.toBe(doc.channels[0].buffer);
    // The resample is a no-op at an equal rate but still copies.
    expect(new Float32Array(backend.lastRequest!.samples)).toEqual(doc.channels[0]);
  });
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('transcribeDocument — a completed run', () => {
  it('converts every position into DOCUMENT samples and stores the transcript', async () => {
    const doc = seedDoc({ channelCount: 2 }); // 48 kHz, so 16 kHz -> x3
    const r = await runWith(doc, [hostSegment(0, 0, 1600, 'hello'), hostSegment(1, 1600, 3200, 'world')]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.transcript.sampleRate).toBe(48000);
    expect(r.transcript.segments.map((s) => [s.startSample, s.endSample])).toEqual([
      [0, 4800],
      [4800, 9600],
    ]);
    expect(r.transcript.segments.map((s) => s.text)).toEqual(['hello', 'world']);
    expect(getTranscript(doc.id)).toBe(r.transcript);
  });

  it('records the detected language', async () => {
    const doc = seedDoc();
    const r = await runWith(doc, [hostSegment(0, 0, 1600)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.transcript.language).toBe('en');
    expect(r.transcript.languageProbability).toBeCloseTo(0.99, 6);
  });

  it('diarizes from the embeddings and labels every segment', async () => {
    const doc = seedDoc();
    const segs = [0, 1, 2, 3].map((i) => hostSegment(i, i * 1600, (i + 1) * 1600));
    const embeddings = [
      { segmentIndex: 0, vector: voiceVector(EMBED_DIM, 0, 1) },
      { segmentIndex: 1, vector: voiceVector(EMBED_DIM, 3, 2) },
      { segmentIndex: 2, vector: voiceVector(EMBED_DIM, 0, 3) },
      { segmentIndex: 3, vector: voiceVector(EMBED_DIM, 3, 4) },
    ];
    const r = await runWith(doc, segs, embeddings);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.transcript.speakerCount).toBe(2);
    expect(r.transcript.segments.map((s) => s.speaker)).toEqual([0, 1, 0, 1]);
    expect(r.transcript.unembeddedSegments).toBe(0);
    expect(r.transcript.unlabelledSegments).toBe(0);
    expect(r.transcript.requestedSpeakerCount).toBeNull();
  });

  it('counts the segments the host could not embed', async () => {
    const doc = seedDoc();
    const segs = [0, 1, 2].map((i) => hostSegment(i, i * 1600, (i + 1) * 1600));
    const r = await runWith(doc, segs, [
      { segmentIndex: 0, vector: voiceVector(EMBED_DIM, 0, 1) },
      { segmentIndex: 2, vector: voiceVector(EMBED_DIM, 0, 2) },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.transcript.unembeddedSegments).toBe(1);
    // Both neighbours are the same voice, so the gap inherits.
    expect(r.transcript.segments[1].speaker).toBe(0);
  });

  it('honours a speaker count asserted at request time', async () => {
    const doc = seedDoc();
    const segs = [0, 1, 2, 3].map((i) => hostSegment(i, i * 1600, (i + 1) * 1600));
    const embeddings = [0, 1, 2, 3].map((i) => ({
      segmentIndex: i,
      vector: voiceVector(EMBED_DIM, 0, i + 1),
    }));
    const r = await runWith(doc, segs, embeddings, { speakerCount: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.transcript.requestedSpeakerCount).toBe(3);
    expect(r.transcript.speakerCount).toBe(3);
  });

  it('REFUSES a speaker count outside the bound rather than silently falling back to auto', () => {
    // The two paths used to disagree: `setTranscriptSpeakerCount` refused an
    // out-of-range count while this one quietly downgraded it to automatic,
    // so the same number meant two different things. Both refuse now.
    return (async () => {
      // 3 s at 48 kHz = 1 s at the model rate, so six 0.1 s cues fit.
      const doc = seedDoc({ length: 48000 * 3 });
      const segs = [0, 1, 2, 3, 4, 5].map((i) => hostSegment(i, i * 1600, (i + 1) * 1600));
      const embeddings = segs.map((sg) => ({
        segmentIndex: sg.index,
        vector: voiceVector(EMBED_DIM, 0, sg.index + 1),
      }));
      const r = await runWith(doc, segs, embeddings, { speakerCount: MAX_SPEAKERS + 1 });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.status).toBe('bad-speaker-count');
      expect(r.message).toMatch(/between 1 and/);
      expect(getTranscript(doc.id)).toBeNull();
    })();
  });

  it('refuses a speaker count the EVIDENCE cannot support, naming the real ceiling', async () => {
    // Two embedded segments cannot be split into three speakers. Asking for it
    // is impossible, not merely ambitious — the clusterer would clamp and the
    // UI would then show a number the result contradicts.
    const doc = seedDoc();
    const segs = [0, 1].map((i) => hostSegment(i, i * 1600, (i + 1) * 1600));
    const embeddings = segs.map((sg) => ({
      segmentIndex: sg.index,
      vector: voiceVector(EMBED_DIM, sg.index, sg.index + 1),
    }));
    const r = await runWith(doc, segs, embeddings, { speakerCount: 3 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('bad-speaker-count');
    expect(r.message).toMatch(/between 1 and 2/);
  });

  it('records the ceiling the evidence supports on the transcript', async () => {
    const doc = seedDoc();
    const segs = [0, 1, 2].map((i) => hostSegment(i, i * 1600, (i + 1) * 1600));
    // Only two of the three segments were embeddable.
    const r = await runWith(doc, segs, [
      { segmentIndex: 0, vector: voiceVector(EMBED_DIM, 0, 1) },
      { segmentIndex: 2, vector: voiceVector(EMBED_DIM, 0, 2) },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.transcript.maxUsableSpeakers).toBe(2);
  });

  it('sorts segments by the host index even when they arrive out of order', async () => {
    const doc = seedDoc();
    const promise = transcribeDocument({ docId: doc.id });
    await flush();
    backend.emitSegment(hostSegment(1, 1600, 3200, 'second'));
    backend.emitSegment(hostSegment(0, 0, 1600, 'first'));
    backend.settle({ ok: true, segmentCount: 2 });
    const r = await promise;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.transcript.segments.map((s) => s.text)).toEqual(['first', 'second']);
  });

  it('leaves no live IPC listeners behind', async () => {
    const doc = seedDoc();
    await runWith(doc, [hostSegment(0, 0, 1600)]);
    expect(backend.liveListeners).toBe(0);
    expect(isTranscribing()).toBe(false);
    expect(getTranscribeBusyCount()).toBe(0);
    expect(getTranscribeProgress()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Segment validation at the IPC boundary
// ---------------------------------------------------------------------------

describe('transcribeDocument — malformed host segments are dropped, and the shortfall is reported', () => {
  async function runDropping(doc: AudioDocument, bad: HostSegmentMsg): Promise<TranscribeResult> {
    const promise = transcribeDocument({ docId: doc.id });
    await flush();
    backend.emitSegment(bad);
    // The host would have counted it, so the count gate must catch the drop.
    backend.settle({ ok: true, segmentCount: 1 });
    return promise;
  }

  const CASES: [string, HostSegmentMsg][] = [
    ['a negative start', hostSegment(0, -1, 1600)],
    ['a non-integer start', { ...hostSegment(0, 0, 1600), startSample: 1.5 }],
    ['an end past the model length', hostSegment(0, 0, 10_000_000)],
    ['an end equal to the start', hostSegment(0, 800, 800)],
    ['an end before the start', hostSegment(0, 800, 700)],
    ['a negative index', hostSegment(-1, 0, 1600)],
    ['empty text', hostSegment(0, 0, 1600, '')],
  ];

  it.each(CASES)('drops %s and fails the count gate', async (_label, bad) => {
    const doc = seedDoc();
    const r = await runDropping(doc, bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/reported 1 segment\(s\) but delivered 0/);
  });

  it('accepts a segment ending EXACTLY at the model length (the boundary is inclusive)', async () => {
    const doc = seedDoc({ channelCount: 1, sampleRate: WHISPER_SAMPLE_RATE, length: 8000 });
    const r = await runWith(doc, [hostSegment(0, 0, 8000)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.transcript.segments).toHaveLength(1);
  });

  it('rejects a segment ending ONE SAMPLE past the model length', async () => {
    const doc = seedDoc({ channelCount: 1, sampleRate: WHISPER_SAMPLE_RATE, length: 8000 });
    const promise = transcribeDocument({ docId: doc.id });
    await flush();
    backend.emitSegment(hostSegment(0, 0, 8001));
    backend.settle({ ok: true, segmentCount: 1 });
    const r = await promise;
    expect(r.ok).toBe(false);
  });

  it('accepts a segment starting EXACTLY at zero', async () => {
    const doc = seedDoc();
    const r = await runWith(doc, [hostSegment(0, 0, 1600)]);
    expect(r.ok).toBe(true);
  });

  it('drops a duplicate index rather than double-counting it', async () => {
    const doc = seedDoc();
    const promise = transcribeDocument({ docId: doc.id });
    await flush();
    backend.emitSegment(hostSegment(0, 0, 1600, 'first'));
    backend.emitSegment(hostSegment(0, 1600, 3200, 'duplicate'));
    backend.settle({ ok: true, segmentCount: 1 });
    const r = await promise;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.transcript.segments.map((s) => s.text)).toEqual(['first']);
  });

  it('drops an embedding carrying a non-finite component instead of poisoning the clusterer', async () => {
    const doc = seedDoc();
    const poisoned = voiceVector(EMBED_DIM, 0, 1);
    poisoned[2] = Number.NaN;
    const segs = [0, 1].map((i) => hostSegment(i, i * 1600, (i + 1) * 1600));
    const r = await runWith(doc, segs, [
      { segmentIndex: 0, vector: poisoned },
      { segmentIndex: 1, vector: voiceVector(EMBED_DIM, 0, 2) },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.transcript.unembeddedSegments).toBe(1);
    // The surviving embedding still produces a usable, finite answer.
    expect(r.transcript.speakerCount).toBe(1);
    expect(r.transcript.segments.map((s) => s.speaker)).toEqual([0, 0]);
  });

  it('reports a segment-count shortfall as a failure rather than a short transcript', async () => {
    const doc = seedDoc();
    const promise = transcribeDocument({ docId: doc.id });
    await flush();
    backend.emitSegment(hostSegment(0, 0, 1600));
    backend.settle({ ok: true, segmentCount: 5 });
    const r = await promise;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/reported 5 segment\(s\) but delivered 1/);
    expect(backend.showMessageBox).toHaveBeenCalled();
    expect(getTranscript(doc.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cancel, staleness and failure
// ---------------------------------------------------------------------------

describe('transcribeDocument — cancel', () => {
  it('kills the run and settles cancelled', async () => {
    const doc = seedDoc();
    const promise = transcribeDocument({ docId: doc.id });
    await flush();
    expect(isTranscribing()).toBe(true);
    expect(await cancelTranscription()).toBe(true);
    const r = await promise;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('cancelled');
    expect(backend.cancelCalls).toBe(1);
    expect(backend.liveListeners).toBe(0);
    expect(getTranscript(doc.id)).toBeNull();
  });

  it('does not raise a native error box for a cancel', async () => {
    const doc = seedDoc();
    const promise = transcribeDocument({ docId: doc.id });
    await flush();
    await cancelTranscription();
    await promise;
    expect(backend.showMessageBox).not.toHaveBeenCalled();
  });

  it('cancels only once even if asked twice', async () => {
    const doc = seedDoc();
    const promise = transcribeDocument({ docId: doc.id });
    await flush();
    await cancelTranscription();
    await cancelTranscription();
    await promise;
    expect(backend.cancelCalls).toBe(1);
  });

  it('reports false when nothing is running', async () => {
    expect(await cancelTranscription()).toBe(false);
  });
});

describe('transcribeDocument — staleness', () => {
  it('aborts EARLY when the source audio is edited mid-run', async () => {
    const doc = seedDoc();
    const promise = transcribeDocument({ docId: doc.id });
    await flush();
    act(() => {
      useAppStore.getState().updateDocument({ ...doc, channels: [makeSignal(HALF_SECOND_48K, 999)] });
    });
    const r = await promise;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('stale');
    expect(backend.cancelCalls).toBe(1);
  });

  it('refuses to store a transcript for audio that changed, even with the early watch off', async () => {
    _setStaleWatchForTest(false);
    const doc = seedDoc();
    const promise = transcribeDocument({ docId: doc.id });
    await flush();
    backend.emitSegment(hostSegment(0, 0, 1600));
    act(() => {
      useAppStore.getState().updateDocument({ ...doc, channels: [makeSignal(HALF_SECOND_48K, 999)] });
    });
    backend.settle({ ok: true, segmentCount: 1 });
    const r = await promise;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('stale');
    expect(getTranscript(doc.id)).toBeNull();
  });

  it('settles source-closed when the document goes away mid-run', async () => {
    _setStaleWatchForTest(false);
    const doc = seedDoc();
    const promise = transcribeDocument({ docId: doc.id });
    await flush();
    act(() => {
      useAppStore.getState().closeDocument(doc.id);
    });
    backend.settle({ ok: true, segmentCount: 0 });
    const r = await promise;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('source-closed');
  });

  it('invalidateTranscript aborts an in-flight run for that document', async () => {
    const doc = seedDoc();
    const promise = transcribeDocument({ docId: doc.id });
    await flush();
    invalidateTranscript(doc.id);
    const r = await promise;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('source-closed');
    expect(backend.cancelCalls).toBe(1);
  });

  it('invalidateTranscript leaves another document\'s run alone', async () => {
    const doc = seedDoc();
    const other = seedDoc({ name: 'Other.wav' });
    const promise = transcribeDocument({ docId: doc.id });
    await flush();
    invalidateTranscript(other.id);
    expect(backend.cancelCalls).toBe(0);
    backend.settle({ ok: true, segmentCount: 0 });
    await promise;
  });

  it('closeDocumentFlow drops a finished transcript', async () => {
    const doc = seedDoc();
    await runWith(doc, [hostSegment(0, 0, 1600)]);
    expect(getTranscript(doc.id)).not.toBeNull();
    await closeDocumentFlow(doc.id);
    expect(getTranscript(doc.id)).toBeNull();
  });
});

describe('isTranscriptStale', () => {
  it('is false for a fresh transcript', async () => {
    const doc = seedDoc();
    await runWith(doc, [hostSegment(0, 0, 1600)]);
    expect(isTranscriptStale(doc.id)).toBe(false);
  });

  it('becomes true after the audio is edited — and the transcript is KEPT', async () => {
    const doc = seedDoc();
    await runWith(doc, [hostSegment(0, 0, 1600)]);
    act(() => {
      useAppStore.getState().updateDocument({ ...doc, channels: [makeSignal(HALF_SECOND_48K, 777)] });
    });
    expect(isTranscriptStale(doc.id)).toBe(true);
    expect(getTranscript(doc.id)).not.toBeNull();
  });

  it('is false when there is no transcript at all', () => {
    expect(isTranscriptStale('nothing')).toBe(false);
  });
});

describe('transcribeDocument — failure', () => {
  it('surfaces a host error and raises a native box', async () => {
    const doc = seedDoc();
    const promise = transcribeDocument({ docId: doc.id });
    await flush();
    backend.settle({ ok: false, error: 'the host exploded' });
    const r = await promise;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('failed');
    expect(r.message).toBe('the host exploded');
    expect(backend.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'the host exploded' })
    );
  });

  it('resolves (never rejects) when the IPC invoke itself dies, and still kills the child', async () => {
    backend.invokeThrows = 'channel closed';
    const doc = seedDoc();
    const r = await transcribeDocument({ docId: doc.id });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('failed');
    expect(r.message).toBe('channel closed');
    expect(backend.cancelCalls).toBe(1);
    expect(backend.liveListeners).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

describe('transcribeDocument — progress', () => {
  it('reports the transcribe stage as a fraction of the model-rate samples', async () => {
    const doc = seedDoc();
    const seen: TranscribeProgress[] = [];
    const promise = transcribeDocument({ docId: doc.id, onProgress: (p) => seen.push(p) });
    await flush();
    backend.emitProgress({ stage: 'transcribe', done: 4000, total: 8000 });
    backend.settle({ ok: true, segmentCount: 0 });
    await promise;
    const transcribing = seen.filter((p) => p.phase === 'transcribing');
    expect(transcribing.at(-1)?.fraction).toBeCloseTo(0.5, 6);
    expect(transcribing.at(-1)?.done).toBe(4000);
    expect(transcribing.at(-1)?.total).toBe(8000);
  });

  it('reports the embedding stage in segments, not samples', async () => {
    const doc = seedDoc();
    const seen: TranscribeProgress[] = [];
    const promise = transcribeDocument({ docId: doc.id, onProgress: (p) => seen.push(p) });
    await flush();
    backend.emitProgress({ stage: 'embed', done: 3, total: 4 });
    backend.settle({ ok: true, segmentCount: 0 });
    await promise;
    const embedding = seen.filter((p) => p.phase === 'embedding');
    expect(embedding.at(-1)?.fraction).toBeCloseTo(0.75, 6);
  });

  it('passes through the resampling and clustering phases', async () => {
    const doc = seedDoc();
    const seen: TranscribeProgress[] = [];
    await runWith(doc, [hostSegment(0, 0, 1600)], [], { onProgress: (p) => seen.push(p) });
    expect(seen.map((p) => p.phase)).toEqual(
      expect.arrayContaining(['resampling', 'transcribing', 'clustering'])
    );
  });

  it('clamps a fraction the host over-reports to 1', async () => {
    const doc = seedDoc();
    const seen: TranscribeProgress[] = [];
    const promise = transcribeDocument({ docId: doc.id, onProgress: (p) => seen.push(p) });
    await flush();
    backend.emitProgress({ stage: 'transcribe', done: 9000, total: 8000 });
    backend.settle({ ok: true, segmentCount: 0 });
    await promise;
    expect(seen.filter((p) => p.phase === 'transcribing').at(-1)?.fraction).toBe(1);
  });

  it('drops progress that arrives after the run settled', async () => {
    const doc = seedDoc();
    const seen: TranscribeProgress[] = [];
    await runWith(doc, [], [], { onProgress: (p) => seen.push(p) });
    const before = seen.length;
    backend.emitProgress({ stage: 'transcribe', done: 1, total: 8000 });
    expect(seen.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Re-clustering
// ---------------------------------------------------------------------------

describe('setTranscriptSpeakerCount', () => {
  async function twoVoices(): Promise<AudioDocument> {
    const doc = seedDoc();
    const segs = [0, 1, 2, 3].map((i) => hostSegment(i, i * 1600, (i + 1) * 1600));
    await runWith(doc, segs, [
      { segmentIndex: 0, vector: voiceVector(EMBED_DIM, 0, 1) },
      { segmentIndex: 1, vector: voiceVector(EMBED_DIM, 3, 2) },
      { segmentIndex: 2, vector: voiceVector(EMBED_DIM, 0, 3) },
      { segmentIndex: 3, vector: voiceVector(EMBED_DIM, 3, 4) },
    ]);
    return doc;
  }

  it('re-clusters at a forced count WITHOUT another IPC run', async () => {
    const doc = await twoVoices();
    const before = backend.runCalls;
    const next = setTranscriptSpeakerCount(doc.id, 1);
    expect(backend.runCalls).toBe(before);
    expect(next?.speakerCount).toBe(1);
    expect(next?.requestedSpeakerCount).toBe(1);
    expect(next?.segments.every((s) => s.speaker === 0)).toBe(true);
  });

  it('keeps the timestamps and text untouched across a re-cluster', async () => {
    const doc = await twoVoices();
    const before = getTranscript(doc.id)!;
    const after = setTranscriptSpeakerCount(doc.id, 3)!;
    expect(after.segments.map((s) => [s.startSample, s.endSample, s.text])).toEqual(
      before.segments.map((s) => [s.startSample, s.endSample, s.text])
    );
  });

  it('goes back to auto-detection with null', async () => {
    const doc = await twoVoices();
    setTranscriptSpeakerCount(doc.id, 1);
    const back = setTranscriptSpeakerCount(doc.id, null);
    expect(back?.requestedSpeakerCount).toBeNull();
    expect(back?.speakerCount).toBe(2);
  });

  it('publishes a new transcript object so subscribers re-render', async () => {
    const doc = await twoVoices();
    const before = getTranscript(doc.id);
    const versionBefore = getTranscribeVersion();
    const after = setTranscriptSpeakerCount(doc.id, 1);
    expect(after).not.toBe(before);
    expect(getTranscribeVersion()).toBeGreaterThan(versionBefore);
  });

  it('is a no-op when the count is already what was asked for', async () => {
    const doc = await twoVoices();
    const before = getTranscript(doc.id);
    expect(setTranscriptSpeakerCount(doc.id, null)).toBe(before);
  });

  // --- the [1, MAX_SPEAKERS] bound, probed below / on / above -------------

  it('refuses a count of 0 (below the bound)', async () => {
    const doc = await twoVoices();
    expect(setTranscriptSpeakerCount(doc.id, 0)).toBeNull();
    expect(getTranscript(doc.id)?.requestedSpeakerCount).toBeNull();
  });

  it('accepts a count of exactly 1 (the low bound)', async () => {
    const doc = await twoVoices();
    expect(setTranscriptSpeakerCount(doc.id, 1)?.requestedSpeakerCount).toBe(1);
  });

  it('accepts a count of exactly the evidence ceiling (4 embedded segments)', async () => {
    const doc = await twoVoices();
    expect(getTranscript(doc.id)?.maxUsableSpeakers).toBe(4);
    expect(setTranscriptSpeakerCount(doc.id, 4)?.requestedSpeakerCount).toBe(4);
  });

  it('refuses a count one above the evidence ceiling rather than clamping it', async () => {
    const doc = await twoVoices();
    expect(setTranscriptSpeakerCount(doc.id, 5)).toBeNull();
  });

  it('refuses a count above MAX_SPEAKERS too', async () => {
    const doc = await twoVoices();
    expect(setTranscriptSpeakerCount(doc.id, MAX_SPEAKERS + 1)).toBeNull();
  });

  it('refuses a non-integer count', async () => {
    const doc = await twoVoices();
    expect(setTranscriptSpeakerCount(doc.id, 2.5)).toBeNull();
  });

  it('returns null when there is no transcript', () => {
    expect(setTranscriptSpeakerCount('nothing', 2)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe('exportTranscript', () => {
  async function withTranscript(): Promise<AudioDocument> {
    // 3 s at 48 kHz = 1 s at the model rate, so the two 1 s cues below fit.
    const doc = seedDoc({ length: 48000 * 3 });
    await runWith(
      doc,
      [hostSegment(0, 0, 16000, 'first line'), hostSegment(1, 16000, 32000, 'second line')],
      [
        { segmentIndex: 0, vector: voiceVector(EMBED_DIM, 0, 1) },
        { segmentIndex: 1, vector: voiceVector(EMBED_DIM, 3, 2) },
      ]
    );
    return doc;
  }

  it('writes exactly what the shared SRT formatter produces', async () => {
    const doc = await withTranscript();
    const path = await exportTranscript(doc.id, 'srt');
    expect(path).toBe('D:\\out\\Interview.srt');
    const transcript = getTranscript(doc.id)!;
    expect(backend.writes).toHaveLength(1);
    expect(backend.writes[0].text).toBe(formatSrt(transcript.segments, transcript.sampleRate));
    expect(backend.writes[0].text).toMatch(/Speaker 1: first line/);
  });

  it('writes exactly what the shared WebVTT formatter produces', async () => {
    const doc = await withTranscript();
    backend.saveDialogPath = 'D:\\out\\Interview.vtt';
    await exportTranscript(doc.id, 'vtt');
    const transcript = getTranscript(doc.id)!;
    expect(backend.writes[0].text).toBe(formatWebVtt(transcript.segments, transcript.sampleRate));
    expect(backend.writes[0].text.startsWith('WEBVTT')).toBe(true);
  });

  it('proposes the document name with the extension REPLACED, not appended', async () => {
    const doc = await withTranscript();
    await exportTranscript(doc.id, 'srt');
    expect(backend.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'Interview.srt' })
    );
  });

  it('offers the matching filter extension per format', async () => {
    const doc = await withTranscript();
    await exportTranscript(doc.id, 'vtt');
    expect(backend.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ name: 'WebVTT subtitles', extensions: ['vtt'] }] })
    );
  });

  it('writes nothing when the save dialog is cancelled', async () => {
    const doc = await withTranscript();
    backend.saveDialogPath = null;
    expect(await exportTranscript(doc.id, 'srt')).toBeNull();
    expect(backend.writes).toHaveLength(0);
  });

  it('surfaces a write failure and returns null', async () => {
    const doc = await withTranscript();
    backend.writeResult = { ok: false, error: 'disk full' };
    expect(await exportTranscript(doc.id, 'srt')).toBeNull();
    expect(backend.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'disk full' })
    );
  });

  it('refuses to export a document with no transcript', async () => {
    const doc = seedDoc();
    expect(await exportTranscript(doc.id, 'srt')).toBeNull();
    expect(backend.showSaveDialog).not.toHaveBeenCalled();
  });

  it('refuses to export an EMPTY transcript rather than writing a blank file', async () => {
    const doc = seedDoc();
    await runWith(doc, []);
    expect(getTranscript(doc.id)?.segments).toHaveLength(0);
    expect(await exportTranscript(doc.id, 'srt')).toBeNull();
    expect(backend.writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Model state + reactivity
// ---------------------------------------------------------------------------

describe('model state', () => {
  it('passes the manager\'s answer through', async () => {
    expect(await getTranscribeModelState()).toEqual({
      downloaded: true,
      bytes: TRANSCRIBE_MODEL_BYTES,
      expectedBytes: TRANSCRIBE_MODEL_BYTES,
    });
  });

  it('reads as "not downloaded" with no preload rather than throwing', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    expect(await getTranscribeModelState()).toEqual({
      downloaded: false,
      bytes: null,
      expectedBytes: TRANSCRIBE_MODEL_BYTES,
    });
  });

  it('ensureTranscribeModels resolves an error instead of rejecting with no preload', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    expect(await ensureTranscribeModels()).toEqual({
      ok: false,
      error: 'Transcription is unavailable in this build.',
    });
  });

  it('ensureTranscribeModels reaches the manager', async () => {
    expect(await ensureTranscribeModels()).toEqual({ ok: true });
    expect(backend.ensureCalls).toBe(1);
  });
});

describe('useTranscribeVersion', () => {
  it('re-renders on a transcript change', async () => {
    const doc = seedDoc();
    const { result } = renderHook(() => useTranscribeVersion());
    const before = result.current;
    await act(async () => {
      await runWith(doc, [hostSegment(0, 0, 1600)]);
    });
    expect(result.current).toBeGreaterThan(before);
  });
});
