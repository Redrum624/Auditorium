// Verifies the Jest moduleNameMapper swaps createTempoWorker for the
// synchronous mock (src/__mocks__/createTempoWorkerMock.ts), that the mock's
// `done` payload is bit-for-bit consistent with the shared pure core
// (analyzeTempo) — the only guard against mock/worker protocol drift
// (createSpectrogramWorker.test.ts:44-54 pattern) — and that every worker
// error path (in-band error, load failure, post-terminate silence) behaves
// per the v1.4 lesson at effectRunner.ts:106-119.
import { createTempoWorker } from './createTempoWorker';
import { analyzeTempo, deriveGrid, MIN_BPM, MAX_BPM } from '../dsp/tempoCore';
import type { TempoAnalysis } from '../dsp/tempoCore';
import { analyzeRemix } from '../dsp/remixFeatures';
import type { RemixAnalysis } from '../dsp/remixFeatures';
import {
  _setTempoWorkerError,
  _setTempoWorkerLoadFailure,
  _getLastTempoMessage,
  _getTempoWorkerTerminateCount,
  _resetTempoWorkerTestState,
} from '../__mocks__/createTempoWorkerMock';

interface ProgressMsg {
  type: 'progress';
  id: number;
  fraction: number;
}
interface DoneMsg {
  type: 'done';
  id: number;
  level: 'tempo' | 'remix' | 'regrid';
  analysis: TempoAnalysis | RemixAnalysis;
}
interface ErrorMsg {
  type: 'error';
  id: number;
  message: string;
}
type Reply = ProgressMsg | DoneMsg | ErrorMsg;

/** A unit-impulse click train at `bpm` beats/minute over `seconds`, first
 * click at sample 0 (mirrors tempoCore.test.ts's local generator — this
 * repo re-declares such helpers per test file rather than sharing one). */
function clickTrain(bpm: number, seconds: number, sr = 44100): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const interval = Math.round((60 / bpm) * sr);
  for (let i = 0; i < n; i += interval) out[i] = 1;
  return out;
}

/** Drives the worker for one 'analyze' request and resolves with every reply
 * received (progress*, then exactly one of done/error), in arrival order. */
function runAnalyze(
  worker: Worker,
  mono: Float32Array,
  sampleRate: number,
  id = 1,
  level: 'tempo' | 'remix' | 'regrid' = 'tempo'
): Promise<Reply[]> {
  const received: Reply[] = [];
  return new Promise((resolve) => {
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as Reply;
      received.push(msg);
      if (msg.type === 'done' || msg.type === 'error') resolve(received);
    };
    worker.postMessage(
      {
        type: 'analyze',
        id,
        level,
        mono,
        sampleRate,
        minBpm: MIN_BPM,
        maxBpm: MAX_BPM,
        beatsPerBar: 4,
        downbeatShiftBeats: 0,
      },
      [mono.buffer]
    );
  });
}

afterEach(() => {
  _resetTempoWorkerTestState();
});

