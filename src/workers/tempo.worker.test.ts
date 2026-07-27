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

    const analysis = done.analysis as {
      beatSamples: Int32Array;
      odf: Float32Array;
      bands: Float32Array;
      odfLow: Float32Array;
    };
    const expectedBuffers = [
      analysis.beatSamples.buffer,
      analysis.odf.buffer,
      analysis.bands.buffer,
      analysis.odfLow.buffer,
    ];
    expect(transfer.length).toBe(4);
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

    const analysis = done.analysis as {
      beatSamples: Int32Array;
      odf: Float32Array;
      bands: Float32Array;
      odfLow: Float32Array;
      chroma: Float32Array;
      barBoundary: Int32Array;
      T: Float32Array;
      C: Float32Array;
      L: Float32Array;
      R: Float32Array;
      S: Float32Array;
      cluster: Int32Array;
    };
    const expectedBuffers = [
      analysis.beatSamples.buffer,
      analysis.odf.buffer,
      analysis.bands.buffer,
      analysis.odfLow.buffer,
      analysis.chroma.buffer,
      analysis.barBoundary.buffer,
      analysis.T.buffer,
      analysis.C.buffer,
      analysis.L.buffer,
      analysis.R.buffer,
      analysis.S.buffer,
      analysis.cluster.buffer,
    ];
    expect(transfer.length).toBe(12);
    expect(new Set(transfer)).toEqual(new Set(expectedBuffers));
    // Every buffer name is DISTINCT (no accidental aliasing that would make
    // the count right for the wrong reason).
    expect(new Set(expectedBuffers).size).toBe(12);
  });
});
