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
  DIARIZE_EMBEDDING_DIMS,
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
  WIRE_LOCAL_SPEAKERS,
  type DiarizeBackend,
} from '../__mocks__/diarizeBackend';
import { readFileSync } from 'fs';
import { join } from 'path';
import { monoMix } from './transcribeService';
import { resampleChannel } from '../dsp/resample';
import { MEASURED_REALTIME_FACTOR } from './stemService';
import { assembleDiarization, expectedWindowCount, frameToSample16k } from '../dsp/diarization';
// The SAME module, as a namespace: `jest.spyOn` needs the object the service
// calls through to observe WHEN the assembly runs (the ordering pin below).
import * as diarizationDsp from '../dsp/diarization';

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
  streamFixtureEvidence(windowCount);
  backend.settle({ ok: true, windowCount });
}

/** Everything the host emits BEFORE its `done` — the same stream without the
 * settlement, so a test can decide what settles the invoke and when. */
function streamFixtureEvidence(windowCount = 3): void {
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
}

/**
 * The same three windows and nine fragments, with `vectorFor` deciding each
 * embedding's payload — the door the wire-width tests below need, since what
 * they vary is the BYTES of one arrival, not the fixture's voices.
 */
function streamFixtureVectors(vectorFor: (k: number, axis: number) => Float32Array): void {
  for (let i = 0; i < 3; i++) backend.emit.window({ index: i, labels: fixtureWindow() });
  FIXTURE_AXES.forEach((f, k) => {
    backend.emit.embedding({
      windowIndex: f.windowIndex,
      localSpeaker: f.localSpeaker,
      activeFrames: ACTIVE_FRAMES[f.localSpeaker],
      vector: vectorFor(k, f.axis),
    });
  });
  backend.settle({ ok: true, windowCount: 3 });
}

/** The fixture's k-th vector, re-cut to `dims` floats — shorter drops the
 * tail, longer pads with zeros (finite, so length is the only thing under
 * test). */