describe('createTempoWorker equivalence (acceptance 1)', () => {
  it('mock done payload is deep-equal to analyzeTempo called directly, field by field', async () => {
    const SR = 44100;
    const mono = clickTrain(120, 8, SR);
    const monoForDirectCall = clickTrain(120, 8, SR); // separate buffer: the worker's copy gets transferred away

    const worker = createTempoWorker();
    const replies = await runAnalyze(worker, mono, SR, 7, 'tempo');
    const done = replies[replies.length - 1] as DoneMsg;

    expect(done.type).toBe('done');
    expect(done.id).toBe(7);
    expect(done.level).toBe('tempo');

    const expected = analyzeTempo(monoForDirectCall, SR, { minBpm: MIN_BPM, maxBpm: MAX_BPM });

    expect(done.analysis.bpm).toBe(expected.bpm);
    expect(done.analysis.confidence).toBe(expected.confidence);
    expect(done.analysis.salience).toBe(expected.salience);
    expect(done.analysis.peakRatio).toBe(expected.peakRatio);
    expect(done.analysis.ibiCv).toBe(expected.ibiCv);
    expect(done.analysis.truncated).toBe(expected.truncated);
    expect(done.analysis.analyzedEndSample).toBe(expected.analyzedEndSample);
    expect(Array.from(done.analysis.beatSamples)).toEqual(Array.from(expected.beatSamples));
    // N2 (T4 review fix round 2): `odf`/`periodFrames`/`decimationFactor` are
    // the fields Plan Ruling 4 added specifically so the regrid path can
    // retain them — `odf` in particular is the newly-TRANSFERRED field
    // (tempo.worker.ts's `done` transfer list now includes
    // `analysis.odf.buffer` alongside `beatSamples.buffer`), which the mock
    // (no real Worker, no real structured-clone/transfer) cannot exercise
    // directly, making this field-equality check the only guard against the
    // mock and the real worker silently disagreeing on `odf`'s shape/content.
    expect(done.analysis.periodFrames).toBe(expected.periodFrames);
    expect(done.analysis.decimationFactor).toBe(expected.decimationFactor);
    expect(done.analysis.odf.length).toBeGreaterThan(0);
    expect(Array.from(done.analysis.odf)).toEqual(Array.from(expected.odf));

    worker.terminate();
  });
});

describe('createTempoWorker level:"remix" (T9, fix round 1 -- real coverage replacing the stale stub assertion)', () => {
  it('mock done payload is deep-equal to analyzeRemix called directly, field by field', async () => {
    const SR = 44100;
    const mono = clickTrain(120, 8, SR);
    const monoForDirectCall = clickTrain(120, 8, SR); // separate buffer: the worker's copy gets transferred away

    const worker = createTempoWorker();
    const replies = await runAnalyze(worker, mono, SR, 8, 'remix');
    const done = replies[replies.length - 1] as DoneMsg;

    expect(done.type).toBe('done');
    expect(done.id).toBe(8);
    expect(done.level).toBe('remix');

    const expected = analyzeRemix(monoForDirectCall, SR, { minBpm: MIN_BPM, maxBpm: MAX_BPM }, { beatsPerBar: 4, downbeatShiftBeats: 0 });
    const analysis = done.analysis as RemixAnalysis;

    expect(analysis.bpm).toBe(expected.bpm);
    expect(Array.from(analysis.beatSamples)).toEqual(Array.from(expected.beatSamples));
    expect(analysis.numBands).toBe(expected.numBands);
    expect(Array.from(analysis.bands)).toEqual(Array.from(expected.bands));
    expect(Array.from(analysis.odfLow)).toEqual(Array.from(expected.odfLow));
    expect(analysis.numChromaFrames).toBe(expected.numChromaFrames);
    expect(analysis.chromaRate).toBe(expected.chromaRate);
    expect(Array.from(analysis.chroma)).toEqual(Array.from(expected.chroma));
    expect(analysis.downbeatPhase).toBe(expected.downbeatPhase);
    expect(analysis.downbeatConfidence).toBe(expected.downbeatConfidence);
    expect(analysis.numBars).toBe(expected.numBars);
    expect(Array.from(analysis.barBoundary)).toEqual(Array.from(expected.barBoundary));
    expect(Array.from(analysis.T)).toEqual(Array.from(expected.T));
    expect(Array.from(analysis.C)).toEqual(Array.from(expected.C));
    expect(Array.from(analysis.L)).toEqual(Array.from(expected.L));
    expect(Array.from(analysis.R)).toEqual(Array.from(expected.R));
    expect(Array.from(analysis.S)).toEqual(Array.from(expected.S));
    expect(Array.from(analysis.cluster)).toEqual(Array.from(expected.cluster));
    expect(Array.from(analysis.transitionSeen)).toEqual(Array.from(expected.transitionSeen));

    worker.terminate();
  });
});

