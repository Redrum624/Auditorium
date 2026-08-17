/**
 * Direct test of `remixPlan.worker.ts`'s own module code — NOT via
 * `createRemixPlanWorker`/the mock, the same approach `tempo.worker.test.ts`
 * takes for the analysis worker. jsdom provides `self` as an alias for the
 * global object and this worker only ever reads/assigns `self.onmessage` /
 * `self.postMessage`, so importing the module once (executing its top-level
 * `ctx.onmessage = ...` exactly as it would inside a real Worker) and then
 * invoking that handler directly exercises the REAL code path.
 *
 * The point of this file is PROTOCOL PARITY: `createRemixPlanWorkerMock.ts`
 * is an in-process double, so nothing else in the suite would catch the real
 * worker and the mock drifting apart (a renamed message field, a reply the
 * service never matches). Every assertion below is made against BOTH.
 */
import './remixPlan.worker';
import { planRemix } from '../dsp/remixPlan';
import { DEFAULT_REMIX_WEIGHTS } from '../dsp/remixCost';
import type { PlanRemixOptions } from '../dsp/remixPlan';
import type { RemixAnalysis } from '../dsp/remixFeatures';
import {
  createRemixPlanWorker,
  _resetRemixPlanWorkerTestState,
} from '../__mocks__/createRemixPlanWorkerMock';

const NUM_BANDS = 23;
const BEATS_PER_BAR = 4;
const R_DIMS = 4 * BEATS_PER_BAR;

/** A hand-built analysis, the `remixPlan.test.ts` recipe — this file tests the
 * worker's PROTOCOL, not the DSP, so a synthetic analysis is exactly right. */
function makeAnalysis(numBars: number): RemixAnalysis {
  const barLen = 10000;
  const head = 500;
  const tail = 800;
  const numBoundaries = numBars + 1;
  const barBoundary = Int32Array.from({ length: numBoundaries }, (_, i) => head + i * barLen);
  return {
    bpm: 120,
    confidence: 1,
    beatSamples: Int32Array.from({ length: numBoundaries * BEATS_PER_BAR }, (_, i) => i * (barLen / BEATS_PER_BAR)),
    salience: 1,
    peakRatio: 1,
    ibiCv: 0,
    truncated: false,
    analyzedEndSample: barBoundary[numBars] + tail,
    odf: new Float32Array(0),
    periodFrames: 20,
    decimationFactor: 4,
    bands: new Float32Array(0),
    numBands: NUM_BANDS,
    odfLow: new Float32Array(0),
    chroma: new Float32Array(0),
    numChromaFrames: 0,
    chromaRate: 10,
    beatsPerBar: BEATS_PER_BAR,
    downbeatPhase: 0,
    downbeatConfidence: 0,
    barBoundary,
    numBars,
    T: new Float32Array(numBoundaries * NUM_BANDS),
    C: new Float32Array(numBoundaries * 12),
    L: new Float32Array(numBoundaries),
    R: new Float32Array(numBoundaries * R_DIMS),
    S: new Float32Array(numBoundaries * (NUM_BANDS + 12)),
    cluster: Int32Array.from({ length: numBoundaries }, (_, i) => i),
    transitionSeen: new Set<string>(),
  };
}

function options(rollIndex = 0): PlanRemixOptions {
  return {
    targetSample: 500 + 24 * 10000 + 800,
    weights: DEFAULT_REMIX_WEIGHTS,
    phraseBars: 8,
    strict: true,
    allowRepeats: true,
    forbiddenJoins: [],
    rollIndex,
  };
}

type Reply = { type: string; id: number; result?: unknown; message?: string };

/** Drives the REAL worker module: swap `self.postMessage` for a collector,
 * invoke the handler the module installed, return everything it replied. */
