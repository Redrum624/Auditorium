import {
  diarizeChannels,
  cancelDiarization,
  isDiarizing,
  getDiarizeBusyCount,
  getDiarizeModelState,
  ensureDiarizeModels,
  stageWeights,
  limitsSentence,
  modelLength16k,
  DIARIZE_SAMPLE_RATE,
  MAX_DIARIZE_SAMPLES,
  DIARIZE_MODEL_BYTES,
  MEASURED_SEGMENT_MS_PER_S,
  MEASURED_EMBED_MS_PER_S,
  SPEAKER_SEPARATION_LIMITS,
  type DiarizeProgress,
  type DiarizeRunPhase,
} from './diarizeService';
import {
  installDiarizeBackend,
  uninstallDiarizeBackend,
  classWindow,
  speakerVector,
  WIRE_WINDOW_FRAMES,
  WIRE_CLASS_COUNT,
  WIRE_EMBED_DIMS,
  type DiarizeBackend,
} from '../__mocks__/diarizeBackend';
import { monoMix } from './transcribeService';
import { resampleChannel } from '../dsp/resample';
import { MEASURED_REALTIME_FACTOR } from './stemService';
import { assembleDiarization, expectedWindowCount, frameToSample16k } from '../dsp/diarization';

// ---------------------------------------------------------------------------
// The fixture — a 12 s stereo 44.1 kHz "Vocals stem" that resamples to exactly
// three segmentation windows.
//
// 12 s x 44100 = 529,200 samples, and 529200 x 16000 / 44100 = 192,000 EXACTLY
// (44100 / 16000 = 2.75625 divides it), so the resampled length needs no
// rounding argument: 192000 = SEG_WINDOW + 2 x SEG_SHIFT, an exact fit with no
// zero-padded tail window. Three windows is the smallest fixture in which a
// window sits between two others, which is where the assembly's per-frame vote
// actually has something to decide.
// ---------------------------------------------------------------------------

const SOURCE_RATE = 44100;
const SOURCE_LENGTH = 529200;
const RESAMPLED_LENGTH = 192000;

function makeLcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
}

/** Noise plus a tone — a signal whose channels differ, so a mono mix that
 * dropped a channel or resampled the wrong one shows up in the comparison. */
function makeSignal(length: number, seed: number): Float32Array {
  const rand = makeLcg(seed);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = 0.3 * rand() + 0.35 * Math.sin((2 * Math.PI * (180 + seed % 40) * i) / SOURCE_RATE);
  }
  return out;
}

function makeChannels(): Float32Array[] {
  return [makeSignal(SOURCE_LENGTH, 8123), makeSignal(SOURCE_LENGTH, 991)];
}

/**
 * Every window carries the same three local speakers in the same three frame
 * ranges: local 0 on frames [0, 200), local 1 on [200, 400), local 2 on
 * [400, 589). Classes 1/2/3 are the powerset singletons, so exactly one local
 * speaker is active per frame and the assembly's `speakerCountPerFrame` is 1
 * wherever a window covers — the fixture is deliberately overlap-free so the
 * expected segments below can be derived by hand.
 */
function fixtureWindow(): Uint8Array {
  return classWindow([
    { from: 0, to: 200, class: 1 },
    { from: 200, to: 400, class: 2 },
    { from: 400, to: WIRE_WINDOW_FRAMES, class: 3 },
  ]);
}

/**
 * The nine fragments, in the order the host emits them (window, then local
 * slot). Voice A holds slot 0 in every window PLUS slot 2 of window 0 — four
 * fragments; voice B holds slot 1 everywhere plus slot 2 of windows 1 and 2 —
 * five. Both are at or above MIN_CLUSTER_SIZE = 4, which is what keeps the
 * auto fold from collapsing them: a 3-and-3 split would fold whole into the
 * larger cluster and the fixture would silently be testing one speaker.
 */
const FIXTURE_AXES: { windowIndex: number; localSpeaker: number; axis: number }[] = [
  { windowIndex: 0, localSpeaker: 0, axis: 0 },
  { windowIndex: 0, localSpeaker: 1, axis: 1 },
  { windowIndex: 0, localSpeaker: 2, axis: 0 },
  { windowIndex: 1, localSpeaker: 0, axis: 0 },
  { windowIndex: 1, localSpeaker: 1, axis: 1 },
  { windowIndex: 1, localSpeaker: 2, axis: 1 },
  { windowIndex: 2, localSpeaker: 0, axis: 0 },
  { windowIndex: 2, localSpeaker: 1, axis: 1 },
  { windowIndex: 2, localSpeaker: 2, axis: 1 },
];

