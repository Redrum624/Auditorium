import { renderHook, act } from '@testing-library/react';
import {
  separateStems,
  cancelStemSeparation,
  isStemSeparationRunning,
  getStemBusyCount,
  getStemProgress,
  getStemModelState,
  ensureStemModel,
  invalidateStemRun,
  _setStaleWatchForTest,
  getStemVersion,
  useStemVersion,
  STEM_LABELS,
  MODEL_SAMPLE_RATE,
  type StemSeparationProgress,
  type StemSeparationResult,
} from './stemService';
import { closeDocumentFlow } from './fileService';
import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { resampleChannel } from '../dsp/resample';
import * as resampleModule from '../dsp/resample';
import { partitionStems } from '../dsp/stemPartition';

// ---------------------------------------------------------------------------
// Fixtures — deterministic pseudo-noise (the LCG recipe this repo re-declares
// per test file: remixService.test.ts, tempoCore.test.ts, resample.test.ts).
// Short on purpose: every test pays a real windowed-sinc resample AND a real
// STFT partition, so half a second of audio keeps the suite honest and fast.
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
  // Noise plus a tone, so the spectrum is neither flat nor a single line.
  for (let i = 0; i < length; i++) {
    out[i] = 0.35 * rand() + 0.4 * Math.sin((2 * Math.PI * 220 * i) / 48000);
  }
  return out;
}

function seedDoc(opts: { channelCount?: 1 | 2; sampleRate?: number; length?: number } = {}): AudioDocument {
  const channelCount = opts.channelCount ?? 2;
  const sampleRate = opts.sampleRate ?? 48000;
  const length = opts.length ?? HALF_SECOND_48K;
  const channels: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) channels.push(makeSignal(length, 12345 + c * 7));
  const doc = createDocument({ name: 'Song.wav', sampleRate, channels, filePath: 'D:\\Song.wav' });
  useAppStore.getState().addDocument(doc);
  return doc;
}

// ---------------------------------------------------------------------------
// The stem IPC mock — a faithful stand-in for stemManager.cjs's renderer
// contract (electron/stemManager.cjs module header): one run at a time,
// 'stems:progress' + 'stems:chunk' events while in flight, and a `separate`
// invoke that resolves {ok:true,totalSegments} | {ok:false,cancelled:true} |
// {ok:false,error} and NEVER rejects unless the IPC channel itself dies.
// ---------------------------------------------------------------------------

type SeparateResult =
  | { ok: true; totalSegments: number }
  | { ok: false; cancelled: true }
  | { ok: false; error: string };

interface StemBackend {
  lastRequest: { sampleRate: number; channels: ArrayBuffer[] } | null;
  separateCalls: number;
  cancelCalls: number;
  ensureCalls: number;
  /** Currently-registered event listeners — must be back to 0 after any path. */
  liveListeners: number;
  modelState: { downloaded: boolean; bytes: number | null; expectedBytes: number };
  /** Set to make the separate invoke itself reject (dead IPC channel). */
  invokeThrows: string | null;
  emitProgress(p: { segment: number; totalSegments: number }): void;
  emitChunk(c: { offset: number; samples: number; data: ArrayBuffer }): void;
  settle(result: SeparateResult): void;
  showMessageBox: jest.Mock;
}

function installStemApi(): StemBackend {
  const progressListeners = new Set<(p: { segment: number; totalSegments: number }) => void>();
  const chunkListeners = new Set<(c: { offset: number; samples: number; data: ArrayBuffer }) => void>();
  let pending: ((r: SeparateResult) => void) | null = null;

  const backend: StemBackend = {
    lastRequest: null,
    separateCalls: 0,
    cancelCalls: 0,
    ensureCalls: 0,
    liveListeners: 0,
    modelState: { downloaded: true, bytes: 165612636, expectedBytes: 165612636 },
    invokeThrows: null,
    emitProgress(p) {
      for (const cb of [...progressListeners]) cb(p);
    },
    emitChunk(c) {
      for (const cb of [...chunkListeners]) cb(c);
    },
    settle(result) {
      const resolve = pending;
      pending = null;
      resolve?.(result);
    },
    showMessageBox: jest.fn().mockResolvedValue(0),
  };

  const api = {
    showMessageBox: backend.showMessageBox,
    stemsModelState: async () => backend.modelState,
    stemsEnsureModel: async () => {
      backend.ensureCalls++;
      return backend.modelState.downloaded
        ? { ok: true as const, path: 'D:\\model.onnx' }
        : { ok: false as const, error: 'offline' };
    },
    onStemsModelProgress: (cb: (p: { received: number; total: number }) => void) => {
      void cb;
      return () => {};
    },
    stemsSeparate: (req: { sampleRate: number; channels: ArrayBuffer[] }) => {
      backend.separateCalls++;
      backend.lastRequest = req;
      if (backend.invokeThrows) return Promise.reject(new Error(backend.invokeThrows));
      return new Promise<SeparateResult>((resolve) => {
        pending = resolve;
      });
    },
    stemsCancel: async () => {
      backend.cancelCalls++;
      if (pending) {
        backend.settle({ ok: false, cancelled: true });
        return { cancelled: true };
      }
      return { cancelled: false };
    },
    onStemsProgress: (cb: (p: { segment: number; totalSegments: number }) => void) => {
      progressListeners.add(cb);
      backend.liveListeners++;
      return () => {
        if (progressListeners.delete(cb)) backend.liveListeners--;
      };
    },
    onStemsChunk: (cb: (c: { offset: number; samples: number; data: ArrayBuffer }) => void) => {
      chunkListeners.add(cb);
      backend.liveListeners++;
      return () => {
        if (chunkListeners.delete(cb)) backend.liveListeners--;
      };
    },
  };

  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  return backend;
}