describe('createTempoWorker level:"regrid" (Task T4 Plan Ruling 4)', () => {
  it('mock done payload is deep-equal to deriveGrid called directly, field by field, and skips the full pipeline (no progress messages)', async () => {
    const SR = 44100;
    const mono = clickTrain(120, 8, SR);
    const original = analyzeTempo(mono, SR, { minBpm: MIN_BPM, maxBpm: MAX_BPM });
    expect(original.bpm).not.toBeNull();

    const monoForRegrid = clickTrain(120, 8, SR); // separate buffer: transferred away by postMessage
    const monoForDirectCall = clickTrain(120, 8, SR);
    const newPeriodFrames = original.periodFrames / 2;

    const worker = createTempoWorker();
    const received: Reply[] = [];
    const done = await new Promise<DoneMsg>((resolve) => {
      worker.onmessage = (e: MessageEvent) => {
        const msg = e.data as Reply;
        received.push(msg);
        if (msg.type === 'done' || msg.type === 'error') resolve(msg as DoneMsg);
      };
      worker.postMessage(
        {
          type: 'analyze',
          id: 11,
          level: 'regrid',
          mono: monoForRegrid,
          sampleRate: SR,
          minBpm: MIN_BPM,
          maxBpm: MAX_BPM,
          beatsPerBar: 4,
          downbeatShiftBeats: 0,
          odf: original.odf,
          periodFrames: newPeriodFrames,
        },
        [monoForRegrid.buffer]
      );
    });

    expect(done.type).toBe('done');
    expect(done.level).toBe('regrid');
    // No progress messages -- deriveGrid skips decimation/FFT/ACF/octave-search.
    expect(received.filter((r) => r.type === 'progress').length).toBe(0);

    const expected = deriveGrid(monoForDirectCall, SR, original.odf, newPeriodFrames);
    expect(done.analysis.bpm).toBe(expected.bpm);
    expect(done.analysis.ibiCv).toBe(expected.ibiCv);
    expect(done.analysis.salience).toBe(expected.salience);
    expect(done.analysis.periodFrames).toBe(expected.periodFrames);
    expect(done.analysis.decimationFactor).toBe(expected.decimationFactor);
    expect(Array.from(done.analysis.beatSamples)).toEqual(Array.from(expected.beatSamples));
    // N2: odf must round-trip unchanged through the regrid request too.
    expect(Array.from(done.analysis.odf)).toEqual(Array.from(original.odf));
    // The whole point of the regrid path: roughly double the beat count of
    // the original (un-corrected) analysis.
    expect(done.analysis.beatSamples.length).toBeGreaterThan(original.beatSamples.length * 1.7);

    worker.terminate();
  });

  it('errors cleanly (not a crash) when odf/periodFrames are missing from a regrid request', async () => {
    const worker = createTempoWorker();
    const mono = clickTrain(120, 8, 44100);
    const replies = await runAnalyze(worker, mono, 44100, 12, 'regrid');

    expect(replies.filter((r) => r.type === 'done').length).toBe(0);
    expect(replies[replies.length - 1]).toEqual({
      type: 'error',
      id: 12,
      message: 'regrid request missing odf/periodFrames',
    });

    worker.terminate();
  });
});

describe('createTempoWorker progress throttle (acceptance 2)', () => {
  it('progress messages are monotonic non-decreasing, in [0,1], and fewer than 40 for an 8s fixture', async () => {
    const SR = 44100;
    const mono = clickTrain(120, 8, SR);
    const worker = createTempoWorker();
    const replies = await runAnalyze(worker, mono, SR, 1, 'tempo');
    const progress = replies.filter((r): r is ProgressMsg => r.type === 'progress');

    expect(progress.length).toBeGreaterThan(0);
    expect(progress.length).toBeLessThan(40);
    for (const p of progress) {
      expect(p.fraction).toBeGreaterThanOrEqual(0);
      expect(p.fraction).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].fraction).toBeGreaterThanOrEqual(progress[i - 1].fraction);
    }

    worker.terminate();
  });
});