const ACTIVE_FRAMES = [200, 200, WIRE_WINDOW_FRAMES - 400];

let backend: DiarizeBackend;

beforeEach(() => {
  backend = installDiarizeBackend();
});

afterEach(async () => {
  // Never leave a run reserved for the next test.
  await cancelDiarization();
  uninstallDiarizeBackend();
});

/** Spins the microtask queue until `pred` holds (or the budget runs out), so a
 * test can wait for the invoke without guessing a tick count. */
async function flushUntil(pred: () => boolean, ticks = 80): Promise<void> {
  for (let i = 0; i < ticks && !pred(); i++) await Promise.resolve();
}

/** Streams the whole fixture: 3 windows, host progress for both stages, the
 * nine embeddings, then a successful settlement. */
function streamFixture(windowCount = 3): void {
  for (let i = 0; i < windowCount; i++) {
    backend.emit.progress({ stage: 'segment', done: i + 1, total: windowCount });
    backend.emit.window({ index: i, labels: fixtureWindow() });
  }
  FIXTURE_AXES.forEach((f, k) => {
    backend.emit.progress({ stage: 'embed', done: k + 1, total: FIXTURE_AXES.length });
    backend.emit.embedding({
      windowIndex: f.windowIndex,
      localSpeaker: f.localSpeaker,
      activeFrames: ACTIVE_FRAMES[f.localSpeaker],
      vector: speakerVector(f.axis, 4000 + k * 37),
    });
  });
  backend.settle({ ok: true, windowCount });
}

async function runFixture(
  options: { onProgress?: (p: DiarizeProgress) => void; shouldCancel?: () => boolean } = {}
): ReturnType<typeof diarizeChannels> {
  const promise = diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE, ...options });
  await flushUntil(() => backend.isPending());
  streamFixture();
  return promise;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('mirrors the host rate and the 2-hour job cap the manager validates against', () => {
    // diarizeHost.cjs: SAMPLE_RATE 16000, MAX_TOTAL_SAMPLES = SAMPLE_RATE * 7200.
    expect(DIARIZE_SAMPLE_RATE).toBe(16000);
    expect(MAX_DIARIZE_SAMPLES).toBe(16000 * 7200);
  });

  it('mirrors the pinned two-file total (5,992,913 + 26,530,550)', () => {
    expect(DIARIZE_MODEL_BYTES).toBe(32523463);
  });

  it('carries the measured stage seeds by value', () => {
    // D5: segmentation 8 ms per audio second (spike 5.5-8.6), embedding 55
    // (spike 29-73). Re-tuning either is a new bench run, not an edit.
    expect(MEASURED_SEGMENT_MS_PER_S).toBe(8);
    expect(MEASURED_EMBED_MS_PER_S).toBe(55);
  });
});