/** Host stem order is drums, bass, other, vocals (stemSegmentation.cjs
 * STEM_NAMES). Distinct gains so the ruling-6 REORDER to Drums, Bass, Vocals,
 * Other is decidable from the output alone. */
const HOST_GAINS = [0.5, 0.25, 0.125, 0.0625];
const GAIN_ENERGY = HOST_GAINS.reduce((a, g) => a + g * g, 0);
/** Ratio mask each stem gets when every estimate is a scaled copy of the mix:
 * m_i = g_i²/Σg_j². Ordered as the RESULT is (Drums, Bass, Vocals, Other). */
const EXPECTED_MASKS = [
  (HOST_GAINS[0] * HOST_GAINS[0]) / GAIN_ENERGY,
  (HOST_GAINS[1] * HOST_GAINS[1]) / GAIN_ENERGY,
  (HOST_GAINS[3] * HOST_GAINS[3]) / GAIN_ENERGY,
  (HOST_GAINS[2] * HOST_GAINS[2]) / GAIN_ENERGY,
];

/** Per-channel gains that DISAGREE between the two sides: the host order is
 * reversed on the right. Every mask is then channel-dependent, so a partition
 * that masked channel 1 with channel 0's estimates is decidable from the
 * output. (With the symmetric `HOST_GAINS` it is not: the mask is the same
 * constant on both sides, and exact-sum hides the swap in the residual.) */
function asymmetricGain(s: number, c: number): number {
  return c === 0 ? HOST_GAINS[s] : HOST_GAINS[HOST_GAINS.length - 1 - s];
}

/** m_i = g_i(c)²/Σ_j g_j(c)² for channel `c`, in the RESULT's ruling-6 order. */
function expectedMasksFor(gainFor: (s: number, c: number) => number, c: number): number[] {
  const energy = [0, 1, 2, 3].reduce((a, s) => a + gainFor(s, c) * gainFor(s, c), 0);
  return [0, 1, 3, 2].map((host) => (gainFor(host, c) * gainFor(host, c)) / energy);
}

const MODEL_CHANNELS = 2;
const STEM_COUNT = 4;

/** Builds one 'stems:chunk' payload covering [0, samples) from the model-rate
 * mix the service actually sent: planar stem-major/channel-minor, block
 * s*2+c, stems in HOST order. Mono input is repeated into both channels
 * exactly as stemHost.cjs's buildSegmentInput does. */
interface ChunkOptions {
  corrupt?: (data: Float32Array) => void;
  /** Gain applied to model channel `c` of host stem `s`. Defaults to the
   * symmetric `HOST_GAINS[s]`; an ASYMMETRIC gain is what pins the mono fold. */
  gainFor?: (s: number, c: number) => number;
  offset?: number;
}

function buildChunk(
  modelChannels: Float32Array[],
  opts: ChunkOptions = {}
): { offset: number; samples: number; data: ArrayBuffer } {
  const gainFor = opts.gainFor ?? ((s: number) => HOST_GAINS[s]);
  const samples = modelChannels[0].length;
  const data = new Float32Array(STEM_COUNT * MODEL_CHANNELS * samples);
  for (let s = 0; s < STEM_COUNT; s++) {
    for (let c = 0; c < MODEL_CHANNELS; c++) {
      const src = modelChannels[Math.min(c, modelChannels.length - 1)];
      const base = (s * MODEL_CHANNELS + c) * samples;
      for (let n = 0; n < samples; n++) data[base + n] = src[n] * gainFor(s, c);
    }
  }
  opts.corrupt?.(data);
  return { offset: opts.offset ?? 0, samples, data: data.buffer };
}

/** `fitLength` from stemService.ts, re-declared here so the expectation is
 * independent of the implementation under test. */
function fitLengthLocal(input: Float32Array, length: number): Float32Array {
  if (input.length === length) return input;
  const out = new Float32Array(length);
  out.set(input.subarray(0, Math.min(length, input.length)));
  return out;
}

/** The MODEL-rate estimates the service must have accumulated from a chunk
 * built with the same `gainFor` -- including the mono fold (average of the
 * model's two channels), reproduced independently. */
function modelEstimatesFrom(
  modelChannels: Float32Array[],
  channelCount: number,
  gainFor: (s: number, c: number) => number
): Float32Array[][] {
  const samples = modelChannels[0].length;
  const out: Float32Array[][] = [];
  for (let s = 0; s < STEM_COUNT; s++) {
    const perChannel: Float32Array[] = [];
    for (let c = 0; c < channelCount; c++) {
      const arr = new Float32Array(samples);
      if (channelCount === 1) {
        const left = new Float32Array(samples);
        const right = new Float32Array(samples);
        for (let n = 0; n < samples; n++) {
          left[n] = modelChannels[0][n] * gainFor(s, 0);
          right[n] = modelChannels[0][n] * gainFor(s, 1);
        }
        for (let n = 0; n < samples; n++) arr[n] = (left[n] + right[n]) / 2;
      } else {
        for (let n = 0; n < samples; n++) arr[n] = modelChannels[c][n] * gainFor(s, c);
      }
      perChannel.push(arr);
    }
    out.push(perChannel);
  }
  return out;
}

/** Rebuilds -- independently of the service -- exactly what `partitionStems`
 * must have been handed: host-order estimates reordered to ruling-6 order and
 * carried back UP to the document rate with the app's own windowed-sinc. */
function expectedPartition(modelEstimates: Float32Array[][], doc: AudioDocument) {
  const hostForLabel = [0, 1, 3, 2];
  const docLength = doc.channels[0].length;
  const estimates = hostForLabel.map((h) =>
    modelEstimates[h].map((ch) =>
      fitLengthLocal(resampleChannel(ch, MODEL_SAMPLE_RATE, doc.sampleRate), docLength)
    )
  );
  return partitionStems(doc.channels, estimates, { collectStats: true });
}