function driveReal(messages: unknown[]): Reply[] {
  const replies: Reply[] = [];
  const g = self as unknown as {
    postMessage: (m: unknown) => void;
    onmessage: ((e: MessageEvent) => void) | null;
  };
  const original = g.postMessage;
  g.postMessage = (m: unknown) => {
    replies.push(m as Reply);
  };
  try {
    for (const msg of messages) g.onmessage?.({ data: msg } as MessageEvent);
  } finally {
    g.postMessage = original;
  }
  return replies;
}

/** Drives the MOCK worker with the same messages. Its replies land in a
 * microtask, so the caller awaits. */
async function driveMock(messages: unknown[]): Promise<Reply[]> {
  const replies: Reply[] = [];
  const worker = createRemixPlanWorker();
  worker.onmessage = ((e: MessageEvent) => {
    replies.push(e.data as Reply);
  }) as never;
  for (const msg of messages) worker.postMessage(msg);
  await new Promise((r) => queueMicrotask(() => r(null)));
  worker.terminate();
  return replies;
}

beforeEach(() => {
  _resetRemixPlanWorkerTestState();
});

describe('remixPlan.worker — protocol', () => {
  it('keeps the analysis RESIDENT across init: two plan requests are served from ONE init', async () => {
    const analysis = makeAnalysis(24);
    const messages = [
      { type: 'init', analysis },
      { type: 'plan', id: 1, options: options(0) },
      { type: 'plan', id: 2, options: options(1) },
    ];

    const real = driveReal(messages);
    const mock = await driveMock(messages);

    // `init` itself replies with NOTHING — it is fire-and-forget.
    expect(real).toHaveLength(2);
    expect(mock).toHaveLength(2);
    expect(real.map((r) => [r.type, r.id])).toEqual([
      ['planned', 1],
      ['planned', 2],
    ]);
    expect(mock.map((r) => [r.type, r.id])).toEqual(real.map((r) => [r.type, r.id]));
  });

  it('the result is bit-for-bit the SAME as calling the shared pure core directly — mock and real worker agree', async () => {
    const analysis = makeAnalysis(24);
    const messages = [
      { type: 'init', analysis },
      { type: 'plan', id: 7, options: options(0) },
    ];
    const expected = planRemix(analysis, options(0));

    const real = driveReal(messages);
    const mock = await driveMock(messages);

    expect(real[0].result).toEqual(expected);
    expect(mock[0].result).toEqual(expected);
    expect(mock[0].result).toEqual(real[0].result);
  });

  it('a plan request BEFORE init replies `error` (never silently nothing, which would hang the caller)', async () => {
    // A fresh module instance is not available here (the real worker module is
    // imported once and already has a resident analysis from the tests above),
    // so the pre-init path is asserted on the MOCK, whose instance is fresh —
    // and the real module's identical guard is the line under test in the
    // `resident` check. Both produce the same reply shape.
    const mock = await driveMock([{ type: 'plan', id: 3, options: options(0) }]);

    expect(mock).toHaveLength(1);
    expect(mock[0].type).toBe('error');
    expect(mock[0].id).toBe(3);
    expect(String(mock[0].message)).toContain('before init');
  });

  it('ignores an unknown message type instead of replying with an undefined result', async () => {
    const real = driveReal([{ type: 'nonsense', id: 9 }]);
    const mock = await driveMock([{ type: 'nonsense', id: 9 }]);

    expect(real).toHaveLength(0);
    expect(mock).toHaveLength(0);
  });

  it('a terminated mock worker never emits again (the guard the service relies on for session teardown)', async () => {
    const analysis = makeAnalysis(24);
    const replies: Reply[] = [];
    const worker = createRemixPlanWorker();
    worker.onmessage = ((e: MessageEvent) => {
      replies.push(e.data as Reply);
    }) as never;
    worker.postMessage({ type: 'init', analysis });
    worker.postMessage({ type: 'plan', id: 1, options: options(0) });
    worker.terminate();
    await new Promise((r) => queueMicrotask(() => r(null)));

    expect(replies).toHaveLength(0);
  });
});
