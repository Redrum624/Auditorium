import {
  RecordingEngine,
  type RecordingContextLike,
  type WorkletNodeLike,
} from './RecordingEngine';
import { RECORDER_WORKLET_SOURCE } from './recorderWorklet';

// ---------------------------------------------------------------------------
// Minimal fake capture graph. Only the surface the engine touches is modelled.
// `port.postMessage('flush')` (engine -> worklet) triggers `flushHandler`, which
// the tests use to emit the final remainder; `port.emit(data)` (worklet -> engine)
// invokes the engine's onmessage handler, simulating batched chunk posts.
// ---------------------------------------------------------------------------

interface WorkletData {
  channels: Float32Array[];
  final: boolean;
}

class FakePort {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  posted: unknown[] = [];
  /** Set by a test; invoked when the engine posts the 'flush' message. */
  flushHandler: (() => void) | null = null;

  postMessage(message: unknown): void {
    this.posted.push(message);
    if (message === 'flush' && this.flushHandler) this.flushHandler();
  }

  /** Simulate the worklet posting a batch back to the engine. */
  emit(data: WorkletData): void {
    this.onmessage?.({ data });
  }
}

class FakeWorkletNode {
  port = new FakePort();
  connections: unknown[] = [];
  disconnected = false;
  connect(dest: unknown): unknown {
    this.connections.push(dest);
    return dest;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeSource {
  connections: unknown[] = [];
  disconnected = false;
  connect(dest: unknown): unknown {
    this.connections.push(dest);
    return dest;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeGain {
  gain = { value: 1 };
  connect(dest: unknown): unknown {
    return dest;
  }
  disconnect(): void {}
}

class FakeContext {
  destination = {};
  addedModules: string[] = [];
  closed = false;
  createdSources: FakeSource[] = [];
  audioWorklet = {
    addModule: async (url: string): Promise<void> => {
      this.addedModules.push(url);
    },
  };
  constructor(public sampleRate: number) {}
  createMediaStreamSource(): FakeSource {
    const s = new FakeSource();
    this.createdSources.push(s);
    return s;
  }
  createGain(): FakeGain {
    return new FakeGain();
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeTrack {
  stopped = false;
  kind = 'audio';
  stop(): void {
    this.stopped = true;
  }
}

class FakeStream {
  tracks = [new FakeTrack()];
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

const f32 = (values: number[]): Float32Array => Float32Array.from(values);

function setup(opts?: { actualRate?: number }) {
  const stream = new FakeStream();
  const node = new FakeWorkletNode();
  const ctx = new FakeContext(opts?.actualRate ?? 44100);
  const getUserMedia = jest.fn(async () => stream as unknown as MediaStream);
  const engine = new RecordingEngine({
    getUserMedia,
    createContext: () => ctx as unknown as RecordingContextLike,
    createWorkletNode: () => node as unknown as WorkletNodeLike,
    createModuleUrl: () => 'blob:test',
  });
  return { engine, stream, node, ctx, getUserMedia };
}

/** Wire the fake worklet to answer a `stop()` flush with a single final batch. */
function respondToFlush(node: FakeWorkletNode, final: Float32Array[]): void {
  node.port.flushHandler = () => node.port.emit({ channels: final, final: true });
}

describe('RecordingEngine', () => {
  describe('state transitions', () => {
    it('reports isRecording across start -> stop', async () => {
      const { engine, node } = setup();
      expect(engine.isRecording).toBe(false);
      await engine.start({ channels: 1, sampleRate: 44100 });
      expect(engine.isRecording).toBe(true);
      respondToFlush(node, [f32([])]);
      await engine.stop();
      expect(engine.isRecording).toBe(false);
    });

    it('throws when start() is called while already recording', async () => {
      const { engine } = setup();
      await engine.start({ channels: 1, sampleRate: 44100 });
      await expect(engine.start({ channels: 1, sampleRate: 44100 })).rejects.toThrow(
        'Already recording'
      );
    });

    it('throws when stop() is called while idle', async () => {
      const { engine } = setup();
      await expect(engine.stop()).rejects.toThrow('Not recording');
    });
  });

  describe('capture graph setup', () => {
    it('requests the device + channel count and registers the worklet module', async () => {
      const { engine, getUserMedia, ctx } = setup();
      await engine.start({ deviceId: 'mic-1', channels: 2, sampleRate: 48000 });
      expect(getUserMedia).toHaveBeenCalledWith({
        audio: { channelCount: 2, deviceId: { exact: 'mic-1' } },
      });
      expect(ctx.addedModules).toEqual(['blob:test']);
    });

    it('omits deviceId from the constraints when none is given', async () => {
      const { engine, getUserMedia } = setup();
      await engine.start({ channels: 1, sampleRate: 44100 });
      expect(getUserMedia).toHaveBeenCalledWith({ audio: { channelCount: 1 } });
    });
  });

  describe('chunk concatenation', () => {
    it('concatenates per-channel batches (including the flush remainder) exactly', async () => {
      const { engine, node, ctx } = setup({ actualRate: 48000 });
      await engine.start({ channels: 2, sampleRate: 44100 });

      node.port.emit({ channels: [f32([1, 2, 3]), f32([4, 5, 6])], final: false });
      node.port.emit({ channels: [f32([7, 8]), f32([9, 10])], final: false });
      respondToFlush(node, [f32([11]), f32([12])]);

      const result = await engine.stop();
      expect(Array.from(result.channels[0])).toEqual([1, 2, 3, 7, 8, 11]);
      expect(Array.from(result.channels[1])).toEqual([4, 5, 6, 9, 10, 12]);
      expect(result.channels).toHaveLength(2);
      // The context's ACTUAL rate wins over the requested 44100.
      expect(result.sampleRate).toBe(48000);
    });

    it('clamps a >2-channel capture to the first two channels', async () => {
      const { engine, node } = setup();
      await engine.start({ channels: 2, sampleRate: 44100 });
      respondToFlush(node, [f32([1]), f32([2]), f32([3])]);
      const result = await engine.stop();
      expect(result.channels).toHaveLength(2);
      expect(Array.from(result.channels[0])).toEqual([1]);
      expect(Array.from(result.channels[1])).toEqual([2]);
    });

    it('falls back to the requested channel count when no audio arrived', async () => {
      const { engine, node } = setup();
      await engine.start({ channels: 2, sampleRate: 44100 });
      // Worklet never saw input: final message carries zero channels.
      node.port.flushHandler = () => node.port.emit({ channels: [], final: true });
      const result = await engine.stop();
      expect(result.channels).toHaveLength(2);
      expect(result.channels[0]).toHaveLength(0);
      expect(result.channels[1]).toHaveLength(0);
    });
  });

  describe('chunk release after stop (Task M9 / F29)', () => {
    it('releases the accumulated per-batch chunk arrays once stop() has resolved the channels, instead of retaining them until the next start()', async () => {
      const { engine, node } = setup();
      await engine.start({ channels: 1, sampleRate: 44100 });
      node.port.emit({ channels: [f32([1, 2, 3])], final: false });
      respondToFlush(node, [f32([4, 5])]);

      const result = await engine.stop();

      // The public RecordResult already carries an independent copy of the
      // merged samples — this white-box check on the private `chunks` field is
      // what actually distinguishes "released now" from "released lazily by
      // the next start()" (which would make this pass either way, since
      // start() also resets `chunks`), directly verifying the retained-arrays
      // leak (F29) is fixed rather than merely inferring it indirectly.
      const internal = engine as unknown as { chunks: Float32Array[][] };
      expect(internal.chunks).toEqual([]);
      expect(Array.from(result.channels[0])).toEqual([1, 2, 3, 4, 5]); // unaffected
    });
  });

  describe('teardown on stop', () => {
    it('stops the media tracks and closes the context (releasing the mic)', async () => {
      const { engine, node, ctx, stream } = setup();
      await engine.start({ channels: 1, sampleRate: 44100 });
      respondToFlush(node, [f32([])]);
      await engine.stop();
      expect(stream.tracks[0].stopped).toBe(true);
      expect(ctx.closed).toBe(true);
      expect(node.disconnected).toBe(true);
      expect(ctx.createdSources[0].disconnected).toBe(true);
    });

    it('still releases the mic, closes the context and clears _isRecording when concatChannels() throws', async () => {
      const { engine, node, ctx, stream } = setup();
      await engine.start({ channels: 1, sampleRate: 44100 });

      // A chunk whose declared length is far past the maximum typed-array
      // size: concatChannels sums the lengths and then allocates the merged
      // buffer, so `new Float32Array(length)` throws RangeError — the same
      // shape as a genuine OOM on a very long take. (No level callback is
      // registered, so emitLevel returns before it would iterate this.)
      const monstrous = { length: 2 ** 45 } as unknown as Float32Array;
      node.port.emit({ channels: [monstrous], final: false });
      respondToFlush(node, [f32([])]);

      await expect(engine.stop()).rejects.toThrow(RangeError);

      // Before the fix, every one of these was skipped: the mic stayed live
      // (recording indicator stuck on), the context stayed open, the graph
      // stayed connected and the engine could never be started again.
      expect(stream.tracks[0].stopped).toBe(true);
      expect(ctx.closed).toBe(true);
      expect(node.disconnected).toBe(true);
      expect(engine.isRecording).toBe(false);

      // The decisive consequence: the engine is usable again.
      await expect(engine.start({ channels: 1, sampleRate: 44100 })).resolves.toBeUndefined();
    });
  });

  describe('level metering', () => {
    it('fires peak dB from each incoming batch (max abs across channels)', async () => {
      const { engine, node } = setup();
      await engine.start({ channels: 1, sampleRate: 44100 });
      const levels: number[] = [];
      engine.onLevel((db) => levels.push(db));

      node.port.emit({ channels: [f32([0.5, -0.25, 0.1])], final: false }); // peak 0.5
      expect(levels[levels.length - 1]).toBeCloseTo(-6.02, 1);
    });

    it('clamps a silent batch to -60 dB', async () => {
      const { engine, node } = setup();
      await engine.start({ channels: 1, sampleRate: 44100 });
      const levels: number[] = [];
      engine.onLevel((db) => levels.push(db));
      node.port.emit({ channels: [f32([0, 0, 0])], final: false });
      expect(levels[levels.length - 1]).toBe(-60);
    });

    it('takes the peak across all channels of a stereo batch', async () => {
      const { engine, node } = setup();
      await engine.start({ channels: 2, sampleRate: 44100 });
      const levels: number[] = [];
      engine.onLevel((db) => levels.push(db));
      node.port.emit({ channels: [f32([0.1]), f32([1.0])], final: false }); // peak 1.0 -> 0 dB
      expect(levels[levels.length - 1]).toBeCloseTo(0, 2);
    });

    it('stops delivering levels after unsubscribing', async () => {
      const { engine, node } = setup();
      await engine.start({ channels: 1, sampleRate: 44100 });
      const levels: number[] = [];
      const unsub = engine.onLevel((db) => levels.push(db));
      node.port.emit({ channels: [f32([0.5])], final: false });
      const count = levels.length;
      unsub();
      node.port.emit({ channels: [f32([0.9])], final: false });
      expect(levels.length).toBe(count);
    });
  });

  describe('error propagation', () => {
    it('rejects with the getUserMedia error and leaves the engine idle', async () => {
      const stream = new FakeStream();
      const node = new FakeWorkletNode();
      const ctx = new FakeContext(44100);
      const err = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
      const engine = new RecordingEngine({
        getUserMedia: jest.fn(async () => {
          throw err;
        }),
        createContext: () => ctx as unknown as RecordingContextLike,
        createWorkletNode: () => node as unknown as WorkletNodeLike,
        createModuleUrl: () => 'blob:test',
      });
      void stream;
      await expect(engine.start({ channels: 1, sampleRate: 44100 })).rejects.toThrow(
        'Permission denied'
      );
      expect(engine.isRecording).toBe(false);
    });

    it('releases the mic and closes the context when worklet setup fails after getUserMedia', async () => {
      // Regression: getUserMedia succeeds, then addModule rejects (the exact
      // CSP failure seen in the first smoke run). The LOCAL stream/context must
      // be torn down or the mic stays lit and retries stack leaked contexts.
      const stream = new FakeStream();
      const ctx = new FakeContext(44100);
      ctx.audioWorklet.addModule = async () => {
        throw new Error('Unable to load a worklet module');
      };
      const engine = new RecordingEngine({
        getUserMedia: async () => stream as unknown as MediaStream,
        createContext: () => ctx as unknown as RecordingContextLike,
        createWorkletNode: () => new FakeWorkletNode() as unknown as WorkletNodeLike,
        createModuleUrl: () => 'blob:test',
      });

      await expect(engine.start({ channels: 1, sampleRate: 44100 })).rejects.toThrow('worklet');
      expect(engine.isRecording).toBe(false);
      expect(stream.tracks[0].stopped).toBe(true); // mic released
      expect(ctx.closed).toBe(true); // context not leaked
    });
  });

  describe('worklet module URL cleanup', () => {
    // The default createModuleUrl allocates a one-shot blob: object URL for
    // the worklet module; it must be revoked once addModule settles instead
    // of leaking for the life of the page. jsdom doesn't implement
    // URL.revokeObjectURL, so these tests install a spy stub for it.
    let originalRevoke: typeof URL.revokeObjectURL;

    beforeEach(() => {
      originalRevoke = URL.revokeObjectURL;
    });

    afterEach(() => {
      URL.revokeObjectURL = originalRevoke;
    });

    it('revokes the module URL after addModule resolves', async () => {
      const revokeObjectURL = jest.fn();
      URL.revokeObjectURL = revokeObjectURL;
      const stream = new FakeStream();
      const node = new FakeWorkletNode();
      const ctx = new FakeContext(44100);
      const createModuleUrl = jest.fn(() => 'blob:worklet-test');
      const engine = new RecordingEngine({
        getUserMedia: async () => stream as unknown as MediaStream,
        createContext: () => ctx as unknown as RecordingContextLike,
        createWorkletNode: () => node as unknown as WorkletNodeLike,
        createModuleUrl,
      });

      await engine.start({ channels: 1, sampleRate: 44100 });

      expect(createModuleUrl).toHaveBeenCalledWith(RECORDER_WORKLET_SOURCE);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:worklet-test');
    });

    it('revokes the module URL even when addModule rejects', async () => {
      const revokeObjectURL = jest.fn();
      URL.revokeObjectURL = revokeObjectURL;
      const stream = new FakeStream();
      const ctx = new FakeContext(44100);
      ctx.audioWorklet.addModule = async () => {
        throw new Error('Unable to load a worklet module');
      };
      const engine = new RecordingEngine({
        getUserMedia: async () => stream as unknown as MediaStream,
        createContext: () => ctx as unknown as RecordingContextLike,
        createWorkletNode: () => new FakeWorkletNode() as unknown as WorkletNodeLike,
        createModuleUrl: () => 'blob:worklet-fail-test',
      });

      await expect(engine.start({ channels: 1, sampleRate: 44100 })).rejects.toThrow('worklet');
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:worklet-fail-test');
    });
  });

  describe('listInputs', () => {
    it('maps audioinput devices and preserves empty labels', async () => {
      const engine = new RecordingEngine({
        enumerateDevices: async () =>
          [
            { deviceId: 'a', kind: 'audioinput', label: 'Mic A' },
            { deviceId: 'v', kind: 'videoinput', label: 'Camera' },
            { deviceId: 'b', kind: 'audioinput', label: '' },
          ] as MediaDeviceInfo[],
      });
      const inputs = await engine.listInputs();
      expect(inputs).toEqual([
        { deviceId: 'a', label: 'Mic A' },
        { deviceId: 'b', label: '' },
      ]);
    });

    it('returns an empty list when device enumeration is unavailable', async () => {
      const engine = new RecordingEngine({ enumerateDevices: undefined });
      // No navigator.mediaDevices in jsdom -> graceful empty list.
      await expect(engine.listInputs()).resolves.toEqual([]);
    });
  });
});

describe('RECORDER_WORKLET_SOURCE', () => {
  it('registers a processor named "recorder"', () => {
    expect(RECORDER_WORKLET_SOURCE).toContain('registerProcessor');
    expect(RECORDER_WORKLET_SOURCE).toContain("'recorder'");
  });

  it('is syntactically valid JavaScript', () => {
    // new Function compiles the body without executing it, so the module-scope
    // references to AudioWorkletProcessor / sampleRate globals are fine — this
    // only proves there is no syntax error.
    expect(() => new Function(RECORDER_WORKLET_SOURCE)).not.toThrow();
  });
});