describe('the fixture is the three-window case it claims to be', () => {
  it('resamples to exactly three windows', () => {
    expect(modelLength16k(SOURCE_LENGTH, SOURCE_RATE)).toBe(RESAMPLED_LENGTH);
    expect(expectedWindowCount(RESAMPLED_LENGTH)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

describe('diarizeChannels', () => {
  it('assembles the evidence the host streamed into the diarization Task 1 predicts', async () => {
    const result = await runFixture();
    if (!result.ok) throw new Error(`expected ok, got ${result.status}: ${result.message}`);

    expect(result.evidence.totalSamples16k).toBe(RESAMPLED_LENGTH);
    expect(result.evidence.windows).toHaveLength(3);
    for (const w of result.evidence.windows) expect(w).toHaveLength(WIRE_WINDOW_FRAMES);
    expect(result.evidence.embeddings).toHaveLength(FIXTURE_AXES.length);
    expect(result.evidence.embeddings.map((e) => [e.windowIndex, e.localSpeaker])).toEqual(
      FIXTURE_AXES.map((f) => [f.windowIndex, f.localSpeaker])
    );
    for (const e of result.evidence.embeddings) expect(e.vector).toHaveLength(WIRE_EMBED_DIMS);

    // Hand-derived from the fixture, not read back from the subject. Window i
    // starts at global frame trunc(i*16000/270 + 0.5) = 0 / 59 / 119, and each
    // frame's winner is the cluster with the most votes (ties to the lower id,
    // and voice A is id 0 because its fragment arrives first):
    //   frames   0..258 -> A (w0 slot 0, then w0 slot 0 + w1 slot 0; at
    //                      200..258 A and B tie 1-1 and A takes it)
    //   frames 259..707 -> B (two or three B slots against at most one A)
    // A run closes at the frame where it stops, so the segments are
    // [frame 0, frame 259) and [frame 259, frame 708) in frame-centre samples.
    expect(result.diarization.speakerCount).toBe(2);
    expect(result.diarization.preFoldClusterCount).toBe(2);
    expect(result.diarization.rawClusterCount).toBe(2);
    expect(result.diarization.segments).toEqual([
      { startSample16k: frameToSample16k(0), endSample16k: frameToSample16k(259), speaker: 0 },
      { startSample16k: frameToSample16k(259), endSample16k: frameToSample16k(708), speaker: 1 },
    ]);
    expect(result.diarization.overlapSegments).toEqual([]);
    expect(result.diarization.speechSeconds).toEqual([(259 * 270) / 16000, (449 * 270) / 16000]);

    // ...and the returned evidence is exactly what produced it, so the review
    // select can re-cluster without a model run.
    expect(assembleDiarization(result.evidence)).toEqual(result.diarization);
  });

  it('resamples ONE fresh mono mix and leaves the source channels untouched', async () => {
    const channels = makeChannels();
    const before = channels.map((c) => c.slice());
    const promise = diarizeChannels({ channels, sampleRate: SOURCE_RATE });
    await flushUntil(() => backend.isPending());
    streamFixture();
    await promise;

    for (let c = 0; c < channels.length; c++) expect(channels[c]).toEqual(before[c]);

    const expected = resampleChannel(monoMix(channels, SOURCE_LENGTH), SOURCE_RATE, 16000);
    const sent = backend.lastRequest;
    expect(sent).not.toBeNull();
    expect(sent?.sampleRate).toBe(16000);
    // The buffer handed to IPC is the mono buffer's own, exactly sized — not a
    // view onto something larger (the manager copies whatever it is given).
    expect(sent?.samples.byteLength).toBe(RESAMPLED_LENGTH * 4);
    expect(new Float32Array(sent?.samples as ArrayBuffer)).toEqual(expected);
    // ...and it is the MIX, not one channel resampled: the two fixture
    // channels carry different noise, so resampling either alone lands
    // somewhere else entirely.
    expect(new Float32Array(sent?.samples as ArrayBuffer)).not.toEqual(
      resampleChannel(channels[0], SOURCE_RATE, 16000)
    );
  });

  it('reports the busy count and the busy flag for the length of the run', async () => {
    expect(isDiarizing()).toBe(false);
    expect(getDiarizeBusyCount()).toBe(0);
    const promise = diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    await flushUntil(() => backend.isPending());
    expect(isDiarizing()).toBe(true);
    expect(getDiarizeBusyCount()).toBe(1);
    streamFixture();
    await promise;
    expect(isDiarizing()).toBe(false);
    expect(getDiarizeBusyCount()).toBe(0);
  });

  it('refuses a second concurrent run with busy, without invoking the host', async () => {
    const first = diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    await flushUntil(() => backend.isPending());
    const second = await diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    expect(second).toEqual({ ok: false, status: 'busy', message: expect.any(String) });
    expect(backend.runCalls).toBe(1);
    streamFixture();
    await first;
    // ...and the gate reopens once the first run settles.
    const third = await runFixture();
    expect(third.ok).toBe(true);
  });

  it('refuses with model-missing before any invoke', async () => {
    backend.modelState = { downloaded: false, bytes: null, expectedBytes: DIARIZE_MODEL_BYTES };
    const result = await diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('model-missing');
    expect(result.message).toContain('32.5 MB');
    expect(backend.runCalls).toBe(0);
    expect(getDiarizeBusyCount()).toBe(0);
  });

  it('refuses with unavailable when the preload bridge is absent', async () => {
    uninstallDiarizeBackend();
    const result = await diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('unavailable');
    expect(getDiarizeBusyCount()).toBe(0);
  });

  it('refuses audio past the 2-hour cap before allocating or invoking', async () => {
    // 7,200,001 samples at 1 kHz is 115,200,016 at 16 kHz: one source sample
    // past the cap, and 28.8 MB rather than the 460 MB a literal 2-hour
    // 16 kHz fixture would cost.
    const long = [new Float32Array(7200001)];
    expect(modelLength16k(long[0].length, 1000)).toBeGreaterThan(MAX_DIARIZE_SAMPLES);
    const result = await diarizeChannels({ channels: long, sampleRate: 1000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('too-long');
    expect(backend.runCalls).toBe(0);
  });

  it('accepts exactly the cap and refuses one 16 kHz sample past it', () => {
    // The boundary itself, pinned on the predicate the run uses, so the cap can
    // be exercised at the constant without allocating 460 MB.
    expect(modelLength16k(7200000, 1000)).toBe(MAX_DIARIZE_SAMPLES);
    expect(modelLength16k(7200001, 1000)).toBe(MAX_DIARIZE_SAMPLES + 16);
  });

  it('refuses empty audio without invoking', async () => {
    const result = await diarizeChannels({ channels: [new Float32Array(0)], sampleRate: SOURCE_RATE });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('failed');
    expect(backend.runCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('cancellation', () => {
  it('cancels an in-flight run once and settles it as cancelled', async () => {
    const promise = diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    await flushUntil(() => backend.isPending());
    expect(await cancelDiarization()).toBe(true);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('cancelled');
    expect(backend.cancelCalls).toBe(1);
    expect(backend.runCalls).toBe(1);
    expect(backend.isPending()).toBe(false);
    expect(getDiarizeBusyCount()).toBe(0);
    // A cancel is not a failure: no native error box.
    expect(backend.showMessageBox).not.toHaveBeenCalled();
  });

  it('returns false when nothing is running', async () => {
    expect(await cancelDiarization()).toBe(false);
    expect(backend.cancelCalls).toBe(0);
  });

  it('cancels once however many times it is called', async () => {
    const promise = diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    await flushUntil(() => backend.isPending());
    expect(await cancelDiarization()).toBe(true);
    await cancelDiarization();
    await promise;
    expect(backend.cancelCalls).toBe(1);
  });

  it('honours shouldCancel before the model probe, spawning nothing', async () => {
    const result = await diarizeChannels({
      channels: makeChannels(),
      sampleRate: SOURCE_RATE,
      shouldCancel: () => true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('cancelled');
    expect(backend.modelStateCalls).toBe(0);
    expect(backend.runCalls).toBe(0);
  });

  it('honours shouldCancel raised after the resample, with NO invoke', async () => {
    // False for the pre-probe check, true from the post-resample check on: the
    // dialog's Cancel between the stem stage and the diarize stage.
    let calls = 0;
    const result = await diarizeChannels({
      channels: makeChannels(),
      sampleRate: SOURCE_RATE,
      shouldCancel: () => calls++ > 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('cancelled');
    expect(backend.modelStateCalls).toBe(1);
    expect(backend.runCalls).toBe(0);
    expect(getDiarizeBusyCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Host failures
// ---------------------------------------------------------------------------

describe('host failures', () => {
  it('maps an error settlement to failed and raises one native box', async () => {
    const promise = diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    await flushUntil(() => backend.isPending());
    backend.settle({ ok: false, error: 'the segmentation model failed to load' });
    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('failed');
    expect(result.message).toBe('the segmentation model failed to load');
    expect(backend.showMessageBox).toHaveBeenCalledTimes(1);
    expect(getDiarizeBusyCount()).toBe(0);
  });

  it('maps a rejected invoke to failed and kills the child it can no longer see', async () => {
    backend.invokeThrows = 'IPC channel closed';
    const result = await diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('failed');
    expect(result.message).toBe('IPC channel closed');
    expect(backend.cancelCalls).toBe(1);
    expect(getDiarizeBusyCount()).toBe(0);
  });

  it('fails when the host delivers fewer windows than it counted', async () => {
    const promise = diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    await flushUntil(() => backend.isPending());
    backend.emit.window({ index: 0, labels: fixtureWindow() });
    backend.emit.window({ index: 1, labels: fixtureWindow() });
    backend.settle({ ok: true, windowCount: 3 });
    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('failed');
    expect(result.message).toContain('3');
    expect(result.message).toContain('2');
  });

  it('drops a malformed window rather than assembling from corrupt bytes', async () => {
    const promise = diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    await flushUntil(() => backend.isPending());
    // Window 0 carries class 6 — the LAST legal powerset class (the {1,2}
    // pair), which must be accepted.
    const legalPair = fixtureWindow();
    legalPair[5] = WIRE_CLASS_COUNT - 1;
    backend.emit.window({ index: 0, labels: legalPair });
    backend.emit.window({ index: 1, labels: fixtureWindow() });
    // ...and window 2 arrives twice broken before it arrives whole: one class
    // past the powerset, then a buffer one byte short. Either would make the
    // assembly throw, and neither may squat on index 2 and shut out the real
    // window behind it.
    const badClass = fixtureWindow();
    badClass[10] = WIRE_CLASS_COUNT;
    backend.emit.window({ index: 2, labels: badClass });
    backend.emit.window({ index: 2, labels: new Uint8Array(WIRE_WINDOW_FRAMES - 1) });
    backend.emit.window({ index: 2, labels: fixtureWindow() });
    FIXTURE_AXES.forEach((f, k) => {
      backend.emit.embedding({
        windowIndex: f.windowIndex,
        localSpeaker: f.localSpeaker,
        activeFrames: ACTIVE_FRAMES[f.localSpeaker],
        vector: speakerVector(f.axis, 4000 + k * 37),
      });
    });
    backend.settle({ ok: true, windowCount: 3 });
    const result = await promise;
    if (!result.ok) throw new Error(`expected ok, got ${result.status}: ${result.message}`);
    expect(result.evidence.windows).toHaveLength(3);
    expect(result.diarization.speakerCount).toBe(2);
  });

  it('drops an embedding carrying a non-finite component', async () => {
    const promise = diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    await flushUntil(() => backend.isPending());
    for (let i = 0; i < 3; i++) backend.emit.window({ index: i, labels: fixtureWindow() });
    FIXTURE_AXES.forEach((f, k) => {
      const vector = speakerVector(f.axis, 4000 + k * 37);
      // One poisoned vector: NaN propagates through every distance in the
      // clusterer, so the row is dropped whole.
      if (k === 5) vector[3] = Number.NaN;
      backend.emit.embedding({
        windowIndex: f.windowIndex,
        localSpeaker: f.localSpeaker,
        activeFrames: ACTIVE_FRAMES[f.localSpeaker],
        vector,
      });
    });
    backend.settle({ ok: true, windowCount: 3 });
    const result = await promise;
    if (!result.ok) throw new Error(`expected ok, got ${result.status}: ${result.message}`);
    expect(result.evidence.embeddings).toHaveLength(FIXTURE_AXES.length - 1);
  });

  it('drops an embedding pointing at a window that never arrived', async () => {
    const promise = diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    await flushUntil(() => backend.isPending());
    for (let i = 0; i < 3; i++) backend.emit.window({ index: i, labels: fixtureWindow() });
    FIXTURE_AXES.forEach((f, k) => {
      backend.emit.embedding({
        windowIndex: f.windowIndex,
        localSpeaker: f.localSpeaker,
        activeFrames: ACTIVE_FRAMES[f.localSpeaker],
        vector: speakerVector(f.axis, 4000 + k * 37),
      });
    });
    backend.emit.embedding({
      windowIndex: 7,
      localSpeaker: 0,
      activeFrames: 20,
      vector: speakerVector(2, 77),
    });
    backend.settle({ ok: true, windowCount: 3 });
    const result = await promise;
    if (!result.ok) throw new Error(`expected ok, got ${result.status}: ${result.message}`);
    expect(result.evidence.embeddings).toHaveLength(FIXTURE_AXES.length);
  });

  it('unsubscribes every listener on every settlement path', async () => {
    await runFixture();
    expect(backend.liveListeners).toBe(0);

    const cancelled = diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    await flushUntil(() => backend.isPending());
    expect(backend.liveListeners).toBeGreaterThan(0);
    await cancelDiarization();
    await cancelled;
    expect(backend.liveListeners).toBe(0);

    const failing = diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    await flushUntil(() => backend.isPending());
    backend.settle({ ok: false, error: 'host died' });
    await failing;
    expect(backend.liveListeners).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

describe('progress', () => {
  const PHASE_ORDER: DiarizeRunPhase[] = ['resampling', 'segmenting', 'embedding', 'clustering'];

  it('reports the four phases in order with a non-decreasing fraction', async () => {
    const seen: DiarizeProgress[] = [];
    const result = await runFixture({ onProgress: (p) => seen.push(p) });
    expect(result.ok).toBe(true);

    expect(seen[0].phase).toBe('resampling');
    expect(seen[seen.length - 1].phase).toBe('clustering');
    expect(new Set(seen.map((p) => p.phase))).toEqual(new Set(PHASE_ORDER));

    let phase = 0;
    let fraction = -1;
    for (const p of seen) {
      const index = PHASE_ORDER.indexOf(p.phase);
      expect(index).toBeGreaterThanOrEqual(phase);
      phase = index;
      expect(p.fraction).toBeGreaterThanOrEqual(fraction);
      fraction = p.fraction;
      expect(p.fraction).toBeLessThanOrEqual(1);
      expect(p.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(p.estimatedRemainingMs)).toBe(true);
    }
    expect(fraction).toBe(1);
  });

  it('splits the bar between the two stages by the measured seeds', async () => {
    const seen: DiarizeProgress[] = [];
    await runFixture({ onProgress: (p) => seen.push(p) });

    // The segmentation stage owns 8 / (8 + 55) of the diarization bar, so the
    // last segment event lands exactly there and the first embed event is
    // already past it.
    const segShare = MEASURED_SEGMENT_MS_PER_S / (MEASURED_SEGMENT_MS_PER_S + MEASURED_EMBED_MS_PER_S);
    const lastSegment = [...seen].reverse().find((p) => p.phase === 'segmenting');
    expect(lastSegment?.done).toBe(3);
    expect(lastSegment?.total).toBe(3);
    expect(lastSegment?.fraction).toBeCloseTo(segShare, 12);

    const firstEmbed = seen.find((p) => p.phase === 'embedding');
    expect(firstEmbed?.fraction).toBeCloseTo(segShare + (1 - segShare) / FIXTURE_AXES.length, 12);
    const lastEmbed = [...seen].reverse().find((p) => p.phase === 'embedding');
    expect(lastEmbed?.done).toBe(FIXTURE_AXES.length);
    expect(lastEmbed?.fraction).toBeCloseTo(1, 12);
  });

  it('seeds the estimate from the two measured stage rates before anything is measured', async () => {
    const seen: DiarizeProgress[] = [];
    await runFixture({ onProgress: (p) => seen.push(p) });
    // 12 s of audio x (8 + 55) ms per audio second.
    const audioSeconds = SOURCE_LENGTH / SOURCE_RATE;
    expect(audioSeconds).toBe(12);
    expect(seen[0].phase).toBe('resampling');
    expect(seen[0].estimatedRemainingMs).toBe(
      audioSeconds * (MEASURED_SEGMENT_MS_PER_S + MEASURED_EMBED_MS_PER_S)
    );
    expect(seen[seen.length - 1].estimatedRemainingMs).toBe(0);
  });

  it('never lets the fraction fall back when stage events arrive out of order', async () => {
    const seen: DiarizeProgress[] = [];
    const promise = diarizeChannels({
      channels: makeChannels(),
      sampleRate: SOURCE_RATE,
      onProgress: (p) => seen.push(p),
    });
    await flushUntil(() => backend.isPending());
    backend.emit.progress({ stage: 'segment', done: 3, total: 3 });
    backend.emit.progress({ stage: 'embed', done: 5, total: 9 });
    // A late straggler from the finished stage: honest per-phase counters, but
    // a bar that walked backwards would read as a failure.
    backend.emit.progress({ stage: 'segment', done: 1, total: 3 });
    const stragglers = seen.filter((p) => p.phase === 'segmenting');
    const last = stragglers[stragglers.length - 1];
    expect(last.done).toBe(1);
    expect(last.fraction).toBe(seen[seen.length - 2].fraction);

    streamFixture();
    await promise;
    let fraction = -1;
    for (const p of seen) {
      expect(p.fraction).toBeGreaterThanOrEqual(fraction);
      fraction = p.fraction;
    }
  });
});

// ---------------------------------------------------------------------------
// Stage weights, model state, limits
// ---------------------------------------------------------------------------

describe('stageWeights', () => {
  it('sums to one and holds the D5 derivation from the three measured seeds', () => {
    const w = stageWeights();
    expect(w.separate + w.segment + w.embed).toBeCloseTo(1, 12);

    // Demucs 1000 / 1.52 = 658 ms per audio second, segmentation 8, embedding
    // 55 — the plan's own numbers, retyped here so the weights are pinned
    // against D5 rather than against the module's own arithmetic.
    const total = 1000 / 1.52 + 8 + 55;
    expect(w.separate).toBeCloseTo(1000 / 1.52 / total, 12);
    expect(w.segment).toBeCloseTo(8 / total, 12);
    expect(w.embed).toBeCloseTo(55 / total, 12);
    // ...and the stem service's factor is the one it is derived from.
    expect(MEASURED_REALTIME_FACTOR).toBe(1.52);
    // The rounded shape D5 states, as a sanity rail on the arithmetic above.
    expect(w.separate).toBeCloseTo(0.91, 2);
    expect(w.segment).toBeCloseTo(0.01, 2);
    expect(w.embed).toBeCloseTo(0.08, 2);
  });
});

describe('model state', () => {
  it('reads the bridge when it is there', async () => {
    expect(await getDiarizeModelState()).toEqual({
      downloaded: true,
      bytes: DIARIZE_MODEL_BYTES,
      expectedBytes: DIARIZE_MODEL_BYTES,
    });
  });

  it('reads as not downloaded when the bridge is missing', async () => {
    uninstallDiarizeBackend();
    expect(await getDiarizeModelState()).toEqual({
      downloaded: false,
      bytes: null,
      expectedBytes: DIARIZE_MODEL_BYTES,
    });
  });

  it('streams download progress and unsubscribes afterwards', async () => {
    const seen: { received: number; total: number }[] = [];
    const promise = ensureDiarizeModels((p) => seen.push(p));
    backend.emit.modelProgress({ received: 1000, total: DIARIZE_MODEL_BYTES });
    expect(await promise).toEqual({ ok: true });
    expect(seen).toEqual([{ received: 1000, total: DIARIZE_MODEL_BYTES }]);
    expect(backend.ensureCalls).toBe(1);
    expect(backend.liveListeners).toBe(0);
  });

  it('reports a download failure rather than throwing', async () => {
    backend.ensureResult = { ok: false, error: 'offline' };
    expect(await ensureDiarizeModels()).toEqual({ ok: false, error: 'offline' });
    uninstallDiarizeBackend();
    const result = await ensureDiarizeModels();
    expect(result.ok).toBe(false);
  });
});

describe('measured limits', () => {
  it('records the D6 bench set and nothing more', () => {
    expect(SPEAKER_SEPARATION_LIMITS.recordings).toBe(4);
    expect(SPEAKER_SEPARATION_LIMITS.twoSpeakerRecordings).toBe(3);
    expect(SPEAKER_SEPARATION_LIMITS.fourSpeakerRecordings).toBe(1);
    // 16.0 + 34.0 + 54.8 + 56.9 (design-notes), not a rounded "about three
    // minutes".
    expect(SPEAKER_SEPARATION_LIMITS.seconds).toBeCloseTo(161.7, 6);
    expect(SPEAKER_SEPARATION_LIMITS.countOnlyTruth).toBe(true);
    expect(SPEAKER_SEPARATION_LIMITS.diarizationErrorRate).toBeNull();
    expect(SPEAKER_SEPARATION_LIMITS.fourSpeakerLanguage).toBe('Mandarin');
  });

  it('states the measured limits in the words the dialog shows', () => {
    expect(limitsSentence()).toBe(
      'On the four test recordings (three with two speakers, one with four) the count was right every time, ' +
        'with clean speech fed straight to the speaker step; recordings with many short turns or heavy crosstalk ' +
        'were not in that set. If the count looks wrong, set it here.'
    );
  });
});