function expectBitExact(actual: Float32Array, expected: Float32Array, label: string): void {
  expect(actual.length).toBe(expected.length);
  for (let n = 0; n < expected.length; n++) {
    if (actual[n] !== expected[n]) {
      throw new Error(
        `${label}: first difference at sample ${n} -- got ${actual[n]}, expected ${expected[n]}`
      );
    }
  }
}

function requestChannels(backend: StemBackend): Float32Array[] {
  if (!backend.lastRequest) throw new Error('no separate request recorded');
  return backend.lastRequest.channels.map((b) => new Float32Array(b));
}

async function waitForRequest(backend: StemBackend): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (backend.lastRequest) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('timed out waiting for the separate request');
}

/** Drives a full, successful backend run: N progress events, one complete
 * chunk, then {ok:true}. */
async function driveSuccess(
  backend: StemBackend,
  opts: ChunkOptions & { segments?: number } = {}
): Promise<void> {
  const segments = opts.segments ?? 3;
  await waitForRequest(backend);
  for (let i = 1; i <= segments; i++) backend.emitProgress({ segment: i, totalSegments: segments });
  backend.emitChunk(buildChunk(requestChannels(backend), opts));
  backend.settle({ ok: true, totalSegments: segments });
}

/**
 * Reconstruction check stated exactly the way `stemPartition.ts` documents the
 * identity: a FLOAT32 left-to-right running sum over the delivered source
 * order with the Residual accumulated LAST — the arithmetic `mixdownSession`
 * itself uses.
 *
 * The bound is expressed in float32 ULPs of the LOCAL magnitude, not as one
 * absolute number. S2's own absolute figure (8.7e-16) is a property of ITS
 * fixtures, where the residual is a ~1e-8 reconstruction remainder; here the
 * stub estimates deliberately leave real energy in the Residual (Σ masks < 1
 * for quiet bins), so the residual is audible-scale and its float32 STORAGE
 * granularity scales with it. One ULP is the floor for float32 audio — the
 * documented, unavoidable bound — so that is what is asserted.
 */
function reconstructionError(
  output: { stems: { channels: Float32Array[] }[]; residual: Float32Array[]; channelCount: number; lengthSamples: number },
  mix: Float32Array[]
): { worstAbs: number; worstUlps: number; exactFraction: number; residualPeak: number } {
  let worstAbs = 0;
  let worstUlps = 0;
  let residualPeak = 0;
  let exact = 0;
  let total = 0;
  for (let c = 0; c < output.channelCount; c++) {
    for (let n = 0; n < output.lengthSamples; n++) {
      let acc = output.stems[0].channels[c][n];
      for (let s = 1; s < output.stems.length; s++) acc = Math.fround(acc + output.stems[s].channels[c][n]);
      const residual = output.residual[c][n];
      residualPeak = Math.max(residualPeak, Math.abs(residual));
      const recon = Math.fround(acc + residual);
      const err = Math.abs(recon - mix[c][n]);
      const scale = Math.max(Math.abs(mix[c][n]), Math.abs(acc), Math.abs(residual));
      const ulp = scale * Math.pow(2, -23);
      worstAbs = Math.max(worstAbs, err);
      if (ulp > 0) worstUlps = Math.max(worstUlps, err / ulp);
      if (recon === mix[c][n]) exact++;
      total++;
    }
  }
  return { worstAbs, worstUlps, exactFraction: exact / total, residualPeak };
}

function expectReconstructs(
  label: string,
  output: { stems: { channels: Float32Array[] }[]; residual: Float32Array[]; channelCount: number; lengthSamples: number },
  mix: Float32Array[]
): void {
  const { worstAbs, worstUlps, exactFraction, residualPeak } = reconstructionError(output, mix);
  console.log(
    `[stemService] ${label}: worst |err| ${worstAbs.toExponential(3)} (${worstUlps.toFixed(2)} float32 ULP), ` +
      `${(exactFraction * 100).toFixed(4)}% bit-exact, residual peak ${residualPeak.toExponential(3)}`
  );
  // Within one float32 storage ULP (2x for the two roundings: storing the
  // residual, then the final add) — nothing was lost beyond f32 granularity.
  expect(worstUlps).toBeLessThanOrEqual(2);
  // ...and in absolute terms below one ULP at full scale (~ -138 dBFS).
  expect(worstAbs).toBeLessThan(1.5e-7);
  expect(exactFraction).toBeGreaterThan(0.99);
}

function rms(a: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
  return Math.sqrt(sum / Math.max(1, a.length));
}

