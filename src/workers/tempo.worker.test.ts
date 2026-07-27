/**
 * Direct test of `tempo.worker.ts`'s own module code — NOT via
 * `createTempoWorker`/the mock. `createTempoWorkerMock.ts` is a fake
 * in-process double whose `postMessage(message, transfer?)` ignores
 * `transfer` entirely (no real `Worker`, no real structured clone), so it
 * can mirror ANALYSIS CONTENT correctly (as `createTempoWorker.test.ts`
 * already verifies) but can never catch a regression where a buffer
 * silently drops out of the transfer list — exactly the "silent
 * degradation to structure-cloning" gap flagged in the T9 review (Important
 * 5): a missing buffer produces IDENTICAL values through the mock, differing
 * only in real-worker performance semantics.
 *
 * jsdom provides `self` as an alias for the global object, and
 * `tempo.worker.ts` only ever reads/assigns `self.onmessage`/`self.
 * postMessage` (never constructs a `Worker`, so none of `createTempoWorker.
 * test.ts`'s jsdom-lacks-Worker caveats apply here) — importing the module
 * once (executing its top-level `ctx.onmessage = ...` assignment exactly as
 * it would run inside a real Worker) and then invoking that handler
 * directly, while overriding `self.postMessage` with a spy, exercises the
 * REAL code path end-to-end, including the exact transfer list.
 */
import './tempo.worker';

interface AnalyzeMessage {
  type: 'analyze';
  id: number;
  level: 'tempo' | 'remix' | 'regrid';
  mono: Float32Array;
  sampleRate: number;
  minBpm: number;
  maxBpm: number;
  beatsPerBar: number;
  downbeatShiftBeats: number;
}

interface DoneReply {
  type: 'done';
  id: number;
  level: 'tempo' | 'remix' | 'regrid';
  analysis: Record<string, unknown>;
}

function clickTrain(bpm: number, seconds: number, sr = 44100): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const interval = Math.round((60 / bpm) * sr);
  for (let i = 0; i < n; i += interval) out[i] = 1;
  return out;
}

function send(msg: AnalyzeMessage): { postMessage: jest.Mock } {
  const postMessage = jest.fn();
  (self as unknown as { postMessage: unknown }).postMessage = postMessage;
  (self as unknown as { onmessage: (e: MessageEvent) => void }).onmessage({ data: msg } as MessageEvent);
  return { postMessage };
}

/** The LAST 'done' reply's `[message, transfer]` call, or throws if none arrived. */
function lastDoneCall(postMessage: jest.Mock): [DoneReply, ArrayBuffer[]] {
  for (let i = postMessage.mock.calls.length - 1; i >= 0; i--) {
    const [message, transfer] = postMessage.mock.calls[i] as [DoneReply, ArrayBuffer[]];
    if (message.type === 'done') return [message, transfer];
  }
  throw new Error('no done reply received');
}

/**
 * Every typed-array view's `.buffer` found directly on `obj`'s own
 * properties -- derived from whatever the analysis object ACTUALLY
 * contains, not a hand-maintained list, so this is ADDITION-safe as well as
 * removal-safe (T9 review fix round 2, minor): a hardcoded name list would
 * pass silently at "N vs N" if a future typed array were added to
 * `RemixAnalysis`/`TempoAnalysis` and the worker's transfer list were not
 * updated to match (both sides would independently be missing the same
 * name). Non-typed-array fields (`bpm`, `transitionSeen` -- a `Set`, not an
 * `ArrayBufferView` -- etc.) are skipped by `ArrayBuffer.isView` itself.
 */
function ownTypedArrayBuffers(obj: Record<string, unknown>): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  for (const value of Object.values(obj)) {
    if (ArrayBuffer.isView(value)) buffers.push((value as { buffer: ArrayBuffer }).buffer);
  }
  return buffers;
}

describe('tempo.worker.ts (real module, not the mock) — transfer list', () => {
  it('level:"tempo" transfers exactly beatSamples/odf/bands/odfLow (4 buffers), all present on analysis', () => {
    const mono = clickTrain(120, 8);
    const { postMessage } = send({
      type: 'analyze',
      id: 1,
      level: 'tempo',
      mono,
      sampleRate: 44100,
      minBpm: 60,
      maxBpm: 200,
      beatsPerBar: 4,
      downbeatShiftBeats: 0,
    });

    const [done, transfer] = lastDoneCall(postMessage);
    expect(done.level).toBe('tempo');

    const expectedBuffers = ownTypedArrayBuffers(done.analysis);
    expect(expectedBuffers.length).toBe(4); // beatSamples/odf/bands/odfLow -- pins the count independent of the dynamic derivation
    expect(transfer.length).toBe(expectedBuffers.length);
    expect(new Set(transfer)).toEqual(new Set(expectedBuffers));
  });

  it('level:"remix" transfers exactly all 12 typed arrays (4 base + 8 remix-only), none structure-cloned', () => {
    const mono = clickTrain(120, 8);
    const { postMessage } = send({
      type: 'analyze',
      id: 2,
      level: 'remix',
      mono,
      sampleRate: 44100,
      minBpm: 60,
      maxBpm: 200,
      beatsPerBar: 4,
      downbeatShiftBeats: 0,
    });

    const [done, transfer] = lastDoneCall(postMessage);
    expect(done.level).toBe('remix');

    const expectedBuffers = ownTypedArrayBuffers(done.analysis);
    expect(expectedBuffers.length).toBe(12); // 4 base + 8 remix-only -- pins the count independent of the dynamic derivation
    // Every buffer is DISTINCT (no accidental aliasing that would make the
    // count right for the wrong reason).
    expect(new Set(expectedBuffers).size).toBe(12);
    expect(transfer.length).toBe(expectedBuffers.length);
    expect(new Set(transfer)).toEqual(new Set(expectedBuffers));
  });
});