function vectorOfDims(k: number, axis: number, dims: number): Float32Array {
  const full = speakerVector(axis, 4000 + k * 37);
  const out = new Float32Array(dims);
  out.set(full.subarray(0, Math.min(full.length, dims)));
  return out;
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

  it('mirrors the embedding wire width the host emits', () => {
    // diarizeHost.cjs:120 EMBEDDING_DIM = 256, D2's `Float32Array(256)` /
    // 1024 bytes. The fake declares it independently (WIRE_EMBED_DIMS), so
    // this equality is the two halves of the contract agreeing, not one of
    // them reading the other.
    expect(DIARIZE_EMBEDDING_DIMS).toBe(256);
    expect(DIARIZE_EMBEDDING_DIMS).toBe(WIRE_EMBED_DIMS);
  });

  it('carries the measured stage seeds by value', () => {
    // Task 8's re-derivation from the SHIPPED models and the SHIPPED chain:
    // segmentation 10 ms per audio second, embedding 75. The values they
    // replaced (8 and 55) came from `spike-results.json`, whose embedding
    // model was CAM++ — an embedder this feature does not ship.
    expect(MEASURED_SEGMENT_MS_PER_S).toBe(10);
    expect(MEASURED_EMBED_MS_PER_S).toBe(75);
  });

  it('derives both seeds from the committed bench baseline, so a re-tune needs a bench run', () => {
    // The rule both docblocks state, executed rather than described: each seed
    // is the MEDIAN of the four `--full-chain` rows of the committed baseline,
    // rounded to the nearest whole millisecond. `--full-chain` is the shipped
    // path (D1: Demucs, then the diarizer); `--direct` is the sweep's
    // condition and measures a cheaper run.
    //
    // This is the guard the old seeds did not have: with 8 and 55 in place it
    // fails, and it fails again the day someone edits a seed without
    // re-running `scripts/diarize-bench.cjs`.
    const baseline = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'docs', 'bench', 'diarize-bench-baseline.json'), 'utf8')
    ) as {
      tables: { fullChain: { ran: boolean; rows: { msPerAudioSecond: { segment: number; embed: number } }[] } };
    };
    const rows = baseline.tables.fullChain.rows;
    expect(baseline.tables.fullChain.ran).toBe(true);
    expect(rows).toHaveLength(4);

    const median = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return (sorted[1] + sorted[2]) / 2;
    };
    const segments = rows.map((r) => r.msPerAudioSecond.segment);
    const embeds = rows.map((r) => r.msPerAudioSecond.embed);
    // The medians are NOT integers (9.95 and 75.35 as committed), so the
    // rounding is doing real work and this is not an identity assertion.
    expect(Number.isInteger(median(segments))).toBe(false);
    expect(Number.isInteger(median(embeds))).toBe(false);
    expect(Math.round(median(segments))).toBe(MEASURED_SEGMENT_MS_PER_S);
    expect(Math.round(median(embeds))).toBe(MEASURED_EMBED_MS_PER_S);
    // ...and the seeds they replaced are outside what this table measures:
    // both old values sit below the median of their own column, which is the
    // shape of the finding that forced the re-derivation (the estimate ran
    // short). The bound is one step off each median, not the median itself.
    expect(median(segments)).toBeGreaterThan(8);
    expect(median(embeds)).toBeGreaterThan(55);
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
    // starts at global frame trunc(i*16000/270 + 0.5) = 0 / 59 / 119, every
    // frame's winner is the cluster with the most votes across the windows
    // covering it, and voice A is cluster 0 because its fragment arrives
    // first. Replaying that vote (diarization.ts assembleLabels) over the
    // three windows gives, as A votes / B votes:
    //     0.. 58  1/0     59..118  2/0    119..199  3/0    200..258  2/1
    //   259..318  1/2    319..399  0/3    400..588  1/2    589..647  0/2
    //   648..707  0/1    708..711  0/0  (covered by no window, so silent)
    // A leads every frame through 258 and B every frame from 259 on. Two
    // details the arithmetic settles: A's pair at 200..258 is w1 slot 0 +
    // w2 slot 0 (w0's slot 0 has already ended at frame 200 and w0 votes B
    // there), and the fixture never produces an EQUAL vote at all — the
    // lowest-id tie-break is not exercised here, and is pinned instead by the
    // twin-slot fixture in `src/dsp/diarization.test.ts`.
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
    const promise = diarizeChannels({ channels: long, sampleRate: 1000 });
    // BEFORE the first await, which is what makes this a test of the
    // PRE-allocation guard rather than of the status. The cap is checked in
    // the synchronous prefix, ahead of the reservation and ahead of the model
    // probe, so a refusal that has neither reserved the run nor probed cannot
    // have mono-mixed 7,200,001 samples and resampled them into the 460 MB
    // buffer the guard exists to refuse. `status` alone proves nothing: any
    // later cap check answers 'too-long' too, having done exactly that work.
    expect(getDiarizeBusyCount()).toBe(0);
    expect(backend.modelStateCalls).toBe(0);
    const result = await promise;
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

  it('predicts the resampled length exactly, which is why the cap is enforced once', () => {
    // WHY the run checks the cap BEFORE the mono mix and never again after the
    // resample: `modelLength16k` IS `resampleChannel`'s own
    // `round(length x toRate / fromRate)` (`resample.ts:97-98`) applied to the
    // mono mix, and `monoMix` returns exactly `length` samples
    // (`transcribeService.ts:394-395`) — same expression, same doubles. A
    // second cap check after the resample could therefore never fire on
    // anything the pre-check let through, and an unreachable guard reads like
    // a real one. This is that identity across the rates a run can meet: an
    // exact downsample, a rounding one, the `fromRate === toRate` short
    // circuit, an upsample, and the source that rounds away to nothing plus
    // the one step past it (which the post-resample ZERO check does catch —
    // the one thing the prediction cannot express as a cap).
    const cases: [length: number, rate: number][] = [
      [SOURCE_LENGTH, SOURCE_RATE],
      [4411, 44100],
      [1, 44100],
      [2, 44100],
      [1000, 16000],
      [1000, 8000],
      [999, 22050],
      [4801, 48000],
    ];
    for (const [length, rate] of cases) {
      const mixed = monoMix([makeSignal(length, 17), makeSignal(length, 909)], length);
      expect(mixed).toHaveLength(length);
      expect(resampleChannel(mixed, rate, DIARIZE_SAMPLE_RATE)).toHaveLength(modelLength16k(length, rate));
    }
  });

  it('refuses empty audio in its own words, before the model probe', async () => {
    const promise = diarizeChannels({ channels: [new Float32Array(0)], sampleRate: SOURCE_RATE });
    // The pair this half pins (the other half is the test below): an empty
    // source is refused in the synchronous prefix, so nothing is reserved and
    // the model is never probed. Without that check the run would probe,
    // mono-mix and resample an empty buffer and land in the post-resample
    // "too short" guard — same status, different guard, different sentence.
    expect(getDiarizeBusyCount()).toBe(0);
    expect(backend.modelStateCalls).toBe(0);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('failed');
    expect(result.message).toBe('There is no audio to separate into speakers.');
    expect(backend.runCalls).toBe(0);
    // No audio is a user-input condition, not a crash.
    expect(backend.showMessageBox).not.toHaveBeenCalled();
  });

  it('refuses a source that resamples away to nothing, and accepts one sample more', async () => {
    // The case the non-empty check above cannot see: one 44.1 kHz sample is a
    // legal, non-empty source whose 16 kHz length is
    // round(1 x 16000 / 44100) = 0 (`resample.ts:97-98` — the same rounding
    // `modelLength16k` mirrors), so it clears both the length check and the
    // 2-hour cap and only the POST-resample guard stops it. Without that guard
    // a zero-length buffer reaches the host and the run is refused there, or
    // worse, assembled from nothing.
    expect(modelLength16k(1, SOURCE_RATE)).toBe(0);
    const promise = diarizeChannels({ channels: [new Float32Array(1)], sampleRate: SOURCE_RATE });
    // Settled without ever reaching the host — asserted BEFORE the await, so a
    // missing guard reads as "the host was invoked", not as a test timeout.
    await flushUntil(() => !isDiarizing());
    expect(backend.runCalls).toBe(0);
    expect(backend.isPending()).toBe(false);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('failed');
    expect(result.message).toBe('The audio is too short to separate into speakers.');
    expect(backend.runCalls).toBe(0);
    // Too short to analyse is a user-input condition, not a crash.
    expect(backend.showMessageBox).not.toHaveBeenCalled();
    expect(getDiarizeBusyCount()).toBe(0);

    // One step past the boundary: two source samples round UP to one 16 kHz
    // sample, which is short but not nothing, so it does go to the host.
    expect(modelLength16k(2, SOURCE_RATE)).toBe(1);
    const shortest = diarizeChannels({ channels: [new Float32Array(2)], sampleRate: SOURCE_RATE });
    await flushUntil(() => backend.isPending());
    expect(backend.runCalls).toBe(1);
    expect(backend.lastRequest?.samples.byteLength).toBe(4);
    backend.settle({ ok: true, windowCount: 0 });
    const past = await shortest;
    if (!past.ok) throw new Error(`expected ok, got ${past.status}: ${past.message}`);
    expect(past.evidence.totalSamples16k).toBe(1);
    expect(past.diarization.speakerCount).toBe(0);
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

  it('maps a host-initiated cancelled settlement to cancelled, with nobody having asked', async () => {
    // The app-quit path (D2): `diarizeManager.dispose()` latches and calls
    // `cancel()` (diarizeManager.cjs:436-439), which settles the in-flight
    // entry `{ok:false,cancelled:true}` at :431 without the renderer ever
    // calling `cancelDiarization` — so `run.cancelled` is false here and the
    // status can only come from the SETTLEMENT. The host's own soft cancel
    // between windows arrives by the same door (diarizeManager.cjs:405-406).
    // Without this test the settlement branch is dead: every other cancel
    // test sets `run.cancelled` first and returns one guard earlier.
    const promise = diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    await flushUntil(() => backend.isPending());
    backend.settle({ ok: false, cancelled: true });
    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('cancelled');
    // Nobody in the renderer asked for it, and it is still not a failure.
    expect(backend.cancelCalls).toBe(0);
    expect(backend.showMessageBox).not.toHaveBeenCalled();
    expect(getDiarizeBusyCount()).toBe(0);
    expect(backend.liveListeners).toBe(0);
  });

  it('catches a Cancel raised while the model probe is in flight, before the resample', async () => {
    // `getDiarizeModelState()` is the run's FIRST await, so the dialog's
    // Cancel really can land here — unlike door 3, which no yield precedes.
    // The status alone does not prove the probe door fired: door 2 re-reads
    // `run.cancelled` and would answer 'cancelled' too, one full mono mix and
    // one windowed-sinc pass later (hundreds of megabytes on a real stem).
    // What separates them is that the 'resampling' publish sits BETWEEN the
    // two, so an empty progress log is the proof no work was started.
    const seen: DiarizeProgress[] = [];
    const promise = diarizeChannels({
      channels: makeChannels(),
      sampleRate: SOURCE_RATE,
      onProgress: (p) => seen.push(p),
    });
    // The probe has been issued and the run is reserved, with nothing spawned.
    expect(backend.modelStateCalls).toBe(1);
    expect(getDiarizeBusyCount()).toBe(1);
    expect(backend.runCalls).toBe(0);

    // `abortRun` sets the flag in `cancelDiarization`'s synchronous prefix, so
    // it is already set when the probe's promise resolves.
    const cancelling = cancelDiarization();
    const result = await promise;
    expect(await cancelling).toBe(true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('cancelled');
    expect(seen).toEqual([]);
    expect(backend.runCalls).toBe(0);
    expect(backend.showMessageBox).not.toHaveBeenCalled();
    expect(getDiarizeBusyCount()).toBe(0);
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

  it('honours shouldCancel at the last look before the invoke, and tears the listeners down', async () => {
    // Door 3 (D5): false at the pre-probe and post-resample looks, true at the
    // third. What is NOT true of this door, stated plainly because the obvious
    // reading is wrong: no real Cancel can land at it. Door 2 and door 3 are
    // separated by no yield point at all — between them sit one assignment,
    // two length guards and the three synchronous `bridge.on*` subscriptions —
    // so the dialog's `cancelledRef` reads identically at both, and
    // `run.cancelled` cannot change either, since `cancelDiarization()` only
    // ever runs from an event handler that needs a yield to be reached. The
    // only caller that gets a different answer at door 3 than at door 2 is a
    // predicate that counts its own calls, which is what this test uses: a
    // test-only device that pins the COUNT D5 fixes at three, not a model of
    // the dialog. Deleting door 3 fails exactly this test and nothing else,
    // and that is the honest extent of the pin.
    let calls = 0;
    const result = await diarizeChannels({
      channels: makeChannels(),
      sampleRate: SOURCE_RATE,
      shouldCancel: () => calls++ >= 2,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('cancelled');
    expect(calls).toBe(3);
    expect(backend.modelStateCalls).toBe(1);
    expect(backend.runCalls).toBe(0);
    // Door 3 sits BEHIND the three subscriptions, so it is the only path that
    // proves they are unsubscribed when the run never reaches the host.
    expect(backend.liveListeners).toBe(0);
    expect(getDiarizeBusyCount()).toBe(0);
  });

  it('wins over an {ok:true} settlement when the host won the race', async () => {
    // The race is the manager's, not a hypothetical: `diarizeManager.cjs:403`
    // settles {ok:true,windowCount} the instant the host reports `done`, and
    // settling nulls its `active` (:293-297), so a Cancel landing one tick
    // later finds nothing to kill and answers {cancelled:false} (:429-431)
    // while the renderer's invoke has ALREADY resolved {ok:true}. Meanwhile
    // `cancelDiarization` set `run.cancelled` synchronously. Without the
    // cancel read at the invoke's return, this run resolves
    // {ok:true, evidence, diarization} — the dialog opens its review panel and
    // offers Land for a run the user stopped.
    //
    // Every other cancel test here takes the SETTLEMENT's cancelled branch
    // instead, because the fake's cancel settles the pending invoke; the
    // `cancelSettlesRun = false` mode is that ordering and nothing else.
    backend.cancelSettlesRun = false;
    const promise = diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    await flushUntil(() => backend.isPending());
    streamFixtureEvidence();
    expect(await cancelDiarization()).toBe(true);
    // The host had already finished: the manager answers with the success it
    // was holding.
    backend.settle({ ok: true, windowCount: 3 });

    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('cancelled');
    expect(backend.cancelCalls).toBe(1);
    // A cancel is not a failure, and it leaves nothing reserved behind it.
    expect(backend.showMessageBox).not.toHaveBeenCalled();
    expect(getDiarizeBusyCount()).toBe(0);
    expect(backend.liveListeners).toBe(0);
  });

  it('answers that race cancelled rather than as a window-count failure', async () => {
    // What separates the cancel read at the invoke's return from the one
    // behind the clustering yield — both answer 'cancelled' for the test
    // above, so only this shape tells them apart. A Cancel that lands while
    // the host is still streaming leaves fewer windows than its `done` counts,
    // and the count check sits BETWEEN the two reads: without the first one,
    // this run raises a native "reported 3 window(s) but delivered 1" box and
    // reports 'failed' for a run the user stopped.
    backend.cancelSettlesRun = false;
    const promise = diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    await flushUntil(() => backend.isPending());
    backend.emit.window({ index: 0, labels: fixtureWindow() });
    expect(await cancelDiarization()).toBe(true);
    backend.settle({ ok: true, windowCount: 3 });

    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('cancelled');
    expect(backend.showMessageBox).not.toHaveBeenCalled();
    expect(getDiarizeBusyCount()).toBe(0);
    expect(backend.liveListeners).toBe(0);
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

  it('keeps the FIRST valid window at an index when the host re-sends one', async () => {
    // A re-sent index is a protocol violation whichever way it is resolved;
    // what must not be left undecided is WHICH payload the assembly sees. The
    // rule is first-VALID-wins (the `has` gate in `acceptWindow`, which a
    // malformed payload never reaches the `set` of), and the second window
    // here is one the per-frame vote notices: all 589 frames class 1 puts
    // local slot 0 — voice A — on every frame window 2 covers, so last-wins
    // would hand back a different segmentation, not merely different bytes.
    const promise = diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    await flushUntil(() => backend.isPending());
    for (let i = 0; i < 3; i++) backend.emit.window({ index: i, labels: fixtureWindow() });
    const allVoiceA = classWindow([{ from: 0, to: WIRE_WINDOW_FRAMES, class: 1 }]);
    backend.emit.window({ index: 2, labels: allVoiceA });
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
    expect(result.evidence.windows[2]).toEqual(fixtureWindow());
    // The fixture's own two segments, unchanged by the late arrival.
    expect(result.diarization.segments).toEqual([
      { startSample16k: frameToSample16k(0), endSample16k: frameToSample16k(259), speaker: 0 },
      { startSample16k: frameToSample16k(259), endSample16k: frameToSample16k(708), speaker: 1 },
    ]);
    // ...and the discrimination: the payload that was ignored really would
    // have changed the answer, so "first wins" is a claim with teeth.
    const lastWins = assembleDiarization({
      ...result.evidence,
      windows: [result.evidence.windows[0], result.evidence.windows[1], allVoiceA],
    });
    expect(lastWins.segments).not.toEqual(result.diarization.segments);
  });

  it('drops an embedding whose slot, window index or frame count is outside the contract', async () => {
    // Four rows the host must never send. Each of the first three makes
    // `assembleDiarization` throw a RangeError if it is let through
    // (`diarization.ts` checkEvidence) — which is a whole FAILED run plus a
    // native error box for one malformed fragment, instead of one dropped
    // fragment and nine good ones. The boundary is pinned from both sides:
    // slots 0..2 are the nine good fragments above, WIRE_LOCAL_SPEAKERS (3)
    // is the first slot past the top and -1 the first below; windowIndex -1
    // clears the `< windows.length` filter that catches the window-7 row in
    // the test below, so this guard is the only thing that stops it.
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
    backend.emit.embedding({ windowIndex: -1, localSpeaker: 0, activeFrames: 200, vector: speakerVector(0, 11) });
    backend.emit.embedding({
      windowIndex: 0,
      localSpeaker: WIRE_LOCAL_SPEAKERS,
      activeFrames: 200,
      vector: speakerVector(0, 12),
    });
    backend.emit.embedding({ windowIndex: 0, localSpeaker: -1, activeFrames: 200, vector: speakerVector(1, 13) });
    // The fourth is the one the assembly would NOT notice: `activeFrames` is
    // carried in the evidence and recomputed by `embeddableFragments`, so a
    // negative count corrupts nothing downstream — it is dropped because a
    // count of turns below zero is not a thing the host may say, and the
    // evidence this service hands the dialog is the evidence it validated.
    backend.emit.embedding({ windowIndex: 1, localSpeaker: 0, activeFrames: -1, vector: speakerVector(0, 14) });
    backend.settle({ ok: true, windowCount: 3 });
    const result = await promise;
    if (!result.ok) throw new Error(`expected ok, got ${result.status}: ${result.message}`);
    expect(result.evidence.embeddings.map((e) => [e.windowIndex, e.localSpeaker])).toEqual(
      FIXTURE_AXES.map((f) => [f.windowIndex, f.localSpeaker])
    );
    expect(result.diarization.speakerCount).toBe(2);
    // One malformed fragment is not a failed run: no native box.
    expect(backend.showMessageBox).not.toHaveBeenCalled();
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

  it('drops an off-dimension embedding that arrives FIRST, keeping the eight behind it', async () => {
    // The inversion this pins: judging width against the FIRST arrival rather
    // than against the wire constant makes one short leading payload the new
    // truth, and the eight correct 256-d vectors behind it are then the ones
    // dropped — a two-voice recording reported as one voice, with {ok:true}
    // and no gate anywhere (the window path has a count gate; embeddings have
    // none). D2 fixes the width at `Float32Array(256)` / 1024 bytes, and the
    // host's own `EMBEDDING_DIM` (diarizeHost.cjs:120) is that 256.
    const promise = diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    await flushUntil(() => backend.isPending());
    streamFixtureVectors((k, axis) =>
      k === 0 ? vectorOfDims(k, axis, WIRE_EMBED_DIMS - 1) : speakerVector(axis, 4000 + k * 37)
    );
    const result = await promise;
    if (!result.ok) throw new Error(`expected ok, got ${result.status}: ${result.message}`);
    // Exactly the eight behind it, in arrival order, at the wire width.
    expect(result.evidence.embeddings.map((e) => [e.windowIndex, e.localSpeaker])).toEqual(
      FIXTURE_AXES.slice(1).map((f) => [f.windowIndex, f.localSpeaker])
    );
    for (const e of result.evidence.embeddings) expect(e.vector).toHaveLength(WIRE_EMBED_DIMS);
    // No speaker count is asserted here on purpose: the dropped fragment is
    // one of voice A's four, and three is under MIN_CLUSTER_SIZE, so the fold
    // legitimately collapses this run to one voice. What the drop must NOT do
    // is take the other eight with it.
  });

  it('drops an off-dimension embedding mid-stream, one float below and one above the wire width', async () => {
    // The boundary from both sides. Fragment 4 is one of voice B's five, so
    // losing it leaves 4 and 4 — both at MIN_CLUSTER_SIZE — and the two voices
    // survive, which is what makes "the rest are kept" a visible claim rather
    // than an embedding count.
    for (const dims of [WIRE_EMBED_DIMS - 1, WIRE_EMBED_DIMS + 1]) {
      const promise = diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
      await flushUntil(() => backend.isPending());
      streamFixtureVectors((k, axis) =>
        k === 4 ? vectorOfDims(k, axis, dims) : speakerVector(axis, 4000 + k * 37)
      );
      const result = await promise;
      if (!result.ok) throw new Error(`expected ok at ${dims} dims, got ${result.status}: ${result.message}`);
      expect(result.evidence.embeddings.map((e) => [e.windowIndex, e.localSpeaker])).toEqual(
        FIXTURE_AXES.filter((_, k) => k !== 4).map((f) => [f.windowIndex, f.localSpeaker])
      );
      for (const e of result.evidence.embeddings) expect(e.vector).toHaveLength(WIRE_EMBED_DIMS);
      expect(result.diarization.speakerCount).toBe(2);
    }
  });

  it('keeps every embedding when all nine arrive at exactly the wire width', async () => {
    // The other side of the boundary, on the same helper: 256 is accepted, and
    // the assertion above is not passing because the guard drops everything.
    const promise = diarizeChannels({ channels: makeChannels(), sampleRate: SOURCE_RATE });
    await flushUntil(() => backend.isPending());
    streamFixtureVectors((k, axis) => vectorOfDims(k, axis, WIRE_EMBED_DIMS));
    const result = await promise;
    if (!result.ok) throw new Error(`expected ok, got ${result.status}: ${result.message}`);
    expect(result.evidence.embeddings).toHaveLength(FIXTURE_AXES.length);
    expect(result.diarization.speakerCount).toBe(2);
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
// The paint the assembly runs behind (D5)
// ---------------------------------------------------------------------------

describe('the clustering label is painted before the assembly', () => {
  it('publishes the label, yields to a paint, and only then assembles', async () => {
    // D5: "the assembly runs behind the last label after a yield". Ordering is
    // the whole point — publishing 'clustering' and calling the assembler in
    // the same synchronous stretch emits the right events in the right order
    // and still leaves the user staring at "Comparing voices" with the bar at
    // 100 % while the main thread blocks in the clusterer.
    //
    // `invocationCallOrder` is one monotonic counter shared by every jest mock,
    // which is what makes an order across three unrelated functions
    // observable — the same instrument `vocalChain.test.ts:4966-4999` uses on
    // `announceMeasuring`, whose shape this yield borrows.
    const raf = jest.spyOn(window, 'requestAnimationFrame');
    const assemble = jest.spyOn(diarizationDsp, 'assembleDiarization');
    const onProgress = jest.fn<void, [DiarizeProgress]>();

    const result = await runFixture({ onProgress });
    expect(result.ok).toBe(true);

    const clustering = onProgress.mock.calls.findIndex((c) => c[0].phase === 'clustering');
    expect(clustering).toBeGreaterThanOrEqual(0);
    expect(assemble).toHaveBeenCalledTimes(1);
    // ONE frame per run, not per stage: this is the only yield on the path.
    expect(raf).toHaveBeenCalledTimes(1);

    const label = onProgress.mock.invocationCallOrder[clustering];
    const paint = raf.mock.invocationCallOrder[0];
    expect(label).toBeLessThan(paint);
    expect(assemble.mock.invocationCallOrder[0]).toBeGreaterThan(paint);

    assemble.mockRestore();
    raf.mockRestore();
  });

  it('yields only for a consumer that asked for progress', async () => {
    // A frame is real work, and a caller with no `onProgress` has no label on
    // screen to paint behind — Task 6's landing hook and the bench drive this
    // service with no callback at all. The gate is the contract
    // `announceMeasuring` states for the chains (vocalChain.ts:2135-2153),
    // kept here for the same reason.
    const raf = jest.spyOn(window, 'requestAnimationFrame');
    const result = await runFixture();
    expect(result.ok).toBe(true);
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });

  it('lets a Cancel raised during that paint win over the finished run', async () => {
    // The yield opens a real window: one frame, with the dialog's Cancel live
    // and the invoke already resolved {ok:true}. The read at the invoke's
    // return happened BEFORE this publish, so it cannot cover this — without a
    // second read behind the yield the run assembles and resolves ok, and the
    // dialog reviews a run the user stopped.
    const assemble = jest.spyOn(diarizationDsp, 'assembleDiarization');
    const promise = diarizeChannels({
      channels: makeChannels(),
      sampleRate: SOURCE_RATE,
      onProgress: (p) => {
        if (p.phase === 'clustering') void cancelDiarization();
      },
    });
    await flushUntil(() => backend.isPending());
    streamFixture();

    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('cancelled');
    // Stopped before the expensive part, not after it.
    expect(assemble).not.toHaveBeenCalled();
    expect(backend.showMessageBox).not.toHaveBeenCalled();
    expect(getDiarizeBusyCount()).toBe(0);
    expect(backend.liveListeners).toBe(0);
    assemble.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Stage weights, model state, limits
// ---------------------------------------------------------------------------

describe('stageWeights', () => {
  it('sums to one and holds the D5 derivation from the three measured seeds', () => {
    const w = stageWeights();
    expect(w.separate + w.segment + w.embed).toBeCloseTo(1, 12);

    // Demucs 1000 / 1.52 = 658 ms per audio second, segmentation 10, embedding
    // 75 — the measured numbers retyped here so the weights are pinned against
    // the measurements rather than against the module's own arithmetic.
    const total = 1000 / 1.52 + 10 + 75;
    expect(w.separate).toBeCloseTo(1000 / 1.52 / total, 12);
    expect(w.segment).toBeCloseTo(10 / total, 12);
    expect(w.embed).toBeCloseTo(75 / total, 12);
    // ...and the stem service's factor is the one it is derived from. Task 8
    // measured the stem stage at 1.97-2.07x realtime over the four committed bench
    // rows and left this constant alone deliberately (it predates the feature,
    // seeds three other dialogs, and 1.52 is the conservative end): the
    // discrepancy is a ledger follow-up, not a silent retune.
    expect(MEASURED_REALTIME_FACTOR).toBe(1.52);
    // The rounded shape, as a sanity rail on the arithmetic above.
    expect(w.separate).toBeCloseTo(0.886, 3);
    expect(w.segment).toBeCloseTo(0.013, 3);
    expect(w.embed).toBeCloseTo(0.101, 3);
    // The embedding stage is now nearly EIGHT times the segmentation stage's
    // weight; under the seeds this replaced it was under seven, and the bar
    // handed Demucs 91.3 % of itself.
    expect(w.embed / w.segment).toBeCloseTo(7.5, 1);
    expect(w.separate).toBeLessThan(0.9);
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
        'both from clean speech and through the voice separation this tool runs first; recordings with many ' +
        'short turns or heavy crosstalk were not in that set. If the count looks wrong, set it here.'
    );
  });

  it('claims the SHIPPED chain, because the bench measured the shipped chain', () => {
    // D5 told Task 8 to rewrite this line if the full-chain table differed
    // from the direct one, and it did not differ where it counts: both modes
    // reach the file-name truth on all four recordings, so the sentence no
    // longer restricts its claim to speech fed straight to the speaker step.
    const baseline = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'docs', 'bench', 'diarize-bench-baseline.json'), 'utf8')
    ) as { tables: Record<'direct' | 'fullChain', { ran: boolean; counts: number[]; truth: number[] }> };
    for (const mode of ['direct', 'fullChain'] as const) {
      expect(baseline.tables[mode].ran).toBe(true);
      expect(baseline.tables[mode].counts).toEqual(baseline.tables[mode].truth);
      expect(baseline.tables[mode].counts).toEqual([2, 2, 2, 4]);
    }
    expect(limitsSentence()).toContain('through the voice separation this tool runs first');
    expect(limitsSentence()).not.toContain('fed straight to the speaker step');
    // The half that is still a limit stays a limit.
    expect(limitsSentence()).toContain('many short turns or heavy crosstalk were not in that set');
  });
});