describe('createTempoWorker error handling (acceptance 3, 4, 5)', () => {
  it('_setTempoWorkerError -> exactly one {type:"error"} reply and no "done"', async () => {
    _setTempoWorkerError('boom');
    const worker = createTempoWorker();
    const mono = clickTrain(120, 8, 44100);
    const replies = await runAnalyze(worker, mono, 44100, 3, 'tempo');

    expect(replies.length).toBe(1);
    expect(replies[0]).toEqual({ type: 'error', id: 3, message: 'boom' });

    worker.terminate();
  });

  it('_setTempoWorkerLoadFailure -> onerror fires and onmessage is never called', async () => {
    _setTempoWorkerLoadFailure('nope');
    const worker = createTempoWorker();
    const onmessage = jest.fn();
    worker.onmessage = onmessage;

    const errored = await new Promise<ErrorEvent>((resolve) => {
      worker.onerror = (ev) => resolve(ev as ErrorEvent);
      worker.postMessage(
        {
          type: 'analyze',
          id: 4,
          level: 'tempo',
          mono: clickTrain(120, 8, 44100),
          sampleRate: 44100,
          minBpm: MIN_BPM,
          maxBpm: MAX_BPM,
          beatsPerBar: 4,
          downbeatShiftBeats: 0,
        },
        []
      );
    });

    expect(errored.message).toBe('nope');
    expect(onmessage).not.toHaveBeenCalled();

    worker.terminate();
  });

  it('after terminate(), a subsequent postMessage produces no callbacks at all', async () => {
    const worker = createTempoWorker();
    const onmessage = jest.fn();
    const onerror = jest.fn();
    worker.onmessage = onmessage;
    worker.onerror = onerror;

    worker.terminate();
    worker.postMessage(
      {
        type: 'analyze',
        id: 5,
        level: 'tempo',
        mono: clickTrain(120, 8, 44100),
        sampleRate: 44100,
        minBpm: MIN_BPM,
        maxBpm: MAX_BPM,
        beatsPerBar: 4,
        downbeatShiftBeats: 0,
      },
      []
    );

    // Flush any pending microtasks the (terminated) worker might otherwise
    // have scheduled.
    await Promise.resolve();
    await Promise.resolve();

    expect(onmessage).not.toHaveBeenCalled();
    expect(onerror).not.toHaveBeenCalled();
  });
});

describe('createTempoWorker jest wiring (acceptance 7)', () => {
  it('constructs without throwing under jsdom — only possible via the moduleNameMapper redirect', () => {
    // If jest.config.cjs's '^.+/createTempoWorker$' mapper entry were missing,
    // this import would resolve to the REAL createTempoWorker.ts, whose body
    // calls `new Worker(new URL(...), ...)` — jsdom has no Worker
    // implementation, so this would throw (or fail even earlier, since
    // ts-jest cannot compile `import.meta.url` under this project's
    // `module: 'commonjs'` transform option). The failure would NOT look
    // like a jest-config problem; it would look like an unrelated Worker/
    // compile error surfacing from deep inside whatever test happened to
    // import createTempoWorker first.
    let worker: Worker | undefined;
    expect(() => {
      worker = createTempoWorker();
    }).not.toThrow();
    expect(typeof worker!.postMessage).toBe('function');
    expect(typeof worker!.terminate).toBe('function');
    worker!.terminate();
  });

  it('captures the last posted message and counts terminate() calls (mock test-hook sanity)', async () => {
    const worker = createTempoWorker();
    const mono = clickTrain(120, 8, 44100);
    await runAnalyze(worker, mono, 44100, 9, 'tempo');
    const last = _getLastTempoMessage();
    expect(last?.id).toBe(9);
    expect(last?.level).toBe('tempo');

    expect(_getTempoWorkerTerminateCount()).toBe(0);
    worker.terminate();
    expect(_getTempoWorkerTerminateCount()).toBe(1);
  });
});