function expectOk(result: StemSeparationResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.status}: ${result.message}`);
  return result.output;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
});

afterEach(async () => {
  // Nothing may outlive a test: an in-flight run holds a store subscription
  // and (in production) a utility process.
  await cancelStemSeparation();
  _setStaleWatchForTest(true);
  jest.restoreAllMocks();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe('separateStems — happy path', () => {
  it('returns four labelled stems in ruling-6 order plus a residual, at the document rate', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    const promise = separateStems({ sourceDocId: doc.id });
    await driveSuccess(backend);
    const output = expectOk(await promise);

    expect(output.stems.map((s) => s.label)).toEqual([...STEM_LABELS]);
    expect(STEM_LABELS).toEqual(['Drums', 'Bass', 'Vocals', 'Other']);
    expect(output.sampleRate).toBe(48000);
    expect(output.channelCount).toBe(2);
    expect(output.lengthSamples).toBe(HALF_SECOND_48K);
    for (const stem of output.stems) {
      expect(stem.channels).toHaveLength(2);
      for (const ch of stem.channels) expect(ch.length).toBe(HALF_SECOND_48K);
    }
    expect(output.residual).toHaveLength(2);
    expect(output.residual[0].length).toBe(HALF_SECOND_48K);
    expect(output.sourceDocId).toBe(doc.id);
    expect(output.sanitisedEstimateSamples).toBe(0);
  });

  it('maps the host stem order (drums, bass, other, vocals) onto the ruling-6 order', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    const promise = separateStems({ sourceDocId: doc.id });
    await driveSuccess(backend);
    const output = expectOk(await promise);

    // Every estimate is a scaled copy of the mix, so each ratio mask is the
    // constant g_i²/Σg_j² and each stem's RMS is that fraction of the mix's.
    // A wrong Vocals/Other swap moves the 3rd stem from 0.0118 to 0.0471 — a
    // 4x error, far outside this tolerance.
    const mixRms = rms(doc.channels[0]);
    for (let i = 0; i < 4; i++) {
      expect(rms(output.stems[i].channels[0]) / mixRms).toBeCloseTo(EXPECTED_MASKS[i], 2);
    }
    expect(EXPECTED_MASKS[2]).toBeLessThan(EXPECTED_MASKS[3]); // Vocals quieter than Other here
  });

  it('masks each channel with the estimate for THAT channel, not with channel 0’s', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    const promise = separateStems({ sourceDocId: doc.id });
    await driveSuccess(backend, { gainFor: asymmetricGain });
    const output = expectOk(await promise);

    const left = expectedMasksFor(asymmetricGain, 0);
    const right = expectedMasksFor(asymmetricGain, 1);
    // The two sides genuinely disagree — otherwise this test would pass on a
    // partition that never looked at the channel index at all.
    expect(left).not.toEqual(right);
    for (let i = 0; i < 4; i++) {
      expect(rms(output.stems[i].channels[0]) / rms(doc.channels[0])).toBeCloseTo(left[i], 2);
      expect(rms(output.stems[i].channels[1]) / rms(doc.channels[1])).toBeCloseTo(right[i], 2);
      // Explicitly NOT the other side's fraction: a dropped channel index in
      // the analysis loop lands exactly there.
      expect(rms(output.stems[i].channels[1]) / rms(doc.channels[1])).not.toBeCloseTo(left[i], 2);
    }
  });

  it('reports mask stats and leaves no listener behind', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    const promise = separateStems({ sourceDocId: doc.id });
    await driveSuccess(backend);
    const output = expectOk(await promise);

    expect(output.stats).toBeDefined();
    expect(output.stats!.maskMin).toBeGreaterThanOrEqual(0);
    expect(output.stats!.maxMaskSum).toBeLessThanOrEqual(1 + 1e-6);
    expect(backend.liveListeners).toBe(0);
    expect(isStemSeparationRunning()).toBe(false);
    expect(getStemBusyCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Resample discipline (ruling 4)
// ---------------------------------------------------------------------------

describe('resample discipline (ruling 4)', () => {
  it('sends the mix to the model at 44.1 kHz from a 48 kHz document, resampled with the app windowed-sinc', async () => {
    const backend = installStemApi();
    const doc = seedDoc({ sampleRate: 48000 });

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);

    expect(backend.lastRequest!.sampleRate).toBe(MODEL_SAMPLE_RATE);
    const sent = requestChannels(backend);
    expect(sent).toHaveLength(2);
    // BIT-EXACT against the app's own resampleChannel: this pins "never
    // linear interpolation, never a hand-rolled resampler".
    for (let c = 0; c < 2; c++) {
      const expected = resampleChannel(doc.channels[c], 48000, MODEL_SAMPLE_RATE);
      expect(sent[c].length).toBe(expected.length);
      expect(Array.from(sent[c].subarray(0, 2000))).toEqual(Array.from(expected.subarray(0, 2000)));
    }
    expect(sent[0].length).toBe(Math.round(HALF_SECOND_48K * (MODEL_SAMPLE_RATE / 48000)));

    await driveSuccess(backend);
    const output = expectOk(await promise);
    // ...and the estimates come back UP to the document rate: the partition
    // ran at 48 kHz over the original mix.
    expect(output.sampleRate).toBe(48000);
    expect(output.stems[0].channels[0].length).toBe(HALF_SECOND_48K);
  });

  it('sends a 44.1 kHz document through unchanged (no resample round trip)', async () => {
    const backend = installStemApi();
    const doc = seedDoc({ sampleRate: MODEL_SAMPLE_RATE, length: 22050 });

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    const sent = requestChannels(backend);
    expect(sent[0].length).toBe(22050);
    expect(Array.from(sent[0].subarray(0, 1000))).toEqual(Array.from(doc.channels[0].subarray(0, 1000)));

    await driveSuccess(backend);
    const output = expectOk(await promise);
    expect(output.lengthSamples).toBe(22050);
  });

  it('keeps the exact-sum reconstruction after the resample round trip (48 kHz source)', async () => {
    const backend = installStemApi();
    const doc = seedDoc({ sampleRate: 48000 });

    const promise = separateStems({ sourceDocId: doc.id });
    await driveSuccess(backend);
    const output = expectOk(await promise);

    expectReconstructs('48 kHz stereo, full resample round trip', output, doc.channels);
  });
});

// ---------------------------------------------------------------------------
// 3. Mono
// ---------------------------------------------------------------------------

describe('mono documents', () => {
  it('folds the model two-channel estimates back to one channel and still sums exactly', async () => {
    const backend = installStemApi();
    const doc = seedDoc({ channelCount: 1, sampleRate: 48000 });

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    expect(backend.lastRequest!.channels).toHaveLength(1);
    await driveSuccess(backend);
    const output = expectOk(await promise);

    expect(output.channelCount).toBe(1);
    for (const stem of output.stems) expect(stem.channels).toHaveLength(1);
    expect(output.residual).toHaveLength(1);
    expectReconstructs('mono 48 kHz, two-channel estimates folded', output, doc.channels);
  });
});

// ---------------------------------------------------------------------------
// 4. Non-finite estimates — the sanitise policy
// ---------------------------------------------------------------------------

describe('non-finite model output', () => {
  it('sanitises NaN/Infinity estimates, reports the count, and still settles ok with finite audio', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    const promise = separateStems({ sourceDocId: doc.id });
    await driveSuccess(backend, {
      corrupt: (data) => {
        data[100] = NaN;
        data[101] = Infinity;
        data[data.length - 1] = -Infinity;
      },
    });
    const output = expectOk(await promise);

    expect(output.sanitisedEstimateSamples).toBe(3);
    for (const stem of output.stems) {
      for (const ch of stem.channels) {
        for (let n = 0; n < ch.length; n++) expect(Number.isFinite(ch[n])).toBe(true);
      }
    }
    for (const ch of output.residual) {
      for (let n = 0; n < ch.length; n++) expect(Number.isFinite(ch[n])).toBe(true);
    }
    // The hard guarantee survives sanitisation: the residual is still the
    // time-domain complement of the ORIGINAL mix.
    expectReconstructs('sanitised NaN/Inf estimates', output, doc.channels);
  });

  it('fails loudly (never silently) when the DOCUMENT itself carries a non-finite sample', async () => {
    const backend = installStemApi();
    const doc = seedDoc();
    doc.channels[0][7] = NaN;

    const promise = separateStems({ sourceDocId: doc.id });
    await driveSuccess(backend);
    const result = await promise;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/not finite/i);
    expect(backend.showMessageBox).toHaveBeenCalled();
    expect(backend.liveListeners).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Cancel
// ---------------------------------------------------------------------------

describe('cancel', () => {
  it('kills the utility process mid-segment and settles with status cancelled', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    backend.emitProgress({ segment: 1, totalSegments: 6 });
    expect(isStemSeparationRunning()).toBe(true);

    const cancelled = await cancelStemSeparation();
    const result = await promise;

    expect(cancelled).toBe(true);
    expect(backend.cancelCalls).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('cancelled');
    expect(backend.showMessageBox).not.toHaveBeenCalled();
    expect(backend.liveListeners).toBe(0);
    expect(isStemSeparationRunning()).toBe(false);
  });

  it('is a no-op resolving false when nothing is running', async () => {
    installStemApi();
    await expect(cancelStemSeparation()).resolves.toBe(false);
  });

  it('drops chunk and progress events that arrive after the run settled', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    const modelChannels = requestChannels(backend);
    await cancelStemSeparation();
    await promise;

    // The manager should never do this, but a late event must not throw or
    // resurrect state.
    expect(() => {
      backend.emitProgress({ segment: 9, totalSegments: 9 });
      backend.emitChunk(buildChunk(modelChannels));
    }).not.toThrow();
    expect(getStemProgress()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Failure paths — every one settles
// ---------------------------------------------------------------------------

describe('failure paths', () => {
  it('surfaces a host error and settles with status failed', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    backend.settle({ ok: false, error: 'onnxruntime session failed' });
    const result = await promise;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/onnxruntime session failed/);
    expect(backend.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Stem separation failed' })
    );
    expect(backend.liveListeners).toBe(0);
  });

  it('settles when the utility process fails to LOAD (spawn failure)', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    backend.settle({ ok: false, error: 'failed to spawn stem host: ENOENT' });
    const result = await promise;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/spawn stem host/);
    expect(backend.liveListeners).toBe(0);
  });

  it('settles when the utility process is KILLED mid-flight (unexpected exit)', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    backend.emitProgress({ segment: 2, totalSegments: 8 });
    backend.settle({ ok: false, error: 'stem host exited unexpectedly (code 3)' });
    const result = await promise;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/exited unexpectedly/);
    expect(isStemSeparationRunning()).toBe(false);
    expect(backend.liveListeners).toBe(0);
  });

  it('settles when the IPC invoke itself rejects (dead channel)', async () => {
    const backend = installStemApi();
    backend.invokeThrows = 'IPC channel closed';
    const doc = seedDoc();

    const result = await separateStems({ sourceDocId: doc.id });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/IPC channel closed/);
    expect(backend.liveListeners).toBe(0);
    expect(isStemSeparationRunning()).toBe(false);
  });

  it('settles when the host reported done but delivered incomplete audio', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    const modelChannels = requestChannels(backend);
    // Half the track only — the manager's contract is a complete tiling.
    const half = modelChannels.map((ch) => ch.subarray(0, Math.floor(ch.length / 2)));
    backend.emitChunk(buildChunk(half as Float32Array[]));
    backend.settle({ ok: true, totalSegments: 2 });
    const result = await promise;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/incomplete/i);
  });

  it('refuses with no-document / empty-document / busy without ever hanging', async () => {
    const backend = installStemApi();

    const missing = await separateStems({ sourceDocId: 'doc-nope' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe('no-document');

    const empty = createDocument({ name: 'Empty', sampleRate: 48000, channels: [new Float32Array(0)] });
    useAppStore.getState().addDocument(empty);
    const emptyResult = await separateStems({ sourceDocId: empty.id });
    expect(emptyResult.ok).toBe(false);
    if (!emptyResult.ok) expect(emptyResult.status).toBe('empty-document');

    const doc = seedDoc();
    const first = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    const second = await separateStems({ sourceDocId: doc.id });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.status).toBe('busy');
    expect(backend.separateCalls).toBe(1);

    await driveSuccess(backend);
    expect((await first).ok).toBe(true);
  });

  it('refuses with model-missing when the model has not been downloaded', async () => {
    const backend = installStemApi();
    backend.modelState = { downloaded: false, bytes: null, expectedBytes: 165612636 };
    const doc = seedDoc();

    const result = await separateStems({ sourceDocId: doc.id });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('model-missing');
    expect(backend.separateCalls).toBe(0);
    expect(isStemSeparationRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Staleness (T13 pattern) — never deliver stems for audio that changed
// ---------------------------------------------------------------------------

describe('staleness', () => {
  it('aborts and settles stale when the source is EDITED mid-flight', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    backend.emitProgress({ segment: 1, totalSegments: 6 });

    // A mutator always allocates fresh channel arrays (peaksCache.ts's
    // identity convention) — that is exactly what the snapshot detects.
    useAppStore.getState().updateDocument({
      ...doc,
      channels: [makeSignal(HALF_SECOND_48K, 99), makeSignal(HALF_SECOND_48K, 98)],
    });

    const result = await promise;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('stale');
    // Lifetime: the edit killed the utility process rather than letting it
    // burn minutes on audio that no longer exists.
    expect(backend.cancelCalls).toBe(1);
    expect(backend.liveListeners).toBe(0);
  });

  it('aborts and settles source-closed when the source is CLOSED mid-flight', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    await closeDocumentFlow(doc.id);
    const result = await promise;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('source-closed');
    expect(backend.cancelCalls).toBe(1);
    expect(backend.liveListeners).toBe(0);
    expect(isStemSeparationRunning()).toBe(false);
  });

  it('discards a COMPLETED run whose source changed before delivery (delivery-time re-check)', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    backend.emitChunk(buildChunk(requestChannels(backend)));
    // Settle FIRST, then edit — the run is already complete main-side, so only
    // the delivery-time identity re-check can catch this.
    backend.settle({ ok: true, totalSegments: 3 });
    useAppStore.getState().updateDocument({
      ...doc,
      channels: [makeSignal(HALF_SECOND_48K, 55), makeSignal(HALF_SECOND_48K, 56)],
    });

    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('stale');
  });

  it('invalidateStemRun kills an in-flight run for the named document only', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);

    invalidateStemRun('doc-unrelated');
    expect(backend.cancelCalls).toBe(0);

    invalidateStemRun(doc.id);
    const result = await promise;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('source-closed');
    expect(backend.cancelCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8. Progress + reactivity + busy integration
// ---------------------------------------------------------------------------

describe('progress and busy state', () => {
  it('streams per-segment progress with the time estimate its law produces', async () => {
    const backend = installStemApi();
    const doc = seedDoc();
    const seen: StemSeparationProgress[] = [];
    // A clock the TEST drives. Real elapsed time here is 0-2 ms, so "at least
    // zero" and "did not grow" hold for any formula — including a hardcoded 0,
    // and including one that charges for the segments already delivered. The
    // published number is arithmetic, so it is asserted as arithmetic.
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    const promise = separateStems({ sourceDocId: doc.id, onProgress: (p) => seen.push({ ...p }) });
    await waitForRequest(backend);

    expect(seen.some((p) => p.phase === 'resampling')).toBe(true);

    now += 4000; // 4 s spent on the first two of four segments
    backend.emitProgress({ segment: 1, totalSegments: 4 });
    backend.emitProgress({ segment: 2, totalSegments: 4 });
    const afterTwo = getStemProgress();
    expect(afterTwo).not.toBeNull();
    expect(afterTwo!.segment).toBe(2);
    expect(afterTwo!.totalSegments).toBe(4);
    expect(afterTwo!.fraction).toBeCloseTo(0.5, 6);
    // (4000 ms / 2 done) x 2 STILL TO COME. Charging for all four gives 8000.
    expect(afterTwo!.estimatedRemainingMs).toBe(4000);

    now += 4000;
    backend.emitProgress({ segment: 4, totalSegments: 4 });
    // Nothing is still to come, so nothing is left to wait for: 2000 x 0.
    expect(getStemProgress()!.estimatedRemainingMs).toBe(0);

    backend.emitChunk(buildChunk(requestChannels(backend)));
    backend.settle({ ok: true, totalSegments: 4 });
    await promise;

    expect(seen.some((p) => p.phase === 'partitioning')).toBe(true);
    expect(getStemProgress()).toBeNull();
  });

  it('carries an estimate BEFORE the first segment, derived from the measured realtime factor', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);

    const initial = getStemProgress();
    expect(initial).not.toBeNull();
    expect(initial!.segment).toBe(0);
    expect(initial!.estimatedRemainingMs).not.toBeNull();
    // 0.5 s of audio at ~1.52x realtime is ~330 ms — the estimate must be in
    // the right ballpark, not a placeholder.
    expect(initial!.estimatedRemainingMs!).toBeGreaterThan(100);
    expect(initial!.estimatedRemainingMs!).toBeLessThan(2000);

    await cancelStemSeparation();
    await promise;
  });

  it('counts as busy work for the close guard while in flight', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    expect(getStemBusyCount()).toBe(0);
    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    expect(getStemBusyCount()).toBe(1);
    expect(isStemSeparationRunning()).toBe(true);

    await driveSuccess(backend);
    await promise;
    expect(getStemBusyCount()).toBe(0);
  });

  it('bumps the version counter on start, progress and completion', async () => {
    const backend = installStemApi();
    const doc = seedDoc();
    const { result } = renderHook(() => useStemVersion());
    const start = result.current;
    expect(start).toBe(getStemVersion());

    let promise!: Promise<StemSeparationResult>;
    await act(async () => {
      promise = separateStems({ sourceDocId: doc.id });
      await waitForRequest(backend);
    });
    const afterStart = result.current;
    expect(afterStart).toBeGreaterThan(start);

    await act(async () => {
      backend.emitProgress({ segment: 1, totalSegments: 2 });
    });
    expect(result.current).toBeGreaterThan(afterStart);

    await act(async () => {
      await driveSuccess(backend, { segments: 2 });
      await promise;
    });
    expect(result.current).toBeGreaterThan(afterStart);
  });
});

// ---------------------------------------------------------------------------
// 9. Model-state passthrough (S6 talks to this service, never to IPC directly)
// ---------------------------------------------------------------------------

describe('model state', () => {
  it('passes the model state through and reports a download failure without throwing', async () => {
    const backend = installStemApi();
    await expect(getStemModelState()).resolves.toEqual(backend.modelState);

    backend.modelState = { downloaded: false, bytes: null, expectedBytes: 165612636 };
    const failed = await ensureStemModel();
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error('unreachable');
    expect(failed.error).toBe('offline');
    expect(backend.ensureCalls).toBe(1);
  });

  it('reports an unavailable preload rather than throwing', async () => {
    delete (window as { electronAPI?: unknown }).electronAPI;
    const state = await getStemModelState();
    expect(state.downloaded).toBe(false);
    const result = await separateStems({ sourceDocId: 'doc-1' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// 10. Fix round 1 — the invariants the review proved were unpinned
// ---------------------------------------------------------------------------

describe('the DELIVERY-TIME staleness gate, on its own (review MED-1)', () => {
  // The early-abort store subscription normally fires first, so a plain edit
  // never reaches the delivery-time check. With the watch off, the delivery
  // gate is the ONLY thing standing between a changed document and stems
  // computed from audio that no longer exists (ruling 7).

  it('discards the result when the source was edited and nothing aborted the run', async () => {
    const backend = installStemApi();
    const doc = seedDoc();
    _setStaleWatchForTest(false);

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    useAppStore.getState().updateDocument({
      ...doc,
      channels: [makeSignal(HALF_SECOND_48K, 31), makeSignal(HALF_SECOND_48K, 32)],
    });
    // The run was never aborted: the host finishes normally and reports ok.
    backend.emitChunk(buildChunk(requestChannels(backend)));
    backend.settle({ ok: true, totalSegments: 3 });

    const result = await promise;
    expect(backend.cancelCalls).toBe(0); // proof the early path never ran
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('stale');
  });

  it('discards the result when the source was closed and nothing aborted the run', async () => {
    const backend = installStemApi();
    const doc = seedDoc();
    _setStaleWatchForTest(false);

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    const modelChannels = requestChannels(backend);
    useAppStore.getState().closeDocument(doc.id);
    backend.emitChunk(buildChunk(modelChannels));
    backend.settle({ ok: true, totalSegments: 3 });

    const result = await promise;
    expect(backend.cancelCalls).toBe(0);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('source-closed');
  });
});

describe('ruling 4 leg 2 — the RETURN resample, pinned bit-exactly (review MED-2)', () => {
  // The reconstruction metric can NEVER pin this leg: a linear resampler
  // leaves above-Nyquist content in the estimates, whose masks then route it
  // into the Residual, which makes the exact-sum numbers look BETTER. So the
  // leg is pinned against `resampleChannel`'s own output instead: the whole
  // partition is recomputed here from the chunk the backend sent, and every
  // stem sample must match bit for bit.

  it('produces exactly the partition of resampleChannel-carried estimates (48 kHz)', async () => {
    const backend = installStemApi();
    const doc = seedDoc({ sampleRate: 48000 });

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    const modelChannels = requestChannels(backend);
    backend.emitChunk(buildChunk(modelChannels));
    backend.settle({ ok: true, totalSegments: 3 });
    const output = expectOk(await promise);

    const expected = expectedPartition(modelEstimatesFrom(modelChannels, 2, (st) => HOST_GAINS[st]), doc);
    for (let i = 0; i < STEM_LABELS.length; i++) {
      for (let c = 0; c < 2; c++) {
        expectBitExact(output.stems[i].channels[c], expected.stems[i][c], `${STEM_LABELS[i]} ch${c}`);
      }
    }
    for (let c = 0; c < 2; c++) {
      expectBitExact(output.residual[c], expected.residual[c], `residual ch${c}`);
    }
  });

  it('fits an estimate whose resample round trip drifts by a sample (review LOW-8)', async () => {
    const backend = installStemApi();
    // 24006 @ 48 kHz -> 22056 @ 44.1 kHz -> 24007 back: one sample of drift,
    // which without the tail fit would be a partitionStems shape error.
    const doc = seedDoc({ sampleRate: 48000, length: 24006 });

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    const modelChannels = requestChannels(backend);
    expect(modelChannels[0].length).toBe(22056);
    expect(resampleChannel(modelChannels[0], MODEL_SAMPLE_RATE, 48000).length).toBe(24007);

    backend.emitChunk(buildChunk(modelChannels));
    backend.settle({ ok: true, totalSegments: 3 });
    const output = expectOk(await promise);

    expect(output.lengthSamples).toBe(24006);
    for (const stem of output.stems) for (const ch of stem.channels) expect(ch.length).toBe(24006);
    expectReconstructs('48 kHz stereo, drifting round-trip length', output, doc.channels);
  });

  it('averages the model two channels on the mono fold (review LOW-9)', async () => {
    const backend = installStemApi();
    const doc = seedDoc({ channelCount: 1, sampleRate: 48000 });
    // Per-stem ASYMMETRY: taking the left channel only would change the
    // relative stem energies, and therefore the masks, and therefore the
    // stems. A symmetric fixture cannot tell the two apart (the ratio mask is
    // scale-invariant).
    const gainFor = (st: number, c: number) => HOST_GAINS[st] * (c === 1 ? st + 1 : 1);

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    const modelChannels = requestChannels(backend);
    backend.emitChunk(buildChunk(modelChannels, { gainFor }));
    backend.settle({ ok: true, totalSegments: 3 });
    const output = expectOk(await promise);

    const expected = expectedPartition(modelEstimatesFrom(modelChannels, 1, gainFor), doc);
    for (let i = 0; i < STEM_LABELS.length; i++) {
      expectBitExact(output.stems[i].channels[0], expected.stems[i][0], `${STEM_LABELS[i]} mono`);
    }
    expectBitExact(output.residual[0], expected.residual[0], 'residual mono');
  });
});

describe('the always-resolves contract under allocation failure (review MED-3)', () => {
  it('settles failed when the RETURN-leg resample throws', async () => {
    const backend = installStemApi();
    const doc = seedDoc();
    const realResample = resampleModule.resampleChannel;
    jest
      .spyOn(resampleModule, 'resampleChannel')
      .mockImplementation((input: Float32Array, from: number, to: number) => {
        if (from === MODEL_SAMPLE_RATE) throw new RangeError('Array buffer allocation failed');
        return realResample(input, from, to);
      });

    const promise = separateStems({ sourceDocId: doc.id });
    await driveSuccess(backend);

    // The headline contract: RESOLVES, never rejects.
    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/allocation failed/);
    expect(backend.showMessageBox).toHaveBeenCalled();
    expect(backend.liveListeners).toBe(0);
    expect(isStemSeparationRunning()).toBe(false);
  });

  it('settles failed when the OUTGOING-leg resample throws', async () => {
    const backend = installStemApi();
    const doc = seedDoc();
    jest.spyOn(resampleModule, 'resampleChannel').mockImplementation(() => {
      throw new RangeError('Array buffer allocation failed');
    });

    const result = await separateStems({ sourceDocId: doc.id });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('failed');
    expect(backend.separateCalls).toBe(0);
    expect(isStemSeparationRunning()).toBe(false);
  });
});

describe('a model that contributed nothing must FAIL, not report success (review MED-5)', () => {
  it('refuses an all-NaN model output instead of returning silent stems', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    const promise = separateStems({ sourceDocId: doc.id });
    await driveSuccess(backend, {
      corrupt: (data) => data.fill(NaN),
    });
    const result = await promise;

    // Sanitisation alone would have produced 4 silent stems, residual === mix,
    // and a cheerful `ok` -- a copy with extra steps presented as a separation.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/no usable output/i);
    // The cause is surfaced, not just the symptom.
    expect(result.message).toMatch(/non-finite/i);
    expect(backend.showMessageBox).toHaveBeenCalled();
  });

  it('still succeeds for a genuinely SILENT document (all-zero masks are correct there)', async () => {
    const backend = installStemApi();
    const silent = createDocument({
      name: 'Silence.wav',
      sampleRate: 48000,
      channels: [new Float32Array(HALF_SECOND_48K), new Float32Array(HALF_SECOND_48K)],
      filePath: 'D:\\Silence.wav',
    });
    useAppStore.getState().addDocument(silent);

    const promise = separateStems({ sourceDocId: silent.id });
    await driveSuccess(backend);
    const output = expectOk(await promise);

    expect(output.stats!.maxMaskSum).toBe(0);
    for (const ch of output.residual) for (let n = 0; n < ch.length; n++) expect(ch[n]).toBe(0);
  });
});

describe('chunk-boundary discipline (review LOW-10, LOW-11)', () => {
  it('does not let a DUPLICATED region stand in for an undelivered one', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    const modelChannels = requestChannels(backend);
    const half = Math.floor(modelChannels[0].length / 2);
    const firstHalf = modelChannels.map((ch) => ch.subarray(0, half)) as Float32Array[];
    // Same region twice: a naive delivered-sample COUNT would read as complete.
    backend.emitChunk(buildChunk(firstHalf));
    backend.emitChunk(buildChunk(firstHalf));
    backend.settle({ ok: true, totalSegments: 2 });

    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/incomplete/i);
  });

  it('accepts overlapping chunks that genuinely tile the track', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    const modelChannels = requestChannels(backend);
    const total = modelChannels[0].length;
    const cut = Math.floor(total * 0.6);
    backend.emitChunk(buildChunk(modelChannels.map((ch) => ch.subarray(0, cut)) as Float32Array[]));
    backend.emitChunk({
      ...buildChunk(modelChannels.map((ch) => ch.subarray(cut - 100, total)) as Float32Array[]),
      offset: cut - 100,
    });
    backend.settle({ ok: true, totalSegments: 2 });

    expectOk(await promise);
  });

  it('drops a chunk that runs past the end of the track', async () => {
    const backend = installStemApi();
    const doc = seedDoc();

    const promise = separateStems({ sourceDocId: doc.id });
    await waitForRequest(backend);
    const modelChannels = requestChannels(backend);
    // offset 1 with a full-length payload ends one sample past modelLength.
    backend.emitChunk({ ...buildChunk(modelChannels), offset: 1 });
    backend.settle({ ok: true, totalSegments: 2 });

    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/incomplete/i);
  });
});

describe('the renderer length cap (review MED-4)', () => {
  it('refuses a job whose model-rate length exceeds the measured renderer budget', async () => {
    const backend = installStemApi();
    // A low-rate document reaches the cap with a small fixture: 4 M samples at
    // 4 kHz resample UP to 44.1 M at the model rate, past the 39 690 000
    // (15 min) cap, without allocating a 15-minute buffer in the test.
    const long = createDocument({
      name: 'Long.wav',
      sampleRate: 4000,
      channels: [new Float32Array(4_000_000)],
      filePath: 'D:\\Long.wav',
    });
    useAppStore.getState().addDocument(long);

    const result = await separateStems({ sourceDocId: long.id });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe('too-long');
    expect(result.message).toMatch(/15 minutes/);
    expect(backend.separateCalls).toBe(0);
    expect(isStemSeparationRunning()).toBe(false);
  });
});

describe('utility-process lifetime on a dead IPC channel (review LOW-12)', () => {
  it('kills the utility process when the separate invoke rejects', async () => {
    const backend = installStemApi();
    backend.invokeThrows = 'IPC channel closed';
    const doc = seedDoc();

    const result = await separateStems({ sourceDocId: doc.id });

    expect(result.ok).toBe(false);
    // A rejected invoke says nothing about the CHILD: without an explicit
    // cancel the manager's utility process outlives the run it belonged to.
    expect(backend.cancelCalls).toBe(1);
    expect(isStemSeparationRunning()).toBe(false);
  });
});
